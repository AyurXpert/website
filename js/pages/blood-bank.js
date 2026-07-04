import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

window.showTab = (tab, btn) => {
  ['requests','inventory','crossmatch'].forEach(t => {
    document.getElementById('tab-'+t).style.display = t===tab?'block':'none';
  });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab==='requests') loadRequests();
  if (tab==='inventory') { loadInventory(); loadStockSummary(); }
  if (tab==='crossmatch') loadCrossmatch();
};

async function loadKPIs() {
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0,7)+'-01';

  const [inv, pending, issued, reactions] = await Promise.all([
    supabase.from('blood_bank_inventory').select('id,expiry_date',{count:'exact'}).eq('tenant_id',tenantId).eq('status','available'),
    supabase.from('blood_bank_requests').select('id',{count:'exact'}).eq('tenant_id',tenantId).in('status',['requested','crossmatch_pending']),
    supabase.from('blood_bank_requests').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('status','issued').gte('issued_at',today),
    supabase.from('blood_bank_requests').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('status','reaction_reported').gte('created_at',monthStart),
  ]);

  document.getElementById('k-avail').textContent = inv.count ?? 0;
  document.getElementById('k-pending').textContent = pending.count ?? 0;
  document.getElementById('k-issued').textContent = issued.count ?? 0;
  document.getElementById('k-reactions').textContent = reactions.count ?? 0;

  const exp7 = new Date(); exp7.setDate(exp7.getDate()+7);
  const expiring = (inv.data||[]).filter(b => b.expiry_date && new Date(b.expiry_date) <= exp7).length;
  document.getElementById('k-expiring').textContent = expiring;
}

window.loadRequests = async () => {
  const st = document.getElementById('f-req-status').value;
  const urg = document.getElementById('f-req-urgency').value;
  let q = supabase.from('blood_bank_requests').select(`*,patient:patients(name),requested_by:profiles!requested_by(full_name)`).eq('tenant_id',tenantId).order('created_at',{ascending:false});
  if (st) q = q.eq('status',st);
  if (urg) q = q.eq('urgency',urg);
  const {data,error} = await q.limit(100);
  const tb = document.getElementById('req-tbody');
  if (error||!data?.length){tb.innerHTML=`<tr><td colspan="8" class="empty">No requests found.</td></tr>`;return;}
  const urgColor = {emergency:'color:var(--red);font-weight:600',urgent:'color:var(--amber);font-weight:600',routine:''};
  tb.innerHTML = data.map(r=>`<tr>
    <td>${_esc(r.patient?.name||'—')}</td>
    <td><strong>${_esc(r.blood_group)}</strong></td>
    <td>${compLabel(r.component)}</td>
    <td>${r.units_requested}</td>
    <td style="${urgColor[r.urgency]||''}">${_esc(r.urgency)}</td>
    <td>${fmtDt(r.created_at)}</td>
    <td><span class="badge b-${r.status}">${statusLabel(r.status)}</span></td>
    <td style="white-space:nowrap">
      ${r.status==='requested'?`<button class="btn btn-sm btn-amber" data-onclick="openCM" data-onclick-a0="${r.id}">Cross-Match</button> `:''}
      ${r.status==='compatible'?`<button class="btn btn-sm btn-primary" data-onclick="issueBlood" data-onclick-a0="${r.id}">Issue</button> `:''}
      ${r.status==='issued'?`<button class="btn btn-sm btn-outline" data-onclick="markTransfused" data-onclick-a0="${r.id}">Transfused</button> `:''}
      ${r.status==='transfused'?`<button class="btn btn-sm btn-danger" data-onclick="reportReaction" data-onclick-a0="${r.id}">Reaction</button>`:''}
    </td>
  </tr>`).join('');
};

window.loadStockSummary = async () => {
  const {data} = await supabase.from('blood_bank_inventory').select('blood_group,component,status,expiry_date').eq('tenant_id',tenantId).eq('status','available');
  const grid = document.getElementById('stock-grid');
  if (!data?.length){grid.innerHTML=`<div style="color:var(--text-muted);font-size:13px;padding:16px">No stock available.</div>`;return;}
  const grouped = {};
  for (const b of data) {
    const key = b.blood_group;
    if (!grouped[key]) grouped[key] = {};
    if (!grouped[key][b.component]) grouped[key][b.component] = 0;
    grouped[key][b.component]++;
  }
  const groups = ['A+','A-','B+','B-','AB+','AB-','O+','O-'];
  const comps = ['packed_rbc','whole_blood','fresh_frozen_plasma','platelets'];
  grid.innerHTML = groups.map(g => {
    const total = Object.values(grouped[g]||{}).reduce((a,b)=>a+b,0);
    if (!total) return '';
    const breakdown = comps.filter(c=>(grouped[g]||{})[c]).map(c=>`${compShort(c)}: ${grouped[g][c]}`).join(', ');
    return `<div class="bg-card">
      <div class="bg-group">${g}</div>
      <div class="bg-comp">${breakdown||'—'}</div>
      <div class="bg-count">${total} units</div>
    </div>`;
  }).join('');
};

window.loadInventory = async () => {
  const grp = document.getElementById('f-inv-group').value;
  const comp = document.getElementById('f-inv-comp').value;
  const st = document.getElementById('f-inv-status').value;
  let q = supabase.from('blood_bank_inventory').select('*').eq('tenant_id',tenantId).order('expiry_date',{ascending:true});
  if (grp) q = q.eq('blood_group',grp);
  if (comp) q = q.eq('component',comp);
  if (st) q = q.eq('status',st);
  const {data} = await q.limit(200);
  const tb = document.getElementById('inv-tbody');
  if (!data?.length){tb.innerHTML=`<tr><td colspan="9" class="empty">No bags found.</td></tr>`;return;}
  const today = new Date();
  tb.innerHTML = data.map(b=>{
    const exp = new Date(b.expiry_date);
    const expCls = exp < today?'color:var(--red);font-weight:600':(exp-today)<7*864e5?'color:var(--amber);font-weight:600':'';
    return `<tr>
      <td><strong>${_esc(b.bag_number)}</strong></td>
      <td>${_esc(b.blood_group)}</td>
      <td>${compLabel(b.component)}</td>
      <td>${b.volume_ml||'—'} ml</td>
      <td>${_esc(b.donor_name||'—')}</td>
      <td>${b.collection_date||'—'}</td>
      <td style="${expCls}">${b.expiry_date}</td>
      <td><span class="badge b-${b.status}">${_esc(b.status)}</span></td>
      <td>${b.status==='available'?`<button class="btn btn-sm btn-danger" data-onclick="discardBag" data-onclick-a0="${b.id}">Discard</button>`:'—'}</td>
    </tr>`;
  }).join('');
};

window.loadCrossmatch = async () => {
  const {data} = await supabase.from('blood_bank_requests').select(`*,patient:patients(name)`).eq('tenant_id',tenantId).in('status',['requested','crossmatch_pending']).order('created_at');
  const tb = document.getElementById('cm-tbody');
  if (!data?.length){tb.innerHTML=`<tr><td colspan="7" class="empty">No pending cross-match requests.</td></tr>`;return;}
  const urgColor={emergency:'color:var(--red);font-weight:600',urgent:'color:var(--amber);font-weight:600',routine:''};
  tb.innerHTML = data.map(r=>`<tr>
    <td>${_esc(r.patient?.name||'—')}</td>
    <td><strong>${_esc(r.blood_group)}</strong></td>
    <td>${compLabel(r.component)}</td>
    <td>${r.units_requested}</td>
    <td style="${urgColor[r.urgency]||''}">${_esc(r.urgency)}</td>
    <td>${fmtDt(r.created_at)}</td>
    <td><button class="btn btn-sm btn-amber" data-onclick="openCM" data-onclick-a0="${r.id}">Update Result</button></td>
  </tr>`).join('');
};

window.openRequestModal = () => {
  ['r-patient','r-ipd','r-indication'].forEach(id=>document.getElementById(id).value='');
  ['r-group','r-component'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('r-urgency').value='routine';
  document.getElementById('req-modal').classList.add('show');
};

window.saveRequest = async () => {
  const patient_name = document.getElementById('r-patient').value.trim();
  const blood_group = document.getElementById('r-group').value;
  const component = document.getElementById('r-component').value;
  const units = parseInt(document.getElementById('r-units').value)||1;
  const urgency = document.getElementById('r-urgency').value;
  if (!patient_name||!blood_group||!component){showToast('Fill patient, blood group and component','error');return;}

  let patient_id = null;
  const {data:pts} = await supabase.from('patients').select('id').eq('tenant_id',tenantId).ilike('name','%'+patient_name+'%').limit(1);
  if (pts?.length) patient_id = pts[0].id;

  const {error} = await supabase.from('blood_bank_requests').insert({
    tenant_id:tenantId, patient_id, blood_group, component,
    units_requested:units, urgency,
    indication:document.getElementById('r-indication').value.trim()||null,
    requested_by:profile.id, status:'requested'
  });
  if (error){showToast('Error: '+error.message,'error');return;}
  closeModal('req-modal');
  showToast('Request submitted','success');
  loadRequests(); loadKPIs();
};

window.openBagModal = () => {
  ['b-bag','b-vol','b-donor-name','b-donor-id','b-notes'].forEach(id=>document.getElementById(id).value='');
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('b-collected').value = today;
  document.getElementById('bag-modal').classList.add('show');
};

window.saveBag = async () => {
  const blood_group = document.getElementById('b-group').value;
  const component = document.getElementById('b-component').value;
  const bag_number = document.getElementById('b-bag').value.trim();
  const expiry_date = document.getElementById('b-expiry').value;
  const collection_date = document.getElementById('b-collected').value;
  if (!blood_group||!component||!bag_number||!expiry_date||!collection_date){showToast('Fill required fields','error');return;}
  const {error} = await supabase.from('blood_bank_inventory').insert({
    tenant_id:tenantId, blood_group, component, bag_number,
    collection_date, expiry_date, status:'available',
    volume_ml:parseInt(document.getElementById('b-vol').value)||null,
    donor_name:document.getElementById('b-donor-name').value.trim()||null,
    donor_id:document.getElementById('b-donor-id').value.trim()||null,
    notes:document.getElementById('b-notes').value.trim()||null,
    created_by:profile.id
  });
  if (error){showToast('Error: '+error.message,'error');return;}
  closeModal('bag-modal');
  showToast('Blood bag added','success');
  loadInventory(); loadStockSummary(); loadKPIs();
};

window.openCM = (reqId) => {
  document.getElementById('cm-req-id').value = reqId;
  ['cm-bag','cm-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('cm-result').value='compatible';
  document.getElementById('cm-modal').classList.add('show');
};

window.saveCrossmatch = async () => {
  const id = document.getElementById('cm-req-id').value;
  const result = document.getElementById('cm-result').value;
  const bag = document.getElementById('cm-bag').value.trim();
  const newStatus = result==='compatible'?'compatible':(result==='incompatible'?'cancelled':'crossmatch_pending');
  const {error} = await supabase.from('blood_bank_requests').update({
    crossmatch_done:true, crossmatch_result:result,
    bag_number:bag||null, status:newStatus,
    notes:document.getElementById('cm-notes').value.trim()||null
  }).eq('id',id).eq('tenant_id',tenantId);
  if (error){showToast('Error: '+error.message,'error');return;}
  closeModal('cm-modal');
  showToast('Cross-match updated','success');
  loadRequests(); loadCrossmatch(); loadKPIs();
};

window.issueBlood = async (id) => {
  if (!confirm('Mark this blood unit as issued to patient?')) return;
  const {error} = await supabase.from('blood_bank_requests').update({status:'issued',issued_at:new Date().toISOString(),issued_by:profile.id}).eq('id',id).eq('tenant_id',tenantId);
  if (error){showToast('Error: '+error.message,'error');return;}
  await supabase.from('blood_bank_inventory').update({status:'issued'}).eq('tenant_id',tenantId).eq('status','reserved');
  showToast('Blood issued','success');
  loadRequests(); loadKPIs();
};

window.markTransfused = async (id) => {
  const {error} = await supabase.from('blood_bank_requests').update({status:'transfused',transfusion_completed_at:new Date().toISOString()}).eq('id',id).eq('tenant_id',tenantId);
  if (!error) { showToast('Marked as transfused','success'); loadRequests(); }
};

window.reportReaction = async (id) => {
  const details = prompt('Describe the transfusion reaction:');
  if (details===null) return;
  const {error} = await supabase.from('blood_bank_requests').update({status:'reaction_reported',reaction_observed:true,reaction_details:details}).eq('id',id).eq('tenant_id',tenantId);
  if (!error) { showToast('Reaction reported','success'); loadRequests(); loadKPIs(); }
};

window.discardBag = async (id) => {
  if (!confirm('Mark this blood bag as discarded?')) return;
  await supabase.from('blood_bank_inventory').update({status:'discarded'}).eq('id',id).eq('tenant_id',tenantId);
  showToast('Bag discarded','success');
  loadInventory(); loadStockSummary(); loadKPIs();
};

window.closeModal = id => document.getElementById(id).classList.remove('show');

function compLabel(c){const m={whole_blood:'Whole Blood',packed_rbc:'Packed RBC',fresh_frozen_plasma:'FFP',platelets:'Platelets',cryoprecipitate:'Cryo',single_donor_platelets:'SDP'};return m[c]||c;}
function compShort(c){const m={whole_blood:'WB',packed_rbc:'PRBC',fresh_frozen_plasma:'FFP',platelets:'PLT',cryoprecipitate:'Cryo',single_donor_platelets:'SDP'};return m[c]||c;}
function statusLabel(s){const m={requested:'Requested',crossmatch_pending:'CM Pending',compatible:'Compatible',issued:'Issued',transfused:'Transfused',reaction_reported:'Reaction',cancelled:'Cancelled'};return m[s]||s;}
function fmtDt(dt){if(!dt)return'—';const d=new Date(dt);return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});}
function showToast(msg,type='success'){const t=document.getElementById('toast');t.textContent=msg;t.className=`toast ${type} show`;setTimeout(()=>t.classList.remove('show'),3000);}

loadRequests();
loadKPIs();
