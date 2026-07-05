import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse','receptionist'], 'index.html');
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const now      = new Date();
const todayStr = now.toISOString().split('T')[0];

// Defaults
document.getElementById('c-date').value          = todayStr;
document.getElementById('cycle-view-date').value = todayStr;
document.getElementById('bi-date').value         = todayStr;
document.getElementById('c-start').value         = now.toTimeString().slice(0,5);
document.getElementById('bi-incub-start').value  = now.toTimeString().slice(0,5);

// Sterility expiry presets (days) by packaging
const EXPIRY_DAYS = { drum:30, peel_pouch:90, cloth_wrap:30, rigid_container:180, eto_bag:365 };

window.updateExpiry = function() {
  const pack = document.getElementById('c-pack').value;
  const days = EXPIRY_DAYS[pack] || 30;
  const exp  = new Date(now); exp.setDate(exp.getDate() + days);
  document.getElementById('c-expiry').value = exp.toISOString().split('T')[0];
};
updateExpiry(); // set initial

// Chemical/Biological indicator select — colour class follows the chosen result
window.updateIndClass = function(el) {
  el.className = 'ind-sel ' + (el.value === 'pass' ? 'pass' : el.value === 'fail' ? 'fail' : '');
};

// Tab switching
document.querySelectorAll('.module-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.module-tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'bi')        loadBITable();
    if (btn.dataset.tab === 'equipment') loadEquipGrid();
  });
});
document.getElementById('cycle-view-date').addEventListener('change', () => loadCycleTable());

// ─── Boot ────────────────────────────────────────────────
window.loadAll = async function() {
  await Promise.all([loadEquipSelectors(), loadDepts(), loadStats(), loadCycleTable(), loadComplianceBanner()]);
};

// ─── Selectors ────────────────────────────────────────────
async function loadEquipSelectors() {
  const { data } = await supabase.from('sterilisation_equipment').select('id,name,type').eq('tenant_id',tenantId).eq('is_active',true).order('name');
  const opts = '<option value="">— Select Equipment —</option>' + (data||[]).map(e=>`<option value="${e.id}">${_esc(e.name)}</option>`).join('');
  window._equipOpts = opts;
  document.getElementById('c-equip').innerHTML  = opts;
  document.getElementById('bi-equip').innerHTML = opts;
}

async function loadDepts() {
  const { data } = await supabase.from('departments').select('id,name').eq('tenant_id',tenantId).eq('is_active',true).order('name');
  const opts = '<option value="">— Select —</option>' + (data||[]).map(d=>`<option value="${d.id}">${_esc(d.name)}</option>`).join('');
  document.getElementById('c-dept').innerHTML = opts;
}

// ─── Stats ────────────────────────────────────────────────
async function loadStats() {
  const weekStart = (() => { const d=new Date(now); d.setDate(d.getDate()-d.getDay()); return d.toISOString().split('T')[0]; })();
  const thirtyAgo = new Date(now); thirtyAgo.setDate(thirtyAgo.getDate()-30);
  const sevenAgo  = new Date(now); sevenAgo.setDate(sevenAgo.getDate()-7);

  const [todayRes, weekRes, failRes, expiryRes, equipRes] = await Promise.all([
    supabase.from('sterilisation_cycles').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('cycle_date',todayStr),
    supabase.from('sterilisation_cycles').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('cycle_date',weekStart),
    supabase.from('sterilisation_cycles').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('biological_indicator','fail').gte('cycle_date',thirtyAgo.toISOString().split('T')[0]),
    supabase.from('sterilisation_cycles').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('sterility_expiry_date',todayStr).lte('sterility_expiry_date',sevenAgo.toISOString().split('T')[0]),
    supabase.from('sterilisation_equipment').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('is_active',true),
  ]);

  document.getElementById('s-today').textContent    = todayRes.count ?? '—';
  document.getElementById('s-week').textContent     = weekRes.count ?? '—';
  document.getElementById('s-fail').textContent     = failRes.count ?? '0';
  document.getElementById('s-expiring').textContent = expiryRes.count ?? '0';
  document.getElementById('s-equip').textContent    = equipRes.count ?? '—';
}

// ─── BI Compliance Banner ─────────────────────────────────
async function loadComplianceBanner() {
  const banner = document.getElementById('compliance-banner');
  const { data, error } = await supabase.from('sterilisation_cycles')
    .select('cycle_date,sterilisation_equipment(name)')
    .eq('tenant_id',tenantId)
    .in('biological_indicator',['pass','fail'])
    .order('cycle_date',{ascending:false}).limit(1);

  if (error?.code === '42P01') {
    banner.className = 'compliance-banner amber';
    banner.innerHTML = `<div class="cb-icon">🔧</div><div class="cb-body"><div class="cb-title">SQL not yet run</div><div class="cb-sub">Run sterilisation_cycles and sterilisation_equipment SQL in Supabase to activate this module.</div></div>`;
    return;
  }

  const last = data?.[0];
  if (!last) {
    banner.className = 'compliance-banner red';
    banner.innerHTML = `<div class="cb-icon">🚨</div><div class="cb-body"><div class="cb-title">No Biological Indicator test on record</div><div class="cb-sub">CSSD protocol requires weekly BI (spore) testing for every autoclave. Log the first BI test immediately.</div></div>`;
    return;
  }

  const daysSince = Math.floor((now - new Date(last.cycle_date)) / 86400000);
  const equip     = _esc(last.sterilisation_equipment?.name || 'unknown equipment');
  if (daysSince <= 5) {
    banner.className = 'compliance-banner green';
    banner.innerHTML = `<div class="cb-icon">✅</div><div class="cb-body"><div class="cb-title">BI testing current — last test ${daysSince === 0 ? 'today' : daysSince + ' days ago'} on ${equip}</div><div class="cb-sub">Next BI test due within ${7-daysSince} day${7-daysSince!==1?'s':''}. Weekly protocol maintained.</div></div>`;
  } else if (daysSince <= 7) {
    banner.className = 'compliance-banner amber';
    banner.innerHTML = `<div class="cb-icon">⚠️</div><div class="cb-body"><div class="cb-title">BI test due — ${daysSince} days since last test (${last.cycle_date})</div><div class="cb-sub">Perform biological indicator test today on all autoclaves to maintain weekly CSSD protocol.</div></div>`;
  } else {
    banner.className = 'compliance-banner red';
    banner.innerHTML = `<div class="cb-icon">🚨</div><div class="cb-body"><div class="cb-title">BI test OVERDUE — ${daysSince} days since last test (${last.cycle_date}) on ${equip}</div><div class="cb-sub">Weekly biological indicator testing is mandatory. All processed loads since last successful BI should be considered suspect. Test and document immediately.</div></div>`;
  }
}

// ─── Save Cycle ────────────────────────────────────────────
let _cycleData = [];
window.saveCycle = async function() {
  const btn   = document.getElementById('c-save-btn');
  const equip = document.getElementById('c-equip').value;
  const date  = document.getElementById('c-date').value;
  if (!equip || !date) { showAlert('cycle-alert','Equipment and date are required','error'); return; }
  btn.disabled = true;

  const bi     = document.getElementById('c-bi').value;
  const status = document.getElementById('c-status').value;

  const { error } = await supabase.from('sterilisation_cycles').insert({
    tenant_id:          tenantId,
    recorded_by:        profile.id,
    cycle_date:         date,
    equipment_id:       equip,
    cycle_no:           parseInt(document.getElementById('c-cycle-no').value)||null,
    requesting_dept_id: document.getElementById('c-dept').value||null,
    load_description:   document.getElementById('c-load').value.trim()||null,
    item_count:         parseInt(document.getElementById('c-count').value)||null,
    packaging_type:     document.getElementById('c-pack').value,
    start_time:         document.getElementById('c-start').value||null,
    end_time:           document.getElementById('c-end').value||null,
    duration_min:       parseInt(document.getElementById('c-dur').value)||null,
    temperature_c:      parseFloat(document.getElementById('c-temp').value)||null,
    pressure_psi:       parseFloat(document.getElementById('c-press').value)||null,
    sterility_expiry_date: document.getElementById('c-expiry').value||null,
    chemical_indicator: document.getElementById('c-ci').value,
    biological_indicator: bi,
    status,
    released_by:        document.getElementById('c-released').value.trim()||null,
    remarks:            document.getElementById('c-remarks').value.trim()||null,
  });

  btn.disabled = false;
  if (error) {
    if (error.code==='42P01') showAlert('cycle-alert','Run sterilisation_cycles SQL in Supabase first','error');
    else showAlert('cycle-alert', safeErrorMessage(error, 'Could not save cycle.'),'error');
    return;
  }

  if (bi === 'fail') {
    showAlert('cycle-alert','⚠ FAILED BI recorded. Quarantine all loads since last pass. Root cause analysis required.','error');
  } else {
    showAlert('cycle-alert','Cycle recorded ✓','success');
  }

  ['c-cycle-no','c-count','c-start','c-end','c-dur','c-temp','c-press','c-released','c-remarks'].forEach(id=>{document.getElementById(id).value='';});
  document.getElementById('c-load').value = '';
  document.getElementById('c-ci').value = 'pass'; document.getElementById('c-ci').className='ind-sel pass';
  document.getElementById('c-bi').value = 'not_done'; document.getElementById('c-bi').className='ind-sel';
  document.getElementById('c-status').value = 'completed';
  updateExpiry();
  loadCycleTable(); loadStats(); loadComplianceBanner();
};

window.loadCycleTable = async function() {
  const date  = document.getElementById('cycle-view-date').value || todayStr;
  const tbody = document.getElementById('cycle-tbody');
  document.getElementById('cycle-table-title').textContent = date === todayStr ? "Today's Cycles" : 'Cycles — ' + date;
  tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div></td></tr>';

  const { data, error } = await supabase.from('sterilisation_cycles')
    .select('*,sterilisation_equipment(name,type),departments!requesting_dept_id(name)')
    .eq('tenant_id',tenantId).eq('cycle_date',date)
    .order('created_at',{ascending:false});

  if (error) {
    if (error.code==='42P01') tbody.innerHTML='<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div></td></tr>';
    else tbody.innerHTML=`<tr><td colspan="9"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load cycles.'))}</div></div></td></tr>`;
    return;
  }
  _cycleData = data || [];
  if (!_cycleData.length) { tbody.innerHTML='<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔄</div><div class="empty-ttl">No cycles for this date</div></div></td></tr>'; return; }

  // §21p — Build department utilization summary
  const utilEl = document.getElementById('cssd-utilization');
  if (utilEl) {
    const deptCounts = {};
    _cycleData.forEach(r => {
      const dn = r.departments?.name || 'Unspecified';
      if (!deptCounts[dn]) deptCounts[dn] = { cycles: 0, items: 0 };
      deptCounts[dn].cycles++;
      deptCounts[dn].items += r.item_count || 0;
    });
    const total = _cycleData.length;
    utilEl.innerHTML = Object.entries(deptCounts).length === 0
      ? '<span style="color:var(--text-muted)">No data</span>'
      : Object.entries(deptCounts).map(([dept, d]) => {
          const pct = total > 0 ? Math.round(d.cycles / total * 100) : 0;
          return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <div style="width:140px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(dept)}</div>
            <div style="flex:1;height:12px;background:#f0f4f2;border-radius:6px;overflow:hidden">
              <div style="height:100%;background:var(--green-mid);width:${pct}%;border-radius:6px"></div>
            </div>
            <div style="font-size:11px;color:var(--text-muted);white-space:nowrap">${d.cycles} cycle${d.cycles!==1?'s':''} · ${d.items} items · ${pct}%</div>
          </div>`;
        }).join('') + `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px">Total: ${total} cycles for ${date}</div>`;
  }

  tbody.innerHTML = _cycleData.map(r=>{
    const expiry    = r.sterility_expiry_date;
    const expDays   = expiry ? Math.floor((new Date(expiry)-now)/86400000) : null;
    const expCls    = expDays === null ? '' : expDays < 0 ? 'expiry-expired' : expDays <= 7 ? 'expiry-soon' : 'expiry-ok';
    const expTxt    = expDays === null ? '—' : expDays < 0 ? `Expired ${Math.abs(expDays)}d ago` : expDays === 0 ? 'Expires today' : `${expDays}d`;
    const biResult  = r.biological_indicator || 'not_done';
    const rowCls    = (r.status === 'failed' || r.biological_indicator === 'fail') ? 'row-failed' : '';
    return `<tr class="${rowCls}">
      <td style="font-weight:700">#${r.cycle_no||'—'}<br><span style="font-size:10px;color:var(--text-muted)">${r.start_time||''}</span></td>
      <td style="font-size:12px;font-weight:500">${_esc(r.sterilisation_equipment?.name||'—')}</td>
      <td style="font-size:12px">${_esc(r.departments?.name||'—')}</td>
      <td style="font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(r.load_description||'')}">${_esc(r.load_description||'—')}</td>
      <td style="font-size:12px">${r.temperature_c!=null?r.temperature_c+'°C':''} ${r.duration_min!=null?'/ '+r.duration_min+'min':''}</td>
      <td>${_indChip(r.chemical_indicator,'CI')}</td>
      <td>${_indChip(biResult,'BI')}</td>
      <td class="${expCls}" style="font-size:12px;white-space:nowrap">${expTxt}</td>
      <td><span class="chip chip-${r.status}">${r.status}</span></td>
    </tr>`;
  }).join('');
};

window.exportCyclesCSV = function() {
  if (!_cycleData.length) { _toast('No data'); return; }
  const rows=[['Date','Cycle#','Equipment','Dept','Load','Temp(°C)','Pressure(psi)','Duration(min)','Packaging','CI','BI','Expiry','Status','Released By','Remarks'],
    ..._cycleData.map(r=>[r.cycle_date,r.cycle_no||'',r.sterilisation_equipment?.name||'',r.departments?.name||'',r.load_description||'',r.temperature_c||'',r.pressure_psi||'',r.duration_min||'',r.packaging_type||'',r.chemical_indicator||'',r.biological_indicator||'',r.sterility_expiry_date||'',r.status||'',r.released_by||'',r.remarks||''])];
  _downloadCSV(rows, 'Sterilisation_Cycles_'+document.getElementById('cycle-view-date').value+'.csv');
};

// ─── BI Testing ───────────────────────────────────────────
let _biData = [];
window.saveBI = async function() {
  const btn    = document.getElementById('bi-save-btn');
  const equip  = document.getElementById('bi-equip').value;
  const result = document.getElementById('bi-result').value;
  if (!equip) { showAlert('bi-alert','Select equipment','error'); return; }
  btn.disabled = true;

  const { error } = await supabase.from('sterilisation_cycles').insert({
    tenant_id:   tenantId,
    recorded_by: profile.id,
    cycle_date:  document.getElementById('bi-date').value,
    equipment_id: equip,
    cycle_no:    parseInt(document.getElementById('bi-cycle').value)||null,
    biological_indicator: result,
    bi_spore_type: document.getElementById('bi-spore').value,
    bi_incub_start: document.getElementById('bi-incub-start').value||null,
    bi_read_hrs:   parseInt(document.getElementById('bi-read-hrs').value)||48,
    bi_lot_no:     document.getElementById('bi-lot').value.trim()||null,
    released_by:   document.getElementById('bi-tested-by').value.trim()||null,
    remarks:       document.getElementById('bi-remarks').value.trim()||null,
    status:        result === 'fail' ? 'failed' : result === 'pending' ? 'quarantine' : 'completed',
    load_description: 'BI Test cycle',
  });

  btn.disabled = false;
  if (error) {
    if (error.code==='42P01') showAlert('bi-alert','Run sterilisation_cycles SQL in Supabase first','error');
    else showAlert('bi-alert',safeErrorMessage(error, 'Could not save BI test.'),'error');
    return;
  }

  if (result === 'fail') {
    showAlert('bi-alert','⚠ FAILED BI — Quarantine all loads since last successful BI. Investigate and re-test immediately.','error');
  } else {
    showAlert('bi-alert','BI test recorded ✓','success');
  }
  ['bi-cycle','bi-lot','bi-tested-by','bi-remarks'].forEach(id=>{document.getElementById(id).value='';});
  loadBITable(); loadComplianceBanner(); loadStats();
};

async function loadBITable() {
  const tbody   = document.getElementById('bi-tbody');
  const ninetyAgo = new Date(now); ninetyAgo.setDate(ninetyAgo.getDate()-90);
  const { data, error } = await supabase.from('sterilisation_cycles')
    .select('*,sterilisation_equipment(name)')
    .eq('tenant_id',tenantId)
    .neq('biological_indicator','not_done')
    .not('biological_indicator','is',null)
    .gte('cycle_date', ninetyAgo.toISOString().split('T')[0])
    .order('cycle_date',{ascending:false}).order('created_at',{ascending:false});

  if (error) {
    if (error.code==='42P01') tbody.innerHTML='<tr><td colspan="8"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div></div></td></tr>';
    else tbody.innerHTML=`<tr><td colspan="8"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load BI tests.'))}</div></div></td></tr>`;
    return;
  }
  _biData = data || [];
  if (!_biData.length) { tbody.innerHTML='<tr><td colspan="8"><div class="empty"><div class="empty-ico">🧫</div><div class="empty-ttl">No BI tests in last 90 days</div></div></td></tr>'; return; }
  tbody.innerHTML = _biData.map(r=>`<tr class="${r.biological_indicator==='fail'?'row-failed':''}">
    <td style="font-weight:600">${r.cycle_date}</td>
    <td style="font-size:12px">${_esc(r.sterilisation_equipment?.name||'—')}</td>
    <td style="text-align:center">${r.cycle_no||'—'}</td>
    <td style="font-size:12px">${_esc(r.bi_spore_type?.replace('_',' ')||'—')}</td>
    <td style="text-align:center">${r.bi_read_hrs||48}h</td>
    <td>${_indChip(r.biological_indicator,'BI')}</td>
    <td style="font-size:12px">${_esc(r.released_by||'—')}</td>
    <td style="font-size:11px;color:var(--text-muted)">${_esc(r.bi_lot_no||'—')}</td>
  </tr>`).join('');
}

window.exportBICSV = function() {
  const rows=[['Date','Equipment','Cycle#','Spore Type','Read (h)','Result','Tested By','Lot No.','Remarks'],
    ..._biData.map(r=>[r.cycle_date,r.sterilisation_equipment?.name||'',r.cycle_no||'',r.bi_spore_type||'',r.bi_read_hrs||48,r.biological_indicator||'',r.released_by||'',r.bi_lot_no||'',r.remarks||''])];
  _downloadCSV(rows,'BI_Test_Log.csv');
};

// ─── Equipment Register ───────────────────────────────────
let _editEquipId = null;
let _equipData   = [];
window.openEquipModal = function(id=null) {
  const e = id ? _equipData.find(x => x.id === id) : null;
  _editEquipId = e?.id || null;
  document.getElementById('equip-modal-title').textContent = e ? 'Edit Equipment' : 'Add Sterilisation Equipment';
  ['em-id','em-name','em-type','em-make','em-model','em-serial','em-location','em-installed','em-capacity','em-last-svc','em-next-svc','em-last-cal','em-next-cal','em-remarks'].forEach(fid=>{
    const el=document.getElementById(fid);
    if(el) el.value = e ? (e[fid.replace('em-','').replace(/-/g,'_')] || '') : '';
  });
  if(e){
    document.getElementById('em-id').value         = e.id;
    document.getElementById('em-name').value       = e.name||'';
    document.getElementById('em-type').value       = e.type||'';
    document.getElementById('em-make').value       = e.make||'';
    document.getElementById('em-model').value      = e.model_no||'';
    document.getElementById('em-serial').value     = e.serial_no||'';
    document.getElementById('em-location').value   = e.location||'';
    document.getElementById('em-installed').value  = e.installation_date||'';
    document.getElementById('em-capacity').value   = e.capacity_litres||'';
    document.getElementById('em-last-svc').value   = e.last_service_date||'';
    document.getElementById('em-next-svc').value   = e.next_service_due||'';
    document.getElementById('em-last-cal').value   = e.last_calibration_date||'';
    document.getElementById('em-next-cal').value   = e.next_calibration_due||'';
    document.getElementById('em-remarks').value    = e.remarks||'';
  }
  document.getElementById('equip-overlay').classList.add('show');
};
window.closeEquipModal = function() { document.getElementById('equip-overlay').classList.remove('show'); };

window.saveEquipment = async function() {
  const btn  = document.getElementById('em-save-btn');
  const name = document.getElementById('em-name').value.trim();
  const type = document.getElementById('em-type').value;
  if (!name || !type) { showAlert('equip-alert','Name and type are required','error'); return; }
  btn.disabled = true;

  const payload = {
    tenant_id: tenantId, name, type,
    make:                document.getElementById('em-make').value.trim()||null,
    model_no:            document.getElementById('em-model').value.trim()||null,
    serial_no:           document.getElementById('em-serial').value.trim()||null,
    location:            document.getElementById('em-location').value.trim()||null,
    installation_date:   document.getElementById('em-installed').value||null,
    capacity_litres:     parseFloat(document.getElementById('em-capacity').value)||null,
    last_service_date:   document.getElementById('em-last-svc').value||null,
    next_service_due:    document.getElementById('em-next-svc').value||null,
    last_calibration_date: document.getElementById('em-last-cal').value||null,
    next_calibration_due:  document.getElementById('em-next-cal').value||null,
    remarks:             document.getElementById('em-remarks').value.trim()||null,
    is_active:           true,
  };

  let error;
  if (_editEquipId) {
    ({ error } = await supabase.from('sterilisation_equipment').update(payload).eq('id',_editEquipId).eq('tenant_id',tenantId));
  } else {
    ({ error } = await supabase.from('sterilisation_equipment').insert(payload));
  }
  btn.disabled = false;
  if (error) {
    if (error.code==='42P01') showAlert('equip-alert','Run sterilisation_equipment SQL in Supabase first','error');
    else showAlert('equip-alert',safeErrorMessage(error, 'Could not save equipment record.'),'error');
    return;
  }
  closeEquipModal();
  _toast(_editEquipId ? 'Equipment updated ✓' : 'Equipment added ✓');
  loadEquipGrid(); loadEquipSelectors(); loadStats();
};

async function loadEquipGrid() {
  const wrap = document.getElementById('equip-grid');
  const { data, error } = await supabase.from('sterilisation_equipment').select('*').eq('tenant_id',tenantId).order('name');
  if (error) {
    if (error.code==='42P01') { wrap.innerHTML='<div class="empty" style="grid-column:1/-1"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run sterilisation_equipment SQL in Supabase</div></div>'; return; }
    wrap.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load equipment.'))}</div></div>`; return;
  }
  _equipData = data || [];
  if (!_equipData.length) { wrap.innerHTML='<div class="empty" style="grid-column:1/-1"><div class="empty-ico">⚙</div><div class="empty-ttl">No equipment registered yet</div><div class="empty-bod">Add your autoclaves and other sterilisation equipment to start tracking</div></div>'; return; }

  wrap.innerHTML = _equipData.map(e=>{
    const svcDue = e.next_service_due ? Math.floor((new Date(e.next_service_due)-now)/86400000) : null;
    const calDue = e.next_calibration_due ? Math.floor((new Date(e.next_calibration_due)-now)/86400000) : null;
    const cardCls = (svcDue!==null&&svcDue<0)||(calDue!==null&&calDue<0) ? 'equip-card service-overdue'
                  : (svcDue!==null&&svcDue<=30)||(calDue!==null&&calDue<=30) ? 'equip-card service-due'
                  : 'equip-card';
    const dateLine = (val, label) => {
      if (!val) return `<div class="equip-date-item"><div class="equip-date-label">${label}</div><div class="equip-date-val" style="color:var(--text-muted)">Not set</div></div>`;
      const days = Math.floor((new Date(val)-now)/86400000);
      const cls  = days < 0 ? 'overdue' : days <= 30 ? 'warn' : '';
      const txt  = days < 0 ? `${val} ⚠ ${Math.abs(days)}d overdue` : days <= 30 ? `${val} · ${days}d left` : val;
      return `<div class="equip-date-item"><div class="equip-date-label">${label}</div><div class="equip-date-val ${cls}">${txt}</div></div>`;
    };
    return `<div class="${cardCls}">
      <div class="equip-name">${_esc(e.name)}</div>
      <div class="equip-type">${_typeLabel(e.type)} ${e.serial_no?'· S/N: '+_esc(e.serial_no):''} ${e.capacity_litres?'· '+e.capacity_litres+'L':''}</div>
      <div class="equip-dates">
        ${dateLine(e.next_service_due,'Next Service')}
        ${dateLine(e.next_calibration_due,'Next Calibration')}
        <div class="equip-date-item"><div class="equip-date-label">Make / Location</div><div class="equip-date-val" style="font-weight:400;color:var(--text-mid)">${_esc(e.make||'—')} ${e.location?'· '+_esc(e.location):''}</div></div>
        <div class="equip-date-item" style="display:flex;align-items:center;justify-content:flex-end;background:none">
          <button class="btn btn-secondary btn-sm" data-onclick="openEquipModal" data-onclick-a0="${e.id}">Edit</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ─── Helpers ─────────────────────────────────────────────
function _typeLabel(t){
  return {autoclave_gravity:'Autoclave (Gravity)',autoclave_prevac:'Autoclave (Pre-vac/Class B)',eto:'ETO',dry_heat:'Dry Heat',microwave:'Microwave CSSD',chemical:'Chemical',plasma:'H₂O₂ Plasma'}[t]||t||'—';
}
function _indChip(v, lbl) {
  if (!v || v==='not_done') return `<span class="chip chip-nd">${lbl} —</span>`;
  if (v==='pass')    return `<span class="chip chip-pass">${lbl} ✓</span>`;
  if (v==='fail')    return `<span class="chip chip-fail" style="font-size:11px">${lbl} ✗ FAIL</span>`;
  if (v==='pending') return `<span class="chip chip-pending">${lbl} ⏳</span>`;
  return `<span class="chip chip-nd">${v}</span>`;
}
function showAlert(id,msg,type){ const el=document.getElementById(id); el.textContent=msg; el.className=`alert ${type} show`; setTimeout(()=>el.classList.remove('show'),5000); }
function _downloadCSV(rows,filename){ const csv=rows.map(r=>Array.isArray(r)?r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','):`"${r}"`).join('\n'); const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv); a.download=filename; a.click(); }
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg,isErr=false){ const el=document.getElementById('toast'); el.textContent=msg; el.style.background=isErr?'#7f1d1d':'#1c2b1f'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

// Boot
await loadAll();
