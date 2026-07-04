import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin'], 'index.html');
initNavbar();
wireDelegatedEvents();
const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const todayStr = new Date().toISOString().slice(0,10);
const monthStr = new Date().toISOString().slice(0,7);
document.getElementById('util-month').value  = monthStr;
document.getElementById('maint-month').value = monthStr;
document.getElementById('df-date').value     = todayStr;
document.getElementById('uf-date').value     = todayStr;
document.getElementById('mf-date').value     = todayStr;

let _equipment = [], _drills = [], _extinguishers = [], _utilities = [], _maintenance = [];

const CAT_LABELS = {
  diagnostic:'Diagnostic', monitoring:'Monitoring', therapeutic:'Therapeutic',
  life_support:'Life Support', surgical:'Surgical', radiology:'Radiology',
  laboratory:'Laboratory', general:'General'
};
const UTIL_LABELS = {
  generator:'Generator/DG', ups:'UPS', water_supply:'Water Supply', water_quality:'Water Quality',
  hvac:'HVAC/AC', electrical:'Electrical', plumbing:'Plumbing', lift:'Lift',
  oxygen_pipeline:'O₂ Pipeline', other:'Other'
};
const MAINT_LABELS = {
  ppm:'PPM', breakdown:'Breakdown', calibration:'Calibration', amc_service:'AMC Service', inspection:'Inspection'
};

// ── Tab switch ────────────────────────────────────────────
window.switchTab = function(t) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-'+t).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.dataset.tab === t) b.classList.add('active');
  });
  if (t==='fire') { loadDrills(); loadExtinguishers(); }
  if (t==='utilities') loadUtilities();
  if (t==='maintenance') loadMaintenance();
};

// ── Load all ─────────────────────────────────────────────
async function loadAll() {
  await Promise.all([loadEquipment(), loadDrills(), loadExtinguishers(), loadKPIs()]);
}

async function loadEquipment() {
  const { data } = await supabase.from('equipment_register')
    .select('*').eq('tenant_id', tenantId).order('category').order('name');
  _equipment = data || [];
  // Populate dept filter
  const depts = [...new Set(_equipment.map(e => e.department).filter(Boolean))].sort();
  const sel = document.getElementById('eq-dept');
  sel.innerHTML = '<option value="">All Departments</option>' +
    depts.map(d => `<option value="${d}">${d}</option>`).join('');
  // Populate maintenance equipment dropdown
  document.getElementById('mf-equip').innerHTML = '<option value="">— Select equipment —</option>' +
    _equipment.filter(e => e.status==='active').map(e => `<option value="${e.id}">${e.name}${e.asset_code?' ('+e.asset_code+')':''}</option>`).join('');
  renderEquipment();
  loadKPIs();
}

async function loadDrills() {
  const yr = new Date().getFullYear();
  const { data } = await supabase.from('fire_drill_records')
    .select('*').eq('tenant_id', tenantId)
    .gte('drill_date', yr+'-01-01').order('drill_date', { ascending: false });
  _drills = data || [];
  renderDrills();
}

async function loadExtinguishers() {
  const { data } = await supabase.from('fire_extinguisher_register')
    .select('*').eq('tenant_id', tenantId).order('extinguisher_no');
  _extinguishers = data || [];
  renderExtinguishers();
}

window.loadUtilities = async function() {
  const m = document.getElementById('util-month').value;
  const [y, mo] = m.split('-').map(Number);
  const start = new Date(y, mo-1, 1).toISOString().slice(0,10);
  const end   = new Date(y, mo, 0).toISOString().slice(0,10);
  const { data } = await supabase.from('utility_maintenance_log')
    .select('*').eq('tenant_id', tenantId)
    .gte('log_date', start).lte('log_date', end)
    .order('log_date', { ascending: false });
  _utilities = data || [];
  renderUtilities();
};

window.loadMaintenance = async function() {
  const m = document.getElementById('maint-month').value;
  const [y, mo] = m.split('-').map(Number);
  const start = new Date(y, mo-1, 1).toISOString().slice(0,10);
  const end   = new Date(y, mo, 0).toISOString().slice(0,10);
  const { data } = await supabase.from('equipment_maintenance_log')
    .select('*, equipment_register(name,asset_code)').eq('tenant_id', tenantId)
    .gte('performed_date', start).lte('performed_date', end)
    .order('performed_date', { ascending: false });
  _maintenance = data || [];
  renderMaintenance();
};

// ── KPI ──────────────────────────────────────────────────
function loadKPIs() {
  const today = new Date(); today.setHours(0,0,0,0);
  const in30  = new Date(today); in30.setDate(in30.getDate()+30);
  const active = _equipment.filter(e => e.status==='active');
  const ppmOver = active.filter(e => e.next_ppm_date && new Date(e.next_ppm_date) < today).length;
  const amcExp  = active.filter(e => e.amc_expiry && new Date(e.amc_expiry) <= in30 && new Date(e.amc_expiry) >= today).length;
  const extDue  = _extinguishers.filter(e => e.next_inspection && new Date(e.next_inspection) < today && e.condition !== 'condemned').length;
  document.getElementById('k-eq').textContent       = active.length;
  document.getElementById('k-ppm-over').textContent = ppmOver;
  document.getElementById('k-amc').textContent      = amcExp;
  document.getElementById('k-drills').textContent   = _drills.length;
  document.getElementById('k-ext-due').textContent  = extDue;
  // Overdue banner
  const banner = document.getElementById('overdue-banner');
  const items = [];
  if (ppmOver)  items.push(`${ppmOver} equipment PPM overdue`);
  if (extDue)   items.push(`${extDue} extinguisher inspection overdue`);
  if (items.length) { banner.style.display=''; banner.textContent='⚠ '+items.join(' · '); }
  else banner.style.display = 'none';
}

// ── Render Equipment ─────────────────────────────────────
window.renderEquipment = function() {
  const q    = document.getElementById('eq-search').value.toLowerCase();
  const cat  = document.getElementById('eq-cat').value;
  const dept = document.getElementById('eq-dept').value;
  const st   = document.getElementById('eq-status').value;
  const today = new Date(); today.setHours(0,0,0,0);
  const in30  = new Date(today); in30.setDate(in30.getDate()+30);
  const rows = _equipment.filter(e => {
    if (cat && e.category !== cat) return false;
    if (dept && e.department !== dept) return false;
    if (st === 'active' && e.status !== 'active') return false;
    if (q && !(e.name.toLowerCase().includes(q) || (e.asset_code||'').toLowerCase().includes(q) || (e.department||'').toLowerCase().includes(q))) return false;
    return true;
  });
  const grid = document.getElementById('eq-grid');
  if (!rows.length) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1">No equipment found</div>'; return; }
  grid.innerHTML = rows.map(e => {
    const ppmClass = e.next_ppm_date ? (new Date(e.next_ppm_date) < today ? 'ppm-overdue' : new Date(e.next_ppm_date) <= in30 ? 'ppm-due' : '') : '';
    const ppmCls   = e.next_ppm_date ? (new Date(e.next_ppm_date) < today ? 'rl-red' : new Date(e.next_ppm_date) <= in30 ? 'rl-amber' : 'rl-green') : '';
    const calCls   = e.next_calibration_date ? (new Date(e.next_calibration_date) < today ? 'rl-red' : new Date(e.next_calibration_date) <= in30 ? 'rl-amber' : 'rl-green') : '';
    const badgeMap = { active:'b-active', under_repair:'b-repair', decommissioned:'b-decommissioned', condemned:'b-condemned' };
    const certBtn  = e.calibration_cert_url ? `<a href="${e.calibration_cert_url}" target="_blank" class="btn btn-outline btn-sm" style="text-decoration:none">📜 Cert</a>` : '';
    return `<div class="eq-card ${ppmClass}">
      <div class="eq-name">${e.name}</div>
      <div class="eq-code">${e.asset_code||'—'} · ${CAT_LABELS[e.category]||e.category} · <span class="badge ${badgeMap[e.status]||'b-active'}" style="font-size:10px">${e.status}</span></div>
      <div class="eq-row"><span class="eq-label">Make/Model</span><span class="eq-val">${e.make||'—'}${e.model?' / '+e.model:''}</span></div>
      <div class="eq-row"><span class="eq-label">Serial No.</span><span class="eq-val">${e.serial_number||'—'}</span></div>
      <div class="eq-row"><span class="eq-label">Location</span><span class="eq-val">${e.department||'—'}</span></div>
      <div class="eq-row"><span class="eq-label">Next PPM</span><span class="eq-val ${ppmCls}">${e.next_ppm_date||'—'}</span></div>
      <div class="eq-row"><span class="eq-label">Next Calibration</span><span class="eq-val ${calCls}">${e.next_calibration_date||'—'}</span></div>
      <div class="eq-row"><span class="eq-label">AMC Vendor</span><span class="eq-val">${e.amc_vendor||'—'}</span></div>
      <div class="eq-row"><span class="eq-label">AMC Expiry</span><span class="eq-val ${e.amc_expiry && new Date(e.amc_expiry)<in30?'rl-amber':''}">${e.amc_expiry||'—'}</span></div>
      <div class="eq-actions">
        ${certBtn}
        <button class="btn btn-outline btn-sm" data-onclick="editEquipment" data-onclick-a0="${e.id}">Edit</button>
        <button class="btn btn-outline btn-sm" data-onclick="logPPM" data-onclick-a0="${e.id}" data-onclick-a1="${_esc(e.name)}">Log PPM</button>
      </div>
    </div>`;
  }).join('');
};

// ── Render Drills ─────────────────────────────────────────
function renderDrills() {
  // Check compliance — 2 drills/year minimum
  const drillBanner = document.getElementById('drill-overdue');
  if (_drills.length < 2) {
    drillBanner.style.display = '';
    drillBanner.textContent   = `⚠ Only ${_drills.length} drill(s) recorded this year — NABH requires minimum 2 drills per year.`;
  } else drillBanner.style.display = 'none';
  document.getElementById('k-drills').textContent = _drills.length;
  const DTYPE = { fire:'🔥 Fire', earthquake:'🏚 Earthquake', mass_casualty:'🚨 MCI', flood:'🌊 Flood', power_failure:'⚡ Power Failure', chemical_spill:'☣ Chemical Spill' };
  const tbody = document.getElementById('drill-tbody');
  if (!_drills.length) { tbody.innerHTML = '<tr><td colspan="8"><div class="empty">No drills recorded this year</div></td></tr>'; return; }
  tbody.innerHTML = _drills.map(d => `<tr>
    <td style="white-space:nowrap">${d.drill_date}${d.drill_time?' '+d.drill_time:''}</td>
    <td>${DTYPE[d.drill_type]||d.drill_type}</td>
    <td>${d.location_covered||'—'}</td>
    <td style="text-align:center">${d.participants_count||0}</td>
    <td style="text-align:center;font-weight:500">${d.evacuation_time_min ? d.evacuation_time_min+' min' : '—'}</td>
    <td style="font-size:12px;max-width:200px">${d.observations ? d.observations.slice(0,80)+(d.observations.length>80?'…':'') : '—'}</td>
    <td style="white-space:nowrap">${d.next_drill_date||'—'}</td>
    <td><button class="btn btn-outline btn-sm" data-onclick="deleteDrill" data-onclick-a0="${d.id}">Delete</button></td>
  </tr>`).join('');
}

// ── Render Extinguishers ──────────────────────────────────
function renderExtinguishers() {
  const today = new Date(); today.setHours(0,0,0,0);
  const due   = _extinguishers.filter(e => e.next_inspection && new Date(e.next_inspection) < today && e.condition !== 'condemned').length;
  document.getElementById('k-ext-due').textContent = due;
  const tbody = document.getElementById('ext-tbody');
  if (!_extinguishers.length) { tbody.innerHTML = '<tr><td colspan="9"><div class="empty">No extinguishers registered</div></td></tr>'; return; }
  tbody.innerHTML = _extinguishers.map(e => {
    const niCls = e.next_inspection && new Date(e.next_inspection) < today ? 'rl-red' : '';
    const badgeMap = { good:'b-good', needs_refill:'b-needs_refill', condemned:'b-condemned', replaced:'b-decommissioned' };
    return `<tr>
      <td><strong>${e.extinguisher_no}</strong></td>
      <td>${e.type}</td>
      <td>${e.location}</td>
      <td>${e.capacity||'—'}</td>
      <td>${e.last_refilled||'—'}</td>
      <td>${e.last_inspection||'—'}</td>
      <td class="${niCls}" style="font-weight:500">${e.next_inspection}</td>
      <td><span class="badge ${badgeMap[e.condition]||'b-good'}">${e.condition}</span></td>
      <td><button class="btn btn-outline btn-sm" data-onclick="editExtinguisher" data-onclick-a0="${e.id}">Edit</button></td>
    </tr>`;
  }).join('');
}

// ── Render Utilities ─────────────────────────────────────
window.renderUtilities = function() {
  const tf = document.getElementById('util-type').value;
  const rows = _utilities.filter(r => !tf || r.utility_type === tf);
  // Summary cards
  const types = [...new Set(_utilities.map(r => r.utility_type))];
  document.getElementById('util-summary').innerHTML = types.map(t => {
    const entries = _utilities.filter(r => r.utility_type === t);
    const latest  = entries[0];
    const issues  = entries.filter(r => !r.is_compliant).length;
    return `<div style="background:var(--white);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);margin-bottom:4px">${UTIL_LABELS[t]||t}</div>
      <div style="font-size:13px;font-weight:500">${entries.length} entries this month</div>
      <div style="font-size:12px;color:${issues?'var(--red)':'var(--text-muted)'}">Last: ${latest?.log_date||'—'}${issues?' · ⚠ '+issues+' issue(s)':''}</div>
    </div>`;
  }).join('');
  const tbody = document.getElementById('util-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8"><div class="empty">No utility logs for this period</div></td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `<tr>
    <td style="white-space:nowrap">${r.log_date}</td>
    <td><strong>${UTIL_LABELS[r.utility_type]||r.utility_type}</strong></td>
    <td style="font-size:12px;max-width:200px">${r.description.slice(0,80)}${r.description.length>80?'…':''}</td>
    <td style="font-size:12px">${r.performed_by||'—'}</td>
    <td style="font-size:12px">${r.result||'—'}</td>
    <td style="text-align:center">${r.is_compliant ? '✅' : '❌'}</td>
    <td style="font-size:12px;color:${r.issues_found?'var(--red)':'var(--text-muted)'}">${r.issues_found ? r.issues_found.slice(0,60) : '—'}</td>
    <td style="white-space:nowrap">${r.next_due_date||'—'}</td>
  </tr>`).join('');
};

// ── Render Maintenance ───────────────────────────────────
window.renderMaintenance = function() {
  const tf = document.getElementById('maint-type').value;
  const rows = _maintenance.filter(r => !tf || r.maintenance_type === tf);
  const tbody = document.getElementById('maint-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty">No maintenance logs for this period</div></td></tr>'; return; }
  tbody.innerHTML = rows.map(r => {
    const stMap = { completed:'b-active', pending:'b-repair', in_progress:'b-needs_refill' };
    return `<tr>
      <td style="white-space:nowrap">${r.performed_date}</td>
      <td style="font-weight:500">${r.equipment_register?.name||'—'}<br/><span style="font-size:11px;color:var(--text-muted)">${r.equipment_register?.asset_code||''}</span></td>
      <td>${MAINT_LABELS[r.maintenance_type]||r.maintenance_type}</td>
      <td style="font-size:12px">${r.performed_by||r.vendor_engineer||'—'}</td>
      <td style="font-size:12px;max-width:180px">${(r.description||'—').slice(0,80)}</td>
      <td style="text-align:center">${r.downtime_hours||0}</td>
      <td><span class="badge ${stMap[r.status]||'b-active'}">${r.status}</span></td>
    </tr>`;
  }).join('');
};

// ── Equipment CRUD ───────────────────────────────────────
window.openEqModal = function(id) {
  document.getElementById('eq-modal').style.display = 'flex';
  document.getElementById('eq-modal-title').textContent = id ? 'Edit Equipment' : 'Add Equipment';
  if (!id) {
    ['eq-edit-id','ef-code','ef-name','ef-make','ef-model','ef-serial','ef-dept',
     'ef-install','ef-warranty','ef-amc-vendor','ef-amc-contact','ef-amc-start',
     'ef-amc-expiry','ef-last-ppm','ef-next-ppm','ef-last-cal','ef-next-cal','ef-cert-url','ef-notes']
     .forEach(id => document.getElementById(id).value = '');
    document.getElementById('ef-ppm-interval').value = '6';
    document.getElementById('ef-cat').value = 'monitoring';
    document.getElementById('ef-status').value = 'active';
  }
};
window.closeEqModal = () => document.getElementById('eq-modal').style.display = 'none';

window.editEquipment = function(id) {
  const e = _equipment.find(x => x.id===id); if (!e) return;
  openEqModal(id);
  document.getElementById('eq-edit-id').value   = e.id;
  document.getElementById('ef-code').value      = e.asset_code||'';
  document.getElementById('ef-cat').value       = e.category;
  document.getElementById('ef-name').value      = e.name;
  document.getElementById('ef-make').value      = e.make||'';
  document.getElementById('ef-model').value     = e.model||'';
  document.getElementById('ef-serial').value    = e.serial_number||'';
  document.getElementById('ef-dept').value      = e.department||'';
  document.getElementById('ef-install').value   = e.installation_date||'';
  document.getElementById('ef-warranty').value  = e.warranty_expiry||'';
  document.getElementById('ef-amc-vendor').value= e.amc_vendor||'';
  document.getElementById('ef-amc-contact').value=e.amc_contact||'';
  document.getElementById('ef-amc-start').value = e.amc_start||'';
  document.getElementById('ef-amc-expiry').value= e.amc_expiry||'';
  document.getElementById('ef-ppm-interval').value= e.ppm_interval_months||6;
  document.getElementById('ef-last-ppm').value  = e.last_ppm_date||'';
  document.getElementById('ef-next-ppm').value  = e.next_ppm_date||'';
  document.getElementById('ef-last-cal').value  = e.last_calibration_date||'';
  document.getElementById('ef-next-cal').value  = e.next_calibration_date||'';
  document.getElementById('ef-cert-url').value  = e.calibration_cert_url||'';
  document.getElementById('ef-status').value    = e.status;
  document.getElementById('ef-notes').value     = e.notes||'';
};

window.saveEquipment = async function() {
  const name = document.getElementById('ef-name').value.trim();
  if (!name) { toast('Equipment name is required', 'error'); return; }
  const payload = {
    tenant_id:             tenantId,
    asset_code:            document.getElementById('ef-code').value.trim()||null,
    category:              document.getElementById('ef-cat').value,
    name,
    make:                  document.getElementById('ef-make').value.trim()||null,
    model:                 document.getElementById('ef-model').value.trim()||null,
    serial_number:         document.getElementById('ef-serial').value.trim()||null,
    department:            document.getElementById('ef-dept').value.trim()||null,
    installation_date:     document.getElementById('ef-install').value||null,
    warranty_expiry:       document.getElementById('ef-warranty').value||null,
    amc_vendor:            document.getElementById('ef-amc-vendor').value.trim()||null,
    amc_contact:           document.getElementById('ef-amc-contact').value.trim()||null,
    amc_start:             document.getElementById('ef-amc-start').value||null,
    amc_expiry:            document.getElementById('ef-amc-expiry').value||null,
    ppm_interval_months:   parseInt(document.getElementById('ef-ppm-interval').value)||6,
    last_ppm_date:         document.getElementById('ef-last-ppm').value||null,
    next_ppm_date:         document.getElementById('ef-next-ppm').value||null,
    last_calibration_date: document.getElementById('ef-last-cal').value||null,
    next_calibration_date: document.getElementById('ef-next-cal').value||null,
    calibration_cert_url:  document.getElementById('ef-cert-url').value.trim()||null,
    status:                document.getElementById('ef-status').value,
    notes:                 document.getElementById('ef-notes').value.trim()||null,
    created_by:            profile.id,
    updated_at:            new Date().toISOString(),
  };
  const editId = document.getElementById('eq-edit-id').value;
  let err;
  if (editId) { ({ error:err } = await supabase.from('equipment_register').update(payload).eq('id',editId)); }
  else        { ({ error:err } = await supabase.from('equipment_register').insert(payload)); }
  if (err) { toast('Save failed: '+err.message, 'error'); return; }
  toast(editId?'Equipment updated':'Equipment added', 'success');
  closeEqModal(); loadEquipment();
};

window.logPPM = function(id, name) {
  const e = _equipment.find(x=>x.id===id); if(!e) return;
  openMaintModal();
  document.getElementById('mf-equip').value = id;
  document.getElementById('mf-type').value  = 'ppm';
  switchTab('maintenance');
  toast(`Logging PPM for: ${name}`, 'success');
};

window.exportEqCSV = function() {
  const rows = _equipment.map(e => [
    e.asset_code||'', e.name, CAT_LABELS[e.category]||e.category,
    e.make||'', e.serial_number||'', e.department||'',
    e.next_ppm_date||'', e.next_calibration_date||'', e.amc_vendor||'', e.amc_expiry||'', e.status
  ]);
  const csv = [['Code','Name','Category','Make','Serial','Department','Next PPM','Next Calibration','AMC Vendor','AMC Expiry','Status'], ...rows]
    .map(r => r.map(c=>`"${c}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`equipment_register_${new Date().toISOString().slice(0,10)}.csv`; a.click();
};

// ── Drill CRUD ───────────────────────────────────────────
window.openDrillModal  = () => document.getElementById('drill-modal').style.display='flex';
window.closeDrillModal = () => document.getElementById('drill-modal').style.display='none';

window.saveDrill = async function() {
  const date = document.getElementById('df-date').value;
  if (!date) { toast('Date is required', 'error'); return; }
  const payload = {
    tenant_id:          tenantId,
    drill_date:         date,
    drill_time:         document.getElementById('df-time').value||null,
    drill_type:         document.getElementById('df-type').value,
    location_covered:   document.getElementById('df-location').value.trim()||null,
    participants_count: parseInt(document.getElementById('df-participants').value)||0,
    coordinator:        document.getElementById('df-coordinator').value.trim()||null,
    evacuation_time_min:parseFloat(document.getElementById('df-evac-time').value)||null,
    observations:       document.getElementById('df-observations').value.trim()||null,
    deficiencies:       document.getElementById('df-deficiencies').value.trim()||null,
    corrective_actions: document.getElementById('df-corrective').value.trim()||null,
    next_drill_date:    document.getElementById('df-next').value||null,
    conducted_by:       profile.id,
  };
  const { error } = await supabase.from('fire_drill_records').insert(payload);
  if (error) { toast('Save failed: '+error.message, 'error'); return; }
  toast('Drill record saved', 'success'); closeDrillModal(); loadDrills();
};

window.deleteDrill = async function(id) {
  if (!confirm('Delete this drill record?')) return;
  await supabase.from('fire_drill_records').delete().eq('id',id);
  toast('Deleted', 'success'); loadDrills();
};

window.exportDrillCSV = function() {
  const rows = _drills.map(d => [d.drill_date, d.drill_type, d.location_covered||'', d.participants_count, d.evacuation_time_min||'', d.observations||'', d.deficiencies||'', d.corrective_actions||'']);
  const csv = [['Date','Type','Location','Participants','Evacuation(min)','Observations','Deficiencies','Corrective Actions'], ...rows]
    .map(r => r.map(c=>`"${c}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`fire_drill_register_${new Date().getFullYear()}.csv`; a.click();
};

// ── Extinguisher CRUD ─────────────────────────────────────
window.openExtModal  = (id) => { document.getElementById('ext-modal').style.display='flex'; if(!id){ ['extf-id','extf-no','extf-location','extf-capacity','extf-install','extf-refill','extf-last-insp','extf-next-insp','extf-insp-by','extf-notes'].forEach(i=>document.getElementById(i).value=''); document.getElementById('extf-type').value='CO2'; document.getElementById('extf-condition').value='good'; document.getElementById('ext-modal-title').textContent='Add Fire Extinguisher'; } };
window.closeExtModal = () => document.getElementById('ext-modal').style.display='none';

window.editExtinguisher = function(id) {
  const e = _extinguishers.find(x=>x.id===id); if(!e) return;
  openExtModal(id);
  document.getElementById('ext-modal-title').textContent='Edit Extinguisher';
  document.getElementById('extf-id').value         = e.id;
  document.getElementById('extf-no').value         = e.extinguisher_no;
  document.getElementById('extf-type').value       = e.type;
  document.getElementById('extf-location').value   = e.location;
  document.getElementById('extf-capacity').value   = e.capacity||'';
  document.getElementById('extf-install').value    = e.installation_date||'';
  document.getElementById('extf-refill').value     = e.last_refilled||'';
  document.getElementById('extf-last-insp').value  = e.last_inspection||'';
  document.getElementById('extf-next-insp').value  = e.next_inspection||'';
  document.getElementById('extf-insp-by').value    = e.inspected_by||'';
  document.getElementById('extf-condition').value  = e.condition;
  document.getElementById('extf-notes').value      = e.notes||'';
};

window.saveExtinguisher = async function() {
  const no  = document.getElementById('extf-no').value.trim();
  const loc = document.getElementById('extf-location').value.trim();
  const nxt = document.getElementById('extf-next-insp').value;
  if (!no || !loc || !nxt) { toast('No., Location and Next Inspection are required', 'error'); return; }
  const payload = {
    tenant_id:         tenantId,
    extinguisher_no:   no,
    type:              document.getElementById('extf-type').value,
    location:          loc,
    capacity:          document.getElementById('extf-capacity').value.trim()||null,
    installation_date: document.getElementById('extf-install').value||null,
    last_refilled:     document.getElementById('extf-refill').value||null,
    last_inspection:   document.getElementById('extf-last-insp').value||null,
    next_inspection:   nxt,
    inspected_by:      document.getElementById('extf-insp-by').value.trim()||null,
    condition:         document.getElementById('extf-condition').value,
    notes:             document.getElementById('extf-notes').value.trim()||null,
    created_by:        profile.id,
    updated_at:        new Date().toISOString(),
  };
  const editId = document.getElementById('extf-id').value;
  let err;
  if (editId) { ({ error:err } = await supabase.from('fire_extinguisher_register').update(payload).eq('id',editId)); }
  else        { ({ error:err } = await supabase.from('fire_extinguisher_register').insert(payload)); }
  if (err) { toast('Save failed: '+err.message, 'error'); return; }
  toast('Saved', 'success'); closeExtModal(); loadExtinguishers();
};

// ── Utility CRUD ─────────────────────────────────────────
window.openUtilModal  = () => { document.getElementById('util-modal').style.display='flex'; document.getElementById('uf-date').value=todayStr; document.getElementById('uf-compliant').checked=true; ['uf-by','uf-result','uf-next','uf-issues','uf-corrective'].forEach(i=>document.getElementById(i).value=''); document.getElementById('uf-desc').value=''; };
window.closeUtilModal = () => document.getElementById('util-modal').style.display='none';

window.saveUtility = async function() {
  const desc = document.getElementById('uf-desc').value.trim();
  const date = document.getElementById('uf-date').value;
  if (!desc || !date) { toast('Date and description required', 'error'); return; }
  const payload = {
    tenant_id:         tenantId,
    utility_type:      document.getElementById('uf-type').value,
    log_date:          date,
    description:       desc,
    performed_by:      document.getElementById('uf-by').value.trim()||null,
    result:            document.getElementById('uf-result').value.trim()||null,
    next_due_date:     document.getElementById('uf-next').value||null,
    is_compliant:      document.getElementById('uf-compliant').checked,
    issues_found:      document.getElementById('uf-issues').value.trim()||null,
    corrective_action: document.getElementById('uf-corrective').value.trim()||null,
    created_by:        profile.id,
  };
  const { error } = await supabase.from('utility_maintenance_log').insert(payload);
  if (error) { toast('Save failed: '+error.message, 'error'); return; }
  toast('Logged', 'success'); closeUtilModal(); loadUtilities();
};

window.exportUtilCSV = function() {
  const rows = _utilities.map(r => [r.log_date, UTIL_LABELS[r.utility_type]||r.utility_type, r.description, r.performed_by||'', r.result||'', r.is_compliant?'Yes':'No', r.issues_found||'', r.next_due_date||'']);
  const csv = [['Date','Utility','Description','Performed By','Result','Compliant','Issues','Next Due'], ...rows]
    .map(r=>r.map(c=>`"${c}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`utility_log_${new Date().toISOString().slice(0,10)}.csv`; a.click();
};

// ── Maintenance CRUD ─────────────────────────────────────
window.openMaintModal  = () => { document.getElementById('maint-modal').style.display='flex'; document.getElementById('mf-date').value=todayStr; ['mf-by','mf-vendor','mf-desc','mf-next'].forEach(i=>document.getElementById(i).value=''); document.getElementById('mf-downtime').value='0'; document.getElementById('mf-cost').value=''; document.getElementById('mf-status').value='completed'; document.getElementById('mf-type').value='ppm'; };
window.closeMaintModal = () => document.getElementById('maint-modal').style.display='none';

window.saveMaintenance = async function() {
  const equipId = document.getElementById('mf-equip').value;
  const date    = document.getElementById('mf-date').value;
  if (!equipId || !date) { toast('Equipment and date are required', 'error'); return; }
  const payload = {
    tenant_id:        tenantId,
    equipment_id:     equipId,
    maintenance_type: document.getElementById('mf-type').value,
    performed_date:   date,
    performed_by:     document.getElementById('mf-by').value.trim()||null,
    vendor_engineer:  document.getElementById('mf-vendor').value.trim()||null,
    description:      document.getElementById('mf-desc').value.trim()||null,
    downtime_hours:   parseFloat(document.getElementById('mf-downtime').value)||0,
    next_due_date:    document.getElementById('mf-next').value||null,
    cost:             parseFloat(document.getElementById('mf-cost').value)||null,
    status:           document.getElementById('mf-status').value,
    created_by:       profile.id,
  };
  // Update next PPM date on equipment if PPM type
  if (payload.maintenance_type === 'ppm' && payload.next_due_date) {
    await supabase.from('equipment_register').update({ next_ppm_date: payload.next_due_date, last_ppm_date: date, updated_at: new Date().toISOString() }).eq('id', equipId);
  }
  if (payload.maintenance_type === 'calibration' && payload.next_due_date) {
    await supabase.from('equipment_register').update({ next_calibration_date: payload.next_due_date, last_calibration_date: date, updated_at: new Date().toISOString() }).eq('id', equipId);
  }
  const { error } = await supabase.from('equipment_maintenance_log').insert(payload);
  if (error) { toast('Save failed: '+error.message, 'error'); return; }
  toast('Maintenance logged', 'success'); closeMaintModal(); loadMaintenance(); loadEquipment();
};

window.exportMaintCSV = function() {
  const rows = _maintenance.map(r => [r.performed_date, r.equipment_register?.name||'', MAINT_LABELS[r.maintenance_type]||r.maintenance_type, r.performed_by||'', r.description||'', r.downtime_hours||0, r.status]);
  const csv = [['Date','Equipment','Type','Performed By','Description','Downtime hrs','Status'], ...rows]
    .map(r=>r.map(c=>`"${c}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`maintenance_log_${new Date().toISOString().slice(0,10)}.csv`; a.click();
};

// ── Toast ─────────────────────────────────────────────────
function toast(msg, type='success') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  setTimeout(() => el.className='toast', 2800);
}

loadAll();
