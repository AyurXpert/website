import { requireAuth, getCurrentProfile, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { logAudit } from '../core/auditLogger.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType } from '../config/ncism.js';
import { addOpdBillItem } from '../modules/billing/opdBillItems.js';

// Auth + navbar first — page must always be visible and navigable even if proforma module is absent
await requireAuth(['doctor', 'super_admin', 'dept_admin']);
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
    }
    if (_hasAdm) {
      document.getElementById('tab-btn-adm').classList.remove('gated');
      document.getElementById('tab-btn-adm').style.display = '';
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

window.switchQueueTab = function(tab) {
  _queueTab = tab;
  document.getElementById('q-search').value = '';
  const opd  = document.getElementById('q-tab-opd');
  const tele = document.getElementById('q-tab-tele');
  const ipd  = document.getElementById('q-tab-ipd');
  [opd, tele, ipd].forEach(b => { b.style.background = 'none'; b.style.color = 'var(--text-muted)'; b.style.borderBottom = '2px solid transparent'; b.style.fontWeight = '500'; });
  if (tab === 'opd') {
    opd.style.background = 'var(--green-light)'; opd.style.color = 'var(--green-deep)'; opd.style.borderBottom = '2px solid var(--green-mid)'; opd.style.fontWeight = '600';
    loadQueue();
  } else if (tab === 'tele') {
    tele.style.background = '#dbeafe'; tele.style.color = '#1d4ed8'; tele.style.borderBottom = '2px solid #2563eb'; tele.style.fontWeight = '600';
    loadQueue();
  } else {
    ipd.style.background = '#fce7f3'; ipd.style.color = '#be185d'; ipd.style.borderBottom = '2px solid #db2777'; ipd.style.fontWeight = '600';
    loadIPDPatients();
  }
};

async function loadQueue() {
  const list  = document.getElementById('q-list');
  const start = new Date(); start.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('visits')
    .select('id, token_number, status, chief_complaint, created_at, is_on_request, visit_category, is_teleconsultation, meeting_url, patients(id, name, phone, abha_number, abha_address)')
    .eq('tenant_id', tenantId)
    .eq('doctor_id', userId)
    .in('status', ['waiting', 'in_progress'])
    .gte('created_at', start.toISOString())
    .order('token_number', { ascending: true });

  if (error) {
    console.error('loadQueue error:', error.message, '| code:', error.code);
    list.innerHTML = `<div class="q-empty" style="color:#e74c3c;font-size:12px">Queue error: ${_esc(safeErrorMessage(error, 'Could not load queue.'))}</div>`;
    return;
  }

  const all   = data || [];
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
      ${patient?.abha_number || patient?.abha_address
        ? `<button data-onclick="_openAbdmForHistory" class="btn btn-primary" style="font-size:13px;padding:6px 14px">📋 ABDM Records</button>`
        : ''}
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
function subscribeRealtime() {
  supabase.channel('doctor-live')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'visits',
      filter: `tenant_id=eq.${tenantId}`
    }, () => { if (_queueTab !== 'ipd') loadQueue(); })
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'doctor_alerts',
      filter: `doctor_id=eq.${userId}`
    }, payload => {
      loadAlerts();
      _toast(`New on-request: ${payload.new.patient_name} — ${payload.new.message}`, 'alert');
    })
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'referrals',
      filter: `tenant_id=eq.${tenantId}`
    }, () => loadIncomingReferrals())
    .subscribe();
}

// ── Start consultation ────────────────────────────
window.startConsultation = async function(visitId) {
  _activeVisitId = visitId;

  await supabase.from('visits').update({ status: 'in_progress' }).eq('id', visitId);

  const { data: visit } = await supabase
    .from('visits')
    .select('*, patients(id, name, phone, abha_number, abha_address, prakriti_data, prakriti_assessed_at), opds(ncism_code, name, allows_prescription, specialty_proforma_key)')
    .eq('id', visitId)
    .single();

  _activeVisit     = visit;
  _activePatient   = visit?.patients;
  _activeNcismCode = visit?.opds?.ncism_code || null;

  // NCISM — Swasthya Rakshana OPD: advisory + Swasthya Card button
  const allowsRx = visit?.opds?.allows_prescription ?? true;
  const noRxNotice = document.getElementById('no-rx-notice');
  if (noRxNotice) noRxNotice.style.display = allowsRx ? 'none' : '';
  document.getElementById('btn-swasthya-card').style.display = allowsRx ? 'none' : '';

  document.getElementById('pt-token').textContent    = visit.token_number;
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

// ── Open IPD Admission in new tab ─────────────────
window.openIPDAdmission = function() {
  if (!_activePatient) return;
  const url = `ipd.html?patient_id=${encodeURIComponent(_activePatient.id)}&name=${encodeURIComponent(_activePatient.name)}&visit_id=${encodeURIComponent(_activeVisitId||'')}`;
  window.open(url, '_blank');
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
    <button class="btn-rm-diff" data-onclick="_removeClosest" data-onclick-a0="@this" data-onclick-a1="li">×</button>
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
  document.getElementById('fu-date').value = d.toISOString().split('T')[0];
};

// ── Pathya / Apathya chips ────────────────────────
['pathya-chips', 'apathya-chips', 'pk-purva-chips', 'pk-main-chips', 'pk-other-chips'].forEach(containerId => {
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
    <button class="btn-rm-rx" data-onclick="_removeRxRowFromAttr" data-onclick-a0="${id}">×</button>
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
    anupana: row.querySelector('.rx-anupana')?.value?.trim() || ''
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
document.getElementById('btn-complete').addEventListener('click', completeConsultation);

async function completeConsultation() {
  if (!_activeVisitId) return;

  const btn = document.getElementById('btn-complete');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
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

    const dispMsg = disposition === 'pk' ? 'Panchakarma plan saved'
      : disposition === 'admission' ? 'Admission order created'
      : disposition === 'referral'  ? (refSaved ? 'Referral sent — target OPD alerted' : 'Referral noted')
      : 'sent to pharmacy';
    _toast(`${_activePatient?.name} — consultation complete, ${dispMsg}`, 'info');
    _closeConsult();
    loadQueue();

    // ABDM M2 — fire-and-forget care context creation (does not block completion)
    if (_activePatient?.abha_number) {
      _abdmCreateCareContext(_activeVisitId, _activePatient, notes, disposition);
    }

  } catch (err) {
    console.error('completeConsultation caught:', err?.message, err?.details, err?.hint);
    _toast(safeErrorMessage(err, 'Error saving consultation. Please try again.'), 'error');
    btn.disabled = false;
    btn.textContent = '✓ Complete & Send to Pharmacy';
  }
}

// ── ABDM M2 — Care Context creation after consultation ───────────
// Only upserts the DB record (merges hi_types). Link token is sent
// by reception.html at ABHA verification time — one notification per visit.
const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';

async function _abdmCreateCareContext(visitId, patient, notes, disposition) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    const hiType = disposition === 'admission' ? 'DischargeSummary' : 'OPConsultation';
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const careContextRef = `VISIT-${visitId}`;
    const display        = `OPD Consultation — ${dateStr}`;

    await fetch(ABDM_HIP_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({
        action:           'create_care_context',
        patient_id:       patient.id,
        visit_id:         visitId,
        care_context_ref: careContextRef,
        display,
        hi_types:         [hiType],
        abha_number:      patient.abha_number,
      }),
    });
  } catch (e) {
    console.warn('ABDM care context fire-and-forget failed (non-critical):', e?.message);
  }
}

// ── M3 HIU — ABDM Records Tab ─────────────────────────────────────
const ABDM_AUTH_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-auth';

async function _abdmGetToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

async function _loadAbdmTab() {
  if (!_activePatient) return;

  const raw = _activePatient.abha_address || _activePatient.abha_number || '';
  const abhaAddr = raw
    ? (raw.includes('@') ? raw : raw + '@sbx')
    : null;

  const noAbhaEl = document.getElementById('abdm-no-abha');
  const mainEl   = document.getElementById('abdm-main');
  if (!abhaAddr) {
    noAbhaEl.style.display = '';
    mainEl.style.display   = 'none';
    return;
  }
  noAbhaEl.style.display = 'none';
  mainEl.style.display   = '';

  document.getElementById('abdm-abha-addr').value = abhaAddr;

  // Set default dates only if not already set
  const today    = new Date();
  const toStr    = today.toISOString().slice(0, 10);
  const fromDate = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  const fromStr  = fromDate.toISOString().slice(0, 10);
  const eraseDate = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
  const eraseStr  = eraseDate.toISOString().slice(0, 10);
  if (!document.getElementById('abdm-date-from').value) document.getElementById('abdm-date-from').value = fromStr;
  if (!document.getElementById('abdm-date-to').value)   document.getElementById('abdm-date-to').value   = toStr;
  if (!document.getElementById('abdm-erase-at').value)  document.getElementById('abdm-erase-at').value  = eraseStr;

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

  listEl.innerHTML = consents.map(c => {
    const col   = statusColor[c.status] || '#888';
    const date  = new Date(c.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const types = (c.hi_types || []).join(', ') || '—';
    const note  = complianceNote[c.status] || null;
    const eraseDate = c.data_erase_at
      ? new Date(c.data_erase_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
      : null;

    return `<div style="border:1px solid ${note ? col + '44' : '#ddd'};border-radius:8px;padding:12px 14px;margin-bottom:10px;background:${note ? '#fafafa' : '#fff'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--green-deep);word-break:break-all">${_esc(c.abha_address)}</div>
          <div style="font-size:12px;color:#666;margin-top:3px">${date} · Purpose: ${_esc(c.purpose || 'CAREMGT')}</div>
          <div style="font-size:12px;color:#666;margin-top:2px;word-break:break-all">Types: ${_esc(types)}</div>
          ${eraseDate && c.status === 'granted' ? `<div style="font-size:11px;color:#888;margin-top:2px">Records erase after: ${eraseDate}</div>` : ''}
        </div>
        <span style="white-space:nowrap;font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;background:${col}18;color:${col};border:1px solid ${col}44">${_esc((c.status || '').toUpperCase())}</span>
      </div>
      ${note
        ? `<div style="margin-top:10px;padding:8px 10px;background:${col}10;border-left:3px solid ${col};border-radius:0 4px 4px 0;font-size:12px;color:${col};font-weight:500">${_esc(note)}</div>`
        : ''}
      ${c.status === 'granted'
        ? `<button class="btn" style="font-size:12px;padding:4px 12px;margin-top:10px" data-onclick="_loadReceivedRecords" data-onclick-a0="${_esc(c.id)}" data-onclick-a1="${_esc(c.status)}">📋 View Records</button>
           <div id="recbox-${_esc(c.id)}" style="display:none;margin-top:10px"></div>`
        : ''}
    </div>`;
  }).join('');
}

async function _submitConsentRequest() {
  const btn      = document.getElementById('btn-abdm-consent');
  const statusEl = document.getElementById('abdm-req-status');

  const abhaAddress = (document.getElementById('abdm-abha-addr')?.value || '').trim();
  if (!abhaAddress) { statusEl.innerHTML = '<span style="color:#c0392b">Patient ABHA address is required.</span>'; return; }

  const hiTypes = [...document.querySelectorAll('#abdm-hi-types .chip.on')].map(c => c.dataset.value);
  if (!hiTypes.length) { statusEl.innerHTML = '<span style="color:#c0392b">Select at least one health information type.</span>'; return; }

  const dateFrom  = document.getElementById('abdm-date-from').value;
  const dateTo    = document.getElementById('abdm-date-to').value;
  const eraseAt   = document.getElementById('abdm-erase-at').value;
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
        dataEraseAt:   eraseAt  + 'T23:59:59.000Z',
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

// ── ABDM: Parse FHIR R4 Bundle into a readable card ──────────────
function _parseFhirForDisplay(bundle, hiType) {
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
          <span id="${detId}-arrow" style="color:#999;font-size:18px;flex-shrink:0;transition:transform 0.2s">›</span>
        </div>
        <div id="${detId}" style="display:none;border-top:1px solid #e0f0d8;padding:10px 14px 14px">
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
  document.getElementById('og-edd').value = edd.toISOString().slice(0,10);
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
  if (open) document.getElementById('imm-date').value = new Date().toISOString().slice(0,10);
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
  });
  if (error) { _toast(safeErrorMessage(error, 'Could not record vaccination.'), 'error'); return; }

  _toast(`Vaccination recorded: ${vaccineName}`, 'info');
  // Reset form
  document.getElementById('imm-vaccine').value    = '';
  document.getElementById('imm-batch').value      = '';
  document.getElementById('imm-next-due').value   = '';
  document.getElementById('imm-custom-name').value= '';
  document.getElementById('imm-custom-row').style.display = 'none';
  await _loadImmunizations(_activePatient.id);
};

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
    recorded_at:             new Date().toISOString().slice(0,10),
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
    assessed_at: new Date().toISOString().slice(0,10),
  };

  const { error } = await supabase.from('patients').update({
    prakriti_data:         prakritiData,
    prakriti_assessed_at:  new Date().toISOString().slice(0,10),
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
  document.getElementById('mc-rest-from').value = new Date().toISOString().slice(0,10);
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
    'disp-notes','pk-oils','pk-notes','pk-start','pk-duration',
    'adm-ward','adm-nursing','adm-diet','adm-duration','adm-indication',
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
    'd-certainty','adm-type','fu-quick','ref-type','ref-urgency','ref-target-opd'
  ];
  selects.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

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
    const today = new Date().toISOString().split('T')[0];
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
await Promise.all([loadQueue(), loadAlerts(), loadInventory(), _loadOpdAttendanceBanner(), loadOpdList(), loadDoctorOpds()]);

async function _loadOpdAttendanceBanner() {
  const { data: t } = await supabase.from('tenants').select('ug_intake,opd_daily_target,type').eq('id', tenantId).single();
  if (!t || !isNCISMType(t.type)) return;
  const target = t.opd_daily_target || ((t.ug_intake || 0) * 2);
  if (!target) return;

  const today = new Date().toISOString().slice(0, 10);
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
  document.getElementById('adr-report-date').value   = new Date().toISOString().slice(0,10);
  document.getElementById('adr-reaction-date').value = new Date().toISOString().slice(0,10);
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
    order_date:          new Date().toISOString().slice(0,10),
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
      lines.push({ description: bundleFee.label, price: Number(bundleFee.amount) || 0, gst_percent: Number(bundleFee.gst_percent) || 0 });
    } else {
      // Not a complete/priceable bundle -- fall back to individual pricing
      // for every test in this group, same path as never-tagged tests.
      individual.push(...taggedTests);
    }
  }

  for (const testName of individual) {
    const feeLabel = TEST_LABEL_OVERRIDES[testName] || testName;
    const fee = byLabel[feeLabel];
    if (fee) lines.push({ description: fee.label, price: Number(fee.amount) || 0, gst_percent: Number(fee.gst_percent) || 0 });
    else unmatched.push(testName);
  }

  return { lines, unmatched };
}

// Attaches this lab order's charges to the visit's existing OPD bill
// (Step 3's addOpdBillItem) -- deliberately non-blocking: a billing hiccup
// here must never stop the clinical order itself, which has already been
// saved by the time this runs. Unmatched tests are surfaced, never silently
// charged ₹0 or silently dropped.
async function _billLabOrder(labSelected) {
  try {
    const { data: bill } = await supabase.from('bills').select('id')
      .eq('visit_id', _activeVisitId).eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!bill) return { billed: [], unmatched: [], noBill: true };

    const { data: feeRows } = await supabase.from('fee_structures')
      .select('label,amount,gst_percent').eq('tenant_id', tenantId).eq('is_active', true).in('category', ['lab','radiology']);

    const { lines, unmatched } = _computeLabBillingLines(labSelected, feeRows || []);

    for (const line of lines) {
      const { error } = await addOpdBillItem({
        supabase, tenantId, billId: bill.id, itemType: 'lab',
        description: line.description, quantity: 1, price: line.price, gstPercent: line.gst_percent,
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

function openLabOrderModal() {
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
}

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

  // Create lab_orders record -- lab_orders has no patient_id column at all
  // (confirmed live, zero rows exist in the whole platform); it routes
  // through visit_id -> visits.patient_id only, matching how lab.js already
  // reads it back. Sending patient_id here made every submission fail with
  // a schema error -- lab ordering from doctor.html has never worked.
  const { data: order, error: oErr } = await supabase.from('lab_orders').insert({
    tenant_id:  tenantId,
    visit_id:   _activeVisitId,
    status:     'pending',
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

  // Session 124 Step 4 -- bill at order time (matches how registration/
  // consultation fees are already collected same-day). Never blocks the
  // clinical order, which is already saved above regardless of what happens here.
  const { unmatched, noBill } = await _billLabOrder(_labSelected);

  closeLabOrderModal();
  let msg = `✅ Lab order submitted: ${_labSelected.size} tests ordered. Lab technician will be notified.`;
  if (noBill) msg += `\n\n⚠ No bill found for this visit -- lab charges were not added. Please add them manually via reception.`;
  else if (unmatched.length) msg += `\n\n⚠ No price found for: ${unmatched.join(', ')} -- please add these to the bill manually.`;
  alert(msg);
  loadLabResults();
};

async function loadLabResults() {
  if (!_activeVisitId) return;
  const { data: orders, error: ordErr } = await supabase
    .from('lab_orders')
    .select('id,status')
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
  document.getElementById('mha-c-date').value    = new Date().toISOString().slice(0,10);
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
};

// ── §21t Swarnaprashan Register (KAU OPD) ────────────────────────────────────
window.saveSwarnaprashan = async function() {
  if (!_activePatient?.id) return;
  const dose = document.getElementById('sp-dose-type').value.trim();
  if (!dose) { alert('Dose type required'); return; }
  const { error } = await supabase.from('swarnaprashan_records').insert({
    tenant_id:         tenantId,
    patient_id:        _activePatient.id,
    administration_date: new Date().toISOString().slice(0,10),
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
