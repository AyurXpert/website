import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin']);
initNavbar();
wireDelegatedEvents();

window._print = () => window.print();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

document.getElementById('sel-date').value = new Date().toISOString().split('T')[0];
document.getElementById('sel-assessor').value = profile.full_name||'';

// ── Standards Database ────────────────────────────────────────
const STANDARDS = [
  // AAC — Access, Assessment & Continuity of Care
  { code:'AAC.1', ch:'AAC', chName:'Access, Assessment & Continuity of Care', title:'Patient Registration & Initial Assessment', desc:'Defined registration process; initial assessment by qualified staff within defined timeframe; UHID assigned', core:false, file:'reception.html', types:['atwc','hospital'] },
  { code:'AAC.2', ch:'AAC', chName:'Access, Assessment & Continuity of Care', title:'Structured Ayurvedic Assessment', desc:'Patients assessed using Ashtasthana Pariksha, Dashavidha Pariksha, Nidana Panchaka; documented in medical record', core:false, file:'doctor.html', types:['atwc','hospital'] },
  { code:'AAC.3', ch:'AAC', chName:'Access, Assessment & Continuity of Care', title:'Care Plan — Initiated within 24h (CORE)', desc:'Documented care plan for every admitted patient including Ayurvedic diagnosis, dosha, goals, interventions', core:true, file:'ipd.html', types:['atwc','hospital'] },
  { code:'AAC.4', ch:'AAC', chName:'Access, Assessment & Continuity of Care', title:'Care Plan — Reviewed & Updated (CORE)', desc:'Care plan reviewed at defined intervals; reassessment and countersignature documented', core:true, file:'ipd.html', types:['atwc','hospital'] },
  { code:'AAC.5', ch:'AAC', chName:'Access, Assessment & Continuity of Care', title:'Continuity & Transfer of Care', desc:'Shift handover documented (SBAR); referral and transfer process defined; continuity of care ensured', core:false, file:'nursing.html', types:['atwc','hospital'] },
  { code:'AAC.6', ch:'AAC', chName:'Access, Assessment & Continuity of Care', title:'Discharge Planning & Summary', desc:'Discharge planning initiated at admission; discharge summary includes Pathya-Apathya, medications, follow-up date, condition', core:false, file:'ipd.html', types:['atwc','hospital'] },
  { code:'AAC.6H', ch:'AAC', chName:'Access, Assessment & Continuity of Care', title:'Blood Transfusion Service (Hospital)', desc:'Blood bank requests, cross-match records, issue register, reaction reporting — NABH AAC.6 hospital specific', core:false, file:'blood-bank.html', types:['hospital'] },

  // COP — Care of Patients
  { code:'COP.1', ch:'COP', chName:'Care of Patients', title:'Uniform Care Standards', desc:'All patients receive care based on identified needs without discrimination; treatment protocols defined', core:false, file:'doctor.html', types:['atwc','hospital'] },
  { code:'COP.2', ch:'COP', chName:'Care of Patients', title:'BLS Availability 24×7 (CORE ATWC)', desc:'BLS kit, AED, oxygen cylinder and crash cart checked every shift; CPR-trained staff on duty; log maintained', core:true, file:'emergency.html', types:['atwc','hospital'] },
  { code:'COP.3', ch:'COP', chName:'Care of Patients', title:'High-Risk Patient Management', desc:'High-risk patients identified (pregnancy, paediatric, elderly, MLC, fall risk); Morse Fall Scale; Braden Scale documented', core:false, file:'nursing.html', types:['atwc','hospital'] },
  { code:'COP.4', ch:'COP', chName:'Care of Patients', title:'Panchakarma Consent & Protocol', desc:'Informed consent for PK procedures; 6-month validity check; gender-matched therapist; Purvakarma assessment documented', core:false, file:'therapist.html', types:['atwc','hospital'] },
  { code:'COP.5', ch:'COP', chName:'Care of Patients', title:'Dietary Management — Pathya', desc:'Diet recommendations (Pathya/Apathya) documented; Palha Diet centre records; patient education on dietary dos and don\'ts', core:false, file:'palha-diet.html', types:['atwc','hospital'] },
  { code:'COP.6', ch:'COP', chName:'Care of Patients', title:'ICU Management (Hospital)', desc:'ICU with 24×7 doctor coverage; q1h vitals documented in flowsheet; ventilator settings and sedation scores logged', core:false, file:'icu-flowsheet.html', types:['hospital'] },

  // MOM — Medication & Operations Management
  { code:'MOM.1', ch:'MOM', chName:'Medication & Operations Management', title:'Medication Policy', desc:'Written policy for medication management including NDPS, Schedule H, high-risk/LASA medications, storage conditions', core:false, file:'dispensaryPOS.html', types:['atwc','hospital'] },
  { code:'MOM.2', ch:'MOM', chName:'Medication & Operations Management', title:'Medication Storage & Procurement', desc:'Medicines stored appropriately; expiry monitored; GMP suppliers used; purchase-order process defined', core:false, file:'inventory.html', types:['atwc','hospital'] },
  { code:'MOM.3', ch:'MOM', chName:'Medication & Operations Management', title:'Complete Prescription Elements', desc:'Prescriptions include patient ID, date, medicine name, dose, frequency, duration, Anupana, prescriber signature', core:false, file:'doctor.html', types:['atwc','hospital'] },
  { code:'MOM.4', ch:'MOM', chName:'Medication & Operations Management', title:'Drug Interaction Review (CORE)', desc:'DDI alerts at prescription stage; LASA/high-risk medicines flagged with double-verification; medication labels generated', core:true, file:'doctor.html', types:['atwc','hospital'] },
  { code:'MOM.5', ch:'MOM', chName:'Medication & Operations Management', title:'NDPS & Schedule H Compliance', desc:'NDPS narcotic register maintained with custodian and witness; Schedule H dispensing only on valid prescription', core:false, file:'dispensaryPOS.html', types:['atwc','hospital'] },
  { code:'MOM.6', ch:'MOM', chName:'Medication & Operations Management', title:'Aushadha Nirman — In-house Preparation', desc:'In-house medicine preparation register with batch number, ingredients, QC checks, expiry; prepared per classical reference', core:false, file:'aushadha-nirman.html', types:['atwc','hospital'] },

  // PRE — Patient Rights & Education
  { code:'PRE.1', ch:'PRE', chName:'Patient Rights & Education', title:'Patient Rights Policy', desc:'Patient rights policy displayed; confidentiality maintained; DPDPA 2023 compliance; grievance mechanism available', core:false, file:'quality.html', types:['atwc','hospital'] },
  { code:'PRE.2', ch:'PRE', chName:'Patient Rights & Education', title:'Gender-Appropriate Care (CORE ATWC)', desc:'Female patients attended by female staff for all procedures; gender match for PK therapists enforced', core:true, file:'therapist.html', types:['atwc','hospital'] },
  { code:'PRE.3', ch:'PRE', chName:'Patient Rights & Education', title:'Informed Consent', desc:'Consent obtained for admission, invasive procedures, anaesthesia, surgery, and PK; documented in medical record', core:false, file:'ipd.html', types:['atwc','hospital'] },
  { code:'PRE.4', ch:'PRE', chName:'Patient Rights & Education', title:'Patient & Family Education (CORE ATWC)', desc:'Education provided on disease, medications, Dinacharya, lifestyle, follow-up; language documented; acknowledgement recorded', core:true, file:'doctor.html', types:['atwc','hospital'] },
  { code:'PRE.5', ch:'PRE', chName:'Patient Rights & Education', title:'Disease Education — Ayurvedic Context (CORE)', desc:'Patient educated on Nidana Panchaka, Pathya-Apathya, Rasayana, follow-up schedule; checklist completed per consultation', core:true, file:'doctor.html', types:['atwc','hospital'] },

  // IPC — Infection Prevention & Control
  { code:'IPC.1', ch:'IPC', chName:'Infection Prevention & Control', title:'IPC Programme', desc:'Formal IPC programme with IPC committee; policies and procedures in place; annual programme review', core:false, file:'quality.html', types:['atwc','hospital'] },
  { code:'IPC.2', ch:'IPC', chName:'Infection Prevention & Control', title:'Hand Hygiene', desc:'5 moments of hand hygiene; compliance monitoring; hand rub dispensers at point of care', core:false, file:'nursing.html', types:['atwc','hospital'] },
  { code:'IPC.3', ch:'IPC', chName:'Infection Prevention & Control', title:'Standard & Transmission-Based Precautions', desc:'PPE protocol; isolation procedures; sterile technique for all invasive procedures; CSSD sterilisation log', core:false, file:'sterilisation.html', types:['atwc','hospital'] },
  { code:'IPC.4', ch:'IPC', chName:'Infection Prevention & Control', title:'Biomedical Waste Management', desc:'BMW categorised and disposed per BMW Rules 2016; CBWTF tie-up; monthly SPCB summary; staff training', core:false, file:'bmw.html', types:['atwc','hospital'] },
  { code:'IPC.5', ch:'IPC', chName:'Infection Prevention & Control', title:'HAI Surveillance (CORE)', desc:'Device-day denominator tracking (CAUTI/CLABSI/VAP); patient devices register; HAI rates computed and reported', core:true, file:'hai-surveillance.html', types:['atwc','hospital'] },
  { code:'IPC.6', ch:'IPC', chName:'Infection Prevention & Control', title:'IPC Notification & Response (CORE)', desc:'HAI events reported to IPC team within 24h; CAPA initiated; outbreak investigation protocol defined', core:true, file:'hai-surveillance.html', types:['atwc','hospital'] },

  // IMS — Information Management System
  { code:'IMS.1', ch:'IMS', chName:'Information Management System', title:'Medical Records — Completeness', desc:'Complete medical records maintained; all required elements present: UHID, vitals, diagnosis, signature, dated entries', core:false, file:'mrd.html', types:['atwc','hospital'] },
  { code:'IMS.2', ch:'IMS', chName:'Information Management System', title:'Data Confidentiality & Security', desc:'Patient data protected; role-based access control; audit trail for record modifications; data backup policy', core:false, file:'admin.html', types:['atwc','hospital'] },
  { code:'IMS.3', ch:'IMS', chName:'Information Management System', title:'NAMASTE/ICD-10 Dual Coding', desc:'All diagnoses coded using NAMASTE (NAMC) and ICD-10; morbidity data available for CCRAS/NCISM reporting', core:false, file:'doctor.html', types:['atwc','hospital'] },
  { code:'IMS.4', ch:'IMS', chName:'Information Management System', title:'Data Reporting (NCISM/CCRAS)', desc:'Monthly OPD/IPD statistics reported to NCISM portal by 10th; morbidity data submitted to NAMASTE/CCRAS', core:false, file:'admin.html', types:['atwc','hospital'] },
  { code:'IMS.5', ch:'IMS', chName:'Information Management System', title:'Medical Records Retention Policy', desc:'Records retained per legal requirements (10 years for clinical, 25 years for surgical); destruction policy documented', core:false, file:'mrd.html', types:['atwc','hospital'] },
  { code:'IMS.6', ch:'IMS', chName:'Information Management System', title:'SOP/Policy Document Management (CORE)', desc:'All SOPs current, version-controlled, with review dates; staff aware of applicable SOPs; overdue reviews flagged', core:true, file:'sop-library.html', types:['atwc','hospital'] },
  { code:'IMS.7', ch:'IMS', chName:'Information Management System', title:'Periodic Medical Record Audit (CORE)', desc:'Monthly MRD audit with completeness checklist (6 criteria); completeness % KPI; deficiencies resolved with CAPA', core:true, file:'mrd.html', types:['atwc','hospital'] },

  // FMS — Facility Management System
  { code:'FMS.1', ch:'FMS', chName:'Facility Management System', title:'Fire Safety & Disaster Preparedness', desc:'Fire NOC current; fire extinguishers maintained and inspected; ≥2 drills/year; evacuation plan displayed', core:false, file:'fms.html', types:['atwc','hospital'] },
  { code:'FMS.2', ch:'FMS', chName:'Facility Management System', title:'Biomedical Equipment Maintenance', desc:'Equipment asset register maintained; PPM schedule followed; calibration certificates current; CSSD qualified', core:false, file:'fms.html', types:['atwc','hospital'] },
  { code:'FMS.3', ch:'FMS', chName:'Facility Management System', title:'Utility Management', desc:'Generator/DG tested monthly; UPS maintained; water quality tested; HVAC serviced; O₂ pipeline inspected', core:false, file:'fms.html', types:['atwc','hospital'] },
  { code:'FMS.4', ch:'FMS', chName:'Facility Management System', title:'Safe Physical Environment', desc:'Anti-skid flooring; handrails; patient safety signage; housekeeping standards; periodic safety rounds', core:false, file:'fms.html', types:['atwc','hospital'] },

  // HRM — Human Resource Management
  { code:'HRM.1', ch:'HRM', chName:'Human Resource Management', title:'Staffing — NCISM Norms', desc:'Staffing meets NCISM minimum norms; doctor:bed, nurse:bed, therapist:session ratios compliant; duty register maintained', core:false, file:'hr.html', types:['atwc','hospital'] },
  { code:'HRM.2', ch:'HRM', chName:'Human Resource Management', title:'Staff Orientation & Training', desc:'New staff orientation documented; ongoing CME/training records maintained; NABH-specific training completed', core:false, file:'hr.html', types:['atwc','hospital'] },
  { code:'HRM.3', ch:'HRM', chName:'Human Resource Management', title:'Credentialing & Privileging', desc:'All clinical staff: credentials verified, registration current, clinical privileges documented and reviewed', core:false, file:'hr.html', types:['atwc','hospital'] },
  { code:'HRM.4', ch:'HRM', chName:'Human Resource Management', title:'Employee Health Programme', desc:'Annual health check-ups for all staff; pre-employment medicals; vaccination records; fitness certificates', core:false, file:'hr.html', types:['atwc','hospital'] },
  { code:'HRM.5', ch:'HRM', chName:'Human Resource Management', title:'24×7 Duty Roster', desc:'Weekly roster published; NCISM §18h/18i shift requirements met; on-call specialist coverage documented', core:false, file:'roster.html', types:['atwc','hospital'] },

  // ROM — Responsibilities of Management
  { code:'ROM.1', ch:'ROM', chName:'Responsibilities of Management', title:'Management Commitment & Patient Safety Goals', desc:'Quality policy approved by management; 6 patient safety goals adopted; NABH self-assessment conducted annually', core:false, file:'admin.html', types:['atwc','hospital'] },
  { code:'ROM.2', ch:'ROM', chName:'Responsibilities of Management', title:'Notifiable Disease Reporting', desc:'Notifiable diseases reported to CMO per IDSP; alert fired for all notifiable disease diagnoses; records maintained', core:false, file:'doctor.html', types:['atwc','hospital'] },
  { code:'ROM.3', ch:'ROM', chName:'Responsibilities of Management', title:'Medico-Legal & Regulatory Compliance', desc:'MLC register; POCSO compliance; NDPS Act; PCPNDT register; AERB log; CBWTF agreement current', core:false, file:'emergency.html', types:['atwc','hospital'] },

  // QIP — Quality Improvement Programme
  { code:'QIP.1', ch:'QIP', chName:'Quality Improvement Programme', title:'Quality Improvement Activities', desc:'IQAC meets quarterly; QI projects identified with measurable goals; outcomes reviewed in IQAC meetings', core:false, file:'iqac.html', types:['atwc','hospital'] },
  { code:'QIP.2', ch:'QIP', chName:'Quality Improvement Programme', title:'KPI Monitoring', desc:'≥5 KPIs tracked monthly; data analysed; benchmarks defined; improvement actions initiated for red KPIs', core:false, file:'nabh-kpi.html', types:['atwc','hospital'] },
  { code:'QIP.3', ch:'QIP', chName:'Quality Improvement Programme', title:'Patient Satisfaction Survey (CORE)', desc:'Patient satisfaction measured; ≥50% response rate; satisfaction score tracked monthly; action plan for gaps', core:true, file:'quality.html', types:['atwc','hospital'] },
  { code:'QIP.4', ch:'QIP', chName:'Quality Improvement Programme', title:'Incident Reporting & CAPA', desc:'Incident reporting system live; RCA for sentinel events; all incidents reviewed; CAPA tracked to closure within 30 days', core:false, file:'quality.html', types:['atwc','hospital'] },
];

const SCORE_OPTIONS = [
  {v:0, label:'0 — Not Implemented', cls:'s-0'},
  {v:1, label:'1 — Partial (<50%)', cls:'s-1'},
  {v:2, label:'2 — Partial (50–75%)', cls:'s-2'},
  {v:3, label:'3 — Largely Done (75–99%)', cls:'s-3'},
  {v:4, label:'4 — Fully Implemented', cls:'s-4'},
];

let _scores = {};
let _currentType = 'atwc';

function getStandards() {
  return STANDARDS.filter(s => s.types.includes(_currentType));
}

function render() {
  _currentType = document.getElementById('sel-type').value;
  const stds = getStandards();

  // Group by chapter
  const chapters = {};
  for (const s of stds) {
    if (!chapters[s.ch]) chapters[s.ch] = {chName:s.chName, items:[]};
    chapters[s.ch].items.push(s);
  }

  const container = document.getElementById('standards-container');
  container.innerHTML = Object.entries(chapters).map(([ch, {chName, items}])=> {
    const chScore = items.reduce((a,s)=>a+(_scores[s.code]||0),0);
    const chMax = items.length * 4;
    const chPct = chMax ? Math.round(chScore/chMax*100) : 0;
    return `<div class="chapter" id="ch-${ch}">
      <div class="chapter-hdr" data-onclick="toggleChapter" data-onclick-a0="${ch}">
        <div class="ch-title">
          <span class="ch-code">${ch}</span>
          ${chName}
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <span class="ch-score">${chScore}/${chMax} (${chPct}%)</span>
          <div class="ch-prog"><div class="ch-fill" id="chfill-${ch}" style="width:${chPct}%"></div></div>
        </div>
      </div>
      <div class="chapter-body" id="chbody-${ch}">
        ${items.map(s => renderStd(s)).join('')}
      </div>
    </div>`;
  }).join('');
  updateOverall();
}

function renderStd(s) {
  const score = _scores[s.code] !== undefined ? _scores[s.code] : '';
  const scls = score !== '' ? 's-'+score : '';
  return `<div class="std-row" id="std-${s.code}">
    <div class="std-left">
      <div class="std-code">${s.code} ${s.core?'<span class="core-badge">CORE</span>':''}</div>
      <div class="std-title">${s.title.replace(' (CORE)','').replace(' (CORE ATWC)','')}</div>
      <div class="std-desc">${s.desc}</div>
      <a class="std-link" href="${s.file}" target="_blank">→ Open ${s.file}</a>
    </div>
    <div class="std-score">
      <span class="score-label">Score (0–4)</span>
      <select class="score-select ${scls}" id="sc-${s.code}" data-onchange="onScore" data-onchange-a0="${s.code}" data-onchange-a1="@this">
        <option value="">— Not scored —</option>
        ${SCORE_OPTIONS.map(o=>`<option value="${o.v}" ${score===o.v?'selected':''}>${o.label}</option>`).join('')}
      </select>
    </div>
  </div>`;
}

window.onScore = (code, sel) => {
  const v = sel.value !== '' ? parseInt(sel.value) : undefined;
  if (v !== undefined) _scores[code] = v;
  else delete _scores[code];
  sel.className = 'score-select' + (v !== undefined ? ' s-'+v : '');
  updateOverall();
  updateChapter(STANDARDS.find(s=>s.code===code)?.ch);
};

function updateChapter(ch) {
  if (!ch) return;
  const items = getStandards().filter(s=>s.ch===ch);
  const chScore = items.reduce((a,s)=>a+(_scores[s.code]||0),0);
  const chMax = items.length*4;
  const chPct = chMax ? Math.round(chScore/chMax*100) : 0;
  const fill = document.getElementById('chfill-'+ch);
  if (fill) fill.style.width = chPct+'%';
  const chEl = document.querySelector(`#ch-${ch} .ch-score`);
  if (chEl) chEl.textContent = `${chScore}/${chMax} (${chPct}%)`;
}

function updateOverall() {
  const stds = getStandards();
  const scored = stds.filter(s=>_scores[s.code]!==undefined);
  const total = scored.reduce((a,s)=>a+_scores[s.code],0);
  const max = stds.length * 4;
  const pct = max ? Math.round(total/max*100) : 0;
  const coreStds = stds.filter(s=>s.core);
  const coreDone = coreStds.filter(s=>(_scores[s.code]||0)>=3).length;

  const circle = document.getElementById('overall-pct');
  const bar = document.getElementById('overall-bar');
  circle.textContent = pct+'%';
  bar.style.width = pct+'%';

  const cls = pct >= 75 ? '' : pct >= 50 ? 'warn' : 'danger';
  circle.className = 'comp-circle '+cls;
  bar.className = 'prog-fill '+cls;

  document.getElementById('overall-title').textContent = pct >= 75 ? '✅ Ready for NABH assessment' : pct >= 50 ? '⚠ Partial compliance — close gaps before applying' : '❌ Significant gaps — prioritise CORE elements first';
  document.getElementById('overall-sub').textContent = `${scored.length} of ${stds.length} standards scored · ${coreDone}/${coreStds.length} CORE standards ≥75% · Total ${total}/${max}`;
}

window.toggleChapter = (ch) => {
  const body = document.getElementById('chbody-'+ch);
  body.classList.toggle('open');
};

window.switchType = () => render();

window.generateActionPlan = () => {
  const stds = getStandards();
  const gaps = stds.filter(s => (_scores[s.code]||0) < 3);
  if (!gaps.length) {
    showToast('All standards scored ≥3. No gaps identified!','success');
    document.getElementById('action-section').style.display='none';
    return;
  }
  const list = document.getElementById('action-list');
  list.innerHTML = gaps.map(s => {
    const score = _scores[s.code] !== undefined ? _scores[s.code] : 'Not scored';
    const cls = (_scores[s.code]||0) === 0 ? '' : 'warn';
    return `<div class="action-item ${cls}">
      <strong>${s.code}${s.core?' ★ CORE':''}</strong> — ${s.title.replace(' (CORE)','').replace(' (CORE ATWC)','')} &nbsp;·&nbsp; Score: ${score}/4<br/>
      <span style="font-size:11px;color:var(--text-muted)">${s.desc}</span><br/>
      <a href="${s.file}" style="font-size:11px;color:var(--green-mid)">→ ${s.file}</a>
    </div>`;
  }).join('');
  document.getElementById('action-section').style.display='block';
  document.getElementById('action-section').scrollIntoView({behavior:'smooth'});
};

window.saveAssessment = async () => {
  const assessor = document.getElementById('sel-assessor').value.trim();
  const date = document.getElementById('sel-date').value;
  if (!assessor||!date){showToast('Enter assessor name and date','error');return;}
  const stds = getStandards();
  const scored = stds.filter(s=>_scores[s.code]!==undefined);
  const total = scored.reduce((a,s)=>a+_scores[s.code],0);
  const max = stds.length*4;
  const pct = max ? parseFloat((total/max*100).toFixed(2)) : 0;
  const {error} = await supabase.from('nabh_self_assessments').insert({
    tenant_id:tenantId,
    assessment_type:_currentType,
    assessment_date:date,
    assessor_name:assessor,
    scores:_scores,
    total_standards:stds.length,
    total_score:total,
    max_score:max,
    compliance_percent:pct,
    submitted_by:profile.id
  });
  if (error){showToast('Error: '+error.message,'error');return;}
  showToast('Assessment saved — '+pct+'% compliance','success');
};

window.loadHistory = async () => {
  const {data} = await supabase.from('nabh_self_assessments').select('id,assessment_date,assessor_name,compliance_percent,assessment_type,total_standards').eq('tenant_id',tenantId).order('assessment_date',{ascending:false}).limit(20);
  const list = document.getElementById('hist-list');
  if (!data?.length){list.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-muted)">No saved assessments.</div>';document.getElementById('hist-modal').classList.add('show');return;}
  list.innerHTML = data.map(a=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:500">${a.assessment_date} — ${_esc(a.assessor_name)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${_esc(a.assessment_type.toUpperCase())} · ${a.total_standards} standards · ${a.compliance_percent}%</div>
      </div>
      <button class="btn btn-sm btn-outline" data-onclick="loadAssessment" data-onclick-a0="${a.id}">Load</button>
    </div>`).join('');
  document.getElementById('hist-modal').classList.add('show');
};

window.loadAssessment = async (id) => {
  const {data} = await supabase.from('nabh_self_assessments').select('*').eq('id',id).single();
  if (!data){showToast('Could not load','error');return;}
  document.getElementById('sel-type').value = data.assessment_type;
  document.getElementById('sel-assessor').value = data.assessor_name;
  document.getElementById('sel-date').value = data.assessment_date;
  _currentType = data.assessment_type;
  _scores = data.scores||{};
  render();
  closeModal('hist-modal');
  showToast('Assessment loaded — '+data.compliance_percent+'% compliance','success');
};

window.closeModal = id => document.getElementById(id).classList.remove('show');

function showToast(msg,type='success'){const t=document.getElementById('toast');t.textContent=msg;t.className=`toast ${type} show`;setTimeout(()=>t.classList.remove('show'),3000);}
function _esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Expand first chapter by default
render();
const firstChBody = document.querySelector('.chapter-body');
if (firstChBody) firstChBody.classList.add('open');
