import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','pharmacist','doctor']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
let _records = [];
let _prepbySearchTimer = null, _supbySearchTimer = null;
let _prepbyResults = [], _supbyResults = [];

// Set current month default
const now = new Date();
document.getElementById('f-month').value = now.toISOString().slice(0,7);
document.getElementById('f-status').value = 'active';

async function loadKPIs() {
  const today = new Date().toISOString().split('T')[0];
  const exp30 = new Date(); exp30.setDate(exp30.getDate()+30);
  const monthStart = now.toISOString().slice(0,7)+'-01';

  const [active, qcpend, qcpass, expiring, monthly] = await Promise.all([
    supabase.from('aushadha_nirman_register').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('status','active'),
    supabase.from('aushadha_nirman_register').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('qc_done',false),
    supabase.from('aushadha_nirman_register').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('qc_result','pass'),
    supabase.from('aushadha_nirman_register').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('status','active').lte('expiry_date',exp30.toISOString().split('T')[0]).gte('expiry_date',today),
    supabase.from('aushadha_nirman_register').select('id',{count:'exact'}).eq('tenant_id',tenantId).gte('preparation_date',monthStart),
  ]);

  document.getElementById('k-active').textContent = active.count??0;
  document.getElementById('k-qcpend').textContent = qcpend.count??0;
  document.getElementById('k-qcpass').textContent = qcpass.count??0;
  document.getElementById('k-expiring').textContent = expiring.count??0;
  document.getElementById('k-month').textContent = monthly.count??0;
  if ((expiring.count??0) > 0) document.getElementById('expiry-alert').classList.add('show');
}

window.loadRegister = async () => {
  const type = document.getElementById('f-type').value;
  const status = document.getElementById('f-status').value;
  const month = document.getElementById('f-month').value;
  let q = supabase.from('aushadha_nirman_register')
    .select('*, prepared_staff:profiles!prepared_by(full_name), supervised_staff:profiles!supervised_by(full_name)')
    .eq('tenant_id',tenantId).order('preparation_date',{ascending:false});
  if (type) q = q.eq('preparation_type',type);
  if (status) q = q.eq('status',status);
  if (month) q = q.gte('preparation_date',month+'-01').lte('preparation_date',month+'-31');
  const {data,error} = await q.limit(200);
  const tb = document.getElementById('reg-tbody');
  document.getElementById('rec-count').textContent = data?.length ? data.length+' records' : '';
  _records = data || [];
  if (error||!data?.length){tb.innerHTML=`<tr><td colspan="10" class="empty">No records found.</td></tr>`;return;}
  const today = new Date();
  tb.innerHTML = data.map(r=>{
    const exp = r.expiry_date ? new Date(r.expiry_date) : null;
    const expCls = !exp ? '' : exp < today ? 'color:var(--red);font-weight:600' : (exp-today)<30*864e5?'color:var(--amber);font-weight:600':'';
    const qcBadge = r.qc_done ? `<span class="badge b-${r.qc_result||'pending'}">${_esc(r.qc_result||'—')}</span>` : `<span style="color:var(--text-muted);font-size:11px">Pending</span>`;
    return `<tr>
      <td><strong>${_esc(r.formula_name)}</strong></td>
      <td>${typeLabel(r.preparation_type)}</td>
      <td>${_esc(r.batch_number)}</td>
      <td>${r.preparation_date}</td>
      <td>${r.quantity_prepared} ${_esc(r.unit)}</td>
      <td>${qcBadge}</td>
      <td style="${expCls}">${r.expiry_date||'—'}</td>
      <td>${r.quantity_remaining!==null?r.quantity_remaining+' '+_esc(r.unit):'—'}</td>
      <td><span class="badge b-${r.status}">${_esc(r.status)}</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-outline" data-onclick="viewDetail" data-onclick-a0="${r.id}">View</button>
        <button class="btn btn-sm btn-primary" data-onclick="editPrep" data-onclick-a0="${r.id}">Edit</button>
        ${r.status==='active'?`<button class="btn btn-sm btn-danger" data-onclick="recall" data-onclick-a0="${r.id}">Recall</button>`:''}
      </td>
    </tr>`;
  }).join('');
};

window.openNew = () => {
  document.getElementById('p-id').value = '';
  document.getElementById('prep-modal-title').textContent = 'New Preparation — Aushadha Nirman';
  ['p-name','p-batch','p-ingredients','p-ref','p-process','p-qcnotes','p-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('p-type').value='';
  document.getElementById('p-unit').value='kg';
  document.getElementById('p-storage').value='cool dry place';
  document.getElementById('p-qc').value='no';
  document.getElementById('p-qcresult').value='';
  document.getElementById('p-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('p-expiry').value='';
  document.getElementById('p-qcdate').value='';
  document.getElementById('p-qty').value='';
  resetStaffPicker('prepby');
  resetStaffPicker('supby');
  document.getElementById('prep-modal').classList.add('show');
};

window.editPrep = (id) => {
  const r = _records.find(x=>x.id===id);
  if (!r) return;
  document.getElementById('p-id').value = r.id;
  document.getElementById('prep-modal-title').textContent = 'Edit — '+r.formula_name;
  document.getElementById('p-name').value = r.formula_name||'';
  document.getElementById('p-type').value = r.preparation_type||'';
  document.getElementById('p-batch').value = r.batch_number||'';
  document.getElementById('p-date').value = r.preparation_date||'';
  document.getElementById('p-expiry').value = r.expiry_date||'';
  document.getElementById('p-qty').value = r.quantity_prepared||'';
  document.getElementById('p-unit').value = r.unit||'kg';
  document.getElementById('p-storage').value = r.storage_conditions||'cool dry place';
  document.getElementById('p-ingredients').value = r.ingredients||'';
  document.getElementById('p-ref').value = r.classical_reference||'';
  document.getElementById('p-process').value = r.process_notes||'';
  document.getElementById('p-qc').value = r.qc_done?'yes':'no';
  document.getElementById('p-qcdate').value = r.qc_date||'';
  document.getElementById('p-qcresult').value = r.qc_result||'';
  document.getElementById('p-qcnotes').value = r.qc_notes||'';
  document.getElementById('p-notes').value = r.notes||'';

  resetStaffPicker('prepby');
  if (r.prepared_by && r.prepared_staff?.full_name) setStaffPicker('prepby', r.prepared_by, r.prepared_staff.full_name);
  resetStaffPicker('supby');
  if (r.supervised_by && r.supervised_staff?.full_name) setStaffPicker('supby', r.supervised_by, r.supervised_staff.full_name);

  document.getElementById('prep-modal').classList.add('show');
};

window.savePrep = async () => {
  const name = document.getElementById('p-name').value.trim();
  const type = document.getElementById('p-type').value;
  const batch = document.getElementById('p-batch').value.trim();
  const date = document.getElementById('p-date').value;
  const qty = parseFloat(document.getElementById('p-qty').value);
  const ingredients = document.getElementById('p-ingredients').value.trim();
  if (!name||!type||!batch||!date||!qty||!ingredients){showToast('Fill all required fields','error');return;}

  const qcDone = document.getElementById('p-qc').value==='yes';
  const payload = {
    tenant_id:tenantId, formula_name:name, preparation_type:type,
    batch_number:batch, preparation_date:date,
    quantity_prepared:qty, unit:document.getElementById('p-unit').value,
    ingredients, storage_conditions:document.getElementById('p-storage').value,
    expiry_date:document.getElementById('p-expiry').value||null,
    classical_reference:document.getElementById('p-ref').value.trim()||null,
    process_notes:document.getElementById('p-process').value.trim()||null,
    qc_done:qcDone,
    qc_date:qcDone?document.getElementById('p-qcdate').value||null:null,
    qc_result:qcDone?document.getElementById('p-qcresult').value||null:null,
    qc_notes:document.getElementById('p-qcnotes').value.trim()||null,
    notes:document.getElementById('p-notes').value.trim()||null,
    prepared_by:document.getElementById('p-prepby-id').value||null,
    supervised_by:document.getElementById('p-supby-id').value||null,
    created_by:profile.id
  };

  const id = document.getElementById('p-id').value;
  const {error} = id
    ? await supabase.from('aushadha_nirman_register').update(payload).eq('id',id).eq('tenant_id',tenantId)
    : await supabase.from('aushadha_nirman_register').insert(payload);
  if (error){showToast('Error: '+error.message,'error');return;}
  closeModal('prep-modal');
  showToast('Saved successfully','success');
  loadRegister(); loadKPIs();
};

window.viewDetail = (id) => {
  const r = _records.find(x=>x.id===id);
  if (!r) return;
  document.getElementById('d-title').textContent = r.formula_name + ' — ' + r.batch_number;
  const rows = [
    ['Type', typeLabel(r.preparation_type)],
    ['Batch Number', r.batch_number],
    ['Preparation Date', r.preparation_date],
    ['Qty Prepared', r.quantity_prepared + ' ' + r.unit],
    ['Storage', r.storage_conditions||'—'],
    ['Expiry', r.expiry_date||'—'],
    ['Ingredients', r.ingredients],
    ['Classical Reference', r.classical_reference||'—'],
    ['Process Notes', r.process_notes||'—'],
    ['Prepared By', r.prepared_staff?.full_name||'—'],
    ['Supervised By', r.supervised_staff?.full_name||'—'],
    ['QC Status', r.qc_done?(r.qc_result||'Done'):'Pending'],
    ['QC Date', r.qc_date||'—'],
    ['QC Notes', r.qc_notes||'—'],
    ['Notes', r.notes||'—'],
  ];
  document.getElementById('d-body').innerHTML = rows.map(([k,v])=>`
    <div style="margin-bottom:8px"><span class="detail-label">${_esc(k)}:</span>&nbsp;
    <span style="color:var(--text-dark)">${_esc(v||'—')}</span></div>`).join('');
  document.getElementById('detail-modal').classList.add('show');
};

window.recall = async (id) => {
  if (!confirm('Mark this batch as recalled?')) return;
  await supabase.from('aushadha_nirman_register').update({status:'recalled'}).eq('id',id).eq('tenant_id',tenantId);
  showToast('Batch recalled','success');
  loadRegister(); loadKPIs();
};

window.printDetail = () => window.print();

window.exportCSV = async () => {
  const {data} = await supabase.from('aushadha_nirman_register').select('*').eq('tenant_id',tenantId).order('preparation_date',{ascending:false});
  if (!data?.length){showToast('No data','error');return;}
  const header = ['Formula Name','Type','Batch No.','Date','Qty','Unit','QC','Expiry','Status'];
  const rows = data.map(r=>[r.formula_name,r.preparation_type,r.batch_number,r.preparation_date,r.quantity_prepared,r.unit,r.qc_result||'pending',r.expiry_date||'',r.status]);
  const csv = [header,...rows].map(r=>r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href='data:text/csv,'+encodeURIComponent(csv);
  a.download='aushadha_nirman_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
};

window.closeModal = id => document.getElementById(id).classList.remove('show');

// ── Staff search/picker (prepared_by / supervised_by → profiles.id) ──────────
window.debouncePrepbySearch = function(val) {
  clearTimeout(_prepbySearchTimer);
  document.getElementById('p-prepby-id').value = '';
  if (val.length < 2) { document.getElementById('p-prepby-results').style.display='none'; return; }
  _prepbySearchTimer = setTimeout(() => searchStaff(val,'pharmacist','prepby'), 300);
};
window.debounceSupbySearch = function(val) {
  clearTimeout(_supbySearchTimer);
  document.getElementById('p-supby-id').value = '';
  if (val.length < 2) { document.getElementById('p-supby-results').style.display='none'; return; }
  _supbySearchTimer = setTimeout(() => searchStaff(val,'doctor','supby'), 300);
};

async function searchStaff(q, role, kind) {
  const { data } = await supabase.from('profiles')
    .select('id,full_name').eq('tenant_id',tenantId).eq('role',role)
    .ilike('full_name',`%${q}%`).limit(8);
  const el = document.getElementById(`p-${kind}-results`);
  if (!data?.length) { el.style.display='none'; return; }
  if (kind==='prepby') _prepbyResults = data; else _supbyResults = data;
  el.style.display = '';
  el.innerHTML = data.map(d => `
    <div class="search-item" data-onclick="selectStaff" data-onclick-a0="${kind}" data-onclick-a1="${d.id}">${_esc(d.full_name)}</div>`).join('');
}

window.selectStaff = function(kind, id) {
  const list = kind==='prepby' ? _prepbyResults : _supbyResults;
  const d = list.find(x => x.id === id);
  if (!d) return;
  setStaffPicker(kind, d.id, d.full_name);
};

function setStaffPicker(kind, id, name) {
  document.getElementById(`p-${kind}-results`).style.display='none';
  document.getElementById(`p-${kind}-search`).value = name;
  document.getElementById(`p-${kind}-id`).value = id;
  const tag = document.getElementById(`p-${kind}-tag`);
  tag.textContent = `✓ ${name}`;
  tag.style.display = '';
}

function resetStaffPicker(kind) {
  document.getElementById(`p-${kind}-search`).value = '';
  document.getElementById(`p-${kind}-id`).value = '';
  document.getElementById(`p-${kind}-results`).style.display='none';
  const tag = document.getElementById(`p-${kind}-tag`);
  tag.textContent = '';
  tag.style.display = 'none';
}

function typeLabel(t){const m={churna:'Churna',vati:'Vati/Gutika',kwatha:'Kwatha',asava_arishta:'Asava/Arishta',ghrita:'Ghrita',taila:'Taila',lepa:'Lepa',avaleha:'Avaleha',other:'Other'};return _esc(m[t]||t);}
function showToast(msg,type='success'){const t=document.getElementById('toast');t.textContent=msg;t.className=`toast ${type} show`;setTimeout(()=>t.classList.remove('show'),3000);}
function _esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

loadRegister();
loadKPIs();
