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
  const [sessRes, admRes, thRes, deptRes, tenantRes, roomRes, blocksRes, prepStaffRes, formularyRes, prepLogRes, pkSettingsRes, pkDutyRes, myShiftsRes] = await Promise.all([
    supabase
      .from('pk_therapy_sessions')
      .select(`
        id, therapy_phase, therapy_name, scheduled_date, scheduled_time,
        actual_start, actual_end, status, therapist_notes, doctor_clearance,
        therapy_room_number, samsarjana_stage, room_id,
        patients(id, name, phone, age, gender),
        profiles!therapist_id(id, full_name, gender),
        departments(id, name),
        pk_treatment_rooms(id, room_name)
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
    // Session 206 piece 3
    supabase
      .from('pk_roster_settings')
      .select('shift1_start,shift2_start,shift_duration_hours')
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabase
      .from('pk_therapist_duty')
      // pk_therapist_duty has 2 FKs to profiles (profile_id, created_by) -- an unqualified
      // profiles(...) embed is ambiguous and PostgREST rejects it; needs the FK hint.
      .select('id,profile_id,shift_slot,profiles!profile_id(id,full_name,gender)')
      .eq('tenant_id', tenantId)
      .eq('duty_date', _pkRosterDate),
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
  _rooms      = roomRes.data || [];
  _buildingBlocks = blocksRes.data || [];
  _ugTier     = isNCISMType(tenantRes.data?.type) ? ncismUgTier(tenantRes.data?.ug_intake) : 0;
  _myPkShiftsWeek = myShiftsRes.data || [];
  _prepStaff  = prepStaffRes.data  || [];
  _formulary  = formularyRes.data  || [];
  _prepLogs   = prepLogRes.data    || [];
  _pkRosterSettings = pkSettingsRes.data || null;
  _pkRosterDuty     = pkDutyRes.data     || [];
  // Real bug caught live this session: an ambiguous-FK embed silently returned no data
  // instead of erroring visibly (data was null, not an exception) -- log it so a future
  // regression here is loud instead of just quietly showing "0 on duty".
  if (pkDutyRes.error) console.error('pk_therapist_duty load failed:', pkDutyRes.error);
  if (pkSettingsRes.error) console.error('pk_roster_settings load failed:', pkSettingsRes.error);

  // If logged in as therapist, only show own sessions
  if (role === 'therapist') {
    _sessions = _sessions.filter(s => s.profiles?.id === myProfile?.id);
  }

  _populateFilterSelects();
  _populateSchedSelects();
  renderStats();
  applyFilters();
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

  const pkDept = _depts.find(d => d.name === 'Panchakarma');
  const pkTherapists = pkDept ? _therapists.filter(t => t.department_id === pkDept.id) : [];
  const current = pkTherapists.find(t => t.designation === 'pk_incharge');

  document.getElementById('pk-incharge-current').innerHTML = current
    ? `Currently: <strong>${_esc(current.full_name)}</strong>`
    : `<span style="color:var(--text-muted)">Not yet set.</span>`;

  const sel = document.getElementById('pk-incharge-select');
  const prevVal = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>' +
    pkTherapists.map(t => `<option value="${t.id}">${_esc(t.full_name)}${t.id === current?.id ? ' (current)' : ''}</option>`).join('');
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
  const capacity = parseInt(document.getElementById('room-capacity').value, 10) || 1;
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

  document.getElementById('pkroster-settings-form').style.display = isAdmin ? '' : 'none';
  document.getElementById('pkroster-weeklyoff-details').style.display = isAdmin ? '' : 'none';
  document.getElementById('pkroster-generate-form').style.display = isAdmin ? '' : 'none';
  document.getElementById('pkroster-shift1').value = _pkRosterSettings?.shift1_start?.slice(0,5) || '09:00';
  document.getElementById('pkroster-shift2').value = _pkRosterSettings?.shift2_start?.slice(0,5) || '14:00';
  if (isAdmin) _renderWeeklyOffList();

  const d = new Date(_pkRosterDate + 'T00:00:00');
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('pkroster-date-display').textContent =
    (_pkRosterDate === today ? 'Today · ' : '') + d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  document.getElementById('pkroster-date-picker').value = _pkRosterDate;
  document.getElementById('pkroster-day-count').textContent = `${_pkRosterDuty.length} therapist(s) on duty`;

  const grid = document.getElementById('pkroster-grid');
  grid.innerHTML = [1, 2].map(slot => {
    const entries = _pkRosterDuty.filter(r => r.shift_slot === slot);
    const rows = entries.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--cream);border-radius:7px;margin-bottom:6px;font-size:13px">
        <span>${_esc(r.profiles?.full_name || 'Unknown')}${r.profiles?.gender ? ` (${r.profiles.gender})` : ''}</span>
        ${isAdmin ? `<button data-onclick="removePkDuty" data-onclick-a0="${r.id}" style="border:none;background:none;color:var(--red);cursor:pointer;font-size:15px;padding:0 4px">✕</button>` : ''}
      </div>`).join('') || '<div style="color:var(--text-muted);font-size:13px;padding:6px 0">No one assigned yet.</div>';

    // Exclude only therapists already assigned to THIS shift (a double-assignment the DB's
    // unique constraint would reject anyway) -- someone on Shift 1 can still be offered for
    // Shift 2 too, that's a legitimate (if unusual) real-world case, not blocked here.
    const availableTherapists = _therapists.filter(t => !entries.some(r => r.profile_id === t.id));
    const options = availableTherapists.map(t => `<option value="${t.id}">${_esc(t.full_name)}</option>`).join('');
    const assignRow = isAdmin ? `
      <div style="display:flex;gap:6px;margin-top:8px">
        <select id="pkroster-assign-${slot}" style="flex:1;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12px;font-family:inherit">
          <option value="">— Assign therapist —</option>${options}
        </select>
        <button data-onclick="assignPkDuty" data-onclick-a0="${slot}" style="height:34px;padding:0 12px;background:var(--green-deep);color:#fff;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit">Add</button>
      </div>` : '';

    return `<div>
      <div style="font-weight:600;font-size:13px;color:var(--green-deep);margin-bottom:8px">${_pkShiftLabel(slot)}</div>
      ${rows}${assignRow}
    </div>`;
  }).join('');
}

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

window.savePkRosterSettings = async function() {
  const shift1 = document.getElementById('pkroster-shift1').value;
  const shift2 = document.getElementById('pkroster-shift2').value;
  if (!shift1 || !shift2) { _alert('error', 'Set both shift start times.'); return; }

  const { error } = await supabase.from('pk_roster_settings').upsert({
    tenant_id: tenantId,
    shift1_start: shift1,
    shift2_start: shift2,
    updated_by: myProfile?.id || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id' });

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to save shift times.')); return; }
  const saved = document.getElementById('pkroster-settings-saved');
  saved.style.display = '';
  setTimeout(() => { saved.style.display = 'none'; }, 2000);
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
  if (!_therapists.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No therapists registered yet.</div>'; return; }
  list.innerHTML = _therapists.map(t => `
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

// ── Generate Week (Session 206 cont.) ───────────────────────────────────────────
// Deliberately client-side, matching this file's own established pattern (pieces 1-3 are
// all plain Supabase calls, no PL/pgSQL business logic) rather than a server-side solver
// RPC like nursing's preview_nursing_week()/commit_nursing_week() -- PK's data volume
// (a handful of therapists, 7 days, 2 shifts) doesn't need heavier DB-side computation,
// and keeping the algorithm in one inspectable place is simpler to get right and verify.
let _pkGenPlan = null;
let _pkGenPlanKey = null; // weekStart|shift1Count|shift2Count the current _pkGenPlan was built from -- Publish refuses to run on a stale plan from different inputs, same safeguard nursing's Generate Roster uses.

// Real bug caught live testing on SDM (IST, UTC+5:30): `new Date(dateStr + 'T00:00:00')`
// parses as LOCAL midnight, but `.toISOString()` always serializes in UTC -- for any
// positive UTC offset that mismatch silently rolls the date back by one calendar day
// (confirmed: _mondayOf('2026-09-21'), a real Monday, returned '2026-09-20' instead).
// Fixed by staying in UTC calendar space end to end -- `new Date(dateStr)` (no time
// suffix) parses date-only strings as UTC midnight per spec, matching this file's own
// existing shiftDate()/goToday()/onPkRosterDatePick() convention -- then every getter/
// setter here uses the UTC variant so no local-timezone conversion is ever in the path.
function _mondayOf(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0,10);
}

function _weekDatesFrom(monday) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

// Pure function, no DB/DOM access -- takes real fetched data as parameters so it's easy to
// reason about and re-verify independently of the UI around it.
function _computePkWeekPlan(therapists, weekStart, shift1Count, shift2Count, leaveByProfile) {
  const dates = _weekDatesFrom(weekStart);
  const loadCount = {};
  therapists.forEach(t => { loadCount[t.id] = 0; });

  const onLeave = (id, dateStr) => (leaveByProfile[id] || []).some(r => r.from_date <= dateStr && r.to_date >= dateStr);
  const sortByLoad = (arr) => [...arr].sort((a, b) => (loadCount[a.id] - loadCount[b.id]) || a.full_name.localeCompare(b.full_name));

  return dates.map(dateStr => {
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    const offToday = therapists.filter(t => t.weekly_off_day === dow || onLeave(t.id, dateStr));
    const eligible = therapists.filter(t => t.weekly_off_day !== dow && !onLeave(t.id, dateStr));

    const shift1 = sortByLoad(eligible).slice(0, shift1Count);
    shift1.forEach(t => { loadCount[t.id]++; });

    const usedToday = new Set(shift1.map(t => t.id));
    const shift2 = sortByLoad(eligible.filter(t => !usedToday.has(t.id))).slice(0, shift2Count);
    shift2.forEach(t => { loadCount[t.id]++; });

    return {
      date: dateStr, dow,
      shift1, shift1Gap: Math.max(0, shift1Count - shift1.length),
      shift2, shift2Gap: Math.max(0, shift2Count - shift2.length),
      off: offToday,
    };
  });
}

// Session 207 (cont.) -- gender-separated generation: two fully independent rotations
// (one per gender pool), each fair-by-load only within its own pool. Replaces the old
// single-pool version, which picked whoever was least-loaded regardless of gender and
// could silently produce an all-one-gender shift -- a real coverage gap for Panchakarma,
// where patient-therapist same-gender pairing is standard practice (the same reason
// Treatment Rooms are gender-split per Sch III). Therapists with no gender set (or
// 'other') are excluded from generation entirely -- same "don't count until assigned"
// principle Rooms' compliance banner already uses for gender_restriction='any'.
function _computePkWeekPlanGendered(therapists, weekStart, counts, leaveByProfile) {
  const dates = _weekDatesFrom(weekStart);
  const male   = therapists.filter(t => t.gender === 'M');
  const female = therapists.filter(t => t.gender === 'F');

  const malePlan   = _computePkWeekPlan(male,   weekStart, counts.shift1Male,   counts.shift2Male,   leaveByProfile);
  const femalePlan = _computePkWeekPlan(female, weekStart, counts.shift1Female, counts.shift2Female, leaveByProfile);

  return dates.map((dateStr, i) => {
    const m = malePlan[i], f = femalePlan[i];
    return {
      date: dateStr, dow: m.dow,
      shift1Male: m.shift1, shift1MaleGap: m.shift1Gap,
      shift1Female: f.shift1, shift1FemaleGap: f.shift1Gap,
      shift2Male: m.shift2, shift2MaleGap: m.shift2Gap,
      shift2Female: f.shift2, shift2FemaleGap: f.shift2Gap,
      off: [...m.off, ...f.off],
    };
  });
}

function _pkGenCounts() {
  return {
    shift1Male:   parseInt(document.getElementById('pkgen-shift1-male').value, 10)   || 0,
    shift1Female: parseInt(document.getElementById('pkgen-shift1-female').value, 10) || 0,
    shift2Male:   parseInt(document.getElementById('pkgen-shift2-male').value, 10)   || 0,
    shift2Female: parseInt(document.getElementById('pkgen-shift2-female').value, 10) || 0,
  };
}

window.previewPkWeek = async function() {
  const rawDate = document.getElementById('pkgen-week-start').value;
  if (!rawDate) { _alert('error', 'Pick a week start date.'); return; }
  const weekStart = _mondayOf(rawDate);
  document.getElementById('pkgen-week-start').value = weekStart;

  const counts = _pkGenCounts();
  if (!Object.values(counts).some(n => n > 0)) { _alert('error', 'Enter at least one shift headcount.'); return; }

  const noGenderCount = _therapists.filter(t => t.gender !== 'M' && t.gender !== 'F').length;

  const dates = _weekDatesFrom(weekStart);
  const { data: leaveRows, error } = await supabase.from('staff_leaves')
    .select('profile_id,from_date,to_date')
    .eq('tenant_id', tenantId)
    .eq('status', 'approved')
    .lte('from_date', dates[6])
    .gte('to_date', dates[0]);
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to check approved leave.')); return; }

  const leaveByProfile = {};
  (leaveRows || []).forEach(r => { (leaveByProfile[r.profile_id] ||= []).push(r); });

  _pkGenPlan = _computePkWeekPlanGendered(_therapists, weekStart, counts, leaveByProfile);
  _pkGenPlanKey = `${weekStart}|${counts.shift1Male}|${counts.shift1Female}|${counts.shift2Male}|${counts.shift2Female}`;
  _renderPkGenPreview(weekStart, counts, noGenderCount);
};

function _renderPkGenPreview(weekStart, counts, noGenderCount) {
  const el = document.getElementById('pkgen-preview');
  if (!_pkGenPlan) { el.innerHTML = ''; return; }

  const totalGap = _pkGenPlan.reduce((s, d) => s + d.shift1MaleGap + d.shift1FemaleGap + d.shift2MaleGap + d.shift2FemaleGap, 0);
  const totalFilled = _pkGenPlan.reduce((s, d) => s + d.shift1Male.length + d.shift1Female.length + d.shift2Male.length + d.shift2Female.length, 0);
  const totalNeeded = _pkGenPlan.length * (counts.shift1Male + counts.shift1Female + counts.shift2Male + counts.shift2Female);
  const cell = (list, gap) => (list.map(t => _esc(t.full_name)).join(', ') || '—') + (gap ? ` <span style="color:var(--red)">(short ${gap})</span>` : '');

  el.innerHTML = `
    <div style="margin-bottom:10px;font-size:13px">
      ${totalGap === 0 ? '✅' : '⚠️'} <strong>${totalFilled}/${totalNeeded}</strong> slots filled for the week starting ${new Date(weekStart+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short'})}${totalGap ? ` — <strong>${totalGap} gap(s)</strong>` : ''}.
      ${noGenderCount ? `<br/><span style="color:var(--text-muted)">${noGenderCount} therapist(s) have no gender on file and were excluded from this generation — set it via their Account Settings first.</span>` : ''}
    </div>
    <div style="overflow-x:auto">
    <table class="sessions-table"><thead><tr>
      <th>Day</th><th>Shift 1 — Male</th><th>Shift 1 — Female</th><th>Shift 2 — Male</th><th>Shift 2 — Female</th><th>Off / Unavailable</th>
    </tr></thead><tbody>${_pkGenPlan.map(d => `
      <tr>
        <td>${new Date(d.date+'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'})}</td>
        <td>${cell(d.shift1Male, d.shift1MaleGap)}</td>
        <td>${cell(d.shift1Female, d.shift1FemaleGap)}</td>
        <td>${cell(d.shift2Male, d.shift2MaleGap)}</td>
        <td>${cell(d.shift2Female, d.shift2FemaleGap)}</td>
        <td style="color:var(--text-muted);font-size:12px">${d.off.map(t => _esc(t.full_name)).join(', ') || '—'}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    <button data-onclick="publishPkWeek" style="margin-top:10px;height:40px;padding:0 18px;background:var(--green-deep);color:#fff;border:none;border-radius:7px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit">Publish This Week</button>
    <span id="pkgen-published" style="display:none;margin-left:10px;color:var(--green-mid);font-size:13px;font-weight:600">✓ Published</span>
  `;
}

window.publishPkWeek = async function() {
  const rawDate = document.getElementById('pkgen-week-start').value;
  const weekStart = _mondayOf(rawDate);
  const counts = _pkGenCounts();
  const currentKey = `${weekStart}|${counts.shift1Male}|${counts.shift1Female}|${counts.shift2Male}|${counts.shift2Female}`;

  // Same guard nursing's Generate Roster uses -- a stale preview from different inputs
  // (week changed, headcounts edited) can never be silently committed.
  if (!_pkGenPlan || currentKey !== _pkGenPlanKey) {
    _alert('error', 'Preview this exact week/headcount combination again before publishing.');
    return;
  }

  const dates = _weekDatesFrom(weekStart);
  const { error: delError } = await supabase.from('pk_therapist_duty')
    .delete()
    .eq('tenant_id', tenantId)
    .gte('duty_date', dates[0])
    .lte('duty_date', dates[6]);
  if (delError) { _alert('error', safeErrorMessage(delError, 'Failed to clear the target week.')); return; }

  const rows = [];
  _pkGenPlan.forEach(d => {
    d.shift1Male.forEach(t => rows.push({ tenant_id: tenantId, profile_id: t.id, duty_date: d.date, shift_slot: 1, created_by: myProfile?.id || null }));
    d.shift1Female.forEach(t => rows.push({ tenant_id: tenantId, profile_id: t.id, duty_date: d.date, shift_slot: 1, created_by: myProfile?.id || null }));
    d.shift2Male.forEach(t => rows.push({ tenant_id: tenantId, profile_id: t.id, duty_date: d.date, shift_slot: 2, created_by: myProfile?.id || null }));
    d.shift2Female.forEach(t => rows.push({ tenant_id: tenantId, profile_id: t.id, duty_date: d.date, shift_slot: 2, created_by: myProfile?.id || null }));
  });

  if (rows.length) {
    const { error: insError } = await supabase.from('pk_therapist_duty').insert(rows);
    if (insError) { _alert('error', safeErrorMessage(insError, 'Failed to publish the week.')); return; }
  }

  const published = document.getElementById('pkgen-published');
  if (published) { published.style.display = ''; setTimeout(() => { published.style.display = 'none'; }, 2500); }
  _pkGenPlan = null;
  _pkGenPlanKey = null;
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
}

function _populateRoomSelect() {
  const sr = document.getElementById('sched-room');
  const note = document.getElementById('sched-room-note');
  sr.innerHTML = '<option value="">— Not assigned —</option>';
  const active = _rooms.filter(r => r.status === 'active');
  active.forEach(r => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = `${r.room_name}${r.room_type ? ' — ' + r.room_type : ''}`;
    sr.appendChild(o);
  });
  note.style.display = active.length ? 'none' : '';
}

function _populateTherapistSelect() {
  const st = document.getElementById('sched-therapist');
  const note = document.getElementById('therapist-note');
  st.innerHTML = '<option value="">— Select therapist —</option>';

  const males   = _therapists.filter(t => t.gender === 'M');
  const females = _therapists.filter(t => t.gender === 'F');
  const unknown = _therapists.filter(t => !t.gender);

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

  if (!_therapists.length) {
    note.textContent = 'No therapists registered yet. Add staff with role "therapist" via the signup flow.';
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
      note.textContent = `${_therapists.length} therapist(s) available — ${m}M / ${f}F (NCISM Sch XX/33 needs ${half}M+${half}F for your ${_ugTier} UG intake)`;
      note.style.color = (m >= half && f >= half) ? 'var(--green-mid)' : 'var(--gold)';
    } else {
      note.textContent = `${_therapists.length} therapist(s) available — ${m}M / ${f}F`;
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

function renderTable(rows) {
  const tbody = document.getElementById('sessions-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">No sessions for this date.<br>Use "+ Schedule Session" to add one.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(s => {
    const pt        = s.patients || {};
    const therapist = s.profiles || {};
    const dept      = s.departments || {};
    const timeStr   = s.scheduled_time ? s.scheduled_time.slice(0,5) : '—';
    const canStart  = s.status === 'scheduled';
    const canComplete = s.status === 'scheduled' || s.status === 'in_progress';
    const canSkip   = s.status === 'scheduled';

    const ptMeta = [pt.gender, pt.age ? pt.age+'y' : ''].filter(Boolean).join(' · ');
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

    return `<tr>
      <td>
        <div class="time-cell">${timeStr}</div>
        ${s.actual_start ? `<div class="time-end">Started ${s.actual_start.slice(11,16)}</div>` : ''}
      </td>
      <td>
        <div class="pt-name">${_esc(pt.name||'—')}</div>
        ${ptMeta ? `<div class="pt-meta">${ptMeta}</div>` : ''}
      </td>
      <td>
        <div class="therapy-name">${_esc(s.therapy_name||'—')}</div>
        <span class="phase-badge phase-${s.therapy_phase}">${_phaseLabel(s.therapy_phase)}</span>
        ${roomLabel}
        ${samLabel}
      </td>
      <td>
        <div>${_esc(therapist.full_name||'—')}</div>
        ${therapist.gender ? `<div class="pt-meta">${therapist.gender === 'M' ? 'Male' : 'Female'}</div>` : ''}
      </td>
      <td>${_esc(dept.name||'—')}</td>
      <td>${fitnessBadge}</td>
      <td>
        <span class="status-badge status-${s.status}">
          ${_statusLabel(s.status)}
        </span>
      </td>
      <td>
        <div class="row-actions">
          ${canStart ? `<button class="icon-btn start" data-onclick="quickStart" data-onclick-a0="${s.id}" title="Mark In Progress">&#9654;</button>` : ''}
          ${canComplete ? `<button class="icon-btn complete" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@false" title="Complete">&#10003;</button>` : ''}
          ${canSkip ? `<button class="icon-btn skip" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@true" title="Skip">&#10007;</button>` : ''}
          <button class="icon-btn" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@false" data-onclick-a2="@true" title="Notes">&#128203;</button>
          <button class="icon-btn" data-onclick="openRxDrawer" data-onclick-a0="${s.id}" title="Prescribe Therapy Materials" style="color:#1a4a2e">💊</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

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
  onSourceChange();
  if (prefillAdmId) {
    const opts = document.getElementById('sched-admission').options;
    for (const o of opts) {
      try { if (JSON.parse(o.value).admId === prefillAdmId) { o.selected = true; break; } }
      catch {}
    }
  }
  document.getElementById('sched-overlay').classList.add('open');
};
window.closeSchedDrawer = function() {
  document.getElementById('sched-overlay').classList.remove('open');
};

window.onSourceChange = function() {
  const src = document.getElementById('sched-source').value;
  document.getElementById('ipd-patient-field').style.display = src === 'ipd' ? '' : 'none';
  document.getElementById('opd-patient-field').style.display = src === 'opd' ? '' : 'none';
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

  // NABH PRE.2 ATWC CORE — Female therapist for female patients
  let patientGender = null;
  if (source === 'ipd') {
    const raw = document.getElementById('sched-admission').value;
    if (raw) {
      try { const obj = JSON.parse(raw); const adm = _admissions.find(a=>a.id===obj.admId); patientGender = adm?.patients?.gender; } catch {}
    }
  } else {
    const patientId = document.getElementById('sched-opd-patient').value;
    if (patientId) {
      const { data: pt } = await supabase.from('patients').select('gender').eq('id',patientId).single();
      patientGender = pt?.gender;
    }
  }
  const therapistData = _therapists.find(t => t.id === therapist);
  if (patientGender === 'F' && therapistData?.gender === 'M') {
    const override = confirm('⚠ NABH PRE.2 ATWC CORE — Gender Mismatch\n\nFemale patients must be treated by female therapists.\n\nThis patient is female and the selected therapist is male.\n\nContinue only with documented medical justification?');
    if (!override) return;
  }

  // NABH PRE.3 ATWC CORE — PK Consent 6-month validity check
  if (source === 'ipd' || source === 'opd') {
    const ptId = source === 'ipd'
      ? (() => { try { return JSON.parse(document.getElementById('sched-admission').value).patientId; } catch { return null; } })()
      : document.getElementById('sched-opd-patient').value;
    if (ptId) {
      const sixMonthsAgo = new Date(Date.now() - 180*86400000).toISOString();
      const { data: consentData } = await supabase.from('consent_records')
        .select('id,consent_datetime,valid_until')
        .eq('patient_id', ptId).eq('tenant_id', tenantId)
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

  let patientId  = null;
  let admId      = null;

  if (source === 'ipd') {
    const raw = document.getElementById('sched-admission').value;
    if (!raw) { _alert('error','Select an IPD patient.'); return; }
    try {
      const obj = JSON.parse(raw);
      patientId = obj.patientId;
      admId     = obj.admId;
    } catch { _alert('error','Invalid patient selection.'); return; }
  } else {
    patientId = document.getElementById('sched-opd-patient').value;
    if (!patientId) { _alert('error','Select a patient.'); return; }
  }

  const roomId = document.getElementById('sched-room').value || null;

  // Session 206: best-effort client-side heads-up before hitting the real DB-enforced
  // conflict guard (pk_sessions_room_slot_uniq) — that unique index is the actual
  // enforcement, this is just so the user isn't surprised by a raw constraint error.
  if (roomId && time) {
    const { data: clash } = await supabase.from('pk_therapy_sessions')
      .select('id, patients(name)')
      .eq('room_id', roomId).eq('scheduled_date', date).eq('scheduled_time', time)
      .neq('status', 'skipped').maybeSingle();
    if (clash) {
      const room = _rooms.find(r => r.id === roomId);
      const ok = confirm(`⚠ ${room?.room_name || 'This room'} already has a session booked at ${time} for ${clash.patients?.name || 'another patient'}.\n\nPick a different room or time — continuing may fail.`);
      if (!ok) return;
    }
  }

  const btn = document.getElementById('btn-sched-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await supabase.from('pk_therapy_sessions').insert({
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
  });

  btn.disabled = false; btn.textContent = 'Schedule';
  if (error) {
    _alert('error', safeErrorMessage(error, error.code === '23505'
      ? 'That room is already booked for this exact date and time — pick another room or slot.'
      : 'Save failed.'));
    return;
  }
  closeSchedDrawer();
  _alert('success','Session scheduled.');
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
window.openCompleteDrawer = function(id, isSkip, viewOnly) {
  const s  = _sessions.find(x => x.id === id);
  if (!s) return;
  const pt        = s.patients || {};
  const therapist = s.profiles || {};

  document.getElementById('comp-session-id').value   = id;
  document.getElementById('comp-start').value         = s.actual_start ? s.actual_start.slice(11,16) : '';
  document.getElementById('comp-end').value           = s.actual_end ? s.actual_end.slice(11,16) : '';
  document.getElementById('comp-notes').value         = s.therapist_notes || '';
  document.getElementById('comp-clearance').checked   = s.doctor_clearance || false;
  document.getElementById('comp-skip-reason').value   = '';

  // Samsarjana Krama — only for Paschatkarma
  const isPaschatkarma = s.therapy_phase === 'paschatkarma';
  const samSec = document.getElementById('samsarjana-section');
  samSec.style.display = (isPaschatkarma && !isSkip) ? '' : 'none';
  if (isPaschatkarma) {
    document.getElementById('comp-samsarjana-stage').value = s.samsarjana_stage || '';
    document.getElementById('comp-samsarjana-tolerating').checked = false;
  }
  document.getElementById('skip-reason-field').style.display = isSkip ? '' : 'none';

  const titleEl = document.getElementById('complete-title');
  const saveBtn = document.getElementById('btn-complete-save');

  if (viewOnly || s.status === 'completed' || s.status === 'skipped') {
    titleEl.textContent = 'Session Notes';
    saveBtn.style.display = 'none';
    document.getElementById('comp-start').disabled = true;
    document.getElementById('comp-end').disabled   = true;
    document.getElementById('comp-notes').disabled = true;
  } else {
    titleEl.textContent = isSkip ? 'Skip Session' : 'Complete Session';
    saveBtn.textContent  = isSkip ? 'Mark Skipped' : 'Mark Completed';
    saveBtn.style.display = '';
    document.getElementById('comp-start').disabled = false;
    document.getElementById('comp-end').disabled   = false;
    document.getElementById('comp-notes').disabled = false;
  }
  saveBtn.dataset.skip = isSkip ? '1' : '0';

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
  const isSkip  = document.getElementById('btn-complete-save').dataset.skip === '1';
  const start   = document.getElementById('comp-start').value;
  const end     = document.getElementById('comp-end').value;
  const notes   = document.getElementById('comp-notes').value.trim();
  const clear   = document.getElementById('comp-clearance').checked;
  const today   = _viewDate;

  const session = _sessions.find(s => s.id === id);
  const isPaschatkarma = session?.therapy_phase === 'paschatkarma';

  const patch = {
    status:           isSkip ? 'skipped' : 'completed',
    therapist_notes:  notes || null,
    doctor_clearance: clear,
  };
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

  _alert('success', isSkip ? 'Session skipped.' : 'Session completed.');
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
['sched-overlay','complete-overlay','rx-overlay'].forEach(id => {
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
