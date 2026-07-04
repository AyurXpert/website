import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','nurse','receptionist']);
initNavbar();
wireDelegatedEvents();

window._closeModalIfSelf = function(isSelf, id) { if (isSelf) closeModal(id); };

const tenantId  = getCurrentTenantId();
const myProfile = getCurrentProfile();
const todayStr  = new Date().toISOString().slice(0,10);

let _hkRows = [], _ldRows = [], _visRows = [], _incRows = [];

// ── Tabs ──────────────────────────────────────────────────────────────────────
window.setTab = function(btn, tab) {
  document.querySelectorAll('.module-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
};

window.closeModal = function(id) { document.getElementById(id).style.display = 'none'; };

async function _populateStaff(selectId, designations) {
  const { data } = await supabase.from('profiles').select('id,full_name')
    .eq('tenant_id', tenantId).eq('is_active', true).in('designation', designations);
  const sel = document.getElementById(selectId);
  const placeholder = sel.options[0]?.outerHTML || '<option value="">— Select staff —</option>';
  sel.innerHTML = placeholder + (data && data.length
    ? data.map(p => `<option value="${p.id}">${_esc(p.full_name)}</option>`).join('')
    : '<option value="" disabled>No staff tagged with this designation — assign via All Staff tab</option>');
}

// ── Housekeeping ──────────────────────────────────────────────────────────────
window.openHkModal = async function() {
  document.getElementById('hk-date').value = todayStr;
  document.getElementById('hk-qc').value = '';
  document.getElementById('hk-notes').value = '';
  await Promise.all([
    _populateStaff('hk-staff', ['sanitation_supervisor','sanitation_worker']),
    _populateStaff('hk-qcby', ['sanitation_supervisor']),
  ]);
  document.getElementById('hk-overlay').style.display = 'flex';
};

window.saveHk = async function() {
  const payload = {
    tenant_id: tenantId,
    round_date: document.getElementById('hk-date').value,
    shift: document.getElementById('hk-shift').value,
    zone: document.getElementById('hk-zone').value,
    staff_id: document.getElementById('hk-staff').value || null,
    completed_at: new Date().toISOString(),
    qc_score: parseInt(document.getElementById('hk-qc').value) || null,
    qc_by: document.getElementById('hk-qcby').value || null,
    notes: document.getElementById('hk-notes').value.trim() || null,
  };
  if (!payload.round_date) { _alert('error','Date is required.'); return; }
  const { error } = await supabase.from('housekeeping_rounds').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  _alert('success','Round logged.');
  closeModal('hk-overlay');
  await loadHk();
};

window.loadHk = async function() {
  let q = supabase.from('housekeeping_rounds')
    .select('id,round_date,shift,zone,qc_score,notes,staff:profiles!staff_id(full_name),qc:profiles!qc_by(full_name)')
    .eq('tenant_id', tenantId).order('round_date',{ascending:false});
  const from = document.getElementById('hk-from').value, to = document.getElementById('hk-to').value;
  if (from) q = q.gte('round_date', from);
  if (to)   q = q.lte('round_date', to);
  const { data, error } = await q;
  if (error) { _alert('error', safeErrorMessage(error, 'Load error. Please try again.')); return; }
  _hkRows = data || [];
  const todays = _hkRows.filter(r => r.round_date === todayStr);
  document.getElementById('hk-stat-rounds').textContent = todays.length;
  const scored = todays.filter(r=>r.qc_score);
  document.getElementById('hk-stat-qc').textContent = scored.length ? (scored.reduce((s,r)=>s+r.qc_score,0)/scored.length).toFixed(1) : '—';

  const tbody = document.getElementById('hk-tbody');
  if (!_hkRows.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted)">No rounds logged for this range.</td></tr>'; return; }
  tbody.innerHTML = _hkRows.map(r => `<tr>
    <td>${_fmtDate(r.round_date)}</td><td>${_cap(r.shift)}</td><td>${_esc(r.zone)}</td>
    <td>${_esc(r.staff?.full_name || '—')}</td><td>${r.qc_score || '—'}</td>
    <td>${_esc(r.qc?.full_name || '—')}</td><td>${_esc(r.notes || '—')}</td>
  </tr>`).join('');
};

// ── Laundry ───────────────────────────────────────────────────────────────────
window.openLdModal = async function() {
  document.getElementById('ld-date').value = todayStr;
  ['ld-zone','ld-collected','ld-distributed','ld-disinfection','ld-vendor','ld-notes'].forEach(id=>document.getElementById(id).value='');
  await _populateStaff('ld-staff', ['laundry_supervisor','laundry_worker']);
  document.getElementById('ld-overlay').style.display = 'flex';
};

window.saveLd = async function() {
  const payload = {
    tenant_id: tenantId,
    cycle_date: document.getElementById('ld-date').value,
    source_zone: document.getElementById('ld-zone').value.trim() || null,
    collected_qty: parseInt(document.getElementById('ld-collected').value) || null,
    collected_at: new Date().toISOString(),
    disinfection_method: document.getElementById('ld-disinfection').value.trim() || null,
    distributed_qty: parseInt(document.getElementById('ld-distributed').value) || null,
    vendor_name: document.getElementById('ld-vendor').value.trim() || null,
    handled_by: document.getElementById('ld-staff').value || null,
    notes: document.getElementById('ld-notes').value.trim() || null,
  };
  if (!payload.cycle_date) { _alert('error','Date is required.'); return; }
  const { error } = await supabase.from('laundry_cycles').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  _alert('success','Cycle logged.');
  closeModal('ld-overlay');
  await loadLd();
};

window.loadLd = async function() {
  let q = supabase.from('laundry_cycles')
    .select('id,cycle_date,source_zone,collected_qty,disinfection_method,distributed_qty,vendor_name,notes,handler:profiles!handled_by(full_name)')
    .eq('tenant_id', tenantId).order('cycle_date',{ascending:false});
  const from = document.getElementById('ld-from').value, to = document.getElementById('ld-to').value;
  if (from) q = q.gte('cycle_date', from);
  if (to)   q = q.lte('cycle_date', to);
  const { data, error } = await q;
  if (error) { _alert('error', safeErrorMessage(error, 'Load error. Please try again.')); return; }
  _ldRows = data || [];
  const todays = _ldRows.filter(r => r.cycle_date === todayStr);
  document.getElementById('ld-stat-cycles').textContent = todays.length;
  document.getElementById('ld-stat-qty').textContent = todays.reduce((s,r)=>s+(r.collected_qty||0),0);

  const tbody = document.getElementById('ld-tbody');
  if (!_ldRows.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No cycles logged for this range.</td></tr>'; return; }
  tbody.innerHTML = _ldRows.map(r => `<tr>
    <td>${_fmtDate(r.cycle_date)}</td><td>${_esc(r.source_zone || '—')}</td><td>${r.collected_qty ?? '—'}</td>
    <td>${_esc(r.disinfection_method || '—')}</td><td>${r.distributed_qty ?? '—'}</td>
    <td>${_esc(r.vendor_name || '—')}</td><td>${_esc(r.handler?.full_name || '—')}</td><td>${_esc(r.notes || '—')}</td>
  </tr>`).join('');
};

// ── Security: Visitor Register ────────────────────────────────────────────────
window.openVisitorModal = function() {
  ['vis-name','vis-id','vis-purpose','vis-met'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('vis-overlay').style.display = 'flex';
};

window.saveVisitor = async function() {
  const name = document.getElementById('vis-name').value.trim();
  if (!name) { _alert('error','Visitor name is required.'); return; }
  const payload = {
    tenant_id: tenantId,
    visitor_name: name,
    id_proof: document.getElementById('vis-id').value.trim() || null,
    purpose: document.getElementById('vis-purpose').value.trim() || null,
    met_person: document.getElementById('vis-met').value.trim() || null,
    entry_time: new Date().toISOString(),
    logged_by: myProfile?.id,
  };
  const { error } = await supabase.from('security_visitor_log').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  _alert('success','Visitor logged.');
  closeModal('vis-overlay');
  await loadVisitors();
};

window.markExit = async function(id) {
  const { error } = await supabase.from('security_visitor_log').update({ exit_time: new Date().toISOString() }).eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  await loadVisitors();
};

window.loadVisitors = async function() {
  let q = supabase.from('security_visitor_log')
    .select('id,visitor_name,purpose,met_person,entry_time,exit_time')
    .eq('tenant_id', tenantId).order('entry_time',{ascending:false});
  const from = document.getElementById('vis-from').value, to = document.getElementById('vis-to').value;
  if (from) q = q.gte('entry_time', from+'T00:00:00');
  if (to)   q = q.lte('entry_time', to+'T23:59:59');
  const { data, error } = await q;
  if (error) { _alert('error', safeErrorMessage(error, 'Load error. Please try again.')); return; }
  _visRows = data || [];
  const tbody = document.getElementById('vis-tbody');
  if (!_visRows.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted)">No visitor entries for this range.</td></tr>'; return; }
  tbody.innerHTML = _visRows.map(r => `<tr>
    <td>${_esc(r.visitor_name)}</td><td>${_esc(r.purpose || '—')}</td><td>${_esc(r.met_person || '—')}</td>
    <td>${_fmtDateTime(r.entry_time)}</td><td>${r.exit_time ? _fmtDateTime(r.exit_time) : '—'}</td>
    <td><span class="status-pill ${r.exit_time ? 'pill-exited' : 'pill-open'}">${r.exit_time ? 'Exited' : 'On Premises'}</span></td>
    <td>${!r.exit_time ? `<button class="btn btn-secondary btn-sm" data-onclick="markExit" data-onclick-a0="${r.id}">Mark Exit</button>` : '—'}</td>
  </tr>`).join('');
};

// ── Security: Incident Log ────────────────────────────────────────────────────
window.openIncidentModal = async function() {
  document.getElementById('inc-date').value = todayStr;
  document.getElementById('inc-time').value = new Date().toTimeString().slice(0,5);
  ['inc-location','inc-desc','inc-action'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('inc-severity').value = 'low';
  await _populateStaff('inc-reporter', ['security_supervisor','security_guard']);
  document.getElementById('inc-overlay').style.display = 'flex';
};

window.saveIncident = async function() {
  const desc = document.getElementById('inc-desc').value.trim();
  if (!desc) { _alert('error','Description is required.'); return; }
  const payload = {
    tenant_id: tenantId,
    incident_date: document.getElementById('inc-date').value,
    incident_time: document.getElementById('inc-time').value || null,
    location: document.getElementById('inc-location').value.trim() || null,
    severity: document.getElementById('inc-severity').value,
    description: desc,
    action_taken: document.getElementById('inc-action').value.trim() || null,
    status: 'open',
    reported_by: document.getElementById('inc-reporter').value || null,
  };
  const { error } = await supabase.from('security_incidents').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  _alert('success','Incident reported.');
  closeModal('inc-overlay');
  await loadIncidents();
};

window.closeIncident = async function(id) {
  const { error } = await supabase.from('security_incidents').update({ status:'closed', closed_at: new Date().toISOString() }).eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  await loadIncidents();
};

window.loadIncidents = async function() {
  let q = supabase.from('security_incidents')
    .select('id,incident_date,location,severity,description,action_taken,status,reporter:profiles!reported_by(full_name)')
    .eq('tenant_id', tenantId).order('incident_date',{ascending:false});
  const from = document.getElementById('inc-from').value, to = document.getElementById('inc-to').value;
  if (from) q = q.gte('incident_date', from);
  if (to)   q = q.lte('incident_date', to);
  const { data, error } = await q;
  if (error) { _alert('error', safeErrorMessage(error, 'Load error. Please try again.')); return; }
  _incRows = data || [];
  const tbody = document.getElementById('inc-tbody');
  if (!_incRows.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No incidents for this range.</td></tr>'; return; }
  tbody.innerHTML = _incRows.map(r => `<tr>
    <td>${_fmtDate(r.incident_date)}</td><td>${_esc(r.location || '—')}</td>
    <td><span class="status-pill pill-${r.severity}">${_cap(r.severity)}</span></td>
    <td>${_esc(r.description)}</td><td>${_esc(r.action_taken || '—')}</td>
    <td><span class="status-pill pill-${r.status}">${_cap(r.status)}</span></td>
    <td>${_esc(r.reporter?.full_name || '—')}</td>
    <td>${r.status==='open' ? `<button class="btn btn-secondary btn-sm" data-onclick="closeIncident" data-onclick-a0="${r.id}">Close</button>` : '—'}</td>
  </tr>`).join('');
};

// ── CSV export ────────────────────────────────────────────────────────────────
window.exportCSV = function(which) {
  const map = {
    hk:  { rows:_hkRows,  header:['Date','Shift','Zone','Staff','QC Score','QC By','Notes'],
           row:r=>[r.round_date,r.shift,r.zone,r.staff?.full_name||'',r.qc_score||'',r.qc?.full_name||'',r.notes||''], file:'Housekeeping_Rounds.csv' },
    ld:  { rows:_ldRows,  header:['Date','Source Zone','Collected Qty','Disinfection','Distributed Qty','Vendor','Handled By','Notes'],
           row:r=>[r.cycle_date,r.source_zone||'',r.collected_qty||'',r.disinfection_method||'',r.distributed_qty||'',r.vendor_name||'',r.handler?.full_name||'',r.notes||''], file:'Laundry_Cycles.csv' },
    vis: { rows:_visRows, header:['Visitor','Purpose','Met','Entry','Exit'],
           row:r=>[r.visitor_name,r.purpose||'',r.met_person||'',r.entry_time||'',r.exit_time||''], file:'Security_Visitor_Log.csv' },
    inc: { rows:_incRows, header:['Date','Location','Severity','Description','Action Taken','Status','Reported By'],
           row:r=>[r.incident_date,r.location||'',r.severity,r.description,r.action_taken||'',r.status,r.reporter?.full_name||''], file:'Security_Incidents.csv' },
  };
  const cfg = map[which];
  if (!cfg.rows.length) { _alert('error','Nothing to export.'); return; }
  const rows = [cfg.header, ...cfg.rows.map(cfg.row)];
  const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = cfg.file;
  a.click();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _fmtDateTime(d) { if (!d) return '—'; return new Date(d).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); }
function _cap(s) { return s ? s.charAt(0).toUpperCase()+s.slice(1) : '—'; }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _alert(type, msg) { const el = document.getElementById('alert-box'); el.className = `alert ${type} show`; el.textContent = msg; setTimeout(() => el.classList.remove('show'), 4000); }

// ── Boot ──────────────────────────────────────────────────────────────────────
document.getElementById('hk-from').value  = todayStr.slice(0,8)+'01'; document.getElementById('hk-to').value  = todayStr;
document.getElementById('ld-from').value  = todayStr.slice(0,8)+'01'; document.getElementById('ld-to').value  = todayStr;
document.getElementById('vis-from').value = todayStr; document.getElementById('vis-to').value = todayStr;
document.getElementById('inc-from').value = todayStr.slice(0,8)+'01'; document.getElementById('inc-to').value = todayStr;
await Promise.all([loadHk(), loadLd(), loadVisitors(), loadIncidents()]);
