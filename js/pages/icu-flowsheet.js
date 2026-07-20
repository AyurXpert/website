import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse']);
initNavbar();
wireDelegatedEvents();

window._print = () => window.print();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
let _admissions = [];
let _currentAdm = null;

// Set today's date
document.getElementById('sel-date').value = new Date().toISOString().split('T')[0];

// Load admitted patients
async function loadAdmissions() {
  // Session 114 -- stays selectable through the reconciliation window
  // (clinically_discharged): the patient hasn't physically left the ward
  // yet at that stage, so ICU charting should stay available.
  const {data} = await supabase.from('ipd_admissions').select(`
    id,admission_date,diagnosis_primary,
    patient:patients(id,name),
    bed:beds(bed_number,ward_name)
  `).eq('tenant_id',tenantId).in('status',['admitted','clinically_discharged']).order('admission_date');
  _admissions = data || [];
  const sel = document.getElementById('sel-patient');
  sel.innerHTML = '<option value="">— Select Admitted Patient —</option>' +
    _admissions.map(a=>`<option value="${a.id}">${_esc(a.patient?.name)} — ${_esc(a.bed?.ward_name||'')} Bed ${_esc(a.bed?.bed_number||'')}</option>`).join('');
}

window.onPatientChange = () => {
  const id = document.getElementById('sel-patient').value;
  _currentAdm = _admissions.find(a=>a.id===id)||null;
  if (_currentAdm) {
    document.getElementById('pt-banner').style.display='block';
    document.getElementById('pt-name').textContent = _currentAdm.patient?.name||'—';
    document.getElementById('pt-adm').textContent = _currentAdm.admission_date||'—';
    document.getElementById('pt-dx').textContent = _currentAdm.diagnosis_primary||'—';
    document.getElementById('pt-bed').textContent = `${_currentAdm.bed?.ward_name||''} / ${_currentAdm.bed?.bed_number||'—'}`;
    document.getElementById('kpi-row').style.display='grid';
    loadFlowsheet();
  } else {
    document.getElementById('pt-banner').style.display='none';
    document.getElementById('kpi-row').style.display='none';
    document.getElementById('fs-container').style.display='none';
    document.getElementById('fs-empty').style.display='block';
  }
};

window.loadFlowsheet = async () => {
  if (!_currentAdm) return;
  const date = document.getElementById('sel-date').value;
  const {data} = await supabase.from('icu_flowsheets')
    .select('*')
    .eq('tenant_id',tenantId)
    .eq('ipd_id',_currentAdm.id)
    .gte('recorded_at',date+'T00:00:00')
    .lte('recorded_at',date+'T23:59:59')
    .order('recorded_at');

  if (!data?.length) {
    document.getElementById('fs-empty').textContent='No entries for this date. Click "+ Add Entry" to begin.';
    document.getElementById('fs-empty').style.display='block';
    document.getElementById('fs-container').style.display='none';
    clearKPIs();
    return;
  }

  document.getElementById('fs-empty').style.display='none';
  document.getElementById('fs-container').style.display='block';

  // Update KPIs from latest entry
  const last = data[data.length-1];
  document.getElementById('k-bp').textContent = last.bp_systolic ? `${last.bp_systolic}/${last.bp_diastolic}` : '—';
  document.getElementById('k-hr').textContent = last.heart_rate||'—';
  document.getElementById('k-spo2').textContent = last.spo2 ? last.spo2+'%' : '—';
  const gcs = (last.gcs_eye||0)+(last.gcs_verbal||0)+(last.gcs_motor||0);
  document.getElementById('k-gcs').textContent = gcs||'—';
  document.getElementById('k-rass').textContent = last.rass_score!==null&&last.rass_score!==undefined ? last.rass_score : '—';
  const totalIn = (last.iv_fluid_in_ml||0)+(last.oral_in_ml||0);
  const totalOut = (last.urine_out_ml||0)+(last.other_out_ml||0)+(last.ng_out_ml||0);
  document.getElementById('k-fb').textContent = `+${totalIn-totalOut}`;
  document.getElementById('k-vent').textContent = last.on_ventilator ? last.ventilator_mode||'Yes' : 'No';

  // Build transposed table
  const times = data.map(d => {
    const t = new Date(d.recorded_at);
    return t.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  });

  const rows = [
    ['BP (mmHg)', data.map(d=>d.bp_systolic?`${d.bp_systolic}/${d.bp_diastolic}`:'—')],
    ['HR (bpm)', data.map(d=>d.heart_rate||'—')],
    ['SpO₂ (%)', data.map(d=>d.spo2||'—')],
    ['Temp (°F)', data.map(d=>d.temperature||'—')],
    ['RR (/min)', data.map(d=>d.respiratory_rate||'—')],
    ['Pain (NRS)', data.map(d=>d.pain_score!==null&&d.pain_score!==undefined?d.pain_score:'—')],
    ['Ventilator', data.map(d=>d.on_ventilator?`<span class="vent-on">${_esc(d.ventilator_mode||'On')}</span>`:`<span class="vent-off">Off</span>`)],
    ['FiO₂ (%)', data.map(d=>d.fio2||'—')],
    ['PEEP', data.map(d=>d.peep||'—')],
    ['TV (ml)', data.map(d=>d.tidal_volume||'—')],
    ['GCS', data.map(d=>{ const g=(d.gcs_eye||0)+(d.gcs_verbal||0)+(d.gcs_motor||0); return g||'—'; })],
    ['RASS', data.map(d=>{
      const r=d.rass_score;
      if(r===null||r===undefined) return '—';
      const cls = r<0?'rass-neg':r>0?'rass-pos':'rass-zero';
      return `<span class="${cls}">${r>=0?'+':''}${r}</span>`;
    })],
    ['IV In (ml)', data.map(d=>d.iv_fluid_in_ml||'—')],
    ['Urine Out (ml)', data.map(d=>d.urine_out_ml||'—')],
    ['Balance (ml)', data.map(d=>{
      const inn=(d.iv_fluid_in_ml||0)+(d.oral_in_ml||0);
      const out=(d.urine_out_ml||0)+(d.other_out_ml||0)+(d.ng_out_ml||0);
      const bal=inn-out;
      const cls=bal<0?'style="color:var(--red)"':'style="color:var(--green-mid)"';
      return `<span ${cls}>${bal>=0?'+':''}${bal}</span>`;
    })],
    ['Vasopressor', data.map(d=>_esc(d.vasopressor||'—'))],
    ['Notes', data.map(d=>_esc(d.notes||'—'))],
  ];

  const thead = document.querySelector('.fs-table thead');
  const existingRows = thead.querySelectorAll('tr');
  existingRows[0].innerHTML = `<th style="text-align:left;background:#1a4a2e;min-width:110px;white-space:nowrap">Parameter</th>` +
    times.map(t=>`<th style="background:#1a4a2e;min-width:80px">${t}</th>`).join('');

  document.getElementById('fs-tbody').innerHTML = rows.map(([label, vals])=>`
    <tr>
      <td class="row-label">${label}</td>
      ${vals.map(v=>`<td>${v}</td>`).join('')}
    </tr>
  `).join('');
};

function clearKPIs(){
  ['k-bp','k-hr','k-spo2','k-gcs','k-rass','k-fb','k-vent'].forEach(id=>document.getElementById(id).textContent='—');
}

window.openEntry = () => {
  if (!_currentAdm){showToast('Select a patient first','error');return;}
  const now = new Date();
  now.setSeconds(0,0);
  document.getElementById('e-dt').value = now.toISOString().slice(0,16);
  document.getElementById('e-nurse').value = profile.full_name||'';
  ['e-bps','e-bpd','e-hr','e-temp','e-spo2','e-rr','e-pain','e-fio2','e-peep','e-tv','e-rrs','e-pip','e-eye','e-verbal','e-motor','e-vaso','e-notes','e-iv','e-oral','e-urine','e-other'].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.value='';
  });
  document.getElementById('e-vent').value='no';
  document.getElementById('e-vmode').value='';
  document.getElementById('e-rass').value='';
  document.getElementById('gcs-total').textContent='—';
  document.getElementById('entry-modal').classList.add('show');
};

window.closeEntry = () => document.getElementById('entry-modal').classList.remove('show');

window.calcGCS = () => {
  const e = parseInt(document.getElementById('e-eye').value)||0;
  const v = parseInt(document.getElementById('e-verbal').value)||0;
  const m = parseInt(document.getElementById('e-motor').value)||0;
  const total = e+v+m;
  document.getElementById('gcs-total').textContent = total > 0 ? total+'/15' : '—';
};

window.saveEntry = async () => {
  const dt = document.getElementById('e-dt').value;
  if (!dt){showToast('Select date and time','error');return;}
  const onVent = document.getElementById('e-vent').value==='yes';

  const payload = {
    tenant_id:tenantId,
    patient_id:_currentAdm.patient?.id,
    ipd_id:_currentAdm.id,
    recorded_at:new Date(dt).toISOString(),
    bp_systolic:parseInt(document.getElementById('e-bps').value)||null,
    bp_diastolic:parseInt(document.getElementById('e-bpd').value)||null,
    heart_rate:parseInt(document.getElementById('e-hr').value)||null,
    temperature:parseFloat(document.getElementById('e-temp').value)||null,
    spo2:parseFloat(document.getElementById('e-spo2').value)||null,
    respiratory_rate:parseInt(document.getElementById('e-rr').value)||null,
    pain_score:parseInt(document.getElementById('e-pain').value)||null,
    on_ventilator:onVent,
    ventilator_mode:onVent?document.getElementById('e-vmode').value||null:null,
    fio2:onVent?parseInt(document.getElementById('e-fio2').value)||null:null,
    peep:onVent?parseInt(document.getElementById('e-peep').value)||null:null,
    tidal_volume:onVent?parseInt(document.getElementById('e-tv').value)||null:null,
    pip:onVent?parseInt(document.getElementById('e-pip').value)||null:null,
    gcs_eye:parseInt(document.getElementById('e-eye').value)||null,
    gcs_verbal:parseInt(document.getElementById('e-verbal').value)||null,
    gcs_motor:parseInt(document.getElementById('e-motor').value)||null,
    rass_score:document.getElementById('e-rass').value!==''?parseInt(document.getElementById('e-rass').value):null,
    vasopressor:document.getElementById('e-vaso').value.trim()||null,
    iv_fluid_in_ml:parseInt(document.getElementById('e-iv').value)||0,
    oral_in_ml:parseInt(document.getElementById('e-oral').value)||0,
    urine_out_ml:parseInt(document.getElementById('e-urine').value)||0,
    other_out_ml:parseInt(document.getElementById('e-other').value)||0,
    notes:document.getElementById('e-notes').value.trim()||null,
    recorded_by:profile.id
  };

  const {error} = await supabase.from('icu_flowsheets').insert(payload);
  if (error){showToast(safeErrorMessage(error, 'Could not save entry.'),'error');return;}
  closeEntry();
  showToast('Entry saved','success');
  loadFlowsheet();
};

function showToast(msg,type='success'){const t=document.getElementById('toast');t.textContent=msg;t.className=`toast ${type} show`;setTimeout(()=>t.classList.remove('show'),3000);}
function _esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

loadAdmissions();
