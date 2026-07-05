import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse','receptionist'], 'index.html');
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

// Default month = current
const now = new Date();
const monthStr = now.toISOString().slice(0,7);
document.getElementById('filter-month').value = monthStr;
document.getElementById('nd-date').value = now.toISOString().split('T')[0];
document.getElementById('nd-time').value = now.toTimeString().slice(0,5);

// Tab switching
document.querySelectorAll('.module-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.module-tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'partograph') loadPartographList();
    if (btn.dataset.tab === 'newborn')    loadNewborn();
    if (btn.dataset.tab === 'register')   loadRegister();
  });
});

window.loadAll = async function() { await Promise.all([loadStats(), loadRegister()]); };

document.getElementById('filter-month').addEventListener('change', loadAll);

let _allDeliveries = [];

async function loadStats() {
  const mStr = document.getElementById('filter-month').value || monthStr;
  const [y, m] = mStr.split('-').map(Number);
  const start = new Date(y, m-1, 1).toISOString();
  const end   = new Date(y, m, 0, 23, 59, 59).toISOString();
  const todayS = now.toISOString().split('T')[0] + 'T00:00:00';
  const todayE = now.toISOString().split('T')[0] + 'T23:59:59';

  const [mRes, tRes] = await Promise.all([
    supabase.from('deliveries').select('id,mode,sex,birth_weight_g,baby_outcome').eq('tenant_id',tenantId).gte('delivery_date',start).lte('delivery_date',end),
    supabase.from('deliveries').select('id').eq('tenant_id',tenantId).gte('delivery_date',todayS.split('T')[0]).lte('delivery_date',todayE.split('T')[0]),
  ]);
  const mData = mRes.data || [];
  const tData = tRes.data || [];
  const total = mData.length;
  const lscs  = mData.filter(d=>d.mode==='lscs').length;
  const girl  = mData.filter(d=>d.sex==='female').length;
  const weights = mData.filter(d=>d.birth_weight_g).map(d=>Number(d.birth_weight_g));
  const avgWt = weights.length ? Math.round(weights.reduce((a,b)=>a+b,0)/weights.length) : '—';
  document.getElementById('s-month').textContent  = total;
  document.getElementById('s-today').textContent  = tData.length;
  document.getElementById('s-lscs').textContent   = total > 0 ? Math.round(lscs/total*100)+'%' : '—';
  document.getElementById('s-girl').textContent   = girl;
  document.getElementById('s-weight').textContent = avgWt;
}

async function loadRegister() {
  const mStr = document.getElementById('filter-month').value || monthStr;
  const [y, m] = mStr.split('-').map(Number);
  const start = new Date(y, m-1, 1).toISOString().split('T')[0];
  const end   = new Date(y, m, 0).toISOString().split('T')[0];
  document.getElementById('register-title').textContent = 'Deliveries — ' + new Date(y, m-1, 1).toLocaleDateString('en-IN',{month:'long',year:'numeric'});

  const { data, error } = await supabase.from('deliveries')
    .select('*,patients(name,phone),profiles!admitted_doctor_id(full_name)')
    .eq('tenant_id',tenantId).gte('delivery_date',start).lte('delivery_date',end)
    .order('delivery_date',{ascending:false}).order('delivery_time',{ascending:false});

  const tbody = document.getElementById('register-tbody');
  if (error) {
    if (error.code==='42P01') {
      tbody.innerHTML='<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run the deliveries table SQL in Supabase to activate this module</div></div></td></tr>';
    } else {
      tbody.innerHTML=`<tr><td colspan="9"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load deliveries.'))}</div></div></td></tr>`;
    }
    return;
  }
  _allDeliveries = data || [];
  renderRegister();
}

window.renderRegister = function() {
  const mf = document.getElementById('filter-mode').value;
  const rows = _allDeliveries.filter(d => !mf || d.mode === mf);
  const tbody = document.getElementById('register-tbody');
  if (!rows.length) { tbody.innerHTML='<tr><td colspan="9"><div class="empty"><div class="empty-ico">🤱</div><div class="empty-ttl">No deliveries in this period</div></div></td></tr>'; return; }
  tbody.innerHTML = rows.map(d=>`<tr>
    <td>
      <div style="font-weight:600">${d.delivery_date}</div>
      <div style="font-size:11px;color:var(--text-muted)">${d.delivery_time||''}</div>
    </td>
    <td>
      <div style="font-weight:500">${_esc(d.patients?.name||'Unknown')}</div>
      <div style="font-size:11px;color:var(--text-muted)">${_esc(d.patients?.phone||'')}</div>
    </td>
    <td>${modeChip(d.mode)}</td>
    <td>${sexIcon(d.sex)}</td>
    <td>${d.birth_weight_g ? d.birth_weight_g + ' g' : '—'}</td>
    <td style="text-align:center">
      <span style="font-weight:700;color:${apgarColor(d.apgar_1min)}">${d.apgar_1min??'—'}</span> /
      <span style="font-weight:700;color:${apgarColor(d.apgar_5min)}">${d.apgar_5min??'—'}</span>
    </td>
    <td>${outcomeChip(d.baby_outcome)}</td>
    <td>${d.is_mlc ? `<span style="background:var(--red-light);color:var(--red);font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">MLC</span>` : '—'}</td>
    <td>
      <a href="anc.html?patient_id=${d.patient_id}" style="font-size:11px;color:var(--green-mid);text-decoration:none">ANC →</a>
    </td>
  </tr>`).join('');
};

// ─── New Delivery ─────────────────────────────────────────
window.openNewDelivery = function() {
  document.querySelectorAll('.module-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelector('.module-tab[data-tab="new"]').classList.add('active');
  document.getElementById('tab-new').classList.add('active');
};

let _ndPatientId = null;

window.searchMother = async function() {
  const q = document.getElementById('nd-search').value.trim();
  const res = document.getElementById('nd-results');
  if (q.length < 2) { res.style.display='none'; return; }
  const { data } = await supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId)
    .or(`phone.ilike.%${q}%,name.ilike.%${q}%`).limit(8);
  if (!data?.length) { res.style.display='none'; return; }
  res.style.display = 'block';
  res.innerHTML = data.map(p=>`<div class="search-result-item" data-onclick="selectMother" data-onclick-a0="${p.id}" data-onclick-a1="${_esc(p.name)}" data-onclick-a2="${_esc(p.phone||'')}">
    <strong>${_esc(p.name)}</strong><span style="color:var(--text-muted);font-size:12px;margin-left:6px">${_esc(p.phone||'')}</span>
  </div>`).join('');
};

window.selectMother = function(id, name, phone) {
  _ndPatientId = id;
  document.getElementById('nd-search').value = name + (phone ? ' · '+phone : '');
  document.getElementById('nd-results').style.display = 'none';
  const box = document.getElementById('nd-patient-box');
  box.style.display = '';
  box.innerHTML = `✓ Selected: <strong>${_esc(name)}</strong> ${phone ? '· '+_esc(phone) : ''}`;
};

window.calcAPGAR = function() {
  const sum = (prefix) => ['activity','pulse','grimace','appear','resp']
    .reduce((s,k) => s + parseInt(document.getElementById(`${prefix}-${k}`).value||0), 0);
  const s1 = sum('a1'), s5 = sum('a5');
  document.getElementById('apgar1-total').textContent = s1;
  document.getElementById('apgar5-total').textContent = s5;
  document.getElementById('apgar1-total').style.color = apgarColor(s1);
  document.getElementById('apgar5-total').style.color = apgarColor(s5);
};

window._toggleNicuReason = function(checked) {
  document.getElementById('nd-nicu-reason-row').style.display = checked ? '' : 'none';
};
window._toggleMlcExtra = function(checked) {
  document.getElementById('nd-mlc-extra').style.display = checked ? '' : 'none';
};

window.saveDelivery = async function() {
  const btn = document.getElementById('nd-save-btn');
  const date = document.getElementById('nd-date').value;
  const mode = document.getElementById('nd-mode').value;
  if (!date) { showAlert('new-alert','Delivery date is required','error'); return; }

  const a1 = parseInt(document.getElementById('apgar1-total').textContent) || 0;
  const a5 = parseInt(document.getElementById('apgar5-total').textContent) || 0;
  const isMLC = document.getElementById('nd-mlc').checked;
  btn.disabled = true;

  const payload = {
    tenant_id: tenantId, patient_id: _ndPatientId||null,
    admitted_doctor_id: document.getElementById('nd-doctor').value||null,
    delivery_date: date,
    delivery_time: document.getElementById('nd-time').value||null,
    mode, gestational_age: document.getElementById('nd-ga').value||null,
    duration_labour: document.getElementById('nd-labour-hrs').value||null,
    blood_loss_ml: document.getElementById('nd-blood-loss').value||null,
    presenting_part: document.getElementById('nd-present').value,
    episiotomy: document.getElementById('nd-episiotomy').value !== 'no',
    tear_degree: document.getElementById('nd-tear').value !== 'none' ? document.getElementById('nd-tear').value : null,
    placenta_delivery: document.getElementById('nd-placenta').value,
    complications: document.getElementById('nd-complications').value.trim()||null,
    birth_weight_g: document.getElementById('nd-weight').value||null,
    sex: document.getElementById('nd-sex').value,
    apgar_1min: a1, apgar_5min: a5,
    baby_outcome: document.getElementById('nd-baby-outcome').value,
    neonatal_resus:      document.getElementById('nd-resus').checked,
    oxygen_therapy:      document.getElementById('nd-oxygen')?.checked || false,
    phototherapy_hours:  parseFloat(document.getElementById('nd-phototherapy').value) || null,
    nicu_transfer:       document.getElementById('nd-nicu-transfer')?.checked || false,
    nicu_transfer_reason:document.getElementById('nd-nicu-reason')?.value.trim() || null,
    baby_notes: document.getElementById('nd-baby-notes').value.trim()||null,
    mother_outcome: document.getElementById('nd-mother-outcome').value,
    disposition: document.getElementById('nd-disposition').value.trim()||null,
    is_mlc: isMLC,
    mlc_number: isMLC ? document.getElementById('nd-mlc-no').value.trim()||null : null,
    notes: document.getElementById('nd-notes').value.trim()||null,
    created_by: profile.id,
  };

  const { error } = await supabase.from('deliveries').insert(payload);
  btn.disabled = false;
  if (error) {
    if (error.code==='42P01') { showAlert('new-alert','Run deliveries SQL in Supabase first','error'); }
    else { showAlert('new-alert', safeErrorMessage(error, 'Could not save delivery.'), 'error'); }
    return;
  }
  showAlert('new-alert','Delivery record saved successfully','success');
  resetNewDelivery();
  loadAll();
};

window.resetNewDelivery = function() {
  _ndPatientId = null;
  document.getElementById('nd-search').value = '';
  document.getElementById('nd-patient-box').style.display = 'none';
  document.getElementById('nd-results').style.display = 'none';
  document.getElementById('nd-complications').value = '';
  document.getElementById('nd-baby-notes').value = '';
  document.getElementById('nd-disposition').value = '';
  document.getElementById('nd-notes').value = '';
  document.getElementById('nd-weight').value = '';
  document.getElementById('nd-blood-loss').value = '';
  document.getElementById('nd-ga').value = '';
  document.getElementById('nd-labour-hrs').value = '';
  document.getElementById('nd-mlc').checked = false;
  document.getElementById('nd-mlc-no').value = '';
  document.getElementById('nd-mlc-nature').value = '';
  document.getElementById('nd-mlc-extra').style.display = 'none';
  document.getElementById('nd-resus').checked = false;
  ['a1','a5'].forEach(p => ['activity','pulse','grimace','appear','resp'].forEach(k => { document.getElementById(`${p}-${k}`).value='0'; }));
  calcAPGAR();
};

// ─── Partograph ───────────────────────────────────────────
let _selectedDeliveryId = null;

async function loadPartographList() {
  const { data, error } = await supabase.from('deliveries')
    .select('id,delivery_date,delivery_time,patients(name)')
    .eq('tenant_id',tenantId).order('delivery_date',{ascending:false}).limit(30);
  const wrap = document.getElementById('partograph-delivery-list');
  if (error || !data?.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-ico">🤱</div><div class="empty-ttl">No deliveries yet</div></div>'; return;
  }
  wrap.innerHTML = data.map(d=>`<div style="padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s" data-onclick="selectDeliveryForPartograph" data-onclick-a0="${d.id}" id="pd-${d.id}">
    <div style="font-weight:500;font-size:13px">${_esc(d.patients?.name||'Unknown')}</div>
    <div style="font-size:11px;color:var(--text-muted)">${d.delivery_date} ${d.delivery_time||''}</div>
  </div>`).join('');
}

window.selectDeliveryForPartograph = async function(id) {
  _selectedDeliveryId = id;
  document.querySelectorAll('[id^="pd-"]').forEach(el => el.style.background='');
  const el = document.getElementById('pd-'+id); if (el) el.style.background = 'var(--green-light)';
  await loadPartographEntries(id);
};

async function loadPartographEntries(delivId) {
  const main = document.getElementById('partograph-main');
  main.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div>';

  const { data, error } = await supabase.from('partograph_entries')
    .select('*').eq('delivery_id',delivId).order('recorded_at',{ascending:true});

  const formHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-hd"><span class="card-title">Add Partograph Observation</span></div>
      <div class="card-body">
        <div class="form-grid-4" style="margin-bottom:10px">
          <div class="form-group"><label class="form-label">Time</label><input type="time" class="form-control" id="pe-time"/></div>
          <div class="form-group"><label class="form-label">Cervix (cm)</label><input type="number" class="form-control" id="pe-cervix" min="0" max="10" step="0.5"/></div>
          <div class="form-group"><label class="form-label">Fetal Descent</label><select class="form-control" id="pe-descent"><option value="">—</option><option value="5/5">5/5</option><option value="4/5">4/5</option><option value="3/5">3/5</option><option value="2/5">2/5</option><option value="1/5">1/5</option><option value="0/5">0/5</option></select></div>
          <div class="form-group"><label class="form-label">FHR (bpm)</label><input type="number" class="form-control" id="pe-fhr" min="60" max="200"/></div>
        </div>
        <div class="form-grid-4" style="margin-bottom:10px">
          <div class="form-group"><label class="form-label">Contractions/10min</label><input type="number" class="form-control" id="pe-contrx" min="0" max="5"/></div>
          <div class="form-group"><label class="form-label">Contraction Duration</label><select class="form-control" id="pe-ctrx-dur"><option value="">—</option><option value="<20s">&lt;20s</option><option value="20-40s">20-40s</option><option value=">40s">&gt;40s</option></select></div>
          <div class="form-group"><label class="form-label">Liquor</label><select class="form-control" id="pe-liquor"><option value="">—</option><option value="I">I — Intact</option><option value="C">C — Clear</option><option value="M">M — Meconium</option><option value="B">B — Blood</option><option value="A">A — Absent</option></select></div>
          <div class="form-group"><label class="form-label">Moulding</label><select class="form-control" id="pe-mould"><option value="">—</option><option value="0">0 — None</option><option value="+">+ — Mild</option><option value="++">++ — Moderate</option><option value="+++">+++ — Severe</option></select></div>
        </div>
        <div class="form-grid-4" style="margin-bottom:10px">
          <div class="form-group"><label class="form-label">BP Sys</label><input type="number" class="form-control" id="pe-bp-s" placeholder="120"/></div>
          <div class="form-group"><label class="form-label">BP Dia</label><input type="number" class="form-control" id="pe-bp-d" placeholder="80"/></div>
          <div class="form-group"><label class="form-label">Pulse</label><input type="number" class="form-control" id="pe-pulse" placeholder="80"/></div>
          <div class="form-group"><label class="form-label">Temp (°C)</label><input type="number" class="form-control" id="pe-temp" step="0.1" placeholder="37.0"/></div>
        </div>
        <div class="form-grid" style="margin-bottom:12px">
          <div class="form-group"><label class="form-label">Urine Output</label><input class="form-control" id="pe-urine" placeholder="e.g. 50mL/hr, trace protein"/></div>
          <div class="form-group"><label class="form-label">Drugs / Oxytocin</label><input class="form-control" id="pe-drugs" placeholder="e.g. Oxytocin 5U in 500mL NS @ 8 drops/min"/></div>
        </div>
        <button class="btn btn-primary btn-sm" data-onclick="savePartographEntry" data-onclick-a0="${delivId}">Add Entry</button>
      </div>
    </div>`;

  if (error && error.code === '42P01') {
    main.innerHTML = formHTML + '<div class="card"><div class="card-body"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">Partograph entries SQL not yet run</div></div></div></div>';
    document.getElementById('pe-time').value = now.toTimeString().slice(0,5);
    return;
  }

  const entries = data || [];
  const tblRows = entries.length ? entries.map(e=>`<tr>
    <td style="font-weight:600">${e.recorded_at ? new Date(e.recorded_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}) : '—'}</td>
    <td class="part-cervix">${e.cervical_dilation_cm ?? '—'}</td>
    <td>${e.fetal_descent||'—'}</td>
    <td>${e.fhr||'—'}</td>
    <td>${e.contractions_per_10min||'—'}</td>
    <td>${e.contraction_duration_sec||'—'}</td>
    <td>${e.liquor||'—'}</td>
    <td>${e.moulding||'—'}</td>
    <td>${e.bp_systolic&&e.bp_diastolic ? e.bp_systolic+'/'+e.bp_diastolic : '—'}</td>
    <td>${e.pulse||'—'}</td>
    <td style="font-size:11px">${_esc(e.drugs_given||'—')}</td>
  </tr>`).join('') : '<tr><td colspan="11" style="text-align:center;color:var(--text-muted);padding:20px">No entries yet — add first observation above</td></tr>';

  main.innerHTML = formHTML + `
    <div class="card">
      <div class="card-hd"><span class="card-title">Partograph Entries</span><span style="font-size:12px;color:var(--text-muted)">${entries.length} observations</span></div>
      <div class="tw">
        <table class="partograph-tbl">
          <thead><tr><th>Time</th><th>Cervix (cm)</th><th>Descent</th><th>FHR</th><th>Ctrx/10min</th><th>Ctrx Duration</th><th>Liquor</th><th>Moulding</th><th>BP</th><th>Pulse</th><th>Drugs</th></tr></thead>
          <tbody>${tblRows}</tbody>
        </table>
      </div>
    </div>`;
  document.getElementById('pe-time').value = now.toTimeString().slice(0,5);
};

window.savePartographEntry = async function(delivId) {
  const payload = {
    delivery_id: delivId, tenant_id: tenantId,
    recorded_at: new Date().toISOString(),
    cervical_dilation_cm: document.getElementById('pe-cervix').value||null,
    fetal_descent:        document.getElementById('pe-descent').value||null,
    fhr:                  document.getElementById('pe-fhr').value||null,
    contractions_per_10min: document.getElementById('pe-contrx').value||null,
    contraction_duration_sec: document.getElementById('pe-ctrx-dur').value||null,
    liquor:    document.getElementById('pe-liquor').value||null,
    moulding:  document.getElementById('pe-mould').value||null,
    bp_systolic: document.getElementById('pe-bp-s').value||null,
    bp_diastolic: document.getElementById('pe-bp-d').value||null,
    pulse:     document.getElementById('pe-pulse').value||null,
    temperature: document.getElementById('pe-temp').value||null,
    urine_output: document.getElementById('pe-urine').value.trim()||null,
    drugs_given:  document.getElementById('pe-drugs').value.trim()||null,
    created_by: profile.id,
  };
  const { error } = await supabase.from('partograph_entries').insert(payload);
  if (error) { _toast(safeErrorMessage(error, 'Could not save partograph entry.'), true); return; }
  _toast('Entry saved');
  loadPartographEntries(delivId);
};

// ─── Newborn Register ────────────────────────────────────
let _newbornData = [];
async function loadNewborn() {
  const mStr = document.getElementById('filter-month').value || monthStr;
  const [y, m] = mStr.split('-').map(Number);
  const start = new Date(y, m-1, 1).toISOString().split('T')[0];
  const end   = new Date(y, m, 0).toISOString().split('T')[0];
  const { data, error } = await supabase.from('deliveries')
    .select('*,patients(name,phone)').eq('tenant_id',tenantId)
    .gte('delivery_date',start).lte('delivery_date',end)
    .order('delivery_date',{ascending:false});
  const tbody = document.getElementById('newborn-tbody');
  if (error) { tbody.innerHTML='<tr><td colspan="10"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div></td></tr>'; return; }
  _newbornData = data || [];
  if (!_newbornData.length) { tbody.innerHTML='<tr><td colspan="10"><div class="empty"><div class="empty-ico">👶</div><div class="empty-ttl">No deliveries in this period</div></div></td></tr>'; return; }
  tbody.innerHTML = _newbornData.map((d,i)=>`<tr>
    <td>${d.delivery_date}</td>
    <td>${_esc(d.patients?.name||'Unknown')}</td>
    <td>${modeChip(d.mode)}</td>
    <td>${sexIcon(d.sex)}</td>
    <td style="font-weight:600">${d.birth_weight_g ? d.birth_weight_g+' g' : '—'}</td>
    <td style="font-weight:700;color:${apgarColor(d.apgar_1min)}">${d.apgar_1min??'—'}</td>
    <td style="font-weight:700;color:${apgarColor(d.apgar_5min)}">${d.apgar_5min??'—'}</td>
    <td style="text-align:center">${d.neonatal_resus ? '⚠️ Yes' : '—'}</td>
    <td>${outcomeChip(d.baby_outcome)}</td>
    <td style="font-size:11px;color:var(--text-muted)">${_esc(d.baby_notes||'—')}</td>
  </tr>`).join('');
}

window.exportNewborn = function() {
  if (!_newbornData.length) return;
  const rows = [
    ['Date','Mother','Phone','Mode','Sex','Weight (g)','APGAR 1min','APGAR 5min','Resuscitation','Outcome','Baby Notes'],
    ..._newbornData.map(d=>[d.delivery_date, d.patients?.name||'', d.patients?.phone||'', d.mode||'',
      d.sex||'', d.birth_weight_g||'', d.apgar_1min??'', d.apgar_5min??'',
      d.neonatal_resus?'Yes':'No', d.baby_outcome||'', d.baby_notes||''])
  ];
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = 'Newborn_Register.csv'; a.click();
};

window.exportRegister = function() {
  if (!_allDeliveries.length) return;
  const rows = [
    ['Date','Time','Mother','Phone','Mode','Presenting Part','GA (wks)','Blood Loss (mL)','Baby Sex','Weight (g)','APGAR 1min','APGAR 5min','Resus','Baby Outcome','Mother Outcome','MLC','MLC No.','Notes'],
    ..._allDeliveries.map(d=>[d.delivery_date,d.delivery_time||'',d.patients?.name||'',d.patients?.phone||'',
      d.mode||'',d.presenting_part||'',d.gestational_age||'',d.blood_loss_ml||'',
      d.sex||'',d.birth_weight_g||'',d.apgar_1min??'',d.apgar_5min??'',
      d.neonatal_resus?'Yes':'No',d.baby_outcome||'',d.mother_outcome||'',
      d.is_mlc?'Yes':'No',d.mlc_number||'',d.notes||''])
  ];
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = 'Delivery_Register.csv'; a.click();
};

// ─── Doctor loader ───────────────────────────────────────
async function loadDoctors() {
  const { data } = await supabase.from('profiles').select('id,full_name').eq('tenant_id',tenantId)
    .in('role',['doctor','super_admin','dept_admin']).eq('is_active',true).order('full_name');
  const sel = document.getElementById('nd-doctor');
  sel.innerHTML = '<option value="">— Select —</option>' + (data||[]).map(d=>`<option value="${d.id}">${_esc(d.full_name)}</option>`).join('');
}

// ─── Helpers ─────────────────────────────────────────────
function modeChip(m) {
  const map = { normal:'<span class="chip-normal">Normal</span>', lscs:'<span class="chip-lscs">LSCS</span>',
    forceps:'<span style="background:var(--gold-light);color:#a06c0a;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600">Forceps</span>',
    vacuum: '<span style="background:var(--pink-light);color:var(--pink);padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600">Vacuum</span>' };
  return map[m] || m||'—';
}
function sexIcon(s) {
  return s==='female' ? '<span style="color:var(--pink);font-weight:600">♀ F</span>' : s==='male' ? '<span style="color:var(--blue);font-weight:600">♂ M</span>' : '—';
}
function outcomeChip(o) {
  if (o==='live_birth')  return '<span class="chip-live">Live Birth</span>';
  if (o==='stillbirth')  return '<span class="chip-still">Stillbirth</span>';
  if (o==='nnd')         return '<span class="chip-still">NND</span>';
  return o||'—';
}
function apgarColor(v) {
  if (v===null||v===undefined) return 'var(--text-muted)';
  if (v >= 7) return 'var(--green-mid)';
  if (v >= 4) return 'var(--gold)';
  return 'var(--red)';
}
function showAlert(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg; el.className = `alert ${type} show`;
  setTimeout(()=>el.classList.remove('show'), 4000);
}
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg,isErr=false){ const el=document.getElementById('toast'); el.textContent=msg; el.style.background=isErr?'#7f1d1d':'#1c2b1f'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

// Boot
await Promise.all([loadDoctors(), loadAll()]);
