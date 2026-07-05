import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const params   = new URLSearchParams(window.location.search);
const orderId  = params.get('order') || null;

// ── Reference ranges — age/sex specific ──────────────
const REF_RANGES = {
  'Haemoglobin':            { unit:'g/dL',  adult_m:[13.0,17.0], adult_f:[12.0,15.0], child:[11.0,16.0], crit_low:7.0,  crit_high:20.0 },
  'WBC Count':              { unit:'×10³/µL', adult_m:[4.0,11.0], adult_f:[4.0,11.0],  child:[5.0,15.0],  crit_low:2.0,  crit_high:30.0 },
  'Platelet Count':         { unit:'×10³/µL', adult_m:[150,400],  adult_f:[150,400],   child:[150,450],   crit_low:50,   crit_high:1000 },
  'RBC Count':              { unit:'×10⁶/µL', adult_m:[4.5,5.9],  adult_f:[4.0,5.2],   child:[3.8,5.8],   crit_low:2.0,  crit_high:7.0 },
  'Haematocrit (PCV)':      { unit:'%',    adult_m:[40,52],   adult_f:[36,48],     child:[35,50],     crit_low:20,   crit_high:60 },
  'MCV':                    { unit:'fL',   adult_m:[80,100],  adult_f:[80,100],    child:[70,90],     crit_low:50,   crit_high:130 },
  'MCH':                    { unit:'pg',   adult_m:[27,33],   adult_f:[27,33],     child:[22,32],     crit_low:15,   crit_high:45 },
  'MCHC':                   { unit:'g/dL', adult_m:[31.5,36], adult_f:[31.5,36],   child:[31,36],     crit_low:15,   crit_high:40 },
  'Blood Glucose (Fasting)':{ unit:'mg/dL', adult_m:[70,100], adult_f:[70,100],    child:[60,100],    crit_low:40,   crit_high:500 },
  'Blood Glucose (Random)': { unit:'mg/dL', adult_m:[70,140], adult_f:[70,140],    child:[70,140],    crit_low:40,   crit_high:500 },
  'HbA1c':                  { unit:'%',    adult_m:[4.0,5.6], adult_f:[4.0,5.6],   child:[4.0,5.6],   crit_low:null, crit_high:14 },
  'Serum Creatinine':       { unit:'mg/dL', adult_m:[0.7,1.3], adult_f:[0.5,1.0],  child:[0.3,0.7],   crit_low:null, crit_high:10 },
  'Serum Urea':             { unit:'mg/dL', adult_m:[15,40],   adult_f:[15,40],    child:[10,35],     crit_low:null, crit_high:200 },
  'Serum Uric Acid':        { unit:'mg/dL', adult_m:[3.5,7.2], adult_f:[2.5,6.0],  child:[2.0,5.5],   crit_low:null, crit_high:13 },
  'SGOT (AST)':             { unit:'U/L',  adult_m:[10,40],   adult_f:[10,35],    child:[10,45],     crit_low:null, crit_high:1000 },
  'SGPT (ALT)':             { unit:'U/L',  adult_m:[7,45],    adult_f:[7,35],     child:[7,45],      crit_low:null, crit_high:1000 },
  'Total Bilirubin':        { unit:'mg/dL', adult_m:[0.2,1.2], adult_f:[0.2,1.2],  child:[0.1,1.0],   crit_low:null, crit_high:15 },
  'Serum Albumin':          { unit:'g/dL', adult_m:[3.5,5.0], adult_f:[3.5,5.0],  child:[3.5,5.0],   crit_low:1.5,  crit_high:null },
  'Total Protein':          { unit:'g/dL', adult_m:[6.0,8.3], adult_f:[6.0,8.3],  child:[5.5,8.0],   crit_low:null, crit_high:null },
  'Serum Sodium':           { unit:'mEq/L', adult_m:[136,145], adult_f:[136,145],  child:[135,145],   crit_low:120,  crit_high:160 },
  'Serum Potassium':        { unit:'mEq/L', adult_m:[3.5,5.1], adult_f:[3.5,5.1],  child:[3.5,5.5],   crit_low:2.5,  crit_high:6.5 },
  'Serum Chloride':         { unit:'mEq/L', adult_m:[98,107],  adult_f:[98,107],   child:[95,110],    crit_low:80,   crit_high:120 },
  'Total Cholesterol':      { unit:'mg/dL', adult_m:[0,200],   adult_f:[0,200],    child:[0,170],     crit_low:null, crit_high:null },
  'HDL Cholesterol':        { unit:'mg/dL', adult_m:[40,60],   adult_f:[50,70],    child:[35,65],     crit_low:null, crit_high:null },
  'LDL Cholesterol':        { unit:'mg/dL', adult_m:[0,100],   adult_f:[0,100],    child:[0,110],     crit_low:null, crit_high:null },
  'Triglycerides':          { unit:'mg/dL', adult_m:[0,150],   adult_f:[0,150],    child:[0,130],     crit_low:null, crit_high:null },
  'Prothrombin Time':       { unit:'sec',  adult_m:[11,14],   adult_f:[11,14],    child:[11,15],     crit_low:null, crit_high:30 },
  'APTT':                   { unit:'sec',  adult_m:[25,35],   adult_f:[25,35],    child:[24,36],     crit_low:null, crit_high:100 },
  'Serum Calcium':          { unit:'mg/dL', adult_m:[8.5,10.5],adult_f:[8.5,10.5],child:[8.5,10.5],  crit_low:6.5,  crit_high:13 },
  'TSH':                    { unit:'µIU/mL',adult_m:[0.4,4.0], adult_f:[0.4,4.0], child:[0.7,5.7],   crit_low:null, crit_high:100 },
  'Free T4':                { unit:'ng/dL', adult_m:[0.8,1.8], adult_f:[0.8,1.8], child:[0.8,2.0],   crit_low:null, crit_high:null },
  'CRP (Quantitative)':     { unit:'mg/L',  adult_m:[0,5],     adult_f:[0,5],      child:[0,5],       crit_low:null, crit_high:200 },
  'ESR':                    { unit:'mm/hr', adult_m:[0,15],    adult_f:[0,20],     child:[0,13],      crit_low:null, crit_high:null },
};

function _getRef(testName, age, gender) {
  const ref = REF_RANGES[testName];
  if (!ref) return null;
  const isChild  = age && age < 13;
  const isMale   = gender?.toLowerCase() === 'male' || gender?.toLowerCase() === 'm';
  const range = isChild ? ref.child : (isMale ? ref.adult_m : ref.adult_f);
  return { low: range[0], high: range[1], unit: ref.unit, crit_low: ref.crit_low, crit_high: ref.crit_high };
}

function _flagResult(value, ref) {
  if (!ref || value === null || value === undefined || value === '') return { flag: '', cls: '' };
  const v = parseFloat(value);
  if (isNaN(v)) return { flag: '', cls: '' };
  if (ref.crit_low  !== null && v < ref.crit_low)  return { flag: '▼▼ CRITICAL LOW',  cls: 'flag-crit' };
  if (ref.crit_high !== null && v > ref.crit_high) return { flag: '▲▲ CRITICAL HIGH', cls: 'flag-crit' };
  if (v < ref.low)  return { flag: '▼ Low',  cls: 'flag-low' };
  if (v > ref.high) return { flag: '▲ High', cls: 'flag-high' };
  return { flag: 'N', cls: '' };
}

async function loadReport() {
  if (!orderId) {
    document.getElementById('report-content').innerHTML = '<div style="color:#c0392b;padding:40px;text-align:center">No order ID specified. Use ?order=ORDER_UUID</div>';
    return;
  }

  // Load the lab order with items, patient, doctor, tenant
  const { data: order, error: oErr } = await supabase
    .from('lab_orders')
    .select(`
      id, created_at, collected_at, authorised_at, authorised_by,
      status, clinical_notes,
      visits(patients(id, name, age, gender, phone, abha_number)),
      ordering_doctor:profiles!ordered_by(full_name),
      authorising_doctor:profiles!authorised_by(full_name),
      lab_order_items(
        id, test_name, test_category, result_value, result_unit,
        is_critical, is_abnormal, reference_range,
        authorisation_status, previous_result, previous_result_date
      )
    `)
    .eq('id', orderId)
    .single();

  if (oErr || !order) {
    document.getElementById('report-content').innerHTML = `<div style="color:#c0392b;padding:40px;text-align:center">Report not found.<br>${_esc(oErr?.message)}</div>`;
    return;
  }

  // Load tenant info
  const tenantRaw = sessionStorage.getItem('ayurxpert_tenant');
  const tenant    = tenantRaw ? JSON.parse(tenantRaw) : {};

  const pat  = order.visits?.patients || {};
  const doc  = order.ordering_doctor || {};
  const items = order.lab_order_items || [];
  const reportId = `LAB-${order.id.slice(0,8).toUpperCase()}`;

  // Group items by category
  const categories = {};
  items.forEach(item => {
    const cat = item.test_category || 'Other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(item);
  });

  // Build results HTML
  const catLabels = {
    haematology: 'Haematology',
    biochemistry: 'Biochemistry / Clinical Chemistry',
    coagulation: 'Coagulation Studies',
    serology: 'Serology / Immunology',
    hormones: 'Hormones / Endocrinology',
    microbiology: 'Microbiology / Culture',
    urine_analysis: 'Urine Analysis',
    other: 'Other Tests',
  };

  let resultsHTML = '';
  Object.entries(categories).forEach(([cat, catItems]) => {
    const label = catLabels[cat] || cat.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
    resultsHTML += `<div class="section-header">${_esc(label)}</div>
    <table>
      <thead><tr>
        <th style="min-width:180px">Test Name</th>
        <th style="width:110px;text-align:right">Result</th>
        <th style="width:70px">Unit</th>
        <th style="width:70px;text-align:center">Flag</th>
        <th style="min-width:160px">Reference Range</th>
        <th style="min-width:100px">Auth Status</th>
      </tr></thead>
      <tbody>
        ${catItems.map(item => {
          const ref  = _getRef(item.test_name, pat.age, pat.gender);
          const flag = _flagResult(item.result_value, ref);
          const refRange = ref ? `${ref.low} – ${ref.high}` : (item.reference_range || '—');
          const isCrit   = flag.cls === 'flag-crit' || item.is_critical;
          const valClass = isCrit ? 'result-critical' : (item.is_abnormal || flag.flag.includes('Low')||flag.flag.includes('High')) ? 'result-abnormal' : 'result-normal';
          const authBadge= item.authorisation_status === 'pathologist_signed'
            ? '<span style="font-size:10px;color:#2d7a4f;font-weight:600">✓ Authorised</span>'
            : '<span style="font-size:10px;color:#c9902a">Pending</span>';
          return `<tr style="${isCrit ? 'background:#fff8f8' : ''}">
            <td style="font-weight:500">${_esc(item.test_name)}</td>
            <td style="text-align:right;font-size:14px;font-weight:700" class="${valClass}">${item.result_value ? _esc(item.result_value) : '<span class="no-result">Pending</span>'}</td>
            <td style="font-size:11px;color:#4a6352">${_esc(item.result_unit||ref?.unit||'')}</td>
            <td style="text-align:center" class="${flag.cls}">${_esc(flag.flag)||'—'}</td>
            <td class="ref-range">${_esc(refRange)}</td>
            <td>${authBadge}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  });

  const hasCritical = items.some(i => i.is_critical || _flagResult(i.result_value, _getRef(i.test_name, pat.age, pat.gender)).cls === 'flag-crit');

  const collectedAt = order.collected_at
    ? new Date(order.collected_at).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})
    : new Date(order.created_at).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const reportedAt  = new Date().toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});

  const authProfile = order.authorising_doctor;

  document.getElementById('report-content').innerHTML = `
    <!-- NABL Header -->
    <div class="rpt-header">
      <div class="rpt-org">
        <div class="rpt-org-name">${_esc(tenant.name || 'AyurXpert Laboratory')}</div>
        <div class="rpt-org-sub">
          Department of Clinical Pathology &amp; Laboratory Medicine<br/>
          NABL Accredited Medical Testing Laboratory — ISO 15189
        </div>
      </div>
      <div class="nabl-block">
        <div class="nabl-cert-box">
          <div><input class="nabl-cert-input" id="nabl-cert-input" value="MC-XXXX" placeholder="MC-XXXX" title="Enter NABL certificate number"/></div>
          <div class="nabl-label">NABL Certificate No.</div>
        </div>
      </div>
    </div>

    <!-- Report title + ID -->
    <div class="rpt-title-strip">
      <span class="rpt-title">LABORATORY REPORT${hasCritical ? ' ⚠ CRITICAL VALUES PRESENT' : ''}</span>
      <span class="rpt-barcode">${reportId}</span>
    </div>

    ${hasCritical ? `
    <div style="background:#c0392b;color:#fff;padding:6px 24px;font-size:12px;font-weight:600">
      ⚠ CRITICAL VALUE(S) DETECTED — Treating clinician has been notified. Immediate action required.
    </div>` : ''}

    <!-- Patient + specimen info -->
    <div class="rpt-info">
      <div class="rpt-info-block">
        <div class="info-row"><span class="info-lbl">Patient Name:</span><span class="info-val">${_esc(pat.name)||'—'}</span></div>
        <div class="info-row"><span class="info-lbl">Age / Sex:</span><span class="info-val">${_esc(pat.age)||'—'}y / ${_esc(pat.gender)||'—'}</span></div>
        <div class="info-row"><span class="info-lbl">Phone:</span><span class="info-val">${_esc(pat.phone)||'—'}</span></div>
        <div class="info-row"><span class="info-lbl">ABHA No.:</span><span class="info-val">${_esc(pat.abha_number)||'—'}</span></div>
        <div class="info-row"><span class="info-lbl">Referred By:</span><span class="info-val">${doc?.full_name ? 'Dr. '+_esc(doc.full_name) : '—'}</span></div>
      </div>
      <div class="rpt-info-block">
        <div class="info-row"><span class="info-lbl">Report ID:</span><span class="info-val">${reportId}</span></div>
        <div class="info-row"><span class="info-lbl">Collected:</span><span class="info-val">${collectedAt}</span></div>
        <div class="info-row"><span class="info-lbl">Reported:</span><span class="info-val">${reportedAt}</span></div>
        <div class="info-row"><span class="info-lbl">Clinical Notes:</span><span class="info-val" style="font-size:11px">${_esc(order.clinical_notes)||'—'}</span></div>
      </div>
    </div>

    <!-- Results -->
    <div class="results-section">${resultsHTML}</div>

    <!-- Authorization -->
    <div class="auth-strip">
      <div class="auth-block">
        <div class="auth-sig-line"></div>
        <input class="auth-editable" value="${authProfile?.full_name ? 'Dr. '+_esc(authProfile.full_name) : ''}" placeholder="Pathologist Name"/>
        <div class="auth-desig">MD (Pathology) / MD (Microbiology)</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px">Reporting Pathologist</div>
      </div>
      <div class="auth-block">
        <div class="auth-sig-line"></div>
        <input class="auth-editable" value="" placeholder="Lab In-charge Name"/>
        <div class="auth-desig">NABL Authorised Signatory</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px">Technical Supervisor</div>
      </div>
      <div class="auth-block">
        <div class="auth-sig-line"></div>
        <div class="auth-name">Date &amp; Time</div>
        <div class="auth-desig">${reportedAt}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px">Report Generated</div>
      </div>
    </div>

    <!-- Footer disclaimer -->
    <div class="rpt-footer">
      <strong>Reference ranges are population-based guidelines; clinical correlation is advised.</strong>
      This report is valid only when printed on official letterhead and countersigned by the Reporting Pathologist.
      Critical values have been telephonically communicated to the requesting clinician.
      For queries, contact: lab@${_esc((tenant.name||'clinic').toLowerCase().replace(/\s/g,''))}.in |
      NABL Cert. No.: <span id="footer-nabl-cert">MC-XXXX</span>
      <br/>Flags: N = Normal · ▲ High · ▼ Low · ▲▲ Critical High · ▼▼ Critical Low
    </div>`;

  // Sync NABL cert number to footer
  document.getElementById('nabl-cert-input').addEventListener('input', function() {
    const el = document.getElementById('footer-nabl-cert');
    if (el) el.textContent = this.value || 'MC-XXXX';
  });
}

loadReport();
