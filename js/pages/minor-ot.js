import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse']);
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const userId   = profile?.id;

let _viewDate  = new Date().toISOString().slice(0,10);
let _allData   = [];
let _viewRec   = null;
let _foundPatient = null;

// ── Date nav ──────────────────────────────────────────────────────────────────
function renderDateNav() {
  const d = new Date(_viewDate + 'T00:00:00');
  document.getElementById('date-display').textContent =
    d.toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
  document.getElementById('date-picker').value = _viewDate;
  const isToday = _viewDate === new Date().toISOString().slice(0,10);
  document.getElementById('today-chip').style.display = isToday ? '' : 'none';
}
window.shiftDate = d => { const dt = new Date(_viewDate); dt.setDate(dt.getDate()+Number(d)); _viewDate = dt.toISOString().slice(0,10); renderDateNav(); loadData(); };
window.onDatePick = () => { _viewDate = document.getElementById('date-picker').value; renderDateNav(); loadData(); };
window.goToday = () => { _viewDate = new Date().toISOString().slice(0,10); renderDateNav(); loadData(); };

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadData() {
  const { data, error } = await supabase
    .from('minor_ot_procedures')
    .select(`id,procedure_name,procedure_type,anaesthesia,procedure_date,duration_minutes,
             pre_op_diagnosis,post_op_diagnosis,operative_findings,procedure_notes,
             instruments_used,complications,post_op_instructions,follow_up_date,status,created_at,
             patients(id,name,phone,age,gender),
             profiles!surgeon_id(full_name)`)
    .eq('tenant_id', tenantId)
    .eq('procedure_date', _viewDate)
    .order('created_at', { ascending: false });

  if (error) { _alert('error', 'Load failed: ' + error.message); return; }
  _allData = data || [];
  renderStats();
  renderTable();
}

async function loadStats() {
  const today = new Date().toISOString().slice(0,10);
  const m1 = new Date(); m1.setDate(1); const monthStart = m1.toISOString().slice(0,10);
  const [todayRes, monthRes] = await Promise.all([
    supabase.from('minor_ot_procedures').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).eq('procedure_date',today),
    supabase.from('minor_ot_procedures').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('procedure_date',monthStart),
  ]);
  document.getElementById('st-today').textContent  = todayRes.count ?? '—';
  document.getElementById('st-month').textContent  = monthRes.count ?? '—';
  const localC   = _allData.filter(r=>r.anaesthesia==='local').length;
  const generalC = _allData.filter(r=>r.anaesthesia==='general').length;
  document.getElementById('st-local').textContent   = localC;
  document.getElementById('st-general').textContent = generalC;
}

function renderStats() { loadStats(); }

// ── Table ─────────────────────────────────────────────────────────────────────
function renderTable() {
  const wrap = document.getElementById('table-wrap');
  if (!_allData.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">🔪</div>
      <div class="empty-title">No procedures on this date</div>
      <div class="empty-desc" style="font-size:13px">Use the button above to add a new procedure record.</div></div>`;
    return;
  }
  const rows = _allData.map(r => {
    const aCls = {local:'anaes-local',general:'anaes-general',none:'anaes-none'}[r.anaesthesia] || 'anaes-other';
    const aLabel = {local:'Local',general:'General',spinal:'Spinal',regional:'Regional',none:'None'}[r.anaesthesia] || r.anaesthesia;
    return `<tr>
      <td><div class="proc-name">${_esc(r.procedure_name || '—')}</div><div class="proc-type">${_typeLabel(r.procedure_type)}</div></td>
      <td>${_esc(r.patients?.name || '—')}<div style="font-size:11px;color:var(--text-muted)">${_esc(r.patients?.phone||'')}</div></td>
      <td><span class="anaes-chip ${aCls}">${_esc(aLabel)}</span></td>
      <td>${r.duration_minutes ? r.duration_minutes + ' min' : '—'}</td>
      <td>${_esc(r.profiles?.full_name || '—')}</td>
      <td>
        <button class="btn btn-secondary btn-sm" data-onclick="viewRecord" data-onclick-a0="${r.id}">View</button>
      </td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `<table class="ot-table">
    <thead><tr><th>Procedure</th><th>Patient</th><th>Anaes.</th><th>Duration</th><th>Surgeon</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── New procedure modal ───────────────────────────────────────────────────────
window.openNewModal = function() {
  _foundPatient = null;
  ['n-search','n-proc-name','n-pre-diag','n-post-diag','n-findings','n-proc-notes','n-instruments','n-complications','n-post-instr'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('n-proc-type').value = '';
  document.getElementById('n-anaesthesia').value = 'local';
  document.getElementById('n-date').value    = _viewDate;
  document.getElementById('n-duration').value = '';
  const fu = new Date(_viewDate); fu.setDate(fu.getDate()+7);
  document.getElementById('n-followup').value = fu.toISOString().slice(0,10);
  document.getElementById('n-pt-result').classList.remove('show');
  document.getElementById('new-overlay').style.display = 'flex';
};
window.closeNewModal = () => { document.getElementById('new-overlay').style.display = 'none'; };

let _ptTimer = null;
window.searchPatient = function() {
  clearTimeout(_ptTimer);
  _ptTimer = setTimeout(async () => {
    const q = document.getElementById('n-search').value.trim();
    if (q.length < 3) { document.getElementById('n-pt-result').classList.remove('show'); return; }
    const isPhone = /^\d+$/.test(q);
    let qry = supabase.from('patients').select('id,name,phone,age,gender').eq('tenant_id',tenantId).limit(1);
    qry = isPhone ? qry.ilike('phone',`%${q}%`) : qry.ilike('name',`%${q}%`);
    const { data } = await qry;
    const pt = data?.[0];
    if (pt) {
      _foundPatient = pt;
      document.getElementById('n-pt-name').textContent = pt.name;
      document.getElementById('n-pt-sub').textContent  = `${pt.phone||'—'} · ${pt.gender||''} ${pt.age?pt.age+'y':''}`;
      document.getElementById('n-pt-result').classList.add('show');
    } else { _foundPatient = null; document.getElementById('n-pt-result').classList.remove('show'); }
  }, 350);
};

window.saveProcedure = async function() {
  if (!_foundPatient)   { alert('Please search and select a patient.'); return; }
  const pname = document.getElementById('n-proc-name').value.trim();
  if (!pname)           { alert('Please enter the procedure name.'); return; }

  const { error } = await supabase.from('minor_ot_procedures').insert({
    tenant_id:            tenantId,
    patient_id:           _foundPatient.id,
    surgeon_id:           userId,
    procedure_name:       pname,
    procedure_type:       document.getElementById('n-proc-type').value || null,
    anaesthesia:          document.getElementById('n-anaesthesia').value,
    procedure_date:       document.getElementById('n-date').value || _viewDate,
    duration_minutes:     parseInt(document.getElementById('n-duration').value) || null,
    pre_op_diagnosis:     document.getElementById('n-pre-diag').value.trim() || null,
    post_op_diagnosis:    document.getElementById('n-post-diag').value.trim() || null,
    operative_findings:   document.getElementById('n-findings').value.trim() || null,
    procedure_notes:      document.getElementById('n-proc-notes').value.trim() || null,
    instruments_used:     document.getElementById('n-instruments').value.trim() || null,
    complications:        document.getElementById('n-complications').value.trim() || null,
    post_op_instructions: document.getElementById('n-post-instr').value.trim() || null,
    follow_up_date:       document.getElementById('n-followup').value || null,
    status:               'completed'
  });
  if (error) { alert('Error saving: ' + error.message); return; }
  closeNewModal();
  _alert('success', 'Procedure record saved.');
  loadData();
};

// ── View modal ────────────────────────────────────────────────────────────────
window.viewRecord = function(id) {
  _viewRec = _allData.find(r => r.id === id);
  if (!_viewRec) return;
  const r = _viewRec;
  document.getElementById('view-title').textContent = r.procedure_name || 'Procedure Record';
  document.getElementById('view-sub').textContent   = `${r.patients?.name || '—'} · ${_fmtDate(r.procedure_date)}`;

  const rows = [
    ['Patient',            _esc(r.patients?.name || '—')],
    ['Phone',              _esc(r.patients?.phone || '—')],
    ['Procedure Type',     _typeLabel(r.procedure_type)],
    ['Anaesthesia',        _esc({local:'Local',general:'General',spinal:'Spinal',regional:'Regional Block',none:'None'}[r.anaesthesia]||r.anaesthesia)],
    ['Date',               _fmtDate(r.procedure_date)],
    ['Duration',           r.duration_minutes ? r.duration_minutes + ' min' : '—'],
    ['Surgeon',            _esc(r.profiles?.full_name || '—')],
    ['Follow-up',          r.follow_up_date ? _fmtDate(r.follow_up_date) : '—'],
    ['Pre-op Diagnosis',   _esc(r.pre_op_diagnosis || '—')],
    ['Post-op Diagnosis',  _esc(r.post_op_diagnosis || '—')],
    ['Operative Findings', _esc(r.operative_findings || '—')],
    ['Procedure Notes',    _esc(r.procedure_notes || '—')],
    ['Instruments Used',   _esc(r.instruments_used || '—')],
    ['Complications',      _esc(r.complications || 'None')],
    ['Post-op Instructions', _esc(r.post_op_instructions || '—')],
  ];
  document.getElementById('view-body').innerHTML = rows.map(([l,v]) =>
    `<div class="view-row"><div class="view-label">${l}</div><div class="view-value">${v}</div></div>`
  ).join('');
  document.getElementById('view-overlay').style.display = 'flex';
};
window.closeViewModal = () => { document.getElementById('view-overlay').style.display = 'none'; };

window.printRecord = function() {
  if (!_viewRec) return;
  const r = _viewRec;
  document.getElementById('ot-print').innerHTML = `
    <div class="print-title">Minor OT Procedure Record</div>
    <div class="print-sub">NCISM §18p · Shalya Chikitsa &nbsp;·&nbsp; ${_fmtDate(r.procedure_date)}</div>
    <div class="print-grid">
      <div class="print-field"><strong>Patient</strong>${_esc(r.patients?.name||'—')}</div>
      <div class="print-field"><strong>Phone</strong>${_esc(r.patients?.phone||'—')}</div>
      <div class="print-field"><strong>Procedure</strong>${_esc(r.procedure_name||'—')}</div>
      <div class="print-field"><strong>Type</strong>${_typeLabel(r.procedure_type)}</div>
      <div class="print-field"><strong>Anaesthesia</strong>${_esc(r.anaesthesia||'—')}</div>
      <div class="print-field"><strong>Duration</strong>${r.duration_minutes?r.duration_minutes+' min':'—'}</div>
      <div class="print-field"><strong>Pre-op Diagnosis</strong>${_esc(r.pre_op_diagnosis||'—')}</div>
      <div class="print-field"><strong>Post-op Diagnosis</strong>${_esc(r.post_op_diagnosis||'—')}</div>
    </div>
    <div style="font-size:11px;font-weight:700;color:#1a4a2e;text-transform:uppercase;margin-bottom:4px">Operative Findings</div>
    <div class="print-notes">${_esc(r.operative_findings||'—')}</div>
    <div style="font-size:11px;font-weight:700;color:#1a4a2e;text-transform:uppercase;margin:10px 0 4px">Procedure Notes</div>
    <div class="print-notes">${_esc(r.procedure_notes||'—')}</div>
    <div style="font-size:11px;font-weight:700;color:#1a4a2e;text-transform:uppercase;margin:10px 0 4px">Post-op Instructions</div>
    <div class="print-notes">${_esc(r.post_op_instructions||'—')}</div>
    <div class="print-sign"><div class="print-sign-box">Surgeon: ${_esc(r.profiles?.full_name||'—')}</div></div>`;
  window.print();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _typeLabel(t) {
  return _esc({incision_drainage:'Incision & Drainage',excision:'Excision / Biopsy',suturing:'Suturing',
    debridement:'Debridement',kshara_karma:'Kshara Karma',agni_karma:'Agni Karma',
    raktamokshana:'Raktamokshana',jalouka:'Jalouka',other:'Other'}[t] || t || '—');
}
function _fmtDate(d){ if(!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _alert(type,msg){ const el=document.getElementById('alert-box'); el.className=`alert ${type} show`; el.textContent=msg; setTimeout(()=>el.classList.remove('show'),4000); }

renderDateNav();
loadData();
