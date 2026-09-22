import { requireAuth, getCurrentProfile, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { logAudit } from '../core/auditLogger.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType } from '../config/ncism.js';
import { addOpdBillItem } from '../modules/billing/opdBillItems.js';
import { getEffectivePrice } from '../modules/billing/effectivePrice.js';
import { computeRoomTariff } from '../modules/billing/roomTariff.js';
import { renderPromoBanner } from '../components/promoBanner.js';
import { openTimePicker, formatTime12 } from '../components/timePicker.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';

// Auth + navbar first — page must always be visible and navigable even if proforma module is absent
await requireAuth(['doctor', 'trainee_doctor', 'super_admin', 'dept_admin']);
initNavbar();
wireDelegatedEvents();

// ── CSP delegation helpers ────────────────────────────────────────────────
// Small named wrappers for inline-handler patterns that aren't a plain
// fn(args) call (DOM one-liners, event.stopPropagation(), object/array args) —
// used with data-onclick/data-onchange + the shared delegated-event engine.
window._toggleClass = function(el, cls) { el.classList.toggle(cls); };
window._toggleParentClass = function(el, cls) { el.parentElement.classList.toggle(cls); };
window._removeClosest = function(el, sel) { el.closest(sel)?.remove(); };
window._removeParentEl = function(el) { el.parentElement?.remove(); };
window._stopProp = function(e) { e.stopPropagation(); };
window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};
window._openBlank = function(url) { window.open(url, '_blank'); };
window._closeHistoryToWelcome = function() {
  document.getElementById('c-history').style.display = 'none';
  document.getElementById('welcome').style.display = '';
};
// Thin wrappers around functions defined later in this module — safe because
// they're only invoked at click-time (long after the whole module has run),
// and data-* attributes can only carry strings, unlike the values these
// underlying functions actually expect (object literals, numbers, booleans).
window._addRxRowFromAttr = function(name, anupana, dose) { addRxRow({ name, anupana, dose }); };
window._removeRxRowFromAttr = function(idStr) { removeRxRow(Number(idStr)); };
window._selectPkOptFromAttr = function(qiStr, dosha, scroll) { _selectPkOpt(Number(qiStr), dosha, scroll); };
window._selectPanelFromAttr = function(testsJson, label) { selectPanel(JSON.parse(testsJson), label); };

// Dynamic import — proforma engine is optional; if the file is unavailable (e.g. website repo deploy)
// the rest of the page (queue, consultation, Rx, labs) still works normally.
let renderProforma = () => {}, collectProforma = () => ({}), resetProforma = () => {}, getExamGuide = () => null;
try {
  const _pMod = await import('../modules/proforma/proformaEngine.js');
  renderProforma  = _pMod.renderProforma;
  collectProforma = _pMod.collectProforma;
  resetProforma   = _pMod.resetProforma;
  getExamGuide    = _pMod.getExamGuide;
} catch (_) {
  console.warn('Proforma engine not available — proforma tab disabled');
}

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const tenant   = getCurrentTenant?.() || JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
const userId   = profile.id;
const _ctx     = { tenantId, userId, userName: profile.full_name };

// ── Session 127 — Trainee Doctor (PG/Intern) draft-and-countersign workflow ──
// NCISM requires every PG/intern's clinical activity be individually logged
// for academic assessment, so trainees get their own login rather than sharing
// a supervising doctor's -- but they can only draft, never finalize a
// medico-legal document. _canReview covers every role that could plausibly
// supervise (a plain 'doctor' review's their own department's trainees; admin
// roles can review across departments too).
const _isTrainee  = profile.role === 'trainee_doctor';
const _canReview  = ['doctor', 'super_admin', 'dept_admin'].includes(profile.role);
let _activeDraftId    = null;  // consultation_notes.id of the draft being reviewed, if any
let _activeDraftedBy  = null;  // that draft's original trainee author (profile.id) -- credited on finalize

// ═══════════════════════════════════════════════════════════
// Session 185 — Consultation autosave
//
// Real incident: a doctor's browser session went stale mid-consultation
// (an unrelated RLS 401 on the final save), and everything typed had to be
// re-entered from scratch after a fresh login. Every ~30s, if the form has
// actually changed since the last autosave, silently upsert its current
// state to `consultation_drafts` (a dedicated table -- never
// consultation_notes itself, which every ABDM/billing/printing consumer
// already assumes holds only real finalized-or-pending_review rows). The
// next time this doctor opens the same visit, a resume banner offers to
// restore it.
//
// Scope, deliberately: mirrors exactly what _collectConsultationFields()
// already returns (history/exam/vitals/ashtasthana/dashavidha/assessment/
// diagnosis/prescription/advice/disposition/referral/proforma -- the vast
// majority of what a doctor actually types), reusing that one function so
// autosave can never save a shape different from what a real Complete/
// Submit-for-Review would. PK-planning (pk-*) and Admission (adm-*) tab
// fields are a separate downstream flow with their own save path, not part
// of _collectConsultationFields() today, so they're out of scope here too --
// not an oversight, just matching the existing boundary.
let _draftDirty       = false;
let _draftSaving       = false;
let _pendingDraftNotes = null;  // fetched draft's form_data, held while the resume banner is up

document.getElementById('c-active').addEventListener('input',  () => { _draftDirty = true; });
document.getElementById('c-active').addEventListener('change', () => { _draftDirty = true; });

setInterval(async () => {
  if (!_activeVisitId || !_draftDirty || _draftSaving) return;
  _draftSaving = true;
  try {
    const { notes } = await _collectConsultationFields();
    const { error } = await supabase.from('consultation_drafts').upsert({
      tenant_id:  tenantId,
      visit_id:   _activeVisitId,
      doctor_id:  userId,
      form_data:  notes,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'visit_id,doctor_id' });
    if (!error) _draftDirty = false;
    else console.warn('Autosave failed (non-fatal):', error.message);
  } catch (err) {
    console.warn('Autosave failed (non-fatal):', err?.message || err);
  } finally {
    _draftSaving = false;
  }
}, 30000);

// Explicit id->key map (not derived from _collectConsultationFields() itself)
// so a field added to one side without the other shows up as a visible diff
// here, not a silent restore gap.
const _DRAFT_FIELD_MAP = [
  ['h-duration','duration'], ['h-severity','severity'], ['h-onset','onset'],
  ['h-progression','progression'], ['h-aggravating','aggravating_factors'],
  ['h-relieving','relieving_factors'], ['h-associated','associated_symptoms'],
  ['h-history','history_notes'],
  ['ph-dm','past_dm'], ['ph-htn','past_htn'], ['ph-thyroid','past_thyroid'],
  ['ph-surgery','past_surgery'], ['ph-other','past_other'],
  ['dh-current','current_medications'], ['dh-allergy','allergies'], ['dh-adr','adr'],
  ['fh-notes','family_history'],
  ['pers-diet','diet_type'], ['pers-sleep','sleep_pattern'], ['pers-exercise','exercise_level'],
  ['pers-bowel','bowel_habits'], ['pers-appetite','appetite'], ['pers-addiction','addiction'],
  ['pers-occupation','occupation'],
  ['ay-prakriti','prakriti'], ['ay-agni','agni_history'], ['ay-koshta','koshta'], ['ay-nidra','nidra'],
  ['ay-nidana','nidana'], ['ay-ahara','ahara'], ['ay-vihara','vihara'],
  ['np-purvarupa','purvarupa'], ['np-rupa','rupa'], ['np-samprapti','samprapti'], ['np-upashaya','upashaya'],
  ['v-bp-s','bp_systolic'], ['v-bp-d','bp_diastolic'], ['v-pulse','pulse_rate'],
  ['v-temp','temperature'], ['v-weight','weight'], ['v-spo2','spo2'], ['v-rr','resp_rate'],
  ['sys-cvs','sys_cvs'], ['sys-rs','sys_rs'], ['sys-cns','sys_cns'], ['sys-pa','sys_pa'],
  ['sys-msk','sys_msk'], ['sys-skin','sys_skin'], ['exam-modern-notes','exam_modern_notes'],
  ['a-nadi','nadi'], ['a-mala','mala'], ['a-mutra','mutra'], ['a-jihwa','jihwa'],
  ['a-shabda','shabda'], ['a-sparsha','sparsha'], ['a-druk','druk'], ['a-akriti','akriti'],
  ['d-vata','vata_state'], ['d-pitta','pitta_state'], ['d-kapha','kapha_state'],
  ['d-agni','agni_state'], ['d-ama','ama_state'], ['exam-ayurveda-notes','exam_ayurveda_notes'],
  ['dasha-vikriti','dasha_vikriti'], ['dasha-sara','dasha_sara'], ['dasha-samhanana','dasha_samhanana'],
  ['dasha-pramana','dasha_pramana'], ['dasha-satmya','dasha_satmya'], ['dasha-satva','dasha_satva'],
  ['dasha-vaya','dasha_vaya'], ['dasha-ahara','dasha_ahara_shakti'], ['dasha-vyayama','dasha_vyayama_shakti'],
  ['as-provisional-modern','provisional_modern'], ['as-provisional-ayurveda','provisional_ayurveda'],
  ['as-redflags','red_flags'], ['as-inv-lab','inv_lab'], ['as-inv-imaging','inv_imaging'],
  ['as-inv-ayurveda','inv_ayurveda'], ['as-reasoning','clinical_reasoning'],
  ['d-modern','modern_diagnosis'], ['d-ayurveda','ayurveda_diagnosis'],
  ['d-namc-code','diagnosis_namc_code'], ['d-namc-label','diagnosis_namc_label'],
  ['d-icd10-code','diagnosis_icd10_code'], ['d-icd10-label','diagnosis_icd10_label'],
  ['d-certainty','diagnosis_certainty'], ['d-notes','clinical_notes'],
  ['rx-instructions','rx_instructions'],
  ['adv-pathya','pathya'], ['adv-apathya','apathya'], ['fu-date','followup_date'], ['fu-notes','followup_notes'],
  ['disp-notes','disp_notes'],
  ['ref-doctor','ref_doctor'], ['ref-hospital','ref_hospital'], ['ref-type','ref_type'],
  ['ref-urgency','ref_urgency'], ['ref-reason','ref_reason'],
];

function _applyProformaFields(containerEl, data) {
  if (!containerEl || !data) return;
  Object.entries(data).forEach(([pfId, val]) => {
    const checkboxes = containerEl.querySelectorAll(`input[type="checkbox"][data-pf-id="${pfId}"]`);
    if (checkboxes.length) {
      const vals = Array.isArray(val) ? val : [val];
      checkboxes.forEach(cb => { cb.checked = vals.includes(cb.value); });
      return;
    }
    const radios = containerEl.querySelectorAll(`input[type="radio"][data-pf-id="${pfId}"]`);
    if (radios.length) {
      radios.forEach(r => { r.checked = (r.value === val); });
      return;
    }
    const el = containerEl.querySelector(`[data-pf-id="${pfId}"]`);
    if (el) el.value = val;
  });
}

function _applyDraftToForm(notes) {
  _DRAFT_FIELD_MAP.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el && notes[key] !== undefined && notes[key] !== null) el.value = notes[key];
  });

  // Disposition -- reuse onDispChange() for its own UI side effects (referral
  // section visibility, Complete-button label, PK tab switch), exactly as a
  // real user pick would trigger.
  if (notes.disposition) {
    const radio = document.querySelector(`input[name=disposition][value="${notes.disposition}"]`);
    if (radio) { radio.checked = true; window.onDispChange(notes.disposition); }
  }

  (notes.differential_list || []).forEach(d => {
    window.addDiff();
    const li = document.querySelector('#diff-list .diff-item:last-child');
    if (li) {
      const [inp, sel] = [li.querySelector('input[type=text]'), li.querySelector('select')];
      if (inp) inp.value = d.diagnosis  || '';
      if (sel) sel.value = d.likelihood || '';
    }
  });

  // addRxRow() already accepts a prefill object in this exact shape.
  (notes.prescription_json || []).forEach(rx => addRxRow(rx));

  const pf = notes.proforma_data;
  if (pf) {
    const { ophtha_exam, ent_exam, obsgyn_exam, ncism_code, ...pfFields } = pf;
    _applyProformaFields(document.getElementById('pf-container'), pfFields);
    const _applyPrefixed = (obj, prefix) => obj && Object.entries(obj).forEach(([k, v]) => {
      const el = document.getElementById(`${prefix}-${k}`);
      if (el) el.value = v;
    });
    _applyPrefixed(ophtha_exam, 'ey');
    _applyPrefixed(ent_exam,    'nt');
    _applyPrefixed(obsgyn_exam, 'og');
  }
}

window._restoreConsultationDraft = function() {
  if (_pendingDraftNotes) _applyDraftToForm(_pendingDraftNotes);
  _pendingDraftNotes = null;
  _draftDirty = false;  // just loaded, not user-edited yet
  document.getElementById('draft-resume-banner').style.display = 'none';
};

window._discardConsultationDraft = async function() {
  if (_activeVisitId) {
    await supabase.from('consultation_drafts').delete()
      .eq('visit_id', _activeVisitId).eq('doctor_id', userId);
  }
  _pendingDraftNotes = null;
  document.getElementById('draft-resume-banner').style.display = 'none';
};

// Called from startConsultation() once the visit is loaded and its
// proforma/specialty sections are rendered (a restore needs those DOM nodes
// to already exist). Best-effort -- a failed lookup just means no resume
// offer, never blocks opening the consultation.
async function _checkForConsultationDraft(visitId) {
  const banner = document.getElementById('draft-resume-banner');
  banner.style.display = 'none';
  _pendingDraftNotes = null;
  try {
    const { data } = await supabase.from('consultation_drafts')
      .select('form_data, updated_at')
      .eq('visit_id', visitId).eq('doctor_id', userId)
      .maybeSingle();
    if (data) {
      _pendingDraftNotes = data.form_data;
      document.getElementById('draft-resume-when').textContent =
        new Date(data.updated_at).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
      banner.style.display = 'flex';
    }
  } catch (err) {
    console.warn('Draft lookup failed (non-fatal):', err?.message || err);
  }
}

async function _clearConsultationDraft(visitId) {
  await supabase.from('consultation_drafts').delete()
    .eq('visit_id', visitId).eq('doctor_id', userId);
  _draftDirty = false;
  _pendingDraftNotes = null;
}

// Resolves a department id to the set of opd ids that department's OPD serves,
// via ncism_code -- departments and opds share the same code space (e.g. both
// use 'KAY' for Kayachikitsa) rather than a direct FK, matching how
// screening.js/bed-admin.js already resolve this.
async function _opdIdsForDept(departmentId) {
  const { data: dept } = await supabase.from('departments').select('ncism_code')
    .eq('id', departmentId).maybeSingle();
  if (!dept?.ncism_code) return null;
  const { data: opds } = await supabase.from('opds').select('id')
    .eq('tenant_id', tenantId).eq('ncism_code', dept.ncism_code);
  return (opds || []).map(o => o.id);
}

// Resolves this profile's department scope to the set of opd ids that
// department's OPD serves. Session 128 -- a trainee_doctor's scope is now
// primarily driven by trainee_postings (the Deputy-MS-approved rotation
// roster, or a direct HOD assignment), checked for a posting whose date
// range covers today; the static scope_department_id (set at invite time)
// is only a fallback for a trainee with no active posting row yet. Every
// other role (HOD reviewing their department's Pending Review queue, etc.)
// is unaffected -- they never have postings, only the static field.
// Returns null if nothing resolves (e.g. a super_admin reviewing tenant-wide,
// or a trainee never assigned/posted at all).
async function _scopedOpdIds() {
  if (_isTrainee) {
    const today = todayLocalStr();
    const { data: posting } = await supabase.from('trainee_postings')
      .select('department_id, area')
      .eq('tenant_id', tenantId).eq('profile_id', userId)
      .lte('posting_start_date', today).gte('posting_end_date', today)
      .eq('area', 'opd')
      .order('posting_start_date', { ascending: false })
      .limit(1).maybeSingle();
    if (posting?.department_id) return _opdIdsForDept(posting.department_id);
  }
  if (!profile.scope_department_id) return null;
  return _opdIdsForDept(profile.scope_department_id);
}

// ── Tenant feature gating ─────────────────────────
// All 4 Disposition options are always visible.
// The PK and Admission DETAIL TABS are tenant-gated.
const PK_TYPES  = ['pk_center', 'hospital', 'teaching_hospital', 'college'];
const ADM_TYPES = ['hospital', 'teaching_hospital', 'college'];

let _hasPK  = false;
let _hasAdm = false;

function _gateFeatures() {
  try {
    const tenant = getCurrentTenant?.() || JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
    const type   = (tenant.type || '').toLowerCase();

    _hasPK  = PK_TYPES.includes(type);
    _hasAdm = ADM_TYPES.includes(type);

    if (_hasPK) {
      document.getElementById('tab-btn-pk').classList.remove('gated');
      document.getElementById('tab-btn-pk').style.display = '';
      _loadPkTemplates();
      _loadPkFeeIndex();
    }
    if (_hasAdm) {
      document.getElementById('tab-btn-adm').classList.remove('gated');
      document.getElementById('tab-btn-adm').style.display = '';
      _loadAdmDepts();
      _loadAdmProcedureOptions();
      _loadTenantAdvancePct();
    }

    // ABDM Records tab — visible for all tenant types
    document.getElementById('tab-btn-abdm').classList.remove('gated');
    document.getElementById('tab-btn-abdm').style.display = '';

    // Update disposition descriptions based on tenant capabilities
    if (!_hasPK) {
      document.getElementById('disp-pk-desc').textContent =
        'Patient requires Panchakarma therapies — note details below and refer to a Panchakarma centre.';
    }
    if (!_hasAdm) {
      document.getElementById('disp-adm-desc').textContent =
        'Patient requires in-patient care — note below and refer to a hospital for admission.';
    }
  } catch {}
}
_gateFeatures();

// ── State ─────────────────────────────────────────
let _activeVisitId   = null;
let _activePatient   = null;
let _activeVisit     = null;
let _activeNcismCode = null;
let _historyPatient  = null;
let _inventory       = [];
let _opdList         = [];
let _doctorOpdIds    = [];
let _activeReferralId = null;

// ── Date label ────────────────────────────────────
document.getElementById('q-date').textContent = new Date().toLocaleDateString('en-IN', {
  weekday: 'long', day: 'numeric', month: 'long'
});

// ── UHID formatter ────────────────────────────────
function _uhid(uuid) {
  return `AYX-${new Date().getFullYear()}-${(uuid||'').replace(/-/g,'').slice(-6).toUpperCase()}`;
}
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }

// ── Wait time ─────────────────────────────────────
function _wait(createdAt) {
  const m = Math.floor((Date.now() - new Date(createdAt)) / 60000);
  if (m < 1) return 'Just arrived';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}

// ── Load inventory for prescription typeahead ─────
async function loadInventory() {
  try {
    const { data } = await supabase
      .from('inventory')
      .select('id, stock_quantity, mrp, medicine:medicines(id,name,indications,anupana,dosage_text,classical_reference)')
      .eq('tenant_id', tenantId);
    _inventory = (data || []).filter(i => i.medicine?.name);
  } catch (e) {
    _inventory = [];
  }
}

// ── Load queue ────────────────────────────────────
let _queueTab = 'opd';

// Session 127 -- only reviewer-capable roles get the Pending Review tab at all;
// a trainee has no one to review, and hiding it for them avoids any confusion.
if (_canReview) document.getElementById('q-tab-review').style.display = '';

window.switchQueueTab = function(tab) {
  _queueTab = tab;
  document.getElementById('q-search').value = '';

  // If the main area is showing a NO-VISIT view (ABDM records or patient history,
  // opened from the ABDM tracker or a past-patient search), switching the queue tab
  // returns it to the neutral welcome state — otherwise the ABDM Records page stays
  // stuck on screen after you move to OPD/Tele/IPD. A real open consultation
  // (_activeVisitId set) is never touched.
  if (!_activeVisitId) {
    const ca = document.getElementById('c-active');
    const ch = document.getElementById('c-history');
    const wl = document.getElementById('welcome');
    if (ca) ca.style.display = 'none';
    if (ch) ch.style.display = 'none';
    if (wl) wl.style.display = '';
  }
  const opd    = document.getElementById('q-tab-opd');
  const tele   = document.getElementById('q-tab-tele');
  const ipd    = document.getElementById('q-tab-ipd');
  const review = document.getElementById('q-tab-review');
  const abdm   = document.getElementById('q-tab-abdm');
  [opd, tele, ipd, review, abdm].forEach(b => { if (!b) return; b.style.background = 'none'; b.style.color = 'var(--text-muted)'; b.style.borderBottom = '2px solid transparent'; b.style.fontWeight = '500'; });
  // Leaving the ABDM tab stops its auto-refresh poll.
  if (tab !== 'abdm' && _abdmReqTimer) { clearInterval(_abdmReqTimer); _abdmReqTimer = null; }
  if (tab === 'opd') {
    opd.style.background = 'var(--green-light)'; opd.style.color = 'var(--green-deep)'; opd.style.borderBottom = '2px solid var(--green-mid)'; opd.style.fontWeight = '600';
    loadQueue();
  } else if (tab === 'tele') {
    tele.style.background = '#dbeafe'; tele.style.color = '#1d4ed8'; tele.style.borderBottom = '2px solid #2563eb'; tele.style.fontWeight = '600';
    loadQueue();
  } else if (tab === 'review') {
    review.style.background = '#fff4e5'; review.style.color = '#7a4a00'; review.style.borderBottom = '2px solid #e8c48a'; review.style.fontWeight = '600';
    loadPendingReviews();
  } else if (tab === 'abdm') {
    abdm.style.background = '#e6f0e6'; abdm.style.color = '#1a6a34'; abdm.style.borderBottom = '2px solid #4a9a5e'; abdm.style.fontWeight = '600';
    _loadAbdmRequests();
    if (_abdmReqTimer) clearInterval(_abdmReqTimer);
    _abdmReqTimer = setInterval(() => { if (_queueTab === 'abdm') _loadAbdmRequests(_abdmReqFilter, true); }, 90000);
  } else {
    ipd.style.background = '#fce7f3'; ipd.style.color = '#be185d'; ipd.style.borderBottom = '2px solid #db2777'; ipd.style.fontWeight = '600';
    loadIPDPatients();
  }
};

// ── 🔗 ABDM tab — cross-patient tracker of consent requests THIS doctor raised ──
// Scoped server-side to doctor_id (see abdm-auth's hiu_list_consents). A patient-safety
// / DPDPA need-to-know boundary: a doctor tracks their own outstanding consents here;
// they never browse another clinician's patients' ABDM activity. A granted row jumps
// straight to that patient's ABDM Records with the consent's records pre-expanded.
let _abdmReqTimer  = null;
let _abdmReqFilter = 'all';
let _abdmReqCache  = [];

async function _loadAbdmRequests(filter = _abdmReqFilter, silent = false) {
  _abdmReqFilter = filter;
  const list = document.getElementById('q-list');
  if (!silent) list.innerHTML = '<div class="q-empty"><div class="q-empty-icon">⏳</div>Loading…</div>';

  const stopAuto = () => { if (_abdmReqTimer) { clearInterval(_abdmReqTimer); _abdmReqTimer = null; } };

  try {
    const token = await _abdmGetToken();
    if (!token) {
      stopAuto();
      if (_queueTab === 'abdm') list.innerHTML = '<div class="q-empty" style="color:#e67e22;font-size:12px">Your session has expired. Please refresh the page to sign back in.</div>';
      return;
    }
    const res = await fetch(ABDM_AUTH_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ action: 'hiu_list_consents', scope: 'mine' }),
    });
    // 401 = the session token was rejected — no point retrying every 90s.
    if (res.status === 401) {
      stopAuto();
      if (_queueTab === 'abdm') list.innerHTML = '<div class="q-empty" style="color:#e67e22;font-size:12px">Your session has expired. Please refresh the page to sign back in.</div>';
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load');
    _abdmReqCache = data.consents || [];
  } catch (e) {
    // A background auto-refresh that hiccups (network blip) just skips this tick and
    // keeps the current list; only a user-initiated load surfaces the error.
    if (silent) return;
    if (_queueTab !== 'abdm') return;
    list.innerHTML = `<div class="q-empty" style="color:#e74c3c;font-size:12px">Couldn't load requests: ${_esc(e.message)}. <button data-onclick="_loadAbdmRequests" style="background:none;border:none;color:var(--green-deep);text-decoration:underline;cursor:pointer;font-size:12px;font-family:inherit">retry</button></div>`;
    return;
  }
  if (_queueTab !== 'abdm') return;

  const norm = (c) => (c.status === 'granted' && (c.granted_erase_at || c.data_erase_at) && new Date(c.granted_erase_at || c.data_erase_at) < new Date()) ? 'expired' : c.status;
  const buckets = { pending: 'requested', granted: 'granted', denied: 'denied', closed: ['revoked', 'expired'] };
  const rows = _abdmReqCache.filter(c => {
    const s = norm(c);
    if (filter === 'all') return true;
    if (filter === 'pending') return s === 'requested';
    if (filter === 'granted') return s === 'granted';
    if (filter === 'denied')  return s === 'denied';
    if (filter === 'closed')  return s === 'revoked' || s === 'expired';
    return true;
  });

  const pendingN = _abdmReqCache.filter(c => norm(c) === 'requested').length;
  document.getElementById('q-abdm-count').textContent = pendingN;

  const chip = (k, label) => `<button data-onclick="_abdmReqFilterSet" data-onclick-a0="${k}" style="font-size:10.5px;padding:3px 9px;border-radius:11px;border:1px solid ${filter === k ? '#4a9a5e' : '#ddd'};background:${filter === k ? '#e6f0e6' : '#fff'};color:${filter === k ? '#1a6a34' : '#666'};font-weight:${filter === k ? 600 : 500};cursor:pointer;font-family:inherit">${label}</button>`;
  const filterBar = `<div style="display:flex;gap:5px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--border);background:#fafcfa">
    ${chip('all', 'All')}${chip('pending', 'Pending')}${chip('granted', 'Granted')}${chip('denied', 'Denied')}${chip('closed', 'Revoked / Expired')}
    <button data-onclick="_loadAbdmRequests" style="margin-left:auto;font-size:10.5px;padding:3px 9px;border-radius:11px;border:1px solid #ddd;background:#fff;color:#666;cursor:pointer;font-family:inherit" title="Refresh now">↻</button>
  </div>`;

  const stColor = { requested: '#c9902a', granted: '#1a7a3a', denied: '#c0392b', revoked: '#7f8c8d', expired: '#7f8c8d', failed: '#c0392b' };
  const stLabel = { requested: 'PENDING', granted: 'GRANTED', denied: 'DENIED', revoked: 'REVOKED', expired: 'EXPIRED', failed: 'FAILED' };
  const HI_SHORT = { OPConsultation: 'OPD', Prescription: 'Rx', DiagnosticReport: 'Lab', DischargeSummary: 'DС', ImmunizationRecord: 'Imm', WellnessRecord: 'Well', HealthDocumentRecord: 'Doc', Invoice: 'Bill' };

  const cards = rows.map(c => {
    const s = norm(c);
    const col = stColor[s] || '#888';
    const d = new Date(c.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const types = (c.requested_hi_types || c.hi_types || []).map(t => HI_SHORT[t] || t).join(' · ');
    return `<div class="q-card" style="cursor:pointer" data-onclick="_openAbdmRequestRow" data-onclick-a0="${_esc(c.id)}" data-onclick-a1="${_esc(s)}" data-onclick-a2="${_esc(c.patient_id || '')}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;color:var(--green-deep)">${_esc(c.patient_name || 'Patient')}</div>
          <div style="font-size:11px;color:#888;word-break:break-all;margin-top:1px">${_esc(c.abha_address || '—')}</div>
          <div style="font-size:10.5px;color:#999;margin-top:2px">${d} · ${_esc((c.purpose || 'CAREMGT'))}</div>
          <div style="font-size:10px;color:#aaa;margin-top:2px">${_esc(types)}</div>
        </div>
        <span style="white-space:nowrap;font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:9px;background:${col}18;color:${col};border:1px solid ${col}44">${_esc(stLabel[s] || s.toUpperCase())}</span>
      </div>
      ${s === 'granted' ? '<div style="font-size:10px;color:#4a9a5e;margin-top:4px">→ tap to view records</div>' : ''}
    </div>`;
  }).join('') || `<div class="q-empty"><div class="q-empty-icon">🔗</div>${filter === 'all' ? 'You haven’t raised any consent requests yet.' : 'No ' + filter + ' requests.'}</div>`;

  list.innerHTML = filterBar + cards;
}
window._loadAbdmRequests = _loadAbdmRequests;

function _abdmReqFilterSet(k) { _loadAbdmRequests(k); }
window._abdmReqFilterSet = _abdmReqFilterSet;

async function _openAbdmRequestRow(consentId, status, patientId) {
  if (status !== 'granted') {
    // Pending / denied / revoked / expired — expand an inline detail under the card,
    // non-destructively (no main-area navigation).
    const c = _abdmReqCache.find(x => x.id === consentId);
    if (!c) return;
    const card = document.querySelector(`[data-onclick="_openAbdmRequestRow"][data-onclick-a0="${consentId}"]`);
    if (!card) return;
    const existing = card.querySelector('.abdm-req-detail');
    if (existing) { existing.remove(); return; }
    const range = (a, b) => a || b ? `${_fmtD(a) || '—'} to ${_fmtD(b) || '—'}` : '—';
    const noteByStatus = {
      requested: 'Waiting for the patient to respond on their ABHA app — refreshes automatically.',
      denied:    'The patient declined this request. No records were shared.',
      revoked:   'The patient revoked this consent. Received records were deleted per ABDM compliance.',
      expired:   'This consent reached its data-retention date. Records are no longer available.',
    };
    const det = document.createElement('div');
    det.className = 'abdm-req-detail';
    det.style.cssText = 'margin-top:8px;padding:8px 10px;background:#f7f7f5;border-radius:6px;font-size:11px;color:#555;line-height:1.5';
    det.innerHTML = `<div><b>Requested types:</b> ${_esc((c.requested_hi_types || c.hi_types || []).join(', ') || '—')}</div>
      <div><b>Records range:</b> ${_esc(range(c.requested_date_from, c.requested_date_to))}</div>
      <div style="margin-top:5px;color:#777">${_esc(noteByStatus[status] || '')}</div>`;
    card.appendChild(det);
    return;
  }

  // Granted → load the patient and open their ABDM Records with this consent expanded.
  const { data: patient, error } = await supabase.from('patients')
    .select('id, name, phone, abha_number, abha_address')
    .eq('id', patientId).single();
  if (error || !patient) { alert('Could not load this patient record.'); return; }
  _historyPatient = patient;
  window._openAbdmForHistory();

  // The consent list renders async inside _loadAbdmTab — poll for this consent's
  // accordion card, expand it, then expand its record box.
  let tries = 0;
  const iv = setInterval(() => {
    const bodyEl = document.getElementById('consbody-' + consentId);
    if (bodyEl) {
      clearInterval(iv);
      if (bodyEl.style.display === 'none') window._toggleConsentCard(consentId);
      const box = document.getElementById('recbox-' + consentId);
      if (box && box.dataset.open !== '1') _loadReceivedRecords(consentId, 'granted');
      bodyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (++tries > 30) {
      clearInterval(iv);
    }
  }, 200);
}
window._openAbdmRequestRow = _openAbdmRequestRow;

async function loadQueue() {
  const list  = document.getElementById('q-list');
  const start = new Date(); start.setHours(0, 0, 0, 0);

  let query = supabase
    .from('visits')
    .select('id, token_number, status, chief_complaint, created_at, is_on_request, visit_category, is_teleconsultation, meeting_url, patients(id, name, phone, abha_number, abha_address)')
    .eq('tenant_id', tenantId)
    .in('status', ['waiting', 'in_progress'])
    .gte('created_at', start.toISOString())
    .order('token_number', { ascending: true });

  // Session 127 -- a trainee's queue is department-scoped (not doctor_id-owned,
  // since they aren't the visit's assigned doctor); everyone else keeps the
  // existing doctor_id-owned behaviour completely unchanged.
  if (_isTrainee) {
    const opdIds = await _scopedOpdIds();
    if (!opdIds || !opdIds.length) {
      list.innerHTML = `<div class="q-empty">No department assigned yet — ask an admin to set your department scope.</div>`;
      document.getElementById('q-count').textContent = 0;
      document.getElementById('q-tele-count').textContent = 0;
      return;
    }
    query = query.in('opd_id', opdIds);
  } else {
    query = query.eq('doctor_id', userId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('loadQueue error:', error.message, '| code:', error.code);
    list.innerHTML = `<div class="q-empty" style="color:#e74c3c;font-size:12px">Queue error: ${_esc(safeErrorMessage(error, 'Could not load queue.'))}</div>`;
    return;
  }

  let all = data || [];

  // Exclude visits someone has already drafted/finalized a consultation for --
  // for a trainee, any existing row means it's already spoken for; for the
  // reviewing doctor, a still-open 'pending_review' draft means a trainee
  // already claimed it, so send them to the Pending Review tab instead of
  // letting two people work the same visit independently.
  if (all.length) {
    const visitIds = all.map(v => v.id);
    const { data: existing } = await supabase.from('consultation_notes')
      .select('visit_id, review_status').in('visit_id', visitIds);
    const excludeIds = new Set(
      _isTrainee
        ? (existing || []).map(n => n.visit_id)
        : (existing || []).filter(n => n.review_status === 'pending_review').map(n => n.visit_id)
    );
    if (excludeIds.size) all = all.filter(v => !excludeIds.has(v.id));
  }

  const opdQ  = all.filter(v => !v.is_teleconsultation);
  const teleQ = all.filter(v =>  v.is_teleconsultation);

  document.getElementById('q-count').textContent      = opdQ.length;
  document.getElementById('q-tele-count').textContent = teleQ.length;

  const shown = _queueTab === 'tele' ? teleQ : opdQ;

  if (!shown.length) {
    list.innerHTML = _queueTab === 'tele'
      ? `<div class="q-empty"><div class="q-empty-icon">📡</div>No tele appointments today</div>`
      : `<div class="q-empty"><div class="q-empty-icon"><img src="assets/AyurXpert_Tree_Only.png" alt=""></div>No patients waiting</div>`;
    return;
  }

  const catLabel = { opd:'OPD', followup:'Follow-up', panchakarma:'Panchakarma', emergency:'Emergency', teleconsultation:'Teleconsult', camp:'Camp' };

  list.innerHTML = shown.map(v => {
    const isActive    = v.id === _activeVisitId;
    const inProgress  = v.status === 'in_progress';
    const isEmergency = v.visit_category === 'emergency';
    const isTele      = v.is_teleconsultation;
    const tokenClass  = isEmergency ? 'red' : inProgress ? 'gold' : isTele ? 'blue' : '';
    const cardClass   = isActive ? 'q-card active' : inProgress ? 'q-card in-progress' : 'q-card';
    const cat         = catLabel[v.visit_category] || 'OPD';
    const meetUrl     = v.meeting_url || `https://meet.jit.si/AyurXpert-${tenant?.tenant_code||''}-${v.id.slice(0,8)}`;
    return `<div class="${cardClass}" data-onclick="startConsultation" data-onclick-a0="${_esc(v.id)}">
      <div class="q-card-top">
        <div class="q-token ${tokenClass}">${v.token_number}</div>
        <div class="q-name">${_esc(v.patients?.name || '—')}</div>
        <div class="q-wait">${_wait(v.created_at)}</div>
      </div>
      <div class="q-meta">
        <span class="badge badge-cat">${_esc(cat)}</span>
        ${v.is_on_request ? '<span class="badge badge-onreq">ON REQ</span>' : ''}
        ${inProgress ? '<span class="badge badge-active">IN PROGRESS</span>' : ''}
        ${isEmergency ? '<span class="badge badge-emerg">EMERGENCY</span>' : ''}
        ${isTele ? '<span class="badge" style="background:#dbeafe;color:#1d4ed8">🎥 TELE</span>' : ''}
      </div>
      <div class="q-complaint">${_esc(v.chief_complaint || '—')}</div>
      ${isTele ? `<div style="margin-top:6px"><a href="${meetUrl}" target="_blank" rel="noopener" data-onclick="_stopProp" data-onclick-a0="@event" style="display:inline-flex;align-items:center;gap:5px;background:#2563eb;color:#fff;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;text-decoration:none">🎥 Join Call</a></div>` : ''}
    </div>`;
  }).join('');
}

// ── IPD patients for this doctor ─────────────────
async function loadIPDPatients() {
  const list = document.getElementById('q-list');
  list.innerHTML = '<div class="q-empty"><div class="q-empty-icon">⏳</div>Loading…</div>';
  const { data, error } = await supabase
    .from('ipd_admissions')
    .select('id, diagnosis_primary, admission_date, admitted_at, beds(bed_number, ward_name), departments(name), patients(id, name, phone, abha_number)')
    .eq('tenant_id', tenantId)
    .eq('admitting_doctor_id', userId)
    .eq('status', 'admitted')
    .order('admitted_at', { ascending: false });
  if (error) { list.innerHTML = `<div class="q-empty" style="color:#e74c3c">Error: ${_esc(safeErrorMessage(error, 'Could not load admitted patients.'))}</div>`; return; }
  const rows = data || [];
  document.getElementById('q-ipd-count').textContent = rows.length;
  if (!rows.length) { list.innerHTML = '<div class="q-empty"><div class="q-empty-icon">🏥</div>No admitted patients</div>'; return; }
  list.innerHTML = rows.map(a => {
    const days = Math.floor((Date.now() - new Date(a.admitted_at)) / 86400000);
    const admDate = new Date(a.admission_date || a.admitted_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
    const ipdUrl = `ipd.html?admission_id=${encodeURIComponent(a.id)}`;
    return `<div class="q-card" style="border-color:#fce7f3" data-onclick="_openBlank" data-onclick-a0="${_esc(ipdUrl)}">
      <div class="q-card-top">
        <div class="q-token" style="background:#fce7f3;color:#be185d;font-size:9px;font-weight:700;min-width:36px">IPD</div>
        <div class="q-name">${_esc(a.patients?.name || '—')}</div>
        <div class="q-wait" style="color:#be185d">${days}d</div>
      </div>
      <div class="q-meta">
        ${a.beds?.ward_name ? `<span class="badge" style="background:#fce7f3;color:#be185d">${_esc(a.beds.ward_name)}</span>` : ''}
        ${a.beds?.bed_number ? `<span class="badge" style="background:#fce7f3;color:#be185d">Bed ${_esc(a.beds.bed_number)}</span>` : ''}
        ${a.departments?.name ? `<span class="badge">${_esc(a.departments.name)}</span>` : ''}
      </div>
      <div class="q-complaint">${_esc(a.diagnosis_primary || '—')}</div>
      <div style="margin-top:4px;font-size:11px;color:#888">Admitted ${admDate}</div>
      <div style="margin-top:6px" data-onclick="_stopProp" data-onclick-a0="@event">
        <a href="${ipdUrl}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;background:#be185d;color:#fff;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;text-decoration:none">🏥 Ward Rounds</a>
      </div>
    </div>`;
  }).join('');
}

// ── Pending Review (Session 127 -- Trainee Doctor drafts) ─────────────────
async function loadPendingReviews() {
  const list = document.getElementById('q-list');
  list.innerHTML = '<div class="q-empty"><div class="q-empty-icon">⏳</div>Loading…</div>';

  let query = supabase
    .from('consultation_notes')
    .select('id, visit_id, modern_diagnosis, ayurveda_diagnosis, provisional_modern, created_at, visits(id, token_number, chief_complaint, patients(id, name)), profiles!drafted_by(full_name)')
    .eq('tenant_id', tenantId)
    .eq('review_status', 'pending_review')
    .order('created_at', { ascending: true });

  // Reviewer's own department scope (if any) narrows this the same way a
  // trainee's queue is narrowed -- a Kayachikitsa professor only reviews
  // Kayachikitsa trainees' drafts. Tenant-wide for anyone with no scope set
  // (typically super_admin/dept_admin).
  const opdIds = await _scopedOpdIds();

  const { data, error } = await query;
  if (error) { list.innerHTML = `<div class="q-empty" style="color:#e74c3c">Error: ${_esc(safeErrorMessage(error, 'Could not load pending reviews.'))}</div>`; return; }

  let rows = data || [];
  if (opdIds) {
    // consultation_notes has no opd_id directly -- filter via the joined visit's opd
    // by re-checking visit membership against the scoped set fetched for loadQueue.
    const { data: scopedVisits } = await supabase.from('visits').select('id').eq('tenant_id', tenantId).in('opd_id', opdIds);
    const scopedVisitIds = new Set((scopedVisits || []).map(v => v.id));
    rows = rows.filter(r => scopedVisitIds.has(r.visit_id));
  }

  document.getElementById('q-review-count').textContent = rows.length;
  if (!rows.length) { list.innerHTML = '<div class="q-empty"><div class="q-empty-icon">📝</div>No drafts pending review</div>'; return; }

  list.innerHTML = rows.map(r => {
    const v = r.visits || {};
    const diag = r.provisional_modern || r.modern_diagnosis || r.ayurveda_diagnosis || '—';
    return `<div class="q-card" data-onclick="openReviewDraft" data-onclick-a0="${_esc(r.id)}">
      <div class="q-card-top">
        <div class="q-token" style="background:#fff4e5;color:#7a4a00;font-size:9px;font-weight:700;min-width:36px">#${v.token_number||'—'}</div>
        <div class="q-name">${_esc(v.patients?.name || '—')}</div>
      </div>
      <div class="q-meta">
        <span class="badge" style="background:#fff4e5;color:#7a4a00">Drafted by ${_esc(r.profiles?.full_name || '—')}</span>
      </div>
      <div class="q-complaint">${_esc(v.chief_complaint || diag)}</div>
    </div>`;
  }).join('');
}

window.openReviewDraft = async function(consultationNoteId) {
  const { data: draft, error } = await supabase
    .from('consultation_notes')
    .select('*, profiles!drafted_by(full_name)')
    .eq('id', consultationNoteId)
    .single();
  if (error || !draft) { _toast('Could not load this draft.', 'error'); return; }

  _activeDraftId   = draft.id;
  _activeDraftedBy = draft.drafted_by;

  await startConsultation(draft.visit_id);

  document.getElementById('draft-author').textContent = draft.profiles?.full_name || 'Trainee';
  const summaryLines = [
    draft.history_notes        && `<strong>History:</strong> ${_esc(draft.history_notes)}`,
    (draft.bp_systolic || draft.pulse_rate) && `<strong>Vitals:</strong> BP ${draft.bp_systolic||'—'}/${draft.bp_diastolic||'—'}, Pulse ${draft.pulse_rate||'—'}, Temp ${draft.temperature||'—'}`,
    draft.provisional_modern   && `<strong>Provisional (Modern):</strong> ${_esc(draft.provisional_modern)}`,
    draft.provisional_ayurveda && `<strong>Provisional (Ayurveda):</strong> ${_esc(draft.provisional_ayurveda)}`,
    draft.inv_lab              && `<strong>Labs suggested:</strong> ${_esc(draft.inv_lab)}`,
    draft.clinical_reasoning   && `<strong>Reasoning:</strong> ${_esc(draft.clinical_reasoning)}`,
  ].filter(Boolean);
  document.getElementById('draft-summary').innerHTML = summaryLines.join('<br>') || 'No detailed notes recorded.';
  document.getElementById('draft-review-panel').style.display = 'block';

  const btn = document.getElementById('btn-complete');
  btn.textContent = '✓ Finalize & Send to Pharmacy';
};

// ── Patient search ────────────────────────────────
let _searchTimeout = null;
window.onQueueSearch = function(query) {
  clearTimeout(_searchTimeout);
  if (!query.trim()) { loadQueue(); return; }
  _searchTimeout = setTimeout(() => searchPastPatients(query.trim()), 350);
};

async function searchPastPatients(query) {
  const list = document.getElementById('q-list');
  list.innerHTML = '<div class="q-empty"><div class="q-empty-icon">🔍</div>Searching…</div>';

  // Search patients by name/phone AND visits by chief_complaint in parallel
  const [{ data: byName }, { data: byDiag }] = await Promise.all([
    supabase.from('patients')
      .select('id, name, phone, abha_number, abha_address')
      .eq('tenant_id', tenantId)
      .or(`name.ilike.%${query}%,phone.ilike.%${query}%`)
      .limit(15),
    supabase.from('visits')
      .select('patient_id, chief_complaint, created_at, patients(id, name, phone, abha_number, abha_address)')
      .eq('tenant_id', tenantId)
      .eq('doctor_id', userId)
      .ilike('chief_complaint', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  // Deduplicate patients from both sources
  const patientMap = {};
  (byName || []).forEach(p => { patientMap[p.id] = p; });
  (byDiag || []).forEach(v => { if (v.patients && !patientMap[v.patients.id]) patientMap[v.patients.id] = v.patients; });

  const patients = Object.values(patientMap);
  if (!patients.length) { list.innerHTML = '<div class="q-empty">No patients found</div>'; return; }

  // Get most recent visit per patient from this doctor
  const { data: visits } = await supabase
    .from('visits')
    .select('id, status, chief_complaint, created_at, patient_id')
    .eq('tenant_id', tenantId)
    .eq('doctor_id', userId)
    .in('patient_id', patients.map(p => p.id))
    .order('created_at', { ascending: false })
    .limit(80);

  const visitMap = {};
  (visits || []).forEach(v => { if (!visitMap[v.patient_id]) visitMap[v.patient_id] = v; });

  list.innerHTML = patients.map(p => {
    const lv = visitMap[p.id];
    const lastDate = lv ? new Date(lv.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : null;
    return `<div class="q-card" data-onclick="openPatientHistory" data-onclick-a0="${_esc(p.id)}">
      <div class="q-card-top">
        <div class="q-token" style="background:#f3f4f6;color:#6b7280;font-size:9px;font-weight:700;min-width:36px">HIST</div>
        <div class="q-name">${_esc(p.name)}</div>
        <div class="q-wait" style="color:#888">${lastDate || '—'}</div>
      </div>
      <div class="q-meta">
        <span class="badge" style="background:#f3f4f6;color:#6b7280">📞 ${_esc(p.phone || '—')}</span>
        ${p.abha_number || p.abha_address ? '<span class="badge" style="background:#e0f2fe;color:#0369a1">ABHA ✓</span>' : ''}
      </div>
      <div class="q-complaint">${lv ? _esc(lv.chief_complaint || '—') : 'No past consultation with you'}</div>
    </div>`;
  }).join('');
}

window.openPatientHistory = async function(patientId) {
  const histEl    = document.getElementById('c-history');
  const welcomeEl = document.getElementById('welcome');
  const activeEl  = document.getElementById('c-active');
  welcomeEl.style.display = 'none';
  activeEl.style.display  = 'none';
  histEl.style.display    = '';
  histEl.innerHTML = '<div style="color:#888;padding:40px;text-align:center">Loading history…</div>';

  // Step 1: patient + visits (all doctors at this facility, not just this doctor)
  const [{ data: patient }, { data: visits }] = await Promise.all([
    supabase.from('patients').select('id, name, phone, abha_number, abha_address').eq('id', patientId).single(),
    supabase.from('visits')
      .select('id, status, chief_complaint, created_at, visit_category')
      .eq('tenant_id', tenantId)
      .eq('doctor_id', userId)
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const visitIds = (visits || []).map(v => v.id);

  // Step 2: consultation notes + prescriptions (separate queries — avoids deep-nest join failures)
  const { data: allNotes } = visitIds.length
    ? await supabase.from('consultation_notes').select('visit_id, diagnosis_namc_label, diagnosis_icd10_label, provisional_ayurveda, clinical_notes').in('visit_id', visitIds)
    : { data: [] };

  const notesMap = {};
  (allNotes || []).forEach(n => { notesMap[n.visit_id] = n; });

  // Prescriptions: two steps (prescriptions → prescription_items)
  const { data: rxHeaders } = visitIds.length
    ? await supabase.from('prescriptions').select('id, visit_id').in('visit_id', visitIds)
    : { data: [] };

  const rxIdToVisit = {};
  (rxHeaders || []).forEach(r => { rxIdToVisit[r.id] = r.visit_id; });
  const rxIds = Object.keys(rxIdToVisit);

  const { data: rxItems } = rxIds.length
    ? await supabase.from('prescription_items').select('prescription_id, medicine_name, dosage, frequency, duration, quantity').in('prescription_id', rxIds)
    : { data: [] };

  const rxMap = {};
  (rxItems || []).forEach(item => {
    const vid = rxIdToVisit[item.prescription_id];
    if (!vid) return;
    if (!rxMap[vid]) rxMap[vid] = [];
    rxMap[vid].push(item);
  });

  const catLabel = { opd:'OPD', followup:'Follow-up', panchakarma:'Panchakarma', emergency:'Emergency', teleconsultation:'Teleconsult', camp:'Camp' };

  const visitsHtml = (visits || []).map(v => {
    const date    = new Date(v.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const notes   = notesMap[v.id] || null;
    const rxItems = rxMap[v.id] || [];
    const diag    = notes?.diagnosis_namc_label || notes?.diagnosis_icd10_label || null;
    const rxHtml  = rxItems.length
      ? rxItems.map(r => `<div style="padding:5px 0;border-bottom:1px solid #f0ede5;font-size:13px">
          <strong>${_esc(r.medicine_name)}</strong>
          <span style="color:#666;margin-left:8px">${_esc([r.dosage, r.frequency, r.duration].filter(Boolean).join(' · '))}</span>
          ${r.quantity ? `<span style="color:#888;margin-left:6px">Qty: ${_esc(r.quantity)}</span>` : ''}
        </div>`).join('')
      : '<div style="color:#aaa;font-size:12px;padding:4px 0">No prescription recorded</div>';

    return `<div style="border:1.5px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px;background:#fff">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-weight:600;color:var(--green-deep);font-size:14px">${date}</span>
          <span class="badge badge-cat">${_esc(catLabel[v.visit_category] || 'OPD')}</span>
          <span class="badge" style="background:${v.status==='completed'?'#e8f5ee':'#fff8e1'};color:${v.status==='completed'?'#1a7a3a':'#7a5c00'}">${_esc(v.status?.toUpperCase())}</span>
        </div>
      </div>
      <div style="font-size:13px;margin-bottom:6px"><span style="color:#888">Chief Complaint:</span> <strong>${_esc(v.chief_complaint || '—')}</strong></div>
      ${diag ? `<div style="font-size:13px;margin-bottom:8px"><span style="color:#888">Diagnosis:</span> <strong>${_esc(diag)}</strong></div>` : ''}
      ${notes?.provisional_ayurveda ? `<div style="font-size:12px;color:#555;margin-bottom:8px;padding:8px;background:#fafdf8;border-radius:6px;border-left:3px solid var(--green-mid)"><strong>Provisional (Ayurveda):</strong> ${_esc(notes.provisional_ayurveda)}</div>` : ''}
      ${notes?.clinical_notes ? `<div style="font-size:12px;color:#555;margin-bottom:6px;padding:8px;background:#fafdf8;border-radius:6px;border-left:3px solid #c9902a"><strong>Clinical Notes:</strong> ${_esc(notes.clinical_notes)}</div>` : ''}
      <div style="font-size:12px;font-weight:600;color:var(--green-deep);margin-bottom:6px">💊 Prescription</div>
      ${rxHtml}
    </div>`;
  }).join('') || '<div style="color:#aaa;text-align:center;padding:30px">No past consultations found</div>';

  _historyPatient = patient;

  histEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:12px">
        <button data-onclick="_closeHistoryToWelcome" style="background:none;border:1.5px solid var(--border);border-radius:8px;padding:6px 14px;cursor:pointer;font-size:13px;font-family:'DM Sans',sans-serif;color:var(--text-main)">← Back</button>
        <div>
          <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--green-deep)">${_esc(patient?.name || 'Patient')}</div>
          <div style="font-size:12px;color:#888">${_esc(patient?.phone || '—')}${patient?.abha_number ? ' · ABHA: ' + _esc(patient.abha_number) : ''}</div>
        </div>
      </div>
      <!-- Session 175 follow-up: was gated on ABHA presence -- meant the button was
           invisible for exactly the patients Vipul's demo scenario cares about
           (demographic-only registration, no ABHA yet). The tab has real content either
           way now (Care Context Status shows regardless of ABHA); the M3 request panel
           inside it degrades to its own "no ABHA" message on its own, same pattern as
           every other entry point into this tab. -->
      <button data-onclick="_openAbdmForHistory" class="btn btn-primary" style="font-size:13px;padding:6px 14px">📋 ABDM Records</button>
    </div>
    <div style="font-size:13px;font-weight:600;color:var(--green-deep);margin-bottom:12px">Past Consultations (${(visits||[]).length})</div>
    ${visitsHtml}`;
};

window._openAbdmForHistory = function() {
  if (!_historyPatient) return;
  _activePatient = _historyPatient;
  _activeVisitId = null;
  _activeVisit   = null;
  document.getElementById('c-history').style.display = 'none';
  document.getElementById('welcome').style.display   = 'none';
  document.getElementById('c-active').style.display  = '';

  // Populate the patient identity strip — opened from history, there's no active
  // visit, so _openVisit()'s header code never runs. Fill it from _historyPatient
  // (id/name/phone/abha_number/abha_address). No visit → hide the token badge.
  document.getElementById('pt-token').style.display   = 'none';
  document.getElementById('pt-name').textContent      = _historyPatient.name || '—';
  document.getElementById('pt-complaint').textContent = 'Viewing ABDM records';
  document.getElementById('pt-uhid').textContent      = _uhid(_historyPatient.id);
  document.getElementById('pt-phone').textContent     = _historyPatient.phone || '—';
  const abhaWrap = document.getElementById('pt-abha-wrap');
  const abhaVal  = _historyPatient.abha_number || _historyPatient.abha_address || '';
  if (abhaVal) {
    document.getElementById('pt-abha').textContent = abhaVal;
    abhaWrap.style.display = '';
  } else {
    abhaWrap.style.display = 'none';
  }
  document.getElementById('pt-abha-addr-wrap').style.display = 'none';
  document.getElementById('pt-prakriti').style.display = 'none';
  // Session 279 -- no live visit here (viewing ABDM history, not a consultation),
  // so the age/gender/New-Followup badge and last-visit-diagnosis strip don't apply.
  document.getElementById('pt-age-gender').textContent = '';
  document.getElementById('pt-visit-badge').style.display = 'none';
  document.getElementById('pt-followup-info').style.display = 'none';
  document.getElementById('pt-hdr-detail').classList.remove('open');
  document.getElementById('pt-detail-toggle').textContent = '▾ More';

  _switchTab('abdm');
};

// ── Load unread alerts ────────────────────────────
async function loadAlerts() {
  const { count } = await supabase
    .from('doctor_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('doctor_id', userId)
    .eq('is_read', false);

  const dot = document.getElementById('alert-dot');
  if (count > 0) {
    dot.textContent = count;
    dot.classList.add('show');
  } else {
    dot.classList.remove('show');
  }
}

// ── §18l — OPD list (for internal referral target) ───
async function loadOpdList() {
  const { data } = await supabase.from('opds')
    .select('id, name, ncism_code')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');
  if (data) {
    _opdList = data;
    const sel = document.getElementById('ref-target-opd');
    sel.innerHTML = '<option value="">— Select OPD —</option>' +
      data.map(o => `<option value="${o.id}">${_esc(o.name)}${o.ncism_code ? ' ('+_esc(o.ncism_code)+')' : ''}</option>`).join('');
  }
}

// ── §18l — Doctor's active OPDs today ────────────
async function loadDoctorOpds() {
  const { data } = await supabase.from('opd_doctors')
    .select('opd_id')
    .eq('doctor_id', userId)
    .eq('tenant_id', tenantId)
    .eq('is_active_today', true);
  _doctorOpdIds = data ? data.map(r => r.opd_id) : [];
  loadIncomingReferrals();
}

// ── §18l — Incoming referrals for this doctor's OPDs
async function loadIncomingReferrals() {
  if (!_doctorOpdIds.length) return;
  const { data } = await supabase.from('referrals')
    .select('id, reason, urgency, referred_at, patients(id, name), referring_doctor:profiles!referring_doctor_id(full_name), source_opd:opds!source_opd_id(name)')
    .eq('tenant_id', tenantId)
    .in('target_opd_id', _doctorOpdIds)
    .eq('status', 'pending')
    .order('referred_at', { ascending: false });

  const panel = document.getElementById('ref-panel');
  const countEl = document.getElementById('ref-panel-count');
  const listEl  = document.getElementById('ref-panel-list');
  if (!data?.length) { panel.style.display = 'none'; return; }

  countEl.textContent = data.length;
  panel.style.display = '';
  const urgLabel = { routine:'Routine', semi_urgent:'Semi-Urgent', urgent:'Urgent', emergency:'Emergency' };
  listEl.innerHTML = data.map(r => `
    <div class="ref-card">
      <div class="ref-card-top">
        <span class="ref-card-name">${_esc(r.patients?.name || '—')}</span>
        <span class="ref-urg ${r.urgency}">${_esc(urgLabel[r.urgency] || r.urgency)}</span>
      </div>
      <div class="ref-card-meta">From: ${_esc(r.referring_doctor?.full_name || '—')} · ${_esc(r.source_opd?.name || '—')} · ${new Date(r.referred_at).toLocaleDateString('en-IN')}</div>
      <div class="ref-card-reason">${_esc(r.reason)}</div>
    </div>`).join('');
}

window.toggleRefPanel = function() {
  const body = document.getElementById('ref-panel-body');
  body.style.display = body.style.display === 'none' ? '' : 'none';
};

// Session 279 -- collapsible queue panel (Dr. Venkatesh: more room for
// consultation details). Default open every load, no persistence -- purely a
// per-session toggle, desktop-only (the toggle button itself is hidden below
// 860px via CSS, where the queue already collapses into its own stacked layout).
window.toggleQueuePanel = function() {
  const page = document.querySelector('.page');
  const btn = document.getElementById('q-collapse-toggle');
  if (!page || !btn) return;
  const collapsed = page.classList.toggle('q-collapsed');
  btn.textContent = collapsed ? '›' : '‹';
  btn.title = collapsed ? 'Expand queue' : 'Collapse queue';
};

// ── §18l — Show/hide internal OPD row ────────────
window.onRefTypeChange = function(val) {
  document.getElementById('ref-internal-row').style.display = val === 'internal' ? '' : 'none';
};

// ── §18l — Accept / mark-seen referral ───────────
window._acceptReferral = async function() {
  if (!_activeReferralId) return;
  await supabase.from('referrals')
    .update({ status: 'accepted', target_visit_id: _activeVisitId })
    .eq('id', _activeReferralId);
  document.getElementById('ref-banner').style.display = 'none';
  _activeReferralId = null;
  loadIncomingReferrals();
  _toast('Referral marked as seen', 'info');
};

// ── Realtime subscription ─────────────────────────
// Session 135 -- was a single 'doctor-live' channel with 4 chained .on() filters
// across 4 different tables. Confirmed live (side-by-side against a working
// single-table control channel, same auth session, same update) that Supabase
// Realtime silently drops delivery on this project for at least the lab_orders
// filter when bundled this way -- the channel subscribes "ok" with a valid
// server-assigned id, but no postgres_changes event ever arrives. Root cause
// not fully explained (not documented as a known Realtime limitation as of this
// session), but the fix is proven: one channel per table, matching the pattern
// every other page in this codebase (lab.js, etc.) already uses successfully.
function subscribeRealtime() {
  supabase.channel('doctor-live-visits')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'visits',
      filter: `tenant_id=eq.${tenantId}`
    }, () => { if (_queueTab !== 'ipd') loadQueue(); })
    .subscribe();

  supabase.channel('doctor-live-alerts')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'doctor_alerts',
      filter: `doctor_id=eq.${userId}`
    }, payload => {
      loadAlerts();
      _toast(`New on-request: ${payload.new.patient_name} — ${payload.new.message}`, 'alert');
    })
    .subscribe();

  supabase.channel('doctor-live-referrals')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'referrals',
      filter: `tenant_id=eq.${tenantId}`
    }, () => loadIncomingReferrals())
    .subscribe();

  // Session 126 -- lab.js pushed new orders to the lab dashboard already, but
  // nothing pushed status changes (sample collected / report ready) back out to
  // the doctor -- previously required reopening the visit to see updated status.
  // Filtered broadly by tenant (a per-visit filter can't be re-subscribed every
  // time the active patient changes) and narrowed client-side to the open visit.
  supabase.channel('doctor-live-lab-orders')
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'lab_orders',
      filter: `tenant_id=eq.${tenantId}`
    }, payload => {
      if (payload.new?.visit_id !== _activeVisitId) return;
      loadLabResults();
      if (payload.new.status === 'completed' && payload.old?.status !== 'completed') {
        _toast('🧪 Lab report ready', 'info');
      }
    })
    .subscribe();
}

// Session 279 -- same fallback pattern reception.js's _ageFromDob() uses; patients.age
// is preferred when set, this only covers the case where only date_of_birth was recorded.
function _ageFromDob(dob) {
  if (!dob) return null;
  const today = new Date(), birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 ? age : null;
}

// Session 279 -- collapsible patient-detail strip, vertical slide (top bar, unlike
// the queue sidebar's left/right slide). Collapsed by default every fresh consultation
// open (see startConsultation()); a plain per-click toggle, no persistence.
window.togglePatientDetail = function() {
  const detail = document.getElementById('pt-hdr-detail');
  const btn    = document.getElementById('pt-detail-toggle');
  const open   = detail.classList.toggle('open');
  btn.textContent = open ? '▴ Less' : '▾ More';
};

// ── Start consultation ────────────────────────────
window.startConsultation = async function(visitId) {
  // Real bug found live-testing the PK Care Plan wizard (Session 209): clicking a
  // different queue card directly -- without first closing the previous consultation
  // via the (✕) button -- never reset any tab's form state, so a chip left selected
  // (or an admission-advice line item, or a PK protocol) silently carried over onto
  // the next patient. Same bug class Session 205 already found+fixed on nursing.html
  // (_clearEntryForms(), called on every patient switch there). _clearForm() already
  // resets every tab's fields including PK/Admission Advice state -- just wasn't being
  // called on this entry point, only on explicit close.
  _clearForm();

  _activeVisitId = visitId;

  // Session 127 -- reset review-draft linkage on every fresh open; openReviewDraft()
  // re-sets these itself right after calling this function when opening via the
  // Pending Review tab.
  _activeDraftId   = null;
  _activeDraftedBy = null;
  document.getElementById('draft-review-panel').style.display = 'none';
  document.getElementById('btn-complete').textContent = _isTrainee ? '📝 Submit for Review' : '✓ Complete & Send to Pharmacy';

  await supabase.from('visits').update({ status: 'in_progress' }).eq('id', visitId);

  const { data: visit } = await supabase
    .from('visits')
    .select('*, patients(id, name, phone, abha_number, abha_address, prakriti_data, prakriti_assessed_at, gender, age, date_of_birth), opds(ncism_code, name, allows_prescription, specialty_proforma_key)')
    .eq('id', visitId)
    .single();

  _activeVisit     = visit;
  _activePatient   = visit?.patients;
  _activeNcismCode = visit?.opds?.ncism_code || null;

  // Session 268 -- an existing not-yet-activated Care Plan for this patient (drafted
  // by any doctor, any visit) can be resumed/added to; fired without blocking the
  // rest of the consultation load.
  if (_hasPK && _activePatient?.id) _pkCheckExistingDraft(_activePatient.id);

  // NCISM — Swasthya Rakshana OPD: advisory + Swasthya Card button
  const allowsRx = visit?.opds?.allows_prescription ?? true;
  const noRxNotice = document.getElementById('no-rx-notice');
  if (noRxNotice) noRxNotice.style.display = allowsRx ? 'none' : '';
  document.getElementById('btn-swasthya-card').style.display = allowsRx ? 'none' : '';

  const ptTokenEl = document.getElementById('pt-token');
  ptTokenEl.style.display = '';                       // may have been hidden by _openAbdmForHistory
  ptTokenEl.textContent   = visit.token_number;
  document.getElementById('pt-name').textContent     = _activePatient?.name || '—';
  document.getElementById('pt-complaint').textContent = visit.chief_complaint || '—';
  document.getElementById('pt-uhid').textContent     = _uhid(_activePatient?.id);
  document.getElementById('pt-phone').textContent    = _activePatient?.phone || '—';

  const abhaWrap = document.getElementById('pt-abha-wrap');
  if (_activePatient?.abha_number) {
    document.getElementById('pt-abha').textContent = _activePatient.abha_number;
    abhaWrap.style.display = '';
  } else {
    abhaWrap.style.display = 'none';
  }
  const abhaAddrWrap = document.getElementById('pt-abha-addr-wrap');
  if (_activePatient?.abha_address) {
    document.getElementById('pt-abha-addr').textContent = _activePatient.abha_address;
    abhaAddrWrap.style.display = '';
  } else {
    abhaAddrWrap.style.display = 'none';
  }

  // Session 279 -- always-visible age/gender + New/Followup badge (Dr. Venkatesh),
  // collapsed by default; the rest (UHID/phone/ABHA/prakriti/last-visit-diagnosis)
  // slides open on demand via togglePatientDetail() below.
  const ptAge = _activePatient?.age ?? _ageFromDob(_activePatient?.date_of_birth);
  const ptGenderLabel = { M: 'Male', F: 'Female', other: 'Other' }[_activePatient?.gender] || _activePatient?.gender || '';
  const ageGenderParts = [];
  if (ptAge) ageGenderParts.push(`${ptAge} yrs`);
  if (ptGenderLabel) ageGenderParts.push(ptGenderLabel);
  document.getElementById('pt-age-gender').textContent = ageGenderParts.length ? `· ${ageGenderParts.join(', ')}` : '';

  const isFollowup = visit.visit_category === 'followup';
  const visitBadge = document.getElementById('pt-visit-badge');
  visitBadge.textContent = isFollowup ? 'Followup' : 'New';
  visitBadge.className   = 'pt-visit-badge ' + (isFollowup ? 'followup' : 'new');
  visitBadge.style.display = '';

  const followupInfo = document.getElementById('pt-followup-info');
  if (isFollowup && _activePatient?.id) {
    supabase.from('visits')
      .select('created_at, diagnosis')
      .eq('patient_id', _activePatient.id)
      .neq('id', visitId)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data: prevVisits }) => {
        const prev = prevVisits?.[0];
        if (!prev) { followupInfo.style.display = 'none'; return; }
        document.getElementById('pt-last-visit-date').textContent =
          new Date(prev.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        document.getElementById('pt-last-diagnosis').textContent = prev.diagnosis || 'Not recorded';
        followupInfo.style.display = '';
      });
  } else {
    followupInfo.style.display = 'none';
  }

  // Collapsed by default for every fresh consultation open.
  document.getElementById('pt-hdr-detail').classList.remove('open');
  document.getElementById('pt-detail-toggle').textContent = '▾ More';

  // §18d — Load existing Prakriti assessment result
  const prakritiResult = _activePatient?.prakriti_data?.result || '';
  const prakritiPill   = document.getElementById('pt-prakriti');
  if (prakritiResult) {
    prakritiPill.textContent     = prakritiResult;
    prakritiPill.style.display   = '';
    document.getElementById('ay-prakriti').value = prakritiResult;
  } else if (_activePatient?.prakriti) {
    prakritiPill.textContent     = _activePatient.prakriti;
    prakritiPill.style.display   = '';
  } else {
    prakritiPill.style.display   = 'none';
  }

  // Pre-fill chief complaint from visit
  document.getElementById('h-complaint').value = visit.chief_complaint || '';

  document.getElementById('welcome').style.display  = 'none';
  document.getElementById('c-active').style.display = 'flex';
  document.getElementById('btn-complete').disabled   = true;

  // Tele visit — show Join Call button
  const joinBtn = document.getElementById('btn-join-call');
  if (visit.is_teleconsultation) {
    const meetUrl = visit.meeting_url || `https://meet.jit.si/AyurXpert-${tenant?.tenant_code||''}-${visit.id.slice(0,8)}`;
    joinBtn.href = meetUrl;
    joinBtn.style.display = '';
  } else {
    joinBtn.style.display = 'none';
  }

  if (window.innerWidth <= 860) {
    document.getElementById('c-active').classList.add('mobile-full');
    document.getElementById('q-mobile-hint').style.display = 'none';
    window.scrollTo(0, 0);
  }

  // Load proforma — specialty_proforma_key takes priority over ncism_code
  const pfContainer  = document.getElementById('pf-container');
  const pfTabBtn     = document.getElementById('tab-btn-proforma');
  const proformaKey  = visit?.opds?.specialty_proforma_key || _activeNcismCode;
  const pfHasData    = await renderProforma(proformaKey, pfContainer);
  pfTabBtn.style.display = pfHasData ? '' : 'none';

  // §18am — Load examination guide for specialty OPDs
  const examGuide = await getExamGuide(proformaKey);
  _renderExamGuide(examGuide);

  // §18r — Shalakya-Netra OPD
  const isNetra = _activeNcismCode === 'SHAL'
    ? visit?.opds?.name?.toLowerCase().includes('netra')
    : visit?.opds?.name?.toLowerCase().includes('netra') || visit?.opds?.name?.toLowerCase().includes('ophthal');
  _isNetra = isNetra;
  document.getElementById('netra-section').style.display = isNetra ? '' : 'none';

  // §18t — Shalakya-KNM OPD
  const isKnm = visit?.opds?.name?.toLowerCase().includes('karna')
    || visit?.opds?.name?.toLowerCase().includes('knm')
    || visit?.opds?.name?.toLowerCase().includes('ent')
    || (_activeNcismCode === 'SHAL' && !isNetra);
  _isKnm = isKnm;
  document.getElementById('ent-section').style.display = isKnm ? '' : 'none';

  // §18w — Prasuti / Streeroga OPD features
  const isPst = ['PST','PRASUTI_TANTRA','STRI_ROGA'].includes(_activeNcismCode)
    || visit?.opds?.name?.toLowerCase().includes('prasuti')
    || visit?.opds?.name?.toLowerCase().includes('stri roga')
    || visit?.opds?.name?.toLowerCase().includes('streeroga');
  _isPst = isPst;
  document.getElementById('obsgyn-section').style.display = isPst ? '' : 'none';

  // NABH — Load patient allergies and show banner
  _loadPatientAllergies(_activePatient?.id);

  // §18y — High-Risk Pregnancy banner (shown on any OPD when patient has a high-risk ANC record)
  const ancRiskBanner = document.getElementById('anc-risk-banner');
  ancRiskBanner.style.display = 'none';
  if (_activePatient?.id) {
    const { data: ancRisk } = await supabase
      .from('anc_visits')
      .select('risk_category, risk_factors, visit_date')
      .eq('patient_id', _activePatient.id)
      .eq('tenant_id', tenantId)
      .eq('risk_category', 'high')
      .order('visit_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ancRisk) {
      const detail = [
        ancRisk.risk_factors ? `Risk factors: ${ancRisk.risk_factors}` : null,
        `Last ANC: ${ancRisk.visit_date}`,
      ].filter(Boolean).join(' · ');
      document.getElementById('anc-risk-detail').textContent = detail;
      ancRiskBanner.style.display = '';
    }
  }

  // §18ab/§18ac/§18ad — Kaumarabhritya OPD features
  const isKau = _activeNcismCode === 'KAU' || visit?.opds?.name?.toLowerCase().includes('kaumar');
  document.getElementById('kau-age-band-row').style.display = isKau ? 'flex' : 'none';
  document.getElementById('pedi-dose-calc').style.display   = isKau ? '' : 'none';
  document.getElementById('growth-section').style.display   = isKau ? '' : 'none';
  document.getElementById('imm-section').style.display      = isKau ? '' : 'none';
  document.getElementById('swarna-section').style.display   = isKau ? '' : 'none';
  if (isKau) {
    document.getElementById('pedi-adult-dose').value = PEDI_FORMS.churna.adult;
    document.getElementById('pedi-unit').value       = PEDI_FORMS.churna.unit;
    await _loadGrowthHistory(_activePatient.id);
    await _loadImmunizations(_activePatient.id);
    await _loadSwarnaprashanHistory(_activePatient.id);
  }

  // §18af/18ag/18ah — Visha features: show only for Agadatantra OPD
  const isAgd = _activeNcismCode === 'AGD' || visit?.opds?.name?.toLowerCase().includes('agad');
  document.getElementById('tab-btn-visha').style.display     = isAgd ? '' : 'none';
  document.getElementById('visha-class-panel').style.display  = isAgd ? '' : 'none';
  document.getElementById('btn-escalate-emg').style.display  = isAgd ? '' : 'none';
  if (isAgd) await _loadVishaRecord(visitId);

  // §18l — Check if patient has a pending referral to this OPD
  document.getElementById('ref-banner').style.display = 'none';
  _activeReferralId = null;
  if (_doctorOpdIds.length && _activePatient?.id) {
    const { data: pendingRef } = await supabase.from('referrals')
      .select('id, reason, referring_doctor:profiles!referring_doctor_id(full_name), source_opd:opds!source_opd_id(name)')
      .eq('patient_id', _activePatient.id)
      .eq('tenant_id', tenantId)
      .in('target_opd_id', _doctorOpdIds)
      .eq('status', 'pending')
      .order('referred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pendingRef) {
      _activeReferralId = pendingRef.id;
      document.getElementById('rib-doctor').textContent = pendingRef.referring_doctor?.full_name || '—';
      document.getElementById('rib-opd').textContent    = pendingRef.source_opd?.name || '—';
      document.getElementById('rib-reason').textContent = pendingRef.reason || '';
      document.getElementById('ref-banner').style.display = '';
    }
  }

  _switchTab('hist');
  loadQueue();
  // Enable lab + imaging order buttons and load existing results
  const labBtn = document.getElementById('order-lab-btn');
  if (labBtn) labBtn.disabled = false;
  const imgBtn = document.getElementById('order-img-btn');
  if (imgBtn) imgBtn.disabled = false;
  loadLabResults();

  // Session 185 — offer to resume an autosaved draft, if one exists for this
  // visit under this doctor's own login. Runs last: proforma/eye/ENT/obsgyn
  // sections above are already rendered by now, so a Restore click has real
  // DOM nodes to write into.
  _checkForConsultationDraft(visitId);
};

// ── Tabs ──────────────────────────────────────────
const ALL_TABS = ['hist','exam','proforma','assess','diag','rx','advice','disp','pk','adm','visha','abdm'];

document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (btn && btn.dataset.tab) _switchTab(btn.dataset.tab);
});

function _switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  ALL_TABS.forEach(id => {
    const el = document.getElementById(`tab-${id}`);
    if (el) el.hidden = id !== name;
  });
  if (name === 'rx') refreshRxSuggestions();
  if (name === 'abdm') _loadAbdmTab();
}
window._switchTab = _switchTab;

// ── Exam block toggle (collapse/expand) ───────────
window.toggleBlock = function(id) {
  document.getElementById(id).classList.toggle('collapsed');
};

// ── Admission Advice (Session 205 cont.) ──────────
// Session 205 (cont.): replaces the old openIPDAdmission() -- that handed the doctor
// straight into ipd.html's full Admit form, letting them complete an entire admission
// unilaterally. Real hospital process: the doctor ADVISES admission with a cost
// estimate; only reception/admin ever actually admits (create_ipd_admission RPC,
// enforced server-side by RLS -- see sql/session205_admission_advice.sql). This block
// builds that advice record + its cost estimate and saves it for reception to see.
let _admDepts       = [];
let _admProcedures  = [];   // fee_structures rows, category='procedure'
let _admItems       = [];   // working list: {fee_type, description, sessions_count, unit_price, line_total}
let _admTenantPct   = { self_pay: 25, insurance: 10 };

async function _loadAdmDepts() {
  const { data } = await supabase.from('departments')
    .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true).order('name');
  _admDepts = data || [];
  const sel = document.getElementById('adm-dept');
  if (sel) sel.innerHTML = '<option value="">— Select department —</option>' +
    _admDepts.map(d => `<option value="${d.id}">${_esc(d.name)}</option>`).join('');
}

async function _loadAdmProcedureOptions() {
  // Real bug found live-testing on SDM (14 Sep): fee_structures' descriptive-text
  // column is called `label`, not `description` -- this select was 400ing on every
  // load, silently leaving the procedure dropdown empty.
  const { data } = await supabase.from('fee_structures')
    .select('fee_type, label, amount, gst_percent, promo_price, promo_valid_until')
    .eq('tenant_id', tenantId).eq('category', 'procedure').eq('is_active', true).order('fee_type');
  _admProcedures = data || [];
  const sel = document.getElementById('adm-proc-select');
  if (sel) sel.innerHTML = '<option value="">— Select a procedure —</option>' +
    _admProcedures.map(p => `<option value="${_esc(p.fee_type)}">${_esc(p.label || p.fee_type)} — ₹${getEffectivePrice(p).toLocaleString('en-IN')}</option>`).join('');
}

async function _loadTenantAdvancePct() {
  const { data } = await supabase.from('tenants')
    .select('ipd_advance_pct_self_pay, ipd_advance_pct_insurance').eq('id', tenantId).maybeSingle();
  if (data) _admTenantPct = { self_pay: Number(data.ipd_advance_pct_self_pay) || 25, insurance: Number(data.ipd_advance_pct_insurance) || 10 };
}

function _renderAdmProcList() {
  const el = document.getElementById('adm-proc-list');
  if (!el) return;
  el.innerHTML = _admItems.length
    ? _admItems.map((it, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:5px;background:#fafff7">
        <div>
          <div style="font-size:12.5px;font-weight:600">${_esc(it.description)}</div>
          <div style="font-size:10.5px;color:var(--text-muted)">${it.sessions_count} session${it.sessions_count>1?'s':''} × ₹${it.unit_price.toLocaleString('en-IN')} = ₹${it.line_total.toLocaleString('en-IN')}</div>
        </div>
        <button type="button" data-onclick="removeAdviceProcedure" data-onclick-a0="${i}" style="width:26px;height:26px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-size:11px">&#10005;</button>
      </div>`).join('')
    : '<div style="text-align:center;color:var(--text-muted);padding:10px;font-size:12px">No procedures planned yet.</div>';
}

window.addAdviceProcedure = function() {
  const feeType = document.getElementById('adm-proc-select').value;
  const sessions = parseInt(document.getElementById('adm-proc-sessions').value) || 1;
  if (!feeType) return;
  const feeRow = _admProcedures.find(p => p.fee_type === feeType);
  if (!feeRow) return;
  const unitPrice = getEffectivePrice(feeRow);
  _admItems.push({
    fee_type: feeType,
    description: feeRow.label || feeType,
    sessions_count: sessions,
    unit_price: unitPrice,
    line_total: unitPrice * sessions,
  });
  document.getElementById('adm-proc-select').value = '';
  document.getElementById('adm-proc-sessions').value = '1';
  _renderAdmProcList();
  recomputeAdviceEstimate();
};

window.removeAdviceProcedure = function(idx) {
  _admItems.splice(Number(idx), 1);
  _renderAdmProcList();
  recomputeAdviceEstimate();
};

let _admLastEstimate = null;   // { roomCost, treatmentCost, total, advancePct, advanceSuggested }
let _admAdviceSaved  = false;  // did saveAdmissionAdvice() actually succeed this consultation?

window.recomputeAdviceEstimate = async function() {
  const el = document.getElementById('adm-estimate-body');
  if (!el) return;
  const roomType = document.getElementById('adm-room-type').value;
  const days     = parseInt(document.getElementById('adm-duration-days').value) || 0;
  const payer    = document.getElementById('adm-payer').value;

  if (!days) {
    el.textContent = 'Fill in department, room type and duration above to see an estimate.';
    _admLastEstimate = null;
    return;
  }

  const today = new Date();
  const through = new Date(today.getTime() + days * 86400000);
  const tariff = await computeRoomTariff({ supabase, tenantId, bed: { bed_type: roomType }, admissionDate: today, throughDate: through });

  const treatmentCost = _admItems.reduce((s, it) => s + it.line_total, 0);

  if (tariff.error) {
    el.innerHTML = `<span style="color:#c0392b">⚠ ${_esc(tariff.error)}</span>` +
      (treatmentCost ? `<br>Planned treatment: ₹${treatmentCost.toLocaleString('en-IN')} (room tariff still needed for a full estimate)` : '');
    _admLastEstimate = null;
    return;
  }

  const roomCost = tariff.total;
  const total    = roomCost + treatmentCost;
  const pct      = payer === 'insurance' ? _admTenantPct.insurance : _admTenantPct.self_pay;
  const advance  = Math.round(total * pct / 100);

  _admLastEstimate = { roomCost, treatmentCost, total, advancePct: pct, advanceSuggested: advance };

  el.innerHTML = `
    Room: ${tariff.days} day${tariff.days>1?'s':''} × ₹${tariff.dailyRate.toLocaleString('en-IN')} = <strong>₹${roomCost.toLocaleString('en-IN')}</strong><br>
    Planned treatment: <strong>₹${treatmentCost.toLocaleString('en-IN')}</strong><br>
    <span style="font-size:14px;font-weight:700;color:var(--green-deep)">Estimated Total: ₹${total.toLocaleString('en-IN')}</span><br>
    Suggested advance (${pct}%, ${payer === 'insurance' ? 'insurance' : 'self-pay'}): <strong>₹${advance.toLocaleString('en-IN')}</strong>`;
};

function _resetAdmissionAdvice() {
  _admItems = [];
  _admLastEstimate = null;
  _admAdviceSaved  = false;
  _renderAdmProcList();
  const el = document.getElementById('adm-estimate-body');
  if (el) el.textContent = 'Fill in department, room type and duration above to see an estimate.';
  const status = document.getElementById('adm-save-status');
  if (status) status.style.display = 'none';
}

window.saveAdmissionAdvice = async function() {
  if (!_activePatient || !_activeVisitId) { alert('Select a patient first.'); return; }
  const deptId       = document.getElementById('adm-dept').value;
  const indication   = document.getElementById('adm-indication').value.trim();
  const days         = parseInt(document.getElementById('adm-duration-days').value) || 0;
  const roomType     = document.getElementById('adm-room-type').value;
  const payer        = document.getElementById('adm-payer').value;

  if (!deptId)     { alert('Select a target department.'); return; }
  if (!indication) { alert('Enter the clinical indication for admission.'); return; }
  if (!days)       { alert('Enter the expected duration (days).'); return; }
  await recomputeAdviceEstimate();
  if (!_admLastEstimate) { alert('Fix the room-tariff issue shown above before sending this advice.'); return; }

  const btn = document.getElementById('btn-save-advice');
  btn.disabled = true; btn.textContent = 'Sending…';

  const { data: advice, error } = await supabase.from('admission_advice').insert({
    tenant_id: tenantId, patient_id: _activePatient.id, visit_id: _activeVisitId, doctor_id: userId,
    department_id: deptId,
    clinical_indication: indication,
    expected_duration_days: days,
    duration_note: document.getElementById('adm-duration-note').value.trim() || null,
    room_type_preference: roomType,
    nursing_care_notes: document.getElementById('adm-nursing').value.trim() || null,
    diet_type: document.getElementById('adm-diet').value.trim() || null,
    payer_type: payer,
    estimated_room_cost: _admLastEstimate.roomCost,
    estimated_treatment_cost: _admLastEstimate.treatmentCost,
    estimated_total: _admLastEstimate.total,
    advance_pct_applied: _admLastEstimate.advancePct,
    advance_amount_suggested: _admLastEstimate.advanceSuggested,
    created_by: userId,
  }).select('id').single();

  if (error) {
    btn.disabled = false; btn.textContent = '📤 Send Admission Advice to Reception';
    alert(safeErrorMessage(error, 'Could not save admission advice.')); return;
  }

  if (_admItems.length) {
    const { error: itemsErr } = await supabase.from('admission_advice_items').insert(
      _admItems.map(it => ({
        tenant_id: tenantId, admission_advice_id: advice.id, fee_type: it.fee_type,
        description: it.description, sessions_count: it.sessions_count,
        unit_price_snapshot: it.unit_price, line_total: it.line_total,
      }))
    );
    if (itemsErr) console.warn('[doctor] admission_advice_items insert:', itemsErr.message);
  }

  await logAudit('admission_advice_created', 'admission_advice', advice.id, {
    patient_name: _activePatient?.name, department_id: deptId, estimated_total: _admLastEstimate.total,
  }, _ctx);

  _admAdviceSaved = true;
  btn.disabled = false; btn.textContent = '📤 Send Admission Advice to Reception';
  const status = document.getElementById('adm-save-status');
  status.style.display = '';
  status.textContent = `✓ Sent — ${_activePatient?.name} will now appear in Reception's Admission Requests queue.`;
};

// ── Panchakarma Care Plan (Session 208, Phase 1) ──
// Replaces the old dead "Panchakarma" tab (3 chip groups + Start/Duration/Oils/Notes
// fields whose values were never read anywhere -- Complete Consultation just showed a
// hardcoded 'Panchakarma plan saved' toast with nothing behind it). Real workflow
// (Dr. Venkatesh): pick one or more protocols -> each protocol's own SOP auto-generates
// a day-by-day calendar (flexible blocks like Snehapana can be extended/reduced, which
// shifts every later day in that protocol) -> medicines + 3 audience-scoped instructions
// -> Admission/Day Care/OPD setting + estimate -> save. Reception hand-off/advance
// collection and the realtime fan-out to nursing/therapist/prep are a later phase --
// this ends at a saved, finalized pk_care_plans row. See sql/session208_pk_sop_templates.sql
// + sql/session208_pk_care_plans.sql.
let _pkTemplates     = [];   // pk_sop_templates rows
let _pkTemplateDays  = {};   // template_id -> pk_sop_template_days rows
let _pkContentHints  = {};   // pk_sop_templates.id -> {duration, staff} from the linked sop_content_templates row (Session 248)
let _pkContentHintsByAyush = {};  // ayush_code -> sop_content_templates row (Session 279)
let _pkContentHintsByLabel = {};  // lower(trim(activity_label)) -> sop_content_templates row (Session 279)
let _pkAyushOptions  = [];   // ayush_procedure_catalog rows (Panchakarma + Anu-Shastra Karma)
let _pkFeeIndex      = {};   // ayush_code -> fee_structures row (tenant's active pricing)
let _pkNiruhaFormulations = []; // pk_niruha_formulations rows (Session 271)
// Session 285 -- pediatric Basti age-band reference data + narrative, loaded once
// alongside the rest of the PK reference tables. Only ever consulted for a Basti
// protocol on a patient under 18 (_pkIsPediatricPatient()) -- the adult Basti pathway
// never reads any of these, so a missing/empty result here can't break it.
let _pkPediatricDosingBands    = []; // pk_pediatric_dosing_bands rows (procedure_key='basti_yapana')
let _pkPediatricEquipmentSizing = []; // pk_pediatric_equipment_sizing rows (procedure_key='basti')
let _pkPediatricNarrative      = {}; // procedure_key -> pediatric sop_content_templates row
// Session 287 -- pediatric Virechana reference data, same "only ever consulted for a
// pediatric patient" isolation as the Basti tables above. Generic table (procedure_key-
// scoped), not Virechana-only -- Vamana's own drug-by-age doses can reuse it later.
let _pkPediatricDrugDoses = []; // pk_pediatric_drug_doses rows, all procedure_keys
let _pkGrowthLatestByPatient = {}; // patient_id -> latest growth_records row (or null once checked)

// Session 279 -- classical unit per Niruha component, fixed by Ayurvedic convention
// (matches pk_care_plan_medicines.quantity_unit's own CHECK constraint: ml or g).
const _PK_NIRUHA_COMPONENT_UNIT = { madhu: 'ml', lavana: 'g', sneha: 'ml', kalka: 'g', kwatha: 'ml', avapa: 'ml' };
const _PK_NIRUHA_COMPONENT_LABEL = {
  madhu: '1. Madhu (Honey)', lavana: '2. Lavana (Salt)', sneha: '3. Sneha (Oil/Ghee)',
  kalka: '4. Kalka (Herbal Paste)', kwatha: '5. Kwatha (Decoction)', avapa: '+. Avapa (optional add-on)',
};
const _PK_NIRUHA_COMPONENT_PLACEHOLDER = {
  madhu: 'Honey', lavana: 'Saindhava Lavana', sneha: 'e.g. Eranda Taila',
  kalka: 'e.g. Shatahva', kwatha: 'e.g. Dashamula Kwatha', avapa: 'e.g. Gomutra',
};

// Session 285 follow-up -- maps each classical Niruha component onto its matching
// column in pk_pediatric_dosing_bands (the NIA document's "Yapana Basti Karma: Age
// Wise Doses" table). Kashaya = Kwatha (decoction); the document's "Gomutra" column
// is exactly this app's existing Avapa slot (its own placeholder was always
// "e.g. Gomutra", confirmed before adding this mapping, not a new assumption).
const _PK_PEDIATRIC_NIRUHA_DOSE_FIELD = {
  madhu: 'madhu_ml', lavana: 'saindhava_g', sneha: 'sneha_ml',
  kalka: 'kalka_g', kwatha: 'kashaya_ml', avapa: 'gomutra_ml',
};

// Applies the patient's resolved pediatric dose band onto a Niruha formula's 6
// primary components in place (only the first item per component -- fresh/loaded
// formulas always start single-item per component, matching _pkNewNiruhaFormula()/
// _pkLoadNiruhaFormulation()'s own shape). No-op for an adult patient or when no band
// resolves (e.g. under 1 year -- see the Step 2 panel's own warning for that case).
// Ingredient NAMES are left untouched -- a formulation's classical ingredient choice
// doesn't change with age, only the quantity; Avapa's name defaults to "Gomutra" only
// when the doctor hasn't already typed something else, since that's what the
// document's own age-wise table actually names that slot for children.
function _pkApplyPediatricNiruhaDoses(niruhaFormula) {
  if (!_pkIsPediatricPatient() || !niruhaFormula) return;
  const band = _pkResolvePediatricDoseBand(_pkPatientAgeYears());
  if (!band) return;
  Object.entries(_PK_PEDIATRIC_NIRUHA_DOSE_FIELD).forEach(([comp, field]) => {
    const item = niruhaFormula.components[comp]?.[0];
    if (!item) return;
    item.qty = band[field] ?? item.qty;
    if (comp === 'avapa' && !item.name) item.name = 'Gomutra';
  });
}

// Session 279 -- fresh Niruha formula: each classical component starts as a
// one-item list (add more via _pkAddNiruhaItem), plus a free-text course name
// and a place for entirely extra custom-labeled components beyond the classical
// 6 (Dr. Venkatesh: "add 7+N if required").
function _pkNewNiruhaFormula() {
  return {
    formulation_key: '', formula_name: '',
    components: {
      madhu:  [{ name: 'Honey', qty: null }],
      lavana: [{ name: 'Saindhava Lavana (Rock Salt)', qty: null }],
      sneha:  [{ name: '', qty: null }],
      kalka:  [{ name: '', qty: null }],
      kwatha: [{ name: '', qty: null }],
      avapa:  [{ name: '', qty: null }],
    },
    extra: [], // [{ label:'', unit:'g', items:[{name:'',qty:null}] }]
  };
}
let _pkProtocols     = [];   // working list: {template_id, procedure_key, protocol_label, is_reviewed, start_date, blocks:[...], medicines:[...]}
let _pkStep          = 1;
let _pkLastEstimate  = null;
let _pkPlanSaved     = false;

async function _loadPkTemplates() {
  const { data: templates } = await supabase.from('pk_sop_templates').select('*').order('phase_group').order('display_name');
  _pkTemplates = templates || [];
  const { data: days } = await supabase.from('pk_sop_template_days').select('*').order('sequence_order');
  _pkTemplateDays = {};
  (days || []).forEach(d => { (_pkTemplateDays[d.template_id] = _pkTemplateDays[d.template_id] || []).push(d); });

  // Ambiguous-day billing-code picker options (Step 3) -- e.g. Basti has 9 real
  // site-specific codes and no generic one, so the doctor resolves it per plan.
  const { data: ayush } = await supabase.from('ayush_procedure_catalog')
    .select('code,name,category').in('category', ['Panchakarma', 'Anu-Shastra Karma']).order('code');
  _pkAyushOptions = ayush || [];

  // Session 248 -- duration/manpower hint on each chip, sourced from the document-content
  // layer (sop_content_templates), not pk_sop_templates itself (that table was deliberately
  // left untouched, see PANCHAKARMA_SOP_EXPANSION_CHECKLIST.md §0b). Not every protocol has
  // a linked content row yet (or a stated figure within one) -- missing hints are just omitted.
  // Session 279 -- a multi-day/multi-activity protocol (Vamana/Virechana/Basti) genuinely
  // has no single protocol-level duration (each day-activity's real duration differs --
  // Vamana's PCK63 administration is 60min, its PCK54 Snehapana prep is 10min); their real
  // per-activity data lives in separate rows keyed by ayush_code or activity_label_match,
  // exactly mirroring the 3-tier priority auto_assign_pk_course_sessions() itself uses
  // (ayush_code > activity_label_match > linked_pk_template_id -- see
  // sql/session277_pk_doctor_duration_manpower_override.sql). Load all 3 keyings so the
  // Step 2 "needs manual input" check (_pkNeedsManualScheduleInput) can check the same way
  // the real engine resolves it, not just the lowest-priority protocol-level fallback.
  const { data: hints } = await supabase.from('sop_content_templates')
    .select('id,linked_pk_template_id,ayush_code,activity_label_match,typical_duration_minutes,man_power_staff,owner_role');
  _pkContentHints = {};
  _pkContentHintsByAyush = {};
  _pkContentHintsByLabel = {};
  (hints || []).forEach(h => {
    if (h.linked_pk_template_id) _pkContentHints[h.linked_pk_template_id] = h;
    if (h.ayush_code) _pkContentHintsByAyush[h.ayush_code] = h;
    if (h.activity_label_match) _pkContentHintsByLabel[h.activity_label_match.trim().toLowerCase()] = h;
  });

  // Session 271 -- Niruha Basti compound-formulation library (Madhu/Lavana/Sneha/
  // Kalka/Kwatha, classically mixed in that order); doctor picks one as a starting
  // template, every field stays freely editable per patient afterward.
  const { data: niruhaForms } = await supabase.from('pk_niruha_formulations').select('*').order('display_name');
  _pkNiruhaFormulations = niruhaForms || [];

  // Session 285 -- pediatric Basti reference data. These 3 queries are scoped so
  // narrowly (dosing_bands/equipment_sizing tables barely have a handful of rows;
  // the narrative query filters to age_band='pediatric', department='panchakarma')
  // that they can never collide with or slow down the existing adult-only loads above.
  const { data: doseBands } = await supabase.from('pk_pediatric_dosing_bands')
    .select('*').eq('procedure_key', 'basti_yapana').order('sequence_order');
  _pkPediatricDosingBands = doseBands || [];
  const { data: equipBands } = await supabase.from('pk_pediatric_equipment_sizing')
    .select('*').eq('procedure_key', 'basti').order('sequence_order');
  _pkPediatricEquipmentSizing = equipBands || [];
  const { data: pediatricNarrative } = await supabase.from('sop_content_templates')
    .select('procedure_key,indications,contraindications,precautions')
    .eq('department', 'panchakarma').eq('age_band', 'pediatric');
  _pkPediatricNarrative = {};
  (pediatricNarrative || []).forEach(r => { _pkPediatricNarrative[r.procedure_key] = r; });

  // Session 287 -- pediatric drug-by-age dose reference (Virechana Dravya, Snehapana
  // test/max dose by Agnibala, Atiyoga rescue-medicine doses). Same negligible-size
  // query pattern as the Basti reference tables above.
  const { data: drugDoses } = await supabase.from('pk_pediatric_drug_doses').select('*').order('sequence_order');
  _pkPediatricDrugDoses = drugDoses || [];

  _renderPkChips();
}

// Session 285 -- patient age already resolved by _ageFromDob()/reception.js's own
// autofill; this just applies the same "under 18 = pediatric" cutoff the platform
// uses everywhere a ROLES.STUDENT/trainee-adjacent age distinction matters. Returns
// null (not pediatric, not adult -- simply unknown) when age can't be determined,
// so callers never have to special-case "no DOB on file" separately.
function _pkPatientAgeYears() {
  return _activePatient?.age ?? _ageFromDob(_activePatient?.date_of_birth);
}
function _pkIsPediatricPatient() {
  const age = _pkPatientAgeYears();
  return age != null && age < 18;
}
function _pkResolvePediatricDoseBand(ageYears) {
  if (ageYears == null) return null;
  return _pkPediatricDosingBands.find(b => ageYears >= b.age_min_years && ageYears <= b.age_max_years) || null;
}
function _pkResolvePediatricEquipmentBand(ageYears) {
  if (ageYears == null) return null;
  return _pkPediatricEquipmentSizing.find(b => ageYears >= b.age_min_years && ageYears <= b.age_max_years) || null;
}

// Session 287 -- drug-by-age lookups, generic across procedure_key/usage_context so
// a future procedure (Vamana) can reuse the same table+helpers with a new key.
function _pkDrugDosesFor(procedureKey, usageContext, ageYears) {
  if (ageYears == null) return [];
  return _pkPediatricDrugDoses.filter(d =>
    d.procedure_key === procedureKey && d.usage_context === usageContext &&
    ageYears >= d.age_min_years && ageYears <= d.age_max_years);
}

// Session 287 -- fetches (once per patient, cached) the most recent growth_records row
// so pediatric Virechana can check the document's own weight-for-age hard stop (SAM/MAM
// = contraindicated) against REAL recorded data instead of asking the doctor to
// re-derive it. Reuses growth_records.weight_percentile_band exactly as computed and
// stored by saveGrowthRecord()'s own _grBand() call -- no new classification logic.
async function _pkLoadLatestGrowthRecord(patientId) {
  if (!patientId || _pkGrowthLatestByPatient[patientId] !== undefined) return _pkGrowthLatestByPatient[patientId];
  const { data } = await supabase.from('growth_records')
    .select('recorded_at,weight_kg,weight_percentile_band')
    .eq('patient_id', patientId).eq('tenant_id', tenantId)
    .order('recorded_at', { ascending: false }).limit(1).maybeSingle();
  _pkGrowthLatestByPatient[patientId] = data || null;
  return _pkGrowthLatestByPatient[patientId];
}
// SAM = '<3rd' percentile band, MAM = '3–15th' -- exact strings _grBand() writes.
function _pkGrowthIsSamMam(record) {
  return record && (record.weight_percentile_band === '<3rd' || record.weight_percentile_band === '3–15th');
}

// Session 287 -- Virechana's own age-group labels (document's Age Group section),
// distinct from Basti's Yapana dose bands -- Virechana's recommendation genuinely
// changes in KIND (Mridu Sadya Virechana vs. Snehana Purvaka Virechana) at these
// boundaries, not just in dose quantity.
function _pkVirechanaAgeBandLabel(ageYears) {
  if (ageYears == null) return null;
  if (ageYears < 1) return 'Infant (0-1yr) — Mridu Sadya Virechana / Koshtha Shuddhi only';
  if (ageYears < 3) return 'Toddler (1-3yr) — Mridu Sadya Virechana / Koshtha Shuddhi only';
  if (ageYears < 6) return 'Pre-schooler (3-5yr) — Mridu Sadya Virechana / Koshtha Shuddhi only';
  if (ageYears < 10) return 'School-age (6-10yr) — Snehana Purvaka Virechana';
  return 'Adolescent (10-18yr) — Snehana Purvaka Virechana';
}

window._pkSetShuddhiTier = function(pi, tier) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  p.pediatric_shuddhi_tier = tier || null;
};

// Session 288 -- Vamana's own age-group recommendation. Infants/Toddlers/Pre-
// schoolers get Sadyo-Vamana (single-purpose, lighter, no Pachana/Snehana/Swedana
// purvakarma) rather than classical Vamana -- the document's Vamana Dravya dose
// table below only really applies to School-age/Adolescent classical Vamana.
function _pkVamanaAgeBandLabel(ageYears) {
  if (ageYears == null) return null;
  if (ageYears < 1) return 'Infant (0-1yr) — Sadyo-Vamana only (Kapha Dushita Stanya / Atyayika)';
  if (ageYears < 3) return 'Toddler (1-3yr) — Sadyo-Vamana only (Kapha/Kapha-Pittaja, Ajeerna)';
  if (ageYears < 6) return 'Pre-schooler (3-5yr) — Sadyo-Vamana only (Pranavaha Srotovikara, Ajeerna)';
  if (ageYears < 12) return 'School-age (6-12yr) — Sadyo-Vamana or classical Vamana';
  return 'Adolescent (12-18yr) — classical Vamana';
}

// Session 289 -- Nasya's own age-group recommendation. Pratimarsha is the one type
// recommended at every pediatric age (even infants); Marsha only joins in from
// School-age 9yr+ (the document splits 6-12yr into "6-8 only Pratimarsha" vs.
// "9-12 both" -- the 6yr lower bound of the school-age band alone isn't enough).
function _pkNasyaAgeBandLabel(ageYears) {
  if (ageYears == null) return null;
  if (ageYears < 1) return 'Infant (0-1yr) — Pratimarsha Nasya only';
  if (ageYears < 3) return 'Toddler (1-3yr) — Pratimarsha Nasya only';
  if (ageYears < 6) return 'Pre-schooler (3-5yr) — Pratimarsha Nasya only';
  if (ageYears < 9) return 'School-age (6-8yr) — Pratimarsha Nasya only';
  if (ageYears < 12) return 'School-age (9-12yr) — Pratimarsha and Marsha Nasya';
  return 'Adolescent (12-18yr) — Pratimarsha and Marsha Nasya';
}

function _pkRenderPediatricVirechanaPanel(p, pi) {
  if (!_pkIsPediatricPatient()) return '';
  const ageYears = _pkPatientAgeYears();
  const ageBandLabel = p.pediatric_age_band || _pkVirechanaAgeBandLabel(ageYears);
  const narrative = _pkPediatricNarrative['virechana'];
  const assentApplicable = ageYears >= _PK_PEDIATRIC_ASSENT_MIN_AGE;
  const growth = _pkGrowthLatestByPatient[_activePatient?.id];
  // Fire-and-forget fetch on first render too (not just at protocol-creation time) --
  // covers re-opening an already-saved pediatric Virechana draft for editing, which
  // reconstructs the protocol without going through _pkToggleProtocol()'s own trigger.
  if (growth === undefined && _activePatient?.id) _pkLoadLatestGrowthRecord(_activePatient.id).then(() => _renderPkCalendar());
  const samMam = _pkGrowthIsSamMam(growth);
  const dravyaOptions = _pkDrugDosesFor('virechana', 'virechana_dravya', ageYears);
  const snehaOptions = _pkDrugDosesFor('virechana', 'virechana_snehapana', ageYears);
  const atiyogaOptions = _pkPediatricDrugDoses.filter(d => d.procedure_key === 'virechana' && d.usage_context === 'virechana_atiyoga_management');

  return `
      <div style="border:2px solid var(--purple);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fdf5fb">
        <div style="font-weight:700;font-size:12.5px;color:var(--purple);margin-bottom:8px">🧒 Pediatric Virechana — patient is ${_esc(String(ageYears))} years old</div>
        ${ageBandLabel ? `<div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">${_esc(ageBandLabel)}</div>` : ''}

        ${growth === undefined ? `
        <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:8px">Checking weight-for-age from the patient's Growth Record…</div>` : growth === null ? `
        <div style="background:#fff8e1;border:1px solid #e6c200;border-radius:5px;padding:7px 10px;font-size:11.5px;color:#6b4c00;margin-bottom:8px">
          ⚠ No Growth Record on file for this patient. Per the document, weight-for-age determines dose tier and SAM/MAM is an outright contraindication — record a Growth Record (History tab) before finalizing this plan.
        </div>` : samMam ? `
        <div style="background:#fff3f3;border:2px solid var(--red);border-radius:5px;padding:8px 10px;font-size:11.5px;color:#7a1a1a;margin-bottom:8px;font-weight:600">
          🚫 CONTRAINDICATED: this patient's latest Growth Record (${new Date(growth.recorded_at+'T00:00').toLocaleDateString('en-IN')}) shows ${_esc(growth.weight_percentile_band)} weight-for-age — ${growth.weight_percentile_band === '<3rd' ? 'Severe Acute Malnutrition (SAM)' : 'Moderate Acute Malnutrition (MAM)'}. The document contraindicates Virechana outright for SAM/MAM children, not just a reduced dose. This plan cannot be saved while Virechana is selected for this patient.
        </div>` : `
        <div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">✓ Latest Growth Record (${new Date(growth.recorded_at+'T00:00').toLocaleDateString('en-IN')}): weight-for-age ${_esc(growth.weight_percentile_band || '—')} — not SAM/MAM, Virechana not weight-contraindicated.</div>`}

        <div class="field" style="width:220px;margin-bottom:8px">
          <label style="font-size:11px">Shuddhi dose tier (weight-for-age)</label>
          <select data-onchange="_pkSetShuddhiTier" data-onchange-a0="${pi}" data-onchange-a1="@value">
            <option value="">— Assess —</option>
            <option value="uttam"${p.pediatric_shuddhi_tier === 'uttam' ? ' selected' : ''}>Uttam (normal/above weight-for-age — full dose)</option>
            <option value="madhyama"${p.pediatric_shuddhi_tier === 'madhyama' ? ' selected' : ''}>Madhyama (70-80% weight-for-age — reduced dose)</option>
            <option value="hina"${p.pediatric_shuddhi_tier === 'hina' ? ' selected' : ''}>Hina (60-70% weight-for-age — minimal dose only)</option>
          </select>
        </div>

        ${dravyaOptions.length ? `
        <details style="margin-bottom:8px" open>
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">💊 Virechana Dravya options for this age — reference for the medicine entry in Step 3</summary>
          <table style="width:100%;font-size:10.5px;margin-top:4px;border-collapse:collapse">
            ${dravyaOptions.map(d => `<tr><td style="padding:2px 6px 2px 0">${_esc(d.drug_name)}</td><td style="padding:2px 6px;color:var(--text-mid)">${d.dose_min === d.dose_max ? d.dose_min : `${d.dose_min}-${d.dose_max}`}${_esc(d.unit)}</td><td style="padding:2px 0;color:var(--text-muted)">${_esc(d.notes || '')}</td></tr>`).join('')}
          </table>
        </details>` : ''}

        ${snehaOptions.length ? `
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">🌿 Snehapana test-dose / max-dose reference by Agnibala — for the Snehapana Dosing panel below</summary>
          <table style="width:100%;font-size:10.5px;margin-top:4px;border-collapse:collapse">
            <thead><tr style="color:var(--text-mid)"><th style="text-align:left;padding:2px 6px 2px 0">Agnibala</th><th style="text-align:left;padding:2px 6px">Test dose</th><th style="text-align:left;padding:2px 0">Max dose</th></tr></thead>
            ${snehaOptions.map(d => `<tr><td style="padding:2px 6px 2px 0;text-transform:capitalize">${_esc(d.agnibala)}</td><td style="padding:2px 6px">${d.secondary_dose_min}-${d.secondary_dose_max}${_esc(d.unit)}</td><td style="padding:2px 0">${d.dose_min}-${d.dose_max}${_esc(d.unit)}</td></tr>`).join('')}
          </table>
          <div style="font-size:10px;color:var(--text-muted);margin-top:3px">Pediatric Snehapana dose is Agnibala-dependent, not the flat adult Koshtha default the panel below auto-fills — set the start dose manually from this table.</div>
        </details>` : ''}

        ${atiyogaOptions.length ? `
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">🚑 Atiyoga (over-purgation) rescue-medicine doses by age — safety reference</summary>
          <table style="width:100%;font-size:10.5px;margin-top:4px;border-collapse:collapse">
            ${atiyogaOptions.map(d => `<tr><td style="padding:2px 6px 2px 0">${_esc(d.drug_name)}</td><td style="padding:2px 6px;color:var(--text-mid)">${_esc(d.age_band_label)}</td><td style="padding:2px 0;color:var(--text-mid)">${d.dose_min === d.dose_max ? d.dose_min : `${d.dose_min}-${d.dose_max}`}${_esc(d.unit)}</td></tr>`).join('')}
          </table>
        </details>` : ''}

        ${narrative?.contraindications ? `
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">⚠ Pediatric-specific contraindications — tap to review</summary>
          <div style="font-size:10.5px;color:var(--text-mid);margin-top:4px">${_esc(narrative.contraindications)}</div>
        </details>` : ''}

        <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;margin-bottom:6px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_guardian_consent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_guardian_consent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Written informed consent obtained from parent/guardian</strong> — required before this plan can be saved.</span>
          </label>
          ${assentApplicable ? `
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_assent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_assent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Verbal/written assent obtained from the child</strong> — required before this plan can be saved.</span>
          </label>` : `
          <div style="font-size:10.5px;color:var(--text-muted)">Child assent: not applicable at this age (under ${_PK_PEDIATRIC_ASSENT_MIN_AGE} years) — guardian consent alone governs.</div>`}
        </div>
      </div>`;
}

// Session 287 follow-up -- Dr. Venkatesh: the Virechana Dravya reference table in
// Step 2 was read-only; the doctor still had to re-type the medicine name and figure
// the dose from memory in Step 3's free-text Ingredients row. This turns that
// reference into an actual picker on the "Virechana administration" block itself --
// selecting a drug auto-fills the name + a Shuddhi-tier-aware suggested dose into the
// existing name/qty/unit fields (still requires the doctor's own "+ Add" click to
// commit it, same as every other ingredient entry -- nothing is silently added).
// Scoped tightly to pediatric patients on the Virechana administration activity only
// -- every other block/procedure keeps its plain free-text entry unchanged.
function _pkRenderVirechanaDravyaPicker(p, pi, b, bi) {
  if (!(_pkIsPediatricPatient() && p.procedure_key === 'virechana' && b.activity_label === 'Virechana administration')) return '';
  const options = _pkDrugDosesFor('virechana', 'virechana_dravya', _pkPatientAgeYears());
  if (!options.length) return '';
  return `
    <div class="field" style="margin-bottom:8px">
      <label style="font-size:11px">🧒 Select a pediatric Virechana Dravya (age-appropriate options, auto-fills dose below)</label>
      <select data-onchange="_pkSelectVirechanaDravya" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="@value">
        <option value="">— Choose a medicine —</option>
        ${options.map(d => `<option value="${d.id}">${_esc(d.drug_name)} (${d.dose_min === d.dose_max ? d.dose_min : `${d.dose_min}-${d.dose_max}`}${_esc(d.unit)})</option>`).join('')}
      </select>
    </div>`;
}

window._pkSelectVirechanaDravya = function(pi, bi, drugDoseId) {
  if (!drugDoseId) return;
  const d = _pkPediatricDrugDoses.find(x => x.id === drugDoseId);
  if (!d) return;
  const p = _pkProtocols[Number(pi)];
  const nameInp = document.getElementById(`pk-med-name-${pi}-${bi}`);
  const qtyInp = document.getElementById(`pk-med-qty-${pi}-${bi}`);
  const unitSel = document.getElementById(`pk-med-unit-${pi}-${bi}`);
  if (nameInp) nameInp.value = d.drug_name;
  // Suggested dose leans on the Shuddhi tier already assessed in Step 2 -- Uttam
  // (full dose) suggests the range's upper bound, Hina (minimal dose only) the lower
  // bound, Madhyama (or not yet assessed) the midpoint. Always doctor-editable before
  // the actual "+ Add" click -- this is a starting suggestion, not a silent decision.
  let qty = d.dose_min;
  if (d.dose_min != null && d.dose_max != null) {
    if (p?.pediatric_shuddhi_tier === 'uttam') qty = d.dose_max;
    else if (p?.pediatric_shuddhi_tier !== 'hina') qty = Math.round(((d.dose_min + d.dose_max) / 2) * 100) / 100;
  }
  if (qtyInp) qtyInp.value = qty ?? '';
  if (unitSel) unitSel.value = d.unit || 'g';
};

// Session 288 -- pediatric Vamana panel. Same structure as Virechana's (age band,
// SAM/MAM hard-stop reusing the real growth_records check, Dravya reference,
// contraindications, consent/assent) -- deliberately NO Shuddhi-tier dropdown, since
// the document describes no equivalent pre-dose weight classification for Vamana
// (only BSA/palm-proportion guidance, too imprecise to encode as a clean formula);
// the suggested dose is just each drug's range midpoint instead. Adds one genuinely
// new piece Virechana didn't need: an explicit "Snehapana not recommended" note,
// since pediatric Vamana purvakarma differs from Virechana/Basti on this point.
function _pkRenderPediatricVamanaPanel(p, pi) {
  if (!_pkIsPediatricPatient()) return '';
  const ageYears = _pkPatientAgeYears();
  const ageBandLabel = p.pediatric_age_band || _pkVamanaAgeBandLabel(ageYears);
  const narrative = _pkPediatricNarrative['vamana'];
  const assentApplicable = ageYears >= _PK_PEDIATRIC_ASSENT_MIN_AGE;
  const growth = _pkGrowthLatestByPatient[_activePatient?.id];
  if (growth === undefined && _activePatient?.id) _pkLoadLatestGrowthRecord(_activePatient.id).then(() => _renderPkCalendar());
  const samMam = _pkGrowthIsSamMam(growth);
  const dravyaOptions = _pkDrugDosesFor('vamana', 'vamana_dravya', ageYears);

  return `
      <div style="border:2px solid var(--purple);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fdf5fb">
        <div style="font-weight:700;font-size:12.5px;color:var(--purple);margin-bottom:8px">🧒 Pediatric Vamana — patient is ${_esc(String(ageYears))} years old</div>
        ${ageBandLabel ? `<div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">${_esc(ageBandLabel)}</div>` : ''}

        <div style="background:#fff8e1;border:1px solid #e6c200;border-radius:5px;padding:7px 10px;font-size:11.5px;color:#6b4c00;margin-bottom:8px">
          ℹ️ Snehapana is <strong>not recommended</strong> as Vamana purvakarma for children — they're considered already-oleated via their milk/ghee-predominant diet. If this protocol's calendar includes a Snehapana block, consider marking it Skip/Home for this patient rather than administering it as for an adult.
        </div>

        ${growth === undefined ? `
        <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:8px">Checking weight-for-age from the patient's Growth Record…</div>` : growth === null ? `
        <div style="background:#fff8e1;border:1px solid #e6c200;border-radius:5px;padding:7px 10px;font-size:11.5px;color:#6b4c00;margin-bottom:8px">
          ⚠ No Growth Record on file. A poorly-nourished (SAM/MAM) child is contraindicated for Vamana per the document — record a Growth Record (History tab) before finalizing this plan.
        </div>` : samMam ? `
        <div style="background:#fff3f3;border:2px solid var(--red);border-radius:5px;padding:8px 10px;font-size:11.5px;color:#7a1a1a;margin-bottom:8px;font-weight:600">
          🚫 CONTRAINDICATED: this patient's latest Growth Record (${new Date(growth.recorded_at+'T00:00').toLocaleDateString('en-IN')}) shows ${_esc(growth.weight_percentile_band)} weight-for-age — ${growth.weight_percentile_band === '<3rd' ? 'Severe Acute Malnutrition (SAM)' : 'Moderate Acute Malnutrition (MAM)'}. A poorly-nourished child is contraindicated for Vamana. This plan cannot be saved while Vamana is selected for this patient.
        </div>` : `
        <div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">✓ Latest Growth Record (${new Date(growth.recorded_at+'T00:00').toLocaleDateString('en-IN')}): weight-for-age ${_esc(growth.weight_percentile_band || '—')} — not SAM/MAM.</div>`}

        ${dravyaOptions.length ? `
        <details style="margin-bottom:8px" open>
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">💊 Vamana Dravya options for classical Vamana — reference for the medicine entry in Step 3</summary>
          <table style="width:100%;font-size:10.5px;margin-top:4px;border-collapse:collapse">
            ${dravyaOptions.map(d => `<tr><td style="padding:2px 6px 2px 0">${_esc(d.drug_name)}</td><td style="padding:2px 6px;color:var(--text-mid)">${d.dose_min == null ? _esc(d.unit) : (d.dose_min === d.dose_max ? d.dose_min : `${d.dose_min}-${d.dose_max}`) + _esc(d.unit === 'q.s.' ? '' : d.unit)}</td><td style="padding:2px 0;color:var(--text-muted)">${_esc(d.notes || '')}</td></tr>`).join('')}
          </table>
          <div style="font-size:10px;color:var(--text-muted);margin-top:3px">For Sadyo-Vamana (infants/toddlers/pre-schoolers), this table doesn't directly apply — dose is customized per child, not from this fixed reference.</div>
        </details>` : ''}

        ${narrative?.contraindications ? `
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">⚠ Pediatric-specific contraindications — tap to review</summary>
          <div style="font-size:10.5px;color:var(--text-mid);margin-top:4px">${_esc(narrative.contraindications)}</div>
        </details>` : ''}

        <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;margin-bottom:6px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_guardian_consent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_guardian_consent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Written informed consent obtained from parent/guardian</strong> — required before this plan can be saved.</span>
          </label>
          ${assentApplicable ? `
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_assent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_assent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Verbal/written assent obtained from the child</strong> — required before this plan can be saved.</span>
          </label>` : `
          <div style="font-size:10.5px;color:var(--text-muted)">Child assent: not applicable at this age (under ${_PK_PEDIATRIC_ASSENT_MIN_AGE} years) — guardian consent alone governs.</div>`}
        </div>
      </div>`;
}

// Session 288 -- same picker pattern as Virechana's, scoped to Vamana's own
// "Vamana administration" activity block. No Shuddhi-tier-aware branching (Vamana
// has none) -- suggested dose is just the range midpoint, or blank for Madhu (q.s.,
// no fixed dose — the doctor decides that one entirely).
function _pkRenderVamanaDravyaPicker(p, pi, b, bi) {
  if (!(_pkIsPediatricPatient() && p.procedure_key === 'vamana' && b.activity_label === 'Vamana administration')) return '';
  const options = _pkDrugDosesFor('vamana', 'vamana_dravya', _pkPatientAgeYears());
  if (!options.length) return '';
  return `
    <div class="field" style="margin-bottom:8px">
      <label style="font-size:11px">🧒 Select a pediatric Vamana Dravya (age-appropriate options, auto-fills dose below)</label>
      <select data-onchange="_pkSelectVamanaDravya" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="@value">
        <option value="">— Choose a medicine —</option>
        ${options.map(d => `<option value="${d.id}">${_esc(d.drug_name)} (${d.dose_min == null ? 'q.s.' : (d.dose_min === d.dose_max ? d.dose_min : `${d.dose_min}-${d.dose_max}`) + _esc(d.unit)})</option>`).join('')}
      </select>
    </div>`;
}

window._pkSelectVamanaDravya = function(pi, bi, drugDoseId) {
  if (!drugDoseId) return;
  const d = _pkPediatricDrugDoses.find(x => x.id === drugDoseId);
  if (!d) return;
  const nameInp = document.getElementById(`pk-med-name-${pi}-${bi}`);
  const qtyInp = document.getElementById(`pk-med-qty-${pi}-${bi}`);
  const unitSel = document.getElementById(`pk-med-unit-${pi}-${bi}`);
  if (nameInp) nameInp.value = d.drug_name;
  if (d.dose_min == null) {
    // Madhu (q.s.) -- no fixed dose to suggest, leave qty blank for the doctor.
    if (qtyInp) qtyInp.value = '';
  } else {
    const qty = d.dose_min === d.dose_max ? d.dose_min : Math.round(((d.dose_min + d.dose_max) / 2) * 100) / 100;
    if (qtyInp) qtyInp.value = qty;
    if (unitSel) unitSel.value = d.unit || 'g';
  }
};

// Session 289 -- pediatric Nasya panel. Same age-band/SAM-MAM/contraindications/
// consent-assent structure as Virechana/Vamana's panels, but the dosing reference is
// genuinely two separate tables (Bindu count by Nasya-type/tier, and ml-per-Bindu by
// substance/age) rather than one flat drug-dose table -- shown as two distinct
// reference sections rather than forced into one.
function _pkRenderPediatricNasyaPanel(p, pi) {
  if (!_pkIsPediatricPatient()) return '';
  const ageYears = _pkPatientAgeYears();
  const ageBandLabel = p.pediatric_age_band || _pkNasyaAgeBandLabel(ageYears);
  const narrative = _pkPediatricNarrative['nasya'];
  const assentApplicable = ageYears >= _PK_PEDIATRIC_ASSENT_MIN_AGE;
  const growth = _pkGrowthLatestByPatient[_activePatient?.id];
  if (growth === undefined && _activePatient?.id) _pkLoadLatestGrowthRecord(_activePatient.id).then(() => _renderPkCalendar());
  const samMam = _pkGrowthIsSamMam(growth);
  const binduCounts = _pkPediatricDrugDoses.filter(d => d.procedure_key === 'nasya' && d.usage_context === 'nasya_bindu_count');
  const binduMl = _pkDrugDosesFor('nasya', 'nasya_bindu_ml', ageYears);

  return `
      <div style="border:2px solid var(--purple);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fdf5fb">
        <div style="font-weight:700;font-size:12.5px;color:var(--purple);margin-bottom:8px">🧒 Pediatric Nasya — patient is ${_esc(String(ageYears))} years old</div>
        ${ageBandLabel ? `<div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">${_esc(ageBandLabel)}</div>` : ''}

        ${growth === undefined ? `
        <div style="font-size:10.5px;color:var(--text-muted);margin-bottom:8px">Checking weight-for-age from the patient's Growth Record…</div>` : growth === null ? `
        <div style="background:#fff8e1;border:1px solid #e6c200;border-radius:5px;padding:7px 10px;font-size:11.5px;color:#6b4c00;margin-bottom:8px">
          ⚠ No Growth Record on file. Severe malnutrition (Apatarpita/SAM/MAM) is a Nasya contraindication per the document — record a Growth Record (History tab) before finalizing this plan.
        </div>` : samMam ? `
        <div style="background:#fff3f3;border:2px solid var(--red);border-radius:5px;padding:8px 10px;font-size:11.5px;color:#7a1a1a;margin-bottom:8px;font-weight:600">
          🚫 CONTRAINDICATED: this patient's latest Growth Record (${new Date(growth.recorded_at+'T00:00').toLocaleDateString('en-IN')}) shows ${_esc(growth.weight_percentile_band)} weight-for-age — ${growth.weight_percentile_band === '<3rd' ? 'Severe Acute Malnutrition (SAM)' : 'Moderate Acute Malnutrition (MAM)'}. Nasya is contraindicated for a severely malnourished child. This plan cannot be saved while Nasya is selected for this patient.
        </div>` : `
        <div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">✓ Latest Growth Record (${new Date(growth.recorded_at+'T00:00').toLocaleDateString('en-IN')}): weight-for-age ${_esc(growth.weight_percentile_band || '—')} — not SAM/MAM.</div>`}

        ${binduCounts.length ? `
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">📏 Bindu (drop) count by Nasya type &amp; tier — reference (Table 8)</summary>
          <table style="width:100%;font-size:10.5px;margin-top:4px;border-collapse:collapse">
            ${binduCounts.map(d => `<tr><td style="padding:2px 6px 2px 0">${_esc(d.drug_name)}</td><td style="padding:2px 6px;color:var(--text-mid)">${d.dose_min} ${_esc(d.unit)}</td><td style="padding:2px 0;color:var(--text-muted)">${_esc(d.age_band_label)}${d.notes ? ' — ' + _esc(d.notes) : ''}</td></tr>`).join('')}
          </table>
          <div style="font-size:10px;color:var(--text-muted);margin-top:3px">Total dose = Bindu count × ml-per-Bindu (below, for the chosen substance and this patient's age). Pratimarsha is auto-computed in Step 3 since its count never changes by tier; for Marsha/others, multiply manually.</div>
        </details>` : ''}

        ${binduMl.length ? `
        <details style="margin-bottom:8px" open>
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">💧 ml per single Bindu, this age band — reference for the medicine entry in Step 3</summary>
          <table style="width:100%;font-size:10.5px;margin-top:4px;border-collapse:collapse">
            ${binduMl.map(d => `<tr><td style="padding:2px 6px 2px 0">${_esc(d.drug_name)}</td><td style="padding:2px 0;color:var(--text-mid)">${d.dose_min === d.dose_max ? d.dose_min : `${d.dose_min}-${d.dose_max}`} ${_esc(d.unit)}</td></tr>`).join('')}
          </table>
        </details>` : ''}

        ${narrative?.contraindications ? `
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">⚠ Pediatric-specific contraindications — tap to review</summary>
          <div style="font-size:10.5px;color:var(--text-mid);margin-top:4px">${_esc(narrative.contraindications)}</div>
        </details>` : ''}

        <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;margin-bottom:6px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_guardian_consent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_guardian_consent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Written informed consent obtained from parent/guardian</strong> — required before this plan can be saved.</span>
          </label>
          ${assentApplicable ? `
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_assent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_assent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Verbal/written assent obtained from the child</strong> — required before this plan can be saved.</span>
          </label>` : `
          <div style="font-size:10.5px;color:var(--text-muted)">Child assent: not applicable at this age (under ${_PK_PEDIATRIC_ASSENT_MIN_AGE} years) — guardian consent alone governs.</div>`}
        </div>
      </div>`;
}

// Session 289 -- one-click Pratimarsha Nasya picker: auto-computes total ml =
// 2 Bindu (fixed across all tiers, per Table 8) x this age band's ml-per-Bindu for
// the chosen substance. Scoped to the "Nasya administration (daily)" block.
const _PK_PRATIMARSHA_BINDU_COUNT = 2;
function _pkRenderNasyaSubstancePicker(p, pi, b, bi) {
  if (!(_pkIsPediatricPatient() && p.procedure_key === 'nasya' && b.activity_label === 'Nasya administration (daily)')) return '';
  const options = _pkDrugDosesFor('nasya', 'nasya_bindu_ml', _pkPatientAgeYears());
  if (!options.length) return '';
  return `
    <div class="field" style="margin-bottom:8px">
      <label style="font-size:11px">🧒 Select a substance for Pratimarsha Nasya (2 Bindu, age-appropriate — auto-fills total dose below)</label>
      <select data-onchange="_pkSelectNasyaSubstance" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="@value">
        <option value="">— Choose a substance —</option>
        ${options.map(d => `<option value="${d.id}">${_esc(d.drug_name)} (${d.dose_min === d.dose_max ? d.dose_min : `${d.dose_min}-${d.dose_max}`}ml per Bindu)</option>`).join('')}
      </select>
      <div style="font-size:10px;color:var(--text-muted);margin-top:3px">For Marsha Nasya (9yr+ only) instead, use the Bindu-count reference above and type the multiplied dose manually — its count varies by tier, unlike Pratimarsha's.</div>
    </div>`;
}

window._pkSelectNasyaSubstance = function(pi, bi, drugDoseId) {
  if (!drugDoseId) return;
  const d = _pkPediatricDrugDoses.find(x => x.id === drugDoseId);
  if (!d) return;
  const nameInp = document.getElementById(`pk-med-name-${pi}-${bi}`);
  const qtyInp = document.getElementById(`pk-med-qty-${pi}-${bi}`);
  const unitSel = document.getElementById(`pk-med-unit-${pi}-${bi}`);
  const perBindu = d.dose_min === d.dose_max ? d.dose_min : (d.dose_min + d.dose_max) / 2;
  const total = Math.round(perBindu * _PK_PRATIMARSHA_BINDU_COUNT * 1000) / 1000;
  if (nameInp) nameInp.value = `${d.drug_name} (Pratimarsha, ${_PK_PRATIMARSHA_BINDU_COUNT} Bindu)`;
  if (qtyInp) qtyInp.value = total;
  if (unitSel) unitSel.value = 'ml';
};

async function _loadPkFeeIndex() {
  const { data } = await supabase.from('fee_structures')
    .select('ayush_code,label,amount,gst_percent,promo_price,promo_valid_until')
    .eq('tenant_id', tenantId).eq('is_active', true).not('ayush_code', 'is', null);
  _pkFeeIndex = {};
  (data || []).forEach(r => { _pkFeeIndex[r.ayush_code] = r; });
}

// Session 278 -- classical Pancha Karma teaching order (Dr. Venkatesh), not alphabetical.
const _PK_MAIN_KARMA_ORDER = ['vamana', 'virechana', 'basti', 'nasya', 'raktamokshana'];
// Live filter term for the 79-item Other Therapies list -- set by _pkFilterOtherTherapies(),
// read fresh on every render, never persisted (resets with the rest of the wizard).
let _pkOtherSearchTerm = '';

function _renderPkChips() {
  const mainEl  = document.getElementById('pk-chips-main');
  const otherEl = document.getElementById('pk-chips-other');
  if (!mainEl || !otherEl) return;
  const chipHtml = (t, idx) => {
    const hint = _pkContentHints[t.id];
    const hintParts = [];
    if (hint?.typical_duration_minutes) hintParts.push(hint.typical_duration_minutes >= 60
      ? `${Math.round(hint.typical_duration_minutes / 60 * 10) / 10}h` : `${hint.typical_duration_minutes}m`);
    if (hint?.man_power_staff) hintParts.push(`${hint.man_power_staff}👤`);
    const hintHtml = hintParts.length ? `<span class="chip-hint"> · ${hintParts.join(' · ')}</span>` : '';
    const isOn = _pkProtocols.some(p => p.procedure_key === t.procedure_key);
    // Session 278 -- "using 2 colors alternatively makes it look good": alternating
    // unselected-state border/tint between the two brand tokens, by visible position (not
    // DB order, so it stays a clean zebra pattern even after the search box narrows the
    // list).
    // Session 279 fix -- that alternating tint reused --green-mid for half the chips,
    // which is the exact color the shared .chip.on CSS class already used for
    // "selected" -- an inline style always wins over a class rule, so once a chip had
    // this inline style there was literally no way for .chip.on to ever show through,
    // for ANY chip, selected or not (not just a subtle color collision on the green
    // half). Selected chips now get their own explicit solid-fill inline style instead
    // -- same "filled = selected" language already used by the Pack Type/Schedule
    // Mode/Room buttons just below in this same wizard -- plus a ✓ prefix so selection
    // never depends on color alone.
    const altColor = idx % 2 === 0 ? 'var(--green-mid)' : 'var(--gold)';
    const styleAttr = isOn
      ? ` style="border-color:var(--green-deep);background:var(--green-deep);color:#fff;font-weight:600"`
      : ` style="border-color:${altColor};background:color-mix(in srgb, ${altColor} 8%, #fff);color:${altColor}"`;
    return `<span class="chip${isOn ? ' on' : ''}"${styleAttr} data-onclick="_pkToggleProtocol" data-onclick-a0="${_esc(t.procedure_key)}" data-onclick-a1="@this">${isOn ? '✓ ' : ''}${_esc(t.display_name)}${!t.is_reviewed ? ' ⚠' : ''}${hintHtml}</span>`;
  };

  const mainSorted = _pkTemplates.filter(t => t.phase_group === 'main_karma')
    .sort((a, b) => _PK_MAIN_KARMA_ORDER.indexOf(a.procedure_key) - _PK_MAIN_KARMA_ORDER.indexOf(b.procedure_key));
  mainEl.innerHTML = mainSorted.map(chipHtml).join('');

  // Session 278 -- Dr. Venkatesh explicitly rejected sub-grouping the 79-item Other
  // Therapies list ("group other therapies is not a good idea") -- stays one flat list,
  // just filterable by the search box above it (data-oninput, starts filtering from the
  // very first keystroke).
  const otherAll = _pkTemplates.filter(t => t.phase_group === 'other_therapy');
  const term = _pkOtherSearchTerm.trim().toLowerCase();
  const otherFiltered = term ? otherAll.filter(t => t.display_name.toLowerCase().includes(term)) : otherAll;
  otherEl.innerHTML = otherFiltered.length
    ? otherFiltered.map(chipHtml).join('')
    : `<div style="font-size:12px;color:var(--text-muted);padding:6px 2px">No therapies match "${_esc(_pkOtherSearchTerm)}".</div>`;
}

window._pkFilterOtherTherapies = function(inputEl) {
  _pkOtherSearchTerm = inputEl.value || '';
  _renderPkChips();
};

// Session 266 -- Basti Pack Type: doctor picks one of 3 classical multi-day package
// configurations (Charaka's Karma/Kala/Yoga Basti), the day-by-day Anuvasana(Oil)/
// Niruha(Decoction) rotation auto-populates the calendar. Sequence + oil/decoc counts
// per Dr. Venkatesh's classical schedule matrix, verified internally consistent
// (len/oil/decoc all check out) before building against it.
const _PK_BASTI_PACK_TYPES = {
  karma: { label: 'Karma Basti (30 days — 18 Oil / 12 Decoction)', days: 30 },
  kala:  { label: 'Kala Basti (15 days — 9 Oil / 6 Decoction)',   days: 15 },
  yoga:  { label: 'Yoga Basti (8 days — 5 Oil / 3 Decoction)',    days: 8  },
};
const _PK_BASTI_SHORT_NAME = { karma: 'Karma Basti', kala: 'Kala Basti', yoga: 'Yoga Basti' };
// Session 267 -- Dr. Venkatesh: Anuvasana must always be after a meal (lunch/dinner),
// never empty stomach; Niruha must always be empty stomach, before breakfast. Baked
// directly into the saved activity_label (not a separate column) so the rule stays
// visible everywhere this label is read -- medicines section, any future nursing/
// therapist assignment screen, printouts -- without extra plumbing.
const _PK_BASTI_ANUVASANA_LABEL = 'Basti Administration — Anuvasana (Oil, after meal — never empty stomach)';
const _PK_BASTI_NIRUHA_LABEL    = 'Basti Administration — Niruha (Decoction, empty stomach before breakfast)';

// Session 267 -- Compressed (same-day) schedule: some hospitals give both a Niruha
// (morning, empty stomach) and an Anuvasana (evening, after the same day's meal) to
// roughly halve the hospital stay. One up-front choice for the whole course (not a
// per-day toggle). Day-count derivation confirmed correct: Day 1 is Anuvasana-only
// (admission day), then double-days consume oil+decoction together until the smaller
// total runs out, then any remaining oil closes the course as single-Anuvasana days --
// preserves the exact same classical oil/decoction totals, just compressed (Karma
// 30->21 total days, Kala 15->9, Yoga 8->5). Originally Karma/Kala only; Dr. Venkatesh
// confirmed Yoga should be offered too (Session 267 follow-up).
const _PK_BASTI_COMPRESSED_TOTALS = {
  karma: { oil: 18, decoc: 12 },
  kala:  { oil: 9,  decoc: 6  },
  yoga:  { oil: 5,  decoc: 3  },
};

function _pkBastiCompressedPlan(packType) {
  const t = _PK_BASTI_COMPRESSED_TOTALS[packType];
  if (!t) return [];
  const days = [{ anuvasana: true, niruha: false }]; // Day 1: admission, Anuvasana only
  let oilLeft = t.oil - 1, decocLeft = t.decoc;
  const doubleDays = Math.min(oilLeft, decocLeft);
  for (let i = 0; i < doubleDays; i++) days.push({ anuvasana: true, niruha: true });
  oilLeft -= doubleDays;
  for (let i = 0; i < oilLeft; i++) days.push({ anuvasana: true, niruha: false });
  return days;
}

// Unified day-by-day plan for whichever mode is active -- one entry per CALENDAR day
// (not per administration), each flagging which of Anuvasana/Niruha happen that day.
// Standard mode: exactly one is ever true per day (the classical rotation). Compressed
// mode: some days have both true.
function _pkBastiDayPlan(p) {
  if (!p.basti_pack_type) return [];
  if (p.basti_schedule_mode === 'compressed') return _pkBastiCompressedPlan(p.basti_pack_type);
  return _pkBastiRotation(p.basti_pack_type).map(t => ({ anuvasana: t === 'anuvasana', niruha: t === 'niruha' }));
}

function _pkBastiRotation(packType) {
  // 'O' = Anuvasana (Oil), 'D' = Niruha (Decoction). Each pattern is 1 Oil, then an
  // alternating middle run, then a fixed closing run of Oil days -- per the classical
  // schedule matrix. Kept as one small table rather than a formula since each pack's
  // closing-run length differs (5/3/1) and isn't derivable from the others.
  const table = {
    karma: { openOil: 1, altDays: 24, closeOil: 5 }, // alt starts D,O,D,O...
    kala:  { openOil: 1, altDays: 11, closeOil: 3 },
    yoga:  { openOil: 1, altDays: 6,  closeOil: 1 },
  };
  const t = table[packType];
  if (!t) return [];
  const seq = ['anuvasana'];
  for (let i = 0; i < t.altDays; i++) seq.push(i % 2 === 0 ? 'niruha' : 'anuvasana');
  for (let i = 0; i < t.closeOil; i++) seq.push('anuvasana');
  return seq;
}

window._pkToggleProtocol = function(procedureKey, chipEl) {
  const idx = _pkProtocols.findIndex(p => p.procedure_key === procedureKey);
  if (idx >= 0) {
    // Session 268 -- a protocol loaded from an existing saved plan (db_id set) can't be
    // removed via the chip -- that's a bigger "delete this protocol" decision, out of
    // scope for now (see _pkLoadExistingDraft()'s comment). Chips only add new ones here.
    if (_pkProtocols[idx].db_id) { alert('This protocol is already part of the saved plan and can\'t be removed here.'); return; }
    _pkProtocols.splice(idx, 1);
    // Session 279 fix -- toggling just the 'on' class here left the chip's own
    // inline style (set at render time, see _renderPkChips) untouched, and an
    // inline style always beats a class rule -- so the chip never visually
    // reverted. A full re-render regenerates the correct inline style for every
    // chip's new state, not just this one's class.
    _renderPkChips();
    return;
  }
  const tpl = _pkTemplates.find(t => t.procedure_key === procedureKey);
  if (!tpl) return;
  const days = (_pkTemplateDays[tpl.id] || []).slice().sort((a, b) => a.sequence_order - b.sequence_order);
  _pkProtocols.push({
    template_id: tpl.id,
    procedure_key: tpl.procedure_key,
    protocol_label: tpl.display_name,
    is_reviewed: tpl.is_reviewed,
    start_date: new Date().toLocaleDateString('en-CA'),
    // Cloned into an editable per-patient copy -- editing this plan never touches
    // the template, same "clone don't link" pattern nursing-roster-template.html uses.
    // Session 254 -- medicines live per-activity (block), not one flat list for the
    // whole course: Dr. Venkatesh confirmed the doctor needs to name, e.g., a
    // different medicine for Deepana-Pachana vs. the Snehapana oil vs. the Virechana
    // purgative itself, all within one protocol.
    // Session 257 -- mode defaults to 'hospital' for every block; only the prep/post-
    // care blocks (Deepana-Pachana, Samsarjana Krama -- see _PK_TOGGLEABLE_ACTIVITIES)
    // ever render a toggle to change it. Confirmed live by Dr. Venkatesh: never for
    // Abhyanga+Sweda or the main procedure itself -- those always happen in hospital.
    // Session 266 -- Basti's single generic "Basti administration (daily)" template day
    // is replaced with two blocks (Anuvasana/Niruha), length 0 until a pack type is
    // chosen -- _pkExpandDays() interleaves them per the classical rotation instead of
    // placing them as two separate contiguous day-ranges.
    blocks: days.flatMap(d => {
      if (tpl.procedure_key === 'basti' && d.activity_label === 'Basti administration (daily)') {
        return [
          { phase: d.phase, activity_label: _PK_BASTI_ANUVASANA_LABEL, is_flexible: false,
            min_days: 0, max_days: 0, length: 0, ayush_code: null, medicines: [], mode: 'hospital', bastiDayType: 'anuvasana' },
          // Session 271 -- Niruha is a 5-part compound formulation (Madhu/Lavana/
          // Sneha/Kalka/Kwatha), not a flat medicines list -- b.medicines stays
          // unused for this block; b.niruhaFormula holds the structured recipe
          // instead (one formula for the whole course, every field editable).
          // Session 279 -- each classical component now holds a LIST of medicines
          // (Kalka/Kwatha in particular are classically multi-herb), plus an
          // optional formula_name and any extra custom-labeled components beyond
          // the classical 6 -- see _pkNewNiruhaFormula().
          { phase: d.phase, activity_label: _PK_BASTI_NIRUHA_LABEL, is_flexible: false,
            min_days: 0, max_days: 0, length: 0, ayush_code: null, medicines: [], mode: 'hospital', bastiDayType: 'niruha',
            niruhaFormula: _pkNewNiruhaFormula() },
        ];
      }
      return [{
        phase: d.phase, activity_label: d.activity_label, is_flexible: d.is_flexible,
        min_days: d.min_days, max_days: d.max_days, length: (d.day_end - d.day_start + 1),
        ayush_code: d.ayush_code, medicines: [], mode: 'hospital',
      }];
    }),
    // Session 255 -- Koshtha + Snehapana dosing, only meaningful for a protocol whose
    // days actually include Snehapana (PCK54). koshtha starts unset (doctor must
    // actively assess it, not a silent default); snehapana_increment_ml defaults to
    // the classical 30ml/day step Dr. Venkatesh described, editable.
    koshtha: null,
    snehapana_start_dose_ml: null,
    snehapana_increment_ml: 30,
    // Session 281 -- doctor-typed specific formula/variant name for a protocol with no
    // platform SOP content (e.g. "Eranda Patra Pinda Sweda" under the "Patra Pinda Sweda"
    // protocol) -- same idea as Niruha's own formula_name, just for every other no-SOP
    // protocol instead of only Basti. Null until the doctor types one.
    custom_formulation_name: null,
    // Session 266 -- unset until the doctor picks one of the 3 classical pack types;
    // only meaningful for procedure_key === 'basti'.
    basti_pack_type: null,
    // Session 267 -- 'standard' (classical 1/day rotation) or 'compressed' (same-day
    // Niruha+Anuvasana, offered for all 3 pack types); defaults to 'standard'.
    basti_schedule_mode: 'standard',
    // Session 268 -- null means "not yet saved anywhere"; set to the real
    // pk_care_plan_protocols.id once this protocol has been persisted (either by a
    // normal save, or because it was reconstructed from an existing draft plan).
    db_id: null,
    // Session 277 -- mandatory doctor-entered duration/man-power/room-requirement for
    // any protocol with no sop_content_templates hint (see _pkNeedsManualScheduleInput()).
    // Starts blank so the wizard genuinely requires an explicit entry, not a silent
    // guess; doctor_requires_room defaults true (the common case) but is still an
    // explicit stored value, never left unset.
    doctor_duration_minutes: null,
    doctor_man_power: null,
    doctor_requires_room: true,
    // Session 285 -- pediatric Basti dosing + consent/assent. Only ever populated
    // when procedure_key === 'basti' AND the patient is under 18 (_pkIsPediatricPatient())
    // -- stays fully null/false and renders nothing for every adult patient and every
    // non-Basti protocol, same additive-only discipline as koshtha/snehapana_* above.
    pediatric_age_band: null,
    pediatric_dose_ml: null,
    pediatric_guardian_consent_obtained: false,
    pediatric_assent_obtained: false,
    // Session 287 -- Virechana-only (null/unused for every other protocol, same
    // additive discipline): doctor-asserted weight-for-age Shuddhi dose tier.
    pediatric_shuddhi_tier: null,
  });
  // Session 285 -- auto-resolve the age band + suggested dose the moment a Basti
  // protocol is added for a pediatric patient, same "pre-fill, stay doctor-editable"
  // pattern _pkSetKoshtha() uses for Snehapana's starting dose.
  if (procedureKey === 'basti' && _pkIsPediatricPatient()) {
    const newP = _pkProtocols[_pkProtocols.length - 1];
    const ageYears = _pkPatientAgeYears();
    const band = _pkResolvePediatricDoseBand(ageYears);
    if (band) {
      newP.pediatric_age_band = band.band_label;
      newP.pediatric_dose_ml = band.dose_ml;
    }
    // Session 285 follow-up -- same auto-fill, applied to the Niruha block's 6
    // classical components (Madhu/Lavana/Sneha/Kalka/Kwatha/Avapa), not just the
    // single reference total above.
    const niruhaBlock = newP.blocks.find(b => b.bastiDayType === 'niruha');
    if (niruhaBlock?.niruhaFormula) _pkApplyPediatricNiruhaDoses(niruhaBlock.niruhaFormula);
  }
  // Session 287 -- same age-band auto-resolve for Virechana, plus a fire-and-forget
  // fetch of the patient's latest growth record (async -- re-renders Step 2 once it
  // resolves) so the SAM/MAM weight-for-age hard stop has real data to check against
  // the moment the panel first appears, not only after the doctor happens to open the
  // Growth Record tab first.
  if (procedureKey === 'virechana' && _pkIsPediatricPatient()) {
    const newP = _pkProtocols[_pkProtocols.length - 1];
    newP.pediatric_age_band = _pkVirechanaAgeBandLabel(_pkPatientAgeYears());
    _pkLoadLatestGrowthRecord(_activePatient.id).then(() => _renderPkCalendar());
  }
  // Session 288 -- same pattern for Vamana.
  if (procedureKey === 'vamana' && _pkIsPediatricPatient()) {
    const newP = _pkProtocols[_pkProtocols.length - 1];
    newP.pediatric_age_band = _pkVamanaAgeBandLabel(_pkPatientAgeYears());
    _pkLoadLatestGrowthRecord(_activePatient.id).then(() => _renderPkCalendar());
  }
  // Session 289 -- same pattern for Nasya.
  if (procedureKey === 'nasya' && _pkIsPediatricPatient()) {
    const newP = _pkProtocols[_pkProtocols.length - 1];
    newP.pediatric_age_band = _pkNasyaAgeBandLabel(_pkPatientAgeYears());
    _pkLoadLatestGrowthRecord(_activePatient.id).then(() => _renderPkCalendar());
  }
  // Session 279 fix -- see the matching comment on the removal branch above; a
  // full re-render is what actually applies the selected-state inline style.
  _renderPkChips();

  // Session 269 -- for a protocol that doesn't need a Basti-style pack-type/schedule
  // step first, the calendar for picking its start date can appear right away; Basti's
  // own equivalent trigger is _pkSetBastiScheduleMode() once Standard/Compressed is
  // chosen (its day-plan is empty/meaningless before that).
  if (procedureKey !== 'basti') {
    const newIdx = _pkProtocols.length - 1;
    const d = new Date(_pkProtocols[newIdx].start_date + 'T00:00:00');
    _pkDatePickerOpenFor = newIdx;
    _pkDatePickerMonth[newIdx] = { y: d.getFullYear(), m: d.getMonth() };
  }
};

function _pkRecomputeBastiBlockLengths(p) {
  const plan = _pkBastiDayPlan(p);
  const oilBlock   = p.blocks.find(b => b.bastiDayType === 'anuvasana');
  const decocBlock = p.blocks.find(b => b.bastiDayType === 'niruha');
  if (oilBlock)   oilBlock.length   = plan.filter(d => d.anuvasana).length;
  if (decocBlock) decocBlock.length = plan.filter(d => d.niruha).length;
}

window._pkSetBastiPackType = function(pi, packType) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  p.basti_pack_type = packType || null;
  // Compressed is only ever offered for Karma/Kala -- reset to standard if the doctor
  // switches to Yoga (or unpicks) while Compressed was active.
  if (p.basti_schedule_mode === 'compressed' && !_PK_BASTI_COMPRESSED_TOTALS[packType]) {
    p.basti_schedule_mode = 'standard';
  }
  _pkRecomputeBastiBlockLengths(p);
  _renderPkCalendar();
};

window._pkSetBastiScheduleMode = function(pi, mode) {
  pi = Number(pi);
  const p = _pkProtocols[pi]; if (!p) return;
  if (mode === 'compressed' && !_PK_BASTI_COMPRESSED_TOTALS[p.basti_pack_type]) return; // no pack type chosen yet
  p.basti_schedule_mode = mode;
  _pkRecomputeBastiBlockLengths(p);
  // Session 269 -- Dr. Venkatesh: once Standard/Compressed is chosen, the calendar for
  // picking the actual start date should appear right away, not need a separate click.
  const d = new Date((p.start_date || todayLocalStr()) + 'T00:00:00');
  _pkDatePickerOpenFor = pi;
  _pkDatePickerMonth[pi] = { y: d.getFullYear(), m: d.getMonth() };
  _renderPkCalendar();
};

const _PK_KOSHTHA_DEFAULT_DOSE = { mridu: 25, madhyama: 45, krura: 55 };

window._pkSetKoshtha = function(pi, koshtha) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  p.koshtha = koshtha || null;
  // Session 287 -- _PK_KOSHTHA_DEFAULT_DOSE is adult-scale (25/45/55ml); auto-filling
  // it for a pediatric patient would silently understate what's still an adult dose
  // relative to a child. Left blank instead so the doctor sets it from the pediatric
  // Virechana panel's own Snehapana Agnibala reference table above.
  if (koshtha && !p.snehapana_start_dose_ml && !_pkIsPediatricPatient()) {
    p.snehapana_start_dose_ml = _PK_KOSHTHA_DEFAULT_DOSE[koshtha] || null;
  }
  _renderPkCalendar();
};

window._pkSetSnehaField = function(pi, field, inputEl) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  const v = Number(inputEl.value);
  p[field] = v > 0 ? v : null;
};

// Session 285 follow-up -- pediatric_dose_ml is now auto-set only (the reference
// band's total, at protocol-creation time) and shown read-only in Step 2; the real
// editable doses live per-ingredient in the Niruha formula card (Step 3) instead of
// a single aggregate field here. No setter needed any more.
window._pkTogglePediatricConsent = function(pi, field, checkboxEl) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  p[field] = !!checkboxEl.checked;
};

// Session 285 -- below this age, a child cannot meaningfully assent (per the NIA
// document's own age-group developmental justification -- Toddlers "limited
// communication skills to express issues"); guardian consent alone is required and
// the assent checkbox shows as not-applicable rather than blocking save. This
// threshold is a reasonable clinical default, not something stated as a fixed number
// anywhere in the source document -- flagged here for Dr. Venkatesh to adjust if the
// real cutoff his department uses differs.
const _PK_PEDIATRIC_ASSENT_MIN_AGE = 7;

function _pkRenderPediatricBastiPanel(p, pi) {
  if (!_pkIsPediatricPatient()) return '';
  const ageYears = _pkPatientAgeYears();
  const doseBand = _pkResolvePediatricDoseBand(ageYears);
  const equipBand = _pkResolvePediatricEquipmentBand(ageYears);
  const narrative = _pkPediatricNarrative['basti_niruha_administration'];
  const assentApplicable = ageYears >= _PK_PEDIATRIC_ASSENT_MIN_AGE;

  return `
      <div style="border:2px solid var(--purple);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fdf5fb">
        <div style="font-weight:700;font-size:12.5px;color:var(--purple);margin-bottom:8px">🧒 Pediatric Basti — patient is ${_esc(String(ageYears))} years old${doseBand ? ` (${_esc(doseBand.band_label)} band)` : ''}</div>

        ${!doseBand ? `
        <div style="background:#fff3f3;border:1px solid var(--red);border-radius:5px;padding:7px 10px;font-size:11.5px;color:#7a1a1a;margin-bottom:8px">
          ⚠ No age-band dose reference available below 1 year — the NIA document's own Basti Age Group section does not recommend classical Basti this young (Acharya opinion ranges from birth to 5-6 months to 1-3 years for the earliest safe age). Use extreme clinical caution; dose is entirely at your discretion if proceeding.
        </div>` : `
        <div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">
          Reference dose for this band (Yapana Basti Karma, age-wise) — Kashaya ${doseBand.kashaya_ml}ml · Sneha ${doseBand.sneha_ml}ml · Gomutra ${doseBand.gomutra_ml}ml · Saindhava ${doseBand.saindhava_g}g · Kalka ${doseBand.kalka_g}g · Madhu ${doseBand.madhu_ml}ml (total ${doseBand.dose_ml}ml). Auto-filled into the Niruha Madhu/Lavana/Sneha/Kalka/Kwatha/Avapa formula in Step 3 — edit the exact per-ingredient doses there, not here.
        </div>`}

        ${equipBand ? `
        <div style="font-size:11px;color:var(--text-dark);margin-bottom:8px">
          🔧 Basti Netra (catheter) reference: length ${equipBand.netra_length_cm}cm, base ${equipBand.netra_base_cm}cm, tip sized to ${_esc(equipBand.netra_tip_desc)} — never insert more than 6 inches (15cm) regardless of table value.
        </div>` : ''}

        ${narrative?.contraindications ? `
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;font-weight:600;color:var(--purple);cursor:pointer">⚠ Pediatric-specific contraindications — tap to review</summary>
          <div style="font-size:10.5px;color:var(--text-mid);margin-top:4px">${_esc(narrative.contraindications)}</div>
        </details>` : ''}

        <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;margin-bottom:6px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_guardian_consent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_guardian_consent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Written informed consent obtained from parent/guardian</strong> — required before this plan can be saved.</span>
          </label>
          ${assentApplicable ? `
          <label style="display:flex;align-items:flex-start;gap:6px;font-size:11.5px;cursor:pointer">
            <input type="checkbox" ${p.pediatric_assent_obtained ? 'checked' : ''}
              data-onchange="_pkTogglePediatricConsent" data-onchange-a0="${pi}" data-onchange-a1="pediatric_assent_obtained" data-onchange-a2="@this" style="margin-top:2px"/>
            <span><strong>Verbal/written assent obtained from the child</strong> — required before this plan can be saved.</span>
          </label>` : `
          <div style="font-size:10.5px;color:var(--text-muted)">Child assent: not applicable at this age (under ${_PK_PEDIATRIC_ASSENT_MIN_AGE} years) — guardian consent alone governs.</div>`}
        </div>
      </div>`;
}

// Session 257 -- Skip / Advise at home, scoped to exactly these two prep/post-care
// activities (confirmed live). Never for Abhyanga+Sweda or the main procedure --
// their own blocks simply never render the toggle at all (see _renderPkCalendar()).
const _PK_TOGGLEABLE_ACTIVITIES = ['Deepana-Pachana', 'Samsarjana Krama (graded diet)'];

window._pkSetBlockMode = function(pi, bi, mode) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  const b = p.blocks[Number(bi)]; if (!b) return;
  if (mode === 'skip') {
    if (b.mode !== 'skip') b._skipLength = b.length; // remember to restore later
    b.length = 0;
  } else if (b.mode === 'skip') {
    b.length = b._skipLength || b.min_days || 1;
  }
  b.mode = mode;
  _renderPkCalendar();
};

// Flat one-row-per-calendar-day expansion of a protocol's blocks, recomputed fresh
// every time (never stored mid-edit) -- this is what makes extending/reducing a
// flexible block automatically shift every later day, with zero separate "shift
// downstream days" logic needed.
function _pkExpandDays(p) {
  const rows = [];
  const base = new Date(p.start_date + 'T00:00:00');
  let dayNum = 1;
  const pushDay = (b) => {
    const d = new Date(base); d.setDate(d.getDate() + (dayNum - 1));
    rows.push({
      day_number: dayNum, phase: b.phase, activity_label: b.activity_label,
      is_flexible: b.is_flexible, planned_date: d.toLocaleDateString('en-CA'),
      ayush_code: b.ayush_code || null, sequence_order: dayNum,
      // Session 257 -- a skipped block already contributes zero rows here (the loop
      // just doesn't run for length=0), so only 'home' vs. 'hospital' ever needs
      // carrying through to the actual saved day rows.
      location_mode: b.mode === 'home' ? 'home' : 'hospital',
    });
  };
  p.blocks.forEach(b => {
    // Session 266/267 -- Basti's Anuvasana/Niruha pair are NOT two contiguous day-
    // ranges (that would be classically wrong -- the two interleave, and in Compressed
    // mode a single calendar day can carry BOTH). The pair is consumed together the
    // first time either is encountered (by day-plan order, that's always the Anuvasana
    // block, since the plan always opens on an Oil day); the Niruha block is then
    // skipped when the loop reaches it. dayNum advances once per CALENDAR day, not
    // once per pushed row -- a double-day pushes 2 rows sharing the same day_number.
    if (b.bastiDayType === 'anuvasana') {
      const niruha = p.blocks.find(x => x.bastiDayType === 'niruha');
      const plan = _pkBastiDayPlan(p);
      plan.forEach(entry => {
        if (entry.anuvasana) pushDay(b);
        if (entry.niruha) pushDay(niruha || b);
        dayNum++;
      });
      return;
    }
    if (b.bastiDayType === 'niruha') return; // already consumed as part of the pair above

    for (let i = 0; i < b.length; i++) { pushDay(b); dayNum++; }
  });
  return rows;
}

function _pkBlockDayRange(p, bi) {
  let offset = 1;
  for (let i = 0; i < bi; i++) offset += p.blocks[i].length;
  const b = p.blocks[bi];
  const startNum = offset, endNum = offset + b.length - 1;
  const base = new Date(p.start_date + 'T00:00:00');
  const d1 = new Date(base); d1.setDate(d1.getDate() + (startNum - 1));
  const d2 = new Date(base); d2.setDate(d2.getDate() + (endNum - 1));
  const fmt = d => d.toLocaleDateString('en-CA');
  return {
    label: startNum === endNum ? `Day ${startNum}` : `Day ${startNum}-${endNum}`,
    dateLabel: startNum === endNum ? fmt(d1) : `${fmt(d1)} to ${fmt(d2)}`,
  };
}

const _PK_PHASE_LABEL = { purvakarma: 'Purvakarma', pradhanakarma: 'Pradhanakarma', paschatkarma: 'Paschatkarma' };

// Session 270 -- Dr. Venkatesh: the day-as-column grid Basti already has (built
// Session 266) should be available for every protocol, not just Basti. Basti keeps
// its own bespoke renderer above (2 fixed activity types, Anu/Niru short labels,
// pack-type/schedule-mode heading, real interleaving) since it already works and
// touching it risks regressing something proven -- this is the generic version for
// everything else, driven purely by whatever activity labels _pkExpandDays(p)
// actually produces, in the order they first appear (matches the protocol's own
// block sequence, since _pkExpandDays already walks blocks in that order).
function _pkRenderGenericDayGrid(p) {
  const rows = _pkExpandDays(p);
  if (!rows.length) return '';

  const activityOrder = [];
  const byDayActivity = {}; // day_number -> Set(activity_label)
  rows.forEach(r => {
    if (!activityOrder.includes(r.activity_label)) activityOrder.push(r.activity_label);
    (byDayActivity[r.day_number] = byDayActivity[r.day_number] || new Set()).add(r.activity_label);
  });
  if (activityOrder.length < 2) return ''; // one activity for the whole course -- the day-range table above already says it plainly, a 1-row grid adds nothing

  const dayNumbers = [...new Set(rows.map(r => r.day_number))].sort((a, b) => a - b);
  const dateByDay = {};
  rows.forEach(r => { dateByDay[r.day_number] = r.planned_date; });

  const rowLabel = (label, title) => `<td title="${_esc(title || label)}" style="padding:5px 9px;font-weight:600;color:var(--text-mid);white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;position:sticky;left:0;background:#fafff7;border-right:1.5px solid var(--border);border-bottom:1px solid var(--border)">${_esc(label)}</td>`;
  const dayCell = (n) => `<td style="padding:5px 9px;text-align:center;border-left:1px solid var(--border);border-bottom:1px solid var(--border);white-space:nowrap;font-size:11px"><strong>Day ${n}</strong><br><span style="color:var(--text-muted);font-size:10px">${_esc(dateByDay[n])}</span></td>`;

  const activityRows = activityOrder.map((label, ai) => {
    const color = _PK_CAL_COLORS[ai % _PK_CAL_COLORS.length];
    const cells = dayNumbers.map(n => {
      const present = byDayActivity[n]?.has(label);
      return `<td style="padding:5px 9px;text-align:center;border-left:1px solid var(--border);border-bottom:1px solid var(--border)">${present ? `<span style="display:inline-block;width:18px;height:18px;border-radius:4px;background:${color};color:#fff;font-size:11px;font-weight:700;line-height:18px">✓</span>` : ''}</td>`;
    }).join('');
    return `<tr>${rowLabel(label)}${cells}</tr>`;
  }).join('');

  return `
      <div style="border:1px solid var(--green-mid);border-radius:6px;padding:10px 12px;margin-top:10px;background:#fafff7;overflow-x:auto">
        <div style="font-weight:600;font-size:12.5px;color:var(--green-mid);margin-bottom:6px">📅 Day-by-Day Schedule</div>
        <table style="border-collapse:collapse">
          <tbody>
            <tr>${rowLabel('Day / Date')}${dayNumbers.map(dayCell).join('')}</tr>
            ${activityRows}
          </tbody>
        </table>
      </div>`;
}

// Session 279 -- resolves one day-activity's real SOP hint the same way
// auto_assign_pk_course_sessions() does: ayush_code match first, then
// activity_label_match (case/whitespace-insensitive, matching the SQL's
// lower(btrim(...)) comparison). Protocol-level (linked_pk_template_id) is NOT
// included here -- that's a separate, lower-priority fallback the caller applies
// itself, same as the SQL does.
function _pkResolveActivityHint(ayushCode, activityLabel) {
  if (ayushCode && _pkContentHintsByAyush[ayushCode]) return _pkContentHintsByAyush[ayushCode];
  const key = (activityLabel || '').trim().toLowerCase();
  if (!ayushCode && key && _pkContentHintsByLabel[key]) return _pkContentHintsByLabel[key];
  return null;
}

// Session 277 -- true when this protocol has no sop_content_templates duration/man-
// power hint (the 59 generic Session-276 procedures, or any future one authored
// without real source content yet) -- the wizard then requires the doctor to enter
// both explicitly before Step 3 (Medicines) is reachable, rather than the scheduling
// engine silently falling back to a generic 30min/1-staff guess.
// Session 279 fix -- the original version only ever checked the protocol-level
// (linked_pk_template_id) hint, which is genuinely null by design for any multi-
// day/multi-activity protocol whose real duration varies per activity (Vamana's
// PCK63 administration=60min vs its PCK54 Snehapana prep=10min; Basti's Niruha=20min
// vs Anuvasana=10min) -- flagging Vamana, Virechana AND Basti as "no SOP data" one at
// a time as each got tested live, even though their real per-activity data has existed
// since Sessions 241-253 and already drives the real scheduling engine successfully.
// Now checks each of the protocol's actual day-activities (p.blocks) the same 3-tier
// way the engine resolves them (ayush_code > activity_label_match > protocol-level
// fallback), and skips ward-nurse/diet-pathya-owned activities entirely -- those never
// get a PK-therapist session generated at all (generate_pk_sessions_for_plan() skips
// them outright), so no scheduling data is ever needed for them.
function _pkNeedsManualScheduleInput(p) {
  const parentHint = _pkContentHints[p.template_id];
  const blocks = p.blocks || [];
  if (!blocks.length) {
    return !parentHint || !parentHint.typical_duration_minutes || !parentHint.man_power_staff;
  }
  return blocks.some(b => {
    const activityHint = _pkResolveActivityHint(b.ayush_code, b.activity_label);
    if (activityHint && activityHint.owner_role && activityHint.owner_role !== 'pk_therapist') return false;
    const hint = activityHint || parentHint;
    return !hint || !hint.typical_duration_minutes || !hint.man_power_staff;
  });
}

function _pkRenderManualScheduleInput(p, pi) {
  if (!_pkNeedsManualScheduleInput(p)) return '';
  const missing = !p.doctor_duration_minutes || !p.doctor_man_power;
  return `
      <div style="border:1.5px solid ${missing ? 'var(--red)' : 'var(--gold)'};border-radius:6px;padding:10px 12px;margin-bottom:10px;background:${missing ? '#fff5f5' : '#fffaf0'}">
        <div style="font-weight:600;font-size:12.5px;color:${missing ? 'var(--red)' : 'var(--green-mid)'};margin-bottom:6px">⏱️ No platform SOP data yet for this procedure — specify how it should be scheduled${missing ? ' (required)' : ''}</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="min-width:140px">
            <label style="font-size:11px">Session duration (minutes) *</label>
            <input type="number" min="1" step="1" value="${p.doctor_duration_minutes || ''}" placeholder="e.g. 45"
              data-onchange="_pkSetManualScheduleField" data-onchange-a0="${pi}" data-onchange-a1="doctor_duration_minutes" data-onchange-a2="@this"
              style="height:34px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:12.5px;width:100px"/>
          </div>
          <div class="field" style="min-width:140px">
            <label style="font-size:11px">Man power (staff) *</label>
            <input type="number" min="1" step="1" value="${p.doctor_man_power || ''}" placeholder="e.g. 2"
              data-onchange="_pkSetManualScheduleField" data-onchange-a0="${pi}" data-onchange-a1="doctor_man_power" data-onchange-a2="@this"
              style="height:34px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:12.5px;width:90px"/>
          </div>
          <div class="field" style="min-width:160px">
            <label style="font-size:11px">Needs a dedicated treatment room?</label>
            <div style="display:flex;gap:6px">
              <button type="button" data-onclick="_pkSetManualRoomRequired" data-onclick-a0="${pi}" data-onclick-a1="true"
                style="font-size:11.5px;padding:7px 12px;border-radius:6px;border:1.5px solid var(--green-mid);cursor:pointer;font-weight:600;background:${p.doctor_requires_room ? 'var(--green-deep)' : '#fff'};color:${p.doctor_requires_room ? '#fff' : 'var(--green-deep)'}">Yes</button>
              <button type="button" data-onclick="_pkSetManualRoomRequired" data-onclick-a0="${pi}" data-onclick-a1="false"
                style="font-size:11.5px;padding:7px 12px;border-radius:6px;border:1.5px solid var(--green-mid);cursor:pointer;font-weight:600;background:${!p.doctor_requires_room ? 'var(--green-deep)' : '#fff'};color:${!p.doctor_requires_room ? '#fff' : 'var(--green-deep)'}">No — bedside/no room</button>
            </div>
          </div>
        </div>
        ${missing ? `<div style="font-size:10.5px;color:var(--red);margin-top:6px">Both fields are required — you can’t proceed to Medicines & Instructions until they’re filled in. Gender-matched therapist and room assignment happen automatically once scheduled — no separate entry needed for that.</div>` : ''}
      </div>`;
}

window._pkSetManualScheduleField = function(pi, field, inputEl) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  const v = Number(inputEl.value);
  p[field] = v > 0 ? v : null;
  _renderPkCalendar();
};

window._pkSetManualRoomRequired = function(pi, val) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  p.doctor_requires_room = val === 'true';
  _renderPkCalendar();
};

function _renderPkCalendar() {
  const el = document.getElementById('pk-calendar-body');
  if (!el) return;
  el.innerHTML = _pkProtocols.map((p, pi) => `
    <div class="section" style="border:1.5px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <div style="font-weight:700;font-size:14px;color:var(--green-deep)">${_esc(p.protocol_label)} <span style="font-size:11px;color:var(--text-muted)">(${new Set(_pkExpandDays(p).map(r => r.day_number)).size} days)</span></div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:var(--text-mid)">Start</label>
          <input type="date" value="${_esc(p.start_date)}" data-onchange="_pkSetProtocolStart" data-onchange-a0="${pi}" data-onchange-a1="@this" style="height:32px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:12.5px"/>
          <!-- Session 269 follow-up -- Dr. Venkatesh: the button was there for every
               protocol including Basti (never actually missing), just easy to miss in
               its default unopened state (plain white/outline) next to Basti's more
               colorful Pack Type/Schedule panels. Solid-filled by default now instead
               of outline-only, so it reads as a real action, not a quiet label. -->
          <button type="button" data-onclick="_pkToggleDatePicker" data-onclick-a0="${pi}"
            style="height:32px;padding:0 10px;border:1.5px solid ${_pkDatePickerOpenFor === pi ? 'var(--green-mid)' : 'var(--gold)'};border-radius:6px;background:${_pkDatePickerOpenFor === pi ? 'var(--green-mid)' : 'var(--gold)'};color:#fff;font-size:11.5px;font-weight:700;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.15)">📅 ${_pkDatePickerOpenFor === pi ? 'Hide Calendar' : 'Pick from Calendar'}</button>
        </div>
      </div>
      ${_pkDatePickerOpenFor === pi ? _pkRenderDatePicker(pi) : ''}
      ${!p.is_reviewed ? `<div style="background:#fff8e1;border:1px solid #e6c200;border-radius:6px;padding:6px 10px;font-size:11px;color:#6b4c00;margin-bottom:8px">⚠ Draft SOP — pending clinical review. Day-counts/phases below are a generic starting point, not yet confirmed.</div>` : ''}
      ${_pkRenderManualScheduleInput(p, pi)}
      ${p.procedure_key === 'virechana' ? _pkRenderPediatricVirechanaPanel(p, pi) : ''}
      ${p.procedure_key === 'vamana' ? _pkRenderPediatricVamanaPanel(p, pi) : ''}
      ${p.procedure_key === 'nasya' ? _pkRenderPediatricNasyaPanel(p, pi) : ''}
      ${p.procedure_key === 'basti' ? `
      <div style="border:1.5px solid var(--blue);border-radius:6px;padding:9px 12px;margin-bottom:10px;background:#f5f8ff;font-size:11.5px;color:var(--text-dark)">
        <strong>📌 Standing instruction:</strong> Local Abhyanga + Swedana (~10 minutes) is performed immediately before <em>every</em> Anuvasana and every Niruha administration — not a separate scheduled day. Applies throughout the whole course, every administration day, without needing its own calendar entry.
      </div>
      ${_pkRenderPediatricBastiPanel(p, pi)}
      <div style="border:1px solid var(--gold);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fffaf0">
        <div style="font-weight:600;font-size:12.5px;color:var(--green-mid);margin-bottom:6px">🌀 Basti Pack Type (Charaka's classical Anuvasana/Niruha rotation)</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${Object.entries(_PK_BASTI_PACK_TYPES).map(([key, cfg]) => `
            <button type="button" data-onclick="_pkSetBastiPackType" data-onclick-a0="${pi}" data-onclick-a1="${key}"
              style="font-size:11.5px;padding:7px 12px;border-radius:6px;border:1.5px solid var(--green-mid);cursor:pointer;font-weight:600;background:${p.basti_pack_type === key ? 'var(--green-deep)' : '#fff'};color:${p.basti_pack_type === key ? '#fff' : 'var(--green-deep)'}">${_esc(cfg.label)}</button>
          `).join('')}
        </div>
        ${!p.basti_pack_type ? `<div style="font-size:10.5px;color:var(--text-muted);margin-top:6px">Choose a pack type to generate the day-by-day Oil/Decoction calendar below.</div>` : ''}
        ${p.basti_pack_type && _PK_BASTI_COMPRESSED_TOTALS[p.basti_pack_type] ? `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="font-size:11.5px;font-weight:600;color:var(--green-deep);margin-bottom:5px">Schedule</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" data-onclick="_pkSetBastiScheduleMode" data-onclick-a0="${pi}" data-onclick-a1="standard"
              style="font-size:11px;padding:6px 10px;border-radius:6px;border:1.5px solid var(--border);cursor:pointer;background:${p.basti_schedule_mode !== 'compressed' ? 'var(--green-mid)' : '#fff'};color:${p.basti_schedule_mode !== 'compressed' ? '#fff' : '#333'}">Standard (${_PK_BASTI_PACK_TYPES[p.basti_pack_type].days} days, 1/day)</button>
            <button type="button" data-onclick="_pkSetBastiScheduleMode" data-onclick-a0="${pi}" data-onclick-a1="compressed"
              style="font-size:11px;padding:6px 10px;border-radius:6px;border:1.5px solid var(--border);cursor:pointer;background:${p.basti_schedule_mode === 'compressed' ? 'var(--green-mid)' : '#fff'};color:${p.basti_schedule_mode === 'compressed' ? '#fff' : '#333'}">Compressed (${_pkBastiCompressedPlan(p.basti_pack_type).length} days, same-day Niruha+Anuvasana from Day 2)</button>
          </div>
          <div style="font-size:10.5px;color:var(--text-muted);margin-top:5px">Compressed: Day 1 Anuvasana only (after admission); Day 2 onward, Niruha every morning (empty stomach) + Anuvasana the same evening (after the meal) — same total Oil/Decoction count, roughly half the stay.</div>
        </div>` : ''}
      </div>` : ''}
      <div style="overflow-x:auto">
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr style="background:var(--green-light);color:var(--green-deep)">
          <th style="padding:5px 8px;text-align:left">Day</th><th style="padding:5px 8px;text-align:left">Date</th>
          <th style="padding:5px 8px;text-align:left">Phase</th><th style="padding:5px 8px;text-align:left">Activity</th><th style="padding:5px 8px;text-align:left">Length</th>
        </tr></thead>
        <tbody>
          ${p.blocks.map((b, bi) => {
            // Session 266 -- the Niruha half of a Basti pair never gets its own row; it's
            // shown combined with the Anuvasana row below (they're not a contiguous range).
            if (b.bastiDayType === 'niruha') return '';

            if (b.bastiDayType === 'anuvasana') {
              const niruha = p.blocks.find(x => x.bastiDayType === 'niruha');
              const total = b.length + (niruha?.length || 0);
              let offset = 1;
              for (let i = 0; i < bi; i++) if (p.blocks[i].bastiDayType !== 'niruha') offset += p.blocks[i].length;
              const startNum = offset, endNum = offset + total - 1;
              const base = new Date(p.start_date + 'T00:00:00');
              const fmt = n => { const d = new Date(base); d.setDate(d.getDate() + (n - 1)); return d.toLocaleDateString('en-CA'); };
              return `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:5px 8px">${total ? (startNum === endNum ? `Day ${startNum}` : `Day ${startNum}-${endNum}`) : '—'}</td>
            <td style="padding:5px 8px">${total ? `${fmt(startNum)} to ${fmt(endNum)}` : 'Choose a pack type'}</td>
            <td style="padding:5px 8px"><span class="phase-badge phase-${b.phase}">${_PK_PHASE_LABEL[b.phase] || b.phase}</span></td>
            <td style="padding:5px 8px">Basti Administration — Anuvasana (Oil) + Niruha (Decoction)${total ? ' — see day-by-day schedule below' : ''}</td>
            <td style="padding:5px 8px">${total ? `${b.length}O / ${niruha?.length || 0}D` : '—'}</td>
          </tr>`;
            }

            const toggleable = _PK_TOGGLEABLE_ACTIVITIES.includes(b.activity_label);
            const r = b.length > 0 ? _pkBlockDayRange(p, bi) : { label: '—', dateLabel: 'Skipped' };
            const modeBtn = (val, label, color) => `<button type="button" data-onclick="_pkSetBlockMode" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="${val}"
              style="font-size:9px;padding:2px 5px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:${b.mode === val ? color : '#fff'};color:${b.mode === val ? '#fff' : '#333'}">${label}</button>`;
            return `
          <tr style="border-bottom:1px solid var(--border)${b.mode === 'skip' ? ';opacity:0.55' : ''}">
            <td style="padding:5px 8px">${r.label}</td>
            <td style="padding:5px 8px">${r.dateLabel}</td>
            <td style="padding:5px 8px"><span class="phase-badge phase-${b.phase}">${_PK_PHASE_LABEL[b.phase] || b.phase}</span></td>
            <td style="padding:5px 8px">${_esc(b.activity_label)}${b.mode === 'home' ? ' <span style="font-size:10px;color:var(--green-mid)">🏠 Advised at home</span>' : ''}</td>
            <td style="padding:5px 8px">
              ${toggleable ? `<div style="display:flex;gap:3px;margin-bottom:4px">
                ${modeBtn('hospital', 'Hospital', 'var(--green-mid)')}
                ${modeBtn('home', 'Home', 'var(--gold)')}
                ${modeBtn('skip', 'Skip', 'var(--red)')}
              </div>` : ''}
              ${b.mode === 'skip' ? '' : (b.is_flexible
                ? `<button type="button" data-onclick="_pkAdjustBlockLength" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="-1" style="width:22px;height:22px;border:1px solid var(--border);border-radius:4px;background:#fff;cursor:pointer">−</button>
                   <span style="display:inline-block;width:28px;text-align:center;font-weight:600">${b.length}d</span>
                   <button type="button" data-onclick="_pkAdjustBlockLength" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="1" style="width:22px;height:22px;border:1px solid var(--border);border-radius:4px;background:#fff;cursor:pointer">+</button>
                   <span style="font-size:10px;color:var(--text-muted)"> (${b.min_days}-${b.max_days})</span>`
                : `${b.length}d`)}
            </td>
          </tr>`; }).join('')}
        </tbody>
      </table>
      </div>
      ${p.procedure_key === 'basti' && p.basti_pack_type ? (() => {
        const plan = _pkBastiDayPlan(p);
        if (!plan.length) return '';
        const anuvasanaIdx = p.blocks.findIndex(b => b.bastiDayType === 'anuvasana');
        let offset = 1;
        for (let i = 0; i < anuvasanaIdx; i++) offset += p.blocks[i].length;
        const base = new Date(p.start_date + 'T00:00:00');
        const fmt = n => { const d = new Date(base); d.setDate(d.getDate() + (n - 1)); return d.toLocaleDateString('en-CA'); };
        const anuCell = `<span title="Anuvasana — after lunch/dinner, never empty stomach" style="display:inline-block;padding:3px 7px;border-radius:4px;font-size:10.5px;font-weight:700;color:#fff;background:var(--gold)">Anu</span>`;
        const niruCell = `<span title="Niruha — empty stomach, before breakfast" style="display:inline-block;padding:3px 7px;border-radius:4px;font-size:10.5px;font-weight:700;color:#fff;background:var(--blue)">Niru</span>`;
        const dayCell = (n) => `<td style="padding:5px 9px;text-align:center;border-left:1px solid var(--border);border-bottom:1px solid var(--border);white-space:nowrap;font-size:11px"><strong>Day ${n}</strong><br><span style="color:var(--text-muted);font-size:10px">${fmt(n)}</span></td>`;
        const rowLabel = (label) => `<td style="padding:5px 9px;font-weight:600;color:var(--text-mid);white-space:nowrap;position:sticky;left:0;background:#fafff7;border-right:1.5px solid var(--border);border-bottom:1px solid var(--border)">${label}</td>`;
        const rows = p.basti_schedule_mode === 'compressed'
          ? [
              `<tr>${rowLabel('Niruha')}${plan.map(e => `<td style="padding:5px 9px;text-align:center;border-left:1px solid var(--border);border-bottom:1px solid var(--border)">${e.niruha ? niruCell : ''}</td>`).join('')}</tr>`,
              `<tr>${rowLabel('Anuvasana')}${plan.map(e => `<td style="padding:5px 9px;text-align:center;border-left:1px solid var(--border);border-bottom:1px solid var(--border)">${e.anuvasana ? anuCell : ''}</td>`).join('')}</tr>`,
            ]
          : [`<tr>${rowLabel('Type')}${plan.map(e => `<td style="padding:5px 9px;text-align:center;border-left:1px solid var(--border);border-bottom:1px solid var(--border)">${e.anuvasana ? anuCell : niruCell}</td>`).join('')}</tr>`];
        return `
      <div style="border:1px solid var(--green-mid);border-radius:6px;padding:10px 12px;margin-top:10px;background:#fafff7;overflow-x:auto">
        <div style="font-weight:600;font-size:12.5px;color:var(--green-mid);margin-bottom:6px">📅 Basti Day-by-Day Schedule — ${_esc(_PK_BASTI_SHORT_NAME[p.basti_pack_type] || '')} ${p.basti_schedule_mode === 'compressed' ? '(Compressed)' : '(Standard)'}</div>
        <table style="border-collapse:collapse">
          <tbody>
            <tr>${rowLabel('Day / Date')}${plan.map((e, i) => dayCell(offset + i)).join('')}</tr>
            ${rows.join('')}
          </tbody>
        </table>
      </div>`;
      })() : ''}
      ${p.procedure_key !== 'basti' ? _pkRenderGenericDayGrid(p) : ''}
      ${p.blocks.some(b => b.ayush_code === 'PCK54') ? `
      <div style="border:1px solid var(--gold);border-radius:6px;padding:10px 12px;margin-top:10px;background:#fffaf0">
        <div style="font-weight:600;font-size:12.5px;color:var(--green-mid);margin-bottom:6px">🌿 Snehapana Dosing</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="min-width:160px">
            <label style="font-size:11px">Koshtha (bowel type)</label>
            <!-- Session 287 bug fix -- was "@this" (passes the raw <select> element, per
                 domEvents.js's own token table), but _pkSetKoshtha()'s body always treated
                 its 2nd arg as the plain string value ("koshtha || null", no el.value read
                 anywhere) -- since Session 255. p.koshtha silently held a DOM element object
                 instead of 'mridu'/'madhyama'/'krura' the whole time: _PK_KOSHTHA_DEFAULT_DOSE
                 lookup silently failed (object coerces to "[object HTMLSelectElement]", never
                 a real key, so the auto-fill never fired -- easy to miss since the field is
                 doctor-editable anyway) and, far worse, EVERY care-plan save that had a Koshtha
                 selected hit this exact CHECK constraint 400 and silently failed via a bare
                 console.warn -- found live while wiring the same (copied) pattern for
                 pediatric_shuddhi_tier and getting the identical error. Fixed at the source: "@value" is the token that actually
                 resolves to el.value, matching what the handler already assumed. -->
            <select data-onchange="_pkSetKoshtha" data-onchange-a0="${pi}" data-onchange-a1="@value">
              <option value="">— Assess —</option>
              <option value="mridu"${p.koshtha === 'mridu' ? ' selected' : ''}>Mridu (soft)</option>
              <option value="madhyama"${p.koshtha === 'madhyama' ? ' selected' : ''}>Madhyama (medium)</option>
              <option value="krura"${p.koshtha === 'krura' ? ' selected' : ''}>Krura (hard/constipated)</option>
            </select>
          </div>
          <div class="field" style="width:130px">
            <label style="font-size:11px">Start dose (Hrasiyasi Matra, ml)</label>
            <input type="number" min="1" value="${p.snehapana_start_dose_ml || ''}" placeholder="e.g. 30"
              data-onchange="_pkSetSnehaField" data-onchange-a0="${pi}" data-onchange-a1="snehapana_start_dose_ml" data-onchange-a2="@this"/>
          </div>
          <div class="field" style="width:130px">
            <label style="font-size:11px">Daily increment (ml)</label>
            <input type="number" min="1" value="${p.snehapana_increment_ml || ''}" placeholder="e.g. 30"
              data-onchange="_pkSetSnehaField" data-onchange-a0="${pi}" data-onchange-a1="snehapana_increment_ml" data-onchange-a2="@this"/>
          </div>
        </div>
        <div style="font-size:10.5px;color:var(--text-muted);margin-top:6px">Each day's actual dose is decided fresh (recorded by the therapist, signs by ward staff, escalation reviewed by you) — this just sets the starting point and daily step.</div>
      </div>` : ''}
    </div>`).join('') || '<div style="text-align:center;color:var(--text-muted);padding:20px">No protocols selected — go back to Step 1.</div>';
}

window._pkAdjustBlockLength = function(pi, bi, delta) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  const b = p.blocks[Number(bi)]; if (!b || !b.is_flexible) return;
  const next = b.length + Number(delta);
  if (next < b.min_days || next > b.max_days) return;
  b.length = next;
  _renderPkCalendar();
};

window._pkSetProtocolStart = function(pi, inputEl) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  p.start_date = inputEl.value || p.start_date;
  _renderPkCalendar();
};

// ── Full Calendar view (Session 268) ────────────────────────────────────────────
// Month-grid preview across EVERY selected protocol combined, so the doctor can check
// real dates/days-of-week and spot any cross-protocol overlap while planning --
// distinct from Step 2's per-protocol day-number table above it.
const _PK_CAL_COLORS = ['var(--green-mid)', 'var(--gold)', 'var(--blue)', 'var(--purple)', 'var(--orange)'];
const _PK_CAL_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Shared by the Full Calendar view and the inline per-protocol date picker (Session
// 269) so the two can't disagree about which dates are occupied or which color a
// protocol gets. date -> [{ protocolLabel, activity, color, pi }]
function _pkComputeDatesByProtocol() {
  const byDate = {};
  _pkProtocols.forEach((p, pi) => {
    const color = _PK_CAL_COLORS[pi % _PK_CAL_COLORS.length];
    _pkExpandDays(p).forEach(r => {
      (byDate[r.planned_date] = byDate[r.planned_date] || []).push({ protocolLabel: p.protocol_label, activity: r.activity_label, color, pi });
    });
  });
  return byDate;
}

window._pkOpenCalendarView = function() {
  if (!_pkProtocols.length) { alert('Select at least one protocol first.'); return; }

  const byDate = _pkComputeDatesByProtocol();
  const dates = Object.keys(byDate).sort();
  if (!dates.length) {
    document.getElementById('pk-cal-body').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">No days planned yet — choose a Start date (and, for Basti, a Pack Type) first.</div>';
    document.getElementById('pk-cal-overlay').style.display = 'flex';
    return;
  }

  const overlapDays = dates.filter(d => new Set(byDate[d].map(e => e.protocolLabel)).size > 1).length;

  // One month-grid per calendar month the plan spans.
  const first = new Date(dates[0] + 'T00:00:00'), last = new Date(dates[dates.length - 1] + 'T00:00:00');
  const months = [];
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
  while (cursor <= last) { months.push(new Date(cursor)); cursor.setMonth(cursor.getMonth() + 1); }

  const legend = _pkProtocols.map((p, pi) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;margin-right:12px">
      <span style="width:10px;height:10px;border-radius:2px;background:${_PK_CAL_COLORS[pi % _PK_CAL_COLORS.length]};display:inline-block"></span>${_esc(p.protocol_label)}
    </span>`).join('');

  const monthHtml = months.map(m => {
    const y = m.getFullYear(), mo = m.getMonth();
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const firstDow = new Date(y, mo, 1).getDay();
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<td></td>');
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const entries = byDate[dateStr];
      const hasOverlap = entries && new Set(entries.map(e => e.protocolLabel)).size > 1;
      cells.push(`<td style="vertical-align:top;padding:3px;border:1px solid var(--border);${hasOverlap ? 'background:#fff3e0' : ''}">
        <div style="font-size:10.5px;font-weight:600;color:${entries ? 'var(--green-deep)' : 'var(--text-muted)'}">${d}</div>
        ${(entries || []).map(e => `<div title="${_esc(e.protocolLabel)}: ${_esc(e.activity)}" style="font-size:8.5px;color:#fff;background:${e.color};border-radius:2px;padding:1px 3px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:72px">${_esc(e.activity.split('—')[1]?.trim() || e.activity)}</div>`).join('')}
        ${hasOverlap ? '<div style="font-size:8px;color:#c0392b;font-weight:700;margin-top:1px">⚠ overlap</div>' : ''}
      </td>`);
    }
    // pad trailing cells to a full week
    while (cells.length % 7 !== 0) cells.push('<td></td>');
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
    return `
      <div style="font-weight:700;font-size:13px;color:var(--green-deep);margin:14px 0 6px">${m.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed">
        <thead><tr>${_PK_CAL_DOW.map(d => `<th style="font-size:10px;color:var(--text-mid);padding:3px;border:1px solid var(--border);background:var(--green-light)">${d}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>`;
  }).join('');

  document.getElementById('pk-cal-body').innerHTML = `
    <div style="margin-bottom:8px">${legend}</div>
    ${overlapDays ? `<div style="background:#fff3e0;border:1px solid var(--orange);border-radius:6px;padding:8px 10px;font-size:11.5px;color:#7a4a00;margin-bottom:6px">⚠ ${overlapDays} day${overlapDays > 1 ? 's have' : ' has'} more than one protocol scheduled — check these are clinically compatible together.</div>` : ''}
    ${monthHtml}
  `;
  document.getElementById('pk-cal-overlay').style.display = 'flex';
};

window._pkCloseCalendarView = function() {
  document.getElementById('pk-cal-overlay').style.display = 'none';
};

// ── Inline per-protocol Start-Date picker (Session 269) ─────────────────────────
// Replaces the plain <input type=date> "Start" control: click a real calendar date
// to set a protocol's start, and immediately see that protocol's whole computed span
// shaded, alongside every other protocol's span already planned -- so the doctor can
// deliberately place two protocols on overlapping days (a real, common pattern
// confirmed by Dr. Venkatesh, e.g. Basti followed by Abhyanga+Swedana the same day)
// with full visibility, not blind date math. Overlap is always just flagged, never
// blocked -- matches the Full Calendar view's philosophy: the system informs, the
// doctor decides.
let _pkDatePickerOpenFor = null;   // protocol index whose picker is currently expanded, or null
let _pkDatePickerMonth   = {};     // pi -> {y, m} the picker is currently showing

window._pkToggleDatePicker = function(pi) {
  pi = Number(pi);
  if (_pkDatePickerOpenFor === pi) { _pkDatePickerOpenFor = null; _renderPkCalendar(); return; }
  _pkDatePickerOpenFor = pi;
  const p = _pkProtocols[pi];
  const d = new Date((p?.start_date || todayLocalStr()) + 'T00:00:00');
  _pkDatePickerMonth[pi] = { y: d.getFullYear(), m: d.getMonth() };
  _renderPkCalendar();
};

window._pkDatePickerNav = function(pi, delta) {
  pi = Number(pi);
  const cur = _pkDatePickerMonth[pi] || { y: new Date().getFullYear(), m: new Date().getMonth() };
  const d = new Date(cur.y, cur.m + Number(delta), 1);
  _pkDatePickerMonth[pi] = { y: d.getFullYear(), m: d.getMonth() };
  _renderPkCalendar();
};

window._pkPickStartDate = function(pi, dateStr) {
  const p = _pkProtocols[Number(pi)]; if (!p) return;
  p.start_date = dateStr;
  // Stay open on the picked date's month -- lets the doctor see the shaded span
  // immediately without an extra click, and keep adjusting if needed.
  const d = new Date(dateStr + 'T00:00:00');
  _pkDatePickerMonth[Number(pi)] = { y: d.getFullYear(), m: d.getMonth() };
  _renderPkCalendar();
};

function _pkRenderDatePicker(pi) {
  const p = _pkProtocols[pi];
  const view = _pkDatePickerMonth[pi] || { y: new Date().getFullYear(), m: new Date().getMonth() };
  const byDate = _pkComputeDatesByProtocol();
  const y = view.y, mo = view.m;
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const firstDow = new Date(y, mo, 1).getDay();
  const myColor = _PK_CAL_COLORS[pi % _PK_CAL_COLORS.length];

  // Session 269 follow-up -- Dr. Venkatesh: this picker's cells only showed a bare
  // day number + a small colored dot for another protocol's occupancy, unlike the
  // Full Calendar view's actual activity-name text -- made it look "empty" next to
  // that richer view. Now shows the real activity label(s) per day here too, for
  // both this protocol's own span and any other protocol's, not just a dot.
  const shortLabel = a => _esc(a.split('—')[1]?.trim() || a);
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<td></td>');
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const allEntries = byDate[dateStr] || [];
    const mineEntries = allEntries.filter(e => e.pi === pi);  // this protocol's own activity(ies) that day
    const others = allEntries.filter(e => e.pi !== pi);       // any OTHER protocol's occupancy
    const mine = mineEntries.length > 0;
    const isStart = dateStr === p.start_date;
    const titleParts = [];
    if (mine) titleParts.push(`${_esc(p.protocol_label)}${isStart ? ' (start)' : ''}: ${mineEntries.map(e => e.activity).join(', ')}`);
    if (others.length) titleParts.push(others.map(e => `${e.protocolLabel}: ${e.activity}`).join(' · '));
    cells.push(`<td style="padding:2px;border:1px solid var(--border);vertical-align:top">
      <button type="button" data-onclick="_pkPickStartDate" data-onclick-a0="${pi}" data-onclick-a1="${dateStr}"
        title="${_esc(titleParts.join(' · '))}"
        style="width:100%;min-height:48px;border:${isStart ? '2px solid ' + myColor : '1px solid transparent'};border-radius:4px;cursor:pointer;padding:2px;background:${isStart ? myColor : (mine ? `color-mix(in srgb, ${myColor} 25%, white)` : '#fff')};color:${isStart ? '#fff' : '#333'};display:flex;flex-direction:column;align-items:stretch;gap:1px;text-align:left">
        <span style="font-size:11px;font-weight:${isStart ? '700' : '400'};text-align:center">${d}${isStart ? ' ★' : ''}</span>
        ${mine ? `<span style="font-size:8px;background:${myColor};color:#fff;border-radius:2px;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${mineEntries.map(e => shortLabel(e.activity)).join(', ')}</span>` : ''}
        ${others.slice(0, 2).map(e => `<span style="font-size:8px;background:${e.color};color:#fff;border-radius:2px;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${shortLabel(e.activity)}</span>`).join('')}
        ${others.length > 2 ? `<span style="font-size:8px;color:var(--text-muted)">+${others.length - 2} more</span>` : ''}
      </button>
    </td>`);
  }
  while (cells.length % 7 !== 0) cells.push('<td></td>');
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);

  const legend = _pkProtocols.map((op, opi) => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;margin-right:10px">
      <span style="width:9px;height:9px;border-radius:2px;background:${_PK_CAL_COLORS[opi % _PK_CAL_COLORS.length]};display:inline-block"></span>${_esc(op.protocol_label)}${opi === pi ? ' (this one)' : ''}
    </span>`).join('');

  return `
    <div style="border:1px solid var(--green-mid);border-radius:6px;padding:10px 12px;margin-top:8px;background:#fafff7">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <button type="button" data-onclick="_pkDatePickerNav" data-onclick-a0="${pi}" data-onclick-a1="-1" style="width:26px;height:26px;border:1px solid var(--border);border-radius:5px;background:#fff;cursor:pointer">‹</button>
        <div style="font-weight:700;font-size:12.5px;color:var(--green-deep)">${new Date(y, mo, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>
        <button type="button" data-onclick="_pkDatePickerNav" data-onclick-a0="${pi}" data-onclick-a1="1" style="width:26px;height:26px;border:1px solid var(--border);border-radius:5px;background:#fff;cursor:pointer">›</button>
      </div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed">
        <thead><tr>${_PK_CAL_DOW.map(dw => `<th style="font-size:10px;color:var(--text-mid);padding:2px;border:1px solid var(--border);background:var(--green-light)">${dw}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <div style="margin-top:6px">${legend}</div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Dots on a day = another protocol already planned there — you can still pick it (e.g. Basti followed by Abhyanga + Swedana the same day is a real, common plan), the dot is just so you can see it.</div>
    </div>`;
}

// Session 254 -- one Medicines section PER ACTIVITY (block), not one flat list for the
// whole protocol: Dr. Venkatesh confirmed the doctor needs to name a different medicine
// for Deepana-Pachana vs. the Snehapana oil vs. the Virechana/Vamana administration
// medicine, each with its own multi-medicine list, all within one protocol. Phase 1 of a
// 2-phase build he explicitly confirmed -- Phase 2 (doctor updating the actual dose
// day-by-day, since real Snehapana dosing escalates on live sneha siddhi assessment) is
// deliberately deferred to a later session.
// Session 271 -- Niruha Basti's 5-part compound formulation card. One formula per
// whole course (Dr. Venkatesh confirmed), starting from a picked classical template,
// every field freely editable afterward -- the library row is a starting point, not
// a lock.
function _pkRenderNiruhaFormulaCard(p, pi, b, bi) {
  const f = b.niruhaFormula;
  const formOpts = '<option value="">— Custom / build manually —</option>' + _pkNiruhaFormulations.map(x =>
    `<option value="${x.id}" ${f.formulation_key === x.formulation_key ? 'selected' : ''}>${_esc(x.display_name)}</option>`).join('');
  const mlComponents = ['madhu', 'sneha', 'kwatha', 'avapa'];
  const classicalTotal = mlComponents.reduce((sum, c) => sum + (f.components[c] || []).reduce((s, it) => s + (it.qty || 0), 0), 0);
  const extraMlTotal = (f.extra || []).filter(x => x.unit === 'ml').reduce((sum, x) => sum + (x.items || []).reduce((s, it) => s + (it.qty || 0), 0), 0);
  const totalMl = classicalTotal + extraMlTotal;

  // One component's list of medicine rows -- add/remove, same visual language as
  // the generic "Medicines / Materials" list every other activity already uses.
  const componentBlock = (comp) => {
    const unit = _PK_NIRUHA_COMPONENT_UNIT[comp];
    const items = f.components[comp] || [];
    return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <label style="font-size:10.5px;font-weight:600;color:var(--text-mid)">${_PK_NIRUHA_COMPONENT_LABEL[comp]}</label>
        <button type="button" data-onclick="_pkAddNiruhaItem" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="${comp}"
          style="font-size:10.5px;padding:2px 8px;border:1px solid var(--blue);border-radius:10px;background:#fff;color:var(--blue);cursor:pointer">+ Add</button>
      </div>
      ${items.map((it, ii) => `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" value="${_esc(it.name || '')}" placeholder="${_esc(_PK_NIRUHA_COMPONENT_PLACEHOLDER[comp])}" style="flex:1"
            data-onchange="_pkSetNiruhaItemField" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="${comp}" data-onchange-a3="${ii}" data-onchange-a4="name" data-onchange-a5="@this"/>
          <input type="number" min="0" value="${it.qty ?? ''}" placeholder="${unit}" style="width:72px"
            data-onchange="_pkSetNiruhaItemField" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="${comp}" data-onchange-a3="${ii}" data-onchange-a4="qty" data-onchange-a5="@this"/>
          <span style="font-size:10.5px;color:var(--text-muted);width:16px">${unit}</span>
          ${items.length > 1 ? `<button type="button" data-onclick="_pkRemoveNiruhaItem" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="${comp}" data-onclick-a3="${ii}"
            style="width:24px;height:24px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-size:10px;flex-shrink:0">&#10005;</button>` : '<span style="width:24px;flex-shrink:0"></span>'}
        </div>`).join('')}
    </div>`;
  };

  // Session 279 -- entirely extra components beyond the classical 6 (Dr.
  // Venkatesh: "add 7+N if required"), each with its own doctor-typed label,
  // unit and medicine list. Not classically named -- no Mardan Krama ordering
  // implied, purely additional.
  const extraBlock = (x, xi) => `
    <div style="border:1px dashed var(--gold);border-radius:6px;padding:8px 10px;margin-bottom:8px;background:#fffaf0">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <input type="text" value="${_esc(x.label || '')}" placeholder="Additional component name (e.g. Ksheera)" style="flex:1;font-weight:600"
          data-onchange="_pkSetNiruhaExtraLabel" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="${xi}" data-onchange-a3="@this"/>
        <select style="width:64px" data-onchange="_pkSetNiruhaExtraUnit" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="${xi}" data-onchange-a3="@this">
          <option value="ml" ${x.unit !== 'g' ? 'selected' : ''}>ml</option>
          <option value="g" ${x.unit === 'g' ? 'selected' : ''}>g</option>
        </select>
        <button type="button" data-onclick="_pkRemoveNiruhaExtraComponent" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="${xi}"
          style="width:24px;height:24px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-size:10px;flex-shrink:0">&#10005;</button>
      </div>
      ${(x.items || []).map((it, ii) => `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
          <input type="text" value="${_esc(it.name || '')}" placeholder="Ingredient name" style="flex:1"
            data-onchange="_pkSetNiruhaExtraItemField" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="${xi}" data-onchange-a3="${ii}" data-onchange-a4="name" data-onchange-a5="@this"/>
          <input type="number" min="0" value="${it.qty ?? ''}" placeholder="${x.unit || 'ml'}" style="width:72px"
            data-onchange="_pkSetNiruhaExtraItemField" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="${xi}" data-onchange-a3="${ii}" data-onchange-a4="qty" data-onchange-a5="@this"/>
          ${(x.items || []).length > 1 ? `<button type="button" data-onclick="_pkRemoveNiruhaExtraItem" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="${xi}" data-onclick-a3="${ii}"
            style="width:24px;height:24px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-size:10px;flex-shrink:0">&#10005;</button>` : '<span style="width:24px;flex-shrink:0"></span>'}
        </div>`).join('')}
      <button type="button" data-onclick="_pkAddNiruhaExtraItem" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="${xi}"
        style="font-size:10.5px;padding:2px 8px;border:1px solid var(--gold);border-radius:10px;background:#fff;color:var(--gold);cursor:pointer">+ Add ingredient</button>
    </div>`;

  const pediatricBand = _pkIsPediatricPatient() ? _pkResolvePediatricDoseBand(_pkPatientAgeYears()) : null;
  return `
        <div style="border:1px solid var(--blue);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#f5f8ff">
          <div style="font-weight:600;font-size:12.5px;color:var(--blue);margin-bottom:6px">${_esc(b.activity_label)}</div>
          ${pediatricBand ? `<div style="background:#fdf5fb;border:1px solid var(--purple);border-radius:5px;padding:6px 10px;font-size:11px;color:var(--purple);margin-bottom:8px">🧒 Pediatric dose applied (${_esc(pediatricBand.band_label)} band) — every quantity below is pre-filled from the age-wise dose table, still fully editable.</div>` : ''}
          <div class="field" style="margin-bottom:8px">
            <label style="font-size:11px">Load Standard Formulation</label>
            <select data-onchange="_pkLoadNiruhaFormulation" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="@this">${formOpts}</select>
          </div>
          <div class="field" style="margin-bottom:8px">
            <label style="font-size:11px">Basti Name <span style="font-weight:400;color:var(--text-muted)">(for the record — type the classical name if it's not in the dropdown above)</span></label>
            <input type="text" value="${_esc(f.formula_name || '')}" placeholder="e.g. Punarnavadi Niruha"
              data-onchange="_pkSetNiruhaFormulaName" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="@this"/>
          </div>
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:8px">Classical mixing order (Mardan Krama): Madhu + Lavana triturated first → Sneha streamed in → Kalka blended in → warm Kwatha added last, stirred until no oil separates. Warm to body temperature (~37°C) via water bath before administration — never direct heat.</div>
          ${componentBlock('madhu')}
          ${componentBlock('lavana')}
          ${componentBlock('sneha')}
          ${componentBlock('kalka')}
          ${componentBlock('kwatha')}
          ${componentBlock('avapa')}
          ${(f.extra || []).map(extraBlock).join('')}
          <button type="button" data-onclick="_pkAddNiruhaExtraComponent" data-onclick-a0="${pi}" data-onclick-a1="${bi}"
            style="font-size:11px;padding:5px 12px;border:1.5px dashed var(--gold);border-radius:8px;background:#fff;color:var(--gold);cursor:pointer;font-weight:600;margin-bottom:6px">+ Add another component</button>
          <div style="font-size:11.5px;font-weight:700;color:var(--green-deep);margin-top:4px">Total liquid volume: ~${totalMl}ml <span style="font-weight:400;color:var(--text-muted)">(classical range 450–600ml)</span></div>
        </div>`;
}

window._pkLoadNiruhaFormulation = function(pi, bi, selectEl) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b) return;
  const formId = selectEl.value;
  if (!formId) {
    b.niruhaFormula = _pkNewNiruhaFormula(); b.niruhaFormula.formula_name = '';
    _pkApplyPediatricNiruhaDoses(b.niruhaFormula); // Session 285 follow-up
    _renderPkMedicines(); return;
  }
  const f = _pkNiruhaFormulations.find(x => x.id === formId); if (!f) return;
  b.niruhaFormula = {
    formulation_key: f.formulation_key, formula_name: f.display_name,
    components: {
      madhu:  [{ name: f.madhu_name_default, qty: f.madhu_default_ml }],
      lavana: [{ name: f.lavana_name_default, qty: f.lavana_default_g }],
      sneha:  [{ name: f.sneha_name_default || '', qty: f.sneha_default_ml }],
      kalka:  [{ name: f.kalka_ingredients_default || '', qty: f.kalka_default_g }],
      kwatha: [{ name: f.kwatha_ingredients_default || '', qty: f.kwatha_default_ml }],
      avapa:  [{ name: f.avapa_name_default || '', qty: f.avapa_default_ml }],
    },
    extra: [],
  };
  // Session 285 follow-up -- a standard formulation's default quantities are adult-
  // scaled; for a pediatric patient, keep the formulation's classical ingredient
  // NAMES but override every quantity with this patient's real age-band dose.
  _pkApplyPediatricNiruhaDoses(b.niruhaFormula);
  _renderPkMedicines();
};

window._pkSetNiruhaFormulaName = function(pi, bi, inputEl) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  b.niruhaFormula.formula_name = inputEl.value;
};

window._pkAddNiruhaItem = function(pi, bi, comp) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  b.niruhaFormula.components[comp].push({ name: '', qty: null });
  _renderPkMedicines();
};
window._pkRemoveNiruhaItem = function(pi, bi, comp, ii) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  b.niruhaFormula.components[comp].splice(Number(ii), 1);
  _renderPkMedicines();
};
window._pkSetNiruhaItemField = function(pi, bi, comp, ii, field, inputEl) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  const it = b.niruhaFormula.components[comp][Number(ii)]; if (!it) return;
  it[field] = field === 'qty' ? (inputEl.value ? Number(inputEl.value) : null) : inputEl.value;
  if (field === 'qty') _renderPkMedicines(); // total volume changed
};

window._pkAddNiruhaExtraComponent = function(pi, bi) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  (b.niruhaFormula.extra = b.niruhaFormula.extra || []).push({ label: '', unit: 'ml', items: [{ name: '', qty: null }] });
  _renderPkMedicines();
};
window._pkRemoveNiruhaExtraComponent = function(pi, bi, xi) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  b.niruhaFormula.extra.splice(Number(xi), 1);
  _renderPkMedicines();
};
window._pkSetNiruhaExtraLabel = function(pi, bi, xi, inputEl) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  const x = b.niruhaFormula.extra[Number(xi)]; if (!x) return;
  x.label = inputEl.value;
};
window._pkSetNiruhaExtraUnit = function(pi, bi, xi, selectEl) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  const x = b.niruhaFormula.extra[Number(xi)]; if (!x) return;
  x.unit = selectEl.value;
  _renderPkMedicines();
};
window._pkAddNiruhaExtraItem = function(pi, bi, xi) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  const x = b.niruhaFormula.extra[Number(xi)]; if (!x) return;
  x.items.push({ name: '', qty: null });
  _renderPkMedicines();
};
window._pkRemoveNiruhaExtraItem = function(pi, bi, xi, ii) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  const x = b.niruhaFormula.extra[Number(xi)]; if (!x) return;
  x.items.splice(Number(ii), 1);
  _renderPkMedicines();
};
window._pkSetNiruhaExtraItemField = function(pi, bi, xi, ii, field, inputEl) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)]; if (!b?.niruhaFormula) return;
  const it = b.niruhaFormula.extra[Number(xi)]?.items[Number(ii)]; if (!it) return;
  it[field] = field === 'qty' ? (inputEl.value ? Number(inputEl.value) : null) : inputEl.value;
  if (field === 'qty') _renderPkMedicines();
};

// Session 281 -- true when this specific block has real platform SOP content (a
// duration+man-power hint), same 3-tier resolution _pkNeedsManualScheduleInput() uses
// per-block internally (ayush_code match > activity_label_match > protocol-level
// fallback). Blocks WITHOUT this get the upgraded Formulation Name + quantity/unit
// ingredient-row form; blocks WITH it keep the original bare name-only list unchanged
// (Dr. Venkatesh: don't touch Anuvasana or the SOP-content-rich protocols).
function _pkBlockHasSopHint(p, b) {
  const activityHint = _pkResolveActivityHint(b.ayush_code, b.activity_label);
  const hint = activityHint || _pkContentHints[p.template_id];
  return !!(hint && hint.typical_duration_minutes && hint.man_power_staff);
}

function _renderPkMedicines() {
  const el = document.getElementById('pk-medicines-body');
  if (!el) return;
  const codeOpts = '<option value="">— none —</option>' + _pkAyushOptions.map(o => `<option value="${_esc(o.code)}">${_esc(o.code)} — ${_esc(o.name)}</option>`).join('');
  // Session 271 -- common Anuvasana oils/ghees, autocomplete suggestions on the
  // existing free-text medicine-name input (not a hard-coded dropdown -- any name
  // can still be typed).
  const snehaDatalist = `<datalist id="pk-sneha-datalist">
    ${['Tila Taila (Sesame Oil)', 'Eranda Taila (Castor Oil)', 'Murchita Eranda Taila', 'Sahacharadi Taila',
       'Dhanwantaram Taila', 'Ksheerabala Taila', 'Mahanarayana Taila', 'Go Ghrita (Cow Ghee)',
       'Guggulu Tiktaka Ghrita', 'Panchatiktaka Ghrita'].map(n => `<option value="${_esc(n)}">`).join('')}
  </datalist>`;
  const unitOpts = u => ['ml','g','kg','L','batch','Pcs','Set'].map(x => `<option value="${x}"${(u || 'ml') === x ? ' selected' : ''}>${x}</option>`).join('');
  el.innerHTML = snehaDatalist + _pkProtocols.map((p, pi) => {
    // Session 281 -- {b, bi} pairs keep each block's REAL index into p.blocks (the
    // handlers below index p.blocks[bi] directly) even after filtering out
    // skip/zero-length/Niruha blocks -- a plain .filter() would silently renumber
    // them and point every handler at the wrong block.
    const renderableBlocks = p.blocks
      .map((b, bi) => ({ b, bi }))
      .filter(({ b }) => !(b.mode === 'skip' || (b.bastiDayType && b.length === 0) || b.bastiDayType === 'niruha'));
    // One Formulation Name per protocol instance (same placement Niruha's own Basti Name
    // already uses), shown once above its blocks -- only when at least one of them
    // actually needs it (has no SOP content).
    const needsFormulationName = renderableBlocks.some(({ b }) => !_pkBlockHasSopHint(p, b));
    // Bug fix -- _pkRenderNiruhaFormulaCard() (Madhu/Lavana/Sneha/Kalka/Kwatha/Avapa +
    // "Load Standard Formulation" dropdown) has been fully implemented since Session
    // 271/279 but was never actually called from here -- the Niruha block is
    // deliberately excluded from renderableBlocks above (by design, it needs its own
    // card, not the generic one) but nothing ever rendered that card in its place, so
    // every doctor has been unable to build/edit a Niruha compound formula through the
    // UI at all despite the save/reconstruct code paths fully supporting it. Found
    // while wiring pediatric doses into this card -- fixed by actually rendering it.
    const niruhaEntry = p.blocks.map((b, bi) => ({ b, bi })).find(({ b }) => b.bastiDayType === 'niruha');
    return `
    <div class="section" style="border:1.5px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:12px">
      <div style="font-weight:700;font-size:14px;color:var(--green-deep);margin-bottom:8px">${_esc(p.protocol_label)}</div>
      ${niruhaEntry ? _pkRenderNiruhaFormulaCard(p, pi, niruhaEntry.b, niruhaEntry.bi) : ''}
      ${needsFormulationName ? `
      <div class="field" style="margin-bottom:10px">
        <label style="font-size:11px">Formulation Name <span style="font-weight:400;color:var(--text-muted)">(for the record — the specific variant used, e.g. "Eranda Patra Pinda Sweda" under "Patra Pinda Sweda")</span></label>
        <input type="text" value="${_esc(p.custom_formulation_name || '')}" placeholder="e.g. Eranda Patra Pinda Sweda" data-onchange="_pkSetFormulationName" data-onchange-a0="${pi}" data-onchange-a1="@this"/>
      </div>` : ''}
      ${renderableBlocks.map(({ b, bi }) => {
        const hasSop = _pkBlockHasSopHint(p, b);
        const billingCode = !b.ayush_code ? `<div class="field" style="margin-bottom:6px">
            <label style="font-size:11px">Billing code for "${_esc(b.activity_label)}" (optional)</label>
            <select data-onchange="_pkSetBlockAyush" data-onchange-a0="${pi}" data-onchange-a1="${bi}" data-onchange-a2="@this">${codeOpts}</select>
          </div>` : '';

        // Session 282 -- unified ingredient-row UI (name + quantity + unit) for every
        // block, hasSop or not; the only real difference is hasSop blocks get a "Load
        // from SOP Materials" quick-fill (real reference materials + quantities already
        // on file) instead of the Formulation Name field the no-SOP branch shows above.
        // Fixes a real gap found live (Dr. Venkatesh, Session 282): the old hasSop
        // branch never collected quantity/unit at all, so even a fully SOP-documented
        // protocol's medicines auto-logged with a blank quantity on Mark Served -- same
        // problem Session 281 fixed for no-SOP protocols, just never applied here too.
        return `
        <div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#fafff7">
          <div style="font-weight:600;font-size:12.5px;color:var(--green-mid);margin-bottom:6px">${_esc(b.activity_label)}${b.mode === 'home' ? ' <span style="font-size:10px;color:var(--gold)">🏠 at home</span>' : ''}</div>
          ${billingCode}
          <div class="field">
            <label style="font-size:11px">${hasSop ? 'Medicines / Materials for this activity' : 'Ingredients'}</label>
            ${hasSop ? `<button type="button" data-onclick="_pkLoadSopMaterials" data-onclick-a0="${pi}" data-onclick-a1="${bi}" style="height:30px;padding:0 10px;margin-bottom:6px;background:var(--white);border:1.5px solid var(--green-mid);color:var(--green-deep);border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">📋 Load from SOP Materials</button>` : ''}
            ${_pkRenderVirechanaDravyaPicker(p, pi, b, bi)}
            ${_pkRenderVamanaDravyaPicker(p, pi, b, bi)}
            ${_pkRenderNasyaSubstancePicker(p, pi, b, bi)}
            <div style="display:grid;grid-template-columns:1.6fr .6fr .5fr auto;gap:6px;margin-bottom:6px">
              <input id="pk-med-name-${pi}-${bi}" type="text" placeholder="${hasSop ? 'e.g. Panchatiktaka Ghrita' : 'e.g. Eranda Ela'}"
                ${b.bastiDayType === 'anuvasana' ? `list="pk-sneha-datalist"` : ''}/>
              <input id="pk-med-qty-${pi}-${bi}" type="number" min="0" step="0.01" placeholder="Qty"/>
              <select id="pk-med-unit-${pi}-${bi}">${unitOpts()}</select>
              <button type="button" data-onclick="_pkAddMedicineQty" data-onclick-a0="${pi}" data-onclick-a1="${bi}" style="height:36px;padding:0 12px;background:var(--green-mid);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">+ Add</button>
            </div>
            ${b.bastiDayType === 'anuvasana' ? `<div style="font-size:10px;color:var(--text-muted);margin:-3px 0 6px">Start typing for common oils/ghees, or enter any name.</div>` : ''}
            ${(b.medicines || []).map((m, mi) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;background:#fff">
                <span style="font-size:12.5px">${_esc(m.medicine_name)}${m.quantity_value ? ` <span style="color:var(--text-muted)">(${m.quantity_value}${_esc(m.quantity_unit || '')})</span>` : ''}</span>
                <button type="button" data-onclick="_pkRemoveMedicine" data-onclick-a0="${pi}" data-onclick-a1="${bi}" data-onclick-a2="${mi}" style="width:24px;height:24px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;font-size:10px">&#10005;</button>
              </div>`).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }).join('') || '<div style="text-align:center;color:var(--text-muted);padding:20px">No protocols selected — go back to Step 1.</div>';
}

window._pkSetFormulationName = function(pi, inputEl) {
  const p = _pkProtocols[Number(pi)];
  if (p) p.custom_formulation_name = inputEl.value.trim() || null;
};

window._pkSetBlockAyush = function(pi, bi, selectEl) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)];
  if (b) b.ayush_code = selectEl.value || null;
  _pkRenderStep3Estimate();
};

// Session 281/282 -- the ingredient-row Add (name + quantity + unit), used by every
// block now, hasSop or not.
window._pkAddMedicineQty = function(pi, bi) {
  const nameInp = document.getElementById(`pk-med-name-${pi}-${bi}`);
  const qtyInp = document.getElementById(`pk-med-qty-${pi}-${bi}`);
  const unitSel = document.getElementById(`pk-med-unit-${pi}-${bi}`);
  const name = nameInp?.value.trim();
  if (!name) return;
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)];
  if (!b) return;
  (b.medicines = b.medicines || []).push({
    medicine_name: name, dosage_instructions: null,
    quantity_value: qtyInp?.value ? Number(qtyInp.value) : null,
    quantity_unit: unitSel?.value || 'ml',
  });
  nameInp.value = ''; if (qtyInp) qtyInp.value = '';
  _renderPkMedicines();
};

window._pkRemoveMedicine = function(pi, bi, mi) {
  const b = _pkProtocols[Number(pi)]?.blocks[Number(bi)];
  if (!b) return;
  b.medicines.splice(Number(mi), 1);
  _renderPkMedicines();
};

// Session 282 -- quick-fill from the platform's own SOP reference materials (real
// items + quantities, e.g. "Fresh lemons (6 Pcs)" for Jambeera Pinda Sweda) instead of
// re-typing them from memory every time. Only ever shown for a hasSop block -- resolves
// the same content-template id _pkBlockHasSopHint() already matched. Appends rather than
// replaces (a doctor may have already typed a patient-specific addition), skipping any
// name already present so repeat clicks don't duplicate.
window._pkLoadSopMaterials = async function(pi, bi) {
  const p = _pkProtocols[Number(pi)];
  const b = p?.blocks[Number(bi)];
  if (!p || !b) return;
  const activityHint = _pkResolveActivityHint(b.ayush_code, b.activity_label);
  const hint = activityHint || _pkContentHints[p.template_id];
  if (!hint?.id) { _toast('No SOP materials on file for this activity yet.', 'error'); return; }

  const { data: materials, error } = await supabase.from('sop_content_template_materials')
    .select('item_name,quantity,unit').eq('template_id', hint.id).order('sequence_order');
  if (error) { _toast('Could not load SOP materials.', 'error'); return; }
  if (!materials || !materials.length) { _toast('No SOP materials on file for this activity yet.', 'error'); return; }

  const existing = new Set((b.medicines || []).map(m => (m.medicine_name || '').trim().toLowerCase()));
  const toAdd = materials.filter(m => !existing.has((m.item_name || '').trim().toLowerCase()));
  if (!toAdd.length) { _toast('All of this activity\'s SOP materials are already listed.', 'error'); return; }

  (b.medicines = b.medicines || []).push(...toAdd.map(m => ({
    medicine_name: m.item_name, dosage_instructions: null,
    quantity_value: m.quantity ?? null, quantity_unit: m.unit || null,
  })));
  _renderPkMedicines();
};

// Sums scheduled days grouped by ayush_code, priced off the tenant's own fee_structures
// via the same getEffectivePrice() helper every other page uses. A day with no billing
// code resolved yet is reported but excluded from the total, never silently dropped.
function _pkComputeEstimate() {
  const byCode = {};
  let unpriced = 0;
  _pkProtocols.forEach(p => {
    _pkExpandDays(p).forEach(r => {
      if (r.ayush_code) byCode[r.ayush_code] = (byCode[r.ayush_code] || 0) + 1;
      else unpriced++;
    });
  });
  const lines = Object.keys(byCode).map(code => {
    const days = byCode[code];
    const feeRow = _pkFeeIndex[code];
    if (!feeRow) return { code, days, priced: false, unitPrice: 0, lineTotal: 0, label: code };
    const unitPrice = getEffectivePrice(feeRow);
    return { code, days, priced: true, unitPrice, lineTotal: unitPrice * days, label: feeRow.label || code };
  });
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  return { lines, total, unpriced };
}

function _pkRenderStep3Estimate() {
  const el = document.getElementById('pk-estimate-step3');
  if (!el) return;
  const est = _pkComputeEstimate();
  _pkLastEstimate = est;
  if (!est.lines.length && !est.unpriced) { el.textContent = 'Select at least one protocol to see an estimate.'; return; }
  el.innerHTML = (est.lines.length ? est.lines.map(l => `${_esc(l.label)}: ${l.days} day${l.days > 1 ? 's' : ''} × ${l.priced ? '₹' + l.unitPrice.toLocaleString('en-IN') : '—'} = <strong>${l.priced ? '₹' + l.lineTotal.toLocaleString('en-IN') : 'not priced'}</strong>`).join('<br>') : 'No billing codes resolved yet.')
    + `<br><span style="font-size:14px;font-weight:700;color:var(--green-deep)">Estimated Total: ₹${est.total.toLocaleString('en-IN')}</span>`
    + (est.unpriced ? `<br><span style="color:#c0392b">⚠ ${est.unpriced} day(s) have no billing code assigned — excluded from this total.</span>` : '');
}

// Plan-wide calendar span (earliest to latest scheduled day across every selected
// protocol) -- this is what a room/ward charge is billed against for Admission/Day
// Care, distinct from the sum of each protocol's own day-count (protocols can run
// sequentially or overlap, so the room is occupied across the whole span either way).
function _pkPlanSpanDays() {
  let min = null, max = null;
  _pkProtocols.forEach(p => {
    _pkExpandDays(p).forEach(r => {
      if (!min || r.planned_date < min) min = r.planned_date;
      if (!max || r.planned_date > max) max = r.planned_date;
    });
  });
  if (!min || !max) return { days: 0, start: null, through: null };
  const start = new Date(min + 'T00:00:00');
  const through = new Date(max + 'T00:00:00');
  return { days: Math.round((through - start) / 86400000) + 1, start, through };
}

let _pkLastRoomEstimate = null;
// Monotonic token guarding against out-of-order async resolution -- computeRoomTariff()
// is a network round trip; if the doctor changes setting/room-type again before an
// earlier call resolves, only the LATEST call is allowed to write to the DOM, so a slow
// stale response can never overwrite a newer one.
let _pkRecomputeToken = 0;

// Cost model confirmed by Dr. Venkatesh: Admission depends on the room selected (full
// room tariff over the plan's span); Day Care is a fixed General Ward charge over the
// same span; OPD-based has no room component at all -- just the treatment total.
window._pkRecomputeStep4 = async function() {
  const el = document.getElementById('pk-estimate-step4');
  if (!el) return;
  const myToken = ++_pkRecomputeToken;
  const setting = document.querySelector('input[name="pk-setting"]:checked')?.value || 'day_care';
  document.getElementById('pk-room-type-field').style.display = setting === 'admission' ? '' : 'none';

  const est = _pkComputeEstimate();
  let roomLine = '';
  let roomCost = 0;
  let roomEst = null;

  if (setting === 'admission' || setting === 'day_care') {
    const span = _pkPlanSpanDays();
    const bedType = setting === 'admission' ? (document.getElementById('pk-room-type').value || 'general') : 'general';
    if (span.days > 0) {
      const tariff = await computeRoomTariff({ supabase, tenantId, bed: { bed_type: bedType }, admissionDate: span.start, throughDate: span.through });
      if (myToken !== _pkRecomputeToken) return; // a newer call already won -- discard this stale result
      if (tariff.error) {
        roomLine = `<br><span style="color:#c0392b">⚠ ${_esc(tariff.error)}</span>`;
      } else {
        roomCost = tariff.total;
        roomEst = { bedType, days: tariff.days, dailyRate: tariff.dailyRate, roomCost };
        roomLine = `<br>${setting === 'day_care' ? 'General Ward' : _esc(bedType)}: ${tariff.days} day${tariff.days > 1 ? 's' : ''} × ₹${tariff.dailyRate.toLocaleString('en-IN')} = <strong>₹${roomCost.toLocaleString('en-IN')}</strong>`;
      }
    }
  }
  if (myToken !== _pkRecomputeToken) return; // guard the sync (opd) path too, for symmetry

  // Only the winning call ever writes to the shared cache savePkCarePlan() reads --
  // this is what actually closes the race, not just the rendered HTML.
  _pkLastEstimate = est;
  _pkLastRoomEstimate = roomEst;

  const total = est.total + roomCost;
  const pct = _admTenantPct.self_pay;
  const advance = Math.round(total * pct / 100);
  el.innerHTML = `Treatment: <strong>₹${est.total.toLocaleString('en-IN')}</strong>${roomLine}`
    + `<br><span style="font-size:14px;font-weight:700;color:var(--green-deep)">Estimated Total: ₹${total.toLocaleString('en-IN')}</span><br>Suggested advance (${pct}%, preview): <strong>₹${advance.toLocaleString('en-IN')}</strong>`
    + (est.unpriced ? `<br><span style="color:#c0392b">⚠ ${est.unpriced} day(s) have no billing code assigned — excluded from this total.</span>` : '');
};

window._pkGoToStep = function(n) {
  n = Number(n);
  if (n >= 2 && !_pkProtocols.length) { alert('Select at least one Panchakarma protocol first.'); return; }
  // Session 277 -- can't reach Medicines & Instructions while any protocol with no
  // platform SOP data is missing its mandatory doctor-entered duration/man-power.
  if (n >= 3) {
    const incomplete = _pkProtocols.find(p => _pkNeedsManualScheduleInput(p) && (!p.doctor_duration_minutes || !p.doctor_man_power));
    if (incomplete) {
      alert(`"${incomplete.protocol_label}" has no platform SOP data yet — enter its session duration and man power in Step 2 before continuing.`);
      _pkStep = 2;
      [1, 2, 3, 4].forEach(i => { const stepEl = document.getElementById('pk-step-' + i); if (stepEl) stepEl.hidden = i !== 2; });
      const ind0 = document.getElementById('pk-step-indicator');
      if (ind0) ind0.textContent = 'Step 2 of 4 — Calendar';
      _renderPkCalendar();
      return;
    }
  }
  _pkStep = n;
  [1, 2, 3, 4].forEach(i => { const stepEl = document.getElementById('pk-step-' + i); if (stepEl) stepEl.hidden = i !== n; });
  const labels = { 1: 'Select protocol(s)', 2: 'Calendar', 3: 'Medicines & Instructions', 4: 'Setting & Save' };
  const ind = document.getElementById('pk-step-indicator');
  if (ind) ind.textContent = `Step ${n} of 4 — ${labels[n]}`;
  if (n === 2) _renderPkCalendar();
  if (n === 3) { _renderPkMedicines(); _pkRenderStep3Estimate(); }
  if (n === 4) _pkRecomputeStep4();
};

function _resetPkCarePlan() {
  _pkProtocols = [];
  _pkStep = 1;
  _pkPlanSaved = false;
  // Session 268 -- which existing pk_care_plans row (if any) this wizard session is
  // editing/adding to, instead of creating a brand new one. Reset on every patient
  // switch; _pkCheckExistingDraft() (called separately, async, from startConsultation)
  // re-detects a draft for the newly active patient and shows the banner again if one exists.
  _pkEditingPlanId = null;
  _pkExistingDraftId = null;
  // Session 269 -- inline date-picker state is per-wizard-session UI state, not
  // per-protocol data -- reset it too so a stale picker doesn't carry over patients.
  _pkDatePickerOpenFor = null;
  _pkDatePickerMonth = {};
  // Session 278 -- a stale search filter from a previous patient's wizard session
  // shouldn't silently narrow what the next patient's doctor sees as "available".
  _pkOtherSearchTerm = '';
  const searchEl = document.getElementById('pk-other-search');
  if (searchEl) searchEl.value = '';
  [1, 2, 3, 4].forEach(i => { const stepEl = document.getElementById('pk-step-' + i); if (stepEl) stepEl.hidden = i !== 1; });
  const ind = document.getElementById('pk-step-indicator');
  if (ind) ind.textContent = 'Step 1 of 4 — Select protocol(s)';
  _renderPkChips();
  ['pk-instr-patient', 'pk-instr-therapist', 'pk-instr-nurse'].forEach(id => { const elx = document.getElementById(id); if (elx) elx.value = ''; });
  const status = document.getElementById('pk-save-status');
  if (status) status.style.display = 'none';
  const draftBanner = document.getElementById('pk-existing-draft-banner');
  if (draftBanner) draftBanner.style.display = 'none';
  const editBanner = document.getElementById('pk-editing-banner');
  if (editBanner) editBanner.style.display = 'none';
  const saveBtn = document.getElementById('btn-save-pk-plan');
  if (saveBtn) saveBtn.textContent = '🌸 Save Care Plan';
}

// ── Session 268 -- Add protocol(s) to / edit an existing draft Care Plan ────────────
// Scope (deliberate): only ever offered for a plan still status='finalized' -- i.e.
// the doctor saved it but reception hasn't activated it yet (no bill, no
// pk_therapy_sessions generated, nothing scheduled). Once a plan is 'active', editing
// it here would mean reconciling against real sessions/assignments/a collected
// advance -- a genuinely harder, separate problem, deliberately out of scope for now.
let _pkEditingPlanId    = null; // set once the doctor chooses "Continue Editing"
let _pkExistingDraftId  = null; // the plan pk_check found, before the doctor decides

async function _pkCheckExistingDraft(patientId) {
  const { data } = await supabase.from('pk_care_plans')
    .select('id, created_at, pk_care_plan_protocols(protocol_label)')
    .eq('tenant_id', tenantId).eq('patient_id', patientId).eq('status', 'finalized')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const banner = document.getElementById('pk-existing-draft-banner');
  if (!banner) return;
  if (!data) { _pkExistingDraftId = null; banner.style.display = 'none'; return; }
  _pkExistingDraftId = data.id;
  const names = (data.pk_care_plan_protocols || []).map(p => p.protocol_label).join(', ') || 'no protocols yet';
  document.getElementById('pk-existing-draft-text').textContent =
    `Created ${new Date(data.created_at).toLocaleDateString('en-IN')} — ${names}. Not yet activated by Reception.`;
  banner.style.display = '';
}

window._pkStartFreshInstead = function() {
  _pkExistingDraftId = null;
  document.getElementById('pk-existing-draft-banner').style.display = 'none';
};

window._pkLoadExistingDraft = async function() {
  const planId = _pkExistingDraftId;
  if (!planId) return;

  const { data: planRow } = await supabase.from('pk_care_plans').select('*').eq('id', planId).single();
  const { data: protocols } = await supabase.from('pk_care_plan_protocols').select('*').eq('care_plan_id', planId).order('sequence_order');
  if (!planRow || !protocols) { alert('Could not load the existing plan.'); return; }

  const protocolIds = protocols.map(p => p.id);
  const [{ data: allDays }, { data: allMeds }] = protocolIds.length ? await Promise.all([
    supabase.from('pk_care_plan_days').select('*').in('protocol_instance_id', protocolIds),
    supabase.from('pk_care_plan_medicines').select('*').in('protocol_instance_id', protocolIds),
  ]) : [{ data: [] }, { data: [] }];

  _pkProtocols = protocols.map(pr => _pkReconstructProtocol(pr, allDays || [], allMeds || []));
  _pkEditingPlanId = planId;

  document.getElementById('pk-existing-draft-banner').style.display = 'none';
  document.getElementById('pk-editing-banner').style.display = '';
  document.getElementById('btn-save-pk-plan').textContent = '🌸 Update Care Plan';
  document.getElementById('pk-instr-patient').value   = planRow.instructions_patient || '';
  document.getElementById('pk-instr-therapist').value = planRow.instructions_therapist || '';
  document.getElementById('pk-instr-nurse').value      = planRow.instructions_nurse || '';
  const settingEl = document.querySelector(`input[name="pk-setting"][value="${planRow.setting}"]`);
  if (settingEl) settingEl.checked = true;
  if (planRow.room_type_preference) { const rt = document.getElementById('pk-room-type'); if (rt) rt.value = planRow.room_type_preference; }

  _renderPkChips();
};

// Rebuilds one _pkProtocols entry from its saved DB rows, using the original SOP
// template as the "shape" reference -- a template day with zero matching saved rows
// means that block was skipped (never re-derivable from the days table alone, since a
// skipped block contributes no rows at all).
function _pkReconstructProtocol(pr, allDays, allMeds) {
  const tpl = _pkTemplates.find(t => t.id === pr.template_id);
  const tplDays = (_pkTemplateDays[pr.template_id] || []).slice().sort((a, b) => a.sequence_order - b.sequence_order);
  const days = allDays.filter(d => d.protocol_instance_id === pr.id);
  const meds = allMeds.filter(m => m.protocol_instance_id === pr.id);

  const p = {
    db_id: pr.id,
    template_id: pr.template_id,
    procedure_key: tpl?.procedure_key || pr.protocol_label,
    protocol_label: pr.protocol_label,
    is_reviewed: tpl?.is_reviewed ?? true,
    start_date: days.length ? days.reduce((min, d) => d.planned_date < min ? d.planned_date : min, days[0].planned_date) : pr.start_date,
    blocks: [],
    koshtha: pr.koshtha,
    snehapana_start_dose_ml: pr.snehapana_start_dose_ml,
    snehapana_increment_ml: pr.snehapana_increment_ml || 30,
    custom_formulation_name: pr.custom_formulation_name || null,
    basti_pack_type: pr.basti_pack_type,
    basti_schedule_mode: pr.basti_schedule_mode || 'standard',
    // Session 285 -- pediatric Basti dosing/consent, carried over unchanged when
    // re-opening an already-saved draft for editing.
    pediatric_age_band: pr.pediatric_age_band || null,
    pediatric_dose_ml: pr.pediatric_dose_ml || null,
    pediatric_guardian_consent_obtained: !!pr.pediatric_guardian_consent_obtained,
    pediatric_assent_obtained: !!pr.pediatric_assent_obtained,
    pediatric_shuddhi_tier: pr.pediatric_shuddhi_tier || null,
    // Session 277 -- carried uniformly on every day row for this protocol; any one of
    // them reflects what the doctor entered (or true default) at save time.
    doctor_duration_minutes: days[0]?.doctor_duration_minutes ?? null,
    doctor_man_power: days[0]?.doctor_man_power ?? null,
    doctor_requires_room: days[0]?.doctor_requires_room ?? true,
  };

  tplDays.forEach(td => {
    if (p.procedure_key === 'basti' && td.activity_label === 'Basti administration (daily)') {
      const anuvasanaBlock = {
        phase: td.phase, activity_label: _PK_BASTI_ANUVASANA_LABEL, is_flexible: false, min_days: 0, max_days: 0,
        length: 0, ayush_code: null, mode: 'hospital', bastiDayType: 'anuvasana',
        medicines: meds.filter(m => m.activity_label === _PK_BASTI_ANUVASANA_LABEL).map(m => ({ medicine_name: m.medicine_name, dosage_instructions: m.dosage_instructions })),
      };
      // Session 271 -- reconstruct the structured Niruha formula from its saved
      // basti_component-tagged rows, not the generic medicines array. Session 279
      // -- each classical component can be multiple rows now, plus any extra
      // custom-labeled components (basti_component null, custom_component_label set).
      const niruhaMeds = meds.filter(m => m.activity_label === _PK_BASTI_NIRUHA_LABEL);
      const itemsFor = c => niruhaMeds.filter(m => m.basti_component === c)
        .map(m => ({ name: m.medicine_name || '', qty: m.quantity_value ?? null }));
      const extraLabels = [...new Set(niruhaMeds.filter(m => !m.basti_component && m.custom_component_label).map(m => m.custom_component_label))];
      const niruhaBlock = {
        phase: td.phase, activity_label: _PK_BASTI_NIRUHA_LABEL, is_flexible: false, min_days: 0, max_days: 0,
        length: 0, ayush_code: null, mode: 'hospital', bastiDayType: 'niruha', medicines: [],
        niruhaFormula: {
          formulation_key: '', formula_name: pr.niruha_formula_name || '',
          components: {
            madhu:  itemsFor('madhu').length  ? itemsFor('madhu')  : [{ name: 'Honey', qty: null }],
            lavana: itemsFor('lavana').length ? itemsFor('lavana') : [{ name: 'Saindhava Lavana (Rock Salt)', qty: null }],
            sneha:  itemsFor('sneha').length  ? itemsFor('sneha')  : [{ name: '', qty: null }],
            kalka:  itemsFor('kalka').length  ? itemsFor('kalka')  : [{ name: '', qty: null }],
            kwatha: itemsFor('kwatha').length ? itemsFor('kwatha') : [{ name: '', qty: null }],
            avapa:  itemsFor('avapa').length  ? itemsFor('avapa')  : [{ name: '', qty: null }],
          },
          extra: extraLabels.map(label => ({
            label, unit: niruhaMeds.find(m => m.custom_component_label === label)?.quantity_unit || 'ml',
            items: niruhaMeds.filter(m => m.custom_component_label === label).map(m => ({ name: m.medicine_name || '', qty: m.quantity_value ?? null })),
          })),
        },
      };
      p.blocks.push(anuvasanaBlock, niruhaBlock);
      return;
    }
    const matching = days.filter(d => d.activity_label === td.activity_label);
    const skipped = matching.length === 0;
    const defaultLen = td.day_end - td.day_start + 1;
    p.blocks.push({
      phase: td.phase, activity_label: td.activity_label, is_flexible: td.is_flexible,
      min_days: td.min_days, max_days: td.max_days,
      length: skipped ? 0 : matching.length,
      ayush_code: (matching[0]?.ayush_code) || td.ayush_code,
      mode: skipped ? 'skip' : (matching.every(d => d.location_mode === 'home') ? 'home' : 'hospital'),
      _skipLength: skipped ? (td.min_days || defaultLen) : undefined,
      medicines: meds.filter(m => m.activity_label === td.activity_label).map(m => ({ medicine_name: m.medicine_name, dosage_instructions: m.dosage_instructions, quantity_value: m.quantity_value, quantity_unit: m.quantity_unit })),
    });
  });

  if (p.procedure_key === 'basti' && p.basti_pack_type) _pkRecomputeBastiBlockLengths(p);
  return p;
}

window.savePkCarePlan = async function() {
  if (!_activePatient) { alert('Select a patient first.'); return; }
  if (!_pkProtocols.length) { alert('Select at least one Panchakarma protocol.'); return; }
  // Session 266 -- a Basti protocol with no pack type chosen would silently save with
  // its entire administration phase missing (0 days) -- block the save instead.
  const missingBastiPack = _pkProtocols.find(p => p.procedure_key === 'basti' && !p.basti_pack_type);
  if (missingBastiPack) { alert('Choose a Basti Pack Type (Karma/Kala/Yoga) in Step 2 before saving.'); return; }
  // Session 277 -- same defensive re-check as the Basti pack-type guard above, in case
  // this is ever reached without going through _pkGoToStep()'s own gate.
  const missingSchedule = _pkProtocols.find(p => _pkNeedsManualScheduleInput(p) && (!p.doctor_duration_minutes || !p.doctor_man_power));
  if (missingSchedule) { alert(`"${missingSchedule.protocol_label}" is missing its session duration/man power — enter them in Step 2 before saving.`); return; }
  // Session 285/287 -- a pediatric Basti or Virechana plan cannot save without
  // guardian consent (always required) and, above _PK_PEDIATRIC_ASSENT_MIN_AGE, child
  // assent too -- same hard block as the Basti-pack-type/schedule checks above, never
  // a silent skip. Reused generically across both procedures (both use the exact same
  // pediatric_guardian_consent_obtained/pediatric_assent_obtained columns).
  const _PK_PEDIATRIC_GATED_PROCEDURES = ['basti', 'virechana', 'vamana', 'nasya'];
  if (_pkIsPediatricPatient()) {
    const ageYears = _pkPatientAgeYears();
    const missingPediatricConsent = _pkProtocols.find(p => _PK_PEDIATRIC_GATED_PROCEDURES.includes(p.procedure_key) && (
      !p.pediatric_guardian_consent_obtained ||
      (ageYears >= _PK_PEDIATRIC_ASSENT_MIN_AGE && !p.pediatric_assent_obtained)
    ));
    if (missingPediatricConsent) { alert(`This is a pediatric ${missingPediatricConsent.protocol_label} plan — obtain and check parent/guardian consent (and child assent, if age-appropriate) in Step 2 before saving.`); return; }
    // Session 287/288/289 -- Virechana + Vamana + Nasya: weight-for-age SAM/MAM is a real
    // document contraindication (not just a reduced dose) for all three procedures, so it
    // hard-blocks save the same way consent does, rather than being a warning the doctor
    // could miss.
    const samMamProtocol = _pkProtocols.find(p => ['virechana', 'vamana', 'nasya'].includes(p.procedure_key) && _pkGrowthIsSamMam(_pkGrowthLatestByPatient[_activePatient?.id]));
    if (samMamProtocol) { alert(`This patient's latest Growth Record shows SAM/MAM weight-for-age — ${samMamProtocol.protocol_label} is contraindicated per the pediatric protocol. Remove that protocol or address the growth concern first.`); return; }
    // Virechana-only: the Shuddhi tier has no Vamana equivalent (see Session 288's notes).
    const missingShuddhiTier = _pkProtocols.find(p => p.procedure_key === 'virechana' && !p.pediatric_shuddhi_tier);
    if (missingShuddhiTier) { alert('Assess the Shuddhi dose tier (Uttam/Madhyama/Hina) for this pediatric Virechana plan in Step 2 before saving.'); return; }
  }
  const settingEl = document.querySelector('input[name="pk-setting"]:checked');
  const setting = settingEl ? settingEl.value : 'day_care';

  const btn = document.getElementById('btn-save-pk-plan');
  btn.disabled = true; btn.textContent = 'Saving…';

  // Recomputed fresh (not from cached state) so a save can never disagree with what
  // was actually last shown on screen.
  await window._pkRecomputeStep4();
  const est = _pkComputeEstimate();
  const roomEst = _pkLastRoomEstimate;
  const roomCost = roomEst?.roomCost || 0;
  const total = est.total + roomCost;
  const pct = _admTenantPct.self_pay;
  const advanceSuggested = Math.round(total * pct / 100);
  const roomTypePreference = setting === 'admission' ? (document.getElementById('pk-room-type').value || 'general') : (setting === 'day_care' ? 'general' : null);

  // Session 268 -- editing an existing draft updates that row instead of creating a
  // new one; scope is deliberately limited to status='finalized' plans (see
  // _pkLoadExistingDraft()'s comment) so this never touches an already-billed/
  // already-scheduled plan.
  const isEditing = !!_pkEditingPlanId;
  const planFields = {
    status: 'finalized', setting,
    instructions_patient: document.getElementById('pk-instr-patient').value.trim() || null,
    instructions_therapist: document.getElementById('pk-instr-therapist').value.trim() || null,
    instructions_nurse: document.getElementById('pk-instr-nurse').value.trim() || null,
    room_type_preference: roomTypePreference,
    estimated_room_cost: roomCost,
    estimated_treatment_cost: est.total,
    estimated_total: total,
    advance_pct_applied: pct,
    advance_amount_suggested: advanceSuggested,
    finalized_at: new Date().toISOString(),
  };

  let plan, error, existingAdmissionAdviceId = null;
  if (isEditing) {
    const { data: existing } = await supabase.from('pk_care_plans').select('admission_advice_id').eq('id', _pkEditingPlanId).single();
    existingAdmissionAdviceId = existing?.admission_advice_id || null;
    ({ data: plan, error } = await supabase.from('pk_care_plans').update(planFields).eq('id', _pkEditingPlanId).select('id').single());
  } else {
    ({ data: plan, error } = await supabase.from('pk_care_plans').insert({
      tenant_id: tenantId, patient_id: _activePatient.id, visit_id: _activeVisitId, doctor_id: userId,
      ...planFields,
    }).select('id').single());
  }

  if (error) {
    btn.disabled = false; btn.textContent = isEditing ? '🌸 Update Care Plan' : '🌸 Save Care Plan';
    alert(safeErrorMessage(error, 'Could not save the Panchakarma care plan.')); return;
  }

  for (let pi = 0; pi < _pkProtocols.length; pi++) {
    const p = _pkProtocols[pi];
    // Session 279 -- the Niruha block's own doctor-typed name (whether picked from
    // the standard-formulation dropdown or freely typed for "Custom") lives at the
    // protocol level so reception/therapist/nursing can show it without knowing
    // which block it came from.
    const niruhaBlock = p.blocks.find(b => b.bastiDayType === 'niruha');
    const protoFields = {
      template_id: p.template_id, protocol_label: p.protocol_label,
      start_date: p.start_date, sequence_order: pi + 1,
      // Session 255 -- Koshtha + Snehapana dosing, only meaningful when this protocol
      // actually has a Snehapana block (null otherwise, matches the wizard's own gate).
      koshtha: p.koshtha || null,
      snehapana_start_dose_ml: p.snehapana_start_dose_ml || null,
      snehapana_increment_ml: p.snehapana_increment_ml || 30,
      // Session 266 -- which classical Basti pack (Karma/Kala/Yoga) the day-by-day
      // Anuvasana/Niruha calendar below was generated from; null for every other protocol.
      basti_pack_type: p.basti_pack_type || null,
      basti_schedule_mode: p.basti_pack_type ? (p.basti_schedule_mode || 'standard') : null,
      niruha_formula_name: niruhaBlock?.niruhaFormula?.formula_name || null,
      custom_formulation_name: p.custom_formulation_name || null,
      // Session 285 -- pediatric Basti dosing/consent, null/false for every adult
      // patient and every non-Basti protocol (matches the wizard's own gate).
      pediatric_age_band: p.pediatric_age_band || null,
      pediatric_dose_ml: p.pediatric_dose_ml || null,
      pediatric_guardian_consent_obtained: !!p.pediatric_guardian_consent_obtained,
      pediatric_assent_obtained: !!p.pediatric_assent_obtained,
      pediatric_shuddhi_tier: p.pediatric_shuddhi_tier || null,
    };

    let proto, protoErr;
    if (p.db_id) {
      // Already-saved protocol being re-edited -- update its own row, then replace its
      // days/medicines wholesale (delete+reinsert is simplest and safe here since a
      // status='finalized' plan has no pk_therapy_sessions/bill referencing them yet).
      ({ data: proto, error: protoErr } = await supabase.from('pk_care_plan_protocols').update(protoFields).eq('id', p.db_id).select('id').single());
      if (!protoErr) {
        await supabase.from('pk_care_plan_days').delete().eq('protocol_instance_id', p.db_id);
        await supabase.from('pk_care_plan_medicines').delete().eq('protocol_instance_id', p.db_id);
      }
    } else {
      ({ data: proto, error: protoErr } = await supabase.from('pk_care_plan_protocols').insert({ care_plan_id: plan.id, status: 'pending', ...protoFields }).select('id').single());
      if (!protoErr) p.db_id = proto.id;
    }
    if (protoErr) { console.warn('[doctor] pk_care_plan_protocols save:', protoErr.message); continue; }

    const dayRows = _pkExpandDays(p).map(r => ({
      protocol_instance_id: proto.id, day_number: r.day_number, phase: r.phase,
      activity_label: r.activity_label, is_flexible: r.is_flexible, planned_date: r.planned_date,
      ayush_code: r.ayush_code, status: 'pending', sequence_order: r.sequence_order,
      // Session 257 -- a block in skip mode already contributes zero rows here (its
      // length is 0), so only 'home' vs. 'hospital' ever needs saving.
      location_mode: r.location_mode,
      // Session 277 -- doctor's mandatory manual entry for a protocol with no
      // sop_content_templates hint (null for a hinted protocol -- the reference-table
      // lookup covers it, this column simply stays unused for those rows).
      doctor_duration_minutes: p.doctor_duration_minutes || null,
      doctor_man_power: p.doctor_man_power || null,
      doctor_requires_room: p.doctor_requires_room ?? null,
    }));
    const { error: daysErr } = await supabase.from('pk_care_plan_days').insert(dayRows);
    if (daysErr) console.warn('[doctor] pk_care_plan_days insert:', daysErr.message);

    // Session 254 -- each medicine carries which activity it belongs to (Deepana-Pachana
    // vs. Snehapana vs. the protocol's administration step, etc.), not just the protocol
    // as a whole. Session 257 -- a skipped block's medicines (if any were entered before
    // switching to skip) are deliberately dropped -- the activity isn't happening.
    const medRows = [];
    p.blocks.forEach(b => {
      if (b.mode === 'skip') return;
      // Session 271 -- Niruha's compound formula saves as structured rows (one per
      // medicine, tagged by component) instead of the generic flat medicines list
      // -- b.medicines stays empty for this block. Session 279 -- each classical
      // component can now hold multiple medicines (Kalka/Kwatha especially are
      // classically multi-herb), plus any extra custom-labeled components beyond
      // the classical 6.
      if (b.bastiDayType === 'niruha' && b.niruhaFormula) {
        const f = b.niruhaFormula;
        let seq = 1;
        ['madhu', 'lavana', 'sneha', 'kalka', 'kwatha', 'avapa'].forEach(comp => {
          (f.components[comp] || []).forEach(it => {
            if (!it.name && it.qty == null) return; // nothing entered -- skip
            medRows.push({
              protocol_instance_id: proto.id, activity_label: b.activity_label, ayush_code: b.ayush_code || null,
              medicine_name: it.name || null, dosage_instructions: null, sequence_order: seq++,
              basti_component: comp, quantity_value: it.qty ?? null, quantity_unit: _PK_NIRUHA_COMPONENT_UNIT[comp],
            });
          });
        });
        (f.extra || []).forEach(x => {
          (x.items || []).forEach(it => {
            if (!it.name && it.qty == null) return;
            medRows.push({
              protocol_instance_id: proto.id, activity_label: b.activity_label, ayush_code: b.ayush_code || null,
              medicine_name: it.name || null, dosage_instructions: null, sequence_order: seq++,
              basti_component: null, custom_component_label: x.label || null, quantity_value: it.qty ?? null, quantity_unit: x.unit || 'ml',
            });
          });
        });
        return;
      }
      (b.medicines || []).forEach((m, mi) => {
        medRows.push({
          protocol_instance_id: proto.id, activity_label: b.activity_label, ayush_code: b.ayush_code || null,
          medicine_name: m.medicine_name, dosage_instructions: m.dosage_instructions, sequence_order: mi + 1,
          // Session 281 -- present for the upgraded no-SOP-protocol ingredient rows,
          // undefined (-> null) for a still-bare SOP-content-rich block's list.
          quantity_value: m.quantity_value ?? null, quantity_unit: m.quantity_unit || null,
        });
      });
    });
    if (medRows.length) {
      const { error: medErr } = await supabase.from('pk_care_plan_medicines').insert(medRows);
      if (medErr) console.warn('[doctor] pk_care_plan_medicines insert:', medErr.message);
    }
  }

  await logAudit(isEditing ? 'pk_care_plan_updated' : 'pk_care_plan_created', 'pk_care_plans', plan.id, {
    patient_name: _activePatient?.name, protocols: _pkProtocols.map(p => p.protocol_label), estimated_total: total,
  }, _ctx);

  // Admission-setting plans reuse the proven admission_advice -> create_ipd_admission()
  // flow as-is, so reception.html's existing Admission Requests queue picks this up with
  // zero changes there (it already reads admission_advice by tenant+status, not by which
  // code path created the row). Day Care/OPD have no bed involved -- they get their own
  // lighter reception.html queue instead (sourced from pk_care_plans directly).
  let handoffMsg = `will appear in Reception's Panchakarma Care Plan queue`;
  if (setting === 'admission') {
    const pkDept = _admDepts.find(d => d.name === 'Panchakarma') || null;
    const protocolNames = _pkProtocols.map(p => p.protocol_label).join(', ');
    const adviceFields = {
      department_id: pkDept?.id || null,
      clinical_indication: `Panchakarma Care Plan: ${protocolNames}`,
      expected_duration_days: roomEst?.days || _pkPlanSpanDays().days || null,
      room_type_preference: roomTypePreference,
      nursing_care_notes: document.getElementById('pk-instr-nurse').value.trim() || null,
      estimated_room_cost: roomCost,
      estimated_treatment_cost: est.total,
      estimated_total: total,
      advance_pct_applied: pct,
      advance_amount_suggested: advanceSuggested,
    };

    // Session 268 -- editing a plan that already has an admission_advice row (from its
    // first save) updates that same row instead of creating a second, duplicate
    // Reception queue entry.
    let advice, adviceErr;
    if (existingAdmissionAdviceId) {
      ({ data: advice, error: adviceErr } = await supabase.from('admission_advice').update(adviceFields).eq('id', existingAdmissionAdviceId).select('id').single());
      if (!adviceErr) await supabase.from('admission_advice_items').delete().eq('admission_advice_id', existingAdmissionAdviceId);
    } else {
      ({ data: advice, error: adviceErr } = await supabase.from('admission_advice').insert({
        tenant_id: tenantId, patient_id: _activePatient.id, visit_id: _activeVisitId, doctor_id: userId,
        // Session 210: lets create_ipd_admission() find its way back to this plan and
        // activate it (+ generate real sessions) the moment the admission actually happens.
        pk_care_plan_id: plan.id,
        payer_type: 'self_pay',
        created_by: userId,
        ...adviceFields,
      }).select('id').single());
    }

    if (adviceErr) {
      console.warn('[doctor] admission_advice save (from PK plan):', adviceErr.message);
      handoffMsg = `could not be sent to Reception automatically (${safeErrorMessage(adviceErr, 'error')}) — please use the Admission Advice tab instead`;
    } else {
      const items = est.lines.filter(l => l.priced).map(l => ({
        tenant_id: tenantId, admission_advice_id: advice.id, fee_type: l.code,
        description: l.label, sessions_count: l.days, unit_price_snapshot: l.unitPrice, line_total: l.lineTotal,
      }));
      if (items.length) {
        const { error: itemsErr } = await supabase.from('admission_advice_items').insert(items);
        if (itemsErr) console.warn('[doctor] admission_advice_items insert (from PK plan):', itemsErr.message);
      }
      if (!existingAdmissionAdviceId) await supabase.from('pk_care_plans').update({ admission_advice_id: advice.id }).eq('id', plan.id);
      handoffMsg = existingAdmissionAdviceId ? `updated in Reception's Admission Requests queue` : `sent to Reception's Admission Requests queue`;
    }
  }

  _pkPlanSaved = true;
  // Session 268 -- keep pointing at this same plan id (whether it was just created or
  // just updated) so a second save later in the same wizard session correctly continues
  // updating it, instead of silently creating a duplicate care plan.
  _pkEditingPlanId = plan.id;
  btn.disabled = false; btn.textContent = '🌸 Update Care Plan';
  const status = document.getElementById('pk-save-status');
  status.style.display = '';
  status.textContent = `✓ ${isEditing ? 'Updated' : 'Saved'} — ${_activePatient?.name}'s Panchakarma care plan (${_pkProtocols.length} protocol${_pkProtocols.length > 1 ? 's' : ''}) is finalized and ${handoffMsg}.`;
};

// ── Disposition change ────────────────────────────
window.onDispChange = function(val) {
  document.querySelectorAll('.disp-opt').forEach(el => el.classList.remove('selected'));
  const radio = document.querySelector(`input[name=disposition][value="${val}"]`);
  if (radio) radio.closest('.disp-opt').classList.add('selected');

  // Show/hide referral details section
  document.getElementById('referral-section').style.display = val === 'referral' ? '' : 'none';

  const completeBtn = document.getElementById('btn-complete');
  if (val === 'pk') {
    completeBtn.textContent = '✓ Complete & Plan Panchakarma';
    if (_hasPK) _switchTab('pk');
  } else if (val === 'admission') {
    completeBtn.textContent = '✓ Complete & Initiate Admission';
    if (_hasAdm) _switchTab('adm');
  } else if (val === 'referral') {
    completeBtn.textContent = '✓ Complete & Generate Referral';
  } else {
    completeBtn.textContent = '✓ Complete & Send to Pharmacy';
  }
};

// ── NAMASTE + ICD-10 dual-coding search ──────────
function _dxSearch(inputId, dropdownId, badgeId, table, codeField, termField, subField, onSelect) {
  const inp = document.getElementById(inputId);
  const dd  = document.getElementById(dropdownId);
  let _timer;

  inp.addEventListener('input', () => {
    clearTimeout(_timer);
    const q = inp.value.trim();
    if (q.length < 2) { dd.classList.remove('open'); dd.innerHTML = ''; return; }
    _timer = setTimeout(async () => {
      const orStr = `${codeField}.ilike.%${q}%,${termField}.ilike.%${q}%${subField ? ',' + subField + '.ilike.%' + q + '%' : ''}`;
      const { data, error: dbErr } = await supabase.from(table)
        .select('*')
        .or(orStr)
        .limit(8);
      if (dbErr) { console.error('dx-search error:', table, dbErr); }
      if (!data || data.length === 0) {
        dd.innerHTML = '<div class="dx-item" style="color:var(--text-mid);cursor:default">No matches found</div>';
        dd.classList.add('open'); return;
      }
      dd.innerHTML = data.map(r => {
        const code  = r[codeField] || '';
        const term  = r[termField] || '';
        const sub   = subField ? (r[subField] || '') : '';
        return `<div class="dx-item" data-code="${_esc(code)}" data-term="${_esc(term)}" data-row='${_esc(JSON.stringify(r))}'>
          <span class="dx-item-code">${_esc(code)}</span><span class="dx-item-term">${_esc(term)}</span>
          ${sub ? `<div class="dx-item-sub">${_esc(sub)}</div>` : ''}
        </div>`;
      }).join('');
      dd.querySelectorAll('.dx-item[data-code]').forEach(el => {
        el.addEventListener('mousedown', e => {
          e.preventDefault();
          const row = JSON.parse(el.dataset.row);
          onSelect(row);
          dd.classList.remove('open'); dd.innerHTML = '';
          inp.value = '';
        });
      });
      dd.classList.add('open');
    }, 280);
  });

  inp.addEventListener('blur', () => setTimeout(() => { dd.classList.remove('open'); }, 200));
}

function _initNamaste() {
  _dxSearch(
    'd-namc-search', 'd-namc-dropdown', 'd-namc-badge',
    'namaste_codes', 'namc_code', 'namc_term', 'name_english',
    row => {
      document.getElementById('d-namc-code').value  = row.namc_code || '';
      document.getElementById('d-namc-label').value = row.namc_term || '';
      document.getElementById('d-icd11-code').value = row.name_english || '';
      // Auto-fill modern diagnosis with English name (if empty)
      const modEl = document.getElementById('d-modern');
      if (!modEl.value) modEl.value = row.name_english || '';
      // §23y — notifiable disease check via English name
      _checkNotifiable(null, row.name_english || '');
      // Show badge
      const badge = document.getElementById('d-namc-badge');
      const icd11 = row.name_english ? `· ${row.name_english}` : '';
      badge.style.display = '';
      badge.innerHTML = `<div class="dx-badge">
        <span class="dx-badge-code">${_esc(row.namc_code)}</span>
        <span class="dx-badge-label">${_esc(row.namc_term)}</span>
        <span class="dx-badge-icd11">${_esc(icd11)}</span>
        <button class="dx-badge-clear" title="Clear" data-onclick="_clearNamaste">×</button>
      </div>`;
    }
  );
}

window._clearNamaste = function() {
  ['d-namc-code','d-namc-label','d-icd11-code','d-namc-search'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('d-namc-badge').style.display = 'none';
  document.getElementById('notifiable-alert').style.display = 'none';
};

// §23y — Notifiable disease detection (ROM.1 ATWC)
const NOTIFIABLE_ICD = [
  { prefix:'A00', name:'Cholera' },
  { prefix:'A01', name:'Typhoid / Paratyphoid' },
  { prefix:'A02', name:'Salmonella Infection' },
  { prefix:'A15', name:'Respiratory Tuberculosis' },
  { prefix:'A16', name:'Pulmonary Tuberculosis' },
  { prefix:'A17', name:'TB of Nervous System' },
  { prefix:'A18', name:'TB of Other Organs' },
  { prefix:'A19', name:'Miliary Tuberculosis' },
  { prefix:'A27', name:'Leptospirosis' },
  { prefix:'A30', name:'Leprosy (Hansen\'s Disease)' },
  { prefix:'A33', name:'Neonatal Tetanus' },
  { prefix:'A34', name:'Obstetrical Tetanus' },
  { prefix:'A35', name:'Other Tetanus' },
  { prefix:'A36', name:'Diphtheria' },
  { prefix:'A37', name:'Whooping Cough (Pertussis)' },
  { prefix:'A80', name:'Acute Poliomyelitis' },
  { prefix:'A82', name:'Rabies' },
  { prefix:'A90', name:'Dengue Fever' },
  { prefix:'A91', name:'Dengue Haemorrhagic Fever' },
  { prefix:'A95', name:'Yellow Fever' },
  { prefix:'B01', name:'Chickenpox / Varicella' },
  { prefix:'B05', name:'Measles' },
  { prefix:'B16', name:'Acute Hepatitis B' },
  { prefix:'B17', name:'Other Acute Viral Hepatitis' },
  { prefix:'B50', name:'Malaria (Plasmodium falciparum)' },
  { prefix:'B51', name:'Malaria (P. vivax)' },
  { prefix:'B52', name:'Malaria (P. malariae)' },
  { prefix:'B53', name:'Other Malaria' },
  { prefix:'B54', name:'Unspecified Malaria' },
  { prefix:'U07', name:'COVID-19' },
];
const NOTIFIABLE_KEYWORDS = ['cholera','typhoid','tuberculosis','leprosy','rabies','dengue','malaria','measles','diphtheria','pertussis','whooping','polio','tetanus','hepatitis','leptospirosis','plague','meningitis','encephalitis','yellow fever','chickenpox','varicella'];

window._checkNotifiable = function(icd10Code, termText) {
  const banner = document.getElementById('notifiable-alert');
  const nameEl = document.getElementById('notifiable-disease-name');
  let match = null;
  if (icd10Code) {
    match = NOTIFIABLE_ICD.find(n => icd10Code.startsWith(n.prefix));
  }
  if (!match && termText) {
    const lower = termText.toLowerCase();
    const kw = NOTIFIABLE_KEYWORDS.find(k => lower.includes(k));
    if (kw) match = { name: termText };
  }
  if (match) {
    banner.style.display = '';
    nameEl.textContent   = `Disease identified: ${match.name}`;
  } else {
    banner.style.display = 'none';
  }
};

function _initIcd10() {
  _dxSearch(
    'd-icd10-search', 'd-icd10-dropdown', 'd-icd10-badge',
    'icd10_codes', 'icd10_code', 'icd10_term', 'chapter_name',
    row => {
      document.getElementById('d-icd10-code').value  = row.icd10_code || '';
      document.getElementById('d-icd10-label').value = row.icd10_term || '';
      document.getElementById('d-icd').value         = row.icd10_code || '';
      // §23y — notifiable disease check via ICD-10
      _checkNotifiable(row.icd10_code || '', row.icd10_term || '');
      const badge = document.getElementById('d-icd10-badge');
      badge.style.display = '';
      badge.innerHTML = `<div class="dx-badge">
        <span class="dx-badge-code">${_esc(row.icd10_code)}</span>
        <span class="dx-badge-label">${_esc(row.icd10_term)}</span>
        <span class="dx-badge-icd11">${_esc(row.chapter_name || '')}</span>
        <button class="dx-badge-clear" title="Clear" data-onclick="_clearIcd10">×</button>
      </div>`;
    }
  );
}

window._clearIcd10 = function() {
  ['d-icd10-code','d-icd10-label','d-icd10-search','d-icd'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('d-icd10-badge').style.display = 'none';
};

// ── Differential diagnosis rows ───────────────────
window.addDiff = function() {
  const id = Date.now();
  const li = document.createElement('li');
  li.className = 'diff-item';
  li.id = `diff-${id}`;
  li.innerHTML = `
    <input type="text" placeholder="Differential diagnosis to be ruled out…"/>
    <select>
      <option value="">— Likelihood —</option>
      <option>Likely</option><option>Possible</option><option>Unlikely</option><option>Ruled out</option>
    </select>
    <button class="btn-rm-diff" title="Remove this differential" aria-label="Remove this differential diagnosis" data-onclick="_removeClosest" data-onclick-a0="@this" data-onclick-a1="li">×</button>
  `;
  document.getElementById('diff-list').appendChild(li);
};

// ── Red flag chips ────────────────────────────────
document.querySelectorAll('.flag-chip').forEach(chip => {
  chip.addEventListener('click', function() {
    this.classList.toggle('on');
    const val  = this.dataset.val;
    const on   = this.classList.contains('on');
    const ta   = document.getElementById('as-redflags');
    const curr = ta.value;
    ta.value = on
      ? (curr ? curr + '\n' + val : val)
      : curr.split('\n').filter(l => l !== val).join('\n');
  });
});

// ── Follow-up quick select ────────────────────────
window.setFollowup = function(days) {
  if (!days) return;
  const d = new Date();
  d.setDate(d.getDate() + parseInt(days));
  document.getElementById('fu-date').value = localDateStr(d);
};

// ── Pathya / Apathya chips ────────────────────────
['pathya-chips', 'apathya-chips'].forEach(containerId => {
  const container = document.getElementById(containerId);
  if (!container) return;
  const ta = container.closest('.section')?.querySelector('textarea');
  if (!ta) return;
  container.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', function() {
      this.classList.toggle('on');
      const val  = this.dataset.val;
      const on   = this.classList.contains('on');
      const curr = ta.value;
      ta.value = on
        ? (curr ? curr + '\n' + val : val)
        : curr.split('\n').filter(l => l !== val).join('\n');
    });
  });
});

// ── Prescription rows ─────────────────────────────
let _rxRows = [];

document.getElementById('btn-add-rx').addEventListener('click', () => addRxRow());

function addRxRow(data = {}) {
  const id = Date.now();
  _rxRows.push(id);

  const div = document.createElement('div');
  div.className = 'rx-row';
  div.id = `rx-${id}`;
  div.innerHTML = `
    <div class="rx-col">
      <label>Medicine Name</label>
      <div class="rx-wrap">
        <input type="text" class="rx-name" placeholder="Start typing…" value="${_esc(data.name||'')}" autocomplete="off"/>
        <div class="typeahead" id="ta-${id}"></div>
      </div>
      <div class="stock-badge" id="sb-${id}" style="display:none"></div>
    </div>
    <div class="rx-col">
      <label>Dosage</label>
      <input type="text" class="rx-dose" placeholder="e.g. 3g" value="${_esc(data.dose||'')}"/>
    </div>
    <div class="rx-col">
      <label>Frequency</label>
      <select class="rx-freq">
        <option value="OD" ${data.freq==='OD'?'selected':''}>OD</option>
        <option value="BD" ${data.freq==='BD'?'selected':''}>BD</option>
        <option value="TDS" ${data.freq==='TDS'?'selected':''}>TDS</option>
        <option value="QID" ${data.freq==='QID'?'selected':''}>QID</option>
        <option value="SOS" ${data.freq==='SOS'?'selected':''}>SOS</option>
        <option value="HS" ${data.freq==='HS'?'selected':''}>HS</option>
        <option value="QAM" ${data.freq==='QAM'?'selected':''}>Morning</option>
        <option value="QPM" ${data.freq==='QPM'?'selected':''}>Evening</option>
      </select>
    </div>
    <div class="rx-col">
      <label>Duration</label>
      <input type="text" class="rx-dur" placeholder="e.g. 30d" value="${_esc(data.dur||'')}"/>
    </div>
    <div class="rx-col">
      <label>Anupana (Vehicle)</label>
      <input type="text" class="rx-anupana" placeholder="Warm water, Milk…" value="${_esc(data.anupana||'')}"/>
    </div>
    <div class="rx-col">
      <!-- 24 Aug 2026 (Session 182): prescription_items.timing existed as a DB column and
           was even part of buildMedicationRequest's dosageInstruction.additionalInstruction
           mapping candidates, but no form field ever wrote to it -- always NULL. -->
      <label>Timing</label>
      <input type="text" class="rx-timing" placeholder="Before food, After food…" value="${_esc(data.timing||'')}"/>
    </div>
    <button class="btn-rm-rx" title="Remove this medicine" aria-label="Remove this medicine row" data-onclick="_removeRxRowFromAttr" data-onclick-a0="${id}">×</button>
  `;

  document.getElementById('rx-rows').appendChild(div);

  const nameInput = div.querySelector('.rx-name');
  const ta = document.getElementById(`ta-${id}`);
  const sb = document.getElementById(`sb-${id}`);

  nameInput.addEventListener('input', function() {
    _updateCompleteBtn();
    const q = this.value.toLowerCase().trim();
    if (q.length < 2 || !_inventory.length) { ta.classList.remove('show'); return; }
    const results = _inventory.filter(i => i.medicine.name.toLowerCase().includes(q)).slice(0, 8);
    if (!results.length) { ta.classList.remove('show'); return; }
    ta.innerHTML = results.map(i => {
      const stock = i.stock_quantity;
      const cls   = stock <= 0 ? 'stock-out' : stock < 10 ? 'stock-low' : 'stock-in';
      const label = stock <= 0 ? 'Out of Stock' : stock < 10 ? `Low (${stock})` : 'In Stock';
      return `<div class="ta-item" data-name="${_esc(i.medicine.name)}" data-stock="${stock}" data-mrp="${i.mrp||0}" data-cls="${cls}" data-label="${_esc(label)}">
        <span class="ta-name">${_esc(i.medicine.name)}</span>
        <div class="ta-right">
          <span class="ta-mrp">₹${i.mrp||0}</span>
          <span class="stock-badge ${cls}">${label}</span>
        </div>
      </div>`;
    }).join('');
    ta.classList.add('show');
  });

  ta.addEventListener('click', e => {
    const item = e.target.closest('.ta-item');
    if (!item) return;
    nameInput.value = item.dataset.name;
    sb.className = `stock-badge ${item.dataset.cls}`;
    sb.textContent = item.dataset.label;
    sb.style.display = 'inline-block';
    ta.classList.remove('show');
    _updateCompleteBtn();
    _checkDDI();
  });

  nameInput.addEventListener('blur', () => setTimeout(() => ta.classList.remove('show'), 200));

  // If row was added with a pre-filled name (e.g. from suggestion card), enable button immediately
  if (data.name) { _updateCompleteBtn(); _checkDDI(); }
}

window.addRxRow = addRxRow;

// Enable Complete button only when at least one named medicine row exists
function _updateCompleteBtn() {
  const hasRx = [...document.querySelectorAll('#rx-rows .rx-name')]
    .some(inp => inp.value.trim().length > 0);
  document.getElementById('btn-complete').disabled = !hasRx;
}

// ── Drug-Drug Interaction (DDI) Check — MOM.4 ────────────────────
const _DDI_PAIRS = [
  { drugs:['ashwagandha','withania'], interacts:['lorazepam','diazepam','clonazepam','alprazolam','zolpidem','phenobarbitone','valproate','clonazepam'], msg:'Ashwagandha + CNS sedatives → additive sedation; monitor for excess CNS depression.' },
  { drugs:['ashwagandha','withania'], interacts:['levothyroxine','thyronorm','eltroxin','thyroxine'], msg:'Ashwagandha may alter thyroid hormone levels; monitor TSH when combined.' },
  { drugs:['guggulu','guggul'], interacts:['levothyroxine','thyronorm','propylthiouracil','carbimazole'], msg:'Guggulu affects thyroid hormone synthesis; monitor thyroid function.' },
  { drugs:['guggulu','guggul'], interacts:['warfarin','acitrom','heparin','aspirin','clopidogrel'], msg:'Guggulu may potentiate anticoagulant effect; monitor INR and bleeding risk.' },
  { drugs:['triphala','haritaki','amalaki','bibhitaki','amla'], interacts:['warfarin','acitrom','heparin','aspirin','clopidogrel'], msg:'Triphala/Amla may increase bleeding risk with anticoagulants; monitor INR.' },
  { drugs:['shatavari','asparagus'], interacts:['furosemide','hydrochlorothiazide','spironolactone','torsemide'], msg:'Shatavari has mild diuretic properties; additive diuretic effect — watch electrolytes.' },
  { drugs:['brahmi','bacopa'], interacts:['phenobarbitone','phenytoin','valproate','carbamazepine','levetiracetam'], msg:'Brahmi may have additive CNS depressant effects with antiepileptics; monitor closely.' },
  { drugs:['punarnava','boerhavia'], interacts:['furosemide','hydrochlorothiazide','spironolactone'], msg:'Punarnava enhances diuretic effect; watch for electrolyte imbalance.' },
  { drugs:['punarnava','boerhavia'], interacts:['lithium'], msg:'Diuretic herbs may reduce lithium excretion or increase toxicity; monitor lithium levels.' },
  { drugs:['yashtimadhu','licorice','glycyrrhiza'], interacts:['amlodipine','atenolol','metoprolol','ramipril','enalapril','losartan','telmisartan'], msg:'Yashtimadhu (Licorice) causes sodium retention and can raise BP; may reduce antihypertensive efficacy.' },
  { drugs:['yashtimadhu','licorice','glycyrrhiza'], interacts:['prednisolone','dexamethasone','hydrocortisone','betamethasone'], msg:'Yashtimadhu potentiates corticosteroid effect; monitor for Cushingoid features.' },
  { drugs:['haridra','curcumin','turmeric'], interacts:['warfarin','acitrom','heparin','aspirin','clopidogrel'], msg:'Haridra/Curcumin inhibits platelet aggregation; increased bleeding risk with anticoagulants.' },
  { drugs:['haridra','curcumin'], interacts:['metformin','glibenclamide','glipizide','sitagliptin','insulin'], msg:'Haridra may potentiate hypoglycaemic effect; monitor blood glucose closely.' },
  { drugs:['methi','fenugreek','trigonella'], interacts:['metformin','glibenclamide','glipizide','insulin'], msg:'Methi seeds have hypoglycaemic activity; risk of additive glucose-lowering with antidiabetics.' },
  { drugs:['karela','bitter melon','momordica'], interacts:['metformin','glibenclamide','glipizide','insulin'], msg:'Karela has insulin-like effect; risk of hypoglycaemia when combined with antidiabetics.' },
  { drugs:['shunthi','ginger','zingiber'], interacts:['warfarin','aspirin','clopidogrel','heparin'], msg:'Ginger has mild antiplatelet effect; increased bleeding risk with anticoagulants.' },
  { drugs:['pushkarmool','inula'], interacts:['digoxin'], msg:'Pushkarmool may potentiate digoxin activity; monitor for digoxin toxicity.' },
  { drugs:['arjuna','terminalia arjuna'], interacts:['digoxin','warfarin','amiodarone'], msg:'Arjuna has cardiac glycoside-like activity; potential additive effect with cardiac medications.' },
  { drugs:['kali mirch','piperine','black pepper','marich'], interacts:['phenytoin','carbamazepine','cyclosporine','rifampicin'], msg:'Piperine inhibits CYP3A4 metabolism; may increase plasma levels of certain drugs.' },
  { drugs:['vijayasar','pterocarpus'], interacts:['metformin','glibenclamide','insulin'], msg:'Vijayasar has significant antidiabetic activity; risk of hypoglycaemia when combined.' },
];

function _checkDDI() {
  const names = [...document.querySelectorAll('#rx-rows .rx-name')]
    .map(i => i.value.trim().toLowerCase()).filter(Boolean);
  if (names.length < 2) { document.getElementById('ddi-warn').style.display='none'; return; }
  const alerts = [];
  for (const pair of _DDI_PAIRS) {
    const hasDrug = names.some(n => pair.drugs.some(d => n.includes(d)));
    const hasInteract = names.some(n => pair.interacts.some(d => n.includes(d)));
    if (hasDrug && hasInteract) alerts.push(pair.msg);
  }
  const warn = document.getElementById('ddi-warn');
  if (alerts.length) {
    document.getElementById('ddi-warn-text').textContent = alerts.join(' | ');
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
}

window.removeRxRow = function(id) {
  document.getElementById(`rx-${id}`)?.remove();
  _rxRows = _rxRows.filter(r => r !== id);
  _updateCompleteBtn();
  _checkDDI();
};

// ── Suggested medicines from NAMC diagnosis ───────
async function refreshRxSuggestions() {
  const namcCode  = document.getElementById('d-namc-code').value.trim();
  const namcLabel = document.getElementById('d-namc-label').value.trim();
  const panel     = document.getElementById('rx-suggestions');
  const list      = document.getElementById('rx-sugg-list');

  if (!namcCode) { panel.style.display = 'none'; return; }

  // 1. Inventory matches (local, fast)
  const inventoryMatches = _inventory.filter(i => {
    const inds = i.medicine?.indications;
    return Array.isArray(inds) && inds.includes(namcCode);
  });

  // 2. Classical formulations from DB (ayush_formulations via junction)
  const { data: classicalRows } = await supabase
    .from('formulation_indications')
    .select('formulation:ayush_formulations(id,name_common,name_sanskrit,ingredients,standard_dosage,dosage_unit,anupana,classical_source,publication_ref)')
    .eq('namc_code', namcCode);
  const classicalMatches = (classicalRows || []).map(r => r.formulation).filter(Boolean);

  if (!inventoryMatches.length && !classicalMatches.length) { panel.style.display = 'none'; return; }

  document.getElementById('rx-sugg-label').textContent = namcLabel || namcCode;

  let html = '';

  // ── Inventory section ──
  if (inventoryMatches.length) {
    html += `<div class="sugg-section-label">From your pharmacy</div>`;
    html += inventoryMatches.map(i => {
      const m        = i.medicine;
      const stock    = i.stock_quantity;
      const stockCls = stock <= 0 ? 'stock-out' : stock < 10 ? 'stock-low' : 'stock-in';
      const stockLbl = stock <= 0 ? 'Out of stock' : stock < 10 ? `Low (${stock})` : `${stock} in stock`;
      const anupana  = (m.anupana || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const dose     = (m.dosage_text || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const ref      = m.classical_reference || '';
      const nameEsc  = m.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const tip      = [m.anupana && `Anupana: ${m.anupana}`, m.dosage_text && `Dosage: ${m.dosage_text}`, ref && `Ref: ${ref}`].filter(Boolean).join(' · ');
      return `<div class="rx-sugg-card" data-onclick="_addRxRowFromAttr" data-onclick-a0="${_esc(nameEsc)}" data-onclick-a1="${_esc(anupana)}" data-onclick-a2="${_esc(dose)}" title="${tip}">
        <div class="rx-sugg-card-name">${m.name}</div>
        <div class="rx-sugg-card-meta"><span class="stock-badge ${stockCls}" style="font-size:10px">${stockLbl}</span>${m.anupana ? ` · ${m.anupana}` : ''}</div>
        ${m.dosage_text || ref ? `<div class="rx-sugg-card-meta" style="font-style:italic">${[m.dosage_text, ref].filter(Boolean).join(' · ')}</div>` : ''}
        <div class="rx-sugg-card-add">+ Add to prescription</div>
      </div>`;
    }).join('');
  }

  // ── Classical formulations section ──
  if (classicalMatches.length) {
    html += `<div class="sugg-section-label sugg-section-classical">Classical reference · AFI/API · Source: PCIM&H, Ministry of AYUSH</div>`;
    html += classicalMatches.map(f => {
      const nameEsc = (f.name_common || f.name_sanskrit).replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const dose    = `${f.standard_dosage || ''} ${f.dosage_unit || ''}`.trim().replace(/'/g, "\\'");
      const anupana = (f.anupana || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const ingr    = (f.ingredients || []).slice(0, 4).join(', ') + ((f.ingredients?.length > 4) ? ` +${f.ingredients.length - 4} more` : '');
      return `<div class="rx-sugg-card rx-sugg-classical" data-onclick="_addRxRowFromAttr" data-onclick-a0="${_esc(nameEsc)}" data-onclick-a1="${_esc(anupana)}" data-onclick-a2="${_esc(dose)}" title="${f.publication_ref || ''}">
        <div class="rx-sugg-card-name">${f.name_common} <span style="font-size:10px;font-weight:400;opacity:.7">${f.name_sanskrit || ''}</span></div>
        ${ingr ? `<div class="rx-sugg-card-meta">${ingr}</div>` : ''}
        ${dose ? `<div class="rx-sugg-card-meta">Dose: ${dose}${f.anupana ? ` · ${f.anupana}` : ''}</div>` : ''}
        <div class="rx-sugg-card-meta" style="font-style:italic">📖 ${f.classical_source || 'AFI'}</div>
        <div class="rx-sugg-card-add">+ Add to prescription</div>
      </div>`;
    }).join('');
  }

  list.innerHTML = html;
  panel.style.display = '';
}

function _getRxData() {
  return [...document.querySelectorAll('#rx-rows .rx-row')].map(row => ({
    name:    row.querySelector('.rx-name')?.value?.trim()    || '',
    dose:    row.querySelector('.rx-dose')?.value?.trim()    || '',
    freq:    row.querySelector('.rx-freq')?.value            || '',
    dur:     row.querySelector('.rx-dur')?.value?.trim()     || '',
    anupana: row.querySelector('.rx-anupana')?.value?.trim() || '',
    timing:  row.querySelector('.rx-timing')?.value?.trim()  || ''
  })).filter(r => r.name);
}

// ── Collect differential list ─────────────────────
function _getDiffList() {
  return [...document.querySelectorAll('#diff-list .diff-item')].map(li => ({
    diagnosis:  li.querySelector('input[type=text]')?.value?.trim() || '',
    likelihood: li.querySelector('select')?.value || ''
  })).filter(d => d.diagnosis);
}

// ── Complete consultation ─────────────────────────
// Session 127 -- both completeConsultation() (normal doctor / reviewing
// professor) and submitForReview() (trainee) need the exact same ~90-field
// collection off the consultation form; extracted so the trainee's draft and
// the professor's own consultation are always built from one source, not two
// copies that could quietly drift apart. Pure DOM reads except for the one
// visits.update side effect (chief_complaint/pain_score), which is harmless
// and correct to run regardless of who's submitting.
async function _collectConsultationFields() {
  const disposition = document.querySelector('input[name=disposition]:checked')?.value || 'opd';
  const chiefComplaint = document.getElementById('h-complaint').value.trim();

  // chief_complaint and pain_score live in visits table, not consultation_notes
  const painVal = document.getElementById('h-pain-score').value;
  const visitUpd = { chief_complaint: chiefComplaint || undefined };
  if (painVal !== '') visitUpd.pain_score = parseInt(painVal);
  if (Object.keys(visitUpd).length) {
    await supabase.from('visits').update(visitUpd).eq('id', _activeVisitId);
  }

  const notes = {
      // History
      duration:            document.getElementById('h-duration').value.trim(),
      severity:            document.getElementById('h-severity').value,
      onset:               document.getElementById('h-onset').value,
      progression:         document.getElementById('h-progression').value,
      aggravating_factors: document.getElementById('h-aggravating').value.trim(),
      relieving_factors:   document.getElementById('h-relieving').value.trim(),
      associated_symptoms: document.getElementById('h-associated').value.trim(),
      history_notes:       document.getElementById('h-history').value.trim(),
      // Past history
      past_dm:             document.getElementById('ph-dm').value,
      past_htn:            document.getElementById('ph-htn').value,
      past_thyroid:        document.getElementById('ph-thyroid').value,
      past_surgery:        document.getElementById('ph-surgery').value.trim(),
      past_other:          document.getElementById('ph-other').value.trim(),
      // Drug/Allergy
      current_medications: document.getElementById('dh-current').value.trim(),
      allergies:           document.getElementById('dh-allergy').value.trim(),
      adr:                 document.getElementById('dh-adr').value.trim(),
      family_history:      document.getElementById('fh-notes').value.trim(),
      // Personal
      diet_type:           document.getElementById('pers-diet').value,
      sleep_pattern:       document.getElementById('pers-sleep').value,
      exercise_level:      document.getElementById('pers-exercise').value,
      bowel_habits:        document.getElementById('pers-bowel').value,
      appetite:            document.getElementById('pers-appetite').value,
      addiction:           document.getElementById('pers-addiction').value,
      occupation:          document.getElementById('pers-occupation').value.trim(),
      // Ayurveda history
      prakriti:            document.getElementById('ay-prakriti').value,
      agni_history:        document.getElementById('ay-agni').value,
      koshta:              document.getElementById('ay-koshta').value,
      nidra:               document.getElementById('ay-nidra').value,
      nidana:              document.getElementById('ay-nidana').value.trim(),
      ahara:               document.getElementById('ay-ahara').value.trim(),
      vihara:              document.getElementById('ay-vihara').value.trim(),
      // Nidana Panchaka (NABH AAC.3)
      purvarupa:           document.getElementById('np-purvarupa').value.trim(),
      rupa:                document.getElementById('np-rupa').value.trim(),
      samprapti:           document.getElementById('np-samprapti').value.trim(),
      upashaya:            document.getElementById('np-upashaya').value.trim(),
      // Modern vitals
      bp_systolic:         parseInt(document.getElementById('v-bp-s').value)    || null,
      bp_diastolic:        parseInt(document.getElementById('v-bp-d').value)    || null,
      pulse_rate:          parseInt(document.getElementById('v-pulse').value)   || null,
      temperature:         parseFloat(document.getElementById('v-temp').value)  || null,
      weight:              parseFloat(document.getElementById('v-weight').value) || null,
      spo2:                parseInt(document.getElementById('v-spo2').value)    || null,
      resp_rate:           parseInt(document.getElementById('v-rr').value)      || null,
      // Systemic
      sys_cvs:             document.getElementById('sys-cvs').value,
      sys_rs:              document.getElementById('sys-rs').value,
      sys_cns:             document.getElementById('sys-cns').value,
      sys_pa:              document.getElementById('sys-pa').value,
      sys_msk:             document.getElementById('sys-msk').value,
      sys_skin:            document.getElementById('sys-skin').value,
      exam_modern_notes:   document.getElementById('exam-modern-notes').value.trim(),
      // Ashtasthana
      nadi:                document.getElementById('a-nadi').value,
      mala:                document.getElementById('a-mala').value,
      mutra:               document.getElementById('a-mutra').value,
      jihwa:               document.getElementById('a-jihwa').value,
      shabda:              document.getElementById('a-shabda').value,
      sparsha:             document.getElementById('a-sparsha').value,
      druk:                document.getElementById('a-druk').value,
      akriti:              document.getElementById('a-akriti').value,
      // Vikruti
      vata_state:          document.getElementById('d-vata').value,
      pitta_state:         document.getElementById('d-pitta').value,
      kapha_state:         document.getElementById('d-kapha').value,
      agni_state:          document.getElementById('d-agni').value,
      ama_state:           document.getElementById('d-ama').value,
      exam_ayurveda_notes: document.getElementById('exam-ayurveda-notes').value.trim(),
      // Dashavidha Pariksha (NABH Ayush Standard)
      dasha_vikriti:        document.getElementById('dasha-vikriti').value.trim(),
      dasha_sara:           document.getElementById('dasha-sara').value,
      dasha_samhanana:      document.getElementById('dasha-samhanana').value,
      dasha_pramana:        document.getElementById('dasha-pramana').value,
      dasha_satmya:         document.getElementById('dasha-satmya').value,
      dasha_satva:          document.getElementById('dasha-satva').value,
      dasha_vaya:           document.getElementById('dasha-vaya').value,
      dasha_ahara_shakti:   document.getElementById('dasha-ahara').value,
      dasha_vyayama_shakti: document.getElementById('dasha-vyayama').value,
      // Assessment
      provisional_modern:  document.getElementById('as-provisional-modern').value.trim(),
      provisional_ayurveda:document.getElementById('as-provisional-ayurveda').value.trim(),
      differential_list:   _getDiffList(),
      red_flags:           document.getElementById('as-redflags').value.trim(),
      inv_lab:             document.getElementById('as-inv-lab').value.trim(),
      inv_imaging:         document.getElementById('as-inv-imaging').value.trim(),
      inv_ayurveda:        document.getElementById('as-inv-ayurveda').value.trim(),
      clinical_reasoning:  document.getElementById('as-reasoning').value.trim(),
      // Diagnosis
      modern_diagnosis:      document.getElementById('d-modern').value.trim(),
      ayurveda_diagnosis:    document.getElementById('d-ayurveda').value.trim() || document.getElementById('d-namc-label').value.trim(),
      diagnosis_namc_code:   document.getElementById('d-namc-code').value.trim(),
      diagnosis_namc_label:  document.getElementById('d-namc-label').value.trim(),
      diagnosis_icd10_code:  document.getElementById('d-icd10-code').value.trim(),
      diagnosis_icd10_label: document.getElementById('d-icd10-label').value.trim(),
      diagnosis_certainty:   document.getElementById('d-certainty').value,
      clinical_notes:        document.getElementById('d-notes').value.trim(),
      // Prescription
      prescription_json:   _getRxData(),
      rx_instructions:     document.getElementById('rx-instructions').value.trim(),
      // Advice
      pathya:              document.getElementById('adv-pathya').value.trim(),
      apathya:             document.getElementById('adv-apathya').value.trim(),
      followup_date:       document.getElementById('fu-date').value || null,
      followup_notes:      document.getElementById('fu-notes').value.trim(),
      // Disposition
      disposition,
      disp_notes:          document.getElementById('disp-notes').value.trim(),
      // Referral
      ref_doctor:          document.getElementById('ref-doctor').value.trim(),
      ref_hospital:        document.getElementById('ref-hospital').value.trim(),
      ref_type:            document.getElementById('ref-type').value,
      ref_urgency:         document.getElementById('ref-urgency').value,
      ref_reason:          document.getElementById('ref-reason').value.trim(),
    };

    // Collect specialty proforma data
    const pfData = collectProforma(document.getElementById('pf-container'));
    if (Object.keys(pfData).length > 0) {
      notes.proforma_data = { ncism_code: _activeNcismCode, ...pfData };
    }
    // §18r/§18t/§18w — merge specialty exam data
    const eyeData = collectOphthaData();
    if (eyeData) notes.proforma_data = { ...(notes.proforma_data || {}), ophtha_exam: eyeData };
    const entData = collectEntData();
    if (entData) notes.proforma_data = { ...(notes.proforma_data || {}), ent_exam: entData };
    const ogData  = collectObsGynData();
    if (ogData)  notes.proforma_data = { ...(notes.proforma_data || {}), obsgyn_exam: ogData };

  return { notes, disposition };
}

document.getElementById('btn-complete').addEventListener('click', () => {
  // Session 127 -- a trainee never has finalize authority, regardless of
  // whether this visit came from their own department queue or (in principle)
  // anywhere else; everyone else keeps the exact existing behaviour.
  (_isTrainee ? submitForReview() : completeConsultation());
});

async function completeConsultation() {
  if (!_activeVisitId) return;

  const btn = document.getElementById('btn-complete');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const { notes, disposition } = await _collectConsultationFields();

    // Session 127 -- finalizing a trainee's draft credits the original
    // author permanently, even though this consultation_notes row is a brand
    // new one written by the reviewing doctor (v1 deliberately doesn't hydrate
    // the trainee's fields into this form -- see openReviewDraft()).
    if (_activeDraftId) notes.drafted_by = _activeDraftedBy;

    // Save to consultation_notes
    const { error: cnErr } = await supabase.from('consultation_notes').insert({
      visit_id:  _activeVisitId,
      tenant_id: tenantId,
      doctor_id: userId,
      ...notes
    });
    if (cnErr) {
      console.error('consultation_notes error — message:', cnErr.message, '| details:', cnErr.details, '| hint:', cnErr.hint, '| code:', cnErr.code);
      throw cnErr;
    }

    // Session 127 -- close out the original draft this consultation reviewed
    // (so it stops showing in Pending Review) and hand the lab orders the
    // trainee already placed for this visit over to the lab/reception, now
    // under the finalizing doctor's sign-off.
    if (_activeDraftId) {
      await supabase.from('consultation_notes')
        .update({ review_status: 'finalized', finalized_by: userId }).eq('id', _activeDraftId);
      await supabase.from('lab_orders')
        .update({ review_status: 'finalized', finalized_by: userId })
        .eq('visit_id', _activeVisitId).eq('review_status', 'pending_review');
    }

    // Create prescription record for pharmacy
    const rx = _getRxData();
    if (rx.length > 0) {
      const { data: presc, error: pErr } = await supabase
        .from('prescriptions')
        .insert({ visit_id: _activeVisitId, tenant_id: tenantId, patient_id: _activePatient.id })
        .select('id').single();

      if (!pErr && presc) {
        await supabase.from('prescription_items').insert(
          rx.map(r => ({
            prescription_id: presc.id,
            medicine_id: null,
            medicine_name: r.name,
            dosage: r.dose,
            frequency: r.freq,
            duration: r.dur,
            anupana: r.anupana,
            timing: r.timing || null,
            quantity: 1
          }))
        );
      }
    }

    // §23z — Save patient education record if any checkbox ticked
    const eduAny = ['edu-disease','edu-meds','edu-adr','edu-pathya','edu-dina','edu-followup'].some(id => document.getElementById(id)?.checked);
    if (eduAny) {
      await supabase.from('patient_education_records').insert({
        tenant_id:               tenantId,
        visit_id:                _activeVisitId,
        patient_id:              _activePatient.id,
        doctor_id:               userId,
        disease_explained:       document.getElementById('edu-disease')?.checked || false,
        medications_explained:   document.getElementById('edu-meds')?.checked    || false,
        adr_risks_explained:     document.getElementById('edu-adr')?.checked     || false,
        pathya_apathya_explained:document.getElementById('edu-pathya')?.checked  || false,
        dinacharya_explained:    document.getElementById('edu-dina')?.checked    || false,
        followup_explained:      document.getElementById('edu-followup')?.checked|| false,
        language_used:           document.getElementById('edu-language')?.value  || 'Kannada',
        patient_acknowledged:    document.getElementById('edu-ack')?.checked     || false,
        education_notes:         document.getElementById('edu-notes')?.value.trim() || null,
      });
    }

    // Mark visit completed
    await supabase.from('visits').update({ status: 'completed' }).eq('id', _activeVisitId);

    await logAudit('complete_consultation', 'visits', _activeVisitId, {
      patient_name: _activePatient?.name,
      modern_diagnosis: notes.modern_diagnosis,
      ayurveda_diagnosis: notes.ayurveda_diagnosis,
      disposition,
      medicines_count: rx.length
    }, _ctx);

    // §18l — Save internal referral record + alert target OPD doctors
    let refSaved = false;
    if (disposition === 'referral') {
      const refTypeVal    = document.getElementById('ref-type').value;
      const refTargetOpd  = document.getElementById('ref-target-opd').value;
      if (refTypeVal === 'internal' && refTargetOpd) {
        const uv = (document.getElementById('ref-urgency').value || '').toLowerCase();
        const urgDb = uv.includes('emergency') ? 'emergency' : uv.includes('urgent') && uv.includes('semi') ? 'semi_urgent' : uv.includes('urgent') ? 'urgent' : 'routine';
        const { data: newRef } = await supabase.from('referrals').insert({
          tenant_id:            tenantId,
          patient_id:           _activePatient.id,
          source_visit_id:      _activeVisitId,
          source_opd_id:        _activeVisit?.opd_id || null,
          target_opd_id:        refTargetOpd,
          referring_doctor_id:  userId,
          reason:               notes.ref_reason || 'Internal referral',
          clinical_notes:       notes.ref_doctor || null,
          urgency:              urgDb,
          referral_type:        'internal',
          status:               'pending',
        }).select('id').single();
        if (newRef) {
          refSaved = true;
          const { data: tgtDoctors } = await supabase.from('opd_doctors')
            .select('doctor_id').eq('opd_id', refTargetOpd).eq('tenant_id', tenantId).eq('is_active_today', true);
          if (tgtDoctors?.length) {
            const tgtName = _opdList.find(o => o.id === refTargetOpd)?.name || 'OPD';
            await supabase.from('doctor_alerts').insert(
              tgtDoctors.map(d => ({
                tenant_id:    tenantId,
                doctor_id:    d.doctor_id,
                visit_id:     _activeVisitId,
                patient_name: _activePatient.name,
                message:      `📋 Referral from ${profile.full_name}: ${_activePatient.name} referred to ${tgtName} — ${notes.ref_reason || 'see notes'}. Urgency: ${urgDb.replace('_',' ')}.`,
                is_read:      false,
              }))
            );
          }
        }
      }
    }

    // Session 208: same honesty fix as Session 205's Admission Advice below -- this
    // used to say "Panchakarma plan saved" unconditionally even though the tab's
    // fields were never saved anywhere at all.
    const dispMsg = disposition === 'pk' ? (_pkPlanSaved ? 'Panchakarma care plan saved' : 'Panchakarma care plan not saved — open the Panchakarma tab and save it')
      // Session 205 (cont.): honest reflection of whether the advice was actually
      // sent -- previously said "Admission order created" unconditionally even
      // though the Admission tab's fields were never saved anywhere at all.
      : disposition === 'admission' ? (_admAdviceSaved ? 'Admission advice sent to reception' : 'Admission advice not sent — open the Admission tab and send it')
      : disposition === 'referral'  ? (refSaved ? 'Referral sent — target OPD alerted' : 'Referral noted')
      : 'sent to pharmacy';
    _toast(`${_activePatient?.name} — consultation complete, ${dispMsg}`, 'info');
    await _clearConsultationDraft(_activeVisitId);  // Session 185 — real note saved, autosave copy no longer needed
    _closeConsult();
    loadQueue();

    // ABDM M2 — fire-and-forget care context creation (does not block completion)
    // 27 Aug 2026 — real bug found live testing Bharathi N (a demographic-only patient,
    // no ABHA on file): this used to gate on _activePatient.abha_number, so a
    // no-ABHA patient's consultation never re-touched their VISIT-<id> care context at
    // all — meaning it could never pick up WellnessRecord (added server-side in
    // create_care_context whenever consultation_notes has real vitals, which only
    // exist AFTER this point) or any hi_types beyond whatever reception.html's
    // registration-time _abdmSmsNotifyNoAbha() optimistically set. That directly
    // contradicts the architecture reception.js/abdm-hip already support --
    // create_care_context's own abha_address fallback chain (visit → patient →
    // abha_number → null) already handles a fully-null abha_number correctly (proven
    // live: Bharathi's own registration-time care context already exists with
    // abha_address=null). Removed the gate -- always fire this now, matching
    // reception.js's Scenario 2 (no ABHA) design intent.
    _abdmCreateCareContext(_activeVisitId, _activePatient, notes, disposition, rx.length > 0);

  } catch (err) {
    console.error('completeConsultation caught:', err?.message, err?.details, err?.hint);
    _toast(safeErrorMessage(err, 'Error saving consultation. Please try again.'), 'error');
    btn.disabled = false;
    btn.textContent = '✓ Complete & Send to Pharmacy';
  }
}

// Session 127 -- the trainee's equivalent of completeConsultation(): saves the
// same consultation form, but only ever as a pending_review draft. Deliberately
// does NOT mark the visit completed, create the prescription/education records,
// raise referrals, write the audit log entry, or fire ABDM care-context creation
// -- all of that is a real clinical/legal action that only happens once a
// supervising doctor actually finalizes it (see completeConsultation()'s
// _activeDraftId branch). Medicines/labs the trainee entered are still visible
// to the reviewing doctor via the draft summary panel in openReviewDraft().
async function submitForReview() {
  if (!_activeVisitId) return;

  const btn = document.getElementById('btn-complete');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const { notes } = await _collectConsultationFields();

    const { error } = await supabase.from('consultation_notes').insert({
      visit_id:      _activeVisitId,
      tenant_id:     tenantId,
      doctor_id:     userId,
      drafted_by:    userId,
      review_status: 'pending_review',
      ...notes,
    });
    if (error) throw error;

    _toast(`${_activePatient?.name} — submitted for Professor review.`, 'info');
    await _clearConsultationDraft(_activeVisitId);  // Session 185 — draft saved for real, autosave copy no longer needed
    _closeConsult();
    loadQueue();
  } catch (err) {
    console.error('submitForReview caught:', err?.message, err?.details, err?.hint);
    _toast(safeErrorMessage(err, 'Error submitting draft. Please try again.'), 'error');
    btn.disabled = false;
    btn.textContent = '📝 Submit for Review';
  }
}

// ── ABDM M2 — Care Context creation after consultation ───────────
// 6 Sep 2026 (Session 198) — real root-cause bug found live testing HIP-initiated
// auto-sync: this used to ONLY upsert the local DB record (merge hi_types) and never
// call generate_link_token again, on the assumption that reception.js's ONE
// registration-time notification covered the whole visit going forward. It doesn't.
// ABDM's on_carecontext payload declares hiType per entry (see abdm-hip's
// generate_link_token — each element of `care_contexts` becomes its own ABDM
// "patient" entry with its own hiType), and reception.js's registration-time call
// only ever declares hiType:'OPConsultation' for this ref — ABDM's Gateway was NEVER
// told this ref would also carry Prescription (or DiagnosticReport, see lab.js),
// even though our own local care_contexts.hi_types row grows to include them.
// Confirmed live: the Invoice care context (BILL-<id>, single hiType, correctly and
// consistently declared) auto-fetched into the patient's PHR app within ~16 minutes,
// zero manual action — but this VISIT-<id> ref (3 real hi_types locally, only 1 ever
// declared to ABDM) never got its auto-fetch triggered at all, even after ~2 hours.
// Fix: re-declare to ABDM whenever genuinely new content becomes real — here, at
// consultation finalize, the consultation itself (or DischargeSummary on admission)
// and Prescription if one was actually written this visit. (Also fixed a masked
// instance of Session 183's em-dash-in-display bug below — harmless before since
// `display` was never sent to ABDM directly by the create_care_context branch, but
// generate_link_token forwards it verbatim to ABDM's real endpoint, which rejects
// an em-dash with "ABDM-9999: Invalid display".)
const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';

async function _abdmCreateCareContext(visitId, patient, notes, disposition, hasRx) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` };

    const hiType = disposition === 'admission' ? 'DischargeSummary' : 'OPConsultation';
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const careContextRef = `VISIT-${visitId}`;
    const display        = `OPD Consultation - ${dateStr}`;

    const ccRes = await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        action:           'create_care_context',
        patient_id:       patient.id,
        visit_id:         visitId,
        care_context_ref: careContextRef,
        display,
        hi_types:         hasRx ? [hiType, 'Prescription'] : [hiType],
        abha_number:      patient.abha_number,
      }),
    });

    // 6 Sep 2026 (Session 198 follow-up #2) — real bug found live: this used to
    // recompute the hiTypes to declare from scratch (hasRx ? [hiType,'Prescription']
    // : [hiType]), independently of what create_care_context's own handler actually
    // merged server-side — which silently includes WellnessRecord whenever the visit
    // has real vitals recorded (abdm-hip's own vitals check), something this client
    // code has no way to know about on its own. Confirmed live: a visit with real BP/
    // pulse/temp/weight had WellnessRecord correctly merged into care_contexts.hi_types
    // in our own DB, but ABDM was never told, because this recomputed list never
    // included it. Now reads the one authoritative list back from the response instead
    // of guessing — falls back to the old local computation only if the response
    // didn't carry hi_types (e.g. a network hiccup on the first call).
    const ccData = await ccRes.json().catch(() => ({}));
    const realHiTypes = (ccData?.hi_types?.length ? ccData.hi_types : (hasRx ? [hiType, 'Prescription'] : [hiType]));

    const abhaNum = patient.abha_number, abhaAddr = patient.abha_address;
    if (abhaNum || abhaAddr) {
      await fetch(ABDM_HIP_FN, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          action: 'generate_link_token', patient_id: patient.id,
          abha_number: abhaNum, abha_address: abhaAddr,
          care_contexts: realHiTypes.map(t => ({ referenceNumber: careContextRef, display, hiType: t })),
        }),
      });
    }
  } catch (e) {
    console.warn('ABDM care context fire-and-forget failed (non-critical):', e?.message);
  }
}

// ── M3 HIU — ABDM Records Tab ─────────────────────────────────────
const ABDM_AUTH_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-auth';

async function _abdmGetToken() {
  let { data: { session } } = await supabase.auth.getSession();
  // Proactively refresh when the access token is expired or within 60s of it —
  // otherwise a background/idle tab (or the ABDM tab's auto-refresh poll) can send an
  // already-expired token and get a 401 from the edge function.
  const expMs = session?.expires_at ? session.expires_at * 1000 : 0;
  if (session && (!expMs || expMs < Date.now() + 60000)) {
    try {
      const { data } = await supabase.auth.refreshSession();
      if (data?.session) session = data.session;
    } catch { /* fall through with whatever we have */ }
  }
  return session?.access_token || null;
}

// Session 175: Care Context Status — what WE'VE created about this patient as a HIP
// (local care_contexts rows), shown regardless of ABHA. Separate concern from the M3
// consent-request panel below it, which requires ABHA and pulls records FROM other
// facilities — the opposite direction of data flow. A demographic-only patient (no
// ABHA at all) can still have a care context; this is the only place in the app that
// surfaces that fact, closing the gap that made Vipul Singh's live-demo check come up
// empty (he checked this exact tab expecting to see it, found nothing, because this
// section didn't exist yet and the M3 section below always required ABHA).
async function _loadCareContextStatus(patientId) {
  const el = document.getElementById('abdm-cc-status');
  if (!el) return;
  el.innerHTML = `<div style="font-size:12px;color:#888">Loading care context status…</div>`;

  const { data, error } = await supabase
    .from('care_contexts')
    .select('care_context_ref, display, hi_types, abha_address, created_at')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (error) { el.innerHTML = `<div style="font-size:12px;color:#c0392b">Could not load care context status: ${_esc(safeErrorMessage(error))}</div>`; return; }

  if (!data?.length) {
    el.innerHTML = `<div style="padding:12px 16px;background:#fdf6f6;border:1px solid #e8c8c8;border-radius:8px;font-size:12.5px;color:#a01a1a">
      🏥 <strong>No care context on file yet</strong> for this patient — one is created automatically the first time they're registered for a visit. Nothing to discover on ABDM's side until then.
    </div>`;
    return;
  }

  const rows = data.map(cc => {
    const abhaNote = cc.abha_address
      ? `🔗 Linked to ABHA <code style="font-size:11px">${_esc(cc.abha_address)}</code>`
      : `🕓 No ABHA on file — discoverable once the patient adds one and searches for this facility from their PHR app (name/DOB/gender/mobile match)`;
    return `<div style="padding:8px 12px;background:#fff;border:1px solid var(--border);border-radius:6px;margin-top:6px;font-size:12.5px">
      <div style="font-weight:600">${_esc(cc.display ?? cc.care_context_ref)}</div>
      <div style="color:var(--text-muted);margin-top:2px">${(cc.hi_types??[]).map(t=>_esc(t)).join(' · ') || 'No record types set'}</div>
      <div style="margin-top:4px">${abhaNote}</div>
    </div>`;
  }).join('');

  // Real usage feedback (18 Aug 2026): a long-visit-history patient (11+ care contexts)
  // made this list dominate the whole ABDM Records page. Collapsed by default (>2
  // entries) with click-to-expand — a single entry or two is short enough to just show
  // outright, no toggle needed for something that small.
  const collapsible = data.length > 2;
  const toggleBtn = collapsible
    ? `<button data-onclick="toggleCareContextList" data-onclick-a0="${data.length}" style="background:none;border:none;color:var(--green-deep);font-size:11.5px;font-weight:600;cursor:pointer;padding:0;text-decoration:underline">▶ Show all ${data.length}</button>`
    : '';

  el.innerHTML = `<div style="padding:12px 16px;background:#f0faf5;border:1px solid #b8ddc4;border-radius:8px">
    <div style="font-weight:600;font-size:13px;color:var(--green-deep)">🏥 Care Context Status (this hospital, as HIP)</div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <span>${data.length} care context${data.length===1?'':'s'} created for this patient — what ABDM would find if searched for.</span>
      ${toggleBtn}
    </div>
    <div id="abdm-cc-rows" style="${collapsible ? 'display:none' : ''}">${rows}</div>
  </div>`;
}

window.toggleCareContextList = function(count) {
  const rowsEl = document.getElementById('abdm-cc-rows');
  const btn    = document.querySelector('#abdm-cc-status button[data-onclick="toggleCareContextList"]');
  if (!rowsEl || !btn) return;
  const nowShown = rowsEl.style.display === 'none';
  rowsEl.style.display = nowShown ? '' : 'none';
  btn.textContent = nowShown ? `▼ Hide` : `▶ Show all ${count}`;
};

async function _loadAbdmTab() {
  if (!_activePatient) return;
  _loadCareContextStatus(_activePatient.id);

  const raw = _activePatient.abha_address || _activePatient.abha_number || '';
  const abhaAddr = raw
    ? (raw.includes('@') ? raw : raw + '@sbx')
    : null;

  const noAbhaEl = document.getElementById('abdm-no-abha');
  const mainEl   = document.getElementById('abdm-main');
  const abhaNoteEl = document.getElementById('abdm-abha-note');
  const abhaNoteName = document.getElementById('abdm-abha-note-name');

  // 10 Sep 2026 — the consent-request form is now available for EVERY patient, whether
  // or not an ABHA is on file. Rationale (Dr. Venkatesh): a patient may have registered
  // here demographic-only, had many follow-ups, and separately holds an ABHA + records
  // at another hospital — the doctor should be able to pull those in with the ABHA the
  // patient provides, without a trip back to Reception. M3 consent is routed on the
  // ABHA ADDRESS alone (no name/DOB/gender is ever sent), so a demographic-only
  // registration — or one whose details don't match the ABHA card — does not block it;
  // the patient authenticates as themselves in their PHR app when they grant.
  noAbhaEl.style.display = 'none';
  mainEl.style.display   = '';
  const abhaField = document.getElementById('abdm-abha-addr');
  if (abhaAddr) {
    abhaField.value = abhaAddr;
    abhaField.dataset.forPatient = _activePatient.id;
    if (abhaNoteEl) abhaNoteEl.style.display = 'none';
  } else {
    // Empty, editable field. Clear it only when this is a DIFFERENT patient than the
    // field was last populated for — so a re-render (e.g. after the consent list
    // refreshes) doesn't wipe an ABHA the doctor is mid-way through typing.
    if (abhaField.dataset.forPatient !== _activePatient.id) abhaField.value = '';
    abhaField.dataset.forPatient = _activePatient.id;
    if (abhaNoteEl) abhaNoteEl.style.display = '';
    if (abhaNoteName) abhaNoteName.textContent = _activePatient.name || 'this patient';
  }

  // Set default dates only if not already set
  const today    = new Date();
  const toStr    = localDateStr(today);
  // 10 Sep 2026 — widened default look-back 1yr → 3yr: "pull my records from another
  // hospital" commonly reaches further back than a single year (and the doctor can
  // still narrow or widen it).
  const fromDate = new Date(today.getFullYear() - 3, today.getMonth(), today.getDate());
  const fromStr  = localDateStr(fromDate);
  const eraseDate = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
  const eraseStr  = localDateStr(eraseDate);
  if (!document.getElementById('abdm-date-from').value) document.getElementById('abdm-date-from').value = fromStr;
  if (!document.getElementById('abdm-date-to').value)   document.getElementById('abdm-date-to').value   = toStr;
  if (!document.getElementById('abdm-erase-at').value)  document.getElementById('abdm-erase-at').value  = eraseStr;
  // Erase time (matches the PHR app's "Consent valid upto → Date | Time" pair)
  const eraseTimeInput = document.getElementById('abdm-erase-time');
  if (eraseTimeInput && !eraseTimeInput.dataset.touched) {
    eraseTimeInput.value = eraseTimeInput.value || '23:59';
    const lbl = document.getElementById('abdm-erase-time-label');
    if (lbl) lbl.textContent = formatTime12(eraseTimeInput.value);
  }

  // Load consent request list
  const listEl = document.getElementById('abdm-consent-list');
  listEl.innerHTML = '<div style="color:#888;font-size:13px;padding:6px 0">Loading…</div>';

  const token = await _abdmGetToken();
  if (!token) { listEl.innerHTML = '<div style="color:#c0392b;font-size:13px">Session expired. Please refresh.</div>'; return; }

  try {
    const res  = await fetch(ABDM_AUTH_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ action: 'hiu_list_consents', patientId: _activePatient.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load consent list');
    _renderConsentList(data.consents || []);
  } catch (e) {
    listEl.innerHTML = `<div style="color:#c0392b;font-size:13px">Error: ${_esc(e.message)}</div>`;
  }
}

function _renderConsentList(consents) {
  const listEl = document.getElementById('abdm-consent-list');
  if (!consents.length) {
    listEl.innerHTML = '<div style="color:#888;font-size:13px;padding:8px 0">No consent requests for this patient yet.</div>';
    return;
  }
  const statusColor = {
    requested: '#c9902a', granted: '#1a7a3a', denied: '#c0392b',
    revoked: '#7f8c8d', expired: '#7f8c8d', failed: '#c0392b',
  };
  // Compliance messages for HIU_FLOW_202 (revoke) and HIU_FLOW_301 (expiry)
  const complianceNote = {
    revoked: '🚫 Consent revoked by patient. All stored health records have been deleted per ABDM compliance.',
    expired: '⏱ Consent expired. All stored health records have been deleted per ABDM data erase policy.',
    denied:  '✗ Patient denied this consent request. No health records were shared.',
  };

  // ABDM's 8 HI types in a stable display order + friendly labels.
  const HI_ORDER = ['OPConsultation','Prescription','DiagnosticReport','DischargeSummary','ImmunizationRecord','WellnessRecord','HealthDocumentRecord','Invoice'];
  const HI_LABEL = { OPConsultation:'OPD Consultation', Prescription:'Prescription', DiagnosticReport:'Diagnostic Report',
    DischargeSummary:'Discharge Summary', ImmunizationRecord:'Immunization', WellnessRecord:'Wellness Record',
    HealthDocumentRecord:'Health Document', Invoice:'Invoice' };
  const sortHi = (arr) => [...(arr || [])].sort((a, b) => {
    const ia = HI_ORDER.indexOf(a), ib = HI_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  // 9 Sep 2026 — accordion. A patient can accumulate many consents (Venkatesha had 29);
  // showing every one fully expanded buried the page. Now: the MOST RECENT still-active
  // granted consent renders expanded with its records auto-loaded; every other consent
  // (older granted, pending, denied, revoked/expired) is a collapsed header that drops
  // down on click to show its Requested/Granted detail (and records, if granted).
  const _normStatus = (c) => {
    const e = c.granted_erase_at || c.data_erase_at;
    return (c.status === 'granted' && e && new Date(e) < new Date()) ? 'expired' : c.status;
  };
  const firstGrantedIdx = consents.findIndex(c => _normStatus(c) === 'granted');

  listEl.innerHTML = consents.map((c, idx) => {
    const grantedErase = c.granted_erase_at || c.data_erase_at;
    const effStatus    = _normStatus(c);
    const erasePassed  = effStatus === 'expired' && c.status === 'granted';

    const col   = statusColor[effStatus] || '#888';
    const date  = new Date(c.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const note  = erasePassed
      ? '⏱ This consent has reached its data-retention (erase) date. Health records are no longer available for viewing.'
      : (complianceNote[c.status] || null);

    // Requested vs Granted (mirrors the ABHA PHR app's consent detail — Screenshot 441).
    const reqHi     = sortHi(c.requested_hi_types || c.hi_types || []);
    const grantHi   = c.granted_hi_types ? sortHi(c.granted_hi_types) : null;
    const grantSet  = new Set(grantHi || []);
    const chip = (t, on) => `<span class="hi-chip ${on ? 'on' : 'off'}">${_esc(HI_LABEL[t] || t)}</span>`;

    const range = (from, to) => (from || to)
      ? `${_fmtD(from) || '—'} &nbsp;to&nbsp; ${_fmtD(to) || '—'}`
      : '';
    const reqRange   = range(c.requested_date_from, c.requested_date_to);
    const grantRange = range(c.granted_date_from, c.granted_date_to);
    const ccRefs     = Array.isArray(c.granted_care_context_refs) ? c.granted_care_context_refs.filter(Boolean) : [];

    const requestedBlock = `<div class="cons-block">
        <div class="cons-block-hd">Requested by ${_esc(tenant?.name || 'this facility')}</div>
        <div>${reqHi.map(t => chip(t, true)).join('')}</div>
        ${reqRange ? `<div class="cons-daterange">Records from: ${reqRange}</div>` : ''}
      </div>`;

    const grantedBlock = grantHi ? `<div class="cons-block granted">
        <div class="cons-block-hd">Granted by Patient</div>
        <div>${reqHi.map(t => chip(t, grantSet.has(t))).join('')}${grantHi.filter(t => !reqHi.includes(t)).map(t => chip(t, true)).join('')}</div>
        ${grantRange ? `<div class="cons-daterange">Records from: ${grantRange}</div>` : ''}
        ${grantedErase ? `<div class="cons-daterange">Records auto-erase after: <b>${_fmtD(grantedErase)}</b></div>` : ''}
        ${ccRefs.length ? `<div class="cons-cc">Limited to ${ccRefs.length} care context${ccRefs.length > 1 ? 's' : ''}: ${_esc(ccRefs.join(', '))}</div>` : ''}
      </div>` : '';

    const open = idx === firstGrantedIdx;
    const typeSummary = grantHi
      ? `${grantHi.length} of ${reqHi.length} type${reqHi.length === 1 ? '' : 's'} granted`
      : `${reqHi.length} type${reqHi.length === 1 ? '' : 's'} requested`;

    const body = `${requestedBlock}${grantedBlock}
      ${note ? `<div style="margin-top:10px;padding:8px 10px;background:${col}10;border-left:3px solid ${col};border-radius:0 4px 4px 0;font-size:12px;color:${col};font-weight:500">${_esc(note)}</div>` : ''}
      ${effStatus === 'granted'
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">
             <button class="btn" style="font-size:12px;padding:4px 12px" data-onclick="_loadReceivedRecords" data-onclick-a0="${_esc(c.id)}" data-onclick-a1="granted">📋 View Records</button>
             <button class="btn" style="font-size:12px;padding:4px 12px" data-onclick="_retriggerConsentFetch" data-onclick-a0="${_esc(c.id)}" title="Ask ABDM to re-send the health data — use if a granted consent hasn't delivered records yet">↻ Re-fetch data</button>
           </div>
           <div id="recbox-${_esc(c.id)}" style="display:none;margin-top:10px"></div>`
        : ''}`;

    return `<div class="cons-card" style="border:1px solid ${note ? col + '44' : '#ddd'};border-radius:8px;margin-bottom:8px;background:#fff;overflow:hidden">
      <div id="conshdr-${_esc(c.id)}" data-onclick="_toggleConsentCard" data-onclick-a0="${_esc(c.id)}" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;background:${open ? '#f4faf5' : '#fafafa'}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            <span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:10px;background:${col}18;color:${col};border:1px solid ${col}44">${_esc((effStatus || '').toUpperCase())}</span>
            <span style="font-size:12px;color:#444;font-weight:600">Requested ${date}</span>
            <span style="font-size:11px;color:#999">${_esc(c.purpose || 'CAREMGT')}</span>
          </div>
          <div style="font-size:10.5px;color:#999;margin-top:2px;word-break:break-all">${_esc(c.abha_address)} · ${typeSummary}</div>
        </div>
        <span id="conschev-${_esc(c.id)}" style="color:#aaa;font-size:14px;flex-shrink:0;transition:transform .15s;transform:rotate(${open ? 90 : 0}deg)">▸</span>
      </div>
      <div class="cons-body" id="consbody-${_esc(c.id)}" style="display:${open ? 'block' : 'none'};padding:2px 12px 12px">${body}</div>
    </div>`;
  }).join('');

  // Auto-load the records for the one expanded (most recent granted) consent.
  if (firstGrantedIdx >= 0) {
    const cid = consents[firstGrantedIdx].id;
    setTimeout(() => {
      const box = document.getElementById('recbox-' + cid);
      if (box && box.dataset.open !== '1') _loadReceivedRecords(cid, 'granted');
    }, 200);
  }
}

// Accordion toggle for a consent card. Expanding a granted card also loads its records
// (once) so it's one click, not two.
window._toggleConsentCard = function(cid) {
  const body = document.getElementById('consbody-' + cid);
  const chev = document.getElementById('conschev-' + cid);
  const hdr  = document.getElementById('conshdr-' + cid);
  if (!body) return;
  const opening = body.style.display === 'none';
  body.style.display = opening ? 'block' : 'none';
  if (chev) chev.style.transform = `rotate(${opening ? 90 : 0}deg)`;
  // Session 279 -- found checking for the same class of bug as the PK wizard chips:
  // the header's own background tint was only ever set at initial render (matching
  // whichever card auto-opened), never updated here, so a manually toggled card's
  // header stayed stuck showing the wrong open/closed shade indefinitely.
  if (hdr) hdr.style.background = opening ? '#f4faf5' : '#fafafa';
  if (opening) {
    const box = body.querySelector('[id^="recbox-"]');
    const hasRecordsBtn = body.querySelector('[data-onclick="_loadReceivedRecords"]');
    if (box && hasRecordsBtn && box.dataset.open !== '1') _loadReceivedRecords(cid, 'granted');
  }
};

async function _submitConsentRequest() {
  const btn      = document.getElementById('btn-abdm-consent');
  const statusEl = document.getElementById('abdm-req-status');

  const abhaAddress = (document.getElementById('abdm-abha-addr')?.value || '').trim();
  if (!abhaAddress) { statusEl.innerHTML = '<span style="color:#c0392b">Patient ABHA address is required.</span>'; return; }
  if (!abhaAddress.includes('@')) {
    statusEl.innerHTML = '<span style="color:#c0392b">Enter the full ABHA address including its @ suffix, e.g. <code>name@sbx</code>.</span>';
    return;
  }

  // The ABHA field is editable, but the request is filed against _activePatient.id (fixed, below).
  // Sending a consent for an ABHA that belongs to someone else would pull that person's records
  // into THIS patient's chart. When the patient HAS an ABHA on file, block a mismatch unless the
  // clinician explicitly overrides. When they don't (demographic-only registration, doctor is
  // entering the ABHA the patient provided), there's nothing to check against — the inline note
  // by the field already states the records will be filed under this patient's chart.
  const ptAbha = (_activePatient?.abha_address || '').trim();
  if (ptAbha && abhaAddress.toLowerCase() !== ptAbha.toLowerCase()) {
    const ok = confirm(
      `The ABHA address entered (${abhaAddress}) does not match this patient's ABHA on file (${ptAbha}).\n\n` +
      `Any records pulled by this consent will be filed under ${_activePatient?.name || 'this patient'}'s chart. ` +
      `Send anyway?`
    );
    if (!ok) {
      statusEl.innerHTML = '<span style="color:#c0392b">Cancelled — the ABHA address does not match this patient.</span>';
      return;
    }
  }

  const hiTypes = [...document.querySelectorAll('#abdm-hi-types .chip.on')].map(c => c.dataset.value);
  if (!hiTypes.length) { statusEl.innerHTML = '<span style="color:#c0392b">Select at least one health information type.</span>'; return; }

  const dateFrom  = document.getElementById('abdm-date-from').value;
  const dateTo    = document.getElementById('abdm-date-to').value;
  const eraseAt   = document.getElementById('abdm-erase-at').value;
  const eraseTime = (document.getElementById('abdm-erase-time')?.value || '23:59');
  const purpose   = document.getElementById('abdm-purpose').value;

  if (!dateFrom || !dateTo || !eraseAt) { statusEl.innerHTML = '<span style="color:#c0392b">All date fields are required.</span>'; return; }

  btn.disabled    = true;
  btn.textContent = 'Sending…';
  statusEl.innerHTML = '';

  try {
    const token = await _abdmGetToken();
    const res = await fetch(ABDM_AUTH_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        action:        'hiu_consent_init',
        patientId:     _activePatient.id,
        visitId:       _activeVisitId || null,
        doctorId:      userId,
        abhaAddress,
        purpose,
        hiTypes,
        dateFrom:      dateFrom + 'T00:00:00.000Z',
        dateTo:        dateTo   + 'T23:59:59.000Z',
        dataEraseAt:   eraseAt  + 'T' + eraseTime + ':00.000Z',
        requesterName: _ctx.userName || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));

    statusEl.innerHTML = `<span style="color:var(--green-deep);font-weight:500">✓ Consent request sent. The patient will be notified on their ABHA app. Request ID: ${_esc(data.requestId || data.dbId)}</span>`;
    await _loadAbdmTab();
  } catch (e) {
    statusEl.innerHTML = `<span style="color:#c0392b">Error: ${_esc(e.message)}</span>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Send Consent Request to Patient';
  }
}
window._submitConsentRequest = _submitConsentRequest;

// Erase-time picker (Material clock dialog, matches the ABDM PHR app's "Consent valid upto" Time field)
function _openEraseTimePicker() {
  const hidden = document.getElementById('abdm-erase-time');
  const label  = document.getElementById('abdm-erase-time-label');
  openTimePicker({
    value: hidden?.value || '23:59',
    onConfirm: (v) => {
      if (hidden) { hidden.value = v; hidden.dataset.touched = '1'; }
      if (label)  label.textContent = formatTime12(v);
    },
  });
}
window._openEraseTimePicker = _openEraseTimePicker;

// ── ABDM: Parse FHIR R4 Bundle into a readable card ──────────────
// 9 Sep 2026 — the received-record view rendered each record as a collapsed one-liner
// and its detail (this function's old body) only extracted ~9 resource types. NHA's demo
// feedback: it should read section-by-section like the ABHA PHR app. This new
// _parseFhirForDisplay walks Composition.section[] (Chief Complaint, Allergies, Medical
// History, Investigation Advice, Medications, Procedures, Follow-up, Vitals, …), resolves
// each section's entries, and surfaces the attached PDF as a "View" button. Bundles with
// no Composition sections fall back to _parseFhirLegacy (the old body, kept below).
function _fmtD(x) {
  if (!x) return '';
  const d = new Date(x);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function _fhirResolve(byRef, ref) {
  if (!ref) return null;
  return byRef[ref] || byRef[String(ref).split('/').slice(-2).join('/')] || byRef[String(ref).split('/').pop()] || null;
}
function _stripXhtml(div) {
  return String(div || '')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function _fhirResourceLine(r) {
  if (!r) return '';
  const t = r.resourceType;
  const cc = (x) => x?.text || x?.coding?.[0]?.display || '';
  if (t === 'Condition') {
    const st = r.clinicalStatus?.coding?.[0]?.code;
    return `${_esc(cc(r.code) || 'Condition')}${st ? ` <span class="fhir-badge" style="background:#fde8e8;color:#c0392b">${_esc(st)}</span>` : ''}`;
  }
  if (t === 'Observation') {
    const n = cc(r.code) || 'Observation';
    if (Array.isArray(r.component) && r.component.length) {
      const parts = r.component.map(c => `${cc(c.code)}: ${c.valueQuantity?.value ?? ''}${c.valueQuantity?.unit ? ' ' + c.valueQuantity.unit : ''}`.trim());
      return `${_esc(n)} — ${_esc(parts.join(', '))}`;
    }
    const v = r.valueQuantity ? `${r.valueQuantity.value} ${r.valueQuantity.unit || ''}`.trim()
      : r.valueString || cc(r.valueCodeableConcept) || (r.dataAbsentReason ? 'not recorded' : '');
    return `${_esc(n)}${v ? `: <b>${_esc(v)}</b>` : ''}`;
  }
  if (t === 'MedicationRequest' || t === 'MedicationStatement') {
    const mc = r.medicationCodeableConcept || r.medication?.concept;
    const dose = r.dosageInstruction?.[0]?.text;
    return `${_esc(cc(mc) || 'Medicine')}${dose ? ` <span class="fhir-dose">— ${_esc(dose)}</span>` : ''}`;
  }
  if (t === 'AllergyIntolerance') {
    const rx = r.reaction?.[0]?.manifestation?.[0]?.text;
    return `<span style="color:#c0392b">${_esc(cc(r.code) || 'Allergy')}${rx ? ` — ${_esc(rx)}` : ''}</span>`;
  }
  if (t === 'Procedure') {
    const d = _fmtD(r.performedDateTime);
    return `${_esc(cc(r.code) || 'Procedure')}${d ? ` <span class="fhir-dose">(${_esc(d)})</span>` : ''}${r.note?.[0]?.text ? ` — ${_esc(r.note[0].text)}` : ''}`;
  }
  if (t === 'ServiceRequest') {
    return `${_esc(cc(r.code) || 'Investigation advised')}${r.priority ? ` <span class="fhir-badge" style="background:#eef;color:#33c">${_esc(r.priority)}</span>` : ''}${r.note?.[0]?.text ? ` — ${_esc(r.note[0].text)}` : ''}`;
  }
  if (t === 'Appointment') {
    const d = _fmtD(r.start);
    return `Follow-up${d ? ` on ${_esc(d)}` : ''}${r.description ? ` — ${_esc(r.description)}` : ''}`;
  }
  if (t === 'FamilyMemberHistory') {
    const conds = (r.condition || []).map(c => cc(c.code)).filter(Boolean).join(', ');
    return `${_esc(r.relationship?.text || 'Family')}${conds ? `: ${_esc(conds)}` : ''}`;
  }
  if (t === 'Immunization') {
    const d = _fmtD(r.occurrenceDateTime);
    const dn = r.protocolApplied?.[0]?.doseNumberPositiveInt ?? r.protocolApplied?.[0]?.doseNumberString;
    return `${_esc(cc(r.vaccineCode) || 'Vaccine')}${dn ? ` (dose ${_esc(String(dn))})` : ''}${d ? ` — ${_esc(d)}` : ''}`;
  }
  if (t === 'ImmunizationRecommendation') {
    const recs = (r.recommendation || []).map(x => `${cc(x.vaccineCode?.[0])} due ${_fmtD(x.dateCriterion?.[0]?.value)}`).filter(s => s && !s.startsWith(' due')).join('; ');
    return _esc(recs || 'Immunization recommendation');
  }
  if (t === 'DiagnosticReport') return `${_esc(cc(r.code) || 'Report')}${r.conclusion ? `: ${_esc(r.conclusion)}` : ''}`;
  if (t === 'DocumentReference') return `${_esc(cc(r.type) || r.description || 'Attached document')}`;
  if (t === 'Binary') return 'Attached document (PDF)';
  if (t === 'CarePlan') return _esc(r.title || r.description || 'Care plan');
  if (t === 'Invoice') {
    const items = (r.lineItem || []).map(l => {
      const nm = l.priceComponent?.[0]?.code?.text || l.chargeItemCodeableConcept?.text || `Item ${l.sequence ?? ''}`;
      const amt = l.priceComponent?.[0]?.amount?.value ?? l.net?.value;
      return `${nm}${amt != null ? ` — ₹${amt}` : ''}`;
    });
    const total = r.totalGross?.value != null ? ` · Total ₹${r.totalGross.value}` : '';
    return _esc((items.join('; ') || 'Invoice') + total);
  }
  return _esc(cc(r.code) || t);
}

function _parseFhirForDisplay(bundle, hiType) {
  if (!bundle?.entry?.length) return null;
  const byRef = {};
  bundle.entry.forEach(e => { const r = e?.resource; if (r?.resourceType && r?.id) { byRef[`${r.resourceType}/${r.id}`] = r; byRef[r.id] = r; } });
  const comp = bundle.entry.find(e => e?.resource?.resourceType === 'Composition')?.resource;

  const secHtml = [];
  if (comp?.section?.length) {
    for (const s of comp.section) {
      const title = s.title || s.code?.text || s.code?.coding?.[0]?.display || 'Section';
      const entries = (s.entry || []).map(en => _fhirResolve(byRef, en.reference)).filter(Boolean);
      // The Document Reference / attached-PDF section is surfaced as the "View PDF" button below.
      if (entries.length && entries.every(r => r.resourceType === 'DocumentReference' || r.resourceType === 'Binary')) continue;
      if (entries.length) {
        const typeLabel = [...new Set(entries.map(r => r.resourceType))].join(', ');
        secHtml.push(`<div class="fhir-sec"><div class="fhir-sec-hd"><span>${_esc(title)}</span><span class="fhir-sec-type">${_esc(typeLabel)}</span></div><div class="fhir-sec-bd"><ul>${entries.map(r => `<li>${_fhirResourceLine(r)}</li>`).join('')}</ul></div></div>`);
      } else if (s.text?.div) {
        const txt = _stripXhtml(s.text.div);
        if (txt && txt !== '—') secHtml.push(`<div class="fhir-sec"><div class="fhir-sec-hd"><span>${_esc(title)}</span></div><div class="fhir-sec-bd"><div class="fhir-narr">${_esc(txt)}</div></div></div>`);
      } else if (s.emptyReason) {
        secHtml.push(`<div class="fhir-sec"><div class="fhir-sec-hd"><span>${_esc(title)}</span></div><div class="fhir-sec-bd"><div class="fhir-empty">${_esc(s.emptyReason.coding?.[0]?.display || s.emptyReason.text || 'None recorded')}</div></div></div>`);
      }
    }
  }

  // Attached PDF — DocumentReference.content[].attachment or a Binary with contentType pdf
  let pdfB64 = null;
  for (const e of bundle.entry) {
    const r = e?.resource;
    const att = r?.resourceType === 'DocumentReference' ? r.content?.find(c => /pdf/i.test(c?.attachment?.contentType || ''))?.attachment
      : (r?.resourceType === 'Binary' && /pdf/i.test(r.contentType || '')) ? { data: r.data } : null;
    if (att?.data) { pdfB64 = att.data; break; }
  }

  if (!secHtml.length && !pdfB64) return _parseFhirLegacy(bundle, hiType);

  let pdfHtml = '';
  if (pdfB64) {
    const key = 'p' + Math.random().toString(36).slice(2);
    (window._abdmPdfCache = window._abdmPdfCache || {})[key] = pdfB64;
    pdfHtml = `<button class="fhir-pdf-btn" data-onclick="_viewAbdmPdf" data-onclick-a0="${key}">📄 View attached document (PDF)</button>`;
  }
  const legacy = !secHtml.length ? (_parseFhirLegacy(bundle, hiType) || '') : '';
  return `<div class="fhir-detail" style="gap:8px">${secHtml.join('')}${legacy}${pdfHtml}</div>`;
}

function _viewAbdmPdf(key) {
  const b64 = (window._abdmPdfCache || {})[key];
  if (!b64) return;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert('Could not open the attached document.'); }
}
window._viewAbdmPdf = _viewAbdmPdf;

function _parseFhirLegacy(bundle, hiType) {
  if (!bundle?.entry?.length) return null;
  const get = (rt) => bundle.entry.filter(e => e?.resource?.resourceType === rt).map(e => e.resource);
  const sections = [];

  // Chief complaint / encounter reason
  const encs = get('Encounter');
  if (encs.length) {
    const reason = encs[0]?.reasonCode?.[0]?.text || encs[0]?.reasonCode?.[0]?.coding?.[0]?.display;
    if (reason) sections.push(`<div class="fhir-row"><span class="fhir-lbl">Chief Complaint</span>${_esc(reason)}</div>`);
  }

  // Diagnoses
  const conds = get('Condition');
  if (conds.length) {
    const dx = conds.map(c => {
      const name = c?.code?.text || c?.code?.coding?.[0]?.display || '';
      const stat = c?.clinicalStatus?.coding?.[0]?.code ? ` <span class="fhir-badge" style="background:#fde8e8;color:#c0392b">${c.clinicalStatus.coding[0].code}</span>` : '';
      return name ? `<span>${_esc(name)}${stat}</span>` : '';
    }).filter(Boolean).join(', ');
    if (dx) sections.push(`<div class="fhir-row"><span class="fhir-lbl dx">Diagnosis</span>${dx}</div>`);
  }

  // Medications
  const meds = [...get('MedicationRequest'), ...get('MedicationStatement')];
  if (meds.length) {
    const list = meds.map(m => {
      const mc = m?.medicationCodeableConcept || m?.medication?.concept;
      const name = mc?.text || mc?.coding?.[0]?.display || 'Medicine';
      const dose = m?.dosageInstruction?.[0]?.text || '';
      return `<li>${_esc(name)}${dose ? ' <span class="fhir-dose">— ' + _esc(dose) + '</span>' : ''}</li>`;
    }).join('');
    sections.push(`<div class="fhir-row"><span class="fhir-lbl rx">Medications</span><ul class="fhir-list">${list}</ul></div>`);
  }

  // Vitals
  const vitals = get('Observation').filter(o =>
    o?.category?.[0]?.coding?.[0]?.code === 'vital-signs' ||
    ['blood pressure','heart rate','body weight','body temperature','oxygen saturation','body height','bmi','respiratory rate'].includes((o?.code?.text || '').toLowerCase())
  );
  if (vitals.length) {
    const items = vitals.map(o => {
      const n = o?.code?.text || o?.code?.coding?.[0]?.display || '';
      const v = o?.valueQuantity ? `${o.valueQuantity.value} ${o.valueQuantity.unit || ''}`.trim() : (o?.valueString || '');
      return n && v ? `${_esc(n)}: <b>${_esc(v)}</b>` : '';
    }).filter(Boolean).join(' · ');
    if (items) sections.push(`<div class="fhir-row"><span class="fhir-lbl">Vitals</span>${items}</div>`);
  }

  // Lab observations
  const labs = get('Observation').filter(o => o?.category?.[0]?.coding?.[0]?.code === 'laboratory');
  if (labs.length) {
    const list = labs.map(o => {
      const n = o?.code?.text || o?.code?.coding?.[0]?.display || '';
      const v = o?.valueQuantity ? `${o.valueQuantity.value} ${o.valueQuantity.unit || ''}`.trim() : (o?.valueString || '');
      const ref = o?.referenceRange?.[0]?.text ? ` (ref: ${o.referenceRange[0].text})` : '';
      return `<li>${_esc(n)}: <b>${_esc(v)}</b>${_esc(ref)}</li>`;
    }).filter(s => s.length > 10).join('');
    if (list) sections.push(`<div class="fhir-row"><span class="fhir-lbl">Lab Results</span><ul class="fhir-list">${list}</ul></div>`);
  }

  // DiagnosticReport conclusion
  const reports = get('DiagnosticReport');
  if (reports.length) {
    const items = reports.map(d => {
      const n = d?.code?.text || d?.code?.coding?.[0]?.display || 'Report';
      const conc = d?.conclusion || '';
      return conc ? `<li>${_esc(n)}: ${_esc(conc)}</li>` : `<li>${_esc(n)}</li>`;
    }).join('');
    sections.push(`<div class="fhir-row"><span class="fhir-lbl">Reports</span><ul class="fhir-list">${items}</ul></div>`);
  }

  // Invoice (billing) — Session 183: real gap found live — an Invoice-type record
  // (no Condition/MedicationRequest/DiagnosticReport content by design) fell through
  // every branch above and rendered nothing but a repeated raw KB size. lineItem[]
  // references a separate ChargeItem resource for its description/qty (Session 182's
  // mandatory-chargeItem fix) — fall back to Invoice.note (Registration/Consultation
  // ₹ lines, always present) when lineItem is empty, e.g. a genuinely ₹0 bill.
  const invoices = get('Invoice');
  if (invoices.length) {
    const chargeItems = get('ChargeItem');
    const ciById = new Map(chargeItems.map(ci => [ci.id, ci]));
    const inv = invoices[0];
    const li = Array.isArray(inv?.lineItem) ? inv.lineItem : [];
    let itemsHtml = '';
    if (li.length) {
      itemsHtml = '<ul class="fhir-list">' + li.map(l => {
        const pc = l?.priceComponent?.[0];
        let name = pc?.code?.text;
        if (!name) {
          const ref = l?.chargeItem?.reference || '';
          const ci = ciById.get(ref.split('/').pop());
          name = ci?.code?.text || `Item ${l.sequence ?? ''}`;
        }
        const amt = pc?.amount?.value ?? l?.net?.value;
        const qty = l?.factor;
        return `<li>${_esc(name)}${qty ? ' × ' + _esc(String(qty)) : ''}${amt != null ? ' — <b>₹' + _esc(String(amt)) + '</b>' : ''}</li>`;
      }).join('') + '</ul>';
    } else if (inv?.note?.length) {
      itemsHtml = '<ul class="fhir-list">' + inv.note.map(n => `<li>${_esc(n?.text || '')}</li>`).join('') + '</ul>';
    }
    const total = inv?.totalGross?.value != null ? `₹${inv.totalGross.value}` : '';
    const statusBadge = inv?.status ? ` <span class="fhir-badge" style="background:#eef7ee;color:var(--green-deep)">${_esc(inv.status)}</span>` : '';
    sections.push(`<div class="fhir-row"><span class="fhir-lbl">Invoice</span>${itemsHtml}${total ? `<div style="margin-top:4px;font-weight:600">Total: ${_esc(total)}${statusBadge}</div>` : ''}</div>`);
  }

  // Allergies
  const allergies = get('AllergyIntolerance');
  if (allergies.length) {
    const names = allergies.map(a => a?.code?.text || a?.code?.coding?.[0]?.display || '').filter(Boolean).join(', ');
    if (names) sections.push(`<div class="fhir-row"><span class="fhir-lbl" style="color:#c0392b">⚠ Allergies</span><span style="color:#c0392b;font-weight:500">${_esc(names)}</span></div>`);
  }

  if (!sections.length) return null;
  return `<div class="fhir-detail">${sections.join('')}</div>`;
}

// ── ABDM: Build longitudinal clinical summary across all records ──
function _buildClinicalSummary(records) {
  const allDx = new Map();          // name → count
  const allMeds = new Map();
  const allAllergies = new Set();
  const facilities = new Set();
  const latestVitals = {};

  records.forEach(r => {
    const src = r.source_display;
    if (src && !src.startsWith('HIP via')) facilities.add(src);
    const b = r.fhir_bundle;
    if (!b?.entry) return;
    const get = (rt) => b.entry.filter(e => e?.resource?.resourceType === rt).map(e => e.resource);

    get('Condition').forEach(c => {
      const n = c?.code?.text || c?.code?.coding?.[0]?.display;
      if (n) allDx.set(n, (allDx.get(n) || 0) + 1);
    });
    [...get('MedicationRequest'), ...get('MedicationStatement')].forEach(m => {
      const mc = m?.medicationCodeableConcept || m?.medication?.concept;
      const n = mc?.text || mc?.coding?.[0]?.display;
      if (n) allMeds.set(n, (allMeds.get(n) || 0) + 1);
    });
    get('AllergyIntolerance').forEach(a => {
      const n = a?.code?.text || a?.code?.coding?.[0]?.display;
      if (n) allAllergies.add(n);
    });
    get('Observation').filter(o =>
      ['blood pressure','heart rate','body weight','oxygen saturation','body temperature'].includes((o?.code?.text || '').toLowerCase())
    ).forEach(o => {
      const n = (o?.code?.text || '').toLowerCase();
      const v = o?.valueQuantity ? `${o.valueQuantity.value} ${o.valueQuantity.unit || ''}`.trim() : '';
      if (v && !latestVitals[n]) latestVitals[n] = v; // records are newest-first
    });
  });

  const lines = [];
  if (allDx.size)        lines.push(`<div><span class="cs-lbl dx">Diagnoses</span>${[...allDx.keys()].slice(0, 6).map(d => `<span class="cs-chip dx">${_esc(d)}</span>`).join('')}</div>`);
  if (allMeds.size)      lines.push(`<div><span class="cs-lbl rx">Medications</span>${[...allMeds.keys()].slice(0, 8).map(m => `<span class="cs-chip rx">${_esc(m)}</span>`).join('')}</div>`);
  if (allAllergies.size) lines.push(`<div><span class="cs-lbl al">⚠ Allergies</span>${[...allAllergies].map(a => `<span class="cs-chip al">${_esc(a)}</span>`).join('')}</div>`);
  const vitStr = Object.entries(latestVitals).map(([k, v]) => `${k.replace('body ','')}: <b>${_esc(v)}</b>`).join(' · ');
  if (vitStr) lines.push(`<div><span class="cs-lbl">Recent Vitals</span>${vitStr}</div>`);

  if (!lines.length) return '';

  const facilityStr = facilities.size ? [...facilities].join(', ') : 'ABDM-linked facility';
  const dateRange = (() => {
    const dates = records.map(r => r.record_date).filter(Boolean).sort();
    if (!dates.length) return '';
    if (dates[0] === dates[dates.length - 1]) return dates[0];
    return `${dates[0]} — ${dates[dates.length - 1]}`;
  })();

  return `<div style="background:linear-gradient(135deg,#f9f7f2 0%,#edf7ed 100%);border:1px solid #b8d8a8;border-radius:10px;padding:14px 16px;margin-bottom:18px">
    <div style="font-size:13px;font-weight:700;color:var(--green-deep);margin-bottom:10px">
      📊 Clinical Summary &nbsp;·&nbsp; <span style="font-weight:400;font-size:12px">${records.length} record${records.length !== 1 ? 's' : ''} from ${_esc(facilityStr)}${dateRange ? ' · ' + dateRange : ''}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:7px;font-size:12px;line-height:1.6;color:#333">${lines.join('')}</div>
  </div>`;
}

function _toggleFhirDetail(id) {
  const el  = document.getElementById(id);
  const arr = document.getElementById(id + '-arrow');
  if (!el) return;
  const open = el.style.display === 'none' || el.style.display === '';
  el.style.display = open ? 'block' : 'none';
  if (arr) { arr.textContent = open ? '›' : '‹'; arr.style.transform = open ? 'rotate(90deg)' : ''; }
}
window._toggleFhirDetail = _toggleFhirDetail;

// ── ABDM: Load received records — longitudinal (chronological) view ──
// Renders inline under the specific consent card that was clicked (recbox-<consentId>),
// not a single shared section at the bottom of the tab — previously every card's "View
// Records" wrote into one global container placed after the whole consent list, so on a
// list of several requests the records always appeared to "jump to the bottom of the page"
// regardless of which card was clicked.
async function _loadReceivedRecords(consentId, consentStatus) {
  const box = document.getElementById('recbox-' + consentId);
  if (!box) return;

  // Toggle: clicking "View Records" again on an already-open card just closes it
  if (box.dataset.open === '1') {
    box.style.display = 'none';
    box.innerHTML = '';
    box.dataset.open = '0';
    return;
  }
  box.dataset.open = '1';
  box.style.display = '';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Compliance: hide records for revoked/expired consents (mandatory per ABDM)
  if (consentStatus === 'revoked' || consentStatus === 'expired') {
    box.innerHTML = `<div style="background:#fff5f5;border:1px solid #fccaca;border-radius:8px;padding:14px 16px;font-size:13px;color:#c0392b;font-weight:500">
      🔒 Health records are not displayed for ${_esc(consentStatus)} consents.<br>
      <span style="font-size:12px;font-weight:400;color:#555;margin-top:4px;display:block">All copies held by this system have been deleted per ABDM compliance (HIU_FLOW_202/301).</span>
    </div>`;
    return;
  }

  box.innerHTML = '<div style="color:#888;font-size:13px;padding:6px 0">Loading records…</div>';

  const { data: records, error } = await supabase
    .from('hiu_received_records')
    .select('*')
    .eq('consent_request_id', consentId)
    .order('record_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) { box.innerHTML = `<div style="color:#c0392b;font-size:13px">${_esc(safeErrorMessage(error, 'Could not load records.'))}</div>`; return; }

  if (!records?.length) {
    box.innerHTML = '<div style="color:#888;font-size:13px;padding:10px 0">No records received yet. Records will appear here once the HIP pushes data — this may take a few minutes after the patient grants consent.</div>';
    return;
  }

  // Clinical summary banner
  const summaryHtml = _buildClinicalSummary(records);

  // Longitudinal view — group by date (Image 32 — PHR app Bahmni format)
  const hiIcon = { OPConsultation:'🩺', Prescription:'💊', DiagnosticReport:'🧪',
    DischargeSummary:'🏥', ImmunizationRecord:'💉', WellnessRecord:'🌿', HealthDocumentRecord:'📄' };
  const hiLabel = { OPConsultation:'OPD Consultation', Prescription:'Prescription',
    DiagnosticReport:'Diagnostic Report', DischargeSummary:'Discharge Summary',
    ImmunizationRecord:'Immunization', WellnessRecord:'Wellness Record', HealthDocumentRecord:'Health Document' };

  const byDate = {};
  records.forEach(r => { const k = r.record_date || 'z_unknown'; (byDate[k] = byDate[k] || []).push(r); });
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  const timelineHtml = sortedDates.map(dk => {
    const dateLabel = dk === 'z_unknown' ? 'Date Unknown'
      : new Date(dk + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

    const cards = byDate[dk].map(r => {
      const src   = r.source_display || r.hip_id || 'Unknown Facility';
      const icon  = hiIcon[r.hi_type] || '📋';
      const type  = hiLabel[r.hi_type] || r.hi_type || 'Health Record';
      const detId = `fhir-${r.id}`;
      const fhirHtml = _parseFhirForDisplay(r.fhir_bundle, r.hi_type);

      return `<div style="border:1px solid #d0e8d0;border-radius:8px;background:#fafdf8;margin-bottom:8px;overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;gap:10px" data-onclick="_toggleFhirDetail" data-onclick-a0="${_esc(detId)}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#222">${icon} ${_esc(src)}</div>
            <div style="font-size:11px;color:#777;margin-top:2px">${_esc(type)}${r.care_context_ref ? ' &nbsp;·&nbsp; Ref: ' + _esc(r.care_context_ref) : ''}</div>
            ${r.raw_summary && !fhirHtml ? `<div style="font-size:11px;color:#555;margin-top:3px;font-style:italic">${_esc(r.raw_summary)}</div>` : ''}
          </div>
          <span id="${detId}-arrow" style="color:#999;font-size:18px;flex-shrink:0;transition:transform 0.2s;transform:rotate(90deg)">›</span>
        </div>
        <div id="${detId}" style="display:block;border-top:1px solid #e0f0d8;padding:10px 14px 14px">
          ${fhirHtml || `<div style="font-size:12px;color:#aaa;padding:4px 0">${_esc(r.raw_summary || 'No structured data available')}</div>`}
        </div>
      </div>`;
    }).join('');

    return `<div style="margin-bottom:22px">
      <div style="font-size:12px;font-weight:700;color:#3a6b3a;text-transform:uppercase;letter-spacing:0.6px;padding-bottom:6px;border-bottom:2px solid #c8e6c8;margin-bottom:10px">${dateLabel}</div>
      ${cards}
    </div>`;
  }).join('');

  box.innerHTML = summaryHtml + timelineHtml;
}
window._loadReceivedRecords = _loadReceivedRecords;

// Re-trigger the HIU health-data fetch for a granted consent. ABDM's sandbox
// sometimes ACKs a data request ("REQUESTED") but never dispatches the push;
// calling hiu_request_data again nudges it (records then arrive in ~30s).
async function _retriggerConsentFetch(consentId) {
  const box = document.getElementById('recbox-' + consentId);
  const btn = document.querySelector(`[data-onclick="_retriggerConsentFetch"][data-onclick-a0="${consentId}"]`);
  const origText = btn ? btn.textContent : '↻ Re-fetch data';
  if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }
  if (box) { box.style.display = ''; box.dataset.open = '1'; }
  const setMsg = (msg, color) => { if (box) box.innerHTML = `<div style="font-size:12px;color:${color};padding:6px 0">${_esc(msg)}</div>`; };
  setMsg('Asking ABDM to re-send the health data…', '#666');
  try {
    const token = await _abdmGetToken();
    const res = await fetch(ABDM_AUTH_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ action: 'hiu_request_data', dbId: consentId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    setMsg('✓ Re-fetch requested — records usually arrive within ~30 seconds. Checking…', '#1a7a3a');
    if (box) box.dataset.open = '0';   // so _loadReceivedRecords opens it fresh
    setTimeout(() => _loadReceivedRecords(consentId, 'granted'), 9000);
  } catch (e) {
    setMsg('Re-fetch failed: ' + e.message, '#c0392b');
    if (box) box.dataset.open = '0';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}
window._retriggerConsentFetch = _retriggerConsentFetch;
window._loadAbdmTab = _loadAbdmTab;

// ── §18r / §18t — Netra + ENT Examination ────────
let _isNetra = false, _isKnm = false;

function collectOphthaData() {
  if (!_isNetra) return null;
  const ids = ['ey-va-od-dist','ey-va-od-near','ey-va-od-ph','ey-iop-od',
    'ey-va-os-dist','ey-va-os-near','ey-va-os-ph','ey-iop-os',
    'ey-eom','ey-pupils','ey-cornea-od','ey-cornea-os','ey-ac-od','ey-ac-os',
    'ey-lens-od','ey-lens-os','ey-as-notes','ey-fundus-od','ey-fundus-os',
    'ey-vartma','ey-sandhi','ey-shukla','ey-krishna','ey-drishti','ey-srava',
    'ey-vedana','ey-kosha','ey-roga-type','ey-notes'];
  const d = {};
  ids.forEach(id => { const v = document.getElementById(id)?.value?.trim(); if (v) d[id.replace('ey-','')] = v; });
  return Object.keys(d).length > 0 ? d : null;
}

function collectEntData() {
  if (!_isKnm) return null;
  const ids = ['nt-tm-r','nt-tm-l','nt-hearing-r','nt-hearing-l','nt-ear-dis-r','nt-ear-dis-l',
    'nt-rinne','nt-weber','nt-tinnitus','nt-vertigo','nt-septum','nt-turbinates',
    'nt-obstruction','nt-nasal-dis','nt-smell','nt-polyps','nt-tonsils','nt-pharynx',
    'nt-tongue','nt-oral-hygiene','nt-vocal-cords','nt-karna-type','nt-nasa-type',
    'nt-mukha-type','nt-ayurveda-notes'];
  const d = {};
  ids.forEach(id => { const v = document.getElementById(id)?.value?.trim(); if (v) d[id.replace('nt-','')] = v; });
  return Object.keys(d).length > 0 ? d : null;
}

// ── §18w — Obs/Gyn Examination ───────────────────
let _isPst = false;

window._calcObsGynDates = function() {
  const lmpVal = document.getElementById('og-lmp').value;
  if (!lmpVal) {
    document.getElementById('og-edd').value = '';
    document.getElementById('og-poa').value = '';
    return;
  }
  const lmp  = new Date(lmpVal + 'T00:00');
  const edd  = new Date(lmp); edd.setDate(edd.getDate() + 280);
  document.getElementById('og-edd').value = localDateStr(edd);
  const today    = new Date();
  const diffDays = Math.floor((today - lmp) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) { document.getElementById('og-poa').value = 'Pre-conception'; return; }
  const weeks = Math.floor(diffDays / 7), days = diffDays % 7;
  document.getElementById('og-poa').value = `${weeks}w ${days}d`;
};

function collectObsGynData() {
  if (!_isPst) return null;
  const ids = ['og-lmp','og-edd','og-poa','og-cycle','og-cycle-dur','og-flow','og-dysmenorrhoea','og-menopause',
    'og-gravida','og-para','og-abortion','og-living','og-fundal','og-fhs','og-fhs-rate',
    'og-presentation','og-engagement','og-fetal-mov','og-oedema','og-ps','og-pv',
    'og-artava-varna','og-artava-guna','og-artava-dushti','og-yoni-vyapad','og-garbhashaya','og-ayurveda-notes'];
  const data = {};
  ids.forEach(id => {
    const v = document.getElementById(id)?.value?.trim();
    if (v) data[id.replace('og-','')] = v;
  });
  return Object.keys(data).length > 0 ? data : null;
}

// ── §18ae — Immunization Record ──────────────────
// NIP India schedule: { key, name, due_months }
const NIP_SCHEDULE = [
  {key:'bcg',     name:'BCG',              mo:0},
  {key:'hepb0',   name:'Hep B (Birth)',    mo:0},
  {key:'opv0',    name:'OPV-0 (Birth)',    mo:0},
  {key:'dtpw1',   name:'DTwP/DTaP-1',     mo:1.5},
  {key:'opv1',    name:'OPV-1',           mo:1.5},
  {key:'ipv1',    name:'IPV-1',           mo:1.5},
  {key:'hepb1',   name:'Hep B-1',         mo:1.5},
  {key:'hib1',    name:'Hib-1',           mo:1.5},
  {key:'rota1',   name:'Rotavirus-1',      mo:1.5},
  {key:'dtpw2',   name:'DTwP/DTaP-2',     mo:2.5},
  {key:'opv2',    name:'OPV-2',           mo:2.5},
  {key:'ipv2',    name:'IPV-2',           mo:2.5},
  {key:'dtpw3',   name:'DTwP/DTaP-3',     mo:3.5},
  {key:'opv3',    name:'OPV-3',           mo:3.5},
  {key:'ipv3',    name:'IPV-3',           mo:3.5},
  {key:'hepb3',   name:'Hep B-3',         mo:3.5},
  {key:'hib3',    name:'Hib-3',           mo:3.5},
  {key:'mr1',     name:'MR/MMR-1',        mo:9},
  {key:'typhoid', name:'Typhoid Conj.',   mo:12},
  {key:'hepA1',   name:'Hep A-1',         mo:12},
  {key:'mmr2',    name:'MR-2/MMR',        mo:15},
  {key:'var1',    name:'Varicella-1',      mo:15},
  {key:'dtpwB',   name:'DTwP Booster-1', mo:18},
  {key:'opvB',    name:'OPV Booster',    mo:18},
  {key:'hibB',    name:'Hib Booster',    mo:18},
  {key:'dtBoost', name:'DT Booster',     mo:60},
  {key:'tt10',    name:'TT (10 yr)',      mo:120},
  {key:'tt16',    name:'TT (16 yr)',      mo:192},
];

async function _loadImmunizations(patientId) {
  const [immRes] = await Promise.all([
    supabase.from('immunizations')
      .select('id, vaccine_name, nip_key, dose_number, given_date, batch_number, next_due_date')
      .eq('patient_id', patientId)
      .eq('tenant_id', tenantId)
      .order('given_date', { ascending: false })
      .limit(12),
  ]);
  const data = immRes.data || [];
  _renderNipChips(data);
  _renderImmHistory(data);
}

function _renderNipChips(given) {
  const yr  = parseInt(document.getElementById('gr-yr').value) || 0;
  const mo  = parseInt(document.getElementById('gr-mo').value) || 0;
  const ageMos = yr * 12 + mo;
  const givenKeys = new Set(given.map(g => g.nip_key).filter(Boolean));
  const givenNames = given.map(g => g.vaccine_name.toLowerCase());
  const chips = document.getElementById('nip-chips');
  if (!chips) return;

  if (!ageMos) { chips.innerHTML = '<span style="font-size:11px;color:var(--text-muted);font-style:italic">Enter age above to see NIP status</span>'; return; }

  const relevant = NIP_SCHEDULE.filter(v => v.mo <= ageMos + 3);
  if (!relevant.length) { chips.innerHTML = ''; return; }

  chips.innerHTML = relevant.map(v => {
    const isGiven = givenKeys.has(v.key) || givenNames.some(n => n.includes(v.name.toLowerCase().split(' ')[0]));
    const isOverdue = !isGiven && v.mo <= ageMos - 2;
    const isDueSoon = !isGiven && !isOverdue;
    const cls = isGiven ? 'nip-given' : isOverdue ? 'nip-overdue' : 'nip-due-soon';
    const icon = isGiven ? '✓' : isOverdue ? '!' : '~';
    return `<span class="nip-chip ${cls}" title="${isGiven ? 'Given' : isOverdue ? 'Overdue' : 'Due soon'}">${icon} ${v.name}</span>`;
  }).join('');
}

function _renderImmHistory(data) {
  const histEl = document.getElementById('imm-history');
  if (!histEl) return;
  if (!data.length) { histEl.innerHTML = '<div style="font-size:11px;color:var(--text-muted);font-style:italic">No vaccinations recorded yet.</div>'; return; }
  histEl.innerHTML = `<table class="imm-history-tbl">
    <thead><tr><th>Date</th><th>Vaccine</th><th>Dose</th><th>Batch</th><th>Next Due</th></tr></thead>
    <tbody>${data.map(r => `<tr>
      <td>${new Date(r.given_date+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</td>
      <td style="font-weight:600">${_esc(r.vaccine_name)}</td>
      <td>${_esc(r.dose_number||'—')}</td>
      <td style="color:var(--text-muted)">${_esc(r.batch_number||'—')}</td>
      <td>${r.next_due_date ? new Date(r.next_due_date+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

window._toggleImmForm = function() {
  const form = document.getElementById('imm-record-form');
  const btn  = document.getElementById('btn-imm-toggle');
  const open = form.style.display === 'none';
  form.style.display = open ? '' : 'none';
  btn.textContent    = open ? '▲ Close' : '+ Record Vaccine';
  if (open) document.getElementById('imm-date').value = todayLocalStr();
};

window._onImmVaccineChange = function() {
  const val = document.getElementById('imm-vaccine').value;
  document.getElementById('imm-custom-row').style.display = val === 'custom|custom' ? '' : 'none';
};

window.saveImmunization = async function() {
  if (!_activePatient) return;
  const vaccineVal = document.getElementById('imm-vaccine').value;
  const isCustom   = vaccineVal === 'custom|custom';
  const vaccineName = isCustom
    ? document.getElementById('imm-custom-name').value.trim()
    : vaccineVal.split('|')[0];
  const nipKey      = isCustom ? null : vaccineVal.split('|')[1];
  const givenDate   = document.getElementById('imm-date').value;
  if (!vaccineName) { _toast('Select or enter vaccine name', 'error'); return; }
  if (!givenDate)   { _toast('Enter date given', 'error'); return; }

  const yr  = parseInt(document.getElementById('gr-yr').value) || 0;
  const mo  = parseInt(document.getElementById('gr-mo').value) || 0;
  const ageStr = yr > 0 ? `${yr}y ${mo}m` : `${mo}m`;

  const { error } = await supabase.from('immunizations').insert({
    tenant_id:            tenantId,
    patient_id:           _activePatient.id,
    visit_id:             _activeVisitId,
    given_by:             userId,
    vaccine_name:         vaccineName,
    nip_key:              nipKey,
    given_date:           givenDate,
    batch_number:         document.getElementById('imm-batch').value.trim() || null,
    age_at_vaccination:   ageStr,
    next_due_date:        document.getElementById('imm-next-due').value || null,
    // 24 Aug 2026 (Session 182): dose_number existed as a DB column and was even read by
    // abdm-fhir's ImmunizationRecord builder, but this form never actually captured it —
    // always saved NULL. Free-text, not a number picker, since real values include non-
    // numeric ones ("Booster") alongside plain sequence numbers.
    dose_number:          document.getElementById('imm-dose-number').value.trim() || null,
  });
  if (error) { _toast(safeErrorMessage(error, 'Could not record vaccination.'), 'error'); return; }

  _toast(`Vaccination recorded: ${vaccineName}`, 'info');
  // Reset form
  document.getElementById('imm-vaccine').value    = '';
  document.getElementById('imm-batch').value      = '';
  document.getElementById('imm-next-due').value   = '';
  document.getElementById('imm-dose-number').value= '';
  document.getElementById('imm-custom-name').value= '';
  document.getElementById('imm-custom-row').style.display = 'none';
  await _loadImmunizations(_activePatient.id);
  _abdmCareContextImmunization(_activePatient);
};

// 6 Sep 2026 (Session 198 follow-up #4) — real gap found: abdm-fhir's buildImmunization()
// has worked correctly since Session 87, and this form has saved real immunizations rows
// all along, but NOTHING ever declared 'ImmunizationRecord' to ABDM — no create_care_context/
// generate_link_token call existed anywhere for it, in this file or any other. Confirmed via
// a full grep across js/ for hi_types/hiType: OPConsultation/Prescription/DiagnosticReport/
// DischargeSummary/Invoice/WellnessRecord all have a real push site; ImmunizationRecord and
// HealthDocumentRecord had none. This one HI type could never have appeared in a patient's
// PHR app via the HIP-initiated mechanism, for any patient, ever — a real demo-blocking gap,
// not just a missed edge case. Patient-scoped ref (IMM-<patientId>), not visit-scoped —
// buildImmunization() itself reads ALL of a patient's immunizations, not one visit's, so a
// standing per-patient ref matches its own scope, same reasoning as WellnessRecord being
// visit-scoped because buildWellness() is.
async function _abdmCareContextImmunization(patient) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` };
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const ccRef   = `IMM-${patient.id}`;
    const display = `Immunization Record - ${dateStr}`;

    const ccRes = await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        action: 'create_care_context', patient_id: patient.id,
        care_context_ref: ccRef, display, hi_types: ['ImmunizationRecord'],
        abha_number: patient.abha_number, abha_address: patient.abha_address,
      }),
    });
    const ccData = await ccRes.json().catch(() => ({}));
    const realHiTypes = ccData?.hi_types?.length ? ccData.hi_types : ['ImmunizationRecord'];

    if (patient.abha_number || patient.abha_address) {
      await fetch(ABDM_HIP_FN, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          action: 'generate_link_token', patient_id: patient.id,
          abha_number: patient.abha_number, abha_address: patient.abha_address,
          care_contexts: realHiTypes.map(t => ({ referenceNumber: ccRef, display, hiType: t })),
        }),
      });
    }
  } catch (e) { console.warn('[ABDM] immunization care context failed:', e?.message); }
}

// ── §18ad — Growth Monitoring ────────────────────
// [P3, P15, P50, P85, P97] at each age in months
// WHO 0-60mo + IAP 5-18 yrs (Indian reference, combined sex approximate)
const GR_WEIGHT = { 0:[2.5,2.9,3.3,3.9,4.3],3:[4.4,5.0,6.0,7.0,7.7],6:[5.7,6.4,7.7,9.0,9.8],9:[6.7,7.5,9.0,10.4,11.4],12:[7.4,8.4,9.9,11.5,12.6],18:[8.5,9.6,11.3,13.0,14.3],24:[9.5,10.7,12.7,14.6,16.0],36:[11.1,12.5,14.7,17.0,18.7],48:[12.7,14.3,16.8,19.4,21.4],60:[14.2,16.0,18.8,21.8,24.1],72:[15.8,17.8,21.0,24.4,27.2],96:[18.8,21.4,25.5,30.3,34.2],120:[22.2,25.5,30.8,37.2,42.5],144:[26.8,31.2,38.2,47.0,54.3],168:[33.0,39.0,48.5,60.5,70.0],192:[40.5,48.0,59.5,73.0,84.0],216:[47.0,56.0,68.0,81.5,92.0] };
const GR_HEIGHT = { 0:[46.1,47.5,49.9,52.3,53.7],3:[55.6,57.4,60.0,62.6,64.4],6:[61.2,63.3,66.0,68.7,70.5],9:[65.6,67.8,70.9,73.8,75.8],12:[69.0,71.3,74.5,77.6,79.7],18:[74.0,76.8,80.2,83.5,85.8],24:[79.3,82.2,85.9,89.4,91.9],36:[88.7,91.9,95.8,99.7,102.4],48:[96.7,100.2,104.6,108.9,111.7],60:[103.7,107.4,112.0,116.5,119.4],72:[109.5,113.5,118.4,123.3,126.5],96:[120.2,124.7,130.4,136.0,139.7],120:[129.5,134.4,140.7,147.0,151.2],144:[137.8,143.3,150.3,157.4,162.1],168:[145.2,151.5,159.2,167.2,172.5],192:[151.0,158.0,166.5,175.0,180.5],216:[153.0,160.5,169.5,178.0,183.5] };
const GR_HC    = { 0:[32.1,33.1,34.5,36.0,37.0],3:[37.4,38.5,40.1,41.6,42.7],6:[40.6,41.8,43.4,44.9,46.0],9:[42.6,43.8,45.4,46.9,48.0],12:[43.8,45.1,46.7,48.2,49.2],18:[45.3,46.7,48.2,49.7,50.8],24:[46.2,47.6,49.1,50.6,51.7],36:[47.2,48.7,50.2,51.7,52.8] };

function _grInterp(ageMos, table) {
  const keys = Object.keys(table).map(Number).sort((a,b)=>a-b);
  if (ageMos <= keys[0]) return table[keys[0]];
  if (ageMos >= keys[keys.length-1]) return table[keys[keys.length-1]];
  for (let i = 0; i < keys.length-1; i++) {
    if (ageMos >= keys[i] && ageMos <= keys[i+1]) {
      const t = (ageMos - keys[i]) / (keys[i+1] - keys[i]);
      return table[keys[i]].map((v,j) => +(v + t*(table[keys[i+1]][j]-v)).toFixed(2));
    }
  }
  return table[keys[0]];
}

function _grBand(val, ref) {
  if (val == null) return null;
  if (val < ref[0]) return { band:'<3rd', label:'Severely Underweight / SAM', cls:'growth-badge-sam', flag:'sam' };
  if (val < ref[1]) return { band:'3–15th', label:'Underweight / MAM', cls:'growth-badge-mam', flag:'mam' };
  if (val < ref[3]) return { band:'15–85th', label:'Normal', cls:'growth-badge-ok', flag:'' };
  if (val < ref[4]) return { band:'85–97th', label:'Overweight', cls:'growth-badge-over', flag:'over' };
  return { band:'>97th', label:'Obese', cls:'growth-badge-over', flag:'over' };
}

function _grPctPos(val, ref) {
  // Returns 0–100 position within the P0–P100 bar
  if (val <= ref[0]) return Math.max(0, (val/ref[0]) * 3);
  if (val <= ref[1]) return 3  + (val-ref[0])/(ref[1]-ref[0]) * 12;
  if (val <= ref[2]) return 15 + (val-ref[1])/(ref[2]-ref[1]) * 35;
  if (val <= ref[3]) return 50 + (val-ref[2])/(ref[3]-ref[2]) * 35;
  if (val <= ref[4]) return 85 + (val-ref[3])/(ref[4]-ref[3]) * 12;
  return Math.min(100, 97 + (val-ref[4])/ref[4] * 3);
}

function _grMeter(label, val, unit, ref) {
  if (val == null || isNaN(val)) return '';
  const band = _grBand(val, ref);
  const pos  = _grPctPos(val, ref);
  return `<div class="growth-row">
    <span class="growth-row-label">${label}</span>
    <span style="font-size:13px;font-weight:500;min-width:56px">${val} ${unit}</span>
    <div style="flex:1">
      <div class="growth-pct-bar">
        <div class="gpb-z1"></div><div class="gpb-z2"></div><div class="gpb-z3"></div>
        <div class="gpb-z4"></div><div class="gpb-z5"></div><div class="gpb-z6"></div>
        <div class="growth-pct-marker" style="left:${pos}%"></div>
      </div>
      <div class="growth-pct-labels"><span>P3</span><span>P15</span><span>P50</span><span>P85</span><span>P97</span></div>
    </div>
    <span class="growth-badge ${band.cls}">${band.band}</span>
  </div>`;
}

window.calcGrowth = async function() {
  const yr  = parseInt(document.getElementById('gr-yr').value) || 0;
  const mo  = parseInt(document.getElementById('gr-mo').value) || 0;
  const ageMos = yr * 12 + mo;

  // Sync weight display from vitals
  const wtFromVitals = document.getElementById('v-weight').value;
  const wtDisp = document.getElementById('gr-wt-display');
  if (wtDisp) wtDisp.value = wtFromVitals ? wtFromVitals + ' kg' : '';

  // Refresh NIP chips when age changes
  if (_activePatient?.id && document.getElementById('imm-section')?.style.display !== 'none') {
    const immRes = await supabase.from('immunizations').select('vaccine_name,nip_key').eq('patient_id',_activePatient.id).eq('tenant_id',tenantId);
    _renderNipChips(immRes.data || []);
  }

  if (!ageMos) { document.getElementById('gr-meters').innerHTML = ''; return; }

  const wt = parseFloat(document.getElementById('v-weight').value) || null;
  const hc = parseFloat(document.getElementById('gr-hc').value) || null;

  // Look for height in gr-ht (added below) or exam-modern-notes — use dedicated input
  const htEl = document.getElementById('gr-ht');
  const ht = htEl ? parseFloat(htEl.value) || null : null;

  const wRef = _grInterp(ageMos, GR_WEIGHT);
  const hRef = _grInterp(ageMos, GR_HEIGHT);
  const cRef = ageMos <= 36 ? _grInterp(ageMos, GR_HC) : null;

  let html = '';
  html += _grMeter('Weight', wt, 'kg', wRef);
  html += _grMeter('Height', ht, 'cm', hRef);
  if (cRef) html += _grMeter('Head Circ.', hc, 'cm', cRef);
  document.getElementById('gr-meters').innerHTML = html;

  // Alert check
  const alertEl = document.getElementById('growth-alert');
  const flags = [];
  if (wt != null && _grBand(wt, wRef)?.flag === 'sam') flags.push('⚠ Weight < 3rd percentile — Severe Acute Malnutrition (SAM). Check MUAC. Refer to higher centre.');
  else if (wt != null && _grBand(wt, wRef)?.flag === 'mam') flags.push('⚠ Weight 3rd–15th percentile — Moderate Acute Malnutrition (MAM). Nutritional counselling required.');
  if (ht != null && _grBand(ht, hRef)?.flag === 'sam') flags.push('⚠ Height < 3rd percentile — Stunting. Assess for chronic malnutrition.');
  if (flags.length) {
    alertEl.style.cssText = 'display:block;padding:9px 12px;border-radius:7px;font-size:12px;font-weight:600;margin-bottom:10px;background:#fdecea;border:1.5px solid #f5c6c6;color:#8b1a1a';
    alertEl.innerHTML = flags.join('<br>');
  } else {
    alertEl.style.display = 'none';
  }
};

async function _loadGrowthHistory(patientId) {
  const histEl = document.getElementById('growth-history');
  if (!histEl) return;
  const { data } = await supabase.from('growth_records')
    .select('recorded_at, age_months, weight_kg, height_cm, hc_cm, weight_percentile_band, height_percentile_band')
    .eq('patient_id', patientId)
    .eq('tenant_id', tenantId)
    .order('recorded_at', { ascending: false })
    .limit(8);
  if (!data?.length) { histEl.innerHTML = ''; return; }
  histEl.innerHTML = `
    <table class="growth-history-tbl">
      <thead><tr><th>Date</th><th>Age</th><th>Weight</th><th>Height</th><th>HC</th><th>Wt %ile</th><th>Ht %ile</th></tr></thead>
      <tbody>${data.map(r => {
        const yrn = Math.floor(r.age_months/12), mon = r.age_months%12;
        return `<tr>
          <td>${new Date(r.recorded_at+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</td>
          <td>${yrn>0?yrn+'y ':''}${mon}m</td>
          <td>${r.weight_kg ? r.weight_kg+' kg' : '—'}</td>
          <td>${r.height_cm ? r.height_cm+' cm' : '—'}</td>
          <td>${r.hc_cm ? r.hc_cm+' cm' : '—'}</td>
          <td>${r.weight_percentile_band || '—'}</td>
          <td>${r.height_percentile_band || '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

window.saveGrowthRecord = async function() {
  const yr  = parseInt(document.getElementById('gr-yr').value) || 0;
  const mo  = parseInt(document.getElementById('gr-mo').value) || 0;
  const ageMos = yr * 12 + mo;
  if (!ageMos) { _toast('Enter patient age first', 'error'); return; }
  const wt = parseFloat(document.getElementById('v-weight').value) || null;
  const htEl = document.getElementById('gr-ht');
  const ht = htEl ? parseFloat(htEl.value) || null : null;
  const hc = parseFloat(document.getElementById('gr-hc').value) || null;
  if (!wt && !ht) { _toast('Enter at least weight or height to save', 'error'); return; }

  const wRef = _grInterp(ageMos, GR_WEIGHT);
  const hRef = _grInterp(ageMos, GR_HEIGHT);
  const bmi  = (wt && ht) ? +((wt / ((ht/100)**2)).toFixed(1)) : null;

  const { error } = await supabase.from('growth_records').insert({
    tenant_id:               tenantId,
    patient_id:              _activePatient.id,
    visit_id:                _activeVisitId,
    recorded_by:             userId,
    recorded_at:             todayLocalStr(),
    age_months:              ageMos,
    weight_kg:               wt,
    height_cm:               ht,
    hc_cm:                   hc,
    bmi,
    weight_percentile_band:  wt ? _grBand(wt, wRef)?.band : null,
    height_percentile_band:  ht ? _grBand(ht, hRef)?.band : null,
  });
  if (error) { _toast(safeErrorMessage(error, 'Could not save growth record.'), 'error'); return; }
  _toast('Growth record saved ✓', 'info');
  await _loadGrowthHistory(_activePatient.id);
};

// ── §18d — Prakriti Assessment ───────────────────
const PRAKRITI_QS = [
  { sec:'Sharira Prakriti — Physical Constitution (Questions 1–15)', q:'Body Build & Frame', v:'Thin, lean, light — difficulty gaining weight', p:'Medium, muscular, well-proportioned', k:'Heavy, stocky, broad — gains weight easily' },
  { q:'Skin Texture', v:'Dry, rough, cool — prone to cracking and flaking', p:'Warm, slightly oily, reddish — prone to rashes', k:'Thick, smooth, cool, moist, lustrous' },
  { q:'Hair', v:'Dry, brittle, frizzy or thin — prone to split ends', p:'Fine, straight, oily — premature greying or thinning', k:'Thick, lustrous, slightly wavy and oily' },
  { q:'Eyes', v:'Small, dry, active movements — prone to twitching', p:'Penetrating, sharp, light-sensitive, reddish tinge', k:'Large, moist, calm, well-lubricated' },
  { q:'Joints', v:'Prominent, bony — crackling sounds, hypermobile', p:'Moderate, somewhat loose, warm to touch', k:'Well-padded, stable, well-lubricated, firm' },
  { q:'Weight & Body Composition', v:'Difficulty gaining — loses weight easily under stress', p:'Moderate — gains or loses with moderate effort', k:'Gains weight very easily — extremely difficult to lose' },
  { q:'Appetite & Hunger', v:'Variable, irregular — sometimes forgets to eat', p:'Strong, intense — irritable or headache if meal is delayed', k:'Low but consistent — can comfortably skip meals' },
  { q:'Digestion', v:'Irregular, variable — prone to gas, bloating, gurgling', p:'Strong, sharp — prone to acidity and heartburn', k:'Slow but steady — occasional heaviness after eating' },
  { q:'Bowel Habits', v:'Dry, hard stools — tends toward constipation', p:'Loose, frequent — sometimes loose motions or urgency', k:'Regular, once daily, formed, moderate pace' },
  { q:'Perspiration', v:'Scanty, almost no odour — body tends to be dry', p:'Moderate to profuse — distinct, strong or pungent odour', k:'Moderate — pleasant or neutral odour' },
  { q:'Sleep', v:'Light, interrupted — difficulty falling asleep, active dreams', p:'Moderate and efficient — sharp or action-packed dreams', k:'Deep, heavy, prolonged — difficult to wake, feels groggy' },
  { q:'Physical Energy & Stamina', v:'Quick bursts of energy — tires easily, needs frequent rest', p:'Moderate and consistent energy throughout the day', k:'Slow to start — but excellent stamina and endurance' },
  { q:'Voice & Speech', v:'Rapid, talks a lot, sometimes hoarse or thin-voiced', p:'Sharp, clear, forceful, persuasive', k:'Deep, melodious, slow and thoughtful' },
  { q:'Climate Preference', v:'Dislikes cold, wind, dryness — strongly prefers warmth', p:'Dislikes heat, strong sun — prefers cool, ventilated spaces', k:'Dislikes cold and damp — tolerates heat moderately' },
  { q:'Circulation & Extremities', v:'Cold hands/feet, poor circulation — prone to tremors', p:'Warm hands/feet, good circulation — warm body temperature', k:'Cool, stable — good circulation, steady, moderate pulse' },
  { sec:'Manasa Prakriti — Mental Constitution (Questions 16–20)', q:'Memory', v:'Quick to learn new things — but also quick to forget', p:'Sharp, accurate, retentive — remembers details and slights', k:'Slow to learn but permanent memory — never forgets' },
  { q:'Thinking Style', v:'Quick, creative, imaginative — but easily distracted', p:'Analytical, logical, precise — perfectionist tendencies', k:'Methodical, calm, deliberate — resistant to change' },
  { q:'Emotional Tendency', v:'Enthusiastic, anxious, changeable — fear/worry prone', p:'Ambitious, competitive, intense — irritability prone', k:'Patient, nurturing, possessive — contentment prone' },
  { q:'Response to Stress', v:'Anxiety, nervousness, panic — feels overwhelmed quickly', p:'Anger, irritability, frustration — becomes critical or sharp', k:'Withdrawal, overeating, excessive sleep, inertia' },
  { q:'Decision Making', v:'Quick decisions — but inconsistent, changes mind often', p:'Decisive and confident — sometimes rigid and inflexible', k:'Slow, very careful and thorough — once decided, stays committed' },
];
let _pkAnswers = {};

window.openPrakritiModal = function() {
  if (!_activePatient) return;
  _pkAnswers = {};
  _renderPkQuestions();
  // Pre-load existing assessment answers if available
  const existing = _activePatient?.prakriti_data;
  if (existing?.answers) {
    _pkAnswers = { ...existing.answers };
    Object.entries(_pkAnswers).forEach(([qi, d]) => _selectPkOpt(parseInt(qi), d, false));
    _updatePkScores();
  }
  document.getElementById('prakriti-overlay').style.display = 'flex';
};

window.closePrakritiModal = function() {
  document.getElementById('prakriti-overlay').style.display = 'none';
};

window.resetPrakritiForm = function() {
  _pkAnswers = {};
  document.querySelectorAll('.pk-opt').forEach(el => el.classList.remove('sel-v','sel-p','sel-k'));
  const rb = document.getElementById('pk-result-box');
  if (rb) rb.style.display = 'none';
  _updatePkScores();
};

function _renderPkQuestions() {
  const body = document.getElementById('pk-modal-body');
  let html = '';
  let lastSec = '';
  PRAKRITI_QS.forEach((q, i) => {
    if (q.sec && q.sec !== lastSec) {
      html += `<div class="pk-section-hdr">${q.sec}</div>`;
      lastSec = q.sec;
    }
    html += `<div class="pk-q-card" id="pk-q-${i}">
      <div class="pk-q-text"><span style="font-size:10px;color:var(--text-muted);font-weight:700;margin-right:6px">${i+1}.</span>${q.q}</div>
      <div class="pk-opts">
        <div class="pk-opt" data-onclick="_selectPkOptFromAttr" data-onclick-a0="${i}" data-onclick-a1="V" data-onclick-a2="@true">
          <div style="font-size:9px;font-weight:700;color:#4080c0;letter-spacing:.4px;margin-bottom:3px">VATA</div>${q.v}
        </div>
        <div class="pk-opt" data-onclick="_selectPkOptFromAttr" data-onclick-a0="${i}" data-onclick-a1="P" data-onclick-a2="@true">
          <div style="font-size:9px;font-weight:700;color:#d05020;letter-spacing:.4px;margin-bottom:3px">PITTA</div>${q.p}
        </div>
        <div class="pk-opt" data-onclick="_selectPkOptFromAttr" data-onclick-a0="${i}" data-onclick-a1="K" data-onclick-a2="@true">
          <div style="font-size:9px;font-weight:700;color:#2d7a4f;letter-spacing:.4px;margin-bottom:3px">KAPHA</div>${q.k}
        </div>
      </div>
    </div>`;
  });
  html += '<div id="pk-result-box" class="pk-result-box" style="display:none"></div>';
  body.innerHTML = html;
}

window._selectPkOpt = function(qi, dosha, scroll) {
  _pkAnswers[qi] = dosha;
  const card = document.getElementById(`pk-q-${qi}`);
  if (card) {
    card.querySelectorAll('.pk-opt').forEach((el, idx) => {
      el.classList.remove('sel-v','sel-p','sel-k');
      if (['V','P','K'][idx] === dosha) el.classList.add(`sel-${dosha.toLowerCase()}`);
    });
    if (scroll) {
      const next = document.getElementById(`pk-q-${qi+1}`);
      if (next) next.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }
  }
  _updatePkScores();
};

function _updatePkScores() {
  const vals = Object.values(_pkAnswers);
  const V = vals.filter(x=>x==='V').length;
  const P = vals.filter(x=>x==='P').length;
  const K = vals.filter(x=>x==='K').length;
  const total = vals.length;
  document.getElementById('pk-v-count').textContent = V;
  document.getElementById('pk-p-count').textContent = P;
  document.getElementById('pk-k-count').textContent = K;
  document.getElementById('pk-progress-text').textContent = `${total} of ${PRAKRITI_QS.length} answered`;
  const tot = V + P + K || 1;
  document.getElementById('pk-bar-v').style.flex = V / tot;
  document.getElementById('pk-bar-p').style.flex = P / tot;
  document.getElementById('pk-bar-k').style.flex = K / tot;
  if (total >= PRAKRITI_QS.length) _showPkResult(V, P, K);
}

function _calcPrakritiResult(V, P, K) {
  const sorted = [['V',V],['P',P],['K',K]].sort((a,b) => b[1]-a[1]);
  const diff12 = sorted[0][1] - sorted[1][1];
  const diff13 = sorted[0][1] - sorted[2][1];
  if (diff13 <= 3) return 'Sama / Tridosha';
  if (diff12 <= 3) {
    const pair = [sorted[0][0], sorted[1][0]].sort().join('');
    return { 'PV':'Vata-Pitta', 'KV':'Vata-Kapha', 'KP':'Pitta-Kapha' }[pair] || pair;
  }
  return sorted[0][0] === 'V' ? 'Vata' : sorted[0][0] === 'P' ? 'Pitta' : 'Kapha';
}

function _showPkResult(V, P, K) {
  const result = _calcPrakritiResult(V, P, K);
  const box    = document.getElementById('pk-result-box');
  if (!box) return;
  box.style.display = '';
  box.innerHTML = `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:6px">Assessment Complete — Result</div>
    <div class="pk-result-dosha">${result}</div>
    <div style="display:flex;gap:20px;justify-content:center;margin-top:8px;font-size:13px;font-weight:600">
      <span style="color:#4080c0">Vata: ${V}</span>
      <span style="color:#d05020">Pitta: ${P}</span>
      <span style="color:#2d7a4f">Kapha: ${K}</span>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px">Click "Apply &amp; Save" to record this permanently on the patient file</div>`;
  box.scrollIntoView({ behavior:'smooth', block:'center' });
}

window.applyPrakritiResult = async function() {
  const answered = Object.keys(_pkAnswers).length;
  if (answered < PRAKRITI_QS.length) {
    _toast(`Please answer all ${PRAKRITI_QS.length} questions — ${PRAKRITI_QS.length - answered} remaining`, 'error');
    return;
  }
  const V = Object.values(_pkAnswers).filter(x=>x==='V').length;
  const P = Object.values(_pkAnswers).filter(x=>x==='P').length;
  const K = Object.values(_pkAnswers).filter(x=>x==='K').length;
  const result = _calcPrakritiResult(V, P, K);

  const prakritiData = {
    answers: { ..._pkAnswers },
    scores: { V, P, K },
    result,
    assessed_by: profile.full_name,
    assessed_at: todayLocalStr(),
  };

  const { error } = await supabase.from('patients').update({
    prakriti_data:         prakritiData,
    prakriti_assessed_at:  todayLocalStr(),
  }).eq('id', _activePatient.id);

  if (error) { _toast(safeErrorMessage(error, 'Could not save Prakriti data.'), 'error'); return; }

  _activePatient.prakriti_data = prakritiData;
  document.getElementById('ay-prakriti').value = result;
  const pill = document.getElementById('pt-prakriti');
  pill.textContent = result; pill.style.display = '';

  closePrakritiModal();
  _toast(`Prakriti assessed: ${result} (V:${V} P:${P} K:${K}) — saved to patient record`, 'info');
};

// ── §18ab — Paediatric Vital Ranges ──────────────
const PEDI_VITAL_RANGES = {
  neonate:    { bp:'60–90 / 30–60', hr:'120–160', rr:'40–60', spo2:'≥95%', temp:'97–99.5°F', wt:'2.5–4.5 kg' },
  infant:     { bp:'70–100 / 50–70', hr:'100–160', rr:'30–60', spo2:'≥95%', temp:'97–99.5°F', wt:'4–10 kg' },
  toddler:    { bp:'80–110 / 50–80', hr:'90–150',  rr:'24–40', spo2:'≥96%', temp:'97–99.5°F', wt:'10–18 kg' },
  school:     { bp:'85–120 / 55–80', hr:'70–120',  rr:'18–30', spo2:'≥96%', temp:'97–99.5°F', wt:'18–40 kg' },
  adolescent: { bp:'100–130 / 60–85', hr:'60–100', rr:'12–20', spo2:'≥97%', temp:'97–99.5°F', wt:'40–70 kg' },
};

window.updateVitalRanges = function(band) {
  const r = PEDI_VITAL_RANGES[band];
  const note = document.getElementById('kau-range-note');
  if (!r) {
    ['bp','hr','rr','spo2','temp','wt'].forEach(k => { const el = document.getElementById('vr-'+k); if(el) el.textContent=''; });
    if(note) note.textContent='';
    return;
  }
  const set = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = 'Normal: ' + val; };
  set('vr-bp', r.bp + ' mmHg');
  set('vr-hr', r.hr + ' bpm');
  set('vr-rr', r.rr + ' /min');
  set('vr-spo2', r.spo2);
  set('vr-temp', r.temp);
  set('vr-wt', r.wt);
  if(note) note.textContent = '↑ age-adjusted ranges shown';
};

// ── §12d — Medical Certificate ────────────────────
window.openMcModal = function() {
  if (!_activePatient) return;
  const diag = document.getElementById('d-modern').value || document.getElementById('d-ayurveda').value || '';
  document.getElementById('mc-diagnosis').value = diag;
  document.getElementById('mc-rest-from').value = todayLocalStr();
  document.getElementById('mc-rest-to').value   = '';
  document.getElementById('mc-remarks').value   = '';
  document.getElementById('mc-overlay').style.display = 'flex';
};
window.closeMcModal = function() {
  document.getElementById('mc-overlay').style.display = 'none';
};

window.printMedCert = function() {
  const tenant   = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
  const date     = new Date().toLocaleDateString('en-IN', {day:'2-digit',month:'long',year:'numeric'});
  const certType = document.getElementById('mc-type').value;
  const diag     = document.getElementById('mc-diagnosis').value.trim();
  const fromDate = document.getElementById('mc-rest-from').value;
  const toDate   = document.getElementById('mc-rest-to').value;
  const advice   = document.getElementById('mc-advice').value;
  const remarks  = document.getElementById('mc-remarks').value.trim();

  const certTitle = certType === 'fitness' ? 'CERTIFICATE OF FITNESS'
                  : certType === 'sick_leave' ? 'SICK LEAVE CERTIFICATE'
                  : 'MEDICAL CERTIFICATE';
  const adviceText = {
    rest:       'Complete rest is advised.',
    light_duty: 'Light duty only — no strenuous physical work.',
    fit:        'The patient is fit to resume normal duties / work / school.',
    unfit:      'The patient is unfit for duties / work / school.',
    custom:     remarks || '',
  }[advice] || '';

  const restStr = fromDate
    ? `from <strong>${new Date(fromDate+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</strong>` +
      (toDate ? ` to <strong>${new Date(toDate+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</strong>` : '')
    : '';
  const regStr = profile.registration_number ? `Reg. No.: ${profile.registration_number}` : '';

  document.getElementById('mc-print').innerHTML = `
<div style="font-family:'DM Sans',sans-serif;max-width:600px;margin:0 auto;padding:0;color:#1c2b1f">
  <div style="text-align:center;padding:16px 20px 10px;border-bottom:3px double #1a4a2e">
    <div style="font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600;color:#1a4a2e">${_esc(tenant.name || 'Ayurveda Hospital')}</div>
    <div style="font-size:11px;color:#6a8070;margin-top:2px">${_esc(tenant.city||'')} ${_esc(tenant.state||'')}</div>
  </div>
  <div style="text-align:center;padding:12px;background:#f5fbf8;border-bottom:1px solid #c8ddd0">
    <div style="font-size:16px;font-weight:700;letter-spacing:2px;color:#1a4a2e;text-transform:uppercase">${_esc(certTitle)}</div>
  </div>
  <div style="padding:20px 24px">
    <p style="font-size:13px;line-height:1.9;margin:0 0 14px">
      This is to certify that <strong>${_esc(_activePatient.name)}</strong>
      (UHID: ${_uhid(_activePatient.id)}${_activePatient.phone ? ', Ph: '+_esc(_activePatient.phone) : ''})
      attended this clinic on <strong>${date}</strong>
      ${diag ? `and is suffering from / was examined for <strong>${_esc(diag)}</strong>` : ''}.
    </p>
    <p style="font-size:13px;line-height:1.9;margin:0 0 6px">
      ${_esc(adviceText)}
      ${restStr ? `Rest is advised ${restStr}.` : ''}
    </p>
    ${remarks && advice !== 'custom' ? `<p style="font-size:12px;color:#4a6352;line-height:1.7;margin:6px 0 0">${_esc(remarks)}</p>` : ''}
    <div style="margin-top:32px;display:flex;justify-content:space-between;align-items:flex-end">
      <div style="font-size:11px;color:#8a9e90">
        <div>Date: ${date}</div>
        <div style="margin-top:2px">UHID: ${_uhid(_activePatient.id)}</div>
      </div>
      <div style="text-align:center">
        <div style="width:180px;border-top:1px solid #aaa;padding-top:6px;font-size:12px;color:#2a4a32">
          <strong>${_esc(profile.full_name)}</strong>
          ${profile.qualification ? `<div style="font-size:11px;color:#6a8070">${_esc(profile.qualification)}</div>` : ''}
          ${regStr ? `<div style="font-size:10px;color:#8a9e90">${_esc(regStr)}</div>` : ''}
        </div>
      </div>
    </div>
  </div>
  <div style="text-align:center;padding:8px;font-size:9px;color:#aaa;border-top:1px solid #eee">Powered by AyurXpert Technologies™</div>
</div>`;

  document.getElementById('mc-overlay').style.display = 'none';
  document.body.classList.add('medcert-print');
  window.addEventListener('afterprint', () => document.body.classList.remove('medcert-print'), { once: true });
  window.print();
};

// ── §18ac — Paediatric Dose Calculator ───────────
const PEDI_FORMS = {
  churna:  { adult:3,   unit:'g',  },
  vati:    { adult:0.5, unit:'g',  },
  kwatha:  { adult:60,  unit:'ml', },
  arishta: { adult:20,  unit:'ml', },
  avaleha: { adult:12,  unit:'g',  },
  ghrita:  { adult:12,  unit:'g',  },
  taila:   { adult:5,   unit:'ml', },
};

window.togglePediCalc = function() {
  const body   = document.getElementById('pedi-calc-body');
  const toggle = document.getElementById('pedi-calc-toggle');
  const open   = body.style.display === 'none';
  body.style.display = open ? '' : 'none';
  toggle.textContent = open ? '▲ Hide' : '▼ Show';
};

window.onPediFormChange = function() {
  const cfg = PEDI_FORMS[document.getElementById('pedi-form').value];
  if (!cfg) return;
  document.getElementById('pedi-adult-dose').value = cfg.adult;
  document.getElementById('pedi-unit').value       = cfg.unit;
  calcPediDose();
};

window.calcPediDose = function() {
  const yrs       = parseFloat(document.getElementById('pedi-age-yr').value)  || 0;
  const mos       = parseFloat(document.getElementById('pedi-age-mo').value)  || 0;
  const adultDose = parseFloat(document.getElementById('pedi-adult-dose').value);
  const unit      = document.getElementById('pedi-unit').value || 'g';
  const result    = document.getElementById('pedi-result');
  const ageYrs    = yrs + mos / 12;

  if (!ageYrs || !adultDose) { result.style.display = 'none'; _pediHighlight(null); return; }

  const childDose = adultDose * ageYrs / (ageYrs + 12);
  let valText, tradText;

  if (unit === 'g') {
    const mg = childDose * 1000;
    if (mg < 1000) {
      valText  = `${Math.round(mg)} mg`;
      tradText = `≈ ${(mg / 125).toFixed(1)} Ratti`;
    } else {
      valText  = `${childDose.toFixed(2)} g`;
      tradText = `≈ ${childDose.toFixed(1)} Masha`;
    }
  } else {
    valText  = `${childDose.toFixed(1)} ml`;
    tradText = 'liquid preparation';
  }

  document.getElementById('pedi-dose-val').textContent  = valText;
  document.getElementById('pedi-dose-trad').textContent = tradText;
  result.style.display = '';
  _pediHighlight(ageYrs);
};

function _pediHighlight(ageYrs) {
  const rows = document.querySelectorAll('#pedi-ref-tbl tbody tr');
  rows.forEach(r => r.classList.remove('pedi-hl'));
  if (ageYrs === null) return;
  const ageMos = ageYrs * 12;
  rows.forEach(r => {
    const mn = parseFloat(r.dataset.min), mx = parseFloat(r.dataset.max);
    if (ageMos >= mn && ageMos < mx) r.classList.add('pedi-hl');
  });
}

// ── §18c — Swasthya Card ──────────────────────────
function _getRitu() {
  const m = new Date().getMonth() + 1;
  if (m <= 2)  return { name:'Shishira — Late Winter', advice:'Keep body warm. Daily Abhyanga with sesame oil is essential. Prefer hot, unctuous, nourishing food. Avoid cold and dry foods.' };
  if (m <= 4)  return { name:'Vasanta — Spring',       advice:'Vamana or Nasya therapy season. Avoid heavy Kapha-aggravating foods (excess sweets, curd, dairy). Prefer light, warm, easily digestible meals.' };
  if (m <= 6)  return { name:'Grishma — Summer',       advice:'Stay cool. Drink adequate water, coconut water, and herbal sherbets. Avoid excess exertion and direct sun. Light, cooling, easily digestible diet.' };
  if (m <= 8)  return { name:'Varsha — Monsoon',       advice:'Digestive fire is naturally weak. Eat freshly cooked, easily digestible food. Avoid raw vegetables and unboiled water. Basti therapy is ideal this season.' };
  if (m <= 10) return { name:'Sharada — Autumn',       advice:'Avoid sour, pungent, and hot foods. Light meals. Virechana (purgation) is ideal. Moonlit night walks are beneficial for health.' };
  return             { name:'Hemanta — Early Winter',  advice:'Nourishing, strengthening diet. Vigorous exercise and Yoga recommended. Daily Abhyanga with warm oil. Increased appetite — channel it into nutritious food.' };
}

window.printSwasthyaCard = function() {
  if (!_activePatient) return;

  const tenant  = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
  const date    = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
  const prakriti = document.getElementById('ay-prakriti').value || '';
  const agni    = document.getElementById('d-agni').value || document.getElementById('ay-agni').value || '';
  const koshta  = document.getElementById('ay-koshta').value || '';
  const pathya  = document.getElementById('adv-pathya').value.trim();
  const apathya = document.getElementById('adv-apathya').value.trim();
  const vihara  = document.getElementById('ay-vihara').value.trim();
  const fuDate  = document.getElementById('fu-date').value;
  const fuNotes = document.getElementById('fu-notes').value.trim();

  const pcMap = {
    'Vata':{ bg:'#eef4ff', col:'#1a3a5c' }, 'Pitta':{ bg:'#fff8e1', col:'#7a4f00' },
    'Kapha':{ bg:'#e8f5ee', col:'#1a4a2e' }, 'Vata-Pitta':{ bg:'#f5eeff', col:'#4a1a6c' },
    'Pitta-Kapha':{ bg:'#fffce0', col:'#4a4200' }, 'Vata-Kapha':{ bg:'#eef5ff', col:'#1a3a5c' },
    'Sama Tridosha':{ bg:'#f5f5f5', col:'#333' },
  };
  const pc   = pcMap[prakriti] || { bg:'#f5f5f5', col:'#444' };
  const ritu = _getRitu();

  const defaultDinacharya = 'Rise before sunrise · Oil pulling with sesame oil · Tongue scraping · 2 drops Anu Taila Nasya · Daily Abhyanga before bath · 30 min Yoga + Pranayama · Regular meal timings · Early dinner · Sleep by 10 PM';
  const dinText = vihara || defaultDinacharya;

  const fuStr = fuDate
    ? `<strong style="color:#1a4a2e">${new Date(fuDate + 'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</strong>${fuNotes ? ' — ' + _esc(fuNotes) : ''}`
    : 'As advised by doctor';

  document.getElementById('sc-print').innerHTML = `
<div style="font-family:'DM Sans',sans-serif;max-width:680px;margin:0 auto;color:#1c2b1f">

  <div style="background:#1a4a2e;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600">${_esc(tenant.name || 'Ayurveda Hospital')}</div>
        <div style="font-size:11px;opacity:.75;margin-top:2px">Swasthya Rakshana OPD — Preventive Health</div>
      </div>
      <div style="text-align:right;font-size:11px;opacity:.8">
        <div>${date}</div><div>Token #${_esc(_activeVisit?.token_number || '—')}</div>
      </div>
    </div>
    <div style="text-align:center;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.3)">
      <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:600;letter-spacing:1.5px">स्वास्थ्य रक्षा पत्र</div>
      <div style="font-size:12px;opacity:.85;margin-top:2px;letter-spacing:.5px">SWASTHYA RAKSHA PATRA — Health Protection Card</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 140px;border:1px solid #c8ddd0;border-top:none">
    <div style="padding:14px 16px;border-right:1px solid #c8ddd0">
      <div style="font-size:19px;font-weight:600;color:#1a4a2e">${_esc(_activePatient.name)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:#4a6352;margin-top:4px">
        <span>UHID: <strong>${_uhid(_activePatient.id)}</strong></span>
        ${_activePatient.abha_number ? `<span>ABHA: <strong>${_esc(_activePatient.abha_number)}</strong></span>` : ''}
        <span>Phone: <strong>${_esc(_activePatient.phone || '—')}</strong></span>
      </div>
      <div style="font-size:12px;color:#4a6352;margin-top:4px">
        Doctor: <strong>${_esc(profile.full_name)}</strong>
        ${agni  ? ` &nbsp;·&nbsp; Agni: <strong>${_esc(agni)}</strong>`  : ''}
        ${koshta ? ` &nbsp;·&nbsp; Koshta: <strong>${_esc(koshta)}</strong>` : ''}
      </div>
    </div>
    <div style="padding:12px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#8a9e90;margin-bottom:6px">Prakriti</div>
      ${prakriti
        ? `<div style="background:${pc.bg};color:${pc.col};font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:600;padding:7px 12px;border-radius:8px;border:2px solid ${pc.col};line-height:1.3">${_esc(prakriti)}</div>`
        : `<div style="font-size:11px;color:#aaa;font-style:italic">Not assessed</div>`}
    </div>
  </div>

  <div style="background:#f5fbf8;border:1px solid #c8ddd0;border-top:none;padding:10px 16px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#4a6352;margin-bottom:4px">🍂 Ritucharya — Seasonal Health Guide</div>
    <div style="font-size:12px"><strong>${_esc(ritu.name)}</strong> — ${_esc(ritu.advice)}</div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;border:1px solid #c8ddd0;border-top:none">
    <div style="padding:12px 16px;border-right:1px solid #c8ddd0">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#1a7a4f;margin-bottom:6px">✅ Pathya — Follow</div>
      ${pathya
        ? `<div style="font-size:12px;line-height:1.8">${_esc(pathya).replace(/\n/g,'<br>')}</div>`
        : `<div style="font-size:12px;color:#aaa;font-style:italic">As advised by doctor</div>`}
    </div>
    <div style="padding:12px 16px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#c0392b;margin-bottom:6px">❌ Apathya — Avoid</div>
      ${apathya
        ? `<div style="font-size:12px;line-height:1.8">${_esc(apathya).replace(/\n/g,'<br>')}</div>`
        : `<div style="font-size:12px;color:#aaa;font-style:italic">As advised by doctor</div>`}
    </div>
  </div>

  <div style="border:1px solid #c8ddd0;border-top:none;padding:10px 16px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#4a6352;margin-bottom:5px">🌅 Dinacharya — Recommended Daily Routine</div>
    <div style="font-size:12px;line-height:1.9;color:#1a3a2e">${_esc(dinText).replace(/\n/g,'<br>').replace(/ · /g,'&ensp;·&ensp;')}</div>
  </div>

  <div style="display:flex;justify-content:space-between;align-items:center;border:1px solid #c8ddd0;border-top:none;padding:10px 16px;background:#fafbf9;border-radius:0 0 6px 6px">
    <div style="font-size:12px;color:#4a6352"><strong>Follow-up:</strong> ${fuStr}</div>
    <div style="text-align:center">
      <div style="width:150px;border-top:1px solid #aaa;padding-top:5px;font-size:11px;color:#7a8e80">
        ${_esc(profile.full_name)}<br><span style="font-size:10px">Swasthya Rakshana OPD</span>
      </div>
    </div>
  </div>

  <div style="text-align:center;margin-top:8px;font-size:10px;color:#aaa">Powered by AyurXpert Technologies™</div>
</div>`;

  document.body.classList.add('swasthya-print');
  window.addEventListener('afterprint', () => document.body.classList.remove('swasthya-print'), { once: true });
  window.print();
};

// ── Print ─────────────────────────────────────────
document.getElementById('btn-print-rx').addEventListener('click', () => {
  if (!_activePatient) return;

  const tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
  const rx   = _getRxData();
  const date = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });

  document.getElementById('print-header').innerHTML = `
    <div style="text-align:center;margin-bottom:16px;border-bottom:2px solid #1a4a2e;padding-bottom:12px">
      <h2 style="font-family:'Cormorant Garamond',serif;font-size:24px;color:#1a4a2e;margin:0">${_esc(tenant.name || 'AyurXpert Clinic')}</h2>
      <p style="font-size:12px;color:#8a9e90;margin-top:4px">${_esc(tenant.city || '')} ${_esc(tenant.state || '')}</p>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:12px">
      <div>Patient: <strong>${_esc(_activePatient.name)}</strong></div>
      <div style="text-align:right">Date: <strong>${date}</strong></div>
      <div>UHID: <strong>${_uhid(_activePatient.id)}</strong></div>
      <div style="text-align:right">Token: <strong>#${_esc(_activeVisit?.token_number)}</strong></div>
      <div>Doctor: <strong>${_esc(profile.full_name)}</strong></div>
      <div style="text-align:right">Phone: <strong>${_esc(_activePatient.phone || '—')}</strong></div>
    </div>
    ${document.getElementById('d-modern').value || document.getElementById('d-ayurveda').value ? `
    <div style="background:#f0f9f4;padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px">
      ${document.getElementById('d-modern').value ? `Diagnosis: <strong>${document.getElementById('d-modern').value}</strong>` : ''}
      ${document.getElementById('d-ayurveda').value ? ` / <strong>${document.getElementById('d-ayurveda').value}</strong>` : ''}
    </div>` : ''}
    <div style="font-size:12px;font-weight:600;color:#1a4a2e;margin-bottom:8px;border-bottom:1px solid #d4e6da;padding-bottom:4px">&#8478; Medicines</div>
    ${rx.map((r,i) => `<div style="padding:6px 0;border-bottom:1px dashed #d4e6da;font-size:12px">
      <strong>${i+1}. ${r.name}</strong> — ${r.dose} ${r.freq} × ${r.dur}
      ${r.anupana ? `<span style="color:#8a9e90"> (with ${r.anupana})</span>` : ''}
      ${r.timing ? `<span style="color:#8a9e90"> — ${r.timing}</span>` : ''}
    </div>`).join('')}
    ${document.getElementById('rx-instructions').value ? `<p style="font-size:11px;color:#4a6352;margin-top:8px">${document.getElementById('rx-instructions').value}</p>` : ''}
    ${document.getElementById('adv-pathya').value ? `<div style="margin-top:12px;font-size:11px"><strong>Pathya:</strong> ${document.getElementById('adv-pathya').value}</div>` : ''}
    ${document.getElementById('adv-apathya').value ? `<div style="font-size:11px"><strong>Apathya:</strong> ${document.getElementById('adv-apathya').value}</div>` : ''}
    ${document.getElementById('fu-date').value ? `<div style="font-size:11px;margin-top:8px">Review on: <strong>${new Date(document.getElementById('fu-date').value).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</strong> ${document.getElementById('fu-notes').value ? '— '+document.getElementById('fu-notes').value : ''}</div>` : ''}
    <div style="margin-top:24px;text-align:right;font-size:11px;color:#8a9e90">
      <div style="border-top:1px solid #ccc;width:160px;display:inline-block;padding-top:6px">${profile.full_name}<br>AyurXpert HMS</div>
    </div>
  `;
  window.print();
});

// ── Close consultation ────────────────────────────
document.getElementById('btn-close').addEventListener('click', _closeConsult);
document.getElementById('btn-mobile-back').addEventListener('click', _closeConsult);

function _closeConsult() {
  _activeVisitId    = null;
  _activePatient    = null;
  _activeVisit      = null;
  _activeNcismCode  = null;
  _activeReferralId = null;
  _activeDraftId    = null;
  _activeDraftedBy  = null;
  document.getElementById('draft-review-panel').style.display = 'none';
  // Session 185 — reset local autosave UI state only; the actual DB draft row
  // (if any) is left alone here so it can still be offered next time this
  // visit is reopened. It's only ever deleted on a real Complete/Submit, or
  // an explicit Discard click.
  document.getElementById('draft-resume-banner').style.display = 'none';
  _draftDirty = false;
  _pendingDraftNotes = null;
  document.getElementById('btn-complete').textContent = _isTrainee ? '📝 Submit for Review' : '✓ Complete & Send to Pharmacy';
  document.getElementById('ref-banner').style.display = 'none';
  document.getElementById('tab-btn-proforma').style.display  = 'none';
  document.getElementById('tab-btn-visha').style.display      = 'none';
  _renderExamGuide(null);
  document.getElementById('visha-class-panel').style.display  = 'none';
  document.getElementById('btn-escalate-emg').style.display   = 'none';
  document.getElementById('visha-saved-banner').style.display = 'none';
  document.getElementById('vc-police-warn').style.display     = 'none';
  document.getElementById('no-rx-notice').style.display       = 'none';
  document.getElementById('btn-swasthya-card').style.display  = 'none';
  document.getElementById('sc-print').innerHTML               = '';
  document.getElementById('netra-section').style.display      = 'none';
  document.getElementById('ent-section').style.display        = 'none';
  document.querySelectorAll('[id^="ey-"],[id^="nt-"]').forEach(el => { el.value = ''; });
  _isNetra = false; _isKnm = false;
  document.getElementById('obsgyn-section').style.display     = 'none';
  document.querySelectorAll('[id^="og-"]').forEach(el => { el.value = ''; });
  _isPst = false;
  document.getElementById('prakriti-overlay').style.display   = 'none';
  _pkAnswers = {};
  document.getElementById('kau-age-band-row').style.display   = 'none';
  document.getElementById('imm-section').style.display         = 'none';
  document.getElementById('nip-chips').innerHTML               = '';
  document.getElementById('imm-history').innerHTML             = '';
  if (document.getElementById('imm-record-form')) {
    document.getElementById('imm-record-form').style.display   = 'none';
    document.getElementById('btn-imm-toggle').textContent      = '+ Record Vaccine';
  }
  document.getElementById('growth-section').style.display     = 'none';
  document.getElementById('gr-meters').innerHTML               = '';
  document.getElementById('growth-history').innerHTML          = '';
  document.getElementById('growth-alert').style.display        = 'none';
  updateVitalRanges('');
  document.getElementById('kau-age-band').value               = '';
  document.getElementById('mc-print').innerHTML               = '';
  document.getElementById('pedi-dose-calc').style.display     = 'none';
  document.getElementById('pedi-calc-body').style.display     = 'none';
  document.getElementById('pedi-result').style.display        = 'none';
  document.getElementById('pedi-calc-toggle').textContent     = '▼ Show';
  document.getElementById('anc-risk-banner').style.display = 'none';
  document.getElementById('swarna-section').style.display   = 'none';
  document.getElementById('c-active').style.display = 'none';
  document.getElementById('c-active').classList.remove('mobile-full');
  document.getElementById('welcome').style.display  = '';
  document.getElementById('q-mobile-hint').style.display = '';
  _clearForm();
  loadQueue();
}

function _clearForm() {
  const textInputs = [
    'h-complaint','h-duration','h-aggravating','h-relieving','h-associated','h-history',
    'np-purvarupa','np-rupa','np-samprapti','np-upashaya',
    'ph-surgery','ph-other','dh-current','dh-allergy','dh-adr','fh-notes','pers-occupation',
    'ay-nidana','ay-ahara','ay-vihara',
    'np-purvarupa','np-rupa','np-samprapti','np-upashaya',
    'exam-modern-notes','exam-ayurveda-notes',
    'as-provisional-modern','as-provisional-ayurveda','as-redflags',
    'as-inv-lab','as-inv-imaging','as-inv-ayurveda','as-reasoning',
    'd-modern','d-ayurveda','d-namc-search','d-namc-code','d-namc-label','d-icd11-code',
    'd-icd10-search','d-icd10-code','d-icd10-label','d-icd','d-notes',
    'rx-instructions','adv-pathya','adv-apathya','fu-date','fu-notes',
    'disp-notes',
    'adm-indication','adm-nursing','adm-diet','adm-duration-days','adm-duration-note',
    'ref-doctor','ref-hospital','ref-reason',
    'pedi-age-yr','pedi-age-mo','pedi-adult-dose','mc-diagnosis','mc-remarks',
    'gr-yr','gr-mo','gr-ht','gr-hc','gr-wt-display'
  ];
  textInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const selects = [
    'h-severity','h-onset','h-progression',
    'ph-dm','ph-htn','ph-thyroid',
    'pers-diet','pers-sleep','pers-exercise','pers-bowel','pers-appetite','pers-addiction',
    'ay-prakriti','ay-agni','ay-koshta','ay-nidra',
    'sys-cvs','sys-rs','sys-cns','sys-pa','sys-msk','sys-skin',
    'a-nadi','a-mala','a-mutra','a-jihwa','a-shabda','a-sparsha','a-druk','a-akriti',
    'd-vata','d-pitta','d-kapha','d-agni','d-ama',
    'dasha-sara','dasha-samhanana','dasha-pramana','dasha-satmya','dasha-satva','dasha-vaya','dasha-ahara','dasha-vyayama',
    'd-certainty','adm-room-type','adm-payer','fu-quick','ref-type','ref-urgency','ref-target-opd'
  ];
  selects.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // adm-dept intentionally left alone here -- _loadAdmDepts() repopulates it fresh
  // (its own default option) each time the Admission tab actually loads, same
  // pattern as _populateDoctorSelect() on ipd.js.
  _resetAdmissionAdvice();
  _resetPkCarePlan();

  document.getElementById('rx-rows').innerHTML = '';
  document.getElementById('diff-list').innerHTML = '';
  document.getElementById('d-namc-badge').style.display  = 'none';
  document.getElementById('d-icd10-badge').style.display = 'none';
  document.querySelectorAll('.chip.on, .flag-chip.on').forEach(c => c.classList.remove('on'));
  _rxRows = [];

  // Reset disposition + hide referral section
  document.getElementById('referral-section').style.display = 'none';
  document.getElementById('ref-internal-row').style.display = 'none';
  const opdRadio = document.querySelector('input[name=disposition][value="opd"]');
  if (opdRadio) { opdRadio.checked = true; onDispChange('opd'); }

  // Reset specialty proforma
  resetProforma(document.getElementById('pf-container'));
}

// ── Alert button ──────────────────────────────────
document.getElementById('btn-alerts').addEventListener('click', async () => {
  await supabase.from('doctor_alerts')
    .update({ is_read: true })
    .eq('doctor_id', userId).eq('is_read', false);
  loadAlerts();
  _toast('All alerts marked as read', 'info');
});

// ── Toast ─────────────────────────────────────────
function _toast(msg, type = 'info') {
  const icon = type === 'alert' ? '🔔' : type === 'error' ? '⚠' : '✓';
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${_esc(msg)}</span>`;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Exam Guide (§18am — Specialty OPD examination library) ──

function _renderExamGuide(guide) {
  const panel = document.getElementById('exam-guide-panel');
  const body  = document.getElementById('exam-guide-body');
  const title = document.getElementById('exam-guide-title');
  if (!guide) { panel.style.display = 'none'; body.innerHTML = ''; return; }

  title.textContent = '📋 ' + guide.title;
  panel.style.display = '';
  panel.classList.remove('eg-open');

  const stepsHtml = (guide.steps || []).map(s => `
    <div class="eg-step">
      <div class="eg-step-title"><span>${s.step}</span>${s.title}</div>
      <ul class="eg-items">${s.items.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>`).join('');

  const refHtml = guide.reference_values?.length ? `
    <div style="padding:10px 16px 12px;background:var(--cream)">
      <div style="font-weight:600;font-size:11px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Reference Values</div>
      <table class="eg-ref-table">
        <tr><th>Test</th><th>Unit</th><th>Normal</th><th>Borderline</th><th>Abnormal</th></tr>
        ${guide.reference_values.map(r => `<tr>
          <td><strong>${r.test}</strong></td><td>${r.unit}</td>
          <td style="color:var(--green-deep)">${r.normal}</td>
          <td>${r.borderline}</td><td>${r.abnormal}</td>
        </tr>`).join('')}
      </table>
    </div>` : '';

  body.innerHTML = stepsHtml + refHtml;
}

// ── Visha Case Register (§18af — Agadatantra) ─────

// Sync Diagnosis tab classification panel → Visha Register tab
function _syncVishaDiag() {
  document.getElementById('vc-visha-type').value = document.getElementById('d-visha-type').value;
  document.getElementById('vc-route').value      = document.getElementById('d-visha-route').value;
  document.getElementById('vc-severity').value   = document.getElementById('d-visha-severity').value;
  _onVishaTypeChange();
}

function _onVishaTypeChange() {
  const v = document.getElementById('vc-visha-type').value;
  document.getElementById('vc-police-warn').style.display = v === 'garavisha' ? '' : 'none';
  if (v === 'garavisha') {
    document.getElementById('vc-police-reported').value = 'yes';
    _onPoliceChange();
  }
}

function _onPoliceChange() {
  const v = document.getElementById('vc-police-reported').value;
  document.getElementById('vc-police-num-wrap').style.display = v === 'yes' ? '' : 'none';
}

async function _loadVishaRecord(visitId) {
  const { data } = await supabase
    .from('poison_cases')
    .select('*')
    .eq('visit_id', visitId)
    .maybeSingle();

  const now = new Date();
  document.getElementById('vc-datetime').value =
    now.toLocaleDateString('en-IN') + ' ' + now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });

  if (data) {
    document.getElementById('vc-case-num').value         = data.case_number;
    document.getElementById('vc-visha-type').value       = data.visha_type || '';
    document.getElementById('vc-route').value            = data.route || 'ingestion';
    document.getElementById('vc-severity').value         = data.severity || 'unknown';
    document.getElementById('vc-outcome').value          = data.outcome || 'unknown';
    document.getElementById('vc-circumstances').value    = data.circumstances || '';
    document.getElementById('vc-antidote').value         = data.antidote_given || '';
    document.getElementById('vc-police-reported').value  = data.police_reported || 'not_applicable';
    document.getElementById('vc-police-num').value       = data.police_report_number || '';
    // Also populate Diagnosis tab classification panel
    document.getElementById('d-visha-type').value     = data.visha_type || '';
    document.getElementById('d-visha-route').value    = data.route || 'ingestion';
    document.getElementById('d-visha-severity').value = data.severity || 'unknown';
    _onVishaTypeChange();
    _onPoliceChange();
    document.getElementById('visha-saved-banner').style.display = '';
    document.getElementById('btn-save-visha').textContent = 'Update Register';
  } else {
    // Auto-generate case number
    const year = now.getFullYear();
    const { count } = await supabase
      .from('poison_cases')
      .select('*', { count:'exact', head:true })
      .eq('tenant_id', tenantId);
    document.getElementById('vc-case-num').value = `PC-${year}-${String((count || 0) + 1).padStart(4,'0')}`;
    document.getElementById('visha-saved-banner').style.display = 'none';
    document.getElementById('btn-save-visha').textContent = 'Save to Register';
  }
}

window.escalateToEmergency = async function() {
  const ptName    = _activePatient?.name || 'Patient';
  const vishaType = document.getElementById('d-visha-type').value;
  const VISHA_LABELS = { sthavara:'Sthavara', jangama:'Jangama', kritima:'Kritima', dushivisha:'Dushivisha', garavisha:'Garavisha', drug_induced:'Drug-induced' };
  const vishaLabel = VISHA_LABELS[vishaType] || 'Visha';

  const ok = confirm(`Escalate ${ptName} to Emergency OPD?\n\nThis will:\n• Create a new emergency visit (${vishaLabel} case)\n• Alert Emergency MO on duty\n• Close this Agadatantra consultation\n\nProceed?`);
  if (!ok) return;

  const btn = document.getElementById('btn-escalate-emg');
  btn.disabled = true;
  btn.textContent = 'Escalating…';

  try {
    // Find Emergency / Atyayika OPD for this tenant
    const { data: allOpds } = await supabase
      .from('opds').select('id,name,ncism_code')
      .eq('tenant_id', tenantId).eq('is_active', true);

    const emergOpd = allOpds?.find(o =>
      o.name?.toLowerCase().includes('emergency') ||
      o.name?.toLowerCase().includes('atyayika') ||
      o.ncism_code?.toLowerCase().includes('emerg')
    );

    if (!emergOpd) {
      _toast('Emergency / Atyayika OPD not found. Please configure it in OPD Admin first.', 'error');
      btn.disabled = false; btn.textContent = '⚠ Escalate to Emergency';
      return;
    }

    // Next token for Emergency OPD today
    const today = todayLocalStr();
    const { count } = await supabase
      .from('visits').select('*', { count:'exact', head:true })
      .eq('opd_id', emergOpd.id).eq('tenant_id', tenantId)
      .gte('created_at', today + 'T00:00:00Z');
    const nextToken = (count || 0) + 1;

    // Create new Emergency visit
    const complaint = `ESCALATED from Agadatantra — ${vishaLabel} Visha case. Original token: ${_activeVisit?.token_number || '—'}.`;
    const { data: newVisit, error: vErr } = await supabase
      .from('visits')
      .insert({
        tenant_id:       tenantId,
        patient_id:      _activePatient.id,
        opd_id:          emergOpd.id,
        status:          'waiting',
        chief_complaint: complaint,
        token_number:    nextToken,
        is_on_request:   true,
      })
      .select('id, token_number')
      .single();

    if (vErr) throw vErr;

    // Alert all on-duty Emergency doctors
    const { data: emergDoctors } = await supabase
      .from('opd_doctors').select('doctor_id')
      .eq('opd_id', emergOpd.id).eq('tenant_id', tenantId).eq('is_active_today', true);

    if (emergDoctors?.length) {
      await supabase.from('doctor_alerts').insert(
        emergDoctors.map(d => ({
          tenant_id:    tenantId,
          doctor_id:    d.doctor_id,
          visit_id:     newVisit.id,
          patient_name: ptName,
          message:      `⚠ EMERGENCY ESCALATION — ${vishaLabel} Visha from Agadatantra. Token #${nextToken}. Patient: ${ptName}. Immediate attention required.`,
          is_read:      false,
        }))
      );
    }

    // Mark current Agadatantra visit as completed
    await supabase.from('visits').update({ status: 'completed' }).eq('id', _activeVisitId);

    _toast(`Patient escalated — Emergency Token #${nextToken}. ${emergDoctors?.length || 0} MO(s) alerted.`, 'alert');
    setTimeout(_closeConsult, 1200);

  } catch (err) {
    _toast(safeErrorMessage(err, 'Escalation failed. Please try again.'), 'error');
    btn.disabled = false;
    btn.textContent = '⚠ Escalate to Emergency';
  }
};

window.saveVishaCase = async function() {
  const vishaType = document.getElementById('vc-visha-type').value;
  if (!vishaType) { _toast('Select Visha type before saving.'); return; }

  const payload = {
    tenant_id:           tenantId,
    visit_id:            _activeVisitId,
    patient_id:          _activePatient?.id || null,
    case_number:         document.getElementById('vc-case-num').value,
    visha_type:          vishaType,
    route:               document.getElementById('vc-route').value,
    severity:            document.getElementById('vc-severity').value,
    outcome:             document.getElementById('vc-outcome').value,
    circumstances:       document.getElementById('vc-circumstances').value.trim() || null,
    antidote_given:      document.getElementById('vc-antidote').value.trim() || null,
    police_reported:     document.getElementById('vc-police-reported').value,
    police_report_number: document.getElementById('vc-police-num').value.trim() || null,
    updated_at:          new Date().toISOString(),
  };

  const { error } = await supabase
    .from('poison_cases')
    .upsert(payload, { onConflict: 'visit_id' });

  if (error) { _toast(safeErrorMessage(error, 'Failed to save.')); return; }
  document.getElementById('visha-saved-banner').style.display = '';
  document.getElementById('btn-save-visha').textContent = 'Update Register';
  _toast('Visha case saved to register.');
};

// ── Boot ──────────────────────────────────────────
_initNamaste();
_initIcd10();
await Promise.all([loadQueue(), loadAlerts(), loadInventory(), _loadOpdAttendanceBanner(), loadOpdList(), loadDoctorOpds(), renderPromoBanner('promo-banner', { supabase, tenantId })]);

async function _loadOpdAttendanceBanner() {
  const { data: t } = await supabase.from('tenants').select('ug_intake,opd_daily_target,type').eq('id', tenantId).single();
  if (!t || !isNCISMType(t.type)) return;
  const target = t.opd_daily_target || ((t.ug_intake || 0) * 2);
  if (!target) return;

  const today = todayLocalStr();
  const { count } = await supabase.from('visits').select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59');

  const pct = Math.min(Math.round(((count || 0) / target) * 100), 100);
  if (pct >= 80) return; // no banner if on track

  const el = document.getElementById('ncism-opd-banner');
  if (!el) return;
  const isRed = pct < 50;
  el.style.display = '';
  el.style.background = isRed ? '#fdecea' : '#fff8e1';
  el.style.color      = isRed ? '#c0392b' : '#7a5c00';
  el.style.borderBottom = `2px solid ${isRed ? '#f5c6c6' : '#e0c060'}`;
  el.textContent = isRed
    ? `NCISM OPD Alert — Only ${count||0} patients today (target: ${target}). ${target-(count||0)} more needed.`
    : `NCISM OPD — ${count||0} / ${target} patients today (${pct}%). Keep going to meet daily target.`;
}
// ── §18bc Pharmacovigilance ADR Reporting ────────────────────────
function openAdrModal() {
  if (!_activePatient) { alert('Select a patient first.'); return; }
  document.getElementById('adr-patient-name').value  = _activePatient.name || '';
  document.getElementById('adr-doctor-name').value   = _ctx.userName || '';
  document.getElementById('adr-report-date').value   = todayLocalStr();
  document.getElementById('adr-reaction-date').value = todayLocalStr();
  document.getElementById('adr-description').value   = '';
  document.getElementById('adr-severity').value      = '';
  document.getElementById('adr-outcome').value       = '';
  document.getElementById('adr-abates').value        = 'na';
  document.getElementById('adr-rechallenge').value   = 'na';
  document.getElementById('adr-concomitant').value   = '';
  document.getElementById('adr-lab-info').value      = '';
  document.getElementById('adr-causality').value     = '';
  document.getElementById('adr-pvpi-no').value       = '';
  const wrap = document.getElementById('adr-med-rows');
  wrap.innerHTML = '';
  const rxNames = [...document.querySelectorAll('.rx-med-select')].map(s => s.options[s.selectedIndex]?.text || '').filter(Boolean);
  if (rxNames.length) rxNames.forEach(n => addAdrMedRow(n));
  else addAdrMedRow();
  document.getElementById('adr-overlay').style.display = 'flex';
}
function closeAdrModal() {
  document.getElementById('adr-overlay').style.display = 'none';
}
function addAdrMedRow(medicineName = '') {
  const row = document.createElement('div');
  row.className = 'adr-med-row';
  const safe = _esc(medicineName);
  row.innerHTML = `
    <input type="text" placeholder="Medicine name" value="${safe}"/>
    <input type="text" placeholder="Dose"/>
    <select>
      <option value="oral">Oral</option><option value="nasal">Nasal</option>
      <option value="topical">Topical</option><option value="rectal">Rectal</option>
      <option value="iv">IV</option><option value="im">IM</option><option value="other">Other</option>
    </select>
    <input type="date"/>
    <select>
      <option value="withdrawn">Withdrawn</option><option value="dose_reduced">Dose Reduced</option>
      <option value="not_changed">Not Changed</option><option value="unknown">Unknown</option>
    </select>
    <button class="adr-med-rm" data-onclick="_removeParentEl" data-onclick-a0="@this" title="Remove">✕</button>`;
  document.getElementById('adr-med-rows').appendChild(row);
}
async function saveAdrReport(status) {
  if (!_activePatient) return;
  const medRows = [...document.getElementById('adr-med-rows').querySelectorAll('.adr-med-row')].map(r => {
    const inp = r.querySelectorAll('input');
    const sel = r.querySelectorAll('select');
    return { medicine: inp[0].value.trim(), dose: inp[1].value.trim(), route: sel[0].value, start_date: inp[2].value, action: sel[1].value };
  }).filter(r => r.medicine);

  const { error } = await supabase.from('adr_reports').insert({
    tenant_id:                tenantId,
    patient_id:               _activePatient.id,
    visit_id:                 _activeVisitId,
    doctor_id:                userId,
    report_date:              document.getElementById('adr-report-date').value,
    reaction_date:            document.getElementById('adr-reaction-date').value || null,
    reaction_description:     document.getElementById('adr-description').value.trim(),
    severity:                 document.getElementById('adr-severity').value || null,
    outcome:                  document.getElementById('adr-outcome').value || null,
    abates_on_stopping:       document.getElementById('adr-abates').value,
    reappears_on_rechallenge: document.getElementById('adr-rechallenge').value,
    suspect_medicines:        medRows,
    concomitant_medicines:    document.getElementById('adr-concomitant').value.trim(),
    relevant_lab_info:        document.getElementById('adr-lab-info').value.trim(),
    causality:                document.getElementById('adr-causality').value || null,
    pvpi_report_no:           document.getElementById('adr-pvpi-no').value.trim() || null,
    status
  });
  if (error) { alert(safeErrorMessage(error, 'Error saving ADR report.')); return; }
  closeAdrModal();
  alert(status === 'submitted' ? 'ADR Report saved and marked as submitted to PvPI.' : 'ADR Report saved as draft.');
}

// ── Imaging Order Module ──────────────────────────────────────────────────────
const IMG_STUDIES_DOC = {
  xray:   ['X-Ray Chest (PA view)','X-Ray Chest (AP view)','X-Ray Abdomen','X-Ray Spine','X-Ray Pelvis','X-Ray Knee','X-Ray Shoulder','X-Ray Wrist/Hand','X-Ray Ankle/Foot','X-Ray Skull','X-Ray Other (specify)'],
  usg:    ['USG Abdomen & Pelvis','USG Abdomen Only','USG Pelvis Only','USG Obstetric (Dating)','USG Obstetric (Anomaly Scan)','USG Obstetric (Growth Scan)','USG Neck (Thyroid)','USG Breast','USG Doppler — Carotid','USG Doppler — Venous/Arterial Limbs'],
  ecg:    ['ECG 12-Lead (Resting)','ECG 12-Lead (Post-exercise)'],
  echo:   ['2D Echocardiography','Colour Doppler Echo'],
  doppler:['Doppler — Carotid','Doppler — Peripheral Arteries','Doppler — Peripheral Veins','Doppler — Renal Arteries'],
  mri:    ['MRI Brain','MRI Spine (Cervical)','MRI Spine (Lumbar)','MRI Knee','MRI Shoulder','MRI Abdomen','MRI Pelvis','MRI Other (specify)'],
  ct:     ['CT Brain (Plain)','CT Brain (Contrast)','CT Chest','CT Abdomen','CT Pelvis','CT Other (specify)'],
  outside:['Outside — Lab Tests','Outside — MRI','Outside — CT Scan','Outside — PET Scan','Outside — Nuclear Medicine','Outside — Other (specify)'],
};

function openImgOrderModal() {
  if (!_activePatient) { alert('Select a patient first.'); return; }
  updateImgStudyOpts();
  document.getElementById('io-indication').value = '';
  document.getElementById('io-priority').value   = 'routine';
  document.getElementById('io-outside-fields').style.display = 'none';
  document.getElementById('img-order-overlay').style.display = 'flex';
}
window.closeImgOrderModal = function() { document.getElementById('img-order-overlay').style.display = 'none'; };

window.updateImgStudyOpts = function() {
  const mod = document.getElementById('io-modality')?.value || 'xray';
  const sel = document.getElementById('io-study');
  if (!sel) return;
  sel.innerHTML = (IMG_STUDIES_DOC[mod]||[]).map(s=>`<option value="${s}">${s}</option>`).join('');
  document.getElementById('io-outside-fields').style.display = mod === 'outside' ? 'block' : 'none';
};

window.submitImgOrder = async function() {
  if (!_activePatient) return;
  const mod   = document.getElementById('io-modality').value;
  const study = document.getElementById('io-study').value;
  const { error } = await supabase.from('imaging_orders').insert({
    tenant_id:           tenantId,
    patient_id:          _activePatient.id,
    visit_id:            _activeVisitId,
    ordered_by:          userId,
    order_date:          todayLocalStr(),
    order_time:          new Date().toTimeString().slice(0,8),
    modality:            mod,
    study_name:          study,
    priority:            document.getElementById('io-priority').value,
    clinical_indication: document.getElementById('io-indication').value.trim() || null,
    is_outside_referral: mod === 'outside',
    outside_centre_name: document.getElementById('io-centre')?.value?.trim() || null,
    expected_date:       document.getElementById('io-exp-date')?.value || null,
    status:              'ordered',
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save imaging order.')); return; }

  // Update imaging text field
  const existing = document.getElementById('as-inv-imaging').value.trim();
  const label = `${{xray:'X-Ray',usg:'USG',ecg:'ECG',echo:'ECHO',doppler:'Doppler',mri:'MRI',ct:'CT',outside:'Outside'}[mod]||mod}: ${study}`;
  document.getElementById('as-inv-imaging').value = existing ? existing + ', ' + label : label;

  closeImgOrderModal();
  alert(`✅ Imaging order submitted: ${study}`);
};

// ── Lab Order Module ──────────────────────────────────────────────────────────
const LAB_PANELS = [
  { label:'CBC',        tests:['Haemoglobin (Hb)','Total Leucocyte Count (TLC)','Differential Leucocyte Count (DLC)','Platelet Count','PCV / Haematocrit'] },
  { label:'LFT',        tests:['SGOT (AST)','SGPT (ALT)','Serum Bilirubin Total','Serum Bilirubin Direct','Alkaline Phosphatase (ALP)','Serum Albumin','Total Protein'] },
  { label:'KFT / RFT',  tests:['Serum Creatinine','Blood Urea','Serum Uric Acid','Serum Sodium','Serum Potassium'] },
  { label:'Lipid Profile', tests:['Total Cholesterol','Triglycerides (TG)','HDL Cholesterol','LDL Cholesterol','VLDL Cholesterol'] },
  { label:'TFT',        tests:['TSH','T3 (Triiodothyronine)','T4 (Thyroxine)'] },
  { label:'Blood Sugar', tests:['Fasting Blood Sugar (FBS)','Post-Prandial Blood Sugar (PPBS)','HbA1c'] },
  { label:'Urine R/M',  tests:['Urine — Albumin (Protein)','Urine — Sugar (Glucose)','Urine — Pus Cells (WBCs)','Urine — RBCs','Urine — pH','Urine — Specific Gravity'] },
];
const LAB_CAT_LABEL = {
  haematology:'🩸 Haematology', biochemistry:'🧪 Biochemistry', lipid:'💛 Lipid',
  thyroid:'🦋 Thyroid', urine:'💧 Urine', stool:'🟤 Stool',
  serology:'🛡 Serology', imaging_ecg:'📡 Imaging / ECG', other:'🔬 Other'
};
const LAB_CATALOG = {
  haematology:['Haemoglobin (Hb)','Total Leucocyte Count (TLC)','Differential Leucocyte Count (DLC)','Platelet Count','PCV / Haematocrit','ESR (Westergren)','Peripheral Blood Smear','Reticulocyte Count','Blood Group & Rh Type'],
  biochemistry:['Fasting Blood Sugar (FBS)','Post-Prandial Blood Sugar (PPBS)','Random Blood Sugar (RBS)','HbA1c','Serum Creatinine','Blood Urea','Serum Uric Acid','SGOT (AST)','SGPT (ALT)','Serum Bilirubin Total','Serum Bilirubin Direct','Alkaline Phosphatase (ALP)','Serum Albumin','Total Protein','Serum Sodium','Serum Potassium','Serum Calcium','Serum Iron','TIBC','Vitamin D (25-OH)','Vitamin B12','CRP (C-Reactive Protein)'],
  lipid:['Total Cholesterol','Triglycerides (TG)','HDL Cholesterol','LDL Cholesterol','VLDL Cholesterol'],
  thyroid:['TSH','T3 (Triiodothyronine)','T4 (Thyroxine)'],
  urine:['Urine — Albumin (Protein)','Urine — Sugar (Glucose)','Urine — Pus Cells (WBCs)','Urine — RBCs','Urine — pH','Urine — Specific Gravity','Urine — Ketone Bodies','Urine — Bile Salts/Pigments','Urine — Casts','Urine Culture & Sensitivity','Urine Pregnancy Test (UPT)'],
  stool:['Stool Routine & Microscopy','Stool — Occult Blood'],
  serology:['Widal Test (TO + TH)','RA Factor (Rheumatoid Factor)','ASO Titre','HIV I & II (Rapid)','HBsAg (Hepatitis B)','Anti-HCV (Hepatitis C)','Malaria (MP / RDT)','Dengue NS1 Antigen','Dengue IgM / IgG','Leptospira IgM','ANA (Antinuclear Antibody)','Blood Culture & Sensitivity','Sputum AFB (ZN Stain)'],
  imaging_ecg:['X-Ray Chest (PA view)','X-Ray (specify area)','USG Abdomen & Pelvis','USG Pelvis (Obstetric)','ECG (12-lead)','ECHO (Echocardiography)'],
  other:['Coagulation Profile (PT/INR/aPTT)','PAP Smear','FNAC (specify site)','Biopsy (specify site)','Procalcitonin (PCT)'],
};

// Session 124 Step 4 -- explicit panel -> fee_structures label mapping.
// Deliberately NOT automatic string-matching -- verified by hand against the
// real fee-admin.js catalog (Step 1) rather than guessed, since a silent
// mismatch here means a patient gets billed wrong. 'Blood Sugar' is
// deliberately absent: unlike the other 6 panels, no single bundle fee
// exists for it (real labs don't bundle HbA1c with same-day sugar tests) --
// it always decomposes to its 3 individual tests instead.
const PANEL_FEE_MAP = {
  'CBC':            'Blood — CBC',
  'LFT':            'Blood — LFT',
  'KFT / RFT':      'Blood — RFT',   // KFT (Kidney) and RFT (Renal) are the same test, regional naming only
  'Lipid Profile':  'Blood — Lipid Profile',
  'TFT':            'Blood — Thyroid (T3/T4/TSH)',
  'Urine R/M':      'Urine — Routine',
};

// Known near-miss label variants between doctor.js's exact order test names
// and fee-admin.js's catalog labels (found during Step 1's cross-check) --
// e.g. "Urine Culture & Sensitivity" (ordered) vs "Culture & Sensitivity"
// (priced) are the same real-world charge, just phrased differently.
// X-Ray/USG variants resolve to the RADIOLOGY category, not lab, since
// that's genuinely where their pricing lives.
const TEST_LABEL_OVERRIDES = {
  'Urine Culture & Sensitivity': 'Culture & Sensitivity',
  'Blood Culture & Sensitivity': 'Culture & Sensitivity',
  'Stool Routine & Microscopy':  'Stool — Routine',
  'Biopsy (specify site)':       'Biopsy',
  'X-Ray Chest (PA view)':       'X-Ray',
  'X-Ray (specify area)':        'X-Ray',
  'USG Abdomen & Pelvis':        'Ultrasound (USG)',
  'USG Pelvis (Obstetric)':      'Ultrasound (USG)',
  'ECG (12-lead)':               'ECG',
  'ECHO (Echocardiography)':     'Echo (2D Echo)',
  // The 'Blood Sugar' panel (unlike the other 6) has no bundle fee and
  // always decomposes to individual pricing -- caught by testing that these
  // 2 exact-match a completely different fee label convention (found live,
  // would otherwise have always shown "unmatched" even with a real fee).
  'Fasting Blood Sugar (FBS)':      'Blood Sugar — Fasting',
  'Post-Prandial Blood Sugar (PPBS)': 'Blood Sugar — PP',
};

// Turns this order's Map<testName, panelLabel> into priced billing lines.
// A tagged panel only bundles if EVERY one of its real tests (per LAB_PANELS,
// never trusted from the tag alone) is actually present -- a partial panel
// (one test unchecked after the panel button was clicked) decomposes to
// individual pricing for whatever remains, same as a never-tagged test.
function _computeLabBillingLines(labSelected, feeRows) {
  const byLabel = {};
  feeRows.forEach(f => { byLabel[f.label] = f; });

  const byPanel = {};
  const individual = [];
  for (const [testName, panelLabel] of labSelected.entries()) {
    if (panelLabel) (byPanel[panelLabel] = byPanel[panelLabel] || []).push(testName);
    else individual.push(testName);
  }

  const lines = [];
  const unmatched = [];

  for (const [panelLabel, taggedTests] of Object.entries(byPanel)) {
    const panelDef = LAB_PANELS.find(p => p.label === panelLabel);
    const isComplete = panelDef && panelDef.tests.length === taggedTests.length
      && panelDef.tests.every(t => taggedTests.includes(t));
    const bundleFeeLabel = PANEL_FEE_MAP[panelLabel];
    const bundleFee = bundleFeeLabel ? byLabel[bundleFeeLabel] : null;
    if (isComplete && bundleFee) {
      lines.push({ description: bundleFee.label, price: getEffectivePrice(bundleFee), gst_percent: Number(bundleFee.gst_percent) || 0 });
    } else {
      // Not a complete/priceable bundle -- fall back to individual pricing
      // for every test in this group, same path as never-tagged tests.
      individual.push(...taggedTests);
    }
  }

  for (const testName of individual) {
    const feeLabel = TEST_LABEL_OVERRIDES[testName] || testName;
    const fee = byLabel[feeLabel];
    if (fee) lines.push({ description: fee.label, price: getEffectivePrice(fee), gst_percent: Number(fee.gst_percent) || 0 });
    else unmatched.push(testName);
  }

  return { lines, unmatched };
}

// Attaches this lab order's charges to the visit's existing OPD bill
// (Step 3's addOpdBillItem) -- deliberately non-blocking: a billing hiccup
// here must never stop the clinical order itself, which has already been
// saved by the time this runs. Unmatched tests are surfaced, never silently
// charged ₹0 or silently dropped.
async function _billLabOrder(labSelected, labOrderId) {
  try {
    const { data: bill } = await supabase.from('bills').select('id')
      .eq('visit_id', _activeVisitId).eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bill) return { billed: [], unmatched: [], noBill: true };

    const { data: feeRows } = await supabase.from('fee_structures')
      .select('label,amount,gst_percent,promo_price,promo_valid_until').eq('tenant_id', tenantId).eq('is_active', true).in('category', ['lab','radiology']);

    const { lines, unmatched } = _computeLabBillingLines(labSelected, feeRows || []);

    for (const line of lines) {
      const { error } = await addOpdBillItem({
        supabase, tenantId, billId: bill.id, itemType: 'lab',
        description: line.description, quantity: 1, price: line.price, gstPercent: line.gst_percent,
        labOrderId,
      });
      if (error) unmatched.push(line.description + ' (billing failed)');
    }

    return { billed: lines.map(l => l.description), unmatched };
  } catch (err) {
    console.error('lab order billing error:', err);
    return { billed: [], unmatched: [...labSelected.keys()] };
  }
}

// Session 124 Step 2 -- Map instead of Set: value tracks which panel (if any)
// a test was added via, so lab.js's queue can show a clean "CBC" grouping
// and later billing can reconstruct "was a complete panel ordered" without
// re-deriving intent from test names. Clicking a panel button (re)tags all
// its tests with that panel's label; manually toggling one checkbox breaks
// its panel association (null = individually selected) since that's a
// deliberate choice on that one test, separate from the bundle.
let _labSelected = new Map();

// 6 Sep 2026 (Session 198) — real bug found live-testing: declared as a bare `function`,
// unreachable from the "🧪 Order via Lab Module" button's data-onclick="openLabOrderModal"
// delegated handler (which looks up window.openLabOrderModal) — the button has silently done
// nothing for every doctor, ever, since this Assessment-tab entry point was built. This is the
// only lab-ordering entry point in doctor.html. Every sibling handler here (closeLabOrderModal,
// submitLabOrder, selectPanel, etc.) is correctly assigned to window — this one was missed.
window.openLabOrderModal = function openLabOrderModal() {
  if (!_activePatient) { alert('Select a patient first.'); return; }
  _labSelected = new Map();
  // Build panels
  document.getElementById('lo-panels').innerHTML = LAB_PANELS.map(p =>
    `<button data-onclick="_selectPanelFromAttr" data-onclick-a0="${_esc(JSON.stringify(p.tests))}" data-onclick-a1="${_esc(p.label)}"
      style="padding:5px 12px;border-radius:12px;border:1.5px solid #9ab8e0;background:#e3f0ff;color:#1a4080;font-size:11px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">
      ${p.label}
    </button>`).join('');
  // Build test checkboxes by category
  document.getElementById('lo-cats').innerHTML = Object.entries(LAB_CATALOG).map(([cat, tests]) =>
    `<div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:600;color:var(--text-mid);margin-bottom:5px">${LAB_CAT_LABEL[cat]||cat}</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px">
        ${tests.map(t => `<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border:1.5px solid var(--border);border-radius:12px;cursor:pointer;background:var(--white)">
          <input type="checkbox" value="${t}" data-cat="${cat}" data-onchange="toggleLabTest" data-onchange-a0="${_esc(t)}" data-onchange-a1="@checked" style="accent-color:#1a4080"/>
          ${t}
        </label>`).join('')}
      </div>
    </div>`).join('');
  updateLabCount();
  document.getElementById('lab-order-overlay').style.display = 'flex';
};

window.selectPanel = function(tests, label) {
  tests.forEach(t => _labSelected.set(t, label));
  // Check corresponding checkboxes
  document.querySelectorAll('#lo-cats input[type=checkbox]').forEach(cb => {
    if (_labSelected.has(cb.value)) cb.checked = true;
  });
  updateLabCount();
};

window.toggleLabTest = function(name, checked) {
  // A manual check always means "individually selected" (null panel), even
  // if this test also belongs to a panel that was clicked earlier -- an
  // explicit action on this one test overrides whatever bundle it came from.
  checked ? _labSelected.set(name, null) : _labSelected.delete(name);
  updateLabCount();
};

function updateLabCount() {
  document.getElementById('lo-count').textContent = _labSelected.size;
}

window.closeLabOrderModal = function() {
  document.getElementById('lab-order-overlay').style.display = 'none';
};

window.submitLabOrder = async function() {
  if (_labSelected.size === 0) { alert('Select at least one test.'); return; }
  if (!_activePatient) return;

  const priority = document.getElementById('lo-priority').value || 'routine';
  const clinicalNotes = document.getElementById('lo-notes').value.trim() || null;
  const bypassPayment = document.getElementById('lo-bypass-payment').checked;

  // Create lab_orders record -- lab_orders has no patient_id column at all
  // (confirmed live, zero rows exist in the whole platform); it routes
  // through visit_id -> visits.patient_id only, matching how lab.js already
  // reads it back. Sending patient_id here made every submission fail with
  // a schema error -- lab ordering from doctor.html has never worked.
  // Session 126 -- payment_status gates whether lab.js can act on this order at
  // all (see markSampleCollected there); 'waived' is the emergency/STAT bypass,
  // set explicitly here rather than inferred from priority, since a STAT test
  // that's still fully payable shouldn't automatically skip the payment step.
  // Session 127 -- a trainee's lab order stays invisible to lab.js/reception's
  // Lab Bills panel (both now also check review_status) until the supervising
  // doctor finalizes the consultation, even though it's billed immediately
  // below same as any other order -- matches "no draft order reaches the
  // payment counter/lab until the professor signs off."
  const { data: order, error: oErr } = await supabase.from('lab_orders').insert({
    tenant_id:  tenantId,
    visit_id:   _activeVisitId,
    status:     'pending',
    priority,
    clinical_notes: clinicalNotes,
    ordered_by: profile.id,
    payment_status: bypassPayment ? 'waived' : 'pending',
    drafted_by: _isTrainee ? profile.id : null,
    review_status: _isTrainee ? 'pending_review' : 'finalized',
  }).select('id').single();
  if (oErr) { alert('Error creating order: ' + oErr.message); return; }

  // Create lab_order_items
  const items = [..._labSelected.entries()].map(([name, panelLabel]) => {
    const cat = Object.entries(LAB_CATALOG).find(([c,ts]) => ts.includes(name))?.[0] || 'other';
    return { order_id:order.id, tenant_id:tenantId, test_name:name, test_category:cat, panel_label: panelLabel };
  });
  const { error: iErr } = await supabase.from('lab_order_items').insert(items);
  if (iErr) { alert('Error adding tests: ' + iErr.message); return; }

  // Update as-inv-lab text field
  const existingText = document.getElementById('as-inv-lab').value.trim();
  const newTests = [..._labSelected.keys()].join(', ');
  document.getElementById('as-inv-lab').value = existingText ? existingText + ', ' + newTests : newTests;

  // Session 124 Step 4 (charge attaches to the bill immediately) + Session 126
  // (payment now gates the lab, unless bypassed above) -- billing itself is never
  // blocking, the clinical order is already saved regardless of what happens here.
  const { unmatched, noBill } = await _billLabOrder(_labSelected, order.id);

  closeLabOrderModal();
  let msg = `✅ Lab order submitted: ${_labSelected.size} tests ordered.`;
  if (bypassPayment) msg += `\n\n🚨 Emergency bypass — lab can proceed immediately. Payment is still owed and will show as pending at reception.`;
  else msg += `\n\n⏳ Payment pending — patient must pay at reception before the lab can collect the sample.`;
  if (noBill) msg += `\n\n⚠ No bill found for this visit -- lab charges were not added. Please add them manually via reception.`;
  else if (unmatched.length) msg += `\n\n⚠ No price found for: ${unmatched.join(', ')} -- please add these to the bill manually.`;
  alert(msg);
  loadLabResults();
};

async function loadLabResults() {
  if (!_activeVisitId) return;
  const { data: orders, error: ordErr } = await supabase
    .from('lab_orders')
    .select('id,status,payment_status')
    .eq('tenant_id', tenantId)
    .eq('visit_id', _activeVisitId);
  if (ordErr) { console.warn('[lab] loadLabResults:', ordErr.message); return; }
  if (!orders?.length) {
    document.getElementById('lab-results-panel').style.display = 'none';
    return;
  }

  const orderIds = orders.map(o => o.id);
  const { data: allItems } = await supabase
    .from('lab_order_items')
    .select('order_id,test_name,result_value,is_abnormal,is_critical')
    .in('order_id', orderIds);
  const itemsByOrder = {};
  (allItems || []).forEach(i => { (itemsByOrder[i.order_id] = itemsByOrder[i.order_id] || []).push(i); });

  document.getElementById('lab-results-panel').style.display = 'block';
  document.getElementById('order-lab-btn').disabled = false;

  const html = orders.map(o => {
    const isDone = o.status === 'completed';
    const items  = itemsByOrder[o.id] || [];
    const criticals = items.filter(i => i.is_critical);
    return `<div style="margin-bottom:8px;padding:8px 10px;background:var(--white);border-radius:6px;border:1px solid ${isDone?'#b2d8bf':'#9ab8e0'}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;background:${isDone?'var(--green-light)':'#e3f0ff'};color:${isDone?'var(--green-deep)':'#1a4080'}">${_esc(isDone?'REPORT READY':{pending:'PENDING',sample_collected:'SAMPLE COLLECTED',in_progress:'IN PROGRESS'}[o.status]||o.status)}</span>
        ${o.order_date ? `<span style="font-size:10px;color:var(--text-muted)">${_fmtDate(o.order_date)}</span>` : ''}
        ${o.payment_status === 'pending' ? '<span style="color:#7a4a00;font-size:10px;font-weight:700">⏳ PAYMENT PENDING</span>' : ''}
        ${criticals.length ? '<span style="color:var(--red);font-size:11px;font-weight:700">⚠ CRITICAL</span>' : ''}
      </div>
      <div style="line-height:1.8">${items.map(i => `<span style="font-size:11px;${i.is_critical?'color:var(--red);font-weight:700':i.is_abnormal?'color:#7a5c00':''}">${_esc(i.test_name)}${i.result_value?' = <strong>'+_esc(i.result_value)+'</strong>':''}</span>`).join(' · ')}</div>
    </div>`;
  }).join('');
  document.getElementById('lab-results-body').innerHTML = html;
}

// Enable lab order button when patient is selected
const _origSelectPatient = window._selectPatientPost;
// ── §18ai Mental Health Flag ──────────────────────────────────────────────────
function openMhaFlag() {
  if (!_activePatient) { alert('Select a patient first.'); return; }
  document.getElementById('mha-flag-overlay').style.display = 'flex';
}
function closeMhaFlag() {
  document.getElementById('mha-flag-overlay').style.display = 'none';
}
async function saveMhaFlag() {
  if (!_activePatient) return;
  const concern   = document.getElementById('mha-concern').value;
  const severity  = document.getElementById('mha-severity').value;
  const obs       = document.getElementById('mha-observations').value.trim();
  const followup  = document.getElementById('mha-followup').value.trim();
  const refPsych  = document.getElementById('mha-ref-psych').checked;
  const refSw     = document.getElementById('mha-ref-sw').checked;
  const family    = document.getElementById('mha-family-inf').checked;
  const crisis    = document.getElementById('mha-crisis').checked;

  const { error } = await supabase.from('mental_health_flags').insert({
    tenant_id:   tenantId,
    patient_id:  _activePatient.id,
    visit_id:    _activeVisitId,
    doctor_id:   userId,
    concern_type: concern,
    severity,
    observations: obs || null,
    followup_plan: followup || null,
    refer_psychiatrist: refPsych,
    refer_social_worker: refSw,
    family_informed: family,
    crisis_intervention: crisis
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save MHA record.')); return; }

  const label = document.querySelector(`#mha-concern option[value="${concern}"]`)?.textContent || concern;
  const badge = severity === 'severe' ? '🔴' : severity === 'moderate' ? '🟡' : '🟢';
  document.getElementById('mha-flag-summary').style.display = 'block';
  document.getElementById('mha-flag-summary').innerHTML = `${badge} <strong>${_esc(label)}</strong> — ${_esc(severity)} | ${crisis ? '<span style="color:var(--red)">Crisis intervention flagged</span>' : 'Flagged'}`;
  closeMhaFlag();
}

// ── §18aj MHA 2017 Consent ────────────────────────────────────────────────────
function openMhaConsent() {
  if (!_activePatient) { alert('Select a patient first.'); return; }
  document.getElementById('mha-c-patient').value = _activePatient.name || '';
  document.getElementById('mha-c-date').value    = todayLocalStr();
  document.getElementById('mha-consent-overlay').style.display = 'flex';
}
function closeMhaConsent() {
  document.getElementById('mha-consent-overlay').style.display = 'none';
}
async function saveMhaConsent(doPrint) {
  if (!_activePatient) return;
  const rows = ['r1','r2','r3','r4','r5','r6'].filter(r => document.getElementById('mha-c-'+r).checked);
  const { error } = await supabase.from('mha_consents').insert({
    tenant_id:         tenantId,
    patient_id:        _activePatient.id,
    visit_id:          _activeVisitId,
    doctor_id:         userId,
    consent_date:      document.getElementById('mha-c-date').value,
    rep_name:          document.getElementById('mha-c-rep-name').value.trim() || null,
    rep_relationship:  document.getElementById('mha-c-rep-rel').value.trim() || null,
    rep_phone:         document.getElementById('mha-c-rep-phone').value.trim() || null,
    rights_explained:  rows,
    consent_status:    document.getElementById('mha-c-consent').value,
    treatment_plan:    document.getElementById('mha-c-treatment').value.trim() || null,
    remarks:           document.getElementById('mha-c-remarks').value.trim() || null
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save consent.')); return; }
  if (doPrint) {
    const p = _activePatient;
    const html = `<html><head><title>MHA 2017 Consent</title>
      <style>body{font-family:sans-serif;padding:32px;font-size:13px}h2{margin-bottom:4px}
      .row{display:flex;gap:24px;margin-bottom:10px}.label{font-weight:600;min-width:130px}
      .check{margin:4px 0}.section{margin:18px 0 6px;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #ccc;padding-bottom:3px}
      .sig-box{margin-top:40px;display:flex;gap:60px}.sig-line{width:180px;border-top:1px solid #333;padding-top:4px;font-size:11px}</style>
      </head><body>
      <h2>Mental Healthcare Act 2017 — Informed Consent Form</h2>
      <div style="font-size:11px;color:#666;margin-bottom:16px">Section 18 &amp; 19 — Right to Access &amp; Right to Consent</div>
      <div class="section">Patient</div>
      <div class="row"><span class="label">Name:</span>${_esc(p.name)}</div>
      <div class="row"><span class="label">Date:</span>${document.getElementById('mha-c-date').value}</div>
      <div class="section">Nominated Representative</div>
      <div class="row"><span class="label">Name:</span>${_esc(document.getElementById('mha-c-rep-name').value||'—')}</div>
      <div class="row"><span class="label">Relationship:</span>${_esc(document.getElementById('mha-c-rep-rel').value||'—')}</div>
      <div class="row"><span class="label">Phone:</span>${_esc(document.getElementById('mha-c-rep-phone').value||'—')}</div>
      <div class="section">Rights Explained</div>
      ${['Patient right to access mental health treatment','Right to give or refuse consent','Right to confidentiality','Right to Advance Directive (MHA §5)','Right to Nominated Representative (MHA §14)','Proposed treatment plan explained'].map((t,i) =>
        `<div class="check">${rows.includes('r'+(i+1)) ? '☑' : '☐'} ${t}</div>`).join('')}
      <div class="section">Consent Decision</div>
      <div class="row"><span class="label">Status:</span>${_esc(document.getElementById('mha-c-consent').selectedOptions[0]?.textContent||'')}</div>
      <div class="row"><span class="label">Treatment:</span>${_esc(document.getElementById('mha-c-treatment').value||'—')}</div>
      <div class="row"><span class="label">Remarks:</span>${_esc(document.getElementById('mha-c-remarks').value||'—')}</div>
      <div class="sig-box">
        <div><div class="sig-line">Patient / Representative Signature</div></div>
        <div><div class="sig-line">Doctor Signature &amp; Stamp</div></div>
      </div>
      <\/body><\/html>`;
    const w = window.open('','_blank');
    w.document.write(html);
    w.document.close();
    w.print();
  }
  closeMhaConsent();
  alert('MHA 2017 Consent saved.');
}

subscribeRealtime();

// ── §21o Clinical Photography / Media Documentation ──────────────────────────
// NCISM Regulation 50(12) — photography/videography section for clinical documentation
let _mediaList = [];
window.openMediaModal = function() {
  if (!_activeVisit) return;
  document.getElementById('media-modal').style.display = 'flex';
  loadMediaList();
};
window.closeMediaModal = function() { document.getElementById('media-modal').style.display = 'none'; };

async function loadMediaList() {
  const el = document.getElementById('media-list');
  const { data } = await supabase.from('clinical_media')
    .select('*').eq('visit_id', _activeVisitId).eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  _mediaList = data || [];
  if (_mediaList.length === 0) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">No media uploaded for this consultation.</div>';
    return;
  }
  // clinical-media is a private bucket — file_url stores the storage path, not a
  // public URL; a fresh signed URL is generated per item at display time.
  const rows = await Promise.all(_mediaList.map(async m => {
    const { data: signed } = await supabase.storage.from('clinical-media').createSignedUrl(m.file_url, 3600);
    const href = signed?.signedUrl || '#';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0f4f2">
        <span style="font-size:20px">${m.media_type==='video'?'🎥':'🖼️'}</span>
        <div style="flex:1"><a href="${_esc(href)}" target="_blank" style="color:var(--green-mid);font-size:13px;font-weight:500">${_esc(m.caption||'Unnamed')}</a>
        <div style="font-size:11px;color:var(--text-muted)">${_esc(m.media_type)} · Consent: ${m.consent_obtained?'✓ Yes':'⚠ Not recorded'} · Academic use: ${m.academic_use_approved?'✓':'✗'}</div></div>
      </div>`;
  }));
  el.innerHTML = rows.join('');
}

window.uploadClinicalMedia = async function() {
  const fileInput = document.getElementById('media-file-input');
  const files = fileInput.files;
  if (!files?.length) { alert('Select a file first'); return; }
  const consent = document.getElementById('media-consent').checked;
  if (!consent) { alert('Patient consent must be obtained before uploading clinical media'); return; }
  const caption  = document.getElementById('media-caption').value.trim();
  const academic = document.getElementById('media-academic').checked;

  const file = files[0];
  const ext  = file.name.split('.').pop().toLowerCase();
  const isVideo = ['mp4','mov','avi','webm'].includes(ext);
  const path = `${tenantId}/${_activeVisitId}/${Date.now()}.${ext}`;

  const { data: upData, error: upErr } = await supabase.storage
    .from('clinical-media').upload(path, file, { cacheControl:'3600', upsert:false });
  if (upErr) { alert(safeErrorMessage(upErr, 'Upload failed. Please try again.')); return; }

  // Store the storage PATH, not a public URL — clinical-media is a private
  // bucket; signed URLs are generated on demand at display time (loadMediaList).
  const { error } = await supabase.from('clinical_media').insert({
    tenant_id:            tenantId,
    patient_id:           _activePatient?.id,
    visit_id:             _activeVisitId,
    file_url:             path,
    media_type:           isVideo ? 'video' : 'image',
    caption:              caption || null,
    consent_obtained:     consent,
    academic_use_approved:academic,
    captured_by:          profile.id,
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save media record.')); return; }
  document.getElementById('media-caption').value = '';
  fileInput.value = '';
  loadMediaList();
  // Only images actually appear in the built bundle (abdm-fhir's buildHealthDocument()
  // deliberately skips video rows — see its own comment) — no point declaring the hiType
  // for a video-only upload, which would only ever surface a placeholder.
  if (!isVideo && consent && _activePatient) _abdmCareContextHealthDocument(_activePatient);
};

// 6 Sep 2026 (Session 198 follow-up #4) — same real gap as ImmunizationRecord above:
// buildHealthDocument() has worked correctly since Session 182 (real clinical_media images,
// gated on consent_obtained), but nothing ever declared 'HealthDocumentRecord' to ABDM — no
// push site existed anywhere. Patient-scoped ref (HDOC-<patientId>), matching
// buildHealthDocument()'s own patient-wide scope (all consented images, not one visit's) and
// NRCES's own definition of this record type as historical/patient-level, not per-visit.
async function _abdmCareContextHealthDocument(patient) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` };
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const ccRef   = `HDOC-${patient.id}`;
    const display = `Health Document - ${dateStr}`;

    const ccRes = await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        action: 'create_care_context', patient_id: patient.id,
        care_context_ref: ccRef, display, hi_types: ['HealthDocumentRecord'],
        abha_number: patient.abha_number, abha_address: patient.abha_address,
      }),
    });
    const ccData = await ccRes.json().catch(() => ({}));
    const realHiTypes = ccData?.hi_types?.length ? ccData.hi_types : ['HealthDocumentRecord'];

    if (patient.abha_number || patient.abha_address) {
      await fetch(ABDM_HIP_FN, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          action: 'generate_link_token', patient_id: patient.id,
          abha_number: patient.abha_number, abha_address: patient.abha_address,
          care_contexts: realHiTypes.map(t => ({ referenceNumber: ccRef, display, hiType: t })),
        }),
      });
    }
  } catch (e) { console.warn('[ABDM] health document care context failed:', e?.message); }
}

// ── §21t Swarnaprashan Register (KAU OPD) ────────────────────────────────────
window.saveSwarnaprashan = async function() {
  if (!_activePatient?.id) return;
  const dose = document.getElementById('sp-dose-type').value.trim();
  if (!dose) { alert('Dose type required'); return; }
  const { error } = await supabase.from('swarnaprashan_records').insert({
    tenant_id:         tenantId,
    patient_id:        _activePatient.id,
    administration_date: todayLocalStr(),
    child_age_months:  parseInt(document.getElementById('sp-age-months').value)||null,
    dose_type:         dose,
    batch_number:      document.getElementById('sp-batch').value.trim()||null,
    administered_by:   profile.id,
    next_dose_date:    document.getElementById('sp-next-dose').value||null,
    notes:             document.getElementById('sp-notes').value.trim()||null,
  });
  if (error) {
    if (error.code === '42P01') alert('Run session32_ncism_gaps.sql in Supabase first');
    else alert(safeErrorMessage(error, 'Something went wrong. Please try again.'));
    return;
  }
  ['sp-dose-type','sp-batch','sp-notes'].forEach(id => document.getElementById(id).value = '');
  _loadSwarnaprashanHistory(_activePatient.id);
};

async function _loadSwarnaprashanHistory(patientId) {
  const el = document.getElementById('sp-history');
  if (!el || !patientId) return;
  const { data } = await supabase.from('swarnaprashan_records')
    .select('*').eq('patient_id', patientId).eq('tenant_id', tenantId)
    .order('administration_date', { ascending: false }).limit(5);
  if (!data?.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">Recent records:</div>' +
    data.map(r => `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid #f0f4f2">${r.administration_date} — ${_esc(r.dose_type)} ${r.child_age_months?'('+r.child_age_months+' months)':''} ${r.next_dose_date?'· Next: '+r.next_dose_date:''}</div>`).join('');
}

// ── NABH Consent Management ──────────────────────────────────────────────────
window.saveOpdConsent = async function() {
  if (!_activePatient?.id || !_activeVisitId) { alert('No active consultation'); return; }
  const consentBy = document.getElementById('consent-by').value.trim();
  if (!consentBy) { alert('Enter the name of who is giving consent'); return; }
  const { error } = await supabase.from('consent_records').insert({
    tenant_id:             tenantId,
    patient_id:            _activePatient.id,
    visit_id:              _activeVisitId,
    consent_type:          document.getElementById('consent-type').value,
    consent_given:         true,
    consent_by:            consentBy,
    relationship:          document.getElementById('consent-relationship').value,
    risks_explained:       document.getElementById('consent-risks').checked,
    alternatives_explained:document.getElementById('consent-alts').checked,
    questions_answered:    document.getElementById('consent-questions').checked,
    doctor_id:             profile.id,
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save consent.')); return; }
  document.getElementById('consent-saved-msg').style.display = '';
  setTimeout(() => { document.getElementById('consent-saved-msg').style.display = 'none'; }, 3000);
};

// ── NABH Pain Score Display ───────────────────────────────────────────────────
window._updatePainDisplay = function(val) {
  const labels = ['0 — No pain','1','2','3 — Mild','4','5 — Moderate','6','7 — Severe','8','9','10 — Worst'];
  const colors = ['#27ae60','#27ae60','#f39c12','#f39c12','#e67e22','#e67e22','#e74c3c','#e74c3c','#c0392b','#c0392b','#8b1a1a'];
  const el = document.getElementById('pain-score-display');
  el.textContent = labels[val] || val;
  el.style.color = colors[val] || 'var(--green-deep)';
};

// ── NABH Allergy System ───────────────────────────────────────────────────────
let _patientAllergies = [];

async function _loadPatientAllergies(patientId) {
  const banner = document.getElementById('allergy-banner');
  const list   = document.getElementById('dh-allergy-list');
  banner.style.display = 'none';
  if (!patientId) return;
  const { data } = await supabase.from('patient_allergies')
    .select('id,allergen,allergen_type,severity,reaction,status')
    .eq('patient_id', patientId).eq('tenant_id', tenantId).eq('status','active')
    .order('created_at', { ascending: false });
  _patientAllergies = data || [];
  if (!_patientAllergies.length) {
    list.innerHTML = '<span style="color:var(--text-muted)">No known allergies recorded</span>';
    document.getElementById('dh-allergy').value = '';
    return;
  }
  const sevColor = { mild:'#f39c12', moderate:'#e67e22', severe:'#e74c3c', anaphylaxis:'#c0392b' };
  list.innerHTML = _patientAllergies.map(a =>
    `<span style="display:inline-flex;align-items:center;gap:4px;background:${sevColor[a.severity]||'#e74c3c'}20;border:1px solid ${sevColor[a.severity]||'#e74c3c'};border-radius:12px;padding:2px 8px;margin:2px;font-size:11px;color:#333">
      <strong>${_esc(a.allergen)}</strong>${a.severity?` <span style="color:${sevColor[a.severity]||'#e74c3c'};font-size:10px">[${_esc(a.severity)}]</span>`:''}
    </span>`
  ).join('');
  document.getElementById('dh-allergy').value = _patientAllergies.map(a => a.allergen).join(', ');
  banner.style.display = 'flex';
  document.getElementById('allergy-banner-text').textContent =
    _patientAllergies.map(a => `${a.allergen}${a.severity ? ' ('+a.severity+')' : ''}`).join(' · ');
}

window.openAllergyModal = function() {
  if (!_activePatient?.id) return;
  const modal = document.getElementById('allergy-modal');
  modal.style.display = 'flex';
  renderAllergyList();
};
window.closeAllergyModal = function() {
  document.getElementById('allergy-modal').style.display = 'none';
};
function renderAllergyList() {
  const el = document.getElementById('allergy-modal-list');
  if (!_patientAllergies.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">None recorded</div>'; return; }
  const sevColor = { mild:'#f39c12', moderate:'#e67e22', severe:'#e74c3c', anaphylaxis:'#c0392b' };
  el.innerHTML = _patientAllergies.map(a =>
    `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">
      <span style="flex:1;font-size:13px"><strong>${_esc(a.allergen)}</strong> <span style="color:var(--text-muted)">(${_esc(a.allergen_type)})</span>${a.reaction ? ' — '+_esc(a.reaction) : ''}</span>
      ${a.severity ? `<span style="font-size:11px;font-weight:600;color:${sevColor[a.severity]||'#e74c3c'};background:${sevColor[a.severity]||'#e74c3c'}15;padding:2px 7px;border-radius:10px">${_esc(a.severity)}</span>` : ''}
      <button data-onclick="resolveAllergy" data-onclick-a0="${_esc(a.id)}" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);background:#fff;border-radius:5px;cursor:pointer;color:var(--text-muted)">Resolved</button>
    </div>`
  ).join('');
}
window.resolveAllergy = async function(allergyId) {
  await supabase.from('patient_allergies').update({ status:'resolved' }).eq('id', allergyId);
  await _loadPatientAllergies(_activePatient.id);
  renderAllergyList();
};
window.saveAllergy = async function() {
  const allergen = document.getElementById('new-allergen').value.trim();
  if (!allergen) { alert('Allergen name required'); return; }
  const { error } = await supabase.from('patient_allergies').insert({
    tenant_id:     tenantId,
    patient_id:    _activePatient.id,
    allergen,
    allergen_type: document.getElementById('new-allergen-type').value,
    severity:      document.getElementById('new-severity').value || null,
    reaction:      document.getElementById('new-reaction').value.trim() || null,
    recorded_by:   profile.id,
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save allergy record.')); return; }
  // Update has_allergies flag on patients table
  await supabase.from('patients').update({ has_allergies: true }).eq('id', _activePatient.id);
  document.getElementById('new-allergen').value   = '';
  document.getElementById('new-reaction').value   = '';
  document.getElementById('new-severity').value   = '';
  await _loadPatientAllergies(_activePatient.id);
  renderAllergyList();
};
