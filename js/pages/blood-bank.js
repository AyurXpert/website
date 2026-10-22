import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { todayLocalStr, istDayStartUTC } from '../utils/dateUtils.js';
import { notify } from '../components/notify.js';

// Session 353B (D5): + lab_tech -- the blood bank technician (designation blood_bank_technician) records stock, cross-match and issue
await requireAuth(['super_admin','dept_admin','doctor','nurse','lab_tech']);
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
  const today = todayLocalStr();
  const monthStart = today.slice(0,7)+'-01';

  const [inv, pending, issued, reactions] = await Promise.all([
    supabase.from('blood_bank_inventory').select('id,expiry_date',{count:'exact'}).eq('tenant_id',tenantId).eq('status','available'),
    supabase.from('blood_bank_requests').select('id',{count:'exact'}).eq('tenant_id',tenantId).in('status',['requested','crossmatch_pending']),
    supabase.from('blood_bank_requests').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('status','issued').gte('issued_at',istDayStartUTC(today)),
    supabase.from('blood_bank_requests').select('id',{count:'exact'}).eq('tenant_id',tenantId).eq('status','reaction_reported').gte('created_at',istDayStartUTC(monthStart)),
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

// TODO §247 (a), owner 21 Oct 2026: a blood request is filed for the patient CHOSEN here -- a UHID (exact), or one of the listed
// name / phone matches picked by a click -- never the first name match (the server also refuses a request with no patient)
let _reqPatient = null;
let _reqMatches = [];
function _ptLine(p) {
  const meta = [p.uhid || 'no UHID', [p.age ? 'Age ' + p.age : '', (p.gender || '').charAt(0).toUpperCase()].filter(Boolean).join(' '),
    p.phone ? 'Ph …' + String(p.phone).slice(-4) : ''].filter(Boolean).join(' · ');
  return { name: p.name || '—', meta };
}
function _showChosen() {
  const el = document.getElementById('r-patient-chosen');
  el.replaceChildren();
  if (!_reqPatient) { el.hidden = true; return; }
  const l = _ptLine(_reqPatient);
  el.textContent = '✓ ' + l.name + ' — ' + l.meta;
  el.hidden = false;
}
function _showMatches(list, note) {
  const el = document.getElementById('r-patient-matches');
  el.replaceChildren();
  list.forEach(p => {
    const l = _ptLine(p);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pt-match';
    b.dataset.onclick = 'chooseReqPatient'; b.dataset.onclickA0 = p.id;
    b.textContent = l.name;
    const m = document.createElement('span'); m.className = 'pt-match-meta'; m.textContent = l.meta;
    b.appendChild(m);
    el.appendChild(b);
  });
  if (note) { const n = document.createElement('div'); n.className = 'pt-note'; n.textContent = note; el.appendChild(n); }
  el.hidden = !list.length && !note;
}
window.clearReqPatient = () => { _reqPatient = null; _reqMatches = []; _showChosen(); _showMatches([], ''); };
window.findReqPatient = async () => {
  const q = document.getElementById('r-patient').value.trim();
  window.clearReqPatient();
  if (!q) { showToast('Type the UHID, a name or a phone number first.', 'error'); return; }
  let hits = [];
  if (/^AYX[\s\-\/]*\d/i.test(q)) {
    // Session 321: a UHID must resolve to exactly one patient (stored UHID, tenant server-side)
    const { data, error } = await supabase.rpc('find_patient_by_uhid', { p_uhid: q });
    if (error) { showToast(safeErrorMessage(error, 'Could not look up that UHID.'), 'error'); return; }
    if (data?.length === 1) { _reqPatient = data[0]; _showChosen(); return; }
    _showMatches([], data?.length ? 'That UHID matches more than one patient — type the full UHID.' : 'No patient found with that UHID.');
    return;
  }
  const digits = q.replace(/\D/g, '');
  let req = supabase.from('patients').select('id,uhid,name,phone,age,gender').eq('tenant_id', tenantId).order('name').limit(21);
  if (/^\d{10}$/.test(digits) && digits.length === q.replace(/[\s\-+]/g, '').length) req = req.eq('phone', digits);
  else {
    const name = q.replace(/[%_,()*\\]/g, ' ').trim();
    if (name.length < 2) { showToast('Type at least 2 letters of the name.', 'error'); return; }
    req = req.ilike('name', '%' + name + '%');
  }
  const { data, error } = await req;
  if (error) { showToast(safeErrorMessage(error, 'Could not search patients.'), 'error'); return; }
  hits = data || [];
  _reqMatches = hits.slice(0, 20);
  _showMatches(_reqMatches, !hits.length ? 'No patient found — check the spelling, or use the UHID.'
    : hits.length > 20 ? 'More than 20 matches — type more of the name, or use the UHID.' : 'Choose the patient.');
};
window.chooseReqPatient = (id) => {
  const p = _reqMatches.find(x => x.id === id);
  if (!p) return;
  _reqPatient = p; _reqMatches = [];
  _showMatches([], ''); _showChosen();
};

window.openRequestModal = () => {
  ['r-patient','r-ipd','r-indication'].forEach(id=>document.getElementById(id).value='');
  window.clearReqPatient();
  ['r-group','r-component'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('r-urgency').value='routine';
  document.getElementById('req-modal').classList.add('show');
};

window.saveRequest = async () => {
  const blood_group = document.getElementById('r-group').value;
  const component = document.getElementById('r-component').value;
  const units = parseInt(document.getElementById('r-units').value)||1;
  const urgency = document.getElementById('r-urgency').value;
  if (!_reqPatient) { showToast('Choose the patient first: type the UHID, a name or a phone number, press 🔍 Find, then pick the patient.','error'); return; }
  if (!blood_group||!component){showToast('Fill blood group and component','error');return;}
  const patient_id = _reqPatient.id;

  const {error} = await supabase.from('blood_bank_requests').insert({
    tenant_id:tenantId, patient_id, blood_group, component,
    units_requested:units, urgency,
    indication:document.getElementById('r-indication').value.trim()||null,
    requested_by:profile.id, status:'requested'
  });
  if (error){showToast(safeErrorMessage(error, 'Could not submit request.'),'error');return;}
  closeModal('req-modal');
  showToast('Request submitted','success');
  loadRequests(); loadKPIs();
};

window.openBagModal = () => {
  ['b-bag','b-vol','b-donor-name','b-donor-id','b-notes'].forEach(id=>document.getElementById(id).value='');
  const today = todayLocalStr();
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
  if (error){showToast(safeErrorMessage(error, 'Could not add blood bag.'),'error');return;}
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
  if (error){showToast(safeErrorMessage(error, 'Could not update cross-match.'),'error');return;}
  closeModal('cm-modal');
  showToast('Cross-match updated','success');
  loadRequests(); loadCrossmatch(); loadKPIs();
};

window.issueBlood = async (id) => {
  if (!confirm('Mark this blood unit as issued to patient?')) return;
  // Session 353B: ONE server step -- the request's own bag (same organisation, available, not expired, same group / component) and the
  // request are marked issued together (the old page marked EVERY reserved bag of the organisation issued, and never this one)
  const {error} = await supabase.rpc('issue_blood_unit', { p_request: id });
  if (error){showToast(safeErrorMessage(error, 'Could not issue blood.'),'error');return;}
  showToast('Blood issued','success');
  loadRequests(); loadKPIs();
};

window.markTransfused = async (id) => {
  const {error} = await supabase.from('blood_bank_requests').update({status:'transfused',transfusion_completed_at:new Date().toISOString()}).eq('id',id).eq('tenant_id',tenantId);
  if (error) { showToast(safeErrorMessage(error, 'Could not mark as transfused.'),'error'); return; }
  showToast('Marked as transfused','success'); loadRequests();
};

window.reportReaction = async (id) => {
  const details = prompt('Describe the transfusion reaction:');
  if (details===null) return;
  const {error} = await supabase.from('blood_bank_requests').update({status:'reaction_reported',reaction_observed:true,reaction_details:details}).eq('id',id).eq('tenant_id',tenantId);
  if (error) { showToast(safeErrorMessage(error, 'Could not report the reaction.'),'error'); return; }
  showToast('Reaction reported','success'); loadRequests(); loadKPIs();
};

window.discardBag = async (id) => {
  if (!confirm('Mark this blood bag as discarded?')) return;
  const {error} = await supabase.from('blood_bank_inventory').update({status:'discarded'}).eq('id',id).eq('tenant_id',tenantId);
  if (error) { showToast(safeErrorMessage(error, 'Could not discard the bag.'),'error'); return; }
  showToast('Bag discarded','success');
  loadInventory(); loadStockSummary(); loadKPIs();
};

window.closeModal = id => document.getElementById(id).classList.remove('show');

function compLabel(c){const m={whole_blood:'Whole Blood',packed_rbc:'Packed RBC',fresh_frozen_plasma:'FFP',platelets:'Platelets',cryoprecipitate:'Cryo',single_donor_platelets:'SDP'};return m[c]||c;}
function compShort(c){const m={whole_blood:'WB',packed_rbc:'PRBC',fresh_frozen_plasma:'FFP',platelets:'PLT',cryoprecipitate:'Cryo',single_donor_platelets:'SDP'};return m[c]||c;}
function statusLabel(s){const m={requested:'Requested',crossmatch_pending:'CM Pending',compatible:'Compatible',issued:'Issued',transfused:'Transfused',reaction_reported:'Reaction',cancelled:'Cancelled'};return m[s]||s;}
function fmtDt(dt){if(!dt)return'—';const d=new Date(dt);return d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});}
function showToast(msg,type='success') { notify(msg, type); }   // Session 323: shared top-layer notify()

loadRequests();
loadKPIs();
