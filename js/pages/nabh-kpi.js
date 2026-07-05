import { requireAuth, getCurrentProfile, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { supabase }    from '../core/db/supabaseClient.js';
import { initNavbar }  from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin']);
initNavbar('nabh-kpi.html');
wireDelegatedEvents();

const profile    = getCurrentProfile();
const tenantId   = getCurrentTenantId();
const userId     = profile.id;
const tenantType = getCurrentTenant()?.type || '';
const isATWC     = ['clinic','pk_center','dispensary'].includes(tenantType);

// Populate month selector (last 12 months)
const monthSel = document.getElementById('kpi-month');
const now = new Date();
for (let i = 0; i < 12; i++) {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  const val = d.toISOString().slice(0,7);
  const lbl = d.toLocaleDateString('en-IN',{month:'long',year:'numeric'});
  const opt = new Option(lbl, val);
  if (i === 1) opt.selected = true; // default: last month
  monthSel.append(opt);
}

// Set tenant badge
if (isATWC) {
  document.getElementById('tenant-badge').className = 'tenant-badge badge-atwc';
  document.getElementById('tenant-badge').textContent = '🏪 NABH ATWC Standards — 5 KPIs';
}

// ── KPI definitions ───────────────────────────────────────────────────────────

// Auto-computable KPIs
const AUTO_KPIS = [
  {
    code: 'medication_error_rate',
    title: 'Medication Error Rate',
    chapter: 'PSQ.3a',
    unit: '%',
    target: 0.5, target_dir: 'lower',
    target_label: 'Target: ≤0.5% of inpatient days',
    atwc: true,
    compute: async (from, to, inpatientDays) => {
      const { count } = await supabase.from('incident_reports')
        .select('id',{count:'exact',head:true})
        .eq('tenant_id',tenantId).eq('incident_type','medication_error')
        .gte('incident_date',from).lte('incident_date',to);
      return inpatientDays > 0 ? +((count/inpatientDays)*100).toFixed(2) : 0;
    }
  },
  {
    code: 'patient_fall_rate',
    title: 'Patient Fall Incidence',
    chapter: 'PSQ.3d',
    unit: '/1000 patient-days',
    target: 2, target_dir: 'lower',
    target_label: 'Target: <2 per 1000 patient-days',
    atwc: false,
    compute: async (from, to, inpatientDays) => {
      const { count } = await supabase.from('incident_reports')
        .select('id',{count:'exact',head:true})
        .eq('tenant_id',tenantId).eq('incident_type','fall')
        .gte('incident_date',from).lte('incident_date',to);
      return inpatientDays > 0 ? +((count/inpatientDays)*1000).toFixed(2) : 0;
    }
  },
  {
    code: 'near_miss_pct',
    title: 'Near Miss Percentage',
    chapter: 'PSQ.3d',
    unit: '%',
    target: 50, target_dir: 'higher',
    target_label: 'Target: ≥50% near-miss reporting (vs total incidents)',
    atwc: false,
    compute: async (from, to) => {
      const { count: total }  = await supabase.from('incident_reports').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('incident_date',from).lte('incident_date',to);
      const { count: nmCount } = await supabase.from('incident_reports').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('incident_type','near_miss').gte('incident_date',from).lte('incident_date',to);
      return total > 0 ? +((nmCount/total)*100).toFixed(1) : 100;
    }
  },
  {
    code: 'consent_completeness',
    title: 'Consent Record Completeness',
    chapter: 'PSQ.3c',
    unit: '%',
    target: 95, target_dir: 'higher',
    target_label: 'Target: ≥95% of admissions have consent',
    atwc: true,
    compute: async (from, to) => {
      const { count: admCount } = await supabase.from('ipd_admissions').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('admission_date',from).lte('admission_date',to);
      if (!admCount) return 100;
      const { data: consentData } = await supabase.from('consent_records').select('ipd_admission_id').eq('tenant_id',tenantId).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59').not('ipd_admission_id','is',null);
      const uniqueAdmWithConsent = new Set((consentData||[]).map(c=>c.ipd_admission_id)).size;
      return +((uniqueAdmWithConsent/admCount)*100).toFixed(1);
    }
  },
  {
    code: 'stock_outs',
    title: 'Medication Stock-Outs',
    chapter: 'PSQ.3c',
    unit: 'items',
    target: 0, target_dir: 'lower',
    target_label: 'Target: 0 stock-out items',
    atwc: true,
    compute: async () => {
      const { count } = await supabase.from('inventory').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).lte('stock_quantity',0);
      return count || 0;
    }
  },
  {
    code: 'procedure_rescheduling',
    title: 'Procedure Rescheduling Rate',
    chapter: 'PSQ.3c',
    unit: '%',
    target: 5, target_dir: 'lower',
    target_label: 'Target: <5% of scheduled procedures rescheduled',
    atwc: false,
    compute: async (from, to) => {
      const { count: total }      = await supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('scheduled_date',from).lte('scheduled_date',to);
      const { count: rescheduled } = await supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('status','rescheduled').gte('scheduled_date',from).lte('scheduled_date',to);
      return total > 0 ? +((rescheduled/total)*100).toFixed(1) : 0;
    }
  },
  {
    code: 'nurse_patient_ratio',
    title: 'Nurse-to-Patient Ratio',
    chapter: 'PSQ.3c',
    unit: 'ratio',
    target: 0.1, target_dir: 'higher',
    target_label: 'Target: ≥1:10 (ratio ≥0.10)',
    atwc: false,
    compute: async () => {
      const { count: nurses }       = await supabase.from('profiles').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('role','nurse').eq('is_active',true);
      const { count: occupiedBeds } = await supabase.from('beds').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('status','occupied');
      return occupiedBeds > 0 ? +((nurses/occupiedBeds).toFixed(2)) : null;
    }
  },
  {
    code: 'care_plan_within_24h',
    title: 'Care Plan Created Within 24h',
    chapter: 'PSQ.3a',
    unit: '%',
    target: 95, target_dir: 'higher',
    target_label: 'Target: ≥95% of admissions get care plan within 24h',
    atwc: false,
    compute: async (from, to) => {
      const { count: admCount } = await supabase.from('ipd_admissions').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('admission_date',from).lte('admission_date',to);
      if (!admCount) return 100;
      const { count: cpCount } = await supabase.from('ipd_care_plans').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59');
      return +((cpCount/admCount)*100).toFixed(1);
    }
  },
  {
    code: 'diagnostic_tat',
    title: 'Lab Test Turnaround Time',
    chapter: 'PSQ.3c',
    unit: 'hours',
    target: 4, target_dir: 'lower',
    target_label: 'Target: ≤4 hours average TAT',
    atwc: false,
    compute: async (from, to) => {
      const { data: samples } = await supabase.from('lab_samples')
        .select('created_at, collected_at')
        .eq('tenant_id',tenantId)
        .not('collected_at','is',null)
        .gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59');
      if (!samples?.length) return null;
      const avgMs = samples.reduce((s,r) => s + (new Date(r.collected_at) - new Date(r.created_at)), 0) / samples.length;
      return +(avgMs/3600000).toFixed(1);
    }
  },
  {
    code: 'sentinel_events',
    title: 'Sentinel Events',
    chapter: 'PSQ.7',
    unit: 'events',
    target: 0, target_dir: 'lower',
    target_label: 'Target: 0 sentinel events',
    atwc: false,
    compute: async (from, to) => {
      const { count } = await supabase.from('incident_reports')
        .select('id',{count:'exact',head:true})
        .eq('tenant_id',tenantId).eq('severity','sentinel')
        .gte('incident_date',from).lte('incident_date',to);
      return count || 0;
    }
  },
  {
    code: 'adr_rate',
    title: 'Adverse Drug Reactions (Inpatients)',
    chapter: 'PSQ.3a',
    unit: '%',
    target: 1, target_dir: 'lower',
    target_label: 'Target: <1% of inpatient days',
    atwc: false,
    compute: async (from, to, inpatientDays) => {
      const { count } = await supabase.from('incident_reports')
        .select('id',{count:'exact',head:true})
        .eq('tenant_id',tenantId).eq('incident_type','adverse_event')
        .gte('incident_date',from).lte('incident_date',to);
      return inpatientDays > 0 ? +((count/inpatientDays)*100).toFixed(2) : 0;
    }
  },
  {
    code: 'needlestick_rate',
    title: 'Needlestick Injury Rate',
    chapter: 'PSQ.3d',
    unit: '/1000 bed-days',
    target: 1, target_dir: 'lower',
    target_label: 'Target: <1 per 1000 patient-days',
    atwc: false,
    compute: async (from, to, inpatientDays) => {
      const { count } = await supabase.from('incident_reports')
        .select('id',{count:'exact',head:true})
        .eq('tenant_id',tenantId).eq('is_needlestick',true)
        .gte('incident_date',from).lte('incident_date',to);
      return inpatientDays > 0 ? +((count/inpatientDays)*1000).toFixed(2) : 0;
    }
  },
  {
    code: 'patient_satisfaction',
    title: 'Patient Satisfaction Index',
    chapter: 'PSQ.2',
    unit: '%',
    target: 80, target_dir: 'higher',
    target_label: 'Target: ≥80% satisfaction score',
    atwc: true,
    compute: async (from, to) => {
      const { data } = await supabase.from('patient_feedback')
        .select('overall_rating')
        .eq('tenant_id',tenantId)
        .gte('submitted_at',from+'T00:00:00').lte('submitted_at',to+'T23:59:59');
      if (!data?.length) return null;
      const avg = data.reduce((s,r) => s+(r.overall_rating||0), 0) / data.length;
      return +(avg/5*100).toFixed(1);
    }
  },
];

// Manual-entry KPIs
const MANUAL_KPIS = [
  { code:'hand_hygiene',        title:'Hand Hygiene Compliance',        chapter:'IPC.3/IPC.6', unit:'%',         target:80,  target_dir:'higher', target_label:'Target: ≥80%',                   atwc:true  },
  { code:'opd_waiting_time',    title:'OPD Consultation Waiting Time',  chapter:'PSQ.3c',      unit:'minutes',   target:30,  target_dir:'lower',  target_label:'Target: ≤30 minutes average',    atwc:true  },
  { code:'cauti_rate',          title:'CAUTI Rate',                     chapter:'PSQ.3b',      unit:'/1000 catheter-days', target:2, target_dir:'lower', target_label:'Target: <2/1000 catheter-days', atwc:false },
  { code:'ssi_rate',            title:'Surgical Site Infection Rate',   chapter:'PSQ.3a',      unit:'/100 procedures', target:5, target_dir:'lower', target_label:'Target: <5 per 100 procedures', atwc:false },
  { code:'lab_reporting_errors',title:'Lab Reporting Errors',           chapter:'PSQ.3a',      unit:'/1000 tests', target:1, target_dir:'lower',  target_label:'Target: <1 per 1000 tests',       atwc:false },
  { code:'hap_rate',            title:'Hospital-Acquired Pressure Ulcers', chapter:'PSQ.3a',  unit:'/1000 patient-days', target:1, target_dir:'lower', target_label:'Target: <1 per 1000 patient-days', atwc:false },
  { code:'mock_drill_variations',title:'Mock Drill Variations',          chapter:'PSQ.3d',      unit:'count',     target:0,   target_dir:'lower',  target_label:'Target: 0 variations in drill',  atwc:false },
  { code:'handover_compliance', title:'Handover Communication Compliance', chapter:'PSQ.3d',  unit:'%',         target:95,  target_dir:'higher', target_label:'Target: ≥95% structured SBAR handovers', atwc:false },
  { code:'rational_prescriptions',title:'Safe & Rational Prescriptions', chapter:'PSQ.3d',    unit:'%',         target:90,  target_dir:'higher', target_label:'Target: ≥90% of OPD prescriptions', atwc:false },
];

// ── Data loading ──────────────────────────────────────────────────────────────

let _inpatientDays = 0;
let _manualData    = {};

async function calcInpatientDays(from, to) {
  const { data } = await supabase.from('ipd_admissions')
    .select('admission_date,discharged_at')
    .eq('tenant_id',tenantId)
    .lte('admission_date',to)
    .or(`discharged_at.gte.${from},discharged_at.is.null`);
  const f = new Date(from), t = new Date(to+'T23:59:59');
  return (data||[]).reduce((sum,a) => {
    const start = new Date(Math.max(new Date(a.admission_date), f));
    const end   = a.discharged_at ? new Date(Math.min(new Date(a.discharged_at), t)) : t;
    return sum + Math.max(0, (end-start)/86400000);
  }, 0);
}

async function loadManualValues(month) {
  const { data } = await supabase.from('kpi_audit_entries')
    .select('kpi_code,value,numerator,denominator,notes')
    .eq('tenant_id',tenantId).eq('month',month);
  _manualData = {};
  (data||[]).forEach(r => { _manualData[r.kpi_code] = r; });
}

window.loadAllKPIs = async function() {
  const month = document.getElementById('kpi-month').value;
  const from  = month + '-01';
  const to    = month + '-31';

  document.getElementById('auto-kpi-grid').innerHTML   = '<div class="loading">Computing KPIs…</div>';
  document.getElementById('manual-kpi-grid').innerHTML = '<div class="loading">Loading…</div>';

  [_inpatientDays] = await Promise.all([
    calcInpatientDays(from, to),
    loadManualValues(month),
  ]);

  const autoKpis = isATWC ? AUTO_KPIS.filter(k=>k.atwc) : AUTO_KPIS;
  const manKpis  = isATWC ? MANUAL_KPIS.filter(k=>k.atwc) : MANUAL_KPIS;

  // Auto-compute
  const autoResults = await Promise.all(autoKpis.map(async kpi => {
    try { return { ...kpi, value: await kpi.compute(from, to, _inpatientDays) }; }
    catch { return { ...kpi, value: null }; }
  }));

  // Render auto KPIs
  document.getElementById('auto-kpi-grid').innerHTML = autoResults.map(k => renderCard(k, false)).join('');

  // Manual KPIs (from audit entries)
  const manResults = manKpis.map(kpi => ({ ...kpi, value: _manualData[kpi.code]?.value ?? null }));
  document.getElementById('manual-kpi-grid').innerHTML = manResults.map(k => renderCard(k, true)).join('');

  // Update summary strip
  const allResults = [...autoResults, ...manResults];
  const red    = allResults.filter(k => k.value !== null && getStatus(k) === 'red').length;
  const yellow = allResults.filter(k => k.value !== null && getStatus(k) === 'yellow').length;
  const green  = allResults.filter(k => k.value !== null && getStatus(k) === 'green').length;
  const missing = allResults.filter(k => k.value === null).length;

  document.getElementById('summary-strip').innerHTML = `
    <div class="sum-card red"><div class="sum-label">Below Target</div><div class="sum-value">${red}</div></div>
    <div class="sum-card yellow"><div class="sum-label">Borderline</div><div class="sum-value">${yellow}</div></div>
    <div class="sum-card green"><div class="sum-label">Meeting Target</div><div class="sum-value">${green}</div></div>
    <div class="sum-card grey"><div class="sum-label">Pending Entry</div><div class="sum-value">${missing}</div></div>
    <div class="sum-card ${red > 0 ? 'red' : 'green'}"><div class="sum-label">Overall Status</div><div class="sum-value" style="font-size:18px">${red > 0 ? '⚠ Action' : '✅ OK'}</div></div>
  `;

  if (red > 0) {
    const redNames = allResults.filter(k => k.value !== null && getStatus(k) === 'red').map(k => k.title).join(', ');
    document.getElementById('alert-text').textContent = `${red} KPI${red>1?'s':''} below target — immediate action required: ${redNames}`;
    document.getElementById('alert-banner').style.display = '';
  } else {
    document.getElementById('alert-banner').style.display = 'none';
  }

  // Populate manual entry KPI selector
  const meKpi = document.getElementById('me-kpi');
  meKpi.innerHTML = manKpis.map(k => `<option value="${k.code}">${k.title}</option>`).join('');
};

function getStatus(kpi) {
  if (kpi.value === null) return 'grey';
  const v = kpi.value, t = kpi.target;
  if (kpi.target_dir === 'lower') {
    if (v <= t) return 'green';
    if (v <= t * 1.5) return 'yellow';
    return 'red';
  } else {
    if (v >= t) return 'green';
    if (v >= t * 0.8) return 'yellow';
    return 'red';
  }
}

function statusLabel(status) {
  return { green:'✅ Meeting target', yellow:'⚠ Borderline', red:'🔴 Below target', grey:'— Pending' }[status];
}

function renderCard(kpi, isManual) {
  const status = getStatus(kpi);
  const valDisplay = kpi.value === null ? '—'
    : kpi.unit === 'ratio' ? `1:${Math.round(1/kpi.value)}`
    : kpi.value;
  return `<div class="kpi-card ${status}">
    ${isManual ? '<div class="kpi-manual-tag">Manual</div>' : ''}
    <div class="kpi-top">
      <div class="kpi-title">${kpi.title}</div>
      <div class="kpi-chapter">${kpi.chapter}</div>
    </div>
    <div class="kpi-value-row">
      <div class="kpi-value">${valDisplay}</div>
      <div class="kpi-unit">${kpi.unit !== 'ratio' ? kpi.unit : ''}</div>
    </div>
    <div class="kpi-target">${kpi.target_label}</div>
    <div class="kpi-status ${status}">${statusLabel(status)}</div>
    ${isManual && kpi.value !== null ? `<div class="kpi-trend" style="margin-top:6px;font-size:10px;color:var(--text-muted)">Last updated: ${_manualData[kpi.code] ? 'this month' : '—'}</div>` : ''}
  </div>`;
}

// ── Manual entry save ─────────────────────────────────────────────────────────
window.saveManualKPI = async function() {
  const code = document.getElementById('me-kpi').value;
  const num  = parseFloat(document.getElementById('me-num').value);
  const den  = parseFloat(document.getElementById('me-den').value);
  const notes = document.getElementById('me-notes').value.trim();
  const month = document.getElementById('kpi-month').value;
  if (isNaN(num) || isNaN(den) || den === 0) { alert('Enter valid numerator and denominator'); return; }

  const kpiDef = MANUAL_KPIS.find(k => k.code === code);
  let value;
  if (kpiDef?.unit === '%')              value = +(num/den*100).toFixed(2);
  else if (kpiDef?.unit?.includes('/1000')) value = +(num/den*1000).toFixed(2);
  else if (kpiDef?.unit?.includes('/100'))  value = +(num/den*100).toFixed(2);
  else                                      value = +(num).toFixed(2);

  const { error } = await supabase.from('kpi_audit_entries').upsert({
    tenant_id: tenantId, kpi_code: code, month,
    numerator: num, denominator: den, value,
    unit: kpiDef?.unit || '', notes: notes || null, entered_by: userId,
  }, { onConflict: 'tenant_id,kpi_code,month' });

  if (error) { alert(error.message); return; }
  document.getElementById('me-num').value   = '';
  document.getElementById('me-den').value   = '';
  document.getElementById('me-notes').value = '';
  document.getElementById('me-saved').style.display = '';
  setTimeout(() => { document.getElementById('me-saved').style.display = 'none'; }, 3000);
  loadAllKPIs();
};

// ── PDF export ────────────────────────────────────────────────────────────────
window.exportKPIReport = function() { window.print(); };

// ── Init ──────────────────────────────────────────────────────────────────────
loadAllKPIs();
