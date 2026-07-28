import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNursingDutyDept, shiftsForDept } from '../config/ncism.js';
import { resolveNursingHeadship, canActAsNursingHead } from '../modules/roster/nursingHeadship.js';
import { computeRequiredPerShift } from '../modules/roster/requiredStaffing.js';

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

const SHIFT_LABELS = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night', general: 'General Duty (9am–5pm)' };
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

async function loadEditGate() {
  if (role !== 'nurse_manager') return; // super_admin/dept_admin already true
  const headship = await resolveNursingHeadship(supabase, tenantId);
  _canEdit = canActAsNursingHead(headship, profile.id, role, profile.designation);
}

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

  const [{ data: settingRow }, { data: templateRow }, { data: poolRows }] = await Promise.all([
    supabase.from('nursing_roster_settings').select('cycle').eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('nursing_roster_templates').select('id,cycle_length').eq('tenant_id', tenantId).eq('department_id', _selectedDept).maybeSingle(),
    // Session 141: tenant-wide pool, not scoped to this department's own
    // recruitment -- a nurse gets POSTED to duty here, not necessarily
    // permanently assigned here.
    supabase.from('profiles').select('id,full_name').eq('tenant_id', tenantId)
      .in('designation', ['staff_nurse', 'ward_sister', 'anm']).eq('is_active', true).order('full_name'),
    _loadRequiredPerShift(deptObj?.name),
  ]);

  _pool = poolRows || [];
  _template = templateRow || null;

  const tenantCycleDays = CYCLE_DAYS[settingRow?.cycle || 'weekly'];
  const cycleLength = _template?.cycle_length || tenantCycleDays;
  _cycleLength = cycleLength;

  let requiredNote = '';
  if (_requiredPerShift?.mode === 'bed') {
    requiredNote = ` · ${_requiredPerShift.bedCount} beds → ${_requiredPerShift.perShift} nurse${_requiredPerShift.perShift === 1 ? '' : 's'} required per shift (1 per 10 beds)`;
  } else if (_requiredPerShift?.mode === 'opd') {
    requiredNote = ` · ${_requiredPerShift.perShift} nurses required (Sch XX/20, pooled across all OPDs), split into ${_requiredPerShift.groups.length} coverage zones`;
  }
  document.getElementById('tpl-sub').textContent = (_template
    ? `${cycleLength}-day template (locked in when first built)`
    : `No template yet -- will be built as a ${tenantCycleDays}-day pattern (current tenant cycle: ${settingRow?.cycle || 'weekly'})`) + requiredNote;

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
}

function _poolOptionsHtml(excludeIds) {
  return _pool.filter(p => !excludeIds.includes(p.id))
    .map(p => `<option value="${_esc(p.id)}">${_esc(p.full_name)}</option>`).join('');
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
  const suggestedTotal = _requiredPerShift ? _requiredPerShift.perShift : 0;
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
      } else {
        const bedStart = (slotIndex - 1) * 10 + 1;
        const bedEnd = Math.min(slotIndex * 10, _requiredPerShift.bedCount);
        html += addRow(slotIndex, bedStart, bedEnd, null, `+ Add nurse (${bedStart}–${bedEnd}) — required`);
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
    const today = new Date().toISOString().slice(0, 10);
    const startInput = document.getElementById('roll-start-date');
    if (!startInput.value) startInput.value = today;
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
    const today = new Date().toISOString().slice(0, 10);
    const startInput = document.getElementById('roll-start-date');
    if (!startInput.value) startInput.value = today;
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

  _selectedDeptShifts.forEach(shift => {
    const suggestedTotal = _requiredPerShift ? _requiredPerShift.perShift : 1;
    for (let slotIndex = 1; slotIndex <= suggestedTotal; slotIndex++) {
      let bedStart = null, bedEnd = null;
      if (_requiredPerShift?.mode === 'bed') {
        bedStart = (slotIndex - 1) * 10 + 1;
        bedEnd = Math.min(slotIndex * 10, _requiredPerShift.bedCount);
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

window.fillAllFixedTeams = async function() {
  if (!_pool.length) { _alert('error', 'No nursing staff recruited in this hospital yet.'); return; }
  const groups = _buildFillGroups();
  if (!groups.length) { _alert('info', 'Nothing to fill -- every required slot already has a nurse assigned.'); return; }
  const totalDays = groups.reduce((sum, g) => sum + g.days.length, 0);
  if (!confirm(`Assign one fixed nurse to each of ${groups.length} still-open shift seat${groups.length === 1 ? '' : 's'} for the rest of this cycle (${totalDays} day-slot${totalDays === 1 ? '' : 's'} total)? Already-filled slots are left untouched.`)) return;

  const btn = document.getElementById('btn-fill-all');
  btn.disabled = true; btn.textContent = 'Filling…';

  let poolIdx = 0;
  for (const g of groups) {
    const nurse = _pool[poolIdx % _pool.length];
    poolIdx++;
    for (const day of g.days) {
      const { error } = await supabase.rpc('save_nursing_roster_template_slot', {
        p_department_id: _selectedDept, p_day_offset: day, p_shift_type: g.shift, p_slot_index: g.slotIndex,
        p_profile_id: nurse.id, p_bed_range_start: g.bedStart, p_bed_range_end: g.bedEnd, p_coverage_label: g.coverageLabel,
      });
      if (error) {
        btn.disabled = false; btn.textContent = '🔁 Fill All (Fixed Teams)';
        _alert('error', safeErrorMessage(error, 'Stopped partway through -- some slots may already be filled.'));
        await loadTemplateForDept();
        return;
      }
    }
  }

  btn.disabled = false; btn.textContent = '🔁 Fill All (Fixed Teams)';
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
window.clearAllSlots = async function() {
  if (!_slots.length) { _alert('info', 'This department has no slots to clear.'); return; }
  if (!confirm(`Remove all ${_slots.length} assigned slots in this department's template? You can re-run Fill All afterward to rebuild it with the current fixed-team logic.`)) return;

  const btn = document.getElementById('btn-clear-all');
  btn.disabled = true; btn.textContent = 'Clearing…';

  for (const s of _slots) {
    const { error } = await supabase.rpc('delete_nursing_roster_template_slot', { p_slot_id: s.id });
    if (error) {
      btn.disabled = false; btn.textContent = '🗑️ Clear All Slots';
      _alert('error', safeErrorMessage(error, 'Stopped partway through clearing.'));
      await loadTemplateForDept();
      return;
    }
  }

  btn.disabled = false; btn.textContent = '🗑️ Clear All Slots';
  _alert('success', 'All slots cleared -- click Fill All (Fixed Teams) to rebuild this department.');
  await loadTemplateForDept();
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
};

function _nameFor(id) {
  return _pool.find(p => p.id === id)?.full_name || '—';
}

function renderRollResult(result) {
  const box = document.getElementById('roll-result');
  const gaps = result.gaps || [];
  const subs = result.substitutions || [];
  let html = `<div class="result-line">✅ <strong>${result.created}</strong> shift${result.created === 1 ? '' : 's'} generated.</div>`;
  if (result.holiday_count > 0) {
    html += `<div class="result-line">🎉 ${result.holiday_count} of them fall on a public holiday -- nursing duty still applies, shown for awareness only.</div>`;
  }
  if (subs.length) {
    html += `<div class="result-line"><strong>${subs.length} covered by a leave substitute:</strong></div>`;
    subs.forEach(s => { html += `<div class="result-line">— ${_esc(s.date)} ${SHIFT_LABELS[s.shift_type]}: ${_esc(_nameFor(s.original_profile_id))} → ${_esc(_nameFor(s.covering_profile_id))} (on approved leave)</div>`; });
  }
  if (gaps.length) {
    html += `<div class="result-line" style="color:#8b1a1a"><strong>⚠ ${gaps.length} gap${gaps.length === 1 ? '' : 's'} -- on approved leave, no covering staff assigned:</strong></div>`;
    gaps.forEach(g => { html += `<div class="result-line">— ${_esc(g.date)} ${SHIFT_LABELS[g.shift_type]}: ${_esc(_nameFor(g.profile_id))}</div>`; });
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

await Promise.all([loadDepartments(), loadEditGate()]);
