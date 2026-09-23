// Follow-up consultation Visit History (Session 295, phase 1 of the plan agreed with
// Dr. Venkatesh -- memory followup_consultation_layout_plan.md).
//
// A date-wise list of the patient's previous visits + IPD admissions in the CURRENT
// department only (newest first, 1st visit labelled at the bottom). Clicking an entry
// opens a read-only side panel over the right of the form -- today's consultation form
// is never replaced, so nothing typed is lost while the doctor compares.
//
// "This department" = same opds.ncism_code as today's visit (departments and opds share
// that code space -- the same join doctor.js's _setAdmDeptDefault() uses). Falls back to
// the exact opd_id when today's OPD has no ncism_code.
//
// Read-only, no schema change. Excludes waiting (never-seen) visits, deleted rows, and
// trainee drafts that were never finalized.

let _sb = null, _esc = s => String(s ?? '');
let _entries = [];          // merged visit + admission entries, newest first
let _loadToken = 0;         // guards against a slow load rendering after a patient switch
let _panelRx = [];          // prescription items of the visit open in the side panel (phase 2 copy)

const _fmtD = d => d ? new Date(d.length === 10 ? d + 'T00:00:00' : d)
  .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const _okReview = r => !r || r === 'finalized';
// Stored enum codes ('opd', 'lama', 'day_care', 'improved') -> readable labels.
const _NICE = { opd: 'OPD', ipd: 'IPD', lama: 'LAMA', pk: 'Panchakarma' };
const _nice = s => !s ? s : (_NICE[s] || String(s).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));

export function resetVisitTimeline() {
  _loadToken++;
  _entries = [];
  const rail = document.getElementById('vh-rail');
  if (rail) rail.hidden = true;
  const list = document.getElementById('vh-list');
  if (list) list.innerHTML = '';
  window.closeVhPanel();
}

export async function loadVisitTimeline({ supabase, esc, tenantId, patientId, currentVisitId, ncismCode, opdId }) {
  _sb = supabase; _esc = esc;
  const token = ++_loadToken;
  const rail = document.getElementById('vh-rail');
  const list = document.getElementById('vh-list');
  if (!rail || !list || !patientId) return;

  const [vRes, aRes] = await Promise.all([
    supabase.from('visits')
      .select('id, created_at, status, visit_category, chief_complaint, diagnosis, pain_score, opd_id, is_deleted, opds(name, ncism_code), doctor:profiles!doctor_id(full_name)')
      .eq('tenant_id', tenantId).eq('patient_id', patientId).neq('id', currentVisitId)
      .order('created_at', { ascending: false }),
    supabase.from('ipd_admissions')
      .select('id, admission_date, admitted_at, discharged_at, clinically_discharged_at, status, diagnosis_primary, discharge_diagnosis_ayurveda, discharge_diagnosis_icd10, discharge_medications, discharge_pk_procedures, discharge_pathya_apathya, discharge_condition, discharge_followup_date, discharge_order_notes, disposition, is_day_care, departments(name, ncism_code), admitting_doctor:profiles!admitting_doctor_id(full_name)')
      .eq('tenant_id', tenantId).eq('patient_id', patientId)
      .order('admission_date', { ascending: false }),
  ]);
  if (token !== _loadToken) return;
  if (vRes.error) console.error('visit history load failed:', vRes.error);
  if (aRes.error) console.error('admission history load failed:', aRes.error);

  const sameDept = v => ncismCode ? v.opds?.ncism_code === ncismCode : v.opd_id === opdId;
  const visits = (vRes.data || []).filter(v =>
    !v.is_deleted && ['completed', 'incomplete', 'in_progress'].includes(v.status) && sameDept(v));
  const adms = ncismCode ? (aRes.data || []).filter(a => a.departments?.ncism_code === ncismCode) : [];

  // Small 🌸/🧪 markers on the rail -- one cheap query each, not per visit.
  const ids = visits.map(v => v.id);
  const pkSet = new Set(), labSet = new Set();
  if (ids.length) {
    const [pk, lab] = await Promise.all([
      supabase.from('pk_care_plans').select('visit_id').in('visit_id', ids),
      supabase.from('lab_orders').select('visit_id, review_status').in('visit_id', ids),
    ]);
    if (token !== _loadToken) return;
    (pk.data || []).forEach(r => pkSet.add(r.visit_id));
    (lab.data || []).filter(r => _okReview(r.review_status)).forEach(r => labSet.add(r.visit_id));
  }

  _entries = [
    ...visits.map(v => ({ kind: 'visit', id: v.id, sortKey: v.created_at, row: v, pk: pkSet.has(v.id), lab: labSet.has(v.id) })),
    ...adms.map(a => ({ kind: 'adm', id: a.id, sortKey: a.admitted_at || a.admission_date, row: a })),
  ].sort((x, y) => new Date(y.sortKey) - new Date(x.sortKey));

  if (!_entries.length) { rail.hidden = true; return; }

  const firstVisitId = visits.length ? visits[visits.length - 1].id : null;
  const deptName = visits[0]?.opds?.name || adms[0]?.departments?.name || '';
  document.getElementById('vh-count').textContent =
    `${visits.length} visit${visits.length === 1 ? '' : 's'}${adms.length ? ` · ${adms.length} admission${adms.length === 1 ? '' : 's'}` : ''}`;
  document.getElementById('vh-dept').textContent = deptName;

  list.innerHTML = `<div class="vh-item vh-today" aria-current="true">
      <span class="vh-date">Today</span><span class="vh-sub">Current visit</span></div>` +
    _entries.map(e => e.kind === 'adm' ? _admItem(e.row) : _visitItem(e, e.id === firstVisitId)).join('');
  rail.hidden = false;
}

function _visitItem(e, isFirst) {
  const v = e.row;
  const tags = [
    isFirst ? '<span class="vh-tag vh-tag-first">1st visit</span>' : '',
    e.pk ? '<span class="vh-tag" title="Panchakarma planned">🌸 PK</span>' : '',
    e.lab ? '<span class="vh-tag" title="Investigations ordered">🧪 Lab</span>' : '',
    v.status === 'incomplete' ? '<span class="vh-tag vh-tag-warn">Incomplete</span>' : '',
  ].join('');
  return `<button type="button" class="vh-item" data-vh-id="${v.id}" data-onclick="openVhVisit" data-onclick-a0="${v.id}">
    <span class="vh-date">${_fmtD(v.created_at)}</span>
    <span class="vh-sub">${v.visit_category === 'followup' ? 'Follow-up' : 'OPD'}${v.doctor?.full_name ? ' · ' + _esc(v.doctor.full_name) : ''}</span>
    ${v.diagnosis || v.chief_complaint ? `<span class="vh-dx">${_esc(v.diagnosis || v.chief_complaint)}</span>` : ''}
    ${tags ? `<span class="vh-tags">${tags}</span>` : ''}
  </button>`;
}

function _admItem(a) {
  const out = a.discharged_at || a.clinically_discharged_at;
  const range = `${_fmtD(a.admission_date)} → ${out ? _fmtD(out) : 'current'}`;
  return `<button type="button" class="vh-item vh-adm" data-vh-id="${a.id}" data-onclick="openVhAdmission" data-onclick-a0="${a.id}">
    <span class="vh-adm-label">🏥 ${a.is_day_care ? 'Day Care' : 'Admitted'}</span>
    <span class="vh-date">${range}</span>
    <span class="vh-sub">${_esc(a.departments?.name || '')}</span>
    ${a.diagnosis_primary ? `<span class="vh-dx">${_esc(a.diagnosis_primary)}</span>` : ''}
  </button>`;
}

// ── Side panel ────────────────────────────────────────────────────────────
function _openPanel(entryId, title, sub) {
  document.querySelectorAll('#vh-list .vh-item.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`#vh-list [data-vh-id="${entryId}"]`)?.classList.add('active');
  document.getElementById('vh-panel-title').textContent = title;
  document.getElementById('vh-panel-sub').textContent = sub;
  document.getElementById('vh-panel-body').innerHTML = '<div class="vh-loading">Loading…</div>';
  const p = document.getElementById('vh-panel');
  _fitAboveActionBar();
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  document.getElementById('vh-panel-close').focus();
}

// Desktop: stop the panel just above doctor.html's fixed bottom action bar so Complete /
// Print Rx / Close stay reachable while a previous visit is open (found live -- the panel
// covered the bar's right end, incl. the ✕ Close button). The bar's height varies as its
// buttons wrap, so it's measured, not hardcoded. Phone width: full-screen panel, as before.
function _fitAboveActionBar() {
  const p = document.getElementById('vh-panel');
  const bar = document.querySelector('.action-bar');
  if (!p) return;
  // (offsetParent is always null for a position:fixed element -- use its real box instead)
  const r = bar?.getBoundingClientRect();
  const barTop = r && r.height > 0 ? r.top : null;
  p.style.bottom = (window.innerWidth > 860 && barTop !== null && barTop < window.innerHeight)
    ? `${Math.round(window.innerHeight - barTop)}px` : '';
}
window.addEventListener('resize', () => {
  if (document.getElementById('vh-panel')?.classList.contains('open')) _fitAboveActionBar();
});

window.closeVhPanel = function() {
  const p = document.getElementById('vh-panel');
  if (!p) return;
  const wasOpen = p.classList.contains('open');
  p.classList.remove('open');
  p.setAttribute('aria-hidden', 'true');
  const active = document.querySelector('#vh-list .vh-item.active');
  document.querySelectorAll('#vh-list .vh-item.active').forEach(el => el.classList.remove('active'));
  if (wasOpen && active) active.focus();   // keyboard users land back where they were
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('vh-panel')?.classList.contains('open')) window.closeVhPanel();
});

const _sec = (title, body) => body ? `<section class="vh-sec"><h4>${title}</h4>${body}</section>` : '';
const _rows = pairs => {
  const html = pairs.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `<div class="vh-row"><span class="vh-k">${k}</span><span class="vh-v">${_esc(v)}</span></div>`).join('');
  return html;
};

window.openVhVisit = async function(visitId) {
  const entry = _entries.find(e => e.kind === 'visit' && e.id === visitId);
  if (!entry) return;
  const v = entry.row;
  const token = _loadToken;
  _openPanel(visitId, _fmtD(v.created_at),
    [v.visit_category === 'followup' ? 'Follow-up' : 'OPD', v.opds?.name, v.doctor?.full_name].filter(Boolean).join(' · '));

  const [cnR, rxR, labR, imgR, pkR] = await Promise.all([
    _sb.from('consultation_notes').select('*').eq('visit_id', visitId).order('created_at', { ascending: false }),
    _sb.from('prescriptions').select('id, review_status, is_deleted, advice_diet, prescription_items(medicine_name, dosage, frequency, duration, anupana, timing)').eq('visit_id', visitId),
    _sb.from('lab_orders').select('id, test_name, status, order_date, review_status, lab_order_items(test_name, result_value, result_unit, reference_range, is_abnormal, is_critical, remarks)').eq('visit_id', visitId),
    _sb.from('imaging_orders').select('study_name, modality, status, order_date, findings, impression').eq('visit_id', visitId),
    _sb.from('pk_care_plans').select('status, setting, instructions_patient, pk_care_plan_protocols(protocol_label, start_date, status)').eq('visit_id', visitId),
  ]);
  if (token !== _loadToken || !document.querySelector(`#vh-list [data-vh-id="${visitId}"].active`)) return;

  const cn = (cnR.data || []).find(n => !n.is_deleted && _okReview(n.review_status)) || null;
  const rxItems = (rxR.data || []).filter(r => !r.is_deleted && _okReview(r.review_status)).flatMap(r => r.prescription_items || []);
  const labs = (labR.data || []).filter(l => _okReview(l.review_status));
  const imgs = imgR.data || [];
  const pks = pkR.data || [];
  const c = cn || {};
  _panelRx = rxItems;

  const bp = c.bp_systolic ? `${c.bp_systolic}/${c.bp_diastolic ?? '—'} mmHg` : null;
  const html = [
    _sec('📝 Case history', _rows([
      ['Chief complaint', v.chief_complaint], ['Duration', c.duration], ['Onset', c.onset],
      ['Severity', c.severity], ['Progression', c.progression], ['Pain score', v.pain_score],
      ['Aggravating', c.aggravating_factors], ['Relieving', c.relieving_factors],
      ['Associated', c.associated_symptoms], ['History', c.history_notes], ['Nidana', c.nidana],
      ['Purvarupa', c.purvarupa], ['Rupa', c.rupa], ['Samprapti', c.samprapti], ['Upashaya', c.upashaya],
    ])),
    _sec('🩺 Examination', _rows([
      ['BP', bp], ['Pulse', c.pulse_rate], ['Temp', c.temperature], ['SpO₂', c.spo2],
      ['Resp. rate', c.resp_rate], ['Weight', c.weight],
      ['Nadi', c.nadi], ['Mala', c.mala], ['Mutra', c.mutra], ['Jihwa', c.jihwa],
      ['Shabda', c.shabda], ['Sparsha', c.sparsha], ['Druk', c.druk], ['Akriti', c.akriti],
      ['Vata', c.vata_state], ['Pitta', c.pitta_state], ['Kapha', c.kapha_state],
      ['Agni', c.agni_state], ['Ama', c.ama_state],
      ['CVS', c.sys_cvs], ['RS', c.sys_rs], ['CNS', c.sys_cns], ['P/A', c.sys_pa],
      ['MSK', c.sys_msk], ['Skin', c.sys_skin],
      ['Modern exam notes', c.exam_modern_notes], ['Ayurveda exam notes', c.exam_ayurveda_notes],
    ])),
    _sec('📋 Diagnosis', _rows([
      ['Ayurveda', c.ayurveda_diagnosis || (!cn ? v.diagnosis : null)], ['Modern', c.modern_diagnosis],
      ['NAMASTE', c.diagnosis_namc_label ? `${c.diagnosis_namc_label}${c.diagnosis_namc_code ? ' (' + c.diagnosis_namc_code + ')' : ''}` : null],
      ['ICD-10', c.diagnosis_icd10_label ? `${c.diagnosis_icd10_label}${c.diagnosis_icd10_code ? ' (' + c.diagnosis_icd10_code + ')' : ''}` : null],
      ['Provisional', [c.provisional_ayurveda, c.provisional_modern].filter(Boolean).join(' / ')],
      ['Certainty', c.diagnosis_certainty], ['Clinical notes', c.clinical_notes],
    ])),
    _sec('🔬 Investigations', _rows([
      ['Lab advised', c.inv_lab], ['Imaging advised', c.inv_imaging], ['Ayurveda', c.inv_ayurveda],
    ]) + labs.map(_labHtml).join('') + imgs.map(_imgHtml).join('')),
    _sec('💊 Prescription', _rxHtml(rxItems) + _rows([['Instructions', c.rx_instructions]])),
    _sec('🌸 Panchakarma', pks.map(p => `<div class="vh-pk">
      ${(p.pk_care_plan_protocols || []).map(pr => `<div><strong>${_esc(pr.protocol_label)}</strong>${pr.start_date ? ` <span class="vh-muted">from ${_fmtD(pr.start_date)}</span>` : ''}</div>`).join('')}
      <div class="vh-muted">${_esc([_nice(p.setting), _nice(p.status)].filter(Boolean).join(' · '))}</div></div>`).join('')),
    _sec('🌿 Advice & follow-up', _rows([
      ['Pathya', c.pathya], ['Apathya', c.apathya], ['Follow-up date', c.followup_date ? _fmtD(c.followup_date) : null],
      ['Follow-up notes', c.followup_notes], ['Disposition', _nice(c.disposition)], ['Disposition notes', c.disp_notes],
      ['Referred to', [c.ref_doctor, c.ref_hospital].filter(Boolean).join(', ')], ['Referral reason', c.ref_reason],
    ])),
  ].join('');

  document.getElementById('vh-panel-body').innerHTML = html ||
    '<div class="vh-empty">No clinical notes were recorded for this visit.</div>';
};

// Phase 2 -- tick medicines to copy into today's prescription, or repeat the whole list.
// Rows land as normal editable rows via doctor.js's window._copyRxFromHistory().
function _rxHtml(items) {
  if (!items.length) return '';
  return `<div class="vh-rx-list">${items.map((r, i) => `
    <label class="vh-rx-item">
      <input type="checkbox" class="vh-rx-chk" data-idx="${i}" data-onchange="vhRxSelChanged">
      <span><strong>${_esc(r.medicine_name)}</strong> ${_esc([r.dosage, r.frequency, r.timing].filter(Boolean).join(' · '))}${r.duration ? ' × ' + _esc(r.duration) : ''}${r.anupana ? ` <span class="vh-muted">with ${_esc(r.anupana)}</span>` : ''}</span>
    </label>`).join('')}</div>
    <div class="vh-rx-actions">
      <button type="button" class="vh-btn" id="vh-rx-copy-sel" data-onclick="vhCopyRx" data-onclick-a0="selected" disabled>Copy selected</button>
      <button type="button" class="vh-btn vh-btn-primary" data-onclick="vhCopyRx" data-onclick-a0="all">↻ Repeat all (${items.length})</button>
    </div>`;
}

window.vhRxSelChanged = function() {
  const n = document.querySelectorAll('#vh-panel-body .vh-rx-chk:checked').length;
  const btn = document.getElementById('vh-rx-copy-sel');
  if (!btn) return;
  btn.disabled = n === 0;
  btn.textContent = n ? `Copy selected (${n})` : 'Copy selected';
};

window.vhCopyRx = function(mode) {
  const picked = mode === 'all' ? _panelRx
    : [...document.querySelectorAll('#vh-panel-body .vh-rx-chk:checked')].map(el => _panelRx[Number(el.dataset.idx)]);
  if (!picked.length || typeof window._copyRxFromHistory !== 'function') return;
  window._copyRxFromHistory(picked.map(r => ({
    name: r.medicine_name, dose: r.dosage || '', freq: r.frequency || '',
    dur: r.duration || '', anupana: r.anupana || '', timing: r.timing || '',
  })));
  document.querySelectorAll('#vh-panel-body .vh-rx-chk:checked').forEach(el => { el.checked = false; });
  window.vhRxSelChanged();
};

function _labHtml(l) {
  const items = (l.lab_order_items || []).filter(i => i.result_value !== null && i.result_value !== '');
  const flag = i => i.is_critical ? '<span class="vh-flag crit">⚠ Critical</span>' : i.is_abnormal ? '<span class="vh-flag">⚠ Abnormal</span>' : '';
  return `<div class="vh-inv">
    <div class="vh-inv-hd"><strong>🧪 ${_esc(l.test_name)}</strong><span class="vh-muted">${_esc(_nice(l.status) || '')}</span></div>
    ${items.length ? `<table class="vh-res"><tbody>${items.map(i => `<tr>
      <td>${_esc(i.test_name)}</td><td><strong>${_esc(i.result_value)}</strong> ${_esc(i.result_unit || '')} ${flag(i)}</td>
      <td class="vh-muted">${_esc(i.reference_range || '')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="vh-muted">Report not available yet.</div>'}
  </div>`;
}

function _imgHtml(i) {
  return `<div class="vh-inv">
    <div class="vh-inv-hd"><strong>📡 ${_esc(i.study_name || i.modality)}</strong><span class="vh-muted">${_esc(_nice(i.status) || '')}</span></div>
    ${i.impression || i.findings ? _rows([['Findings', i.findings], ['Impression', i.impression]]) : '<div class="vh-muted">Report not available yet.</div>'}
  </div>`;
}

window.openVhAdmission = function(admId) {
  const entry = _entries.find(e => e.kind === 'adm' && e.id === admId);
  if (!entry) return;
  const a = entry.row;
  const out = a.discharged_at || a.clinically_discharged_at;
  _openPanel(admId, `🏥 ${a.is_day_care ? 'Day Care' : 'Admission'}: ${_fmtD(a.admission_date)} → ${out ? _fmtD(out) : 'current'}`,
    [a.departments?.name, a.admitting_doctor?.full_name].filter(Boolean).join(' · '));
  document.getElementById('vh-panel-body').innerHTML = [
    _sec('📋 Admission', _rows([['Status', _nice(a.status)], ['Diagnosis at admission', a.diagnosis_primary]])),
    _sec('🏁 Discharge summary', _rows([
      ['Ayurveda diagnosis', a.discharge_diagnosis_ayurveda], ['ICD-10', a.discharge_diagnosis_icd10],
      ['Condition at discharge', _nice(a.discharge_condition)], ['PK procedures', a.discharge_pk_procedures],
      ['Medicines', a.discharge_medications], ['Pathya / Apathya', a.discharge_pathya_apathya],
      ['Follow-up date', a.discharge_followup_date ? _fmtD(a.discharge_followup_date) : null],
      ['Disposition', _nice(a.disposition)], ['Notes', a.discharge_order_notes],
    ]) || (out ? '' : '<div class="vh-muted">Patient not yet discharged.</div>')),
  ].join('');
};
