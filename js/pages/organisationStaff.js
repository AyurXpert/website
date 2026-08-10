// Organisation Staff — Session 164. Dedicated standalone page (not an HR tab) listing every
// real employee beyond the strict NCISM Schedule I/XX minimum, for whatever real reason.
// Dr. Venkatesh's explicit ask: "whatever the post, no matter how important it is to run the
// hospital, if it's out of NCISM compliance it should be [tracked separately]... it's better to
// keep a separate page to list them" -- a clean two-category model (NCISM Compliance Staff vs.
// Organisation Staff) so a super_admin checking in always has an unambiguous picture of where
// the org stands. See _collectOrganisationStaff()'s own comment (ncismStaffCompliance.js) for
// the full reasoning on what counts as "beyond the minimum" here.
import { requireAuth, getCurrentProfile, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { logAudit } from '../core/auditLogger.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType } from '../config/ncism.js';
import {
  buildDeptTree, _computeIpdBedTotals, _computeGrandCompliance, _collectOrganisationStaff,
} from '../config/ncismStaffCompliance.js';

await requireAuth(['super_admin','dept_admin'], 'index.html');
const profile = getCurrentProfile();
const tenantId = getCurrentTenantId();
const tenant = getCurrentTenant() || {};
initNavbar();
wireDelegatedEvents();

// Gated designations can't terminate directly -- same rule admin.js's Extra Staff tab
// enforces, re-checked server-side inside terminate_staff() itself regardless.
const GATED_APPROVAL_DESIGS = ['medical_director','principal','medical_superintendent'];
function _isGatedForApproval(){ return GATED_APPROVAL_DESIGS.includes(profile?.designation); }

function _esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function _toast(msg,isError=false){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.style.background=isError?'#7f1d1d':'#1c2b1f';
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),3000);
}

let _deptSelOptsHtml = '<option value="">— No Department —</option>';

async function render(){
  const tableWrap = document.getElementById('table-wrap');
  const statRow = document.getElementById('stat-row');
  const cardSub = document.getElementById('card-sub');

  const [{ data:tRow }, { data:rawStaff }, { data:depts }, { data:opds }, { data:bedsRows }] = await Promise.all([
    supabase.from('tenants').select('ug_intake,type').eq('id',tenantId).single(),
    supabase.from('profiles').select('id,full_name,designation,department_id').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('departments').select('id,name,ncism_code,category,parent_department_id,is_pg_dept,pg_seats_sanctioned').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('opds').select('id,name,ncism_code').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('beds').select('department_id').eq('tenant_id',tenantId),
  ]);

  _deptSelOptsHtml = '<option value="">— No Department —</option>'
    + [...(depts||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(d=>`<option value="${_esc(d.id)}">${_esc(d.name)}</option>`).join('');

  if (!isNCISMType(tRow?.type)) {
    statRow.innerHTML = '';
    tableWrap.innerHTML = '<div class="empty"><div class="empty-ico">ℹ</div><div class="empty-ttl">Organisation Staff tracking (beyond the NCISM minimum) only applies to Teaching Hospital / College tenants — this organisation is registered as "'+_esc(tRow?.type||'unknown')+'".</div></div>';
    cardSub.textContent = '';
    return;
  }
  const ugRaw = tRow?.ug_intake || 0;
  const ug = [60,100,150,200].includes(ugRaw) ? ugRaw : (ugRaw>=150?150:ugRaw>=100?100:ugRaw>0?60:0);
  if (!ug) {
    tableWrap.innerHTML = '<div class="empty"><div class="empty-ico">ℹ</div><div class="empty-ttl">Applies to Teaching Hospitals and Colleges with UG intake configured.</div></div>';
    cardSub.textContent = '';
    return;
  }

  const bedTotals = _computeIpdBedTotals(depts, bedsRows);
  const byDept = {};
  (rawStaff||[]).forEach(s=>{ if(!s.department_id) return; (byDept[s.department_id]=byDept[s.department_id]||[]).push(s); });
  const cntDeptD = (deptId,keys)=>(byDept[deptId]||[]).filter(s=>(keys||[]).includes(s.designation)).length;
  const tree = buildDeptTree(depts||[], opds||[]);
  const { grandReq, grandMet } = _computeGrandCompliance(tree, ug, bedTotals, cntDeptD);
  const deptNameById = {}; (depts||[]).forEach(d=>{ deptNameById[d.id]=d.name; });

  const list = _collectOrganisationStaff(tree, ug, bedTotals, byDept, rawStaff, deptNameById);
  const orgStaffTotal = list.reduce((s,r)=>s+r.extra,0);
  const totalActiveStaff = (rawStaff||[]).length;
  const ncismCompliant = Math.min(grandMet, grandReq);

  statRow.innerHTML =
    '<div class="stat"><div class="stat-label">👥 Total Organisation Staff</div><div class="stat-val">'+totalActiveStaff+'</div></div>'
    +'<div class="stat"><div class="stat-label">✅ NCISM Compliance Staff</div><div class="stat-val">'+ncismCompliant+' / '+grandReq+'</div><div class="stat-sub">Filling a real Schedule I/XX post — see <a href="admin.html#hr:ncism">NCISM Requirements</a></div></div>'
    +'<div class="stat gold"><div class="stat-label">🏢 Organisation Staff (below)</div><div class="stat-val">'+orgStaffTotal+'</div><div class="stat-sub">Real employees, beyond the strict minimum</div></div>';

  cardSub.textContent = totalActiveStaff+' total staff · '+ncismCompliant+' count toward NCISM · '+orgStaffTotal+' listed below';

  if (!list.length){
    tableWrap.innerHTML = '<div class="empty"><div class="empty-ico">✅</div><div class="empty-ttl">Every active staff member is currently counted toward the NCISM minimum. Nothing to list here.</div></div>';
    return;
  }

  const rows = list.map(r=>{
    const staffHtml = (r.staff||[]).map(s=>{
      const hasDesignation = !!(r.keys && r.keys.length);
      // No-designation accounts (e.g. a platform/admin login) aren't a recruited staff post at
      // all -- offering Depute/Terminate there would be actively wrong (could be the org's own
      // Super Admin account). Shown read-only instead, with a pointer to where they're actually
      // managed.
      const actions = hasDesignation
        ? '<button class="btn-outline" data-onclick="openDeputeModal" data-onclick-a0="'+_esc(s.id)+'" data-onclick-a1="'+_esc(s.full_name||'this staff member')+'" data-onclick-a2="'+_esc(r.deptId||'')+'">🔄 Depute</button>'
          +'<button class="btn-danger-outline" data-onclick="openTerminateModal" data-onclick-a0="'+_esc(s.id)+'" data-onclick-a1="'+_esc(s.full_name||'this staff member')+'">🗑 Terminate</button>'
        : '<span style="font-size:10.5px;color:var(--text-muted)">Manage via Admin → HR → Login Access</span>';
      return '<div class="staff-row"><span class="staff-name">'+_esc(s.full_name||'—')+'</span>'+actions+'</div>';
    }).join('') || '<span style="font-size:11px;color:var(--text-muted)">—</span>';
    return '<tr>'
      +'<td>'+_esc(r.deptName||'—')+'</td>'
      +'<td>'+_esc(r.label)+'<div class="reason-text">'+_esc(r.ref)+'</div></td>'
      +'<td style="text-align:center;font-weight:700">'+r.extra+'</td>'
      +'<td>'+staffHtml+'</td>'
      +'</tr>';
  }).join('');

  tableWrap.innerHTML = '<table>'
    +'<thead><tr>'
      +'<th>Department / Where Posted</th>'
      +'<th>Position &amp; Why</th>'
      +'<th style="text-align:center">Count</th>'
      +'<th>Staff / Actions</th>'
    +'</tr></thead><tbody>'+rows+'</tbody></table>';
}

window.openDeputeModal = function(staffId, staffName, currentDeptId){
  document.getElementById('depute-staff-id').value = staffId;
  document.getElementById('depute-staff-name').textContent = staffName;
  const sel = document.getElementById('depute-dept-select');
  sel.innerHTML = _deptSelOptsHtml;
  if (currentDeptId) sel.value = currentDeptId;
  document.getElementById('depute-modal').style.display = 'flex';
};
window.closeDeputeModal = function(){
  document.getElementById('depute-modal').style.display = 'none';
};
window.submitDepute = async function(){
  const staffId = document.getElementById('depute-staff-id').value;
  const staffName = document.getElementById('depute-staff-name').textContent;
  const deptId = document.getElementById('depute-dept-select').value || null;
  const { error } = await supabase.rpc('dept_admin_update_department', { p_staff_id: staffId, p_department_id: deptId });
  if (error) { _toast(safeErrorMessage(error, 'Could not depute staff.'), true); return; }
  await logAudit('depute_organisation_staff', 'profiles', staffId, { staff_name: staffName, department_id: deptId }, {tenantId, userId: profile.id, userName: profile.full_name});
  closeDeputeModal();
  _toast(staffName+' deputed to the new department.');
  render();
};

window.openTerminateModal = function(staffId, staffName){
  document.getElementById('terminate-staff-id').value = staffId;
  document.getElementById('terminate-staff-name').textContent = staffName;
  document.getElementById('terminate-reason').value = '';
  document.getElementById('terminate-modal').style.display = 'flex';
};
window.closeTerminateModal = function(){
  document.getElementById('terminate-modal').style.display = 'none';
};
window.submitTerminate = async function(){
  const staffId = document.getElementById('terminate-staff-id').value;
  const staffName = document.getElementById('terminate-staff-name').textContent;
  const reason = document.getElementById('terminate-reason').value.trim();
  if (!reason) { _toast('A reason for termination is required.', true); return; }

  if (_isGatedForApproval()) {
    if(!confirm(`Submit a request to terminate ${staffName}? This needs sign-off before it takes effect.`)) return;
    const { error } = await supabase.rpc('request_approval', {
      p_action_type: 'staff_terminate', p_payload: { staff_id: staffId, staff_name: staffName, reason }, p_reason: null,
    });
    if (error) { _toast(safeErrorMessage(error, 'Could not submit request.'), true); return; }
    closeTerminateModal();
    _toast('Submitted for approval.');
    return;
  }
  if(!confirm(`Terminate ${staffName}? This revokes their login and removes them from every staffing count in the HMS. Reversible any time from Admin → HR → Terminated Staff.`)) return;
  const { error } = await supabase.rpc('terminate_staff', { p_staff_id: staffId, p_reason: reason });
  if (error) { _toast(safeErrorMessage(error, 'Could not terminate staff.'), true); return; }
  await logAudit('terminate_staff', 'profiles', staffId, { staff_name: staffName, reason }, {tenantId, userId: profile.id, userName: profile.full_name});
  closeTerminateModal();
  _toast(staffName+' terminated.');
  render();
};

render();
