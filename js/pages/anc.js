import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['doctor','nurse','super_admin','dept_admin','receptionist']);
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};
window.closeDetailModal = function() { document.getElementById('detail-overlay').style.display = 'none'; };

const profile    = getCurrentProfile();
const tenantId   = getCurrentTenantId();
const userId     = profile?.id;

let _patient      = null;
let _ancVisits     = [];
let _searchTimer   = null;
let _searchResults = [];

// ── Patient search ────────────────────────────────────────────────────────────
window.debounceSearch = function(val) {
  clearTimeout(_searchTimer);
  if (val.length < 2) { document.getElementById('search-results').style.display = 'none'; return; }
  _searchTimer = setTimeout(() => searchPatients(val), 300);
};

async function searchPatients(q) {
  const { data } = await supabase.from('patients')
    .select('id,name,phone,age,gender,abha_number')
    .eq('tenant_id', tenantId)
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%,abha_number.ilike.%${q}%`)
    .limit(8);

  const el = document.getElementById('search-results');
  if (!data || !data.length) {
    el.style.display = 'block';
    el.innerHTML = `<div style="padding:10px;font-size:13px;color:var(--text-muted)">No patients found</div>`;
    return;
  }
  _searchResults = data;
  el.style.display = 'block';
  el.innerHTML = data.map(p => `
    <div class="search-row-item" data-onclick="selectPatient" data-onclick-a0="${p.id}">
      <div>
        <div class="pt-name">${p.name}</div>
        <div class="pt-meta">${p.phone || '—'} · Age ${p.age || '—'} · ${(p.gender||'').charAt(0).toUpperCase()}</div>
      </div>
      <span style="font-size:11px;color:var(--text-muted)">${p.abha_number||''}</span>
    </div>`).join('');
}

window.selectPatient = async function(id) {
  const p = _searchResults.find(x => x.id === id);
  if (!p) return;
  _patient = p;
  document.getElementById('search-results').style.display = 'none';
  document.getElementById('pt-search').value = p.name;
  document.getElementById('bar-name').textContent = p.name;
  document.getElementById('bar-meta').textContent = `${p.phone||'—'} · Age ${p.age||'—'} · ${(p.gender||'').charAt(0).toUpperCase()}`;
  document.getElementById('patient-bar').classList.add('show');
  document.getElementById('new-visit-btn').disabled = false;
  await loadAncVisits();
  document.getElementById('garbha-card').style.display = '';
  loadGarbhaSessions();
};

window.clearPatient = function() {
  _patient = null;
  document.getElementById('pt-search').value = '';
  document.getElementById('patient-bar').classList.remove('show');
  document.getElementById('anc-stats').style.display = 'none';
  document.getElementById('anc-card').style.display = 'none';
  document.getElementById('risk-card').style.display = 'none';
  document.getElementById('garbha-card').style.display = 'none';
  document.getElementById('new-visit-btn').disabled = true;
};

// ── Load ANC visits ───────────────────────────────────────────────────────────
async function loadAncVisits() {
  const { data, error } = await supabase
    .from('anc_visits')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('patient_id', _patient.id)
    .order('visit_date');
  if (error) { _alert('error', safeErrorMessage(error, 'Could not load visits.')); return; }
  _ancVisits = data || [];
  renderAncTable();
  updateStats();
}

function renderAncTable() {
  document.getElementById('anc-card').style.display = 'block';
  document.getElementById('anc-stats').style.display = 'block';
  const tbody = document.getElementById('anc-tbody');
  if (!_ancVisits.length) {
    tbody.innerHTML = `<tr><td colspan="14"><div class="empty-state"><div class="empty-icon">🤰</div><div class="empty-title">No ANC visits recorded</div><div class="empty-sub">Add the first antenatal visit</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = _ancVisits.map((v, i) => `
    <tr class="${v.risk_category === 'high' ? 'high-risk-row' : ''}">
      <td><strong>${i + 1}</strong></td>
      <td>${_fmtDate(v.visit_date)}</td>
      <td>${v.gestational_age || '—'}</td>
      <td>${v.weight || '—'}</td>
      <td>${v.bp_systolic && v.bp_diastolic ? v.bp_systolic + '/' + v.bp_diastolic : '—'}</td>
      <td>${v.pulse || '—'}</td>
      <td>${v.fundal_height || '—'}</td>
      <td>${v.fhr || '—'}</td>
      <td>${v.presentation || '—'}</td>
      <td style="font-weight:600;color:${v.haemoglobin && v.haemoglobin < 10 ? 'var(--red)' : 'inherit'}">${v.haemoglobin || '—'}</td>
      <td>${v.urine_albumin || '—'} / ${v.urine_sugar || '—'}</td>
      <td><span class="risk-badge risk-${v.risk_category||'normal'}">${_riskLabel(v.risk_category)}</span></td>
      <td>${v.next_visit_date ? _fmtDate(v.next_visit_date) : '—'}</td>
      <td class="no-print"><button class="btn btn-secondary btn-sm" data-onclick="viewVisit" data-onclick-a0="${v.id}">View</button></td>
    </tr>`).join('');

  // Risk factors
  const riskVisits = _ancVisits.filter(v => v.risk_factors);
  if (riskVisits.length) {
    document.getElementById('risk-card').style.display = 'block';
    document.getElementById('risk-factors-body').innerHTML = riskVisits
      .map(v => `<div>📅 ${_fmtDate(v.visit_date)} — ${v.risk_factors}</div>`).join('');
  }
}

function updateStats() {
  const count = _ancVisits.length;
  const latest = count ? _ancVisits[count - 1] : null;
  const highRisk = _ancVisits.some(v => v.risk_category === 'high');
  const modRisk  = _ancVisits.some(v => v.risk_category === 'moderate');

  document.getElementById('stat-visits').textContent = count;
  document.getElementById('stat-poa').textContent = latest?.gestational_age || '—';
  document.getElementById('stat-edd').textContent = latest?.edd ? _fmtDate(latest.edd) : '—';
  const riskText = highRisk ? 'High Risk' : modRisk ? 'Moderate' : 'Normal';
  const riskClass = highRisk ? 'red' : modRisk ? 'gold' : '';
  document.getElementById('stat-risk').textContent = riskText;
  document.getElementById('stat-risk-card').className = 'stat-card ' + riskClass;

  const badge = document.getElementById('risk-badge');
  badge.textContent = riskText;
  badge.className = 'risk-badge risk-' + (highRisk ? 'high' : modRisk ? 'moderate' : 'normal');
}

// ── New visit modal ───────────────────────────────────────────────────────────
window.openVisitModal = function() {
  if (!_patient) return;
  document.getElementById('modal-pt-label').textContent = _patient.name + ' — Visit ' + (_ancVisits.length + 1);
  document.getElementById('v-date').value  = new Date().toISOString().slice(0, 10);
  document.getElementById('v-visit-no').value = _ancVisits.length + 1;
  document.getElementById('risk-alert').classList.remove('show');
  document.getElementById('visit-overlay').style.display = 'flex';
};

window.closeVisitModal = function() {
  document.getElementById('visit-overlay').style.display = 'none';
};

window.assessRisk = function() {
  const sys    = parseInt(document.getElementById('v-bp-sys').value) || 0;
  const dia    = parseInt(document.getElementById('v-bp-dia').value) || 0;
  const hb     = parseFloat(document.getElementById('v-hb').value) || 0;
  const fhr    = parseInt(document.getElementById('v-fhr').value) || 0;
  const albumin= document.getElementById('v-urine-albumin').value;
  const pallor = document.getElementById('v-pallor').value;

  const flags = [];
  if (sys >= 140 || dia >= 90) flags.push('BP ≥ 140/90 — PIH / Pre-eclampsia suspected');
  if (hb && hb < 7)    flags.push('Hb < 7 g/dL — Severe anaemia');
  else if (hb && hb < 10) flags.push('Hb < 10 g/dL — Anaemia present');
  if (fhr && (fhr < 110 || fhr > 160)) flags.push('FHR abnormal (' + fhr + ' bpm) — foetal distress?');
  if (['2+','3+'].includes(albumin)) flags.push('Proteinuria ' + albumin + ' — renal / PIH concern');
  if (['moderate','severe'].includes(pallor)) flags.push('Pallor ' + pallor + ' — anaemia workup needed');

  const alert = document.getElementById('risk-alert');
  if (flags.length) {
    alert.innerHTML = '<strong>⚠ Auto-detected risk factors:</strong><br>' + flags.join('<br>');
    alert.className = 'risk-alert high show';
    document.getElementById('v-risk').value = sys >= 140 || dia >= 90 || (hb && hb < 7) ? 'high' : 'moderate';
  } else {
    alert.classList.remove('show');
  }
};

window.saveVisit = async function() {
  if (!_patient) return;
  const payload = {
    tenant_id:       tenantId,
    patient_id:      _patient.id,
    doctor_id:       userId,
    visit_number:    parseInt(document.getElementById('v-visit-no').value) || (_ancVisits.length + 1),
    visit_date:      document.getElementById('v-date').value,
    gestational_age: document.getElementById('v-poa').value.trim() || null,
    weight:          parseFloat(document.getElementById('v-weight').value) || null,
    bp_systolic:     parseInt(document.getElementById('v-bp-sys').value) || null,
    bp_diastolic:    parseInt(document.getElementById('v-bp-dia').value) || null,
    pulse:           parseInt(document.getElementById('v-pulse').value) || null,
    temperature:     parseFloat(document.getElementById('v-temp').value) || null,
    edema:           document.getElementById('v-edema').value,
    pallor:          document.getElementById('v-pallor').value,
    fundal_height:   document.getElementById('v-fh').value.trim() || null,
    fhr:             parseInt(document.getElementById('v-fhr').value) || null,
    fetal_movements: document.getElementById('v-fetal-mov').value,
    presentation:    document.getElementById('v-presentation').value,
    lie:             document.getElementById('v-lie').value,
    engagement:      document.getElementById('v-engagement').value,
    haemoglobin:     parseFloat(document.getElementById('v-hb').value) || null,
    blood_sugar:     document.getElementById('v-bs').value.trim() || null,
    urine_albumin:   document.getElementById('v-urine-albumin').value,
    urine_sugar:     document.getElementById('v-urine-sugar').value,
    risk_category:   document.getElementById('v-risk').value,
    risk_factors:    document.getElementById('v-risk-factors').value.trim() || null,
    supplements:     document.getElementById('v-supplements').value,
    tt_status:       document.getElementById('v-tt').value,
    referral:        document.getElementById('v-referral').value.trim() || null,
    next_visit_date: document.getElementById('v-next-visit').value || null,
    remarks:         document.getElementById('v-remarks').value.trim() || null,
  };

  const { error } = await supabase.from('anc_visits').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save ANC visit.')); return; }
  _alert('success', 'ANC visit saved.');
  closeVisitModal();
  await loadAncVisits();
};

// ── View detail ───────────────────────────────────────────────────────────────
window.viewVisit = function(id) {
  const v = _ancVisits.find(x => x.id === id);
  if (!v) return;
  document.getElementById('detail-sub').textContent = 'Visit ' + v.visit_number + ' — ' + _fmtDate(v.visit_date);
  document.getElementById('detail-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px">
      ${_row('Date', _fmtDate(v.visit_date))}
      ${_row('Gestational Age', v.gestational_age)}
      ${_row('Weight (kg)', v.weight)}
      ${_row('BP', v.bp_systolic ? v.bp_systolic+'/'+v.bp_diastolic+' mmHg' : '—')}
      ${_row('Pulse', v.pulse ? v.pulse+' bpm' : '—')}
      ${_row('Temperature', v.temperature ? v.temperature+'°F' : '—')}
      ${_row('Oedema', v.edema || '—')}
      ${_row('Pallor', v.pallor || '—')}
      ${_row('Fundal Height', v.fundal_height)}
      ${_row('FHR', v.fhr ? v.fhr+' bpm' : '—')}
      ${_row('Foetal Movements', v.fetal_movements)}
      ${_row('Presentation', v.presentation)}
      ${_row('Lie', v.lie)}
      ${_row('Engagement', v.engagement)}
      ${_row('Haemoglobin', v.haemoglobin ? v.haemoglobin+' g/dL' : '—')}
      ${_row('Blood Sugar', v.blood_sugar)}
      ${_row('Urine Albumin', v.urine_albumin)}
      ${_row('Urine Sugar', v.urine_sugar)}
      ${_row('Risk Category', _riskLabel(v.risk_category))}
      ${_row('Risk Factors', v.risk_factors)}
      ${_row('Supplements', v.supplements)}
      ${_row('TT Status', v.tt_status)}
      ${_row('Referral', v.referral)}
      ${_row('Next Visit', v.next_visit_date ? _fmtDate(v.next_visit_date) : '—')}
    </div>
    ${v.remarks ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)"><strong>Advice / Remarks:</strong><br>${v.remarks}</div>` : ''}`;
  document.getElementById('detail-overlay').style.display = 'flex';
};

window.printRegister = function() { window.print(); };

// ── Helpers ───────────────────────────────────────────────────────────────────
// ── §21q Garbhasanskara Sessions ─────────────────────────────────────────────
let _garbhaSessions = [];
window.loadGarbhaSessions = async function() {
  const el = document.getElementById('garbha-list');
  if (!_patient) return;
  const { data, error } = await supabase
    .from('garbhasanskara_sessions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('patient_id', _patient.id)
    .order('session_date', { ascending: false });
  if (error) {
    el.innerHTML = error.code === '42P01' ? '<em style="color:var(--text-muted)">Run session32_ncism_gaps.sql to activate this module.</em>' : safeErrorMessage(error, 'Could not load sessions.');
    return;
  }
  _garbhaSessions = data || [];
  if (!_garbhaSessions.length) { el.innerHTML = '<em style="color:var(--text-muted)">No Garbhasanskara sessions logged yet.</em>'; return; }
  const typeLabel = { yoga:'Yoga', music_therapy:'Music Therapy', mantra_therapy:'Mantra Therapy', meditation:'Meditation', counselling:'Counselling', other:'Other' };
  el.innerHTML = _garbhaSessions.map(s => `
    <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #f0f4f2">
      <div style="font-weight:600;font-size:13px;min-width:90px">${s.session_date}</div>
      <span style="padding:2px 8px;border-radius:4px;background:#e8f5ee;color:var(--green-deep);font-size:11px;font-weight:600">${typeLabel[s.session_type]||s.session_type}</span>
      <div style="font-size:12px;color:var(--text-muted)">${s.gestational_week ? 'Week '+s.gestational_week+' ·' : ''} ${s.duration_minutes||60} min ${s.notes ? '· '+s.notes : ''}</div>
    </div>`).join('');
};

window.openGarbhaModal = function() { document.getElementById('garbha-modal').style.display = 'flex'; document.getElementById('gs-date').value = new Date().toISOString().slice(0,10); };
window.closeGarbhaModal = function() { document.getElementById('garbha-modal').style.display = 'none'; };
window.saveGarbhaSession = async function() {
  const type = document.getElementById('gs-type').value;
  if (!type) { alert('Session type required'); return; }
  const { error } = await supabase.from('garbhasanskara_sessions').insert({
    tenant_id:        tenantId,
    patient_id:       _patient.id,
    session_date:     document.getElementById('gs-date').value,
    gestational_week: parseInt(document.getElementById('gs-week').value)||null,
    session_type:     type,
    duration_minutes: parseInt(document.getElementById('gs-duration').value)||60,
    notes:            document.getElementById('gs-notes').value.trim()||null,
    facilitator_id:   profile.id,
    attendance:       true,
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save session.')); return; }
  closeGarbhaModal();
  loadGarbhaSessions();
};

function _row(label, value) {
  return `<div><span style="font-size:11px;color:var(--text-muted);display:block">${label}</span><span style="font-weight:500">${value || '—'}</span></div>`;
}
function _riskLabel(r) { return {normal:'Normal', moderate:'Moderate', high:'High Risk'}[r] || r || 'Normal'; }
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _alert(type, msg) { const el = document.getElementById('alert-box'); el.className = `alert ${type} show`; el.textContent = msg; setTimeout(() => el.classList.remove('show'), 4000); }
