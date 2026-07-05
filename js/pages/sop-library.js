import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin'], 'index.html');
initNavbar();
wireDelegatedEvents();
const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
let _docs = [];

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const CAT_LABELS = {
  clinical:'Clinical', nursing:'Nursing', pharmacy:'Pharmacy', lab:'Laboratory',
  infection_control:'Infection Control', emergency:'Emergency',
  administration:'Administration', hr:'HR / Training', quality:'Quality / NABH', general:'General'
};

async function load() {
  const { data } = await supabase.from('sop_documents')
    .select('*').eq('tenant_id', tenantId).order('category').order('sop_code');
  _docs = data || [];
  renderKPI();
  renderTable();
  checkOverdue();
}

function renderKPI() {
  const today = new Date(); today.setHours(0,0,0,0);
  const in30  = new Date(today); in30.setDate(in30.getDate()+30);
  let total=_docs.length, current=0, due=0, overdue=0, draft=0;
  _docs.forEach(d => {
    if (d.status==='current') current++;
    if (d.status==='draft') draft++;
    if (d.review_date) {
      const rv = new Date(d.review_date);
      if (rv < today) overdue++;
      else if (rv <= in30) due++;
    }
  });
  document.getElementById('k-total').textContent    = total;
  document.getElementById('k-current').textContent  = current;
  document.getElementById('k-due').textContent      = due;
  document.getElementById('k-overdue').textContent  = overdue;
  document.getElementById('k-draft').textContent    = draft;
}

function reviewClass(reviewDate) {
  if (!reviewDate) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const in30  = new Date(today); in30.setDate(in30.getDate()+30);
  const rv    = new Date(reviewDate);
  if (rv < today)  return 'rl-red';
  if (rv <= in30)  return 'rl-amber';
  return 'rl-green';
}

function checkOverdue() {
  const today = new Date(); today.setHours(0,0,0,0);
  const overdue = _docs.filter(d => d.review_date && new Date(d.review_date) < today && d.status==='current');
  const banner  = document.getElementById('overdue-banner');
  if (overdue.length) {
    banner.style.display = '';
    banner.textContent   = `⚠ ${overdue.length} SOP(s) are overdue for review — IMS.6 requires all documents to be reviewed per schedule.`;
  }
}

window.renderTable = function() {
  const q   = document.getElementById('search').value.toLowerCase();
  const cat = document.getElementById('cat-filter').value;
  const st  = document.getElementById('status-filter').value;
  const rows = _docs.filter(d => {
    if (cat && d.category !== cat) return false;
    if (st  && d.status   !== st)  return false;
    if (q && !((d.title||'').toLowerCase().includes(q) || (d.sop_code||'').toLowerCase().includes(q) || (d.approved_by||'').toLowerCase().includes(q))) return false;
    return true;
  });
  const tbody = document.getElementById('sop-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="9"><div class="empty">No SOPs found</div></td></tr>'; return; }
  tbody.innerHTML = rows.map(d => {
    const rv  = d.review_date ? d.review_date : '—';
    const cls = reviewClass(d.review_date);
    const bdg = {current:'b-current',draft:'b-draft',superseded:'b-superseded',withdrawn:'b-withdrawn'}[d.status]||'b-draft';
    const urlBtn = d.file_url ? `<a href="${_esc(d.file_url)}" target="_blank" class="btn btn-outline btn-sm" style="text-decoration:none">↗ Open</a>` : '';
    return `<tr>
      <td><strong>${_esc(d.sop_code||'—')}</strong></td>
      <td>${_esc(d.title)}</td>
      <td>${_esc(CAT_LABELS[d.category]||d.category)}</td>
      <td>v${_esc(d.version)}</td>
      <td>${d.effective_date||'—'}</td>
      <td class="${cls}">${rv}</td>
      <td>${_esc(d.approved_by||'—')}</td>
      <td><span class="badge ${bdg}">${_esc(d.status)}</span></td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        ${urlBtn}
        <button class="btn btn-outline btn-sm" data-onclick="editSOP" data-onclick-a0="${d.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-onclick="archiveSOP" data-onclick-a0="${d.id}">Archive</button>
      </td>
    </tr>`;
  }).join('');
};

window.openModal = function(id) {
  document.getElementById('sop-modal').style.display = 'flex';
  document.getElementById('modal-title').textContent = id ? 'Edit SOP Document' : 'Add SOP Document';
  if (!id) {
    ['edit-id','f-code','f-title','f-version','f-effective','f-review','f-approved','f-url','f-notes'].forEach(i => document.getElementById(i).value = '');
    document.getElementById('f-version').value = '1.0';
    document.getElementById('f-cat').value    = 'clinical';
    document.getElementById('f-status').value = 'current';
  }
};

window.closeModal = function() {
  document.getElementById('sop-modal').style.display = 'none';
};

window.editSOP = function(id) {
  const d = _docs.find(x => x.id === id); if (!d) return;
  openModal(id);
  document.getElementById('edit-id').value      = d.id;
  document.getElementById('f-code').value       = d.sop_code||'';
  document.getElementById('f-title').value      = d.title;
  document.getElementById('f-cat').value        = d.category;
  document.getElementById('f-version').value    = d.version;
  document.getElementById('f-effective').value  = d.effective_date||'';
  document.getElementById('f-review').value     = d.review_date||'';
  document.getElementById('f-approved').value   = d.approved_by||'';
  document.getElementById('f-status').value     = d.status;
  document.getElementById('f-url').value        = d.file_url||'';
  document.getElementById('f-notes').value      = d.notes||'';
};

window.saveSOP = async function() {
  const title   = document.getElementById('f-title').value.trim();
  const review  = document.getElementById('f-review').value;
  if (!title || !review) { toast('Title and Review Date are required', 'error'); return; }
  const payload = {
    tenant_id:      tenantId,
    sop_code:       document.getElementById('f-code').value.trim()||null,
    title,
    category:       document.getElementById('f-cat').value,
    version:        document.getElementById('f-version').value.trim()||'1.0',
    effective_date: document.getElementById('f-effective').value||null,
    review_date:    review,
    approved_by:    document.getElementById('f-approved').value.trim()||null,
    status:         document.getElementById('f-status').value,
    file_url:       document.getElementById('f-url').value.trim()||null,
    notes:          document.getElementById('f-notes').value.trim()||null,
    created_by:     profile.id,
    updated_at:     new Date().toISOString()
  };
  const editId = document.getElementById('edit-id').value;
  let err;
  if (editId) {
    ({ error: err } = await supabase.from('sop_documents').update(payload).eq('id', editId));
  } else {
    ({ error: err } = await supabase.from('sop_documents').insert(payload));
  }
  if (err) { toast('Save failed: '+err.message, 'error'); return; }
  toast(editId ? 'SOP updated' : 'SOP added', 'success');
  closeModal();
  load();
};

window.archiveSOP = async function(id) {
  const d = _docs.find(x => x.id === id); if (!d) return;
  if (!confirm(`Archive "${d.title}"? Status will be set to Superseded.`)) return;
  const { error } = await supabase.from('sop_documents').update({ status:'superseded', updated_at:new Date().toISOString() }).eq('id', id);
  if (error) { toast('Failed: '+error.message, 'error'); return; }
  toast('SOP archived', 'success'); load();
};

window.exportCSV = function() {
  const rows = _docs.map(d => [d.sop_code||'', d.title, d.category, d.version, d.effective_date||'', d.review_date, d.approved_by||'', d.status]);
  const csv  = [['Code','Title','Category','Version','Effective','Review Date','Approved By','Status'], ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a    = document.createElement('a');
  a.href     = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `sop_library_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
};

function _esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  setTimeout(() => el.className = 'toast', 2800);
}

load();
