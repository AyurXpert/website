import { requireAuth, getCurrentProfile, getCurrentTenantId, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

await requireAuth(['super_admin','dept_admin','doctor','nurse','receptionist'], 'index.html');
initNavbar();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const role     = getCurrentRole();

// Default date = today
const todayStr = new Date().toISOString().split('T')[0];
document.getElementById('filter-date').value = todayStr;
document.getElementById('rmo-date').value = todayStr;

// Set current time for new case
const nowTime = new Date().toTimeString().slice(0,5);
document.getElementById('nc-time').value = nowTime;
document.getElementById('rmo-start').value = nowTime;

// Tab switching
document.querySelectorAll('.module-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.module-tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'rmo')  loadDutyLog();
    if (btn.dataset.tab === 'obs')  loadObsBeds();
    if (btn.dataset.tab === 'mlc')  loadMLC();
    if (btn.dataset.tab === 'bls')  loadBLS();
  });
});

// Obs bed checkbox toggle
document.getElementById('nc-obs').addEventListener('change', function() {
  document.getElementById('nc-obs-bed').style.display = this.checked ? '' : 'none';
});

window.loadAll = async function() {
  await Promise.all([loadStats(), loadCases(), loadRMOBanner()]);
};

// Date filter
document.getElementById('filter-date').addEventListener('change', loadAll);

window._allCases = [];

async function loadStats() {
  const dateStr = document.getElementById('filter-date').value || todayStr;
  const start = dateStr + 'T00:00:00';
  const end   = dateStr + 'T23:59:59';
  const { data } = await supabase.from('emergency_cases').select('id,status,is_mlc,is_obs_bed').eq('tenant_id',tenantId).gte('arrival_time',start).lte('arrival_time',end);
  if (!data) { showStatsError(); return; }
  const total    = data.length;
  const active   = data.filter(c=>c.status==='active').length;
  const obs      = data.filter(c=>c.status==='observation'||c.is_obs_bed).length;
  const admitted = data.filter(c=>c.status==='admitted').length;
  const mlc      = data.filter(c=>c.is_mlc).length;
  document.getElementById('s-total').textContent    = total;
  document.getElementById('s-active').textContent   = active;
  document.getElementById('s-obs').textContent      = obs;
  document.getElementById('s-admitted').textContent = admitted;
  document.getElementById('s-mlc').textContent      = mlc;
}

function showStatsError() {
  ['s-total','s-active','s-obs','s-admitted','s-mlc'].forEach(id => document.getElementById(id).textContent = '—');
}

async function loadCases() {
  const dateStr = document.getElementById('filter-date').value || todayStr;
  const start = dateStr + 'T00:00:00', end = dateStr + 'T23:59:59';
  document.getElementById('cases-title').textContent = dateStr === todayStr ? "Today's Cases" : 'Cases — ' + dateStr;

  const { data, error } = await supabase.from('emergency_cases')
    .select('*,patients(name,phone),profiles!rmo_id(full_name)')
    .eq('tenant_id',tenantId).gte('arrival_time',start).lte('arrival_time',end)
    .order('arrival_time',{ascending:false});

  if (error) {
    const tbody = document.getElementById('cases-tbody');
    if (error.code === '42P01') {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run the emergency_cases SQL in Supabase to activate this module</div></div></td></tr>`;
    } else {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load data.'))}</div></div></td></tr>`;
    }
    return;
  }
  window._allCases = data || [];
  renderCases();
}

window.renderCases = function() {
  const tf = document.getElementById('filter-triage').value;
  const sf = document.getElementById('filter-status').value;
  let cases = window._allCases.filter(c =>
    (!tf || c.triage_category === tf) && (!sf || c.status === sf)
  );
  const tbody = document.getElementById('cases-tbody');
  if (!cases.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><div class="empty-ico">🏥</div><div class="empty-ttl">No cases found</div></div></td></tr>';
    return;
  }
  tbody.innerHTML = cases.map(c => {
    const time = c.arrival_time ? new Date(c.arrival_time).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}) : '—';
    const pat  = c.patients?.name || 'Unknown';
    const phone = c.patients?.phone ? ` · ${c.patients.phone}` : '';
    const { label:tLabel, cls:tCls } = triageInfo(c.triage_category);
    const sChip = statusChip(c.status);
    const mlcTag = c.is_mlc ? `<span class="mlc-badge">MLC ${c.mlc_number ? '#'+_esc(c.mlc_number) : ''}</span>` : '—';
    return `<tr>
      <td style="font-weight:600">${time}</td>
      <td><div style="font-weight:500">${_esc(pat)}</div><div style="font-size:11px;color:var(--text-muted)">${_esc(phone)}</div></td>
      <td><span class="triage-chip triage-${c.triage_category}">${tLabel}</span></td>
      <td style="max-width:220px;font-size:12px">${_esc(c.chief_complaint||'—')}</td>
      <td>${sChip}</td>
      <td>${mlcTag}</td>
      <td><button class="btn btn-secondary btn-sm" data-onclick="openUpdateModal" data-onclick-a0="${_esc(c.id)}" data-onclick-a1="${_esc(c.status)}">Update</button></td>
    </tr>`;
  }).join('');
};

async function loadRMOBanner() {
  const todayDate = new Date().toISOString().split('T')[0];
  const h = new Date().getHours();
  const shift = h < 14 ? 'Morning' : h < 20 ? 'Evening' : 'Night';
  const { data } = await supabase.from('emergency_duty_log')
    .select('rmo_id,profiles!rmo_id(full_name)')
    .eq('tenant_id',tenantId).eq('duty_date',todayDate).eq('shift',shift)
    .order('created_at',{ascending:false}).limit(1).maybeSingle();
  if (data?.profiles?.full_name) {
    document.getElementById('rmo-on-duty-banner').textContent = `RMO (${shift}): Dr. ${data.profiles.full_name}`;
  } else {
    document.getElementById('rmo-on-duty-banner').textContent = `No RMO logged for ${shift} shift`;
  }
}

// ─── New Case ────────────────────────────────────────────
window.openNewCase = function() {
  document.getElementById('new-case-card').style.display = '';
  document.getElementById('nc-search').focus();
};
window.closeNewCase = function() {
  document.getElementById('new-case-card').style.display = 'none';
  resetNewCase();
};

let _ncPatientId = null;

window.searchPatients = async function() {
  const q = document.getElementById('nc-search').value.trim();
  const res = document.getElementById('nc-results');
  if (q.length < 2) { res.style.display = 'none'; return; }
  const { data } = await supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId)
    .or(`phone.ilike.%${q}%,name.ilike.%${q}%`).limit(8);
  if (!data?.length) { res.style.display = 'none'; return; }
  res.style.display = '';
  res.innerHTML = data.map(p => `<div class="search-result-item" data-onclick="selectPatient" data-onclick-a0="${_esc(p.id)}" data-onclick-a1="${_esc(p.name)}" data-onclick-a2="${_esc(p.phone||'')}">
    <strong>${_esc(p.name)}</strong><span style="color:var(--text-muted);font-size:12px;margin-left:6px">${_esc(p.phone||'')}</span>
  </div>`).join('');
};

window.selectPatient = function(id, name, phone) {
  _ncPatientId = id;
  document.getElementById('nc-search').value = name + (phone ? ' · ' + phone : '');
  document.getElementById('nc-results').style.display = 'none';
  const box = document.getElementById('nc-patient-box');
  box.style.display = '';
  box.innerHTML = `✓ Selected: <strong>${_esc(name)}</strong> ${phone ? '· ' + _esc(phone) : ''}`;
};

window.toggleMLC = function(on) {
  document.getElementById('mlc-extra').style.display = on ? '' : 'none';
};

window.saveCase = async function() {
  const btn = document.getElementById('nc-save-btn');
  const triage    = document.getElementById('nc-triage').value;
  const complaint = document.getElementById('nc-complaint').value.trim();
  const timeVal   = document.getElementById('nc-time').value;
  const isMLC     = document.getElementById('nc-mlc').checked;
  const isObs     = document.getElementById('nc-obs').checked;

  if (!complaint) { showAlert('case-alert','Chief complaint is required','error'); return; }

  const dateStr = document.getElementById('filter-date').value || todayStr;
  const arrival = new Date(dateStr + 'T' + (timeVal || '00:00') + ':00').toISOString();

  btn.disabled = true;
  const payload = {
    tenant_id:tenantId, patient_id:_ncPatientId||null,
    arrival_time:arrival, triage_category:triage, chief_complaint:complaint,
    status:'active', rmo_id:profile.id,
    is_mlc:isMLC, is_obs_bed:isObs,
    obs_bed_no:isObs ? (document.getElementById('nc-obs-bed').value||null) : null,
  };
  if (isMLC) {
    payload.mlc_number      = document.getElementById('nc-mlc-no').value.trim()||null;
    payload.mlc_nature      = document.getElementById('nc-mlc-nature').value||null;
    payload.mlc_police_station = document.getElementById('nc-mlc-ps').value.trim()||null;
    payload.mlc_intimation  = document.getElementById('nc-mlc-intim').value||null;
  }

  const { error } = await supabase.from('emergency_cases').insert(payload);
  btn.disabled = false;
  if (error) { showAlert('case-alert', safeErrorMessage(error), 'error'); return; }
  showAlert('case-alert','Case registered successfully','success');
  closeNewCase();
  loadAll();
};

function resetNewCase() {
  _ncPatientId = null;
  ['nc-search','nc-complaint','nc-mlc-no','nc-mlc-ps','nc-obs-bed'].forEach(id => { document.getElementById(id).value=''; });
  document.getElementById('nc-patient-box').style.display = 'none';
  document.getElementById('nc-results').style.display = 'none';
  document.getElementById('nc-mlc').checked = false;
  document.getElementById('nc-obs').checked = false;
  document.getElementById('mlc-extra').style.display = 'none';
  document.getElementById('nc-obs-bed').style.display = 'none';
  document.getElementById('nc-time').value = new Date().toTimeString().slice(0,5);
}

// ─── Update Modal ────────────────────────────────────────
window.openUpdateModal = function(id, status) {
  document.getElementById('upd-id').value = id;
  document.getElementById('upd-status').value = status;
  document.getElementById('upd-notes').value = '';
  document.getElementById('update-modal').style.display = 'flex';
};
window.closeUpdateModal = function() { document.getElementById('update-modal').style.display = 'none'; };
window._closeUpdateModalIfBackdrop = function(isTarget) { if (isTarget) window.closeUpdateModal(); };
window.saveUpdate = async function() {
  const id     = document.getElementById('upd-id').value;
  const status = document.getElementById('upd-status').value;
  const notes  = document.getElementById('upd-notes').value.trim();
  const payload = { status };
  if (notes) payload.clinical_notes = notes;
  if (['discharged','admitted','referred','lama','deceased'].includes(status)) {
    payload.disposition_time = new Date().toISOString();
    payload.disposition = status;
  }
  if (status === 'observation') payload.is_obs_bed = true;
  const { error } = await supabase.from('emergency_cases').update(payload).eq('id',id).eq('tenant_id',tenantId);
  if (error) { _toast(safeErrorMessage(error), true); return; }
  closeUpdateModal();
  _toast('Status updated');
  loadAll();
};

// ─── RMO Duty Log ────────────────────────────────────────
let _rmoShift = 'Morning';
window.selectShift = function(btn) {
  document.querySelectorAll('.shift-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  _rmoShift = btn.dataset.shift;
};

async function loadDoctors() {
  const { data } = await supabase.from('profiles').select('id,full_name').eq('tenant_id',tenantId).eq('role','doctor').eq('is_active',true).order('full_name');
  const sel = document.getElementById('rmo-doctor');
  sel.innerHTML = '<option value="">— Select Doctor —</option>' + (data||[]).map(d=>`<option value="${d.id}">${_esc(d.full_name)}</option>`).join('');
}

window.saveDutyLog = async function() {
  const docId = document.getElementById('rmo-doctor').value;
  const date  = document.getElementById('rmo-date').value;
  if (!docId || !date) { showAlert('rmo-alert','Select a doctor and date','error'); return; }
  const { error } = await supabase.from('emergency_duty_log').insert({
    tenant_id:tenantId, rmo_id:docId, shift:_rmoShift,
    duty_date:date,
    start_time:          document.getElementById('rmo-start').value||null,
    end_time:            document.getElementById('rmo-end').value||null,
    oncall_consultants:  document.getElementById('rmo-oncall').value.trim()||null,
    incidents_handled:   parseInt(document.getElementById('rmo-incidents').value)||0,
    notes:               document.getElementById('rmo-notes').value.trim()||null,
  });
  if (error) {
    if (error.code==='42P01') { showAlert('rmo-alert','Run emergency_duty_log SQL in Supabase first','error'); }
    else { showAlert('rmo-alert', safeErrorMessage(error), 'error'); }
    return;
  }
  showAlert('rmo-alert','Duty logged','success');
  loadDutyLog();
  loadRMOBanner();
};

window.loadDutyLog = async function() {
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate()-7);
  const { data, error } = await supabase.from('emergency_duty_log')
    .select('*,profiles!rmo_id(full_name)')
    .eq('tenant_id',tenantId)
    .gte('duty_date', sevenDaysAgo.toISOString().split('T')[0])
    .order('duty_date',{ascending:false}).order('shift');
  const wrap = document.getElementById('duty-log-body');
  if (error) {
    if (error.code==='42P01') {
      wrap.innerHTML = '<div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div>';
    } else {
      wrap.innerHTML = `<div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load data.'))}</div></div>`;
    }
    return;
  }
  if (!data?.length) { wrap.innerHTML = '<div class="empty"><div class="empty-ico">📋</div><div class="empty-ttl">No duty logged in last 7 days</div></div>'; return; }
  wrap.innerHTML = `<div class="tw"><table>
    <thead><tr><th>Date</th><th>Shift</th><th>Doctor</th><th>Start</th><th>End</th><th>Notes</th></tr></thead>
    <tbody>${data.map(d=>`<tr>
      <td>${d.duty_date}</td>
      <td><span style="background:var(--green-light);color:var(--green-deep);padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600">${d.shift}</span></td>
      <td>Dr. ${_esc(d.profiles?.full_name||'—')}</td>
      <td>${d.start_time||'—'}</td>
      <td>${d.end_time||'—'}</td>
      <td style="font-size:12px;color:var(--text-muted)">${_esc(d.notes||'—')}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
};

// ─── Observation Beds ────────────────────────────────────
window.loadObsBeds = async function() {
  const { data, error } = await supabase.from('emergency_cases')
    .select('id,obs_bed_no,chief_complaint,arrival_time,status,patients(name,phone)')
    .eq('tenant_id',tenantId).eq('is_obs_bed',true).in('status',['active','observation'])
    .order('arrival_time',{ascending:false});
  const summary = document.getElementById('obs-summary');
  const list    = document.getElementById('obs-list');
  if (error) {
    if (error.code==='42P01') { list.innerHTML='<div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div>'; return; }
    list.innerHTML=`<div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load data.'))}</div></div>`; return;
  }
  const obs = data || [];
  summary.innerHTML = `<div style="display:flex;align-items:center;gap:14px;background:var(--white);border:1.5px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:12px">
    <div style="text-align:center"><div style="font-size:28px;font-weight:700;color:var(--red)">${obs.length}</div><div style="font-size:11px;color:var(--text-muted)">Currently in Obs</div></div>
    <div style="flex:1;font-size:13px;color:var(--text-mid)">Observation beds are emergency-only holding beds. Not counted in IPD census per NCISM §6(g).</div>
  </div>`;
  if (!obs.length) { list.innerHTML='<div class="empty"><div class="empty-ico">🛏</div><div class="empty-ttl">No patients in observation</div></div>'; return; }
  list.innerHTML = `<div class="tw"><table>
    <thead><tr><th>Obs Bed</th><th>Patient</th><th>Chief Complaint</th><th>Arrival</th><th>Status</th><th></th></tr></thead>
    <tbody>${obs.map(c=>`<tr>
      <td style="font-weight:700">${_esc(c.obs_bed_no||'OBS')}</td>
      <td>${_esc(c.patients?.name||'Unknown')}<br><small style="color:var(--text-muted)">${_esc(c.patients?.phone||'')}</small></td>
      <td style="font-size:12px">${_esc(c.chief_complaint||'—')}</td>
      <td style="font-size:12px">${c.arrival_time ? new Date(c.arrival_time).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}) : '—'}</td>
      <td>${statusChip(c.status)}</td>
      <td><button class="btn btn-secondary btn-sm" data-onclick="openUpdateModal" data-onclick-a0="${_esc(c.id)}" data-onclick-a1="${_esc(c.status)}">Update</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
};

// ─── MLC Register ────────────────────────────────────────
let _mlcData = [];
window.loadMLC = async function() {
  const period = document.getElementById('mlc-month-filter').value;
  let start = null;
  const now = new Date();
  if (period==='today') start = now.toISOString().split('T')[0] + 'T00:00:00';
  else if (period==='week') { const d = new Date(now); d.setDate(d.getDate()-7); start = d.toISOString(); }
  else if (period==='month') { const d = new Date(now.getFullYear(),now.getMonth(),1); start = d.toISOString(); }

  let q = supabase.from('emergency_cases').select('*,patients(name,phone)').eq('tenant_id',tenantId).eq('is_mlc',true).order('arrival_time',{ascending:false});
  if (start) q = q.gte('arrival_time',start);
  const { data, error } = await q;
  const tbody = document.getElementById('mlc-tbody');
  if (error) {
    if (error.code==='42P01') { tbody.innerHTML='<tr><td colspan="8"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div></td></tr>'; return; }
    tbody.innerHTML=`<tr><td colspan="8"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load data.'))}</div></div></td></tr>`; return;
  }
  _mlcData = data||[];
  if (!_mlcData.length) { tbody.innerHTML='<tr><td colspan="8"><div class="empty"><div class="empty-ico">⚖️</div><div class="empty-ttl">No MLC cases in selected period</div></div></td></tr>'; return; }
  tbody.innerHTML = _mlcData.map(c=>`<tr>
    <td style="font-size:12px">${c.arrival_time ? new Date(c.arrival_time).toLocaleString('en-IN') : '—'}</td>
    <td><strong>${_esc(c.mlc_number||'—')}</strong></td>
    <td>${_esc(c.patients?.name||'Unknown')}<br><small style="color:var(--text-muted)">${_esc(c.patients?.phone||'')}</small></td>
    <td style="font-size:12px">${_esc(c.mlc_nature||'—')}</td>
    <td><span class="triage-chip triage-${c.triage_category}">${triageInfo(c.triage_category).label}</span></td>
    <td style="font-size:12px">${_esc(c.mlc_police_station||'—')}</td>
    <td><span class="triage-chip ${c.mlc_intimation==='informed'?'triage-routine':c.mlc_intimation==='pending'?'triage-urgent':'triage-semi'}">${_esc(c.mlc_intimation||'—')}</span></td>
    <td>${statusChip(c.status)}</td>
  </tr>`).join('');
};

window.exportMLC = function() {
  if (!_mlcData.length) return;
  const rows = [
    ['Date/Time','MLC No.','Patient Name','Phone','Nature','Triage','Police Station','Intimation','Status','Chief Complaint'],
    ..._mlcData.map(c=>[
      c.arrival_time ? new Date(c.arrival_time).toLocaleString('en-IN') : '',
      c.mlc_number||'', c.patients?.name||'', c.patients?.phone||'',
      c.mlc_nature||'', c.triage_category||'', c.mlc_police_station||'',
      c.mlc_intimation||'', c.status||'', c.chief_complaint||''
    ])
  ];
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = 'MLC_Register.csv'; a.click();
};

// ─── BLS Log (§23x — COP.2 ATWC CORE) ──────────────────
const todayFull = new Date().toISOString().slice(0,10);
document.getElementById('bls-date-filter').value = todayFull;
document.getElementById('bls-f-date').value      = todayFull;

window.loadBLS = async function() {
  const d = document.getElementById('bls-date-filter').value || todayFull;
  const { data } = await supabase.from('bls_logs')
    .select('*').eq('tenant_id', tenantId).eq('log_date', d)
    .order('created_at', { ascending: false });
  const rows = data || [];
  renderBLSTable(rows);
  checkBLSMissing(rows, d);
};

function checkBLSMissing(rows, d) {
  const banner = document.getElementById('bls-missing-banner');
  if (d !== todayFull) { banner.style.display='none'; return; }
  const hr   = new Date().getHours();
  const curShift = hr>=6 && hr<14 ? 'morning' : hr>=14 && hr<22 ? 'afternoon' : 'night';
  const done = rows.some(r => r.shift === curShift);
  banner.style.display = done ? 'none' : '';
}

function renderBLSTable(rows) {
  const yes = v => v ? '✅' : '❌';
  const tbody = document.getElementById('bls-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10"><div class="empty">No BLS log entries for this date</div></td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${r.log_date}</td>
    <td><span style="background:var(--green-light);color:var(--green-deep);padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600">${r.shift}</span></td>
    <td>${_esc(r.department||'—')}</td>
    <td style="text-align:center">${yes(r.kit_complete)}</td>
    <td style="text-align:center">${yes(r.aed_functional)}</td>
    <td style="text-align:center">${yes(r.o2_cylinder_ok)}</td>
    <td style="text-align:center">${yes(r.crash_cart_ok)}</td>
    <td style="font-size:12px">${_esc(r.cpr_trained_staff||'—')} ${r.cpr_trained_count?'('+r.cpr_trained_count+')':''}</td>
    <td style="font-size:12px">${_esc(r.checked_by_name||'—')}</td>
    <td style="font-size:12px;color:${r.remarks?'var(--amber)':'var(--text-muted)'}">${_esc(r.remarks||'—')}</td>
  </tr>`).join('');
}

window.openBLSModal = function() {
  document.getElementById('bls-modal').style.display='flex';
  document.getElementById('bls-f-date').value        = document.getElementById('bls-date-filter').value || todayFull;
  document.getElementById('bls-f-shift').value       = 'morning';
  document.getElementById('bls-f-dept').value        = '';
  document.getElementById('bls-kit').checked         = false;
  document.getElementById('bls-aed').checked         = false;
  document.getElementById('bls-o2').checked          = false;
  document.getElementById('bls-cart').checked        = false;
  document.getElementById('bls-f-staff').value       = '';
  document.getElementById('bls-f-count').value       = '';
  document.getElementById('bls-f-checked-by').value  = profile?.full_name || '';
  document.getElementById('bls-f-remarks').value     = '';
};
window.closeBLSModal = function() {
  document.getElementById('bls-modal').style.display='none';
};
window.saveBLS = async function() {
  const logDate = document.getElementById('bls-f-date').value;
  const shift   = document.getElementById('bls-f-shift').value;
  if (!logDate || !shift) { _toast('Date and shift required', true); return; }
  const payload = {
    tenant_id:         tenantId,
    log_date:          logDate,
    shift,
    department:        document.getElementById('bls-f-dept').value.trim()||null,
    kit_complete:      document.getElementById('bls-kit').checked,
    aed_functional:    document.getElementById('bls-aed').checked,
    o2_cylinder_ok:    document.getElementById('bls-o2').checked,
    crash_cart_ok:     document.getElementById('bls-cart').checked,
    cpr_trained_staff: document.getElementById('bls-f-staff').value.trim()||null,
    cpr_trained_count: parseInt(document.getElementById('bls-f-count').value)||0,
    checked_by:        profile.id,
    checked_by_name:   document.getElementById('bls-f-checked-by').value.trim()||null,
    remarks:           document.getElementById('bls-f-remarks').value.trim()||null,
  };
  const { error } = await supabase.from('bls_logs').insert(payload);
  if (error) { _toast(safeErrorMessage(error), true); return; }
  _toast('BLS log saved'); closeBLSModal();
  document.getElementById('bls-date-filter').value = logDate;
  loadBLS();
};

// ─── Helpers ─────────────────────────────────────────────
function triageInfo(t) {
  return {
    emergency: {label:'🔴 Emergency', cls:'triage-emergency'},
    urgent:    {label:'🟠 Urgent',    cls:'triage-urgent'},
    semi_urgent:{label:'🟡 Semi-Urgent',cls:'triage-semi'},
    routine:   {label:'🟢 Routine',   cls:'triage-routine'},
  }[t] || {label:t||'—', cls:'triage-routine'};
}
function statusChip(s) {
  const map = {
    active:      'background:#fdecea;color:#7f1d1d;border-color:#fca5a5',
    observation: 'background:#fffbeb;color:#78350f;border-color:#fcd34d',
    admitted:    'background:var(--blue-light);color:var(--blue);border-color:var(--blue)',
    discharged:  'background:var(--green-light);color:var(--green-deep);border-color:var(--green-mid)',
    referred:    'background:#f5f3ff;color:#6d28d9;border-color:#c4b5fd',
    lama:        'background:#f3f4f6;color:#374151;border-color:#9ca3af',
    deceased:    'background:#1f2937;color:#f9fafb;border-color:#374151',
  };
  const style = map[s] || map.active;
  return `<span style="${style};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;border:1.5px solid">${_esc(s||'unknown')}</span>`;
}
function showAlert(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg; el.className = `alert ${type} show`;
  setTimeout(()=>el.classList.remove('show'), 4000);
}
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg,isErr=false){ const el=document.getElementById('toast'); el.textContent=msg; el.style.background=isErr?'#7f1d1d':'#1c2b1f'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

// Boot
loadDoctors();
await loadAll();
