import { requireAuth, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['pharmacist', 'dept_admin', 'super_admin']);
initNavbar();
wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const tenantId = getCurrentTenantId();
const TODAY    = new Date().toISOString().split('T')[0];
document.getElementById('po-date-line').textContent =
  `Purchase Order · Generated ${new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })}`;

// _poItems: array of {invId, medId, medIdDisplay, name, unit, brand, supplier, currentStock, maxStock, toOrder, costPrice, isManual}
let _poItems = [];
let _allInventory = []; // all active inventory (for add modal search)

// ── Load data ─────────────────────────────────────────
async function loadData() {
  const { data, error } = await supabase
    .from('inventory')
    .select(`id, stock_quantity, cost_price, max_stock, reorder_level, supplier_name,
             medicine:medicines(id, name, med_id, unit, brand, is_active)`)
    .eq('tenant_id', tenantId);

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to load purchase orders.')); return; }

  const allItems = (data || []).filter(i => i.medicine?.is_active !== false);
  _allInventory  = allItems;

  // Low stock = stock <= reorder_level (admin-set), and reorder_level must be set
  _poItems = allItems
    .filter(i => {
      const threshold = i.reorder_level || 0;
      return threshold > 0 && (i.stock_quantity ?? 0) <= threshold;
    })
    .map(i => _makePoItem(i, i.max_stock - (i.stock_quantity ?? 0)));

  render();
}

function _makePoItem(inv, qtyToOrder) {
  return {
    invId:    inv.id,
    medId:    inv.medicine.id,
    medIdDisplay: inv.medicine.med_id || '',
    name:     inv.medicine.name,
    unit:     inv.medicine.unit || '',
    brand:    inv.medicine.brand || '',
    supplier: inv.supplier_name || 'No Supplier',
    currentStock: inv.stock_quantity ?? 0,
    maxStock: inv.max_stock || 0,
    toOrder:  Math.max(1, qtyToOrder),
    costPrice: Number(inv.cost_price || 0),
    isManual: false,
  };
}

// ── Render ─────────────────────────────────────────────
function render() {
  const container = document.getElementById('po-container');
  container.innerHTML = '';

  if (!_poItems.length) {
    document.getElementById('summary-bar').style.display = 'none';
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <div class="empty-title">All Medicines Well Stocked</div>
        <div class="empty-sub">No medicines are below the low stock threshold (50% of max).<br>
          Use "Add Medicine" to manually add items to this PO.</div>
      </div>`;
    updateSummary();
    return;
  }

  // Group by supplier
  const groups = {};
  _poItems.forEach(item => {
    if (!groups[item.supplier]) groups[item.supplier] = [];
    groups[item.supplier].push(item);
  });

  Object.entries(groups)
    .sort(([a],[b]) => (a === 'No Supplier' ? 1 : b === 'No Supplier' ? -1 : a.localeCompare(b)))
    .forEach(([supplier, items]) => {
      container.appendChild(renderGroup(supplier, items));
    });

  // Grand total
  const tmpl = document.getElementById('tmpl-grand-total').content.cloneNode(true);
  container.appendChild(tmpl);
  updateTotals();
  document.getElementById('summary-bar').style.display = '';
}

function renderGroup(supplier, items) {
  const div = document.createElement('div');
  div.className = 'supplier-group';
  div.dataset.supplier = supplier;

  const subtotal = items.reduce((s, i) => s + i.toOrder * i.costPrice, 0);
  const totalUnits = items.reduce((s, i) => s + i.toOrder, 0);

  div.innerHTML = `
    <div class="sg-head">
      <div>
        <div class="sg-name">🏭 ${_esc(supplier)}</div>
        <div class="sg-sub">${items.length} medicine${items.length !== 1 ? 's' : ''} · ${totalUnits} units</div>
      </div>
      <div class="sg-subtotal" data-subtotal>₹${subtotal.toFixed(2)}</div>
    </div>
    <table class="po-table">
      <thead>
        <tr>
          <th>Med ID</th>
          <th>Medicine</th>
          <th>Unit</th>
          <th>Brand</th>
          <th>In Stock</th>
          <th>Max</th>
          <th>To Order</th>
          <th>CP (₹/unit)</th>
          <th style="text-align:right">Line Total (₹)</th>
          <th></th>
        </tr>
      </thead>
      <tbody data-group-body="${_esc(supplier)}">
        ${items.map(item => renderRow(item)).join('')}
      </tbody>
    </table>
    <div class="sg-footer">
      Supplier subtotal:&nbsp;<span class="sg-footer-total" data-sg-total-val="${_esc(supplier)}">₹${subtotal.toFixed(2)}</span>
    </div>
  `;

  // Bind qty inputs
  div.querySelectorAll('.inp-po-qty').forEach(inp => {
    inp.addEventListener('input', () => {
      const invId = inp.dataset.invid;
      const item  = _poItems.find(i => i.invId === invId);
      if (item) {
        item.toOrder = Math.max(0, parseInt(inp.value) || 0);
        const row = inp.closest('tr');
        const lt  = item.toOrder * item.costPrice;
        row.querySelector('[data-linetotal]').textContent = '₹' + lt.toFixed(2);
        updateTotals();
      }
    });
  });

  // Bind remove buttons
  div.querySelectorAll('.btn-remove-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const invId = btn.dataset.invid;
      _poItems = _poItems.filter(i => i.invId !== invId);
      render();
    });
  });

  return div;
}

function renderRow(item) {
  const lt    = item.toOrder * item.costPrice;
  const stkClass = item.currentStock <= 0 ? 'stock-out' : 'stock-low';
  return `
    <tr>
      <td><span class="med-id-badge">${_esc(item.medIdDisplay)}</span></td>
      <td><div class="med-name-cell" title="${_esc(item.name)}">${_esc(item.name)}</div></td>
      <td style="color:var(--text-muted)">${_esc(item.unit) || '—'}</td>
      <td style="color:var(--text-muted)">${_esc(item.brand) || '—'}</td>
      <td><span class="${stkClass}">${item.currentStock}</span></td>
      <td style="color:var(--text-muted)">${item.maxStock}</td>
      <td>
        <input class="inp-po-qty" type="number" min="0" value="${item.toOrder}" data-invid="${item.invId}"/>
        <span class="po-qty-display">${item.toOrder}</span>
      </td>
      <td class="cp-cell">₹${item.costPrice.toFixed(2)}</td>
      <td style="text-align:right"><span class="line-total" data-linetotal>₹${lt.toFixed(2)}</span></td>
      <td><button class="btn-remove-row" data-invid="${item.invId}" title="Remove from PO">✕</button></td>
    </tr>
  `;
}

function updateTotals() {
  const groups = {};
  _poItems.forEach(item => {
    if (!groups[item.supplier]) groups[item.supplier] = 0;
    groups[item.supplier] += item.toOrder * item.costPrice;
  });

  // Update supplier subtotals
  Object.entries(groups).forEach(([supplier, total]) => {
    const el = document.querySelector(`[data-sg-total-val="${CSS.escape(supplier)}"]`);
    const hd = document.querySelector(`[data-supplier="${CSS.escape(supplier)}"] [data-subtotal]`);
    if (el)  el.textContent  = '₹' + total.toFixed(2);
    if (hd)  hd.textContent  = '₹' + total.toFixed(2);
    const sub = document.querySelector(`[data-supplier="${CSS.escape(supplier)}"] .sg-sub`);
    if (sub) {
      const items = _poItems.filter(i => i.supplier === supplier);
      const units = items.reduce((s, i) => s + i.toOrder, 0);
      sub.textContent = `${items.length} medicine${items.length !== 1 ? 's' : ''} · ${units} units`;
    }
  });

  // Grand total
  const grand = _poItems.reduce((s, i) => s + i.toOrder * i.costPrice, 0);
  const units = _poItems.reduce((s, i) => s + i.toOrder, 0);
  const el = document.getElementById('gt-value');
  const lbl = document.getElementById('gt-items-label');
  if (el)  el.textContent  = '₹' + grand.toFixed(2);
  if (lbl) lbl.textContent = `${_poItems.length} medicines · ${units} units`;

  updateSummary();
}

function updateSummary() {
  const suppliers = new Set(_poItems.map(i => i.supplier)).size;
  const units     = _poItems.reduce((s, i) => s + i.toOrder, 0);
  const total     = _poItems.reduce((s, i) => s + i.toOrder * i.costPrice, 0);
  document.getElementById('s-suppliers').textContent = suppliers;
  document.getElementById('s-meds').textContent      = _poItems.length;
  document.getElementById('s-units').textContent     = units;
  document.getElementById('s-total').textContent     = '₹' + total.toFixed(2);
}

// ── CSV Export ─────────────────────────────────────────
document.getElementById('btn-export-csv').addEventListener('click', () => {
  if (!_poItems.length) { _alert('error', 'No items in PO.'); return; }
  const header = ['Supplier','Med ID','Medicine','Unit','Brand','In Stock','Max','To Order','CP (₹)','Line Total (₹)'];
  const rows = _poItems.map(i => [
    `"${i.supplier}"`, i.medIdDisplay, `"${i.name}"`,
    `"${i.unit}"`, `"${i.brand}"`,
    i.currentStock, i.maxStock, i.toOrder,
    i.costPrice.toFixed(2), (i.toOrder * i.costPrice).toFixed(2)
  ]);
  const grand = _poItems.reduce((s, i) => s + i.toOrder * i.costPrice, 0);
  rows.push(['','','','','','','','','Grand Total','₹' + grand.toFixed(2)]);

  const csv = [header, ...rows].map(r => r.join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `PO_${TODAY}.csv`; a.click();
  URL.revokeObjectURL(url);
});

// ── Add Medicine Modal ─────────────────────────────────
let _selectedInv = null;

document.getElementById('btn-add-med').addEventListener('click', openAddModal);
document.getElementById('btn-modal-close').addEventListener('click', closeAddModal);
document.getElementById('btn-modal-cancel').addEventListener('click', closeAddModal);

function openAddModal() {
  _selectedInv = null;
  document.getElementById('med-search-input').value = '';
  document.getElementById('search-results').classList.remove('open');
  document.getElementById('med-add-form').style.display = 'none';
  document.getElementById('btn-modal-add').disabled = true;
  document.getElementById('add-med-modal').classList.add('open');
  setTimeout(() => document.getElementById('med-search-input').focus(), 100);
}
function closeAddModal() {
  document.getElementById('add-med-modal').classList.remove('open');
}

// Search input live filtering
document.getElementById('med-search-input').addEventListener('input', function() {
  const q = this.value.toLowerCase().trim();
  const results = document.getElementById('search-results');
  if (!q) { results.classList.remove('open'); return; }

  // Exclude already-in-PO
  const inPo = new Set(_poItems.map(i => i.invId));
  const matches = _allInventory
    .filter(i => !inPo.has(i.id) && i.medicine.name.toLowerCase().includes(q))
    .slice(0, 8);

  if (!matches.length) {
    results.innerHTML = `<div class="sr-item" style="color:var(--text-muted)">No medicines found</div>`;
    results.classList.add('open');
    return;
  }

  results.innerHTML = matches.map(i => {
    const threshold = i.reorder_level || 0;
    const stockTag  = threshold > 0 && (i.stock_quantity ?? 0) <= threshold ? ' 🔴 Low' : ` · Stock: ${i.stock_quantity ?? 0}`;
    return `<div class="sr-item" data-invid="${i.id}">
      <div class="sr-item-name">${_esc(i.medicine.name)}</div>
      <div class="sr-item-meta">${_esc(i.medicine.brand || '')} ${_esc(i.medicine.unit || '')}${_esc(stockTag)} · Max: ${i.max_stock || '—'} · CP: ₹${Number(i.cost_price || 0).toFixed(2)}</div>
    </div>`;
  }).join('');
  results.classList.add('open');

  results.querySelectorAll('.sr-item[data-invid]').forEach(el => {
    el.addEventListener('click', () => selectMedicine(el.dataset.invid));
  });
});

function selectMedicine(invId) {
  const inv = _allInventory.find(i => i.id === invId);
  if (!inv) return;
  _selectedInv = inv;
  document.getElementById('search-results').classList.remove('open');
  document.getElementById('med-search-input').value = inv.medicine.name;
  document.getElementById('med-add-form').style.display = '';
  document.getElementById('sel-med-id').value     = inv.medicine.id;
  document.getElementById('sel-inv-id').value     = inv.id;
  document.getElementById('sel-med-name').value   = inv.medicine.name;
  document.getElementById('sel-current-stock').value = inv.stock_quantity ?? 0;
  document.getElementById('sel-max-stock').value  = inv.max_stock || '—';
  const defaultQty = Math.max(1, (inv.max_stock || 0) - (inv.stock_quantity ?? 0));
  document.getElementById('sel-qty').value        = defaultQty;
  document.getElementById('sel-cp').value         = Number(inv.cost_price || 0).toFixed(2);
  window._updateLineTotal();
  document.getElementById('btn-modal-add').disabled = false;
  document.getElementById('sel-qty').focus();
}

window._updateLineTotal = function() {
  const qty = parseInt(document.getElementById('sel-qty').value) || 0;
  const cp  = parseFloat(document.getElementById('sel-cp').value) || 0;
  document.getElementById('sel-line-total').value = '₹' + (qty * cp).toFixed(2);
};

document.getElementById('btn-modal-add').addEventListener('click', () => {
  if (!_selectedInv) return;
  const qty = parseInt(document.getElementById('sel-qty').value) || 0;
  const cp  = parseFloat(document.getElementById('sel-cp').value) || 0;
  if (qty <= 0) { _alert('error', 'Enter quantity to order.'); return; }

  const newItem = {
    invId:    _selectedInv.id,
    medId:    _selectedInv.medicine.id,
    medIdDisplay: _selectedInv.medicine.med_id || '',
    name:     _selectedInv.medicine.name,
    unit:     _selectedInv.medicine.unit || '',
    brand:    _selectedInv.medicine.brand || '',
    supplier: _selectedInv.supplier_name || 'No Supplier',
    currentStock: _selectedInv.stock_quantity ?? 0,
    maxStock: _selectedInv.max_stock || 0,
    toOrder:  qty,
    costPrice: cp,
    isManual: true,
  };
  _poItems.push(newItem);
  closeAddModal();
  render();
});

// Close on backdrop click
document.getElementById('add-med-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('add-med-modal')) closeAddModal();
});

function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = `alert show ${type}`;
  if (type !== 'error') setTimeout(() => el.className = 'alert', 4000);
}

await loadData();
