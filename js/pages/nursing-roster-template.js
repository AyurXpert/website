import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNursingDutyDept, shiftsForDept, shiftsOverlap, shiftTimes, shiftNames } from '../config/ncism.js';
import { resolveNursingHeadship, canActAsNursingHead } from '../modules/roster/nursingHeadship.js';
import { computeRequiredPerShift, distributeAcrossShifts } from '../modules/roster/requiredStaffing.js';
import { checkCycleExpiry } from '../modules/roster/cycleExpiry.js';

// Session 139 (Nursing Duty Roster Phase 3): template editor for the
// "Template-Based Rolling Schedule" -- a repeating base pattern per
// department, sized to the tenant's approved cycle length
// (nursing_roster_settings.cycle, Phase 2). Edit gating mirrors roster.js
// exactly: super_admin/dept_admin always can; nurse_manager only if
// currently the resolved Nursing Head.
//
// Session 141: shift columns are now per-department (shiftsForDept()) --
// 'general' (single 9am-5pm shift) for OPD/Screening OPD/Panchakarma/
// Diagnostics, the classic 3-shift ward pattern for Medical/Surgical
// In-Patients/OT/Labour Room. The nurse pool is tenant-wide (any active
// Staff Nurse/Ward Sister/ANM, not scoped to the department's own
// recruitment) -- real posting/rotation puts nurses on duty in wards they
// aren't permanently assigned to. Medical/Surgical In-Patients also show a
// bed-derived (1 per 10 beds) suggested nurse count per shift.
await requireAuth(['super_admin', 'dept_admin', 'nurse_manager']);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const role     = getCurrentRole();

// Session 166: these are the equal_8x3 DEFAULTS -- loadShiftPatternCard() (part of the boot
// sequence, before any department's grid can be selected/rendered) overwrites all 4 keys in
// place with the tenant's actual chosen pattern's names+times.
const SHIFT_LABELS = { morning: 'Morning (06:00–14:00)', afternoon: 'Afternoon (14:00–22:00)', night: 'Night (22:00–06:00)', general: 'General Duty (09:00–17:00)' };
const SHIFT_PATTERN_LABELS = { equal_8x3: 'Equal Thirds (8+8+8)', six_six_twelve: 'Day-Weighted (6+6+12)' };
const CYCLE_DAYS = { weekly: 7, fortnightly: 14, monthly: 30 };

let _canEdit = role === 'super_admin' || role === 'dept_admin';
let _depts = [];
let _selectedDept = null;
let _selectedDeptShifts = ['morning', 'afternoon', 'night'];
let _requiredPerShift = null; // bed-derived suggestion, Medical/Surgical In-Patients only
let _template = null;   // { id, cycle_length } or null
let _slots = [];        // template slots, with .profiles.full_name joined
let _pool = [];         // nursing staff assignable (tenant-wide)
let _cycleLength = 7;   // current dept's template length, set in loadTemplateForDept
let _busyElsewhere = new Set(); // profile_ids already posted to an overlapping shift in ANOTHER department
let _expiry = []; // per-department { deptId, lastDate, status }, from checkCycleExpiry() -- also drives the suggested start date below
let _tenantCycleKey = 'weekly'; // nursing_roster_settings.cycle, refreshed by loadRosterCycle() -- used for the bulk action's "To" date

// Local Y-M-D, not UTC -- avoids the roster.js bug (fixed Session 149) where
// .toISOString() on a local date silently rolls back a day for any positive-
// UTC-offset timezone (e.g. India, UTC+5:30).
function _localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Real question from Dr. Venkatesh testing SDM: the start-date field was
// defaulting to today even though a cycle was already generated through
// 3 Aug -- nothing stopped him from accidentally overwriting still-active
// days. Default to the day AFTER whatever's already generated instead, so
// the field is correct out of the box; only fall back to today if this
// department has never had a roster generated at all.
function _suggestedStartDate(deptId) {
  const rec = _expiry.find(r => r.deptId === deptId);
  if (rec?.lastDate) {
    const d = new Date(rec.lastDate);
    d.setDate(d.getDate() + 1);
    return _localDateStr(d);
  }
  return _localDateStr(new Date());
}

// Bulk action shares one start date across every department -- default to
// the day after the LATEST last-generated date among them, so no
// department's still-active days get silently overwritten (a department
// whose own cycle ended earlier just gets a small, visible gap instead,
// same "honest gap" convention used everywhere else in this feature).
function _suggestedBulkStartDate() {
  const dated = _expiry.filter(r => r.lastDate);
  if (!dated.length) return _localDateStr(new Date());
  const latest = dated.reduce((max, r) => (new Date(r.lastDate) > new Date(max.lastDate) ? r : max));
  const d = new Date(latest.lastDate);
  d.setDate(d.getDate() + 1);
  return _localDateStr(d);
}

// It's a fixed-length cycle (weekly/fortnightly/monthly, set via the Roster
// Cycle card below), so once a "From" date is picked the end date isn't a
// separate decision -- just show it, so the head can see the real range
// before generating instead of only ever seeing a single start date.
function _updateCycleEndDisplay(fromInputId, toSpanId, days) {
  const fromVal = document.getElementById(fromInputId)?.value;
  const toEl = document.getElementById(toSpanId);
  if (!toEl) return;
  if (!fromVal) { toEl.textContent = '—'; return; }
  const d = new Date(fromVal);
  d.setDate(d.getDate() + (days - 1));
  toEl.textContent = _localDateStr(d);
}

async function loadDepartments() {
  const { data } = await supabase.from('departments')
    .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true).order('name');
  _depts = (data || []).filter(isNursingDutyDept);

  const sel = document.getElementById('filter-dept');
  _depts.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
    sel.appendChild(o);
  });
}

// Suggested per-shift nurse count -- computeRequiredPerShift() (shared with
// nursing-admin.js's rotation preview, Session 144, so both pages can never
// disagree on a department's required headcount) handles the two special
// sources: Medical/Surgical In-Patients (bed-derived, 1 per 10 beds) and OPD
// (flat UG-intake-tier headcount split into 3 coverage zones, Session 142).
// Every other nursing-duty department returns null, meaning "1 per shift" is
// this page's own default (see _addSlotRowsHtml/_buildFillGroups).
async function _loadRequiredPerShift(deptName) {
  _requiredPerShift = await computeRequiredPerShift(supabase, tenantId, deptName);
}

// Real bug found on SDM (Dr. Venkatesh): Fill All only ever looked at the
// CURRENT department's own template -- since it's called once per
// department with no cross-department awareness, the same nurse (usually
// whoever sorts first alphabetically) kept landing as the fixed team member
// in several departments at once. General Duty (09:00-17:00) physically
// overlaps both Morning (06:00-14:00) and Afternoon (14:00-22:00), so a
// nurse fixed to Labour Room's Morning shift would also show up in OPD's/
// Diagnostics'/Panchakarma's/Screening OPD's General Duty shift, every
// single day, once each department was filled independently. Computes which
// pool members already hold an overlapping-time slot in any OTHER
// department's CURRENT template -- used to grey them out of the manual add
// dropdown and exclude them from Fill All's pool for this department.
async function _loadBusyElsewhere(deptShifts) {
  _busyElsewhere = new Set();
  if (!_selectedDept) return;

  const { data: otherTemplates } = await supabase.from('nursing_roster_templates')
    .select('id').eq('tenant_id', tenantId).neq('department_id', _selectedDept);
  const otherIds = (otherTemplates || []).map(t => t.id);
  if (!otherIds.length) return;

  const { data: otherSlots } = await supabase.from('nursing_roster_template_slots')
    .select('profile_id,shift_type').in('template_id', otherIds);
  (otherSlots || []).forEach(s => {
    if (s.profile_id && deptShifts.some(myShift => shiftsOverlap(myShift, s.shift_type))) {
      _busyElsewhere.add(s.profile_id);
    }
  });
}

async function loadEditGate() {
  if (role !== 'nurse_manager') return; // super_admin/dept_admin already true
  const headship = await resolveNursingHeadship(supabase, tenantId);
  _canEdit = canActAsNursingHead(headship, profile.id, role, profile.designation);
}

// ── Roster Cycle (Session 149: moved here from nursing-admin.html, per
// Dr. Venkatesh -- this is where the cycle length actually matters, right
// next to the "From"/"To" dates it determines, rather than a separate admin
// page). Same maker-checker flow as before: Nursing Head proposes weekly/
// fortnightly/monthly, MS/Deputy MS (or super_admin) approves via
// pending_approvals. The RPC re-derives "is this caller really the current
// head" server-side -- canAct below is only a display hint.
const CYCLE_LABELS = { weekly: 'Weekly (7 days)', fortnightly: 'Fortnightly (14 days)', monthly: 'Monthly (30 days)' };

async function loadRosterCycle() {
  const body = document.getElementById('cycle-body');
  const headship = await resolveNursingHeadship(supabase, tenantId);
  const canAct = canActAsNursingHead(headship, profile.id, role, profile.designation);

  const [{ data: setting }, { data: pending }, { data: templates }] = await Promise.all([
    supabase.from('nursing_roster_settings').select('cycle').eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('pending_approvals')
      .select('id,payload,requested_at,requester:profiles!requested_by(full_name)')
      .eq('tenant_id', tenantId).eq('action_type', 'nursing_roster_cycle').eq('status', 'pending')
      .order('requested_at', { ascending: false }).limit(1),
    // A department's template cycle_length is locked in the moment it's
    // FIRST built, from whatever the tenant cycle was at that time.
    supabase.from('nursing_roster_templates').select('department_id,cycle_length').eq('tenant_id', tenantId),
  ]);

  _tenantCycleKey = setting?.cycle || 'weekly';
  const pendingReq = pending?.[0] || null;
  const tenantDays = CYCLE_DAYS[_tenantCycleKey] || 7;

  const deptNameById = new Map(_depts.map(d => [d.id, d.name]));
  const mismatched = (templates || [])
    .filter(t => deptNameById.has(t.department_id) && t.cycle_length !== tenantDays)
    .map(t => ({ name: deptNameById.get(t.department_id), length: t.cycle_length }));

  let html = `<div style="margin-bottom:10px"><span style="font-size:12.5px;color:var(--text-muted)">Current cycle:</span> `
    + `<span class="badge" style="background:var(--green-light);color:var(--green-deep);font-weight:600">${_esc(CYCLE_LABELS[_tenantCycleKey] || _tenantCycleKey)}</span></div>`;

  if (mismatched.length) {
    // Session 149: a hospital roster can't change structural length
    // mid-cycle -- resetting these the moment a change is approved would
    // touch live bed-slot allocations and attendance still in effect. This
    // is informational only, not something the head needs to act on: each
    // department below queues the new length automatically, the next time
    // its OWN Generate Next Cycle runs (once its current cycle has actually
    // finished) -- roll_nursing_roster_template() adopts it right then.
    html += `<div class="empty" style="color:#7a5a10;background:var(--gold-light);border:1.5px solid var(--gold);border-radius:8px;padding:8px 10px;margin-bottom:10px">`
      + `ℹ️ ${mismatched.length} department${mismatched.length === 1 ? '' : 's'} still on an older cycle length, queued to switch to ${tenantDays} days automatically at their next Generate Next Cycle: `
      + mismatched.map(m => `<strong>${_esc(m.name)}</strong> (currently ${m.length}-day)`).join(', ')
      + `. No action needed.</div>`;
  }

  if (pendingReq) {
    const reqCycle = pendingReq.payload?.cycle;
    html += `<div class="empty">⏳ Change to <strong>${_esc(CYCLE_LABELS[reqCycle] || reqCycle)}</strong> requested by ${_esc(pendingReq.requester?.full_name || '—')} on ${_esc((pendingReq.requested_at || '').slice(0, 10))} -- awaiting Medical Superintendent / Deputy MS approval.</div>`;
  } else if (canAct) {
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<select id="cycle-select" style="height:32px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12.5px">'
      + Object.entries(CYCLE_LABELS).map(([v, l]) => `<option value="${v}" ${v === _tenantCycleKey ? 'selected' : ''}>${_esc(l)}</option>`).join('')
      + '</select>'
      + '<button class="btn btn-primary btn-sm" data-onclick="requestRosterCycleChange">Request Change</button>'
      + '</div>';
  } else {
    html += '<div class="empty">Only the current Nursing Head can request a cycle change.</div>';
  }

  body.innerHTML = html;

  // Cycle length only ever changes AFTER MS/Deputy MS approval (not on
  // request), so this just keeps the bulk "To" date in sync with whatever's
  // actually active right now.
  _updateCycleEndDisplay('bulk-roll-start-date', 'bulk-roll-end-date', CYCLE_DAYS[_tenantCycleKey] || 7);
}

window.requestRosterCycleChange = async function() {
  const sel = document.getElementById('cycle-select');
  const cycle = sel?.value;
  if (!cycle) return;
  const { error } = await supabase.rpc('request_nursing_roster_cycle', { p_cycle: cycle });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not submit the roster-cycle change request.')); return; }
  await loadRosterCycle();
};

// ── Shift Pattern (Session 166) -- same maker-checker card as Roster Cycle above, just a
// different tenant-wide setting: how the round-the-clock nursing shifts split across 24 hours.
// General Duty (09:00-17:00) is unaffected by this either way, so it's never mentioned as a
// choice here, only as a fixed reference point in the summary line.
function _applyShiftPatternLabels(pattern) {
  const names = shiftNames(pattern), times = shiftTimes(pattern);
  SHIFT_LABELS.morning   = `${names.morning} (${times.morning})`;
  SHIFT_LABELS.afternoon = `${names.afternoon} (${times.afternoon})`;
  SHIFT_LABELS.night     = `${names.night} (${times.night})`;
  SHIFT_LABELS.general   = `${names.general} (${times.general})`;
}

async function loadShiftPatternCard() {
  const body = document.getElementById('shift-pattern-body');
  const headship = await resolveNursingHeadship(supabase, tenantId);
  const canAct = canActAsNursingHead(headship, profile.id, role, profile.designation);

  const [{ data: setting }, { data: pending }] = await Promise.all([
    supabase.from('nursing_roster_settings').select('shift_pattern').eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('pending_approvals')
      .select('id,payload,requested_at,requester:profiles!requested_by(full_name)')
      .eq('tenant_id', tenantId).eq('action_type', 'nursing_shift_pattern').eq('status', 'pending')
      .order('requested_at', { ascending: false }).limit(1),
  ]);

  const pattern = setting?.shift_pattern || 'equal_8x3';
  _applyShiftPatternLabels(pattern); // must run before any department grid renders
  const pendingReq = pending?.[0] || null;
  const names = shiftNames(pattern), times = shiftTimes(pattern);

  let html = `<div style="margin-bottom:10px"><span style="font-size:12.5px;color:var(--text-muted)">Current pattern:</span> `
    + `<span class="badge" style="background:var(--green-light);color:var(--green-deep);font-weight:600">${_esc(SHIFT_PATTERN_LABELS[pattern] || pattern)}</span>`
    + `<div style="margin-top:4px;font-size:11.5px;color:var(--text-muted)">${_esc(names.morning)} ${_esc(times.morning)} · ${_esc(names.afternoon)} ${_esc(times.afternoon)} · ${_esc(names.night)} ${_esc(times.night)} · General Duty ${_esc(times.general)} (always fixed)</div></div>`;

  if (pendingReq) {
    const reqPattern = pendingReq.payload?.pattern;
    html += `<div class="empty">⏳ Change to <strong>${_esc(SHIFT_PATTERN_LABELS[reqPattern] || reqPattern)}</strong> requested by ${_esc(pendingReq.requester?.full_name || '—')} on ${_esc((pendingReq.requested_at || '').slice(0, 10))} -- awaiting Medical Superintendent / Deputy MS approval.</div>`;
  } else if (canAct) {
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<select id="shift-pattern-select" style="height:32px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12.5px">'
      + Object.entries(SHIFT_PATTERN_LABELS).map(([v, l]) => `<option value="${v}" ${v === pattern ? 'selected' : ''}>${_esc(l)}</option>`).join('')
      + '</select>'
      + '<button class="btn btn-primary btn-sm" data-onclick="requestShiftPatternChange">Request Change</button>'
      + '</div>'
      + '<div style="margin-top:6px;font-size:11px;color:var(--text-muted)">Applies tenant-wide, to every round-the-clock nursing ward. General Duty is never affected.</div>';
  } else {
    html += '<div class="empty">Only the current Nursing Head can request a shift-pattern change.</div>';
  }

  body.innerHTML = html;

  // If a department's already selected (e.g. this ran again after a change request was
  // submitted mid-session), refresh its grid headers so an already-open grid doesn't keep
  // showing stale shift-time labels.
  if (_selectedDept) renderGrid(_cycleLength);
}

window.requestShiftPatternChange = async function() {
  const sel = document.getElementById('shift-pattern-select');
  const pattern = sel?.value;
  if (!pattern) return;
  const { error } = await supabase.rpc('request_nursing_shift_pattern', { p_pattern: pattern });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not submit the shift-pattern change request.')); return; }
  await loadShiftPatternCard();
};

document.getElementById('filter-dept').addEventListener('change', async (e) => {
  _selectedDept = e.target.value || null;
  if (!_selectedDept) {
    document.getElementById('tpl-table').style.display = 'none';
    document.getElementById('tpl-empty').style.display = '';
    document.getElementById('roll-card').style.display = 'none';
    return;
  }
  await loadTemplateForDept();
});

async function loadTemplateForDept() {
  document.getElementById('tpl-readonly-note').style.display = _canEdit ? 'none' : '';

  const deptObj = _depts.find(d => d.id === _selectedDept);
  _selectedDeptShifts = shiftsForDept(deptObj);

  const [{ data: templateRow }, { data: poolRows }] = await Promise.all([
    supabase.from('nursing_roster_templates').select('id,cycle_length,notes').eq('tenant_id', tenantId).eq('department_id', _selectedDept).maybeSingle(),
    // Session 141: tenant-wide pool, not scoped to this department's own
    // recruitment -- a nurse gets POSTED to duty here, not necessarily
    // permanently assigned here.
    supabase.from('profiles').select('id,full_name,weekly_off_day').eq('tenant_id', tenantId)
      .in('designation', ['staff_nurse', 'ward_sister', 'anm']).eq('is_active', true).order('full_name'),
    _loadRequiredPerShift(deptObj?.name),
    _loadBusyElsewhere(_selectedDeptShifts),
  ]);

  _pool = poolRows || [];
  _template = templateRow || null;

  // _tenantCycleKey comes from loadRosterCycle() (always run before a
  // department can be selected) -- one source of truth instead of a second,
  // independently-timed nursing_roster_settings fetch here.
  const tenantCycleDays = CYCLE_DAYS[_tenantCycleKey] || 7;
  const cycleLength = _template?.cycle_length || tenantCycleDays;
  _cycleLength = cycleLength;
  const cycleMismatch = !!(_template && _template.cycle_length !== tenantCycleDays);

  let requiredNote = '';
  if (_requiredPerShift?.mode === 'bed') {
    const byShift = distributeAcrossShifts(_requiredPerShift.total, _selectedDeptShifts);
    const perShiftDesc = _selectedDeptShifts.map(s => `${SHIFT_LABELS[s]}: ${byShift[s]}`).join(', ');
    requiredNote = ` · ${_requiredPerShift.bedCount} beds → ${_requiredPerShift.total} nurse${_requiredPerShift.total === 1 ? '' : 's'} required total (combined Medical+Surgical IPD ratio, Sch XX/27), spread across shifts as ${perShiftDesc}`;
  } else if (_requiredPerShift?.mode === 'opd') {
    requiredNote = ` · ${_requiredPerShift.total} nurses required (Sch XX/18, pooled across all OPDs), split into ${_requiredPerShift.groups.length} coverage zones`;
  } else if (_requiredPerShift?.mode === 'ot') {
    const byShift = distributeAcrossShifts(_requiredPerShift.total, _selectedDeptShifts);
    const perShiftDesc = _selectedDeptShifts.map(s => `${SHIFT_LABELS[s]}: ${byShift[s]}`).join(', ');
    requiredNote = ` · ${_requiredPerShift.total} nurse${_requiredPerShift.total === 1 ? '' : 's'} required total (Sch XX/35), spread across shifts as ${perShiftDesc}`;
  } else if (_requiredPerShift?.mode === 'atyayika') {
    const byShift = distributeAcrossShifts(_requiredPerShift.total, _selectedDeptShifts);
    const perShiftDesc = _selectedDeptShifts.map(s => `${SHIFT_LABELS[s]}: ${byShift[s]}`).join(', ');
    requiredNote = ` · ${_requiredPerShift.total} nurse${_requiredPerShift.total === 1 ? '' : 's'} required total (Sch XX/18), spread across shifts as ${perShiftDesc}`;
  }
  document.getElementById('tpl-sub').innerHTML = ((_template
    ? `${cycleLength}-day template (locked in when first built)`
      + (cycleMismatch ? ` <strong style="color:#7a5a10">ℹ️ tenant cycle is now ${_esc(CYCLE_LABELS[_tenantCycleKey] || _tenantCycleKey)} (${tenantCycleDays} days) — this department will switch automatically at its next Generate Next Cycle, no action needed</strong>` : '')
    : `No template yet -- will be built as a ${tenantCycleDays}-day pattern (current tenant cycle: ${_esc(CYCLE_LABELS[_tenantCycleKey] || _tenantCycleKey)})`) + requiredNote);

  if (_template) {
    const { data: slotRows } = await supabase.from('nursing_roster_template_slots')
      .select('id,day_offset,shift_type,slot_index,profile_id,bed_range_start,bed_range_end,coverage_label,profiles(full_name)')
      .eq('template_id', _template.id);
    _slots = slotRows || [];
  } else {
    _slots = [];
  }

  document.getElementById('tpl-empty').style.display = 'none';
  document.getElementById('tpl-table').style.display = '';
  document.getElementById('roll-card').style.display = _template ? '' : 'none';
  document.getElementById('fill-all-bar').style.display = (_canEdit && _pool.length) ? '' : 'none';
  renderGrid(cycleLength);
  _renderDeptNote();
}

// Session 149: department-level note explaining a deliberately-empty
// template (nursing post retained for NCISM compliance, real coverage from
// other staff, nurse redeployed to Relief Pool). Visible to every viewer;
// only _canEdit can change it.
function _renderDeptNote() {
  const display = document.getElementById('dept-note-display');
  const editBox = document.getElementById('dept-note-edit');
  const editBtn = document.getElementById('btn-edit-dept-note');
  editBox.style.display = 'none';
  if (!_template) { display.style.display = 'none'; return; }
  if (_template.notes) {
    document.getElementById('dept-note-text').textContent = _template.notes;
    display.style.display = '';
    editBtn.style.display = _canEdit ? '' : 'none';
    editBtn.textContent = 'Edit';
  } else if (_canEdit) {
    // No note yet -- still show the box so the head has a way to add one.
    document.getElementById('dept-note-text').textContent = '— none —';
    display.style.display = '';
    editBtn.style.display = '';
    editBtn.textContent = '+ Add Note';
  } else {
    display.style.display = 'none';
  }
}

document.getElementById('btn-edit-dept-note').addEventListener('click', () => {
  document.getElementById('dept-note-input').value = _template?.notes || '';
  document.getElementById('dept-note-edit').style.display = '';
  document.getElementById('dept-note-display').style.display = 'none';
});
document.getElementById('btn-cancel-dept-note').addEventListener('click', () => {
  document.getElementById('dept-note-edit').style.display = 'none';
  _renderDeptNote();
});
document.getElementById('btn-save-dept-note').addEventListener('click', async () => {
  const note = document.getElementById('dept-note-input').value.trim();
  const { error } = await supabase.rpc('set_department_roster_note', { p_department_id: _selectedDept, p_note: note || null });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save this note.')); return; }
  _alert('success', 'Note saved.');
  await loadTemplateForDept();
});

function _poolOptionsHtml(excludeIds) {
  return _pool.filter(p => !excludeIds.includes(p.id))
    .map(p => _busyElsewhere.has(p.id)
      ? `<option value="" disabled>${_esc(p.full_name)} — busy elsewhere (overlapping shift)</option>`
      : `<option value="${_esc(p.id)}">${_esc(p.full_name)}</option>`)
    .join('');
}

// One "+ Add" row per still-needed slot -- for a bed-linked department or
// OPD (Session 142) this shows exactly how many more nurses are needed
// (each pre-labelled with the 10-bed block, or OPD coverage zone, it would
// cover), not just a single generic add affordance. Beyond the suggested
// minimum (or for places with no suggestion at all), a single plain
// "+ Add" row still lets the head add extra staff freely.
function _addSlotRowsHtml(day, shift, cellSlots, isGeneral) {
  if (!_canEdit) return '';
  const assignedIds = cellSlots.map(s => s.profile_id);
  const options = _poolOptionsHtml(assignedIds);
  if (!options) return _pool.length ? '' : '<div class="slot-beds">No nursing staff recruited in this hospital yet.</div>';

  const filled = cellSlots.length;
  const mode = _requiredPerShift?.mode;
  const perShiftByType = _requiredPerShift ? distributeAcrossShifts(_requiredPerShift.total, _selectedDeptShifts) : {};
  const suggestedTotal = _requiredPerShift ? (perShiftByType[shift] ?? 0) : 0;
  const neededMore = Math.max(0, suggestedTotal - filled);
  let html = '';

  const addRow = (slotIndex, bedStart, bedEnd, coverageLabel, label) => `<div class="add-slot-row">
    <select id="add-nurse-${day}-${shift}-${slotIndex}"><option value="">${_esc(label)}</option>${options}</select>
    ${isGeneral ? '' : `<input type="number" id="add-bed-start-${day}-${shift}-${slotIndex}" placeholder="Bed#" value="${bedStart ?? ''}"/>
    <input type="number" id="add-bed-end-${day}-${shift}-${slotIndex}" placeholder="to" value="${bedEnd ?? ''}"/>`}
    <input type="hidden" id="add-coverage-${day}-${shift}-${slotIndex}" value="${_esc(coverageLabel || '')}"/>
    <button class="btn btn-sm btn-secondary" data-onclick="addSlot" data-onclick-a0="${day}" data-onclick-a1="${shift}" data-onclick-a2="${slotIndex}">Add</button>
  </div>`;

  if (neededMore > 0) {
    for (let i = 0; i < neededMore; i++) {
      const slotIndex = filled + i + 1;
      if (mode === 'opd') {
        const zone = _requiredPerShift.groups[slotIndex - 1] || null;
        html += zone
          ? addRow(slotIndex, null, null, zone, `+ Add nurse (covers: ${zone}) — required`)
          : addRow(slotIndex, null, null, null, '+ Add nurse — required');
      } else if (mode === 'bed') {
        // Beds are split evenly across THIS SHIFT's own slot count -- not a
        // fixed 10-per-slot block, since that only made sense back when
        // every slot in every shift shared one department-wide total (the
        // now-fixed x3 bug). 6 total nurses for 60 beds, 2 per shift, means
        // each of those 2 covers 30 beds during their shift, not 10.
        const blockSize = Math.ceil(_requiredPerShift.bedCount / suggestedTotal);
        const bedStart = (slotIndex - 1) * blockSize + 1;
        const bedEnd = Math.min(slotIndex * blockSize, _requiredPerShift.bedCount);
        html += addRow(slotIndex, bedStart, bedEnd, null, `+ Add nurse (${bedStart}–${bedEnd}) — required`);
      } else {
        html += addRow(slotIndex, null, null, null, '+ Add nurse — required');
      }
    }
  } else {
    const nextSlotIndex = filled ? Math.max(...cellSlots.map(s => s.slot_index)) + 1 : 1;
    html += addRow(nextSlotIndex, null, null, null, '+ Add nurse…');
  }
  return html;
}

function renderGrid(cycleLength) {
  // Session 143: OPD's 3 required nurses each cover a fixed, named zone
  // (Session 142) -- Dr. Venkatesh found the original layout (all 3 stacked
  // inside one "General Duty" cell per day) confusing, with no visible
  // header saying who's posted where. Give OPD its own column-per-zone
  // layout instead of the generic shift-column grid every other place uses.
  if (_requiredPerShift?.mode === 'opd') { renderOpdGroupedGrid(cycleLength); return; }

  const isGeneral = _selectedDeptShifts[0] === 'general';

  const thead = document.getElementById('tpl-thead');
  thead.innerHTML = `<tr><th class="day-col">Day</th>${_selectedDeptShifts.map(s => `<th>${_esc(SHIFT_LABELS[s])}</th>`).join('')}</tr>`;

  const tbody = document.getElementById('tpl-tbody');
  let html = '';
  for (let day = 0; day < cycleLength; day++) {
    html += `<tr><td class="day-col">Day ${day + 1}</td>`;
    _selectedDeptShifts.forEach(shift => {
      const cellSlots = _slots.filter(s => s.day_offset === day && s.shift_type === shift)
        .sort((a, b) => a.slot_index - b.slot_index);
      html += `<td class="shift-cell">`;
      cellSlots.forEach(s => {
        const beds = (!isGeneral && s.bed_range_start && s.bed_range_end) ? ` <span class="slot-beds">(Beds ${s.bed_range_start}–${s.bed_range_end})</span>` : '';
        const coverage = s.coverage_label ? ` <span class="slot-beds">(covers: ${_esc(s.coverage_label)})</span>` : '';
        html += `<div class="slot-row">
          <span><span class="slot-name">${_esc(s.profiles?.full_name || '—')}</span>${beds}${coverage}</span>
          ${_canEdit ? `<button class="slot-remove" data-onclick="removeSlot" data-onclick-a0="${_esc(s.id)}">✕</button>` : ''}
        </div>`;
      });
      html += _addSlotRowsHtml(day, shift, cellSlots, isGeneral);
      html += `</td>`;
    });
    html += `</tr>`;
  }
  tbody.innerHTML = html;

  if (_canEdit) {
    const startInput = document.getElementById('roll-start-date');
    if (!startInput.value) startInput.value = _suggestedStartDate(_selectedDept);
    _updateCycleEndDisplay('roll-start-date', 'roll-end-date', _cycleLength);
  }
}

// Session 143: one column per zone (slot_index N = zone N, fixed for the
// life of the template -- matches how save_nursing_roster_template_slot()/
// addSlot() already key everything by day+shift+slot_index), Day 1..N as
// rows underneath. Each cell holds exactly one nurse for that zone/day --
// "distribute 3 nurses among these 3 groups", not extra backup slots.
function renderOpdGroupedGrid(cycleLength) {
  const groups = _requiredPerShift.groups;
  const shift = 'general';

  const thead = document.getElementById('tpl-thead');
  thead.innerHTML = `<tr><th class="day-col">Day</th>${groups.map((g, i) => `<th>Zone ${i + 1}<br><span style="font-weight:400;font-size:10px;text-transform:none;letter-spacing:0">${_esc(g)}</span></th>`).join('')}</tr>`;

  const tbody = document.getElementById('tpl-tbody');
  let html = '';
  for (let day = 0; day < cycleLength; day++) {
    html += `<tr><td class="day-col">Day ${day + 1}</td>`;
    groups.forEach((zoneLabel, i) => {
      const slotIndex = i + 1;
      const existing = _slots.find(s => s.day_offset === day && s.shift_type === shift && s.slot_index === slotIndex);
      html += `<td class="shift-cell">`;
      if (existing) {
        html += `<div class="slot-row">
          <span class="slot-name">${_esc(existing.profiles?.full_name || '—')}</span>
          ${_canEdit ? `<button class="slot-remove" data-onclick="removeSlot" data-onclick-a0="${_esc(existing.id)}">✕</button>` : ''}
        </div>`;
      } else if (_canEdit) {
        const options = _poolOptionsHtml([]);
        if (options) {
          html += `<div class="add-slot-row">
            <select id="add-nurse-${day}-${shift}-${slotIndex}"><option value="">+ Add nurse…</option>${options}</select>
            <input type="hidden" id="add-coverage-${day}-${shift}-${slotIndex}" value="${_esc(zoneLabel)}"/>
            <button class="btn btn-sm btn-secondary" data-onclick="addSlot" data-onclick-a0="${day}" data-onclick-a1="${shift}" data-onclick-a2="${slotIndex}">Add</button>
          </div>`;
        } else if (!_pool.length) {
          html += `<div class="slot-beds">No nursing staff recruited in this hospital yet.</div>`;
        }
      }
      html += `</td>`;
    });
    html += `</tr>`;
  }
  tbody.innerHTML = html;

  if (_canEdit) {
    const startInput = document.getElementById('roll-start-date');
    if (!startInput.value) startInput.value = _suggestedStartDate(_selectedDept);
    _updateCycleEndDisplay('roll-start-date', 'roll-end-date', _cycleLength);
  }
}

// "Fill All" -- Dr. Venkatesh's real-usage finding (initial build rotated a
// different nurse in day-by-day, which felt unmanageably complex once he
// actually used it): a real ward wants the SAME nurse posted to the SAME
// department for the whole cycle, not reshuffled daily. Groups every still-
// empty slot by (shift, slot_index) -- one physical "team seat" for the
// cycle's life -- and assigns ONE nurse to fill every empty day in that
// seat, rotating which pool member gets which seat so two seats in the same
// department don't collide. Never touches a day that already has a nurse in
// that seat -- remove it first to reassign. Moving nurses to a DIFFERENT
// department for the NEXT cycle is a separate, tenant-wide concern (this
// button only ever sees one department's template at a time) -- not yet
// built, see TODO_LATER.md.
function _buildFillGroups() {
  const groups = [];
  const opdMode = _requiredPerShift?.mode === 'opd';

  if (opdMode) {
    _requiredPerShift.groups.forEach((zoneLabel, i) => {
      const slotIndex = i + 1;
      const days = [];
      for (let day = 0; day < _cycleLength; day++) {
        const existing = _slots.some(s => s.day_offset === day && s.shift_type === 'general' && s.slot_index === slotIndex);
        if (!existing) days.push(day);
      }
      if (days.length) groups.push({ shift: 'general', slotIndex, bedStart: null, bedEnd: null, coverageLabel: zoneLabel, days });
    });
    return groups;
  }

  const perShiftByType = _requiredPerShift ? distributeAcrossShifts(_requiredPerShift.total, _selectedDeptShifts) : {};
  _selectedDeptShifts.forEach(shift => {
    const suggestedTotal = _requiredPerShift ? (perShiftByType[shift] ?? 0) : 1;
    for (let slotIndex = 1; slotIndex <= suggestedTotal; slotIndex++) {
      let bedStart = null, bedEnd = null;
      if (_requiredPerShift?.mode === 'bed') {
        const blockSize = Math.ceil(_requiredPerShift.bedCount / suggestedTotal);
        bedStart = (slotIndex - 1) * blockSize + 1;
        bedEnd = Math.min(slotIndex * blockSize, _requiredPerShift.bedCount);
      }
      const days = [];
      for (let day = 0; day < _cycleLength; day++) {
        const existing = _slots.some(s => s.day_offset === day && s.shift_type === shift && s.slot_index === slotIndex);
        if (!existing) days.push(day);
      }
      if (days.length) groups.push({ shift, slotIndex, bedStart, bedEnd, coverageLabel: null, days });
    }
  });
  return groups;
}

// Session 146: day_offset 0 is treated as Monday (matching this app's
// existing week-view convention, roster.js's _getMonday()) so a nurse's
// weekly_off_day (0=Sunday..6=Saturday, JS Date.getDay() convention) can be
// mapped onto a template day_offset at all -- this is a best-effort guess
// for whichever real date a cycle eventually gets rolled forward against;
// roll_nursing_roster_template()'s own date-based check is the guaranteed,
// accurate enforcement regardless of whether this guess holds for any given
// cycle's actual chosen start date.
function _dowForDayOffset(dayOffset) {
  return (dayOffset + 1) % 7;
}

// Core fill logic for whichever department is CURRENTLY LOADED (_selectedDept/
// _pool/_busyElsewhere/etc, set by loadTemplateForDept()) -- no confirm()/
// alert()/button-state here, so both the single-department button below and
// the "All Departments" bulk action can share it.
async function _fillDeptFixedTeams() {
  if (!_pool.length) return { status: 'no-pool' };
  const availablePool = _pool.filter(p => !_busyElsewhere.has(p.id));
  if (!availablePool.length) return { status: 'all-busy' };
  const groups = _buildFillGroups();
  if (!groups.length) return { status: 'nothing-to-fill' };

  let poolIdx = 0;
  let weeklyOffSkips = 0;
  for (const g of groups) {
    const nurse = availablePool[poolIdx % availablePool.length];
    poolIdx++;
    for (const day of g.days) {
      // Session 146: leave this nurse's own weekly-off day unfilled instead
      // of booking them into it -- the head can see the gap directly in the
      // template and staff a relief nurse for that specific day, rather than
      // only discovering it as a silent gap after Roll Forward.
      if (nurse.weekly_off_day != null && _dowForDayOffset(day) === nurse.weekly_off_day) {
        weeklyOffSkips++;
        continue;
      }
      const { error } = await supabase.rpc('save_nursing_roster_template_slot', {
        p_department_id: _selectedDept, p_day_offset: day, p_shift_type: g.shift, p_slot_index: g.slotIndex,
        p_profile_id: nurse.id, p_bed_range_start: g.bedStart, p_bed_range_end: g.bedEnd, p_coverage_label: g.coverageLabel,
      });
      if (error) return { status: 'error', error };
    }
  }
  return { status: 'filled', seats: groups.length, skipped: _pool.length - availablePool.length, weeklyOffSkips };
}

window.fillAllFixedTeams = async function() {
  if (!_pool.length) { _alert('error', 'No nursing staff recruited in this hospital yet.'); return; }
  const availablePool = _pool.filter(p => !_busyElsewhere.has(p.id));
  if (!availablePool.length) { _alert('error', 'Every recruited nurse already has an overlapping shift assigned in another department -- free someone up first, or recruit more nursing staff.'); return; }
  const groups = _buildFillGroups();
  if (!groups.length) { _alert('info', 'Nothing to fill -- every required slot already has a nurse assigned.'); return; }
  const totalDays = groups.reduce((sum, g) => sum + g.days.length, 0);
  const skippedNote = availablePool.length < _pool.length ? ` (${_pool.length - availablePool.length} pool member${_pool.length - availablePool.length === 1 ? '' : 's'} skipped -- already busy elsewhere)` : '';
  if (!confirm(`Assign one fixed nurse to each of ${groups.length} still-open shift seat${groups.length === 1 ? '' : 's'} for the rest of this cycle (${totalDays} day-slot${totalDays === 1 ? '' : 's'} total)?${skippedNote} Already-filled slots are left untouched.`)) return;

  const btn = document.getElementById('btn-fill-all');
  btn.disabled = true; btn.textContent = 'Filling…';
  const result = await _fillDeptFixedTeams();
  btn.disabled = false; btn.textContent = '🔁 Fill All (Fixed Teams)';

  if (result.status === 'error') {
    _alert('error', safeErrorMessage(result.error, 'Stopped partway through -- some slots may already be filled.'));
  } else if (result.weeklyOffSkips) {
    _alert('info', `Filled ${result.seats} seat${result.seats === 1 ? '' : 's'} -- left ${result.weeklyOffSkips} day-slot${result.weeklyOffSkips === 1 ? '' : 's'} open where the assigned nurse's weekly off falls. Add a relief nurse for those days manually.`);
  }
  await loadTemplateForDept();
};

// Fill All deliberately never overwrites an already-filled slot -- but that
// means a department that was filled BEFORE the Fixed-Teams change (the
// original day-by-day rotation) never gets automatically corrected just by
// re-running Fill All, since every slot already has *some* nurse in it.
// Real-usage finding (Dr. Venkatesh, SDM tenant): the old pattern was still
// showing after the code fix, hard refresh, and a CDN cache purge -- because
// none of those touch existing DATA, only code. This wipes every slot in
// the current department's template so Fill All can rebuild it fresh.
async function _clearDeptSlots() {
  if (!_slots.length) return { status: 'empty' };
  for (const s of _slots) {
    const { error } = await supabase.rpc('delete_nursing_roster_template_slot', { p_slot_id: s.id });
    if (error) return { status: 'error', error };
  }
  return { status: 'cleared', count: _slots.length };
}

window.clearAllSlots = async function() {
  if (!_slots.length) { _alert('info', 'This department has no slots to clear.'); return; }
  if (!confirm(`Remove all ${_slots.length} assigned slots in this department's template? You can re-run Fill All afterward to rebuild it with the current fixed-team logic.`)) return;

  const btn = document.getElementById('btn-clear-all');
  btn.disabled = true; btn.textContent = 'Clearing…';
  const result = await _clearDeptSlots();
  btn.disabled = false; btn.textContent = '🗑️ Clear All Slots';

  if (result.status === 'error') {
    _alert('error', safeErrorMessage(result.error, 'Stopped partway through clearing.'));
  } else {
    _alert('success', 'All slots cleared -- click Fill All (Fixed Teams) to rebuild this department.');
  }
  await loadTemplateForDept();
};

// ── Bulk actions across every nursing-duty department (Dr. Venkatesh's
// ask: doing Fill All/Clear All/Generate Next Cycle one department at a
// time was tedious with 8 real departments). Each loops over _depts,
// switching _selectedDept + the visible dropdown so loadTemplateForDept()
// refreshes the busy-elsewhere check fresh for every department in turn
// (important -- a nurse fixed to department A partway through the loop must
// correctly show as busy once we reach department B), then restores
// whichever department the head was originally looking at.
function _renderBulkResult(lines) {
  const box = document.getElementById('bulk-result');
  box.innerHTML = lines.map(l => `<div class="result-line">${l}</div>`).join('');
  box.className = 'result-box show';
}

window.fillAllDepartmentsFixedTeams = async function() {
  if (!_depts.length) { _alert('error', 'No nursing-duty departments found.'); return; }
  if (!confirm(`Run Fill All (Fixed Teams) across all ${_depts.length} nursing-duty departments? Already-filled slots are left untouched in each.`)) return;

  const btn = document.getElementById('btn-bulk-fill-all');
  btn.disabled = true; btn.textContent = 'Filling all departments…';
  const sel = document.getElementById('filter-dept');
  const originalDept = _selectedDept;

  const lines = [];
  for (const dept of _depts) {
    _selectedDept = dept.id;
    sel.value = dept.id;
    await loadTemplateForDept();
    const result = await _fillDeptFixedTeams();
    if (result.status === 'filled') {
      lines.push(`✅ <strong>${_esc(dept.name)}</strong> — ${result.seats} seat${result.seats === 1 ? '' : 's'} filled${result.skipped ? ` (${result.skipped} pool member${result.skipped === 1 ? '' : 's'} skipped — busy elsewhere)` : ''}${result.weeklyOffSkips ? ` · ${result.weeklyOffSkips} day-slot${result.weeklyOffSkips === 1 ? '' : 's'} left open for weekly off` : ''}`);
    } else if (result.status === 'nothing-to-fill') {
      lines.push(`— <strong>${_esc(dept.name)}</strong> — already fully filled`);
    } else if (result.status === 'all-busy') {
      lines.push(`⚠ <strong>${_esc(dept.name)}</strong> — every recruited nurse already busy elsewhere, nothing assigned`);
    } else if (result.status === 'no-pool') {
      lines.push(`⚠ <strong>${_esc(dept.name)}</strong> — no nursing staff recruited yet`);
    } else if (result.status === 'error') {
      lines.push(`❌ <strong>${_esc(dept.name)}</strong> — ${_esc(safeErrorMessage(result.error, 'error'))}`);
    }
  }

  _selectedDept = originalDept;
  sel.value = originalDept || '';
  if (originalDept) await loadTemplateForDept();

  btn.disabled = false; btn.textContent = '🔁 Fill All (Fixed Teams) — All Departments';
  _renderBulkResult(lines);
};

window.clearAllDepartmentsSlots = async function() {
  if (!_depts.length) { _alert('error', 'No nursing-duty departments found.'); return; }
  if (!confirm(`Remove ALL assigned slots across all ${_depts.length} nursing-duty departments' templates? You'll need to re-run Fill All afterward to rebuild them.`)) return;

  const btn = document.getElementById('btn-bulk-clear-all');
  btn.disabled = true; btn.textContent = 'Clearing all departments…';
  const sel = document.getElementById('filter-dept');
  const originalDept = _selectedDept;

  const lines = [];
  for (const dept of _depts) {
    _selectedDept = dept.id;
    sel.value = dept.id;
    await loadTemplateForDept();
    const result = await _clearDeptSlots();
    if (result.status === 'cleared') {
      lines.push(`🗑️ <strong>${_esc(dept.name)}</strong> — ${result.count} slot${result.count === 1 ? '' : 's'} cleared`);
    } else if (result.status === 'empty') {
      lines.push(`— <strong>${_esc(dept.name)}</strong> — nothing to clear`);
    } else if (result.status === 'error') {
      lines.push(`❌ <strong>${_esc(dept.name)}</strong> — ${_esc(safeErrorMessage(result.error, 'error'))}`);
    }
  }

  _selectedDept = originalDept;
  sel.value = originalDept || '';
  if (originalDept) await loadTemplateForDept();

  btn.disabled = false; btn.textContent = '🗑️ Clear All Slots — All Departments';
  _renderBulkResult(lines);
};

window.rollForwardAllDepartments = async function() {
  const date = document.getElementById('bulk-roll-start-date').value;
  if (!date) { _alert('error', 'Pick a start date first.'); return; }
  if (!_depts.length) { _alert('error', 'No nursing-duty departments found.'); return; }
  if (!confirm(`Generate the next cycle's real duty-roster dates (starting ${date}) for all ${_depts.length} nursing-duty departments?`)) return;

  const btn = document.getElementById('btn-bulk-roll');
  btn.disabled = true; btn.textContent = 'Generating…';
  const sel = document.getElementById('filter-dept');
  const originalDept = _selectedDept;

  const lines = [];
  for (const dept of _depts) {
    _selectedDept = dept.id;
    sel.value = dept.id;
    await loadTemplateForDept();
    if (!_template) { lines.push(`— <strong>${_esc(dept.name)}</strong> — no template built yet, skipped`); continue; }

    const { data, error } = await supabase.rpc('roll_nursing_roster_template', { p_department_id: dept.id, p_start_date: date });
    if (error) { lines.push(`❌ <strong>${_esc(dept.name)}</strong> — ${_esc(safeErrorMessage(error, 'error'))}`); continue; }
    const gapsCount = (data.gaps || []).length;
    const subsCount = (data.substitutions || []).length;
    lines.push(`✅ <strong>${_esc(dept.name)}</strong> — ${data.created} shift${data.created === 1 ? '' : 's'} generated`
      + (subsCount ? `, ${subsCount} leave substitution${subsCount === 1 ? '' : 's'}` : '')
      + (gapsCount ? `, <span style="color:#8b1a1a">⚠ ${gapsCount} gap${gapsCount === 1 ? '' : 's'}</span>` : '')
      + (data.cycle_transitioned ? `, <span style="color:#7a5a10">🔁 switched ${data.old_cycle_days}→${data.new_cycle_days} days</span>` : ''));
  }

  _selectedDept = originalDept;
  sel.value = originalDept || '';
  if (originalDept) await loadTemplateForDept();

  btn.disabled = false; btn.textContent = '🔁 Generate Next Cycle — All Departments';
  _renderBulkResult(lines);

  // Refresh so the field's default reflects what was JUST generated, not
  // what's now a stale (already-overwritten) start date.
  await loadCycleExpiryBanner();
  document.getElementById('bulk-roll-start-date').value = _suggestedBulkStartDate();
  _updateCycleEndDisplay('bulk-roll-start-date', 'bulk-roll-end-date', CYCLE_DAYS[_tenantCycleKey] || 7);
};

window.addSlot = async function(day, shift, slotIndex) {
  const sel = document.getElementById(`add-nurse-${day}-${shift}-${slotIndex}`);
  const profileId = sel?.value;
  if (!profileId) return;
  const bedStart = document.getElementById(`add-bed-start-${day}-${shift}-${slotIndex}`)?.value;
  const bedEnd = document.getElementById(`add-bed-end-${day}-${shift}-${slotIndex}`)?.value;
  const coverageLabel = document.getElementById(`add-coverage-${day}-${shift}-${slotIndex}`)?.value || null;

  const { error } = await supabase.rpc('save_nursing_roster_template_slot', {
    p_department_id: _selectedDept, p_day_offset: Number(day), p_shift_type: shift, p_slot_index: Number(slotIndex),
    p_profile_id: profileId, p_bed_range_start: bedStart ? Number(bedStart) : null, p_bed_range_end: bedEnd ? Number(bedEnd) : null,
    p_coverage_label: coverageLabel,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save this slot.')); return; }
  await loadTemplateForDept();
};

window.removeSlot = async function(slotId) {
  if (!confirm('Remove this nurse from the template?')) return;
  const { error } = await supabase.rpc('delete_nursing_roster_template_slot', { p_slot_id: slotId });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not remove this slot.')); return; }
  await loadTemplateForDept();
};

window.rollForward = async function() {
  const date = document.getElementById('roll-start-date').value;
  if (!date) { _alert('error', 'Pick a start date first.'); return; }
  const btn = document.getElementById('btn-roll');
  btn.disabled = true; btn.textContent = 'Generating…';

  const { data, error } = await supabase.rpc('roll_nursing_roster_template', { p_department_id: _selectedDept, p_start_date: date });

  btn.disabled = false; btn.textContent = 'Generate Next Cycle';

  if (error) { _alert('error', safeErrorMessage(error, 'Could not roll the roster forward.')); return; }
  renderRollResult(data);

  await loadCycleExpiryBanner();
  document.getElementById('roll-start-date').value = _suggestedStartDate(_selectedDept);
  _updateCycleEndDisplay('roll-start-date', 'roll-end-date', _cycleLength);
};

function _nameFor(id) {
  return _pool.find(p => p.id === id)?.full_name || '—';
}

function renderRollResult(result) {
  const box = document.getElementById('roll-result');
  const gaps = result.gaps || [];
  const subs = result.substitutions || [];
  let html = `<div class="result-line">✅ <strong>${result.created}</strong> shift${result.created === 1 ? '' : 's'} generated.</div>`;
  if (result.cycle_transitioned) {
    html += `<div class="result-line">🔁 This department's template just switched from ${result.old_cycle_days} to <strong>${result.new_cycle_days} days</strong>, matching the currently-approved roster cycle.</div>`;
  }
  if (result.holiday_count > 0) {
    html += `<div class="result-line">🎉 ${result.holiday_count} of them fall on a public holiday -- nursing duty still applies, shown for awareness only.</div>`;
  }
  if (subs.length) {
    // Session 149: relief-pool substitutions (weekly off) shown separately
    // from leave substitutions -- different reason, worth telling apart.
    const leaveSubs = subs.filter(s => s.via !== 'relief_pool');
    const reliefSubs = subs.filter(s => s.via === 'relief_pool');
    if (leaveSubs.length) {
      html += `<div class="result-line"><strong>${leaveSubs.length} covered by a leave substitute:</strong></div>`;
      leaveSubs.forEach(s => { html += `<div class="result-line">— ${_esc(s.date)} ${SHIFT_LABELS[s.shift_type]}: ${_esc(_nameFor(s.original_profile_id))} → ${_esc(_nameFor(s.covering_profile_id))} (on approved leave)</div>`; });
    }
    if (reliefSubs.length) {
      html += `<div class="result-line">🌟 <strong>${reliefSubs.length} covered by the relief pool:</strong></div>`;
      reliefSubs.forEach(s => { html += `<div class="result-line">— ${_esc(s.date)} ${SHIFT_LABELS[s.shift_type]}: ${_esc(_nameFor(s.original_profile_id))} → ${_esc(_nameFor(s.covering_profile_id))} (weekly off)</div>`; });
    }
  }
  if (gaps.length) {
    html += `<div class="result-line" style="color:#8b1a1a"><strong>⚠ ${gaps.length} gap${gaps.length === 1 ? '' : 's'} -- needs manual staffing:</strong></div>`;
    gaps.forEach(g => { html += `<div class="result-line">— ${_esc(g.date)} ${SHIFT_LABELS[g.shift_type]}: ${_esc(_nameFor(g.profile_id))} (${_esc(g.reason)})</div>`; });
  }
  box.innerHTML = html;
  box.className = 'result-box show' + (gaps.length ? ' warn' : '');
}

function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = `alert ${type} show`;
  setTimeout(() => el.className = 'alert', 5000);
}

// ── Cycle Expiry Banner (Session 148) ───────────────────────────────
// Same check as nursing-admin.html's banner (shared js/modules/roster/
// cycleExpiry.js) -- shown here too since this is where the actual fix
// (Generate Next Cycle) happens.
async function loadCycleExpiryBanner() {
  const el = document.getElementById('expiry-banner');
  _expiry = await checkCycleExpiry(supabase, tenantId, _depts);
  const concerning = _expiry.filter(r => r.status !== 'ok');
  if (!concerning.length) { el.style.display = 'none'; return; }

  const hasUrgent = concerning.some(r => r.status === 'expired' || r.status === 'none');
  el.className = `expiry-banner ${hasUrgent ? 'danger' : 'warn'}`;
  el.style.display = '';

  // Session 149: dropped the per-department breakdown lines -- Dr.
  // Venkatesh found the full list too noisy; one summary line is enough,
  // especially here where the actual fix (Generate Next Cycle) is right
  // below. nursing-admin.js's banner simplified the same way, so the two
  // pages never show different detail for the same underlying data. Also
  // names any queued cycle-length change that will auto-apply the moment
  // Generate Next Cycle is clicked for one of these departments, so the
  // head sees it coming beforehand instead of being surprised after.
  const transitioning = concerning.filter(r => r.willTransition);
  el.innerHTML = `<strong>${hasUrgent ? '🔴' : '⚠️'} ${concerning.length} department${concerning.length === 1 ? '' : 's'} need${concerning.length === 1 ? 's' : ''} the next roster cycle generated</strong>`
    + (transitioning.length ? `<div style="margin-top:6px">ℹ️ Next cycle will transition to ${transitioning[0].tenantDays} days for ${transitioning.length} of these department${transitioning.length === 1 ? '' : 's'}.</div>` : '');
}

await Promise.all([loadDepartments(), loadEditGate()]);
document.getElementById('bulk-card').style.display = _canEdit ? '' : 'none';
await loadCycleExpiryBanner(); // populates _expiry, used by the suggested-date default below
await loadRosterCycle(); // populates _tenantCycleKey, used by the bulk "To" date below
await loadShiftPatternCard(); // populates SHIFT_LABELS with the tenant's actual pattern, before any grid can render
document.getElementById('bulk-roll-start-date').value = _suggestedBulkStartDate();
_updateCycleEndDisplay('bulk-roll-start-date', 'bulk-roll-end-date', CYCLE_DAYS[_tenantCycleKey] || 7);

// Live-recompute "To" whenever the head edits a "From" date by hand, not
// just when this page sets one programmatically.
document.getElementById('bulk-roll-start-date').addEventListener('change', () =>
  _updateCycleEndDisplay('bulk-roll-start-date', 'bulk-roll-end-date', CYCLE_DAYS[_tenantCycleKey] || 7));
document.getElementById('roll-start-date').addEventListener('change', () =>
  _updateCycleEndDisplay('roll-start-date', 'roll-end-date', _cycleLength));
