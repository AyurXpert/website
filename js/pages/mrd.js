import { supabase } from '../core/db/supabaseClient.js';
import { requireAuth, hasModule, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

const ALLOWED = ['super_admin','dept_admin','mrd_staff'];
await requireAuth(ALLOWED);
if (!hasModule('mrd')) { window.location.replace('admin.html'); }

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

initNavbar();
wireDelegatedEvents();

// ── State ────────────────────────────────────────────────
let _ipdData = [];
let _diagData = [];
let _searchTimer;

// ── Tab switch ────────────────────────────────────────────
window.switchTab = function(id) {
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', ['records','stats','diagnosis','ipd','audit'][i] === id));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === 'tab-' + id));
};

// ── KPIs ──────────────────────────────────────────────────
async function loadKPIs() {
  const thisMonth = new Date().toISOString().slice(0,7);
  const [
    { count: patCount },
    { count: visCount },
    { count: newCount },
    { count: ipdCount },
    { count: codedCount },
  ] = await Promise.all([
    supabase.from('patients').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId),
    supabase.from('visits').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId),
    supabase.from('patients').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('created_at',thisMonth+'-01'),
    supabase.from('ipd_admissions').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId),
    supabase.from('consultation_notes').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).not('diagnosis_namc_code','is',null),
  ]);
  document.getElementById('k-patients').textContent = patCount || 0;
  document.getElementById('k-visits').textContent   = visCount || 0;
  document.getElementById('k-visits-sub').textContent = 'all time';
  document.getElementById('k-new').textContent      = newCount || 0;
  document.getElementById('k-ipd').textContent      = ipdCount || 0;
  document.getElementById('k-coded').textContent    = codedCount || 0;
}

// ── Patient Records — search ──────────────────────────────
window.searchPatients = function() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(_doPatientSearch, 300);
};

async function _doPatientSearch() {
  const q = document.getElementById('rec-search').value.trim();
  const resultsEl = document.getElementById('rec-results');
  const fileEl    = document.getElementById('rec-file');
  fileEl.style.display = 'none';
  if (q.length < 3) { resultsEl.innerHTML = ''; return; }

  const isPhone = /^\d{7,}$/.test(q);
  const isUHID  = q.toUpperCase().startsWith('AYX');

  let query = supabase.from('patients')
    .select('id,name,phone,age,gender,date_of_birth,blood_group,prakriti_data,prakriti_assessed_at,created_at')
    .eq('tenant_id', tenantId);

  if (isPhone)     query = query.eq('phone', q);
  else if (isUHID) query = query.ilike('id', '%' + q.replace(/^AYX-?/i,'').toLowerCase() + '%');
  else             query = query.ilike('name', `%${q}%`);

  const { data, error } = await query.limit(10);
  if (error) { _toast(safeErrorMessage(error, 'Could not search patients.'),'error'); return; }
  if (!data?.length) { resultsEl.innerHTML = '<div class="empty">No patients found</div>'; return; }

  resultsEl.innerHTML = `<div class="search-results">${
    data.map(p => `<div class="sr-item" data-onclick="openPatientFile" data-onclick-a0="${p.id}">
      <div class="sr-name">${_esc(p.name)}</div>
      <div class="sr-meta">
        UHID: AYX-${p.id.replace(/-/g,'').slice(-6).toUpperCase()} &nbsp;·&nbsp;
        ${_esc(p.phone||'No phone')} &nbsp;·&nbsp;
        ${p.age ? p.age+'y' : ''} ${_esc(p.gender||'')} &nbsp;·&nbsp;
        ${p.prakriti_data?.result ? '🌿 '+_esc(p.prakriti_data.result) : 'Prakriti not assessed'}
      </div>
    </div>`).join('')
  }</div>`;
}

window.openPatientFile = async function(patientId) {
  document.getElementById('rec-results').innerHTML = '';
  const fileEl = document.getElementById('rec-file');
  fileEl.style.display = '';
  fileEl.innerHTML = '<div class="empty">Loading patient file…</div>';

  const [
    { data: pat },
    { data: visits },
    { data: bills },
    { data: ipd },
  ] = await Promise.all([
    supabase.from('patients').select('*').eq('id', patientId).single(),
    supabase.from('visits').select('id,created_at,status,chief_complaint,opds(name),profiles!doctor_id(full_name)').eq('patient_id',patientId).order('created_at',{ascending:false}),
    supabase.from('bills').select('id,created_at,final_amount,status,payment_mode').eq('patient_id',patientId).eq('tenant_id',tenantId).order('created_at',{ascending:false}),
    supabase.from('ipd_admissions').select('id,admission_date,discharged_at,status,diagnosis_primary,departments(name)').eq('patient_id',patientId).order('admission_date',{ascending:false}),
  ]);

  const initials = (pat.name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const joined   = _fmtD(pat.created_at?.slice(0,10));
  const totalBilled = (bills||[]).reduce((s,b)=>s+(parseFloat(b.final_amount)||0),0);

  fileEl.innerHTML = `
    <div class="pf-header">
      <div class="pf-avatar">${_esc(initials)}</div>
      <div style="flex:1">
        <div class="pf-name">${_esc(pat.name)}</div>
        <div class="pf-sub">UHID: AYX-${pat.id.replace(/-/g,'').slice(-6).toUpperCase()} &nbsp;·&nbsp; Registered: ${joined}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:20px;font-weight:700;font-family:'Cormorant Garamond',serif">${(visits||[]).length}</div>
        <div style="font-size:11px;opacity:.8">Total Visits</div>
      </div>
    </div>
    <div class="pf-body">
      <div class="pf-demog">
        <div class="pf-demog-item">Age: <span>${pat.age||'—'}</span></div>
        <div class="pf-demog-item">Gender: <span>${_esc(pat.gender||'—')}</span></div>
        <div class="pf-demog-item">DOB: <span>${pat.date_of_birth||'—'}</span></div>
        <div class="pf-demog-item">Blood Group: <span>${_esc(pat.blood_group||'—')}</span></div>
        <div class="pf-demog-item">Phone: <span>${_esc(pat.phone||'—')}</span></div>
        <div class="pf-demog-item">ABHA: <span>${_esc(pat.abha_number||'—')}</span></div>
        <div class="pf-demog-item">Prakriti: <span>${_esc(pat.prakriti_data?.result||'Not assessed')}</span></div>
        <div class="pf-demog-item">Total Billed: <span>₹${_n(totalBilled)}</span></div>
      </div>

      <div class="pf-cols">
        <!-- Visit timeline -->
        <div>
          <div class="pf-section-label">Visit History (${(visits||[]).length})</div>
          <div class="visit-list" id="vlist-${patientId}">
            ${(visits||[]).map(v => `
              <div class="visit-item" data-onclick="loadVisitDetail" data-onclick-a0="${v.id}" data-onclick-a1="${patientId}" data-onclick-a2="@this">
                <div class="vi-top">
                  <div class="vi-date">${_fmtD(v.created_at?.slice(0,10))}</div>
                  <span class="badge b-${v.status}" style="font-size:10px">${_esc(v.status)}</span>
                </div>
                <div class="vi-opd">${_esc(v.opds?.name||'OPD')} · ${_esc(v.profiles?.full_name||'—')}</div>
                ${v.chief_complaint ? `<div class="vi-complaint">"${_esc(v.chief_complaint.slice(0,80))}${v.chief_complaint.length>80?'…':''}"</div>` : ''}
              </div>`).join('') || '<div class="empty">No visits recorded</div>'}
          </div>
        </div>

        <!-- Visit detail + IPD summary -->
        <div>
          <div class="pf-section-label">Visit Details</div>
          <div id="visit-detail-${patientId}" style="color:var(--text-muted);font-size:12px;padding:8px 0">
            Select a visit from the list to view clinical details.
          </div>

          ${(ipd||[]).length ? `
            <div class="pf-section-label">IPD Admissions (${ipd.length})</div>
            ${ipd.map(a => `<div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:6px;font-size:12px">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <strong>${_esc(a.departments?.name||'IPD')}</strong>
                <span class="badge b-${a.status}">${_esc(a.status)}</span>
              </div>
              <div style="color:var(--text-muted)">Admitted: ${_fmtD(a.admission_date)} ${a.discharged_at ? '→ Discharged: '+_fmtD(a.discharged_at.slice(0,10)) : '(current)'}</div>
              ${a.diagnosis_primary ? `<div style="margin-top:3px;color:var(--text-dark)">${_esc(a.diagnosis_primary)}</div>` : ''}
            </div>`).join('')}
          ` : ''}
        </div>
      </div>
    </div>`;
};

window.loadVisitDetail = async function(visitId, patientId, el) {
  document.querySelectorAll('.visit-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  const detailEl = document.getElementById('visit-detail-' + patientId);
  detailEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Loading…</div>';

  const { data: cn } = await supabase
    .from('consultation_notes')
    .select('diagnosis_namc_label,diagnosis_namc_code,diagnosis_icd10_label,diagnosis_icd10_code,clinical_notes,ayurveda_diagnosis')
    .eq('visit_id', visitId).maybeSingle();

  const { data: rxItems } = await supabase
    .from('prescription_items')
    .select('medicine_name,dosage,frequency,duration')
    .eq('prescription_id', (
      await supabase.from('prescriptions').select('id').eq('visit_id',visitId).maybeSingle()
    ).data?.id || '00000000-0000-0000-0000-000000000000');

  detailEl.innerHTML = `<div class="vd-panel">
    ${cn?.diagnosis_namc_label ? `
      <div class="vd-row"><div class="vd-label">NAMC Diagnosis:</div><div class="vd-val"><strong>${_esc(cn.diagnosis_namc_label)}</strong> <span style="color:var(--text-muted)">(${_esc(cn.diagnosis_namc_code||'')})</span></div></div>` : ''}
    ${cn?.diagnosis_icd10_label ? `
      <div class="vd-row"><div class="vd-label">ICD-10:</div><div class="vd-val">${_esc(cn.diagnosis_icd10_label)} <span style="color:var(--text-muted)">(${_esc(cn.diagnosis_icd10_code||'')})</span></div></div>` : ''}
    ${cn?.ayurveda_diagnosis ? `
      <div class="vd-row"><div class="vd-label">Ayurveda Dx:</div><div class="vd-val">${_esc(cn.ayurveda_diagnosis)}</div></div>` : ''}
    ${cn?.clinical_notes ? `
      <div class="vd-row"><div class="vd-label">Clinical Notes:</div><div class="vd-val" style="white-space:pre-wrap">${_esc(cn.clinical_notes.slice(0,300))}${cn.clinical_notes.length>300?'…':''}</div></div>` : ''}
    ${rxItems?.length ? `
      <div style="margin-top:8px;font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">Prescription (${rxItems.length} medicines)</div>
      ${rxItems.map(r => `<div style="font-size:12px;padding:3px 0;border-bottom:1px solid var(--border)">
        <strong>${_esc(r.medicine_name)}</strong> · ${_esc(r.dosage||'')} ${_esc(r.frequency||'')} ${r.duration ? '× '+_esc(r.duration) : ''}
      </div>`).join('')}` : ''}
    ${!cn && !rxItems?.length ? '<div style="color:var(--text-muted);font-size:12px">No clinical notes recorded for this visit.</div>' : ''}
  </div>`;
};

// ── Statistics ────────────────────────────────────────────
window.loadStats = async function() {
  const period = document.getElementById('stat-period').value;
  const { from } = _periodDates(period);

  const [
    { data: visitRows },
    { data: patRows },
  ] = await Promise.all([
    supabase.from('visits').select('id,created_at,opds(name),is_new_patient')
      .eq('tenant_id',tenantId).gte('created_at', from+'T00:00:00'),
    supabase.from('patients').select('id,age,gender,created_at')
      .eq('tenant_id',tenantId).gte('created_at', from+'T00:00:00'),
  ]);

  // OPD breakdown
  const opdCounts = {};
  (visitRows||[]).forEach(v => {
    const name = v.opds?.name || 'Unknown OPD';
    opdCounts[name] = (opdCounts[name]||0) + 1;
  });
  const opdSorted = Object.entries(opdCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const maxOpd = opdSorted[0]?.[1] || 1;
  document.getElementById('stat-opd-chart').innerHTML = opdSorted.map(([name,cnt]) =>
    `<div class="bar-row">
      <div class="bar-label" title="${_esc(name)}">${_esc(name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(cnt/maxOpd*100)}%"></div></div>
      <div class="bar-count">${cnt}</div>
    </div>`).join('') || '<div class="empty">No data</div>';

  // New vs return
  const newV  = (visitRows||[]).filter(v=>v.is_new_patient).length;
  const retV  = (visitRows||[]).length - newV;
  const total = (visitRows||[]).length || 1;
  document.getElementById('stat-new-return').innerHTML = `
    <div style="display:flex;gap:20px;margin-bottom:12px">
      <div style="flex:1;text-align:center;padding:14px;background:var(--green-light);border-radius:8px">
        <div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:700;color:var(--green-deep)">${newV}</div>
        <div style="font-size:11px;color:var(--text-muted)">New Patients</div>
      </div>
      <div style="flex:1;text-align:center;padding:14px;background:var(--gold-light);border-radius:8px">
        <div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:700;color:var(--gold)">${retV}</div>
        <div style="font-size:11px;color:var(--text-muted)">Return Visits</div>
      </div>
    </div>
    <div class="bar-row">
      <div class="bar-label">New</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(newV/total*100)}%"></div></div>
      <div class="bar-count">${Math.round(newV/total*100)}%</div>
    </div>
    <div class="bar-row">
      <div class="bar-label">Return</div>
      <div class="bar-track"><div class="bar-fill gold" style="width:${Math.round(retV/total*100)}%"></div></div>
      <div class="bar-count">${Math.round(retV/total*100)}%</div>
    </div>`;

  // Gender
  const gMap = {M:0,F:0,other:0};
  (patRows||[]).forEach(p => { gMap[p.gender||'other'] = (gMap[p.gender||'other']||0)+1; });
  const maxG = Math.max(...Object.values(gMap)) || 1;
  document.getElementById('stat-gender-chart').innerHTML = [
    ['Male (M)', gMap.M], ['Female (F)', gMap.F], ['Other', gMap.other]
  ].map(([l,c]) => `<div class="bar-row">
    <div class="bar-label">${l}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.round(c/maxG*100)}%"></div></div>
    <div class="bar-count">${c}</div>
  </div>`).join('');

  // Age groups
  const ageGroups = {'0-12':0,'13-17':0,'18-30':0,'31-45':0,'46-60':0,'61+':0};
  (patRows||[]).forEach(p => {
    const a = parseInt(p.age)||0;
    if (a<=12) ageGroups['0-12']++;
    else if (a<=17) ageGroups['13-17']++;
    else if (a<=30) ageGroups['18-30']++;
    else if (a<=45) ageGroups['31-45']++;
    else if (a<=60) ageGroups['46-60']++;
    else ageGroups['61+']++;
  });
  const maxA = Math.max(...Object.values(ageGroups)) || 1;
  document.getElementById('stat-age-chart').innerHTML = Object.entries(ageGroups).map(([l,c]) =>
    `<div class="bar-row">
      <div class="bar-label">${l} years</div>
      <div class="bar-track"><div class="bar-fill gold" style="width:${Math.round(c/maxA*100)}%"></div></div>
      <div class="bar-count">${c}</div>
    </div>`).join('');

  // Monthly trend (last 6 months)
  const monthMap = {};
  (visitRows||[]).forEach(v => {
    const m = v.created_at?.slice(0,7);
    if (m) monthMap[m] = (monthMap[m]||0)+1;
  });
  const months = Object.keys(monthMap).sort().slice(-6);
  const maxM = Math.max(...months.map(m=>monthMap[m])) || 1;
  document.getElementById('stat-trend-chart').innerHTML = months.map(m =>
    `<div class="bar-row">
      <div class="bar-label">${new Date(m+'-01').toLocaleDateString('en-IN',{month:'short',year:'numeric'})}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(monthMap[m]/maxM*100)}%"></div></div>
      <div class="bar-count">${monthMap[m]}</div>
    </div>`).join('') || '<div class="empty">No visit data in this period</div>';
};

window.exportStatsCSV = function() { _toast('Use browser Print to save the statistics view', 'success'); };

// ── Diagnosis burden ──────────────────────────────────────
window.loadDiagnosis = async function() {
  const period  = document.getElementById('diag-period').value;
  const coding  = document.getElementById('diag-coding').value;
  const { from } = _periodDates(period);
  document.getElementById('diag-period-lbl').textContent = period === 'all' ? 'All time' : 'From ' + _fmtD(from);

  const labelCol = coding === 'namc' ? 'diagnosis_namc_label' : 'diagnosis_icd10_label';
  const codeCol  = coding === 'namc' ? 'diagnosis_namc_code'  : 'diagnosis_icd10_code';

  const { data, error } = await supabase
    .from('consultation_notes')
    .select(`${labelCol},${codeCol}`)
    .eq('tenant_id', tenantId)
    .not(labelCol, 'is', null)
    .gte('created_at', from + 'T00:00:00');

  if (error) { _toast(safeErrorMessage(error, 'Could not load records.'),'error'); return; }

  const countMap = {};
  (data||[]).forEach(r => {
    const label = r[labelCol];
    const code  = r[codeCol] || '';
    if (!label) return;
    const key = label + '||' + code;
    if (!countMap[key]) countMap[key] = { label, code, count: 0 };
    countMap[key].count++;
  });

  _diagData = Object.values(countMap).sort((a,b)=>b.count-a.count);
  const total = _diagData.reduce((s,d)=>s+d.count, 0) || 1;
  const maxC  = _diagData[0]?.count || 1;

  document.getElementById('diag-chart').innerHTML = _diagData.slice(0,15).map(d =>
    `<div class="bar-row">
      <div class="bar-label" title="${_esc(d.label)}">${_esc(d.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(d.count/maxC*100)}%"></div></div>
      <div class="bar-count">${d.count}</div>
    </div>`).join('') || '<div class="empty">No coded diagnoses found in this period. Diagnoses are coded in doctor.html using NAMASTE dual-coding.</div>';

  document.getElementById('diag-tbody').innerHTML = _diagData.map((d,i) =>
    `<tr>
      <td style="color:var(--text-muted)">${i+1}</td>
      <td style="font-weight:${i<3?'600':'400'}">${_esc(d.label)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_esc(d.code)}</td>
      <td style="font-weight:600;color:var(--green-deep)">${d.count}</td>
      <td>${Math.round(d.count/total*100)}%</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">No data</td></tr>';
};

window.exportDiagCSV = function() {
  _csvDownload(_diagData.map(d => ({ Diagnosis: d.label, Code: d.code, Cases: d.count })), 'diagnosis_burden');
};

// ── IPD Registry ──────────────────────────────────────────
async function loadIPD() {
  const { data, error } = await supabase
    .from('ipd_admissions')
    .select('id,admission_date,admitted_at,discharged_at,status,diagnosis_primary,patients(name,age,gender),departments(name),profiles!admitting_doctor_id(full_name)')
    .eq('tenant_id', tenantId)
    .order('admission_date', { ascending: false });
  if (error) { document.getElementById('ipd-tbody').innerHTML = '<tr><td colspan="9" class="empty">IPD module not available</td></tr>'; return; }
  _ipdData = data || [];
  filterIPD();
}

window.filterIPD = function() {
  const q      = document.getElementById('ipd-search').value.toLowerCase();
  const status = document.getElementById('ipd-status').value;
  const month  = document.getElementById('ipd-month').value;
  const filtered = _ipdData.filter(a =>
    (!q      || a.patients?.name?.toLowerCase().includes(q)) &&
    (!status || a.status === status) &&
    (!month  || a.admission_date?.startsWith(month))
  );
  document.getElementById('ipd-count-lbl').textContent = `${filtered.length} records`;
  const tbody = document.getElementById('ipd-tbody');
  tbody.innerHTML = filtered.map(a => {
    const admDate = a.admission_date || a.admitted_at?.slice(0,10);
    const disDate = a.discharged_at?.slice(0,10);
    const los = admDate && disDate
      ? Math.max(1, Math.round((new Date(disDate)-new Date(admDate))/86400000))
      : (a.status==='admitted' ? Math.round((new Date()-new Date(admDate))/86400000)+' (ongoing)' : '—');
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${_fmtD(admDate)}</td>
      <td style="font-weight:500">${_esc(a.patients?.name||'—')}</td>
      <td style="font-size:12px">${a.patients?.age||'—'}y ${_esc(a.patients?.gender||'')}</td>
      <td style="font-size:12px">${_esc(a.departments?.name||'—')}</td>
      <td style="font-size:12px">${_esc(a.profiles?.full_name||'—')}</td>
      <td style="font-size:12px;max-width:180px;word-break:break-word">${_esc(a.diagnosis_primary||'—')}</td>
      <td style="font-size:12px">${disDate ? _fmtD(disDate) : '—'}</td>
      <td style="text-align:center;font-weight:500">${los}</td>
      <td><span class="badge b-${a.status}">${_esc(a.status)}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No IPD admissions found</td></tr>';
};

window.exportIPDCSV = function() {
  _csvDownload(_ipdData.map(a => ({
    AdmissionDate: a.admission_date, Patient: a.patients?.name,
    Age: a.patients?.age, Gender: a.patients?.gender,
    Department: a.departments?.name, Doctor: a.profiles?.full_name,
    Diagnosis: a.diagnosis_primary, DischargeDate: a.discharged_at?.slice(0,10),
    Status: a.status,
  })), 'ipd_registry');
};

// ── MRD Audit (§23w — IMS.7 CORE) ────────────────────────
let _auditData = [];

// Set default month to current
document.getElementById('audit-month').value = new Date().toISOString().slice(0,7);

window.loadAudit = async function() {
  const m = document.getElementById('audit-month').value;
  if (!m) return;
  const { data } = await supabase.from('mrd_audit_records')
    .select('*').eq('tenant_id', tenantId).eq('audit_month', m)
    .order('created_at', { ascending: false });
  _auditData = data || [];
  renderAudit();
};

window.renderAudit = function() {
  const rt = document.getElementById('audit-rtype').value;
  const rows = _auditData.filter(r => !rt || r.record_type === rt);
  const complete  = rows.filter(r => r.has_uhid && r.has_consent && r.has_discharge_summary && r.has_timed_entries && r.has_doctor_signature && r.has_diagnosis_coded).length;
  const deficient = rows.length - complete;
  document.getElementById('a-total').textContent    = rows.length;
  document.getElementById('a-complete').textContent = complete;
  document.getElementById('a-deficient').textContent= deficient;
  document.getElementById('a-pct').textContent      = rows.length ? Math.round(complete/rows.length*100)+'%' : '—';
  const yes = v => v ? '✅' : '❌';
  const tbody = document.getElementById('audit-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10"><div class="empty">No audit records for this period</div></td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `<tr>
    <td><strong>${_esc(r.uhid||'—')}</strong></td>
    <td>${_esc(r.patient_name||'—')}</td>
    <td><span style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text-muted)">${_esc(r.record_type)}</span></td>
    <td style="text-align:center">${yes(r.has_uhid)}</td>
    <td style="text-align:center">${yes(r.has_consent)}</td>
    <td style="text-align:center">${yes(r.has_discharge_summary)}</td>
    <td style="text-align:center">${yes(r.has_timed_entries)}</td>
    <td style="text-align:center">${yes(r.has_doctor_signature)}</td>
    <td style="text-align:center">${yes(r.has_diagnosis_coded)}</td>
    <td style="font-size:12px;color:${r.deficiencies ? 'var(--red)' : 'var(--text-muted)'}">${_esc(r.deficiencies||'None')}</td>
  </tr>`).join('');
};

window.openAuditModal = function() {
  const m = document.getElementById('audit-modal');
  m.style.display = 'flex';
  ['am-uhid','am-name','am-defic','am-action'].forEach(id => document.getElementById(id).value='');
  ['am-uhid-ok','am-consent-ok','am-discharge-ok','am-timed-ok','am-signed-ok','am-coded-ok'].forEach(id => document.getElementById(id).checked=false);
  document.getElementById('am-rtype').value = 'opd';
};
window.closeAuditModal = function() {
  document.getElementById('audit-modal').style.display='none';
};
window.saveAuditRecord = async function() {
  const name = document.getElementById('am-name').value.trim();
  if (!name) { _toast('Patient name required', 'error'); return; }
  const m = document.getElementById('audit-month').value || new Date().toISOString().slice(0,7);
  const payload = {
    tenant_id:              tenantId,
    audit_month:            m,
    patient_name:           name,
    uhid:                   document.getElementById('am-uhid').value.trim()||null,
    record_type:            document.getElementById('am-rtype').value,
    has_uhid:               document.getElementById('am-uhid-ok').checked,
    has_consent:            document.getElementById('am-consent-ok').checked,
    has_discharge_summary:  document.getElementById('am-discharge-ok').checked,
    has_timed_entries:      document.getElementById('am-timed-ok').checked,
    has_doctor_signature:   document.getElementById('am-signed-ok').checked,
    has_diagnosis_coded:    document.getElementById('am-coded-ok').checked,
    deficiencies:           document.getElementById('am-defic').value.trim()||null,
    action_taken:           document.getElementById('am-action').value.trim()||null,
    reviewed_by:            profile.id,
  };
  const { error } = await supabase.from('mrd_audit_records').insert(payload);
  if (error) { _toast(safeErrorMessage(error, 'Save failed.'), 'error'); return; }
  _toast('Audit record saved', 'success'); closeAuditModal(); loadAudit();
};
window.exportAuditCSV = function() {
  _csvDownload(_auditData.map(r => ({
    UHID: r.uhid||'', Patient: r.patient_name, Type: r.record_type,
    'UHID OK': r.has_uhid?'Yes':'No', 'Consent OK': r.has_consent?'Yes':'No',
    'Discharge OK': r.has_discharge_summary?'Yes':'No', 'Timed OK': r.has_timed_entries?'Yes':'No',
    'Signed OK': r.has_doctor_signature?'Yes':'No', 'Coded OK': r.has_diagnosis_coded?'Yes':'No',
    Deficiencies: r.deficiencies||'', Action: r.action_taken||''
  })), 'mrd_audit');
};

// ── Helpers ───────────────────────────────────────────────
function _periodDates(period) {
  const today = new Date();
  let from;
  if (period === 'month')   from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0,10);
  else if (period === 'quarter') {
    const q = Math.floor(today.getMonth()/3);
    from = new Date(today.getFullYear(), q*3, 1).toISOString().slice(0,10);
  } else if (period === 'year') from = new Date(today.getFullYear(), 0, 1).toISOString().slice(0,10);
  else from = '2020-01-01';
  return { from };
}
function _fmtD(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _n(v) { return (parseFloat(v)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function _toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}
function _csvDownload(rows, name) {
  if (!rows.length) { _toast('No data', 'error'); return; }
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','), ...rows.map(r => keys.map(k=>`"${String(r[k]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `${name}_${new Date().toISOString().slice(0,10)}.csv`; a.click();
}

// ── Boot ─────────────────────────────────────────────────
await Promise.all([loadKPIs(), loadStats(), loadDiagnosis(), loadIPD()]);
