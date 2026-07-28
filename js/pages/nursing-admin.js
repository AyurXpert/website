import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType } from '../config/ncism.js';
import { resolveNursingHeadship, canActAsNursingHead, canDecideShiftChange } from '../modules/roster/nursingHeadship.js';

await requireAuth(['nurse_manager', 'super_admin', 'dept_admin']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const role     = profile?.role;

// Session 112: nursing-scoped leave list -- deliberately NOT hr.html's tenant-wide,
// all-roles pending-leave list (that would expose every other department's staff's
// personal leave/rejection reasons to a nursing-scoped role). Same designation set used
// throughout this session's nursing work.
const NURSING_DESIGNATIONS = ['staff_nurse', 'ward_sister', 'anm'];
const NURSING_LABELS = { staff_nurse: 'Staff Nurse', ward_sister: 'Ward Sister', anm: 'ANM' };

let _rejectingLeaveId = null;

// ── Shift Change Requests (Nursing Duty Roster Phase 4, Session 140) ─
// Individual requests to change a SPECIFIC already-assigned shift --
// distinct from the generic multi-day leave list below (a shift-change
// request is a staff_leaves row with related_duty_roster_id set). Decided
// by the resolved Nursing Head only -- deliberately narrower than every
// other gate in this feature (canDecideShiftChange excludes MD/Principal/
// MS, unlike canActAsNursingHead), per the original design note.
async function loadShiftChangeRequests() {
  const el = document.getElementById('shift-change-list');
  const headship = await resolveNursingHeadship(supabase, tenantId);
  const canDecide = canDecideShiftChange(headship, profile.id, role);

  const { data, error } = await supabase.from('staff_leaves')
    .select('id,reason,requested_at:created_at,requester:profiles!staff_leaves_profile_id_fkey(full_name),covering:profiles!staff_leaves_covering_profile_id_fkey(full_name),duty_roster!related_duty_roster_id(shift_date,shift_type,departments(name))')
    .eq('tenant_id', tenantId).eq('status', 'pending').not('related_duty_roster_id', 'is', null)
    .order('created_at', { ascending: false });

  if (error) { el.innerHTML = `<div class="empty">${_esc(safeErrorMessage(error, 'Could not load shift-change requests.'))}</div>`; return; }

  if (!data?.length) { el.innerHTML = '<div class="empty">No pending shift-change requests.</div>'; return; }

  const SHIFT_LABELS = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night', on_call: 'On-Call' };

  el.innerHTML = data.map(r => {
    const shift = r.duty_roster;
    const shiftLabel = shift ? `${SHIFT_LABELS[shift.shift_type] || shift.shift_type} · ${_esc((shift.shift_date || '').slice(0, 10))}${shift.departments?.name ? ' · ' + _esc(shift.departments.name) : ''}` : '—';
    return `<div class="leave-card">
      <div class="lc-top">
        <div>
          <div class="lc-name">${_esc(r.requester?.full_name || '—')}</div>
          <div class="lc-meta">${shiftLabel}</div>
        </div>
      </div>
      ${r.covering?.full_name ? `<div class="lc-dates">👤 Proposed covering: ${_esc(r.covering.full_name)}</div>` : `<div class="lc-dates">⚠ No covering colleague proposed -- will be marked unassigned if approved</div>`}
      ${r.reason ? `<div class="lc-reason">"${_esc(r.reason)}"</div>` : ''}
      ${canDecide ? `<div class="lc-actions">
        <button class="btn btn-approve btn-sm" data-onclick="decideShiftChange" data-onclick-a0="${r.id}" data-onclick-a1="@true">✓ Approve</button>
        <button class="btn btn-reject btn-sm" data-onclick="decideShiftChange" data-onclick-a0="${r.id}" data-onclick-a1="@false">✗ Reject</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

window.decideShiftChange = async function(leaveId, approve) {
  const notes = approve ? null : (prompt('Reason for rejecting (optional):') || null);
  const { error } = await supabase.rpc('decide_shift_change_request', { p_leave_id: leaveId, p_approve: approve, p_notes: notes });
  if (error) { alert(safeErrorMessage(error, 'Could not decide this request.')); return; }
  await loadShiftChangeRequests();
};

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

// ── Nursing Head delegation (Session 137) ───────────────────────────
// Default head = whoever holds the nursing_superintendent designation;
// tenants.nursing_head_delegate_id is an explicit override, set/cleared via
// the update_nursing_head_delegate RPC (tenants' own RLS blocks a direct
// .update() from anyone but super_admin -- same RLS-too-narrow bug class as
// Session 120's profiles fix). Shared resolution logic with roster.js, so
// write-access gating there can never disagree with what's shown here.
async function loadHeadship() {
  const body = document.getElementById('headship-body');
  const headship = await resolveNursingHeadship(supabase, tenantId);
  const canAct = canActAsNursingHead(headship, profile.id, role, profile.designation);

  if (!headship.defaultHead) {
    body.innerHTML = '<div class="empty">No staff with the Nursing Superintendent designation found yet -- assign one via HR → All Staff before headship delegation can work.</div>';
    return;
  }

  const chip = (p, tag) => p ? `<span class="badge" style="background:var(--green-light);color:var(--green-deep);font-weight:600">${_esc(p.full_name)}${tag ? ' — '+tag : ''}</span>` : '';

  let html = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">'
    + '<span style="font-size:12.5px;color:var(--text-muted)">Currently editing:</span>'
    + chip(headship.effectiveHead, headship.delegate ? 'acting head' : 'default')
    + '</div>';

  if (canAct) {
    if (headship.delegate) {
      html += `<button class="btn btn-reject btn-sm" data-onclick="resetNursingHeadship">↺ Reset to ${_esc(headship.defaultHead.full_name)} (default)</button>`;
    } else {
      const deputies = headship.candidates.filter(c => c.designation === 'deputy_nursing_superintendent');
      if (deputies.length) {
        html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<span style="font-size:12.5px;color:var(--text-muted)">Delegate to (e.g. while on leave):</span>'
          + '<select id="delegate-select" style="height:32px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12.5px">'
          + deputies.map(d => `<option value="${_esc(d.id)}">${_esc(d.full_name)}</option>`).join('')
          + '</select>'
          + '<button class="btn btn-primary btn-sm" data-onclick="delegateNursingHeadship">Delegate</button>'
          + '</div>';
      } else {
        html += '<div class="empty">No Deputy Nursing Superintendents on record to delegate to.</div>';
      }
    }
  } else {
    html += '<div class="empty">Only the current head, Medical Director/Principal/Medical Superintendent, or super_admin can change this.</div>';
  }

  body.innerHTML = html;
}

window.delegateNursingHeadship = async function() {
  const sel = document.getElementById('delegate-select');
  const delegateId = sel?.value;
  const delegateName = sel?.options[sel.selectedIndex]?.textContent;
  if (!delegateId) return;
  if (!confirm(`Delegate nursing headship to ${delegateName}? They'll get full duty-roster edit access; you'll be read-only until this is reset back.`)) return;
  const { error } = await supabase.rpc('update_nursing_head_delegate', { p_delegate_id: delegateId });
  if (error) { alert(safeErrorMessage(error, 'Could not delegate headship.')); return; }
  await loadHeadship();
};

window.resetNursingHeadship = async function() {
  if (!confirm('Reset nursing headship back to the default (Nursing Superintendent)?')) return;
  const { error } = await supabase.rpc('update_nursing_head_delegate', { p_delegate_id: null });
  if (error) { alert(safeErrorMessage(error, 'Could not reset headship.')); return; }
  await loadHeadship();
};

// ── Roster Cycle (Nursing Duty Roster Phase 2, Session 138) ─────────
// Nursing Head proposes weekly/fortnightly/monthly; MS/Deputy MS (or
// super_admin) approves via the same pending_approvals maker-checker
// mechanism Session 128 used for the intern rotation roster. The RPC
// re-derives "is this caller really the current head" server-side (mirrors
// nursingHeadship.js's own resolution) -- this page's canAct check below is
// only a display hint, same as everywhere else this pattern is used.
const CYCLE_LABELS = { weekly: 'Weekly (7 days)', fortnightly: 'Fortnightly (14 days)', monthly: 'Monthly (30 days)' };

async function loadRosterCycle() {
  const body = document.getElementById('cycle-body');
  const headship = await resolveNursingHeadship(supabase, tenantId);
  const canAct = canActAsNursingHead(headship, profile.id, role, profile.designation);

  const [{ data: setting }, { data: pending }] = await Promise.all([
    supabase.from('nursing_roster_settings').select('cycle').eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('pending_approvals')
      .select('id,payload,requested_at,requester:profiles!requested_by(full_name)')
      .eq('tenant_id', tenantId).eq('action_type', 'nursing_roster_cycle').eq('status', 'pending')
      .order('requested_at', { ascending: false }).limit(1),
  ]);

  const currentCycle = setting?.cycle || 'weekly';
  const pendingReq = pending?.[0] || null;

  let html = `<div style="margin-bottom:10px"><span style="font-size:12.5px;color:var(--text-muted)">Current cycle:</span> `
    + `<span class="badge" style="background:var(--green-light);color:var(--green-deep);font-weight:600">${_esc(CYCLE_LABELS[currentCycle] || currentCycle)}</span></div>`;

  if (pendingReq) {
    const reqCycle = pendingReq.payload?.cycle;
    html += `<div class="empty">⏳ Change to <strong>${_esc(CYCLE_LABELS[reqCycle] || reqCycle)}</strong> requested by ${_esc(pendingReq.requester?.full_name || '—')} on ${_esc((pendingReq.requested_at || '').slice(0, 10))} -- awaiting Medical Superintendent / Deputy MS approval.</div>`;
  } else if (canAct) {
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<select id="cycle-select" style="height:32px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12.5px">'
      + Object.entries(CYCLE_LABELS).map(([v, l]) => `<option value="${v}" ${v === currentCycle ? 'selected' : ''}>${_esc(l)}</option>`).join('')
      + '</select>'
      + '<button class="btn btn-primary btn-sm" data-onclick="requestRosterCycleChange">Request Change</button>'
      + '</div>';
  } else {
    html += '<div class="empty">Only the current Nursing Head can request a cycle change.</div>';
  }

  body.innerHTML = html;
}

window.requestRosterCycleChange = async function() {
  const sel = document.getElementById('cycle-select');
  const cycle = sel?.value;
  if (!cycle) return;
  const { error } = await supabase.rpc('request_nursing_roster_cycle', { p_cycle: cycle });
  if (error) { alert(safeErrorMessage(error, 'Could not submit the roster-cycle change request.')); return; }
  await loadRosterCycle();
};

await loadHeadship();
await loadShiftChangeRequests();
await loadNursingLeaves();
await loadComplianceSnapshot();
await loadRosterCycle();
