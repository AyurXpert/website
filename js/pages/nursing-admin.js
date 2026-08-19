import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType, isNursingDutyDept, shiftsForDept, NURSING_GENERAL_DUTY_CODES, NURSING_GENERAL_DUTY_NAMES } from '../config/ncism.js';
import { resolveNursingHeadship, canActAsNursingHead, canDecideShiftChange } from '../modules/roster/nursingHeadship.js';
import { computeRequiredPerShift, distributeAcrossShifts, buildRequiredMatrix } from '../modules/roster/requiredStaffing.js';
import { checkCycleExpiry } from '../modules/roster/cycleExpiry.js';
import { findUncoveredAbsences } from '../modules/roster/coverageGaps.js';
import { _computeIpdBedTotals, _combinedIpdNursingSplit } from '../config/ncismStaffCompliance.js';
import { NURSING_ELIGIBLE_DESIGNATIONS } from '../modules/roster/coverageCapacity.js';

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

// Session 167: real bug found live (Dr. Venkatesh, cycle-expiry banner naming "Diagnostics" as
// needing the next roster cycle generated, despite it having been dropped from every other
// nursing-duty department list back in Session 166 Part 6 -- zero real Sch XX nursing post since
// the 2026-27 MESA&R circular removed it). isNursingDutyDept() alone only checks whether a
// department is one of the 9 real nursing-duty PLACES, not whether it currently has any real
// requirement -- roster.js/nursing-roster-template.js already layer buildRequiredMatrix()'s
// "required > 0" check on top of it (_dropZeroRequirementDepts()/loadDepartments()'s
// hasRequirement set) but this page's 4 independent department-list builders (Cycle Expiry,
// Coverage Gap, Department Rotation, Supervision Zones) never got the same treatment -- swept
// all 4, not just the one reported, matching the ladder-wide sweeps this bug class has needed
// before (Session 134's OT Attendants/CSSD Aya double-count). Cached across the 4 call sites --
// the requirement matrix is static config for the life of a page load, not something that
// changes mid-session.
let _hasReqCache = null;
async function _reqDeptIds() {
  if (_hasReqCache) return _hasReqCache;
  const matrix = await buildRequiredMatrix(supabase, tenantId);
  _hasReqCache = new Set();
  matrix.forEach(r => { if (r.required > 0) _hasReqCache.add(r.department_id); });
  return _hasReqCache;
}
async function _loadNursingDutyDepts(cols = 'id,name,ncism_code') {
  const [{ data: allDepts }, hasReq] = await Promise.all([
    supabase.from('departments').select(cols).eq('tenant_id', tenantId).eq('is_active', true).order('name'),
    _reqDeptIds(),
  ]);
  return (allDepts || []).filter(d => isNursingDutyDept(d) && hasReq.has(d.id));
}

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
    .select('id,reason,covering_status,requested_at:created_at,requester:profiles!staff_leaves_profile_id_fkey(full_name),covering:profiles!staff_leaves_covering_profile_id_fkey(full_name),duty_roster!related_duty_roster_id(shift_date,shift_type,departments(name))')
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
      ${r.covering?.full_name ? `<div class="lc-dates">👤 Proposed covering: ${_esc(r.covering.full_name)} ${_coveringStatusBadge(r.covering_status)}${r.covering_status !== 'accepted' ? ' -- will be marked unassigned if approved now' : ''}</div>` : `<div class="lc-dates">⚠ No covering colleague proposed -- will be marked unassigned if approved</div>`}
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
    .select('*, profiles!profile_id(full_name, designation), covering:profiles!covering_profile_id(full_name)')
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
      ${l.covering?.full_name ? `<div class="lc-meta">🤝 Charge given to: <strong>${_esc(l.covering.full_name)}</strong> ${_coveringStatusBadge(l.covering_status)}</div>` : ''}
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

// Session 149: covering_profile_id is only ever actually usable once the
// named colleague has accepted -- see sql/session149_covering_acceptance.sql.
function _coveringStatusBadge(status) {
  if (status === 'accepted') return '<span style="color:var(--green-mid,#2d7a4f);font-weight:600">✓ accepted</span>';
  if (status === 'declined') return '<span style="color:var(--red,#c0392b);font-weight:600">✗ declined</span>';
  if (status === 'pending') return '<span style="color:var(--gold,#c9902a);font-weight:600">⏳ awaiting response</span>';
  return '';
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
// Session 150 (MESA&R UG 2026-27 circular): refs/counts updated to match the replaced
// Schedule XX (see ncismStaffCompliance.js). IPD Nursing is now a single sentinel row --
// req is unused, the real number comes from _combinedIpdNursingSplit (same combined
// bed-derived ratio as admin.js's ladder, reused here so the two pages can't disagree).
const IPD_NURSING_SENTINEL = '__combined_ipd__';
const NURSING_XX_ROWS = [
  ['Matron / Nursing Superintendent', ['nursing_superintendent'], { 60: 1, 100: 1, 150: 1, 200: 1 }, 'Sch XX/4'],
  ['Assistant Matron (day + night shifts)', ['deputy_nursing_superintendent'], { 60: 2, 100: 2, 150: 4, 200: 4 }, 'Sch XX/5'],
  ['Nursing Staff (Atyayika/Shalya/Prasuti, pooled across OPD)', ['staff_nurse', 'ward_sister'], { 60: 3, 100: 3, 150: 3, 200: 5 }, 'Sch XX/18'],
  ['Nursing Staff — Medical + Surgical IPD (combined, 1 per 30 beds + relievers)', ['staff_nurse', 'ward_sister'], IPD_NURSING_SENTINEL, 'Sch XX/27'],
  ['PK Nursing Staff', ['staff_nurse'], { 60: 1, 100: 1, 150: 2, 200: 2 }, 'Sch XX/32'],
  ['OT Nursing Staff', ['staff_nurse'], { 60: 1, 100: 2, 150: 3, 200: 4 }, 'Sch XX/35'],
  ['Nursing Staff — Labour Room (3 shifts)', ['staff_nurse', 'ward_sister'], { 60: 3, 100: 3, 150: 6, 200: 6 }, 'Sch XX/38'],
];

async function loadComplianceSnapshot() {
  const grid = document.getElementById('snap-grid');
  const sub = document.getElementById('snap-sub');

  const [{ data: tRow }, { data: allStaff }, { data: depts }, { data: bedsRows }] = await Promise.all([
    supabase.from('tenants').select('type,ug_intake').eq('id', tenantId).single(),
    supabase.from('profiles').select('id,designation').eq('tenant_id', tenantId).eq('is_active', true),
    supabase.from('departments').select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true),
    supabase.from('beds').select('department_id').eq('tenant_id', tenantId),
  ]);

  const recruitedByDesig = {};
  (allStaff || []).forEach(s => { if (s.designation) recruitedByDesig[s.designation] = (recruitedByDesig[s.designation] || 0) + 1; });
  const ipdBedTotals = _computeIpdBedTotals(depts || [], bedsRows || []);
  const ipdSplit = _combinedIpdNursingSplit(ipdBedTotals);
  const ipdNursingTotal = ipdSplit.IPD_MEDICAL + ipdSplit.IPD_SURGICAL;
  const ipdCombined = ipdBedTotals.IPD_MEDICAL + ipdBedTotals.IPD_SURGICAL;

  let ladderHtml = '';
  if (isNCISMType(tRow?.type) && tRow?.ug_intake) {
    const ugRaw = tRow.ug_intake;
    const ug = [60, 100, 150, 200].includes(ugRaw) ? ugRaw : (ugRaw >= 150 ? 150 : ugRaw >= 100 ? 100 : ugRaw > 0 ? 60 : 0);
    sub.textContent = `UG Intake: ${ug} · Required vs recruited (tenant-wide) + who's actually on duty today, by department`;
    ladderHtml = NURSING_XX_ROWS.map(([label, keys, req, ref]) => {
      const total = req === IPD_NURSING_SENTINEL ? ipdNursingTotal : (req[ug] || 0);
      const recruited = keys.reduce((sum, k) => sum + (recruitedByDesig[k] || 0), 0);
      const gap = Math.max(0, total - recruited);
      const cls = recruited >= total && total > 0 ? 'snap-ok' : recruited > 0 ? 'snap-warn' : 'snap-deficit';
      const icon = recruited >= total && total > 0 ? '✅' : recruited > 0 ? '⚠️' : '❌';
      return `<div class="snap-card">
        <div class="snap-dept">${_esc(label)}</div>
        <div style="font-size:10.5px;color:var(--text-muted)">${_esc(ref)}${req === IPD_NURSING_SENTINEL && ipdCombined ? ` · ${ipdCombined} real beds` : ''}</div>
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

// ── Department Rotation (Session 144) ───────────────────────────────
// Fill All (Fixed Teams, previous session) keeps a nurse in the SAME
// department for a whole cycle -- this is the tenant-wide follow-up:
// moving that nurse to a DIFFERENT department for the NEXT cycle, in a
// fixed sequence Dr. Venkatesh configures once (not random reassignment),
// with an explicit preview the Nursing Head reviews before anything is
// written. "Fixed sequence" = department at position N always hands its
// current occupants to the department at position N+1, wrapping back to
// the first after the last -- a conga line across every configured
// department at once.
const CYCLE_DAYS = { weekly: 7, fortnightly: 14, monthly: 30 };
let _rotationDepts = [];     // all nursing-duty departments {id,name,ncism_code}
let _rotationSequence = [];  // ordered array of department ids (configured, or default = name order)
let _seqDraft = [];          // in-modal working copy while reordering
let _previewSnapshot = null; // computed in previewRotation(), reused by confirmApplyRotation()

async function loadRotationSection() {
  const body = document.getElementById('rotation-body');
  _rotationDepts = await _loadNursingDutyDepts();

  if (_rotationDepts.length < 2) {
    body.innerHTML = '<div class="empty">Need at least 2 nursing-duty departments before a rotation makes sense.</div>';
    return;
  }

  const { data: seqRows } = await supabase.from('nursing_dept_rotation_sequence')
    .select('department_id,seq_order').eq('tenant_id', tenantId).order('seq_order');
  const configuredIds = (seqRows || []).map(r => r.department_id).filter(id => _rotationDepts.some(d => d.id === id));
  _rotationSequence = configuredIds.length === _rotationDepts.length ? configuredIds : _rotationDepts.map(d => d.id);

  const headship = await resolveNursingHeadship(supabase, tenantId);
  const canAct = canActAsNursingHead(headship, profile.id, role, profile.designation);

  const names = _rotationSequence.map(id => _rotationDepts.find(d => d.id === id)?.name || '—');
  let html = `<div style="font-size:12.5px;margin-bottom:10px"><span style="color:var(--text-muted)">Sequence:</span> ${names.map(_esc).join(' → ')} → <em>(back to start)</em></div>`;
  html += canAct
    ? '<button class="btn btn-primary btn-sm" data-onclick="previewRotation">👁️ Preview Next-Cycle Rotation</button>'
    : '<div class="empty">Only the current Nursing Head can run a rotation.</div>';
  body.innerHTML = html;
}

window.openRotationSequenceModal = function() {
  _seqDraft = _rotationSequence.slice();
  _renderSeqList();
  document.getElementById('rotation-seq-modal').classList.add('show');
};
window.closeRotationSequenceModal = function() {
  document.getElementById('rotation-seq-modal').classList.remove('show');
};
function _renderSeqList() {
  const el = document.getElementById('seq-list');
  el.innerHTML = _seqDraft.map((id, i) => {
    const name = _rotationDepts.find(d => d.id === id)?.name || '—';
    return `<div class="seq-row">
      <span class="seq-pos">${i + 1}</span>
      <span class="seq-name">${_esc(name)}</span>
      <div class="seq-arrows">
        <button data-onclick="moveSeqItem" data-onclick-a0="${i}" data-onclick-a1="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-onclick="moveSeqItem" data-onclick-a0="${i}" data-onclick-a1="1" ${i === _seqDraft.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
    </div>`;
  }).join('');
}
window.moveSeqItem = function(index, dir) {
  const i = Number(index), j = i + Number(dir);
  if (j < 0 || j >= _seqDraft.length) return;
  [_seqDraft[i], _seqDraft[j]] = [_seqDraft[j], _seqDraft[i]];
  _renderSeqList();
};
window.saveRotationSequence = async function() {
  const { error } = await supabase.rpc('save_nursing_rotation_sequence', { p_department_ids: _seqDraft });
  if (error) { alert(safeErrorMessage(error, 'Could not save the rotation sequence.')); return; }
  closeRotationSequenceModal();
  await loadRotationSection();
};

// Snapshots every configured department's CURRENT template (unique assigned
// nurses, required headcount) and computes the proposed department-to-
// department moves -- pure read/compute, writes nothing. Cached on
// _previewSnapshot so Confirm reuses the exact numbers the head reviewed,
// rather than silently recomputing (and potentially drifting) at write time.
window.previewRotation = async function() {
  if (_rotationSequence.length < 2) { alert('Need at least 2 departments in the rotation sequence.'); return; }

  const { data: settingRow } = await supabase.from('nursing_roster_settings').select('cycle').eq('tenant_id', tenantId).maybeSingle();
  const tenantCycleDays = CYCLE_DAYS[settingRow?.cycle || 'weekly'];

  const perDept = {};
  for (const dept of _rotationDepts) {
    if (!_rotationSequence.includes(dept.id)) continue;
    const { data: tpl } = await supabase.from('nursing_roster_templates')
      .select('id,cycle_length').eq('tenant_id', tenantId).eq('department_id', dept.id).maybeSingle();
    let uniqueNurses = [];
    if (tpl) {
      const { data: slots } = await supabase.from('nursing_roster_template_slots')
        .select('profile_id,profiles(full_name)').eq('template_id', tpl.id);
      const seen = new Map();
      (slots || []).forEach(s => { if (s.profile_id && !seen.has(s.profile_id)) seen.set(s.profile_id, s.profiles?.full_name || '—'); });
      uniqueNurses = [...seen.entries()].map(([id, name]) => ({ id, name }));
    }
    const requiredPerShift = await computeRequiredPerShift(supabase, tenantId, dept.name);
    const shifts = shiftsForDept(dept);
    // Real bug found on SDM: this used to multiply a per-shift count by the
    // shift count to get a "total" -- but requiredPerShift.total (bed-
    // derived or Sch. XX intake-tier) IS ALREADY the real NCISM total, not a
    // per-shift figure. Multiplying by shifts.length was demanding 3x more
    // nurses than NCISM actually requires (e.g. Medical In-Patients' real
    // total of 6 was being inflated to 18).
    const requiredTotal = requiredPerShift ? requiredPerShift.total : shifts.length;
    perDept[dept.id] = {
      template: tpl || null, cycleLength: tpl?.cycle_length || tenantCycleDays,
      uniqueNurses, requiredPerShift, shifts, requiredTotal,
    };
  }

  const seq = _rotationSequence;
  const moves = [];
  seq.forEach((deptId, i) => {
    const toId = seq[(i + 1) % seq.length];
    const toName = _rotationDepts.find(d => d.id === toId)?.name || '—';
    const fromName = _rotationDepts.find(d => d.id === deptId)?.name || '—';
    (perDept[deptId].uniqueNurses || []).forEach(n => {
      moves.push({ profileId: n.id, name: n.name, fromName, toDeptId: toId, toName });
    });
  });

  const deptStatus = seq.map(deptId => {
    const incoming = moves.filter(m => m.toDeptId === deptId).length;
    const required = perDept[deptId].requiredTotal;
    const name = _rotationDepts.find(d => d.id === deptId)?.name || '—';
    const status = (incoming === 0 && required > 0) ? 'none' : incoming < required ? 'short' : incoming > required ? 'surplus' : 'ok';
    return { deptId, name, incoming, required, status };
  });

  _previewSnapshot = { perDept, seq, moves };
  _renderPreview(deptStatus);
  document.getElementById('rotation-preview-modal').classList.add('show');
};

function _renderPreview(deptStatus) {
  const el = document.getElementById('preview-body');
  const { moves } = _previewSnapshot;

  const statusLabel = d => d.status === 'ok' ? '✓ matches required'
    : d.status === 'surplus' ? `⚠ ${d.incoming - d.required} more than required -- extra staff won't be auto-placed`
    : d.status === 'none' ? '❌ no incoming nurses'
    : `❌ short by ${d.required - d.incoming} -- those seats will stay unassigned`;
  const statusClass = d => d.status === 'ok' ? '' : d.status === 'surplus' ? 'move-warn' : 'move-deficit';

  let html = '<div style="font-size:11px;font-weight:700;color:var(--green-deep);text-transform:uppercase;margin-bottom:6px">Department Headcount After Rotation</div>';
  html += deptStatus.map(d => `<div class="move-row"><span>${_esc(d.name)}</span><span class="${statusClass(d)}">${d.incoming} incoming / ${d.required} required — ${statusLabel(d)}</span></div>`).join('');

  html += '<div style="font-size:11px;font-weight:700;color:var(--green-deep);text-transform:uppercase;margin:14px 0 6px">Proposed Moves</div>';
  html += moves.length
    ? moves.map(m => `<div class="move-row"><span>${_esc(m.name)}</span><span>${_esc(m.fromName)} → ${_esc(m.toName)}</span></div>`).join('')
    : '<div class="empty">No department currently has an assigned nurse to rotate -- run Fill All (Fixed Teams) on at least one department first.</div>';

  el.innerHTML = html;
  document.getElementById('btn-confirm-rotation').style.display = moves.length ? '' : 'none';
}

window.closeRotationPreviewModal = function() {
  document.getElementById('rotation-preview-modal').classList.remove('show');
  _previewSnapshot = null;
};

// Applies exactly what was previewed: for every department in the sequence,
// clears its CURRENT template slots entirely, then refills from its
// incoming nurse group only (the previous department's outgoing occupants).
// Deliberately does NOT wrap around to reuse an incoming nurse across
// several seats within the same department when the group is smaller than
// required -- unlike Fill All's tenant-wide-pool wraparound (fine there,
// small-pool testing convenience), reusing one rotating nurse into two
// CONCURRENT seats here would silently claim one person can cover two beds/
// shifts at once. A shortfall is left as a genuine gap instead, matching
// what the preview already told the head to expect.
window.confirmApplyRotation = async function() {
  if (!_previewSnapshot || !_previewSnapshot.moves.length) return;
  if (!confirm('This replaces the current template for every department in the rotation sequence. Continue?')) return;

  const btn = document.getElementById('btn-confirm-rotation');
  btn.disabled = true; btn.textContent = 'Applying…';

  const { perDept, seq, moves } = _previewSnapshot;

  for (const deptId of seq) {
    const info = perDept[deptId];

    if (info.template) {
      const { data: existingSlots } = await supabase.from('nursing_roster_template_slots')
        .select('id').eq('template_id', info.template.id);
      for (const s of (existingSlots || [])) {
        await supabase.rpc('delete_nursing_roster_template_slot', { p_slot_id: s.id });
      }
    }

    const incomingIds = moves.filter(m => m.toDeptId === deptId).map(m => m.profileId);
    if (!incomingIds.length) continue;

    const requiredPerShift = info.requiredPerShift;
    let poolIdx = 0;

    if (requiredPerShift?.mode === 'opd') {
      for (let z = 0; z < requiredPerShift.groups.length && poolIdx < incomingIds.length; z++) {
        const nurseId = incomingIds[poolIdx]; poolIdx++;
        for (let day = 0; day < info.cycleLength; day++) {
          await supabase.rpc('save_nursing_roster_template_slot', {
            p_department_id: deptId, p_day_offset: day, p_shift_type: 'general', p_slot_index: z + 1,
            p_profile_id: nurseId, p_bed_range_start: null, p_bed_range_end: null, p_coverage_label: requiredPerShift.groups[z],
          });
        }
      }
    } else {
      const perShiftByType = requiredPerShift ? distributeAcrossShifts(requiredPerShift.total, info.shifts) : {};
      outer:
      for (const shift of info.shifts) {
        const perShiftCount = requiredPerShift ? (perShiftByType[shift] ?? 0) : 1;
        for (let slotIndex = 1; slotIndex <= perShiftCount; slotIndex++) {
          if (poolIdx >= incomingIds.length) break outer;
          const nurseId = incomingIds[poolIdx]; poolIdx++;
          let bedStart = null, bedEnd = null;
          if (requiredPerShift?.mode === 'bed') {
            const blockSize = Math.ceil(requiredPerShift.bedCount / perShiftCount);
            bedStart = (slotIndex - 1) * blockSize + 1;
            bedEnd = Math.min(slotIndex * blockSize, requiredPerShift.bedCount);
          }
          for (let day = 0; day < info.cycleLength; day++) {
            await supabase.rpc('save_nursing_roster_template_slot', {
              p_department_id: deptId, p_day_offset: day, p_shift_type: shift, p_slot_index: slotIndex,
              p_profile_id: nurseId, p_bed_range_start: bedStart, p_bed_range_end: bedEnd, p_coverage_label: null,
            });
          }
        }
      }
    }
  }

  btn.disabled = false; btn.textContent = '✅ Confirm & Apply Rotation';
  closeRotationPreviewModal();
  alert('Rotation applied. Remember to click Generate Next Cycle on nursing-roster-template.html for each department to stamp these into the real dated roster.');
  await loadRotationSection();
};

// ── Nursing Supervision Zones (Session 147) ─────────────────────────
// On-ground duty MONITORING only (view + attendance-marking on roster.
// html's new tab) -- deliberately NOT a scheduling/editing delegation,
// which stays with whoever the resolved Nursing Head is (unchanged).
// Group count is dynamic: however many active nursing_superintendent/
// deputy_nursing_superintendent profiles exist at this tenant, that's how
// many candidates the Matron can assign a department to -- not hardcoded
// to a fixed "4 groups".
let _zoneDepts = [];       // nursing-duty departments {id,name}
let _zoneCandidates = [];  // active nursing_superintendent/deputy_nursing_superintendent profiles
let _zoneAssignments = {}; // department_id -> profile_id (current)

async function loadSupervisionZones() {
  const body = document.getElementById('zones-body');
  _zoneDepts = await _loadNursingDutyDepts('id,name');

  const { data: candidates } = await supabase.from('profiles')
    .select('id,full_name,designation').eq('tenant_id', tenantId).eq('is_active', true)
    .in('designation', ['nursing_superintendent', 'deputy_nursing_superintendent']).order('full_name');
  _zoneCandidates = candidates || [];

  const { data: assignRows } = await supabase.from('nursing_zone_assignments')
    .select('department_id,profile_id').eq('tenant_id', tenantId);
  _zoneAssignments = {};
  (assignRows || []).forEach(r => { _zoneAssignments[r.department_id] = r.profile_id; });

  const headship = await resolveNursingHeadship(supabase, tenantId);
  const canAct = canActAsNursingHead(headship, profile.id, role, profile.designation);
  document.getElementById('zones-edit-btn').style.display = canAct ? '' : 'none';

  if (!_zoneCandidates.length) {
    body.innerHTML = '<div class="empty">No staff with Nursing Superintendent/Assistant Matron designation found yet.</div>';
    return;
  }
  if (!_zoneDepts.length) {
    body.innerHTML = '<div class="empty">No nursing-duty departments found yet.</div>';
    return;
  }

  body.innerHTML = _zoneDepts.map(d => {
    const assignedId = _zoneAssignments[d.id];
    const person = assignedId ? _zoneCandidates.find(c => c.id === assignedId) : null;
    return `<div class="move-row"><span>${_esc(d.name)}</span><span>${person ? _esc(person.full_name) : '<em style="color:var(--text-muted)">Unassigned</em>'}</span></div>`;
  }).join('');
}

window.openZonesModal = function() {
  _renderZonesList();
  document.getElementById('zones-modal').classList.add('show');
};
window.closeZonesModal = function() {
  document.getElementById('zones-modal').classList.remove('show');
};
function _renderZonesList() {
  const el = document.getElementById('zones-list');
  el.innerHTML = _zoneDepts.map(d => {
    const current = _zoneAssignments[d.id] || '';
    const options = ['<option value="">— Unassigned —</option>']
      .concat(_zoneCandidates.map(c => `<option value="${_esc(c.id)}" ${current === c.id ? 'selected' : ''}>${_esc(c.full_name)}${c.designation === 'nursing_superintendent' ? ' (Matron)' : ''}</option>`))
      .join('');
    return `<div class="seq-row">
      <span class="seq-name">${_esc(d.name)}</span>
      <select data-zone-dept="${_esc(d.id)}" style="height:32px;border:1.5px solid var(--border);border-radius:7px;padding:0 8px;font-size:12.5px">${options}</select>
    </div>`;
  }).join('');
}

window.saveZoneAssignments = async function() {
  const selects = document.querySelectorAll('#zones-list select[data-zone-dept]');
  const assignments = [];
  selects.forEach(sel => {
    if (sel.value) assignments.push({ department_id: sel.dataset.zoneDept, profile_id: sel.value });
  });
  const { error } = await supabase.rpc('save_nursing_zone_assignments', { p_assignments: assignments });
  if (error) { alert(safeErrorMessage(error, 'Could not save supervision zones.')); return; }
  closeZonesModal();
  await loadSupervisionZones();
};

// ── Cycle Expiry Banner (Session 148) ───────────────────────────────
// Roll Forward is entirely manual (confirmed via grep -- no cron/scheduled
// job anywhere calls roll_nursing_roster_template()), so a department's
// roster can silently run out of scheduled dates with nobody noticing.
// Warns once the last already-generated shift_date is within 3 days (or
// already past) -- links straight to nursing-roster-template.html.
async function loadCycleExpiryBanner() {
  const el = document.getElementById('expiry-banner');
  const nursingDepts = await _loadNursingDutyDepts();

  const results = await checkCycleExpiry(supabase, tenantId, nursingDepts);
  const concerning = results.filter(r => r.status !== 'ok');
  if (!concerning.length) { el.style.display = 'none'; return; }

  const hasUrgent = concerning.some(r => r.status === 'expired' || r.status === 'none');
  el.className = `expiry-banner ${hasUrgent ? 'danger' : 'warn'}`;
  el.style.display = '';

  // Session 149 dropped the per-department breakdown lines here (Dr.
  // Venkatesh found a full one-line-per-department table too noisy on this
  // overview page) -- Session 167 found that went too far: the summary
  // count alone gave no way to tell WHICH department without leaving this
  // page and checking each one by hand on nursing-roster-template.html.
  // Restored just the names (not the old per-department stats table) --
  // a plain comma-separated list stays compact even at 8-9 departments.
  const transitioning = concerning.filter(r => r.willTransition);
  const names = concerning.map(r => _esc(r.deptName)).join(', ');
  el.innerHTML = `<strong>${hasUrgent ? '🔴' : '⚠️'} ${concerning.length} department${concerning.length === 1 ? '' : 's'} need${concerning.length === 1 ? 's' : ''} the next roster cycle generated</strong>`
    + `<div style="margin-top:4px">${names}</div>`
    + (transitioning.length ? `<div style="margin-top:6px">ℹ️ Next cycle will transition to ${transitioning[0].tenantDays} days for ${transitioning.length} of these department${transitioning.length === 1 ? '' : 's'}.</div>` : '')
    + `<div style="margin-top:8px"><a href="nursing-roster-template.html" style="color:inherit;font-weight:600;text-decoration:underline">Go to Roster Template →</a></div>`;
}

// Local Y-M-D, not UTC -- same fix as roster.js/nursing-roster-template.js's
// own _dateStr()/_localDateStr() (Session 149 found .toISOString() silently
// rolls back a day for India's UTC+5:30).
function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Coverage Gap Banner (Session 159) ───────────────────────────────
// mark_duty_attendance() auto-tries relief-pool coverage the instant a
// shift is marked Absent (roster.html's On-Ground Duty Monitor) -- this is
// the "did it work" surface for whoever's on this overview page, not just
// whoever happened to be the one marking attendance. Live via realtime
// (duty_roster is already a publication member, Session 134/152), so a
// same-day absence with no coverage shows up here without a reload.
async function loadCoverageGapBanner() {
  const el = document.getElementById('coverage-gap-banner');
  const nursingDeptIds = (await _loadNursingDutyDepts()).map(d => d.id);

  const gaps = await findUncoveredAbsences(supabase, tenantId, nursingDeptIds, _todayStr());
  if (!gaps.length) { el.style.display = 'none'; return; }

  el.className = 'expiry-banner danger';
  el.style.display = '';
  const lines = gaps.map(g => `${_esc(g.profile_name)} — ${_esc(g.department_name)} (${_esc(g.shift_type)})`).join('<br>');
  el.innerHTML = `<strong>🚨 ${gaps.length} shift${gaps.length === 1 ? '' : 's'} today ${gaps.length === 1 ? 'has' : 'have'} an absence with no relief nurse available</strong>`
    + `<div style="margin-top:6px">${lines}</div>`
    + `<div style="margin-top:8px"><a href="roster.html?tab=monitor" style="color:inherit;font-weight:600;text-decoration:underline">Go to On-Ground Duty Monitor →</a></div>`;
}

let _coverageBadgeDebounce = null;
function _refreshCoverageGapBannerDebounced() {
  clearTimeout(_coverageBadgeDebounce);
  _coverageBadgeDebounce = setTimeout(loadCoverageGapBanner, 600);
}
supabase.channel('coverage-gap-live')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'duty_roster', filter: `tenant_id=eq.${tenantId}` }, _refreshCoverageGapBannerDebounced)
  .subscribe();

// ── Today's Staffing Snapshot (Session 175) ──────────────────────────────────
// Dr. Venkatesh's explicit ask: on login, a Nursing Superintendent should see at a
// glance who's working where, who's off/on leave, who's free, and who's posted to a
// lighter-duty zone today. Four buckets, computed fresh, never a cached/manual number:
//   • Working  — has a real duty_roster row for today (grouped by department)
//   • On leave — an approved staff_leaves row covering today
//   • Off      — no duty_roster row today, not on leave, but the current rotating
//                weekly-off formula (preview_nursing_week, re-run read-only for the
//                current week) says today IS their scheduled off day. Deliberately does
//                NOT use profiles.weekly_off_day for this -- that field is the OLDER
//                fixed-weekday model and is documented stale against the rotating
//                solver's real published schedule (Session 168's nursing.html bug was
//                exactly this mismatch). Re-deriving from the same solver the real
//                schedule was generated from is the only way to answer "off" honestly.
//   • Free     — none of the above: a genuine unexplained gap (never posted, or an
//                older Fixed-Team/Roll-Forward tenant with no rotating-off concept).
// "Lighter-duty zone" = the 4 real day-only General Duty places (OPD, Diagnostics,
// Panchakarma, Screening OPD) per Dr. Venkatesh's choice of a fixed category rather
// than a live Required-vs-Assigned computation -- reuses the SAME categorisation
// shiftsForDept()/isNursingDutyDept() already use, not a new hand-picked list.
function _mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _isLightDutyDept(dept) {
  return NURSING_GENERAL_DUTY_CODES.has(dept?.ncism_code) || NURSING_GENERAL_DUTY_NAMES.has(dept?.name);
}

async function loadTodayStaffingSnapshot() {
  const bodyEl = document.getElementById('today-snapshot-body');
  const subEl  = document.getElementById('snapshot-sub');
  const today  = _todayStr();

  try {
    const { data: staff } = await supabase.from('profiles')
      .select('id, full_name, designation')
      .eq('tenant_id', tenantId).eq('is_active', true)
      .in('designation', NURSING_ELIGIBLE_DESIGNATIONS);
    const staffList = staff || [];
    const staffIds  = staffList.map(s => s.id);
    if (!staffIds.length) {
      subEl.textContent = 'No nursing staff on file yet.';
      bodyEl.innerHTML = '';
      return;
    }

    const { data: depts } = await supabase.from('departments')
      .select('id, name, ncism_code').eq('tenant_id', tenantId).eq('is_active', true);
    const lightDeptIds = new Set((depts || []).filter(_isLightDutyDept).map(d => d.id));

    const [{ data: dutyRows }, { data: leaveRows }] = await Promise.all([
      supabase.from('duty_roster')
        .select('profile_id, department_id, shift_type, departments(name)')
        .eq('tenant_id', tenantId).eq('shift_date', today).in('profile_id', staffIds),
      supabase.from('staff_leaves')
        .select('profile_id, reason, leave_type')
        .eq('tenant_id', tenantId).eq('status', 'approved')
        .lte('from_date', today).gte('to_date', today).in('profile_id', staffIds),
    ]);

    // Rotating weekly-off, re-derived read-only for the current week (see note above)
    let offToday = new Set();
    try {
      const required = await buildRequiredMatrix(supabase, tenantId);
      if (required.length) {
        const { data: preview } = await supabase.rpc('preview_nursing_week', {
          p_week_start: _mondayOf(today), p_required: required,
        });
        offToday = new Set(
          (preview?.weekly_offs || [])
            .filter(o => (o.off_dates || []).includes(today))
            .map(o => o.profile_id)
        );
      }
    } catch { /* best-effort -- an off-day miss just falls through to "Free", never blocks the rest */ }

    const workingMap = new Map();
    (dutyRows || []).forEach(r => {
      if (!workingMap.has(r.profile_id)) workingMap.set(r.profile_id, []);
      workingMap.get(r.profile_id).push({
        deptId: r.department_id, deptName: r.departments?.name || '—', shift: r.shift_type,
      });
    });
    const leaveMap = new Map((leaveRows || []).map(r => [r.profile_id, r]));

    const working = [], onLeave = [], off = [], free = [], lightZone = [];
    for (const s of staffList) {
      const shifts = workingMap.get(s.id);
      if (shifts?.length) {
        working.push({ ...s, shifts });
        const lightShifts = shifts.filter(sh => lightDeptIds.has(sh.deptId));
        if (lightShifts.length) lightZone.push({ ...s, shifts: lightShifts });
      } else if (leaveMap.has(s.id)) {
        onLeave.push({ ...s, leave: leaveMap.get(s.id) });
      } else if (offToday.has(s.id)) {
        off.push(s);
      } else {
        free.push(s);
      }
    }

    subEl.textContent = `${staffList.length} nursing staff · ${working.length} working · ${onLeave.length} on leave · ${off.length} off · ${free.length} free`;

    const shiftLabel = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night', general: 'General Duty' };
    const nameTag = (s, extra = '') => `<div style="padding:6px 10px;background:#fff;border:1px solid var(--border);border-radius:6px;font-size:12.5px;margin-bottom:5px">
      <strong>${_esc(s.full_name)}</strong>${extra}
    </div>`;

    const workingHtml = working.length
      ? working.map(s => nameTag(s, ` <span style="color:var(--text-muted)">— ${s.shifts.map(sh => `${_esc(sh.deptName)} (${_esc(shiftLabel[sh.shift] || sh.shift)})`).join(', ')}</span>`)).join('')
      : '<div style="font-size:12px;color:var(--text-muted)">Nobody rostered yet today.</div>';

    const leaveHtml = onLeave.map(s => nameTag(s, s.leave.reason ? ` <span style="color:var(--text-muted)">— on leave: ${_esc(s.leave.reason)}</span>` : ' <span style="color:var(--text-muted)">— on leave</span>')).join('');
    const offHtml = off.map(s => nameTag(s, ` <span style="color:var(--text-muted)">— scheduled weekly off</span>`)).join('');
    const leaveOffHtml = (leaveHtml + offHtml) || '<div style="font-size:12px;color:var(--text-muted)">Nobody off or on leave today.</div>';

    const freeHtml = free.length
      ? free.map(s => nameTag(s)).join('')
      : '<div style="font-size:12px;color:var(--text-muted)">No unexplained gaps — everyone is accounted for.</div>';

    const lightHtml = lightZone.length
      ? lightZone.map(s => nameTag(s, ` <span style="color:var(--text-muted)">— ${s.shifts.map(sh => _esc(sh.deptName)).join(', ')}</span>`)).join('')
      : '<div style="font-size:12px;color:var(--text-muted)">Nobody posted to a day-only place today.</div>';

    const panel = (title, sub, count, html) => `<div style="background:#f9f8f4;border:1px solid var(--border);border-radius:8px;padding:12px">
      <div style="font-weight:600;font-size:12.5px;color:var(--green-deep);margin-bottom:2px">${title} (${count})</div>
      <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:8px">${sub}</div>
      <div style="max-height:220px;overflow-y:auto">${html}</div>
    </div>`;

    bodyEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
      ${panel('📍 Working Today', 'Has a real shift assigned today', working.length, workingHtml)}
      ${panel('🏖️ Off / On Leave', 'Approved leave or scheduled weekly off', onLeave.length + off.length, leaveOffHtml)}
      ${panel('🆓 Free Today', 'Not working, not on leave, not their off day — an unexplained gap', free.length, freeHtml)}
      ${panel('🌿 Lighter-Duty Zones', 'Posted to OPD / Diagnostics / Panchakarma / Screening OPD today', lightZone.length, lightHtml)}
    </div>`;
  } catch (err) {
    subEl.textContent = 'Could not load.';
    bodyEl.innerHTML = `<div style="font-size:12.5px;color:#c0392b">${_esc(safeErrorMessage(err, 'Could not load today\'s staffing snapshot.'))}</div>`;
  }
}

await loadHeadship();
await loadTodayStaffingSnapshot();
await loadCoverageGapBanner();
await loadShiftChangeRequests();
await loadNursingLeaves();
await loadComplianceSnapshot();
await loadRotationSection();
await loadSupervisionZones();
await loadCycleExpiryBanner();
