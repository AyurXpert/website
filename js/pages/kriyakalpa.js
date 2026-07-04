import { supabase } from '../core/db/supabaseClient.js';
import { requireAuth, getCurrentProfile, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['doctor','nurse','super_admin','dept_admin','therapist']);
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = tenant?.id;
const userId    = profile?.id;

let _patient    = null;
let _sessions   = [];
let _deptFilter = 'all';
let _completeId = null;
let _searchTimer= null;
let _searchResults = [];

const PROCS = {
  netra: [
    'Netra Tarpana (Akshi Tarpana)',
    'Netra Seka (Akshi Seka)',
    'Putapaka',
    'Aschyotana (Eye Drops)',
    'Anjana (Collyrium)',
    'Bidalaka',
    'Vidalaka',
    'Pindi (Netra Bandana)',
    'Lepa (Eye Pack)',
    'Traataka',
  ],
  ent: [
    'Nasya (Nasal Administration)',
    'Nasyam — Pratimarsha',
    'Nasyam — Marsha',
    'Karnapoorna (Ear Oil)',
    'Karna Dhoopanam (Ear Fumigation)',
    'Karna Prasekam',
    'Gandoosha (Gargling)',
    'Kavala (Oil Pulling)',
    'Dhumapana (Inhalation)',
    'Mukha Lepa (Face Pack)',
    'Shirobasti',
    'Shirodhara',
  ]
};

// ── Search ────────────────────────────────────────────────────────────────────
window.debounceSearch = function(val) {
  clearTimeout(_searchTimer);
  if (val.length < 2) { document.getElementById('search-results').style.display = 'none'; return; }
  _searchTimer = setTimeout(() => searchPatients(val), 300);
};

async function searchPatients(q) {
  const { data } = await supabase.from('patients')
    .select('id,name,phone,age,gender')
    .eq('tenant_id', tenantId)
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
    .limit(8);
  _searchResults = data || [];
  const el = document.getElementById('search-results');
  if (!_searchResults.length) { el.style.display='block'; el.innerHTML='<div style="padding:10px;font-size:13px;color:var(--text-muted)">No patients found</div>'; return; }
  el.style.display = 'block';
  el.innerHTML = _searchResults.map(p => `
    <div class="pt-item" data-onclick="selectPatient" data-onclick-a0="${p.id}">
      <div><div class="pt-name">${_esc(p.name)}</div><div class="pt-meta">${_esc(p.phone||'—')} · Age ${p.age||'—'} · ${_esc((p.gender||'').charAt(0).toUpperCase())}</div></div>
    </div>`).join('');
}

window.selectPatient = async function(id) {
  const p = _searchResults.find(x => x.id === id);
  if (!p) return;
  _patient = p;
  document.getElementById('search-results').style.display = 'none';
  document.getElementById('pt-search').value = p.name;
  document.getElementById('bar-name').textContent = p.name;
  document.getElementById('bar-meta').textContent = `${p.phone||'—'} · Age ${p.age||'—'} · ${(p.gender||'').charAt(0).toUpperCase()}`;
  document.getElementById('patient-bar').classList.add('show');
  document.getElementById('new-sess-btn').disabled = false;
  await loadSessions();
};

window.clearPatient = function() {
  _patient = null;
  document.getElementById('pt-search').value = '';
  document.getElementById('patient-bar').classList.remove('show');
  document.getElementById('stats-section').style.display = 'none';
  document.getElementById('sessions-list').innerHTML = '';
  document.getElementById('new-sess-btn').disabled = true;
};

window.setDept = function(el, dept) {
  document.querySelectorAll('.dept-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  _deptFilter = dept;
  renderSessions();
};

// ── Load sessions ─────────────────────────────────────────────────────────────
async function loadSessions() {
  const { data, error } = await supabase.from('kriyakalpa_sessions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('patient_id', _patient.id)
    .order('session_date').order('session_time');
  if (error) { _alert('error', 'Load error: ' + error.message); return; }
  _sessions = data || [];
  renderSessions();
  updateStats();
}

function renderSessions() {
  document.getElementById('stats-section').style.display = 'block';
  const filtered = _deptFilter === 'all' ? _sessions : _sessions.filter(s => s.dept === _deptFilter);
  const list = document.getElementById('sessions-list');
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🌿</div><div class="empty-title">No ${_deptFilter==='all'?'':_esc(_deptFilter)+' '}sessions yet</div></div>`;
    return;
  }
  list.innerHTML = filtered.map(s => `
    <div class="sess-card ${s.status}" style="margin-bottom:10px">
      <div class="sess-icon">${s.dept === 'netra' ? '👁' : '👂'}</div>
      <div class="sess-info">
        <div class="sess-proc">${_esc(s.procedure_name)}</div>
        <div class="sess-meta">
          📅 ${_fmtDate(s.session_date)} ${s.session_time ? '· ' + s.session_time.slice(0,5) : ''}
          ${s.therapist_name ? '· ' + _esc(s.therapist_name) : ''}
          ${s.medicine_used ? '· <em>' + _esc(s.medicine_used) + '</em>' : ''}
        </div>
        ${s.side && s.side !== 'na' ? `<span class="sess-eye">${{bilateral:'Both sides',right:'Right',left:'Left'}[s.side]||_esc(s.side)}</span>` : ''}
        ${s.course_label ? `<span style="font-size:11px;color:var(--text-muted);margin-left:6px">${_esc(s.course_label)}</span>` : ''}
        ${s.post_observations ? `<div style="font-size:11px;color:var(--text-mid);margin-top:4px">${_esc(s.post_observations)}</div>` : ''}
      </div>
      <div class="sess-actions">
        <span class="status-pill pill-${s.status}">${{scheduled:'Scheduled',in_progress:'In Progress',completed:'Done',cancelled:'Cancelled',skipped:'Skipped'}[s.status]||_esc(s.status)}</span>
        ${s.status === 'scheduled' ? `<button class="btn btn-complete btn-sm" data-onclick="openCompleteModal" data-onclick-a0="${s.id}">✓ Complete</button>` : ''}
        ${s.status === 'scheduled' ? `<button class="btn btn-secondary btn-sm" data-onclick="cancelSession" data-onclick-a0="${s.id}">✕</button>` : ''}
      </div>
    </div>`).join('');
}

function updateStats() {
  const total     = _sessions.length;
  const completed = _sessions.filter(s => s.status === 'completed').length;
  const scheduled = _sessions.filter(s => s.status === 'scheduled').length;
  const courses   = new Set(_sessions.map(s => s.course_label).filter(Boolean)).size;
  document.getElementById('stat-total').textContent    = total;
  document.getElementById('stat-completed').textContent= completed;
  document.getElementById('stat-scheduled').textContent= scheduled;
  document.getElementById('stat-courses').textContent  = courses || '—';
}

// ── Schedule modal ────────────────────────────────────────────────────────────
window.openModal = function() {
  if (!_patient) return;
  document.getElementById('m-date').value  = new Date().toISOString().slice(0,10);
  renderProcChips();
  document.getElementById('sess-overlay').style.display = 'flex';
};

window.closeModal = function() {
  document.getElementById('sess-overlay').style.display = 'none';
};

window.renderProcChips = function() {
  const dept = document.getElementById('m-dept').value;
  const sel  = document.getElementById('m-procedure');
  sel.innerHTML = PROCS[dept].map(p => `<option value="${_esc(p)}">${_esc(p)}</option>`).join('');
};

window.saveSession = async function() {
  if (!_patient) return;
  const dept   = document.getElementById('m-dept').value;
  const proc   = document.getElementById('m-procedure').value;
  if (!proc) { alert('Select a procedure.'); return; }
  const { error } = await supabase.from('kriyakalpa_sessions').insert({
    tenant_id:        tenantId,
    patient_id:       _patient.id,
    doctor_id:        userId,
    dept,
    procedure_name:   proc,
    side:             document.getElementById('m-side').value,
    course_label:     document.getElementById('m-course').value.trim() || null,
    session_date:     document.getElementById('m-date').value,
    session_time:     document.getElementById('m-time').value || null,
    duration_minutes: parseInt(document.getElementById('m-duration').value) || null,
    therapist_name:   document.getElementById('m-therapist').value.trim() || null,
    status:           document.getElementById('m-status').value,
    medicine_used:    document.getElementById('m-medicine').value.trim() || null,
    quantity_used:    document.getElementById('m-qty').value.trim() || null,
    pre_findings:     document.getElementById('m-pre-findings').value.trim() || null,
    post_observations:document.getElementById('m-post-obs').value.trim() || null,
    adverse_events:   document.getElementById('m-adverse').value.trim() || null,
    remarks:          document.getElementById('m-remarks').value.trim() || null,
  });
  if (error) { _alert('error', 'Error: ' + error.message); return; }
  _alert('success', 'Session saved.');
  closeModal();
  await loadSessions();
};

// ── Complete session ──────────────────────────────────────────────────────────
window.openCompleteModal = function(id) {
  _completeId = id;
  document.getElementById('c-date').value  = new Date().toISOString().slice(0,10);
  document.getElementById('c-obs').value   = '';
  document.getElementById('c-med').value   = '';
  document.getElementById('c-qty').value   = '';
  document.getElementById('c-therapist').value = '';
  document.getElementById('complete-overlay').style.display = 'flex';
};

window.closeCompleteModal = function() {
  document.getElementById('complete-overlay').style.display = 'none';
};

window.confirmComplete = async function() {
  if (!_completeId) return;
  const { error } = await supabase.from('kriyakalpa_sessions').update({
    status:           'completed',
    session_date:     document.getElementById('c-date').value,
    therapist_name:   document.getElementById('c-therapist').value.trim() || null,
    post_observations:document.getElementById('c-obs').value.trim() || null,
    medicine_used:    document.getElementById('c-med').value.trim() || null,
    quantity_used:    document.getElementById('c-qty').value.trim() || null,
    completed_at:     new Date().toISOString(),
  }).eq('id', _completeId);
  if (error) { _alert('error', 'Error: ' + error.message); return; }
  _alert('success', 'Session marked completed.');
  closeCompleteModal();
  await loadSessions();
};

window.cancelSession = async function(id) {
  if (!confirm('Cancel this session?')) return;
  const { error } = await supabase.from('kriyakalpa_sessions').update({ status: 'cancelled' }).eq('id', id);
  if (error) { _alert('error', 'Error: ' + error.message); return; }
  await loadSessions();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _alert(type, msg) { const el = document.getElementById('alert-box'); el.className = `alert ${type} show`; el.textContent = msg; setTimeout(() => el.classList.remove('show'), 4000); }
