import { requireAuth, getCurrentTenantId, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';
import { notify } from '../components/notify.js';
import { aggregateByMedicine } from '../modules/inventory/stockByMedicine.js';
import { fillFormSelect } from '../modules/inventory/medicineForms.js';
import { STATES } from '../modules/tax/gstReturnsExport.js';

// Session 365: the accountant / finance manager open this page to see (and, the finance manager, cancel) goods receipts;
// recording is for the pharmacy team -- the server decides both (post_purchase_invoice / cancel_purchase_invoice)
await requireAuth(['pharmacist', 'dept_admin', 'super_admin', 'accountant', 'finance_manager']);
initNavbar();
wireDelegatedEvents();

const tenantId   = getCurrentTenantId();
const isSuperAdmin = getCurrentRole() === 'super_admin';
let _medicines   = [];
let _suppliers   = [];
let _lineCount   = 0;
let _activeBarcodeLineEl = null;
let _barcodeStream = null;
let _barcodeDetector = null;
const TODAY      = todayLocalStr();
let _barcodeScanning = false;
let _ocrImageBase64 = null;
let _ocrImageType   = null;
const $ = id => document.getElementById(id);
const GST_RATES = ['0', '0.25', '3', '5', '12', '18', '28', '40'];   // the server decides which are valid on the invoice date
const REG_LABEL = { regular: 'Regular', composition: 'Composition', unregistered: 'Unregistered' };
const money = v => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function _el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style') e.style.cssText = v; else if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k in e && typeof e[k] !== 'function' && k !== 'list') e[k] = v; else e.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const _opt = (value, text, selected) => _el('option', { value, text, selected: !!selected });

// ── Load medicines ─────────────────────────────────
// Session 340: this pharmacy's OWN active medicines (each organisation owns its list -- RLS returns only its own rows).
// This pharmacy's last MRP / GST %, where it has stock rows, pre-fills the line (the invoice's own figures are typed in).
async function loadMedicines() {
  const [{ data: cat }, { data: inv }] = await Promise.all([
    supabase.from('medicines').select('id, name, unit, barcode').eq('tenant_id', tenantId).eq('is_active', true),
    supabase.from('inventory')
      .select('id, medicine_id, stock_quantity, expiry_date, inward_date, is_student_batch, mrp, cost_price, gst_percent, profit_percent')
      .eq('tenant_id', tenantId),
  ]);
  const mine = new Map(aggregateByMedicine(inv).map(i => [i.medicine_id, i]));   // one entry per medicine
  _medicines = (cat || [])
    .map(m => {
      const i = mine.get(m.id);
      return { id: m.id, name: m.name, label: m.unit ? `${m.name} [${m.unit}]` : m.name, barcode: m.barcode,
               mrp: i?.mrp ?? null, gst: i?.gst_percent ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Load suppliers ─────────────────────────────────
async function loadSuppliers() {
  const { data } = await supabase
    .from('suppliers')
    .select('id, name, gstin, state_code, gst_registration, is_gmp_certified, gmp_certificate_number, gmp_certifying_authority, gmp_certificate_expiry, is_approved, is_active')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');
  _suppliers = data || [];
  const sel = $('supplier-select');
  sel.replaceChildren(_opt('', '— Select supplier —'), ..._suppliers.map(s => {
    const gmpOk = s.is_gmp_certified && (!s.gmp_certificate_expiry || s.gmp_certificate_expiry >= TODAY);
    const icon  = gmpOk ? '✅' : s.is_gmp_certified ? '⚠' : '❌';
    return _opt(s.id, `${icon} ${s.name}${s.gst_registration ? '' : ' (GST not recorded)'}`);
  }));
}

function fillPlaceOfSupply() {
  const sel = $('place-of-supply');
  sel.replaceChildren(_opt('', 'Our organisation’s GST state (Tax settings)'),
    ...Object.entries(STATES).filter(([c]) => Number(c) <= 38).map(([c, n]) => _opt(c, `${c} — ${n}`)));
}

window.onSupplierChange = function(val) {
  const card    = $('gmp-status-card');
  const overRow = $('gmp-override-row');
  const gstInfo = $('supplier-gst');
  clearCalc();
  if (!val) { card.style.display = 'none'; overRow.style.display = 'none'; gstInfo.textContent = ''; card.dataset.blocked = '0'; return; }
  const s = _suppliers.find(x => x.id === val);
  if (!s) return;
  gstInfo.replaceChildren(s.gst_registration
    ? `${REG_LABEL[s.gst_registration]}${s.gstin ? ' · GSTIN ' + s.gstin : ''}${s.state_code ? ' · state ' + s.state_code + (STATES[s.state_code] ? ' (' + STATES[s.state_code] + ')' : '') : ''}`
    : _el('span', { style: 'color:var(--red);font-weight:600', text: '⚠ The GST registration is not recorded — add it in Suppliers first.' }));

  // GMP evaluation (shown here; the server enforces it -- NCISM §6(3))
  const in90 = localDateStr(new Date(Date.now()+90*86400000));
  let statusCls, blocked = false;
  const certTxt = `Certificate #${s.gmp_certificate_number || '—'} · ${s.gmp_certifying_authority || '—'}`;
  const head = _el('strong');
  let rest = '';
  if (!s.is_gmp_certified) {
    statusCls = 'border-color:#fca5a5;background:#fff3f3;color:#dc2626';
    head.textContent = '❌ Not GMP Certified'; rest = ' — NCISM §6(3) requires procurement only from GMP-certified pharmacies. Purchase is blocked.'; blocked = true;
  } else if (s.gmp_certificate_expiry && s.gmp_certificate_expiry < TODAY) {
    statusCls = 'border-color:#fca5a5;background:#fff3f3;color:#dc2626';
    head.textContent = `✗ GMP Certificate Expired (${_fmtD(s.gmp_certificate_expiry)})`; rest = ` — ${certTxt}. Purchase is blocked.`; blocked = true;
  } else if (s.gmp_certificate_expiry && s.gmp_certificate_expiry <= in90) {
    statusCls = 'border-color:#e8c068;background:#fff8e1;color:#c9902a';
    head.textContent = `⚠ GMP Certificate Expiring Soon (${_fmtD(s.gmp_certificate_expiry)})`; rest = ` — ${certTxt}. Request renewal from supplier.`;
  } else {
    statusCls = 'border-color:#9dd4b0;background:#e8f5ee;color:#1a4a2e';
    head.textContent = '✓ GMP Certified'; rest = ` — ${certTxt}${s.gmp_certificate_expiry ? ' · Expires ' + _fmtD(s.gmp_certificate_expiry) : ''}`;
  }
  card.style.cssText = `display:block;margin-top:10px;border-radius:10px;padding:12px 16px;border:1.5px solid;font-size:13px;${statusCls}`;
  $('gmp-status-text').replaceChildren(head, rest);
  overRow.style.display = blocked && isSuperAdmin ? '' : 'none';
  $('gmp-override').checked = false; $('gmp-override-reason').value = '';
  card.dataset.blocked = blocked ? '1' : '0';
};

function _fmtD(d){ if(!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }

function _medSelect(selectedId = '') {
  const sel = _el('select', { class: 'sel-med', 'aria-label': 'Medicine' });
  _refillMedSelect(sel, selectedId);
  return sel;
}
// rebuilds one line's medicine list with DOM nodes
function _refillMedSelect(sel, keep) {
  sel.replaceChildren(_opt('', '— Select medicine —'), ..._medicines.map(m => {
    const o = _opt(m.id, m.label || m.name);
    o.dataset.mrp = m.mrp ?? ''; o.dataset.barcode = m.barcode || ''; o.dataset.gst = m.gst ?? '';
    return o;
  }));
  sel.value = keep || '';
}

// ── Add line ───────────────────────────────────────
function addLine(prefill = {}) {
  _lineCount++;
  const expDefault = (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() + 1);
    return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getFullYear()).slice(-2)}`;
  })();
  const sel  = _medSelect(prefill.medId || '');
  const scan = _el('button', { type: 'button', class: 'btn-scan-barcode', title: 'Scan barcode to auto-select medicine', 'aria-label': 'Scan barcode', text: '⬛' });
  const num  = (cls, ph, step, val, label) => _el('input', { type: 'number', class: cls, min: '0', step, placeholder: ph, value: val ?? '', 'aria-label': label });
  const gst  = _el('select', { class: 'inp-gst', 'aria-label': 'GST %' }, _opt('', '—'), ...GST_RATES.map(r => _opt(r, r + ' %')));
  const div  = _el('div', { class: 'line-item', id: `line-${_lineCount}` },
    _el('div', { class: 'med-cell' }, sel, scan),
    _el('input', { type: 'text', class: 'inp-batch', placeholder: 'Batch no.', value: prefill.batch || '', maxLength: 40, 'aria-label': 'Batch number' }),
    _el('input', { type: 'text', class: 'inp-expiry', placeholder: 'MM/YY', maxLength: 5, value: prefill.expiry || expDefault, 'aria-label': 'Expiry MM/YY' }),
    num('inp-qty', 'Qty', '1', prefill.qty, 'Quantity'),
    num('inp-free', '0', '1', prefill.free ?? '', 'Free quantity'),
    num('inp-rate', '0.00', '0.01', prefill.rate, 'Rate excluding GST'),
    num('inp-disc', '0', '0.01', prefill.disc ?? '', 'Discount %'),
    gst,
    num('inp-mrp', '0.00', '0.01', prefill.mrp, 'MRP'),
    _el('button', { type: 'button', class: 'btn-remove-line', 'aria-label': 'Remove line', text: '✕' }),
    _el('div', { class: 'line-calc' }));
  $('line-items').appendChild(div);

  const fromMedicine = () => {
    const o = sel.options[sel.selectedIndex];
    if (!o?.value) return;
    if (!div.querySelector('.inp-mrp').value && o.dataset.mrp) div.querySelector('.inp-mrp').value = o.dataset.mrp;
    if (!gst.value && o.dataset.gst !== '' && GST_RATES.includes(String(Number(o.dataset.gst)))) gst.value = String(Number(o.dataset.gst));
  };
  sel.addEventListener('change', () => { fromMedicine(); updateSummary(); });
  if (prefill.medId) fromMedicine();
  if (prefill.gst !== undefined) gst.value = String(prefill.gst);
  div.querySelector('.btn-remove-line').addEventListener('click', () => { div.remove(); updateSummary(); });
  div.querySelectorAll('input, select').forEach(i => i.addEventListener('input', updateSummary));
  scan.addEventListener('click', () => openBarcodeModal(div));
  // Expiry auto-format: add / after 2 digits
  const expInput = div.querySelector('.inp-expiry');
  expInput.addEventListener('input', function() {
    let v = this.value.replace(/\D/g,'');
    if (v.length >= 2) v = v.slice(0,2) + '/' + v.slice(2,4);
    this.value = v;
  });
  updateSummary();
  return div;
}

// the page counts units only; every rupee figure comes from the server ("Check totals")
function updateSummary() {
  const lines = [...document.querySelectorAll('.line-item')];
  let units = 0;
  lines.forEach(l => { units += (parseInt(l.querySelector('.inp-qty')?.value) || 0) + (parseInt(l.querySelector('.inp-free')?.value) || 0); });
  $('sum-items').textContent = lines.length;
  $('sum-units').textContent = units;
  clearCalc();
}
function clearCalc() {
  $('sum-cost').textContent = '—';
  $('calc-card').hidden = true;
  document.querySelectorAll('.line-calc').forEach(c => c.replaceChildren());
}

document.getElementById('btn-add-line').addEventListener('click', () => addLine());

// ── Session 340: add a medicine to this pharmacy's own list during the receipt ──
const _nm = id => document.getElementById(id);
fillFormSelect(_nm('nm-form'));
function _nmReset() {
  ['nm-name', 'nm-strength', 'nm-unit', 'nm-mfr'].forEach(id => { _nm(id).value = ''; });
  _nm('nm-form').value = ''; _nm('nm-err').textContent = '';
  _nm('nm-warn').style.display = 'none'; _nm('nm-warn').replaceChildren(); _nm('nm-save-anyway').style.display = 'none';
}
_nm('btn-new-med').addEventListener('click', () => { _nmReset(); _nm('new-med-panel').style.display = ''; _nm('nm-name').focus(); });
_nm('nm-cancel').addEventListener('click', () => { _nm('new-med-panel').style.display = 'none'; });
function _nmArgs() {
  return { p_name: _nm('nm-name').value, p_form: _nm('nm-form').value || null, p_strength: _nm('nm-strength').value,
           p_unit: _nm('nm-unit').value, p_manufacturer: _nm('nm-mfr').value, p_hsn: null, p_gst_percent: null };   // Session 345b: the organisation default HSN
}
async function _nmCreate() {
  _nm('nm-save').disabled = _nm('nm-save-anyway').disabled = true;
  const { data, error } = await supabase.rpc('pharmacy_item_create_during_receipt', _nmArgs());
  _nm('nm-save').disabled = _nm('nm-save-anyway').disabled = false;
  if (error) { _nm('nm-err').textContent = safeErrorMessage(error, 'Could not add the medicine.'); return; }
  _medicines.push({ id: data.id, name: data.name, label: data.unit ? `${data.name} [${data.unit}]` : data.name, barcode: null, mrp: null, gst: null });
  _medicines.sort((a, b) => a.name.localeCompare(b.name));
  // refresh every line's list (keeping its choice), then put the new medicine on the first empty line (or a new one)
  document.querySelectorAll('.sel-med').forEach(sel => _refillMedSelect(sel, sel.value));
  const empty = [...document.querySelectorAll('.sel-med')].find(sel => !sel.value);
  if (empty) { empty.value = data.id; empty.dispatchEvent(new Event('change')); } else addLine({ medId: data.id });
  _nm('new-med-panel').style.display = 'none';
  notify(`"${data.name}" added to your list`, 'success');
}
// similar names already in the list are a warning (an exact duplicate is refused by the server)
_nm('nm-save').addEventListener('click', async () => {
  _nm('nm-err').textContent = ''; _nm('nm-warn').style.display = 'none'; _nm('nm-save-anyway').style.display = 'none';
  const a = _nmArgs();
  if (a.p_name.trim().length >= 3) {
    const { data: near, error } = await supabase.rpc('pharmacy_item_near_duplicates', { p_name: a.p_name, p_form: a.p_form, p_exclude: null });
    if (error) { _nm('nm-err').textContent = safeErrorMessage(error, 'Could not check for similar medicines.'); return; }
    if (Array.isArray(near) && near.length) {
      const ul = document.createElement('ul');
      ul.style.margin = '6px 0 0 18px';
      near.forEach(n => { const li = document.createElement('li');
        li.textContent = `${n.name}${n.strength ? ' · ' + n.strength : ''}${n.unit ? ' · ' + n.unit : ''}${n.manufacturer ? ' · ' + n.manufacturer : ''}${n.is_active ? '' : ' — inactive'}`;
        ul.appendChild(li); });
      const head = document.createElement('strong');
      head.textContent = 'Similar medicines are already in your list — pick one of them on the line instead, if it is the same:';
      _nm('nm-warn').replaceChildren(head, ul);
      _nm('nm-warn').style.display = ''; _nm('nm-save-anyway').style.display = '';
      return;
    }
  }
  await _nmCreate();
});
_nm('nm-save-anyway').addEventListener('click', _nmCreate);

// "Clear All": a second click within 4 seconds clears (no native confirm in a money flow)
let _clearArmed = null;
function resetForm() {
  $('line-items').replaceChildren();
  ['invoice-number', 'invoice-total', 'remarks', 'gmp-override-reason'].forEach(id => { $(id).value = ''; });
  $('supplier-select').value = ''; $('place-of-supply').value = ''; $('gmp-override').checked = false;
  $('gmp-status-card').style.display = 'none'; $('gmp-override-row').style.display = 'none'; $('supplier-gst').textContent = '';
  $('gmp-status-card').dataset.blocked = '0';
  $('invoice-date').value = TODAY;
  _lineCount = 0; updateSummary();
}
$('btn-clear').addEventListener('click', () => {
  const b = $('btn-clear');
  if (!_clearArmed) {
    b.textContent = 'Click again to clear'; _clearArmed = setTimeout(() => { b.textContent = 'Clear All'; _clearArmed = null; }, 4000);
    return;
  }
  clearTimeout(_clearArmed); _clearArmed = null; b.textContent = 'Clear All';
  resetForm(); addLine();
});

// ── The payload: what was typed, as printed; the server checks and computes everything ──
function _expiryOf(raw) {
  // A label's "EXP 09/27" means usable through the END of that month (Session 331)
  if (!raw || !/^\d{2}\/\d{2}$/.test(raw)) return null;
  const [mm, yy] = raw.split('/').map(Number);
  if (mm < 1 || mm > 12) return null;
  const last = new Date(Date.UTC(2000 + yy, mm, 0)).getUTCDate();
  return `20${String(yy).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
function buildPayload() {
  const lines = [...document.querySelectorAll('.line-item')];
  if (!lines.length) return { error: 'Add at least one item.' };
  const supplierId = $('supplier-select').value;
  if (!supplierId) return { error: 'Choose the supplier.' };
  const items = [];
  for (const [idx, l] of lines.entries()) {
    const row = `Row ${idx + 1}`;
    const medId = l.querySelector('.sel-med').value;
    if (!medId) return { error: `${row}: select a medicine.` };
    const expiry = _expiryOf(l.querySelector('.inp-expiry').value.trim());
    if (!expiry) return { error: `${row}: enter the expiry as MM/YY (e.g. 09/27).` };
    if (!l.querySelector('.inp-gst').value) return { error: `${row}: choose the GST % printed on the invoice.` };
    items.push({ medicine_id: medId, batch_number: l.querySelector('.inp-batch').value.trim(), expiry_date: expiry,
                 qty: l.querySelector('.inp-qty').value || '0', free_qty: l.querySelector('.inp-free').value || '0',
                 rate: l.querySelector('.inp-rate').value, discount_pct: l.querySelector('.inp-disc').value || '0',
                 gst_rate: l.querySelector('.inp-gst').value, mrp: l.querySelector('.inp-mrp').value });
  }
  const p = { supplier_id: supplierId, supplier_invoice_no: $('invoice-number').value.trim(), supplier_invoice_date: $('invoice-date').value || null,
              invoice_total: $('invoice-total').value === '' ? null : $('invoice-total').value, remarks: $('remarks').value.trim() || null,
              lines: items };
  if ($('place-of-supply').value) p.place_of_supply = $('place-of-supply').value;
  if ($('gmp-status-card').dataset.blocked === '1') {
    if (!$('gmp-override').checked) return { error: 'Purchase blocked: the supplier’s GMP certificate is missing or expired (NCISM §6(3)). Only a Super Admin can override this.' };
    p.gmp_override = true; p.gmp_override_reason = $('gmp-override-reason').value.trim();
  }
  return { p };
}

// the server's figures, shown as they came back
function showCalc(c) {
  const lines = [...document.querySelectorAll('.line-item')];
  (c.lines || []).forEach((ln, i) => {
    const cell = lines[i]?.querySelector('.line-calc');
    if (!cell) return;
    const tax = c.intra_state ? `CGST ${money(ln.cgst_amount)} + SGST ${money(ln.sgst_amount)}` : `IGST ${money(ln.igst_amount)}`;
    cell.textContent = `Taxable ₹${money(ln.taxable_value)}${Number(ln.discount_amount) ? ' (discount ₹' + money(ln.discount_amount) + ')' : ''} · ${tax} · line ₹${money(ln.line_total)} · stock +${Number(ln.qty) + Number(ln.free_qty)} at ₹${money(ln.unit_cost)} a unit`;
  });
  const rows = [['Taxable value', c.taxable_total]];
  if (c.intra_state) { rows.push(['CGST', c.cgst_total], ['SGST', c.sgst_total]); } else { rows.push(['IGST', c.igst_total]); }
  rows.push(['Computed total', c.computed_total]);
  const tbl = _el('table', { class: 'calc-table' }, _el('tbody', {}, ...rows.map(([k, v], i) =>
    _el('tr', { class: i === rows.length - 1 ? 'total' : null }, _el('td', { text: k }), _el('td', { class: 'num', text: '₹ ' + money(v) })))));
  if (c.invoice_total !== null && c.invoice_total !== undefined) {
    tbl.tBodies[0].append(_el('tr', {}, _el('td', { text: 'Supplier’s total (as printed)' }), _el('td', { class: 'num', text: '₹ ' + money(c.invoice_total) })),
                          _el('tr', {}, _el('td', { text: 'Round-off' }), _el('td', { class: 'num', text: '₹ ' + money(c.round_off) })));
  }
  const notes = [];
  notes.push(_el('div', { class: 'note ' + (c.intra_state ? 'ok' : 'warn'),
    text: c.intra_state ? `Intra-state supply (place of supply ${c.place_of_supply}): CGST + SGST.`
                        : `Inter-state supply (supplier state ${c.supplier_state_code}, place of supply ${c.place_of_supply}): IGST.` }));
  if (c.invoice_total === null || c.invoice_total === undefined) notes.push(_el('div', { class: 'note warn', text: 'Enter the supplier’s invoice total — it must match within ₹1.' }));
  else if (!c.total_matches) notes.push(_el('div', { class: 'note bad', text: `The supplier’s total differs from the computed total by ₹${money(Math.abs(c.round_off))} — more than ₹1. Check the rates, discounts and GST % on each line.` }));
  else notes.push(_el('div', { class: 'note ok', text: '✓ The supplier’s total matches (within ₹1).' }));
  notes.push(_el('div', { class: 'note ' + (c.itc_eligible ? 'ok' : 'warn'),
    text: `Input tax credit: ₹${money(c.itc_amount)} — ${c.itc_reason}${c.itc_eligible ? ' Claimed in the GSTR-3B of ' + new Date(c.itc_period + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) + '.' : ''}` }));
  if (c.itc_note) notes.push(_el('div', { class: 'note warn', text: c.itc_note }));
  if (c.itc_deadline_note) notes.push(_el('div', { class: 'note bad', text: c.itc_deadline_note }));
  $('calc-body').replaceChildren(tbl, ...notes);
  $('calc-card').hidden = false;
  $('sum-cost').textContent = '₹' + money(c.computed_total);
}

$('btn-preview-grn').addEventListener('click', async () => {
  const { p, error: e } = buildPayload();
  if (e) { notify(e, 'error'); return; }
  const btn = $('btn-preview-grn'); btn.disabled = true;
  const { data, error } = await supabase.rpc('post_purchase_invoice', { p, p_preview: true });
  btn.disabled = false;
  if (error || !data) { notify(safeErrorMessage(error, 'Could not check the totals.'), 'error'); return; }
  showCalc(data);
});

// ── Save GRN ──────────────────────────────────────
$('btn-save-grn').addEventListener('click', async () => {
  const { p, error: e } = buildPayload();
  if (e) { notify(e, 'error'); return; }
  const btn = $('btn-save-grn');
  $('save-result').replaceChildren();   // the banner speaks only for THIS attempt
  btn.disabled = true; btn.textContent = 'Saving…';
  const { data, error } = await supabase.rpc('post_purchase_invoice', { p, p_preview: false });
  btn.disabled = false; btn.textContent = 'Save GRN & Update Stock';
  // never a false "saved": only the server's answer counts
  if (error || !data?.saved || !data?.grn_number) { notify(safeErrorMessage(error, 'The goods receipt was not saved.'), 'error'); return; }
  const newBatches = (data.lines || []).filter(l => l.new_batch).length;
  const link = _el('a', { href: `printGRN.html?id=${encodeURIComponent(data.id)}`, target: '_blank', rel: 'noopener', class: 'btn btn-secondary btn-sm', text: '🖨 Print GRN' });
  $('save-result').replaceChildren(_el('div', { class: 'note ok', style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
    _el('span', { text: `✓ ${data.grn_number} saved — ${(data.lines || []).length} line(s), stock updated${newBatches ? ` (${newBatches} new batch${newBatches > 1 ? 'es' : ''})` : ''}. ITC ₹${money(data.itc_amount)}.` }), link));
  notify(`${data.grn_number} saved. Stock updated.`, 'success');
  resetForm(); addLine();
  loadGrns();
});

// ── The GRN list (+ Print, + Cancel for the pharmacy in-charge / the finance manager) ──
let _cancelId = null;
async function loadGrns() {
  const { data, error } = await supabase.rpc('list_purchase_invoices', { p_from: $('grn-from').value, p_to: $('grn-to').value });
  const body = $('grn-list');
  if (error || !data) { body.replaceChildren(_el('tr', {}, _el('td', { colSpan: 11, text: safeErrorMessage(error, 'Could not load the goods receipts.') }))); return; }
  // recording is offered only to those the server lets record
  $('grn-form').hidden = !data.can_record;
  document.querySelectorAll('.save-bar, .grn-summary, #line-items, .add-line-row, .items-header').forEach(n => { n.hidden = !data.can_record; });
  document.querySelector('.section-card[style*="padding:0"]')?.toggleAttribute('hidden', !data.can_record);
  $('btn-scan-receipt').hidden = !data.can_record;
  if (!data.rows.length) { body.replaceChildren(_el('tr', {}, _el('td', { colSpan: 11, text: 'No goods receipts in this period.' }))); return; }
  body.replaceChildren(...data.rows.map(r => _el('tr', {},
    _el('td', {}, _el('strong', { text: r.grn_number })),
    _el('td', { text: _fmtD(r.received_date) }),
    _el('td', {}, r.supplier_name, r.supplier_gstin ? _el('div', { style: 'font-family:monospace;color:var(--text-muted)', text: r.supplier_gstin }) : null),
    _el('td', { text: `${r.supplier_invoice_no} · ${_fmtD(r.supplier_invoice_date)}` }),
    _el('td', { class: 'num', text: money(r.taxable_total) }), _el('td', { class: 'num', text: money(r.tax_total) }),
    _el('td', { class: 'num', text: money(r.invoice_total) }), _el('td', { class: 'num', text: money(r.itc_amount) }),
    _el('td', {}, r.status === 'cancelled' ? _el('span', { class: 'badge-cancel', text: 'Cancelled' }) : _el('span', { class: 'badge-posted', text: 'Posted' }),
        r.cancel_reason ? _el('div', { style: 'font-size:11px;color:var(--text-muted)', text: r.cancel_reason }) : null),
    _el('td', { text: r.posted_by || '—' }),
    _el('td', { style: 'white-space:nowrap' },
      _el('a', { href: `printGRN.html?id=${encodeURIComponent(r.id)}`, target: '_blank', rel: 'noopener', class: 'btn btn-ghost btn-sm', text: '🖨 Print' }),
      r.cancel_allowed ? _el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-grn': r.id, 'data-no': r.grn_number, text: 'Cancel…', style: 'margin-left:4px' }) : null))));
}
$('grn-list').addEventListener('click', e => {
  const b = e.target.closest('button[data-grn]');
  if (!b) return;
  _cancelId = b.dataset.grn;
  $('grn-cancel-title').textContent = `Cancel ${b.dataset.no}`;
  $('grn-cancel-reason').value = ''; $('grn-cancel-err').textContent = '';
  $('grn-cancel-panel').hidden = false; $('grn-cancel-reason').focus();
});
$('btn-grn-cancel-no').addEventListener('click', () => { $('grn-cancel-panel').hidden = true; _cancelId = null; });
$('btn-grn-cancel-yes').addEventListener('click', async () => {
  if (!_cancelId) return;
  const btn = $('btn-grn-cancel-yes'); btn.disabled = true;
  const { data, error } = await supabase.rpc('cancel_purchase_invoice', { p_invoice: _cancelId, p_reason: $('grn-cancel-reason').value });
  btn.disabled = false;
  if (error || data?.status !== 'cancelled') { $('grn-cancel-err').textContent = safeErrorMessage(error, 'The goods receipt was not cancelled.'); return; }
  notify(`${data.grn_number} cancelled${data.self_approved ? ' (self-approved: sole administrator)' : ''}. Stock taken out again.`, 'success');
  $('grn-cancel-panel').hidden = true; _cancelId = null;
  loadGrns();
});
$('btn-grn-load').addEventListener('click', loadGrns);

// ── Barcode scanning ──────────────────────────────
function openBarcodeModal(lineEl) {
  _activeBarcodeLineEl = lineEl;
  $('barcode-manual-input').value = '';
  $('barcode-status').textContent = 'Starting camera…';
  $('barcode-modal').classList.add('open');
  startBarcodeCamera();
}

async function startBarcodeCamera() {
  try {
    if (!('BarcodeDetector' in window)) {
      $('barcode-status').textContent = 'Camera scan not supported in this browser. Use manual entry below.';
      return;
    }
    _barcodeDetector = new BarcodeDetector({ formats: ['ean_13','ean_8','code_128','code_39','qr_code','upc_a','upc_e'] });
    _barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('barcode-video');
    video.srcObject = _barcodeStream;
    await video.play();
    _barcodeScanning = true;
    $('barcode-status').textContent = 'Point camera at barcode…';
    scanBarcodeLoop(video);
  } catch {
    $('barcode-status').textContent = 'Camera unavailable. Use manual entry below.';
  }
}

async function scanBarcodeLoop(video) {
  if (!_barcodeScanning) return;
  try {
    const barcodes = await _barcodeDetector.detect(video);
    if (barcodes.length > 0) {
      const code = barcodes[0].rawValue;
      _barcodeScanning = false;
      $('barcode-status').textContent = `Detected: ${code}`;
      resolveBarcodeMatch(code);
      return;
    }
  } catch { /* keep scanning */ }
  if (_barcodeScanning) requestAnimationFrame(() => scanBarcodeLoop(video));
}

function resolveBarcodeMatch(code) {
  stopBarcodeCamera();
  const match = _medicines.find(m => m.barcode === code);
  if (match && _activeBarcodeLineEl) {
    const sel = _activeBarcodeLineEl.querySelector('.sel-med');
    sel.value = match.id;
    sel.dispatchEvent(new Event('change'));
    notify(`Barcode matched: ${match.name}`, 'success');
    closeBarcodeModal();
  } else {
    $('barcode-status').textContent = `Barcode ${code} not found in inventory. Try manual entry.`;
    $('barcode-manual-input').value = code;
  }
}

$('btn-barcode-manual-ok').addEventListener('click', () => {
  const code = $('barcode-manual-input').value.trim();
  if (code) resolveBarcodeMatch(code);
});
$('barcode-manual-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-barcode-manual-ok').click();
});

function stopBarcodeCamera() {
  _barcodeScanning = false;
  if (_barcodeStream) { _barcodeStream.getTracks().forEach(t => t.stop()); _barcodeStream = null; }
  $('barcode-video').srcObject = null;
}

function closeBarcodeModal() {
  stopBarcodeCamera();
  $('barcode-modal').classList.remove('open');
  _activeBarcodeLineEl = null;
}

$('btn-barcode-close').addEventListener('click', closeBarcodeModal);

// ── Receipt OCR (the Edge Function is not deployed yet -- Known Issues #1) ──
$('btn-scan-receipt').addEventListener('click', openOcrModal);

function openOcrModal() {
  _ocrImageBase64 = null; _ocrImageType = null;
  $('ocr-preview').style.display = 'none';
  $('ocr-results').style.display = 'none';
  $('btn-ocr-add-wrap').style.display = 'none';
  $('btn-ocr-extract').disabled = true;
  $('btn-ocr-extract').textContent = '🔍 Extract with AI';
  $('ocr-drop-zone').style.display = '';
  $('ocr-modal').classList.add('open');
}
function closeOcrModal() { $('ocr-modal').classList.remove('open'); }
$('btn-ocr-cancel').addEventListener('click', closeOcrModal);

const dropZone = $('ocr-drop-zone');
const fileInput = $('ocr-file-input');
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleOcrFile(file);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleOcrFile(fileInput.files[0]); });
$('ocr-change-photo').addEventListener('click', () => fileInput.click());

function handleOcrFile(file) {
  if (!file.type.startsWith('image/')) { notify('Please select an image file.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    _ocrImageBase64 = dataUrl.split(',')[1];
    _ocrImageType   = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    $('ocr-preview-img').src = dataUrl;
    $('ocr-preview').style.display = '';
    $('ocr-drop-zone').style.display = 'none';
    $('ocr-results').style.display = 'none';
    $('btn-ocr-add-wrap').style.display = 'none';
    $('btn-ocr-extract').disabled = false;
    $('btn-ocr-extract').textContent = '🔍 Extract with AI';
  };
  reader.readAsDataURL(file);
}

$('btn-ocr-extract').addEventListener('click', async () => {
  if (!_ocrImageBase64) return;
  const btn = $('btn-ocr-extract');
  btn.disabled = true; btn.textContent = '⏳ Analysing receipt…';
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/receipt-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ imageBase64: _ocrImageBase64, mediaType: _ocrImageType }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'OCR failed');
    if (!data.items?.length) {
      btn.disabled = false; btn.textContent = '🔍 Extract with AI';
      notify('No items detected. Try a clearer photo of the invoice.', 'error'); return;
    }
    renderOcrResults(data.items);
  } catch (err) {
    btn.disabled = false; btn.textContent = '🔍 Extract with AI';
    notify(safeErrorMessage(err, 'OCR failed. Please try again.'), 'error');
  }
});

function renderOcrResults(items) {
  $('ocr-items-list').replaceChildren(...items.map((item, i) => _el('div', { class: 'ocr-item', 'data-i': String(i) },
    _el('input', { type: 'text', class: 'ocr-name', value: item.name || '', placeholder: 'Medicine name', 'aria-label': 'Medicine name' }),
    _el('input', { type: 'number', class: 'ocr-qty', min: '1', value: item.quantity || 1, placeholder: 'Qty', 'aria-label': 'Quantity' }),
    _el('input', { type: 'number', class: 'ocr-cost', min: '0', step: '0.01', value: item.cost || 0, placeholder: 'Rate', 'aria-label': 'Rate' }),
    _el('input', { type: 'number', class: 'ocr-mrp', min: '0', step: '0.01', value: item.mrp || 0, placeholder: 'MRP', 'aria-label': 'MRP' }))));
  $('ocr-results').style.display = '';
  $('btn-ocr-add-wrap').style.display = '';
  $('btn-ocr-extract').textContent = '✓ Extracted';
}

$('btn-ocr-rescan').addEventListener('click', () => {
  _ocrImageBase64 = null;
  $('ocr-preview').style.display = 'none';
  $('ocr-drop-zone').style.display = '';
  $('ocr-results').style.display = 'none';
  $('btn-ocr-add-wrap').style.display = 'none';
  $('btn-ocr-extract').disabled = true;
  $('btn-ocr-extract').textContent = '🔍 Extract with AI';
});

$('btn-ocr-add-lines').addEventListener('click', () => {
  const ocrItems = [...document.querySelectorAll('#ocr-items-list .ocr-item')];
  ocrItems.forEach(el => {
    const name = el.querySelector('.ocr-name').value.trim();
    const qty  = parseInt(el.querySelector('.ocr-qty').value) || 1;
    const rate = parseFloat(el.querySelector('.ocr-cost').value) || 0;
    const mrp  = parseFloat(el.querySelector('.ocr-mrp').value) || 0;
    if (!name) return;
    const match = _medicines.find(m => m.name.toLowerCase() === name.toLowerCase())
      || _medicines.find(m => m.name.toLowerCase().includes(name.toLowerCase().slice(0, 8)));
    addLine({ medId: match?.id || '', qty, rate, mrp });
  });
  closeOcrModal();
  notify(`${ocrItems.length} items added from receipt. Please verify and select medicines.`, 'success');
});

// ── Boot ──────────────────────────────────────────
$('invoice-date').value = TODAY;
$('grn-to').value = TODAY;
$('grn-from').value = localDateStr(new Date(Date.now() - 30 * 86400000));
fillPlaceOfSupply();
await Promise.all([loadMedicines(), loadSuppliers()]);
addLine();
loadGrns();
