import { requireAuth, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','receptionist','nurse']);
initNavbar();
wireDelegatedEvents();

window._print = () => window.print();

const tenant   = getCurrentTenant();
const tenantId = getCurrentTenantId();

// Print header
document.getElementById('ph-org-name').textContent = tenant?.name || 'AyurXpert HMS';

let _rows = [];    // current register data
const today = new Date().toISOString().slice(0,10);

// ── Init ──────────────────────────────────────────────
async function init() {
  applyPreset('today');
  await Promise.all([loadOPDs(), loadDoctors()]);
  await loadRegister();
}

async function loadOPDs() {
  const { data } = await supabase.from('opds').select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true).order('name');
  const sel = document.getElementById('f-opd');
  (data || []).forEach(o => {
    const opt = document.createElement('option'); opt.value = o.id;
    opt.textContent = o.name + (o.ncism_code ? ` (${o.ncism_code})` : '');
    sel.appendChild(opt);
  });
}

async function loadDoctors() {
  const { data } = await supabase.from('profiles').select('id,full_name').eq('tenant_id', tenantId).eq('role','doctor').eq('is_active', true).order('full_name');
  const sel = document.getElementById('f-doctor');
  (data || []).forEach(d => {
    const opt = document.createElement('option'); opt.value = d.id;
    opt.textContent = d.full_name; sel.appendChild(opt);
  });
}

// ── Preset helpers ─────────────────────────────────────
window.applyPreset = function(preset) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.preset-btn[data-preset="${preset}"]`);
  if (btn) btn.classList.add('active');

  const now = new Date();
  let from = today, to = today;
  if (preset === 'week') {
    const day = now.getDay(); // 0 = Sunday
    const diff = day === 0 ? 6 : day - 1;
    const mon = new Date(now); mon.setDate(now.getDate() - diff);
    from = mon.toISOString().slice(0,10);
  } else if (preset === 'month') {
    from = today.slice(0,7) + '-01';
  }
  document.getElementById('f-from').value = from;
  document.getElementById('f-to').value   = to;
};

// ── Load register ──────────────────────────────────────
window.loadRegister = async function() {
  const from    = document.getElementById('f-from').value;
  const to      = document.getElementById('f-to').value;
  const opdId   = document.getElementById('f-opd').value;
  const docId   = document.getElementById('f-doctor').value;
  const typeVal = document.getElementById('f-type').value;

  if (!from || !to) { _toast('Please select a date range', 'error'); return; }
  if (to < from)    { _toast('End date must be on or after start date', 'error'); return; }

  document.getElementById('reg-tbody').innerHTML = '<tr><td colspan="12" class="loading">Loading…</td></tr>';

  const fromDT = from + 'T00:00:00';
  const toDT   = to   + 'T23:59:59';

  let q = supabase.from('visits')
    .select(`
      id, created_at, token_number, chief_complaint, is_new_patient,
      patients(id, name, age, gender, phone, abha_number),
      profiles!doctor_id(id, full_name),
      opds(id, name, ncism_code),
      consultation_notes(diagnosis_namc_label, diagnosis_icd10_label, disposition)
    `)
    .eq('tenant_id', tenantId)
    .in('status', ['completed','in_progress','waiting'])
    .gte('created_at', fromDT)
    .lte('created_at', toDT)
    .order('created_at', { ascending: true });

  if (opdId) q = q.eq('opd_id', opdId);
  if (docId) q = q.eq('doctor_id', docId);
  if (typeVal === 'new')    q = q.eq('is_new_patient', true);
  if (typeVal === 'return') q = q.eq('is_new_patient', false);

  const { data, error } = await q.limit(1000);

  if (error) {
    document.getElementById('reg-tbody').innerHTML = `<tr><td colspan="12" class="empty" style="color:#c0392b">Error: ${safeErrorMessage(error, 'Could not load register.')}</td></tr>`;
    return;
  }

  _rows = data || [];
  _renderTable();
  _updateSummary(from, to);

  document.getElementById('ph-date-range').textContent =
    _fmtDate(from) + (from !== to ? ' to ' + _fmtDate(to) : '');
};

function _renderTable() {
  const tbody = document.getElementById('reg-tbody');
  if (!_rows.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">No visits found for the selected criteria.</td></tr>';
    return;
  }

  tbody.innerHTML = _rows.map((v, i) => {
    const pat  = v.patients || {};
    const doc  = v.profiles  || {};
    const opd  = v.opds      || {};
    const notes = Array.isArray(v.consultation_notes)
      ? v.consultation_notes[0]
      : (v.consultation_notes || {});

    const dt   = new Date(v.created_at);
    const dateStr = dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const ageSex  = [pat.age ? pat.age+'y' : '—', pat.gender ? pat.gender.charAt(0).toUpperCase() : ''].filter(Boolean).join('/');
    const uhid    = `AYX-${(pat.id||'').slice(0,6).toUpperCase()}`;
    const token   = v.token_number ? `#${v.token_number}` : '—';
    const isNew   = v.is_new_patient;

    const diagHtml = (notes?.diagnosis_namc_label || notes?.diagnosis_icd10_label)
      ? `<div class="diag-cell">
          ${notes.diagnosis_namc_label ? `<div class="diag-namc">${_esc(notes.diagnosis_namc_label)}</div>` : ''}
          ${notes.diagnosis_icd10_label ? `<div class="diag-icd">${_esc(notes.diagnosis_icd10_label)}</div>` : ''}
        </div>`
      : '<span style="color:var(--text-muted)">—</span>';

    return `<tr>
      <td style="color:var(--text-muted);text-align:center">${i+1}</td>
      <td style="white-space:nowrap;font-size:11px">${dateStr}</td>
      <td style="font-size:11px;white-space:nowrap">${token}<br><span style="color:var(--text-muted)">${uhid}</span></td>
      <td style="font-weight:500">${_esc(pat.name||'—')}</td>
      <td style="text-align:center;font-size:12px">${ageSex}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_esc(pat.phone||'—')}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_esc(pat.abha_number||'—')}</td>
      <td style="font-size:11px;max-width:130px">${_esc(v.chief_complaint||'—')}</td>
      <td>${diagHtml}</td>
      <td style="font-size:11px">${_esc(opd.name||'—')}${opd.ncism_code?`<br><span style="color:var(--text-muted)">${opd.ncism_code}</span>`:''}</td>
      <td style="font-size:11px">${doc.full_name ? 'Dr. '+_esc(doc.full_name) : '—'}</td>
      <td style="text-align:center">${isNew ? '<span class="badge-new">New</span>' : '<span class="badge-return">Return</span>'}</td>
    </tr>`;
  }).join('');
}

function _updateSummary(from, to) {
  const newCount  = _rows.filter(r => r.is_new_patient).length;
  const diagCount = _rows.filter(r => {
    const n = Array.isArray(r.consultation_notes) ? r.consultation_notes[0] : r.consultation_notes;
    return n?.diagnosis_namc_label || n?.diagnosis_icd10_label;
  }).length;
  const doctorSet = new Set(_rows.map(r => r.profiles?.id).filter(Boolean));
  const opdSet    = new Set(_rows.map(r => r.opds?.id).filter(Boolean));

  document.getElementById('s-total').textContent   = _rows.length;
  document.getElementById('s-new').textContent     = newCount;
  document.getElementById('s-return').textContent  = _rows.length - newCount;
  document.getElementById('s-diag').textContent    = diagCount;
  document.getElementById('s-doctors').textContent = doctorSet.size;
  document.getElementById('s-opds').textContent    = opdSet.size;

  const label = from === to ? `Register — ${_fmtDate(from)}` : `Register — ${_fmtDate(from)} to ${_fmtDate(to)}`;
  document.getElementById('tbl-title').textContent = label;
  document.getElementById('summary-strip').style.display = '';
}

// ── Export ─────────────────────────────────────────────
window.exportCSV = function() {
  if (!_rows.length) { _toast('No data to export', 'error'); return; }
  const headers = ['S.No','Date','Token','UHID','Patient Name','Age','Sex','Phone','ABHA No',
    'Chief Complaint','Diagnosis (NAMC)','Diagnosis (ICD-10)','OPD','Doctor','New/Return'];
  const rows = _rows.map((v, i) => {
    const pat  = v.patients || {};
    const doc  = v.profiles  || {};
    const opd  = v.opds      || {};
    const notes = Array.isArray(v.consultation_notes) ? v.consultation_notes[0] : (v.consultation_notes || {});
    const dt = new Date(v.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
    return [
      i+1, dt, v.token_number||'', `AYX-${(pat.id||'').slice(0,6).toUpperCase()}`,
      pat.name||'', pat.age||'', pat.gender||'', pat.phone||'', pat.abha_number||'',
      v.chief_complaint||'', notes.diagnosis_namc_label||'', notes.diagnosis_icd10_label||'',
      opd.name||'', doc.full_name ? 'Dr. '+doc.full_name : '',
      v.is_new_patient ? 'New' : 'Return',
    ];
  });
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const from = document.getElementById('f-from').value;
  const to   = document.getElementById('f-to').value;
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `opd_register_${from}_${to}.csv`; a.click();
  _toast('CSV exported', 'success');
};

// ── Helpers ────────────────────────────────────────────
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
