import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['doctor','nurse','super_admin','dept_admin']);
initNavbar();
wireDelegatedEvents();
const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();

// ── State ─────────────────────────────────────────────────────────────────────
let _screeningOpdId = null;
let _departments    = [];    // { id, name, ncism_code, opd_id }
let _queue          = [];    // visits with patients
let _activeVisit    = null;
let _triage         = 'Routine';
let _screeningDutySessionId = sessionStorage.getItem('ax_screening_duty_session_id'); // queue redesign piece 3

// ── Init ──────────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0,10);

// Deferred to the bottom of the file, invoked there instead of running inline
// here. Real bug found live (Session 170): this block ends by calling
// window.loadQueue() — but window.loadQueue = async function(){...} (below) is a
// plain property assignment, not a hoisted function declaration, so it doesn't
// exist yet at THIS point in the file's top-to-bottom execution. Calling it here
// threw "window.loadQueue is not a function" and silently halted the rest of
// this init, leaving the queue stuck on the static "Loading queue…" placeholder
// forever — a first fix (prefixing the earlier bare `loadQueue()` call with
// `window.`) was necessary but not sufficient; the actual fix is running this
// whole block only after every window.* handler in the file has been assigned,
// via the `await _initScreeningQueue();` call at the very bottom of the file.
async function _initScreeningQueue() {
  _updateScreeningDutyUI(); // reflect a duty session restored from sessionStorage before the queue query below even runs
  document.getElementById('q-date').textContent = new Date(today + 'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short'});
  document.getElementById('ss-date').textContent = new Date(today + 'T00:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});

  // Get Screening OPD id for this tenant. Two ncism_code conventions exist side by side:
  // 'SCREEN' (short-form, current default seeding) and 'SCREENING_OPD' (long-form, legacy
  // tenants like Srishti Ayurveda) — check both rather than assuming one.
  const { data: screenOpds } = await supabase
    .from('opds')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('ncism_code', ['SCREEN', 'SCREENING_OPD']);
  const screenOpd = screenOpds?.[0];

  if (!screenOpd) {
    document.getElementById('queue-list').innerHTML = `
      <div class="queue-empty">
        <strong>Screening OPD not configured.</strong><br><br>
        Go to OPD Admin and ensure the Screening OPD (NCISM code: SCREEN) is active for your organisation.
      </div>`;
  } else {
    _screeningOpdId = screenOpd.id;
    await loadDepartments();
    await window.loadQueue();
  }
}

// ── Chief-complaint → specialty auto-suggestion ────────────────────────────────
// Keyed by ncism_code (not department id/name), so this works regardless of which
// OPDs/departments a given tenant actually has seeded -- a code with no matching
// department here just means no suggestion fires, exactly like any complaint text
// that doesn't match a keyword. Never blocks or replaces manual selection; the
// nurse can always change it, matching the screening-review-and-confirm model.
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

let _deptManuallyOverridden = false;

function _suggestDeptCode(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;
  for (const [code, keywords] of Object.entries(CC_KEYWORD_MAP)) {
    if (keywords.some(k => t.includes(k))) return code;
  }
  return null;
}

function _autoSuggestDept() {
  if (_deptManuallyOverridden) return;
  const code = _suggestDeptCode(document.getElementById('scr-cc').value);
  const hint = document.getElementById('scr-dept-suggest-hint');
  if (!code) { if (hint) hint.style.display = 'none'; return; }
  const dept = _departments.find(d => d.ncism_code === code);
  if (!dept) { if (hint) hint.style.display = 'none'; return; }
  const sel = document.getElementById('scr-dept');
  if (sel.value !== dept.id) {
    sel.value = dept.id;
    window.onDeptChange(); // same bare-identifier bug as loadQueue() above — window.-assigned, not module-scoped
  }
  if (hint) {
    hint.textContent = `💡 Suggested "${dept.name}" based on the complaint — confirm or change if needed.`;
    hint.style.display = '';
  }
}

document.getElementById('scr-cc').addEventListener('input', _autoSuggestDept);
document.getElementById('scr-dept').addEventListener('change', () => {
  _deptManuallyOverridden = true;
  const hint = document.getElementById('scr-dept-suggest-hint');
  if (hint) hint.style.display = 'none';
});

// ── Load departments for routing ──────────────────────────────────────────────
async function loadDepartments() {
  const { data } = await supabase
    .from('departments')
    .select('id,name,ncism_code,opd_id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');

  _departments = (data || []).filter(d => d.opd_id);  // only depts with an OPD

  const sel = document.getElementById('scr-dept');
  _departments.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
    sel.appendChild(o);
  });
}

// ── Multi-counter Screening duty toggle (queue redesign piece 3, 17 Aug 2026) ──
// Same fair-queue pattern as reception.html's Registration Queue: several staff can
// be on Screening duty at once (staff_duty_sessions, active_duty=['screening']),
// each new patient reception routes here is fair-assigned to whichever has fewest
// waiting (see reception.js's _createVisit()). This page just needs to know whether
// THIS viewer is on duty right now, to decide which queue query to run.
function _updateScreeningDutyUI() {
  const btn    = document.getElementById('btn-screening-duty-toggle');
  const status = document.getElementById('screening-duty-status');
  if (!btn || !status) return;
  if (_screeningDutySessionId) {
    btn.textContent = '🔴 Stop Triaging';
    status.textContent = 'Showing your fair share (+ anything unclaimed)';
  } else {
    btn.textContent = '🟢 Start Triaging (fair queue)';
    status.textContent = 'Showing the full Screening queue';
  }
}

window.toggleScreeningDuty = async function() {
  if (_screeningDutySessionId) {
    await supabase.from('staff_duty_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', _screeningDutySessionId);
    _screeningDutySessionId = null;
    sessionStorage.removeItem('ax_screening_duty_session_id');
  } else {
    const { data, error } = await supabase.from('staff_duty_sessions')
      .insert({ tenant_id: tenantId, profile_id: profile.id, active_duty: ['screening'] })
      .select('id').single();
    if (error) { alert(safeErrorMessage(error, 'Could not start your Screening duty session.')); return; }
    _screeningDutySessionId = data.id;
    sessionStorage.setItem('ax_screening_duty_session_id', data.id);
  }
  _updateScreeningDutyUI();
  await window.loadQueue();
};

// ── Load today's screening queue ──────────────────────────────────────────────
window.loadQueue = async function() {
  if (!_screeningOpdId) return;
  document.getElementById('queue-list').innerHTML = '<div class="queue-empty">Loading…</div>';

  let query = supabase
    .from('visits')
    .select('id,status,chief_complaint,token_number,created_at,abha_address,patients(id,name,phone,age,gender,abha_number)')
    .eq('tenant_id', tenantId)
    .eq('opd_id', _screeningOpdId)
    .in('status', ['waiting','in_progress'])
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59');
  // On duty: only this staffer's fair share, plus anything nobody had claimed at
  // assignment time (e.g. the gap before anyone toggled on) — never a silent loss.
  // Not on duty (the default, unchanged for a single-triage-nurse tenant): the full
  // undifferentiated queue, exactly as before this feature existed.
  if (_screeningDutySessionId) {
    query = query.or(`assigned_screener_id.eq.${profile.id},assigned_screener_id.is.null`);
  }
  const { data, error } = await query.order('token_number');

  if (error) {
    document.getElementById('queue-list').innerHTML = `<div class="queue-empty">Error: ${safeErrorMessage(error, 'Could not load queue.')}</div>`;
    return;
  }

  _queue = data || [];
  _renderQueue();
  _updateStats();
};

function _renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('q-count').textContent = _queue.length;

  if (!_queue.length) {
    list.innerHTML = '<div class="queue-empty">No patients waiting for screening.<br><br>When Reception registers a patient and selects the Screening OPD, they will appear here.</div>';
    return;
  }

  list.innerHTML = _queue.map(v => {
    const pt   = v.patients || {};
    const meta = [pt.phone, pt.gender, pt.age ? pt.age + 'y' : ''].filter(Boolean).join(' · ');
    const isActive = _activeVisit?.id === v.id;
    return `
      <div class="queue-item${isActive ? ' active' : ''}" data-onclick="selectVisit" data-onclick-a0="${v.id}">
        <div class="qi-top">
          <span class="qi-token">#${v.token_number || '?'}</span>
          <span class="qi-name">${_esc(pt.name || 'Unknown')}</span>
        </div>
        <div class="qi-meta">${_esc(meta)}</div>
        ${v.chief_complaint ? `<div class="qi-cc">${_esc(v.chief_complaint)}</div>` : ''}
      </div>`;
  }).join('');
}

async function _updateStats() {
  // Count screened today (completed visits from screening OPD today)
  const { count: screened } = await supabase
    .from('visits')
    .select('id', { count:'exact', head:true })
    .eq('tenant_id', tenantId)
    .eq('opd_id', _screeningOpdId)
    .eq('status', 'completed')
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59');

  document.getElementById('ss-waiting').textContent  = _queue.length + ' ';
  document.getElementById('ss-screened').textContent = (screened || 0) + ' ';
  document.getElementById('ss-emergency').textContent = '0 ';  // tracked after triage added
}

// ── Select patient from queue ─────────────────────────────────────────────────
window.selectVisit = function(visitId) {
  _activeVisit = _queue.find(v => v.id === visitId);
  if (!_activeVisit) return;

  const pt   = _activeVisit.patients || {};
  const meta = [pt.phone, pt.gender, pt.age ? pt.age + 'y' : ''].filter(Boolean).join(' · ');

  document.getElementById('pt-avatar').textContent = (pt.name || '?').charAt(0).toUpperCase();
  document.getElementById('pt-name').textContent   = pt.name || '—';
  document.getElementById('pt-meta').textContent   = meta || '—';
  document.getElementById('pt-token').textContent  = '#' + (_activeVisit.token_number || '?');
  document.getElementById('scr-cc').value          = _activeVisit.chief_complaint || '';

  // Reset form
  _triage = 'Routine';
  document.querySelectorAll('.triage-opt').forEach(el => el.className = 'triage-opt');
  document.querySelector('[data-triage="Routine"]').classList.add('active-routine');
  document.getElementById('scr-pulse').value        = '';
  document.getElementById('scr-bp').value           = '';
  document.getElementById('scr-temp').value         = '';
  document.getElementById('scr-spo2').value         = '';
  document.getElementById('scr-height').value       = '';
  document.getElementById('scr-weight').value       = '';
  document.getElementById('scr-bmi').value          = '';
  document.getElementById('scr-naadi').value        = '';
  document.getElementById('scr-notes').value        = '';
  document.getElementById('scr-dept').value         = '';
  document.getElementById('scr-doctor').innerHTML   = '<option value="">— Select department first —</option>';
  document.getElementById('scr-instructions').value = '';
  document.getElementById('btn-route').disabled     = true;
  document.getElementById('scr-dept-suggest-hint').style.display = 'none';
  _deptManuallyOverridden = false;

  // Show form
  document.getElementById('form-empty').style.display    = 'none';
  document.getElementById('screening-form').style.display = 'flex';
  document.getElementById('alert').classList.remove('show');

  _renderQueue();  // re-render to highlight active
  _autoSuggestDept();  // pre-fill from any complaint reception already captured
};

window.clearSelection = function() {
  _activeVisit = null;
  _triage      = 'Routine';
  document.getElementById('form-empty').style.display     = 'flex';
  document.getElementById('screening-form').style.display = 'none';
  _renderQueue();
};

// ── BMI auto-calculation ──────────────────────────────────────────────────────
window.calcBMI = function() {
  const h = parseFloat(document.getElementById('scr-height').value);
  const w = parseFloat(document.getElementById('scr-weight').value);
  const el = document.getElementById('scr-bmi');
  if (h > 0 && w > 0) {
    const bmi = (w / Math.pow(h / 100, 2)).toFixed(1);
    el.value = bmi;
  } else {
    el.value = '';
  }
};

// ── Triage selection ──────────────────────────────────────────────────────────
window.selectTriage = function(el) {
  _triage = el.dataset.triage;
  document.querySelectorAll('.triage-opt').forEach(t => t.className = 'triage-opt');
  const clsMap = { Emergency:'active-emergency', Urgent:'active-urgent', 'Semi-urgent':'active-semi', Routine:'active-routine' };
  el.classList.add(clsMap[_triage] || 'active-routine');
};

// ── Enable route button when dept is selected ─────────────────────────────────
window.onDeptChange = function() {
  const dept = document.getElementById('scr-dept').value;
  const btn  = document.getElementById('btn-route');
  btn.disabled = !dept;
  if (dept) {
    const d = _departments.find(d => d.id === dept);
    btn.textContent = '▙ Route to ' + (d ? d.name : 'OPD');
    loadOpdDoctors(d?.opd_id ?? null);
  } else {
    btn.textContent = '▙ Route to OPD';
    loadOpdDoctors(null);
  }
};

// Real bug found live (Session 170): routePatient() only ever set doctor_id when
// the person doing the ROUTING happened to themselves be logged in as a doctor —
// the actual triage workflow (a nurse or admin routing someone else) always left
// it null, and doctor.js's own queue is filtered strictly by doctor_id === the
// logged-in doctor's own id (never by OPD), so a routed visit was invisible to
// every doctor, always, not just in this specific test. Mirrors reception.js's
// loadDoctors() exactly — same opd_doctors "active today" roster, same fallback
// when nobody's marked active for that OPD yet.
async function loadOpdDoctors(opdId) {
  const sel = document.getElementById('scr-doctor');
  if (!opdId) { sel.innerHTML = '<option value="">— Select department first —</option>'; return; }

  const { data: opdDocs } = await supabase
    .from('opd_doctors')
    .select('doctor_id')
    .eq('opd_id', opdId)
    .eq('tenant_id', tenantId)
    .eq('is_active_today', true);

  const doctorIds = (opdDocs || []).map(d => d.doctor_id);
  if (doctorIds.length === 0) {
    sel.innerHTML = '<option value="">— No doctors active today for this OPD —</option>';
    return;
  }

  const { data: doctors } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', doctorIds)
    .eq('status', 'active')
    .order('full_name');

  sel.innerHTML = '<option value="">— Select doctor —</option>' +
    (doctors || []).map(d => `<option value="${d.id}">${_esc(d.full_name)}</option>`).join('');
  if (doctors?.length === 1) sel.value = doctors[0].id; // only one candidate — pick it, still overridable
}

// ── Route patient ─────────────────────────────────────────────────────────────
window.routePatient = async function() {
  if (!_activeVisit) return;

  const deptId = document.getElementById('scr-dept').value;
  if (!deptId) { _alert('error', 'Select a target department first.'); return; }

  const dept         = _departments.find(d => d.id === deptId);
  const cc           = document.getElementById('scr-cc').value.trim()          || _activeVisit.chief_complaint || '';
  const pulse        = document.getElementById('scr-pulse').value.trim();
  const bp           = document.getElementById('scr-bp').value.trim();
  const temp         = document.getElementById('scr-temp').value.trim();
  const spo2         = document.getElementById('scr-spo2').value.trim();
  const height       = document.getElementById('scr-height').value.trim();
  const weight       = document.getElementById('scr-weight').value.trim();
  const bmi          = document.getElementById('scr-bmi').value.trim();
  const naadi        = document.getElementById('scr-naadi').value.trim();
  const notes        = document.getElementById('scr-notes').value.trim();
  const instructions = document.getElementById('scr-instructions').value.trim();

  // Build screening summary to pass to specialty OPD
  const vitals = [
    pulse  && `PR: ${pulse}`,
    bp     && `BP: ${bp}`,
    temp   && `Temp: ${temp}`,
    spo2   && `SpO₂: ${spo2}`,
    height && `Ht: ${height}cm`,
    weight && `Wt: ${weight}kg`,
    bmi    && `BMI: ${bmi}`,
    naadi  && `Naadi: ${naadi}`,
  ].filter(Boolean).join(', ');
  let screeningSummary = `[Triage: ${_triage}]`;
  if (vitals)   screeningSummary += ` | Vitals: ${vitals}`;
  if (notes)    screeningSummary += ` | Screening note: ${notes}`;
  if (instructions) screeningSummary += ` | Instructions: ${instructions}`;

  const btn = document.getElementById('btn-route');
  btn.disabled = true; btn.textContent = 'Routing…';

  // Get next token number for target OPD today
  const { data: lastToken } = await supabase
    .from('visits')
    .select('token_number')
    .eq('tenant_id', tenantId)
    .eq('opd_id', dept.opd_id)
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59')
    .order('token_number', { ascending: false })
    .limit(1);

  const nextToken = lastToken?.[0]?.token_number ? lastToken[0].token_number + 1 : 1;

  // 1. Mark screening visit as completed
  const { error: errComplete } = await supabase
    .from('visits')
    .update({ status: 'completed', chief_complaint: cc })
    .eq('id', _activeVisit.id);

  if (errComplete) {
    _alert('error', 'Failed to complete screening visit: ' + errComplete.message);
    btn.disabled = false; btn.textContent = '↗ Route to OPD'; return;
  }

  // 2. Create new visit in target OPD queue
  const newVisit = {
    tenant_id:        tenantId,
    patient_id:       _activeVisit.patients.id,
    opd_id:           dept.opd_id,
    status:           'waiting',
    chief_complaint:  cc ? cc + '\n' + screeningSummary : screeningSummary,
    token_number:     nextToken,
    is_on_request:    false,
    // Real gap found live (Session 170): the visit-scoped ABHA Address feature only
    // ever covered reception.html's own visit-creation insert — but routing FROM
    // Screening (this function) is the more common real path a specialty visit
    // actually comes into existence through, and it never carried the address
    // forward at all. Carry over whatever was on the Screening visit being routed.
    abha_address:     _activeVisit.abha_address || null,
  };

  // Assign doctor — prefer whoever the nurse explicitly picked for this OPD
  // (real fix, Session 170: this used to only fire when the person doing the
  // ROUTING was themselves a doctor, which left doctor_id null for the actual
  // nurse-triage workflow, making the visit invisible to every doctor's queue).
  // Fall back to that old self-is-doctor behaviour only if nothing was picked.
  const scrDoctorId = document.getElementById('scr-doctor').value;
  if (scrDoctorId) newVisit.doctor_id = scrDoctorId;
  else if (profile?.role === 'doctor') newVisit.doctor_id = profile.id;

  const { error: errNew } = await supabase.from('visits').insert(newVisit);

  if (errNew) {
    // Rollback — revert screening visit to waiting
    await supabase.from('visits').update({ status: 'waiting' }).eq('id', _activeVisit.id);
    _alert('error', 'Failed to create specialty OPD visit: ' + errNew.message);
    btn.disabled = false; btn.textContent = '↗ Route to OPD'; return;
  }

  _alert('success', `${_activeVisit.patients?.name} routed to ${dept.name}. Token #${nextToken} created.`);
  _activeVisit = null;
  document.getElementById('form-empty').style.display     = 'flex';
  document.getElementById('screening-form').style.display = 'none';
  await window.loadQueue();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.className = `alert show ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 4000);
}

// Runs the deferred init now that every window.* handler above (loadQueue,
// selectVisit, onDeptChange, etc.) has actually been assigned — see the comment
// on _initScreeningQueue() itself for why this can't run any earlier.
await _initScreeningQueue();
