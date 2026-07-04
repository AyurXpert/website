import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','therapist','doctor','receptionist']);
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const tenantId  = getCurrentTenantId();
const myProfile = getCurrentProfile();

let _sessions    = [];
let _attCounts   = {};   // sessionId -> attendee count
let _activeSess  = null; // session id open in attendance modal
let _attendees   = [];   // rows for the active session
let _searchTimer = null;
const todayStr = new Date().toISOString().slice(0,10);

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.module-tab').forEach(btn => {
  btn.addEventListener('click', () => setTab(btn, btn.dataset.tab));
});
window.setTab = function(btn, tab) {
  document.querySelectorAll('.module-tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-'+tab).classList.add('active');
  if (tab === 'register') loadRegister();
};

// ── Load sessions (Today's Sessions + Session Schedule share this) ────────────
async function loadSessions() {
  const { data, error } = await supabase.from('yoga_sessions')
    .select('id,session_date,session_time,session_type,instructor_id,capacity,status,notes,instructor:profiles!instructor_id(full_name)')
    .eq('tenant_id', tenantId)
    .order('session_date').order('session_time');
  if (error) { _alert('error', safeErrorMessage(error, 'Load error. Please try again.')); return; }
  _sessions = data || [];

  const ids = _sessions.map(s => s.id);
  _attCounts = {};
  if (ids.length) {
    const { data: att } = await supabase.from('yoga_attendance').select('session_id').in('session_id', ids);
    (att || []).forEach(a => { _attCounts[a.session_id] = (_attCounts[a.session_id] || 0) + 1; });
  }

  renderToday();
  renderSchedule();
}

function renderToday() {
  const todays = _sessions.filter(s => s.session_date === todayStr);
  document.getElementById('stat-today-sessions').textContent  = todays.length;
  document.getElementById('stat-today-attendees').textContent = todays.reduce((s,x)=>s+(_attCounts[x.id]||0),0);
  const monthPrefix = todayStr.slice(0,7);
  document.getElementById('stat-month-sessions').textContent  = _sessions.filter(s=>s.session_date.startsWith(monthPrefix)).length;

  const list = document.getElementById('today-list');
  if (!todays.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🧘</div><div class="empty-title">No sessions scheduled today</div></div>`;
    return;
  }
  list.innerHTML = todays.map(s => _sessCard(s, true)).join('');
}

function renderSchedule() {
  const upcoming = _sessions.filter(s => s.status === 'scheduled' && s.session_date >= todayStr);
  const list = document.getElementById('schedule-list');
  if (!upcoming.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-title">No upcoming sessions</div></div>`;
    return;
  }
  list.innerHTML = upcoming.map(s => _sessCard(s, false)).join('');
}

function _sessCard(s, isToday) {
  const timeStr = s.session_time ? s.session_time.slice(0,5) : '—';
  const instructor = s.instructor?.full_name || '— no instructor assigned —';
  const count = _attCounts[s.id] || 0;
  const statusLabel = { scheduled:'Scheduled', completed:'Completed', cancelled:'Cancelled' }[s.status] || s.status;
  return `<div class="sess-card ${s.status}">
    <div class="sess-icon">🧘</div>
    <div class="sess-info">
      <div class="sess-title"><span class="type-badge">${s.session_type === 'group' ? 'Group' : 'Individual'}</span>${timeStr} · ${_esc(instructor)}</div>
      <div class="sess-meta">${_fmtDate(s.session_date)}${s.capacity ? ' · Capacity ' + s.capacity : ''} · ${count} attendee${count===1?'':'s'}${s.notes ? ' · ' + _esc(s.notes) : ''}</div>
    </div>
    <div class="sess-actions">
      <span class="status-pill pill-${s.status}">${statusLabel}</span>
      ${s.status === 'scheduled' ? `<button class="btn btn-secondary btn-sm" data-onclick="openAttendanceModal" data-onclick-a0="${s.id}">👥 Attendance</button>` : ''}
      ${s.status === 'scheduled' ? `<button class="btn btn-secondary btn-sm" data-onclick="openScheduleModal" data-onclick-a0="${s.id}">✎ Edit</button>` : ''}
      ${s.status === 'scheduled' ? `<button class="btn btn-complete btn-sm" data-onclick="markCompleted" data-onclick-a0="${s.id}">✓ Complete</button>` : ''}
      ${s.status === 'scheduled' ? `<button class="btn btn-secondary btn-sm" data-onclick="cancelSession" data-onclick-a0="${s.id}">✕</button>` : ''}
    </div>
  </div>`;
}

// ── Schedule modal ────────────────────────────────────────────────────────────
async function _populateInstructors() {
  const { data } = await supabase.from('profiles')
    .select('id,full_name')
    .eq('tenant_id', tenantId).eq('is_active', true).eq('designation', 'yoga_instructor');
  const sel = document.getElementById('m-instructor');
  sel.innerHTML = '<option value="">— Select instructor —</option>' +
    (data && data.length ? data.map(p => `<option value="${p.id}">${_esc(p.full_name)}</option>`).join('')
      : '<option value="" disabled>No staff tagged as Yoga Instructor — assign via All Staff tab</option>');
}

window.openScheduleModal = async function(id) {
  await _populateInstructors();
  const editing = id ? _sessions.find(s => s.id === id) : null;
  document.getElementById('sess-modal-title').textContent = editing ? 'Edit Yoga Session' : 'Schedule Yoga Session';
  document.getElementById('sess-overlay').dataset.editId = id || '';
  document.getElementById('m-date').value       = editing?.session_date || todayStr;
  document.getElementById('m-time').value       = editing?.session_time?.slice(0,5) || '07:00';
  document.getElementById('m-type').value       = editing?.session_type || 'group';
  document.getElementById('m-capacity').value   = editing?.capacity || '';
  document.getElementById('m-instructor').value = editing?.instructor_id || '';
  document.getElementById('m-notes').value      = editing?.notes || '';
  document.getElementById('sess-overlay').style.display = 'flex';
};

window.closeScheduleModal = function() {
  document.getElementById('sess-overlay').style.display = 'none';
};

window.saveSession = async function() {
  const editId = document.getElementById('sess-overlay').dataset.editId;
  const payload = {
    tenant_id:     tenantId,
    session_date:  document.getElementById('m-date').value,
    session_time:  document.getElementById('m-time').value,
    session_type:  document.getElementById('m-type').value,
    capacity:      parseInt(document.getElementById('m-capacity').value) || null,
    instructor_id: document.getElementById('m-instructor').value || null,
    notes:         document.getElementById('m-notes').value.trim() || null,
  };
  if (!payload.session_date || !payload.session_time) { _alert('error', 'Date and time are required.'); return; }

  const { error } = editId
    ? await supabase.from('yoga_sessions').update(payload).eq('id', editId)
    : await supabase.from('yoga_sessions').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  _alert('success', editId ? 'Session updated.' : 'Session scheduled.');
  closeScheduleModal();
  await loadSessions();
};

window.markCompleted = async function(id) {
  const { error } = await supabase.from('yoga_sessions').update({ status: 'completed' }).eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  await loadSessions();
};

window.cancelSession = async function(id) {
  if (!confirm('Cancel this session?')) return;
  const { error } = await supabase.from('yoga_sessions').update({ status: 'cancelled' }).eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  await loadSessions();
};

// ── Attendance modal ──────────────────────────────────────────────────────────
window.openAttendanceModal = async function(sessionId) {
  _activeSess = sessionId;
  document.getElementById('pt-search').value = '';
  document.getElementById('search-results').innerHTML = '';
  await _loadAttendees();
  document.getElementById('att-overlay').style.display = 'flex';
};

window.closeAttendanceModal = function() {
  document.getElementById('att-overlay').style.display = 'none';
  _activeSess = null;
  loadSessions(); // refresh attendee counts on the cards behind the modal
};

async function _loadAttendees() {
  const { data, error } = await supabase.from('yoga_attendance')
    .select('id,patient_id,marked_at,patients(name,phone)')
    .eq('session_id', _activeSess)
    .order('marked_at');
  if (error) { _alert('error', safeErrorMessage(error, 'Load error. Please try again.')); return; }
  _attendees = data || [];
  _renderAttendees();
}

function _renderAttendees() {
  document.getElementById('att-count').textContent = _attendees.length;
  const list = document.getElementById('attendee-list');
  if (!_attendees.length) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No attendees marked yet — search above to add.</div>`;
    return;
  }
  list.innerHTML = _attendees.map(a => `
    <div class="attendee-row">
      <div>
        <div class="attendee-name">${_esc(a.patients?.name || '—')}</div>
        <div class="attendee-meta">${_esc(a.patients?.phone || '—')}</div>
      </div>
      <button class="remove-btn" data-onclick="removeAttendee" data-onclick-a0="${a.id}" title="Remove">✕</button>
    </div>`).join('');
}

window.debounceSearch = function(val) {
  clearTimeout(_searchTimer);
  if (val.length < 2) { document.getElementById('search-results').innerHTML = ''; return; }
  _searchTimer = setTimeout(() => _searchPatients(val), 300);
};

async function _searchPatients(q) {
  const { data } = await supabase.from('patients')
    .select('id,name,phone,age,gender')
    .eq('tenant_id', tenantId)
    .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
    .limit(8);
  const el = document.getElementById('search-results');
  if (!data?.length) { el.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-muted)">No patients found</div>'; return; }
  el.innerHTML = data.map(p => `
    <div class="pt-item" data-onclick="addAttendee" data-onclick-a0="${p.id}">
      <div><div class="pt-name">${_esc(p.name)}</div><div class="pt-meta">${_esc(p.phone||'—')} · Age ${p.age||'—'} · ${(p.gender||'').charAt(0).toUpperCase()}</div></div>
    </div>`).join('');
}

window.addAttendee = async function(patientId) {
  if (_attendees.some(a => a.patient_id === patientId)) { _alert('error', 'Already marked present for this session.'); return; }
  const { error } = await supabase.from('yoga_attendance').insert({
    tenant_id:  tenantId,
    session_id: _activeSess,
    patient_id: patientId,
    attended:   true,
    marked_at:  new Date().toISOString(),
    marked_by:  myProfile?.id,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  document.getElementById('pt-search').value = '';
  document.getElementById('search-results').innerHTML = '';
  await _loadAttendees();
};

window.removeAttendee = async function(attendanceId) {
  const { error } = await supabase.from('yoga_attendance').delete().eq('id', attendanceId);
  if (error) { _alert('error', safeErrorMessage(error, 'Error. Please try again.')); return; }
  await _loadAttendees();
};

// ── Attendance register ───────────────────────────────────────────────────────
window.loadRegister = async function() {
  const from = document.getElementById('reg-from').value;
  const to   = document.getElementById('reg-to').value;
  let q = supabase.from('yoga_attendance')
    .select('marked_at,patients(name),marked_by:profiles!marked_by(full_name),session:yoga_sessions(session_date,session_time,session_type,instructor:profiles!instructor_id(full_name))')
    .eq('tenant_id', tenantId)
    .order('marked_at', { ascending: false });
  const { data, error } = await q;
  if (error) { _alert('error', safeErrorMessage(error, 'Load error. Please try again.')); return; }

  let rows = data || [];
  if (from) rows = rows.filter(r => r.session?.session_date >= from);
  if (to)   rows = rows.filter(r => r.session?.session_date <= to);
  _renderRegister(rows);
};

let _registerRows = [];
function _renderRegister(rows) {
  _registerRows = rows;
  const tbody = document.getElementById('register-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted)">No attendance records for this range.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${_fmtDate(r.session?.session_date)}</td>
    <td>${r.session?.session_time ? r.session.session_time.slice(0,5) : '—'}</td>
    <td>${r.session?.session_type === 'group' ? 'Group' : 'Individual'}</td>
    <td>${_esc(r.session?.instructor?.full_name || '—')}</td>
    <td>${_esc(r.patients?.name || '—')}</td>
    <td>${_esc(r.marked_by?.full_name || '—')}</td>
    <td>${r.marked_at ? new Date(r.marked_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'}</td>
  </tr>`).join('');
}

window.exportRegisterCSV = function() {
  if (!_registerRows.length) { _alert('error', 'Nothing to export.'); return; }
  const rows = [['Date','Time','Type','Instructor','Patient','Marked By','Marked At']];
  _registerRows.forEach(r => rows.push([
    r.session?.session_date || '', r.session?.session_time?.slice(0,5) || '',
    r.session?.session_type || '', r.session?.instructor?.full_name || '',
    r.patients?.name || '', r.marked_by?.full_name || '', r.marked_at || '',
  ]));
  const csv = rows.map(row => row.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'Yoga_Attendance_Register.csv';
  a.click();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _alert(type, msg) { const el = document.getElementById('alert-box'); el.className = `alert ${type} show`; el.textContent = msg; setTimeout(() => el.classList.remove('show'), 4000); }

// ── Boot ──────────────────────────────────────────────────────────────────────
document.getElementById('reg-from').value = todayStr.slice(0,8) + '01';
document.getElementById('reg-to').value   = todayStr;
await loadSessions();
