import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole, getCurrentSecondaryRole, getCurrentHasMonitoringAccess } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { buildRequiredMatrix } from '../modules/roster/requiredStaffing.js';
import { resolveNursingHeadship, canActAsNursingHead } from '../modules/roster/nursingHeadship.js';

// Session 166 Phase 2: the UI for preview_nursing_week()/commit_nursing_week() -- the whole-week
// solver (rotating weekly-off, same-department widening, named cross-department pairing, honest
// gap reporting) built and validated this session. Deliberately a NEW page, not folded into
// roster.html's manual per-cell grid or nursing-roster-template.html's Fixed-Team editor -- this
// is a genuinely different workflow (batch-generate a whole week, review it, then commit),
// not a per-slot edit. Access mirrors roster.html: monitoringSafe admits Deputy MS read-only
// (duty_roster's write-side RLS was closed earlier this session specifically to make this safe);
// Publish is further gated client-side to _canEdit, matching roster.js's exact convention, with
// commit_nursing_week()'s own server-side _duty_roster_editor_ok() check as the real enforcement.
await requireAuth(['super_admin', 'dept_admin', 'nurse_manager', 'nurse'], 'login.html', { monitoringSafe: true });
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const role     = getCurrentRole();
let _canEdit   = role === 'super_admin' || role === 'dept_admin' || getCurrentSecondaryRole() === 'dept_admin';

let _weekStart = _getMonday(new Date());
let _deptNames = {};
let _lastPreview = null;       // the full RPC result, kept so Publish doesn't need to re-fetch it
let _lastPreviewWeek = null;   // which week the current preview/enable-state belongs to -- a week
                                // change invalidates it, forcing a fresh preview before publish

function _getMonday(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const m = new Date(d);
  m.setDate(m.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function _dateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function _fmtDate(d) { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }

function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = `alert ${type} show`;
}

async function loadEditGate() {
  if (role === 'nurse_manager') {
    const headship = await resolveNursingHeadship(supabase, tenantId);
    _canEdit = canActAsNursingHead(headship, profile.id, role, profile.designation);
  } else if (role === 'doctor' && getCurrentHasMonitoringAccess()) {
    _canEdit = false; // Deputy MS: view/preview only, never publish
  }
  document.getElementById('readonly-note').style.display = _canEdit ? 'none' : '';
  document.getElementById('btn-publish').style.display = _canEdit ? '' : 'none';
}

function _updateWeekLabel() {
  const end = new Date(_weekStart); end.setDate(end.getDate() + 6);
  document.getElementById('week-label').textContent = `${_fmtDate(_weekStart)} – ${_fmtDate(end)}, ${_weekStart.getFullYear()}`;
  document.getElementById('preview-results').style.display = 'none';
  document.getElementById('btn-publish').disabled = true;
  document.getElementById('publish-hint').textContent = 'Generate a preview for this exact week first.';
  _lastPreview = null;
  _lastPreviewWeek = null;
}

document.getElementById('btn-prev-week').addEventListener('click', () => { _weekStart.setDate(_weekStart.getDate() - 7); _updateWeekLabel(); });
document.getElementById('btn-next-week').addEventListener('click', () => { _weekStart.setDate(_weekStart.getDate() + 7); _updateWeekLabel(); });
document.getElementById('btn-this-week').addEventListener('click', () => { _weekStart = _getMonday(new Date()); _updateWeekLabel(); });

async function loadDeptNames() {
  const { data } = await supabase.from('departments').select('id,name').eq('tenant_id', tenantId);
  _deptNames = {}; (data || []).forEach(d => { _deptNames[d.id] = d.name; });
}

const VIA_LABEL = { home: 'Home assignment', widened: 'Same-department widening', widened_cross: 'Cross-department pairing', relief: 'Cross-pool relief' };

function _renderPreview(result) {
  const el = document.getElementById('preview-results');
  const gapCount = result.gap_count ?? (result.gaps || []).length;
  const planCount = result.plan_count ?? (result.plan || []).length;
  const total = planCount + gapCount;
  const viaCount = {};
  (result.plan || []).forEach(p => { viaCount[p.via] = (viaCount[p.via] || 0) + 1; });

  let html = `<div class="stat-row">
    <div class="stat-tile"><div class="num">${result.pool_count ?? '—'}</div><div class="lbl">Nurses in pool</div></div>
    <div class="stat-tile"><div class="num">${planCount}/${total}</div><div class="lbl">Slots filled</div></div>
    <div class="stat-tile ${gapCount > 0 ? 'danger' : ''}"><div class="num">${gapCount}</div><div class="lbl">Honest gaps</div></div>
  </div>`;

  html += '<div class="via-legend">' + Object.entries(viaCount).map(([via, n]) =>
    `<span class="via-chip ${via === 'home' ? '' : (via === 'relief' ? 'relief' : 'widened')}">${_esc(VIA_LABEL[via] || via)}: ${n}</span>`
  ).join('') + '</div>';

  if ((result.gaps || []).length) {
    html += '<table class="gen-table" style="margin-bottom:14px"><thead><tr><th>Date</th><th>Department</th><th>Shift</th><th>Reason</th></tr></thead><tbody>'
      + result.gaps.map(g => `<tr><td>${_esc(_fmtDate(g.date))}</td><td>${_esc(_deptNames[g.department_id] || '—')}</td><td>${_esc(g.shift_type)}</td><td>${_esc(g.reason)}</td></tr>`).join('')
      + '</tbody></table>';
  } else {
    html += '<div class="empty">✅ No gaps — every required slot this week is covered.</div>';
  }

  const offs = result.weekly_offs || [];
  if (offs.length) {
    html += `<details><summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--green-deep);margin:10px 0">📋 Weekly off this week (${offs.length} staff)</summary>`
      + '<table class="gen-table" style="margin-top:8px"><thead><tr><th>Staff</th><th>Off day(s)</th></tr></thead><tbody>'
      + offs.map(o => `<tr><td>${_esc(o.full_name)}</td><td>${(o.off_dates || []).map(d => _esc(_fmtDate(d))).join(', ')}</td></tr>`).join('')
      + '</tbody></table></details>';
  }

  el.innerHTML = html;
  el.style.display = '';
}

document.getElementById('btn-preview').addEventListener('click', async () => {
  const btn = document.getElementById('btn-preview');
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const required = await buildRequiredMatrix(supabase, tenantId);
    if (!required.length) { _alert('error', 'No nursing-duty departments configured yet.'); return; }
    const { data, error } = await supabase.rpc('preview_nursing_week', { p_week_start: _dateStr(_weekStart), p_required: required });
    if (error) { _alert('error', safeErrorMessage(error, 'Could not generate a preview.')); return; }
    _lastPreview = { required, result: data };
    _lastPreviewWeek = _dateStr(_weekStart);
    _renderPreview(data);
    if (_canEdit) {
      document.getElementById('btn-publish').disabled = false;
      document.getElementById('publish-hint').textContent = 'This will replace any existing roster for this week in these departments.';
    }
  } finally {
    btn.disabled = false; btn.textContent = '🔍 Generate Preview';
  }
});

document.getElementById('btn-publish').addEventListener('click', async () => {
  if (!_lastPreview || _lastPreviewWeek !== _dateStr(_weekStart)) {
    _alert('error', 'Generate a fresh preview for this week before publishing.');
    return;
  }
  const gapCount = _lastPreview.result.gap_count ?? (_lastPreview.result.gaps || []).length;
  if (!confirm(`Publish this week? This replaces any existing roster for ${_dateStr(_weekStart)} – ${_dateStr(new Date(_weekStart.getTime() + 6 * 86400000))} in these departments.${gapCount ? `\n\n${gapCount} honest gap(s) will remain unfilled.` : ''}`)) return;

  const btn = document.getElementById('btn-publish');
  btn.disabled = true; btn.textContent = 'Publishing…';
  try {
    const { data, error } = await supabase.rpc('commit_nursing_week', { p_week_start: _dateStr(_weekStart), p_required: _lastPreview.required });
    if (error) { _alert('error', safeErrorMessage(error, 'Could not publish this week.')); btn.disabled = false; btn.textContent = '✅ Confirm & Publish This Week'; return; }
    _alert('success', `Published — ${data.created} shift${data.created === 1 ? '' : 's'} written. View it on the Duty Roster page.`);
    document.getElementById('publish-hint').textContent = 'Published. Generate a fresh preview to publish again.';
    _lastPreview = null; _lastPreviewWeek = null;
  } finally {
    btn.disabled = false; btn.textContent = '✅ Confirm & Publish This Week';
  }
});

await loadEditGate();
await loadDeptNames();
_updateWeekLabel();
