import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','nurse','doctor'], 'index.html');
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();

const todayStr = new Date().toISOString().slice(0,7);
document.getElementById('dev-month').value = todayStr;
document.getElementById('hai-month').value = todayStr;
document.getElementById('d-ins-date').value = new Date().toISOString().slice(0,10);
document.getElementById('h-date').value    = new Date().toISOString().slice(0,10);

let _devices = [], _haiEvents = [];

function activeTab() { return document.querySelector('.tab-pane.active')?.id?.replace('tab-',''); }

// ── Patient search picker (shared by the Device and HAI Event modals) ────
const _patientSearchTimers = {};
window.searchDevPatient = function() { _debouncePatientSearch('d'); };
window.searchHaiPatient = function() { _debouncePatientSearch('h'); };

function _debouncePatientSearch(prefix) {
  clearTimeout(_patientSearchTimers[prefix]);
  document.getElementById(`${prefix}-patient-id`).value = '';
  document.getElementById(`${prefix}-patient-selected`).classList.remove('show');
  const q = document.getElementById(`${prefix}-patient`).value.trim();
  const resultsEl = document.getElementById(`${prefix}-patient-results`);
  if (q.length < 2) { resultsEl.classList.remove('show'); resultsEl.innerHTML = ''; return; }
  _patientSearchTimers[prefix] = setTimeout(() => _doPatientSearch(prefix, q), 300);
}

async function _doPatientSearch(prefix, q) {
  const { data } = await supabase.from('patients').select('id,name,phone')
    .eq('tenant_id', tenantId)
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
    .limit(8);
  const resultsEl = document.getElementById(`${prefix}-patient-results`);
  if (!data?.length) {
    resultsEl.innerHTML = '<div class="pt-item" style="cursor:default;color:var(--text-muted)">No patients found</div>';
    resultsEl.classList.add('show');
    return;
  }
  resultsEl.innerHTML = data.map(p => `<div class="pt-item" data-onclick="selectSearchPatient" data-onclick-a0="${prefix}" data-onclick-a1="${p.id}" data-onclick-a2="${_esc(p.name)}" data-onclick-a3="${_esc(p.phone||'')}">
    <div class="pt-name">${_esc(p.name)}</div>
    <div class="pt-meta">${_esc(p.phone||'—')}</div>
  </div>`).join('');
  resultsEl.classList.add('show');
}

window.selectSearchPatient = function(prefix, id, name, phone) {
  document.getElementById(`${prefix}-patient-id`).value = id;
  document.getElementById(`${prefix}-patient`).value = name;
  document.getElementById(`${prefix}-patient-results`).classList.remove('show');
  const sel = document.getElementById(`${prefix}-patient-selected`);
  sel.textContent = `✓ ${name}${phone ? ' · '+phone : ''}`;
  sel.classList.add('show');
};

window.switchTab = function(t) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-'+t)?.classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => { if (b.dataset.tab === t) b.classList.add('active'); });
  if (t==='rates') renderRates();
};

async function loadDevices() {
  const m = document.getElementById('dev-month').value;
  const [y, mo] = m.split('-').map(Number);
  const start = new Date(y, mo-1, 1).toISOString().slice(0,10);
  const end   = new Date(y, mo, 0).toISOString().slice(0,10);
  const { data } = await supabase.from('patient_devices')
    .select('*,patients(name,phone)').eq('tenant_id', tenantId)
    .gte('insertion_date', start).lte('insertion_date', end)
    .order('insertion_date', { ascending: false });
  _devices = data || [];
  renderDevices(); renderKPI();
}
window.loadDevices = loadDevices;

async function loadHAI() {
  const m = document.getElementById('hai-month').value;
  const [y, mo] = m.split('-').map(Number);
  const start = new Date(y, mo-1, 1).toISOString().slice(0,10);
  const end   = new Date(y, mo, 0).toISOString().slice(0,10);
  const { data } = await supabase.from('hai_events')
    .select('*,patients(name,phone)').eq('tenant_id', tenantId)
    .gte('detected_date', start).lte('detected_date', end)
    .order('detected_date', { ascending: false });
  _haiEvents = data || [];
  renderHAI(); renderKPI();
  checkAlert();
}
window.loadHAI = loadHAI;

const DEV_LABELS = {
  urinary_catheter:'Urinary Catheter', central_line:'Central Line (CVC)', iv_cannula:'IV Cannula',
  ventilator:'Ventilator', nasogastric_tube:'NG Tube', drainage_tube:'Drainage Tube', other:'Other'
};

function renderKPI() {
  const today = new Date(); today.setHours(0,0,0,0);
  const active = _devices.filter(d => !d.removal_date);
  const cathDays = _devices.filter(d => d.device_type==='urinary_catheter').reduce((s,d) => {
    const ins = new Date(d.insertion_date);
    const rem = d.removal_date ? new Date(d.removal_date) : today;
    return s + Math.max(0, Math.round((rem-ins)/(1000*60*60*24)));
  }, 0);
  const clDays = _devices.filter(d => d.device_type==='central_line').reduce((s,d) => {
    const ins = new Date(d.insertion_date);
    const rem = d.removal_date ? new Date(d.removal_date) : today;
    return s + Math.max(0, Math.round((rem-ins)/(1000*60*60*24)));
  }, 0);
  const cauti  = _haiEvents.filter(e => e.hai_type==='CAUTI').length;
  const clabsi = _haiEvents.filter(e => e.hai_type==='CLABSI').length;
  document.getElementById('k-dev').textContent        = active.length;
  document.getElementById('k-devdays').textContent    = cathDays + clDays;
  document.getElementById('k-hai').textContent        = _haiEvents.length;
  document.getElementById('k-cauti-rate').textContent = cathDays > 0 ? ((cauti/cathDays)*1000).toFixed(2) : '—';
  document.getElementById('k-clabsi-rate').textContent = clDays > 0 ? ((clabsi/clDays)*1000).toFixed(2) : '—';
}

window.renderDevices = function() {
  const tf = document.getElementById('dev-type-filter').value;
  const sf = document.getElementById('dev-status-filter').value;
  const today = new Date(); today.setHours(0,0,0,0);
  const rows = _devices.filter(d => {
    if (tf && d.device_type !== tf) return false;
    if (sf==='active' && d.removal_date) return false;
    return true;
  });
  const tbody = document.getElementById('dev-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No device records found</div></td></tr>'; return; }
  tbody.innerHTML = rows.map(d => {
    const ins = new Date(d.insertion_date);
    const rem = d.removal_date ? new Date(d.removal_date) : today;
    const days = Math.max(0, Math.round((rem-ins)/(1000*60*60*24)));
    const status = d.removal_date ? '<span class="badge b-resolved">Removed</span>' : '<span class="badge b-active">Active</span>';
    const rmBtn  = !d.removal_date ? `<button class="btn btn-outline btn-sm" data-onclick="markRemoved" data-onclick-a0="${d.id}">Mark Removed</button>` : '';
    return `<tr>
      <td>${_esc(d.patients?.name||'—')}</td>
      <td>${DEV_LABELS[d.device_type]||_esc(d.device_type)}</td>
      <td>${d.insertion_date}</td>
      <td>${_esc(d.site||'—')}</td>
      <td><strong>${days}</strong> days</td>
      <td>${status}</td>
      <td>${rmBtn}</td>
    </tr>`;
  }).join('');
};

window.renderHAI = function() {
  const tf = document.getElementById('hai-type-filter').value;
  const rows = _haiEvents.filter(e => !tf || e.hai_type===tf);
  const tbody = document.getElementById('hai-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No HAI events — excellent!</div></td></tr>'; return; }
  tbody.innerHTML = rows.map(e => {
    const out = {ongoing:'b-ongoing',resolved:'b-resolved'}[e.outcome]||'b-active';
    return `<tr>
      <td>${e.detected_date}</td>
      <td><span class="hai-chip">${_esc(e.hai_type)}</span></td>
      <td>${_esc(e.patients?.name||'—')}</td>
      <td>${_esc(e.organism||'—')}</td>
      <td>${e.notified_ipc_team ? '✅ Yes' : '⚠ No'}</td>
      <td><span class="badge ${out}">${_esc(e.outcome||'ongoing')}</span></td>
      <td><button class="btn btn-outline btn-sm" data-onclick="updateOutcome" data-onclick-a0="${e.id}">Update</button></td>
    </tr>`;
  }).join('');
};

function renderRates() {
  const today = new Date(); today.setHours(0,0,0,0);
  const cathDays = _devices.filter(d => d.device_type==='urinary_catheter').reduce((s,d) => {
    const ins = new Date(d.insertion_date); const rem = d.removal_date ? new Date(d.removal_date) : today;
    return s + Math.max(0, Math.round((rem-ins)/(1000*60*60*24)));
  }, 0);
  const clDays = _devices.filter(d => d.device_type==='central_line').reduce((s,d) => {
    const ins = new Date(d.insertion_date); const rem = d.removal_date ? new Date(d.removal_date) : today;
    return s + Math.max(0, Math.round((rem-ins)/(1000*60*60*24)));
  }, 0);
  const cauti  = _haiEvents.filter(e => e.hai_type==='CAUTI').length;
  const clabsi = _haiEvents.filter(e => e.hai_type==='CLABSI').length;
  const cautiRate  = cathDays > 0 ? ((cauti/cathDays)*1000).toFixed(2) : 0;
  const clabsiRate = clDays   > 0 ? ((clabsi/clDays)*1000).toFixed(2)  : 0;
  document.getElementById('r-cathdays').textContent    = cathDays;
  document.getElementById('r-cauti-n').textContent     = cauti;
  document.getElementById('r-cauti-rate').textContent  = cautiRate;
  document.getElementById('r-cauti-rate').className    = 'rate-num' + (cautiRate>3?' danger':cautiRate>0?' warn':'');
  document.getElementById('r-cldays').textContent      = clDays;
  document.getElementById('r-clabsi-n').textContent    = clabsi;
  document.getElementById('r-clabsi-rate').textContent = clabsiRate;
  document.getElementById('r-clabsi-rate').className   = 'rate-num' + (clabsiRate>1?' danger':clabsiRate>0?' warn':'');
  document.getElementById('r-ssi-n').textContent       = _haiEvents.filter(e => e.hai_type==='SSI').length;
  document.getElementById('r-vap-n').textContent       = _haiEvents.filter(e => e.hai_type==='VAP').length;
  document.getElementById('r-total').textContent       = _haiEvents.length;
}

function checkAlert() {
  const banner = document.getElementById('hai-alert');
  const notUnnotified = _haiEvents.filter(e => !e.notified_ipc_team);
  if (notUnnotified.length) {
    banner.style.display = '';
    banner.textContent   = `⚠ ${notUnnotified.length} HAI event(s) not notified to IPC team — notify immediately.`;
  } else { banner.style.display = 'none'; }
}

window.openDevModal = function() {
  document.getElementById('dev-modal').style.display = 'flex';
  document.getElementById('dev-edit-id').value = '';
  document.getElementById('d-patient').value = '';
  document.getElementById('d-patient-id').value = '';
  document.getElementById('d-patient-results').classList.remove('show');
  document.getElementById('d-patient-selected').classList.remove('show');
  document.getElementById('d-type').value = 'urinary_catheter';
  document.getElementById('d-ins-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('d-rem-date').value = '';
  document.getElementById('d-site').value = '';
  document.getElementById('d-notes').value = '';
};
window.closeDevModal = () => document.getElementById('dev-modal').style.display = 'none';

window.saveDevice = async function() {
  const patientId = document.getElementById('d-patient-id').value;
  const insDate = document.getElementById('d-ins-date').value;
  if (!patientId || !insDate) { toast('Select a patient and enter the insertion date', 'error'); return; }
  const payload = {
    tenant_id:      tenantId,
    patient_id:     patientId,
    device_type:    document.getElementById('d-type').value,
    insertion_date: insDate,
    removal_date:   document.getElementById('d-rem-date').value || null,
    site:           document.getElementById('d-site').value.trim() || null,
    notes:          document.getElementById('d-notes').value.trim() || null,
  };
  const { error } = await supabase.from('patient_devices').insert(payload);
  if (error) { toast('Save failed: '+error.message, 'error'); return; }
  toast('Device logged', 'success'); closeDevModal(); loadDevices();
};

window.markRemoved = async function(id) {
  const today = new Date().toISOString().slice(0,10);
  const { error } = await supabase.from('patient_devices').update({ removal_date: today }).eq('id', id);
  if (error) { toast('Failed: '+error.message, 'error'); return; }
  toast('Marked as removed', 'success'); loadDevices();
};

window.openHAIModal = function() {
  document.getElementById('hai-modal').style.display = 'flex';
  document.getElementById('hai-edit-id').value = '';
  document.getElementById('h-patient').value   = '';
  document.getElementById('h-patient-id').value = '';
  document.getElementById('h-patient-results').classList.remove('show');
  document.getElementById('h-patient-selected').classList.remove('show');
  document.getElementById('h-type').value      = 'CAUTI';
  document.getElementById('h-date').value      = new Date().toISOString().slice(0,10);
  document.getElementById('h-culture').checked = false;
  document.getElementById('h-organism').value  = '';
  document.getElementById('h-antibiogram').value = '';
  document.getElementById('h-notified').checked = false;
  document.getElementById('h-outcome').value   = 'ongoing';
  document.getElementById('h-notes').value     = '';
};
window.closeHAIModal = () => document.getElementById('hai-modal').style.display = 'none';

window.saveHAI = async function() {
  const patientId = document.getElementById('h-patient-id').value;
  const date    = document.getElementById('h-date').value;
  if (!patientId || !date) { toast('Select a patient and enter the detection date', 'error'); return; }
  const payload = {
    tenant_id:        tenantId,
    patient_id:       patientId,
    hai_type:         document.getElementById('h-type').value,
    detected_date:    date,
    culture_done:     document.getElementById('h-culture').checked,
    organism:         document.getElementById('h-organism').value.trim() || null,
    antibiogram:      document.getElementById('h-antibiogram').value.trim() || null,
    notified_ipc_team: document.getElementById('h-notified').checked,
    notified_at:      document.getElementById('h-notified').checked ? new Date().toISOString() : null,
    outcome:          document.getElementById('h-outcome').value,
    notes:            document.getElementById('h-notes').value.trim() || null,
    reported_by:      profile.id,
  };
  const { error } = await supabase.from('hai_events').insert(payload);
  if (error) { toast('Save failed: '+error.message, 'error'); return; }
  toast('HAI event reported', 'success'); closeHAIModal(); loadHAI();
};

window.updateOutcome = async function(id) {
  const outcome = prompt('New outcome (resolved / ongoing / transferred / discharged / deceased):');
  if (!outcome) return;
  const valid = ['resolved','ongoing','transferred','discharged','deceased'];
  if (!valid.includes(outcome.toLowerCase())) { toast('Invalid outcome', 'error'); return; }
  const { error } = await supabase.from('hai_events').update({ outcome: outcome.toLowerCase() }).eq('id', id);
  if (error) { toast('Failed: '+error.message, 'error'); return; }
  toast('Updated', 'success'); loadHAI();
};

window.exportHAICSV = function() {
  const rows = _haiEvents.map(e => [e.detected_date, e.hai_type, e.patients?.name||'', e.organism||'', e.notified_ipc_team?'Yes':'No', e.outcome||'']);
  const csv  = [['Date','HAI Type','Patient','Organism','IPC Notified','Outcome'], ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const a    = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `hai_events_${new Date().toISOString().slice(0,10)}.csv`; a.click();
};

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  setTimeout(() => el.className = 'toast', 2800);
}

loadDevices(); loadHAI();
