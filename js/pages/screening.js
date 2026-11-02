// Screening OPD (NCISM Reg. 40(5)). Session 374B (plan docs/handoff/session373_plan.md B1–B10, contract §10): the page talks to the
// server only through the screening_* functions -- counters + claims ("With Counter 2 — Nurse X", 5-minute lapse, renewed every
// minute while the form is open), structured findings, ONE server step to route (screening_route_visit: token, specialty visit,
// findings, the Screening visit completed -- all or nothing), Emergency triage to the Emergency OPD, "Screened by me today", the purple
// NCISM strip with department bars (hospital targets) and the Screener log (Super Admin / MS / DMS / RMO / MD). The old two-write route
// (complete the Screening visit, then insert the specialty visit from the browser) is closed on the server.
// Owner 2 Nov 2026: only staff on TODAY's Screening duty list screen (others: a notice, no queue -- privacy); the Super Admin / MS /
// Deputy MS / RMO / MD see the queue read-only + the "Screening duty" tab (the MS / DMS / RMO / Super Admin keep the list); R1 open /
// route only after Start Triaging; R2 the next free counter pre-filled, a name in use refused; routing to yourself needs a reason; G5 a
// field's mistake shown when the screener leaves it; F1 / F2 department colours + the department chart; F3 designations in words.
import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { todayLocalStr } from '../utils/dateUtils.js';
import { notify } from '../components/notify.js';
import { getOpdWorkflow, screeningOpdId } from '../modules/opd/screeningOpd.js';
import { buildFindings, bmi, claimText, desigWords, vitalFlags, NUM_FIELDS, TEXT_FIELDS } from '../modules/screening/findings.js';
import { mountScreeningStrip, openDeptRange, openDeptChart } from '../modules/screening/deptStrip.js';
import { deptLabel } from '../modules/screening/deptColours.js';

// trainee_doctor: an INTERN may screen (owner Q1); the server (screening_me) decides -- PG scholars are told they cannot
await requireAuth(['doctor', 'nurse', 'super_admin', 'dept_admin', 'trainee_doctor']);
initNavbar();
wireDelegatedEvents();
const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const today = todayLocalStr();

const REFRESH_MS = 20000;   // the queue refreshes itself (B3) so counters see each other's claims
const RENEW_MS   = 60000;   // the open form renews its claim every minute (the server lapses it after 5 minutes)
const NO_DOCTOR  = '— OPD shared queue (no doctor) —';
const NO_EMERGENCY_OPD = 'No Emergency OPD is marked — the Super Admin can mark one in OPD Management.';

// ── State ─────────────────────────────────────────────────────────────────────
let _me = null;              // screening_me()
let _screeningOpdId = null;
let _targets = [];           // screening_route_targets()
let _queue = [];             // screening_queue_today()
let _active = null;          // the open queue row (claimed by me)
let _triage = null;
let _claimLost = false;
let _renewTimer = null, _refreshTimer = null;
let _relVisit = null;        // the patient an admin is releasing
let _deptManuallyOverridden = false;
let _logRows = [];
let _dutyRows = [];          // screening_duty_day()
let _dutyRm = null;          // the duty entry being taken off
let _candidates = null;      // screening_duty_candidates() (keepers only)
const START_FIRST = 'Click 🟢 Start Triaging to start your Screening duty.';
const fixCount = n => (n === 1 ? '1 thing needs fixing' : `${n} things need fixing`);   // G5 grammar

const $ = id => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const fmtTime = iso => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '');

// ── Chief-complaint → specialty suggestion (clinical only; it never reads the NCISM strip, B9) ─────────────
// Keyed by ncism_code; a code with no OPD here simply gives no suggestion. Never blocks or replaces the screener's own choice.
const CC_KEYWORD_MAP = {
  KAY: ['fever','cough','cold','diabetes','sugar','hypertension','blood pressure','joint pain','arthritis','weakness','fatigue','tired','indigestion','acidity','gastritis','constipation','headache','migraine','asthma','breathless','chest pain','body ache','giddiness','vomiting','loose motion','diarrhea'],
  PK:  ['panchakarma','detox','back pain','spondylosis','sciatica','stiffness','stress','obesity','weight loss','rejuvenation','slip disc','cervical spondylosis','rasayana'],
  SHAL:['wound','injury','piles','hemorrhoids','fistula','fissure','hernia','swelling','lump','abscess','ulcer','burn','fracture','cyst'],
  SHAK:['eye pain','vision','ear pain','nose block','sore throat','sinus','tonsil','hearing loss','watering eye','redness in eye','nasal block'],
  KAU: ['child','infant','baby','pediatric','paediatric','vaccination','growth delay'],
  SW:  ['wellness','yoga','general checkup','health checkup','immunity','lifestyle','diet consultation'],
  PST: ['pregnancy','menstrual','periods','gynec','pcod','pcos','infertility','delivery','antenatal','menopause','leucorrhea','white discharge'],
  AGD: ['poisoning','snake bite','insect bite','toxicity','drug overdose'],
};
function _suggestDeptCode(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;
  for (const [code, keywords] of Object.entries(CC_KEYWORD_MAP)) if (keywords.some(k => t.includes(k))) return code;
  return null;
}
function _autoSuggest() {
  const hint = $('scr-dept-suggest-hint');
  if (_deptManuallyOverridden || !_active) return;
  const code = _suggestDeptCode($('scr-cc').value);
  const t = code ? _targets.find(x => !x.is_emergency && x.ncism_code === code) : null;
  if (!t) { hint.hidden = true; return; }
  if ($('scr-opd').value !== t.opd_id) { $('scr-opd').value = t.opd_id; _onOpdChanged(false); }
  hint.textContent = `💡 Suggested "${t.opd_name}" from the complaint — confirm or change.`;
  hint.hidden = false;
}
$('scr-cc').addEventListener('input', _autoSuggest);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  $('q-date').textContent = new Date(today + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
  $('ss-date').textContent = new Date(today + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  $('log-from').value = today; $('log-to').value = today; $('log-from').max = today; $('log-to').max = today;

  const [wf, me] = await Promise.all([getOpdWorkflow(supabase), supabase.rpc('screening_me')]);
  if (me.error || !me.data) {
    _emptyQueue(safeErrorMessage(me.error, 'Could not check your Screening rights. Reload the page.'));
    return;
  }
  _me = me.data;
  if (_me.can_view_log || _me.can_keep_list) {
    $('scr-tabs').hidden = false;
    $('tab-log').hidden = !_me.can_view_log;
    $('tab-duty').hidden = false;
  }
  _mountStrip();

  if (!_me.can_screen && !_me.read_only_queue) {
    $('screening-duty-row').hidden = true;
    if (_me.is_screener) {
      // owner 2 Nov 2026: not on today's list -> no queue at all (privacy), a short notice only
      $('queue-list').replaceChildren(h('div', { class: 'scr-notice', role: 'status' }, _me.not_on_duty_message || 'You are not on Screening duty today. Ask the Medical Superintendent.'));
      $('form-empty-title').textContent = 'You are not on Screening duty today';
      $('form-empty-sub').textContent = 'Ask the Medical Superintendent to put you on today\'s Screening duty list.';
    } else {
      _emptyQueue('Only nurses, doctors and interns can screen patients.');
      $('form-empty-title').textContent = 'Screening is not part of your role';
      $('form-empty-sub').textContent = _me.can_view_log ? 'You can open the 📋 Screener log tab above.' : 'Ask the Super Admin if you should be screening patients.';
    }
    return;
  }
  if (!wf.screening_opd) {
    _emptyQueue('Screening OPD is switched off for this organisation. Reception sends patients straight to the OPD / doctor. A Super Admin can switch it on in Admin → Feature Modules → OPD workflow.');
    return;
  }
  _screeningOpdId = screeningOpdId(wf);
  if (!_screeningOpdId) {
    _emptyQueue('Screening OPD not configured. Go to OPD Management and make sure the organisation\'s Screening OPD exists and is active.');
    return;
  }
  if (_me.can_screen) await _enterScreener(); else _enterReadOnly();
  await window.loadQueue();
  _refreshTimer = setInterval(() => { if (!document.hidden) window.loadQueue(true); }, REFRESH_MS);
}

// V6 (owner 2 Nov 2026): screening switches on / off WITHOUT a reload when the person's own duty entry changes
const _EMPTY_TITLE = $('form-empty-title').textContent, _EMPTY_SUB = [...$('form-empty-sub').childNodes].map(n => n.cloneNode(true));
async function _enterScreener() {
  $('screening-duty-row').hidden = false;
  $('form-empty-title').textContent = _EMPTY_TITLE;
  $('form-empty-sub').replaceChildren(..._EMPTY_SUB.map(n => n.cloneNode(true)));   // the page's own static text, restored as it was
  // R2: the next free counter is pre-filled (editable for a physical desk name)
  $('scr-counter').value = _me.counter || _me.suggested_counter || '';
  _updateDutyUI();
  await _loadTargets();
  if (_me.needs_supervisor || _me.is_intern) await _loadSupervisors();
}
function _enterReadOnly() {
  // the offices / keepers not screening today: the queue read-only
  $('screening-duty-row').hidden = true;
  $('form-empty-title').textContent = 'Read-only view';
  $('form-empty-sub').textContent = 'You see today\'s Screening queue, but you are not on today\'s Screening duty list, so you do not open or route patients. The 🗓 Screening duty tab shows who is on duty.';
}
async function _modeAfterDutyChange() {
  const was = !!_me?.can_screen;
  const { data } = await supabase.rpc('screening_me');
  if (!data) return;
  _me = data;
  if (_me.can_screen === was || !_screeningOpdId) return;
  if (_me.can_screen) { await _enterScreener(); notify('You are on today\'s Screening duty — 🟢 Start Triaging when you are at your counter.', 'success'); }
  else { if (_active) await window.clearSelection(); _enterReadOnly(); }
  await window.loadQueue();
}

function _emptyQueue(text) {
  $('queue-list').replaceChildren(h('div', { class: 'queue-empty' }, h('strong', { text })));
}

async function _mountStrip(stats) {
  await mountScreeningStrip({ supabase, root: $('scr-ncism-strip'), today, stats: stats || null,
    onOpenRange: settings => openDeptRange({ supabase, today, settings, errorText: safeErrorMessage, tenantName: profile?.tenants?.name || '' }),
    onOpenDept: (settings, dept, index) => openDeptChart({ supabase, today, settings, dept, index, errorText: safeErrorMessage, tenantName: profile?.tenants?.name || '' }) });
}

async function _loadTargets() {
  const { data, error } = await supabase.rpc('screening_route_targets');
  const sel = $('scr-opd');
  sel.replaceChildren(h('option', { value: '' }, '— Choose the OPD —'));
  if (error) { notify(safeErrorMessage(error, 'The OPD list could not be loaded.'), 'error'); _targets = []; return; }
  _targets = data || [];
  for (const t of _targets) {
    const name = t.department_name && t.department_name !== t.opd_name ? `${t.opd_name} — ${t.department_name}` : t.opd_name;
    sel.append(h('option', { value: t.opd_id }, t.is_emergency ? `${name} (Emergency OPD)` : name));
  }
}

async function _loadSupervisors() {
  const sel = $('scr-supervisor');
  const { data, error } = await supabase.rpc('screening_supervisors');
  sel.replaceChildren(h('option', { value: '' }, error ? '— Supervisor list not loaded — reload the page —' : '— Choose the supervising doctor —'));
  for (const d of data || []) sel.append(h('option', { value: d.doctor_id }, d.designation ? `${d.name} (${desigWords(d.designation)})` : d.name));
}

// ── Duty + counter (B3) ───────────────────────────────────────────────────────
function _updateDutyUI() {
  const on = !!_me?.duty_session_id;
  $('btn-screening-duty-toggle').textContent = on ? '🔴 Stop Triaging' : '🟢 Start Triaging';
  $('screening-duty-status').textContent = on ? `On duty at ${_me.counter || '—'} — your fair share (+ anything unassigned)` : `${START_FIRST} The full queue is shown.`;
  $('scr-counter').disabled = on;
}

// V4 (owner 2 Nov 2026): leaving the counter box -> "already in use by …" at once (the server's check at Start stays)
const _ckey = t => String(t || '').toLowerCase().replace(/\s/g, '');
async function _checkCounterName() {
  const msg = $('scr-counter-msg'), v = $('scr-counter').value.trim();
  msg.textContent = ''; msg.classList.remove('scr-warn');
  if (!v || _me?.duty_session_id) return;
  const { data } = await supabase.rpc('screening_me');
  if (data) _me = data;
  const hit = (_me?.counters_in_use || []).find(c => _ckey(c.counter) === _ckey(v));
  if (hit) { msg.textContent = `${v} is already in use by ${hit.name} — choose another.`; msg.classList.add('scr-warn'); }
}
$('scr-counter').addEventListener('focusout', _checkCounterName);
$('scr-counter').addEventListener('input', () => { $('scr-counter-msg').textContent = ''; });

// screening_me again (the counter, the suggestion for the next free one)
async function _refreshMe() {
  const { data } = await supabase.rpc('screening_me');
  if (data) _me = data;
  if (!_me.duty_session_id) $('scr-counter').value = _me.suggested_counter || $('scr-counter').value;
}

window.toggleScreeningDuty = async function() {
  if (_me?.duty_session_id) {
    if (_active) await window.clearSelection();   // the server also releases my claims when the session ends (G8)
    const { error } = await supabase.from('staff_duty_sessions').update({ ended_at: new Date().toISOString() }).eq('id', _me.duty_session_id);
    if (error) { notify(safeErrorMessage(error, 'Could not end your Screening duty.'), 'error'); return; }
    _me.duty_session_id = null; _me.counter = null;
    await _refreshMe();
  } else {
    const counter = $('scr-counter').value.trim();
    if (!counter) { notify('Give the counter a name of 1 to 30 characters (e.g. Counter 1).', 'error'); $('scr-counter').focus(); return; }
    const { data, error } = await supabase.rpc('screening_set_counter', { p_counter: counter });
    if (error) {
      // R2: "Counter 2 is already in use by <name> — choose another." -> the next free one is filled in again
      notify(safeErrorMessage(error, 'Could not start your Screening duty.'), 'error');
      await _refreshMe();
      $('scr-counter').focus();
      return;
    }
    _me.duty_session_id = data; _me.counter = counter;
  }
  _updateDutyUI();
  await window.loadQueue();
};

// ── Queue ─────────────────────────────────────────────────────────────────────
window.refreshAll = async function() { await window.loadQueue(); };

window.loadQueue = async function(quiet = false) {
  if (!_screeningOpdId || !(_me?.can_screen || _me?.read_only_queue)) return;
  if (!quiet && !_queue.length) _emptyQueue('Loading…');
  const { data, error } = await supabase.rpc('screening_queue_today');
  if (error) { if (!quiet) _emptyQueue(safeErrorMessage(error, 'Could not load the queue.')); return; }
  let rows = data || [];
  // On duty: my fair share + anything nobody was assigned + whatever I have open (a page filter, contract §10.2)
  if (_me.can_screen && _me.duty_session_id) rows = rows.filter(r => !r.assigned_screener_id || r.assigned_screener_id === profile.id || r.claimed_by_me);
  _queue = rows;
  // the patient I have open vanished from the queue (routed / no longer waiting) -> say so, stop routing
  if (_active && !_queue.some(r => r.visit_id === _active.visit_id)) _lose('This patient is no longer in the Screening queue (routed or closed at another counter).');
  _renderQueue();
  _loadStats();
  if (!quiet) loadScanBypassLog();
};

window.readOnlyInfo = function() {
  notify(_me?.can_keep_list ? 'Read-only — add yourself to today\'s Screening duty list to screen (🗓 Screening duty tab).'
    : 'Read-only — you are not on today\'s Screening duty list. Ask the Medical Superintendent.', 'info');
};

function _tags(r) {
  const out = [];
  // V8 (owner 2 Nov 2026): the bill is not paid (or there is none yet) -- a highlighted badge with the word
  if (r.bill_status !== 'paid') out.push(h('span', { class: 'scr-badge-unpaid' }, r.bill_status === 'pending' ? 'UNPAID — bill pending' : 'UNPAID'));
  if (r.visit_category === 'emergency') out.push(h('span', { class: 'scr-badge scr-badge-emergency' }, 'EMERGENCY'));
  if (r.is_on_request) out.push(h('span', { class: 'qi-tag' }, `ON REQ${r.requested_doctor_name ? ': ' + r.requested_doctor_name : ''}`));
  if (r.is_teleconsultation) out.push(h('span', { class: 'qi-tag' }, '🎥 TELE'));
  if (r.visit_category === 'panchakarma') out.push(h('span', { class: 'qi-tag' }, 'Panchakarma'));
  if (r.pain_score !== null && r.pain_score !== undefined) out.push(h('span', { class: 'qi-tag' }, `Pain ${r.pain_score}/10`));
  return out;
}

function _renderQueue() {
  $('q-count').textContent = _queue.length;
  if (!_queue.length) {
    _emptyQueue('No patients waiting for screening.');
    $('queue-list').firstChild.append(h('br'), h('br'), 'When Reception registers a new patient, they appear here.');
    return;
  }
  const list = _queue.map(r => {
    const held = claimText(r);
    const mine = r.claim_active && r.claimed_by_me;
    const meta = [r.phone, r.gender, r.age ? r.age + 'y' : ''].filter(Boolean).join(' · ');
    const ro = !_me.can_screen;   // the read-only view: a click says why (V5), it never opens
    const open = h('button', ro ? { type: 'button', class: 'qi-open', 'data-onclick': 'readOnlyInfo',
      'aria-label': `Token ${r.token_number ?? '?'}, ${r.patient_name || 'Unknown'} — read-only` } : { type: 'button', class: 'qi-open', 'data-onclick': 'selectVisit', 'data-onclick-a0': r.visit_id,
      disabled: !!held, 'aria-disabled': held ? 'true' : null,
      'aria-label': `Token ${r.token_number ?? '?'}, ${r.patient_name || 'Unknown'}${held ? ' — ' + held : mine ? ' — open at your counter' : ''}` },
      h('div', { class: 'qi-top' }, h('span', { class: 'qi-token' }, `#${r.token_number ?? '?'}`), h('span', { class: 'qi-name' }, r.patient_name || 'Unknown')),
      meta ? h('div', { class: 'qi-meta' }, meta) : null,
      r.chief_complaint ? h('div', { class: 'qi-cc' }, r.chief_complaint) : null,
      h('div', { class: 'qi-tags' }, _tags(r)),
      held ? h('div', { class: 'qi-held' }, `🔒 ${held}`) : null,
      mine ? h('div', { class: 'qi-mine' }, `✓ Open at your counter (${r.claim_counter || '—'})`) : null);
    const card = h('div', { class: `qi${_active?.visit_id === r.visit_id ? ' active' : ''}${held ? ' held' : ''}${ro ? ' readonly' : ''}` }, open);
    if (held && _me.can_release_any) card.append(h('button', { type: 'button', class: 'qi-release', 'data-onclick': 'openAdminRelease', 'data-onclick-a0': r.visit_id }, 'Release…'));
    return card;
  });
  $('queue-list').replaceChildren(...list);
}

async function _loadStats() {
  const { data, error } = await supabase.rpc('screening_today_stats');
  if (error || !data) return;
  $('ss-waiting').textContent = data.waiting ?? '—';
  $('ss-with').textContent = data.with_counters ?? '—';
  $('ss-screened').textContent = data.screened_today ?? '—';
  $('ss-mine').textContent = data.screened_by_me ?? '—';
  $('ss-emergency').textContent = data.emergency_today ?? '—';
  const notSeen = document.querySelector('#scr-ncism-strip .sd-extra');
  if (notSeen && data.screened_not_seen !== undefined) notSeen.textContent = `Screened, not yet seen by a department doctor: ${data.screened_not_seen}`;
}

// Session 181: ABHA Scan & Share patients who went straight to a department (passive awareness, not a queue)
async function loadScanBypassLog() {
  const row = $('scan-bypass-row');
  let query = supabase.from('visits').select('id, token_number, created_at, opds(name), patients(name)')
    .eq('tenant_id', tenantId).eq('routed_via_scan_qr', true)
    .gte('created_at', today + 'T00:00:00+05:30').lte('created_at', today + 'T23:59:59.999+05:30');
  if (_screeningOpdId) query = query.neq('opd_id', _screeningOpdId);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) { console.warn('[screening] loadScanBypassLog:', error.message); return; }
  const rows = data || [];
  $('scan-bypass-count').textContent = rows.length;
  row.style.display = rows.length ? '' : 'none';
  $('scan-bypass-list').replaceChildren(...rows.map(v => h('div', { class: 'qi-meta', style: 'padding:6px 0;border-top:1px solid #d8ecdd' },
    h('strong', {}, v.patients?.name || 'Unknown'), ` — Token #${v.token_number ?? '—'} · ${v.opds?.name || 'Unknown department'} · ABHA Scan & Share`)));
}
window.toggleScanBypassList = function() {
  const list = $('scan-bypass-list');
  const open = list.style.display !== 'none';
  list.style.display = open ? 'none' : '';
  $('scan-bypass-toggle-icon').textContent = open ? '▾' : '▴';
  $('scan-bypass-btn').setAttribute('aria-expanded', open ? 'false' : 'true');
};

// ── Open (claim) / release ────────────────────────────────────────────────────
function _myCounter() { return _me?.counter || $('scr-counter').value.trim() || null; }

window.selectVisit = async function(visitId) {
  const row = _queue.find(r => r.visit_id === visitId);
  if (!row || !_me?.can_screen) return;
  if (!_me.duty_session_id) {   // R1: the server refuses it too
    notify(START_FIRST, 'error');
    $('btn-screening-duty-toggle').focus();
    return;
  }
  if (_active && _active.visit_id === visitId && !_claimLost) return;
  if (_active) await _releaseOwn();
  const { data, error } = await supabase.rpc('screening_claim', { p_visit: visitId, p_counter: _myCounter() });
  if (error) {
    notify(safeErrorMessage(error, 'Could not open this patient.'), 'error');
    await window.loadQueue(true);
    return;
  }
  _active = row;
  _claimLost = false;
  _fillForm(row, data);
  _startRenew();
  _renderQueue();
};

// V2 (owner re-check 2 Nov 2026; found: ONE renewal answered 502 by the server, the page then gave the patient up while the screener was
// typing): the claim is renewed every minute AND on any activity in the form (at most every 30 s). Only a REAL refusal ends it -- another
// counter took the patient, it was routed / closed, the screener is off duty; anything else (a network / server hiccup) keeps the form
// and everything typed, and tries again. screening_claim also re-claims the screener's own lapsed claim when nobody else took it.
const DEFINITE_LOSS = /^(This patient is with |Already routed by|This visit is no longer waiting|This visit is not in today|You are not on Screening duty today|Click 🟢 Start Triaging|Visit not found)/;
let _lastRenew = 0, _renewing = null;
function _renew() {
  if (!_active || _claimLost) return Promise.resolve(false);
  if (_renewing) return _renewing;
  const vid = _active.visit_id;
  _renewing = (async () => {
    const { error } = await supabase.rpc('screening_claim', { p_visit: vid, p_counter: _myCounter() });
    if (!_active || _active.visit_id !== vid) return false;
    if (!error) { _lastRenew = Date.now(); _connNote(false); return true; }
    if (DEFINITE_LOSS.test(error.message || '')) { _lose(safeErrorMessage(error, 'This patient is no longer open at your counter.')); return false; }
    _connNote(true);
    return false;
  })().finally(() => { _renewing = null; });
  return _renewing;
}
function _connNote(on) {
  const n = $('claim-note');
  if (!n || !_active) return;
  n.dataset.conn = on ? '1' : '';
  if (on) n.textContent = '⚠ Connection problem — your patient stays open here and nothing typed is lost; trying again…';
  else if (n.dataset.text) n.textContent = n.dataset.text;
}
function _startRenew() {
  clearInterval(_renewTimer);
  _lastRenew = Date.now();
  _renewTimer = setInterval(() => { _renew(); }, RENEW_MS);
}
const _onActivity = () => { if (_active && !_claimLost && Date.now() - _lastRenew > 30000) _renew(); };
['input', 'keydown', 'click'].forEach(ev => $('screening-form').addEventListener(ev, _onActivity));

function _lose(text) {
  if (!_active || _claimLost) return;
  _claimLost = true;
  clearInterval(_renewTimer);
  const a = $('form-alert');
  a.textContent = `${text} Nothing was saved — close this form and pick the patient again if needed.`;
  a.hidden = false;
  $('btn-route').disabled = true;
}

async function _releaseOwn() {
  clearInterval(_renewTimer);
  const v = _active;
  _active = null;
  if (!v || _claimLost) return;
  const { error } = await supabase.rpc('screening_release', { p_visit: v.visit_id });
  if (error) notify(safeErrorMessage(error, 'Could not release the patient (it frees itself after 5 minutes).'), 'error');
}

window.clearSelection = async function() {
  await _releaseOwn();
  _claimLost = false;
  $('form-empty').style.display = 'flex';
  $('screening-form').style.display = 'none';
  await window.loadQueue(true);
};

// closing the tab frees the patient at once (best effort -- the claim lapses after 5 minutes anyway)
// (a supabase request is sent only once .then() is called on it)
window.addEventListener('pagehide', () => { if (_active && !_claimLost) supabase.rpc('screening_release', { p_visit: _active.visit_id }).then(() => {}, () => {}); });

// Admin release of another counter's patient (reason, audited)
window.openAdminRelease = function(visitId) {
  const r = _queue.find(x => x.visit_id === visitId);
  if (!r) return;
  _relVisit = visitId;
  $('rel-title').textContent = `Release ${r.patient_name || 'this patient'} (${claimText(r) || 'no longer held'})`;
  $('rel-reason').value = '';
  $('rel-msg').textContent = '';
  $('rel-panel').hidden = false;
  $('rel-reason').focus();
};
window.closeAdminRelease = function() { $('rel-panel').hidden = true; _relVisit = null; };
window.confirmAdminRelease = async function() {
  const reason = $('rel-reason').value.trim();
  if (reason.length < 5 || reason.length > 300) { $('rel-msg').textContent = "Give the reason for releasing another counter's patient (5 to 300 characters)."; return; }
  const { data, error } = await supabase.rpc('screening_release', { p_visit: _relVisit, p_reason: reason });
  if (error) { $('rel-msg').textContent = safeErrorMessage(error, 'Could not release the patient.'); return; }
  notify(data ? 'Released — any counter can open the patient now.' : 'Nobody held this patient any more.', data ? 'success' : 'info');
  window.closeAdminRelease();
  await window.loadQueue(true);
};

// ── The form ──────────────────────────────────────────────────────────────────
function _fillForm(r, claim) {
  $('pt-avatar').textContent = (r.patient_name || '?').charAt(0).toUpperCase();
  $('pt-name').textContent = r.patient_name || '—';
  $('pt-meta').textContent = [r.phone, r.gender, r.age ? r.age + 'y' : '', r.abha_number ? 'ABHA ✓' : ''].filter(Boolean).join(' · ') || '—';
  $('pt-tags').replaceChildren(..._tags(r));
  $('pt-token').textContent = '#' + (r.token_number ?? '?');
  $('claim-note').textContent = `Open at your counter (${claim?.counter || _myCounter() || '—'}) — the other counters see "With ${claim?.counter || '—'}". It stays yours while you work; it frees itself only if left untouched for 5 minutes.`;
  $('claim-note').dataset.text = $('claim-note').textContent;
  $('scr-cc').value = r.chief_complaint || '';
  for (const f of NUM_FIELDS) $(f.id).value = '';
  ['scr-notes', 'scr-inv', 'scr-instructions', 'scr-reason'].forEach(id => { $(id).value = ''; });
  $('scr-naadi').value = '';
  $('scr-bmi').textContent = '—';
  $('scr-supervisor').value = '';
  _clearErrors();
  _triage = null;
  document.querySelectorAll('.triage-opt').forEach(b => b.setAttribute('aria-checked', 'false'));
  $('scr-opd').value = '';
  $('scr-doctor').replaceChildren(h('option', { value: '' }, '— Choose the OPD first —'));
  $('scr-dept-suggest-hint').hidden = true;
  $('form-alert').hidden = true;
  _deptManuallyOverridden = false;
  $('scr-supervisor-wrap').hidden = !(_me.is_intern || _me.needs_supervisor);
  $('scr-supervisor-req').textContent = _me.needs_supervisor ? '(required for an intern)' : '(optional)';
  $('form-empty').style.display = 'none';
  $('screening-form').style.display = 'flex';
  _applyRouteMode();
  if (r.is_on_request && r.requested_doctor_id) _preselectRequested(r);
  else _autoSuggest();
  $('btn-route').disabled = false;
  document.querySelector('.triage-opt').focus();
}

// "On request by doctor": open that doctor's OPD (today's duty list) and select the doctor; changing it needs a reason (B7)
async function _preselectRequested(r) {
  const { data } = await supabase.from('opd_doctors').select('opd_id').eq('tenant_id', tenantId).eq('doctor_id', r.requested_doctor_id).eq('active_on', today);
  const opd = (data || []).map(x => x.opd_id).find(id => _targets.some(t => t.opd_id === id && !t.is_emergency));
  if (!opd || _active?.visit_id !== r.visit_id) { _autoSuggest(); _onDoctorChanged(); return; }
  _deptManuallyOverridden = true;
  $('scr-opd').value = opd;
  await _onOpdChanged(false, r.requested_doctor_id);
}

window.calcBMI = function() {
  const b = bmi($('scr-height').value, $('scr-weight').value);
  $('scr-bmi').textContent = b === null ? '—' : `${b} (the server records its own)`;
};

window.selectTriage = function(key) {
  _triage = key;
  document.querySelectorAll('.triage-opt').forEach(b => b.setAttribute('aria-checked', b.dataset.triage === key ? 'true' : 'false'));
  $('scr-triage-err').textContent = '';
  _applyRouteMode();
};

const _emergencyOpd = () => _targets.find(t => t.is_emergency) || null;

// Emergency triage (B4): with a marked Emergency OPD the route box becomes "Route to Emergency OPD (casualty)" (no OPD / doctor);
// without one (owner Q3) the screener still chooses the OPD, the visit is marked EMERGENCY -- never refused.
function _applyRouteMode() {
  const em = _triage === 'emergency', emOpd = _emergencyOpd();
  const note = $('scr-emerg-note');
  if (em && emOpd) {
    note.textContent = `⛔ Emergency → ${emOpd.opd_name}, no doctor chosen: the RMO / CMO / EMO on duty take the patient, at the top of their queue.`;
    note.hidden = false;
    $('scr-route-fields').hidden = true;
  } else if (em) {
    note.textContent = `⛔ ${NO_EMERGENCY_OPD} The patient goes to the OPD chosen below, marked EMERGENCY at the top of that queue.`;
    note.hidden = false;
    $('scr-route-fields').hidden = false;
  } else {
    note.hidden = true;
    $('scr-route-fields').hidden = false;
  }
  _routeLabel();
}

function _routeLabel() {
  const btn = $('btn-route');
  const em = _triage === 'emergency', emOpd = _emergencyOpd();
  const t = _targets.find(x => x.opd_id === $('scr-opd').value);
  btn.classList.toggle('emergency', em);
  btn.textContent = em && emOpd ? '⛔ Route to Emergency OPD (casualty)' : em ? `⛔ Route as EMERGENCY to ${t ? t.opd_name : 'OPD'}` : `↗ Route to ${t ? t.opd_name : 'OPD'}`;
}

window.onOpdChange = function() { _deptManuallyOverridden = true; $('scr-dept-suggest-hint').hidden = true; _onOpdChanged(true); };

// the doctor list = the server's duty list for today in that OPD; NEVER pre-selected (F-347-2) except the requested doctor
async function _onOpdChanged(_byHand, selectDoctor = null) {
  const opdId = $('scr-opd').value;
  const sel = $('scr-doctor');
  $('scr-opd').removeAttribute('aria-invalid'); $('scr-opd-err').textContent = '';
  _routeLabel();
  if (!opdId) { sel.replaceChildren(h('option', { value: '' }, '— Choose the OPD first —')); _onDoctorChanged(); return; }
  sel.replaceChildren(h('option', { value: '' }, 'Loading doctors…'));
  const { data, error } = await supabase.rpc('opd_doctors_on_duty', { p_opd_id: opdId });
  if ($('scr-opd').value !== opdId) return;
  sel.replaceChildren(h('option', { value: '' }, NO_DOCTOR));
  if (error) sel.append(h('option', { value: '', disabled: true }, '— Doctor list not loaded — reload the page —'));
  const docs = (data || []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (!error && !docs.length) sel.append(h('option', { value: '', disabled: true }, '— No doctor on duty today in this OPD —'));
  for (const d of docs) sel.append(h('option', { value: d.doctor_id }, d.name));
  if (selectDoctor && docs.some(d => d.doctor_id === selectDoctor)) sel.value = selectDoctor;
  _onDoctorChanged();
}

window.onDoctorChange = () => _onDoctorChanged();
// a reason is needed when the requested doctor is changed (B7) or when the screener routes the patient to HIMSELF (owner 2 Nov 2026,
// flagged "self-routed" -- not when the patient asked for him: "on request")
let _reasonKind = null;
function _onDoctorChanged() {
  const r = _active, doc = $('scr-doctor').value;
  const reqChange = !!(r?.is_on_request && r.requested_doctor_id && doc !== r.requested_doctor_id);
  const self = !!(doc && doc === profile?.id && !(r?.is_on_request && r.requested_doctor_id === profile?.id));
  _reasonKind = self ? 'self' : reqChange ? 'request' : null;
  $('scr-reason-wrap').hidden = !_reasonKind;
  $('scr-reason-label').textContent = self && reqChange ? 'Reason for routing the patient to yourself instead of the requested doctor'
    : self ? 'Reason for routing the patient to yourself' : 'Reason for changing the requested doctor';
}

function _clearErrors() {
  document.querySelectorAll('#screening-form .scr-err').forEach(e => { e.textContent = ''; e.classList.remove('scr-warn', 'scr-alert'); });
  document.querySelectorAll('#screening-form [aria-invalid]').forEach(e => { e.removeAttribute('aria-invalid'); e.removeAttribute('aria-describedby'); });
}
function _fieldError(id, message) {
  const box = $(id), err = $(id + '-err');
  if (err) err.textContent = message;
  if (box && box.tagName !== 'DIV') { box.setAttribute('aria-invalid', 'true'); if (err) box.setAttribute('aria-describedby', id + '-err'); }
}
function _fieldClear(id) {
  const box = $(id), err = $(id + '-err');
  if (err) { err.textContent = ''; err.classList.remove('scr-warn', 'scr-alert'); }
  if (box) { box.removeAttribute('aria-invalid'); box.removeAttribute('aria-describedby'); }
}

// G5 (owner 2 Nov 2026): a field's mistake is shown as soon as the screener LEAVES the field (the same rules as Route / the server);
// the BP pair is judged when both boxes are filled or the diastolic box is left
const FIELD_IDS = new Set([...NUM_FIELDS, ...TEXT_FIELDS].map(f => f.id));
function _rawFindings() {
  const raw = { triage: _triage };
  for (const f of NUM_FIELDS) raw[f.key] = $(f.id).value;
  for (const f of TEXT_FIELDS) raw[f.key] = $(f.id).value;
  return raw;
}
function _checkField(id) {
  const ids = id === 'scr-bp-s' || id === 'scr-bp-d' ? ['scr-bp-s', 'scr-bp-d'] : [id];
  ids.forEach(_fieldClear);
  const { errors } = buildFindings({ ..._rawFindings(), triage: 'routine' });
  const pairPending = id === 'scr-bp-s' && !$('scr-bp-d').value.trim();
  const shown = errors.filter(e => ids.includes(e.id) && !(e.key === 'bp' && pairPending));
  shown.forEach(e => _fieldError(e.id, e.message));
  // V1: a clinically abnormal (but possible) value -> an amber flag with its word, never a refusal
  const { findings } = buildFindings({ ..._rawFindings(), triage: 'routine' });
  const bad = new Set(shown.map(e => e.id));
  vitalFlags(findings).filter(x => ids.includes(x.id) && !bad.has(x.id)).forEach(x => {
    const err = $(x.id + '-err');
    if (!err) return;
    // red (pulse > 150): a prompt to consider ⛔ Emergency triage -- the screener decides; amber: a flag for the doctor
    err.textContent = x.level === 'red' ? `${x.text}: press ⛔ Emergency above if you agree (your decision — routing is not blocked)`
      : `⚠ ${x.text} — a flag for the doctor (not an error)`;
    err.classList.add('scr-warn');
    err.classList.toggle('scr-alert', x.level === 'red');
  });
}
$('screening-form').addEventListener('focusout', e => { if (FIELD_IDS.has(e.target?.id)) _checkField(e.target.id); });

// ── Route: ONE server step (B3) ──────────────────────────────────────────────
window.routePatient = async function() {
  if (!_active || _claimLost) return;
  _clearErrors();
  const { findings, errors } = buildFindings(_rawFindings());
  const em = findings.triage === 'emergency', emOpd = _emergencyOpd();
  const opd = $('scr-opd').value || null, doctor = $('scr-doctor').value || null;
  if (!(em && emOpd) && !opd) errors.push({ id: 'scr-opd', message: 'Choose the OPD to send the patient to.' });
  const supervisor = $('scr-supervisor').value || null;
  if (_me.needs_supervisor && !supervisor) errors.push({ id: 'scr-supervisor', message: 'An intern routes a patient only with a supervising doctor.' });
  const needReason = !$('scr-reason-wrap').hidden && !(em && emOpd);
  const reason = $('scr-reason').value.trim();
  if (needReason && (reason.length < 5 || reason.length > 300)) errors.push({ id: 'scr-reason', message: _reasonKind === 'self'
    ? 'Give the reason for routing the patient to yourself (5 to 300 characters).' : 'Give the reason for changing the requested doctor (5 to 300 characters).' });
  if (errors.length) {
    errors.forEach(e => _fieldError(e.id, e.message));
    notify(errors.length === 1 ? `${fixCount(1)}: ${errors[0].message}` : `${fixCount(errors.length)} before routing (marked in red).`, 'error');
    const first = errors[0].id === 'scr-triage' ? document.querySelector('.triage-opt') : $(errors[0].id);
    first?.focus();
    return;
  }
  const btn = $('btn-route');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Routing…';
  const args = { p_visit: _active.visit_id, p_findings: findings, p_opd: em && emOpd ? null : opd, p_doctor: em && emOpd ? null : doctor,
    p_reason: needReason ? reason : null, p_supervisor: supervisor };
  if (Date.now() - _lastRenew > 60000) await _renew();
  if (_claimLost) { btn.textContent = label; return; }
  let { data, error } = await supabase.rpc('screening_route_visit', args);
  if (error && /^Open the patient first/.test(error.message || '') && await _renew()) {
    ({ data, error } = await supabase.rpc('screening_route_visit', args));   // V2: my own lapsed claim, re-claimed -- one more try
  }
  if (error) {
    btn.disabled = false; btn.textContent = label;
    const msg = safeErrorMessage(error, 'The patient was not routed. Nothing was saved.');
    const a = $('form-alert'); a.textContent = msg; a.hidden = false;
    notify(msg, 'error');
    if (/^(Already routed by|This visit is no longer waiting|Open the patient first)/.test(error.message || '')) _lose(msg);
    return;
  }
  const name = _active.patient_name || 'Patient';
  clearInterval(_renewTimer);
  _active = null;
  notify(`${name} routed to ${data?.opd_name || 'the OPD'} — token #${data?.token_number ?? '?'} · ${data?.doctor_name || 'OPD shared queue'}${data?.emergency ? ' · EMERGENCY' : ''}${data?.route_flag === 'self_routed' ? ' · self-routed (logged)' : ''}.`, 'success');
  if (data?.no_emergency_opd) notify(NO_EMERGENCY_OPD, 'warning');
  $('form-empty').style.display = 'flex';
  $('screening-form').style.display = 'none';
  await window.loadQueue(true);
  const { data: stats } = await supabase.rpc('screening_today_stats');
  _mountStrip(stats);
};

// ── Tabs + Screener log (B10) ─────────────────────────────────────────────────
window.showScrTab = function(which) {
  for (const k of ['screen', 'duty', 'log']) {
    $('tab-' + k).setAttribute('aria-selected', k === which ? 'true' : 'false');
    $('pane-' + k).hidden = k !== which;
  }
  if (which === 'log' && !_logRows.length) window.loadScreenerLog();
  if (which === 'duty') _openDuty();
};

const LOG_HEAD = ['Screener', 'Designation', 'Counter', 'Routed', 'Average minutes (open → route)', 'Routine', 'Semi-urgent', 'Urgent', 'Emergency',
  'Self-routed', 'Own OPD', 'On request', 'OPDs chosen', 'Supervised by'];
const LOG_NUM = [3, 5, 6, 7, 8, 9, 10, 11];
const OPD_COL = 12;
const pairs = o => Object.entries(o || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
const logCells = r => [r.screener_name || '—', r.designation ? desigWords(r.designation) : '—', r.counter_label || '—', String(r.routed ?? 0),
  r.avg_minutes === null || r.avg_minutes === undefined ? '—' : String(r.avg_minutes), String(r.routine ?? 0), String(r.semi_urgent ?? 0), String(r.urgent ?? 0),
  String(r.emergency ?? 0), String(r.self_routed ?? 0), String(r.own_opd ?? 0), String(r.on_request ?? 0), pairs(r.by_opd) || '—', pairs(r.supervised_by) || '—'];
// F1: the OPDs chosen with their department's colour (always with the name)
function _opdCell(byOpd) {
  const items = Object.entries(byOpd || {});
  if (!items.length) return '—';
  const wrap = h('span', {});
  items.forEach(([name, n], i) => {
    const t = _targets.find(x => x.opd_name === name);
    const idx = Math.max(0, _targets.findIndex(x => x.opd_name === name));
    if (i) wrap.append(', ');
    wrap.append(deptLabel(`${name}: ${n}`, t?.ncism_code, idx));
  });
  return wrap;
}

window.loadScreenerLog = async function() {
  const f = $('log-from').value, t = $('log-to').value, msg = $('log-msg');
  if (!f || !t) { msg.textContent = 'Choose both dates.'; return; }
  if (f > t) { msg.textContent = 'The From date is after the To date.'; return; }
  msg.textContent = 'Loading…';
  const { data, error } = await supabase.rpc('screening_log', { p_from: f, p_to: t });
  if (error) { msg.textContent = safeErrorMessage(error, 'The screener log could not be loaded.'); $('log-body').replaceChildren(); _logRows = []; return; }
  _logRows = data || [];
  msg.textContent = _logRows.length ? '' : 'No patient was routed in this period.';
  const tbl = h('table', { class: 'ncr-table', id: 'log-table' }, h('thead', {}, h('tr', {}, LOG_HEAD.map(x => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, _logRows.map(r => h('tr', {}, logCells(r).map((v, i) => h('td', {}, i === OPD_COL ? _opdCell(r.by_opd) : v))))));
  $('log-body').replaceChildren(tbl);
};
window.downloadScreenerLog = async function() {
  if (!_logRows.length) { $('log-msg').textContent = 'Press Show first (or there is nothing to download).'; return; }
  const { xlsxBlob, downloadBlob } = await import('../utils/xlsxWriter.js');
  const rows = [['Screener log', `${$('log-from').value} to ${$('log-to').value}`], [], LOG_HEAD].concat(_logRows.map(r => {
    const c = logCells(r); for (const i of LOG_NUM) c[i] = Number(c[i]); return c;
  }));
  downloadBlob(xlsxBlob([{ name: 'Screener log', rows }]), `screener_log_${$('log-from').value}_to_${$('log-to').value}.xlsx`);
};

// ── The Screening duty list (owner 2 Nov 2026) ───────────────────────────────
// kept by the Super Admin / MS / Deputy MS / RMO (today and up to 7 days ahead); the Medical Director reads it (B-D1)
const _addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const _dayLabel = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' });
async function _openDuty() {
  const sel = $('duty-date');
  if (!sel.options.length) {
    for (let i = 0; i <= 7; i++) { const d = _addDays(today, i); sel.append(h('option', { value: d }, i === 0 ? `Today — ${_dayLabel(d)}` : _dayLabel(d))); }
    sel.value = today;
  }
  const keep = !!_me?.can_keep_list;
  $('duty-add-wrap').hidden = !keep;
  $('duty-add-btn').hidden = !keep;
  $('duty-sub').textContent = keep
    ? 'Only the staff on a day\'s list can start a counter, see the queue, open and route patients that day. Taking someone off needs a reason; nothing is deleted.'
    : 'Only the staff on a day\'s list can start a counter, see the queue, open and route patients that day. The list is kept by the Super Admin, Medical Superintendent, Deputy MS or RMO.';
  if (keep && !_candidates) {
    const { data, error } = await supabase.rpc('screening_duty_candidates');
    _candidates = error ? [] : (data || []);
    if (error) $('duty-msg').textContent = safeErrorMessage(error, 'The staff list could not be loaded.');
  }
  await window.loadDutyList();
}
function _fillCandidates() {
  const sel = $('duty-add-who');
  const on = new Set(_dutyRows.filter(r => !r.removed).map(r => r.profile_id));
  sel.replaceChildren(h('option', { value: '' }, '— Choose a nurse, doctor or intern —'),
    ...(_candidates || []).filter(c => !on.has(c.profile_id)).map(c => h('option', { value: c.profile_id }, c.designation ? `${c.name} (${desigWords(c.designation)})` : c.name)));
}
window.loadDutyList = async function() {
  const day = $('duty-date').value || today, msg = $('duty-msg');
  msg.textContent = 'Loading…';
  const { data, error } = await supabase.rpc('screening_duty_day', { p_date: day });
  if (error) { msg.textContent = safeErrorMessage(error, 'The Screening duty list could not be loaded.'); $('duty-body').replaceChildren(); _dutyRows = []; return; }
  _dutyRows = data || [];
  const live = _dutyRows.filter(r => !r.removed).length;
  msg.textContent = live ? `${live} on Screening duty${day === today ? ' today' : ' on ' + _dayLabel(day)}.` : `Nobody is on Screening duty${day === today ? ' today' : ' on ' + _dayLabel(day)} yet.`;
  const keep = !!_me?.can_keep_list;
  const head = ['Name', 'Designation', ...(day === today ? ['Counter now', 'Screened'] : []), 'Added by', 'Status', ...(keep ? [''] : [])];
  const rows = _dutyRows.map(r => {
    const status = r.removed ? `Taken off by ${r.removed_by_name || '—'} at ${fmtTime(r.removed_at)}: ${r.remove_reason || ''}` : 'On duty';
    const cells = [h('td', {}, r.name || '—'), h('td', {}, r.designation ? desigWords(r.designation) : '—')];
    if (day === today) cells.push(h('td', {}, r.counter_label || (r.removed ? '—' : 'not started')), h('td', {}, String(r.screened ?? 0)));
    cells.push(h('td', {}, `${r.added_by_name || '—'} · ${fmtTime(r.added_at)}`), h('td', { class: 'duty-reason' }, status));
    if (keep) cells.push(h('td', {}, r.removed ? '' : h('button', { type: 'button', class: 'duty-rm-btn', 'data-onclick': 'openDutyRemove', 'data-onclick-a0': r.id,
      'aria-label': `Take ${r.name || 'this person'} off Screening duty` }, 'Take off…')));
    return h('tr', { class: r.removed ? 'duty-removed' : null }, cells);
  });
  $('duty-body').replaceChildren(_dutyRows.length ? h('table', { class: 'ncr-table', id: 'duty-table' },
    h('thead', {}, h('tr', {}, head.map(x => h('th', { scope: 'col' }, x)))), h('tbody', {}, rows)) : '');
  if (keep) _fillCandidates();
};
window.addToDuty = async function() {
  const who = $('duty-add-who').value, day = $('duty-date').value || today;
  if (!who) { $('duty-msg').textContent = 'Choose the person to put on Screening duty.'; $('duty-add-who').focus(); return; }
  const { error } = await supabase.rpc('screening_duty_add', { p_profile: who, p_date: day });
  if (error) { $('duty-msg').textContent = safeErrorMessage(error, 'The person was not added to the Screening duty list.'); return; }
  notify('Added to the Screening duty list.', 'success');
  await window.loadDutyList();
  if (who === profile?.id) await _modeAfterDutyChange();
};
window.openDutyRemove = function(id) {
  const r = _dutyRows.find(x => x.id === id);
  if (!r) return;
  _dutyRm = id;
  $('duty-rm-title').textContent = `Take ${r.name || 'this person'} off Screening duty`;
  $('duty-rm-reason').value = '';
  $('duty-rm-msg').textContent = '';
  $('duty-rm').hidden = false;
  $('duty-rm-reason').focus();
};
window.closeDutyRemove = function() { $('duty-rm').hidden = true; _dutyRm = null; };
window.confirmDutyRemove = async function() {
  const reason = $('duty-rm-reason').value.trim();
  if (reason.length < 5 || reason.length > 300) { $('duty-rm-msg').textContent = 'Give the reason for taking this person off Screening duty (5 to 300 characters).'; return; }
  const { error } = await supabase.rpc('screening_duty_remove', { p_id: _dutyRm, p_reason: reason });
  if (error) { $('duty-rm-msg').textContent = safeErrorMessage(error, 'The person was not taken off Screening duty.'); return; }
  const mine = _dutyRows.find(x => x.id === _dutyRm)?.profile_id === profile?.id;
  notify('Taken off Screening duty — any patient they had open is free again.', 'success');
  window.closeDutyRemove();
  await window.loadDutyList();
  if (mine) await _modeAfterDutyChange();
};

await init();
