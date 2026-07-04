import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin']);
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const tenantId  = getCurrentTenantId();
const myProfile = getCurrentProfile();
let _entries  = [];
let _filter   = '';

const CAT_LABEL = { classical:'Classical', patent:'Patent', rasa_shastra:'Rasa Shastra', liquid:'Liquid', external:'External', single_herb:'Single Herb', polyherbal:'Polyherbal' };

// ── Load ─────────────────────────────────────────
async function loadFormulary() {
  const { data } = await supabase
    .from('hospital_formulary')
    .select('*, approved_by_profile:profiles!approved_by(full_name)')
    .eq('tenant_id', tenantId)
    .order('medicine_name');
  _entries = data || [];
  updateStats();
  renderTable();
}

function updateStats() {
  const active = _entries.filter(e => e.is_active);
  const today  = new Date();
  const oneYearAgo = new Date(today); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const dueReview  = active.filter(e => !e.last_reviewed_at || new Date(e.last_reviewed_at) < oneYearAgo);
  document.getElementById('stat-total').textContent    = active.length;
  document.getElementById('stat-classical').textContent = active.filter(e=>e.category==='classical').length;
  document.getElementById('stat-patent').textContent   = active.filter(e=>['patent','rasa_shastra'].includes(e.category)).length;
  document.getElementById('stat-review').textContent   = dueReview.length;
}

function _reviewClass(dateStr) {
  if (!dateStr) return 'review-red';
  const d = new Date(dateStr);
  const now = new Date();
  const months = (now - d) / (1000 * 60 * 60 * 24 * 30);
  if (months < 6)  return 'review-green';
  if (months < 12) return 'review-amber';
  return 'review-red';
}

window.renderTable = function() {
  const q = (document.getElementById('search-input').value || '').toLowerCase();
  let rows = _entries.filter(e =>
    (!_filter || e.category === _filter) &&
    (!q || e.medicine_name.toLowerCase().includes(q) || (e.generic_name||'').toLowerCase().includes(q) || (e.approved_indications||'').toLowerCase().includes(q))
  );
  const tbody = document.getElementById('formulary-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">No medicines match this filter.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(e => `
    <tr class="${e.is_active?'':'inactive'}">
      <td>
        <div style="font-weight:600">${_esc(e.medicine_name)}</div>
        ${e.generic_name ? `<div style="font-size:11px;color:var(--text-muted)">${_esc(e.generic_name)}</div>` : ''}
      </td>
      <td><span class="cat-badge cat-${e.category||'classical'}">${CAT_LABEL[e.category]||_esc(e.category)}</span></td>
      <td style="font-size:12px">${_esc(e.dosage_form||'—')}</td>
      <td style="font-size:12px;max-width:140px">${_esc(e.standard_dose||'—')}</td>
      <td style="font-size:12px;max-width:200px;color:var(--text-mid)">${_esc((e.approved_indications||'—').slice(0,80))}${(e.approved_indications||'').length>80?'…':''}</td>
      <td><span class="review-dot ${_reviewClass(e.last_reviewed_at)}"></span>${e.last_reviewed_at ? new Date(e.last_reviewed_at+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : 'Not reviewed'}</td>
      <td><span class="${e.is_active?'status-active':'status-inactive'}">${e.is_active?'Active':'Inactive'}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn-sm" data-onclick="openDrawer" data-onclick-a0="${e.id}">Edit</button>
          <button class="btn-sm danger" data-onclick="toggleActive" data-onclick-a0="${e.id}" data-onclick-a1="${e.is_active}">${e.is_active?'Deactivate':'Activate'}</button>
        </div>
      </td>
    </tr>`).join('');
};

window.setFilter = function(cat, el) {
  _filter = cat;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderTable();
};

// ── Add / Edit ────────────────────────────────────
window.openDrawer = function(id) {
  const e = id ? _entries.find(x => x.id === id) : null;
  document.getElementById('form-id').value            = e?.id || '';
  document.getElementById('form-name').value          = e?.medicine_name || '';
  document.getElementById('form-generic').value       = e?.generic_name || '';
  document.getElementById('form-category').value      = e?.category || 'classical';
  document.getElementById('form-dosage-form').value   = e?.dosage_form || '';
  document.getElementById('form-std-dose').value      = e?.standard_dose || '';
  document.getElementById('form-indications').value   = e?.approved_indications || '';
  document.getElementById('form-reviewed').value      = e?.last_reviewed_at || '';
  document.getElementById('form-status').value        = String(e?.is_active ?? true);
  document.getElementById('form-notes').value         = e?.notes || '';
  document.getElementById('drawer-title').textContent = e ? 'Edit Formulary Entry' : 'Add Medicine to Formulary';
  document.getElementById('form-overlay').classList.add('open');
};

window.closeDrawer = function() {
  document.getElementById('form-overlay').classList.remove('open');
};

window.saveEntry = async function() {
  const id   = document.getElementById('form-id').value;
  const name = document.getElementById('form-name').value.trim();
  if (!name) { _toast('Medicine name is required.', true); return; }

  const payload = {
    tenant_id:           tenantId,
    medicine_name:       name,
    generic_name:        document.getElementById('form-generic').value.trim() || null,
    category:            document.getElementById('form-category').value,
    dosage_form:         document.getElementById('form-dosage-form').value.trim() || null,
    standard_dose:       document.getElementById('form-std-dose').value.trim() || null,
    approved_indications:document.getElementById('form-indications').value.trim() || null,
    last_reviewed_at:    document.getElementById('form-reviewed').value || null,
    is_active:           document.getElementById('form-status').value === 'true',
    notes:               document.getElementById('form-notes').value.trim() || null,
  };

  let error;
  if (id) {
    ({ error } = await supabase.from('hospital_formulary').update(payload).eq('id', id));
  } else {
    payload.approved_by = myProfile?.id;
    payload.approved_at = new Date().toISOString();
    ({ error } = await supabase.from('hospital_formulary').insert(payload));
  }
  if (error) { _toast('Error: ' + error.message, true); return; }
  closeDrawer();
  _toast(id ? 'Entry updated.' : 'Medicine added to formulary.');
  await loadFormulary();
};

window.toggleActive = async function(id, current) {
  const isActive = current === true || current === 'true';
  const { error } = await supabase.from('hospital_formulary').update({ is_active: !isActive }).eq('id', id);
  if (error) { _toast('Error: ' + error.message, true); return; }
  _toast(isActive ? 'Medicine deactivated.' : 'Medicine activated.');
  await loadFormulary();
};

// ── Import from Inventory ─────────────────────────
window.openImportModal = async function() {
  document.getElementById('import-overlay').style.display = 'flex';
  const listEl = document.getElementById('import-list');
  listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">Loading…</div>';

  const [invRes] = await Promise.all([
    supabase.from('inventory').select('medicine:medicines(id,name)').eq('tenant_id', tenantId),
  ]);
  const inFormulary = new Set(_entries.map(e => e.medicine_name.toLowerCase()));
  const candidates = (invRes.data || [])
    .map(r => r.medicine?.name).filter(Boolean)
    .filter((n,i,a) => a.indexOf(n) === i)
    .filter(n => !inFormulary.has(n.toLowerCase()))
    .sort();

  if (!candidates.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px">All inventory medicines are already in the formulary.</div>';
    return;
  }
  listEl.innerHTML = candidates.map((n,i) => `
    <label class="import-item">
      <input type="checkbox" id="imp-${i}" value="${_esc(n)}" checked/>
      <span>${_esc(n)}</span>
    </label>`).join('');
};

window.closeImportModal = function() {
  document.getElementById('import-overlay').style.display = 'none';
};

window.doImport = async function() {
  const checks = document.querySelectorAll('#import-list input[type=checkbox]:checked');
  if (!checks.length) { _toast('Select at least one medicine.', true); return; }
  const rows = Array.from(checks).map(c => ({
    tenant_id:     tenantId,
    medicine_name: c.value,
    category:      'classical',
    is_active:     true,
    approved_by:   myProfile?.id,
    approved_at:   new Date().toISOString(),
  }));
  const { error } = await supabase.from('hospital_formulary').insert(rows);
  if (error) { _toast('Import error: ' + error.message, true); return; }
  closeImportModal();
  _toast(`${rows.length} medicine(s) added to formulary.`);
  await loadFormulary();
};

// ── CSV Export ────────────────────────────────────
window.exportCsv = function() {
  const active = _entries.filter(e => e.is_active);
  const lines = [
    ['Medicine Name','Generic Name','Category','Dosage Form','Standard Dose','Approved Indications','Last Reviewed'],
    ...active.map(e => [e.medicine_name, e.generic_name||'', CAT_LABEL[e.category]||e.category, e.dosage_form||'', e.standard_dose||'', e.approved_indications||'', e.last_reviewed_at||''])
  ].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(','));
  const blob = new Blob([lines.join('\n')], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href = url;
  a.download = `hospital-formulary-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
};

function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = isErr ? '#8b1a1a' : '#1a4a2e';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

await loadFormulary();
