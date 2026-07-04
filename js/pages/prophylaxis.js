import { supabase } from '../core/db/supabaseClient.js';
import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar }  from '../components/navbar.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

const ALLOWED = ['super_admin','dept_admin','doctor','receptionist','nurse'];
await requireAuth(ALLOWED);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

// ── State ─────────────────────────────────────────────
let _programmes = [];
let _enrolments = [];
let _activeProg = null;
let _editingProgId = null;
let _editingEnrolId = null;

// ── Tab switch ────────────────────────────────────────
window.switchTab = function(id) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', ['programmes','enrolments'][i] === id));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + id));
  if (id === 'enrolments') _populateProgSelect();
};

// ── Load programmes ───────────────────────────────────
async function loadProgrammes() {
  const { data, error } = await supabase
    .from('prophylaxis_programs')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('start_date', { ascending: false });
  if (error) { _toast('Error loading programmes: ' + error.message, 'error'); return; }
  _programmes = data || [];
  renderProgList();
}

function renderProgList() {
  const el = document.getElementById('prog-list');
  if (!_programmes.length) { el.innerHTML = '<div class="empty">No programmes yet. Click "+ New Programme" to create one.</div>'; return; }
  el.innerHTML = _programmes.map(p => {
    const today = new Date(); const s = new Date(p.start_date); const e = new Date(p.end_date);
    const active = today >= s && today <= e;
    const past   = today > e;
    const statusLabel = active ? '<span style="color:#2d7a4f;font-size:11px;font-weight:600">● Active</span>'
                      : past   ? '<span style="color:#888;font-size:11px">Completed</span>'
                               : '<span style="color:#c9902a;font-size:11px">Upcoming</span>';
    const dur = Math.round((e - s) / 86400000) + 1;
    return `<div class="prog-card" data-onclick="selectProg" data-onclick-a0="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div class="prog-name">${_esc(p.name)}</div>
          <div class="prog-dates">${_fmtDate(p.start_date)} → ${_fmtDate(p.end_date)} · ${dur} days</div>
        </div>
        <span class="season-badge s-${p.season}">${_seasonLabel(p.season)}</span>
      </div>
      <div class="prog-stats">
        <div class="prog-stat">${statusLabel}</div>
        <div class="prog-stat">Max: <strong>${p.max_patients || '—'}</strong></div>
        ${p.medicines?.length ? `<div class="prog-stat">${_esc(p.medicines.slice(0,2).join(', '))}${p.medicines.length>2?'…':''}</div>` : ''}
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-outline btn-sm" data-onclick="_editProgStop" data-onclick-a0="@event" data-onclick-a1="${p.id}">Edit</button>
        <button class="btn btn-gold btn-sm" data-onclick="_goEnrolStop" data-onclick-a0="@event" data-onclick-a1="${p.id}">View Enrolments</button>
      </div>
    </div>`;
  }).join('');
}

window.selectProg = function(id) {
  _activeProg = _programmes.find(p => p.id === id);
};

window._editProgStop = function(e, id) { e.stopPropagation(); editProg(id); };
window._goEnrolStop  = function(e, id) { e.stopPropagation(); goEnrol(id); };

window.goEnrol = function(id) {
  switchTab('enrolments');
  setTimeout(() => {
    document.getElementById('enrol-prog-select').value = id;
    loadEnrolments();
  }, 50);
};

// ── Programme modal ───────────────────────────────────
window.openProgModal = function(prog) {
  _editingProgId = prog?.id || null;
  document.getElementById('prog-modal-title').textContent = prog ? 'Edit Programme' : 'New Programme';
  document.getElementById('pm-name').value      = prog?.name || '';
  document.getElementById('pm-season').value    = prog?.season || '';
  document.getElementById('pm-max').value       = prog?.max_patients || '';
  document.getElementById('pm-start').value     = prog?.start_date || '';
  document.getElementById('pm-end').value       = prog?.end_date || '';
  document.getElementById('pm-medicines').value = (prog?.medicines || []).join(', ');
  document.getElementById('pm-protocol').value  = prog?.protocol || '';
  document.getElementById('pm-desc').value      = prog?.description || '';
  document.getElementById('prog-modal').classList.add('show');
};

window.editProg = function(id) {
  const p = _programmes.find(x => x.id === id);
  if (p) openProgModal(p);
};

window.closeProgModal = function() {
  document.getElementById('prog-modal').classList.remove('show');
  _editingProgId = null;
};

window.saveProgramme = async function() {
  const name  = document.getElementById('pm-name').value.trim();
  const season = document.getElementById('pm-season').value;
  const start  = document.getElementById('pm-start').value;
  const end    = document.getElementById('pm-end').value;
  if (!name || !season || !start || !end) { _toast('Name, season and dates are required', 'error'); return; }
  if (end < start) { _toast('End date must be after start date', 'error'); return; }

  const medRaw = document.getElementById('pm-medicines').value;
  const medicines = medRaw ? medRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  const payload = {
    tenant_id: tenantId, name, season, start_date: start, end_date: end,
    max_patients: parseInt(document.getElementById('pm-max').value) || 30,
    medicines,
    protocol:    document.getElementById('pm-protocol').value.trim() || null,
    description: document.getElementById('pm-desc').value.trim() || null,
  };

  let error;
  if (_editingProgId) {
    ({ error } = await supabase.from('prophylaxis_programs').update(payload).eq('id', _editingProgId));
  } else {
    ({ error } = await supabase.from('prophylaxis_programs').insert({ ...payload, created_by: profile.id }));
  }
  if (error) { _toast('Save error: ' + error.message, 'error'); return; }
  _toast(_editingProgId ? 'Programme updated' : 'Programme created', 'success');
  closeProgModal();
  loadProgrammes();
};

// ── Populate select in enrolments tab ─────────────────
function _populateProgSelect() {
  const sel = document.getElementById('enrol-prog-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select a programme —</option>' +
    _programmes.map(p => `<option value="${p.id}">${_esc(p.name)} (${_fmtDate(p.start_date)})</option>`).join('');
  if (cur) sel.value = cur;
}

// ── Load enrolments ───────────────────────────────────
window.loadEnrolments = async function() {
  const progId = document.getElementById('enrol-prog-select').value;
  document.getElementById('enrolment-section').style.display = progId ? '' : 'none';
  if (!progId) return;
  _activeProg = _programmes.find(p => p.id === progId);
  document.getElementById('enrol-prog-name-lbl').textContent = _activeProg?.name || '';

  const { data, error } = await supabase
    .from('prophylaxis_enrollments')
    .select('*, patients(id, name, phone, age, gender)')
    .eq('program_id', progId)
    .eq('tenant_id', tenantId)
    .order('enrolled_at');
  if (error) { _toast('Error: ' + error.message, 'error'); return; }
  _enrolments = data || [];
  renderEnrolTable();
  updateStats();
};

function renderEnrolTable() {
  const tbody = document.getElementById('enrol-tbody');
  if (!_enrolments.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No patients enrolled yet. Use the search above to enrol.</td></tr>';
    return;
  }
  tbody.innerHTML = _enrolments.map(e => {
    const pat = e.patients;
    const log = e.compliance_log || [];
    const total = log.length;
    const attended = log.filter(d => d.attended).length;
    const pct = total ? Math.round(attended / total * 100) : 0;
    const dots = _buildDots(e);
    return `<tr>
      <td>
        <div style="font-weight:500">${_esc(pat?.name||'—')}</div>
        <div style="font-size:11px;color:var(--text-muted)">${_esc(pat?.phone||'')} · ${pat?.age ? pat.age + 'y' : ''} ${_esc(pat?.gender||'')}</div>
      </td>
      <td style="font-size:12px">${_fmtDate(e.enrolled_at)}</td>
      <td>
        <div class="comp-dots" title="${attended}/${total} sessions attended">${dots}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px">${total ? `${attended}/${total} (${pct}%)` : 'Not started'}</div>
      </td>
      <td><span class="status-badge st-${e.status}">${_statusLabel(e.status)}</span></td>
      <td style="font-size:12px;max-width:140px;word-break:break-word">${_esc(e.outcome||'—')}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" data-onclick="markToday" data-onclick-a0="${e.id}">Mark Today</button>
          <button class="btn btn-sm" style="background:var(--gold-light);color:#7a5200;border:1px solid #e8c97a" data-onclick="openOutcomeModal" data-onclick-a0="${e.id}">Outcome</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function _buildDots(e) {
  if (!_activeProg) return '';
  const log = e.compliance_log || [];
  const logMap = {};
  log.forEach(d => logMap[d.date] = d.attended);
  const start = new Date(_activeProg.start_date);
  const end   = new Date(_activeProg.end_date);
  const today = new Date(); today.setHours(0,0,0,0);
  let dots = '';
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0,10);
    const isFuture = d > today;
    const cls = isFuture ? 'future' : (logMap[ds] ? 'attended' : 'absent');
    const title = isFuture ? ds : (logMap[ds] ? `${ds} ✓` : `${ds} ✗`);
    dots += `<div class="comp-dot ${cls}" title="${title}" data-date="${ds}" data-enrol="${e.id}"></div>`;
  }
  return dots;
}

function updateStats() {
  const total    = _enrolments.length;
  const done     = _enrolments.filter(e => e.status === 'completed').length;
  const compPcts = _enrolments.map(e => {
    const log = e.compliance_log || [];
    return log.length ? log.filter(d => d.attended).length / log.length * 100 : null;
  }).filter(v => v !== null);
  const avgComp  = compPcts.length ? Math.round(compPcts.reduce((a,b) => a+b, 0) / compPcts.length) : null;
  const daysLeft = _activeProg ? Math.max(0, Math.round((new Date(_activeProg.end_date) - new Date()) / 86400000)) : null;

  document.getElementById('st-enrolled').textContent  = total;
  document.getElementById('st-completed').textContent = done;
  document.getElementById('st-compliance').textContent = avgComp !== null ? avgComp + '%' : '—';
  document.getElementById('st-days-left').textContent = daysLeft !== null ? daysLeft : '—';
}

// ── Mark today ────────────────────────────────────────
window.markToday = async function(enrolId) {
  const today = new Date().toISOString().slice(0,10);
  const enrol = _enrolments.find(e => e.id === enrolId);
  if (!enrol) return;
  const log = [...(enrol.compliance_log || [])];
  const existing = log.find(d => d.date === today);
  if (existing) {
    existing.attended = !existing.attended;
  } else {
    log.push({ date: today, attended: true });
  }
  log.sort((a, b) => a.date.localeCompare(b.date));
  const { error } = await supabase.from('prophylaxis_enrollments')
    .update({ compliance_log: log }).eq('id', enrolId);
  if (error) { _toast('Error: ' + error.message, 'error'); return; }
  enrol.compliance_log = log;
  renderEnrolTable();
  updateStats();
  _toast('Attendance updated', 'success');
};

// ── Outcome modal ─────────────────────────────────────
window.openOutcomeModal = function(enrolId) {
  _editingEnrolId = enrolId;
  const e = _enrolments.find(x => x.id === enrolId);
  document.getElementById('oc-status').value = e?.status || 'enrolled';
  document.getElementById('oc-notes').value  = e?.outcome || '';
  document.getElementById('outcome-modal').classList.add('show');
};

window.closeOutcomeModal = function() {
  document.getElementById('outcome-modal').classList.remove('show');
  _editingEnrolId = null;
};

window.saveOutcome = async function() {
  const { error } = await supabase.from('prophylaxis_enrollments').update({
    status:  document.getElementById('oc-status').value,
    outcome: document.getElementById('oc-notes').value.trim() || null,
  }).eq('id', _editingEnrolId);
  if (error) { _toast('Error: ' + error.message, 'error'); return; }
  const e = _enrolments.find(x => x.id === _editingEnrolId);
  if (e) { e.status = document.getElementById('oc-status').value; e.outcome = document.getElementById('oc-notes').value.trim(); }
  closeOutcomeModal();
  renderEnrolTable();
  updateStats();
  _toast('Outcome saved', 'success');
};

// ── Patient search for enrolment ──────────────────────
let _searchTimer;
window.searchEnrolPatient = function() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(_doSearch, 300);
};

async function _doSearch() {
  const q = document.getElementById('enrol-search').value.trim();
  const el = document.getElementById('enrol-results');
  if (q.length < 3) { el.innerHTML = ''; return; }
  const isPhone = /^\d{7,}$/.test(q);
  const { data } = isPhone
    ? await supabase.from('patients').select('id,name,phone,age,gender').eq('tenant_id', tenantId).eq('phone', q).limit(5)
    : await supabase.from('patients').select('id,name,phone,age,gender').eq('tenant_id', tenantId).ilike('name', `%${q}%`).limit(5);
  if (!data?.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:6px">No patients found</div>'; return; }
  el.innerHTML = data.map(p => {
    const alreadyEnrolled = _enrolments.some(e => e.patients?.id === p.id || e.patient_id === p.id);
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:13px;font-weight:500">${_esc(p.name)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${_esc(p.phone||'')} · ${p.age ? p.age + 'y' : ''} ${_esc(p.gender||'')}</div>
      </div>
      ${alreadyEnrolled
        ? '<span style="font-size:11px;color:var(--text-muted)">Already enrolled</span>'
        : `<button class="btn btn-gold btn-sm" data-onclick="enrolPatient" data-onclick-a0="${p.id}" data-onclick-a1="${_esc(p.name)}">Enrol</button>`
      }
    </div>`;
  }).join('');
}

window.enrolPatient = async function(patientId, patientName) {
  const progId = document.getElementById('enrol-prog-select').value;
  if (!progId) { _toast('Select a programme first', 'error'); return; }
  const prog = _programmes.find(p => p.id === progId);
  const maxP = prog?.max_patients || 9999;
  if (_enrolments.length >= maxP) { _toast(`Programme is full (max ${maxP} patients)`, 'error'); return; }

  const { error } = await supabase.from('prophylaxis_enrollments').insert({
    tenant_id: tenantId, program_id: progId, patient_id: patientId,
    enrolled_by: profile.id, enrolled_at: new Date().toISOString().slice(0,10),
    compliance_log: [], status: 'enrolled',
  });
  if (error) { _toast('Enrol error: ' + error.message, 'error'); return; }
  _toast(`${patientName} enrolled`, 'success');
  document.getElementById('enrol-search').value = '';
  document.getElementById('enrol-results').innerHTML = '';
  loadEnrolments();
};

// ── Export CSV ────────────────────────────────────────
window.exportEnrolCSV = function() {
  if (!_enrolments.length) { _toast('No data to export', 'error'); return; }
  const rows = [['Patient','Phone','Age','Gender','Enrolled On','Sessions Attended','Total Sessions','Compliance %','Status','Outcome']];
  _enrolments.forEach(e => {
    const pat = e.patients;
    const log = e.compliance_log || [];
    const att = log.filter(d => d.attended).length;
    const pct = log.length ? Math.round(att/log.length*100) : 0;
    rows.push([pat?.name||'',pat?.phone||'',pat?.age||'',pat?.gender||'',e.enrolled_at,att,log.length,pct+'%',e.status,e.outcome||'']);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `prophylaxis_${_activeProg?.name?.replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
};

// ── Helpers ───────────────────────────────────────────
function _fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function _seasonLabel(s) {
  return {vasanta:'Vasanta',sharad:'Sharad',hemanta:'Hemanta',shishira:'Shishira',grishma:'Grishma',varsha:'Varsha',custom:'Custom'}[s] || _esc(s);
}
function _statusLabel(s) {
  return {enrolled:'Enrolled',completed:'Completed',dropped:'Dropped',no_show:'No Show'}[s] || _esc(s);
}
function _toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Init ──────────────────────────────────────────────
await loadProgrammes();
