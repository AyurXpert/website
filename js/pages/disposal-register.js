import { requireAuth, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['pharmacist','super_admin','dept_admin','accountant'], 'login.html');
initNavbar();
wireDelegatedEvents();

window._print = () => window.print();

const tenantId  = getCurrentTenantId();
const tenant    = getCurrentTenant();

// Default: current month
const now   = new Date();
const y     = now.getFullYear();
const m     = String(now.getMonth()+1).padStart(2,'0');
document.getElementById('f-from').value = `${y}-${m}-01`;
document.getElementById('f-to').value   = now.toISOString().split('T')[0];

const METHOD_LABEL = {
  return_supplier:   'Return to Supplier',
  incineration:      'Incineration',
  municipal_bmw:     'Municipal BMW',
  autoclave:         'Autoclave',
  drain_disposal:    'Drain Disposal',
  student_practical: '🎓 Practical Use',
};

let _records = [];

window.loadRecords = async function() {
  const from   = document.getElementById('f-from').value;
  const to     = document.getElementById('f-to').value;
  const name   = document.getElementById('f-name').value.trim().toLowerCase();
  const method = document.getElementById('f-method').value;

  let q = supabase.from('disposal_records')
    .select('*, profiles!disposed_by(full_name)')
    .eq('tenant_id', tenantId)
    .order('disposal_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (from) q = q.gte('disposal_date', from);
  if (to)   q = q.lte('disposal_date', to);
  if (method) q = q.eq('disposal_method', method);

  const { data, error } = await q;
  if (error) { _toast(safeErrorMessage(error, 'Could not load records.')); return; }

  _records = (data || []).filter(r => !name || r.medicine_name.toLowerCase().includes(name));
  renderTable();
  renderStats();
};

function renderStats() {
  const thisMonth = `${y}-${m}`;
  document.getElementById('s-total').textContent   = _records.length;
  document.getElementById('s-qty').textContent     = _records.reduce((s,r)=>s+(r.quantity||0),0);
  document.getElementById('s-month').textContent   = _records.filter(r=>(r.disposal_date||'').startsWith(thisMonth)).length;
  const methods = new Set(_records.map(r=>r.disposal_method)).size;
  document.getElementById('s-methods').textContent = methods;
}

function renderTable() {
  const tbody = document.getElementById('records-body');
  if (!_records.length) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty"><div class="empty-ico">⚗</div>No disposal records found for selected filters</div></td></tr>`;
    return;
  }
  tbody.innerHTML = _records.map((r, idx) => `
    <tr>
      <td style="color:var(--text-muted)">${idx+1}</td>
      <td>${_fmtDate(r.disposal_date)}</td>
      <td><strong>${_esc(r.medicine_name)}</strong></td>
      <td style="font-family:monospace;font-size:12px;color:var(--text-muted)">${_esc(r.batch_number||'—')}</td>
      <td>${r.expiry_date ? `<span style="color:var(--red)">${_fmtDate(r.expiry_date)}</span>` : '—'}</td>
      <td><span class="chip chip-qty">${r.quantity} units</span></td>
      <td><span class="chip chip-method">${_esc(METHOD_LABEL[r.disposal_method]||r.disposal_method)}</span></td>
      <td>${_esc(r.profiles?.full_name||'—')}</td>
      <td>${_esc(r.witnessed_by||'—')}</td>
      <td style="font-size:12px;color:var(--text-muted)">${_esc(r.remarks||'—')}</td>
    </tr>`).join('');
}

window.resetFilters = function() {
  document.getElementById('f-from').value   = `${y}-${m}-01`;
  document.getElementById('f-to').value     = now.toISOString().split('T')[0];
  document.getElementById('f-name').value   = '';
  document.getElementById('f-method').value = '';
  loadRecords();
};

window.exportCSV = function() {
  if (!_records.length) { _toast('No records to export.'); return; }
  const hdr = ['#','Disposal Date','Medicine Name','Batch No.','Expiry Date','Qty Disposed','Disposal Method','Disposed By','Witnessed By','Remarks'];
  const rows = _records.map((r,i) => [
    i+1, r.disposal_date||'', r.medicine_name, r.batch_number||'',
    r.expiry_date||'', r.quantity,
    METHOD_LABEL[r.disposal_method]||r.disposal_method,
    r.profiles?.full_name||'', r.witnessed_by||'', r.remarks||''
  ]);
  const csv = [hdr, ...rows].map(r => r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `Disposal_Register_${tenant?.name||'AyurXpert'}_${y}-${m}.csv`;
  a.click();
  _toast('CSV exported');
};

function _fmtDate(d){ if(!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2800); }

await loadRecords();
