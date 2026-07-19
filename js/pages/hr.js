import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/+esm';
import { requireAuth, hasModule, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { ENV } from '../config/env.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

const ALLOWED = ['super_admin','dept_admin'];
await requireAuth(ALLOWED);
if (!hasModule('hr')) { window.location.replace('admin.html'); }

const supabase  = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY);
const sess      = getCurrentProfile() || {};
const tenantId  = getCurrentTenantId();
const isAdmin   = ['super_admin','dept_admin'].includes(sess.role);

wireDelegatedEvents();

initNavbar();

// ── State ──────────────────────────────────────────────
let _staff = [], _leaves = [], _trainings = [], _healthRecords = [];
let _calYear, _calMonth;
let _rejectingLeaveId = null;
let _viewingStaff = null;
let _healthProfileId = null;
const today = new Date().toISOString().slice(0,10);

// ── Tab switch ─────────────────────────────────────────
window.switchTab = function(id) {
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', ['directory','leave','training','health','credentials'][i] === id));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === 'tab-' + id));
  if (id === 'leave')       loadLeaves();
  if (id === 'training')    loadTrainings();
  if (id === 'health')      loadHealth();
  if (id === 'credentials') loadCredentials();
};

// ── Load all on init ────────────────────────────────────
async function init() {
  await loadStaff();
  await loadLeaves();
  await loadTrainings();
  updateKPIs();
}

// ── Staff directory ─────────────────────────────────────
async function loadStaff() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, phone, status, is_active, created_at, department_id')
    .eq('tenant_id', tenantId)
    .order('full_name');
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  _staff = data || [];
  _populateStaffSelects();
  filterStaff();
}

window.filterStaff = function() {
  const q      = document.getElementById('dir-search').value.toLowerCase();
  const role   = document.getElementById('dir-role').value;
  const status = document.getElementById('dir-status').value;
  const filtered = _staff.filter(s =>
    (!q      || s.full_name?.toLowerCase().includes(q) || s.phone?.includes(q)) &&
    (!role   || s.role === role) &&
    (!status || s.status === status)
  );
  renderStaffGrid(filtered);
};

function renderStaffGrid(list) {
  const el = document.getElementById('staff-grid');
  if (!list.length) { el.innerHTML = '<div class="empty">No staff found</div>'; return; }
  el.innerHTML = list.map(s => {
    const initials = (s.full_name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
    const joined = s.created_at ? new Date(s.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
    return `<div class="staff-card">
      <div class="sc-top">
        <div class="sc-avatar">${_esc(initials)}</div>
        <div>
          <div class="sc-name">${_esc(s.full_name || '—')}</div>
          <div class="sc-role">${_roleLabel(s.role)}</div>
        </div>
        <span class="badge b-${s.status}" style="margin-left:auto">${_statusLabel(s.status)}</span>
      </div>
      <div class="sc-meta">
        Phone: <span>${_esc(s.phone || '—')}</span>
        Joined: <span>${joined}</span>
      </div>
      <div class="sc-actions">
        <button class="btn btn-outline btn-sm" data-onclick="openStaffModal" data-onclick-a0="${s.id}">View Profile</button>
        <button class="btn btn-sm" style="background:var(--gold-light);color:#7a5200;border:1px solid #e8c97a"
          data-onclick="openLeaveModalFor" data-onclick-a0="${s.id}">Apply Leave</button>
      </div>
    </div>`;
  }).join('');
}

window.openStaffModal = function(id) {
  _viewingStaff = _staff.find(s => s.id === id);
  if (!_viewingStaff) return;
  const s = _viewingStaff;
  const initials = (s.full_name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const joined = s.created_at ? new Date(s.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  const staffLeaves = _leaves.filter(l => l.profile_id === id);
  const staffTrainings = _trainings.filter(t => t.profile_id === id);

  document.getElementById('sm-title').textContent = s.full_name || 'Staff Profile';
  document.getElementById('sm-body').innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:18px">
      <div class="sc-avatar" style="width:56px;height:56px;font-size:22px">${_esc(initials)}</div>
      <div>
        <div style="font-size:17px;font-weight:600;color:var(--green-deep)">${_esc(s.full_name||'—')}</div>
        <div style="font-size:13px;color:var(--text-muted)">${_roleLabel(s.role)}</div>
        <span class="badge b-${s.status}" style="margin-top:4px">${_statusLabel(s.status)}</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;font-size:13px;margin-bottom:18px">
      <div><span style="color:var(--text-muted)">Phone:</span> ${_esc(s.phone||'—')}</div>
      <div><span style="color:var(--text-muted)">Joined:</span> ${joined}</div>
      <div><span style="color:var(--text-muted)">Role:</span> ${_roleLabel(s.role)}</div>
      <div><span style="color:var(--text-muted)">Active:</span> ${s.is_active?'Yes':'No'}</div>
    </div>
    <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
      Leave History (${staffLeaves.length} requests)
    </div>
    ${staffLeaves.length ? `<div style="font-size:12px;max-height:120px;overflow-y:auto">
      ${staffLeaves.map(l => `<div style="display:flex;gap:10px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">
        <span class="badge b-${l.leave_type}" style="flex-shrink:0">${_esc(l.leave_type)}</span>
        <span style="color:var(--text-mid)">${_fmtD(l.from_date)} → ${_fmtD(l.to_date)}</span>
        <span class="badge b-${l.status}" style="margin-left:auto">${_esc(l.status)}</span>
      </div>`).join('')}
    </div>` : '<div style="font-size:12px;color:var(--text-muted)">No leave requests</div>'}
    <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px">
      Training Records (${staffTrainings.length})
    </div>
    ${staffTrainings.length ? `<div style="font-size:12px;max-height:100px;overflow-y:auto">
      ${staffTrainings.map(t => `<div style="padding:4px 0;border-bottom:1px solid var(--border)">
        <strong>${_esc(t.title)}</strong> · <span style="color:var(--text-muted)">${_fmtD(t.training_date)} · ${_esc(t.training_type)}</span>
      </div>`).join('')}
    </div>` : '<div style="font-size:12px;color:var(--text-muted)">No training records</div>'}`;

  // Reset MFA — super_admin only (mirrors promote_to_dept_admin's precedent of
  // restricting sensitive account actions to super_admin, not dept_admin too)
  document.getElementById('sm-reset-mfa-btn').style.display = sess.role === 'super_admin' ? '' : 'none';

  // Status action buttons — show relevant action for each status
  const btn = document.getElementById('sm-suspend-btn');
  const isActive = ['active','approved'].includes(s.status);
  if (isActive) {
    btn.innerHTML = `<select id="sm-status-change" style="padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-size:12px;font-family:inherit;margin-right:6px">
      <option value="">— Change status —</option>
      <option value="suspended">Suspend (temp block)</option>
      <option value="on_leave">Mark On Leave</option>
      <option value="inactive">Mark Inactive</option>
      <option value="blocked">Block (permanent)</option>
    </select>`;
    btn.onclick = _applyStatusChange;
    btn.style.display = '';
    btn.style.background = 'none';
    btn.style.border = 'none';
    btn.style.padding = '0';
  } else if (['suspended','on_leave','inactive','blocked'].includes(s.status)) {
    btn.textContent = 'Reactivate Staff';
    btn.style.cssText = '';
    btn.onclick = toggleSuspend;
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
  document.getElementById('staff-modal').classList.add('show');
};

window.closeStaffModal = function() { document.getElementById('staff-modal').classList.remove('show'); };

async function _applyStatusChange() {
  const sel = document.getElementById('sm-status-change');
  const newStatus = sel?.value;
  if (!newStatus) { _toast('Select a status to apply', 'error'); return; }
  const labels = { suspended:'Suspend', on_leave:'Mark On Leave', inactive:'Mark Inactive', blocked:'Block' };
  if (!confirm(`${labels[newStatus] || 'Change status of'} ${_viewingStaff.full_name}?`)) return;
  const { error } = await supabase.from('profiles').update({
    status: newStatus, is_active: false,
  }).eq('id', _viewingStaff.id);
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeStaffModal();
  await loadStaff();
  _toast(`${_viewingStaff.full_name} — status set to ${newStatus.replace(/_/g,' ')}`, 'success');
}

window.toggleSuspend = async function() {
  if (!_viewingStaff) return;
  if (!confirm(`Reactivate ${_viewingStaff.full_name}?`)) return;
  const { error } = await supabase.from('profiles').update({ status: 'active', is_active: true })
    .eq('id', _viewingStaff.id);
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeStaffModal();
  await loadStaff();
  _toast(_viewingStaff.full_name + ' reactivated', 'success');
};

window.resetStaffMfa = async function() {
  if (!_viewingStaff) return;
  if (!confirm(`Reset two-factor authentication for ${_viewingStaff.full_name}? They will need to set it up again before they can log in.`)) return;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;

  try {
    const res = await fetch('https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/mfa-admin-reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ targetUserId: _viewingStaff.id }),
    });
    const result = await res.json();
    if (!res.ok) { _toast(result.error || 'Could not reset MFA.', 'error'); return; }
    _toast(`MFA reset for ${_viewingStaff.full_name}`, 'success');
  } catch (err) {
    _toast(safeErrorMessage(err, 'Could not reset MFA. Please try again.'), 'error');
  }
};

window.exportStaffCSV = function() {
  _csvDownload(_staff.map(s => ({
    Name: s.full_name, Role: s.role, Phone: s.phone,
    Status: s.status, Joined: s.created_at?.slice(0,10),
  })), 'staff_directory');
};

// ── Leave management ────────────────────────────────────
async function loadLeaves() {
  const { data, error } = await supabase
    .from('staff_leaves')
    .select('*, profiles!profile_id(full_name, role), covering:profiles!covering_profile_id(full_name, role)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error && error.code === '42P01') {
    document.getElementById('pending-leaves-list').innerHTML =
      '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">Leave table not set up yet — run the SQL below to activate.</div>';
    return;
  }
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  _leaves = data || [];
  renderPendingLeaves();
  renderLeaveList();
  updateKPIs();
  if (_calYear) renderCalendar();
}

function renderPendingLeaves() {
  const pending = _leaves.filter(l => l.status === 'pending');
  const badge = document.getElementById('pending-count-badge');
  badge.innerHTML = pending.length ? `<span class="badge b-pending">${pending.length}</span>` : '';
  const el = document.getElementById('pending-leaves-list');
  if (!pending.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No pending leave requests.</div>'; return; }
  el.innerHTML = pending.map(l => {
    const days = _leaveDays(l.from_date, l.to_date);
    return `<div class="leave-card pending">
      <div class="lc-top">
        <div>
          <div class="lc-name">${_esc(l.profiles?.full_name || '—')} <span style="font-weight:400;color:var(--text-muted)">(${_roleLabel(l.profiles?.role)})</span></div>
          <div class="lc-meta">${_fmtD(l.created_at?.slice(0,10))}</div>
        </div>
        <span class="badge b-${l.leave_type}">${_esc(l.leave_type)}</span>
      </div>
      <div class="lc-dates">📅 ${_fmtD(l.from_date)} → ${_fmtD(l.to_date)} &nbsp;·&nbsp; ${days} day${days>1?'s':''}</div>
      ${l.reason ? `<div class="lc-reason">"${_esc(l.reason)}"</div>` : ''}
      ${l.covering ? `<div class="lc-meta">🤝 Charge given to: <strong>${_esc(l.covering.full_name)}</strong> (${_roleLabel(l.covering.role)})</div>` : ''}
      <div class="lc-actions">
        <button class="btn btn-approve btn-sm" data-onclick="approveLeave" data-onclick-a0="${l.id}">✓ Approve</button>
        <button class="btn btn-reject btn-sm" data-onclick="openRejectModal" data-onclick-a0="${l.id}">✗ Reject</button>
      </div>
    </div>`;
  }).join('');
}

window.renderLeaveList = function() {
  const staffFilter  = document.getElementById('leave-filter-staff').value;
  const statusFilter = document.getElementById('leave-filter-status').value;
  const filtered = _leaves.filter(l =>
    (!staffFilter  || l.profile_id === staffFilter) &&
    (!statusFilter || l.status === statusFilter)
  );
  const el = document.getElementById('leave-list-body');
  if (!filtered.length) { el.innerHTML = '<div class="empty">No leave requests found</div>'; return; }
  el.innerHTML = filtered.map(l => {
    const days = _leaveDays(l.from_date, l.to_date);
    return `<div class="leave-card ${l.status}">
      <div class="lc-top">
        <div>
          <div class="lc-name">${_esc(l.profiles?.full_name || '—')}</div>
          <div class="lc-meta">${_roleLabel(l.profiles?.role)} · Applied ${_fmtD(l.created_at?.slice(0,10))}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <span class="badge b-${l.leave_type}">${_esc(l.leave_type)}</span>
          <span class="badge b-${l.status}">${_esc(l.status)}</span>
        </div>
      </div>
      <div class="lc-dates">📅 ${_fmtD(l.from_date)} → ${_fmtD(l.to_date)} · ${days} day${days>1?'s':''}</div>
      ${l.reason ? `<div class="lc-reason">"${_esc(l.reason)}"</div>` : ''}
      ${l.covering ? `<div class="lc-meta">🤝 Charge given to: <strong>${_esc(l.covering.full_name)}</strong> (${_roleLabel(l.covering.role)})</div>` : ''}
      ${l.rejection_reason ? `<div style="font-size:12px;color:var(--red);margin-top:4px">Rejected: ${_esc(l.rejection_reason)}</div>` : ''}
    </div>`;
  }).join('');
};

window.approveLeave = async function(id) {
  const { error } = await supabase.from('staff_leaves').update({
    status: 'approved', approved_by: sess.id, approved_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  _toast('Leave approved', 'success');
  await loadLeaves();
};

window.openRejectModal = function(id) {
  _rejectingLeaveId = id;
  document.getElementById('reject-reason').value = '';
  document.getElementById('reject-modal').classList.add('show');
};
window.closeRejectModal = function() { document.getElementById('reject-modal').classList.remove('show'); _rejectingLeaveId = null; };

window.confirmReject = async function() {
  const reason = document.getElementById('reject-reason').value.trim();
  if (!reason) { _toast('Please enter a reason for rejection', 'error'); return; }
  const { error } = await supabase.from('staff_leaves').update({
    status: 'rejected', approved_by: sess.id, approved_at: new Date().toISOString(),
    rejection_reason: reason,
  }).eq('id', _rejectingLeaveId);
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeRejectModal();
  _toast('Leave rejected', 'success');
  await loadLeaves();
};

// ── Leave modal ─────────────────────────────────────────
window.openLeaveModal = function() { _openLeaveModalFor(''); };
window.openLeaveModalFor = function(id) { _openLeaveModalFor(id); };
function _openLeaveModalFor(id) {
  document.getElementById('lm-staff').value = id || '';
  document.getElementById('lm-type').value  = 'casual';
  document.getElementById('lm-from').value  = today;
  document.getElementById('lm-to').value    = today;
  document.getElementById('lm-covering').value = '';
  document.getElementById('lm-reason').value= '';
  document.getElementById('lm-days-label').textContent = '1 day';
  document.getElementById('leave-modal').classList.add('show');
}
window.closeLeaveModal = function() { document.getElementById('leave-modal').classList.remove('show'); };

document.getElementById('lm-from').addEventListener('change', _updateDaysLabel);
document.getElementById('lm-to').addEventListener('change', _updateDaysLabel);
function _updateDaysLabel() {
  const f = document.getElementById('lm-from').value;
  const t = document.getElementById('lm-to').value;
  if (f && t && t >= f) {
    const d = _leaveDays(f, t);
    document.getElementById('lm-days-label').textContent = d + ' day' + (d > 1 ? 's' : '');
  }
}

window.submitLeave = async function() {
  const staffId = document.getElementById('lm-staff').value || sess.id;
  const type  = document.getElementById('lm-type').value;
  const from  = document.getElementById('lm-from').value;
  const to    = document.getElementById('lm-to').value;
  const covering = document.getElementById('lm-covering').value;
  const reason = document.getElementById('lm-reason').value.trim();
  if (!from || !to || to < from) { _toast('Please select valid dates', 'error'); return; }
  if (covering && covering === staffId) { _toast('Covering staff cannot be the same person taking leave.', 'error'); return; }
  const { error } = await supabase.from('staff_leaves').insert({
    tenant_id: tenantId, profile_id: staffId,
    leave_type: type, from_date: from, to_date: to, reason: reason || null,
    covering_profile_id: covering || null,
    status: isAdmin ? 'approved' : 'pending',
    ...(isAdmin ? { approved_by: sess.id, approved_at: new Date().toISOString() } : {}),
  });
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeLeaveModal();
  _toast(isAdmin ? 'Leave recorded (auto-approved)' : 'Leave request submitted', 'success');
  await loadLeaves();
};

// ── Calendar view ───────────────────────────────────────
const now = new Date();
_calYear = now.getFullYear(); _calMonth = now.getMonth();

window.switchLeaveView = function(v) {
  document.getElementById('leave-list-view').style.display    = v === 'list'     ? '' : 'none';
  document.getElementById('leave-calendar-view').style.display = v === 'calendar' ? '' : 'none';
  if (v === 'calendar') renderCalendar();
};

window.calNav = function(dir) {
  _calMonth += Number(dir);
  if (_calMonth > 11) { _calMonth = 0; _calYear++; }
  if (_calMonth < 0)  { _calMonth = 11; _calYear--; }
  renderCalendar();
};

function renderCalendar() {
  const year = _calYear, month = _calMonth;
  document.getElementById('cal-month-label').textContent =
    new Date(year, month, 1).toLocaleDateString('en-IN', { month:'long', year:'numeric' });

  const approvedLeaves = _leaves.filter(l => l.status === 'approved');
  const leaveMap = {};
  approvedLeaves.forEach(l => {
    const s = new Date(l.from_date), e = new Date(l.to_date);
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      const k = d.toISOString().slice(0,10);
      if (!leaveMap[k]) leaveMap[k] = [];
      leaveMap[k].push(l.profiles?.full_name?.split(' ')[0] || '?');
    }
  });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev  = new Date(year, month, 0).getDate();

  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d =>
    `<div class="cal-hdr">${d}</div>`).join('');

  for (let i = 0; i < firstDay; i++) {
    const d = daysInPrev - firstDay + 1 + i;
    html += `<div class="cal-day other-month"><div class="cal-day-num">${d}</div></div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = ds === today;
    const names = leaveMap[ds] || [];
    html += `<div class="cal-day${isToday?' today':''}">
      <div class="cal-day-num">${d}</div>
      ${names.slice(0,3).map(n => `<div class="cal-leave-dot">${_esc(n)}</div>`).join('')}
      ${names.length > 3 ? `<div class="cal-leave-dot">+${names.length-3} more</div>` : ''}
    </div>`;
  }
  const totalCells = firstDay + daysInMonth;
  const remaining  = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remaining; i++)
    html += `<div class="cal-day other-month"><div class="cal-day-num">${i}</div></div>`;

  document.getElementById('cal-grid').innerHTML = html;
}

// ── Training records ────────────────────────────────────
async function loadTrainings() {
  const { data, error } = await supabase
    .from('training_records')
    .select('*, profiles!profile_id(full_name, role)')
    .eq('tenant_id', tenantId)
    .order('training_date', { ascending: false });
  if (error && error.code === '42P01') {
    document.getElementById('training-tbody').innerHTML =
      '<tr><td colspan="9" class="empty">Training table not set up yet — run the SQL to activate.</td></tr>';
    return;
  }
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  _trainings = data || [];
  renderTraining();
  updateKPIs();
}

window.renderTraining = function() {
  const staffId = document.getElementById('tr-staff').value;
  const type    = document.getElementById('tr-type').value;
  const month   = document.getElementById('tr-month').value;
  const filtered = _trainings.filter(t =>
    (!staffId || t.profile_id === staffId) &&
    (!type    || t.training_type === type) &&
    (!month   || t.training_date?.startsWith(month))
  );
  const tbody = document.getElementById('training-tbody');
  tbody.innerHTML = filtered.map(t => `<tr>
    <td style="font-size:12px;white-space:nowrap">${_fmtD(t.training_date)}</td>
    <td style="font-weight:500">${_esc(t.profiles?.full_name||'—')}</td>
    <td style="font-size:11px;color:var(--text-muted)">${_roleLabel(t.profiles?.role)}</td>
    <td>${_esc(t.title)}</td>
    <td><span class="badge b-pending" style="font-size:10px">${_esc(t.training_type)}</span></td>
    <td style="font-size:12px">${_esc(t.conducted_by||'—')}</td>
    <td style="text-align:center">${t.duration_hours||'—'}</td>
    <td style="text-align:center">${t.score!=null ? t.score+'%' : '—'}</td>
    <td style="font-size:12px">${t.certificate_url ? `<a href="${_esc(t.certificate_url)}" target="_blank" style="color:var(--green-mid)">View</a>` : '—'}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty">No training records found</td></tr>';
};

window.openTrainingModal = function() {
  document.getElementById('tm-title').value  = '';
  document.getElementById('tm-type').value   = 'cme';
  document.getElementById('tm-date').value   = today;
  document.getElementById('tm-by').value     = '';
  document.getElementById('tm-venue').value  = '';
  document.getElementById('tm-hours').value  = '';
  document.getElementById('tm-score').value  = '';
  document.getElementById('tm-notes').value  = '';
  document.getElementById('training-modal').classList.add('show');
};
window.closeTrainingModal = function() { document.getElementById('training-modal').classList.remove('show'); };

window.saveTraining = async function() {
  const staffId = document.getElementById('tm-staff').value;
  const title   = document.getElementById('tm-title').value.trim();
  const type    = document.getElementById('tm-type').value;
  const date    = document.getElementById('tm-date').value;
  if (!staffId || !title || !date) { _toast('Staff, title and date are required', 'error'); return; }
  const { error } = await supabase.from('training_records').insert({
    tenant_id: tenantId, profile_id: staffId, title, training_type: type, training_date: date,
    conducted_by: document.getElementById('tm-by').value.trim() || null,
    venue:        document.getElementById('tm-venue').value.trim() || null,
    duration_hours: parseFloat(document.getElementById('tm-hours').value) || null,
    score:        parseFloat(document.getElementById('tm-score').value) || null,
    notes:        document.getElementById('tm-notes').value.trim() || null,
    recorded_by:  sess.id,
  });
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeTrainingModal();
  _toast('Training record saved', 'success');
  await loadTrainings();
};

window.exportTrainingCSV = function() {
  _csvDownload(_trainings.map(t => ({
    Date: t.training_date, Staff: t.profiles?.full_name, Role: t.profiles?.role,
    Title: t.title, Type: t.training_type, ConductedBy: t.conducted_by,
    Hours: t.duration_hours, Score: t.score,
  })), 'training_records');
};

// ── KPI update ─────────────────────────────────────────
function updateKPIs() {
  const active    = _staff.filter(s => s.status === 'active').length;
  const pending   = _staff.filter(s => s.status === 'pending_approval').length;
  const leavePend = _leaves.filter(l => l.status === 'pending').length;
  const onLeave   = _leaves.filter(l => l.status === 'approved' && l.from_date <= today && l.to_date >= today).length;
  const thisMonth = new Date().toISOString().slice(0,7);
  const trainMth  = _trainings.filter(t => t.training_date?.startsWith(thisMonth)).length;
  document.getElementById('k-total').textContent       = _staff.length;
  document.getElementById('k-total-sub').textContent   = `${active} active, ${pending} pending`;
  document.getElementById('k-active').textContent      = active;
  document.getElementById('k-pending').textContent     = pending;
  document.getElementById('k-leave-pending').textContent = leavePend;
  document.getElementById('k-on-leave').textContent    = onLeave;
  document.getElementById('k-training').textContent    = trainMth;
}

// ── Populate selects ────────────────────────────────────
function _populateStaffSelects() {
  const opts = _staff.map(s => `<option value="${s.id}">${_esc(s.full_name)} (${_roleLabel(s.role)})</option>`).join('');
  ['leave-filter-staff','lm-staff','lm-covering','tm-staff'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const prefix = id === 'leave-filter-staff' ? '<option value="">All Staff</option>' :
                   id === 'lm-staff'            ? '<option value="">— Self —</option>' :
                   id === 'lm-covering'         ? '<option value="">— Not specified —</option>' : '';
    el.innerHTML = prefix + opts;
  });
  document.getElementById('tr-staff').innerHTML = '<option value="">All Staff</option>' + opts;
  document.getElementById('health-rec-filter').innerHTML = '<option value="">All Staff</option>' + opts;
}

// ═══════════════════════════════════════════════
// HEALTH CHECK-UPS
// ═══════════════════════════════════════════════

async function loadHealth() {
  const { data, error } = await supabase
    .from('employee_health_records')
    .select('*, profiles:profiles!profile_id(id, full_name, role)')
    .eq('tenant_id', tenantId)
    .order('checkup_date', { ascending: false });
  if (error) { _toast(safeErrorMessage(error, 'Error loading health records.'), 'error'); return; }
  _healthRecords = data || [];
  _renderHealthStatus();
  _renderHealthRecords();
  _updateHealthKPIs();
}

function _renderHealthStatus() {
  const search = (document.getElementById('health-search')?.value || '').toLowerCase();
  const fitFilter = document.getElementById('health-filter-status')?.value || '';
  const tbody = document.getElementById('health-tbody');
  const cutoff12 = new Date(); cutoff12.setMonth(cutoff12.getMonth() - 12);
  const cutoff6  = new Date(); cutoff6.setMonth(cutoff6.getMonth() - 6);

  // Build last-checkup map per staff
  const lastCheckup = {};
  _healthRecords.forEach(r => {
    if (!lastCheckup[r.profile_id] || r.checkup_date > lastCheckup[r.profile_id].checkup_date) {
      lastCheckup[r.profile_id] = r;
    }
  });

  let rows = _staff.filter(s => ['active','approved','pending_approval'].includes(s.status));
  if (search) rows = rows.filter(s => s.full_name?.toLowerCase().includes(search) || s.phone?.includes(search));

  rows = rows.map(s => {
    const rec = lastCheckup[s.id] || null;
    const dateStr = rec?.checkup_date || null;
    let statusClass = 'red', statusLabel = 'Never Checked', dueness = 0;
    if (dateStr) {
      const d = new Date(dateStr);
      if (d >= cutoff6)       { statusClass = 'green'; statusLabel = 'Up to date'; dueness = 2; }
      else if (d >= cutoff12) { statusClass = 'gold';  statusLabel = 'Due soon';    dueness = 1; }
      else                    { statusClass = 'red';   statusLabel = 'Overdue';     dueness = 0; }
    }
    return { ...s, rec, dateStr, statusClass, statusLabel, dueness };
  });

  if (fitFilter === 'overdue') {
    rows = rows.filter(r => r.statusClass === 'red');
  } else if (fitFilter) {
    rows = rows.filter(r => r.rec?.fitness_status === fitFilter);
  }

  const statusColors = { red:'var(--red)', gold:'var(--gold)', green:'var(--green-mid)' };

  tbody.innerHTML = rows.length ? rows.map(r => `<tr>
    <td style="font-weight:500">${_esc(r.full_name)}</td>
    <td style="font-size:11px;color:var(--text-muted)">${_roleLabel(r.role)}</td>
    <td style="font-size:12px">${r.dateStr ? _fmtD(r.dateStr) : '<span style="color:var(--red)">—</span>'}</td>
    <td style="font-size:11px">${r.rec ? _checkupTypeLabel(r.rec.checkup_type) : '—'}</td>
    <td style="font-size:12px">${r.rec?.bp_systolic ? r.rec.bp_systolic+'/'+r.rec.bp_diastolic : '—'}</td>
    <td style="font-size:12px">${r.rec?.bmi != null ? r.rec.bmi.toFixed(1) : '—'}</td>
    <td><span style="font-size:11px;font-weight:600;color:${r.rec ? _fitnessColor(r.rec.fitness_status) : 'var(--text-muted)'}">${r.rec ? _fitnessLabel(r.rec.fitness_status) : '—'}</span></td>
    <td style="font-size:12px"><span style="color:${statusColors[r.statusClass]};font-weight:600">${r.statusLabel}</span>${r.rec?.next_checkup_date ? '<br><span style="font-size:10px;color:var(--text-muted)">Due: '+_fmtD(r.rec.next_checkup_date)+'</span>' : ''}</td>
    <td><button class="btn btn-primary btn-sm" data-onclick="openHealthModal" data-onclick-a0="${r.id}" data-onclick-a1="${_esc(r.full_name||'')}">+ Record</button></td>
  </tr>`).join('') : '<tr><td colspan="9" class="empty">No staff found</td></tr>';
}

function _renderHealthRecords() {
  const filterId = document.getElementById('health-rec-filter')?.value || '';
  const recs = filterId ? _healthRecords.filter(r => r.profile_id === filterId) : _healthRecords;
  const tbody = document.getElementById('health-records-tbody');
  tbody.innerHTML = recs.length ? recs.map(r => `<tr>
    <td style="font-size:12px;white-space:nowrap">${_fmtD(r.checkup_date)}</td>
    <td style="font-weight:500">${_esc(r.profiles?.full_name||'—')}</td>
    <td style="font-size:11px">${_checkupTypeLabel(r.checkup_type)}</td>
    <td style="font-size:12px">${r.bp_systolic ? r.bp_systolic+'/'+r.bp_diastolic : '—'}</td>
    <td style="text-align:right">${r.weight_kg != null ? r.weight_kg : '—'}</td>
    <td style="text-align:right">${r.height_cm != null ? r.height_cm : '—'}</td>
    <td style="text-align:right">${r.bmi != null ? Number(r.bmi).toFixed(1) : '—'}</td>
    <td style="text-align:right">${r.hemoglobin != null ? r.hemoglobin : '—'}</td>
    <td><span style="font-size:11px;font-weight:600;color:${_fitnessColor(r.fitness_status)}">${_fitnessLabel(r.fitness_status)}</span></td>
    <td style="font-size:11px;color:var(--text-muted)">${r.conducted_by||'—'}</td>
  </tr>`).join('') : '<tr><td colspan="10" class="empty">No records found</td></tr>';
}

function _updateHealthKPIs() {
  const cutoff12 = new Date(); cutoff12.setMonth(cutoff12.getMonth() - 12);
  const cutoff6  = new Date(); cutoff6.setMonth(cutoff6.getMonth() - 6);
  const activeStaff = _staff.filter(s => ['active','approved'].includes(s.status));
  const lastCheckup = {};
  _healthRecords.forEach(r => {
    if (!lastCheckup[r.profile_id] || r.checkup_date > lastCheckup[r.profile_id]) lastCheckup[r.profile_id] = r.checkup_date;
  });
  let never=0, overdue=0, due=0, ok=0;
  activeStaff.forEach(s => {
    const d = lastCheckup[s.id];
    if (!d)                        never++;
    else if (new Date(d) < cutoff12) overdue++;
    else if (new Date(d) < cutoff6)  due++;
    else                             ok++;
  });
  const restrict = _healthRecords.filter(r => r.fitness_status === 'fit_with_restrictions').length;
  const thisYear = new Date().getFullYear().toString();
  const total = _healthRecords.filter(r => r.checkup_date?.startsWith(thisYear)).length;
  document.getElementById('hk-never').textContent   = never;
  document.getElementById('hk-overdue').textContent = overdue;
  document.getElementById('hk-due').textContent     = due;
  document.getElementById('hk-ok').textContent      = ok;
  document.getElementById('hk-restrict').textContent= restrict;
  document.getElementById('hk-total').textContent   = total;
}

window.filterHealthTable = function() { _renderHealthStatus(); };
window.filterHealthRecords = function() { _renderHealthRecords(); };

window.openHealthModal = function(profileId, name) {
  _healthProfileId = profileId;
  document.getElementById('hm-staff-name').textContent = name;
  document.getElementById('hm-date').value = today;
  document.getElementById('hm-type').value = 'annual';
  document.getElementById('hm-bp-sys').value = '';
  document.getElementById('hm-bp-dia').value = '';
  document.getElementById('hm-pulse').value  = '';
  document.getElementById('hm-weight').value = '';
  document.getElementById('hm-height').value = '';
  document.getElementById('hm-bmi').value    = '';
  document.getElementById('hm-bmi-label').textContent = '';
  document.getElementById('hm-vis-r').value  = '';
  document.getElementById('hm-vis-l').value  = '';
  document.getElementById('hm-hb').value     = '';
  document.getElementById('hm-bs').value     = '';
  document.getElementById('hm-fitness').value = 'fit';
  document.getElementById('hm-restrictions').value = '';
  document.getElementById('hm-findings').value = '';
  document.getElementById('hm-by').value     = '';
  document.getElementById('hm-cert').checked = false;
  document.getElementById('hm-restrictions-field').style.display = 'none';
  // Default next check-up = 1 year from today
  const next = new Date(); next.setFullYear(next.getFullYear() + 1);
  document.getElementById('hm-next-date').value = next.toISOString().slice(0,10);
  document.getElementById('health-modal').classList.add('show');
};

window.closeHealthModal = function() {
  document.getElementById('health-modal').classList.remove('show');
  _healthProfileId = null;
};

window._calcBMI = function() {
  const w = parseFloat(document.getElementById('hm-weight').value);
  const h = parseFloat(document.getElementById('hm-height').value);
  if (w > 0 && h > 0) {
    const bmi = (w / (h/100) ** 2).toFixed(1);
    document.getElementById('hm-bmi').value = bmi;
    const b = parseFloat(bmi);
    const cat = b < 18.5 ? 'Underweight' : b < 25 ? 'Normal' : b < 30 ? 'Overweight' : 'Obese';
    const col = b < 18.5 ? 'var(--gold)' : b < 25 ? 'var(--green-mid)' : b < 30 ? 'var(--gold)' : 'var(--red)';
    document.getElementById('hm-bmi-label').innerHTML = `<span style="color:${col}">${cat}</span>`;
  } else {
    document.getElementById('hm-bmi').value = '';
    document.getElementById('hm-bmi-label').textContent = '';
  }
};

window._toggleRestrictions = function() {
  const v = document.getElementById('hm-fitness').value;
  document.getElementById('hm-restrictions-field').style.display =
    (v === 'fit_with_restrictions' || v === 'unfit' || v === 'referred') ? '' : 'none';
};

window.saveHealth = async function() {
  if (!_healthProfileId) return;
  const date = document.getElementById('hm-date').value;
  const type = document.getElementById('hm-type').value;
  const fit  = document.getElementById('hm-fitness').value;
  if (!date) { _toast('Please select a check-up date', 'error'); return; }
  if ((fit !== 'fit') && !document.getElementById('hm-restrictions').value.trim()) {
    _toast('Please enter restrictions / referral details', 'error'); return;
  }
  const w = parseFloat(document.getElementById('hm-weight').value) || null;
  const h = parseFloat(document.getElementById('hm-height').value) || null;
  const bmiVal = (w && h) ? parseFloat((w / (h/100)**2).toFixed(1)) : null;

  const payload = {
    tenant_id:          tenantId,
    profile_id:         _healthProfileId,
    checkup_date:       date,
    checkup_type:       type,
    conducted_by:       document.getElementById('hm-by').value.trim() || null,
    bp_systolic:        parseInt(document.getElementById('hm-bp-sys').value) || null,
    bp_diastolic:       parseInt(document.getElementById('hm-bp-dia').value) || null,
    pulse:              parseInt(document.getElementById('hm-pulse').value) || null,
    weight_kg:          w,
    height_cm:          h,
    bmi:                bmiVal,
    vision_right:       document.getElementById('hm-vis-r').value.trim() || null,
    vision_left:        document.getElementById('hm-vis-l').value.trim() || null,
    hemoglobin:         parseFloat(document.getElementById('hm-hb').value) || null,
    blood_sugar:        parseFloat(document.getElementById('hm-bs').value) || null,
    findings:           document.getElementById('hm-findings').value.trim() || null,
    fitness_status:     fit,
    restrictions:       document.getElementById('hm-restrictions').value.trim() || null,
    next_checkup_date:  document.getElementById('hm-next-date').value || null,
    certificate_issued: document.getElementById('hm-cert').checked,
    recorded_by:        sess.id,
  };

  const { error } = await supabase.from('employee_health_records').insert(payload);
  if (error) { _toast(safeErrorMessage(error, 'Save error. Please try again.'), 'error'); return; }
  _toast('Health check-up recorded', 'success');
  closeHealthModal();
  loadHealth();
};

window.exportHealthCSV = function() {
  _csvDownload(_healthRecords.map(r => ({
    Date: r.checkup_date, Staff: r.profiles?.full_name, Role: r.profiles?.role,
    Type: r.checkup_type, BP: r.bp_systolic ? r.bp_systolic+'/'+r.bp_diastolic : '',
    Weight_kg: r.weight_kg, Height_cm: r.height_cm, BMI: r.bmi,
    Vision_R: r.vision_right, Vision_L: r.vision_left,
    Hemoglobin: r.hemoglobin, BloodSugar: r.blood_sugar,
    Fitness: r.fitness_status, Restrictions: r.restrictions||'',
    NextDue: r.next_checkup_date, ConductedBy: r.conducted_by||'',
    CertIssued: r.certificate_issued ? 'Yes' : 'No',
  })), 'employee_health_checkups');
};

function _checkupTypeLabel(t) {
  return {annual:'Annual',pre_employment:'Pre-Employment',periodic:'Periodic',
    exit:'Exit Medical',fitness:'Fitness Cert.'}[t] || (t||'—');
}
function _fitnessLabel(s) {
  return {fit:'Fit for Duty',fit_with_restrictions:'Fit (Restricted)',
    unfit:'Unfit',referred:'Referred'}[s] || (s||'—');
}
function _fitnessColor(s) {
  return {fit:'var(--green-mid)',fit_with_restrictions:'var(--gold)',
    unfit:'var(--red)',referred:'var(--text-muted)'}[s] || 'var(--text-muted)';
}

// ── Helpers ────────────────────────────────────────────
function _leaveDays(from, to) {
  return Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
}
function _fmtD(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _roleLabel(r) {
  return {super_admin:'Super Admin',dept_admin:'Dept Admin',doctor:'Doctor',receptionist:'Receptionist',
    pharmacist:'Pharmacist',nurse:'Nurse',nurse_manager:'Nurse Manager',lab_tech:'Lab Tech',accountant:'Accountant',
    therapist:'Therapist',student:'Student'}[r] || (r||'—');
}
function _statusLabel(s) {
  return {
    active:'Active', pending_approval:'Pending', approved:'Approved',
    rejected:'Rejected', suspended:'Suspended',
    on_leave:'On Leave', inactive:'Inactive', blocked:'Blocked',
  }[s] || (s||'—');
}
function _toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}
function _csvDownload(rows, name) {
  if (!rows.length) { _toast('No data', 'error'); return; }
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','), ...rows.map(r => keys.map(k=>`"${String(r[k]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `${name}_${new Date().toISOString().slice(0,10)}.csv`; a.click();
}

await init();

// ── NABH Credentials & Privileging ───────────────────────────────────────────
let _credEditId = null;

async function loadCredentials() {
  const el = document.getElementById('cred-list');
  const alertEl = document.getElementById('cred-expiry-alerts');
  const { data } = await supabase.from('staff_credentials')
    .select('*,profiles!profile_id(full_name,role)')
    .eq('tenant_id', tenantId)
    .order('created_at',{ascending:false});
  if (!data?.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:32px;font-size:13px">No credentials recorded yet. Click + Add / Update to get started.</div>'; alertEl.innerHTML=''; return; }
  const today = new Date();
  const expiring = data.filter(c => c.registration_expiry && new Date(c.registration_expiry) < new Date(today.getTime()+90*86400000));
  alertEl.innerHTML = expiring.length ? `<div style="background:#fdecea;border:1.5px solid #f5b8b8;border-radius:8px;padding:10px 14px;font-size:12px;color:#8b1a1a">⚠ <strong>${expiring.length} registration(s) expiring within 90 days:</strong> ${expiring.map(c=>`${_esc(c.profiles?.full_name||'—')} (${_esc(c.registration_expiry)})`).join(', ')}</div>` : '';
  el.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f5faf7">
      <th style="padding:8px 12px;text-align:left;border-bottom:1.5px solid var(--border)">Name</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:1.5px solid var(--border)">Role</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:1.5px solid var(--border)">Qualification</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:1.5px solid var(--border)">Reg. No.</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:1.5px solid var(--border)">Reg. Body</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:1.5px solid var(--border)">Expiry</th>
      <th style="padding:8px 12px;text-align:center;border-bottom:1.5px solid var(--border)">Privileges</th>
      <th style="padding:8px 12px;text-align:center;border-bottom:1.5px solid var(--border)">Verified</th>
      <th style="padding:8px 12px;border-bottom:1.5px solid var(--border)"></th>
    </tr></thead>
    <tbody>${data.map(c => {
      const exp = c.registration_expiry ? new Date(c.registration_expiry) : null;
      const expClass = !exp ? '' : exp < today ? 'color:#c0392b;font-weight:700' : exp < new Date(today.getTime()+90*86400000) ? 'color:#e67e22;font-weight:600' : 'color:var(--green-mid)';
      const privs = [c.can_admit_patients&&'Admit',c.can_prescribe&&'Rx',c.can_perform_pk&&'PK',c.can_perform_surgery&&'Surgery',c.can_administer_meds&&'Meds'].filter(Boolean);
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;font-weight:600">${_esc(c.profiles?.full_name||'—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;color:var(--text-muted)">${_esc(c.profiles?.role||'—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${_esc(c.degree||c.qualification||'—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${_esc(c.registration_number||'—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${_esc(c.registration_body||'—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;${expClass}">${_esc(c.registration_expiry||'—')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;text-align:center">${privs.length ? privs.map(p=>`<span style="font-size:9px;background:#e8f5ee;color:#1a4a2e;border:1px solid #b8ddc6;border-radius:8px;padding:1px 5px;margin:1px;display:inline-block">${p}</span>`).join('') : '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;text-align:center">${c.credentials_verified ? '<span style="color:#27ae60;font-weight:700">✅</span>' : '<span style="color:#e67e22">⏳</span>'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2"><button data-onclick="openCredModal" data-onclick-a0="${c.id}" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);background:#fff;border-radius:5px;cursor:pointer">Edit</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

window.openCredModal = async function(credId) {
  _credEditId = credId || null;
  document.getElementById('cred-modal').style.display = 'flex';
  // Load staff for selector
  const { data: staff } = await supabase.from('profiles').select('id,full_name,role').eq('tenant_id',tenantId).eq('is_active',true).in('role',['doctor','nurse','therapist','lab_tech']);
  const sel = document.getElementById('cred-profile-sel');
  sel.innerHTML = '<option value="">— Select staff member —</option>' + (staff||[]).map(s=>`<option value="${s.id}">${_esc(s.full_name)} (${_esc(s.role)})</option>`).join('');
  if (credId) {
    const { data: c } = await supabase.from('staff_credentials').select('*').eq('id',credId).single();
    if (c) {
      sel.value = c.profile_id || '';
      ['degree','registration_number','registration_body','registration_expiry','specialization','experience_years','privileges_text'].forEach(f => { const el = document.getElementById('cred-'+f.replace(/_/g,'-')); if(el) el.value = c[f]||''; });
      document.getElementById('cred-can-admit').checked   = c.can_admit_patients||false;
      document.getElementById('cred-can-rx').checked      = c.can_prescribe||false;
      document.getElementById('cred-can-pk').checked      = c.can_perform_pk||false;
      document.getElementById('cred-can-surg').checked    = c.can_perform_surgery||false;
      document.getElementById('cred-can-meds').checked    = c.can_administer_meds||false;
      document.getElementById('cred-verified').checked    = c.credentials_verified||false;
    }
  }
};
window.closeCredModal = function() { document.getElementById('cred-modal').style.display='none'; _credEditId=null; };
window.saveCred = async function() {
  const profileId = document.getElementById('cred-profile-sel').value;
  if (!profileId) { _toast('Select a staff member','error'); return; }
  const payload = {
    tenant_id: tenantId, profile_id: profileId,
    degree:               document.getElementById('cred-degree').value.trim()||null,
    registration_number:  document.getElementById('cred-registration-number').value.trim()||null,
    registration_body:    document.getElementById('cred-registration-body').value.trim()||null,
    registration_expiry:  document.getElementById('cred-registration-expiry').value||null,
    specialization:       document.getElementById('cred-specialization').value.trim()||null,
    experience_years:     parseInt(document.getElementById('cred-experience-years').value)||null,
    privileges_text:      document.getElementById('cred-privileges-text').value.trim()||null,
    can_admit_patients:   document.getElementById('cred-can-admit').checked,
    can_prescribe:        document.getElementById('cred-can-rx').checked,
    can_perform_pk:       document.getElementById('cred-can-pk').checked,
    can_perform_surgery:  document.getElementById('cred-can-surg').checked,
    can_administer_meds:  document.getElementById('cred-can-meds').checked,
    credentials_verified: document.getElementById('cred-verified').checked,
    verified_by:          document.getElementById('cred-verified').checked ? sess.id : null,
    verified_at:          document.getElementById('cred-verified').checked ? new Date().toISOString() : null,
    updated_at:           new Date().toISOString(),
  };
  let error;
  if (_credEditId) {
    ({ error } = await supabase.from('staff_credentials').update(payload).eq('id',_credEditId));
  } else {
    ({ error } = await supabase.from('staff_credentials').upsert(payload,{onConflict:'profile_id'}));
  }
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Credentials saved','success');
  closeCredModal();
  loadCredentials();
};
