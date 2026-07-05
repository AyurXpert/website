import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse','receptionist'], 'index.html');
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const now      = new Date();
const todayStr = now.toISOString().split('T')[0];

// Defaults
document.getElementById('d-date').value          = todayStr;
document.getElementById('daily-view-date').value = todayStr;
document.getElementById('p-date').value          = todayStr;
document.getElementById('t-date').value          = todayStr;
document.getElementById('p-time').value          = now.toTimeString().slice(0,5);
document.getElementById('t-start').value         = now.toTimeString().slice(0,5);
document.getElementById('summary-month').value   = todayStr.slice(0,7);

// Tab switching
document.querySelectorAll('.module-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.module-tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'pickup')    loadPickupTable();
    if (btn.dataset.tab === 'treatment') loadTreatmentTable();
  });
});

// ─── Shared: load departments ─────────────────────────────
async function loadDepts() {
  const { data } = await supabase.from('departments').select('id,name').eq('tenant_id',tenantId).eq('is_active',true).order('name');
  const sel = document.getElementById('d-dept');
  sel.innerHTML = '<option value="">— Select Department —</option>' +
    (data||[]).map(d=>`<option value="${d.id}">${_esc(d.name)}</option>`).join('');
}

// ─── Stats & Compliance ───────────────────────────────────
window.loadAll = async function() {
  await Promise.all([loadStats(), loadDailyTable(), loadComplianceBanner()]);
};

async function loadStats() {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const { data } = await supabase.from('bmw_daily_log').select('yellow_kg,red_kg,white_count,blue_kg')
    .eq('tenant_id',tenantId).gte('log_date',monthStart).lte('log_date',todayStr);
  if (!data) return;
  const sum = (key) => data.reduce((s,r)=>s+(Number(r[key])||0),0);
  const yellow = sum('yellow_kg'), red = sum('red_kg'), white = sum('white_count'), blue = sum('blue_kg');
  const total  = yellow + red + blue;
  document.getElementById('s-yellow').textContent = yellow.toFixed(1);
  document.getElementById('s-red').textContent    = red.toFixed(1);
  document.getElementById('s-white').textContent  = white;
  document.getElementById('s-blue').textContent   = blue.toFixed(1);
  document.getElementById('s-total').textContent  = total.toFixed(1) + ' kg';
}

async function loadComplianceBanner() {
  const banner = document.getElementById('compliance-banner');
  const { data } = await supabase.from('bmw_pickups').select('pickup_date').eq('tenant_id',tenantId)
    .order('pickup_date',{ascending:false}).limit(1);
  const lastPickup = data?.[0]?.pickup_date;
  if (!lastPickup) {
    banner.className = 'compliance-banner red';
    banner.innerHTML = `<div class="cb-icon">🚨</div><div class="cb-body"><div class="cb-title">No CBWTF pickup recorded</div><div class="cb-sub">BMW Rules 2016 Rule 8(4): Bio-medical waste must be handed to CBWTF. Storage ≤48 hours at source. Log the first pickup immediately.</div></div>`;
    return;
  }
  const daysSince = Math.floor((now - new Date(lastPickup)) / 86400000);
  if (daysSince <= 1) {
    banner.className = 'compliance-banner green';
    banner.innerHTML = `<div class="cb-icon">✅</div><div class="cb-body"><div class="cb-title">CBWTF pickup current — last collected ${daysSince === 0 ? 'today' : 'yesterday'} (${lastPickup})</div><div class="cb-sub">BMW Rules 2016 48-hour storage limit compliant.</div></div>`;
  } else if (daysSince <= 2) {
    banner.className = 'compliance-banner amber';
    banner.innerHTML = `<div class="cb-icon">⚠️</div><div class="cb-body"><div class="cb-title">CBWTF pickup ${daysSince} days ago (${lastPickup}) — approaching 48-hour limit</div><div class="cb-sub">Schedule CBWTF pickup today to remain compliant with BMW Rules 2016 Rule 8(4).</div></div>`;
  } else {
    banner.className = 'compliance-banner red';
    banner.innerHTML = `<div class="cb-icon">🚨</div><div class="cb-body"><div class="cb-title">CBWTF pickup OVERDUE — last pickup ${daysSince} days ago (${lastPickup})</div><div class="cb-sub">BMW Rules 2016 violation: waste stored beyond 48 hours. Contact CBWTF immediately and log the pickup.</div></div>`;
  }
}

// ─── Daily Log ────────────────────────────────────────────
window.saveDailyLog = async function() {
  const btn = document.getElementById('d-save-btn');
  const date = document.getElementById('d-date').value;
  if (!date) { showAlert('daily-alert','Date is required','error'); return; }
  btn.disabled = true;
  const { error } = await supabase.from('bmw_daily_log').insert({
    tenant_id:   tenantId,
    recorded_by: profile.id,
    log_date:    date,
    department_id: document.getElementById('d-dept').value || null,
    yellow_kg:   parseFloat(document.getElementById('d-yellow').value) || 0,
    red_kg:      parseFloat(document.getElementById('d-red').value) || 0,
    white_count: parseInt(document.getElementById('d-white').value) || 0,
    blue_kg:     parseFloat(document.getElementById('d-blue').value) || 0,
    collection_time: document.getElementById('d-time').value || null,
    storage_hours:   parseInt(document.getElementById('d-storage').value) || null,
    remarks:     document.getElementById('d-remarks').value.trim() || null,
  });
  btn.disabled = false;
  if (error) {
    if (error.code==='42P01') showAlert('daily-alert','Run bmw_daily_log SQL in Supabase first','error');
    else showAlert('daily-alert', error.message,'error');
    return;
  }
  showAlert('daily-alert','Entry saved ✓','success');
  ['d-yellow','d-red','d-white','d-blue','d-time','d-storage','d-remarks'].forEach(id=>{document.getElementById(id).value='';});
  loadDailyTable(); loadStats(); loadComplianceBanner();
};

let _dailyData = [];
window.loadDailyTable = async function() {
  const date  = document.getElementById('daily-view-date').value || todayStr;
  const tbody = document.getElementById('daily-tbody');
  document.getElementById('daily-table-title').textContent = date === todayStr ? "Today's BMW Log" : 'BMW Log — ' + date;
  tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div></td></tr>';
  const { data, error } = await supabase.from('bmw_daily_log').select('*,departments(name)').eq('tenant_id',tenantId).eq('log_date',date).order('created_at',{ascending:false});
  if (error) {
    if (error.code==='42P01') tbody.innerHTML='<tr><td colspan="7"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run bmw_daily_log SQL in Supabase</div></div></td></tr>';
    else tbody.innerHTML=`<tr><td colspan="7"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(error.message)}</div></div></td></tr>`;
    return;
  }
  _dailyData = data || [];
  if (!_dailyData.length) { tbody.innerHTML='<tr><td colspan="7"><div class="empty"><div class="empty-ico">♻</div><div class="empty-ttl">No entries for this date</div></div></td></tr>'; return; }
  let totalY=0,totalR=0,totalW=0,totalB=0;
  tbody.innerHTML = _dailyData.map(r=>{
    totalY+=Number(r.yellow_kg||0); totalR+=Number(r.red_kg||0); totalW+=Number(r.white_count||0); totalB+=Number(r.blue_kg||0);
    const storageWarn = r.storage_hours > 24 ? 'color:var(--bmw-red);font-weight:700' : '';
    return `<tr>
      <td style="font-weight:500">${_esc(r.departments?.name||'—')}</td>
      <td style="background:var(--bmw-yellow-bg);color:var(--bmw-yellow);font-weight:600;text-align:center">${r.yellow_kg||'—'}</td>
      <td style="background:var(--bmw-red-bg);color:var(--bmw-red);font-weight:600;text-align:center">${r.red_kg||'—'}</td>
      <td style="background:var(--bmw-white-bg);color:var(--bmw-white);font-weight:600;text-align:center">${r.white_count||'—'}</td>
      <td style="background:var(--bmw-blue-bg);color:var(--bmw-blue);font-weight:600;text-align:center">${r.blue_kg||'—'}</td>
      <td style="font-size:12px">${r.collection_time||'—'}</td>
      <td style="${storageWarn};font-size:12px">${r.storage_hours!=null?r.storage_hours+'h':'—'}${r.storage_hours>24?' ⚠':''}${r.storage_hours>48?' 🚨':''}</td>
    </tr>`;
  }).join('') + `<tr style="background:#f0f9f4;font-weight:700">
    <td>TOTAL</td>
    <td style="background:var(--bmw-yellow-bg);color:var(--bmw-yellow);text-align:center">${totalY.toFixed(1)} kg</td>
    <td style="background:var(--bmw-red-bg);color:var(--bmw-red);text-align:center">${totalR.toFixed(1)} kg</td>
    <td style="background:var(--bmw-white-bg);color:var(--bmw-white);text-align:center">${totalW}</td>
    <td style="background:var(--bmw-blue-bg);color:var(--bmw-blue);text-align:center">${totalB.toFixed(1)} kg</td>
    <td colspan="2" style="font-size:11px;color:var(--text-muted)">Total: ${(totalY+totalR+totalB).toFixed(1)} kg + ${totalW} sharps</td>
  </tr>`;
};

window.exportDailyCSV = function() {
  if (!_dailyData.length) { _toast('No data'); return; }
  const rows=[['Date','Department','Yellow (kg)','Red (kg)','White (count)','Blue (kg)','Collection Time','Storage (h)','Remarks'],
    ..._dailyData.map(r=>[r.log_date,r.departments?.name||'',r.yellow_kg||0,r.red_kg||0,r.white_count||0,r.blue_kg||0,r.collection_time||'',r.storage_hours||'',r.remarks||''])];
  _downloadCSV(rows,'BMW_Daily_Log_'+(_dailyData[0]?.log_date||todayStr)+'.csv');
};

// ─── CBWTF Pickup ─────────────────────────────────────────
let _pickupData = [];
window.savePickup = async function() {
  const btn  = document.getElementById('p-save-btn');
  const manifest = document.getElementById('p-manifest').value.trim();
  if (!manifest) { showAlert('pickup-alert','Manifest number is required (BMW Rules 2016 Rule 8(4))','error'); return; }
  btn.disabled = true;
  const y=parseFloat(document.getElementById('p-yellow').value)||0, r=parseFloat(document.getElementById('p-red').value)||0;
  const w=parseFloat(document.getElementById('p-white').value)||0,  b=parseFloat(document.getElementById('p-blue').value)||0;
  const { error } = await supabase.from('bmw_pickups').insert({
    tenant_id:   tenantId, recorded_by: profile.id,
    pickup_date: document.getElementById('p-date').value,
    pickup_time: document.getElementById('p-time').value || null,
    cbwtf_name:  document.getElementById('p-agency').value.trim()||null,
    vehicle_no:  document.getElementById('p-vehicle').value.trim()||null,
    driver_name: document.getElementById('p-driver').value.trim()||null,
    manifest_no: manifest,
    receipt_no:  document.getElementById('p-receipt').value.trim()||null,
    yellow_kg:y, red_kg:r, white_kg:w, blue_kg:b,
    total_kg:parseFloat((y+r+w+b).toFixed(2)),
    remarks: document.getElementById('p-remarks').value.trim()||null,
  });
  btn.disabled = false;
  if (error) {
    if (error.code==='42P01') showAlert('pickup-alert','Run bmw_pickups SQL in Supabase first','error');
    else showAlert('pickup-alert', error.message,'error');
    return;
  }
  showAlert('pickup-alert','Pickup logged ✓','success');
  ['p-agency','p-vehicle','p-driver','p-manifest','p-receipt','p-yellow','p-red','p-white','p-blue','p-remarks'].forEach(id=>{document.getElementById(id).value='';});
  loadPickupTable(); loadComplianceBanner();
};

async function loadPickupTable() {
  const tbody = document.getElementById('pickup-tbody');
  const { data, error } = await supabase.from('bmw_pickups').select('*').eq('tenant_id',tenantId).order('pickup_date',{ascending:false}).limit(50);
  if (error) {
    if (error.code==='42P01') tbody.innerHTML='<tr><td colspan="8"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div></td></tr>';
    else tbody.innerHTML=`<tr><td colspan="8"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(error.message)}</div></div></td></tr>`;
    return;
  }
  _pickupData = data || [];
  if (!_pickupData.length) { tbody.innerHTML='<tr><td colspan="8"><div class="empty"><div class="empty-ico">🚛</div><div class="empty-ttl">No pickups logged yet</div></div></td></tr>'; return; }
  tbody.innerHTML = _pickupData.map(r=>`<tr>
    <td style="font-weight:600">${r.pickup_date}<br><span style="font-size:11px;color:var(--text-muted)">${r.pickup_time||''}</span></td>
    <td style="font-size:12px">${_esc(r.cbwtf_name||'—')}</td>
    <td style="font-size:12px">${_esc(r.vehicle_no||'—')}</td>
    <td style="font-size:12px;font-weight:600">${_esc(r.manifest_no||'—')}</td>
    <td style="background:var(--bmw-yellow-bg);color:var(--bmw-yellow);text-align:center;font-weight:600">${r.yellow_kg||'—'}</td>
    <td style="background:var(--bmw-red-bg);color:var(--bmw-red);text-align:center;font-weight:600">${r.red_kg||'—'}</td>
    <td style="background:var(--bmw-white-bg);color:var(--bmw-white);text-align:center;font-weight:600">${r.white_kg||'—'}</td>
    <td style="background:var(--bmw-blue-bg);color:var(--bmw-blue);text-align:center;font-weight:600">${r.blue_kg||'—'}</td>
  </tr>`).join('');
}

window.exportPickupCSV = function() {
  const rows=[['Date','Time','CBWTF Agency','Vehicle','Manifest','Receipt','Yellow(kg)','Red(kg)','Sharps(kg)','Blue(kg)','Total(kg)','Remarks'],
    ..._pickupData.map(r=>[r.pickup_date,r.pickup_time||'',r.cbwtf_name||'',r.vehicle_no||'',r.manifest_no||'',r.receipt_no||'',r.yellow_kg||0,r.red_kg||0,r.white_kg||0,r.blue_kg||0,r.total_kg||0,r.remarks||''])];
  _downloadCSV(rows,'BMW_CBWTF_Pickup_Register.csv');
};

// ─── Treatment Log ────────────────────────────────────────
let _treatData = [];
window.saveTreatment = async function() {
  const btn = document.getElementById('t-save-btn');
  btn.disabled = true;
  const { error } = await supabase.from('bmw_treatment_log').insert({
    tenant_id:   tenantId, recorded_by: profile.id,
    treatment_date: document.getElementById('t-date').value,
    treatment_type: document.getElementById('t-type').value,
    equipment_id:   document.getElementById('t-equip').value.trim()||null,
    cycle_no:       parseInt(document.getElementById('t-cycle').value)||null,
    waste_category: document.getElementById('t-cat').value,
    start_time:     document.getElementById('t-start').value||null,
    end_time:       document.getElementById('t-end').value||null,
    temperature_c:  parseFloat(document.getElementById('t-temp').value)||null,
    pressure_psi:   parseFloat(document.getElementById('t-pressure').value)||null,
    duration_min:   parseInt(document.getElementById('t-duration').value)||null,
    weight_kg:      parseFloat(document.getElementById('t-weight').value)||null,
    biological_indicator: document.getElementById('t-bi').value,
    operator_name:  document.getElementById('t-operator').value.trim()||null,
    remarks:        document.getElementById('t-remarks').value.trim()||null,
  });
  btn.disabled = false;
  if (error) {
    if (error.code==='42P01') showAlert('treat-alert','Run bmw_treatment_log SQL in Supabase first','error');
    else showAlert('treat-alert', error.message,'error');
    return;
  }
  showAlert('treat-alert','Treatment cycle recorded ✓','success');
  ['t-equip','t-cycle','t-start','t-end','t-temp','t-pressure','t-duration','t-weight','t-operator','t-remarks'].forEach(id=>{document.getElementById(id).value='';});
  loadTreatmentTable();
};

async function loadTreatmentTable() {
  const tbody = document.getElementById('treatment-tbody');
  const { data, error } = await supabase.from('bmw_treatment_log').select('*').eq('tenant_id',tenantId).order('treatment_date',{ascending:false}).order('created_at',{ascending:false}).limit(50);
  if (error) {
    if (error.code==='42P01') tbody.innerHTML='<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div></td></tr>';
    else tbody.innerHTML=`<tr><td colspan="9"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(error.message)}</div></div></td></tr>`;
    return;
  }
  _treatData = data || [];
  if (!_treatData.length) { tbody.innerHTML='<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔬</div><div class="empty-ttl">No treatment cycles logged yet</div></div></td></tr>'; return; }
  const biCls = {pass:'bi-pass',fail:'bi-fail',pending:'bi-pending',not_done:''};
  tbody.innerHTML = _treatData.map(r=>`<tr>
    <td style="font-weight:600;white-space:nowrap">${r.treatment_date}</td>
    <td style="font-size:12px;font-weight:500">${_typeLabel(r.treatment_type)}</td>
    <td style="font-size:12px">${_esc(r.equipment_id||'—')}</td>
    <td style="text-align:center">${r.cycle_no||'—'}</td>
    <td><span class="cat-badge ${_esc(r.waste_category)}">${_esc(r.waste_category||'—')}</span></td>
    <td style="font-size:12px">${r.temperature_c!=null?r.temperature_c+'°C':'—'} ${r.pressure_psi!=null?'/ '+r.pressure_psi+' psi':''}</td>
    <td style="text-align:center">${r.duration_min!=null?r.duration_min+' min':'—'}</td>
    <td style="text-align:center">${r.weight_kg!=null?r.weight_kg+' kg':'—'}</td>
    <td class="${biCls[r.biological_indicator]||''}">${_biLabel(r.biological_indicator)}</td>
  </tr>`).join('');
}

window.exportTreatmentCSV = function() {
  const rows=[['Date','Type','Equipment','Cycle','Category','Temp(°C)','Pressure(psi)','Duration(min)','Weight(kg)','BI Result','Operator','Remarks'],
    ..._treatData.map(r=>[r.treatment_date,r.treatment_type||'',r.equipment_id||'',r.cycle_no||'',r.waste_category||'',r.temperature_c||'',r.pressure_psi||'',r.duration_min||'',r.weight_kg||'',r.biological_indicator||'',r.operator_name||'',r.remarks||''])];
  _downloadCSV(rows,'BMW_Treatment_Log.csv');
};

// ─── Monthly Summary ──────────────────────────────────────
let _summaryData = null;
window.loadMonthlySummary = async function() {
  const m = document.getElementById('summary-month').value;
  if (!m) return;
  const [y, mo] = m.split('-').map(Number);
  const start = new Date(y, mo-1, 1).toISOString().split('T')[0];
  const end   = new Date(y, mo, 0).toISOString().split('T')[0];
  const label = new Date(y, mo-1, 1).toLocaleDateString('en-IN',{month:'long',year:'numeric'});
  const body  = document.getElementById('summary-body');
  body.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Generating…</div></div>';

  const [logRes, pickRes, treatRes] = await Promise.all([
    supabase.from('bmw_daily_log').select('yellow_kg,red_kg,white_count,blue_kg,log_date').eq('tenant_id',tenantId).gte('log_date',start).lte('log_date',end),
    supabase.from('bmw_pickups').select('yellow_kg,red_kg,white_kg,blue_kg,total_kg,manifest_no,pickup_date').eq('tenant_id',tenantId).gte('pickup_date',start).lte('pickup_date',end),
    supabase.from('bmw_treatment_log').select('weight_kg,treatment_type,waste_category').eq('tenant_id',tenantId).gte('treatment_date',start).lte('treatment_date',end),
  ]);

  if (logRes.error && logRes.error.code === '42P01') {
    body.innerHTML='<div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run BMW SQL tables in Supabase first</div></div>';
    return;
  }

  const logs   = logRes.data  || [];
  const picks  = pickRes.data || [];
  const treats = treatRes.data || [];

  const sum = (arr,key) => arr.reduce((s,r)=>s+(Number(r[key])||0),0);
  const genY = sum(logs,'yellow_kg'), genR = sum(logs,'red_kg'), genW = sum(logs,'white_count'), genB = sum(logs,'blue_kg');
  const picY = sum(picks,'yellow_kg'), picR = sum(picks,'red_kg'), picW = sum(picks,'white_kg'), picB = sum(picks,'blue_kg');
  const totalGen = genY+genR+genB, totalPic = sum(picks,'total_kg');
  const treatWt = sum(treats,'weight_kg');
  const daysInMonth = new Date(y, mo, 0).getDate();

  _summaryData = { label, y, mo, start, end, genY, genR, genW, genB, picY, picR, picW, picB, totalGen, totalPic, picks, treats, logs };

  body.innerHTML = `
    <div style="background:var(--green-deep);color:#fff;border-radius:var(--radius);padding:14px 18px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:600">BMW Monthly Summary — ${_esc(label)}</div>
        <div style="font-size:11px;opacity:.6;margin-top:2px">${daysInMonth}-day month · ${logs.length} daily entries · ${picks.length} CBWTF pickups</div>
      </div>
      <div style="font-size:11px;opacity:.6">Report due: 10th of next month (SPCB)</div>
    </div>

    <!-- Generation by category -->
    <div class="month-grid">
      <div class="month-cat-card" style="background:var(--bmw-yellow-bg);border-color:var(--bmw-yellow-border);color:var(--bmw-yellow)">
        <div class="month-cat-val">${genY.toFixed(2)}</div>
        <div class="month-cat-lbl">🟡 Yellow (kg)</div>
        <div class="month-cat-sub">Picked: ${picY.toFixed(2)} kg · Balance: ${(genY-picY).toFixed(2)} kg</div>
      </div>
      <div class="month-cat-card" style="background:var(--bmw-red-bg);border-color:var(--bmw-red-border);color:var(--bmw-red)">
        <div class="month-cat-val">${genR.toFixed(2)}</div>
        <div class="month-cat-lbl">🔴 Red (kg)</div>
        <div class="month-cat-sub">Picked: ${picR.toFixed(2)} kg · Balance: ${(genR-picR).toFixed(2)} kg</div>
      </div>
      <div class="month-cat-card" style="background:var(--bmw-white-bg);border-color:var(--bmw-white-border);color:var(--bmw-white)">
        <div class="month-cat-val">${genW}</div>
        <div class="month-cat-lbl">⬜ Sharps (count)</div>
        <div class="month-cat-sub">Picked: ${picW.toFixed(2)} kg (by weight)</div>
      </div>
      <div class="month-cat-card" style="background:var(--bmw-blue-bg);border-color:var(--bmw-blue-border);color:var(--bmw-blue)">
        <div class="month-cat-val">${genB.toFixed(2)}</div>
        <div class="month-cat-lbl">🔵 Blue (kg)</div>
        <div class="month-cat-sub">Picked: ${picB.toFixed(2)} kg · Balance: ${(genB-picB).toFixed(2)} kg</div>
      </div>
    </div>

    <!-- Pickup & Treatment summary -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div class="card">
        <div class="card-hd"><span class="card-title">CBWTF Pickups This Month</span></div>
        <div class="card-body" style="padding:12px 16px">
          <div style="font-size:28px;font-weight:700;color:var(--green-deep);font-family:'Cormorant Garamond',serif">${picks.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">Total collected: ${totalPic.toFixed(2)} kg</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Manifests: ${picks.map(p=>_esc(p.manifest_no||'—')).join(', ')||'None'}</div>
          ${picks.length === 0 ? '<div style="color:var(--bmw-red);font-size:12px;margin-top:6px;font-weight:600">⚠ No CBWTF pickup this month — potential BMW Rules violation</div>' : ''}
        </div>
      </div>
      <div class="card">
        <div class="card-hd"><span class="card-title">On-site Treatment This Month</span></div>
        <div class="card-body" style="padding:12px 16px">
          <div style="font-size:28px;font-weight:700;color:var(--green-deep);font-family:'Cormorant Garamond',serif">${treats.length}</div>
          <div style="font-size:12px;color:var(--text-muted)">Total treated: ${treatWt.toFixed(2)} kg</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Types: ${[...new Set(treats.map(t=>_typeLabel(t.treatment_type)))].join(', ')||'None'}</div>
        </div>
      </div>
    </div>

    <div style="background:var(--gold-light);border:1.5px solid #e8c060;border-radius:var(--radius);padding:12px 16px;font-size:12px;color:#5a3a00">
      <strong>SPCB Monthly Report Checklist:</strong> Submit by 10th of next month · Include daily generation totals by category · Attach CBWTF manifests · Include autoclave log · Signed by BMW Officer / Medical Superintendent
    </div>`;

  document.getElementById('summary-csv-btn').style.display = '';
};

window.exportSummaryCSV = function() {
  if (!_summaryData) return;
  const { label, genY, genR, genW, genB, picY, picR, picW, picB, totalGen, totalPic } = _summaryData;
  const rows=[
    ['BMW Monthly Report — '+label],[''],
    ['Category','Generated','Collected by CBWTF','Balance'],
    ['Yellow (kg)', genY.toFixed(2), picY.toFixed(2), (genY-picY).toFixed(2)],
    ['Red (kg)',    genR.toFixed(2), picR.toFixed(2), (genR-picR).toFixed(2)],
    ['Sharps (#)',  genW, '—','—'],
    ['Blue (kg)',   genB.toFixed(2), picB.toFixed(2), (genB-picB).toFixed(2)],
    ['TOTAL (kg)', totalGen.toFixed(2), totalPic.toFixed(2), (totalGen-totalPic).toFixed(2)],
  ];
  _downloadCSV(rows, 'BMW_Monthly_Report_'+label.replace(' ','_')+'.csv');
};

// ─── Helpers ─────────────────────────────────────────────
function _typeLabel(t){ const m={autoclave:'Autoclave',microwave:'Microwave',dry_heat:'Dry Heat',chemical:'Chemical',incineration:'Incineration',deep_burial:'Deep Burial'}; return _esc(m[t]||t||'—'); }
function _biLabel(v){ const m={pass:'✓ Pass',fail:'✗ FAIL',pending:'Pending',not_done:'—'}; return _esc(m[v]||v||'—'); }
function showAlert(id,msg,type){ const el=document.getElementById(id); el.textContent=msg; el.className=`alert ${type} show`; setTimeout(()=>el.classList.remove('show'),4000); }
function _downloadCSV(rows, filename) {
  const csv = rows.map(r=>Array.isArray(r)?r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','):`"${r}"`).join('\n');
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv); a.download=filename; a.click();
}
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg,isErr=false){ const el=document.getElementById('toast'); el.textContent=msg; el.style.background=isErr?'#7f1d1d':'#1c2b1f'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

// Boot
await Promise.all([loadDepts(), loadAll()]);
