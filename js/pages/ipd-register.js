import { requireAuth, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse','receptionist']);
initNavbar();
wireDelegatedEvents();

window._print = () => window.print();

const tenant   = getCurrentTenant();
const tenantId = getCurrentTenantId();
const today    = new Date().toISOString().slice(0,10);

document.getElementById('ph-org').textContent = tenant?.name || 'AyurXpert HMS';

let _rows = [];

// ── Init ──────────────────────────────────────────────
async function init() {
  applyPreset('month');
  await Promise.all([loadDepts(), loadDoctors()]);
  await loadRegister();
}

async function loadDepts() {
  const { data } = await supabase.from('departments').select('id,name,ncism_code')
    .eq('tenant_id', tenantId).eq('is_active', true).order('name');
  const sel = document.getElementById('f-dept');
  (data||[]).forEach(d => {
    const o = document.createElement('option'); o.value = d.id;
    o.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
    sel.appendChild(o);
  });
}

async function loadDoctors() {
  const { data } = await supabase.from('profiles').select('id,full_name')
    .eq('tenant_id', tenantId).eq('role','doctor').eq('is_active',true).order('full_name');
  const sel = document.getElementById('f-doctor');
  (data||[]).forEach(d => {
    const o = document.createElement('option'); o.value = d.id;
    o.textContent = d.full_name; sel.appendChild(o);
  });
}

window.applyPreset = function(preset) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.preset-btn[data-preset="${preset}"]`)?.classList.add('active');
  const now = new Date();
  let from = today, to = today;
  if (preset === 'week') {
    const day = now.getDay(); const diff = day === 0 ? 6 : day - 1;
    const mon = new Date(now); mon.setDate(now.getDate()-diff);
    from = mon.toISOString().slice(0,10);
  } else if (preset === 'month') {
    from = today.slice(0,7) + '-01';
  }
  document.getElementById('f-from').value = from;
  document.getElementById('f-to').value   = to;
};

window.loadRegister = async function() {
  const from   = document.getElementById('f-from').value;
  const to     = document.getElementById('f-to').value;
  const deptId = document.getElementById('f-dept').value;
  const docId  = document.getElementById('f-doctor').value;
  const status = document.getElementById('f-status').value;

  if (!from || !to) { _toast('Please select a date range', 'error'); return; }

  document.getElementById('reg-tbody').innerHTML = '<tr><td colspan="13" style="text-align:center;padding:30px;color:var(--text-muted)">Loading…</td></tr>';

  let q = supabase.from('ipd_admissions')
    .select(`
      id, admission_date, admitted_at, discharged_at, charges_locked_at, status, disposition,
      diagnosis_primary, diet_type,
      patients(id, name, age, gender, phone),
      profiles!admitting_doctor_id(full_name),
      departments(name, ncism_code),
      beds(bed_number, ward_name)
    `)
    .eq('tenant_id', tenantId)
    .gte('admission_date', from)
    .lte('admission_date', to)
    .order('admission_date', { ascending: true })
    .order('admitted_at',    { ascending: true });

  if (deptId) q = q.eq('department_id', deptId);
  if (docId)  q = q.eq('admitting_doctor_id', docId);
  // Session 114 -- status (lifecycle) and disposition (reason) are now split.
  // "Admitted" covers both fully-active and mid-discharge-process admissions
  // (still physically on the ward until charges_locked); "Discharged" means
  // status is terminal AND the disposition was a normal discharge; LAMA/
  // Transferred/Deceased now live in `disposition`, never `status`.
  if (status === 'admitted') q = q.in('status', ['admitted','clinically_discharged']);
  else if (status === 'discharged') q = q.eq('status','discharged').eq('disposition','discharged');
  else if (status) q = q.eq('disposition', status);

  const { data, error } = await q.limit(1000);
  if (error) {
    document.getElementById('reg-tbody').innerHTML = `<tr><td colspan="13" class="empty" style="color:var(--red)">Error: ${_esc(safeErrorMessage(error, 'Could not load register.'))}</td></tr>`;
    return;
  }

  _rows = data || [];
  _renderTable();
  _updateSummary(from, to);
};

function _ipdNo(row) {
  const d = new Date(row.admission_date || row.admitted_at || row.id);
  const datePart = d.toISOString().slice(0,10).replace(/-/g,'');
  return `IPD-${datePart}-${row.id.slice(0,4).toUpperCase()}`;
}

function _los(row) {
  // Session 114 -- LOS uses charges_locked_at (the real bed-vacate moment),
  // not discharged_at (now stamped at MRD's final record release, which can
  // trail the patient's actual ward departure by hours or days).
  const start = row.admitted_at || row.admission_date;
  const end   = row.charges_locked_at || null;
  if (!start) return '—';
  const s = new Date(start);
  const e = end ? new Date(end) : new Date();
  const days = Math.max(0, Math.round((e - s) / 86400000));
  return days || '<1';
}

function _statusBadge(row) {
  // Session 114 -- for a closed admission, disposition (lama/transferred/
  // deceased/discharged) is the meaningful label, not the lifecycle `status`
  // (which is now just 'discharged' for every closed case regardless of why).
  const isActive = ['admitted','clinically_discharged'].includes(row.status);
  const key = isActive ? row.status : (row.disposition || row.status);
  const cls = {admitted:'b-admitted', clinically_discharged:'b-admitted', discharged:'b-discharged',
               lama:'b-lama', transferred:'b-transferred', deceased:'b-deceased'}[key] || '';
  const label = {admitted:'Admitted', clinically_discharged:'Admitted (Discharge Ordered)', discharged:'Discharged',
                 lama:'LAMA', transferred:'Transferred', deceased:'Deceased'}[key] || key;
  return `<span class="badge ${cls}">${_esc(label)}</span>`;
}

function _renderTable() {
  const tbody = document.getElementById('reg-tbody');
  if (!_rows.length) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">No IPD admissions found for the selected criteria.</td></tr>';
    return;
  }
  tbody.innerHTML = _rows.map((r, i) => {
    const pat    = r.patients || {};
    const doc    = r.profiles || {};
    const dept   = r.departments || {};
    const bed    = r.beds || {};
    const ageSex = [pat.age ? pat.age+'y' : '—', pat.gender ? pat.gender.charAt(0).toUpperCase() : ''].filter(Boolean).join('/');
    return `<tr>
      <td style="color:var(--text-muted);text-align:center">${i+1}</td>
      <td style="font-size:11px;white-space:nowrap">${_fmtDate(r.admission_date)}</td>
      <td><code style="font-size:10.5px;color:var(--green-deep);font-weight:600">${_ipdNo(r)}</code></td>
      <td style="font-weight:500">${_esc(pat.name||'—')}</td>
      <td style="text-align:center;font-size:12px">${ageSex}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_esc(pat.phone||'—')}</td>
      <td style="font-size:11px">${_esc(dept.name||'—')}${dept.ncism_code?`<br><span style="color:var(--text-muted);font-size:10px">${_esc(dept.ncism_code)}</span>`:''}</td>
      <td style="font-size:11px">${bed.ward_name ? _esc(bed.ward_name)+'<br>' : ''}${bed.bed_number ? `<span style="color:var(--text-muted)">Bed ${_esc(bed.bed_number)}</span>` : '—'}</td>
      <td style="font-size:11px">${doc.full_name ? 'Dr. '+_esc(doc.full_name) : '—'}</td>
      <td style="font-size:11px;max-width:150px">${_esc(r.diagnosis_primary||'—')}</td>
      <td>${_statusBadge(r)}</td>
      <td style="font-size:11px;white-space:nowrap">${r.charges_locked_at ? _fmtDate(r.charges_locked_at.slice(0,10)) : '—'}</td>
      <td style="text-align:center;font-size:12px;font-weight:500">${_los(r)}</td>
    </tr>`;
  }).join('');
}

function _updateSummary(from, to) {
  // Session 114 -- active/discharged/other/deceased now read disposition for
  // closed cases (status is just 'discharged' for all of them regardless of
  // why); "active" includes clinically_discharged since the patient hasn't
  // physically left the ward yet at that stage.
  const active    = _rows.filter(r => ['admitted','clinically_discharged'].includes(r.status)).length;
  const discharged= _rows.filter(r => r.disposition === 'discharged').length;
  const other     = _rows.filter(r => ['lama','transferred'].includes(r.disposition)).length;
  const deceased  = _rows.filter(r => r.disposition === 'deceased').length;

  // Average LOS for discharged patients -- charges_locked_at (bed-vacate
  // moment), not discharged_at (now trails to MRD's final release).
  const disRows = _rows.filter(r => r.disposition === 'discharged' && r.admitted_at && r.charges_locked_at);
  const avgLOS  = disRows.length
    ? (disRows.reduce((sum, r) => sum + Math.round((new Date(r.charges_locked_at)-new Date(r.admitted_at))/86400000), 0) / disRows.length).toFixed(1)
    : '—';

  document.getElementById('s-total').textContent     = _rows.length;
  document.getElementById('s-active').textContent    = active;
  document.getElementById('s-discharged').textContent= discharged;
  document.getElementById('s-other').textContent     = other;
  document.getElementById('s-deceased').textContent  = deceased;
  document.getElementById('s-los').textContent       = avgLOS;

  const label = from === to ? _fmtDate(from) : `${_fmtDate(from)} – ${_fmtDate(to)}`;
  document.getElementById('tbl-title').textContent = `IPD Register — ${label}`;
  document.getElementById('ph-range').textContent  = label;
  document.getElementById('summary-strip').style.display = '';
}

window.exportCSV = function() {
  if (!_rows.length) { _toast('No data to export', 'error'); return; }
  const headers = ['S.No','Admission Date','IPD No','Patient Name','Age','Sex','Phone',
    'Department','NCISM Code','Ward','Bed No','Admitting Doctor','Primary Diagnosis',
    'Status','Discharge Date','LOS (days)'];
  const rows = _rows.map((r, i) => {
    const pat  = r.patients||{}, doc = r.profiles||{}, dept = r.departments||{}, bed = r.beds||{};
    return [
      i+1, r.admission_date, _ipdNo(r),
      pat.name||'', pat.age||'', pat.gender||'', pat.phone||'',
      dept.name||'', dept.ncism_code||'', bed.ward_name||'', bed.bed_number||'',
      doc.full_name ? 'Dr. '+doc.full_name : '',
      r.diagnosis_primary||'', r.status||'',
      r.discharged_at ? r.discharged_at.slice(0,10) : '',
      _los(r),
    ];
  });
  const csv = [headers, ...rows].map(r => r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const from = document.getElementById('f-from').value;
  const to   = document.getElementById('f-to').value;
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `ipd_register_${from}_${to}.csv`; a.click();
  _toast('CSV exported', 'success');
};

function _fmtDate(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

await init();
