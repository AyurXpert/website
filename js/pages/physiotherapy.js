import { requireAuth, getCurrentProfile, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse','therapist','receptionist'], 'index.html');
initNavbar();
wireDelegatedEvents();

const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = tenant?.id;
const today     = new Date().toISOString().slice(0,10);

let _searchTimer = null, _modalSearchTimer = null, _referralSearchTimer = null, _selectedPatient = null, _histData = [];
let _registerSearchResults = [], _modalSearchResults = [], _referralSearchResults = [];

// ── Tabs ──────────────────────────────────────────────────────────────────────
window.switchTab = function(id) {
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', ['queue','register','history'][i] === id));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === 'tab-' + id));
  if (id === 'queue')    loadQueue();
  if (id === 'history')  { document.getElementById('hist-month').value = today.slice(0,7); loadHistory(); }
};

// ── Load queue ────────────────────────────────────────────────────────────────
window.loadQueue = async function() {
  const tbody = document.getElementById('queue-tbody');
  const { data, error } = await supabase.from('physiotherapy_sessions')
    .select('*,patients(name,phone),profiles!physiotherapist_id(full_name)')
    .eq('tenant_id', tenantId)
    .eq('session_date', today)
    .order('created_at');

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${error.code==='42P01'?'Run session32_ncism_gaps.sql first':_esc(safeErrorMessage(error, 'Could not load data.'))}</div></div></td></tr>`;
    return;
  }
  if (!data?.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><div class="empty-ico">🏃</div><div class="empty-ttl">No sessions today</div><div class="empty-sub">Click + New Session to add one</div></div></td></tr>'; return; }

  tbody.innerHTML = data.map(s => `<tr>
    <td style="font-weight:600">${_esc(s.patients?.name||'—')}<br><span style="font-size:11px;color:var(--text-muted)">${_esc(s.patients?.phone||'')}</span></td>
    <td style="font-size:12px">${s.referral_by ? '📋' : '—'} ${_esc(s.treatment_type)}</td>
    <td style="font-weight:500">${_esc(s.treatment_type)}</td>
    <td>${s.session_number||1} / ${s.total_sessions_planned||1}</td>
    <td>${s.duration_minutes||30} min</td>
    <td><span class="badge badge-${s.status||'scheduled'}">${(s.status||'scheduled').replace('_',' ')}</span></td>
    <td>${s.status==='scheduled'?`<button class="btn btn-primary btn-sm" data-onclick="markComplete" data-onclick-a0="${s.id}">Complete</button>`:''}</td>
  </tr>`).join('');

  // KPIs
  const all = data.length;
  const sched = data.filter(s=>s.status==='scheduled').length;
  const comp  = data.filter(s=>s.status==='completed').length;
  document.getElementById('k-today').textContent     = all;
  document.getElementById('k-scheduled').textContent = sched;
  document.getElementById('k-completed').textContent = comp;
};

window.markComplete = async function(id) {
  await supabase.from('physiotherapy_sessions').update({ status:'completed' }).eq('id', id).eq('tenant_id', tenantId);
  loadQueue();
};

// ── Patient search ────────────────────────────────────────────────────────────
window.debounceSearch = function(val) {
  clearTimeout(_searchTimer);
  if (val.length < 2) { document.getElementById('search-results').style.display='none'; return; }
  _searchTimer = setTimeout(() => searchPatients(val, 'search-results', 'selectRegisterPatient'), 300);
};

window.debounceModalSearch = function(val) {
  clearTimeout(_modalSearchTimer);
  if (val.length < 2) { document.getElementById('m-search-results').style.display='none'; return; }
  _modalSearchTimer = setTimeout(() => searchPatients(val, 'm-search-results', 'selectModalPatient'), 300);
};

async function searchPatients(q, resultsId, onSelectFnName) {
  const { data } = await supabase.from('patients')
    .select('id,name,phone,age').eq('tenant_id',tenantId)
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%`).limit(8);
  const el = document.getElementById(resultsId);
  if (!data?.length) { el.style.display='none'; return; }
  el.style.display = '';
  if (resultsId === 'search-results') _registerSearchResults = data;
  else _modalSearchResults = data;
  el.innerHTML = data.map(p => `
    <div class="search-item" data-onclick="${onSelectFnName}" data-onclick-a0="${p.id}">
      <div class="pt-name">${_esc(p.name)}</div>
      <div class="pt-meta">${_esc(p.phone||'—')} · Age ${p.age||'—'}</div>
    </div>`).join('');
}

window.selectRegisterPatient = function(id) {
  const p = _registerSearchResults.find(x => x.id === id);
  if (!p) return;
  document.getElementById('search-results').style.display='none';
  document.getElementById('pt-search').value = p.name;
  loadPatientSessions(p);
};

window.selectModalPatient = function(id) {
  const p = _modalSearchResults.find(x => x.id === id);
  if (!p) return;
  _selectedPatient = p;
  document.getElementById('m-search-results').style.display='none';
  document.getElementById('m-pt-search').value = p.name;
  const tag = document.getElementById('m-patient-tag');
  tag.textContent = `✓ ${p.name} · ${p.phone||'—'}`;
  tag.style.display = '';
  document.getElementById('m-patient-id').value = p.id;
};

// ── Referring doctor search (referral_by FK → profiles.id) ───────────────────
window.debounceReferralSearch = function(val) {
  clearTimeout(_referralSearchTimer);
  if (val.length < 2) { document.getElementById('m-referral-results').style.display='none'; return; }
  _referralSearchTimer = setTimeout(() => searchReferralDoctors(val), 300);
};

async function searchReferralDoctors(q) {
  const { data } = await supabase.from('profiles')
    .select('id,full_name').eq('tenant_id',tenantId).eq('role','doctor')
    .ilike('full_name',`%${q}%`).limit(8);
  const el = document.getElementById('m-referral-results');
  if (!data?.length) { el.style.display='none'; return; }
  _referralSearchResults = data;
  el.style.display = '';
  el.innerHTML = data.map(d => `
    <div class="search-item" data-onclick="selectReferralDoctor" data-onclick-a0="${d.id}">
      <div class="pt-name">${_esc(d.full_name)}</div>
    </div>`).join('');
}

window.selectReferralDoctor = function(id) {
  const d = _referralSearchResults.find(x => x.id === id);
  if (!d) return;
  document.getElementById('m-referral-results').style.display='none';
  document.getElementById('m-referral-search').value = d.full_name;
  document.getElementById('m-referral-id').value = d.id;
  const tag = document.getElementById('m-referral-tag');
  tag.textContent = `✓ Dr. ${d.full_name}`;
  tag.style.display = '';
};

async function loadPatientSessions(p) {
  _selectedPatient = p;
  const card = document.getElementById('pt-sessions-card');
  const title = document.getElementById('pt-sessions-title');
  const sub   = document.getElementById('pt-sessions-sub');
  const tbody = document.getElementById('pt-sessions-tbody');
  card.style.display = '';
  title.textContent = `Sessions — ${p.name}`;

  const { data } = await supabase.from('physiotherapy_sessions')
    .select('*').eq('tenant_id',tenantId).eq('patient_id',p.id)
    .order('session_date',{ascending:false});

  const total = data?.length || 0;
  const completed = data?.filter(s=>s.status==='completed').length || 0;
  sub.textContent = `${total} sessions · ${completed} completed`;

  document.getElementById('k-patients').textContent = total;

  if (!data?.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted)">No sessions yet</td></tr>'; return; }
  tbody.innerHTML = data.map(s => `<tr>
    <td>${s.session_date}</td>
    <td style="font-weight:500">${_esc(s.treatment_type)}</td>
    <td>${s.session_number||1} / ${s.total_sessions_planned||1}</td>
    <td style="font-size:12px">${_esc(s.outcome||'—')}</td>
    <td><span class="badge badge-${s.status||'scheduled'}">${(s.status||'').replace('_',' ')}</span></td>
  </tr>`).join('');
}

// ── New session modal ─────────────────────────────────────────────────────────
window.openNewSessionModal = function() {
  document.getElementById('session-modal').style.display = 'flex';
  document.getElementById('m-date').value = today;
  document.getElementById('m-session-no').value = '1';
  document.getElementById('m-total-sessions').value = '';
  document.getElementById('m-duration').value = '30';
  document.getElementById('m-treatment').value = '';
  document.getElementById('m-referral-search').value = '';
  document.getElementById('m-referral-id').value = '';
  document.getElementById('m-referral-results').style.display = 'none';
  document.getElementById('m-referral-tag').style.display = 'none';
  document.getElementById('m-outcome').value = '';
  document.getElementById('m-notes').value = '';
  document.getElementById('m-status').value = 'scheduled';
  if (_selectedPatient) {
    document.getElementById('m-pt-search').value = _selectedPatient.name;
    document.getElementById('m-patient-id').value = _selectedPatient.id;
    const tag = document.getElementById('m-patient-tag');
    tag.textContent = `✓ ${_selectedPatient.name}`;
    tag.style.display = '';
  } else {
    document.getElementById('m-pt-search').value = '';
    document.getElementById('m-patient-id').value = '';
    document.getElementById('m-patient-tag').style.display = 'none';
  }
};
window.closeSessionModal = function() { document.getElementById('session-modal').style.display = 'none'; };

window.saveSession = async function() {
  const patId = document.getElementById('m-patient-id').value;
  const treat = document.getElementById('m-treatment').value.trim();
  if (!patId)  { _alert('error','Select a patient first'); return; }
  if (!treat)  { _alert('error','Treatment type is required'); return; }

  const { error } = await supabase.from('physiotherapy_sessions').insert({
    tenant_id:            tenantId,
    patient_id:           patId,
    session_date:         document.getElementById('m-date').value,
    session_number:       parseInt(document.getElementById('m-session-no').value)||1,
    total_sessions_planned: parseInt(document.getElementById('m-total-sessions').value)||1,
    duration_minutes:     parseInt(document.getElementById('m-duration').value)||30,
    treatment_type:       treat,
    referral_by:          document.getElementById('m-referral-id').value||null,
    physiotherapist_id:   profile.id,
    outcome:              document.getElementById('m-outcome').value.trim()||null,
    notes:                document.getElementById('m-notes').value.trim()||null,
    status:               document.getElementById('m-status').value,
  });

  if (error) { _alert('error', safeErrorMessage(error, 'Could not save session.')); return; }
  closeSessionModal();
  _alert('success','Session saved');
  loadQueue();
  if (_selectedPatient) loadPatientSessions(_selectedPatient);
};

// ── History ───────────────────────────────────────────────────────────────────
window.loadHistory = async function() {
  const month = document.getElementById('hist-month').value;
  if (!month) return;
  const tbody = document.getElementById('hist-tbody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">Loading…</td></tr>';

  const { data, error } = await supabase.from('physiotherapy_sessions')
    .select('*,patients(name,phone),profiles!physiotherapist_id(full_name)')
    .eq('tenant_id',tenantId)
    .gte('session_date', month+'-01')
    .lte('session_date', month+'-31')
    .order('session_date',{ascending:false});

  if (error || !data?.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">No sessions for this month</td></tr>'; return; }
  _histData = data;
  tbody.innerHTML = data.map(s => `<tr>
    <td>${s.session_date}</td>
    <td style="font-weight:500">${_esc(s.patients?.name||'—')}</td>
    <td>${_esc(s.treatment_type)}</td>
    <td>${s.session_number||1}/${s.total_sessions_planned||1}</td>
    <td>${_esc(s.profiles?.full_name||'—')}</td>
    <td style="font-size:12px">${_esc(s.outcome||'—')}</td>
    <td><span class="badge badge-${s.status||'scheduled'}">${(s.status||'').replace('_',' ')}</span></td>
  </tr>`).join('');
};

window.exportHistoryCSV = function() {
  if (!_histData.length) { alert('Load history first'); return; }
  const rows = [['Date','Patient','Treatment','Session#','Total','Physiotherapist','Outcome','Status']];
  _histData.forEach(s => rows.push([s.session_date, s.patients?.name||'', s.treatment_type, s.session_number||1, s.total_sessions_planned||1, s.profiles?.full_name||'', s.outcome||'', s.status||'']));
  const csv = rows.map(r => r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `physiotherapy-${document.getElementById('hist-month').value}.csv`;
  a.click();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _alert(type, msg) { const el=document.getElementById('alert-box'); el.className=`alert ${type} show`; el.textContent=msg; setTimeout(()=>el.classList.remove('show'),4000); }

loadQueue();
document.getElementById('hist-month').value = today.slice(0,7);
