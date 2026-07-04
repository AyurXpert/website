import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse','therapist','receptionist'], 'index.html');
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const now      = new Date();
const todayStr = now.toISOString().split('T')[0];

// Init defaults
document.getElementById('f-date').value = todayStr;
document.getElementById('f-time').value = now.toTimeString().slice(0,5);
document.getElementById('reg-from').value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
document.getElementById('reg-to').value   = todayStr;

// Date change triggers register reload
['reg-from','reg-to'].forEach(id => document.getElementById(id).addEventListener('change', () => loadRegister()));

// ─── State ────────────────────────────────────────────────
let _curProc   = 'agnikarma';
let _patientId = null;
let _patientName = '';
let _regData   = [];

// ─── Procedure type selector ──────────────────────────────
window.selectProc = function(btn) {
  document.querySelectorAll('.proc-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _curProc = btn.dataset.proc;
  document.querySelectorAll('.proc-panel').forEach(p => p.classList.remove('show'));
  document.getElementById('panel-' + _curProc)?.classList.add('show');
  // Update form title
  const labels = { agnikarma:'Agnikarma', raktamokshana:'Raktamokshana', ksharakarma:'Ksharakarma', pain_management:'Pain Management' };
  document.getElementById('form-title').textContent = 'New ' + labels[_curProc] + ' Session';
  if (_patientId) loadPastSessions();
};

// ─── View toggle ──────────────────────────────────────────
window.switchView = function(view, btn) {
  document.querySelectorAll('.vt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('view-new').style.display = view === 'new' ? '' : 'none';
  document.getElementById('view-register').style.display = view === 'register' ? '' : 'none';
  if (view === 'register') loadRegister();
};

window._refreshStatsAndRegister = function() { loadStats(); loadRegister(); };

// ─── Stats ────────────────────────────────────────────────
window.loadStats = async function() {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const [totRes, monRes] = await Promise.all([
    supabase.from('anushastra_sessions').select('id,procedure_type').eq('tenant_id',tenantId),
    supabase.from('anushastra_sessions').select('id,procedure_type').eq('tenant_id',tenantId).gte('created_at',monthStart),
  ]);
  if (totRes.error) {
    if (totRes.error.code === '42P01') {
      ['s-total','s-month','s-agni','s-rakta','s-kshara'].forEach(id => document.getElementById(id).textContent = 'SQL?');
    }
    return;
  }
  const all  = totRes.data || [];
  const mon  = monRes.data || [];
  document.getElementById('s-total').textContent = all.length;
  document.getElementById('s-month').textContent = mon.length;
  document.getElementById('s-agni').textContent  = all.filter(s=>s.procedure_type==='agnikarma').length;
  document.getElementById('s-rakta').textContent = all.filter(s=>s.procedure_type==='raktamokshana').length;
  document.getElementById('s-kshara').textContent= all.filter(s=>s.procedure_type==='ksharakarma').length;
};

// ─── Patient search ───────────────────────────────────────
window.searchPatient = async function() {
  const q = document.getElementById('pt-search').value.trim();
  const res = document.getElementById('pt-results');
  if (q.length < 2) { res.style.display='none'; return; }
  const { data } = await supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId)
    .or(`phone.ilike.%${q}%,name.ilike.%${q}%`).limit(8);
  if (!data?.length) { res.style.display='none'; return; }
  res.style.display = '';
  res.innerHTML = data.map(p=>`<div class="pt-item" data-onclick="selectPatient" data-onclick-a0="${p.id}" data-onclick-a1="${_esc(p.name)}" data-onclick-a2="${_esc(p.phone||'')}">
    <div><div class="pt-name">${_esc(p.name)}</div><div class="pt-meta">${_esc(p.phone||'—')}</div></div>
    <span style="font-size:11px;color:var(--green-mid)">Select →</span>
  </div>`).join('');
};

window.selectPatient = function(id, name, phone) {
  _patientId = id; _patientName = name;
  document.getElementById('pt-search').value = name + (phone ? ' · ' + phone : '');
  document.getElementById('pt-results').style.display = 'none';
  const bar = document.getElementById('patient-bar');
  document.getElementById('pb-name').textContent = name;
  document.getElementById('pb-meta').textContent = phone || 'No phone on record';
  bar.classList.add('show');
  document.getElementById('session-form-card').style.display = '';
  document.getElementById('past-sessions-card').style.display = '';
  document.getElementById('past-title').textContent = 'Past ' + _procLabel(_curProc) + ' Sessions — ' + name;
  loadPastSessions();
};

window.clearPatient = function() {
  _patientId = null; _patientName = '';
  document.getElementById('pt-search').value = '';
  document.getElementById('pt-results').style.display = 'none';
  document.getElementById('patient-bar').classList.remove('show');
  document.getElementById('session-form-card').style.display = 'none';
  document.getElementById('past-sessions-card').style.display = 'none';
  resetForm();
};

// ─── Raktamokshana subtype switch ─────────────────────────
window.updateRaktaSubtype = function(v) {
  document.getElementById('rm-jalouka-fields').style.display = v==='jalaukavacharana' ? '' : 'none';
  document.getElementById('rm-sira-fields').style.display    = v==='siravyadha'       ? '' : 'none';
};

// ─── Save session ─────────────────────────────────────────
window.saveSession = async function() {
  if (!_patientId) { showAlert('Select a patient first','error'); return; }
  const btn = document.getElementById('save-btn');
  btn.disabled = true;

  const payload = {
    tenant_id:   tenantId,
    patient_id:  _patientId,
    doctor_id:   document.getElementById('f-doctor').value || null,
    therapist_id:document.getElementById('f-therapist').value || null,
    procedure_type: _curProc,
    session_date: document.getElementById('f-date').value,
    session_time: document.getElementById('f-time').value || null,
    status:       document.getElementById('f-status').value,
    affected_site:document.getElementById('f-site').value.trim() || null,
    side:         document.getElementById('f-side').value || null,
    duration_minutes: parseInt(document.getElementById('f-duration').value) || null,
    pre_findings: document.getElementById('f-pre').value.trim() || null,
    post_observations: document.getElementById('f-post').value.trim() || null,
    adverse_events: document.getElementById('f-adverse').value.trim() || null,
    medicines_used: document.getElementById('f-meds').value.trim() || null,
    consent_obtained: document.getElementById('consent-check').checked,
    consent_notes: document.getElementById('f-consent-notes').value.trim() || null,
    remarks:      document.getElementById('f-remarks').value.trim() || null,
    created_by:   profile.id,
  };

  if (document.getElementById('f-status').value === 'completed') {
    payload.completed_at = new Date().toISOString();
  }

  // Procedure-specific fields
  if (_curProc === 'agnikarma') {
    payload.shalaka_type    = document.getElementById('ag-shalaka-type').value || null;
    payload.shalaka_material= document.getElementById('ag-material').value || null;
    payload.applications_count = parseInt(document.getElementById('ag-count').value) || null;
    payload.procedure_subtype = document.getElementById('ag-indication').value || null;
  } else if (_curProc === 'raktamokshana') {
    const sub = document.getElementById('rm-subtype').value;
    payload.procedure_subtype = sub;
    payload.rm_indication = document.getElementById('rm-indication').value || null;
    if (sub === 'jalaukavacharana') {
      payload.leech_count   = parseInt(document.getElementById('rm-leech-count').value) || null;
      payload.leech_site    = document.getElementById('rm-leech-site').value.trim() || null;
      payload.leech_time_min= parseInt(document.getElementById('rm-leech-time').value) || null;
    } else if (sub === 'siravyadha') {
      payload.sira_site       = document.getElementById('rm-sira-site').value.trim() || null;
      payload.blood_volume_ml = parseFloat(document.getElementById('rm-sira-vol').value) || null;
    }
  } else if (_curProc === 'ksharakarma') {
    payload.kshara_type    = document.getElementById('kk-type').value || null;
    payload.kshara_drug    = document.getElementById('kk-drug').value || null;
    payload.kshara_method  = document.getElementById('kk-method').value || null;
    payload.procedure_subtype = document.getElementById('kk-indication').value || null;
  } else if (_curProc === 'pain_management') {
    payload.block_type   = document.getElementById('pm-type').value || null;
    payload.drug_used    = document.getElementById('pm-drug').value.trim() || null;
    payload.drug_dose    = document.getElementById('pm-dose').value.trim() || null;
    payload.pain_score_pre  = parseInt(document.getElementById('pm-pain-pre').value) || null;
    payload.pain_score_post = parseInt(document.getElementById('pm-pain-post').value) || null;
  }

  const { error } = await supabase.from('anushastra_sessions').insert(payload);
  btn.disabled = false;
  if (error) {
    if (error.code === '42P01') {
      showAlert('Run anushastra_sessions SQL in Supabase SQL Editor first', 'error');
    } else {
      showAlert(error.message, 'error');
    }
    return;
  }
  showAlert('Session saved successfully ✓', 'success');
  resetForm();
  loadPastSessions();
  loadStats();
};

window.resetForm = function() {
  document.getElementById('f-date').value = todayStr;
  document.getElementById('f-time').value = new Date().toTimeString().slice(0,5);
  document.getElementById('f-status').value = 'scheduled';
  ['f-site','f-pre','f-post','f-adverse','f-meds','f-consent-notes','f-remarks',
   'f-duration','ag-count','rm-leech-count','rm-leech-site','rm-leech-time',
   'rm-leech-paste','rm-sira-site','rm-sira-vol','kk-neutralise','kk-duration',
   'pm-drug','pm-dose','pm-pain-pre','pm-pain-post'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('consent-check').checked = true;
};

// ─── Past sessions for patient ────────────────────────────
window.loadPastSessions = async function() {
  if (!_patientId) return;
  const body = document.getElementById('past-body');
  body.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div>';

  const { data, error } = await supabase.from('anushastra_sessions')
    .select('*,profiles!doctor_id(full_name)')
    .eq('tenant_id',tenantId).eq('patient_id',_patientId).eq('procedure_type',_curProc)
    .order('session_date',{ascending:false}).order('created_at',{ascending:false}).limit(20);

  if (error) {
    if (error.code === '42P01') {
      body.innerHTML = '<div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run anushastra_sessions SQL in Supabase</div></div>';
    } else {
      body.innerHTML = `<div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(error.message)}</div></div>`;
    }
    return;
  }

  document.getElementById('past-title').textContent =
    `Past ${_procLabel(_curProc)} Sessions — ${_esc(_patientName)} (${(data||[]).length})`;

  if (!data?.length) {
    body.innerHTML = `<div class="empty"><div class="empty-ico">🌿</div><div class="empty-ttl">No ${_procLabel(_curProc)} sessions yet for this patient</div></div>`;
    return;
  }

  body.innerHTML = `<div class="tw"><table>
    <thead><tr><th>Date</th><th>Site</th><th>Details</th><th>Doctor</th><th>Status</th><th>Adverse</th></tr></thead>
    <tbody>
    ${data.map(s=>`<tr>
      <td style="font-weight:600;white-space:nowrap">${s.session_date}<br><span style="font-size:11px;color:var(--text-muted)">${s.session_time||''}</span></td>
      <td>${_esc(s.affected_site||'—')} <span style="font-size:11px;color:var(--text-muted)">${s.side||''}</span></td>
      <td style="font-size:12px">${_procDetail(s)}</td>
      <td style="font-size:12px">${s.profiles?.full_name ? 'Dr. '+_esc(s.profiles.full_name) : '—'}</td>
      <td><span class="chip chip-${s.status}">${s.status}</span></td>
      <td style="font-size:12px;color:${s.adverse_events&&s.adverse_events.toLowerCase()!=='none'?'var(--red)':'var(--text-muted)'}">${_esc(s.adverse_events||'None')}</td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
};

// ─── Session Register ─────────────────────────────────────
window.loadRegister = async function() {
  const from   = document.getElementById('reg-from').value;
  const to     = document.getElementById('reg-to').value;
  const type   = document.getElementById('reg-type').value;
  const status = document.getElementById('reg-status').value;
  const tbody  = document.getElementById('reg-tbody');
  tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div></td></tr>';

  let q = supabase.from('anushastra_sessions')
    .select('*,patients(name,phone),profiles!doctor_id(full_name)')
    .eq('tenant_id',tenantId)
    .order('session_date',{ascending:false}).order('created_at',{ascending:false});
  if (from) q = q.gte('session_date',from);
  if (to)   q = q.lte('session_date',to);
  if (type)   q = q.eq('procedure_type',type);
  if (status) q = q.eq('status',status);

  const { data, error } = await q;
  if (error) {
    if (error.code === '42P01') {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run the anushastra_sessions SQL in Supabase SQL Editor</div></div></td></tr>';
    } else {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(error.message)}</div></div></td></tr>`;
    }
    return;
  }
  _regData = data || [];
  if (!_regData.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">🌿</div><div class="empty-ttl">No sessions found in this period</div></div></td></tr>';
    return;
  }
  tbody.innerHTML = _regData.map(s=>`<tr>
    <td style="white-space:nowrap"><strong>${s.session_date}</strong><br><span style="font-size:11px;color:var(--text-muted)">${s.session_time||''}</span></td>
    <td>
      <div style="font-weight:500">${_esc(s.patients?.name||'Unknown')}</div>
      <div style="font-size:11px;color:var(--text-muted)">${_esc(s.patients?.phone||'')}</div>
    </td>
    <td>
      <span class="ptype ptype-${s.procedure_type}">${_procLabel(s.procedure_type)}</span>
      ${s.procedure_subtype ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">${_esc(s.procedure_subtype)}</div>` : ''}
    </td>
    <td style="font-size:12px">${_esc(s.affected_site||'—')}<br><span style="color:var(--text-muted)">${s.side||''}</span></td>
    <td style="font-size:12px">${s.profiles?.full_name ? 'Dr. '+_esc(s.profiles.full_name) : '—'}</td>
    <td style="font-size:12px">${s.duration_minutes ? s.duration_minutes+' min' : '—'}</td>
    <td style="text-align:center">${s.consent_obtained ? '<span class="consent-ok">✓</span>' : '<span class="consent-no">✗</span>'}</td>
    <td><span class="chip chip-${s.status}">${s.status}</span></td>
    <td>
      ${s.status === 'scheduled' || s.status === 'in_progress'
        ? `<button class="btn btn-complete btn-sm" data-onclick="markComplete" data-onclick-a0="${s.id}">✓ Complete</button>`
        : '<span style="font-size:11px;color:var(--text-muted)">Done</span>'}
    </td>
  </tr>`).join('');
};

window.markComplete = async function(id) {
  const { error } = await supabase.from('anushastra_sessions')
    .update({ status:'completed', completed_at: new Date().toISOString() })
    .eq('id',id).eq('tenant_id',tenantId);
  if (error) { _toast(error.message,true); return; }
  _toast('Marked as completed ✓');
  loadRegister();
  loadStats();
};

window.exportRegister = function() {
  if (!_regData.length) { _toast('No data to export'); return; }
  const rows = [
    ['Date','Time','Patient','Phone','Procedure Type','Subtype','Site','Side','Duration (min)','Doctor','Status','Consent','Pre-findings','Post-observations','Adverse Events','Medicines Used','Remarks'],
    ..._regData.map(s=>[
      s.session_date, s.session_time||'', s.patients?.name||'', s.patients?.phone||'',
      s.procedure_type||'', s.procedure_subtype||'', s.affected_site||'', s.side||'',
      s.duration_minutes||'', s.profiles?.full_name||'', s.status||'',
      s.consent_obtained?'Yes':'No', s.pre_findings||'', s.post_observations||'',
      s.adverse_events||'', s.medicines_used||'', s.remarks||''
    ])
  ];
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = 'Anushastra_Karma_Register.csv'; a.click();
};

// ─── Load doctors & therapists ────────────────────────────
async function loadStaff() {
  const { data } = await supabase.from('profiles').select('id,full_name,role')
    .eq('tenant_id',tenantId).eq('is_active',true)
    .in('role',['doctor','therapist','super_admin','dept_admin']).order('full_name');
  const doctors   = (data||[]).filter(p=>['doctor','super_admin','dept_admin'].includes(p.role));
  const therapists= (data||[]).filter(p=>p.role==='therapist');
  const dSel = document.getElementById('f-doctor');
  dSel.innerHTML = '<option value="">— Select Doctor —</option>' + doctors.map(d=>`<option value="${d.id}">Dr. ${_esc(d.full_name)}</option>`).join('');
  const tSel = document.getElementById('f-therapist');
  tSel.innerHTML = '<option value="">— Select (optional) —</option>' + therapists.map(t=>`<option value="${t.id}">${_esc(t.full_name)}</option>`).join('');
}

// ─── Helpers ─────────────────────────────────────────────
function _procLabel(p) {
  return {agnikarma:'Agnikarma',raktamokshana:'Raktamokshana',ksharakarma:'Ksharakarma',pain_management:'Pain Mgmt'}[p]||p||'—';
}
function _procDetail(s) {
  if (s.procedure_type==='agnikarma')
    return [s.shalaka_type, s.shalaka_material, s.applications_count ? s.applications_count+' applications' : ''].filter(Boolean).join(' · ');
  if (s.procedure_type==='raktamokshana')
    return [s.procedure_subtype, s.leech_count ? s.leech_count+' leeches' : '', s.blood_volume_ml ? s.blood_volume_ml+'mL' : ''].filter(Boolean).join(' · ');
  if (s.procedure_type==='ksharakarma')
    return [s.kshara_type, s.kshara_drug].filter(Boolean).join(' · ');
  if (s.procedure_type==='pain_management')
    return [s.block_type, s.drug_used].filter(Boolean).join(' · ');
  return s.procedure_subtype||'—';
}
function showAlert(msg, type) {
  const el = document.getElementById('main-alert');
  el.textContent = msg; el.className = `alert ${type} show`;
  setTimeout(()=>el.classList.remove('show'), 4000);
}
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg,isErr=false){ const el=document.getElementById('toast'); el.textContent=msg; el.style.background=isErr?'#7f1d1d':'#1c2b1f'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

// ─── Boot ─────────────────────────────────────────────────
await Promise.all([loadStaff(), loadStats()]);
