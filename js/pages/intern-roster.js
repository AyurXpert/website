// intern-roster.js — Session 128.
//
// Deputy Medical Superintendent drafts the year's intern rotation plan here;
// nothing takes effect until the Medical Superintendent approves it (via the
// existing HR -> Approvals tab in admin.js, decide_approval() RPC). Only
// covers the shared OPD/Lab/Screening/Pharmacy rotation, computed from real
// NCISM bed-share ratios -- intern IPD posting and all PG posting are direct,
// unapproved HOD actions (dept-admin.html), not part of this page at all.
import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { computeInternRotationPlan, computeStopCounts } from '../modules/roster/internRotation.js';

await requireAuth(['doctor']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

// Narrower than dept-admin.html's "any scoped doctor" precedent -- this page
// is specific to one designation, not any HOD.
if (profile.designation !== 'deputy_medical_superintendent') {
  document.querySelector('.page-wrap').innerHTML =
    '<div class="empty">This page is for the Deputy Medical Superintendent only.</div>';
  document.documentElement.style.visibility = '';
  throw new Error('not authorized');
}

function _toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => el.classList.remove('show'), 3500);
}

const AREA_LABELS = {
  PK: 'Panchakarma', KAY: 'Kayachikitsa', SHAL: 'Shalya Tantra', SHAK: 'Shalakya Tantra',
  KAU: 'Kaumarabhritya', PST: 'Prasuti & Stri Roga', AGD: 'Agada Tantra',
  lab: 'Lab', screening: 'Screening OPD', pharmacy: 'Pharmacy',
};
const CLINICAL_CODES = ['PK', 'KAY', 'SHAL', 'SHAK', 'KAU', 'PST', 'AGD'];

let _interns = [];
let _deptByCode = {};
let _computedPlan = null;

async function _loadInterns() {
  const { data, error } = await supabase.from('profiles')
    .select('id, full_name')
    .eq('tenant_id', tenantId).eq('role', 'trainee_doctor').eq('designation', 'intern').eq('status', 'active');
  if (error) { document.getElementById('rp-intern-count').textContent = 'Error loading interns.'; return; }
  _interns = data || [];
  const el = document.getElementById('rp-intern-count');
  if (!_interns.length) {
    el.textContent = 'No active interns found — invite them via Admin > HR first.';
    document.getElementById('btn-compute').disabled = true;
  } else {
    el.textContent = `${_interns.length} active intern(s) found.`;
    document.getElementById('btn-compute').disabled = false;
  }
}

async function _loadDeptMap() {
  const { data } = await supabase.from('departments')
    .select('id, ncism_code').eq('tenant_id', tenantId).eq('is_active', true)
    .in('ncism_code', CLINICAL_CODES);
  _deptByCode = {};
  (data || []).forEach(d => { _deptByCode[d.ncism_code] = d.id; });
}

window.computePlan = function() {
  const startDate = document.getElementById('rp-start-date').value;
  if (!startDate) { _toast('Pick a rotation start date first.', true); return; }
  if (!_interns.length) return;

  _computedPlan = computeInternRotationPlan(_interns, startDate);

  const counts = computeStopCounts();
  document.getElementById('rp-stop-counts').innerHTML = Object.entries(counts)
    .map(([code, n]) => `<span class="stop-chip">${_esc(AREA_LABELS[code] || code)}: ${n} stop(s)</span>`).join('');

  const table = document.getElementById('plan-table');
  const header = '<tr><th>Intern</th>' + Array.from({ length: 12 }, (_, i) => `<th>Stop ${i + 1}</th>`).join('') + '</tr>';
  const rows = _computedPlan.map(({ intern, postings }) => {
    const cells = postings.map(p =>
      `<td><span class="area-pill">${_esc(AREA_LABELS[p.area_code] || p.area_code)}</span><br><span style="color:var(--text-muted);font-size:10px">${p.start_date}</span></td>`
    ).join('');
    return `<tr><td style="font-weight:600">${_esc(intern.name || intern.full_name || '—')}</td>${cells}</tr>`;
  }).join('');
  table.innerHTML = header + rows;

  document.getElementById('rp-plan-section').style.display = 'block';
};

window.submitRosterForApproval = async function() {
  if (!_computedPlan) return;
  const reason = document.getElementById('rp-reason').value.trim() || null;
  const btn = document.getElementById('btn-submit-roster');
  btn.disabled = true; btn.textContent = 'Submitting…';

  try {
    // Resolve area codes to real department ids here (clinical codes only --
    // lab/screening/pharmacy have no department_id, area alone identifies them).
    const postings = _computedPlan.flatMap(({ postings }) => postings.map(p => ({
      profile_id: p.profile_id,
      department_id: CLINICAL_CODES.includes(p.area_code) ? (_deptByCode[p.area_code] || null) : null,
      area: CLINICAL_CODES.includes(p.area_code) ? 'opd' : p.area_code,
      start_date: p.start_date,
      end_date: p.end_date,
    })));

    const { error } = await supabase.rpc('request_intern_roster', {
      p_payload: { postings, rotation_start: document.getElementById('rp-start-date').value },
      p_reason: reason,
    });
    if (error) throw error;

    _toast('Roster submitted — awaiting Medical Superintendent approval.');
    document.getElementById('rp-plan-section').style.display = 'none';
    _computedPlan = null;
    loadHistory();
  } catch (err) {
    _toast(safeErrorMessage(err, 'Could not submit roster.'), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Submit for MS Approval';
  }
};

async function loadHistory() {
  const el = document.getElementById('rp-history');
  const { data, error } = await supabase.from('pending_approvals')
    .select('id, status, requested_at, decided_at, decision_notes, reason')
    .eq('tenant_id', tenantId).eq('action_type', 'intern_roster').eq('requested_by', profile.id)
    .order('requested_at', { ascending: false });
  if (error) { el.innerHTML = `<div class="empty">${_esc(safeErrorMessage(error, 'Could not load history.'))}</div>`; return; }
  if (!data?.length) { el.innerHTML = '<div class="empty">No rosters submitted yet.</div>'; return; }

  el.innerHTML = data.map(r => {
    const date = new Date(r.requested_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    return `<div class="history-row">
      <span>${_esc(r.reason || 'Intern rotation roster')} — <span style="color:var(--text-muted)">${date}</span></span>
      <span class="status-tag status-${r.status}">${_esc(r.status.toUpperCase())}</span>
    </div>`;
  }).join('');
}

// ── Boot ──
document.getElementById('rp-start-date').value = new Date().toISOString().slice(0, 10);
await _loadInterns();
await _loadDeptMap();
await loadHistory();
