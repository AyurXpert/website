import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { fillFormSelect, ITEM_MASTER_ROLES } from '../modules/inventory/medicineForms.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';
import { notify } from '../components/notify.js';

await requireAuth(['pharmacist', 'dept_admin', 'super_admin']);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const canItemMaster = ITEM_MASTER_ROLES.includes(profile?.role) || profile?.secondary_role === 'dept_admin';
let _items  = [];
let _adjType = 'remove';   // Session 332: adding stock is a goods receipt (Purchase / GRN), never an adjustment
// Session 332: the shared medicine catalogue (name, category, brand, unit, barcode, image, indications, active,
// anupana, classical reference, dosage) is changed only by AyurXpert (platform admin) -- read-only here.
const CATALOGUE_FIELDS = ['f-name', 'f-cat', 'f-brand', 'f-unit', 'f-barcode', 'f-active', 'f-anupana', 'f-classical-ref', 'f-dosage', 'f-image',
                          'f-form', 'f-strength', 'f-mfr'];
// Session 340: each organisation owns its medicine list. These fields are saved through pharmacy_item_save() by an
// administrator (super_admin, or a dept_admin when the pharmacy module is on -- the server re-checks); a pharmacist sees
// them read-only and adds new medicines while receiving stock (Purchase / GRN).
const ITEM_FIELDS = ['f-name', 'f-cat', 'f-brand', 'f-unit', 'f-form', 'f-strength', 'f-mfr'];
// a RECEIVED batch's identity is what the supplier delivered -- fixed (DB guard trg_inventory_browser_guard)
const RECEIVED_BATCH_FIELDS = ['f-mrp', 'f-expiry', 'f-batch'];
let _tags   = [];
let _namcLabels = {};
let _imgUploading = false;
const TODAY = todayLocalStr();
const IN_90_DAYS = localDateStr(new Date(Date.now() + 90*86400000));

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
    .select(`id, batch_source, stock_quantity, mrp, cost_price, gst_percent, reorder_level,
             profit_percent, max_stock, expiry_date, inward_date, supplier_name, batch_number,
             is_gmp_certified, gmp_certificate_no, is_student_batch,
             is_high_risk, is_lasa, lasa_pair, is_schedule_h, is_schedule_h1, is_schedule_e1, is_ndps,
             medicine:medicines(id, name, category, is_active, indications, barcode, med_id, brand, unit, image_url, anupana, classical_reference, dosage_text,
                                dosage_form, strength, manufacturer, gst_percent, hsn_code, is_high_risk, is_schedule_e1)`)
    .eq('tenant_id', tenantId);

  if (error) { console.error('loadInventory error:', error); _alert('error', safeErrorMessage(error, 'Failed to load inventory.')); return; }
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
          ${i.is_schedule_h1 ? '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#e3f0ff;color:#1a4080;border:1px solid #a8c8f0">Sch-H1</span>' : ''}
          ${i.is_ndps ? '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#f7e6f2;color:#8b1a6b;border:1px solid #d9a8c9">NDPS</span>' : ''}
          ${i.is_schedule_e1 ? '<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#fdeee2;color:#9a4a10;border:1px solid #f0c09a">Sch-E1</span>' : ''}
          ${i.is_student_batch
            ? '<br><span style="display:inline-block;margin-top:2px;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;background:#fff8e1;color:#7a4000;border:1px solid #e8c068">⚠ STUDENT</span>'
            : ''}
        </td>
        <td><button class="btn-status-toggle stock-badge ${isActive ? 'sb-ok' : ''}" data-med-id="${i.medicine.id}" data-active="${isActive}" style="${isActive ? '' : 'background:#f0f0f0;color:#666'}" title="Catalogue status — set by AyurXpert">${isActive ? 'Active' : 'Inactive'}</button></td>
        <td>
          <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
            ${i.is_student_batch ? `<button class="btn btn-xs btn-practical" data-id="${i.id}" data-name="${_esc(i.medicine.name)}" data-stock="${i.stock_quantity||0}" data-expiry="${i.expiry_date||''}" data-batch="${_esc(i.batch_number||'')}" style="background:#fff8e1;color:#7a4000;border:1px solid #e8c068;white-space:nowrap">🎓 Practical Use</button>` : ''}
            <button class="btn btn-ghost btn-xs btn-adj" data-id="${i.id}" data-name="${_esc(i.medicine.name)}">±</button>
            <button class="btn btn-secondary btn-xs btn-edit" data-id="${i.id}">Edit</button>
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
    btn.addEventListener('click', () => toggleStatus())
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
  if (error) { _alert('error', safeErrorMessage(error, 'Image upload failed.')); return; }

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

  // Session 340: the medicine's own fields are editable by an administrator (add and edit); Active / Inactive only on edit;
  // barcode / indications / classical text / image are not part of the item master save and stay read-only.
  CATALOGUE_FIELDS.forEach(id => { const el = document.getElementById(id);
    if (el) el.disabled = !(canItemMaster && (ITEM_FIELDS.includes(id) || (id === 'f-active' && isEdit))); });
  fillFormSelect(document.getElementById('f-form'), '');
  document.getElementById('f-strength').value = '';
  document.getElementById('f-mfr').value = '';
  document.getElementById('f-deact-reason').value = '';
  document.getElementById('deact-reason-wrap').style.display = 'none';
  document.getElementById('item-master-note').textContent = canItemMaster ? '' :
    'Medicine details are kept by an administrator. To add a new medicine, receive it through Purchase / GRN (＋ New medicine).';
  const tagWrap = document.getElementById('tag-wrap');
  if (tagWrap) tagWrap.style.pointerEvents = 'none';
  const editItem = isEdit ? _items.find(i => i.id === invId) : null;
  const receivedBatch = editItem?.batch_source === 'received';
  RECEIVED_BATCH_FIELDS.forEach(id => { document.getElementById(id).disabled = receivedBatch; });
  document.getElementById('f-is-student-batch').disabled = isEdit;   // fixed once the row exists

  if (isEdit) {
    const item = editItem;
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
    fillFormSelect(document.getElementById('f-form'), item.medicine.dosage_form || '');
    document.getElementById('f-strength').value   = item.medicine.strength || '';
    document.getElementById('f-mfr').value        = item.medicine.manufacturer || '';
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
    document.getElementById('f-is-schedule-h1').checked   = item.is_schedule_h1    || false;
    document.getElementById('f-is-schedule-e1').checked   = item.is_schedule_e1    || false;
    document.getElementById('f-is-ndps').checked          = item.is_ndps           || false;
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
    // Session 307 — a new item must not inherit the safety / schedule flags of the last item edited
    ['f-is-high-risk','f-is-lasa','f-is-schedule-h','f-is-schedule-h1','f-is-schedule-e1','f-is-ndps']
      .forEach(id => { document.getElementById(id).checked = false; });
    document.getElementById('f-lasa-pair').value = '';
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
// Session 340: deactivating a medicine needs a reason (asked only when it is switched to Inactive)
document.getElementById('f-active').addEventListener('change', e => {
  document.getElementById('deact-reason-wrap').style.display = e.target.value === 'false' ? '' : 'none';
});

// ── Save medicine ────────────────────────────────────
document.getElementById('btn-save-med').addEventListener('click', async () => {
  const name    = document.getElementById('f-name').value.trim();
  const mrp     = parseFloat(document.getElementById('f-mrp').value) || 0;
  if (!name)    { _alert('error', 'Medicine name is required.'); return; }
  if (mrp <= 0) { _alert('error', 'MRP must be greater than 0.'); return; }
  if (_imgUploading) { _alert('warning', 'Image upload in progress — please wait.'); return; }

  const invId       = document.getElementById('edit-inv-id').value;
  const medId       = document.getElementById('edit-med-id').value;
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
  // Session 307 — separate drug classes: H1 register, E1 caution, NDPS register (not Schedule H)
  const isScheduleH1 = document.getElementById('f-is-schedule-h1').checked;
  const isScheduleE1 = document.getElementById('f-is-schedule-e1').checked;
  const isNdps       = document.getElementById('f-is-ndps').checked;

  const btn = document.getElementById('btn-save-med');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    if (invId && medId) {
      // Session 332: only this pharmacy's stock-row fields are saved -- the shared catalogue entry is read-only
      // here, and a RECEIVED batch keeps its batch number / expiry / MRP (the database refuses a change).
      const editItem = _items.find(i => i.id === invId);
      if (canItemMaster && editItem) {
        const m = editItem.medicine;
        const f = { name, form: document.getElementById('f-form').value, strength: document.getElementById('f-strength').value.trim(),
                    unit: document.getElementById('f-unit').value.trim(), mfr: document.getElementById('f-mfr').value.trim(),
                    brand: document.getElementById('f-brand').value.trim(), cat: document.getElementById('f-cat').value };
        const changed = f.name !== m.name || f.form !== (m.dosage_form || '') || f.strength !== (m.strength || '') || f.unit !== (m.unit || '')
                     || f.mfr !== (m.manufacturer || '') || f.brand !== (m.brand || '') || f.cat !== (m.category || '');
        if (changed) {
          const { error: me } = await supabase.rpc('pharmacy_item_save', {
            p_id: m.id, p_name: f.name, p_form: f.form || null, p_strength: f.strength, p_unit: f.unit, p_manufacturer: f.mfr,
            p_brand: f.brand, p_category: f.cat, p_hsn: m.hsn_code, p_gst_percent: m.gst_percent,
            p_is_high_risk: !!m.is_high_risk, p_is_schedule_e1: !!m.is_schedule_e1 });
          if (me) throw me;
        }
        const wantActive = document.getElementById('f-active').value === 'true';
        if (wantActive !== (m.is_active !== false)) {
          const { error: ae } = await supabase.rpc('pharmacy_item_set_active', {
            p_id: m.id, p_active: wantActive, p_reason: document.getElementById('f-deact-reason').value.trim() || null });
          if (ae) throw ae;
        }
      }
      const patch = { mrp, cost_price: cp, gst_percent: gstPct, profit_percent: profPct,
                      reorder_level: reorder, max_stock: maxStock,
                      inward_date: inward, expiry_date: expiry, batch_number: batch, supplier_name: supplier,
                      is_gmp_certified: isGmp, gmp_certificate_no: gmpCert, medicine_type: medType,
                      is_high_risk: isHighRisk, is_lasa: isLasa, lasa_pair: lasaPair, is_schedule_h: isScheduleH,
                      is_schedule_h1: isScheduleH1, is_schedule_e1: isScheduleE1, is_ndps: isNdps };
      if (editItem?.batch_source === 'received') { delete patch.mrp; delete patch.cost_price; delete patch.expiry_date; delete patch.batch_number; }
      const { error: ie } = await supabase.from('inventory').update(patch).eq('id', invId).eq('tenant_id', tenantId);
      if (ie) throw ie;
      _alert('success', `"${name}" updated.`);
    } else {
      // Session 340: the medicine is created in THIS pharmacy's own list (item master), then a 0-stock row is added --
      // stock arrives through Purchase / GRN. A pharmacist adds new medicines during a goods receipt instead.
      if (!canItemMaster) {
        _alert('error', 'Only an administrator can add a medicine here — receive it through Purchase / GRN (＋ New medicine) instead.');
        btn.disabled = false; btn.textContent = 'Save Medicine'; return;
      }
      const exists = _items.find(i => i.medicine.name.toLowerCase() === name.toLowerCase());
      if (exists) { _alert('error', `"${name}" already exists.`); btn.disabled = false; btn.textContent = 'Save Medicine'; return; }
      const { data: created, error: ce } = await supabase.rpc('pharmacy_item_save', {
        p_id: null, p_name: name, p_form: document.getElementById('f-form').value || null,
        p_strength: document.getElementById('f-strength').value.trim(), p_unit: document.getElementById('f-unit').value.trim(),
        p_manufacturer: document.getElementById('f-mfr').value.trim(), p_brand: document.getElementById('f-brand').value.trim(),
        p_category: document.getElementById('f-cat').value, p_hsn: null, p_gst_percent: gstPct,
        p_is_high_risk: isHighRisk, p_is_schedule_e1: isScheduleE1 });
      if (ce) throw ce;
      const med = { id: created.id, name: created.name };
      const { error: ie } = await supabase.from('inventory').insert({
        tenant_id: tenantId, medicine_id: med.id,
        stock_quantity: 0, mrp, cost_price: cp, gst_percent: gstPct,
        profit_percent: profPct, reorder_level: reorder, max_stock: maxStock,
        inward_date: inward, expiry_date: expiry, batch_number: batch, supplier_name: supplier,
        is_gmp_certified: isGmp, gmp_certificate_no: gmpCert,
        is_student_batch: isStudentBatch, medicine_type: medType,
        is_high_risk: isHighRisk, is_lasa: isLasa, lasa_pair: lasaPair, is_schedule_h: isScheduleH,
        is_schedule_h1: isScheduleH1, is_schedule_e1: isScheduleE1, is_ndps: isNdps
      });
      if (ie) throw ie;
      _alert('success', `"${med.name}" added to inventory with 0 stock — receive stock through Purchase / GRN.`);
    }
    closePanel();
    await loadInventory();
  } catch (err) {
    _alert('error', safeErrorMessage(err, 'Save failed. Please try again.'));
  }
  btn.disabled = false; btn.textContent = 'Save Medicine';
});

// ── Adjust stock modal ────────────────────────────────
window.onAdjReasonChange = function(val) {
  document.getElementById('disposal-fields').style.display = val === 'expired' ? '' : 'none';
  document.getElementById('adj-note-field').style.display  = val === 'expired' ? 'none' : '';
};
// modal reason -> adjust_stock() kind (Session 332)
const ADJ_KIND = { expired: 'expiry_disposal', damaged: 'damaged', stock_correction: 'stock_correction', sample: 'sample', other: 'other' };

function openAdjust(invId, name) {
  document.getElementById('adj-modal-title').textContent       = `Adjust Stock — ${name}`;
  document.getElementById('adj-inv-id').value                  = invId;
  document.getElementById('adj-qty').value                     = '';
  document.getElementById('adj-reason').value                  = '';
  document.getElementById('disposal-fields').style.display     = 'none';
  document.getElementById('adj-disposal-method').value         = '';
  document.getElementById('adj-disposal-date').value           = todayLocalStr();
  document.getElementById('adj-witnessed-by').value            = '';
  document.getElementById('adj-disposal-remarks').value        = '';
  document.getElementById('adj-note').value                    = '';
  document.getElementById('adj-note-field').style.display      = '';
  _adjType = 'remove';
  document.getElementById('adj-remove').classList.add('selected');
  document.getElementById('adj-add').classList.remove('selected');
  document.getElementById('adj-modal').classList.add('open');
}
// Session 332: stock is ADDED only by a goods receipt (batch, expiry, MRP, supplier recorded)
document.getElementById('adj-add').addEventListener('click', () => {
  if (confirm('Stock is added through Purchase / GRN, where the batch number, expiry and MRP are recorded.\n\nOpen Purchase / GRN now?')) {
    window.location.href = 'purchase.html';
  }
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

  const note = document.getElementById('adj-note').value.trim();
  if (!isExpiry && note.length < 5) { _alert('error', 'Describe what happened (at least 5 characters).'); return; }
  if (_adjType !== 'remove') return;

  const btn = document.getElementById('btn-adj-confirm');
  btn.disabled = true; btn.textContent = 'Saving…';

  // Session 332: one server call removes the stock, writes the disposal register for an expiry disposal,
  // and records who / why (audited). The browser can no longer set stock itself.
  const { data: res, error } = await supabase.rpc('adjust_stock', {
    p_inventory_id: invId, p_qty: qty, p_kind: ADJ_KIND[reason], p_reason: isExpiry ? null : note,
    p_disposal_method: isExpiry ? document.getElementById('adj-disposal-method').value : null,
    p_witnessed_by:    isExpiry ? document.getElementById('adj-witnessed-by').value.trim() : null,
    p_disposal_date:   isExpiry ? (document.getElementById('adj-disposal-date').value || null) : null,
    p_remarks:         isExpiry ? (document.getElementById('adj-disposal-remarks').value.trim() || null) : null,
  });
  btn.disabled = false; btn.textContent = 'Confirm';
  if (error) { _alert('error', safeErrorMessage(error, 'Failed to update stock.')); return; }

  document.getElementById('adj-modal').classList.remove('open');
  _alert('success', isExpiry
    ? `${qty} units logged for disposal. Stock now ${res?.stock_after ?? '—'}.`
    : `Stock now ${res?.stock_after ?? '—'} units.`);
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

  // Session 332: one server call -- disposal register entry + stock removal in one transaction, audited
  const { error: adjErr } = await supabase.rpc('adjust_stock', {
    p_inventory_id: invId, p_qty: qty, p_kind: 'student_practical', p_witnessed_by: witness.trim(),
  });
  if (adjErr) { _alert('error', safeErrorMessage(adjErr, 'Could not record the practical use.')); return; }

  _alert('success', `${qty} units of "${name}" logged as used in practical. Disposal record created.`);
  await loadInventory();
}

async function deleteMedicine(invId, name) {
  if (!confirm(`Remove "${name}" from inventory?\n\nThis deletes the stock record for your dispensary. The medicine name stays in the catalogue.`)) return;
  const { error } = await supabase.from('inventory')
    .delete().eq('id', invId).eq('tenant_id', tenantId);
  if (error) { _alert('error', safeErrorMessage(error, 'Delete failed.')); return; }
  _selectedIds.delete(invId);
  _alert('success', `"${name}" removed from inventory.`);
  await loadInventory();
}

// ── Toggle active / inactive directly in row ─────────
// Session 332: Active / Inactive is a flag on the SHARED catalogue entry -- switching it here used to switch the
// medicine off for every organisation. Only AyurXpert can change it now; a per-organisation "not stocked here"
// setting is TODO_LATER.md §124.
function toggleStatus() {
  _alert('info', 'Active / Inactive belongs to the shared AyurXpert medicine catalogue and is changed by AyurXpert support. To stop stocking a medicine, let its stock run out.');
}

// ── Bulk delete ───────────────────────────────────────
const _selectedIds = new Set();

function _updateBulkBar() {
  const n   = _selectedIds.size;
  const btn = document.getElementById('btn-bulk-del');
  document.getElementById('bulk-count').textContent = n;
  // Session 305: deleting inventory rows is not allowed (no DELETE rule; the old one never matched
  // anyone, so Delete silently removed nothing). Bulk delete stays hidden; see TODO_LATER
  // 'mark item inactive instead of delete'.
  btn.style.display = 'none';
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
  if (error) { _alert('error', safeErrorMessage(error, 'Bulk delete failed.')); return; }
  _selectedIds.clear();
  _alert('success', `${ids.length} medicine(s) removed from inventory.`);
  await loadInventory();
});

function _alert(type, msg) { notify(msg, type); }   // Session 323: shared top-layer notify()

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
  // Session 332: item settings only -- stock / MRP / batch / expiry come in through Purchase / GRN
  const header = 'Med ID,Name,GST%,Reorder(Low),Max';
  const example = ',"Chandraprabha Vatika",5,20,100';
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

    const TODAY_ISO = todayLocalStr();
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

    if (preview.length < 10) preview.push({ action, name: rawName, reorder: autoReorder, max: maxRaw, gst: gstRaw });
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
    <thead><tr><th>Action</th><th>Name</th><th>Reorder</th><th>Max</th><th>GST %</th></tr></thead>
    <tbody>${preview.map(p => `
      <tr class="row-${p.action}">
        <td><span class="badge-${p.action}">${p.action === 'new' ? 'ADD (catalogue)' : 'UPDATE'}</span></td>
        <td>${_esc(p.name)}</td><td>${_esc(p.reorder)}</td><td>${_esc(p.max)}</td><td>${_esc(p.gst)}</td>
      </tr>`).join('')}
    ${_importRows.length > 10 ? `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);font-style:italic">…and ${_importRows.length - 10} more rows</td></tr>` : ''}
    </tbody></table>`;

  document.getElementById('btn-do-import').disabled = false;
}

document.getElementById('btn-do-import').addEventListener('click', async () => {
  if (!_importRows.length) return;

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
  const notInCatalogue = [];

  function _setProgress(label) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progFill.style.width = pct + '%';
    progText.textContent = label || `Processing ${done} / ${total}…`;
  }
  _setProgress('Starting…');

  // Session 332: ITEM SETTINGS ONLY. Stock, MRP, batch, expiry, inward date and supplier columns are ignored
  // (stock arrives through Purchase / GRN -> receive_stock()); the shared medicine catalogue is never written
  // (AyurXpert maintains it). New rows are matched to the catalogue by exact name and added with 0 stock.
  const itemFields = r => {
    const f = {};
    if (r.gst_percent > 0)   f.gst_percent   = r.gst_percent;
    if (r.max_stock > 0)     f.max_stock     = r.max_stock;
    if (r.reorder_level > 0) f.reorder_level = r.reorder_level;
    return f;
  };
  const newRows    = _importRows.filter(r => r.action === 'new');
  const updateRows = _importRows.filter(r => r.action === 'update');

  // ── 1. New rows: catalogue match by exact name (case-insensitive) -> stock row with 0 stock ──
  if (newRows.length > 0) {
    _setProgress('Matching the medicine catalogue…');
    const { data: cat, error: ce } = await supabase.from('medicines').select('id, name, is_active');
    const byName = new Map();
    (cat || []).forEach(m => {
      const k = m.name.toLowerCase().trim();
      if (!byName.has(k) || (byName.get(k).is_active === false && m.is_active !== false)) byName.set(k, m);
    });
    const have = new Set(_items.map(i => i.medicine.id));
    const payload = [];
    for (const r of newRows) {
      const m = ce ? null : byName.get(r.name.toLowerCase().trim());
      if (!m) { skipped++; notInCatalogue.push(r.name); }
      else if (have.has(m.id)) { skipped++; }
      else { have.add(m.id); payload.push({ tenant_id: tenantId, medicine_id: m.id, stock_quantity: 0, ...itemFields(r) }); }
      done++;
    }
    for (let i = 0; i < payload.length; i += 50) {
      const chunk = payload.slice(i, i + 50);
      const { error: ie } = await supabase.from('inventory').insert(chunk);
      if (ie) { console.error('Inventory insert error:', ie); errors += chunk.length; }
      else    added += chunk.length;
    }
    _setProgress(`Adding catalogue medicines… ${done}/${total}`);
  }

  // ── 2. Existing items: item settings on EVERY batch row of the medicine (kept identical by the database) ──
  const UPDATE_BATCH = 10;
  for (let i = 0; i < updateRows.length; i += UPDATE_BATCH) {
    const batch = updateRows.slice(i, i + UPDATE_BATCH);
    await Promise.all(batch.map(async row => {
      try {
        const invPatch = itemFields(row);
        if (Object.keys(invPatch).length) {
          const { error: ie } = await supabase.from('inventory')
            .update(invPatch).eq('id', row.existing.id).eq('tenant_id', tenantId);
          if (ie) throw ie;
          updated++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error('Update error:', row.name, err);
        errors++;
      }
      done++;
    }));
    _setProgress(`Updating item settings… ${done}/${total}`);
  }

  // ── Done ───────────────────────────────────────────
  progFill.style.width = '100%';
  progText.textContent = 'Finalising…';
  await loadInventory();

  // Build result summary
  const parts = [];
  if (added)   parts.push(`✅ ${added} added`);
  if (updated) parts.push(`✏️ ${updated} updated`);
  if (skipped) parts.push(`⏭ ${skipped} skipped${notInCatalogue.length ? ` (${notInCatalogue.length} not in the AyurXpert catalogue: ${notInCatalogue.slice(0, 5).join(', ')}${notInCatalogue.length > 5 ? '…' : ''})` : ''}`);
  if (errors)  parts.push(`❌ ${errors} failed`);
  const resultMsg = `Import complete — ${parts.join('  ·  ')}`;

  _closeImport();
  cancelBtn.disabled = false;
  _alert(errors > 0 ? 'warning' : 'success', resultMsg);
});

await loadInventory();
