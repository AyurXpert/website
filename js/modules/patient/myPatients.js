// "My Patients" tab (Part 1, read-only) — doctor.html's queue panel, 6th tab.
// Plan agreed with Dr. Venkatesh: a date-scoped, paginated list of the logged-in doctor's
// own finalized consultations, newest first; clicking one opens a fully read-only detail
// (note, diagnosis, prescription incl. prescriber snapshot, investigations incl. fee/status
// and a View report link, pharmacy dispense status, admission/day-care status, Panchakarma
// status). No edit buttons, no new write paths, no schema changes.
//
// "Consulted by me" = consultation_notes.doctor_id = me (I wrote it) OR finalized_by = me
// (I countersigned a trainee's draft), review_status='finalized', is_deleted=false. A
// countersigned draft can match on BOTH sides at once for the same visit (the trainee's
// original draft row is updated in place to finalized/finalized_by=me, AND a second, fresh
// row is inserted with doctor_id=me for the same visit — see completeConsultation() in
// doctor.js) — deduped below by visit_id, keeping the newest created_at (mirrors the exact
// same pick visitTimeline.js's openVhVisit() already makes for the same reason).
//
// "Today"/date-range filtering uses the Asia/Kolkata calendar day (istDayRangeUTC), not the
// browser's local timezone and not UTC — a doctor's OS clock isn't guaranteed to be IST.
//
// Non-PK OPD procedures (Agnikarma, Kshara karma, Jalaukavacharana, etc.) have no tracking
// table at all today — shown as "Not tracked yet", not "Not advised" (TODO_LATER.md §79).
// Imaging has no payment_status column (TODO_LATER.md §80) — shown as "Billing not tracked".

import { todayISTStr, istDayRangeUTC } from '../../utils/dateUtils.js';

let _sb = null, _esc = s => String(s ?? '');
let _tenantId = null, _userId = null;
let _pageRows = [];       // current page's list rows, cached for detail lookup by visit_id
let _page = 0;
let _hasNext = false;
let _filterFrom = todayISTStr();
let _filterTo   = todayISTStr();
let _listToken  = 0;
let _detailToken = 0;
const _PAGE_SIZE = 25;
const _MAX_RANGE_DAYS = 186; // ~6 months

const _fmtD = d => d ? new Date(d.length === 10 ? d + 'T00:00:00' : d)
  .toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const _fmtDT = d => d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const _okReview = r => !r || r === 'finalized';
const _NICE = {
  pending: 'Pending', converted: 'Converted (Admitted)', declined: 'Declined', expired: 'Expired',
  sample_collected: 'Sample Collected', in_progress: 'In Progress', completed: 'Completed', ordered: 'Ordered',
  paid: 'Fee Paid', waived: 'Fee Waived', ipd_credit: 'IPD Credit', day_care: 'Day Care',
  opd: 'OPD', admission: 'Admission', draft: 'Draft', finalized: 'Finalized', active: 'Active', cancelled: 'Cancelled',
};
const _nice = s => !s ? s : (_NICE[s] || String(s).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()));

export function resetMyPatients() {
  _listToken++; _detailToken++;
  _pageRows = [];
}

export function loadMyPatients({ supabase, esc, tenantId, userId }) {
  _sb = supabase; _esc = esc; _tenantId = tenantId; _userId = userId;
  _filterFrom = todayISTStr(); _filterTo = todayISTStr(); _page = 0;
  _fetchAndRenderList();
}

async function _fetchAndRenderList() {
  const list = document.getElementById('q-list');
  if (!list) return;
  const token = ++_listToken;
  list.innerHTML = _filterBarHtml() + '<div class="q-empty"><div class="q-empty-icon">⏳</div>Loading…</div>';

  const { startUTC } = istDayRangeUTC(_filterFrom);
  const { endUTC }   = istDayRangeUTC(_filterTo);

  const { data, error } = await _sb.from('consultation_notes')
    .select(`id, visit_id, doctor_id, drafted_by, finalized_by, created_at,
      ayurveda_diagnosis, modern_diagnosis, diagnosis_namc_label, diagnosis_icd10_label,
      visits(id, patient_id, chief_complaint, is_deleted, patients(id, name, phone, age, gender))`)
    .eq('tenant_id', _tenantId)
    .eq('review_status', 'finalized')
    .eq('is_deleted', false)
    .or(`doctor_id.eq.${_userId},finalized_by.eq.${_userId}`)
    .gte('created_at', startUTC)
    .lt('created_at', endUTC)
    .order('created_at', { ascending: false })
    .range(_page * _PAGE_SIZE, _page * _PAGE_SIZE + _PAGE_SIZE - 1);

  if (token !== _listToken) return;
  if (error) {
    list.innerHTML = _filterBarHtml() + `<div class="q-empty" style="color:#e74c3c;font-size:12px">Couldn't load: ${_esc(error.message)}</div>`;
    return;
  }

  _hasNext = (data || []).length === _PAGE_SIZE;

  const seen = new Set();
  _pageRows = (data || []).filter(r => {
    if (!r.visits || r.visits.is_deleted) return false;
    if (seen.has(r.visit_id)) return false;
    seen.add(r.visit_id);
    return true;
  });

  const countEl = document.getElementById('q-count');
  if (countEl) countEl.textContent = _pageRows.length;

  if (!_pageRows.length) {
    list.innerHTML = _filterBarHtml() + `<div class="q-empty"><div class="q-empty-icon">👥</div>No consultations in this range.</div>`;
    return;
  }
  list.innerHTML = _filterBarHtml() + _pageRows.map(_cardHtml).join('') + _pagerHtml();
}

function _filterBarHtml() {
  return `<div style="padding:8px 10px;border-bottom:1px solid var(--border);background:#fafcfa">
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="date" id="mp-from" value="${_filterFrom}" max="${todayISTStr()}" aria-label="From date"
        style="font-size:11px;padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-family:inherit">
      <span style="font-size:11px;color:#888">to</span>
      <input type="date" id="mp-to" value="${_filterTo}" max="${todayISTStr()}" aria-label="To date"
        style="font-size:11px;padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-family:inherit">
      <button type="button" data-onclick="myPatientsSearch" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid var(--green-mid);background:var(--green-light);color:var(--green-deep);font-weight:600;cursor:pointer;font-family:inherit">Search</button>
      <button type="button" data-onclick="myPatientsToday" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #ddd;background:#fff;color:#666;cursor:pointer;font-family:inherit">Today</button>
    </div>
  </div>`;
}

function _pagerHtml() {
  if (_page === 0 && !_hasNext) return '';
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 4px">
    <button type="button" data-onclick="myPatientsPage" data-onclick-a0="prev" ${_page === 0 ? 'disabled' : ''}
      style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #ddd;background:#fff;color:${_page === 0 ? '#ccc' : '#666'};cursor:${_page === 0 ? 'default' : 'pointer'};font-family:inherit">◀ Prev</button>
    <span style="font-size:11px;color:#888">Page ${_page + 1}</span>
    <button type="button" data-onclick="myPatientsPage" data-onclick-a0="next" ${!_hasNext ? 'disabled' : ''}
      style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #ddd;background:#fff;color:${!_hasNext ? '#ccc' : '#666'};cursor:${!_hasNext ? 'default' : 'pointer'};font-family:inherit">Next ▶</button>
  </div>`;
}

function _cardHtml(r) {
  const p = r.visits.patients || {};
  const time = new Date(r.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const date = new Date(r.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
  const ageGender = [p.age ? `${p.age}y` : null, p.gender ? String(p.gender)[0].toUpperCase() : null].filter(Boolean).join('/');
  const dx = r.diagnosis_namc_label || r.ayurveda_diagnosis || r.diagnosis_icd10_label || r.modern_diagnosis || r.visits.chief_complaint || '—';
  return `<div class="q-card" data-onclick="openMyPatientVisit" data-onclick-a0="${_esc(r.visit_id)}">
    <div class="q-card-top">
      <div class="q-token" style="background:#f3f4f6;color:#4b5563;font-size:9px;font-weight:700;min-width:36px">${_esc(time)}</div>
      <div class="q-name">${_esc(p.name || '—')}</div>
      <div class="q-wait" style="color:#888">${_esc(date)}</div>
    </div>
    ${ageGender ? `<div class="q-meta"><span class="badge" style="background:#f3f4f6;color:#6b7280">${_esc(ageGender)}</span></div>` : ''}
    <div class="q-complaint">${_esc(dx)}</div>
  </div>`;
}

window.myPatientsSearch = function() {
  const fromEl = document.getElementById('mp-from');
  const toEl   = document.getElementById('mp-to');
  if (!fromEl || !toEl) return;
  let from = fromEl.value, to = toEl.value;
  if (!from || !to) { alert('Pick both a from and to date.'); return; }
  if (from > to) [from, to] = [to, from];
  const days = Math.round((new Date(to) - new Date(from)) / 86400000);
  if (days > _MAX_RANGE_DAYS) {
    from = new Date(new Date(to).getTime() - _MAX_RANGE_DAYS * 86400000).toISOString().slice(0, 10);
    alert('Date range is limited to 6 months — showing the most recent 6 months up to your chosen "to" date.');
  }
  _filterFrom = from; _filterTo = to; _page = 0;
  _fetchAndRenderList();
};

window.myPatientsToday = function() {
  _filterFrom = todayISTStr(); _filterTo = todayISTStr(); _page = 0;
  _fetchAndRenderList();
};

window.myPatientsPage = function(dir) {
  if (dir === 'prev' && _page > 0) _page--;
  else if (dir === 'next' && _hasNext) _page++;
  else return;
  _fetchAndRenderList();
};

// ── Read-only detail (rendered into doctor.html's #c-history, same container
// openPatientHistory() uses — "← Back" reuses the existing _closeHistoryToWelcome()). ──
window.openMyPatientVisit = async function(visitId) {
  const row = _pageRows.find(r => r.visit_id === visitId);
  if (!row) return;
  if (typeof window.closeIpdRound === 'function') window.closeIpdRound();

  const histEl    = document.getElementById('c-history');
  const welcomeEl = document.getElementById('welcome');
  const activeEl  = document.getElementById('c-active');
  if (!histEl || !welcomeEl || !activeEl) return;
  welcomeEl.style.display = 'none';
  activeEl.style.display  = 'none';
  histEl.style.display    = '';

  const token = ++_detailToken;
  const p = row.visits.patients || {};
  const header = `<div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
      <button data-onclick="_closeHistoryToWelcome" style="background:none;border:1.5px solid var(--border);border-radius:8px;padding:6px 14px;cursor:pointer;font-size:13px;font-family:'DM Sans',sans-serif;color:var(--text-main)">← Back</button>
      <div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--green-deep)">${_esc(p.name || 'Patient')}</div>
        <div style="font-size:12px;color:#888">${_esc(_fmtDT(row.created_at))}${p.phone ? ' · ' + _esc(p.phone) : ''}</div>
      </div>
    </div>`;
  histEl.innerHTML = header + '<div class="vh-loading">Loading…</div>';

  const [cnR, rxR, labR, imgR, pkR, advR, admR] = await Promise.all([
    _sb.from('consultation_notes').select('*').eq('visit_id', visitId).order('created_at', { ascending: false }),
    _sb.from('prescriptions').select('id, review_status, is_deleted, status, prescriber_display_name, prescriber_registration_number, prepared_by_name, prescription_items(medicine_name, dosage, frequency, duration, anupana, timing)').eq('visit_id', visitId).order('created_at', { ascending: false }),
    _sb.from('lab_orders').select('id, test_name, status, payment_status, review_status, performed_outside, outside_lab_name, outside_report_date, outside_report_path, lab_order_items(test_name, result_value, result_unit, reference_range, is_abnormal, is_critical)').eq('visit_id', visitId),
    _sb.from('imaging_orders').select('study_name, modality, status, findings, impression, is_outside_referral, outside_centre_name, outside_report_path, outside_entered_at, performed_date').eq('visit_id', visitId),
    _sb.from('pk_care_plans').select('status, setting, pk_care_plan_protocols(protocol_label, start_date)').eq('visit_id', visitId),
    _sb.from('admission_advice').select('status, clinical_indication').eq('visit_id', visitId).order('created_at', { ascending: false }),
    _sb.from('ipd_admissions').select('status, is_day_care, admission_date').eq('visit_id', visitId),
  ]);
  if (token !== _detailToken) return;

  const cn = (cnR.data || []).find(n => !n.is_deleted && _okReview(n.review_status)) || {};
  const rxRows = (rxR.data || []).filter(r => !r.is_deleted && _okReview(r.review_status));
  const labs = (labR.data || []).filter(l => _okReview(l.review_status));
  const imgs = imgR.data || [];
  const pks  = pkR.data || [];
  const adv  = (advR.data || [])[0] || null;
  const adm  = (admR.data || [])[0] || null;

  const body = [
    _sec('📝 Consultation Note', _rows([
      ['Chief complaint', row.visits.chief_complaint],
      ['Ayurveda diagnosis', cn.ayurveda_diagnosis], ['Modern diagnosis', cn.modern_diagnosis],
      ['NAMASTE', cn.diagnosis_namc_label ? `${cn.diagnosis_namc_label}${cn.diagnosis_namc_code ? ' (' + cn.diagnosis_namc_code + ')' : ''}` : null],
      ['ICD-10', cn.diagnosis_icd10_label ? `${cn.diagnosis_icd10_label}${cn.diagnosis_icd10_code ? ' (' + cn.diagnosis_icd10_code + ')' : ''}` : null],
      ['Clinical notes', cn.clinical_notes], ['Pathya', cn.pathya], ['Apathya', cn.apathya],
      ['Follow-up date', cn.followup_date ? _fmtD(cn.followup_date) : null], ['Disposition', _nice(cn.disposition)],
    ])),
    _sec('💊 Prescription', _rxHtml(rxRows) + (cn.rx_instructions ? _rows([['Instructions', cn.rx_instructions]]) : '')),
    _pharmacySection(rxRows),
    _sec('🔬 Investigations', (!labs.length && !imgs.length) ? '<div class="vh-muted">Not advised.</div>' : labs.map(_labHtml).join('') + imgs.map(_imgHtml).join('')),
    _admissionSection(adv, adm),
    _pkSection(pks),
  ].join('');

  histEl.innerHTML = header + `<div style="font-size:13px">${body}</div>`;
};

const _sec  = (title, body) => body ? `<div class="vh-sec"><h4>${title}</h4>${body}</div>` : '';
const _rows = pairs => pairs.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
  .map(([k, v]) => `<div class="vh-row"><span class="vh-k">${k}</span><span class="vh-v">${_esc(v)}</span></div>`).join('');

function _rxHtml(rxRows) {
  if (!rxRows.length) return '<div class="vh-muted">Not advised — no medicines prescribed.</div>';
  const rx = rxRows[0];
  const items = rx.prescription_items || [];
  const itemsHtml = items.length ? items.map(r => `<div style="padding:5px 0;border-bottom:1px solid #f0ede5;font-size:13px">
      <strong>${_esc(r.medicine_name)}</strong>
      <span style="color:#666;margin-left:8px">${_esc([r.dosage, r.frequency, r.timing].filter(Boolean).join(' · '))}${r.duration ? ' × ' + _esc(r.duration) : ''}</span>
      ${r.anupana ? `<span style="color:#888;margin-left:6px">with ${_esc(r.anupana)}</span>` : ''}
    </div>`).join('') : '<div class="vh-muted">No items recorded.</div>';
  const presc = rx.prescriber_display_name || rx.prepared_by_name;
  const prescLine = presc ? `<div class="vh-muted" style="margin-top:6px">Prescribed by ${_esc(presc)}${rx.prescriber_registration_number ? ' · Reg. ' + _esc(rx.prescriber_registration_number) : ''}${rx.prepared_by_name && rx.prepared_by_name !== presc ? ` (originally drafted by ${_esc(rx.prepared_by_name)})` : ''}</div>` : '';
  // Session 338: reprint -- the server marks it Original / DUPLICATE COPY No. N
  const reprint = rx.review_status === 'finalized' && !rx.is_deleted
    ? `<div style="margin-top:8px"><button type="button" class="vh-link" data-onclick="reprintPrescription" data-onclick-a0="${_esc(rx.id)}" style="min-height:44px">🖨 Reprint prescription</button></div>`
    : '';
  return itemsHtml + prescLine + reprint;
}

// Opened straight from the click (a window.open after an await is blocked as a pop-up). Shared with doctor.js's
// patient history. The print page records the print and decides Original / Duplicate.
window.reprintPrescription = function(rxId) {
  if (!rxId) return;
  window.open(`printPrescription.html?rxId=${encodeURIComponent(rxId)}`, '_blank');
};

function _pharmacySection(rxRows) {
  if (!rxRows.length) return _sec('🏪 Pharmacy', '<div class="vh-muted">Not advised — no medicines prescribed.</div>');
  const dispensed = rxRows[0].status === 'dispensed';
  return _sec('🏪 Pharmacy', `<span class="badge" style="background:${dispensed ? '#e8f5ee' : '#fff4e5'};color:${dispensed ? '#1a7a3a' : '#7a4a00'}">${dispensed ? 'Dispensed' : 'Not yet dispensed'}</span>`);
}

function _labHtml(l) {
  const items = (l.lab_order_items || []).filter(i => i.result_value !== null && i.result_value !== '');
  const flag = i => i.is_critical ? '<span class="vh-flag crit">⚠ Critical</span>' : i.is_abnormal ? '<span class="vh-flag">⚠ Abnormal</span>' : '';
  const payColor = l.payment_status === 'paid' ? '#1a7a3a' : l.payment_status === 'waived' || l.payment_status === 'ipd_credit' ? '#6b7280' : '#c0392b';
  const payBg    = l.payment_status === 'paid' ? '#e8f5ee' : l.payment_status === 'waived' || l.payment_status === 'ipd_credit' ? '#f3f4f6' : '#fff0ee';
  return `<div class="vh-inv">
    <div class="vh-inv-hd"><strong>🧪 ${_esc(l.test_name || (l.lab_order_items || []).map(i => i.test_name).slice(0, 3).join(', ') || 'Lab test')}</strong>
      <span><span class="badge" style="background:${payBg};color:${payColor}">${_esc(_nice(l.payment_status) || 'Fee: —')}</span> <span class="vh-muted">${l.performed_outside ? '🔗 Outside lab' : _esc(_nice(l.status) || '')}</span></span></div>
    ${l.performed_outside ? `<div class="vh-muted" style="margin-bottom:4px">🔗 ${_esc(l.outside_lab_name || 'Outside lab')}${l.outside_report_date ? ', ' + _fmtD(l.outside_report_date) : ''}${l.outside_report_path ? ` · <button type="button" class="vh-link" data-onclick="openLabReportFile" data-onclick-a0="${_esc(l.outside_report_path)}">📄 View report</button>` : ''}</div>` : ''}
    ${items.length ? `<table class="vh-res"><tbody>${items.map(i => `<tr>
      <td>${_esc(i.test_name)}</td><td><strong>${_esc(i.result_value)}</strong> ${_esc(i.result_unit || '')} ${flag(i)}</td>
      <td class="vh-muted">${_esc(i.reference_range || '')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="vh-muted">Report not available yet.</div>'}
  </div>`;
}

function _imgHtml(i) {
  return `<div class="vh-inv">
    <div class="vh-inv-hd"><strong>📡 ${_esc(i.study_name || i.modality)}</strong><span class="vh-muted">${(i.outside_entered_at || i.is_outside_referral) ? '🔗 Outside centre' : _esc(_nice(i.status) || '')}</span></div>
    <div class="vh-muted" style="margin-bottom:4px">Billing not tracked for imaging yet</div>
    ${(i.outside_entered_at || i.is_outside_referral) && i.outside_centre_name ? `<div class="vh-muted" style="margin-bottom:4px">🔗 ${_esc(i.outside_centre_name)}${i.performed_date ? ', ' + _fmtD(i.performed_date) : ''}${i.outside_report_path ? ` · <button type="button" class="vh-link" data-onclick="openLabReportFile" data-onclick-a0="${_esc(i.outside_report_path)}">📄 View report</button>` : ''}</div>` : ''}
    ${i.impression || i.findings ? _rows([['Findings', i.findings], ['Impression', i.impression]]) : '<div class="vh-muted">Report not available yet.</div>'}
  </div>`;
}

function _admissionSection(adv, adm) {
  if (adm) {
    return _sec('🏥 Admission', _rows([
      ['Status', `${adm.is_day_care ? 'Day Care' : 'Admitted'} · ${_nice(adm.status)}`],
      ['Admission date', adm.admission_date ? _fmtD(adm.admission_date) : null],
    ]));
  }
  if (adv) return _sec('🏥 Admission', _rows([['Status', _nice(adv.status)], ['Indication', adv.clinical_indication]]));
  return _sec('🏥 Admission', '<div class="vh-muted">Not advised.</div>');
}

function _pkSection(pks) {
  const pkBody = pks.length ? pks.map(p => `<div class="vh-pk">
      ${(p.pk_care_plan_protocols || []).map(pr => `<div><strong>${_esc(pr.protocol_label)}</strong>${pr.start_date ? ` <span class="vh-muted">from ${_fmtD(pr.start_date)}</span>` : ''}</div>`).join('')}
      <div class="vh-muted">${_esc([_nice(p.setting), _nice(p.status)].filter(Boolean).join(' · '))}</div>
    </div>`).join('') : '<div class="vh-muted">Not advised.</div>';
  return _sec('🌸 Panchakarma', pkBody) +
    _sec('🩹 Other OPD Procedures', '<div class="vh-muted">Not tracked yet (e.g. Agnikarma, Kshara karma, Jalaukavacharana).</div>');
}
