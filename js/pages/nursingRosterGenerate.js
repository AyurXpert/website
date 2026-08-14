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
//
// Session 167: cycle-adaptive generation -- the tenant's approved Roster Cycle setting
// (nursing_roster_settings.cycle, weekly/fortnightly/monthly, same maker-checker setting the
// older Fixed-Team template system already reads) now also governs THIS page. Deliberately does
// NOT touch preview_nursing_week()/commit_nursing_week() themselves -- their rotating weekly-off
// formula (sort_idx + week_number, mod 7) is scoped to and proven correct for exactly one
// calendar week; generalizing it to a 14/30-day span directly would mean re-deriving that math
// for spans that don't cleanly decompose into whole weeks. Instead, a fortnight/month is built by
// calling the SAME tested single-week RPCs once per Monday in the period and combining the
// results client-side -- the proven engine is never modified, just called more than once.
// "Monthly" means exactly 4 consecutive Monday-start weeks (28 days), not a real calendar month --
// confirmed with Dr. Venkatesh (12 Aug 2026): the solver is inherently Monday-anchored, and a
// real calendar month would end mid-week with no clean way to close out a partial week.
// Publish is per-week atomic (reuses commit_nursing_week()'s existing per-week transaction
// unchanged) but NOT one all-or-nothing transaction across the whole period -- also Dr.
// Venkatesh's confirmed call: a large multi-week write is more likely to hit a lock/timeout, and
// requiring all-or-nothing means a single hiccup on week 4 would silently discard weeks 1-3 that
// published cleanly. A partial-publish failure is reported by exactly which week stopped, so the
// remaining weeks can just be re-run.
await requireAuth(['super_admin', 'dept_admin', 'nurse_manager', 'nurse'], 'login.html', { monitoringSafe: true });
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const role     = getCurrentRole();
let _canEdit   = role === 'super_admin' || role === 'dept_admin' || getCurrentSecondaryRole() === 'dept_admin';

const CYCLE_WEEKS = { weekly: 1, fortnightly: 2, monthly: 4 };
const CYCLE_META = {
  weekly:      { period: 'Week',     periodLower: 'week',     navLabel: '🆕 Generate Week',     pageTitle: '🆕 Generate Weekly Roster',     btnPreview: '🔍 Generate Preview', btnPublish: '✅ Confirm & Publish This Week',     nudgeStep: 'week' },
  fortnightly: { period: 'Fortnight',periodLower: 'fortnight', navLabel: '🆕 Generate Fortnightly',pageTitle: '🆕 Generate Fortnightly Roster', btnPreview: '🔍 Generate Preview', btnPublish: '✅ Confirm & Publish This Fortnight', nudgeStep: 'fortnight' },
  monthly:     { period: '4-Week Month', periodLower: '4-week month', navLabel: '🆕 Generate Monthly', pageTitle: '🆕 Generate Monthly Roster', btnPreview: '🔍 Generate Preview', btnPublish: '✅ Confirm & Publish This Month', nudgeStep: 'month' },
};

let _cycle     = 'weekly';
let _weekCount = 1;
let _weekStart = _getMonday(new Date());
let _deptNames = {};
let _lastPreview = null;       // combined { required, byWeek: [{weekStart, result}], merged: <renderable> }
let _lastPreviewMondays = null; // JSON-stringified array of Monday date-strings the current preview/enable-state covers

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

async function loadCycle() {
  const { data } = await supabase.from('nursing_roster_settings').select('cycle').eq('tenant_id', tenantId).maybeSingle();
  _cycle = data?.cycle || 'weekly';
  _weekCount = CYCLE_WEEKS[_cycle] || 1;
  const meta = CYCLE_META[_cycle];
  document.getElementById('page-title').textContent = meta.pageTitle;
  document.getElementById('nav-active-label').textContent = meta.navLabel;
  document.getElementById('period-card-title').textContent = `📅 ${meta.period}`;
  document.getElementById('period-card-sub').textContent = `Starts on a Monday${_weekCount > 1 ? ` — spans ${_weekCount} weeks` : ''}`;
  document.getElementById('preview-card-sub').textContent = `Computes the full proposed ${meta.periodLower} at once — writes nothing until you publish it below`;
  document.getElementById('publish-card-sub').textContent = `Replaces any existing roster for this ${meta.periodLower}, in these departments, with the previewed plan above`;
  document.getElementById('btn-preview').textContent = meta.btnPreview;
  document.getElementById('btn-publish').textContent = meta.btnPublish;
  document.getElementById('this-period-label').textContent = meta.period;
  document.title = `${meta.pageTitle.replace('🆕 ', '')} — AyurXpert`;
  if (_weekCount > 1) {
    const note = document.getElementById('cycle-note');
    note.textContent = `This tenant's approved Roster Cycle is ${_cycle} — generating ${_weekCount} weeks at once, each solved and (once published) written independently. If a hiccup stops publish partway, the weeks already written stay published; just re-run the remaining ones.`;
    note.classList.add('show');
  }
}

async function loadEditGate() {
  if (role === 'nurse_manager') {
    const headship = await resolveNursingHeadship(supabase, tenantId);
    _canEdit = canActAsNursingHead(headship, profile.id, role, profile.designation);
  } else if (role === 'doctor' && getCurrentHasMonitoringAccess()) {
    _canEdit = false; // Deputy MS: view/preview only, never publish
  }
  // Pre-existing bug found live during Session 167's nursing.js banner investigation, same
  // class: this element carries class="alert info", and .alert{display:none} (a CSS class
  // rule) still applies after style.display is merely cleared to '' -- an inline style.display
  // can only override a class rule when explicitly set to a real value, not cleared. The
  // read-only explanation banner has never actually been visible to a read-only viewer (e.g.
  // Deputy MS) since this page was built. Fixed using the .alert.show{display:block} convention
  // this same file already defines and uses correctly elsewhere (see _renderPreview()'s
  // note.classList.add('show')).
  document.getElementById('readonly-note').classList.toggle('show', !_canEdit);
  document.getElementById('btn-publish').style.display = _canEdit ? '' : 'none';
}

function _periodMondays() {
  return Array.from({ length: _weekCount }, (_, i) => {
    const m = new Date(_weekStart);
    m.setDate(m.getDate() + i * 7);
    return m;
  });
}

function _updateWeekLabel() {
  const mondays = _periodMondays();
  const end = new Date(mondays[mondays.length - 1]); end.setDate(end.getDate() + 6);
  document.getElementById('week-label').textContent = `${_fmtDate(_weekStart)} – ${_fmtDate(end)}, ${_weekStart.getFullYear()}`;
  document.getElementById('preview-results').style.display = 'none';
  document.getElementById('btn-publish').disabled = true;
  document.getElementById('publish-hint').textContent = `Generate a preview for this exact ${CYCLE_META[_cycle].periodLower} first.`;
  _lastPreview = null;
  _lastPreviewMondays = null;
}

document.getElementById('btn-prev-week').addEventListener('click', () => { _weekStart.setDate(_weekStart.getDate() - 7 * _weekCount); _updateWeekLabel(); });
document.getElementById('btn-next-week').addEventListener('click', () => { _weekStart.setDate(_weekStart.getDate() + 7 * _weekCount); _updateWeekLabel(); });
document.getElementById('btn-this-week').addEventListener('click', () => { _weekStart = _getMonday(new Date()); _updateWeekLabel(); });

async function loadDeptNames() {
  const { data } = await supabase.from('departments').select('id,name').eq('tenant_id', tenantId);
  _deptNames = {}; (data || []).forEach(d => { _deptNames[d.id] = d.name; });
}

const VIA_LABEL = { home: 'Home assignment', widened: 'Same-department widening', widened_cross: 'Cross-department pairing', relief: 'Cross-pool relief' };

// Combines N single-week preview_nursing_week() results (one per Monday in the period) into one
// renderable shape identical to what the single-week page always rendered -- plan/gaps concat
// straight across weeks (each entry already carries its own real `date`, so nothing needs a
// week label added); weekly_offs merges per-person off_dates arrays by profile_id, since the
// same nurse can appear in more than one week's off-list with a different day each time.
function _mergePreviews(byWeek) {
  const plan = [], gaps = [];
  const offsByProfile = {};
  let pool_count = 0;
  byWeek.forEach(({ result }) => {
    (result.plan || []).forEach(p => plan.push(p));
    (result.gaps || []).forEach(g => gaps.push(g));
    (result.weekly_offs || []).forEach(o => {
      if (!offsByProfile[o.profile_id]) offsByProfile[o.profile_id] = { profile_id: o.profile_id, full_name: o.full_name, off_dates: [] };
      offsByProfile[o.profile_id].off_dates.push(...(o.off_dates || []));
    });
    pool_count = Math.max(pool_count, result.pool_count || 0);
  });
  return {
    plan, gaps, pool_count,
    weekly_offs: Object.values(offsByProfile),
    plan_count: plan.length, gap_count: gaps.length,
  };
}

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
    html += `<div class="empty">✅ No gaps — every required slot this ${CYCLE_META[_cycle].periodLower} is covered.</div>`;
  }

  const offs = result.weekly_offs || [];
  if (offs.length) {
    html += `<details><summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--green-deep);margin:10px 0">📋 Weekly off this ${CYCLE_META[_cycle].periodLower} (${offs.length} staff)</summary>`
      + '<table class="gen-table" style="margin-top:8px"><thead><tr><th>Staff</th><th>Off day(s)</th></tr></thead><tbody>'
      + offs.map(o => `<tr><td>${_esc(o.full_name)}</td><td>${(o.off_dates || []).map(d => _esc(_fmtDate(d))).join(', ')}</td></tr>`).join('')
      + '</tbody></table></details>';
  }

  el.innerHTML = html;
  el.style.display = '';
}

document.getElementById('btn-preview').addEventListener('click', async () => {
  const btn = document.getElementById('btn-preview');
  const meta = CYCLE_META[_cycle];
  btn.disabled = true; btn.textContent = 'Generating…';
  try {
    const required = await buildRequiredMatrix(supabase, tenantId);
    if (!required.length) { _alert('error', 'No nursing-duty departments configured yet.'); return; }
    const mondays = _periodMondays();
    const byWeek = [];
    for (const monday of mondays) {
      const { data, error } = await supabase.rpc('preview_nursing_week', { p_week_start: _dateStr(monday), p_required: required });
      if (error) {
        _alert('error', safeErrorMessage(error, `Could not generate a preview for the week starting ${_fmtDate(monday)}.`));
        return;
      }
      byWeek.push({ weekStart: _dateStr(monday), result: data });
    }
    const merged = _mergePreviews(byWeek);
    _lastPreview = { required, byWeek };
    _lastPreviewMondays = JSON.stringify(mondays.map(_dateStr));
    _renderPreview(merged);
    if (_canEdit) {
      document.getElementById('btn-publish').disabled = false;
      document.getElementById('publish-hint').textContent = `This will replace any existing roster for this ${meta.periodLower} in these departments.`;
    }
  } finally {
    btn.disabled = false; btn.textContent = meta.btnPreview;
  }
});

document.getElementById('btn-publish').addEventListener('click', async () => {
  const meta = CYCLE_META[_cycle];
  const mondays = _periodMondays();
  const currentMondays = JSON.stringify(mondays.map(_dateStr));
  if (!_lastPreview || _lastPreviewMondays !== currentMondays) {
    _alert('error', `Generate a fresh preview for this ${meta.periodLower} before publishing.`);
    return;
  }
  const merged = _mergePreviews(_lastPreview.byWeek);
  const gapCount = merged.gap_count;
  const end = new Date(mondays[mondays.length - 1]); end.setDate(end.getDate() + 6);
  if (!confirm(`Publish this ${meta.periodLower}? This replaces any existing roster for ${_dateStr(_weekStart)} – ${_dateStr(end)} in these departments.${gapCount ? `\n\n${gapCount} honest gap(s) will remain unfilled.` : ''}`)) return;

  const btn = document.getElementById('btn-publish');
  btn.disabled = true;
  let totalCreated = 0;
  for (let i = 0; i < mondays.length; i++) {
    const monday = mondays[i];
    btn.textContent = mondays.length > 1 ? `Publishing week ${i + 1} of ${mondays.length}…` : 'Publishing…';
    const { data, error } = await supabase.rpc('commit_nursing_week', { p_week_start: _dateStr(monday), p_required: _lastPreview.required });
    if (error) {
      _alert('error', safeErrorMessage(error, `Could not publish the week starting ${_fmtDate(monday)}.`)
        + (i > 0 ? ` ${i} week(s) before it published successfully — only the remaining week(s) need re-running.` : ''));
      btn.disabled = false; btn.textContent = meta.btnPublish;
      return;
    }
    totalCreated += data.created;
  }
  _alert('success', `Published — ${totalCreated} shift${totalCreated === 1 ? '' : 's'} written across ${mondays.length} week${mondays.length === 1 ? '' : 's'}. View it on the Duty Roster page.`);
  document.getElementById('publish-hint').textContent = `Published. Generate a fresh preview to publish again.`;
  _lastPreview = null; _lastPreviewMondays = null;
  btn.disabled = false; btn.textContent = meta.btnPublish;
});

await loadCycle();
await loadEditGate();
await loadDeptNames();

// Session 169: nursing-roster-template.js's Roll Forward gap-result links here with
// ?week=YYYY-MM-DD once it reports unfilled shifts, so the Nursing Head lands straight on the
// week that needs the cross-department solver instead of having to re-navigate to it manually.
// Snapped to that date's Monday like every other week-nav path -- an arbitrary mid-week date
// in the link would silently misalign _weekStart from the grid it's meant to match.
const _qWeek = new URLSearchParams(location.search).get('week');
if (_qWeek && /^\d{4}-\d{2}-\d{2}$/.test(_qWeek)) {
  const d = new Date(_qWeek + 'T00:00:00');
  if (!isNaN(d)) _weekStart = _getMonday(d);
}

_updateWeekLabel();
