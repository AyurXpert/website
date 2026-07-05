import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse']);
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};
window._stopProp = function(e) { e.stopPropagation(); };

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const userId   = profile?.id;

let _viewDate    = new Date().toISOString().slice(0,10);
let _allCases    = [];
let _activeFilter= 'all';
let _activeId    = null;
let _foundPt     = null;
let _doctors     = [];

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const { data } = await supabase.from('profiles')
    .select('id,full_name,role').eq('tenant_id',tenantId).eq('is_active',true)
    .in('role',['doctor','super_admin','dept_admin']).order('full_name');
  _doctors = data || [];
  const surgSel  = document.getElementById('n-surgeon');
  const anaesSel = document.getElementById('n-anaes-dr');
  _doctors.forEach(d => {
    const o1 = new Option(d.full_name, d.id);
    const o2 = new Option(d.full_name, d.id);
    surgSel.appendChild(o1);
    anaesSel.appendChild(o2);
  });
  // default surgeon to logged-in doctor
  if (profile?.role === 'doctor') surgSel.value = userId;
  renderDateNav();
  loadCases();
}

// ── Date nav ──────────────────────────────────────────────────────────────────
function renderDateNav() {
  const d = new Date(_viewDate + 'T00:00:00');
  document.getElementById('date-display').textContent =
    d.toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  document.getElementById('date-picker').value = _viewDate;
  const isToday = _viewDate === new Date().toISOString().slice(0,10);
  document.getElementById('today-chip').style.display = isToday ? '' : 'none';
}
window.shiftDate  = d => { const dt=new Date(_viewDate); dt.setDate(dt.getDate()+Number(d)); _viewDate=dt.toISOString().slice(0,10); renderDateNav(); loadCases(); };
window.onDatePick = () => { _viewDate=document.getElementById('date-picker').value; renderDateNav(); loadCases(); };
window.goToday    = () => { _viewDate=new Date().toISOString().slice(0,10); renderDateNav(); loadCases(); };

// ── Load cases ────────────────────────────────────────────────────────────────
async function loadCases() {
  const { data, error } = await supabase
    .from('ot_cases')
    .select(`id,serial_no,procedure_name,case_type,procedure_category,pre_op_diagnosis,post_op_diagnosis,
             anaesthesia_type,ot_table,scheduled_date,scheduled_time,actual_start,actual_end,
             status,post_op_condition,created_at,
             patients(id,name,phone,age,gender),
             profiles!surgeon_id(full_name)`)
    .eq('tenant_id', tenantId)
    .eq('scheduled_date', _viewDate)
    .order('scheduled_time', { ascending: true, nullsFirst: false });

  if (error) { _alert('error',safeErrorMessage(error, 'Failed to load OT cases.')); return; }
  _allCases = data || [];
  renderStats();
  renderTable();
}

async function loadStats() {
  const today = new Date().toISOString().slice(0,10);
  const m1 = new Date(); m1.setDate(1); const monthStart = m1.toISOString().slice(0,10);
  const [sc,ip,dn,mo,em] = await Promise.all([
    supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('scheduled_date',today).eq('status','scheduled'),
    supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('status','in_progress'),
    supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('scheduled_date',today).eq('status','completed'),
    supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('scheduled_date',monthStart).eq('status','completed'),
    supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('scheduled_date',today).eq('case_type','emergency'),
  ]);
  document.getElementById('st-sched').textContent  = sc.count ?? '—';
  document.getElementById('st-inprog').textContent = ip.count ?? '—';
  document.getElementById('st-done').textContent   = dn.count ?? '—';
  document.getElementById('st-month').textContent  = mo.count ?? '—';
  document.getElementById('st-emerg').textContent  = em.count ?? '—';
}

// ── Filter + render ───────────────────────────────────────────────────────────
window.setFilter = (f, btn) => {
  _activeFilter = f;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderTable();
};

function renderStats() { loadStats(); }

function renderTable() {
  const list = _activeFilter === 'all' ? _allCases : _allCases.filter(c=>c.status===_activeFilter);
  const wrap = document.getElementById('table-wrap');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">🔪</div>
      <div class="empty-title">No OT cases for this date</div>
      <div style="font-size:13px;color:var(--text-muted)">Use the button above to schedule a new case.</div></div>`;
    return;
  }
  const rows = list.map(c => {
    const time = c.scheduled_time ? c.scheduled_time.slice(0,5) : '—';
    const sCls = {scheduled:'s-scheduled',in_progress:'s-in_progress',completed:'s-completed',cancelled:'s-cancelled'}[c.status]||'';
    const sLbl = {scheduled:'Scheduled',in_progress:'In Progress',completed:'Completed',cancelled:'Cancelled'}[c.status]||c.status;
    const tCls = {elective:'ct-elective',emergency:'ct-emergency',semi_elective:'ct-semi_elective'}[c.case_type]||'';
    const tLbl = {elective:'Elective',emergency:'Emergency',semi_elective:'Semi-elective'}[c.case_type]||c.case_type;
    const dur  = c.actual_start && c.actual_end
      ? Math.round((new Date(c.actual_end)-new Date(c.actual_start))/60000)+' min' : '—';
    return `<tr data-onclick="viewCase" data-onclick-a0="${c.id}">
      <td style="font-weight:600;min-width:40px">${c.serial_no||'—'}</td>
      <td>${time}</td>
      <td>
        <div style="font-weight:600">${c.procedure_name}</div>
        <div style="font-size:11px;color:var(--text-muted)">${c.pre_op_diagnosis||''}</div>
      </td>
      <td>${c.patients?.name||'—'}<div style="font-size:11px;color:var(--text-muted)">${c.patients?.phone||''}</div></td>
      <td>${c.profiles?.full_name||'—'}</td>
      <td>${c.ot_table||'—'}</td>
      <td><span class="anaes-lbl">${_anaesLabel(c.anaesthesia_type)}</span></td>
      <td>${dur}</td>
      <td><span class="case-type-chip ${tCls}">${tLbl}</span></td>
      <td><span class="status-chip ${sCls}">${sLbl}</span></td>
      <td data-onclick="_stopProp" data-onclick-a0="@event" style="white-space:nowrap">
        ${c.status==='scheduled'   ? `<button class="btn btn-secondary btn-sm" data-onclick="startCase" data-onclick-a0="${c.id}">▶ Start</button>` : ''}
        ${c.status==='in_progress' ? `<button class="btn btn-primary btn-sm" data-onclick="openIntra" data-onclick-a0="${c.id}">📝 Complete</button>` : ''}
        ${c.status==='scheduled'   ? `<button class="btn btn-sm" style="background:#f1f5f4;border:1px solid var(--border);margin-left:4px" data-onclick="cancelCase" data-onclick-a0="${c.id}">✕</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `<table class="ot-table">
    <thead><tr>
      <th>Sl#</th><th>Time</th><th>Procedure</th><th>Patient</th>
      <th>Surgeon</th><th>OT</th><th>Anaes.</th><th>Duration</th><th>Type</th><th>Status</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── New case ──────────────────────────────────────────────────────────────────
window.openNewCase = function() {
  _foundPt = null;
  document.getElementById('n-pt-search').value  = '';
  document.getElementById('n-pt-result').classList.remove('show');
  document.getElementById('n-proc').value        = '';
  document.getElementById('n-case-type').value   = 'elective';
  document.getElementById('n-category').value    = 'general';
  document.getElementById('n-ot-table').value    = 'OT-1';
  document.getElementById('n-date').value        = _viewDate;
  document.getElementById('n-time').value        = '08:00';
  document.getElementById('n-pre-diag').value    = '';
  document.getElementById('n-asst').value        = '';
  document.getElementById('n-anaes-type').value  = 'general';
  document.getElementById('n-notes').value       = '';
  if (profile?.role==='doctor') document.getElementById('n-surgeon').value = userId;
  ['chk-consent','chk-npo','chk-iv','chk-site'].forEach(id=>document.getElementById(id).checked=true);
  ['chk-blood','chk-allergy','chk-implant','chk-xray'].forEach(id=>document.getElementById(id).checked=false);
  document.getElementById('new-overlay').style.display = 'flex';
};
window.closeNew = () => { document.getElementById('new-overlay').style.display='none'; };

let _ptTimer = null;
window.searchPt = function() {
  clearTimeout(_ptTimer);
  _ptTimer = setTimeout(async () => {
    const q = document.getElementById('n-pt-search').value.trim();
    if (q.length < 3) { document.getElementById('n-pt-result').classList.remove('show'); return; }
    const isPhone = /^\d+$/.test(q);
    let qry = supabase.from('patients').select('id,name,phone,age,gender').eq('tenant_id',tenantId).limit(1);
    qry = isPhone ? qry.ilike('phone',`%${q}%`) : qry.ilike('name',`%${q}%`);
    const { data } = await qry;
    const pt = data?.[0];
    if (pt) {
      _foundPt = pt;
      document.getElementById('n-pt-name').textContent = pt.name;
      document.getElementById('n-pt-sub').textContent  = `${pt.phone||'—'} · ${pt.gender||''} ${pt.age?pt.age+'y':''}`;
      document.getElementById('n-pt-result').classList.add('show');
    } else { _foundPt=null; document.getElementById('n-pt-result').classList.remove('show'); }
  }, 350);
};

window.saveNewCase = async function() {
  if (!_foundPt) { alert('Please search and select a patient.'); return; }
  const proc = document.getElementById('n-proc').value.trim();
  if (!proc)    { alert('Please enter the procedure name.'); return; }
  const surgId = document.getElementById('n-surgeon').value;
  if (!surgId)  { alert('Please select the surgeon.'); return; }

  // Get next serial number for this tenant
  const { count } = await supabase.from('ot_cases').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId);
  const serial = (count || 0) + 1;

  const preop = {
    consent: document.getElementById('chk-consent').checked,
    blood_arranged: document.getElementById('chk-blood').checked,
    npo: document.getElementById('chk-npo').checked,
    iv_access: document.getElementById('chk-iv').checked,
    site_marked: document.getElementById('chk-site').checked,
    allergies_noted: document.getElementById('chk-allergy').checked,
    implant_ready: document.getElementById('chk-implant').checked,
    imaging_available: document.getElementById('chk-xray').checked,
  };

  const { error } = await supabase.from('ot_cases').insert({
    tenant_id:       tenantId,
    patient_id:      _foundPt.id,
    serial_no:       serial,
    procedure_name:  proc,
    case_type:       document.getElementById('n-case-type').value,
    procedure_category: document.getElementById('n-category').value,
    pre_op_diagnosis: document.getElementById('n-pre-diag').value.trim() || null,
    surgeon_id:      surgId,
    assistant_surgeon: document.getElementById('n-asst').value.trim() || null,
    anaesthetist_id: document.getElementById('n-anaes-dr').value || null,
    anaesthesia_type: document.getElementById('n-anaes-type').value,
    ot_table:        document.getElementById('n-ot-table').value,
    scheduled_date:  document.getElementById('n-date').value,
    scheduled_time:  document.getElementById('n-time').value || null,
    preop_checklist: preop,
    notes:           document.getElementById('n-notes').value.trim() || null,
    status:          'scheduled',
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save case.')); return; }

  // NABH — Save surgical consent record
  const consentBy = document.getElementById('ot-consent-by').value.trim();
  if (consentBy) {
    await supabase.from('consent_records').insert({
      tenant_id:              tenantId,
      patient_id:             _foundPt.id,
      consent_type:           document.getElementById('ot-consent-type').value,
      consent_given:          true,
      consent_by:             consentBy,
      relationship:           document.getElementById('ot-consent-rel').value,
      risks_explained:        document.getElementById('ot-consent-risks').checked,
      alternatives_explained: document.getElementById('ot-consent-alts').checked,
      questions_answered:     document.getElementById('ot-consent-questions').checked,
      procedure_details:      proc,
    });
  }

  closeNew();
  _alert('success', `OT Case #${serial} scheduled for ${_foundPt.name}.`);
  loadCases();
};

// ── Start case ────────────────────────────────────────────────────────────────
window.startCase = async function(id) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('ot_cases').update({ status:'in_progress', actual_start:now }).eq('id',id);
  if (error) { alert(safeErrorMessage(error, 'Could not start case.')); return; }
  _alert('success','OT Case started.');
  loadCases();
};

// ── Cancel case ───────────────────────────────────────────────────────────────
window.cancelCase = async function(id) {
  if (!confirm('Cancel this OT case?')) return;
  const { error } = await supabase.from('ot_cases').update({ status:'cancelled' }).eq('id',id);
  if (error) { alert(safeErrorMessage(error, 'Could not cancel case.')); return; }
  _alert('success','Case cancelled.');
  loadCases();
};

// ── Intraoperative modal ──────────────────────────────────────────────────────
window.openIntra = function(id) {
  _activeId = id;
  const c = _allCases.find(x=>x.id===id);
  if (!c) return;
  document.getElementById('intra-title').textContent = c.procedure_name;
  document.getElementById('intra-sub').textContent   = `${c.patients?.name||'—'} · ${c.ot_table||''}`;
  const now = new Date(); const later = new Date(now.getTime()+90*60000);
  const fmtDt = d => d.toISOString().slice(0,16);
  document.getElementById('i-start').value = c.actual_start ? c.actual_start.slice(0,16) : (now.toISOString().slice(0,16));
  document.getElementById('i-end').value   = fmtDt(later);
  document.getElementById('i-post-diag').value = c.post_op_diagnosis || c.pre_op_diagnosis || '';
  document.getElementById('i-findings').value = '';
  document.getElementById('i-details').value  = '';
  document.getElementById('i-blood-loss').value = '';
  document.getElementById('i-duration').value   = '';
  document.getElementById('i-destination').value = 'ward';
  document.getElementById('i-complications').value = '';
  document.getElementById('i-post-instr').value = '';
  document.getElementById('i-swab').checked = true;
  document.getElementById('i-inst').checked = true;
  document.getElementById('i-specimen').checked = false;
  document.getElementById('i-specimen-det').value = '';

  // Auto-calc duration when end changes
  document.getElementById('i-end').oninput = () => {
    const s = new Date(document.getElementById('i-start').value);
    const e = new Date(document.getElementById('i-end').value);
    if (s && e && e > s) document.getElementById('i-duration').value = Math.round((e-s)/60000);
  };
  document.getElementById('intra-overlay').style.display = 'flex';
};
window.closeIntra = () => { document.getElementById('intra-overlay').style.display='none'; };

window.saveIntra = async function() {
  if (!_activeId) return;
  const findings = document.getElementById('i-findings').value.trim();
  if (!findings) { alert('Please enter operative findings.'); return; }
  const start = document.getElementById('i-start').value;
  const end   = document.getElementById('i-end').value;
  const dur   = parseInt(document.getElementById('i-duration').value) || null;

  const { error } = await supabase.from('ot_cases').update({
    status:               'completed',
    actual_start:         start ? new Date(start).toISOString() : null,
    actual_end:           end   ? new Date(end).toISOString()   : null,
    duration_minutes:     dur,
    post_op_diagnosis:    document.getElementById('i-post-diag').value.trim() || null,
    operative_findings:   findings,
    procedure_details:    document.getElementById('i-details').value.trim() || null,
    blood_loss_ml:        parseInt(document.getElementById('i-blood-loss').value) || null,
    post_op_destination:  document.getElementById('i-destination').value,
    complications:        document.getElementById('i-complications').value.trim() || null,
    post_op_condition:    document.getElementById('i-condition').value,
    post_op_instructions: document.getElementById('i-post-instr').value.trim() || null,
    swab_count_correct:   document.getElementById('i-swab').checked,
    instrument_count_correct: document.getElementById('i-inst').checked,
    specimen_sent:        document.getElementById('i-specimen').checked,
    specimen_details:     document.getElementById('i-specimen-det').value.trim() || null,
  }).eq('id', _activeId);
  if (error) { alert(safeErrorMessage(error, 'Could not save intraoperative record.')); return; }
  closeIntra();
  _alert('success','Intraoperative record saved. Case marked as Completed.');
  loadCases();
};

// ── View case ─────────────────────────────────────────────────────────────────
window.viewCase = function(id) {
  const c = _allCases.find(x=>x.id===id);
  if (!c) return;
  _activeId = id;
  document.getElementById('view-title').textContent = `OT Record — #${c.serial_no||'—'} · ${c.procedure_name}`;
  document.getElementById('view-sub').textContent   = `${c.patients?.name||'—'} · ${_fmtDate(c.scheduled_date)}`;

  const anaes = _doctors.find(d=>d.id===c.anaesthetist_id)?.full_name || '—';
  const dur   = c.duration_minutes ? c.duration_minutes+' min' : (c.actual_start&&c.actual_end ? Math.round((new Date(c.actual_end)-new Date(c.actual_start))/60000)+' min' : '—');

  const sections = [
    { title:'Patient & Scheduling', rows:[
      ['Patient',         c.patients?.name||'—'],
      ['Phone',           c.patients?.phone||'—'],
      ['Scheduled Date',  _fmtDate(c.scheduled_date)],
      ['Scheduled Time',  c.scheduled_time||'—'],
      ['OT Table',        c.ot_table||'—'],
      ['Case Type',       {elective:'Elective',emergency:'Emergency',semi_elective:'Semi-Elective'}[c.case_type]||c.case_type],
    ]},
    { title:'Surgical Team', rows:[
      ['Surgeon',         c.profiles?.full_name||'—'],
      ['Anaesthetist',    anaes],
      ['Anaesthesia',     _anaesLabel(c.anaesthesia_type)],
    ]},
    { title:'Diagnosis & Procedure', rows:[
      ['Pre-op Diagnosis',  c.pre_op_diagnosis||'—'],
      ['Post-op Diagnosis', c.post_op_diagnosis||'—'],
      ['Operative Findings',c.operative_findings||'—'],
      ['Procedure Details', c.procedure_details||'—'],
    ]},
    { title:'Intraoperative', rows:[
      ['Actual Start',    c.actual_start ? new Date(c.actual_start).toLocaleString('en-IN') : '—'],
      ['Actual End',      c.actual_end   ? new Date(c.actual_end).toLocaleString('en-IN')   : '—'],
      ['Duration',        dur],
      ['Blood Loss',      c.blood_loss_ml!=null ? c.blood_loss_ml+' ml' : '—'],
      ['Swab Count',      c.swab_count_correct!==false ? '✅ Correct' : '❌ Discrepancy'],
      ['Instrument Count',c.instrument_count_correct!==false ? '✅ Correct' : '❌ Discrepancy'],
      ['Specimen Sent',   c.specimen_sent ? 'Yes — '+(c.specimen_details||'') : 'No'],
      ['Complications',   c.complications||'None'],
    ]},
    { title:'Post-operative', rows:[
      ['Condition',       c.post_op_condition||'—'],
      ['Destination',     c.post_op_destination||'—'],
      ['Instructions',    c.post_op_instructions||'—'],
    ]},
  ];

  document.getElementById('view-body').innerHTML = sections.map(s => `
    <div class="view-section">
      <div class="view-section-title">${s.title}</div>
      ${s.rows.map(([l,v])=>`<div class="view-row"><div class="view-label">${l}</div><div class="view-value">${v||'—'}</div></div>`).join('')}
    </div>`).join('');
  document.getElementById('view-overlay').style.display = 'flex';
};
window.closeView = () => { document.getElementById('view-overlay').style.display='none'; };

window.printOtRecord = function() {
  const c = _allCases.find(x=>x.id===_activeId); if(!c) return;
  const anaes = _doctors.find(d=>d.id===c.anaesthetist_id)?.full_name || '—';
  const dur   = c.duration_minutes ? c.duration_minutes+' min' : '—';
  document.getElementById('ot-print').innerHTML = `
    <div style="font-family:'DM Sans',sans-serif;max-width:700px;margin:0 auto">
      <div style="text-align:center;border-bottom:2px solid #1a4a2e;padding-bottom:10px;margin-bottom:14px">
        <div style="font-size:18px;font-weight:700;color:#1a4a2e">OPERATIVE RECORD</div>
        <div style="font-size:11px;color:#555;margin-top:3px">NCISM §18p · Major OT Register · AyurXpert HMS</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;margin-bottom:14px">
        ${[['OT Serial No', c.serial_no||'—'],['Date',_fmtDate(c.scheduled_date)],
           ['Patient', c.patients?.name||'—'],['Phone', c.patients?.phone||'—'],
           ['Procedure', c.procedure_name],['Case Type', c.case_type],
           ['Surgeon', c.profiles?.full_name||'—'],['Anaesthetist', anaes],
           ['Anaesthesia', _anaesLabel(c.anaesthesia_type)],['OT Table', c.ot_table||'—'],
           ['Duration', dur],['Blood Loss', c.blood_loss_ml!=null?c.blood_loss_ml+' ml':'—'],
           ['Pre-op Diagnosis', c.pre_op_diagnosis||'—'],['Post-op Diagnosis', c.post_op_diagnosis||'—'],
          ].map(([l,v])=>`<div style="border-bottom:1px dotted #ccc;padding:4px 0;font-size:12px"><strong style="display:block;font-size:10px;color:#555;text-transform:uppercase">${l}</strong>${v}</div>`).join('')}
      </div>
      ${['Operative Findings','Procedure Details','Complications','Post-operative Instructions'].map(k=>{
        const map={['Operative Findings']:c.operative_findings,['Procedure Details']:c.procedure_details,['Complications']:c.complications,['Post-operative Instructions']:c.post_op_instructions};
        return `<div style="margin-bottom:10px"><div style="font-size:10px;font-weight:700;color:#1a4a2e;text-transform:uppercase;margin-bottom:3px">${k}</div><div style="border:1px solid #ccc;border-radius:4px;padding:7px;font-size:12px;min-height:36px">${map[k]||'—'}</div></div>`;
      }).join('')}
      <div style="display:flex;justify-content:space-between;margin-top:30px">
        <div style="text-align:center;border-top:1px solid #333;padding-top:4px;width:160px;font-size:11px">Surgeon</div>
        <div style="text-align:center;border-top:1px solid #333;padding-top:4px;width:160px;font-size:11px">Anaesthetist</div>
        <div style="text-align:center;border-top:1px solid #333;padding-top:4px;width:160px;font-size:11px">Scrub Nurse</div>
      </div>
    </div>`;
  window.print();
};

// ── OT Logbook ────────────────────────────────────────────────────────────────
window.openLogbook = function() {
  const now = new Date();
  document.getElementById('lb-month').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  document.getElementById('logbook-overlay').style.display = 'flex';
  loadLogbook();
};
window.closeLogbook = () => { document.getElementById('logbook-overlay').style.display='none'; };

window.loadLogbook = async function() {
  const month = document.getElementById('lb-month').value;
  if (!month) return;
  const [yr, mo] = month.split('-');
  const from = `${yr}-${mo}-01`;
  const to   = new Date(yr, mo, 0).toISOString().slice(0,10);
  const { data } = await supabase
    .from('ot_cases')
    .select(`serial_no,scheduled_date,scheduled_time,procedure_name,case_type,anaesthesia_type,
             duration_minutes,status,patients(name,age,gender),profiles!surgeon_id(full_name)`)
    .eq('tenant_id',tenantId)
    .gte('scheduled_date',from).lte('scheduled_date',to)
    .order('scheduled_date').order('serial_no');

  const rows = (data||[]).map(c => `<tr>
    <td>${c.serial_no||'—'}</td>
    <td>${_fmtDate(c.scheduled_date)}</td>
    <td>${c.scheduled_time?.slice(0,5)||'—'}</td>
    <td>${c.patients?.name||'—'}</td>
    <td>${c.patients?.age||'—'} / ${(c.patients?.gender||'').charAt(0).toUpperCase()}</td>
    <td>${c.procedure_name}</td>
    <td>${_anaesLabel(c.anaesthesia_type)}</td>
    <td>${c.profiles?.full_name||'—'}</td>
    <td>${c.duration_minutes?c.duration_minutes+' min':'—'}</td>
    <td>${{scheduled:'Sched',in_progress:'In Prog',completed:'Done',cancelled:'Cancel'}[c.status]||c.status}</td>
  </tr>`).join('');

  document.getElementById('logbook-body').innerHTML = rows
    ? `<div style="overflow-x:auto"><table class="logbook-table">
        <thead><tr><th>Sl#</th><th>Date</th><th>Time</th><th>Patient</th><th>Age/Sex</th>
          <th>Procedure</th><th>Anaes.</th><th>Surgeon</th><th>Duration</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : `<div class="empty-state"><div class="empty-icon">📖</div><div class="empty-title">No cases in this month</div></div>`;
};

window.printLogbook = function() {
  window.print();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _anaesLabel(t){return{general:'GA',spinal:'SA',epidural:'Epidural',regional:'Regional',local:'Local',none:'None'}[t]||t||'—';}
function _fmtDate(d){if(!d)return'—';return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});}
function _alert(type,msg){const el=document.getElementById('alert-box');el.className=`alert ${type} show`;el.textContent=msg;setTimeout(()=>el.classList.remove('show'),4000);}

init();
