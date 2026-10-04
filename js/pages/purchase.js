import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';
import { notify } from '../components/notify.js';
import { aggregateByMedicine } from '../modules/inventory/stockByMedicine.js';
import { fillFormSelect } from '../modules/inventory/medicineForms.js';

await requireAuth(['pharmacist', 'dept_admin', 'super_admin']);
initNavbar();
wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const tenantId   = getCurrentTenantId();
const profile    = getCurrentProfile();
const isSuperAdmin = getCurrentRole() === 'super_admin';
let _medicines   = [];
let _suppliers   = [];
let _lineCount   = 0;
let _activeBarcodeLineEl = null;
let _barcodeStream = null;
let _barcodeDetector = null;
const TODAY      = todayLocalStr();
const IN_90      = localDateStr(new Date(Date.now() + 90*86400000));
let _barcodeScanning = false;
let _ocrImageBase64 = null;
let _ocrImageType   = null;
let _ocrExtractedItems = [];

// ── Load medicines ─────────────────────────────────
// Session 340: this pharmacy's OWN active medicines (each organisation owns its list -- RLS returns only its own rows),
// not only those already in stock (receive_stock() creates the first batch). A medicine not yet in the list is added
// here during the receipt ("＋ New medicine"). This pharmacy's last MRP / cost, where it has stock rows, pre-fills the line.
async function loadMedicines() {
  const [{ data: cat }, { data: inv }] = await Promise.all([
    supabase.from('medicines').select('id, name, is_active, barcode, unit').eq('is_active', true),
    supabase.from('inventory')
      .select('id, medicine_id, stock_quantity, expiry_date, inward_date, is_student_batch, mrp, cost_price, gst_percent, profit_percent')
      .eq('tenant_id', tenantId),
  ]);
  const mine = new Map(aggregateByMedicine(inv).map(i => [i.medicine_id, i]));   // one entry per medicine
  _medicines = (cat || [])
    .map(m => {
      const i = mine.get(m.id);
      return { id: m.id, name: m.name, label: m.unit ? `${m.name} [${m.unit}]` : m.name, barcode: m.barcode,
               mrp: i?.mrp ?? null, cost: i?.cost_price ?? null, gst: i?.gst_percent ?? 0, profit: i?.profit_percent ?? 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Load suppliers ─────────────────────────────────
async function loadSuppliers() {
  const { data } = await supabase
    .from('suppliers')
    .select('id, name, is_gmp_certified, gmp_certificate_number, gmp_certifying_authority, gmp_certificate_expiry, is_approved, is_active')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');
  _suppliers = data || [];
  const sel = document.getElementById('supplier-select');
  const opts = _suppliers.map(s => {
    const gmpOk = s.is_gmp_certified && (!s.gmp_certificate_expiry || s.gmp_certificate_expiry >= TODAY);
    const icon  = gmpOk ? '✅' : s.is_gmp_certified ? '⚠' : '❌';
    return `<option value="${s.id}">${icon} ${_esc(s.name)}</option>`;
  });
  sel.innerHTML = '<option value="">— Select supplier —</option>' + opts.join('') + '<option value="__manual__">✍ Type manually (unlisted supplier)</option>';
}

window.onSupplierChange = function(val) {
  const manual = document.getElementById('supplier-name-manual');
  const card   = document.getElementById('gmp-status-card');
  const overRow= document.getElementById('gmp-override-row');
  const nameHid= document.getElementById('supplier-name');
  const idHid  = document.getElementById('supplier-id');

  if (val === '__manual__') {
    manual.style.display = '';
    manual.required = true;
    card.style.display = 'none';
    overRow.style.display = 'none';
    idHid.value = '';
    nameHid.value = '';
    return;
  }
  manual.style.display = 'none';
  manual.required = false;

  if (!val) { card.style.display = 'none'; overRow.style.display = 'none'; idHid.value = ''; nameHid.value = ''; return; }

  const s = _suppliers.find(x => x.id === val);
  if (!s) return;
  idHid.value   = s.id;
  nameHid.value = s.name;

  // GMP evaluation
  const now = todayLocalStr();
  const in90 = localDateStr(new Date(Date.now()+90*86400000));
  let statusCls, statusText, blocked = false;

  if (!s.is_gmp_certified) {
    statusCls  = 'border-color:#fca5a5;background:#fff3f3;color:#dc2626';
    statusText = `<strong>❌ Not GMP Certified</strong> — NCISM §6(3) requires procurement only from GMP-certified pharmacies. <strong>Purchase is blocked.</strong>`;
    blocked    = true;
  } else if (s.gmp_certificate_expiry && s.gmp_certificate_expiry < now) {
    statusCls  = 'border-color:#fca5a5;background:#fff3f3;color:#dc2626';
    statusText = `<strong>✗ GMP Certificate Expired</strong> (${_fmtD(s.gmp_certificate_expiry)}) — Certificate #${_esc(s.gmp_certificate_number)||'—'} · ${_esc(s.gmp_certifying_authority)||'—'}. <strong>Purchase is blocked.</strong>`;
    blocked    = true;
  } else if (s.gmp_certificate_expiry && s.gmp_certificate_expiry <= in90) {
    statusCls  = 'border-color:#e8c068;background:#fff8e1;color:#c9902a';
    statusText = `<strong>⚠ GMP Certificate Expiring Soon</strong> (${_fmtD(s.gmp_certificate_expiry)}) — Certificate #${_esc(s.gmp_certificate_number)||'—'} · ${_esc(s.gmp_certifying_authority)||'—'}. Request renewal from supplier.`;
    blocked    = false;
  } else {
    statusCls  = 'border-color:#9dd4b0;background:#e8f5ee;color:#1a4a2e';
    statusText = `<strong>✓ GMP Certified</strong> — Certificate #${_esc(s.gmp_certificate_number)||'—'} · ${_esc(s.gmp_certifying_authority)||'—'}${s.gmp_certificate_expiry?' · Expires '+_fmtD(s.gmp_certificate_expiry):''}`;
    blocked    = false;
  }

  card.style.cssText  = `display:block;margin-top:10px;border-radius:10px;padding:12px 16px;border:1.5px solid;font-size:13px;${statusCls}`;
  card.querySelector('#gmp-status-text').innerHTML = statusText;

  if (blocked && isSuperAdmin) {
    overRow.style.display = '';
    document.getElementById('gmp-override').checked = false;
  } else {
    overRow.style.display = 'none';
  }
  // Store blocked state for save validation
  card.dataset.blocked = blocked ? '1' : '0';
};

function _fmtD(d){ if(!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }

function medOptions(selectedId = '') {
  return `<option value="">— Select medicine —</option>` +
    _medicines.map(m =>
      `<option value="${m.id}" data-mrp="${m.mrp||0}" data-cost="${m.cost||0}" data-barcode="${_esc(m.barcode||'')}" data-profit="${m.profit||0}" data-gst="${m.gst||0}" ${m.id === selectedId ? 'selected' : ''}>${_esc(m.label || m.name)}</option>`
    ).join('');
}

// ── Add line ───────────────────────────────────────
function addLine(prefill = {}) {
  _lineCount++;
  const n = _lineCount;
  const expDefault = (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() + 1);
    return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getFullYear()).slice(-2)}`;
  })();

  const div = document.createElement('div');
  div.className = 'line-item';
  div.id = `line-${n}`;
  div.innerHTML = `
    <div class="med-cell">
      <select class="sel-med" data-n="${n}">${medOptions(prefill.medId || '')}</select>
      <button class="btn-scan-barcode" data-n="${n}" title="Scan barcode to auto-select medicine">⬛</button>
    </div>
    <input type="text" class="inp-batch" placeholder="Batch no." value="${_esc(prefill.batch || '')}"/>
    <input type="text" class="inp-expiry" placeholder="MM/YY" maxlength="5" value="${_esc(prefill.expiry || expDefault)}"/>
    <input type="number" class="inp-qty" min="1" placeholder="Qty" data-n="${n}" value="${prefill.qty || ''}"/>
    <input type="number" class="inp-cost" min="0" step="0.01" placeholder="0.00" value="${prefill.cost || ''}"/>
    <input type="number" class="inp-mrp" min="0" step="0.01" placeholder="0.00" value="${prefill.mrp || ''}"/>
    <button class="btn-remove-line" data-n="${n}">✕</button>
  `;
  document.getElementById('line-items').appendChild(div);

  const sel     = div.querySelector('.sel-med');
  const inpMrp  = div.querySelector('.inp-mrp');
  const inpCost = div.querySelector('.inp-cost');

  function autocalcCost() {
    const opt = sel.options[sel.selectedIndex];
    const mrp = parseFloat(inpMrp.value) || 0;
    const pct = parseFloat(opt?.dataset?.profit || 0);
    if (mrp > 0 && pct > 0) inpCost.value = (mrp - mrp * pct / 100).toFixed(2);
    updateSummary();
  }

  sel.addEventListener('change', function() {
    const opt = this.options[this.selectedIndex];
    if (opt.value) {
      inpMrp.value = opt.dataset.mrp || '';
      autocalcCost();
    }
    updateSummary();
  });

  inpMrp.addEventListener('input', autocalcCost);

  // Pre-fill if medId given
  if (prefill.medId) {
    const opt = sel.querySelector(`option[value="${prefill.medId}"]`);
    if (opt) { inpMrp.value = opt.dataset.mrp || ''; autocalcCost(); }
  }

  div.querySelector('.btn-remove-line').addEventListener('click', () => { div.remove(); updateSummary(); });
  div.querySelector('.inp-qty').addEventListener('input', updateSummary);
  inpCost.addEventListener('input', updateSummary);
  div.querySelector('.btn-scan-barcode').addEventListener('click', () => openBarcodeModal(div));

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

function updateSummary() {
  const lines = [...document.querySelectorAll('.line-item')];
  let units = 0, cost = 0;
  lines.forEach(l => {
    units += parseInt(l.querySelector('.inp-qty')?.value) || 0;
    cost  += (parseInt(l.querySelector('.inp-qty')?.value) || 0) * (parseFloat(l.querySelector('.inp-cost')?.value) || 0);
  });
  document.getElementById('sum-items').textContent = lines.length;
  document.getElementById('sum-units').textContent = units;
  document.getElementById('sum-cost').textContent  = '₹' + cost.toFixed(2);
}

document.getElementById('btn-add-line').addEventListener('click', () => addLine());

// ── Session 340: add a medicine to this pharmacy's own list during the receipt ──
const _nm = id => document.getElementById(id);
fillFormSelect(_nm('nm-form'));
function _nmReset() {
  ['nm-name', 'nm-strength', 'nm-unit', 'nm-mfr', 'nm-hsn'].forEach(id => { _nm(id).value = ''; });
  _nm('nm-form').value = ''; _nm('nm-err').textContent = '';
  _nm('nm-warn').style.display = 'none'; _nm('nm-warn').replaceChildren(); _nm('nm-save-anyway').style.display = 'none';
}
_nm('btn-new-med').addEventListener('click', () => { _nmReset(); _nm('new-med-panel').style.display = ''; _nm('nm-name').focus(); });
_nm('nm-cancel').addEventListener('click', () => { _nm('new-med-panel').style.display = 'none'; });
function _nmArgs() {
  return { p_name: _nm('nm-name').value, p_form: _nm('nm-form').value || null, p_strength: _nm('nm-strength').value,
           p_unit: _nm('nm-unit').value, p_manufacturer: _nm('nm-mfr').value, p_hsn: _nm('nm-hsn').value || null, p_gst_percent: null };
}
// rebuilds one line's medicine list with DOM nodes (same data-* attributes as medOptions())
function _refillMedSelect(sel, keep) {
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '— Select medicine —';
  const opts = _medicines.map(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label || m.name;
    o.dataset.mrp = m.mrp || 0; o.dataset.cost = m.cost || 0; o.dataset.barcode = m.barcode || '';
    o.dataset.profit = m.profit || 0; o.dataset.gst = m.gst || 0;
    return o;
  });
  sel.replaceChildren(blank, ...opts);
  sel.value = keep || '';
}
async function _nmCreate() {
  _nm('nm-save').disabled = _nm('nm-save-anyway').disabled = true;
  const { data, error } = await supabase.rpc('pharmacy_item_create_during_receipt', _nmArgs());
  _nm('nm-save').disabled = _nm('nm-save-anyway').disabled = false;
  if (error) { _nm('nm-err').textContent = safeErrorMessage(error, 'Could not add the medicine.'); return; }
  _medicines.push({ id: data.id, name: data.name, label: data.unit ? `${data.name} [${data.unit}]` : data.name, barcode: null,
                    mrp: null, cost: null, gst: 0, profit: 0 });
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
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('Clear all items?')) return;
  document.getElementById('line-items').innerHTML = '';
  ['supplier-name','supplier-name-manual','supplier-id','invoice-number','invoice-date','remarks'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('supplier-select').value = '';
  document.getElementById('supplier-name-manual').style.display = 'none';
  document.getElementById('gmp-status-card').style.display = 'none';
  document.getElementById('gmp-override-row').style.display = 'none';
  _lineCount = 0; updateSummary();
});

// ── Save GRN ──────────────────────────────────────
document.getElementById('btn-save-grn').addEventListener('click', async () => {
  // Resolve supplier name
  const supSelect = document.getElementById('supplier-select').value;
  let supplier, supplierId;
  if (supSelect === '__manual__') {
    supplier   = document.getElementById('supplier-name-manual').value.trim();
    supplierId = null;
  } else {
    supplier   = document.getElementById('supplier-name').value.trim();
    supplierId = document.getElementById('supplier-id').value || null;
  }
  if (!supplier) { _alert('error', 'Supplier name is required.'); return; }

  // GMP block check
  const gmpCard = document.getElementById('gmp-status-card');
  if (gmpCard.dataset.blocked === '1') {
    const overridden = document.getElementById('gmp-override')?.checked;
    if (!overridden) {
      _alert('error', 'Purchase blocked: supplier GMP certificate is expired or missing (NCISM §6(3)). Only a Super Admin can override this.');
      return;
    }
  }
  const lines = [...document.querySelectorAll('.line-item')];
  if (!lines.length) { _alert('error', 'Add at least one item.'); return; }

  const items = []; let hasError = false;
  lines.forEach((l, idx) => {
    const medId  = l.querySelector('.sel-med').value;
    const qty    = parseInt(l.querySelector('.inp-qty').value) || 0;
    const mrp    = parseFloat(l.querySelector('.inp-mrp').value) || 0;
    const cost   = parseFloat(l.querySelector('.inp-cost').value) || 0;
    const batch  = l.querySelector('.inp-batch').value.trim() || null;
    const expRaw = l.querySelector('.inp-expiry').value.trim();
    // A label's "EXP 09/27" means usable through the END of that month (Session 331: was stored as the 1st)
    let expiry = null;
    if (expRaw && /^\d{2}\/\d{2}$/.test(expRaw)) {
      const [mm, yy] = expRaw.split('/').map(Number);
      if (mm >= 1 && mm <= 12) {
        const last = new Date(Date.UTC(2000 + yy, mm, 0)).getUTCDate();
        expiry = `20${String(yy).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
      }
    }
    const row = `Row ${idx + 1}`;
    if (!medId || qty <= 0) { _alert('error', `${row}: select a medicine and enter quantity.`); hasError = true; return; }
    // Session 331 -- real batches: every received line needs its batch number, expiry and MRP
    if (!batch)   { _alert('error', `${row}: enter the batch number.`); hasError = true; return; }
    if (!expiry)  { _alert('error', `${row}: enter the expiry as MM/YY (e.g. 09/27).`); hasError = true; return; }
    if (!(mrp > 0)) { _alert('error', `${row}: enter the MRP.`); hasError = true; return; }
    items.push({ medId, qty, mrp, cost, batch, expiry });
  });
  if (hasError) return;

  const btn = document.getElementById('btn-save-grn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const invoiceDate   = document.getElementById('invoice-date').value || null;
  const invoiceNumber = document.getElementById('invoice-number').value.trim() || null;

  try {
    // Session 331: one server call, all lines or none. Each line goes into its own batch (same batch no. +
    // expiry + MRP adds to that batch); the receipt is logged in stock_batches. It never reports stock that
    // was not added -- the old per-line browser loop silently skipped a medicine with no / two stock rows.
    const { data: res, error } = await supabase.rpc('receive_stock', {
      p_lines: items.map(i => ({ medicine_id: i.medId, batch_number: i.batch, expiry_date: i.expiry,
                                 qty: i.qty, mrp: i.mrp, cost_price: i.cost })),
      p_supplier_id: supplierId, p_supplier_name: supplier,
      p_invoice_number: invoiceNumber, p_invoice_date: invoiceDate,
    });
    if (error) throw error;
    const newBatches = (res?.lines || []).filter(l => l.new_batch).length;
    _alert('success', `GRN saved: ${items.length} line(s), ${res?.received_qty ?? 0} units received` +
      (newBatches ? ` (${newBatches} new batch${newBatches > 1 ? 'es' : ''})` : '') + '. Stock updated.');
    document.getElementById('line-items').innerHTML = '';
    ['supplier-name','supplier-name-manual','supplier-id','invoice-number','invoice-date','remarks'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('supplier-select').value = '';
    document.getElementById('supplier-name-manual').style.display = 'none';
    document.getElementById('gmp-status-card').style.display = 'none';
    document.getElementById('gmp-override-row').style.display = 'none';
    document.getElementById('invoice-date').value = todayLocalStr();
    _lineCount = 0; updateSummary();
  } catch (err) {
    _alert('error', safeErrorMessage(err, 'Save failed. Please try again.'));
  }
  btn.disabled = false; btn.textContent = 'Save & Update Stock';
});

// ── Barcode scanning ──────────────────────────────
function openBarcodeModal(lineEl) {
  _activeBarcodeLineEl = lineEl;
  document.getElementById('barcode-manual-input').value = '';
  document.getElementById('barcode-status').textContent = 'Starting camera…';
  document.getElementById('barcode-modal').classList.add('open');
  startBarcodeCamera();
}

async function startBarcodeCamera() {
  try {
    // Check BarcodeDetector support
    if (!('BarcodeDetector' in window)) {
      document.getElementById('barcode-status').textContent = 'Camera scan not supported in this browser. Use manual entry below.';
      return;
    }
    _barcodeDetector = new BarcodeDetector({ formats: ['ean_13','ean_8','code_128','code_39','qr_code','upc_a','upc_e'] });
    _barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.getElementById('barcode-video');
    video.srcObject = _barcodeStream;
    await video.play();
    _barcodeScanning = true;
    document.getElementById('barcode-status').textContent = 'Point camera at barcode…';
    scanBarcodeLoop(video);
  } catch (err) {
    document.getElementById('barcode-status').textContent = 'Camera unavailable. Use manual entry below.';
  }
}

async function scanBarcodeLoop(video) {
  if (!_barcodeScanning) return;
  try {
    const barcodes = await _barcodeDetector.detect(video);
    if (barcodes.length > 0) {
      const code = barcodes[0].rawValue;
      _barcodeScanning = false;
      document.getElementById('barcode-status').textContent = `Detected: ${code}`;
      resolveBarcodeMatch(code);
      return;
    }
  } catch {}
  if (_barcodeScanning) requestAnimationFrame(() => scanBarcodeLoop(video));
}

function resolveBarcodeMatch(code) {
  stopBarcodeCamera();
  const match = _medicines.find(m => m.barcode === code);
  if (match && _activeBarcodeLineEl) {
    const sel = _activeBarcodeLineEl.querySelector('.sel-med');
    sel.value = match.id;
    sel.dispatchEvent(new Event('change'));
    _alert('success', `Barcode matched: ${match.name}`);
    closeBarcodeModal();
  } else {
    document.getElementById('barcode-status').textContent = `Barcode ${code} not found in inventory. Try manual entry.`;
    document.getElementById('barcode-manual-input').value = code;
  }
}

document.getElementById('btn-barcode-manual-ok').addEventListener('click', () => {
  const code = document.getElementById('barcode-manual-input').value.trim();
  if (code) resolveBarcodeMatch(code);
});
document.getElementById('barcode-manual-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-barcode-manual-ok').click();
});

function stopBarcodeCamera() {
  _barcodeScanning = false;
  if (_barcodeStream) { _barcodeStream.getTracks().forEach(t => t.stop()); _barcodeStream = null; }
  const video = document.getElementById('barcode-video');
  video.srcObject = null;
}

function closeBarcodeModal() {
  stopBarcodeCamera();
  document.getElementById('barcode-modal').classList.remove('open');
  _activeBarcodeLineEl = null;
}

document.getElementById('btn-barcode-close').addEventListener('click', closeBarcodeModal);

// ── Receipt OCR ───────────────────────────────────
document.getElementById('btn-scan-receipt').addEventListener('click', openOcrModal);

function openOcrModal() {
  _ocrImageBase64 = null; _ocrImageType = null; _ocrExtractedItems = [];
  document.getElementById('ocr-preview').style.display = 'none';
  document.getElementById('ocr-results').style.display = 'none';
  document.getElementById('btn-ocr-add-wrap').style.display = 'none';
  document.getElementById('btn-ocr-extract').disabled = true;
  document.getElementById('btn-ocr-extract').textContent = '🔍 Extract with AI';
  document.getElementById('ocr-drop-zone').style.display = '';
  document.getElementById('ocr-modal').classList.add('open');
}

function closeOcrModal() {
  document.getElementById('ocr-modal').classList.remove('open');
}

document.getElementById('btn-ocr-cancel').addEventListener('click', closeOcrModal);

// Drop zone / file select
const dropZone = document.getElementById('ocr-drop-zone');
const fileInput = document.getElementById('ocr-file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleOcrFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleOcrFile(fileInput.files[0]);
});
document.getElementById('ocr-change-photo').addEventListener('click', () => fileInput.click());

function handleOcrFile(file) {
  if (!file.type.startsWith('image/')) { _alert('error', 'Please select an image file.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    const base64  = dataUrl.split(',')[1];
    _ocrImageBase64 = base64;
    _ocrImageType   = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    document.getElementById('ocr-preview-img').src = dataUrl;
    document.getElementById('ocr-preview').style.display = '';
    document.getElementById('ocr-drop-zone').style.display = 'none';
    document.getElementById('ocr-results').style.display = 'none';
    document.getElementById('btn-ocr-add-wrap').style.display = 'none';
    document.getElementById('btn-ocr-extract').disabled = false;
    document.getElementById('btn-ocr-extract').textContent = '🔍 Extract with AI';
  };
  reader.readAsDataURL(file);
}

document.getElementById('btn-ocr-extract').addEventListener('click', async () => {
  if (!_ocrImageBase64) return;
  const btn = document.getElementById('btn-ocr-extract');
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
      _alert('error', 'No items detected. Try a clearer photo of the invoice.'); return;
    }
    _ocrExtractedItems = data.items;
    renderOcrResults(data.items);
  } catch (err) {
    btn.disabled = false; btn.textContent = '🔍 Extract with AI';
    _alert('error', safeErrorMessage(err, 'OCR failed. Please try again.'));
  }
});

function renderOcrResults(items) {
  const listEl = document.getElementById('ocr-items-list');
  listEl.innerHTML = items.map((item, i) => `
    <div class="ocr-item" data-i="${i}">
      <input type="text" class="ocr-name" value="${_esc(item.name || '')}" placeholder="Medicine name"/>
      <input type="number" class="ocr-qty" min="1" value="${item.quantity || 1}" placeholder="Qty"/>
      <input type="number" class="ocr-cost" min="0" step="0.01" value="${item.cost || 0}" placeholder="Cost"/>
      <input type="number" class="ocr-mrp" min="0" step="0.01" value="${item.mrp || 0}" placeholder="MRP"/>
    </div>
  `).join('');

  document.getElementById('ocr-results').style.display = '';
  document.getElementById('btn-ocr-add-wrap').style.display = '';
  document.getElementById('btn-ocr-extract').textContent = '✓ Extracted';
}

document.getElementById('btn-ocr-rescan').addEventListener('click', () => {
  _ocrImageBase64 = null;
  document.getElementById('ocr-preview').style.display = 'none';
  document.getElementById('ocr-drop-zone').style.display = '';
  document.getElementById('ocr-results').style.display = 'none';
  document.getElementById('btn-ocr-add-wrap').style.display = 'none';
  document.getElementById('btn-ocr-extract').disabled = true;
  document.getElementById('btn-ocr-extract').textContent = '🔍 Extract with AI';
});

document.getElementById('btn-ocr-add-lines').addEventListener('click', () => {
  const ocrItems = [...document.querySelectorAll('#ocr-items-list .ocr-item')];
  ocrItems.forEach(el => {
    const name = el.querySelector('.ocr-name').value.trim();
    const qty  = parseInt(el.querySelector('.ocr-qty').value) || 1;
    const cost = parseFloat(el.querySelector('.ocr-cost').value) || 0;
    const mrp  = parseFloat(el.querySelector('.ocr-mrp').value) || 0;
    if (!name) return;
    // Try to match medicine by name
    const match = _medicines.find(m => m.name.toLowerCase() === name.toLowerCase())
      || _medicines.find(m => m.name.toLowerCase().includes(name.toLowerCase().slice(0, 8)));
    addLine({ medId: match?.id || '', qty, cost, mrp });
  });
  closeOcrModal();
  _alert('success', `${ocrItems.length} items added from receipt. Please verify and select medicines.`);
});

// ── Alert helper ──────────────────────────────────
function _alert(type, msg) { notify(msg, type); }   // Session 323: shared top-layer notify()

// ── Boot ──────────────────────────────────────────
document.getElementById('invoice-date').value = todayLocalStr();
await Promise.all([loadMedicines(), loadSuppliers()]);
addLine();
