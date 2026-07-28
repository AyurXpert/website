import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { NURSING_DUTY_CODES, NURSING_DEPT_NAMES } from '../config/ncism.js';
import { resolveNursingHeadship, canActAsNursingHead } from '../modules/roster/nursingHeadship.js';

// Session 139 (Nursing Duty Roster Phase 3): template editor for the
// "Template-Based Rolling Schedule" -- a repeating base pattern per
// department, sized to the tenant's approved cycle length
// (nursing_roster_settings.cycle, Phase 2). Edit gating mirrors roster.js
// exactly: super_admin/dept_admin always can; nurse_manager only if
// currently the resolved Nursing Head.
await requireAuth(['super_admin', 'dept_admin', 'nurse_manager']);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const role     = getCurrentRole();

const SHIFTS = ['morning', 'afternoon', 'night'];
const SHIFT_LABELS = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const CYCLE_DAYS = { weekly: 7, fortnightly: 14, monthly: 30 };

let _canEdit = role === 'super_admin' || role === 'dept_admin';
let _depts = [];
let _selectedDept = null;
let _template = null;   // { id, cycle_length } or null
let _slots = [];        // template slots, with .profiles.full_name joined
let _pool = [];         // nursing staff assignable in the selected department

async function loadDepartments() {
  const { data } = await supabase.from('departments')
    .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true).order('name');
  _depts = (data || []).filter(d => NURSING_DUTY_CODES.has(d.ncism_code) || NURSING_DEPT_NAMES.has(d.name));

  const sel = document.getElementById('filter-dept');
  _depts.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
    sel.appendChild(o);
  });
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

  const [{ data: settingRow }, { data: templateRow }, { data: poolRows }] = await Promise.all([
    supabase.from('nursing_roster_settings').select('cycle').eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('nursing_roster_templates').select('id,cycle_length').eq('tenant_id', tenantId).eq('department_id', _selectedDept).maybeSingle(),
    supabase.from('profiles').select('id,full_name').eq('tenant_id', tenantId).eq('department_id', _selectedDept)
      .in('designation', ['staff_nurse', 'ward_sister', 'anm']).eq('is_active', true).order('full_name'),
  ]);

  _pool = poolRows || [];
  _template = templateRow || null;

  const tenantCycleDays = CYCLE_DAYS[settingRow?.cycle || 'weekly'];
  const cycleLength = _template?.cycle_length || tenantCycleDays;

  document.getElementById('tpl-sub').textContent = _template
    ? `${cycleLength}-day template (locked in when first built)`
    : `No template yet -- will be built as a ${tenantCycleDays}-day pattern (current tenant cycle: ${settingRow?.cycle || 'weekly'})`;

  if (_template) {
    const { data: slotRows } = await supabase.from('nursing_roster_template_slots')
      .select('id,day_offset,shift_type,slot_index,profile_id,bed_range_start,bed_range_end,profiles(full_name)')
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

function renderGrid(cycleLength) {
  const tbody = document.getElementById('tpl-tbody');
  let html = '';
  for (let day = 0; day < cycleLength; day++) {
    html += `<tr><td class="day-col">Day ${day + 1}</td>`;
    SHIFTS.forEach(shift => {
      const cellSlots = _slots.filter(s => s.day_offset === day && s.shift_type === shift)
        .sort((a, b) => a.slot_index - b.slot_index);
      const assignedIds = cellSlots.map(s => s.profile_id);
      html += `<td class="shift-cell">`;
      cellSlots.forEach(s => {
        const beds = (s.bed_range_start && s.bed_range_end) ? ` <span class="slot-beds">(Beds ${s.bed_range_start}–${s.bed_range_end})</span>` : '';
        html += `<div class="slot-row">
          <span><span class="slot-name">${_esc(s.profiles?.full_name || '—')}</span>${beds}</span>
          ${_canEdit ? `<button class="slot-remove" data-onclick="removeSlot" data-onclick-a0="${_esc(s.id)}">✕</button>` : ''}
        </div>`;
      });
      if (_canEdit) {
        const nextSlotIndex = cellSlots.length ? Math.max(...cellSlots.map(s => s.slot_index)) + 1 : 1;
        const options = _poolOptionsHtml(assignedIds);
        if (options) {
          html += `<div class="add-slot-row">
            <select id="add-nurse-${day}-${shift}"><option value="">+ Add nurse…</option>${options}</select>
            <input type="number" id="add-bed-start-${day}-${shift}" placeholder="Bed#"/>
            <input type="number" id="add-bed-end-${day}-${shift}" placeholder="to"/>
            <button class="btn btn-sm btn-secondary" data-onclick="addSlot" data-onclick-a0="${day}" data-onclick-a1="${shift}" data-onclick-a2="${nextSlotIndex}">Add</button>
          </div>`;
        } else if (!_pool.length) {
          html += `<div class="slot-beds">No nursing staff assigned to this department yet.</div>`;
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
  const sel = document.getElementById(`add-nurse-${day}-${shift}`);
  const profileId = sel?.value;
  if (!profileId) return;
  const bedStart = document.getElementById(`add-bed-start-${day}-${shift}`)?.value;
  const bedEnd = document.getElementById(`add-bed-end-${day}-${shift}`)?.value;

  const { error } = await supabase.rpc('save_nursing_roster_template_slot', {
    p_department_id: _selectedDept, p_day_offset: Number(day), p_shift_type: shift, p_slot_index: Number(slotIndex),
    p_profile_id: profileId, p_bed_range_start: bedStart ? Number(bedStart) : null, p_bed_range_end: bedEnd ? Number(bedEnd) : null,
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
