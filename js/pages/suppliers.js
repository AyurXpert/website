import { requireAuth, getCurrentTenantId, getCurrentTenant, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';
import { hideRegisterWrites, showViewOnlyNote } from '../utils/registerAccess.js';
import { notify } from '../components/notify.js';
import { STATES } from '../modules/tax/gstReturnsExport.js';

await requireAuth(['pharmacist','super_admin','dept_admin','accountant','finance_manager'], 'login.html');
initNavbar();
wireDelegatedEvents();

const tenantId  = getCurrentTenantId();
const tenant    = getCurrentTenant();
const TODAY     = todayLocalStr();
const IN_90     = localDateStr(new Date(Date.now() + 90*86400000));

// the accountant / finance manager see the GMP supplier register for reference but can't change it --
// writes are pharmacist + admins only (session310_partd_money_tables2_lockdown.sql; since Session 365 only through supplier_save())
const _viewOnly = ['accountant', 'finance_manager'].includes(getCurrentRole());
if (_viewOnly) {
  hideRegisterWrites(['openAdd', 'saveSupplier', 'deactivate']);
  showViewOnlyNote('You can view the supplier register. Adding, editing, or deactivating a supplier needs a pharmacist or admin.');
}

let _suppliers = [];
const $ = id => document.getElementById(id);
const REG_LABEL = { regular: 'Regular', composition: 'Composition', unregistered: 'Unregistered' };

// the state list of an unregistered supplier (GST state codes)
(function fillStates() {
  // owner 27 Oct 2026: a local unregistered supplier stays quick -- empty = the organisation's own GST state (the server fills it in)
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Our state (local supplier)';
  const opts = Object.entries(STATES).filter(([c]) => Number(c) <= 38).map(([c, n]) => {
    const o = document.createElement('option'); o.value = c; o.textContent = `${c} — ${n}`; return o;
  });
  $('m-state').replaceChildren(blank, ...opts);
})();

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
  const { data, error } = await supabase.from('suppliers')
    .select('*').eq('tenant_id', tenantId).order('name');
  if (error) { _toast(safeErrorMessage(error, 'Could not load the suppliers.'), 'error'); return; }
  _suppliers = (data || []).map(s => ({ ...s, _gmp: _gmpStatus(s) }));
  renderStats();
  renderTable();
}

function renderStats() {
  $('s-total').textContent     = _suppliers.filter(s=>s.is_active).length;
  $('s-certified').textContent = _suppliers.filter(s=>s._gmp==='valid').length;
  $('s-expiring').textContent  = _suppliers.filter(s=>s._gmp==='expiring').length;
  $('s-expired').textContent   = _suppliers.filter(s=>s._gmp==='expired'||s._gmp==='none').length;
}

const fmtDate = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
function _el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'style') e.style.cssText = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v); }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k instanceof Node ? k : String(k));
  return e;
}

window.renderTable = function() {
  const name   = $('f-name').value.toLowerCase();
  const gmp    = $('f-gmp').value;
  const status = $('f-status').value;

  const list = _suppliers.filter(s =>
    (!name   || s.name.toLowerCase().includes(name) || (s.gstin || '').toLowerCase().includes(name)) &&
    (!gmp    || s._gmp === gmp) &&
    (status === '' || (status === 'active' ? s.is_active : !s.is_active))
  );

  const tbody = $('suppliers-body');
  if (!list.length) {
    tbody.replaceChildren(_el('tr', {}, _el('td', { colspan: '9' }, _el('div', { class: 'empty' }, _el('div', { class: 'empty-ico' }, '🏭'), 'No suppliers found'))));
    return;
  }
  tbody.replaceChildren(...list.map(s => {
    const expCell = _el('td', { style: 'font-size:12px' });
    if (s._gmp === 'expiring') expCell.append(_el('span', { style: 'color:var(--gold);font-weight:600' }, fmtDate(s.gmp_certificate_expiry)));
    else if (s._gmp === 'expired') expCell.append(_el('span', { style: 'color:var(--red);font-weight:600' }, fmtDate(s.gmp_certificate_expiry)));
    else expCell.append(fmtDate(s.gmp_certificate_expiry));
    const gst = _el('td', { style: 'font-size:12px' });
    if (s.gst_registration) {
      gst.append(_el('span', { style: 'font-family:monospace' }, s.gstin || (s.state_code ? `State ${s.state_code}` : '—')), _el('br'),
                 _el('span', { style: 'color:var(--text-muted)' }, REG_LABEL[s.gst_registration] || s.gst_registration));
    } else {
      gst.append(_el('span', { style: 'color:var(--orange,#d35400);font-weight:600' }, '⚠ Not recorded'), _el('br'),
                 _el('span', { style: 'color:var(--text-muted)' }, 'needed for a goods receipt'));
    }
    const nameCell = _el('td', {}, _el('strong', {}, s.name));
    if (!s.is_active) nameCell.append(_el('br'), _el('span', { style: 'font-size:11px;color:var(--text-muted)' }, 'Inactive'));
    const actions = _el('td', { style: 'white-space:nowrap' },
      _el('button', { class: 'btn btn-outline btn-sm', 'data-onclick': 'openEdit', 'data-onclick-a0': s.id, 'aria-label': `Edit ${s.name}` }, '✏'),
      _el('button', { class: 'btn btn-danger btn-sm', 'data-onclick': 'deactivate', 'data-onclick-a0': s.id, style: 'margin-left:4px' }, s.is_active ? 'Deactivate' : 'Activate'));
    if (_viewOnly) actions.replaceChildren();
    return _el('tr', {}, nameCell, gst,
      _el('td', { style: 'font-size:12px' }, s.contact_name || '—', _el('br'), _el('span', { style: 'color:var(--text-muted)' }, s.phone || '')),
      _el('td', { style: 'font-family:monospace;font-size:12px' }, s.gmp_certificate_number || '—'),
      _el('td', { style: 'font-size:12px' }, s.gmp_certifying_authority || '—'),
      expCell,
      _el('td', {}, _el('span', { class: `gmp-badge ${GMP_CLS[s._gmp]}` }, GMP_LABEL[s._gmp])),
      _el('td', {}, s.is_approved ? _el('span', { style: 'color:#2d7a4f;font-weight:600' }, '✓') : _el('span', { style: 'color:var(--red)' }, '✗')),
      actions);
  }));
};

window.toggleGmpFields = function() {
  const show = $('m-gmp-certified').checked;
  $('gmp-cert-fields').style.display = show ? '' : 'none';
};
window.toggleGstFields = function() {
  const reg = $('m-gst-reg').value;
  $('m-gstin-wrap').hidden = reg === 'unregistered';
  $('m-unreg-wrap').hidden = reg !== 'unregistered';
};

window.openAdd = function() {
  $('modal-title').textContent = 'Add Supplier';
  $('m-id').value = '';
  ['m-name','m-contact','m-phone','m-email','m-address','m-gmp-no','m-gmp-auth','m-gmp-expiry','m-notes','m-gstin','m-pan'].forEach(id => { $(id).value = ''; });
  $('m-gst-reg').value = ''; $('m-state').value = ''; $('m-err').textContent = '';
  $('m-gmp-certified').checked = false;
  $('m-approved').checked = true;
  $('m-active').checked   = true;
  $('gmp-cert-fields').style.display = 'none';
  window.toggleGstFields();
  $('sup-modal').classList.add('open');
};

window.openEdit = function(id) {
  const s = _suppliers.find(x => x.id === id);
  if (!s) return;
  $('modal-title').textContent = 'Edit Supplier';
  $('m-id').value          = s.id;
  $('m-name').value        = s.name || '';
  $('m-contact').value     = s.contact_name || '';
  $('m-phone').value       = s.phone || '';
  $('m-email').value       = s.email || '';
  $('m-address').value     = s.address || '';
  $('m-gmp-certified').checked = s.is_gmp_certified || false;
  $('m-gmp-no').value      = s.gmp_certificate_number || '';
  $('m-gmp-auth').value    = s.gmp_certifying_authority || '';
  $('m-gmp-expiry').value  = s.gmp_certificate_expiry || '';
  $('m-approved').checked  = s.is_approved !== false;
  $('m-active').checked    = s.is_active !== false;
  $('m-notes').value       = s.notes || '';
  $('m-gst-reg').value     = s.gst_registration || '';
  $('m-gstin').value       = s.gstin || '';
  $('m-state').value       = s.gst_registration === 'unregistered' ? (s.state_code || '') : '';
  $('m-pan').value         = s.gst_registration === 'unregistered' ? (s.pan || '') : '';
  $('m-err').textContent   = '';
  $('gmp-cert-fields').style.display = s.is_gmp_certified ? '' : 'none';
  window.toggleGstFields();
  $('sup-modal').classList.add('open');
};

window.closeModal = function() { $('sup-modal').classList.remove('open'); };

function _payloadFrom(s, overrides = {}) {
  return {
    name: s.name, contact_name: s.contact_name, phone: s.phone, email: s.email, address: s.address,
    is_gmp_certified: !!s.is_gmp_certified, gmp_certificate_number: s.gmp_certificate_number, gmp_certifying_authority: s.gmp_certifying_authority,
    gmp_certificate_expiry: s.gmp_certificate_expiry, is_approved: s.is_approved !== false, is_active: s.is_active !== false, notes: s.notes,
    gst_registration: s.gst_registration, gstin: s.gstin, state_code: s.state_code, pan: s.pan, ...overrides,
  };
}

window.saveSupplier = async function() {
  $('m-err').textContent = '';
  const name = $('m-name').value.trim();
  if (!name) { $('m-err').textContent = 'Supplier name is required.'; return; }
  const isGmp = $('m-gmp-certified').checked;
  const reg = $('m-gst-reg').value;
  if (!reg) { $('m-err').textContent = 'Choose the supplier’s GST registration.'; return; }
  const p = {
    name,
    contact_name:              $('m-contact').value.trim()    || null,
    phone:                     $('m-phone').value.trim()      || null,
    email:                     $('m-email').value.trim()      || null,
    address:                   $('m-address').value.trim()    || null,
    is_gmp_certified:          isGmp,
    gmp_certificate_number:    isGmp ? ($('m-gmp-no').value.trim()   || null) : null,
    gmp_certifying_authority:  isGmp ? ($('m-gmp-auth').value.trim() || null) : null,
    gmp_certificate_expiry:    isGmp ? ($('m-gmp-expiry').value       || null) : null,
    is_approved:               $('m-approved').checked,
    is_active:                 $('m-active').checked,
    notes:                     $('m-notes').value.trim() || null,
    gst_registration:          reg,
    gstin:                     reg === 'unregistered' ? null : ($('m-gstin').value.trim() || null),
    state_code:                reg === 'unregistered' ? ($('m-state').value || null) : null,
    pan:                       reg === 'unregistered' ? ($('m-pan').value.trim() || null) : null,
  };
  const id = $('m-id').value || null;
  const { data, error } = await supabase.rpc('supplier_save', { p_supplier: id, p });
  // never a false "saved": only the server's answer counts
  if (error || !data?.saved) { $('m-err').textContent = safeErrorMessage(error, 'Could not save the supplier.'); return; }
  _toast(id ? '✅ Supplier updated' : '✅ Supplier added', 'success');
  closeModal();
  await load();
};

let _actId = null;
window.deactivate = function(id) {
  const s = _suppliers.find(x => x.id === id);
  if (!s) return;
  _actId = id;
  $('act-title').textContent = s.is_active ? 'Deactivate supplier?' : 'Activate supplier?';
  $('act-text').textContent = s.is_active
    ? `"${s.name}" will no longer be offered on a goods receipt. Its history is kept.`
    : `"${s.name}" will be offered on goods receipts again.`;
  $('act-err').textContent = '';
  $('act-yes').textContent = s.is_active ? 'Deactivate' : 'Activate';
  $('act-modal').classList.add('open');
};
window.closeActModal = function() { $('act-modal').classList.remove('open'); _actId = null; };
window.confirmToggleActive = async function() {
  const s = _suppliers.find(x => x.id === _actId);
  if (!s) return;
  if (!s.gst_registration) { $('act-err').textContent = 'Record the supplier’s GST registration first (✏ Edit).'; return; }
  const { data, error } = await supabase.rpc('supplier_save', { p_supplier: s.id, p: _payloadFrom(s, { is_active: !s.is_active }) });
  if (error || !data?.saved) { $('act-err').textContent = safeErrorMessage(error, 'Could not change the supplier.'); return; }
  _toast(`✅ Supplier ${s.is_active ? 'deactivated' : 'activated'}`, 'success');
  window.closeActModal();
  await load();
};

window.exportCSV = function() {
  const hdr = ['Name','GST registration','GSTIN','State','PAN','Contact','Phone','Email','GMP Certified','Certificate No.','Authority','GMP Expiry','Approved','Active','Notes'];
  const rows = _suppliers.map(s => [
    s.name, REG_LABEL[s.gst_registration] || '', s.gstin||'', s.state_code||'', s.pan||'', s.contact_name||'', s.phone||'', s.email||'',
    s.is_gmp_certified?'Yes':'No', s.gmp_certificate_number||'',
    s.gmp_certifying_authority||'', s.gmp_certificate_expiry||'',
    s.is_approved?'Yes':'No', s.is_active?'Yes':'No', s.notes||''
  ]);
  // a cell starting with = + - @ is written as text (no spreadsheet formula)
  const cell = c => { let v = String(c); if (/^[=+\-@]/.test(v)) v = "'" + v; return `"${v.replace(/"/g,'""')}"`; };
  const csv = [hdr,...rows].map(r=>r.map(cell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `Suppliers_${tenant?.name||'AyurXpert'}.csv`;
  a.click();
};

function _toast(msg, type = 'info') { notify(msg, type); }   // Session 323: shared top-layer notify()

await load();
