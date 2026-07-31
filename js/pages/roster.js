import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNursingDutyDept, shiftsForDept } from '../config/ncism.js';
import { resolveNursingHeadship, canActAsNursingHead } from '../modules/roster/nursingHeadship.js';

// Session 137: widened from admin-only to also let plain nursing staff/ayahs
// (role 'nurse', covers both designations) view the roster -- read-only,
// gated below via _canEdit. super_admin/dept_admin always retain full edit;
// nurse_manager's edit ability is now further gated on being the currently-
// resolved nursing head (see loadHeadGate()), not just holding the role.
await requireAuth(['super_admin', 'dept_admin', 'nurse_manager', 'nurse']);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const role     = getCurrentRole();
let _canEdit   = role === 'super_admin' || role === 'dept_admin'; // refined once headship resolves, for nurse_manager
let _holidays  = new Map(); // 'YYYY-MM-DD' -> occasion name, for the visible week

// This page was originally built as the doctor RMO/EMO/GDMO on-call duty
// roster (NCISM §51(5)) and later reused wholesale for the Nursing Duty
// Roster (Sessions 137-143) rather than split into a separate page. A
// nurse_manager/nurse's department list is already scoped down to just the
// 8 real nursing-duty places (isNursingDutyDept, loadDepartments() below) --
// for them this page is ALWAYS the nursing roster, never the doctor one, so
// the header text and NCISM citation need to say so instead of "RMO / EMO /
// GDMO". The On-Call Specialty Consultant table is a separate doctor-
// specialist concept (shift_type='on_call') that no nursing department ever
// uses in this data model -- shown to a nurse it would just be a permanent,
// unfixable wall of "Unassigned", so it's hidden entirely for this view.
const _isNursingScopedView = role === 'nurse_manager' || role === 'nurse';
if (_isNursingScopedView) {
  document.getElementById('page-subtitle').textContent = 'NCISM §18h/18i — ward & OPD nursing shift schedule with gap detection';
  document.getElementById('main-section-title').textContent = '🏥 Nursing Duty Roster';
  document.getElementById('oncall-section').style.display = 'none';
}

// Session 145: Leave & Weekly Off tab shows other staff's personal leave
// reasons/rejection notes -- same privacy boundary nursing-admin.html's
// leave card already draws (Session 112: "not hr.html's tenant-wide,
// all-roles pending-leave list"). A plain nurse/ayah can view the roster
// read-only but must not see this tab; nurse_manager/dept_admin/super_admin
// keep the same access nursing-admin.html already grants them.
const _canSeeLeaveTab = role === 'super_admin' || role === 'dept_admin' || role === 'nurse_manager';
if (!_canSeeLeaveTab) { document.getElementById('tab-btn-leave').style.display = 'none'; }

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ── State ──────────────────────────────────────────
let _weekStart  = _getMonday(new Date());
let _depts      = [];
let _doctors    = [];
let _roster     = [];     // duty_roster rows for current week
let _editEntry  = null;   // existing row being edited
let _newSlotIndex = 1;    // Session 139: next free slot_index when adding a new entry (multi-staff-per-shift)

// Session 141: SHIFTS is no longer a fixed global set -- shiftsForDept(dept)
// computes which shift(s) apply per department (a single 'general' 9am-5pm
// day shift for OPD/Screening OPD/Panchakarma/Diagnostics, the classic
// 3-shift ward pattern for everything else).
const SHIFT_LABELS = { morning:'Morning', afternoon:'Afternoon', night:'Night', general:'General Duty', on_call:'On-Call' };
const SHIFT_TIMES  = { morning:'06:00–14:00', afternoon:'14:00–22:00', night:'22:00–06:00', general:'09:00–17:00', on_call:'24hr specialist' };

// ── Utilities ──────────────────────────────────────
function _getMonday(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const m = new Date(d);
  m.setDate(m.getDate() + diff);
  m.setHours(0,0,0,0);
  return m;
}
function _dateStr(d) {
  return d.toISOString().split('T')[0];
}
function _fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN',{day:'numeric',month:'short'});
}
function _fmtDay(d) {
  return new Date(d).toLocaleDateString('en-IN',{weekday:'short'});
}
function _isToday(d) {
  return _dateStr(new Date(d)) === _dateStr(new Date());
}
function _weekDates() {
  return Array.from({length:7}, (_,i) => {
    const d = new Date(_weekStart);
    d.setDate(d.getDate() + i);
    return _dateStr(d);
  });
}

// ── Load data ──────────────────────────────────────
async function loadDepartments() {
  const { data } = await supabase.from('departments')
    .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active',true).order('name');
  _depts = data || [];

  // Nursing Superintendent (and, Session 137, plain nursing staff/ayahs viewing
  // read-only) only need departments where nursing duty is actually required
  // -- not every org department (Administration, Sanskrit & Samhita, Security,
  // etc. have no nursing staff at all). super_admin/dept_admin keep the full
  // list unchanged. Session 141: uses the real nursing-duty place list
  // (isNursingDutyDept()) instead of the old per-clinical-department model.
  if (role === 'nurse_manager' || role === 'nurse') {
    _depts = _depts.filter(isNursingDutyDept);
  }

  const fd = document.getElementById('filter-dept');
  const md = document.getElementById('m-dept');
  [fd, md].forEach(sel => {
    const preserve = sel.value;
    while(sel.options.length > (sel === fd ? 1 : 0)) sel.remove(sel.options.length-1);
    _depts.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
      sel.appendChild(o);
    });
    if (preserve) sel.value = preserve;
  });

  // Plain nursing staff/ayah, Session 137: default the view to their own
  // ward for convenience -- still free to switch to any other nursing dept.
  if (role === 'nurse' && profile.department_id && _depts.some(d => d.id === profile.department_id)) {
    fd.value = profile.department_id;
  }
}

// Session 137: nurse_manager's edit ability is gated on actually being the
// currently-resolved nursing head (default = Nursing Superintendent
// designation, or an explicit delegate) -- not just holding the role. The
// other 3 nurse_manager accounts, and every plain nurse/ayah, get read-only.
async function loadHeadGate() {
  if (role !== 'nurse_manager') return; // super_admin/dept_admin already true; plain nurse stays false
  const headship = await resolveNursingHeadship(supabase, tenantId);
  _canEdit = canActAsNursingHead(headship, profile.id, role, profile.designation);
  if (!_canEdit) {
    _alert('info', `Read-only — ${headship.effectiveHead?.full_name || 'the current Nursing Head'} is currently the only nursing account that can edit this roster.`);
  }
  _applyEditGate();
}

// Hides/disables every write-capable control when !_canEdit. Read-only
// visitors still see the full grid, gap banner, and on-call table.
function _applyEditGate() {
  document.getElementById('btn-add-shift').style.display = _canEdit ? '' : 'none';
  document.getElementById('btn-confirm-all').style.display = _canEdit ? '' : 'none';
  const autoBtn = document.getElementById('btn-auto-assign-weekly-off');
  if (autoBtn) autoBtn.style.display = _canEdit ? '' : 'none';
}

async function loadHolidays() {
  const dates = _weekDates();
  const { data } = await supabase.from('public_holidays').select('holiday_date,name')
    .eq('tenant_id', tenantId).gte('holiday_date', dates[0]).lte('holiday_date', dates[6]);
  _holidays = new Map((data||[]).map(h => [h.holiday_date, h.name]));
}

async function loadDoctors() {
  const { data } = await supabase.from('profiles')
    .select('id,full_name,role')
    .eq('tenant_id', tenantId)
    .in('role', ['doctor','nurse'])
    .eq('status','active')
    .order('full_name');
  _doctors = data || [];
  const sel = document.getElementById('m-doctor');
  while(sel.options.length > 1) sel.remove(1);
  _doctors.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.full_name + (d.role === 'nurse' ? ' (Nurse/RMO)' : '');
    sel.appendChild(o);
  });
}

async function loadRoster() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  let q = supabase.from('duty_roster')
    // Session 139: duty_roster has always had 2 FKs to profiles (profile_id AND
    // created_by) -- an unhinted `profiles(full_name)` embed is ambiguous and
    // PostgREST returns HTTP 300. This session's schema migration apparently
    // forced a PostgREST schema-cache refresh that surfaced this pre-existing
    // bug for the first time (caught live -- loadRoster() 300'd for every
    // tenant, not something specific to the new multi-slot columns).
    .select('id,department_id,profile_id,shift_date,shift_type,slot_index,bed_range_start,bed_range_end,is_confirmed,notes,profiles!duty_roster_profile_id_fkey(full_name)')
    .eq('tenant_id', tenantId)
    .gte('shift_date', dates[0])
    .lte('shift_date', dates[6]);
  if (deptFilter) q = q.eq('department_id', deptFilter);
  const [{ data }] = await Promise.all([q, loadHolidays()]);
  _roster = data || [];
  renderRoster();
  renderOnCall();
  updateGapBanner();
  // Session 145: keep the Weekly Off tab's "This Week" column in sync with
  // week-nav clicks -- only if that tab has already been opened once (avoids
  // fetching/rendering leave-tab data on every load for viewers who never
  // open it, e.g. plain nurses who can't see the tab at all).
  if (_nursingStaffOff.length) renderWeeklyOff();
}

// Session 137: public holidays "pre-filled into every roster" -- a small 🎉
// marker + tooltip on the matching date column, in both tables below. A live
// read against public_holidays, not copied into duty_roster.
function _dateHeaderHtml(d) {
  const holidayName = _holidays.get(d);
  return `<th class="${_isToday(d)?'today-col':''}"${holidayName?` title="Public Holiday: ${_esc(holidayName)}" style="background:#fdf3e0"`:''}>`
    + `${_fmtDay(d)}<br><span style="font-weight:400;font-size:10px">${_fmtDate(d)}</span>`
    + (holidayName ? `<br><span style="font-size:9px;color:#7a5a10">🎉 ${_esc(holidayName)}</span>` : '')
    + `</th>`;
}

// ── Render weekly roster ───────────────────────────
function renderRoster() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  const depts = deptFilter ? _depts.filter(d => d.id === deptFilter) : _depts;

  // Header
  const thead = document.getElementById('roster-thead');
  thead.innerHTML = `<tr>
    <th class="shift-col">Shift</th>
    ${dates.map(d => _dateHeaderHtml(d)).join('')}
  </tr>`;

  // Body — one group of rows per dept
  const tbody = document.getElementById('roster-tbody');
  if (!depts.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No departments configured.</td></tr>'; return; }

  let html = '';
  depts.forEach(dept => {
    html += `<tr><td colspan="8" style="background:var(--green-light);color:var(--green-deep);font-weight:600;font-size:11px;padding:5px 10px;text-transform:uppercase;letter-spacing:.5px">${_esc(dept.name)}</td></tr>`;
    shiftsForDept(dept).forEach(shift => {
      html += `<tr>
        <td class="shift-label"><span class="shift-badge ${shift}">${SHIFT_LABELS[shift]}</span><br><span style="font-size:9px">${SHIFT_TIMES[shift]}</span></td>
        ${dates.map(d => {
          const entries = _roster.filter(r => r.department_id === dept.id && r.shift_date === d && r.shift_type === shift);
          return _cellHtml(dept.id, d, shift, entries);
        }).join('')}
      </tr>`;
    });
  });
  tbody.innerHTML = html;
  _wireCellClicks(tbody);
}

// Session 139: a cell can now hold several concurrent staff (multi-nurse
// wards, sized by real bed-count ratios) -- render every duty_roster row for
// that dept/date/shift as its own clickable line, plus a trailing "+ Add"
// affordance (or the unassigned-gap label if the cell is completely empty)
// to assign one more without disturbing the existing slots.
function _cellHtml(deptId, date, shift, entries) {
  const today = _isToday(date);
  if (!entries.length) {
    return `<td class="${today?'today-col':''}">
      <div class="shift-cell gap ${shift}">
        <span class="cell-gap-label" data-dept="${deptId}" data-date="${date}" data-shift="${shift}" data-entry-id="" data-slot-index="1">⚠ Unassigned</span>
      </div></td>`;
  }
  const maxSlot = Math.max(...entries.map(e => e.slot_index || 1));
  const items = entries.map(entry => {
    const name = entry.profiles?.full_name || '—';
    const beds = (entry.bed_range_start && entry.bed_range_end) ? `<span class="cell-beds">Beds ${entry.bed_range_start}–${entry.bed_range_end}</span>` : '';
    return `<div class="slot-item" data-dept="${deptId}" data-date="${date}" data-shift="${shift}" data-entry-id="${entry.id}" data-slot-index="${entry.slot_index || 1}">
      <span class="cell-name">${_esc(name)}</span>
      ${beds}
      ${entry.is_confirmed ? '<span class="cell-confirmed">✓ Confirmed</span>' : '<span class="cell-pending">Pending confirm</span>'}
      ${entry.notes ? `<span class="cell-status">${_esc(entry.notes)}</span>` : ''}
    </div>`;
  }).join('');
  return `<td class="${today?'today-col':''}">
    <div class="shift-cell ${shift}">
      ${items}
      <div class="cell-add" data-dept="${deptId}" data-date="${date}" data-shift="${shift}" data-entry-id="" data-slot-index="${maxSlot + 1}">+ Add</div>
    </div></td>`;
}

function _wireCellClicks(tbody) {
  tbody.querySelectorAll('.slot-item, .cell-add, .cell-gap-label').forEach(el => {
    el.addEventListener('click', () => openModal(
      el.dataset.dept, el.dataset.date, el.dataset.shift, el.dataset.entryId || null, Number(el.dataset.slotIndex) || 1
    ));
  });
}

// ── On-Call roster ─────────────────────────────────
function renderOnCall() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  const depts = deptFilter ? _depts.filter(d => d.id === deptFilter) : _depts;

  const thead = document.getElementById('oncall-thead');
  thead.innerHTML = `<tr>
    <th class="shift-col">Specialty Dept</th>
    ${dates.map(d => _dateHeaderHtml(d)).join('')}
  </tr>`;

  const tbody = document.getElementById('oncall-tbody');
  if (!depts.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No departments configured.</td></tr>'; return; }

  let html = '';
  depts.forEach(dept => {
    html += `<tr>
      <td class="shift-label"><span class="shift-badge on_call">${_esc(dept.ncism_code || '—')}</span><br><span style="font-size:10px;color:var(--text-mid)">${_esc(dept.name)}</span></td>
      ${dates.map(d => {
        const entries = _roster.filter(r => r.department_id === dept.id && r.shift_date === d && r.shift_type === 'on_call');
        return _cellHtml(dept.id, d, 'on_call', entries);
      }).join('')}
    </tr>`;
  });
  tbody.innerHTML = html;
  _wireCellClicks(tbody);
}

// ── Gap detection ──────────────────────────────────
function updateGapBanner() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  const depts = deptFilter ? _depts.filter(d => d.id === deptFilter) : _depts;
  let gaps = 0;
  depts.forEach(dept => {
    shiftsForDept(dept).forEach(shift => {
      dates.forEach(d => {
        const has = _roster.some(r => r.department_id === dept.id && r.shift_date === d && r.shift_type === shift);
        if (!has) gaps++;
      });
    });
  });
  const banner = document.getElementById('gap-banner');
  if (gaps > 0) {
    const section = _isNursingScopedView ? '§18h/18i' : '§51(5)';
    banner.textContent = `⚠ NCISM ${section} compliance issue: ${gaps} shift${gaps>1?'s':''} unassigned this week.`;
    banner.classList.add('show');
  } else {
    banner.textContent = '';
    banner.classList.remove('show');
  }
}

// ── Week navigation ────────────────────────────────
function updateWeekLabel() {
  const dates = _weekDates();
  document.getElementById('week-label').textContent =
    `${_fmtDate(dates[0])} – ${_fmtDate(dates[6])}`;
}

document.getElementById('btn-prev-week').addEventListener('click', () => {
  _weekStart.setDate(_weekStart.getDate() - 7); updateWeekLabel(); loadRoster();
});
document.getElementById('btn-next-week').addEventListener('click', () => {
  _weekStart.setDate(_weekStart.getDate() + 7); updateWeekLabel(); loadRoster();
});
document.getElementById('btn-today').addEventListener('click', () => {
  _weekStart = _getMonday(new Date()); updateWeekLabel(); loadRoster();
});
document.getElementById('filter-dept').addEventListener('change', loadRoster);
document.getElementById('btn-add-shift').addEventListener('click', () => openModal(null, _dateStr(new Date()), 'morning', null, 1));

// Bulk-confirm every currently-visible unconfirmed shift (respects the week
// range + department filter already applied to _roster by loadRoster()) --
// avoids clicking through each shift's edit modal one at a time just to tick
// "confirmed". Fill All / Generate Next Cycle never set is_confirmed (that's
// a separate "staff has actually acknowledged" signal), so a freshly-filled
// roster starts entirely unconfirmed by design; this is the fast path to
// clear that once the head has actually verified/notified the assignments.
document.getElementById('btn-confirm-all').addEventListener('click', async () => {
  const unconfirmed = _roster.filter(r => !r.is_confirmed);
  if (!unconfirmed.length) { _alert('info', 'Nothing to confirm — every visible shift is already confirmed.'); return; }
  if (!confirm(`Mark all ${unconfirmed.length} unconfirmed shift${unconfirmed.length > 1 ? 's' : ''} in the current view as confirmed?`)) return;

  const btn = document.getElementById('btn-confirm-all');
  btn.disabled = true; btn.textContent = 'Confirming…';

  const { error } = await supabase.from('duty_roster')
    .update({ is_confirmed: true })
    .in('id', unconfirmed.map(r => r.id));

  btn.disabled = false; btn.textContent = '✓ Confirm All Visible';

  if (error) { _alert('error', safeErrorMessage(error, 'Could not confirm shifts.')); return; }
  _alert('success', `${unconfirmed.length} shift${unconfirmed.length > 1 ? 's' : ''} confirmed.`);
  await loadRoster();
});

// Session 141: the shift dropdown is now dynamic per department -- a
// day-only place (OPD/Screening OPD/Panchakarma/Diagnostics) only offers
// "General Duty", everything else keeps the classic 3-shift + on-call set.
// Re-run whenever the modal opens or the department selector inside it changes.
function _refreshShiftOptions(deptId, selectedShift) {
  const dept = _depts.find(d => d.id === deptId);
  const opts = [...(dept ? shiftsForDept(dept) : ['morning', 'afternoon', 'night']), 'on_call'];
  const sel = document.getElementById('m-shift');
  sel.innerHTML = opts.map(s => `<option value="${s}">${_esc(SHIFT_LABELS[s])} (${_esc(SHIFT_TIMES[s])})</option>`).join('');
  sel.value = opts.includes(selectedShift) ? selectedShift : opts[0];
  _refreshStaffLabels(dept);
}

// The same modal/dropdown (role in ['doctor','nurse']) backs both the
// original RMO/EMO/GDMO doctor duty rows and every nursing department added
// since -- "Officer / Doctor" was left over from before nursing departments
// shared this page, confusing for a nurse/ayah shift. Swap the wording when
// the selected department is a nursing-duty place.
function _refreshStaffLabels(dept) {
  const isNursing = dept ? isNursingDutyDept(dept) : false;
  document.getElementById('m-doctor-label').textContent = isNursing ? 'Nurse / Staff' : 'Officer / Doctor';
  document.getElementById('m-confirmed-label').textContent = isNursing
    ? 'Mark as confirmed (staff has acknowledged)'
    : 'Mark as confirmed (doctor has acknowledged)';
}
document.getElementById('m-dept').addEventListener('change', (e) => _refreshShiftOptions(e.target.value, document.getElementById('m-shift').value));

// ── Modal ──────────────────────────────────────────
// Session 139: `slotIndex` is the new concurrent-staff slot this modal writes
// to -- either the specific slot being edited (entryId set) or the next free
// one for a brand-new assignment in an already-occupied cell (multi-nurse
// wards can have several people on the same shift/date).
function openModal(deptId, date, shift, entryId, slotIndex) {
  // Session 137: read-only visitors (plain nurse/ayah, or a nurse_manager who
  // isn't currently the resolved head) can see every cell but not edit it --
  // guarded here so it covers every entry point (grid cells, on-call cells,
  // + Add Shift) in one place, not just the buttons _applyEditGate() hides.
  if (!_canEdit) {
    // Session 140 (Phase 4): a read-only visitor clicking their OWN assigned
    // shift gets a "Request Change" flow instead of the generic block --
    // everyone else's shifts (or an empty/gap cell) stay purely informational,
    // since requesting a change to someone else's shift isn't this nurse's call.
    const ownEntry = entryId ? _roster.find(r => r.id === entryId && r.profile_id === profile.id) : null;
    if (ownEntry) { openRequestChangeModal(ownEntry); return; }
    _alert('info', 'Read-only — only the current Nursing Head can edit this roster.');
    return;
  }
  _editEntry = entryId ? _roster.find(r => r.id === entryId) : null;
  _newSlotIndex = slotIndex || 1;

  document.getElementById('m-dept').value  = deptId || '';
  document.getElementById('m-date').value  = date;
  _refreshShiftOptions(deptId, shift);
  document.getElementById('m-doctor').value = _editEntry?.profile_id || '';
  document.getElementById('m-bed-start').value = _editEntry?.bed_range_start || '';
  document.getElementById('m-bed-end').value = _editEntry?.bed_range_end || '';
  document.getElementById('m-confirmed').checked = _editEntry?.is_confirmed || false;
  document.getElementById('m-notes').value = _editEntry?.notes || '';

  const removeBtn = document.getElementById('btn-remove-shift');
  removeBtn.style.display = _editEntry ? '' : 'none';

  const existingInfo = document.getElementById('m-existing-info');
  if (_editEntry) {
    existingInfo.style.display = '';
    existingInfo.textContent = `Currently assigned: ${_editEntry.profiles?.full_name || '—'} · Editing this slot.`;
  } else {
    existingInfo.style.display = 'none';
  }

  const deptName = _depts.find(d => d.id === deptId)?.name || '';
  document.getElementById('modal-title').textContent = `${_editEntry ? 'Edit' : 'Assign'} Shift — ${deptName ? deptName + ' · ' : ''}${_fmtDate(date)}`;
  document.getElementById('shift-modal').classList.add('show');
}

window.closeModal = function() {
  document.getElementById('shift-modal').classList.remove('show');
  _editEntry = null;
};

window.saveShift = async function() {
  const deptId   = document.getElementById('m-dept').value;
  const date     = document.getElementById('m-date').value;
  const shift    = document.getElementById('m-shift').value;
  const doctorId = document.getElementById('m-doctor').value;
  const bedStart = document.getElementById('m-bed-start').value;
  const bedEnd   = document.getElementById('m-bed-end').value;
  const confirmed= document.getElementById('m-confirmed').checked;
  const notes    = document.getElementById('m-notes').value.trim();

  if (!deptId)   { _alert('error','Select a department.'); return; }
  if (!date)     { _alert('error','Select a date.'); return; }
  if (!doctorId) { _alert('error','Select a doctor / officer.'); return; }

  const btn = document.getElementById('btn-save-shift');
  btn.disabled = true; btn.textContent = 'Saving…';

  const payload = {
    tenant_id: tenantId, department_id: deptId,
    profile_id: doctorId, shift_date: date,
    shift_type: shift, slot_index: _editEntry ? _editEntry.slot_index : _newSlotIndex,
    bed_range_start: bedStart ? Number(bedStart) : null, bed_range_end: bedEnd ? Number(bedEnd) : null,
    is_confirmed: confirmed, notes: notes || null,
  };

  let error;
  if (_editEntry) {
    ({ error } = await supabase.from('duty_roster').update(payload).eq('id', _editEntry.id));
  } else {
    ({ error } = await supabase.from('duty_roster').upsert(payload, { onConflict: 'tenant_id,department_id,shift_date,shift_type,slot_index' }));
  }

  btn.disabled = false; btn.textContent = 'Save Assignment';

  if (error) { _alert('error', safeErrorMessage(error, 'Could not save shift.')); return; }
  closeModal();
  _alert('success', 'Shift assigned.');
  await loadRoster();
};

window.removeShift = async function() {
  if (!_editEntry || !confirm('Remove this shift assignment?')) return;
  const { error } = await supabase.from('duty_roster').delete().eq('id', _editEntry.id);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not remove shift.')); return; }
  closeModal();
  _alert('success', 'Shift removed.');
  await loadRoster();
};

// ── Request Shift Change (Nursing Duty Roster Phase 4, Session 140) ────
// A read-only nurse/ayah viewing their OWN assigned shift can ask for a
// change instead of just seeing a blocked message. Reuses the existing
// staff_leaves approval flow server-side (request_shift_change() RPC) --
// this is deliberately NOT a full edit; only the shift being changed and an
// optional proposed covering colleague are collected.
let _requestChangeEntry = null;

async function openRequestChangeModal(entry) {
  _requestChangeEntry = entry;
  const deptName = _depts.find(d => d.id === entry.department_id)?.name || '';
  document.getElementById('rc-shift-info').textContent =
    `${SHIFT_LABELS[entry.shift_type] || entry.shift_type} · ${_fmtDate(entry.shift_date)}${deptName ? ' · ' + deptName : ''}`;
  document.getElementById('rc-reason').value = '';

  const sel = document.getElementById('rc-covering');
  sel.innerHTML = '<option value="">— No specific colleague, just flag it —</option>';
  // Session 141: tenant-wide, not scoped to this shift's own department --
  // matches the roster template editor's pool (a nurse can cover a shift in
  // a ward she isn't permanently recruited to).
  const { data: pool } = await supabase.from('profiles')
    .select('id,full_name')
    .eq('tenant_id', tenantId).eq('is_active', true)
    .in('designation', ['staff_nurse', 'ward_sister', 'anm'])
    .neq('id', profile.id)
    .order('full_name');
  (pool || []).forEach(p => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.full_name;
    sel.appendChild(o);
  });

  document.getElementById('request-change-modal').classList.add('show');
}

window.closeRequestChangeModal = function() {
  document.getElementById('request-change-modal').classList.remove('show');
  _requestChangeEntry = null;
};

window.submitRequestChange = async function() {
  if (!_requestChangeEntry) return;
  const covering = document.getElementById('rc-covering').value || null;
  const reason = document.getElementById('rc-reason').value.trim();

  const btn = document.getElementById('btn-submit-request-change');
  btn.disabled = true; btn.textContent = 'Submitting…';

  const { error } = await supabase.rpc('request_shift_change', {
    p_duty_roster_id: _requestChangeEntry.id, p_covering_profile_id: covering, p_reason: reason || null,
  });

  btn.disabled = false; btn.textContent = 'Submit Request';

  if (error) { _alert('error', safeErrorMessage(error, 'Could not submit this request.')); return; }
  closeRequestChangeModal();
  _alert('success', 'Change request submitted — the Nursing Head will review it.');
};

// ── Tabs (Session 145, extended Session 147) ────────
window.switchTab = function(tab) {
  document.getElementById('tab-schedule').style.display = tab === 'schedule' ? '' : 'none';
  document.getElementById('tab-leave').style.display = tab === 'leave' ? '' : 'none';
  document.getElementById('tab-monitor').style.display = tab === 'monitor' ? '' : 'none';
  document.getElementById('tab-btn-schedule').classList.toggle('active', tab === 'schedule');
  document.getElementById('tab-btn-leave').classList.toggle('active', tab === 'leave');
  document.getElementById('tab-btn-monitor').classList.toggle('active', tab === 'monitor');
  if (tab === 'leave') { loadLeaveRequests(); loadWeeklyOff(); }
  if (tab === 'monitor') { loadMonitorShifts(); }
};

// ── Leave Requests (Session 145) ────────────────────
// Mirrors nursing-admin.js's loadNursingLeaves()/approveLeave()/
// confirmReject() exactly (same designation scope, same status/columns) so
// the Nursing Head can act on a request without leaving this page --
// nursing-admin.html's own card is untouched and still works the same way.
const NURSING_DESIGNATIONS = ['staff_nurse', 'ward_sister', 'anm'];
const NURSING_LABELS = { staff_nurse: 'Staff Nurse', ward_sister: 'Ward Sister', anm: 'ANM' };
let _rejectingLeaveId = null;

async function loadLeaveRequests() {
  const el = document.getElementById('leave-request-list');
  if (!el) return;
  el.innerHTML = 'Loading…';

  const { data: nursingStaff } = await supabase.from('profiles')
    .select('id').eq('tenant_id', tenantId).in('designation', NURSING_DESIGNATIONS);
  const nursingIds = (nursingStaff || []).map(s => s.id);

  if (!nursingIds.length) {
    el.innerHTML = '<div class="empty">No nursing staff (Staff Nurse / Ward Sister / ANM designation) found yet.</div>';
    return;
  }

  const { data: leaves, error } = await supabase.from('staff_leaves')
    .select('*, profiles!profile_id(full_name, designation)')
    .eq('tenant_id', tenantId).eq('status', 'pending')
    .in('profile_id', nursingIds)
    .order('created_at', { ascending: false });

  if (error) { el.innerHTML = `<div class="empty">${_esc(safeErrorMessage(error, 'Could not load leave requests.'))}</div>`; return; }
  if (!leaves?.length) { el.innerHTML = '<div class="empty">No pending leave requests from nursing staff.</div>'; return; }

  el.innerHTML = leaves.map(l => {
    const days = _leaveDays(l.from_date, l.to_date);
    const desigLabel = NURSING_LABELS[l.profiles?.designation] || l.profiles?.designation || '—';
    return `<div class="leave-card">
      <div class="lc-top">
        <div>
          <div class="lc-name">${_esc(l.profiles?.full_name || '—')} <span style="font-weight:400;color:var(--text-muted)">(${_esc(desigLabel)})</span></div>
          <div class="lc-meta">Applied ${_esc((l.created_at || '').slice(0, 10))}</div>
        </div>
        <span class="leave-badge">${_esc(l.leave_type || 'leave')}</span>
      </div>
      <div class="lc-dates">📅 ${_esc(l.from_date)} → ${_esc(l.to_date)} · ${days} day${days > 1 ? 's' : ''}</div>
      ${l.reason ? `<div class="lc-reason">"${_esc(l.reason)}"</div>` : ''}
      ${_canEdit ? `<div class="lc-actions">
        <button class="btn btn-secondary btn-sm" data-onclick="approveLeaveRequest" data-onclick-a0="${l.id}">✓ Approve</button>
        <button class="btn btn-danger btn-sm" data-onclick="openRejectLeaveModal" data-onclick-a0="${l.id}">✗ Reject</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

function _leaveDays(from, to) {
  if (!from || !to) return 1;
  return Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
}

window.approveLeaveRequest = async function(id) {
  const { error } = await supabase.from('staff_leaves').update({
    status: 'approved', approved_by: profile.id, approved_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not approve. Please try again.')); return; }
  _alert('success', 'Leave approved.');
  await loadLeaveRequests();
};

window.openRejectLeaveModal = function(id) {
  _rejectingLeaveId = id;
  document.getElementById('reject-leave-reason').value = '';
  document.getElementById('reject-leave-modal').classList.add('show');
};
window.closeRejectLeaveModal = function() {
  document.getElementById('reject-leave-modal').classList.remove('show');
  _rejectingLeaveId = null;
};
window.confirmRejectLeave = async function() {
  const reason = document.getElementById('reject-leave-reason').value.trim();
  if (!reason) { _alert('error', 'Please enter a reason for rejection.'); return; }
  const { error } = await supabase.from('staff_leaves').update({
    status: 'rejected', approved_by: profile.id, approved_at: new Date().toISOString(),
    rejection_reason: reason,
  }).eq('id', _rejectingLeaveId);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not reject. Please try again.')); return; }
  closeRejectLeaveModal();
  _alert('success', 'Leave rejected.');
  await loadLeaveRequests();
};

// ── Weekly Off (Session 145) ────────────────────────
// One fixed weekday off per nurse (profiles.weekly_off_day, 0=Sunday..
// 6=Saturday), staggered across the team -- deliberately separate from
// CL/EL leave_quotas (a routine rest day isn't "leave"). Informational/
// tracking only for now -- does not yet stop Fill All/Roll Forward from
// booking a shift on this day (see TODO note in sql/session145_nursing_
// weekly_off.sql).
//
// Session 149: two follow-on asks from Dr. Venkatesh. (1) "Auto-Assign in
// Sequence" seeds every not-yet-set nurse with a day, round-robin, instead
// of the Matron having to click through each one by hand -- an already-set
// nurse is left untouched, so this is safe to click repeatedly as new staff
// join. (2) A "fair share" cap (ceil(total nursing staff / 7), so the 7 days
// can never end up wildly uneven) is enforced two ways: the auto-assign
// sequence skips a day once it's at cap, and the per-nurse dropdown disables
// (not hides -- the Matron still needs to see why) any day already at cap
// for every OTHER nurse. A nurse's own current day is never disabled, so
// switching them away and back always stays possible.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let _nursingStaffOff = [];

async function loadWeeklyOff() {
  const { data } = await supabase.from('profiles')
    .select('id,full_name,weekly_off_day')
    .eq('tenant_id', tenantId).eq('is_active', true)
    .in('designation', NURSING_DESIGNATIONS)
    .order('full_name');
  _nursingStaffOff = data || [];
  renderWeeklyOff();
}

// Max nurses that may share the same weekly off day, spread as evenly as
// possible across all 7 days.
function _weeklyOffCap() {
  const total = _nursingStaffOff.length;
  return total ? Math.max(1, Math.ceil(total / 7)) : 0;
}

function _weeklyOffCounts() {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  _nursingStaffOff.forEach(n => { if (n.weekly_off_day != null) counts[n.weekly_off_day]++; });
  return counts;
}

function renderWeeklyOff() {
  const tbody = document.getElementById('weekly-off-tbody');
  if (!tbody) return;
  if (!_nursingStaffOff.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No nursing staff (Staff Nurse / Ward Sister / ANM designation) found yet.</td></tr>';
    return;
  }
  const dates = _weekDates();
  const cap = _weeklyOffCap();
  const counts = _weeklyOffCounts();
  tbody.innerHTML = _nursingStaffOff.map((n, idx) => {
    const offDate = dates.find(d => new Date(d).getDay() === n.weekly_off_day);
    const thisWeekLabel = (n.weekly_off_day == null) ? '—' : (offDate ? `${_fmtDay(offDate)}, ${_fmtDate(offDate)}` : '—');
    const options = ['<option value="">— Not set —</option>']
      .concat(WEEKDAY_NAMES.map((name, i) => {
        const atCap = counts[i] >= cap && n.weekly_off_day !== i;
        return `<option value="${i}" ${n.weekly_off_day === i ? 'selected' : ''} ${atCap ? 'disabled' : ''}>${name}${atCap ? ' — full' : ''}</option>`;
      }))
      .join('');
    return `<tr>
      <td>${idx + 1}</td>
      <td>${_esc(n.full_name)}</td>
      <td><select class="weekly-off-select" data-profile="${n.id}" ${_canEdit ? '' : 'disabled'} style="border:1.5px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px">${options}</select></td>
      <td>${thisWeekLabel}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.weekly-off-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const val = sel.value === '' ? null : Number(sel.value);
      sel.disabled = true;
      const { error } = await supabase.rpc('set_nurse_weekly_off', { p_profile_id: sel.dataset.profile, p_weekly_off_day: val });
      if (error) { _alert('error', safeErrorMessage(error, 'Could not update weekly off.')); sel.disabled = false; return; }
      _alert('success', 'Weekly off updated.');
      await loadWeeklyOff();
    });
  });
}

// Seeds every nurse who has no weekly off set yet, round-robin across the 7
// days, skipping any day already at its fair-share cap. Nurses who already
// have a day set (whether by a past auto-assign or a manual Matron edit) are
// left untouched -- this is meant to be safe to re-run whenever new staff join.
async function autoAssignWeeklyOff() {
  if (!_canEdit) return;
  const unset = _nursingStaffOff.filter(n => n.weekly_off_day == null);
  if (!unset.length) { _alert('info', 'Every nurse already has a weekly off day set.'); return; }
  if (!confirm(`Auto-assign a weekly off day, spread evenly in sequence, to ${unset.length} nurse${unset.length > 1 ? 's' : ''} who don't have one set yet?`)) return;

  const cap = _weeklyOffCap();
  const counts = _weeklyOffCounts();
  const assignments = [];
  let day = 0;
  for (const n of unset) {
    let tries = 0;
    while (counts[day] >= cap && tries < 7) { day = (day + 1) % 7; tries++; }
    assignments.push({ profile: n.id, day });
    counts[day]++;
    day = (day + 1) % 7;
  }

  const btn = document.getElementById('btn-auto-assign-weekly-off');
  btn.disabled = true; btn.textContent = 'Assigning…';
  for (const a of assignments) {
    const { error } = await supabase.rpc('set_nurse_weekly_off', { p_profile_id: a.profile, p_weekly_off_day: a.day });
    if (error) {
      _alert('error', safeErrorMessage(error, 'Could not auto-assign weekly off.'));
      btn.disabled = false; btn.textContent = '🔀 Auto-Assign in Sequence';
      await loadWeeklyOff();
      return;
    }
  }
  btn.disabled = false; btn.textContent = '🔀 Auto-Assign in Sequence';
  _alert('success', `Weekly off assigned for ${assignments.length} nurse${assignments.length > 1 ? 's' : ''}.`);
  await loadWeeklyOff();
}
document.getElementById('btn-auto-assign-weekly-off')?.addEventListener('click', autoAssignWeeklyOff);

// ── On-Ground Duty Monitor (Session 147) ────────────
// Read-only shift visibility + attendance marking (present/absent) --
// deliberately NOT scheduling/editing, which stays exclusively with the
// resolved Nursing Head (Weekly Schedule tab above, unchanged). Visibility
// is scoped to whichever nursing-duty departments this viewer supervises:
// all of them for super_admin/dept_admin/the resolved Nursing Head, or just
// their own assigned zone for a deputy_nursing_superintendent
// (nursing_zone_assignments, Session 147). Hidden entirely for a plain
// nurse/ayah -- same privacy-tier convention as the Leave & Weekly Off tab.
let _monitorDeptIds = [];
let _canSeeMonitorTab = false;
let _monitorDate = _dateStr(new Date());
let _monitorShifts = [];

async function loadMonitorScope() {
  if (role === 'super_admin' || role === 'dept_admin') {
    _monitorDeptIds = _depts.filter(isNursingDutyDept).map(d => d.id);
    _canSeeMonitorTab = true;
  } else if (role === 'nurse_manager') {
    if (_canEdit) {
      // The resolved Nursing Head (Matron or her acting delegate) sees every
      // nursing-duty department, same as her scheduling authority already does.
      _monitorDeptIds = _depts.filter(isNursingDutyDept).map(d => d.id);
      _canSeeMonitorTab = true;
    } else {
      const { data } = await supabase.from('nursing_zone_assignments')
        .select('department_id').eq('tenant_id', tenantId).eq('profile_id', profile.id);
      _monitorDeptIds = (data || []).map(r => r.department_id);
      _canSeeMonitorTab = _monitorDeptIds.length > 0;
    }
  } else {
    _monitorDeptIds = [];
    _canSeeMonitorTab = false;
  }
  document.getElementById('tab-btn-monitor').style.display = _canSeeMonitorTab ? '' : 'none';
}

function _updateMonitorDateLabel() {
  document.getElementById('monitor-date-label').textContent =
    `${_fmtDay(_monitorDate)}, ${_fmtDate(_monitorDate)}`;
}

async function loadMonitorShifts() {
  _updateMonitorDateLabel();
  if (!_monitorDeptIds.length) { _monitorShifts = []; renderMonitor(); return; }
  const { data } = await supabase.from('duty_roster')
    .select(`id,department_id,shift_type,attendance_status,attendance_marked_at,
      profiles!duty_roster_profile_id_fkey(full_name),
      marker:profiles!duty_roster_attendance_marked_by_fkey(full_name)`)
    .eq('tenant_id', tenantId).eq('shift_date', _monitorDate)
    .in('department_id', _monitorDeptIds);
  _monitorShifts = data || [];
  renderMonitor();
}

function renderMonitor() {
  const el = document.getElementById('monitor-list');
  if (!_canSeeMonitorTab) { el.innerHTML = '<div class="empty">No supervision zone assigned yet -- ask the Matron to assign one via Nursing Administration → Nursing Supervision Zones.</div>'; return; }
  if (!_monitorShifts.length) { el.innerHTML = '<div class="empty">No shifts scheduled for this date in your supervised department(s).</div>'; return; }

  const byDept = {};
  _monitorShifts.forEach(s => { (byDept[s.department_id] = byDept[s.department_id] || []).push(s); });

  let html = '';
  Object.entries(byDept).forEach(([deptId, shifts]) => {
    const deptName = _depts.find(d => d.id === deptId)?.name || '—';
    html += `<div class="monitor-dept-header">${_esc(deptName)}</div>`;
    html += shifts.map(s => {
      const name = s.profiles?.full_name || '—';
      const shiftLabel = SHIFT_LABELS[s.shift_type] || s.shift_type;
      const actionsHtml = s.attendance_status
        ? `<span class="attendance-mark ${s.attendance_status}">${s.attendance_status === 'present' ? '✓ Present' : '✗ Absent'}</span>
           <button class="btn btn-secondary btn-sm" data-onclick="markAttendance" data-onclick-a0="${s.id}" data-onclick-a1="@null">Undo</button>`
        : `<button class="btn btn-present btn-sm" data-onclick="markAttendance" data-onclick-a0="${s.id}" data-onclick-a1="present">✓ Present</button>
           <button class="btn btn-absent btn-sm" data-onclick="markAttendance" data-onclick-a0="${s.id}" data-onclick-a1="absent">✗ Absent</button>`;
      const metaHtml = s.attendance_status
        ? `${_esc(shiftLabel)} · marked by ${_esc(s.marker?.full_name || '—')} ${_esc(s.attendance_marked_at ? new Date(s.attendance_marked_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')}`
        : _esc(shiftLabel);
      return `<div class="monitor-row">
        <div><div class="monitor-name">${_esc(name)}</div><div class="monitor-meta">${metaHtml}</div></div>
        <div class="attendance-actions">${actionsHtml}</div>
      </div>`;
    }).join('');
  });
  el.innerHTML = html;
}

window.markAttendance = async function(dutyRosterId, status) {
  const { error } = await supabase.rpc('mark_duty_attendance', { p_duty_roster_id: dutyRosterId, p_status: status });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not mark attendance.')); return; }
  await loadMonitorShifts();
};

document.getElementById('btn-monitor-prev').addEventListener('click', () => {
  const d = new Date(_monitorDate); d.setDate(d.getDate() - 1); _monitorDate = _dateStr(d); loadMonitorShifts();
});
document.getElementById('btn-monitor-next').addEventListener('click', () => {
  const d = new Date(_monitorDate); d.setDate(d.getDate() + 1); _monitorDate = _dateStr(d); loadMonitorShifts();
});
document.getElementById('btn-monitor-today').addEventListener('click', () => {
  _monitorDate = _dateStr(new Date()); loadMonitorShifts();
});

// ── Alert ──────────────────────────────────────────
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = `alert ${type} show`;
  setTimeout(() => el.className = 'alert', 4000);
}

// ── Boot ───────────────────────────────────────────
updateWeekLabel();
_applyEditGate(); // correct immediately for super_admin/dept_admin/plain nurse; loadHeadGate() may still flip it for nurse_manager
await Promise.all([loadDepartments(), loadDoctors(), loadHeadGate()]);
await loadMonitorScope(); // needs _canEdit (loadHeadGate) + _depts (loadDepartments) already resolved
await loadRoster();
