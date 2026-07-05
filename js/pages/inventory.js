import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['pharmacist', 'dept_admin', 'super_admin']);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
let _items  = [];
let _adjType = 'add';
let _tags   = [];
let _namcLabels = {};
let _imgUploading = false;
const TODAY = new Date().toISOString().split('T')[0];
const IN_90_DAYS = new Date(Date.now() + 90*86400000).toISOString().split('T')[0];

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const CAT_LABELS = {
  tablet:'Tablet / Capsule', churna:'Churna', kwatha:'Kwatha / Kashayam',
  asava:'Asava / Arishta', ghrita:'Ghrita / Taila', bhasma:'Bhasma / Rasa',
  leha:'Leha / Avaleha', syrup:'Syrup / Liquid', cream:'Cream / Ointment',
  injection:'Injection', other:'Other',
};

// ── Pricing calculations ─────────────────────────────
function calcPricing() {
  const mrp     = parseFloat(document.getElementById('f-mrp').value)    || 0;
  const gstPct  = parseFloat(document.getElementById('f-gst').value)    || 0;
  const profPct = parseFloat(document.getElementById('f-profit').value) || 0;

  const bp = mrp > 0 ? mrp / (1 + gstPct / 100) : 0;
  const ta = mrp - bp;
  const pa = mrp * profPct / 100;
  const cp = mrp - pa;

  document.getElementById('c-bp').textContent = '₹' + bp.toFixed(2);
  document.getElementById('c-ta').textContent = '₹' + ta.toFixed(2);
  document.getElementById('c-pa').textContent = '₹' + pa.toFixed(2);
  document.getElementById('c-cp').textContent = '₹' + cp.toFixed(2);
}
window._calcPricing = calcPricing;

// Bind input + change + keyup on all three pricing number inputs
['input','change','keyup'].forEach(ev => {
  document.getElementById('f-mrp').addEventListener(ev, calcPricing);
  document.getElementById('f-gst').addEventListener(ev, calcPricing);
  document.getElementById('f-profit').addEventListener(ev, calcPricing);
});

// Auto-suggest Low = floor(Max/2) when Max is entered
['input','change'].forEach(ev => {
  document.getElementById('f-max').addEventListener(ev, () => {
    const max = parseInt(document.getElementById('f-max').value) || 0;
    const reorderEl = document.getElementById('f-reorder');
    const suggested = max > 0 ? Math.floor(max / 2) : '';
    // Only auto-fill if field is empty or still matches previous auto-value
    if (!reorderEl.dataset.manuallySet) reorderEl.value = suggested;
  });
});
document.getElementById('f-reorder').addEventListener('input', () => {
  document.getElementById('f-reorder').dataset.manuallySet = '1';
});

// ── Load inventory ──────────────────────────────────
async function loadInventory() {
  const { data, error } = await supabase
    .from('inventory')
    .select(`id, stock_quantity, mrp, cost_price, gst_percent, reorder_level,
             profit_percent, max_stock, expiry_date, inward_date, supplier_name, batch_number,
             is_gmp_certified, gmp_certificate_no, is_student_batch,
             is_high_risk, is_lasa, lasa_pair, is_schedule_h,
             medicine:medicines(id, name, category, is_active, indications, barcode, med_id, brand, unit, image_url, anupana, classical_reference, dosage_text)`)
    .eq('tenant_id', tenantId);

  if (error) { console.error('loadInventory error:', error); _alert('error', 'Failed to load inventory: ' + error.message); return; }
  _items = (data || []).filter(i => i.medicine)
    .sort((a, b) => a.medicine.name.localeCompare(b.medicine.name));
  renderSummary();
  renderTable();
}

function renderSummary() {
  const active   = _items.filter(i => i.medicine.is_active !== false);
  const inactive = _items.filter(i => i.medicine.is_active === false);
  const low      = active.filter(i => { const t = i.reorder_level || 0; return i.stock_quantity > 0 && i.stock_quantity <= t && t > 0; });
  const out      = active.filter(i => i.stock_quantity <= 0);
  const expiring = active.filter(i => i.expiry_date && i.expiry_date <= IN_90_DAYS && i.expiry_date >= TODAY);
  document.getElementById('s-total').textContent    = active.length;
  document.getElementById('s-low').textContent      = low.length;
  document.getElementById('s-out').textContent      = out.length;
  document.getElementById('s-inactive').textContent = inactive.length;
  document.getElementById('s-expiry').textContent   = expiring.length;
}

function renderTable() {
  const search    = document.getElementById('search').value.toLowerCase().trim();
  const filterCat = document.getElementById('filter-cat').value;
  const filterStk = document.getElementById('filter-stock').value;
  const filterSts = document.getElementById('filter-status').value;
  const filterMedType = document.getElementById('filter-med-type')?.value || '';

  let rows = _items;

  if (filterSts === 'active')   rows = rows.filter(i => i.medicine.is_active !== false);
  else if (filterSts === 'inactive') rows = rows.filter(i => i.medicine.is_active === false);

  if (filterCat) rows = rows.filter(i => i.medicine.category === filterCat);
  // §21v — filter by medicine type (finished / raw_drug / classical)
  if (filterMedType) rows = rows.filter(i => (i.medicine_type || 'finished') === filterMedType);

  if (filterStk === 'out')  rows = rows.filter(i => i.stock_quantity <= 0);
  else if (filterStk === 'low') rows = rows.filter(i => { const t = i.reorder_level || 0; return i.stock_quantity > 0 && i.stock_quantity <= t && t > 0; });
  else if (filterStk === 'ok')  rows = rows.filter(i => i.stock_quantity > (i.reorder_level || 0));

  if (search) rows = rows.filter(i => {
    const inds = Array.isArray(i.medicine.indications) ? i.medicine.indications : [];
    return i.medicine.name.toLowerCase().includes(search)
      || (i.medicine.brand || '').toLowerCase().includes(search)
      || inds.some(ind => ind.toLowerCase().includes(search));
  });

  const tbody = document.getElementById('med-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="21" class="table-empty">No medicines found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(i => {
    const reorder = i.reorder_level || 0;
    const qty     = i.stock_quantity ?? 0;
    let stockClass = 'stock-ok', badgeClass = 'sb-ok', badgeText = 'OK';
    if (qty <= 0)                    { stockClass = 'stock-out'; badgeClass = 'sb-out'; badgeText = 'Out'; }
    else if (reorder > 0 && qty <= reorder) { stockClass = 'stock-low'; badgeClass = 'sb-low'; badgeText = 'Low'; }

    const isActive  = i.medicine.is_active !== false;
    const mrp       = Number(i.mrp || 0);
    const gstPct    = Number(i.gst_percent || 0);
    const profPct   = Number(i.profit_percent || 0);
    const bp        = mrp / (1 + gstPct / 100);
    const ta        = mrp - bp;
    const pa        = mrp * profPct / 100;
    const cp        = mrp - pa;

    const imgHtml = i.medicine.image_url
      ? `<img src="${_esc(i.medicine.image_url)}" class="med-thumb" loading="lazy"/>`
      : `<img src="assets/icon.svg" class="med-thumb" style="padding:5px;background:var(--green-light)" loading="lazy"/>`;

    const inds = Array.isArray(i.medicine.indications) ? i.medicine.indications : [];
    const indHtml = inds.slice(0, 2).map(t => `<span class="ind-pill">${_esc(t)}</span>`).join('')
      + (inds.length > 2 ? `<span style="font-size:10px;color:var(--text-muted)">+${inds.length-2}</span>` : '');

    const expiryHtml = i.expiry_date
      ? `<span style="color:${i.expiry_date <= IN_90_DAYS ? 'var(--red)' : 'inherit'}">${_fmtDate(i.expiry_date)}</span>`
      : '<span style="color:var(--text-muted)">—</span>';

    return `
      <tr class="${isActive ? '' : 'inactive-row'}">
        <td><input type="checkbox" class="row-chk" data-id="${i.id}" style="cursor:pointer;accent-color:var(--green-deep);vertical-align:middle;margin-right:5px"/><span class="med-id-badge">${_esc(i.medicine.med_id) || '—'}</span></td>
        <td>${imgHtml}</td>
        <td>
          <div class="med-name" title="${_esc(i.medicine.name)}">${_esc(i.medicine.name)}</div>
          <div class="med-sub">${CAT_LABELS[i.medicine.category] || ''}</div>
          ${inds.length ? `<div style="margin-top:2px">${indHtml}</div>` : ''}
        </td>
        <td style="color:var(--text-mid)">${_esc(i.medicine.brand) || '—'}</td>
        <td style="color:var(--text-muted)">${_esc(i.medicine.unit) || '—'}</td>
        <td>
          <span class="${stockClass}">${qty}</span>
          <span class="stock-badge ${badgeClass}" style="margin-left:3px">${badgeText}</span>
        </td>
        <td class="calc-val">₹${bp.toFixed(2)}</td>
        <td style="color:var(--text-muted)">${gstPct}%</td>
        <td style="color:var(--text-muted)">₹${ta.toFixed(2)}</td>
        <td style="font-weight:600">₹${mrp.toFixed(2)}</td>
        <td class="profit-val">${profPct}%</td>
        <td class="profit-val">₹${pa.toFixed(2)}</td>
        <td class="calc-val">₹${cp.toFixed(2)}</td>
        <td style="color:var(--text-muted);font-size:11px">${i.inward_date ? _fmtDate(i.inward_date) : '—'}</td>
        <td style="font-size:11px">${expiryHtml}</td>
        <td style="color:var(--text-muted);font-size:11px;font-family:monospace">${i.batch_number ? _esc(i.batch_number) : '<span style="color:#ccc">—</span>'}</td>
        <td style="color:var(--text-muted)">${reorder}</td>
        <td style="color:var(--text-muted)">${i.max_stock ?? 0}</td>
        <td style="color:var(--text-muted);max-width:110px;overflow:hidden;text-overflow:ellipsis">
          ${_esc(i.supplier_name) || '—'}
          ${i.is_gmp_certified
            ? '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#e8f5ee;color:#1a4a2e;border:1px solid #b2d8bf">GMP✓</span>'
            : '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#fff8e1;color:#7a5c00;border:1px solid #e0c060">GMP?</span>'}
          ${i.is_high_risk ? '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#fdecea;color:#8b1a1a;border:1px solid #f5b8b8">⚠ HIGH-RISK</span>' : ''}
          ${i.is_lasa      ? '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#fff3cd;color:#7a4a00;border:1px solid #e8d08a">LASA</span>' : ''}
          ${i.is_schedule_h ? '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#e3f0ff;color:#1a4080;border:1px solid #a8c8f0">Sch-H</span>' : ''}
          ${i.is_student_batch
            ? '<br><span style="display:inline-block;margin-top:2px;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;background:#fff8e1;color:#7a4000;border:1px solid #e8c068">⚠ STUDENT</span>'
            : ''}
        </td>
        <td><button class="btn-status-toggle stock-badge ${isActive ? 'sb-ok' : ''}" data-med-id="${i.medicine.id}" data-active="${isActive}" style="${isActive ? '' : 'background:#f0f0f0;color:#666'}" title="Click to toggle Active / Inactive">${isActive ? 'Active' : 'Inactive'}</button></td>
        <td>
          <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
            ${i.is_student_batch ? `<button class="btn btn-xs btn-practical" data-id="${i.id}" data-name="${_esc(i.medicine.name)}" data-stock="${i.stock_quantity||0}" data-expiry="${i.expiry_date||''}" data-batch="${_esc(i.batch_number||'')}" style="background:#fff8e1;color:#7a4000;border:1px solid #e8c068;white-space:nowrap">🎓 Practical Use</button>` : ''}
            <button class="btn btn-ghost btn-xs btn-adj" data-id="${i.id}" data-name="${_esc(i.medicine.name)}">±</button>
            <button class="btn btn-secondary btn-xs btn-edit" data-id="${i.id}">Edit</button>
            <button class="btn btn-xs btn-del" data-id="${i.id}" data-name="${_esc(i.medicine.name)}" style="background:var(--error-bg);color:var(--error-text);border:1px solid var(--error-border)">Del</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', () => openEdit(btn.dataset.id)));
  tbody.querySelectorAll('.btn-adj').forEach(btn => btn.addEventListener('click', () => openAdjust(btn.dataset.id, btn.dataset.name)));
  tbody.querySelectorAll('.btn-del').forEach(btn => btn.addEventListener('click', () => deleteMedicine(btn.dataset.id, btn.dataset.name)));
  tbody.querySelectorAll('.btn-practical').forEach(btn => btn.addEventListener('click', () =>
    markPracticalUse(btn.dataset.id, btn.dataset.name, parseInt(btn.dataset.stock)||0, btn.dataset.expiry, btn.dataset.batch)
  ));

  tbody.querySelectorAll('.btn-status-toggle').forEach(btn =>
    btn.addEventListener('click', () => toggleStatus(btn.dataset.medId, btn.dataset.active === 'true'))
  );

  // Re-attach row checkbox listeners after each render
  tbody.querySelectorAll('.row-chk').forEach(chk => {
    if (_selectedIds.has(chk.dataset.id)) chk.checked = true;
    chk.addEventListener('change', () => {
      chk.checked ? _selectedIds.add(chk.dataset.id) : _selectedIds.delete(chk.dataset.id);
      _updateBulkBar();
    });
  });
  _updateBulkBar();
}

function _fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y.slice(2)}`;
}

// ── Filters ─────────────────────────────────────────
['search','filter-cat','filter-stock','filter-status'].forEach(id =>
  document.getElementById(id).addEventListener(id === 'search' ? 'input' : 'change', renderTable)
);

// ── CSV Export ──────────────────────────────────────
document.getElementById('btn-export-csv').addEventListener('click', () => {
  const filterSts = document.getElementById('filter-status').value;
  const rows = _items.filter(i => {
    if (filterSts === 'active') return i.medicine.is_active !== false;
    if (filterSts === 'inactive') return i.medicine.is_active === false;
    return true;
  });

  const header = ['Med ID','Name','Category','Brand','Unit','Barcode','Stock','BP(₹)','GST%','TA(₹)','MRP(₹)','P%','PA(₹)','CP(₹)','Inward','Expiry','Batch','Reorder(Low)','Max','Supplier','Status','Indications'];
  const csvRows = [header, ...rows.map(i => {
    const mrp = Number(i.mrp || 0), gst = Number(i.gst_percent || 0), pct = Number(i.profit_percent || 0);
    const bp = mrp / (1 + gst/100), ta = mrp - bp, pa = mrp * pct / 100, cp = mrp - pa;
    const inds = Array.isArray(i.medicine.indications) ? i.medicine.indications.join(' | ') : '';
    return [
      i.medicine.med_id || '',
      `"${i.medicine.name}"`,
      CAT_LABELS[i.medicine.category] || '',
      `"${i.medicine.brand || ''}"`,
      `"${i.medicine.unit || ''}"`,
      i.medicine.barcode || '',
      i.stock_quantity ?? 0,
      bp.toFixed(2), `${gst}%`, ta.toFixed(2), mrp.toFixed(2),
      `${pct}%`, pa.toFixed(2), cp.toFixed(2),
      i.inward_date || '', i.expiry_date || '',
      `"${i.batch_number || ''}"`,
      i.reorder_level ?? 0, i.max_stock ?? 0,
      `"${i.supplier_name || ''}"`,
      i.medicine.is_active !== false ? 'Active' : 'Inactive',
      `"${inds}"`,
    ];
  })];

  const csv  = csvRows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `inventory_${TODAY}.csv`; a.click();
  URL.revokeObjectURL(url);
  _alert('success', 'CSV exported.');
});

// ── Tag input ────────────────────────────────────────
const tagInput  = document.getElementById('tag-input');
const tagAddBtn = document.getElementById('tag-add-btn');
const tagsArea  = document.getElementById('tags-area');
const tagCount  = document.getElementById('tag-count');

const namcSugg = document.getElementById('namc-suggestions');
let _namcTimer = null;

tagInput.addEventListener('input', () => {
  const q = tagInput.value.trim();
  tagAddBtn.disabled = !q || _tags.length >= 10;
  clearTimeout(_namcTimer);
  if (q.length < 2) { hideSugg(); return; }
  _namcTimer = setTimeout(() => searchNamc(q), 280);
});
tagInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addTag(); hideSugg(); }
  if (e.key === 'Escape') hideSugg();
});
tagAddBtn.addEventListener('click', () => { addTag(); hideSugg(); });

// Common Indian-English → IAST transliteration fixes
function _namcNorm(q) {
  return q
    .replace(/jw/gi,  'jv')   // jwara → jvara
    .replace(/shw/gi, 'sv')   // shwasa → svasa
    .replace(/sh/gi,  'S')    // shiro → Siro
    .replace(/th/gi,  'T')    // tritha → triTa
    .replace(/aa/gi,  'A')    // kapha→ same, but raasa → rAsa
    .replace(/ee/gi,  'I')    // arshee → arSI
    .replace(/oo/gi,  'U');   // dosha → same
}

async function searchNamc(q) {
  const norm = _namcNorm(q);
  // Build OR across both original and transliteration-normalised query
  const terms = [...new Set([q, norm])];
  const orParts = terms.flatMap(t => [
    `namc_term.ilike.%${t}%`,
    `name_english.ilike.%${t}%`,
    `name_english_index.ilike.%${t}%`
  ]).join(',');

  const { data, error } = await supabase
    .from('namaste_codes')
    .select('namc_code, namc_term, name_english, name_english_index')
    .or(orParts)
    .limit(10);
  if (error) { console.error('NAMC search error:', error); hideSugg(); return; }
  if (!data?.length) { hideSugg(); return; }

  namcSugg.innerHTML = data.map(r => {
    const eng = (r.name_english_index || r.name_english || '').split('/')[0].split('(')[0].split('⇒')[0].trim();
    const label = eng || r.namc_term;
    return `<div class="namc-sugg-item" data-code="${_esc(r.namc_code)}" data-label="${_esc(label)}">
      <span class="namc-sugg-code">${_esc(r.namc_code)}</span>
      <span class="namc-sugg-term">${_esc(label)} <span style="color:var(--text-muted);font-size:10px;font-style:italic">${_esc(r.namc_term)}</span></span>
    </div>`;
  }).join('');
  namcSugg.style.display = 'block';
}

namcSugg.addEventListener('mousedown', e => {
  const item = e.target.closest('.namc-sugg-item');
  if (!item) return;
  e.preventDefault();
  const code = item.dataset.code;
  const label = item.dataset.label;
  if (_tags.length >= 10 || _tags.includes(code)) { tagInput.value = ''; hideSugg(); return; }
  _tags.push(code);
  _namcLabels[code] = label;
  tagInput.value = '';
  tagAddBtn.disabled = true;
  hideSugg();
  renderTags();
});

function hideSugg() { namcSugg.style.display = 'none'; namcSugg.innerHTML = ''; }
document.addEventListener('click', e => { if (!e.target.closest('.tag-input-wrap')) hideSugg(); });

function addTag() {
  const val = tagInput.value.trim();
  if (!val || _tags.length >= 10) return;
  if (_tags.map(t => t.toLowerCase()).includes(val.toLowerCase())) { tagInput.value = ''; return; }
  _tags.push(val);
  tagInput.value = '';
  tagAddBtn.disabled = true;
  renderTags();
}
function removeTag(idx) {
  _tags.splice(idx, 1);
  renderTags();
  tagAddBtn.disabled = !tagInput.value.trim() || _tags.length >= 10;
}
function renderTags() {
  tagsArea.innerHTML = _tags.map((t, i) => {
    const label = _namcLabels[t] || t;
    return `<span class="tag-chip" title="${_esc(t)}">${_esc(label)}<button data-onclick="_removeTag" data-onclick-a0="${i}" title="Remove">×</button></span>`;
  }).join('');
  tagCount.textContent = `${_tags.length} / 10 indications`;
  tagInput.placeholder = _tags.length >= 10 ? 'Maximum 10 reached' : 'Search NAMC disease / indication…';
  tagInput.disabled = _tags.length >= 10;
}
window._removeTag = removeTag;

// ── Image upload ─────────────────────────────────────
document.getElementById('f-image').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { _alert('error', 'Image must be under 2 MB.'); return; }

  _imgUploading = true;
  const ext = file.name.split('.').pop().toLowerCase();
  const path = `${tenantId}/${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage
    .from('medicine-images').upload(path, file, { upsert: true });

  _imgUploading = false;
  if (error) { _alert('error', 'Image upload failed: ' + error.message); return; }

  const { data: { publicUrl } } = supabase.storage.from('medicine-images').getPublicUrl(data.path);
  document.getElementById('edit-image-url').value = publicUrl;
  document.getElementById('img-preview').src = publicUrl;
  document.getElementById('img-preview').style.display = 'block';
  document.getElementById('img-placeholder').style.display = 'none';
});

// ── Slide panel ──────────────────────────────────────
document.getElementById('btn-add-med').addEventListener('click', () => openPanel(null));

function openPanel(invId) {
  const isEdit = !!invId;
  document.getElementById('panel-title').textContent = isEdit ? 'Edit Medicine' : 'Add Medicine';
  document.getElementById('opening-stock-section').style.display = isEdit ? 'none' : '';
  document.getElementById('med-id-display').style.display = isEdit ? '' : 'none';

  // Reset image
  document.getElementById('edit-image-url').value = '';
  document.getElementById('img-preview').style.display = 'none';
  document.getElementById('img-placeholder').style.display = '';
  document.getElementById('f-image').value = '';

  _tags = [];

  if (isEdit) {
    const item = _items.find(i => i.id === invId);
    if (!item) return;
    document.getElementById('edit-inv-id').value  = item.id;
    document.getElementById('edit-med-id').value  = item.medicine.id;
    document.getElementById('f-med-id').value     = item.medicine.med_id || '';
    document.getElementById('f-name').value       = item.medicine.name;
    document.getElementById('f-cat').value        = item.medicine.category || '';
    document.getElementById('f-brand').value      = item.medicine.brand || '';
    document.getElementById('f-unit').value       = item.medicine.unit || '';
    document.getElementById('f-barcode').value    = item.medicine.barcode || '';
    document.getElementById('f-active').value     = String(item.medicine.is_active !== false);
    document.getElementById('f-mrp').value        = item.mrp || '';
    document.getElementById('f-gst').value        = item.gst_percent ?? 0;
    document.getElementById('f-profit').value     = item.profit_percent || '';
    document.getElementById('f-reorder').value     = item.reorder_level ?? '';
    document.getElementById('f-reorder').dataset.manuallySet = item.reorder_level ? '1' : '';
    document.getElementById('f-max').value         = item.max_stock ?? '';
    document.getElementById('f-inward').value     = item.inward_date || '';
    document.getElementById('f-expiry').value     = item.expiry_date || '';
    document.getElementById('f-batch').value      = item.batch_number || '';
    document.getElementById('f-supplier').value   = item.supplier_name || '';
    document.getElementById('f-is-gmp').checked          = item.is_gmp_certified  || false;
    document.getElementById('f-gmp-cert-no').value        = item.gmp_certificate_no || '';
    document.getElementById('f-is-student-batch').checked = item.is_student_batch  || false;
    document.getElementById('f-is-high-risk').checked     = item.is_high_risk      || false;
    document.getElementById('f-is-lasa').checked          = item.is_lasa           || false;
    document.getElementById('f-lasa-pair').value          = item.lasa_pair         || '';
    document.getElementById('f-is-schedule-h').checked    = item.is_schedule_h     || false;
    _tags = Array.isArray(item.medicine.indications) ? [...item.medicine.indications] : [];
    document.getElementById('f-anupana').value       = item.medicine.anupana || '';
    document.getElementById('f-classical-ref').value = item.medicine.classical_reference || '';
    document.getElementById('f-dosage').value        = item.medicine.dosage_text || '';
    if (item.medicine.image_url) {
      document.getElementById('edit-image-url').value = item.medicine.image_url;
      document.getElementById('img-preview').src = item.medicine.image_url;
      document.getElementById('img-preview').style.display = 'block';
      document.getElementById('img-placeholder').style.display = 'none';
    }
  } else {
    document.getElementById('edit-inv-id').value = '';
    document.getElementById('edit-med-id').value = '';
    ['f-name','f-brand','f-unit','f-barcode','f-mrp','f-profit','f-supplier','f-batch','f-anupana','f-classical-ref','f-dosage'].forEach(id =>
      document.getElementById(id).value = '');
    document.getElementById('f-stock').value  = '';
    document.getElementById('f-cat').value    = '';
    document.getElementById('f-active').value = 'true';
    document.getElementById('f-gst').value    = '0';
    document.getElementById('f-reorder').value = '';
    document.getElementById('f-reorder').dataset.manuallySet = '';
    document.getElementById('f-max').value    = '';
    document.getElementById('f-inward').value = TODAY;
    document.getElementById('f-expiry').value = '';
    document.getElementById('f-is-gmp').checked          = false;
    document.getElementById('f-gmp-cert-no').value        = '';
    document.getElementById('f-is-student-batch').checked = false;
  }
  renderTags();
  window._calcPricing();
  document.getElementById('overlay').classList.add('open');
  document.getElementById('slide-panel').classList.add('open');
}

function closePanel() {
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('slide-panel').classList.remove('open');
}

document.getElementById('overlay').addEventListener('click', closePanel);
document.getElementById('btn-close-panel').addEventListener('click', closePanel);
document.getElementById('btn-cancel-panel').addEventListener('click', closePanel);
function openEdit(invId) { openPanel(invId); }

// ── Save medicine ────────────────────────────────────
document.getElementById('btn-save-med').addEventListener('click', async () => {
  const name    = document.getElementById('f-name').value.trim();
  const mrp     = parseFloat(document.getElementById('f-mrp').value) || 0;
  if (!name)    { _alert('error', 'Medicine name is required.'); return; }
  if (mrp <= 0) { _alert('error', 'MRP must be greater than 0.'); return; }
  if (_imgUploading) { _alert('warning', 'Image upload in progress — please wait.'); return; }

  const invId       = document.getElementById('edit-inv-id').value;
  const medId       = document.getElementById('edit-med-id').value;
  const cat         = document.getElementById('f-cat').value || null;
  const anupana     = document.getElementById('f-anupana').value.trim() || null;
  const classicalRef= document.getElementById('f-classical-ref').value.trim() || null;
  const dosageText  = document.getElementById('f-dosage').value.trim() || null;
  const brand    = document.getElementById('f-brand').value.trim() || null;
  const unit     = document.getElementById('f-unit').value.trim() || null;
  const barcode  = document.getElementById('f-barcode').value.trim() || null;
  const active   = document.getElementById('f-active').value === 'true';
  const gstPct   = parseFloat(document.getElementById('f-gst').value) || 0;
  const profPct  = parseFloat(document.getElementById('f-profit').value) || 0;
  const maxStock = parseInt(document.getElementById('f-max').value) || 0;
  const reorder  = parseInt(document.getElementById('f-reorder').value) || 0;
  const cp       = mrp - (mrp * profPct / 100);
  const inward   = document.getElementById('f-inward').value || null;
  const expiry   = document.getElementById('f-expiry').value || null;
  const batch    = document.getElementById('f-batch').value.trim() || null;
  const supplier = document.getElementById('f-supplier').value.trim() || null;
  const isGmp        = document.getElementById('f-is-gmp').checked;
  const gmpCert      = document.getElementById('f-gmp-cert-no').value.trim() || null;
  const isStudentBatch = document.getElementById('f-is-student-batch').checked;
  const medType      = document.getElementById('f-med-type')?.value || 'finished';
  const isHighRisk   = document.getElementById('f-is-high-risk').checked;
  const isLasa       = document.getElementById('f-is-lasa').checked;
  const lasaPair     = document.getElementById('f-lasa-pair').value.trim() || null;
  const isScheduleH  = document.getElementById('f-is-schedule-h').checked;
  const imageUrl = document.getElementById('edit-image-url').value || null;
  const stock    = parseInt(document.getElementById('f-stock')?.value) || 0;

  const btn = document.getElementById('btn-save-med');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    if (invId && medId) {
      const { error: me } = await supabase.from('medicines')
        .update({ name, category: cat, brand, unit, is_active: active,
                  indications: _tags, barcode, image_url: imageUrl,
                  anupana, classical_reference: classicalRef, dosage_text: dosageText })
        .eq('id', medId);
      if (me) throw me;
      const { error: ie } = await supabase.from('inventory')
        .update({ mrp, cost_price: cp, gst_percent: gstPct, profit_percent: profPct,
                  reorder_level: reorder, max_stock: maxStock,
                  inward_date: inward, expiry_date: expiry, batch_number: batch, supplier_name: supplier,
                  is_gmp_certified: isGmp, gmp_certificate_no: gmpCert,
                  is_student_batch: isStudentBatch, medicine_type: medType,
                  is_high_risk: isHighRisk, is_lasa: isLasa, lasa_pair: lasaPair, is_schedule_h: isScheduleH })
        .eq('id', invId).eq('tenant_id', tenantId);
      if (ie) throw ie;
      _alert('success', `"${name}" updated.`);
    } else {
      const exists = _items.find(i => i.medicine.name.toLowerCase() === name.toLowerCase());
      if (exists) { _alert('error', `"${name}" already exists.`); btn.disabled = false; btn.textContent = 'Save Medicine'; return; }
      const { data: med, error: me } = await supabase.from('medicines')
        .insert({ name, category: cat, brand, unit, is_active: active,
                  indications: _tags, barcode, image_url: imageUrl,
                  anupana, classical_reference: classicalRef, dosage_text: dosageText })
        .select('id').single();
      if (me) throw me;
      const { error: ie } = await supabase.from('inventory').insert({
        tenant_id: tenantId, medicine_id: med.id,
        stock_quantity: stock, mrp, cost_price: cp, gst_percent: gstPct,
        profit_percent: profPct, reorder_level: reorder, max_stock: maxStock,
        inward_date: inward, expiry_date: expiry, batch_number: batch, supplier_name: supplier,
        is_gmp_certified: isGmp, gmp_certificate_no: gmpCert,
        is_student_batch: isStudentBatch, medicine_type: medType,
        is_high_risk: isHighRisk, is_lasa: isLasa, lasa_pair: lasaPair, is_schedule_h: isScheduleH
      });
      if (ie) throw ie;
      _alert('success', `"${name}" added to inventory.`);
    }
    closePanel();
    await loadInventory();
  } catch (err) {
    _alert('error', 'Save failed: ' + (err.message || err.details || 'Please try again.'));
  }
  btn.disabled = false; btn.textContent = 'Save Medicine';
});

// ── Adjust stock modal ────────────────────────────────
window.onAdjReasonChange = function(val) {
  document.getElementById('disposal-fields').style.display = val === 'expired' ? '' : 'none';
};

function openAdjust(invId, name) {
  document.getElementById('adj-modal-title').textContent       = `Adjust Stock — ${name}`;
  document.getElementById('adj-inv-id').value                  = invId;
  document.getElementById('adj-qty').value                     = '';
  document.getElementById('adj-reason').value                  = '';
  document.getElementById('disposal-fields').style.display     = 'none';
  document.getElementById('adj-disposal-method').value         = '';
  document.getElementById('adj-disposal-date').value           = new Date().toISOString().split('T')[0];
  document.getElementById('adj-witnessed-by').value            = '';
  document.getElementById('adj-disposal-remarks').value        = '';
  _adjType = 'add';
  document.getElementById('adj-add').classList.add('selected');
  document.getElementById('adj-remove').classList.remove('selected');
  document.getElementById('adj-modal').classList.add('open');
}
document.getElementById('adj-add').addEventListener('click', () => {
  _adjType = 'add';
  document.getElementById('adj-add').classList.add('selected');
  document.getElementById('adj-remove').classList.remove('selected');
});
document.getElementById('adj-remove').addEventListener('click', () => {
  _adjType = 'remove';
  document.getElementById('adj-remove').classList.add('selected');
  document.getElementById('adj-add').classList.remove('selected');
});
document.getElementById('btn-adj-cancel').addEventListener('click', () =>
  document.getElementById('adj-modal').classList.remove('open')
);
document.getElementById('btn-adj-confirm').addEventListener('click', async () => {
  const qty    = parseInt(document.getElementById('adj-qty').value);
  const invId  = document.getElementById('adj-inv-id').value;
  const reason = document.getElementById('adj-reason').value;
  if (!qty || qty <= 0)  { _alert('error', 'Enter a valid quantity.'); return; }
  if (!reason)           { _alert('error', 'Please select a reason.'); return; }

  const isExpiry = reason === 'expired';
  if (isExpiry) {
    const method    = document.getElementById('adj-disposal-method').value;
    const witnessed = document.getElementById('adj-witnessed-by').value.trim();
    if (!method)    { _alert('error', 'Select a disposal method.'); return; }
    if (!witnessed) { _alert('error', 'Enter the name of the witness / supervisor.'); return; }
  }

  const item   = _items.find(i => i.id === invId);
  if (!item) return;
  const newQty = _adjType === 'add'
    ? (item.stock_quantity ?? 0) + qty
    : Math.max(0, (item.stock_quantity ?? 0) - qty);

  const btn = document.getElementById('btn-adj-confirm');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await supabase.from('inventory')
    .update({ stock_quantity: newQty }).eq('id', invId).eq('tenant_id', tenantId);
  if (error) { btn.disabled = false; btn.textContent = 'Confirm'; _alert('error', 'Failed: ' + error.message); return; }

  // If expired, log disposal record
  if (isExpiry) {
    await supabase.from('disposal_records').insert({
      tenant_id:       tenantId,
      inventory_id:    invId,
      medicine_name:   item.medicine?.name  || '—',
      batch_number:    item.batch_number    || null,
      quantity:        qty,
      expiry_date:     item.expiry_date     || null,
      disposal_method: document.getElementById('adj-disposal-method').value,
      disposed_by:     profile?.id          || null,
      witnessed_by:    document.getElementById('adj-witnessed-by').value.trim(),
      disposal_date:   document.getElementById('adj-disposal-date').value,
      remarks:         document.getElementById('adj-disposal-remarks').value.trim() || null,
    });
  }

  btn.disabled = false; btn.textContent = 'Confirm';
  document.getElementById('adj-modal').classList.remove('open');
  _alert('success', isExpiry
    ? `${qty} units logged for disposal. Stock updated to ${newQty}.`
    : `Stock updated to ${newQty} units.`);
  await loadInventory();
});

// ── Delete medicine from inventory ───────────────────
// ── Mark student batch as used in practical ──────────
async function markPracticalUse(invId, name, currentStock, expiryDate, batchNumber) {
  if (currentStock <= 0) {
    _alert('error', `"${name}" has no stock remaining to log.`);
    return;
  }

  const qtyStr = prompt(
    `Mark "${name}" as used in practical session.\n\nCurrent stock: ${currentStock} units\n\nEnter quantity used (leave blank to use all ${currentStock} units):`,
    currentStock
  );
  if (qtyStr === null) return; // cancelled

  const qty = parseInt(qtyStr) || currentStock;
  if (qty <= 0 || qty > currentStock) {
    _alert('error', `Enter a quantity between 1 and ${currentStock}.`);
    return;
  }

  const witness = prompt('Witnessed by (faculty/supervisor name):');
  if (witness === null) return; // cancelled
  if (!witness.trim()) { _alert('error', 'Witness name is required for practical use record.'); return; }

  // Create disposal record
  const { error: drErr } = await supabase.from('disposal_records').insert({
    tenant_id:       tenantId,
    inventory_id:    invId,
    medicine_name:   name,
    batch_number:    batchNumber || null,
    quantity:        qty,
    expiry_date:     expiryDate  || null,
    disposal_method: 'student_practical',
    disposed_by:     profile?.id || null,
    witnessed_by:    witness.trim(),
    disposal_date:   new Date().toISOString().split('T')[0],
    remarks:         'Student-prepared batch consumed in pharmacy practical session (NCISM §6(3))',
  });
  if (drErr) { _alert('error', 'Failed to log disposal: ' + drErr.message); return; }

  // Deduct stock
  const newStock = currentStock - qty;
  const { error: invErr } = await supabase.from('inventory')
    .update({ stock_quantity: newStock }).eq('id', invId).eq('tenant_id', tenantId);
  if (invErr) { _alert('error', 'Stock update failed: ' + invErr.message); return; }

  _alert('success', `${qty} units of "${name}" logged as used in practical. Disposal record created.`);
  await loadInventory();
}

async function deleteMedicine(invId, name) {
  if (!confirm(`Remove "${name}" from inventory?\n\nThis deletes the stock record for your dispensary. The medicine name stays in the catalogue.`)) return;
  const { error } = await supabase.from('inventory')
    .delete().eq('id', invId).eq('tenant_id', tenantId);
  if (error) { _alert('error', 'Delete failed: ' + error.message); return; }
  _selectedIds.delete(invId);
  _alert('success', `"${name}" removed from inventory.`);
  await loadInventory();
}

// ── Toggle active / inactive directly in row ─────────
async function toggleStatus(medId, isActive) {
  const { error } = await supabase.from('medicines')
    .update({ is_active: !isActive }).eq('id', medId);
  if (error) { _alert('error', 'Status update failed: ' + error.message); return; }
  if (isActive) {
    // Switching to Inactive — auto-show All so row stays visible
    document.getElementById('filter-status').value = '';
    _alert('warning', 'Marked Inactive — filter switched to All so you can still see it.');
  } else {
    _alert('success', 'Marked Active.');
  }
  await loadInventory();
}

// ── Bulk delete ───────────────────────────────────────
const _selectedIds = new Set();

function _updateBulkBar() {
  const n   = _selectedIds.size;
  const btn = document.getElementById('btn-bulk-del');
  document.getElementById('bulk-count').textContent = n;
  btn.style.display = n > 0 ? '' : 'none';
  const chkAll = document.getElementById('chk-all');
  if (chkAll) {
    const visible = document.querySelectorAll('.row-chk').length;
    chkAll.indeterminate = n > 0 && n < visible;
    chkAll.checked = visible > 0 && n >= visible;
  }
}

document.getElementById('chk-all').addEventListener('change', function() {
  document.querySelectorAll('.row-chk').forEach(chk => {
    chk.checked = this.checked;
    this.checked ? _selectedIds.add(chk.dataset.id) : _selectedIds.delete(chk.dataset.id);
  });
  _updateBulkBar();
});

document.getElementById('btn-bulk-del').addEventListener('click', async () => {
  const ids = [..._selectedIds];
  if (!ids.length) return;
  if (!confirm(`Remove ${ids.length} medicine(s) from inventory?\n\nStock records will be deleted. Medicine names stay in the catalogue.`)) return;
  const { error } = await supabase.from('inventory')
    .delete().in('id', ids).eq('tenant_id', tenantId);
  if (error) { _alert('error', 'Bulk delete failed: ' + error.message); return; }
  _selectedIds.clear();
  _alert('success', `${ids.length} medicine(s) removed from inventory.`);
  await loadInventory();
});

function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = `alert show ${type}`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type !== 'error') setTimeout(() => el.className = 'alert', 4000);
}

// ── CSV Import ────────────────────────────────────────
let _importRows = [];  // parsed rows ready to import

function _closeImport() {
  document.getElementById('import-modal').classList.remove('open');
  document.getElementById('import-file').value = '';
  _importRows = [];
  document.getElementById('import-summary').className = 'import-summary';
  document.getElementById('import-err').className = 'import-err';
  document.getElementById('import-preview').style.display = 'none';
  document.getElementById('import-preview').innerHTML = '';
  document.getElementById('btn-do-import').disabled = true;
  document.getElementById('btn-do-import').textContent = 'Import';
  document.getElementById('btn-cancel-import').disabled = false;
  document.getElementById('import-prog-wrap').classList.remove('show');
  document.getElementById('import-prog-fill').style.width = '0%';
  document.getElementById('import-prog-text').textContent = 'Preparing…';
}

document.getElementById('btn-import-csv').addEventListener('click', () => {
  _closeImport();
  document.getElementById('import-modal').classList.add('open');
});
document.getElementById('btn-close-import').addEventListener('click', _closeImport);
document.getElementById('btn-cancel-import').addEventListener('click', _closeImport);

// Drag-over visual
const dropEl = document.getElementById('import-drop');
dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('drag-over'); });
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag-over'));
dropEl.addEventListener('drop', e => {
  e.preventDefault(); dropEl.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) _parseImportFile(file);
});
document.getElementById('import-file').addEventListener('change', e => {
  if (e.target.files[0]) _parseImportFile(e.target.files[0]);
});

// Download blank template
document.getElementById('btn-dl-template').addEventListener('click', e => {
  e.preventDefault();
  const header = 'Med ID,Name,Category,Brand,Unit,Barcode,Stock,MRP(₹),GST%,P%,Inward,Expiry,Batch,Reorder(Low),Max,Supplier,Status,Indications';
  const example = ',"Ashwagandha Capsule",tablet,"Himalaya","60 Nos",,100,150,5,20,2024-01-01,2026-12-31,BT20240101,20,100,"AVS",Active,"Stress | Immunity"';
  const blob = new Blob([header + '\n' + example], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'inventory_template.csv'; a.click();
});

function _parseCSVLine(line) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

function _parseDate(s) {
  if (!s) return null;
  s = s.trim().replace(/\s+/g, '');
  if (!s) return null;
  // YYYY-MM-DD or YYYY/MM/DD
  if (/^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(s)) return s.replace(/\//g, '-');
  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (Indian formats)
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return null;
}

async function _parseImportFile(file) {
  const errEl = document.getElementById('import-err');
  const sumEl = document.getElementById('import-summary');
  errEl.className = 'import-err'; sumEl.className = 'import-summary';
  document.getElementById('import-preview').style.display = 'none';
  document.getElementById('btn-do-import').disabled = true;
  _importRows = [];

  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { errEl.textContent = 'CSV has no data rows.'; errEl.className = 'import-err show'; return; }

  const headers = _parseCSVLine(lines[0]).map(h => h.replace(/[₹()\s]/g,'').toLowerCase());

  // Column index helpers
  const ci = name => headers.findIndex(h => h.includes(name));
  const iMedId    = ci('medid');
  const iName     = ci('name');
  const iCat      = ci('category');
  const iBrand    = ci('brand');
  const iUnit     = ci('unit');
  const iBarcode  = ci('barcode');
  const iStock    = ci('stock');
  const iMrp      = headers.findIndex(h => h === 'mrp' || h === 'mrp');
  const iGst      = ci('gst');
  const iProfit   = ci('p%') >= 0 ? ci('p%') : headers.findIndex(h => h === 'p');
  const iInward   = ci('inward');
  const iExpiry   = ci('expiry');
  const iBatch    = ci('batch');
  const iReorder  = ci('reorder') >= 0 ? ci('reorder') : ci('low');
  const iMax      = ci('max');
  const iSupplier = ci('supplier');
  const iStatus   = ci('status');
  const iInds     = ci('indication');

  if (iName < 0) {
    errEl.textContent = 'CSV must have a "Name" column.';
    errEl.className = 'import-err show'; return;
  }

  // Build lookup maps from current loaded inventory
  const byMedId = {};
  const byName  = {};
  _items.forEach(i => {
    if (i.medicine.med_id) byMedId[i.medicine.med_id.toUpperCase()] = i;
    byName[i.medicine.name.toLowerCase().trim()] = i;
  });

  let countNew = 0, countUpdate = 0, countSkip = 0;
  const preview = [];

  for (let r = 1; r < lines.length; r++) {
    const cols = _parseCSVLine(lines[r]);
    const rawName = iName >= 0 ? (cols[iName] || '').trim() : '';
    if (!rawName) { countSkip++; continue; }

    const rawMedId  = iMedId >= 0  ? (cols[iMedId]  || '').trim().toUpperCase() : '';
    const mrpRaw    = iMrp >= 0    ? parseFloat(cols[iMrp]   || 0) : 0;
    const gstRaw    = iGst >= 0    ? parseFloat((cols[iGst]  || '0').replace('%','')) : 0;
    const profRaw   = iProfit >= 0 ? parseFloat((cols[iProfit]|| '0').replace('%','')) : 0;
    const stockRaw  = iStock >= 0  ? parseInt(cols[iStock]  || 0) : 0;
    const maxRaw    = iMax >= 0    ? parseInt(cols[iMax]    || 0) : 0;
    const reorderRaw= iReorder >= 0? parseInt(cols[iReorder]|| 0) : 0;
    const statusRaw = iStatus >= 0 ? (cols[iStatus]||'Active').trim().toLowerCase() : 'active';
    const indsRaw   = iInds >= 0   ? (cols[iInds]  ||'').split('|').map(s=>s.trim()).filter(Boolean) : [];
    const batchRaw  = iBatch >= 0  ? (cols[iBatch] ||'').trim() : '';

    // Match existing record
    let existing = null;
    if (rawMedId && byMedId[rawMedId]) existing = byMedId[rawMedId];
    else if (byName[rawName.toLowerCase()]) existing = byName[rawName.toLowerCase()];

    const action = existing ? 'update' : 'new';
    if (action === 'new') countNew++; else countUpdate++;

    const TODAY_ISO = new Date().toISOString().slice(0, 10);
    const parsedInward = _parseDate(iInward >= 0 ? cols[iInward] : '');
    const autoReorder  = (reorderRaw === 0 && maxRaw > 0) ? Math.floor(maxRaw / 2) : reorderRaw;

    _importRows.push({
      action, existing,
      name: rawName,
      category: iCat >= 0 ? (cols[iCat]||'').trim().toLowerCase() || null : null,
      brand: iBrand >= 0 ? (cols[iBrand]||'').trim() || null : null,
      unit: iUnit >= 0 ? (cols[iUnit]||'').trim() || null : null,
      barcode: iBarcode >= 0 ? (cols[iBarcode]||'').trim() || null : null,
      is_active: statusRaw !== 'inactive',
      indications: indsRaw,
      mrp: mrpRaw, gst_percent: gstRaw, profit_percent: profRaw,
      cost_price: mrpRaw - (mrpRaw * profRaw / 100),
      stock_quantity: stockRaw, max_stock: maxRaw, reorder_level: autoReorder,
      inward_date: parsedInward || TODAY_ISO,
      expiry_date: _parseDate(iExpiry >= 0 ? cols[iExpiry] : ''),
      batch_number: batchRaw || null,
      supplier_name: iSupplier >= 0 ? (cols[iSupplier]||'').trim() || null : null,
    });

    if (preview.length < 10) preview.push({ action, name: rawName, mrp: mrpRaw, stock: stockRaw, batch: batchRaw });
  }

  if (!_importRows.length) {
    errEl.textContent = 'No valid rows found in CSV.'; errEl.className = 'import-err show'; return;
  }

  sumEl.innerHTML = `Ready to import <strong>${_importRows.length}</strong> rows — <span class="badge-new">${countNew} new</span> &nbsp;<span class="badge-update">${countUpdate} update</span>${countSkip ? ` · ${countSkip} blank rows skipped` : ''}`;
  sumEl.className = 'import-summary show';

  // Preview table
  const prevEl = document.getElementById('import-preview');
  prevEl.style.display = 'block';
  prevEl.innerHTML = `<table>
    <thead><tr><th>Action</th><th>Name</th><th>MRP (₹)</th><th>Stock</th><th>Batch</th></tr></thead>
    <tbody>${preview.map(p => `
      <tr class="row-${p.action}">
        <td><span class="badge-${p.action}">${p.action === 'new' ? 'NEW' : 'UPDATE'}</span></td>
        <td>${_esc(p.name)}</td><td>${_esc(p.mrp)}</td><td>${_esc(p.stock)}</td><td>${_esc(p.batch) || '—'}</td>
      </tr>`).join('')}
    ${_importRows.length > 10 ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);font-style:italic">…and ${_importRows.length - 10} more rows</td></tr>` : ''}
    </tbody></table>`;

  document.getElementById('btn-do-import').disabled = false;
}

document.getElementById('btn-do-import').addEventListener('click', async () => {
  if (!_importRows.length) return;
  const replaceStock = document.getElementById('import-replace-stock').checked;

  const btn       = document.getElementById('btn-do-import');
  const cancelBtn = document.getElementById('btn-cancel-import');
  const progWrap  = document.getElementById('import-prog-wrap');
  const progFill  = document.getElementById('import-prog-fill');
  const progText  = document.getElementById('import-prog-text');

  btn.disabled = true; btn.textContent = 'Importing…';
  cancelBtn.disabled = true;
  progWrap.classList.add('show');

  const total   = _importRows.length;
  let done = 0, added = 0, updated = 0, skipped = 0, errors = 0;

  function _setProgress(label) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progFill.style.width = pct + '%';
    progText.textContent = label || `Processing ${done} / ${total}…`;
  }
  _setProgress('Starting…');

  // ── Separate new vs update ──
  const newRows    = _importRows.filter(r => r.action === 'new');
  const updateRows = _importRows.filter(r => r.action === 'update');

  const CHUNK = 50;  // batch size

  // ── 1. Batch-insert new medicines ──────────────────
  if (newRows.length > 0) {
    for (let i = 0; i < newRows.length; i += CHUNK) {
      const chunk = newRows.slice(i, i + CHUNK);
      const medPayload = chunk.map(r => ({
        name: r.name, category: r.category, brand: r.brand,
        unit: r.unit, barcode: r.barcode, is_active: r.is_active,
        indications: r.indications,
      }));

      const { data: meds, error: me } = await supabase
        .from('medicines').insert(medPayload).select('id, name');

      if (me) {
        console.error('Batch medicine insert error:', me);
        errors += chunk.length;
        done   += chunk.length;
        _setProgress(`Inserting medicines… ${done}/${total}`);
        continue;
      }

      // Map name → id (case-insensitive)
      const nameToId = {};
      (meds || []).forEach(m => { nameToId[m.name.toLowerCase()] = m.id; });

      const invPayload = chunk.map(r => {
        const medId = nameToId[r.name.toLowerCase()];
        if (!medId) { errors++; return null; }
        return {
          tenant_id: tenantId, medicine_id: medId,
          stock_quantity: r.stock_quantity,
          mrp: r.mrp, cost_price: r.cost_price,
          gst_percent: r.gst_percent, profit_percent: r.profit_percent,
          max_stock: r.max_stock, reorder_level: r.reorder_level,
          inward_date: r.inward_date, expiry_date: r.expiry_date,
          batch_number: r.batch_number, supplier_name: r.supplier_name,
        };
      }).filter(Boolean);

      if (invPayload.length) {
        const { error: ie } = await supabase.from('inventory').insert(invPayload);
        if (ie) { console.error('Batch inventory insert error:', ie); errors += invPayload.length; }
        else    added += invPayload.length;
      }

      done += chunk.length;
      _setProgress(`Adding new medicines… ${done}/${total}`);
    }
  }

  // ── 2. Update existing medicines — 10 in parallel ──
  const UPDATE_BATCH = 10;
  for (let i = 0; i < updateRows.length; i += UPDATE_BATCH) {
    const batch = updateRows.slice(i, i + UPDATE_BATCH);
    await Promise.all(batch.map(async row => {
      try {
        const inv = row.existing;

        const medPatch = { name: row.name, is_active: row.is_active };
        if (row.category !== null)    medPatch.category   = row.category;
        if (row.brand    !== null)    medPatch.brand      = row.brand;
        if (row.unit     !== null)    medPatch.unit       = row.unit;
        if (row.barcode  !== null)    medPatch.barcode    = row.barcode;
        if (row.indications.length)  medPatch.indications = row.indications;

        const { error: me } = await supabase.from('medicines').update(medPatch).eq('id', inv.medicine.id);
        if (me) throw me;

        const invPatch = {};
        if (row.mrp > 0)             { invPatch.mrp = row.mrp; invPatch.cost_price = row.cost_price; }
        if (row.gst_percent > 0)     invPatch.gst_percent    = row.gst_percent;
        if (row.profit_percent > 0)  invPatch.profit_percent = row.profit_percent;
        if (row.max_stock > 0)       invPatch.max_stock      = row.max_stock;
        if (row.reorder_level > 0)   invPatch.reorder_level  = row.reorder_level;
        if (row.inward_date)         invPatch.inward_date    = row.inward_date;
        if (row.expiry_date)         invPatch.expiry_date    = row.expiry_date;
        if (row.batch_number)        invPatch.batch_number   = row.batch_number;
        if (row.supplier_name)       invPatch.supplier_name  = row.supplier_name;
        if (replaceStock)            invPatch.stock_quantity = row.stock_quantity;

        if (Object.keys(invPatch).length) {
          const { error: ie } = await supabase.from('inventory')
            .update(invPatch).eq('id', inv.id).eq('tenant_id', tenantId);
          if (ie) throw ie;
        }
        updated++;
      } catch (err) {
        console.error('Update error:', row.name, err);
        errors++;
      }
      done++;
    }));
    _setProgress(`Updating existing records… ${done}/${total}`);
  }

  // ── Done ───────────────────────────────────────────
  progFill.style.width = '100%';
  progText.textContent = 'Finalising…';
  await loadInventory();

  // Build result summary
  const parts = [];
  if (added)   parts.push(`✅ ${added} added`);
  if (updated) parts.push(`✏️ ${updated} updated`);
  if (skipped) parts.push(`⏭ ${skipped} skipped`);
  if (errors)  parts.push(`❌ ${errors} failed`);
  const resultMsg = `Import complete — ${parts.join('  ·  ')}`;

  _closeImport();
  cancelBtn.disabled = false;
  _alert(errors > 0 ? 'warning' : 'success', resultMsg);
});

await loadInventory();
