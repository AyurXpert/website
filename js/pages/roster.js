import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin', 'dept_admin']);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ── State ──────────────────────────────────────────
let _weekStart  = _getMonday(new Date());
let _depts      = [];
let _doctors    = [];
let _roster     = [];     // duty_roster rows for current week
let _editEntry  = null;   // existing row being edited

const SHIFTS      = ['morning','afternoon','night'];
const SHIFT_LABELS = { morning:'Morning', afternoon:'Afternoon', night:'Night', on_call:'On-Call' };
const SHIFT_TIMES  = { morning:'06:00–14:00', afternoon:'14:00–22:00', night:'22:00–06:00', on_call:'24hr specialist' };

// ── Utilities ──────────────────────────────────────
function _getMonday(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const m = new Date(d);
  m.setDate(m.getDate() + diff);
  m.setHours(0,0,0,0);
  return m;
}
function _dateStr(d) {
  return d.toISOString().split('T')[0];
}
function _fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN',{day:'numeric',month:'short'});
}
function _fmtDay(d) {
  return new Date(d).toLocaleDateString('en-IN',{weekday:'short'});
}
function _isToday(d) {
  return _dateStr(new Date(d)) === _dateStr(new Date());
}
function _weekDates() {
  return Array.from({length:7}, (_,i) => {
    const d = new Date(_weekStart);
    d.setDate(d.getDate() + i);
    return _dateStr(d);
  });
}

// ── Load data ──────────────────────────────────────
async function loadDepartments() {
  const { data } = await supabase.from('departments')
    .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active',true).order('name');
  _depts = data || [];

  const fd = document.getElementById('filter-dept');
  const md = document.getElementById('m-dept');
  [fd, md].forEach(sel => {
    const preserve = sel.value;
    while(sel.options.length > (sel === fd ? 1 : 0)) sel.remove(sel.options.length-1);
    _depts.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
      sel.appendChild(o);
    });
    if (preserve) sel.value = preserve;
  });
}

async function loadDoctors() {
  const { data } = await supabase.from('profiles')
    .select('id,full_name,role')
    .eq('tenant_id', tenantId)
    .in('role', ['doctor','nurse'])
    .eq('status','active')
    .order('full_name');
  _doctors = data || [];
  const sel = document.getElementById('m-doctor');
  while(sel.options.length > 1) sel.remove(1);
  _doctors.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.full_name + (d.role === 'nurse' ? ' (Nurse/RMO)' : '');
    sel.appendChild(o);
  });
}

async function loadRoster() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  let q = supabase.from('duty_roster')
    .select('id,department_id,profile_id,shift_date,shift_type,is_confirmed,notes,profiles(full_name)')
    .eq('tenant_id', tenantId)
    .gte('shift_date', dates[0])
    .lte('shift_date', dates[6]);
  if (deptFilter) q = q.eq('department_id', deptFilter);
  const { data } = await q;
  _roster = data || [];
  renderRoster();
  renderOnCall();
  updateGapBanner();
}

// ── Render weekly roster ───────────────────────────
function renderRoster() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  const depts = deptFilter ? _depts.filter(d => d.id === deptFilter) : _depts;

  // Header
  const thead = document.getElementById('roster-thead');
  thead.innerHTML = `<tr>
    <th class="shift-col">Shift</th>
    ${dates.map((d,i) => `<th class="${_isToday(d)?'today-col':''}">${_fmtDay(d)}<br><span style="font-weight:400;font-size:10px">${_fmtDate(d)}</span></th>`).join('')}
  </tr>`;

  // Body — one group of rows per dept
  const tbody = document.getElementById('roster-tbody');
  if (!depts.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No departments configured.</td></tr>'; return; }

  let html = '';
  depts.forEach(dept => {
    html += `<tr><td colspan="8" style="background:var(--green-light);color:var(--green-deep);font-weight:600;font-size:11px;padding:5px 10px;text-transform:uppercase;letter-spacing:.5px">${_esc(dept.name)}</td></tr>`;
    SHIFTS.forEach(shift => {
      html += `<tr>
        <td class="shift-label"><span class="shift-badge ${shift}">${SHIFT_LABELS[shift]}</span><br><span style="font-size:9px">${SHIFT_TIMES[shift]}</span></td>
        ${dates.map(d => {
          const entry = _roster.find(r => r.department_id === dept.id && r.shift_date === d && r.shift_type === shift);
          return _cellHtml(dept.id, d, shift, entry);
        }).join('')}
      </tr>`;
    });
  });
  tbody.innerHTML = html;

  // Attach cell click handlers
  tbody.querySelectorAll('.shift-cell').forEach(cell => {
    cell.addEventListener('click', () => openModal(
      cell.dataset.dept, cell.dataset.date, cell.dataset.shift, cell.dataset.entryId || null
    ));
  });
}

function _cellHtml(deptId, date, shift, entry) {
  const today = _isToday(date);
  if (!entry) {
    return `<td class="${today?'today-col':''}">
      <div class="shift-cell gap ${shift}" data-dept="${deptId}" data-date="${date}" data-shift="${shift}">
        <span class="cell-gap-label">⚠ Unassigned</span>
      </div></td>`;
  }
  const name = entry.profiles?.full_name || '—';
  return `<td class="${today?'today-col':''}">
    <div class="shift-cell ${shift}" data-dept="${deptId}" data-date="${date}" data-shift="${shift}" data-entry-id="${entry.id}">
      <span class="cell-name">${_esc(name)}</span>
      ${entry.is_confirmed ? '<span class="cell-confirmed">✓ Confirmed</span>' : '<span class="cell-status">Pending confirm</span>'}
      ${entry.notes ? `<span class="cell-status">${_esc(entry.notes)}</span>` : ''}
    </div></td>`;
}

// ── On-Call roster ─────────────────────────────────
function renderOnCall() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  const depts = deptFilter ? _depts.filter(d => d.id === deptFilter) : _depts;

  const thead = document.getElementById('oncall-thead');
  thead.innerHTML = `<tr>
    <th class="shift-col">Specialty Dept</th>
    ${dates.map(d => `<th class="${_isToday(d)?'today-col':''}">${_fmtDay(d)}<br><span style="font-weight:400;font-size:10px">${_fmtDate(d)}</span></th>`).join('')}
  </tr>`;

  const tbody = document.getElementById('oncall-tbody');
  if (!depts.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No departments configured.</td></tr>'; return; }

  let html = '';
  depts.forEach(dept => {
    html += `<tr>
      <td class="shift-label"><span class="shift-badge on_call">${_esc(dept.ncism_code || '—')}</span><br><span style="font-size:10px;color:var(--text-mid)">${_esc(dept.name)}</span></td>
      ${dates.map(d => {
        const entry = _roster.find(r => r.department_id === dept.id && r.shift_date === d && r.shift_type === 'on_call');
        return _cellHtml(dept.id, d, 'on_call', entry);
      }).join('')}
    </tr>`;
  });
  tbody.innerHTML = html;

  tbody.querySelectorAll('.shift-cell').forEach(cell => {
    cell.addEventListener('click', () => openModal(
      cell.dataset.dept, cell.dataset.date, cell.dataset.shift, cell.dataset.entryId || null
    ));
  });
}

// ── Gap detection ──────────────────────────────────
function updateGapBanner() {
  const dates = _weekDates();
  const deptFilter = document.getElementById('filter-dept').value;
  const depts = deptFilter ? _depts.filter(d => d.id === deptFilter) : _depts;
  let gaps = 0;
  depts.forEach(dept => {
    SHIFTS.forEach(shift => {
      dates.forEach(d => {
        const has = _roster.some(r => r.department_id === dept.id && r.shift_date === d && r.shift_type === shift);
        if (!has) gaps++;
      });
    });
  });
  const banner = document.getElementById('gap-banner');
  if (gaps > 0) {
    banner.textContent = `⚠ NCISM §51(5) compliance issue: ${gaps} shift${gaps>1?'s':''} unassigned this week — 24×7 coverage not met.`;
    banner.classList.add('show');
  } else {
    banner.textContent = '';
    banner.classList.remove('show');
  }
}

// ── Week navigation ────────────────────────────────
function updateWeekLabel() {
  const dates = _weekDates();
  document.getElementById('week-label').textContent =
    `${_fmtDate(dates[0])} – ${_fmtDate(dates[6])}`;
}

document.getElementById('btn-prev-week').addEventListener('click', () => {
  _weekStart.setDate(_weekStart.getDate() - 7); updateWeekLabel(); loadRoster();
});
document.getElementById('btn-next-week').addEventListener('click', () => {
  _weekStart.setDate(_weekStart.getDate() + 7); updateWeekLabel(); loadRoster();
});
document.getElementById('btn-today').addEventListener('click', () => {
  _weekStart = _getMonday(new Date()); updateWeekLabel(); loadRoster();
});
document.getElementById('filter-dept').addEventListener('change', loadRoster);
document.getElementById('btn-add-shift').addEventListener('click', () => openModal(null, _dateStr(new Date()), 'morning', null));

// ── Modal ──────────────────────────────────────────
function openModal(deptId, date, shift, entryId) {
  _editEntry = entryId ? _roster.find(r => r.id === entryId) : null;

  document.getElementById('m-dept').value  = deptId || '';
  document.getElementById('m-date').value  = date;
  document.getElementById('m-shift').value = shift;
  document.getElementById('m-doctor').value = _editEntry?.profile_id || '';
  document.getElementById('m-confirmed').checked = _editEntry?.is_confirmed || false;
  document.getElementById('m-notes').value = _editEntry?.notes || '';

  const removeBtn = document.getElementById('btn-remove-shift');
  removeBtn.style.display = _editEntry ? '' : 'none';

  const existingInfo = document.getElementById('m-existing-info');
  if (_editEntry) {
    existingInfo.style.display = '';
    existingInfo.textContent = `Currently assigned: ${_editEntry.profiles?.full_name || '—'} · Editing this slot.`;
  } else {
    existingInfo.style.display = 'none';
  }

  const deptName = _depts.find(d => d.id === deptId)?.name || '';
  document.getElementById('modal-title').textContent = `${_editEntry ? 'Edit' : 'Assign'} Shift — ${deptName ? deptName + ' · ' : ''}${_fmtDate(date)}`;
  document.getElementById('shift-modal').classList.add('show');
}

window.closeModal = function() {
  document.getElementById('shift-modal').classList.remove('show');
  _editEntry = null;
};

window.saveShift = async function() {
  const deptId   = document.getElementById('m-dept').value;
  const date     = document.getElementById('m-date').value;
  const shift    = document.getElementById('m-shift').value;
  const doctorId = document.getElementById('m-doctor').value;
  const confirmed= document.getElementById('m-confirmed').checked;
  const notes    = document.getElementById('m-notes').value.trim();

  if (!deptId)   { _alert('error','Select a department.'); return; }
  if (!date)     { _alert('error','Select a date.'); return; }
  if (!doctorId) { _alert('error','Select a doctor / officer.'); return; }

  const btn = document.getElementById('btn-save-shift');
  btn.disabled = true; btn.textContent = 'Saving…';

  const payload = {
    tenant_id: tenantId, department_id: deptId,
    profile_id: doctorId, shift_date: date,
    shift_type: shift, is_confirmed: confirmed,
    notes: notes || null,
  };

  let error;
  if (_editEntry) {
    ({ error } = await supabase.from('duty_roster').update(payload).eq('id', _editEntry.id));
  } else {
    ({ error } = await supabase.from('duty_roster').upsert(payload, { onConflict: 'tenant_id,department_id,shift_date,shift_type' }));
  }

  btn.disabled = false; btn.textContent = 'Save Assignment';

  if (error) { _alert('error', 'Failed: ' + error.message); return; }
  closeModal();
  _alert('success', 'Shift assigned.');
  await loadRoster();
};

window.removeShift = async function() {
  if (!_editEntry || !confirm('Remove this shift assignment?')) return;
  const { error } = await supabase.from('duty_roster').delete().eq('id', _editEntry.id);
  if (error) { _alert('error', 'Failed: ' + error.message); return; }
  closeModal();
  _alert('success', 'Shift removed.');
  await loadRoster();
};

// ── Alert ──────────────────────────────────────────
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = `alert ${type} show`;
  setTimeout(() => el.className = 'alert', 4000);
}

// ── Boot ───────────────────────────────────────────
updateWeekLabel();
await Promise.all([loadDepartments(), loadDoctors()]);
await loadRoster();
