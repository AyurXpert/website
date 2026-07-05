import { requireAuth, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['pharmacist','super_admin','dept_admin','accountant'], 'login.html');
initNavbar();
wireDelegatedEvents();

const tenantId  = getCurrentTenantId();
const tenant    = getCurrentTenant();
const TODAY     = new Date().toISOString().split('T')[0];
const IN_90     = new Date(Date.now() + 90*86400000).toISOString().split('T')[0];

let _suppliers = [];

function _gmpStatus(s) {
  if (!s.is_gmp_certified)                              return 'none';
  if (!s.gmp_certificate_expiry)                        return 'valid';
  if (s.gmp_certificate_expiry < TODAY)                 return 'expired';
  if (s.gmp_certificate_expiry <= IN_90)                return 'expiring';
  return 'valid';
}
const GMP_LABEL = { valid:'✓ GMP Valid', expiring:'⚠ Expiring Soon', expired:'✗ Expired', none:'— Not Certified' };
const GMP_CLS   = { valid:'gmp-valid',   expiring:'gmp-expiring',     expired:'gmp-expired', none:'gmp-none' };

async function load() {
  const { data } = await supabase.from('suppliers')
    .select('*').eq('tenant_id', tenantId).order('name');
  _suppliers = (data || []).map(s => ({ ...s, _gmp: _gmpStatus(s) }));
  renderStats();
  renderTable();
}

function renderStats() {
  document.getElementById('s-total').textContent    = _suppliers.filter(s=>s.is_active).length;
  document.getElementById('s-certified').textContent= _suppliers.filter(s=>s._gmp==='valid').length;
  document.getElementById('s-expiring').textContent = _suppliers.filter(s=>s._gmp==='expiring').length;
  document.getElementById('s-expired').textContent  = _suppliers.filter(s=>s._gmp==='expired'||s._gmp==='none').length;
}

window.renderTable = function() {
  const name   = document.getElementById('f-name').value.toLowerCase();
  const gmp    = document.getElementById('f-gmp').value;
  const status = document.getElementById('f-status').value;

  const list = _suppliers.filter(s =>
    (!name   || s.name.toLowerCase().includes(name)) &&
    (!gmp    || s._gmp === gmp) &&
    (status === '' || (status === 'active' ? s.is_active : !s.is_active))
  );

  const tbody = document.getElementById('suppliers-body');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><div class="empty-ico">🏭</div>No suppliers found</div></td></tr>`;
    return;
  }

  const fmtDate = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
  tbody.innerHTML = list.map(s => `
    <tr>
      <td><strong>${_esc(s.name)}</strong>${!s.is_active?'<br><span style="font-size:11px;color:var(--text-muted)">Inactive</span>':''}</td>
      <td style="font-size:12px">${_esc(s.contact_name||'—')}<br><span style="color:var(--text-muted)">${_esc(s.phone||'')}</span></td>
      <td style="font-family:monospace;font-size:12px">${_esc(s.gmp_certificate_number||'—')}</td>
      <td style="font-size:12px">${_esc(s.gmp_certifying_authority||'—')}</td>
      <td style="font-size:12px">${s._gmp==='expiring'?`<span style="color:var(--gold);font-weight:600">${fmtDate(s.gmp_certificate_expiry)}</span>`:s._gmp==='expired'?`<span style="color:var(--red);font-weight:600">${fmtDate(s.gmp_certificate_expiry)}</span>`:fmtDate(s.gmp_certificate_expiry)}</td>
      <td><span class="gmp-badge ${GMP_CLS[s._gmp]}">${GMP_LABEL[s._gmp]}</span></td>
      <td>${s.is_approved?'<span style="color:#2d7a4f;font-weight:600">✓</span>':'<span style="color:var(--red)">✗</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-sm" data-onclick="openEdit" data-onclick-a0="${s.id}">✏</button>
        <button class="btn btn-danger btn-sm" data-onclick="deactivate" data-onclick-a0="${s.id}" style="margin-left:4px">${s.is_active?'Deactivate':'Activate'}</button>
      </td>
    </tr>`).join('');
};

window.toggleGmpFields = function() {
  const show = document.getElementById('m-gmp-certified').checked;
  document.getElementById('gmp-cert-fields').style.display = show ? '' : 'none';
};

window.openAdd = function() {
  document.getElementById('modal-title').textContent = 'Add Supplier';
  document.getElementById('m-id').value = '';
  ['m-name','m-contact','m-phone','m-email','m-address','m-gmp-no','m-gmp-auth','m-gmp-expiry','m-notes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('m-gmp-certified').checked = false;
  document.getElementById('m-approved').checked = true;
  document.getElementById('m-active').checked   = true;
  document.getElementById('gmp-cert-fields').style.display = 'none';
  document.getElementById('sup-modal').classList.add('open');
};

window.openEdit = function(id) {
  const s = _suppliers.find(x => x.id === id);
  if (!s) return;
  document.getElementById('modal-title').textContent = 'Edit Supplier';
  document.getElementById('m-id').value          = s.id;
  document.getElementById('m-name').value        = s.name || '';
  document.getElementById('m-contact').value     = s.contact_name || '';
  document.getElementById('m-phone').value       = s.phone || '';
  document.getElementById('m-email').value       = s.email || '';
  document.getElementById('m-address').value     = s.address || '';
  document.getElementById('m-gmp-certified').checked = s.is_gmp_certified || false;
  document.getElementById('m-gmp-no').value      = s.gmp_certificate_number || '';
  document.getElementById('m-gmp-auth').value    = s.gmp_certifying_authority || '';
  document.getElementById('m-gmp-expiry').value  = s.gmp_certificate_expiry || '';
  document.getElementById('m-approved').checked  = s.is_approved !== false;
  document.getElementById('m-active').checked    = s.is_active !== false;
  document.getElementById('m-notes').value       = s.notes || '';
  document.getElementById('gmp-cert-fields').style.display = s.is_gmp_certified ? '' : 'none';
  document.getElementById('sup-modal').classList.add('open');
};

window.closeModal = function() { document.getElementById('sup-modal').classList.remove('open'); };

window.saveSupplier = async function() {
  const name = document.getElementById('m-name').value.trim();
  if (!name) { _toast('Supplier name is required.'); return; }
  const isGmp = document.getElementById('m-gmp-certified').checked;

  const payload = {
    tenant_id:                 tenantId,
    name,
    contact_name:              document.getElementById('m-contact').value.trim()    || null,
    phone:                     document.getElementById('m-phone').value.trim()      || null,
    email:                     document.getElementById('m-email').value.trim()      || null,
    address:                   document.getElementById('m-address').value.trim()    || null,
    is_gmp_certified:          isGmp,
    gmp_certificate_number:    isGmp ? (document.getElementById('m-gmp-no').value.trim()   || null) : null,
    gmp_certifying_authority:  isGmp ? (document.getElementById('m-gmp-auth').value.trim() || null) : null,
    gmp_certificate_expiry:    isGmp ? (document.getElementById('m-gmp-expiry').value       || null) : null,
    is_approved:               document.getElementById('m-approved').checked,
    is_active:                 document.getElementById('m-active').checked,
    notes:                     document.getElementById('m-notes').value.trim() || null,
  };

  const id = document.getElementById('m-id').value;
  const { error } = id
    ? await supabase.from('suppliers').update(payload).eq('id', id).eq('tenant_id', tenantId)
    : await supabase.from('suppliers').insert(payload);

  if (error) { _toast('❌ ' + error.message); return; }
  _toast(id ? '✅ Supplier updated' : '✅ Supplier added');
  closeModal();
  await load();
};

window.deactivate = async function(id) {
  const s = _suppliers.find(x => x.id === id);
  if (!s) return;
  const action = s.is_active ? 'deactivate' : 'activate';
  if (!confirm(`${action.charAt(0).toUpperCase()+action.slice(1)} supplier "${s.name}"?`)) return;
  await supabase.from('suppliers').update({ is_active: !s.is_active }).eq('id', id).eq('tenant_id', tenantId);
  _toast(`✅ Supplier ${action}d`);
  await load();
};

window.exportCSV = function() {
  const hdr = ['Name','Contact','Phone','Email','GMP Certified','Certificate No.','Authority','GMP Expiry','Approved','Active','Notes'];
  const rows = _suppliers.map(s => [
    s.name, s.contact_name||'', s.phone||'', s.email||'',
    s.is_gmp_certified?'Yes':'No', s.gmp_certificate_number||'',
    s.gmp_certifying_authority||'', s.gmp_certificate_expiry||'',
    s.is_approved?'Yes':'No', s.is_active?'Yes':'No', s.notes||''
  ]);
  const csv = [hdr,...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `Suppliers_${tenant?.name||'AyurXpert'}.csv`;
  a.click();
};

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2800); }

await load();
