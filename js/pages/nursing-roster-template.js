import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNursingDutyDept, shiftsForDept, OPD_POOLED_NURSE_COUNT, OPD_COVERAGE_GROUPS } from '../config/ncism.js';
import { _computeIpdBedTotals } from '../config/ncismStaffCompliance.js';
import { resolveNursingHeadship, canActAsNursingHead } from '../modules/roster/nursingHeadship.js';

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
const BED_DEPT_ZONE = { 'Medical In-Patients': 'IPD_MEDICAL', 'Surgical In-Patients': 'IPD_SURGICAL' };

let _canEdit = role === 'super_admin' || role === 'dept_admin';
let _depts = [];
let _selectedDept = null;
let _selectedDeptShifts = ['morning', 'afternoon', 'night'];
let _requiredPerShift = null; // bed-derived suggestion, Medical/Surgical In-Patients only
let _template = null;   // { id, cycle_length } or null
let _slots = [];        // template slots, with .profiles.full_name joined
let _pool = [];         // nursing staff assignable (tenant-wide)

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

// Suggested per-shift nurse count -- two different sources depending on the
// department:
// (a) Medical/Surgical In-Patients: bed-derived (1 per 10 beds), reusing the
//     same _computeIpdBedTotals() grouping the NCISM staffing ladder already
//     uses (real beds are still tracked under the original clinical
//     departments' ncism_code -- KAY/PK/KAU/AGD for Medical, SHAL/SHAK/PST
//     for Surgical -- not under the Medical/Surgical In-Patients department
//     rows directly; confirmed live before assuming a simpler direct
//     department_id bed count would work, since it would silently return 0).
// (b) OPD: a flat, UG-intake-tier-based headcount (Sch XX/20, same table
//     nursing-admin.js's compliance ladder uses) -- OPD has no beds -- split
//     into 3 named coverage zones (Session 142, confirmed with Dr. Venkatesh)
//     across the 10 real Schedule XVIII outpatient clinics.
async function _loadRequiredPerShift(deptName) {
  const zone = BED_DEPT_ZONE[deptName];
  if (zone) {
    const [{ data: allDepts }, { data: beds }] = await Promise.all([
      supabase.from('departments').select('id,ncism_code').eq('tenant_id', tenantId).eq('is_active', true),
      supabase.from('beds').select('department_id').eq('tenant_id', tenantId),
    ]);
    const bedTotals = _computeIpdBedTotals(allDepts || [], beds || []);
    const bedCount = bedTotals[zone] || 0;
    _requiredPerShift = bedCount > 0 ? { mode: 'bed', bedCount, perShift: Math.ceil(bedCount / 10) } : null;
    return;
  }
  if (deptName === 'OPD') {
    const { data: tenantRow } = await supabase.from('tenants').select('ug_intake').eq('id', tenantId).single();
    const ugRaw = tenantRow?.ug_intake;
    const ug = [60, 100, 150, 200].includes(ugRaw) ? ugRaw : (ugRaw >= 150 ? 150 : ugRaw >= 100 ? 100 : ugRaw > 0 ? 60 : 0);
    const perShift = OPD_POOLED_NURSE_COUNT[ug] || 0;
    _requiredPerShift = perShift > 0 ? { mode: 'opd', perShift, groups: OPD_COVERAGE_GROUPS } : null;
    return;
  }
  _requiredPerShift = null;
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
