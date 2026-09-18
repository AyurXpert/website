import { requireAuth, getCurrentTenantId, getCurrentRole, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { renderPromoBanner } from '../components/promoBanner.js';
import { isNCISMType, ncismUgTier, PK_THERAPY_ROOM_COUNT } from '../config/ncism.js';
import { NCISM_XX_ROWS } from '../config/ncismStaffCompliance.js';

/*
  SQL to run once in Supabase:

  -- 1. Add therapist to profiles role check
  ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
  ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('super_admin','dept_admin','doctor','receptionist','pharmacist',
                    'nurse','lab_tech','accountant','therapist','student','public'));

  -- 2. Enable RLS on pk_therapy_sessions
  ALTER TABLE pk_therapy_sessions ENABLE ROW LEVEL SECURITY;

  -- 3. §47 PK Therapy Section columns (NCISM §47(xiii) room tracking + Samsarjana Krama)
  ALTER TABLE pk_therapy_sessions ADD COLUMN IF NOT EXISTS therapy_room_number text;
  ALTER TABLE pk_therapy_sessions ADD COLUMN IF NOT EXISTS samsarjana_stage text;
  DROP POLICY IF EXISTS "tenant_pk_sessions" ON pk_therapy_sessions;
  CREATE POLICY "tenant_pk_sessions" ON pk_therapy_sessions FOR ALL TO authenticated
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
*/

await requireAuth(['super_admin','dept_admin','doctor','therapist','nurse']);
initNavbar();
wireDelegatedEvents();

window._removeClosest = function(el, sel) { el.closest(sel)?.remove(); };

const tenantId   = getCurrentTenantId();
const role       = getCurrentRole();
const myProfile  = getCurrentProfile();

let _sessions    = [];
let _admissions  = [];
let _therapists  = [];
let _depts       = [];
let _opdPatients = [];
let _rooms       = [];
let _buildingBlocks = [];
let _ugTier      = 0;   // Session 206: 0 = not an NCISM tenant / no ug_intake set
let _prepStaff   = [];
let _formulary   = [];
let _prepLogs    = [];
let _pkRosterSettings = null;
let _pkRosterDuty     = [];
let _pkPrepRoomDuty   = []; // Session 212, list since Session 218 -- [{id, profile_id, profiles:{id,full_name}}, ...], any length/day now
let _pkEditingDutyId  = null; // Session 220 -- which pk_therapist_duty row (Shift 1/2 grid), if any, currently shows an inline reassign <select> instead of its plain name
let _pkCycle          = 'weekly'; // Session 215 -- pk_roster_settings.cycle, weekly/fortnightly/monthly
let _pkCyclePending   = null; // Session 215 -- the latest pending pk_roster_cycle approval request, if any
let _pkShiftPending   = null; // Session 216 -- the latest pending pk_shift_times approval request, if any
let _pkTherapists    = []; // Session 213 -- _therapists filtered to department='Panchakarma' only; the real pool for Shift 1/2 + Prep Room In-charge
let _pkPrepLeaveIds   = new Set(); // Session 212 -- profile ids on approved leave covering _pkRosterDate, for the manual assign warning only
let _myPkShiftsWeek   = [];
let _pkRosterDate     = new Date().toISOString().slice(0,10);
let _viewDate    = new Date().toISOString().slice(0,10);
// Session 206 piece 2: prep-room work happens in real time, not by the schedule-date
// navigator above — deliberately a fixed "today", same idiom already used platform-wide
// (flagged elsewhere as a standing platform-wide gap around midnight IST, not fixed here).
const _prepToday = new Date().toISOString().slice(0,10);

// Session 207: Monday-start "this week" bounds for a plain therapist's read-only shifts
// card. Uses toLocaleDateString('en-CA') for "today" rather than the toISOString().slice
// idiom used elsewhere in this file -- that idiom silently rolls back to yesterday's date
// for any local time before the UTC offset catches up (00:00-05:30 IST), a known
// platform-wide gap only fixed in new code so far (Session 205), so fixed here too.
function _thisWeekBounds() {
  const todayStr = new Date().toLocaleDateString('en-CA');
  const d = new Date(todayStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun..6=Sat
  const monday = new Date(d);
  monday.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = x => x.toLocaleDateString('en-CA');
  return { start: fmt(monday), end: fmt(sunday) };
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadAll() {
  _updateDateDisplay();

  const _week = _thisWeekBounds();
  const [sessRes, admRes, thRes, deptRes, tenantRes, roomRes, blocksRes, prepStaffRes, formularyRes, prepLogRes, pkSettingsRes, pkCyclePendingRes, pkShiftPendingRes, pkDutyRes, pkPrepRes, pkPrepLeaveRes, myShiftsRes] = await Promise.all([
    supabase
      .from('pk_therapy_sessions')
      .select(`
        id, therapy_phase, therapy_name, scheduled_date, scheduled_time,
        actual_start, actual_end, status, therapist_notes, doctor_clearance,
        therapy_room_number, samsarjana_stage, room_id, ipd_admission_id,
        planned_duration_minutes, special_instructions, skip_reason,
        patients(id, name, phone, age, gender),
        profiles!therapist_id(id, full_name, gender),
        ordering_doctor:profiles!ordering_doctor_id(id, full_name),
        departments(id, name),
        pk_treatment_rooms(id, room_name),
        pk_therapy_session_therapists(profiles(id, full_name, gender))
      `)
      .eq('tenant_id', tenantId)
      .eq('scheduled_date', _viewDate)
      .order('scheduled_time', { ascending: true, nullsFirst: false }),
    supabase
      .from('ipd_admissions')
      .select('id, patients(id,name,phone,age,gender), beds(bed_number), departments(name)')
      .eq('tenant_id', tenantId)
      .eq('status', 'admitted'),
    supabase
      .from('profiles')
      .select('id,full_name,gender,weekly_off_day,department_id,designation')
      .eq('tenant_id', tenantId)
      .eq('role','therapist')
      .eq('is_active', true)
      .order('full_name'),
    supabase
      .from('departments')
      .select('id,name')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('tenants')
      .select('type,ug_intake')
      .eq('id', tenantId)
      .single(),
    supabase
      .from('pk_treatment_rooms')
      .select('id,room_name,room_type,capacity,gender_restriction,status,block_id,floor_number,building_blocks(id,name)')
      .eq('tenant_id', tenantId)
      .order('room_name'),
    // Session 206 (cont.) — same building_blocks table bed-admin.html already uses for
    // physical ward/wing placement, reused here (not merged into beds -- a treatment room
    // is booked in short session slots across a day, a bed is occupied for a multi-day
    // admission stay; conflating the two would collide beds.status's real meaning).
    supabase
      .from('building_blocks')
      .select('id,name,zone')
      .eq('tenant_id', tenantId)
      .order('name'),
    // Session 206 piece 2 — matches pk_preparation_logs' own write-allowed role set exactly,
    // so "Prepared By" can never offer someone who'd then fail to save.
    supabase
      .from('profiles')
      .select('id,full_name,role')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .in('role', ['super_admin','dept_admin','doctor','therapist','nurse'])
      .order('full_name'),
    supabase
      .from('hospital_formulary')
      .select('id,medicine_name')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('medicine_name'),
    supabase
      .from('pk_preparation_logs')
      .select(`
        id, prepared_date, item_name, quantity, unit, prepared_at, issued_at, waste_logged, notes,
        profiles!prepared_by(id, full_name),
        pk_treatment_rooms(id, room_name),
        pk_therapy_sessions(id, therapy_name, patients(name))
      `)
      .eq('tenant_id', tenantId)
      .eq('prepared_date', _prepToday)
      .order('prepared_at', { ascending: false }),
    // Session 206 piece 3. Session 215: +cycle (weekly/fortnightly/monthly).
    supabase
      .from('pk_roster_settings')
      .select('shift1_start,shift2_start,shift_duration_hours,cycle')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    // Session 215 -- any pending pk_roster_cycle request, so the Roster Cycle card can show
    // "awaiting approval" instead of letting a second request be submitted on top of it.
    supabase
      .from('pending_approvals')
      .select('id,payload,requested_at,requester:profiles!requested_by(full_name)')
      .eq('tenant_id', tenantId).eq('action_type', 'pk_roster_cycle').eq('status', 'pending')
      .order('requested_at', { ascending: false }).limit(1),
    // Session 216 -- same, for a pending pk_shift_times request.
    supabase
      .from('pending_approvals')
      .select('id,payload,requested_at,requester:profiles!requested_by(full_name)')
      .eq('tenant_id', tenantId).eq('action_type', 'pk_shift_times').eq('status', 'pending')
      .order('requested_at', { ascending: false }).limit(1),
    supabase
      .from('pk_therapist_duty')
      // pk_therapist_duty has 2 FKs to profiles (profile_id, created_by) -- an unqualified
      // profiles(...) embed is ambiguous and PostgREST rejects it; needs the FK hint.
      .select('id,profile_id,shift_slot,profiles!profile_id(id,full_name,gender)')
      .eq('tenant_id', tenantId)
      .eq('duty_date', _pkRosterDate),
    // Session 212 -- Prep Room In-charge. Session 218: several people/day now allowed
    // (unique(tenant_id,duty_date,profile_id), was unique(tenant_id,duty_date)) since the
    // headcount is adjustable -- no longer .maybeSingle(), a plain list like Shift 1/2.
    supabase
      .from('pk_prep_room_duty')
      .select('id,profile_id,profiles!profile_id(id,full_name)')
      .eq('tenant_id', tenantId)
      .eq('duty_date', _pkRosterDate)
      .order('created_at'),
    // Session 212 (cont.) -- who's on approved leave covering _pkRosterDate, so the manual
    // Prep Room In-charge dropdown can warn (not block, per Dr. Venkatesh -- manual assignment
    // stays an admin override tool same as Shift 1/2's) about weekly-off/leave, the way the
    // week generator already excludes them outright. Shift 1/2's own manual dropdowns
    // deliberately keep no such warning -- this is Prep Room In-charge only, by request.
    supabase
      .from('staff_leaves')
      .select('profile_id')
      .eq('tenant_id', tenantId)
      .eq('status', 'approved')
      .lte('from_date', _pkRosterDate)
      .gte('to_date', _pkRosterDate),
    // Session 207 -- backs the plain-therapist "My Shifts This Week" read-only card;
    // scoped to the logged-in profile only, cheap regardless of role (a super_admin/HOD
    // simply gets an empty result, harmless).
    supabase
      .from('pk_therapist_duty')
      .select('id,duty_date,shift_slot')
      .eq('tenant_id', tenantId)
      .eq('profile_id', myProfile?.id || '')
      .gte('duty_date', _week.start)
      .lte('duty_date', _week.end)
      .order('duty_date'),
  ]);

  if (sessRes.error) {
    _alert('error', safeErrorMessage(sessRes.error, 'Failed to load sessions.')
      + (sessRes.error.code === '42501' ? ' — Run the RLS SQL shown in source comments.' : ''));
    return;
  }

  _sessions   = sessRes.data || [];
  _admissions = admRes.data  || [];
  _therapists = thRes.data   || [];
  _depts      = deptRes.data || [];
  // Session 213 -- the Duty Roster (Shift 1/2 + Prep Room In-charge) is scoped to the real
  // Panchakarma department, not the platform-wide role='therapist' pool _therapists itself is
  // (that broader pool still backs Schedule Session/Assign Room & Therapist elsewhere on this
  // page). Real gap found live: SDM has 14 role='therapist' profiles but only 10 are actually
  // in Panchakarma (5M+5F, matching Sch XX/33) -- the other 4 (Physiotherapist, 2x Kriyakalpa,
  // Yoga Demonstrator) belong to different departments and were only ever excluded from Shift
  // 1/2 by the accident of having no gender set, with no protection at all for Prep Room
  // In-charge (built gender-open on purpose). Matches _renderPkInchargePanel()'s pre-existing
  // pkDept lookup by name -- Panchakarma's name is fixed NCISM seed data, not admin-editable.
  const _pkDept = _depts.find(d => d.name === 'Panchakarma');
  _pkTherapists = _pkDept ? _therapists.filter(t => t.department_id === _pkDept.id) : [];
  _rooms      = roomRes.data || [];
  _buildingBlocks = blocksRes.data || [];
  _ugTier     = isNCISMType(tenantRes.data?.type) ? ncismUgTier(tenantRes.data?.ug_intake) : 0;
  _myPkShiftsWeek = myShiftsRes.data || [];
  _prepStaff  = prepStaffRes.data  || [];
  _formulary  = formularyRes.data  || [];
  _prepLogs   = prepLogRes.data    || [];
  _pkRosterSettings = pkSettingsRes.data || null;
  _pkCycle          = _pkRosterSettings?.cycle || 'weekly';
  _pkCyclePending   = pkCyclePendingRes.data?.[0] || null;
  _pkShiftPending   = pkShiftPendingRes.data?.[0] || null;
  _pkRosterDuty     = pkDutyRes.data     || [];
  _pkPrepRoomDuty   = pkPrepRes.data     || [];
  _pkPrepLeaveIds   = new Set((pkPrepLeaveRes.data || []).map(r => r.profile_id));
  // Real bug caught live this session: an ambiguous-FK embed silently returned no data
  // instead of erroring visibly (data was null, not an exception) -- log it so a future
  // regression here is loud instead of just quietly showing "0 on duty".
  if (pkDutyRes.error) console.error('pk_therapist_duty load failed:', pkDutyRes.error);
  if (pkSettingsRes.error) console.error('pk_roster_settings load failed:', pkSettingsRes.error);
  if (pkPrepRes.error) console.error('pk_prep_room_duty load failed:', pkPrepRes.error);

  // Session 223 -- a plain therapist only ever sees their own sessions, but the Pk Incharge
  // and any room/roster admin (same population the Duty Roster already gives full oversight
  // to via _isPkRosterAdmin()/_isRoomAdmin()) need the whole department's schedule to actually
  // do their job -- a real gap found live: the Pk Incharge account only ever saw sessions
  // assigned to themself, identical to any other plain therapist.
  if (role === 'therapist' && !_isPkRosterAdmin() && !_isRoomAdmin()) {
    _sessions = _sessions.filter(s => s.profiles?.id === myProfile?.id);
  }

  _populateFilterSelects();
  _populateSchedSelects();
  renderStats();
  applyFilters();
  _renderRoomOccupancyGrid();
  _renderRoomsPanel();
  _renderPrepPanel();
  _renderPkRosterPanel();
  _renderPkInchargePanel();
}

// ── Panchakarma In-charge selection (Session 207) ───────────────────────────────
const PK_INCHARGE_ADMIN_DESIGS = ['medical_director', 'principal', 'medical_superintendent'];

function _renderPkInchargePanel() {
  const details = document.getElementById('pk-incharge-details');
  const isAdmin = role === 'super_admin' || PK_INCHARGE_ADMIN_DESIGS.includes(myProfile?.designation);
  details.style.display = isAdmin ? '' : 'none';
  if (!isAdmin) return;

  // Session 213: reuses the shared _pkTherapists pool (department='Panchakarma') computed
  // once in loadAll() -- was its own local pkDept/filter here before, now one source of truth.
  const current = _pkTherapists.find(t => t.designation === 'pk_incharge');

  document.getElementById('pk-incharge-current').innerHTML = current
    ? `Currently: <strong>${_esc(current.full_name)}</strong>`
    : `<span style="color:var(--text-muted)">Not yet set.</span>`;

  const sel = document.getElementById('pk-incharge-select');
  const prevVal = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>' +
    _pkTherapists.map(t => `<option value="${t.id}">${_esc(t.full_name)}${t.id === current?.id ? ' (current)' : ''}</option>`).join('');
  if (prevVal && pkTherapists.some(t => t.id === prevVal)) sel.value = prevVal;
}

window.savePkIncharge = async function() {
  const id = document.getElementById('pk-incharge-select').value;
  if (!id) { _alert('error', 'Choose a therapist first.'); return; }
  const { error } = await supabase.rpc('set_pk_incharge', { p_profile_id: id });
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to set Panchakarma In-charge.')); return; }
  const saved = document.getElementById('pk-incharge-saved');
  saved.style.display = '';
  setTimeout(() => { saved.style.display = 'none'; }, 2000);
  await loadAll();
};

window.clearPkIncharge = async function() {
  const { error } = await supabase.rpc('set_pk_incharge', { p_profile_id: null });
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to clear Panchakarma In-charge.')); return; }
  await loadAll();
};

// ── Treatment Rooms (Session 206) ───────────────────────────────────────────────
// Session 207: deliberately NOT pk_incharge -- that designation's own regulatory duty is
// therapist rostering (Sch XX/33), not physical-infrastructure/capacity decisions, kept
// separate on purpose (see set_pk_incharge()'s comment header, sql/session207_*). Mirrors
// _pk_room_admin_ok() server-side exactly -- super_admin, the real Panchakarma-department
// HOD (profiles.scope_department_id, dept-admin.html's own model -- NOT the generic
// 'dept_admin' role, which any org-wide Medical Director/Principal also holds regardless
// of department), or Medical Director/Principal/Medical Superintendent by designation.
const ROOM_ADMIN_DESIGS = ['medical_director', 'principal', 'medical_superintendent'];

function _isRoomAdmin() {
  if (role === 'super_admin') return true;
  if (ROOM_ADMIN_DESIGS.includes(myProfile?.designation)) return true;
  const pkDept = _depts.find(d => d.name === 'Panchakarma');
  return !!(pkDept && myProfile?.scope_department_id === pkDept.id);
}

function _renderRoomsPanel() {
  const isAdmin = _isRoomAdmin();
  document.getElementById('rooms-details').style.display = isAdmin ? '' : 'none';
  if (!isAdmin) return;
  document.getElementById('rooms-admin-form').style.display = '';

  const active = _rooms.filter(r => r.status === 'active');
  document.getElementById('rooms-summary-count').textContent =
    _rooms.length ? `${active.length} active / ${_rooms.length} total` : '';

  // Compliance banner — Session 206 correction: NCISM's real model is ONE combined,
  // general-purpose "therapy room" pool (Droni + Swedana facility + monitoring kit all
  // travel together per bay, Sch XXV), gender-split evenly per Schedule III — not a
  // per-procedure-type room count. See js/config/ncism.js's PK_THERAPY_ROOM_COUNT comment
  // for the full citation. Rooms explicitly typed "Any" don't count toward either gender's
  // half until the admin assigns them — that's deliberate, not a bug, so the banner can't
  // be gamed by leaving rooms unassigned.
  const banner = document.getElementById('rooms-compliance-banner');
  if (_ugTier) {
    const required = PK_THERAPY_ROOM_COUNT[_ugTier] || 0;
    const half = required / 2;
    const maleCount = active.filter(r => r.gender_restriction === 'male').length;
    const femaleCount = active.filter(r => r.gender_restriction === 'female').length;
    const anyCount = active.filter(r => r.gender_restriction === 'any').length;
    const kaumara = active.some(r => r.room_type?.toLowerCase().includes('kaumara'));
    const met = maleCount >= half && femaleCount >= half;

    banner.style.display = '';
    banner.style.background = met ? '#eaf7ef' : '#fdf3e3';
    banner.style.border = `1.5px solid ${met ? '#bfe3cc' : '#f0dca0'}`;
    banner.style.color = met ? '#1a4a2e' : '#7a5a00';
    banner.innerHTML = `${met ? '✅' : '⚠️'} NCISM Sch III/XXV — needs <strong>${half} male + ${half} female</strong> therapy rooms for your ${_ugTier} UG intake (${required} total, gender-split per Sch III). Configured: <strong>${maleCount} male, ${femaleCount} female</strong>${anyCount ? `, ${anyCount} unassigned (set Male/Female to count)` : ''}.<br/>${kaumara ? '✅' : '⚠️'} At least 1 room designated for Kaumara Panchakarma (Reg 47(a)(xiii)).`;
  } else {
    banner.style.display = 'none';
  }

  // Building selector — same block list bed-admin.html manages, populated fresh each render
  // so a block added there shows up here without a page reload.
  const blockSel = document.getElementById('room-block');
  const blockVal = blockSel.value;
  blockSel.innerHTML = '<option value="">— Not mapped —</option>' +
    _buildingBlocks.map(b => `<option value="${b.id}">${_esc(b.name)}</option>`).join('');
  if (blockVal && _buildingBlocks.some(b => b.id === blockVal)) blockSel.value = blockVal;

  // Session 211 — same block list, same "don't clobber what the admin already picked" pattern,
  // for the Bulk Add Rooms form's own building selector.
  const bulkBlockSel = document.getElementById('bulk-room-block');
  if (bulkBlockSel) {
    const bulkBlockVal = bulkBlockSel.value;
    bulkBlockSel.innerHTML = '<option value="">— Not mapped —</option>' +
      _buildingBlocks.map(b => `<option value="${b.id}">${_esc(b.name)}</option>`).join('');
    if (bulkBlockVal && _buildingBlocks.some(b => b.id === bulkBlockVal)) bulkBlockSel.value = bulkBlockVal;
  }

  const list = document.getElementById('rooms-list');
  if (!_rooms.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No treatment rooms configured yet.</div>';
    return;
  }
  list.innerHTML = `<table class="sessions-table"><thead><tr>
      <th>Room</th><th>Type</th><th>Capacity</th><th>Gender</th><th>Building</th><th>Status</th>${isAdmin ? '<th></th>' : ''}
    </tr></thead><tbody>${_rooms.map(r => `
      <tr>
        <td>${_esc(r.room_name)}</td>
        <td>${_esc(r.room_type || '—')}</td>
        <td>${r.capacity}</td>
        <td>${r.gender_restriction === 'any' ? 'Any' : r.gender_restriction === 'male' ? 'Male only' : 'Female only'}</td>
        <td>${r.building_blocks?.name ? _esc(r.building_blocks.name) + (r.floor_number != null ? ` · Fl ${r.floor_number}` : '') : '—'}</td>
        <td>${r.status === 'active' ? '🟢 Active' : r.status === 'maintenance' ? '🟡 Maintenance' : '⚪ Inactive'}</td>
        ${isAdmin ? `<td style="white-space:nowrap;display:flex;gap:6px">
          <button data-onclick="editRoom" data-onclick-a0="${r.id}" style="height:30px;padding:0 10px;background:var(--blue-light);border:1.5px solid var(--blue);color:var(--blue);border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">✏️ Edit</button>
          <button data-onclick="cycleRoomStatus" data-onclick-a0="${r.id}" style="height:30px;padding:0 10px;background:var(--gold-light);border:1.5px solid var(--gold);color:#8a6414;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">🔄 Status</button>
        </td>` : ''}
      </tr>`).join('')}</tbody></table>`;
}

window.editRoom = function(id) {
  const room = _rooms.find(r => r.id === id);
  if (!room) return;
  document.getElementById('rooms-details').open = true;
  document.getElementById('room-edit-id').value = room.id;
  document.getElementById('room-name').value = room.room_name;
  document.getElementById('room-type').value = room.room_type || 'General Therapy Room';
  document.getElementById('room-capacity').value = room.capacity || 1;
  document.getElementById('room-gender').value = room.gender_restriction || 'any';
  document.getElementById('room-block').value = room.block_id || '';
  document.getElementById('room-floor').value = room.floor_number ?? '';
  document.getElementById('room-form-title').textContent = `Edit Treatment Room — ${room.room_name}`;
  document.getElementById('room-save-btn').textContent = 'Save Changes';
  document.getElementById('room-cancel-btn').style.display = '';
  document.getElementById('rooms-admin-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.cancelEditRoom = function() {
  document.getElementById('room-edit-id').value = '';
  document.getElementById('room-name').value = '';
  document.getElementById('room-type').value = 'General Therapy Room';
  document.getElementById('room-capacity').value = '1';
  document.getElementById('room-gender').value = 'any';
  document.getElementById('room-block').value = '';
  document.getElementById('room-floor').value = '';
  document.getElementById('room-form-title').textContent = 'Add Treatment Room';
  document.getElementById('room-save-btn').textContent = '+ Add Room';
  document.getElementById('room-cancel-btn').style.display = 'none';
};

window.saveRoom = async function() {
  const editId = document.getElementById('room-edit-id').value;
  const name = document.getElementById('room-name').value.trim();
  const type = document.getElementById('room-type').value.trim();
  // Session 236 -- always 1, hardcoded rather than read from the (now disabled, display-only)
  // input: a treatment room is never a multi-patient concept like a bed/ward.
  const capacity = 1;
  const gender = document.getElementById('room-gender').value;
  const blockId = document.getElementById('room-block').value || null;
  const floorRaw = document.getElementById('room-floor').value;
  const floor = floorRaw !== '' ? parseInt(floorRaw, 10) : null;

  if (!name) { _alert('error', 'Enter a room name.'); return; }

  const payload = {
    room_name: name,
    room_type: type || 'General Therapy Room',
    capacity,
    gender_restriction: gender,
    block_id: blockId,
    floor_number: floor,
  };

  const { error } = editId
    ? await supabase.from('pk_treatment_rooms').update(payload).eq('id', editId)
    : await supabase.from('pk_treatment_rooms').insert({ ...payload, tenant_id: tenantId });

  if (error) {
    _alert('error', safeErrorMessage(error, error.code === '23505' ? 'A room with this name already exists.' : 'Failed to save room.'));
    return;
  }

  window.cancelEditRoom();
  const saved = document.getElementById('room-saved');
  saved.style.display = '';
  setTimeout(() => { saved.style.display = 'none'; }, 2000);
  await loadAll();
};

window.cycleRoomStatus = async function(id) {
  const room = _rooms.find(r => r.id === id);
  if (!room) return;
  const next = { active: 'maintenance', maintenance: 'inactive', inactive: 'active' }[room.status] || 'active';
  const { error } = await supabase.from('pk_treatment_rooms').update({ status: next }).eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to update room status.')); return; }
  await loadAll();
};

// ── Bulk Add Rooms (Session 211) ────────────────────────────────────────────────
// Same room master data/RLS as the single Add form above -- just a batched insert with
// auto-numbered names + a gender split, for a tenant setting up Sch III/XXV capacity from
// scratch rather than clicking "+ Add Room" 6-16 times one at a time.
window.toggleBulkRooms = function() {
  const el = document.getElementById('rooms-bulk-form');
  el.style.display = el.style.display === 'none' ? '' : 'none';
};

window.onBulkRoomPrefixInput = function(el) {
  const preview = document.getElementById('bulk-room-prefix-preview');
  if (preview) preview.textContent = el.value.trim() || 'Room';
};

window.applySuggestedBulkCounts = function() {
  if (!_ugTier) {
    _alert('info', 'NCISM UG intake isn\'t configured for this tenant — enter counts manually.');
    return;
  }
  const required = PK_THERAPY_ROOM_COUNT[_ugTier] || 0;
  const half = required / 2;
  const active = _rooms.filter(r => r.status === 'active');
  const maleCount = active.filter(r => r.gender_restriction === 'male').length;
  const femaleCount = active.filter(r => r.gender_restriction === 'female').length;
  document.getElementById('bulk-room-male').value = Math.max(0, half - maleCount);
  document.getElementById('bulk-room-female').value = Math.max(0, half - femaleCount);
  const kaumara = active.some(r => r.room_type?.toLowerCase().includes('kaumara'));
  document.getElementById('bulk-room-kaumara').checked = !kaumara;
};

// Continues numbering from the highest existing "<prefix> N" room name (any status, so a
// deactivated/renamed room's old number is never reissued) rather than always starting at 1 —
// avoids the unique(tenant_id, room_name) constraint colliding with rooms already on file.
function _bulkRoomNextNumber(prefix) {
  const escaped = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '\\s*(\\d+)$', 'i');
  let max = 0;
  _rooms.forEach(r => {
    const m = re.exec((r.room_name || '').trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return max + 1;
}

window.createBulkRooms = async function() {
  const maleN = parseInt(document.getElementById('bulk-room-male').value, 10) || 0;
  const femaleN = parseInt(document.getElementById('bulk-room-female').value, 10) || 0;
  const anyN = parseInt(document.getElementById('bulk-room-any').value, 10) || 0;
  const total = maleN + femaleN + anyN;
  if (total <= 0) { _alert('error', 'Enter at least one room to create.'); return; }
  if (total > 30) { _alert('error', 'Create at most 30 rooms at a time — split into batches.'); return; }

  const prefix = document.getElementById('bulk-room-prefix').value.trim() || 'Room';
  // Session 236 -- always 1 (field removed from the form entirely): a treatment room is
  // never a multi-patient concept like a bed/ward.
  const capacity = 1;
  const blockId = document.getElementById('bulk-room-block').value || null;
  const floorRaw = document.getElementById('bulk-room-floor').value;
  const floor = floorRaw !== '' ? parseInt(floorRaw, 10) : null;
  const kaumara = document.getElementById('bulk-room-kaumara').checked;

  const startNum = _bulkRoomNextNumber(prefix);
  const genders = [
    ...Array(maleN).fill('male'),
    ...Array(femaleN).fill('female'),
    ...Array(anyN).fill('any'),
  ];

  const rows = genders.map((gender, i) => ({
    tenant_id: tenantId,
    room_name: `${prefix} ${startNum + i}`,
    room_type: (kaumara && i === 0) ? 'Kaumara Panchakarma' : 'General Therapy Room',
    capacity,
    gender_restriction: gender,
    block_id: blockId,
    floor_number: floor,
  }));

  const btn = document.getElementById('bulk-room-create-btn');
  btn.disabled = true;
  const { error } = await supabase.from('pk_treatment_rooms').insert(rows);
  btn.disabled = false;
  if (error) {
    _alert('error', safeErrorMessage(error, error.code === '23505'
      ? `A room named "${prefix} ${startNum}" or similar already exists — try a different prefix.`
      : 'Failed to create rooms.'));
    return;
  }

  document.getElementById('bulk-room-male').value = '0';
  document.getElementById('bulk-room-female').value = '0';
  document.getElementById('bulk-room-any').value = '0';
  document.getElementById('bulk-room-kaumara').checked = false;
  const saved = document.getElementById('bulk-room-saved');
  saved.style.display = '';
  setTimeout(() => { saved.style.display = 'none'; }, 2500);
  await loadAll();
};

// ── Preparation Room Log (Session 206 piece 2, NCISM Reg 47(a)(viii)–(ix)) ─────────────
function _renderPrepPanel() {
  // Item datalist — real formulary names, doesn't force the field (bespoke per-patient
  // prep is real and common; item_name stays free text either way).
  const dl = document.getElementById('prep-item-suggestions');
  dl.innerHTML = _formulary.map(f => `<option value="${_esc(f.medicine_name)}"></option>`).join('');

  // Prepared By — defaults to the logged-in profile if they're in the eligible list.
  const byEl = document.getElementById('prep-by');
  const byVal = byEl.value;
  byEl.innerHTML = _prepStaff.map(p => `<option value="${p.id}">${_esc(p.full_name)}</option>`).join('');
  byEl.value = byVal || myProfile?.id || '';

  // Issue-to-room — active rooms only, same pool the schedule drawer uses.
  const roomEl = document.getElementById('prep-room');
  roomEl.innerHTML = '<option value="">— Not assigned yet —</option>' +
    _rooms.filter(r => r.status === 'active').map(r => `<option value="${r.id}">${_esc(r.room_name)}</option>`).join('');

  // Session link — today's scheduled sessions (the date-navigator's _sessions, which is
  // real "today" only when the navigator itself is on today — an honest limitation, not
  // worth a second query just for this optional convenience field).
  const sessEl = document.getElementById('prep-session');
  sessEl.innerHTML = '<option value="">— Not linked to a session —</option>' +
    _sessions.map(s => `<option value="${s.id}">${_esc(s.patients?.name || 'Patient')} — ${_esc(s.therapy_name)}${s.scheduled_time ? ' @ ' + s.scheduled_time.slice(0,5) : ''}</option>`).join('');

  const list = document.getElementById('prep-list');
  if (!_prepLogs.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No preparations logged today.</div>';
    return;
  }
  list.innerHTML = `<table class="sessions-table"><thead><tr>
      <th>Time</th><th>Item</th><th>Qty</th><th>Prepared By</th><th>For</th><th>Waste</th><th>Status</th><th></th>
    </tr></thead><tbody>${_prepLogs.map(p => {
      const timeStr = new Date(p.prepared_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      const forWhat = p.pk_therapy_sessions
        ? `${_esc(p.pk_therapy_sessions.patients?.name || 'Patient')} — ${_esc(p.pk_therapy_sessions.therapy_name || '')}`
        : (p.pk_treatment_rooms ? _esc(p.pk_treatment_rooms.room_name) : '—');
      return `<tr>
        <td>${timeStr}</td>
        <td>${_esc(p.item_name)}</td>
        <td>${p.quantity ?? '—'} ${p.quantity ? _esc(p.unit) : ''}</td>
        <td>${_esc(p.profiles?.full_name || '—')}</td>
        <td>${forWhat}</td>
        <td>${p.waste_logged ? '✅' : '—'}</td>
        <td>${p.issued_at ? '📦 Issued' : '🧪 Prepared'}</td>
        <td>${p.issued_at ? '' : `<button data-onclick="markPrepIssued" data-onclick-a0="${p.id}" style="height:30px;padding:0 10px;background:var(--white);border:1.5px solid var(--border);border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit">Mark Issued</button>`}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

window.savePrepLog = async function() {
  const item = document.getElementById('prep-item').value.trim();
  const quantity = document.getElementById('prep-quantity').value;
  const unit = document.getElementById('prep-unit').value;
  const preparedBy = document.getElementById('prep-by').value;
  const roomId = document.getElementById('prep-room').value || null;
  const sessionId = document.getElementById('prep-session').value || null;
  const wasteLogged = document.getElementById('prep-waste').checked;
  const notes = document.getElementById('prep-notes').value.trim();

  if (!item) { _alert('error', 'Enter what was prepared.'); return; }
  if (!preparedBy) { _alert('error', 'Select who prepared it.'); return; }

  const formularyMatch = _formulary.find(f => f.medicine_name === item);

  const { error } = await supabase.from('pk_preparation_logs').insert({
    tenant_id: tenantId,
    prepared_date: _prepToday,
    item_name: item,
    formulary_id: formularyMatch?.id || null,
    quantity: quantity ? Number(quantity) : null,
    unit,
    prepared_by: preparedBy,
    room_id: roomId,
    session_id: sessionId,
    waste_logged: wasteLogged,
    notes: notes || null,
  });

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to save preparation log.')); return; }

  document.getElementById('prep-item').value = '';
  document.getElementById('prep-quantity').value = '';
  document.getElementById('prep-waste').checked = false;
  document.getElementById('prep-notes').value = '';
  const saved = document.getElementById('prep-saved');
  saved.style.display = '';
  setTimeout(() => { saved.style.display = 'none'; }, 2000);
  await loadAll();
};

window.markPrepIssued = async function(id) {
  const { error } = await supabase.from('pk_preparation_logs').update({ issued_at: new Date().toISOString() }).eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to mark issued.')); return; }
  await loadAll();
};

// ── Therapist Duty Roster (Session 206 piece 3) ─────────────────────────────────
// Deliberately separate from roster.html/duty_roster -- see therapist.html's comment.
function _isPkRosterAdmin() {
  return role === 'super_admin' || role === 'dept_admin'
    || myProfile?.secondary_role === 'dept_admin' || myProfile?.designation === 'pk_incharge';
}

function _pkShiftLabel(n) {
  const start = n === 1 ? (_pkRosterSettings?.shift1_start || '09:00') : (_pkRosterSettings?.shift2_start || '14:00');
  const dur = _pkRosterSettings?.shift_duration_hours || 8;
  const [h, m] = start.split(':').map(Number);
  const endH = (h + dur) % 24;
  const fmt = (hh, mm) => `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  return `Shift ${n} (${fmt(h,m)}–${fmt(endH,m)})`;
}

function _renderPkRosterPanel() {
  const isAdmin = _isPkRosterAdmin();
  // Session 207 (cont.) -- a third tier: the real Panchakarma HOD and Medical
  // Superintendent already have Rooms access (_isRoomAdmin()) but deliberately not
  // roster-edit rights (that stays pk_incharge's job, per Dr. Venkatesh's explicit
  // design call). They get read-only oversight of the FULL roster instead of nothing --
  // same "supervise without controlling" pattern as Nursing's Coverage Capacity card.
  const isViewer = !isAdmin && _isRoomAdmin();

  // A plain therapist (neither admin nor viewer) gets a stripped-down read-only "my
  // shifts this week" card instead -- same fork nursing.html made for its own roster.
  document.getElementById('pkroster-details').style.display = (isAdmin || isViewer) ? '' : 'none';
  document.getElementById('pk-my-shifts-card').style.display = (!isAdmin && !isViewer && role === 'therapist') ? '' : 'none';
  if (!isAdmin && !isViewer) {
    if (role === 'therapist') _renderMyPkShiftsWeek();
    return;
  }

  document.getElementById('pkroster-weeklyoff-details').style.display = isAdmin ? '' : 'none';
  document.getElementById('pkroster-generate-form').style.display = isAdmin ? '' : 'none';
  if (isAdmin) _renderWeeklyOffList();
  _renderPkShiftTimesCard(isAdmin);
  _renderPkCycleCard(isAdmin);
  _applyPkCycleLabels();
  if (isAdmin) window.updatePkHeadcountHint();

  const d = new Date(_pkRosterDate + 'T00:00:00');
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('pkroster-date-display').textContent =
    (_pkRosterDate === today ? 'Today · ' : '') + d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  document.getElementById('pkroster-date-picker').value = _pkRosterDate;
  document.getElementById('pkroster-day-count').textContent = `${_pkRosterDuty.length} therapist(s) on duty`;

  const grid = document.getElementById('pkroster-grid');
  grid.innerHTML = [1, 2].map(slot => {
    const entries = _pkRosterDuty.filter(r => r.shift_slot === slot);
    // Session 220 -- click-a-name-to-swap, matching nursing roster.html's "click a slot to
    // reassign" convenience (a lighter version: PK has only a person per slot, no bed range/
    // notes/confirmed fields, so no full modal is needed). Clicking a name turns that one row
    // into an inline <select> pre-selected to them; picking someone else immediately swaps the
    // assignment (a plain UPDATE on this row's profile_id, not a remove+add round trip).
    const rows = entries.map(r => {
      if (isAdmin && _pkEditingDutyId === r.id) {
        // Always include the person currently in this slot (so "no change" is a real option)
        // plus whoever else isn't already assigned to this exact shift today.
        const choices = _pkTherapists.filter(t => t.id === r.profile_id || !entries.some(e => e.profile_id === t.id));
        const opts = choices.map(t => `<option value="${t.id}"${t.id === r.profile_id ? ' selected' : ''}>${_esc(t.full_name)}</option>`).join('');
        return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
          <select data-onchange="swapPkDuty" data-onchange-a0="${r.id}" data-onchange-a1="@this" style="flex:1;height:34px;border:1.5px solid var(--green-deep);border-radius:7px;padding:0 8px;font-size:12px;font-family:inherit">${opts}</select>
          <button data-onclick="cancelEditPkDuty" title="Cancel" style="border:none;background:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 4px">✕</button>
        </div>`;
      }
      const accent = slot === 1 ? 'var(--gold)' : 'var(--green-mid)';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--cream);border-left:3px solid ${accent};border-radius:0 7px 7px 0;margin-bottom:6px;font-size:13px">
        <span${isAdmin ? ` data-onclick="startEditPkDuty" data-onclick-a0="${r.id}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px"` : ''}>${_esc(r.profiles?.full_name || 'Unknown')}${r.profiles?.gender ? ` (${r.profiles.gender})` : ''}</span>
        ${isAdmin ? `<button data-onclick="removePkDuty" data-onclick-a0="${r.id}" style="border:none;background:none;color:var(--red);cursor:pointer;font-size:15px;padding:0 4px">✕</button>` : ''}
      </div>`;
    }).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:6px 0">No one assigned yet.</div>';

    // Exclude only therapists already assigned to THIS shift (a double-assignment the DB's
    // unique constraint would reject anyway) -- someone on Shift 1 can still be offered for
    // Shift 2 too, that's a legitimate (if unusual) real-world case, not blocked here.
    // Session 213: _pkTherapists (department='Panchakarma'), not the platform-wide _therapists.
    const availableTherapists = _pkTherapists.filter(t => !entries.some(r => r.profile_id === t.id));
    const options = availableTherapists.map(t => `<option value="${t.id}">${_esc(t.full_name)}</option>`).join('');
    const assignRow = isAdmin ? `
      <div style="display:flex;gap:6px;margin-top:8px">
        <select id="pkroster-assign-${slot}" style="flex:1;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12px;font-family:inherit">
          <option value="">— Assign therapist —</option>${options}
        </select>
        <button data-onclick="assignPkDuty" data-onclick-a0="${slot}" style="height:34px;padding:0 12px;background:var(--green-deep);color:#fff;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit">Add</button>
      </div>` : '';

    const dot = slot === 1 ? 'var(--gold)' : 'var(--green-mid)';
    return `<div style="background:var(--white);border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;box-shadow:0 1px 3px rgba(26,74,46,.06)">
      <div style="display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px;color:var(--green-deep);margin-bottom:8px">
        <span style="width:8px;height:8px;border-radius:50%;background:${dot};display:inline-block"></span>${_pkShiftLabel(slot)}
      </div>
      ${rows}${assignRow}
    </div>`;
  }).join('');

  // Session 222 -- real gap reported live: this view showed who's working but nothing about
  // who's off, forcing a cross-check against the separate Weekly Off list. Reuses
  // _pkPrepWarningReason()'s exact weekly-off/approved-leave logic for _pkRosterDate (already
  // loaded for the Prep Room dropdown's warning labels), just surfaced here too.
  const offToday = document.getElementById('pkroster-off-today');
  if (offToday) {
    const offList = _pkTherapists
      .map(t => ({ t, reason: _pkPrepWarningReason(t) }))
      .filter(x => x.reason);
    if (offList.length) {
      offToday.style.background = 'var(--gold-light)';
      offToday.style.border = '1.5px solid var(--gold)';
      offToday.style.color = 'var(--text-dark)';
      offToday.innerHTML = `<span style="font-size:15px">🌴</span> <strong>Off today:</strong> ${offList.map(x => `${_esc(x.t.full_name)} <span style="color:var(--text-muted);font-weight:400">(${x.reason.replace(' today', '')})</span>`).join(', ')}`;
    } else {
      offToday.style.background = 'var(--green-light)';
      offToday.style.border = '1.5px solid var(--border)';
      offToday.style.color = 'var(--text-mid)';
      offToday.innerHTML = `<span style="font-size:15px">✅</span> Full team today — no one on weekly off or approved leave.`;
    }
  }

  _renderPkPrepRoomCard(isAdmin);
  _loadPkWeekView();
}

// Session 221 -- "View Full Week": the day-view above only ever showed one day (Shift 1/2 +
// Prep Room cards); this is a read-only week-at-a-glance table of the ACTUAL published roster
// (pk_therapist_duty + pk_prep_room_duty), navigated independently of the single-day picker
// above it (browsing a week here doesn't change which day the edit cards show). Deliberately
// separate state from _pkRosterDate/_pkGenDays -- this isn't the hypothetical Generate Week
// Preview (that shows what WOULD be published), it's what's actually live right now.
let _pkWeekViewMonday = null;

function _weekDatesUTC(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

window.shiftPkWeekView = function(n) {
  const d = new Date(_pkWeekViewMonday);
  d.setUTCDate(d.getUTCDate() + Number(n) * 7);
  _pkWeekViewMonday = d.toISOString().slice(0, 10);
  _loadPkWeekView();
};
window.goToPkWeekViewThisWeek = function() {
  _pkWeekViewMonday = _mondayOf(new Date().toISOString().slice(0, 10));
  _loadPkWeekView();
};

async function _loadPkWeekView() {
  if (!_isPkRosterAdmin() && !_isRoomAdmin()) return; // matches _renderPkRosterPanel()'s own admin/viewer gate
  if (!_pkWeekViewMonday) _pkWeekViewMonday = _mondayOf(new Date().toISOString().slice(0, 10));
  const monday = _pkWeekViewMonday;
  const dates = _weekDatesUTC(monday);
  const sunday = dates[6];

  const label = document.getElementById('pkweekview-label');
  if (label) {
    label.textContent = `${new Date(monday+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})} – ${new Date(sunday+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}`;
  }

  const [dutyRes, prepRes] = await Promise.all([
    supabase.from('pk_therapist_duty')
      .select('duty_date,shift_slot,profiles!profile_id(id,full_name,gender)')
      .eq('tenant_id', tenantId)
      .gte('duty_date', monday).lte('duty_date', sunday),
    supabase.from('pk_prep_room_duty')
      .select('duty_date,profiles!profile_id(id,full_name)')
      .eq('tenant_id', tenantId)
      .gte('duty_date', monday).lte('duty_date', sunday),
  ]);
  if (dutyRes.error) console.error('pk week view duty load failed:', dutyRes.error);
  if (prepRes.error) console.error('pk week view prep load failed:', prepRes.error);
  const dutyRows = dutyRes.data || [];
  const prepRows = prepRes.data || [];

  const names = (list) => list.map(x => _esc(x.profiles?.full_name || 'Unknown')).join(', ') || '—';
  const today = new Date().toISOString().slice(0, 10);

  const rowsHtml = dates.map(dateStr => {
    const dow = new Date(dateStr).getUTCDay(); // 0=Sun..6=Sat, matches profiles.weekly_off_day
    const dayDuty = dutyRows.filter(r => r.duty_date === dateStr);
    const s1m = dayDuty.filter(r => r.shift_slot === 1 && r.profiles?.gender === 'M');
    const s1f = dayDuty.filter(r => r.shift_slot === 1 && r.profiles?.gender === 'F');
    const s2m = dayDuty.filter(r => r.shift_slot === 2 && r.profiles?.gender === 'M');
    const s2f = dayDuty.filter(r => r.shift_slot === 2 && r.profiles?.gender === 'F');
    const dayPrep = prepRows.filter(r => r.duty_date === dateStr);
    const off = _pkTherapists.filter(t => t.weekly_off_day === dow);
    const isToday = dateStr === today;
    return `<tr${isToday ? ' style="background:var(--green-light)"' : ''}>
      <td>${isToday ? '<strong>Today</strong> · ' : ''}${new Date(dateStr+'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'})}</td>
      <td>${names(s1m)}</td>
      <td>${names(s1f)}</td>
      <td>${names(s2m)}</td>
      <td>${names(s2f)}</td>
      <td>${names(dayPrep)}</td>
      <td style="color:var(--text-muted);font-size:12px">${off.map(t => _esc(t.full_name)).join(', ') || '—'}</td>
    </tr>`;
  }).join('');

  const table = document.getElementById('pkweekview-table');
  if (table) {
    table.innerHTML = `<div style="overflow-x:auto"><table class="sessions-table"><thead><tr>
      <th>Day</th><th>Shift 1 — Male</th><th>Shift 1 — Female</th><th>Shift 2 — Male</th><th>Shift 2 — Female</th><th>Prep Room In-charge</th><th>Weekly Off</th>
    </tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">This is the actual published roster — click a day in the section above to edit it. "Weekly Off" reflects each therapist's fixed weekly-off day only, not approved leave.</div>`;
  }
}

// Session 212 -- Prep Room In-charge. Session 218: headcount is now adjustable via Generate
// Week's own Prep Room input, so several people/day are now valid
// (unique(tenant_id,duty_date,profile_id), was unique(tenant_id,duty_date)) -- this card is a
// list + Add row now, matching the Shift 1/2 cards above, not a single-slot display.
function _renderPkPrepRoomCard(isAdmin) {
  const current = document.getElementById('pkroster-prep-current');
  const rows = _pkPrepRoomDuty;
  current.innerHTML = rows.length
    ? rows.map(row => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--cream);border-radius:7px;margin-bottom:6px;font-size:13px">
        <span>${_esc(row.profiles?.full_name || 'Unknown')}</span>
        ${isAdmin ? `<button data-onclick="removePkPrepRoom" data-onclick-a0="${row.id}" style="border:none;background:none;color:var(--red);cursor:pointer;font-size:15px;padding:0 4px">✕</button>` : ''}
      </div>`).join('')
    : '<div style="color:var(--text-muted);font-size:13px;padding:6px 0">No one assigned yet.</div>';

  const assignRowEl = document.getElementById('pkroster-prep-assign-row');
  assignRowEl.style.display = isAdmin ? 'flex' : 'none';
  if (!isAdmin) return;

  // Any active PANCHAKARMA therapist is eligible -- no gender filter, unlike Shift 1/2
  // (prep-room work isn't patient-facing). Session 213: _pkTherapists, not the platform-wide
  // _therapists (was wrongly offering Physiotherapist/Kriyakalpa/Yoga Demonstrator here, since
  // this posting has no gender filter to accidentally exclude them like Shift 1/2's does).
  // Excludes whoever's already assigned today (same exclusion Shift 1/2's own dropdowns use) --
  // a real double-assignment would be caught by the DB constraint anyway, this just keeps the
  // dropdown from offering it in the first place.
  // Session 212 (cont.): unlike Shift 1/2's manual dropdowns (deliberately left plain, per Dr.
  // Venkatesh), each option here is labelled with a weekly-off/leave warning when it applies --
  // manual assignment still allows it (this is an override tool, same as Shift 1/2), it's just
  // no longer a silent choice the way it was before this label existed.
  const assignedIds = new Set(rows.map(r => r.profile_id));
  const available = _pkTherapists.filter(t => !assignedIds.has(t.id));
  const sel = document.getElementById('pkroster-prep-select');
  sel.innerHTML = '<option value="">— Assign therapist —</option>' +
    available.map(t => {
      const reason = _pkPrepWarningReason(t);
      return `<option value="${t.id}">${_esc(t.full_name)}${reason ? ` — ⚠️ ${reason}` : ''}</option>`;
    }).join('');
}

// dow via getUTCDay() on a bare date string (no 'T00:00:00' suffix) -- same UTC-safe convention
// _mondayOf() already established in this file, so this never disagrees with the generator's
// own extract(dow from date) (also timezone-agnostic on a plain date).
function _pkPrepWarningReason(t) {
  const dow = new Date(_pkRosterDate).getUTCDay();
  const off = t.weekly_off_day === dow;
  const onLeave = _pkPrepLeaveIds.has(t.id);
  if (off && onLeave) return 'weekly off + on approved leave today';
  if (off) return 'weekly off today';
  if (onLeave) return 'on approved leave today';
  return null;
}

window.assignPkPrepRoom = async function() {
  const sel = document.getElementById('pkroster-prep-select');
  const profileId = sel.value;
  if (!profileId) { _alert('error', 'Select a therapist.'); return; }

  const therapist = _pkTherapists.find(t => t.id === profileId);
  const reason = therapist ? _pkPrepWarningReason(therapist) : null;
  if (reason && !confirm(`${therapist.full_name} is ${reason}. Assign as Prep Room In-charge anyway?`)) {
    return;
  }

  // Session 218 -- plain insert, not upsert: several people/day are now valid
  // (unique(tenant_id,duty_date,profile_id)), matching Shift 1/2's assignPkDuty() pattern
  // exactly instead of the old single-slot "replace whoever's there" upsert.
  const { error } = await supabase.from('pk_prep_room_duty').insert({
    tenant_id: tenantId,
    profile_id: profileId,
    duty_date: _pkRosterDate,
    created_by: myProfile?.id || null,
  });

  if (error) {
    _alert('error', safeErrorMessage(error, error.code === '23505' ? 'This therapist is already assigned to Prep Room today.' : 'Failed to assign Prep Room In-charge.'));
    return;
  }
  await loadAll();
};

window.removePkPrepRoom = async function(id) {
  const { error } = await supabase.from('pk_prep_room_duty').delete().eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to remove Prep Room In-charge.')); return; }
  await loadAll();
};

// Session 207 -- read-only "my shifts this week" for a plain therapist. Deliberately no
// date-picker/other-people's-names -- that's the full roster grid above, admin-only.
function _renderMyPkShiftsWeek() {
  const list = document.getElementById('pk-my-shifts-list');
  if (!_myPkShiftsWeek.length) {
    list.innerHTML = '<div style="color:var(--text-muted)">No shifts assigned this week yet.</div>';
    return;
  }
  list.innerHTML = _myPkShiftsWeek.map(r => {
    const d = new Date(r.duty_date + 'T00:00:00');
    const dayLabel = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
      <span>${_esc(dayLabel)}</span><span>${_esc(_pkShiftLabel(r.shift_slot))}</span>
    </div>`;
  }).join('');
}

// Session 216 -- Shift Times, same maker-checker flow as Roster Cycle (request_pk_shift_times()
// -> pending_approvals -> decide_approval(), decided by Medical Superintendent/Deputy MS/
// super_admin). Was a direct self-service upsert before this session; converted for parity with
// nursing's own governance model, per explicit design call.
function _renderPkShiftTimesCard(isAdmin) {
  const body = document.getElementById('pkroster-settings-body');
  if (!body) return;

  const current = `${_pkShiftLabel(1)} · ${_pkShiftLabel(2)}`;
  let html = `<div style="margin-bottom:10px"><span style="font-size:12.5px;color:var(--text-muted)">Current shift times:</span> `
    + `<span style="background:var(--green-light);color:var(--green-deep);font-weight:600;padding:2px 10px;border-radius:10px;font-size:12.5px">${_esc(current)}</span></div>`;

  if (_pkShiftPending) {
    const p = _pkShiftPending.payload || {};
    html += `<div style="font-size:12.5px;color:var(--text-mid)">⏳ Change to <strong>Shift 1 ${_esc((p.shift1_start||'').slice(0,5))} / Shift 2 ${_esc((p.shift2_start||'').slice(0,5))}</strong> requested by ${_esc(_pkShiftPending.requester?.full_name || '—')} on ${_esc((_pkShiftPending.requested_at || '').slice(0,10))} — awaiting Medical Superintendent / Deputy MS approval.</div>`;
  } else if (isAdmin) {
    html += '<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end">'
      + '<div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Shift 1 Start</label>'
      + `<input id="pkroster-shift1" type="time" value="${_esc(_pkRosterSettings?.shift1_start?.slice(0,5) || '09:00')}" style="width:100%;height:36px;border:1.5px solid var(--border);border-radius:7px;padding:0 10px;font-size:13px;font-family:inherit"/></div>`
      + '<div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Shift 2 Start</label>'
      + `<input id="pkroster-shift2" type="time" value="${_esc(_pkRosterSettings?.shift2_start?.slice(0,5) || '14:00')}" style="width:100%;height:36px;border:1.5px solid var(--border);border-radius:7px;padding:0 10px;font-size:13px;font-family:inherit"/></div>`
      + '<button data-onclick="requestPkShiftTimesChange" style="height:36px;padding:0 16px;background:var(--green-deep);color:#fff;border:none;border-radius:7px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit">Request Change</button>'
      + '</div>';
  } else {
    html += '<div style="font-size:12.5px;color:var(--text-muted)">Only the Panchakarma In-charge, dept admin, or super_admin can request a shift-times change.</div>';
  }

  body.innerHTML = html;
}

window.requestPkShiftTimesChange = async function() {
  const shift1 = document.getElementById('pkroster-shift1')?.value;
  const shift2 = document.getElementById('pkroster-shift2')?.value;
  if (!shift1 || !shift2) { _alert('error', 'Set both shift start times.'); return; }

  const { error } = await supabase.rpc('request_pk_shift_times', { p_shift1_start: shift1, p_shift2_start: shift2 });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not submit the shift-times change request.')); return; }
  await loadAll();
};

window.assignPkDuty = async function(slot) {
  const sel = document.getElementById(`pkroster-assign-${slot}`);
  const profileId = sel.value;
  if (!profileId) { _alert('error', 'Select a therapist.'); return; }

  const { error } = await supabase.from('pk_therapist_duty').insert({
    tenant_id: tenantId,
    profile_id: profileId,
    duty_date: _pkRosterDate,
    shift_slot: Number(slot),
    created_by: myProfile?.id || null,
  });

  if (error) {
    _alert('error', safeErrorMessage(error, error.code === '23505' ? 'This therapist is already assigned to this shift.' : 'Failed to assign duty.'));
    return;
  }
  await loadAll();
};

window.removePkDuty = async function(id) {
  const { error } = await supabase.from('pk_therapist_duty').delete().eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to remove duty assignment.')); return; }
  await loadAll();
};

// Session 220 -- click-a-name-to-swap. A lightweight re-render (_renderPkRosterPanel() reads
// only already-fetched module state, no network round trip) toggles which row shows its inline
// reassign <select> -- only a real swap (swapPkDuty, on the select's own onchange) touches the DB.
window.startEditPkDuty = function(id) {
  _pkEditingDutyId = id;
  _renderPkRosterPanel();
};
window.cancelEditPkDuty = function() {
  _pkEditingDutyId = null;
  _renderPkRosterPanel();
};
window.swapPkDuty = async function(id, sel) {
  const newProfileId = sel.value;
  _pkEditingDutyId = null;
  const row = _pkRosterDuty.find(r => r.id === id);
  if (!newProfileId || !row || row.profile_id === newProfileId) { _renderPkRosterPanel(); return; }

  const { error } = await supabase.from('pk_therapist_duty').update({ profile_id: newProfileId }).eq('id', id);
  if (error) {
    _alert('error', safeErrorMessage(error, error.code === '23505' ? 'That therapist is already assigned to this shift.' : 'Failed to reassign.'));
    return;
  }
  await loadAll();
};

window.shiftPkRosterDate = function(n) {
  const d = new Date(_pkRosterDate);
  d.setDate(d.getDate() + Number(n));
  _pkRosterDate = d.toISOString().slice(0,10);
  loadAll();
};
window.goToPkRosterToday = function() {
  _pkRosterDate = new Date().toISOString().slice(0,10);
  loadAll();
};
window.onPkRosterDatePick = function() {
  _pkRosterDate = document.getElementById('pkroster-date-picker').value;
  loadAll();
};

// ── Weekly Off (Session 206 cont.) ──────────────────────────────────────────────
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function _renderWeeklyOffList() {
  const list = document.getElementById('pkroster-weeklyoff-list');
  // Session 213: _pkTherapists (department='Panchakarma') -- weekly-off here only matters for
  // who's actually eligible for the roster this feeds (Shift 1/2 + Prep Room In-charge).
  if (!_pkTherapists.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No Panchakarma-department therapists registered yet.</div>'; return; }
  list.innerHTML = _pkTherapists.map(t => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:13px">${_esc(t.full_name)}</span>
      <select id="pkoff-${t.id}" style="height:32px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12px;font-family:inherit">
        <option value="">— None set —</option>
        ${WEEKDAY_NAMES.map((n, i) => `<option value="${i}"${t.weekly_off_day === i ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
      <button data-onclick="savePkWeeklyOff" data-onclick-a0="${t.id}" style="height:32px;padding:0 12px;background:var(--white);border:1.5px solid var(--border);border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit">Save</button>
    </div>`).join('');
}

window.savePkWeeklyOff = async function(profileId) {
  const val = document.getElementById(`pkoff-${profileId}`).value;
  const { error } = await supabase.rpc('set_pk_weekly_off', {
    p_profile_id: profileId,
    p_weekly_off_day: val === '' ? null : Number(val),
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to save weekly off.')); return; }
  _alert('success', 'Weekly off saved.');
  await loadAll();
};

// ── Generate Week (Session 206 cont., moved server-side Session 211) ───────────────────
// Session 211: the solver itself now runs in Postgres (preview_pk_week()/commit_pk_week()),
// matching the *technique* nursing's preview_nursing_week()/commit_nursing_week() use (dry-run
// preview -> commit re-derives the identical plan from the same inputs, never a client-cached
// payload) -- confirmed against nursing's real live function definitions first. Deliberately
// NOT the same table (duty_roster) or the same algorithm -- see sql/session211_preview_commit_
// pk_week.sql's header for why: duty_roster.shift_type is a closed 5-value enum with no
// per-tenant custom shift times, and Panchakarma already has 41 real duty_roster rows for
// NURSING staff (it's one of nursing's own 9 duty-scheduling departments) -- sharing that table
// for PK THERAPIST duty would collide two different staff pools in the same key space. Also no
// stale-plan-key guard needed anymore (unlike the old client-side version): since commit_pk_week
// always re-derives its plan by calling preview_pk_week() itself with the same inputs, "publish
// a stale plan" is structurally impossible now, not just detected.

// Real bug caught live testing on SDM (IST, UTC+5:30) while this was still client-side:
// `new Date(dateStr + 'T00:00:00')` parses as LOCAL midnight, but `.toISOString()` always
// serializes in UTC -- for any positive UTC offset that mismatch silently rolls the date back
// by one calendar day (confirmed: _mondayOf('2026-09-21'), a real Monday, returned '2026-09-20'
// instead). Fixed by staying in UTC calendar space end to end -- `new Date(dateStr)` (no time
// suffix) parses date-only strings as UTC midnight per spec, matching this file's own existing
// shiftDate()/goToday()/onPkRosterDatePick() convention. Still needed client-side to normalize
// whatever date the admin picks to the Monday the RPC requires (the RPC rejects non-Mondays
// outright rather than silently correcting them).
function _mondayOf(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0,10);
}

// Session 215 -- cycle-adaptive generation, same technique as nursingRosterGenerate.js's
// Session 167 rework: preview_pk_week()/commit_pk_week() themselves stay untouched (single-week
// only, proven correct); this just calls them once per Monday in the tenant's approved cycle
// (weekly/fortnightly/monthly, pk_roster_settings.cycle) and merges the results client-side.
// "Monthly" = 4 Monday-start weeks, matching nursing's own convention, not a calendar month.
// Deliberately NOT reusing nursing's _getMonday()/_dateStr() (those are local-time, internally
// consistent within nursingRosterGenerate.js's own domain) -- this file's own _mondayOf() is
// UTC-consistent instead (Session 206's real local/UTC-mixing bug fix), so period math here
// stays in that same UTC domain rather than mixing two conventions in one file.
const PK_CYCLE_WEEKS = { weekly: 1, fortnightly: 2, monthly: 4 };
const PK_CYCLE_META = {
  weekly:      { label: 'Weekly (7 days)',           periodLower: 'week',           btnPublish: 'Publish This Week' },
  fortnightly: { label: 'Fortnightly (14 days)',      periodLower: 'fortnight',      btnPublish: 'Publish This Fortnight' },
  monthly:     { label: 'Monthly (4-week month)',     periodLower: '4-week month',   btnPublish: 'Publish This Month' },
};

function _pkPeriodMondays(weekStart, weekCount) {
  return Array.from({ length: weekCount }, (_, i) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
}

// Combines N single-week preview_pk_week() results into one renderable shape -- 'days' concat
// straight across weeks (each already carries its own real date), counts sum, no_gender_count
// takes the max (it's the same tenant-wide figure every week, not something that accumulates).
function _mergePkPreviews(byWeek) {
  const days = [];
  let filled = 0, needed = 0, gaps = 0, noGender = 0;
  byWeek.forEach(({ result }) => {
    (result.days || []).forEach(d => days.push(d));
    filled += result.filled_count || 0;
    needed += result.needed_count || 0;
    gaps += result.gap_count || 0;
    noGender = Math.max(noGender, result.no_gender_count || 0);
  });
  return { days, filled_count: filled, needed_count: needed, gap_count: gaps, no_gender_count: noGender };
}

function _applyPkCycleLabels() {
  const meta = PK_CYCLE_META[_pkCycle] || PK_CYCLE_META.weekly;
  const label = document.getElementById('pkgen-cycle-label');
  if (label) label.textContent = `(Shift 1/2 gender-separated per Sch III/XXV; Prep Room In-charge headcount set separately below, any therapist — generating ${PK_CYCLE_WEEKS[_pkCycle]} week(s), this tenant's approved cycle is ${meta.periodLower})`;
}

let _pkGenDays = null;      // last merged preview 'days' -- kept only for re-rendering, not re-published (Publish re-runs the RPCs, see above)
let _pkGenMondaysKey = null; // JSON of the exact Mondays the current _pkGenDays was built from -- Publish refuses a stale/changed period, same discipline nursing's page uses

function _pkGenCounts() {
  return {
    shift1_male:   parseInt(document.getElementById('pkgen-shift1-male').value, 10)   || 0,
    shift1_female: parseInt(document.getElementById('pkgen-shift1-female').value, 10) || 0,
    shift2_male:   parseInt(document.getElementById('pkgen-shift2-male').value, 10)   || 0,
    shift2_female: parseInt(document.getElementById('pkgen-shift2-female').value, 10) || 0,
    // Session 218 -- Prep Room In-charge is now an adjustable headcount (default 1, same
    // behavior as before for anyone who never touches it), not a hardcoded "always exactly
    // 1/day" rule -- real workload can need more people as UG intake tier scales up.
    prep_count:    parseInt(document.getElementById('pkgen-prep-count')?.value, 10) ?? 1,
  };
}

// Session 217 -- real gap found live: requesting Shift 1+2 headcounts that consume the entire
// Panchakarma pool (e.g. 3M+3F/2M+2F against a real 5M+5F department) mathematically guarantees
// Prep Room In-charge gaps every single day -- there's nobody left over -- and the RPC correctly
// reports this as honest per-day "(gap)" cells, but that only surfaces AFTER clicking Preview,
// buried in a table. This computes the same arithmetic client-side and shows it live as the
// admin types, so the mismatch is obvious before running anything.
// Session 218: incorporates the now-adjustable prep_count into the same arithmetic (it used to
// be an implicit fixed +1 folded into "spare"; now it's requested via its own input like the
// shift boxes, so it's counted the same way they are).
window.updatePkHeadcountHint = function() {
  const hint = document.getElementById('pkgen-headcount-hint');
  if (!hint) return;
  const counts = _pkGenCounts();
  const maleNeeded = counts.shift1_male + counts.shift2_male;
  const femaleNeeded = counts.shift1_female + counts.shift2_female;
  const totalNeeded = maleNeeded + femaleNeeded + counts.prep_count;
  if (totalNeeded <= 0) { hint.textContent = ''; return; }

  const malePool = _pkTherapists.filter(t => t.gender === 'M').length;
  const femalePool = _pkTherapists.filter(t => t.gender === 'F').length;
  const totalPool = _pkTherapists.length;
  const spare = totalPool - totalNeeded;

  if (maleNeeded > malePool || femaleNeeded > femalePool) {
    hint.innerHTML = `⚠️ <strong>Not enough therapists for Shift 1+2 alone</strong>: this asks for ${maleNeeded}M/${femaleNeeded}F every day but only ${malePool}M/${femalePool}F exist in Panchakarma. Every day will show Shift gaps.`;
    hint.style.color = 'var(--red)';
  } else if (spare < 0) {
    hint.innerHTML = `⚠️ Requesting ${maleNeeded + femaleNeeded} for Shift 1+2 plus ${counts.prep_count} for Prep Room = ${totalNeeded}, but only ${totalPool} Panchakarma therapists exist — <strong>${-spare} short every day</strong> even before weekly-off/leave.`;
    hint.style.color = 'var(--red)';
  } else if (spare === 0) {
    hint.innerHTML = `Requesting all ${totalPool} of your ${totalPool} Panchakarma therapists (Shift 1+2 + Prep Room combined) — <strong>zero spare</strong>, so any day with a weekly off or approved leave will fall short.`;
    hint.style.color = 'var(--gold)';
  } else {
    hint.innerHTML = `${totalNeeded} of ${totalPool} therapists requested per day (incl. ${counts.prep_count} for Prep Room) — ${spare} spare for weekly-off/leave coverage.`;
    hint.style.color = 'var(--text-muted)';
  }
};

window.previewPkWeek = async function() {
  const rawDate = document.getElementById('pkgen-week-start').value;
  if (!rawDate) { _alert('error', 'Pick a week start date.'); return; }
  const weekStart = _mondayOf(rawDate);
  document.getElementById('pkgen-week-start').value = weekStart;

  const counts = _pkGenCounts();
  if (!Object.values(counts).some(n => n > 0)) { _alert('error', 'Enter at least one shift or Prep Room headcount.'); return; }

  const weekCount = PK_CYCLE_WEEKS[_pkCycle] || 1;
  const mondays = _pkPeriodMondays(weekStart, weekCount);
  const btn = document.getElementById('pkgen-preview-btn');
  if (btn) btn.disabled = true;
  const byWeek = [];
  try {
    for (const monday of mondays) {
      if (btn && mondays.length > 1) btn.textContent = `Generating week starting ${monday}…`;
      const { data, error } = await supabase.rpc('preview_pk_week', { p_week_start: monday, p_counts: counts });
      if (error) { _alert('error', safeErrorMessage(error, `Failed to generate the preview for the week starting ${monday}.`)); return; }
      byWeek.push({ monday, result: data });
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Preview'; }
  }

  const merged = _mergePkPreviews(byWeek);
  _pkGenDays = merged.days;
  // Session 218 -- real pre-existing gap found while touching this: the stale-preview guard
  // only ever compared the Monday list, never the headcounts, so changing a count (e.g.
  // prep_count) after previewing -- without re-previewing -- would silently publish the NEW
  // numbers under the OLD, already-reviewed preview. Now keys on both.
  _pkGenMondaysKey = JSON.stringify({ mondays, counts });
  _renderPkGenPreview(weekStart, mondays, merged);
};

function _renderPkGenPreview(weekStart, mondays, result) {
  const el = document.getElementById('pkgen-preview');
  if (!_pkGenDays) { el.innerHTML = ''; return; }

  const meta = PK_CYCLE_META[_pkCycle] || PK_CYCLE_META.weekly;
  const cell = (list, gap) => ((list || []).map(t => _esc(t.full_name)).join(', ') || '—') + (gap ? ` <span style="color:var(--red)">(short ${gap})</span>` : '');
  const periodEnd = new Date(mondays[mondays.length - 1]); periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);

  el.innerHTML = `
    <div style="margin-bottom:10px;font-size:13px">
      ${result.gap_count === 0 ? '✅' : '⚠️'} <strong>${result.filled_count}/${result.needed_count}</strong> slots filled for the ${meta.periodLower} starting ${new Date(weekStart+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})} through ${periodEnd.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}${result.gap_count ? ` — <strong>${result.gap_count} gap(s)</strong>` : ''}.
      ${result.no_gender_count ? `<br/><span style="color:var(--text-muted)">${result.no_gender_count} therapist(s) have no gender on file and were excluded from the Shift 1/2 rotation (still eligible for Prep Room In-charge) — set it via their Account Settings first.</span>` : ''}
    </div>
    <div style="overflow-x:auto">
    <table class="sessions-table"><thead><tr>
      <th>Day</th><th>Shift 1 — Male</th><th>Shift 1 — Female</th><th>Shift 2 — Male</th><th>Shift 2 — Female</th><th>Prep Room In-charge</th><th>Off / Unavailable</th>
    </tr></thead><tbody>${_pkGenDays.map(d => `
      <tr>
        <td>${new Date(d.date+'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'})}</td>
        <td>${cell(d.shift1_male, d.shift1_male_gap)}</td>
        <td>${cell(d.shift1_female, d.shift1_female_gap)}</td>
        <td>${cell(d.shift2_male, d.shift2_male_gap)}</td>
        <td>${cell(d.shift2_female, d.shift2_female_gap)}</td>
        <td>${cell(d.prep_incharge, d.prep_incharge_gap)}</td>
        <td style="color:var(--text-muted);font-size:12px">${d.off.map(t => _esc(t.full_name)).join(', ') || '—'}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    <button data-onclick="publishPkWeek" style="margin-top:10px;height:40px;padding:0 18px;background:var(--green-deep);color:#fff;border:none;border-radius:7px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit">${_esc(meta.btnPublish)}</button>
    <span id="pkgen-published" style="display:none;margin-left:10px;color:var(--green-mid);font-size:13px;font-weight:600">✓ Published</span>
  `;
}

window.publishPkWeek = async function() {
  if (!_pkGenDays) { _alert('error', `Preview this ${(PK_CYCLE_META[_pkCycle] || PK_CYCLE_META.weekly).periodLower} before publishing.`); return; }
  const rawDate = document.getElementById('pkgen-week-start').value;
  const weekStart = _mondayOf(rawDate);
  const counts = _pkGenCounts();
  const weekCount = PK_CYCLE_WEEKS[_pkCycle] || 1;
  const mondays = _pkPeriodMondays(weekStart, weekCount);
  const meta = PK_CYCLE_META[_pkCycle] || PK_CYCLE_META.weekly;

  // Same guard nursing's Generate Roster uses -- a stale preview from a different week/cycle/
  // headcount combination can never be silently published; both the exact Mondays AND the exact
  // counts previewed must match what's about to be committed.
  if (_pkGenMondaysKey !== JSON.stringify({ mondays, counts })) {
    _alert('error', `Preview this exact ${meta.periodLower} again before publishing.`);
    return;
  }

  const publishBtn = document.querySelector('#pkgen-preview button[data-onclick="publishPkWeek"]');
  if (publishBtn) publishBtn.disabled = true;
  let totalCreated = 0;
  for (let i = 0; i < mondays.length; i++) {
    const monday = mondays[i];
    if (publishBtn && mondays.length > 1) publishBtn.textContent = `Publishing week ${i+1} of ${mondays.length}…`;
    const { data, error } = await supabase.rpc('commit_pk_week', { p_week_start: monday, p_counts: counts });
    if (error) {
      _alert('error', safeErrorMessage(error, `Failed to publish the week starting ${monday}.`)
        + (i > 0 ? ` ${i} week(s) before it published successfully — only the remaining week(s) need re-running.` : ''));
      if (publishBtn) { publishBtn.disabled = false; publishBtn.textContent = meta.btnPublish; }
      return;
    }
    totalCreated += (data?.created || 0);
  }

  const published = document.getElementById('pkgen-published');
  if (published) { published.style.display = ''; setTimeout(() => { published.style.display = 'none'; }, 2500); }
  _pkGenDays = null;
  _pkGenMondaysKey = null;
  await loadAll();
};

// ── Roster Cycle (Session 215) ──────────────────────────────────────────────────
// Same maker-checker flow as nursing's own Roster Cycle card, per explicit design call: PK's
// roster is already single-role-controlled (pk_incharge/dept admin/super_admin, no separate
// approver), but parity with nursing's real governance model was the ask, not a simplified
// self-service picker. request_pk_roster_cycle() re-derives "is this caller really allowed to
// request" server-side (_pk_roster_admin_ok()) -- isAdmin below is only a display hint.
function _renderPkCycleCard(isAdmin) {
  const body = document.getElementById('pkroster-cycle-body');
  if (!body) return;

  let html = `<div style="margin-bottom:10px"><span style="font-size:12.5px;color:var(--text-muted)">Current cycle:</span> `
    + `<span style="background:var(--green-light);color:var(--green-deep);font-weight:600;padding:2px 10px;border-radius:10px;font-size:12.5px">${_esc((PK_CYCLE_META[_pkCycle] || PK_CYCLE_META.weekly).label)}</span></div>`;

  if (_pkCyclePending) {
    const reqCycle = _pkCyclePending.payload?.cycle;
    html += `<div style="font-size:12.5px;color:var(--text-mid)">⏳ Change to <strong>${_esc((PK_CYCLE_META[reqCycle] || {}).label || reqCycle)}</strong> requested by ${_esc(_pkCyclePending.requester?.full_name || '—')} on ${_esc((_pkCyclePending.requested_at || '').slice(0,10))} — awaiting Medical Superintendent / Deputy MS approval.</div>`;
  } else if (isAdmin) {
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<select id="pkroster-cycle-select" style="height:32px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12.5px;font-family:inherit">'
      + Object.entries(PK_CYCLE_META).map(([v, m]) => `<option value="${v}"${v === _pkCycle ? ' selected' : ''}>${_esc(m.label)}</option>`).join('')
      + '</select>'
      + '<button data-onclick="requestPkRosterCycleChange" style="height:32px;padding:0 14px;background:var(--green-deep);color:#fff;border:none;border-radius:7px;font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit">Request Change</button>'
      + '</div>';
  } else {
    html += '<div style="font-size:12.5px;color:var(--text-muted)">Only the Panchakarma In-charge, dept admin, or super_admin can request a cycle change.</div>';
  }

  body.innerHTML = html;
}

window.requestPkRosterCycleChange = async function() {
  const sel = document.getElementById('pkroster-cycle-select');
  const cycle = sel?.value;
  if (!cycle) return;
  const { error } = await supabase.rpc('request_pk_roster_cycle', { p_cycle: cycle });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not submit the roster-cycle change request.')); return; }
  await loadAll();
};

// ── Date nav ──────────────────────────────────────────────────────────────────
window.shiftDate = function(n) {
  const d = new Date(_viewDate);
  d.setDate(d.getDate() + Number(n));
  _viewDate = d.toISOString().slice(0,10);
  document.getElementById('date-picker').value = _viewDate;
  loadAll();
};
window.goToday = function() {
  _viewDate = new Date().toISOString().slice(0,10);
  document.getElementById('date-picker').value = _viewDate;
  loadAll();
};
window.onDatePick = function() {
  _viewDate = document.getElementById('date-picker').value;
  loadAll();
};
function _updateDateDisplay() {
  const d = new Date(_viewDate + 'T00:00:00');
  const today = new Date().toISOString().slice(0,10);
  const label = _viewDate === today ? 'Today · ' : '';
  document.getElementById('date-display').textContent =
    label + d.toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'long', year:'numeric' });
  document.getElementById('date-picker').value = _viewDate;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  const all = _sessions;
  document.getElementById('stat-total').textContent      = all.length;
  document.getElementById('stat-scheduled').textContent  = all.filter(s=>s.status==='scheduled').length;
  document.getElementById('stat-inprogress').textContent = all.filter(s=>s.status==='in_progress').length;
  document.getElementById('stat-completed').textContent  = all.filter(s=>s.status==='completed').length;

  // NCISM §47(vii) compliance banner
  const banner  = document.getElementById('ncism47-banner');
  const detail  = document.getElementById('ncism47-detail');
  const active  = all.filter(s => s.status !== 'skipped');
  if (!active.length) { banner.style.display = 'none'; return; }
  const cleared = active.filter(s => s.doctor_clearance).length;
  const pct     = Math.round(cleared / active.length * 100);
  banner.style.display = '';
  banner.className = `ncism47-banner ${pct === 100 ? 'ok' : pct < 50 ? 'danger' : ''}`;
  detail.innerHTML = `
    <span class="ncism47-pill ${pct===100?'green':pct<50?'red':'amber'}">${cleared}/${active.length} cleared</span>
    <span class="ncism47-meta">${pct===100 ? 'All sessions fitness-cleared ✓' : `${active.length - cleared} session(s) without PK fitness clearance`}</span>
  `;
}

// Session 227 -- Room Occupancy grid. Window spans both configured shifts (falls back to the
// same 09:00/14:00/8h defaults _pkShiftLabel() uses if settings haven't loaded yet), in 30-min
// columns -- fine granularity without an unreadable number of columns for a typical 8-9hr span.
function _pkShiftWindow() {
  const { byShift } = _pkShiftWindows();
  return { startMin: Math.min(byShift[1].start, byShift[2].start), endMin: Math.max(byShift[1].end, byShift[2].end) };
}
// Session 228 -- per-shift windows, not just the combined min/max above: a slot at 06:00 is
// only actually staffed by whoever's on duty for the SHIFT that covers 06:00, not by anyone
// rostered anywhere that day regardless of shift (the bug this replaced -- a Shift 2 person
// starting at 07:00 was being counted as "available" for a 06:00 slot).
function _pkShiftWindows() {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const s1 = _pkRosterSettings?.shift1_start || '09:00';
  const s2 = _pkRosterSettings?.shift2_start || '14:00';
  const dur = (_pkRosterSettings?.shift_duration_hours || 8) * 60;
  return { byShift: { 1: { start: toMin(s1), end: toMin(s1) + dur }, 2: { start: toMin(s2), end: toMin(s2) + dur } } };
}
const _fmtMin = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

let _roomOccupancyToken = 0; // guards against a slower stale render landing after a newer one (date navigated away mid-fetch)

async function _renderRoomOccupancyGrid() {
  const token = ++_roomOccupancyToken;
  const wrap = document.getElementById('pkroom-occupancy-details');
  const isAdmin = _isPkRosterAdmin() || _isRoomAdmin();
  // Session 223's same widened-visibility population -- a plain therapist's _sessions is
  // already narrowed to "mine", which would make every other room falsely look empty here.
  wrap.style.display = isAdmin ? '' : 'none';
  if (!isAdmin) return;

  const grid = document.getElementById('pkroom-occupancy-grid');
  const activeRooms = _rooms.filter(r => r.status === 'active');
  if (!activeRooms.length) { grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No active treatment rooms configured.</div>'; return; }

  const { startMin, endMin } = _pkShiftWindow();
  const slotLen = 30;
  const slots = [];
  for (let m = startMin; m < endMin; m += slotLen) slots.push(m);

  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  // Sessions actually placed in a room+time today, with their real span (defaults to one
  // slot's worth when no planned_duration_minutes is set -- can't know the true span otherwise).
  const placed = _sessions.filter(s => s.room_id && s.scheduled_time && s.status !== 'skipped');
  // For the "is anyone actually free to staff this" check below, ANY timed session counts
  // toward a therapist being busy, room-assigned or not (a therapist can't be in two places).
  // Session 229 -- counts every assigned therapist on a multi-therapist session, not just the
  // primary, since all of them are genuinely occupied for its duration.
  const timed = _sessions.filter(s => s.scheduled_time && s.status !== 'skipped' && _sessionAllTherapists(s).length);

  // Session 228 -- real gap found live: this grid showed a room as freely schedulable purely
  // by room occupancy, with no check that an on-duty therapist of the right gender was even
  // available to staff it (surfaced when only 3M+3F were actually rostered for the morning
  // shift, not enough to staff all 4+4 rooms at once). Fetched fresh for _viewDate specifically
  // -- NOT the Duty Roster panel's own independently-browsable _pkRosterDate, which can be a
  // different day than the one this grid is showing.
  const { data: dutyRows } = await supabase
    .from('pk_therapist_duty')
    .select('shift_slot, profiles!profile_id(id,gender)')
    .eq('tenant_id', tenantId)
    .eq('duty_date', _viewDate);
  if (token !== _roomOccupancyToken) return; // a newer render has since started -- discard this one
  const dutyByShift = (dutyRows || []).filter(r => r.profiles);
  const { byShift } = _pkShiftWindows();
  // Which shift(s) actually cover a given slot -- both, if the tenant's 2 shifts overlap.
  const activeShiftsAt = (slotStart, slotEnd) =>
    [1, 2].filter(n => byShift[n].start < slotEnd && byShift[n].end > slotStart);

  const genderOrder = { female: 0, male: 1, any: 2 };
  const sortedRooms = [...activeRooms].sort((a, b) =>
    (genderOrder[a.gender_restriction] ?? 2) - (genderOrder[b.gender_restriction] ?? 2) || a.room_name.localeCompare(b.room_name));

  const header = `<tr><th style="min-width:110px">Room</th>${slots.map(m => `<th style="min-width:64px;font-size:10.5px">${_fmtMin(m)}</th>`).join('')}</tr>`;

  const rows = sortedRooms.map(r => {
    const roomSessions = placed.filter(s => s.room_id === r.id);
    const genderLabel = r.gender_restriction === 'female' ? 'Female' : r.gender_restriction === 'male' ? 'Male' : 'Any';
    const cells = slots.map(slotStart => {
      const slotEnd = slotStart + slotLen;
      const overlaps = (s) => {
        const start = toMin(s.scheduled_time.slice(0, 5));
        const end = start + (s.planned_duration_minutes || slotLen);
        return start < slotEnd && end > slotStart;
      };
      const hit = roomSessions.find(overlaps);
      if (!hit) {
        // Who's on duty for whichever shift(s) actually cover this slot, of this room's
        // designated gender, and not already busy with a DIFFERENT session (any room) at
        // this exact slot.
        const activeShifts = activeShiftsAt(slotStart, slotEnd);
        const busyIds = new Set(timed.filter(overlaps).flatMap(s => _sessionAllTherapists(s).map(t => t.id)));
        const eligible = dutyByShift.filter(r2 => activeShifts.includes(r2.shift_slot)).map(r2 => r2.profiles).filter(p =>
          (r.gender_restriction === 'any' || !r.gender_restriction || (p.gender === 'M' ? 'male' : 'female') === r.gender_restriction)
          && !busyIds.has(p.id));
        if (!eligible.length) {
          return `<td style="background:#eee;text-align:center;color:var(--text-muted);font-size:11px" title="No on-duty ${genderLabel.toLowerCase()} therapist is free for ${_esc(r.room_name)} at ${_fmtMin(slotStart)} -- everyone rostered is either off today or already in another session">🚫</td>`;
        }
        return `<td data-onclick="quickScheduleAt" data-onclick-a0="${_fmtMin(slotStart)}" style="cursor:pointer;background:var(--success-bg);text-align:center;color:var(--success-text);font-size:16px" title="Click to schedule a session in ${_esc(r.room_name)} at ${_fmtMin(slotStart)}">+</td>`;
      }
      const isFirstSlot = toMin(hit.scheduled_time.slice(0, 5)) >= slotStart && toMin(hit.scheduled_time.slice(0, 5)) < slotEnd;
      const name = _esc(hit.patients?.name || 'Patient');
      return `<td style="background:var(--gold-light);font-size:10.5px;padding:4px 6px;${isFirstSlot ? '' : 'opacity:.55'}">${isFirstSlot ? name : '···'}</td>`;
    }).join('');
    return `<tr><td style="font-weight:600;font-size:12.5px">${_esc(r.room_name)}<div class="pt-meta">${genderLabel}${r.room_type ? ' · ' + _esc(r.room_type) : ''}</div></td>${cells}</tr>`;
  }).join('');

  grid.innerHTML = `<table class="sessions-table"><thead>${header}</thead><tbody>${rows}</tbody></table>
    <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">🟩 Click an open slot to schedule a session there. 🚫 = physically free but no on-duty, unbusy therapist of the right gender exists for that slot. Occupied slots show the patient's name (a session with no set duration is shown occupying one 30-min slot only).</div>`;
}

// Session 227 -- clicking an open Room Occupancy slot jumps straight into "+ Schedule Session"
// with the date/time pre-filled. Deliberately does NOT also pre-fill the room: which rooms are
// even offered depends on the patient's gender (Session 226), not known until a patient is
// picked, so pre-locking a room here could silently end up wrong-gender or get wiped the moment
// _autoAssignSchedTherapist() re-filters the room dropdown after patient selection.
window.quickScheduleAt = function(timeStr) {
  openSchedDrawer();
  document.getElementById('sched-date').value = _viewDate;
  document.getElementById('sched-time').value = timeStr;
};

// ── Populate filters + sched selects ─────────────────────────────────────────
function _populateFilterSelects() {
  const ft = document.getElementById('filter-therapist');
  const ft_val = ft.value;
  ft.innerHTML = '<option value="">All Therapists</option>';
  _therapists.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.full_name;
    ft.appendChild(o);
  });
  if (ft_val) ft.value = ft_val;

  const fd = document.getElementById('filter-dept');
  const fd_val = fd.value;
  fd.innerHTML = '<option value="">All Departments</option>';
  _depts.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    fd.appendChild(o);
  });
  if (fd_val) fd.value = fd_val;
}

function _populateSchedSelects() {
  // Admissions
  const sa = document.getElementById('sched-admission');
  sa.innerHTML = '<option value="">— Select admitted patient —</option>';
  _admissions.forEach(a => {
    const pt  = a.patients || {};
    const bed = a.beds || {};
    const o = document.createElement('option');
    o.value = JSON.stringify({ admId: a.id, patientId: pt.id, patientName: pt.name });
    o.textContent = `${pt.name} — Bed ${bed.bed_number || '?'}`;
    sa.appendChild(o);
  });

  // Depts
  const sd = document.getElementById('sched-dept');
  sd.innerHTML = '<option value="">— Select department —</option>';
  _depts.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    sd.appendChild(o);
  });

  // Therapists
  _populateTherapistSelect();

  // Rooms (Session 206)
  _populateRoomSelect();

  // Session 223 -- reuses the already-loaded _prepStaff list (role in super_admin/dept_admin/
  // doctor/therapist/nurse, Session 206), filtered to doctors only -- no new query needed.
  const sdoc = document.getElementById('sched-doctor');
  sdoc.innerHTML = '<option value="">— Not specified —</option>' +
    _prepStaff.filter(p => p.role === 'doctor').map(p => `<option value="${p.id}">${_esc(p.full_name)}</option>`).join('');
}

// Session 226 -- NCISM Sch III/XXV gender-separated treatment rooms: pk_treatment_rooms.
// gender_restriction was already tracked (Rooms admin panel/compliance banner) but never once
// checked when actually booking a patient into a room -- a real, previously-unknown gap found
// live when a test patient landed in a cross-gender room. 'any'/null rooms always match.
function _roomMatchesGender(room, patientGender) {
  if (!patientGender || !room.gender_restriction || room.gender_restriction === 'any') return true;
  return (patientGender === 'M' && room.gender_restriction === 'male')
      || (patientGender === 'F' && room.gender_restriction === 'female');
}

// Session 235 -- real gap found live: only one patient can ever be treated in a room at a time
// (Dr. Venkatesh's explicit confirmation), but the old pre-check only ever caught an EXACT
// matching start time -- two sessions genuinely overlapping at different start times (e.g.
// 06:00-06:25 and 06:10-06:25 in the same room) slipped through both this heads-up AND the old
// DB unique index. Now mirrors the real DB-level fix (pk_sessions_room_overlap_excl, a true
// time-range exclusion constraint) -- defaults an unset duration to 30 min, same as the DB
// column's own generated time_range default.
async function _checkRoomOverlap(roomId, date, time, durationMinutes, excludeSessionId) {
  const { data: rows } = await supabase.from('pk_therapy_sessions')
    .select('id, scheduled_time, planned_duration_minutes, patients(name)')
    .eq('room_id', roomId).eq('scheduled_date', date).neq('status', 'skipped')
    .not('scheduled_time', 'is', null);
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const newStart = toMin(time);
  const newEnd = newStart + (durationMinutes || 30);
  for (const r of rows || []) {
    if (excludeSessionId && r.id === excludeSessionId) continue;
    const start = toMin(r.scheduled_time.slice(0, 5));
    const end = start + (r.planned_duration_minutes || 30);
    if (newStart < end && newEnd > start) return r;
  }
  return null;
}

function _populateRoomSelect(patientGender) {
  const sr = document.getElementById('sched-room');
  const note = document.getElementById('sched-room-note');
  sr.innerHTML = '<option value="">— Not assigned —</option>';
  const allActive = _rooms.filter(r => r.status === 'active');
  const active = allActive.filter(r => _roomMatchesGender(r, patientGender));
  active.forEach(r => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = `${r.room_name}${r.room_type ? ' — ' + r.room_type : ''}`;
    sr.appendChild(o);
  });
  note.style.display = active.length ? 'none' : '';
  note.textContent = allActive.length
    ? `No ${patientGender === 'M' ? 'male' : 'female'}-designated treatment room available — assign this patient once one is set up.`
    : 'No treatment rooms configured yet — set them up in the 🛏 Treatment Rooms panel above.';
}

function _populateTherapistSelect() {
  const st = document.getElementById('sched-therapist');
  const note = document.getElementById('therapist-note');
  st.innerHTML = '<option value="">— Select therapist —</option>';

  // Session 213 (cont.) -- _pkTherapists (department='Panchakarma'), not the platform-wide
  // _therapists. A real Panchakarma therapy session should only ever be conducted by a
  // Panchakarma-department therapist -- this was previously offering all 14 role='therapist'
  // profiles platform-wide (including Physiotherapist/Kriyakalpa/Yoga Demonstrator), and the
  // Sch XX/33 compliance note below was only "correct" by the same accident the Duty Roster's
  // was (those 4 have no gender set, so they never actually skewed the M/F count -- but they
  // were still selectable to actually conduct a PK procedure, which is the real bug).
  const males   = _pkTherapists.filter(t => t.gender === 'M');
  const females = _pkTherapists.filter(t => t.gender === 'F');
  const unknown = _pkTherapists.filter(t => !t.gender);

  [
    { group: 'Male Therapists', list: males },
    { group: 'Female Therapists', list: females },
    { group: 'Therapists', list: unknown },
  ].forEach(({ group, list }) => {
    if (!list.length) return;
    const og = document.createElement('optgroup');
    og.label = group;
    list.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.full_name;
      og.appendChild(o);
    });
    st.appendChild(og);
  });

  if (!_pkTherapists.length) {
    note.textContent = 'No Panchakarma-department therapists registered yet. Add staff with role "therapist" under the Panchakarma department via the signup flow.';
    note.style.color = 'var(--gold)';
  } else {
    const m = males.length, f = females.length;
    // Session 206: was hardcoded "2M+2F" regardless of intake tier — didn't match any real
    // tier (Sch XX/33's own 60-intake row is 3M+3F). Now pulls the real per-tier figure from
    // the same NCISM_XX_ROWS the HR compliance ladder uses, so this note can't drift from it.
    if (_ugTier) {
      const row = NCISM_XX_ROWS.find(r => r[4] === 'Sch XX/33');
      const total = row ? (row[3][_ugTier] || 0) : 0;
      const half = Math.ceil(total / 2);
      note.textContent = `${_pkTherapists.length} therapist(s) available — ${m}M / ${f}F (NCISM Sch XX/33 needs ${half}M+${half}F for your ${_ugTier} UG intake)`;
      note.style.color = (m >= half && f >= half) ? 'var(--green-mid)' : 'var(--gold)';
    } else {
      note.textContent = `${_pkTherapists.length} therapist(s) available — ${m}M / ${f}F`;
      note.style.color = 'var(--text-mid)';
    }
  }
}

// ── Render table ──────────────────────────────────────────────────────────────
window.applyFilters = function() {
  const ft = document.getElementById('filter-therapist').value;
  const fd = document.getElementById('filter-dept').value;
  const fs = document.getElementById('filter-status').value;

  let rows = _sessions;
  if (ft) rows = rows.filter(s => s.profiles?.id === ft);
  if (fd) rows = rows.filter(s => s.departments?.id === fd);
  if (fs) rows = rows.filter(s => s.status === fs);

  renderTable(rows);
};

// Session 229 -- some procedures genuinely need 2-4 therapists at once (e.g. Pizhichil,
// Njavara Kizhi). pk_therapy_session_therapists holds the ADDITIONAL ones only -- the primary
// (s.profiles) stays the single source of truth everywhere it was already used (auto-assign
// continuity-of-care, fairness load-balancing, the gold "isMine" highlight), so this helper is
// only needed where "every therapist on this session" genuinely matters (busy-checks, gender
// validation, display).
function _sessionAllTherapists(s) {
  const extra = (s.pk_therapy_session_therapists || []).map(r => r.profiles).filter(Boolean);
  return s.profiles?.id ? [s.profiles, ...extra] : extra;
}

function renderTable(rows) {
  const tbody = document.getElementById('sessions-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="table-empty">No sessions for this date.<br>Use "+ Schedule Session" to add one.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(s => {
    const pt        = s.patients || {};
    const therapist = s.profiles || {};
    const dept      = s.departments || {};
    const doctor    = s.ordering_doctor || {};
    const timeStr   = s.scheduled_time ? s.scheduled_time.slice(0,5) : '—';
    const canStart  = s.status === 'scheduled';
    const canComplete = s.status === 'scheduled' || s.status === 'in_progress';
    const canSkip   = s.status === 'scheduled';

    // Session 223 -- was an 11px muted subtext, easy to miss (reported live). Kept inline
    // under the name (not its own column, per Dr. Venkatesh's correction) but as a real
    // badge now so it's actually legible at a glance.
    const genderLabel = pt.gender === 'M' ? 'Male' : pt.gender === 'F' ? 'Female' : null;
    const ptMeta = [genderLabel, pt.age ? pt.age + 'y' : null].filter(Boolean).join(' · ');
    // Session 223 -- highlights this row when it's assigned to the logged-in therapist, so
    // the Pk Incharge/admin's now-widened full-department view still makes their own
    // sessions easy to spot at a glance (same purpose as the Week View's "today" highlight).
    const isMine = role === 'therapist' && therapist.id && therapist.id === myProfile?.id;
    const durationLabel = s.planned_duration_minutes ? `${s.planned_duration_minutes} min` : '—';
    const instructionsFull = s.special_instructions || '';
    const instructionsShort = instructionsFull.length > 45 ? instructionsFull.slice(0, 45) + '…' : instructionsFull;
    // Session 206: prefer the real room resource; therapy_room_number is legacy free text
    // (0 rows platform-wide used it, kept only as a fallback for any pre-migration row).
    const roomName = s.pk_treatment_rooms?.room_name || s.therapy_room_number;
    const roomLabel = roomName ? `<div class="pt-meta">${_esc(roomName)}</div>` : '';

    // Fitness badge (NCISM §47(vii))
    const isPurva = s.therapy_phase === 'purvakarma';
    let fitnessBadge;
    if (s.status === 'skipped') {
      fitnessBadge = '—';
    } else if (s.doctor_clearance) {
      fitnessBadge = `<span class="fitness-ok">✓ Cleared</span>`;
    } else if (isPurva && s.status !== 'completed') {
      fitnessBadge = `<span class="fitness-block">✗ Not cleared</span>`;
    } else {
      fitnessBadge = `<span class="fitness-warn">⚠ Pending</span>`;
    }

    // Samsarjana indicator for Paschatkarma
    const samLabel = s.samsarjana_stage
      ? `<div class="pt-meta" style="color:#7a5a00">🍚 ${_samLabel(s.samsarjana_stage)}</div>`
      : '';

    // Session 225 -- inline Time/Duration editing directly on the table (was only reachable
    // via "+ Schedule Session" at creation or the Assign Room & Therapist drawer afterward).
    // Same click-to-edit convention as _pkEditingDutyId's grid above: click the value, it
    // becomes a real input pre-filled with the current value, commits on change.
    // Session 239 -- same restriction as the 🏠 Assign drawer: Time/Duration are logistics
    // fields owned by the Pk Incharge, not any therapist. A non-admin now sees plain read-only
    // text here (no click-to-edit affordance) instead of the underlined value.
    const _canEditSlot = _isPkRosterAdmin();
    const timeCell = _canEditSlot && _editSessionCell?.id === s.id && _editSessionCell.field === 'time'
      ? `<input type="time" value="${s.scheduled_time ? s.scheduled_time.slice(0,5) : ''}"
           data-onchange="saveSessionCell" data-onchange-a0="${s.id}" data-onchange-a1="time" data-onchange-a2="@value"
           data-onblur="cancelEditSessionCell"
           style="height:30px;border:1.5px solid var(--green-deep);border-radius:6px;padding:0 6px;font-size:12px;width:95px;font-family:inherit"/>`
      : _canEditSlot
        ? `<div class="time-cell" data-onclick="startEditSessionCell" data-onclick-a0="${s.id}" data-onclick-a1="time"
             style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px" title="Click to edit">${timeStr}</div>
           ${s.actual_start ? `<div class="time-end">Started ${s.actual_start.slice(11,16)}</div>` : ''}`
        : `<div class="time-cell">${timeStr}</div>
           ${s.actual_start ? `<div class="time-end">Started ${s.actual_start.slice(11,16)}</div>` : ''}`;

    const durationCell = _canEditSlot && _editSessionCell?.id === s.id && _editSessionCell.field === 'duration'
      ? `<input type="number" min="0" value="${s.planned_duration_minutes || ''}" placeholder="min"
           data-onchange="saveSessionCell" data-onchange-a0="${s.id}" data-onchange-a1="duration" data-onchange-a2="@value"
           data-onblur="cancelEditSessionCell"
           style="height:30px;border:1.5px solid var(--green-deep);border-radius:6px;padding:0 6px;font-size:12px;width:65px;font-family:inherit"/>`
      : _canEditSlot
        ? `<span data-onclick="startEditSessionCell" data-onclick-a0="${s.id}" data-onclick-a1="duration"
             style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px" title="Click to edit">${durationLabel}</span>`
        : `<span>${durationLabel}</span>`;

    return `<tr${isMine ? ' style="background:var(--gold-light)"' : ''}>
      <td>
        ${timeCell}
      </td>
      <td>
        <div class="pt-name">${_esc(pt.name||'—')}</div>
        ${ptMeta ? `<div class="pt-gender-badge">${_esc(ptMeta)}</div>` : ''}
      </td>
      <td>
        <div class="therapy-name">${_esc(s.therapy_name||'—')}</div>
        <span class="phase-badge phase-${s.therapy_phase}">${_phaseLabel(s.therapy_phase)}</span>
        ${roomLabel}
        ${samLabel}
      </td>
      <td>${durationCell}</td>
      <td>${_esc(doctor.full_name || '—')}</td>
      <td>
        <div>${_esc(therapist.full_name||'—')}</div>
        ${therapist.gender ? `<div class="pt-meta">${therapist.gender === 'M' ? 'Male' : 'Female'}</div>` : ''}
        ${(s.pk_therapy_session_therapists || []).map(r => r.profiles).filter(Boolean).map(t => `<div class="pt-meta">+ ${_esc(t.full_name)}</div>`).join('')}
      </td>
      <td>${_esc(dept.name||'—')}</td>
      <td>${instructionsFull ? `<span title="${_esc(instructionsFull)}">${_esc(instructionsShort)}</span>` : '—'}</td>
      <td>${fitnessBadge}</td>
      <td>
        <span class="status-badge status-${s.status}">
          ${_statusLabel(s.status)}
        </span>
        ${s.status === 'skipped' && s.skip_reason ? `<div class="pt-meta" title="${_esc(s.skip_reason)}">${_esc(s.skip_reason)}</div>` : ''}
      </td>
      <td>
        <div class="row-actions">
          <!-- Session 229 -- was only shown while room/therapist were still missing, which
               meant there was no way back into this drawer at all once a session was fully
               assigned -- exactly where "+ Add another therapist" lives, so a real,
               already-staffed session could never gain a 2nd/3rd/4th therapist through the UI.
               Always shown now (bar a skipped session); label reflects which case it is.
               Session 239 -- Room/Therapist/Time/Duration are logistics decisions that belong
               to the Pk Incharge (or dept admin/super_admin), not any therapist working the
               floor -- a regular therapist could otherwise reassign a colleague's room or
               bump another therapist off a session. Restricted to _isPkRosterAdmin() here,
               same check the Duty Roster/Rooms admin panels already gate on. -->
          ${s.status !== 'skipped' && _isPkRosterAdmin() ? `<button class="icon-btn" data-onclick="openAssignDrawer" data-onclick-a0="${s.id}" title="${(!s.room_id || !therapist.id) ? 'Assign Room & Therapist' : 'Edit Room / Therapists'}" style="color:#1a4080">🏠</button>` : ''}
          ${canStart ? `<button class="icon-btn start" data-onclick="quickStart" data-onclick-a0="${s.id}" title="Mark In Progress">&#9654;</button>` : ''}
          ${canComplete ? `<button class="icon-btn complete" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@false" title="Complete">&#10003;</button>` : ''}
          ${canSkip ? `<button class="icon-btn skip" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@true" title="Skip">&#10007;</button>` : ''}
          <!-- Session 232 -- was always view-only regardless of status, with no way to ever
               actually add a note to a still-active session through this button; notesOnly
               (3rd arg) now only means "read-only" for an already-finalized session, and
               "editable notes-only" for one still in progress. Highlighted + tooltip preview
               when a note already exists, matching the Instructions column's own pattern. -->
          <button class="icon-btn" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@false" data-onclick-a2="@true" title="${s.therapist_notes ? _esc('View/Edit Notes: ' + s.therapist_notes.slice(0,80)) : 'Add Notes'}" style="${s.therapist_notes ? 'color:var(--green-mid)' : ''}">&#128203;</button>
          <button class="icon-btn" data-onclick="openRxDrawer" data-onclick-a0="${s.id}" title="Prescribe Therapy Materials" style="color:#1a4a2e">💊</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// Session 225 -- inline Time/Duration editing (see renderTable()'s timeCell/durationCell).
window.startEditSessionCell = function(sessionId, field) {
  if (!_isPkRosterAdmin()) return; // Session 239 -- Time/Duration are Pk Incharge-only, see renderTable()
  _editSessionCell = { id: sessionId, field };
  applyFilters();
};
window.cancelEditSessionCell = function() {
  _editSessionCell = null;
  applyFilters();
};
window.saveSessionCell = async function(sessionId, field, value) {
  if (!_isPkRosterAdmin()) return; // Session 239 -- same guard as startEditSessionCell()
  const patch = field === 'time'
    ? { scheduled_time: value || null }
    : { planned_duration_minutes: value ? Number(value) : null };
  _editSessionCell = null;
  const { error } = await supabase.from('pk_therapy_sessions').update(patch).eq('id', sessionId);
  if (error) {
    // Session 235 -- the room-overlap guard is now a real exclusion constraint (23P01), not
    // just an exact-time unique violation (23505) -- both mean the same thing to the user.
    _alert('error', safeErrorMessage(error, (error.code === '23505' || error.code === '23P01')
      ? 'That time overlaps another session already booked in the same room — pick another time.'
      : 'Save failed.'));
    await loadAll();
    return;
  }
  await loadAll();
};

// ── Schedule drawer ───────────────────────────────────────────────────────────
window.openSchedDrawer = function(prefillAdmId) {
  document.getElementById('sched-source').value    = 'ipd';
  document.getElementById('sched-phase').value     = 'purvakarma';
  document.getElementById('sched-therapy').value   = '';
  document.getElementById('sched-therapist').value = '';
  document.getElementById('sched-clearance').checked = false;
  document.getElementById('sched-room').value      = '';
  document.getElementById('sched-date').value      = _viewDate;
  document.getElementById('sched-time').value      = '';
  document.getElementById('sched-dept').value      = '';
  document.getElementById('sched-admission').value = '';
  document.getElementById('sched-duration').value  = '';
  document.getElementById('sched-doctor').value    = '';
  document.getElementById('sched-instructions').value = '';
  _schedExtraTherapistIds = [];
  document.getElementById('sched-extra-therapists').innerHTML = '';
  onSourceChange();
  if (prefillAdmId) {
    const opts = document.getElementById('sched-admission').options;
    for (const o of opts) {
      try { if (JSON.parse(o.value).admId === prefillAdmId) { o.selected = true; break; } }
      catch {}
    }
  }
  // Session 214 -- setting .selected above doesn't fire a change event, so re-run explicitly;
  // onSourceChange() (called above) already ran it once with no patient selected yet.
  _autoAssignSchedTherapist();
  document.getElementById('sched-overlay').classList.add('open');
};
window.closeSchedDrawer = function() {
  document.getElementById('sched-overlay').classList.remove('open');
};

window.onSourceChange = function() {
  const src = document.getElementById('sched-source').value;
  document.getElementById('ipd-patient-field').style.display = src === 'ipd' ? '' : 'none';
  document.getElementById('opd-patient-field').style.display = src === 'opd' ? '' : 'none';
  _autoAssignSchedTherapist();
};

// Session 214 -- shared patient-context resolver for the Schedule Session drawer. Used by both
// saveSession() (previously re-derived this 3 separate times inline: the NABH gender check, the
// PK-consent check, and the final insert prep) and the new auto-assign engine below.
async function _resolveSchedPatientContext() {
  const source = document.getElementById('sched-source').value;
  if (source === 'ipd') {
    const raw = document.getElementById('sched-admission').value;
    if (!raw) return { patientId: null, admId: null, gender: null };
    try {
      const obj = JSON.parse(raw);
      const adm = _admissions.find(a => a.id === obj.admId);
      return { patientId: obj.patientId || null, admId: obj.admId || null, gender: adm?.patients?.gender || null };
    } catch {
      return { patientId: null, admId: null, gender: null };
    }
  }
  const patientId = document.getElementById('sched-opd-patient').value;
  if (!patientId) return { patientId: null, admId: null, gender: null };
  const { data: pt } = await supabase.from('patients').select('gender').eq('id', patientId).single();
  return { patientId, admId: null, gender: pt?.gender || null };
}

// Session 214 -- automates the Schedule Session Therapist field. Priority order, checked with
// Dr. Venkatesh before building: (1) continuity of care -- if this patient's stay (IPD:
// ipd_admission_id, OPD: patient_id since there's no admission concept) already has a prior PK
// session, reuse that SAME therapist for every subsequent session, PROVIDED they're actually on
// duty this date (can't force someone not at work); (2) otherwise, on-duty + gender-matched +
// least-loaded that day (mirrors the Duty Roster's own fairness logic); (3) a genuine gap --
// nobody eligible via (1) or (2) -- reveals a real <select> so a human decides, scoped to
// whoever IS on duty if anyone is, else the full Panchakarma pool as a last resort. No manual
// picker in the non-gap case, per explicit design call -- this isn't a suggestion with an
// override link, it's the actual assignment unless the roster genuinely can't produce one.
let _schedAutoAssignToken = 0; // monotonic guard against a slower stale request resolving after a newer one (same pattern as PK Care Plan's Session 208 request-token guard)

async function _autoAssignSchedTherapist() {
  const token = ++_schedAutoAssignToken;
  const sel  = document.getElementById('sched-therapist');
  const auto = document.getElementById('sched-therapist-auto');
  const note = document.getElementById('therapist-note');
  const date = document.getElementById('sched-date').value;

  const showAuto = (text, color) => {
    sel.style.display = 'none'; auto.style.display = 'flex';
    auto.textContent = text;
    note.textContent = ''; note.style.color = color || 'var(--text-mid)';
  };
  const showPicker = (pool, selectedId, noteText) => {
    sel.style.display = ''; auto.style.display = 'none';
    sel.innerHTML = '<option value="">— Select therapist —</option>' +
      pool.map(t => `<option value="${t.id}"${t.id === selectedId ? ' selected' : ''}>${_esc(t.full_name)}${t.gender ? ' (' + t.gender + ')' : ''}</option>`).join('');
    note.textContent = noteText; note.style.color = 'var(--gold)';
  };

  if (!date) { sel.value = ''; showAuto('— Select date first —'); return; }

  const ctx = await _resolveSchedPatientContext();
  if (token !== _schedAutoAssignToken) return; // a newer call has since started -- discard this one
  if (!ctx.patientId) {
    sel.value = ''; showAuto('— Select patient first —');
    _schedExtraTherapistIds = [];
    _renderExtraTherapistRows('sched-extra-therapists', _schedExtraTherapistIds, 'onSchedExtraTherapistChange', 'removeSchedExtraTherapist', '', null);
    return;
  }
  // Session 226 -- re-filters the room dropdown to this patient's gender-designated rooms
  // every time the patient selection changes (was populated once, patient-agnostic, at drawer
  // open -- letting a cross-gender room stay selectable the whole time).
  _populateRoomSelect(ctx.gender);
  // Session 229 -- same re-filter for the multi-therapist extras panel; drops any selection
  // that's no longer gender-eligible if the patient changed.
  _schedExtraTherapistIds = _schedExtraTherapistIds.filter(id => {
    const t = _pkTherapists.find(x => x.id === id);
    return t && (!ctx.gender || !t.gender || t.gender === ctx.gender);
  });
  _renderExtraTherapistRows('sched-extra-therapists', _schedExtraTherapistIds, 'onSchedExtraTherapistChange', 'removeSchedExtraTherapist', document.getElementById('sched-therapist').value, ctx.gender);

  const { data: dutyRows } = await supabase
    .from('pk_therapist_duty')
    .select('profile_id, profiles!profile_id(id,full_name,gender)')
    .eq('tenant_id', tenantId)
    .eq('duty_date', date);
  if (token !== _schedAutoAssignToken) return;

  const onDutyMap = new Map();
  (dutyRows || []).forEach(r => { if (r.profiles) onDutyMap.set(r.profiles.id, r.profiles); });
  const onDuty = [...onDutyMap.values()];

  let priorQuery = supabase.from('pk_therapy_sessions')
    .select('therapist_id')
    .eq('tenant_id', tenantId)
    .neq('status', 'skipped')
    .order('scheduled_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  priorQuery = ctx.admId ? priorQuery.eq('ipd_admission_id', ctx.admId) : priorQuery.eq('patient_id', ctx.patientId);
  const { data: priorRows } = await priorQuery;
  if (token !== _schedAutoAssignToken) return;
  const continuityId = priorRows?.[0]?.therapist_id || null;
  // Session 226 -- continuity-of-care never overrides the gender hard-block; a prior therapist
  // of the wrong gender for this patient (only possible from data predating this fix) falls
  // through to the normal gender-matched pool below instead of being silently reused.
  const continuityOnDuty = continuityId
    ? onDuty.find(t => t.id === continuityId && (!ctx.gender || !t.gender || t.gender === ctx.gender))
    : null;

  if (continuityOnDuty) {
    sel.innerHTML = `<option value="${continuityOnDuty.id}" selected>${_esc(continuityOnDuty.full_name)}</option>`;
    sel.value = continuityOnDuty.id;
    showAuto(`✓ ${continuityOnDuty.full_name} (continuing this patient's care)`, 'var(--green-mid)');
    return;
  }

  const genderMatched = ctx.gender ? onDuty.filter(t => t.gender === ctx.gender) : onDuty;
  if (genderMatched.length) {
    const { data: loadRows } = await supabase
      .from('pk_therapy_sessions')
      .select('therapist_id')
      .eq('tenant_id', tenantId)
      .eq('scheduled_date', date)
      .neq('status', 'skipped')
      .in('therapist_id', genderMatched.map(t => t.id));
    if (token !== _schedAutoAssignToken) return;
    const loadCount = {};
    genderMatched.forEach(t => { loadCount[t.id] = 0; });
    (loadRows || []).forEach(r => { loadCount[r.therapist_id] = (loadCount[r.therapist_id] || 0) + 1; });
    const picked = [...genderMatched].sort((a, b) => (loadCount[a.id] - loadCount[b.id]) || a.full_name.localeCompare(b.full_name))[0];
    sel.innerHTML = `<option value="${picked.id}" selected>${_esc(picked.full_name)}</option>`;
    sel.value = picked.id;
    const continuityNote = continuityId ? ' — the previous therapist for this patient isn\'t on duty today' : '';
    showAuto(`✓ ${picked.full_name} (on duty today, least-loaded${continuityNote})`, 'var(--green-mid)');
    return;
  }

  // Genuine gap: no continuity match, and no gender-matched on-duty therapist. Session 226 --
  // cross-gender is hard-blocked with no override, so the fallback pools here are gender-
  // filtered too (was previously offering wrong-gender on-duty therapists, relying on
  // saveSession()'s now-removed confirm() to catch it at save time).
  const onDutyEligible = ctx.gender ? onDuty.filter(t => !t.gender || t.gender === ctx.gender) : onDuty;
  const poolEligible = ctx.gender ? _pkTherapists.filter(t => !t.gender || t.gender === ctx.gender) : _pkTherapists;
  const genderWord = ctx.gender === 'F' ? 'female' : ctx.gender === 'M' ? 'male' : 'matching';

  if (onDutyEligible.length) {
    showPicker(onDutyEligible, null, `⚠️ No same-gender therapist among today's least-loaded pick — choose manually from who's on duty.`);
  } else if (poolEligible.length) {
    showPicker(poolEligible, null, `⚠️ No ${genderWord} therapist on duty this date — showing all ${genderWord} Panchakarma therapists (none rostered today).`);
  } else {
    sel.value = ''; // saveSession()'s own "Select a therapist" check catches this if submitted anyway
    showAuto(`🚫 No ${genderWord} Panchakarma therapist exists at all — this session cannot be scheduled until one is added.`, 'var(--red)');
  }
}
window.onSchedAssignInputsChange = function() { _autoAssignSchedTherapist(); };

// Session 229 -- multi-therapist add/remove/change for the "+ Schedule Session" form.
window.addSchedExtraTherapist = async function() {
  if (_schedExtraTherapistIds.length >= 3) { _alert('error', 'Up to 3 additional therapists (4 total) — that should cover any real procedure.'); return; }
  const ctx = await _resolveSchedPatientContext();
  _schedExtraTherapistIds.push('');
  _renderExtraTherapistRows('sched-extra-therapists', _schedExtraTherapistIds, 'onSchedExtraTherapistChange', 'removeSchedExtraTherapist', document.getElementById('sched-therapist').value, ctx.gender);
};
window.removeSchedExtraTherapist = async function(idx) {
  _schedExtraTherapistIds.splice(Number(idx), 1);
  const ctx = await _resolveSchedPatientContext();
  _renderExtraTherapistRows('sched-extra-therapists', _schedExtraTherapistIds, 'onSchedExtraTherapistChange', 'removeSchedExtraTherapist', document.getElementById('sched-therapist').value, ctx.gender);
};
window.onSchedExtraTherapistChange = async function(idx, value) {
  _schedExtraTherapistIds[Number(idx)] = value;
  const ctx = await _resolveSchedPatientContext();
  _renderExtraTherapistRows('sched-extra-therapists', _schedExtraTherapistIds, 'onSchedExtraTherapistChange', 'removeSchedExtraTherapist', document.getElementById('sched-therapist').value, ctx.gender);
};

window.saveSession = async function() {
  const source    = document.getElementById('sched-source').value;
  const phase     = document.getElementById('sched-phase').value;
  const therapy   = document.getElementById('sched-therapy').value.trim();
  const therapist = document.getElementById('sched-therapist').value;
  const deptId    = document.getElementById('sched-dept').value;
  const date      = document.getElementById('sched-date').value;
  const time      = document.getElementById('sched-time').value;
  const clearance = document.getElementById('sched-clearance').checked;

  if (!therapy)   { _alert('error','Enter therapy name.'); return; }
  if (!therapist) { _alert('error','Select a therapist.'); return; }
  if (!deptId)    { _alert('error','Select a department.'); return; }
  if (!date)      { _alert('error','Enter a date.'); return; }

  const ctx = await _resolveSchedPatientContext();
  if (!ctx.patientId) { _alert('error', source === 'ipd' ? 'Select an IPD patient.' : 'Select a patient.'); return; }

  // NABH PRE.2 ATWC CORE — cross-gender therapist assignment is hard-blocked, not just
  // warned (Session 226 -- was previously a dismissible confirm(), and one-directional
  // besides, only ever catching female-patient+male-therapist. A real male-patient+
  // female-therapist mismatch slipped through live testing because of both gaps at once.
  // No override -- Dr. Venkatesh's explicit call).
  const therapistData = _pkTherapists.find(t => t.id === therapist);
  if (ctx.gender && therapistData?.gender && ctx.gender !== therapistData.gender) {
    _alert('error', 'NABH PRE.2 — cross-gender therapist assignment is not permitted. Assign a therapist of the same gender as the patient.');
    return;
  }
  // Session 229 -- same hard block for every additional therapist, not just the primary.
  const extraTherapistIds = [...new Set(_schedExtraTherapistIds.filter(Boolean))];
  for (const id of extraTherapistIds) {
    const t = _pkTherapists.find(x => x.id === id);
    if (ctx.gender && t?.gender && ctx.gender !== t.gender) {
      _alert('error', `NABH PRE.2 — ${t.full_name} is a different gender than the patient. Cross-gender therapist assignment is not permitted.`);
      return;
    }
  }

  // Session 226 -- NCISM Sch III/XXV gender-separated treatment rooms: same hard block for
  // a room whose gender_restriction doesn't match the patient.
  const roomIdCheck = document.getElementById('sched-room').value || null;
  const roomDataCheck = roomIdCheck ? _rooms.find(r => r.id === roomIdCheck) : null;
  if (roomDataCheck && !_roomMatchesGender(roomDataCheck, ctx.gender)) {
    _alert('error', `${roomDataCheck.room_name} is a ${roomDataCheck.gender_restriction}-only treatment room — pick a room designated for this patient's gender.`);
    return;
  }

  // NABH PRE.3 ATWC CORE — PK Consent 6-month validity check
  {
    const { data: consentData } = await supabase.from('consent_records')
      .select('id,consent_datetime,valid_until')
      .eq('patient_id', ctx.patientId).eq('tenant_id', tenantId)
      .eq('consent_type','panchakarma')
      .order('consent_datetime',{ascending:false}).limit(1).maybeSingle();
    if (!consentData) {
      const ok = confirm('⚠ NABH PRE.3 ATWC CORE — No PK Consent on Record\n\nNo Panchakarma consent found for this patient. Consent is mandatory before first session.\n\nProceed anyway? (You must record consent separately.)');
      if (!ok) return;
    } else {
      const expiry = consentData.valid_until ? new Date(consentData.valid_until) : new Date(new Date(consentData.consent_datetime).getTime() + 180*86400000);
      if (expiry < new Date()) {
        const renew = confirm(`⚠ NABH — PK Consent Expired\n\nConsent given on ${new Date(consentData.consent_datetime).toLocaleDateString('en-IN')} has expired.\n\nFresh consent is required. Proceed anyway?`);
        if (!renew) return;
      }
    }
  }

  // NCISM §47(a)(xv) — Raktamokshana must be in Anushastra Karma unit, not regular therapy room
  const therapyLower = therapy.toLowerCase();
  if (therapyLower.includes('raktamokshana') || therapyLower.includes('leech')) {
    const proceed = confirm(
      '⚠ NCISM §47(a)(xv) — Aseptic Conditions Required\n\n' +
      'Raktamokshana (leech therapy) must be conducted in the Anushastra Karma unit under aseptic conditions.\n\n' +
      'Confirm this session is scheduled in the designated Anushastra Karma / aseptic procedure room?'
    );
    if (!proceed) return;
  }

  const patientId = ctx.patientId;
  const admId     = ctx.admId;
  const roomId = document.getElementById('sched-room').value || null;
  const durationVal = document.getElementById('sched-duration').value;
  const doctorVal   = document.getElementById('sched-doctor').value;
  const instrVal    = document.getElementById('sched-instructions').value.trim();

  // Session 206/235 -- best-effort client-side heads-up before hitting the real DB-enforced
  // conflict guard (pk_sessions_room_overlap_excl, a true time-range exclusion constraint as
  // of Session 235 -- was previously an exact-start-time-only unique index that missed a
  // genuine overlap at a different start time entirely). This pre-check now mirrors that same
  // real overlap logic, not just an exact-time match.
  if (roomId && time) {
    const clash = await _checkRoomOverlap(roomId, date, time, durationVal ? Number(durationVal) : null, null);
    if (clash) {
      const room = _rooms.find(r => r.id === roomId);
      const ok = confirm(`⚠ ${room?.room_name || 'This room'} already has an overlapping session booked for ${clash.patients?.name || 'another patient'}.\n\nPick a different room or time — continuing may fail.`);
      if (!ok) return;
    }
  }

  const btn = document.getElementById('btn-sched-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { data: inserted, error } = await supabase.from('pk_therapy_sessions').insert({
    tenant_id:           tenantId,
    patient_id:          patientId,
    ipd_admission_id:    admId || null,
    therapist_id:        therapist,
    department_id:       deptId,
    therapy_phase:       phase,
    therapy_name:        therapy,
    scheduled_date:      date,
    scheduled_time:      time || null,
    doctor_clearance:    clearance,
    room_id:             roomId,
    status:              'scheduled',
    planned_duration_minutes: durationVal ? Number(durationVal) : null,
    ordering_doctor_id:  doctorVal || null,
    special_instructions: instrVal || null,
  }).select('id').single();

  if (!error && inserted && extraTherapistIds.length) {
    // Session 229 -- best-effort: the main session is already saved at this point (its own
    // insert above is the real safety-checked write), this is just recording who else is
    // helping. A failure here surfaces as a warning, not a rollback of the whole schedule.
    const { error: extraErr } = await supabase.from('pk_therapy_session_therapists')
      .insert(extraTherapistIds.map(id => ({ session_id: inserted.id, therapist_id: id })));
    if (extraErr) _alert('error', safeErrorMessage(extraErr, 'Session scheduled, but the additional therapists could not be saved.'));
  }

  btn.disabled = false; btn.textContent = 'Schedule';
  if (error) {
    // Session 235 -- 23P01 is the real overlap-safe exclusion constraint now, 23505 was the
    // old exact-start-time-only unique index it replaced -- same user-facing meaning either way.
    _alert('error', safeErrorMessage(error, (error.code === '23505' || error.code === '23P01')
      ? 'That room already has an overlapping session booked — pick another room or time.'
      : 'Save failed.'));
    return;
  }
  closeSchedDrawer();
  _alert('success','Session scheduled.');
  await loadAll();
};

// ── Assign Room & Therapist (Session 210) ──────────────────────────────────────
// For a session generated from a Panchakarma Care Plan -- date/phase/therapy are
// already set by the plan (deliberately not auto-booked, see sql/session210_*).
// Reuses the exact same safety checks saveSession() already has (NABH gender-match,
// PK consent validity, Raktamokshana aseptic-unit confirm, room-clash pre-check),
// just for an UPDATE against an existing session instead of a fresh INSERT.
let _assignSessionId = null;
// Session 225 -- inline Time/Duration editing directly on the Session Schedule table (was
// only editable via the "+ Schedule Session" create form or the "Assign Room & Therapist"
// drawer, requested as a quicker path for adjusting either after the fact). Same
// click-to-edit convention as _pkEditingDutyId's Shift 1/2 grid above.
let _editSessionCell = null; // { id, field: 'time' | 'duration' }

// Session 229 -- multi-therapist sessions. Both forms track their own selected-extras array
// (ids, possibly with blank '' slots mid-pick) independently.
let _schedExtraTherapistIds = [];
let _assignExtraTherapistIds = [];

function _extraTherapistOptions(patientGender, excludeIds) {
  return _pkTherapists.filter(t => (!patientGender || !t.gender || t.gender === patientGender) && !excludeIds.includes(t.id));
}

function _renderExtraTherapistRows(containerId, ids, onChangeFn, onRemoveFn, primaryId, patientGender) {
  const container = document.getElementById(containerId);
  container.innerHTML = ids.map((id, idx) => {
    const exclude = [primaryId, ...ids.filter((_, i) => i !== idx)].filter(Boolean);
    const opts = _extraTherapistOptions(patientGender, exclude)
      .map(t => `<option value="${t.id}"${t.id === id ? ' selected' : ''}>${_esc(t.full_name)}</option>`).join('');
    return `<div style="display:flex;gap:6px;margin-bottom:6px">
      <select data-onchange="${onChangeFn}" data-onchange-a0="${idx}" data-onchange-a1="@value" style="flex:1;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12px;font-family:inherit">
        <option value="">— Select therapist —</option>${opts}
      </select>
      <button data-onclick="${onRemoveFn}" data-onclick-a0="${idx}" style="border:none;background:none;color:var(--red);cursor:pointer;font-size:15px;padding:0 4px">✕</button>
    </div>`;
  }).join('');
}

// Session 228 -- real gap found live: this dropdown never checked whether a therapist was
// actually on duty on the session's own date at all (a room/gender match alone isn't enough
// to actually staff it) -- someone rostered for a different shift/day could be manually
// assigned here with zero warning. Fetched fresh per the date currently in the drawer
// (deliberately NOT the Duty Roster panel's independently-browsable _pkRosterDate, which can
// be a different day entirely). Warns rather than hard-blocks, same as the Prep Room manual
// dropdown's weekly-off/leave labels -- this stays a real override tool for a genuine
// call-someone-in case, unlike the Session 226 gender rule.
async function _refreshAssignTherapistDuty(date, patientGender, currentTherapistId) {
  const { data: dutyRows } = await supabase
    .from('pk_therapist_duty')
    .select('profile_id')
    .eq('tenant_id', tenantId)
    .eq('duty_date', date);
  const onDutyIds = new Set((dutyRows || []).map(r => r.profile_id));
  _populateAssignTherapistSelect(patientGender, onDutyIds, date);
  document.getElementById('assign-therapist').value = currentTherapistId || '';
}

window.openAssignDrawer = async function(sessionId) {
  // Session 239 -- the UI never renders this button for a non-admin, but guard the entry
  // point itself too (matches the existing convention at _renderPkRosterPanel()'s save path).
  if (!_isPkRosterAdmin()) return;
  const s = _sessions.find(x => x.id === sessionId);
  if (!s) return;
  _assignSessionId = sessionId;
  const pt = s.patients || {};

  // Session 237 -- Therapy Name/Phase/Department/Doctor/Special Instructions are read-only
  // clinical info here (corrected same session -- these were briefly editable, see the
  // drawer's own comment). Time/Room/Therapist(s)/Duration below remain the real editable
  // logistics fields.
  document.getElementById('assign-session-summary').innerHTML = `
    <div class="detail-row"><span>Patient</span><strong>${_esc(pt.name || '—')}</strong></div>
    <div class="detail-row"><span>Therapy</span><strong>${_esc(s.therapy_name || '—')}</strong></div>
    <div class="detail-row"><span>Phase</span><strong>${_phaseLabel(s.therapy_phase)}</strong></div>
    <div class="detail-row"><span>Department</span><strong>${_esc(s.departments?.name || '—')}</strong></div>
    <div class="detail-row"><span>Doctor</span><strong>${_esc(s.ordering_doctor?.full_name || '—')}</strong></div>
    <div class="detail-row"><span>Date</span><strong>${s.scheduled_date}</strong></div>
    ${s.special_instructions ? `<div class="detail-row"><span>Instructions</span><strong>${_esc(s.special_instructions)}</strong></div>` : ''}
  `;

  _populateAssignRoomSelect(pt.gender);
  await _refreshAssignTherapistDuty(s.scheduled_date, pt.gender, s.profiles?.id);
  document.getElementById('assign-room').value       = s.room_id || '';
  document.getElementById('assign-time').value       = s.scheduled_time ? s.scheduled_time.slice(0,5) : '';
  document.getElementById('assign-duration').value   = s.planned_duration_minutes || '';
  // Session 229 -- multi-therapist: pre-fill from whatever's already saved for this session.
  _assignExtraTherapistIds = (s.pk_therapy_session_therapists || []).map(r => r.profiles?.id).filter(Boolean);
  _renderExtraTherapistRows('assign-extra-therapists', _assignExtraTherapistIds, 'onAssignExtraTherapistChange', 'removeAssignExtraTherapist', s.profiles?.id || '', pt.gender);
  document.getElementById('assign-overlay').classList.add('open');
};
window.closeAssignDrawer = function() {
  document.getElementById('assign-overlay').classList.remove('open');
};

// Session 229 -- multi-therapist add/remove/change for the Assign Room & Therapist drawer.
function _currentAssignSessionGender() {
  return _sessions.find(x => x.id === _assignSessionId)?.patients?.gender || null;
}
window.addAssignExtraTherapist = function() {
  if (_assignExtraTherapistIds.length >= 3) { _alert('error', 'Up to 3 additional therapists (4 total) — that should cover any real procedure.'); return; }
  _assignExtraTherapistIds.push('');
  _renderExtraTherapistRows('assign-extra-therapists', _assignExtraTherapistIds, 'onAssignExtraTherapistChange', 'removeAssignExtraTherapist', document.getElementById('assign-therapist').value, _currentAssignSessionGender());
};
window.removeAssignExtraTherapist = function(idx) {
  _assignExtraTherapistIds.splice(Number(idx), 1);
  _renderExtraTherapistRows('assign-extra-therapists', _assignExtraTherapistIds, 'onAssignExtraTherapistChange', 'removeAssignExtraTherapist', document.getElementById('assign-therapist').value, _currentAssignSessionGender());
};
window.onAssignExtraTherapistChange = function(idx, value) {
  _assignExtraTherapistIds[Number(idx)] = value;
  _renderExtraTherapistRows('assign-extra-therapists', _assignExtraTherapistIds, 'onAssignExtraTherapistChange', 'removeAssignExtraTherapist', document.getElementById('assign-therapist').value, _currentAssignSessionGender());
};

function _populateAssignRoomSelect(patientGender) {
  const sr = document.getElementById('assign-room');
  sr.innerHTML = '<option value="">— Not assigned —</option>';
  _rooms.filter(r => r.status === 'active' && _roomMatchesGender(r, patientGender)).forEach(r => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = `${r.room_name}${r.room_type ? ' — ' + r.room_type : ''}`;
    sr.appendChild(o);
  });
}

function _populateAssignTherapistSelect(patientGender, onDutyIds, scheduledDate) {
  const st = document.getElementById('assign-therapist');
  st.innerHTML = '<option value="">— Select therapist —</option>';
  // Session 213 (cont.) -- _pkTherapists (department='Panchakarma'), same reasoning as
  // _populateTherapistSelect() above: assigning a room+therapist to a real PK session should
  // only ever offer real Panchakarma-department therapists.
  // Session 226 -- cross-gender therapists are now hard-excluded from this dropdown entirely
  // (not just warned at save time) when the patient's gender is known; unknown-gender
  // therapists are still offered since a mismatch genuinely can't be determined for them.
  const pool = _pkTherapists.filter(t => !patientGender || !t.gender || t.gender === patientGender);
  const males   = pool.filter(t => t.gender === 'M');
  const females = pool.filter(t => t.gender === 'F');
  const unknown = pool.filter(t => !t.gender);
  [{ group: 'Male Therapists', list: males }, { group: 'Female Therapists', list: females }, { group: 'Therapists', list: unknown }]
    .forEach(({ group, list }) => {
      if (!list.length) return;
      const og = document.createElement('optgroup'); og.label = group;
      list.forEach(t => {
        const o = document.createElement('option');
        o.value = t.id;
        // Session 228 -- warns (doesn't block) when this therapist isn't rostered on duty for
        // this exact session's date, matching the Prep Room dropdown's own weekly-off/leave
        // warning pattern -- manual assignment stays a real override tool.
        o.textContent = onDutyIds && !onDutyIds.has(t.id)
          ? `${t.full_name} — ⚠️ not on duty ${scheduledDate}`
          : t.full_name;
        og.appendChild(o);
      });
      st.appendChild(og);
    });
}

window.saveAssignment = async function() {
  if (!_isPkRosterAdmin()) return; // Session 239 -- same guard as openAssignDrawer()
  const s = _sessions.find(x => x.id === _assignSessionId);
  if (!s) return;
  const therapistId = document.getElementById('assign-therapist').value;
  const roomId       = document.getElementById('assign-room').value || null;
  const time         = document.getElementById('assign-time').value || null;
  // Session 237 -- Therapy Name/Phase/Department/Doctor/Special Instructions are deliberately
  // NOT editable here (briefly were, Sessions 233-234, corrected same session): these are
  // clinical decisions, not the Pk Incharge/therapist's call to change -- same principle as
  // Date below. Read straight from the session record, unchanged.
  const therapyName  = s.therapy_name;
  // Session 230 -- Date is deliberately NOT editable here (briefly was, corrected same
  // session): a session's day is clinically deliberate, not the Pk Incharge's call to move on
  // their own. See Skip's reschedule-on-skip path for the one real case a therapist genuinely
  // needs to move a date -- when treatment didn't happen at all.
  const date         = s.scheduled_date;
  if (!therapistId) { _alert('error', 'Select a therapist.'); return; }

  // Session 226 -- same hard block saveSession() has: cross-gender therapist assignment is
  // never permitted, no override, checked in both directions.
  const patientGender = s.patients?.gender;
  const therapistData = _pkTherapists.find(t => t.id === therapistId);
  if (patientGender && therapistData?.gender && patientGender !== therapistData.gender) {
    _alert('error', 'NABH PRE.2 — cross-gender therapist assignment is not permitted. Assign a therapist of the same gender as the patient.');
    return;
  }
  // Session 229 -- same hard block for every additional therapist, not just the primary.
  const extraTherapistIds = [...new Set(_assignExtraTherapistIds.filter(Boolean))];
  for (const id of extraTherapistIds) {
    const t = _pkTherapists.find(x => x.id === id);
    if (patientGender && t?.gender && patientGender !== t.gender) {
      _alert('error', `NABH PRE.2 — ${t.full_name} is a different gender than the patient. Cross-gender therapist assignment is not permitted.`);
      return;
    }
  }

  // Same NCISM Sch III/XXV gender-separated-room hard block saveSession() has.
  const roomDataCheck = roomId ? _rooms.find(r => r.id === roomId) : null;
  if (roomDataCheck && !_roomMatchesGender(roomDataCheck, patientGender)) {
    _alert('error', `${roomDataCheck.room_name} is a ${roomDataCheck.gender_restriction}-only treatment room — pick a room designated for this patient's gender.`);
    return;
  }

  // Same NABH PRE.3 PK consent 6-month validity check.
  if (s.patients?.id) {
    const { data: consentData } = await supabase.from('consent_records')
      .select('id,consent_datetime,valid_until')
      .eq('patient_id', s.patients.id).eq('tenant_id', tenantId)
      .eq('consent_type', 'panchakarma')
      .order('consent_datetime', { ascending: false }).limit(1).maybeSingle();
    if (!consentData) {
      const ok = confirm('⚠ NABH PRE.3 ATWC CORE — No PK Consent on Record\n\nNo Panchakarma consent found for this patient. Consent is mandatory before first session.\n\nProceed anyway? (You must record consent separately.)');
      if (!ok) return;
    } else {
      const expiry = consentData.valid_until ? new Date(consentData.valid_until) : new Date(new Date(consentData.consent_datetime).getTime() + 180*86400000);
      if (expiry < new Date()) {
        const renew = confirm(`⚠ NABH — PK Consent Expired\n\nConsent given on ${new Date(consentData.consent_datetime).toLocaleDateString('en-IN')} has expired.\n\nFresh consent is required. Proceed anyway?`);
        if (!renew) return;
      }
    }
  }

  // Same NCISM §47(a)(xv) Raktamokshana aseptic-unit confirm -- reads the CURRENT (possibly
  // just-edited) therapy name, not the session's original one.
  const therapyLower = therapyName.toLowerCase();
  if (therapyLower.includes('raktamokshana') || therapyLower.includes('leech')) {
    const proceed = confirm(
      '⚠ NCISM §47(a)(xv) — Aseptic Conditions Required\n\n' +
      'Raktamokshana (leech therapy) must be conducted in the Anushastra Karma unit under aseptic conditions.\n\n' +
      'Confirm this session is scheduled in the designated Anushastra Karma / aseptic procedure room?'
    );
    if (!proceed) return;
  }

  const durationVal = document.getElementById('assign-duration').value;

  // Same real-overlap room-clash pre-check saveSession() has (Session 235).
  if (roomId && time) {
    const clash = await _checkRoomOverlap(roomId, date, time, durationVal ? Number(durationVal) : null, _assignSessionId);
    if (clash) {
      const room = _rooms.find(r => r.id === roomId);
      const ok = confirm(`⚠ ${room?.room_name || 'This room'} already has an overlapping session booked for ${clash.patients?.name || 'another patient'}.\n\nPick a different room or time — continuing may fail.`);
      if (!ok) return;
    }
  }

  const btn = document.getElementById('btn-assign-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  // Session 237 -- only the real logistics fields are ever written here now: Therapy Name/
  // Phase/Department/Doctor/Special Instructions are read-only, never touched by this drawer.
  const { error } = await supabase.from('pk_therapy_sessions').update({
    therapist_id: therapistId, room_id: roomId, scheduled_time: time,
    planned_duration_minutes: durationVal ? Number(durationVal) : null,
  }).eq('id', _assignSessionId);

  // Session 229 -- resyncs the additional-therapist list: delete-then-reinsert is simplest and
  // correct here (at most 3 rows, no risk of losing anything else -- this table only ever
  // holds this exact session's additional therapists).
  if (!error) {
    await supabase.from('pk_therapy_session_therapists').delete().eq('session_id', _assignSessionId);
    if (extraTherapistIds.length) {
      const { error: extraErr } = await supabase.from('pk_therapy_session_therapists')
        .insert(extraTherapistIds.map(id => ({ session_id: _assignSessionId, therapist_id: id })));
      if (extraErr) _alert('error', safeErrorMessage(extraErr, 'Assigned, but the additional therapists could not be saved.'));
    }
  }

  btn.disabled = false; btn.textContent = 'Assign';
  if (error) {
    // Session 235 -- same 23P01/23505 note as saveSession() above.
    _alert('error', safeErrorMessage(error, (error.code === '23505' || error.code === '23P01')
      ? 'That room already has an overlapping session booked — pick another room or time.'
      : 'Save failed.'));
    return;
  }
  closeAssignDrawer();
  _alert('success', 'Room & therapist assigned.');
  await loadAll();
};

// ── Quick start ───────────────────────────────────────────────────────────────
window.quickStart = async function(id) {
  const session = _sessions.find(s => s.id === id);

  // NCISM §47(vii) — fitness clearance is mandatory for Purvakarma
  if (session && session.therapy_phase === 'purvakarma' && !session.doctor_clearance) {
    const proceed = confirm(
      '⚠ NCISM §47(vii) Compliance Alert\n\n' +
      'PK Fitness Clearance has NOT been marked for this patient.\n\n' +
      'NCISM mandates that every patient must undergo consultation to confirm fitness BEFORE starting Panchakarma therapy.\n\n' +
      'Proceed without clearance? (Non-compliant — will be flagged in records)'
    );
    if (!proceed) return;
  }

  const now = new Date();
  const { error } = await supabase.from('pk_therapy_sessions')
    .update({ status: 'in_progress', actual_start: now.toISOString() })
    .eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not update session.')); return; }
  _alert('success', 'Session marked in progress.');
  await loadAll();
};

// ── Complete drawer ───────────────────────────────────────────────────────────
// Session 232 -- 3rd arg renamed viewOnly -> notesOnly: it no longer means "always read-only"
// (that was the real bug -- a still-Scheduled/In-Progress session had literally no way to ever
// record a note without forcing Complete/Skip). Now it means "just the note, not a status
// change" -- editable for an active session, and read-only only once a session is genuinely
// finalized (completed/skipped), where rewriting history isn't the point of this button.
window.openCompleteDrawer = function(id, isSkip, notesOnly) {
  const s  = _sessions.find(x => x.id === id);
  if (!s) return;
  const pt        = s.patients || {};
  const therapist = s.profiles || {};
  const isFinalized = s.status === 'completed' || s.status === 'skipped';

  document.getElementById('comp-session-id').value   = id;
  document.getElementById('comp-start').value         = s.actual_start ? s.actual_start.slice(11,16) : '';
  document.getElementById('comp-end').value           = s.actual_end ? s.actual_end.slice(11,16) : '';
  document.getElementById('comp-notes').value         = s.therapist_notes || '';
  document.getElementById('comp-clearance').checked   = s.doctor_clearance || false;
  document.getElementById('comp-skip-reason').value   = '';
  document.getElementById('comp-reschedule-date').value = '';

  // Samsarjana Krama — only for Paschatkarma, and only in the real Complete/Skip flow.
  const isPaschatkarma = s.therapy_phase === 'paschatkarma';
  const samSec = document.getElementById('samsarjana-section');
  samSec.style.display = (isPaschatkarma && !isSkip && !notesOnly) ? '' : 'none';
  if (isPaschatkarma) {
    document.getElementById('comp-samsarjana-stage').value = s.samsarjana_stage || '';
    document.getElementById('comp-samsarjana-tolerating').checked = false;
  }
  document.getElementById('skip-reason-field').style.display = (isSkip && !notesOnly) ? '' : 'none';

  const titleEl = document.getElementById('complete-title');
  const saveBtn = document.getElementById('btn-complete-save');
  const timesRow = document.getElementById('comp-times-row');
  const clearanceField = document.getElementById('comp-clearance-field');

  if (notesOnly && isFinalized) {
    // Historic record -- read-only, unchanged from before this session's fix.
    titleEl.textContent = 'Session Notes';
    saveBtn.style.display = 'none';
    timesRow.style.display = '';
    clearanceField.style.display = '';
    document.getElementById('comp-start').disabled = true;
    document.getElementById('comp-end').disabled   = true;
    document.getElementById('comp-notes').disabled = true;
  } else if (notesOnly) {
    // Real fix: a still-active session can now actually have a note recorded against it,
    // without being forced through Complete/Skip just to say something.
    titleEl.textContent = 'Session Notes';
    saveBtn.textContent = 'Save Notes';
    saveBtn.style.display = '';
    timesRow.style.display = 'none';
    clearanceField.style.display = 'none';
    document.getElementById('comp-notes').disabled = false;
  } else {
    titleEl.textContent = isSkip ? 'Skip Session' : 'Complete Session';
    saveBtn.textContent  = isSkip ? 'Mark Skipped' : 'Mark Completed';
    saveBtn.style.display = '';
    timesRow.style.display = '';
    clearanceField.style.display = '';
    document.getElementById('comp-start').disabled = false;
    document.getElementById('comp-end').disabled   = false;
    document.getElementById('comp-notes').disabled = false;
  }
  saveBtn.dataset.mode = notesOnly ? 'notes' : (isSkip ? 'skip' : 'complete');

  document.getElementById('comp-detail-card').innerHTML = `
    <div class="detail-row"><span>Patient</span><strong>${_esc(pt.name||'—')}</strong></div>
    <div class="detail-row"><span>Therapy</span><strong>${_esc(s.therapy_name)}</strong></div>
    <div class="detail-row"><span>Phase</span><strong>${_phaseLabel(s.therapy_phase)}</strong></div>
    <div class="detail-row"><span>Therapist</span><strong>${_esc(therapist.full_name||'—')}</strong></div>
    <div class="detail-row"><span>Scheduled</span><strong>${s.scheduled_time ? s.scheduled_time.slice(0,5) : '—'}</strong></div>
  `;

  document.getElementById('complete-overlay').classList.add('open');
};
window.closeCompleteDrawer = function() {
  document.getElementById('complete-overlay').classList.remove('open');
};

window.saveCompletion = async function() {
  const id      = document.getElementById('comp-session-id').value;
  const mode    = document.getElementById('btn-complete-save').dataset.mode; // 'notes' | 'skip' | 'complete'

  // Session 232 -- notes-only save: just the note, no status change at all. The real fix this
  // session -- a still-active session previously had no way to record a note without being
  // forced through Complete/Skip.
  if (mode === 'notes') {
    const notesOnlyVal = document.getElementById('comp-notes').value.trim();
    const btn = document.getElementById('btn-complete-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    const { error } = await supabase.from('pk_therapy_sessions').update({ therapist_notes: notesOnlyVal || null }).eq('id', id);
    btn.disabled = false; btn.textContent = 'Save Notes';
    if (error) { _alert('error', safeErrorMessage(error, 'Could not save note.')); return; }
    closeCompleteDrawer();
    _alert('success', 'Note saved.');
    await loadAll();
    return;
  }

  const isSkip  = mode === 'skip';
  const start   = document.getElementById('comp-start').value;
  const end     = document.getElementById('comp-end').value;
  const notes   = document.getElementById('comp-notes').value.trim();
  const clear   = document.getElementById('comp-clearance').checked;
  const today   = _viewDate;
  // Session 231 -- real bug found live: this field has existed since the drawer was built but
  // was never actually persisted anywhere (pk_therapy_sessions had no column for it) -- every
  // skip reason ever entered was silently discarded.
  const skipReason = document.getElementById('comp-skip-reason').value.trim();

  const session = _sessions.find(s => s.id === id);
  const isPaschatkarma = session?.therapy_phase === 'paschatkarma';

  const patch = {
    status:           isSkip ? 'skipped' : 'completed',
    therapist_notes:  notes || null,
    doctor_clearance: clear,
  };
  if (isSkip) patch.skip_reason = skipReason || null;
  if (!isSkip) {
    if (start) patch.actual_start = `${today}T${start}:00`;
    if (end)   patch.actual_end   = `${today}T${end}:00`;

    // Save Samsarjana Krama stage for Paschatkarma
    if (isPaschatkarma) {
      const stage = document.getElementById('comp-samsarjana-stage').value;
      if (stage) patch.samsarjana_stage = stage;
    }
  }

  const btn = document.getElementById('btn-complete-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await supabase.from('pk_therapy_sessions').update(patch).eq('id', id);
  btn.disabled = false;
  btn.textContent = isSkip ? 'Mark Skipped' : 'Mark Completed';

  if (error) { _alert('error', safeErrorMessage(error, 'Could not update session.')); return; }

  // Session 230 -- rescheduling on Skip is the one real case a therapist genuinely needs to
  // move a session's date (treatment didn't happen at all) -- deliberately NOT a general date-
  // edit anywhere else (see Assign Room & Therapist drawer's own comment). Creates a fresh
  // session on the new date rather than mutating the skipped one, so the skip stays a real,
  // permanent record -- carries over the same patient/therapy/room/therapist(s) as a starting
  // point, doctor_clearance reset to false (a new instance of the procedure needs its own
  // fitness confirmation, same as any newly created session).
  const rescheduleDate = isSkip ? document.getElementById('comp-reschedule-date').value : '';
  if (rescheduleDate && session) {
    const { data: newSession, error: reErr } = await supabase.from('pk_therapy_sessions').insert({
      tenant_id:            tenantId,
      patient_id:           session.patients?.id || null,
      ipd_admission_id:     session.ipd_admission_id || null,
      therapist_id:         session.profiles?.id || null,
      department_id:        session.departments?.id || null,
      therapy_phase:        session.therapy_phase,
      therapy_name:         session.therapy_name,
      scheduled_date:       rescheduleDate,
      room_id:              session.room_id || null,
      status:               'scheduled',
      doctor_clearance:     false,
      planned_duration_minutes: session.planned_duration_minutes || null,
      ordering_doctor_id:   session.ordering_doctor?.id || null,
      special_instructions: session.special_instructions || null,
    }).select('id').single();
    if (reErr) {
      _alert('error', safeErrorMessage(reErr, 'Session skipped, but the reschedule could not be created — reschedule it manually.'));
    } else if (newSession) {
      const extras = (session.pk_therapy_session_therapists || []).map(r => r.profiles?.id).filter(Boolean);
      if (extras.length) {
        await supabase.from('pk_therapy_session_therapists').insert(extras.map(id => ({ session_id: newSession.id, therapist_id: id })));
      }
    }
  }

  closeCompleteDrawer();

  // NCISM §47(vii) — Post-PK review alert when last Paschatkarma session completes
  if (!isSkip && isPaschatkarma) {
    const patientId  = session?.patients?.id;
    const remaining  = _sessions.filter(s =>
      s.id !== id &&
      s.patients?.id === patientId &&
      s.therapy_phase === 'paschatkarma' &&
      s.status !== 'completed' && s.status !== 'skipped'
    );
    if (remaining.length === 0) {
      // §18m — notify referring doctor via doctor_alerts + close referral
      const { data: ref } = await supabase
        .from('referrals')
        .select('id, referring_doctor_id')
        .eq('patient_id', patientId)
        .eq('tenant_id', tenantId)
        .in('status', ['pending','accepted'])
        .eq('referral_type', 'internal')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ref?.referring_doctor_id) {
        await supabase.from('doctor_alerts').insert({
          tenant_id:    tenantId,
          doctor_id:    ref.referring_doctor_id,
          patient_name: session?.patients?.name || 'Patient',
          message:      `✅ PK Therapy Complete — ${session?.patients?.name || 'Patient'} has completed all Panchakarma sessions (Purvakarma → Pradhanakarma → Paschatkarma). Please schedule a post-therapy follow-up consultation.`,
          is_read:      false,
        });
        await supabase.from('referrals').update({ status: 'seen' }).eq('id', ref.id);
      }
      _alert('success',
        '✓ Paschatkarma complete. ' +
        '⚕ NCISM §47(vii): Post-therapy fitness review required — ' +
        'schedule a follow-up PK OPD consultation for ' + (session?.patients?.name || 'this patient') + '.' +
        (ref?.referring_doctor_id ? ' Referring doctor has been notified.' : '')
      );
      await loadAll();
      return;
    }
  }

  _alert('success', isSkip
    ? (rescheduleDate ? `Session skipped and rescheduled to ${rescheduleDate}.` : 'Session skipped.')
    : 'Session completed.');
  await loadAll();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _phaseLabel(p) {
  return { purvakarma:'Purvakarma', pradhanakarma:'Pradhanakarma', paschatkarma:'Paschatkarma' }[p] || p;
}
function _statusLabel(s) {
  return { scheduled:'Scheduled', in_progress:'In Progress', completed:'Completed', skipped:'Skipped' }[s] || s;
}
function _samLabel(s) {
  return {
    peya:'Peya', vilepi:'Vilepi', akrita_yusa:'Akrita Yusa',
    krita_yusa:'Krita Yusa', yusha_mamsa:'Yusha/Mamsa', normal_diet:'Normal diet'
  }[s] || s;
}
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.className = `alert show ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 3500);
  window.scrollTo({ top:0, behavior:'smooth' });
}

// ── Therapy Prescription ─────────────────────────────────────────────────────
let _rxSession = null;

window.openRxDrawer = function(sessionId) {
  const s = _sessions.find(x => x.id === sessionId);
  if (!s) return;
  _rxSession = s;
  const pt   = s.patients || {};
  const dept = s.departments || {};
  const adm  = _admissions.find(a => a.patients?.id === pt.id);
  const bed  = adm?.beds?.bed_number ? ` · Bed ${adm.beds.bed_number}` : '';
  document.getElementById('rx-session-info').innerHTML =
    `<strong>${pt.name || '—'}</strong>${bed}<br>
     Therapy: <strong>${s.therapy_name || '—'}</strong> · ${_phaseLabel(s.therapy_phase)} · ${dept.name || '—'}`;
  const list = document.getElementById('rx-items-list');
  list.innerHTML = '';
  _addRxItem(); _addRxItem();
  document.getElementById('rx-overlay').classList.add('open');
};

window.closeRxDrawer = function() {
  document.getElementById('rx-overlay').classList.remove('open');
  _rxSession = null;
};

window._addRxItem = function() {
  const row = document.createElement('div');
  row.className = 'rx-item-row';
  row.innerHTML = `
    <input type="text" placeholder="e.g. Tila Taila, Dashmoola Kwatha…"/>
    <input type="text" placeholder="e.g. 250 ml"/>
    <button class="rx-btn-rm" data-onclick="_removeClosest" data-onclick-a0="@this" data-onclick-a1=".rx-item-row">✕</button>`;
  document.getElementById('rx-items-list').appendChild(row);
};

window.saveTherapyRx = async function() {
  if (!_rxSession) return;
  const rows  = document.querySelectorAll('#rx-items-list .rx-item-row');
  const items = [];
  rows.forEach(r => {
    const inputs = r.querySelectorAll('input');
    const name   = inputs[0]?.value.trim();
    const dose   = inputs[1]?.value.trim();
    if (name) items.push({ name, dose });
  });
  if (!items.length) { _alert('error', 'Add at least one item.'); return; }

  const { data: presc, error: pErr } = await supabase.from('prescriptions').insert({
    tenant_id:  tenantId,
    patient_id: _rxSession.patients.id,
    visit_id:   null,
    status:     'pending',
  }).select('id').single();
  if (pErr) { _alert('error', 'Error: ' + pErr.message); return; }

  await supabase.from('prescription_items').insert(
    items.map(i => ({
      prescription_id: presc.id,
      medicine_id:     null,
      medicine_name:   i.name,
      dosage:          i.dose || null,
      frequency:       null,
      duration:        null,
      quantity:        1,
    }))
  );

  closeRxDrawer();
  _alert('success', `${items.length} item(s) sent to Dispensary for ${_rxSession.patients?.name}.`);
};

// Close on overlay click
['sched-overlay','complete-overlay','rx-overlay','assign-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) document.getElementById(id).classList.remove('open');
  });
});

// Init date picker
document.getElementById('date-picker').value = _viewDate;

// §21aa — Emergency Kit Audit
const today = new Date();
document.getElementById('ka-date').value     = today.toISOString().slice(0,10);
const nextMo = new Date(today); nextMo.setMonth(nextMo.getMonth()+1);
document.getElementById('ka-next-due').value = nextMo.toISOString().slice(0,10);
(async function checkKitAuditOverdue() {
  const { data } = await supabase.from('emergency_kit_audits')
    .select('audit_date').eq('tenant_id',tenantId).eq('location','pk_section')
    .order('audit_date',{ascending:false}).limit(1).maybeSingle();
  if (!data) { document.getElementById('kit-audit-overdue-banner').style.display = ''; return; }
  const daysSince = Math.floor((Date.now()-new Date(data.audit_date+'T00:00:00'))/86400000);
  document.getElementById('kit-audit-overdue-banner').style.display = daysSince > 30 ? '' : 'none';
  const recent = document.getElementById('ka-recent');
  if (recent) recent.textContent = `Last audit: ${new Date(data.audit_date+'T00:00:00').toLocaleDateString('en-IN')} · ${daysSince} days ago`;
})();

window.saveKitAudit = async function() {
  const d = document.getElementById('ka-date').value;
  if (!d) { alert('Audit date required'); return; }
  const { error } = await supabase.from('emergency_kit_audits').insert({
    tenant_id: tenantId,
    audit_date: d,
    location: document.getElementById('ka-location').value,
    all_items_present: document.getElementById('ka-items-ok').value === 'true',
    replacements_made: document.getElementById('ka-replacements').value.trim() || null,
    next_audit_due: document.getElementById('ka-next-due').value || null,
    audited_by: myProfile.id,
  });
  if (error) {
    if (error.code === '42P01') alert('Run session32_ncism_gaps.sql in Supabase first');
    else alert(safeErrorMessage(error, 'Something went wrong. Please try again.'));
    return;
  }
  const saved = document.getElementById('ka-saved');
  saved.style.display = ''; setTimeout(()=>saved.style.display='none',3000);
  document.getElementById('kit-audit-overdue-banner').style.display = 'none';
};

await loadAll();
renderPromoBanner('promo-banner', { supabase, tenantId });
