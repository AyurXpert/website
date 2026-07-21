// dept-admin.js — Phase 3 first slice (Session 120): a HOD/Professor's own
// department dashboard. Deliberately a small, DEDICATED page rather than a
// restricted view of admin.html/bed-admin.html -- those are mixed read+write
// single-page files (Statistics tab, department CRUD, etc. all reachable in
// the same session), and Phase 2 already found that granting partial access
// to a page like that risks exposing everything else in it. This page never
// had any write UI beyond the roster editor below, and that editor is backed
// by RPCs that re-derive and check the caller's department scope from the
// database on every write -- never trusts the client.
import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType, UG_BED_RATIOS } from '../config/ncism.js';

await requireAuth(['doctor']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const deptId   = profile?.scope_department_id || null;

if (!deptId) {
  // Not actually scoped -- this page is meaningless without it.
  window.location.replace('doctor.html');
}

const SHIFT_LABELS = { morning:'Morning', afternoon:'Afternoon', night:'Night', on_call:'On-Call' };
const SHIFT_TYPES = ['morning','afternoon','night','on_call'];

function _esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function _formatDesignation(d){ return d ? d.replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase()) : ''; }
function _toast(msg, isErr){
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (isErr?' err':'');
  setTimeout(()=>el.classList.remove('show'), 3500);
}
function _dateStr(d){ return d.toISOString().slice(0,10); }
function _weekDates(){
  const out = []; const today = new Date();
  for (let i=0;i<7;i++){ const d = new Date(today); d.setDate(today.getDate()+i); out.push(d); }
  return out;
}

let _staffList = [];
let _rosterByKey = {}; // `${date}|${shiftType}` -> row

async function loadAll(){
  const today = new Date().toISOString().slice(0,10);
  const todayStart = today + 'T00:00:00.000Z';
  const tomorrowStart = new Date(new Date(today+'T00:00:00Z').getTime()+86400000).toISOString();
  const weekDates = _weekDates();
  const weekStart = _dateStr(weekDates[0]), weekEnd = _dateStr(weekDates[6]);

  const [{ data:dept }, { data:staff }, { data:roster }, { data:tRow }] = await Promise.all([
    supabase.from('departments').select('id,name,category,ncism_code,opd_id,is_active').eq('id',deptId).single(),
    supabase.from('profiles').select('id,full_name,designation').eq('tenant_id',tenantId).eq('department_id',deptId).eq('is_active',true).order('full_name'),
    supabase.from('duty_roster').select('id,profile_id,shift_date,shift_type,is_confirmed').eq('tenant_id',tenantId).eq('department_id',deptId).gte('shift_date',weekStart).lte('shift_date',weekEnd),
    supabase.from('tenants').select('opd_daily_target,type').eq('id',tenantId).single(),
  ]);

  if (!dept) { document.getElementById('dd-body').innerHTML = '<div class="empty">Department not found.</div>'; return; }

  _staffList = staff || [];
  _rosterByKey = {};
  (roster||[]).forEach(r => { _rosterByKey[r.shift_date+'|'+r.shift_type] = r; });

  document.getElementById('dept-title').textContent = dept.name;
  document.getElementById('dept-subtitle').textContent =
    (dept.ncism_code ? 'NCISM: '+dept.ncism_code+' · ' : '') + (dept.is_active ? 'Active' : 'Inactive');

  // Today's queue vs prorated NCISM target -- same calc as admin.js's Department Detail
  let queueHtml = '';
  if (dept.opd_id) {
    const { data:visits } = await supabase.from('visits')
      .select('status').eq('tenant_id',tenantId).eq('opd_id',dept.opd_id).eq('is_deleted',false)
      .gte('created_at',todayStart).lt('created_at',tomorrowStart);
    const counts = {waiting:0,in_progress:0,completed:0};
    (visits||[]).forEach(v=>{ if(counts[v.status]!==undefined) counts[v.status]++; });
    const total = (visits||[]).length;
    const ratio = dept.ncism_code ? UG_BED_RATIOS[dept.ncism_code] : null;
    const target = (ratio && isNCISMType(tRow?.type)) ? Math.round((tRow?.opd_daily_target||0)*ratio) : null;
    queueHtml = `<div class="snap-card">
      <div class="snap-title">🚪 OPD Queue Today</div>
      <div class="snap-row">⏳ Waiting: <strong>${counts.waiting}</strong> · 🩺 In Progress: <strong>${counts.in_progress}</strong> · ✅ Completed: <strong>${counts.completed}</strong></div>
      ${target!=null ? `<div class="snap-muted">Today's target: <strong>${target}</strong> — ${total>=target?'<span class="ok">met</span>':`<span class="warn">${target-total} more needed</span>`}</div>` : ''}
    </div>`;
  }

  // Staff + today's duty/leave status
  const staffIds = _staffList.map(s=>s.id);
  const { data:leaves } = staffIds.length
    ? await supabase.from('staff_leaves').select('profile_id,leave_type,covering:profiles!covering_profile_id(full_name)')
        .eq('tenant_id',tenantId).eq('status','approved').lte('from_date',today).gte('to_date',today).in('profile_id',staffIds)
    : { data: [] };
  const leavesByProfile = {}; (leaves||[]).forEach(l=>{ leavesByProfile[l.profile_id]=l; });
  const todayRosterByProfile = {};
  (roster||[]).filter(r=>r.shift_date===today).forEach(r=>{ todayRosterByProfile[r.profile_id]=r; });

  const staffHtml = _staffList.length ? _staffList.map(s=>{
    const onLeave = leavesByProfile[s.id];
    const onDuty = todayRosterByProfile[s.id];
    let tag = '<span class="tag muted">Not rostered today</span>';
    if (onLeave) tag = `<span class="tag danger">🏖️ On leave${onLeave.covering ? ' — charge: '+_esc(onLeave.covering.full_name) : ''}</span>`;
    else if (onDuty) tag = `<span class="tag ok">🕐 On duty — ${_esc(SHIFT_LABELS[onDuty.shift_type]||onDuty.shift_type)}</span>`;
    return `<div class="staff-row"><span>${_esc(s.full_name)} <span class="muted">(${_esc(_formatDesignation(s.designation))})</span></span>${tag}</div>`;
  }).join('') : '<div class="empty-sm">No staff assigned to this department.</div>';

  document.getElementById('dd-body').innerHTML = `
    ${queueHtml}
    <div class="snap-card">
      <div class="snap-title">👥 Staff (${_staffList.length})</div>
      ${staffHtml}
    </div>`;

  renderRoster(weekDates);
}

function renderRoster(weekDates){
  const head = '<tr><th>Shift</th>' + weekDates.map(d=>`<th>${d.toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'})}</th>`).join('') + '</tr>';
  const rows = SHIFT_TYPES.map(shift => {
    const cells = weekDates.map(d => {
      const date = _dateStr(d);
      const key = date+'|'+shift;
      const row = _rosterByKey[key];
      const staffName = row ? (_staffList.find(s=>s.id===row.profile_id)?.full_name || '—') : null;
      return `<td>
        ${row
          ? `<div class="roster-cell filled">${_esc(staffName)}<button class="cell-x" data-onclick="removeShift" data-onclick-a0="${_esc(row.id)}">&times;</button></div>`
          : `<button class="cell-add" data-onclick="assignShift" data-onclick-a0="${date}" data-onclick-a1="${shift}">+ Assign</button>`}
      </td>`;
    }).join('');
    return `<tr><td class="shift-label">${SHIFT_LABELS[shift]}</td>${cells}</tr>`;
  }).join('');
  document.getElementById('roster-table').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
}

window.assignShift = function(date, shift){
  if (!_staffList.length) { _toast('No staff assigned to this department to roster.', true); return; }
  document.getElementById('assign-date').value = date;
  document.getElementById('assign-shift').value = shift;
  document.getElementById('assign-label').textContent = SHIFT_LABELS[shift] + ' — ' + date;
  const sel = document.getElementById('assign-staff');
  sel.innerHTML = _staffList.map(s=>`<option value="${_esc(s.id)}">${_esc(s.full_name)}</option>`).join('');
  document.getElementById('assign-modal').style.display = 'flex';
};

window.closeAssignModal = function(){ document.getElementById('assign-modal').style.display = 'none'; };

window.confirmAssignShift = async function(){
  const date = document.getElementById('assign-date').value;
  const shift = document.getElementById('assign-shift').value;
  const staffId = document.getElementById('assign-staff').value;
  const { error } = await supabase.rpc('hod_save_roster_shift', {
    p_department_id: deptId, p_shift_date: date, p_shift_type: shift, p_profile_id: staffId,
  });
  if (error) { _toast(safeErrorMessage(error, 'Could not save shift.'), true); return; }
  window.closeAssignModal();
  _toast('Shift assigned.');
  await loadAll();
};

window.removeShift = async function(rowId){
  if (!confirm('Remove this shift assignment?')) return;
  const { error } = await supabase.rpc('hod_delete_roster_shift', { p_department_id: deptId, p_row_id: rowId });
  if (error) { _toast(safeErrorMessage(error, 'Could not remove shift.'), true); return; }
  _toast('Shift removed.');
  await loadAll();
};

if (deptId) await loadAll();
