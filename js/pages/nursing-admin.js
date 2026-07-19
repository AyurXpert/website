import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType } from '../config/ncism.js';

await requireAuth(['nurse_manager', 'super_admin', 'dept_admin']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

// Session 112: nursing-scoped leave list -- deliberately NOT hr.html's tenant-wide,
// all-roles pending-leave list (that would expose every other department's staff's
// personal leave/rejection reasons to a nursing-scoped role). Same designation set used
// throughout this session's nursing work.
const NURSING_DESIGNATIONS = ['staff_nurse', 'ward_sister', 'anm'];
const NURSING_LABELS = { staff_nurse: 'Staff Nurse', ward_sister: 'Ward Sister', anm: 'ANM' };

let _rejectingLeaveId = null;

// ── Nursing Staff Leave Requests (Session 112) ──────────────────────
// Reuses hr.js's exact approveLeave()/confirmReject() Supabase-update pattern, scoped to
// nursing-designation staff only.
async function loadNursingLeaves() {
  const el = document.getElementById('leave-list');

  const { data: nursingStaff } = await supabase
    .from('profiles')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('designation', NURSING_DESIGNATIONS);
  const nursingIds = (nursingStaff || []).map(s => s.id);

  if (!nursingIds.length) {
    el.innerHTML = '<div class="empty">No nursing staff (Staff Nurse / Ward Sister / ANM designation) found yet.</div>';
    return;
  }

  const { data: leaves, error } = await supabase
    .from('staff_leaves')
    .select('*, profiles!profile_id(full_name, designation)')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .in('profile_id', nursingIds)
    .order('created_at', { ascending: false });

  if (error) { el.innerHTML = `<div class="empty">${_esc(safeErrorMessage(error, 'Could not load leave requests.'))}</div>`; return; }

  if (!leaves?.length) {
    el.innerHTML = '<div class="empty">No pending leave requests from nursing staff.</div>';
    return;
  }

  el.innerHTML = leaves.map(l => {
    const days = _leaveDays(l.from_date, l.to_date);
    const desigLabel = NURSING_LABELS[l.profiles?.designation] || l.profiles?.designation || '—';
    return `<div class="leave-card">
      <div class="lc-top">
        <div>
          <div class="lc-name">${_esc(l.profiles?.full_name || '—')} <span style="font-weight:400;color:var(--text-muted)">(${_esc(desigLabel)})</span></div>
          <div class="lc-meta">Applied ${_esc((l.created_at || '').slice(0, 10))}</div>
        </div>
        <span class="badge" style="background:var(--gold-light);color:#7a5a10">${_esc(l.leave_type || 'leave')}</span>
      </div>
      <div class="lc-dates">📅 ${_esc(l.from_date)} → ${_esc(l.to_date)} · ${days} day${days > 1 ? 's' : ''}</div>
      ${l.reason ? `<div class="lc-reason">"${_esc(l.reason)}"</div>` : ''}
      <div class="lc-actions">
        <button class="btn btn-approve btn-sm" data-onclick="approveLeave" data-onclick-a0="${l.id}">✓ Approve</button>
        <button class="btn btn-reject btn-sm" data-onclick="openRejectModal" data-onclick-a0="${l.id}">✗ Reject</button>
      </div>
    </div>`;
  }).join('');
}

function _leaveDays(from, to) {
  if (!from || !to) return 1;
  return Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
}

window.approveLeave = async function(id) {
  const { error } = await supabase.from('staff_leaves').update({
    status: 'approved', approved_by: profile.id, approved_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) { alert(safeErrorMessage(error, 'Could not approve. Please try again.')); return; }
  await loadNursingLeaves();
};

window.openRejectModal = function(id) {
  _rejectingLeaveId = id;
  document.getElementById('reject-reason').value = '';
  document.getElementById('reject-modal').classList.add('show');
};
window.closeRejectModal = function() {
  document.getElementById('reject-modal').classList.remove('show');
  _rejectingLeaveId = null;
};
window.confirmReject = async function() {
  const reason = document.getElementById('reject-reason').value.trim();
  if (!reason) { alert('Please enter a reason for rejection.'); return; }
  const { error } = await supabase.from('staff_leaves').update({
    status: 'rejected', approved_by: profile.id, approved_at: new Date().toISOString(),
    rejection_reason: reason,
  }).eq('id', _rejectingLeaveId);
  if (error) { alert(safeErrorMessage(error, 'Could not reject. Please try again.')); return; }
  closeRejectModal();
  await loadNursingLeaves();
};

// ── Nursing Compliance Snapshot (Session 112) ───────────────────────
// Required-vs-recruited by designation (reuses admin.js's designation-based Schedule XX
// counting approach, NOT ncism-compliance.js's role-based one -- the nursing-relevant
// subset only) + a live duty_roster on-duty-today count per department, which doesn't
// exist anywhere else in the app.
const NURSING_XX_ROWS = [
  ['Matron / Nursing Superintendent', ['nursing_superintendent'], { 60: 1, 100: 1, 150: 1, 200: 1 }, 'Sch XX/7'],
  ['Assistant Matron', ['deputy_nursing_superintendent'], { 60: 2, 100: 3, 150: 4, 200: 5 }, 'Sch XX/8'],
  ['Nursing Staff — All OPDs', ['staff_nurse', 'ward_sister'], { 60: 3, 100: 3, 150: 3, 200: 5 }, 'Sch XX/20'],
  ['Nursing Staff — Medical IPD (1 per 10 beds)', ['staff_nurse', 'ward_sister'], { 60: 4, 100: 6, 150: 9, 200: 12 }, 'Sch XX/32'],
  ['Nursing Staff — Surgical IPD (1 per 10 beds)', ['staff_nurse', 'ward_sister'], { 60: 3, 100: 4, 150: 6, 200: 8 }, 'Sch XX/35'],
  ['PK Nursing Staff', ['staff_nurse'], { 60: 1, 100: 1, 150: 2, 200: 2 }, 'Sch XX/38'],
  ['OT Nursing Staff', ['staff_nurse'], { 60: 1, 100: 2, 150: 3, 200: 4 }, 'Sch XX/43'],
  ['Nursing Staff — Labour Room (3 shifts)', ['staff_nurse', 'ward_sister'], { 60: 3, 100: 3, 150: 6, 200: 6 }, 'Sch XX/46'],
];

async function loadComplianceSnapshot() {
  const grid = document.getElementById('snap-grid');
  const sub = document.getElementById('snap-sub');

  const [{ data: tRow }, { data: allStaff }, { data: depts }] = await Promise.all([
    supabase.from('tenants').select('type,ug_intake').eq('id', tenantId).single(),
    supabase.from('profiles').select('id,designation').eq('tenant_id', tenantId).eq('is_active', true),
    supabase.from('departments').select('id,name').eq('tenant_id', tenantId).eq('is_active', true),
  ]);

  const recruitedByDesig = {};
  (allStaff || []).forEach(s => { if (s.designation) recruitedByDesig[s.designation] = (recruitedByDesig[s.designation] || 0) + 1; });

  let ladderHtml = '';
  if (isNCISMType(tRow?.type) && tRow?.ug_intake) {
    const ugRaw = tRow.ug_intake;
    const ug = [60, 100, 150, 200].includes(ugRaw) ? ugRaw : (ugRaw >= 150 ? 150 : ugRaw >= 100 ? 100 : ugRaw > 0 ? 60 : 0);
    sub.textContent = `UG Intake: ${ug} · Required vs recruited (tenant-wide) + who's actually on duty today, by department`;
    ladderHtml = NURSING_XX_ROWS.map(([label, keys, req, ref]) => {
      const total = req[ug] || 0;
      const recruited = keys.reduce((sum, k) => sum + (recruitedByDesig[k] || 0), 0);
      const gap = Math.max(0, total - recruited);
      const cls = recruited >= total && total > 0 ? 'snap-ok' : recruited > 0 ? 'snap-warn' : 'snap-deficit';
      const icon = recruited >= total && total > 0 ? '✅' : recruited > 0 ? '⚠️' : '❌';
      return `<div class="snap-card">
        <div class="snap-dept">${_esc(label)}</div>
        <div style="font-size:10.5px;color:var(--text-muted)">${_esc(ref)}</div>
        <div class="snap-row"><span>Required</span><strong>${total}</strong></div>
        <div class="snap-row"><span>Recruited</span><strong class="${cls}">${recruited} ${icon}</strong></div>
        ${gap > 0 ? `<div class="snap-row snap-deficit"><span>Gap</span><strong>−${gap}</strong></div>` : ''}
      </div>`;
    }).join('');
  } else {
    sub.textContent = 'Who\'s actually on duty today, by department (UG-intake-based requirements only apply to Teaching Hospital / College tenants)';
  }

  // Live on-duty-today count, any tenant type -- who's actually covering the floor right now.
  const today = new Date().toISOString().slice(0, 10);
  const nursingIds = new Set((allStaff || []).filter(s => NURSING_DESIGNATIONS.includes(s.designation)).map(s => s.id));
  const { data: rosterToday } = await supabase
    .from('duty_roster')
    .select('department_id, profile_id')
    .eq('tenant_id', tenantId)
    .eq('shift_date', today)
    .in('profile_id', [...nursingIds]);

  const onDutyByDept = {};
  (rosterToday || []).forEach(r => { onDutyByDept[r.department_id] = (onDutyByDept[r.department_id] || 0) + 1; });
  const deptMap = {}; (depts || []).forEach(d => { deptMap[d.id] = d.name; });

  const onDutyHtml = Object.keys(onDutyByDept).length
    ? Object.entries(onDutyByDept).map(([deptId, count]) =>
        `<div class="snap-card"><div class="snap-dept">${_esc(deptMap[deptId] || 'Unknown department')}</div>
         <div class="snap-row"><span>On duty today</span><strong class="snap-ok">${count}</strong></div></div>`
      ).join('')
    : '<div class="empty">No nursing staff rostered for today yet.</div>';

  grid.innerHTML = ladderHtml + '<div style="grid-column:1/-1;font-size:11px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 4px">🔴 On Duty Today, By Department</div>' + onDutyHtml;
}

await loadNursingLeaves();
await loadComplianceSnapshot();
