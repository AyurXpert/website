import { requireAuth, getCurrentProfile } from '../core/auth.js';
import { initNavbar }  from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse']);
initNavbar();
wireDelegatedEvents();

const _role = getCurrentProfile()?.role;

/* ─────────────────────────────────────────────────────────────
   DEPARTMENT + MODULE DEFINITIONS
   page  → standalone page link
   consult → feature inside doctor.html consultation tabs
   soon  → coming soon (disabled)

   Session 205 real bug fix, found live going through the navbar item-by-item with
   Dr. Venkatesh: this hub showed the exact same 28-page link list to every viewer
   regardless of role, with zero filtering -- 9 of the 28 (admin.html/bed-admin.html/
   dpc.html/formulary-admin.html/iqac.html/ncism-compliance.html/pharmacovigilance.html/
   quality.html/yoga.html) silently bounced a nurse back to nursing.html on click, the
   same dead-end pattern already fixed on the top navbar (and yoga.html specifically
   proved the top-navbar fix alone wasn't enough -- this hub had its own independent,
   unfiltered link to it). Every href-bearing module below now carries `roles:[...]`
   copied verbatim from that destination page's own requireAuth() call (not re-derived
   or guessed) -- consult/soon entries have no href and are never gated, since they're
   not real navigable links.
───────────────────────────────────────────────────────────── */
const DEPTS = [
  {
    code:'KAY', name:'Kayachikitsa', icon:'🩺', desc:'Internal Medicine',
    modules:[
      { icon:'🔍', name:'Prakriti Pariksha', desc:'20-question constitutional assessment (V/P/K)',  type:'consult', ncism:'§18d' },
      { icon:'📋', name:'Consultation & NAMASTE', desc:'Full 9-tab OPD consultation with dual coding', type:'consult', ncism:'' },
      { icon:'📖', name:'Hospital Formulary',     desc:'Approved medicines list, NCISM §6(2)',         href:'formulary-admin.html', ncism:'§18as', roles:['super_admin','dept_admin'] },
      { icon:'📄', name:'Medical Certificate',    desc:'Medical / Fitness / Sick Leave certificate',  type:'consult', ncism:'§12d' },
    ]
  },
  {
    code:'PK', name:'Panchakarma', icon:'🌸', desc:'Panchakarma Therapies',
    modules:[
      { icon:'📅', name:'Therapy Scheduler',      desc:'Daily PK session scheduling & therapist assignment', href:'therapist.html', ncism:'', roles:['super_admin','dept_admin','doctor','therapist','nurse'] },
      { icon:'🍲', name:'Palha Diet Centre',       desc:"Today's diet indent, kitchen workflow, SOP",           href:'palha-diet.html', ncism:'§18bb', roles:['super_admin','dept_admin','doctor','nurse','receptionist','diet_staff'] },
      { icon:'💊', name:'PK Therapy Prescription',desc:'Prescribe PK medicines from therapist screen',         type:'consult', ncism:'§18n' },
      { icon:'📋', name:'PK Proforma',             desc:'Panchakarma specialty proforma in consultation',       type:'consult', ncism:'§18v' },
    ]
  },
  {
    code:'SHAL', name:'Shalya Tantra', icon:'🔪', desc:'Surgery & Para-surgical Procedures',
    modules:[
      { icon:'🧵', name:'Kshara Sutra Scheduler', desc:'Weekly thread change tracking & appointments', href:'ksharasutra.html', ncism:'§18o', roles:['super_admin','dept_admin','doctor','nurse'] },
      { icon:'⚗',  name:'Anushastra Karma',        desc:'Agnikarma · Raktamokshana · Ksharakarma · Pain Mgmt', href:'anushastra.html', ncism:'§47(c)', roles:['super_admin','dept_admin','doctor','nurse','therapist','receptionist'] },
      { icon:'🏥', name:'Minor OT Procedures',     desc:'Minor surgical procedure records & print',           href:'minor-ot.html',  ncism:'§18p', roles:['super_admin','dept_admin','doctor','nurse'] },
      { icon:'🔪', name:'Major OT Register',       desc:'Full theatre management — scheduling, logbook, print', href:'major-ot.html', ncism:'§18p', roles:['super_admin','dept_admin','doctor','nurse'] },
      { icon:'📋', name:'Shalya Proforma',          desc:'Specialty examination proforma in consultation',       type:'consult', ncism:'§18z' },
    ]
  },
  {
    code:'SHAK', name:'Shalakya Tantra', icon:'👁', desc:'ENT & Ophthalmology',
    modules:[
      { icon:'👁', name:'Ophthalmology Examination', desc:'VA, IOP, slit lamp, fundus, Netra Pariksha', type:'consult', ncism:'§18r' },
      { icon:'👂', name:'ENT Examination',            desc:'Ear / nose / throat, Rinne / Weber tests',   type:'consult', ncism:'§18t' },
      { icon:'💧', name:'Netra Kriya Kalpa',          desc:'Tarpana, Putapaka, Anjana session tracker',  type:'soon',    ncism:'§18s' },
      { icon:'🌬', name:'ENT Kriya Kalpa',            desc:'Nasya, Karnapurana session tracker',         type:'soon',    ncism:'§18u' },
    ]
  },
  {
    code:'KAU', name:'Kaumarabhritya', icon:'👶', desc:'Paediatrics',
    modules:[
      { icon:'📐', name:'Bala Matra Calculator', desc:'Sharangadhara dose formula for children',      type:'consult', ncism:'§18ac' },
      { icon:'📈', name:'Growth Chart',           desc:'WHO/IAP percentile bars, SAM/MAM alert',      type:'consult', ncism:'§18ad' },
      { icon:'💉', name:'Immunization Record',    desc:'NIP India 28-vaccine schedule & history',     type:'consult', ncism:'§18ae' },
      { icon:'📋', name:'Kaumarabhritya Proforma',desc:'Paediatric specialty proforma',                type:'consult', ncism:'§18g' },
    ]
  },
  {
    code:'PST', name:'Prasuti & Stri Roga', icon:'🤱', desc:'Obstetrics & Gynaecology',
    modules:[
      { icon:'🔬', name:'Obs/Gyn Examination',  desc:'Menstrual Hx, GPAL, FHS, fundal, PS/PV', type:'consult', ncism:'§18w' },
      { icon:'📊', name:'ANC Register',         desc:'Antenatal register across multiple visits', href:'anc.html', ncism:'§18x', roles:['super_admin','dept_admin','doctor','nurse','receptionist'] },
      { icon:'🤱', name:'Labour Room',          desc:'Delivery register, partograph, APGAR, newborn care', href:'labour-room.html', ncism:'§8.9', roles:['super_admin','dept_admin','doctor','nurse','receptionist'] },
      { icon:'📋', name:'Prasuti Proforma',      desc:'Obstetrics specialty proforma',            type:'consult', ncism:'§18v' },
    ]
  },
  {
    code:'AGD', name:'Agada Tantra', icon:'⚗', desc:'Toxicology & Forensic Medicine',
    modules:[
      { icon:'📒', name:'Visha Register',      desc:'Poisoning cases register in consultation', type:'consult', ncism:'§18af' },
      { icon:'🚨', name:'Poison Case Records', desc:'Detailed poison case documentation',        type:'consult', ncism:'§18af' },
    ]
  },
  {
    code:'SW', name:'Swasthavritta & Yoga', icon:'🧘', desc:'Preventive & Social Medicine',
    modules:[
      { icon:'🌿', name:'Swasthya Raksha Card', desc:'Prakriti, Ritucharya, Dinacharya print card', type:'consult', ncism:'§18c' },
      { icon:'📋', name:'Advice & Pathya',       desc:'Lifestyle, diet, yoga advice in consultation', type:'consult', ncism:'' },
      { icon:'🍃', name:'Seasonal Prophylaxis',  desc:'Vasanta Shodhana, Sharad Rasayana — enrolment & compliance tracker', href:'prophylaxis.html', ncism:'§18e', roles:['super_admin','dept_admin','doctor','receptionist','nurse'] },
      { icon:'🧘', name:'Yoga Session Register', desc:'Schedule sessions + attendance register', href:'yoga.html', ncism:'§47(l)', roles:['super_admin','dept_admin','therapist','doctor','receptionist'] },
    ]
  },
  {
    code:'MAN', name:'Manovaha (Psychiatry)', icon:'🧠', desc:'Mental Health — MHA 2017',
    modules:[
      { icon:'🚩', name:'Mental Health Flag',    desc:'Flag & document mental health concerns',    type:'soon', ncism:'§18ai' },
      { icon:'📝', name:'MHA 2017 Consent',      desc:'Mental Healthcare Act 2017 consent module', type:'soon', ncism:'§18aj' },
    ]
  },
  {
    code:'IPD', name:'IPD & Ward', icon:'🏥', desc:'In-Patient Department',
    modules:[
      { icon:'🛏', name:'IPD Admissions',     desc:'Admit, bed assignment, discharge workflow', href:'ipd.html',      ncism:'', roles:['super_admin','dept_admin','doctor','receptionist','nurse'] },
      { icon:'🏗', name:'Bed Management',     desc:'Bed matrix, ward setup, occupancy view',    href:'bed-admin.html', ncism:'', roles:['super_admin','dept_admin'] },
      { icon:'📋', name:'Ward Round Notes',   desc:'SOAP notes per IPD patient per day',        href:'ipd.html',       ncism:'', roles:['super_admin','dept_admin','doctor','receptionist','nurse'] },
      { icon:'📄', name:'Discharge Summary',  desc:'Print IPD discharge summary (§15d)',        href:'ipd.html',       ncism:'§15d', roles:['super_admin','dept_admin','doctor','receptionist','nurse'] },
    ]
  },
  {
    code:'SCR', name:'Screening OPD', icon:'🔭', desc:'Mandatory Triage — NCISM',
    modules:[
      { icon:'🔭', name:'Screening Triage',   desc:'Emergency / Urgent / Routine triage & routing', href:'screening.html', ncism:'', roles:['super_admin','dept_admin','doctor','nurse'] },
      { icon:'🚨', name:'Emergency OPD',      desc:'Atyayika Chikitsa · 24×7 case register, RMO duty, MLC', href:'emergency.html', ncism:'§4.6', roles:['super_admin','dept_admin','doctor','nurse','receptionist'] },
    ]
  },
  {
    code:'ADM', name:'Administration', icon:'⚙', desc:'Hospital Administration & Compliance',
    modules:[
      { icon:'📊', name:'NCISM Compliance',    desc:'OPD ratio, bed occupancy, Table-7 & 8',       href:'ncism-compliance.html', ncism:'', roles:['super_admin','dept_admin','accountant'] },
      { icon:'⭐', name:'Quality Management', desc:'Incident reports, patient feedback, quality indicators hub', href:'quality.html',   ncism:'§12', roles:['super_admin','dept_admin'] },
      { icon:'🗓', name:'24×7 Duty Roster',    desc:'Weekly shift grid, on-call, gap detection',    href:'roster.html',           ncism:'§18h', roles:['super_admin','dept_admin','nurse_manager','nurse'] },
      { icon:'💊', name:'Drug Procurement',    desc:'Procurement committee meeting tracker',         href:'dpc.html',               ncism:'§18at', roles:['super_admin','dept_admin','accountant'] },
      { icon:'🧪', name:'Pharmacovigilance',  desc:'Bimonthly PV Cell meetings, ADR review, report submission', href:'pharmacovigilance.html', ncism:'§48', roles:['super_admin','dept_admin','doctor','receptionist'] },
      { icon:'🏅', name:'IQAC',               desc:'Quarterly quality assurance meetings, indicators, action tracking', href:'iqac.html',      ncism:'§12.1', roles:['super_admin','dept_admin','doctor','receptionist'] },
      { icon:'♻',  name:'BMW Management',    desc:'Daily waste log, CBWTF pickup, autoclave, monthly SPCB report',   href:'bmw.html',       ncism:'§10.4', roles:['super_admin','dept_admin','doctor','nurse','receptionist'] },
      { icon:'🧹', name:'Facility Ops',      desc:'Housekeeping rounds, laundry cycles, security visitor + incident register', href:'facility-ops.html', ncism:'§50(6)/(7)/(9)', roles:['super_admin','dept_admin','nurse','receptionist'] },
      { icon:'🔬', name:'CSSD / Sterilisation', desc:'Cycle log, BI testing, equipment register, sterility expiry',   href:'sterilisation.html', ncism:'§13', roles:['super_admin','dept_admin','doctor','nurse','receptionist'] },
      { icon:'🔬', name:'NABL Lab Quality',        desc:'Sample traceability, QC Levey-Jennings chart, Westgard rules, calibration register', href:'lab-nabl.html', ncism:'ISO 15189', roles:['super_admin','dept_admin','lab_tech','doctor','nurse'] },
      { icon:'📒', name:'OPD Register',          desc:'Daily/monthly OPD patient register (NCISM format) — printable, CSV export',  href:'opd-register.html', ncism:'§2.1', roles:['super_admin','dept_admin','doctor','receptionist','nurse'] },
      { icon:'🛏️', name:'IPD Register',          desc:'In-patient admission register — LOS, diagnosis, discharge status, printable', href:'ipd-register.html', ncism:'§2.2', roles:['super_admin','dept_admin','doctor','nurse','receptionist'] },
      { icon:'📈', name:'Monthly Report',      desc:'NCISM monthly data export — OPD, IPD, beds, procedures', href:'admin.html',             ncism:'§2.2', roles:['super_admin','dept_admin'] },
    ]
  },
];

// Session 205: a module with no `roles` (every `consult`/`soon` entry — not a real navigable
// link) is never gated. super_admin bypasses every gate here too, matching requireAuth()'s own
// platform-wide convention.
function _moduleVisible(m) {
  return !m.roles || _role === 'super_admin' || m.roles.includes(_role);
}

function buildHub() {
  const grid = document.getElementById('dept-grid');
  grid.innerHTML = '';
  DEPTS.forEach((dept, i) => {
    const visibleModules = dept.modules.filter(_moduleVisible);
    if (!visibleModules.length) return; // nothing this viewer can use in this department at all

    const card = document.createElement('div');
    card.className = 'dept-card';
    card.dataset.dept = dept.code;

    const modulesHTML = visibleModules.map(m => {
      const disabled  = m.type === 'soon' ? 'disabled' : '';
      const href      = m.href ? `href="${m.href}"` : '';
      const tag       = m.href ? 'a' : 'div';
      const badges = [
        m.ncism ? `<span class="badge badge-ncism">${m.ncism}</span>` : '',
        m.href      ? `<span class="badge badge-page">Page</span>`    : '',
        m.type === 'consult' ? `<span class="badge badge-consult">In Consultation</span>` : '',
        m.type === 'soon'    ? `<span class="badge badge-soon">Coming Soon</span>`       : '',
      ].filter(Boolean).join('');
      return `<${tag} class="module-item ${disabled}" ${href}>
        <div class="module-icon">${m.icon}</div>
        <div class="module-info">
          <div class="module-name">${m.name}</div>
          <div class="module-desc">${m.desc}</div>
          <div class="module-badges">${badges}</div>
        </div>
        ${!disabled ? '<span class="module-arrow">›</span>' : ''}
      </${tag}>`;
    }).join('<div class="module-divider"></div>');

    card.innerHTML = `
      <div class="dept-card-hdr" data-onclick="toggleDept" data-onclick-a0="@this">
        <div class="dept-icon">${dept.icon}</div>
        <div>
          <div class="dept-name">${dept.name}</div>
          <div class="dept-code">${dept.code} · ${dept.desc}</div>
        </div>
        <span class="dept-chevron">▼</span>
      </div>
      <div class="dept-modules">${modulesHTML}</div>`;

    grid.appendChild(card);
  });
}

window.toggleDept = function(headerEl) {
  const card = headerEl.closest('.dept-card');
  const isOpen = card.classList.contains('open');
  document.querySelectorAll('.dept-card.open').forEach(c => c.classList.remove('open'));
  if (!isOpen) card.classList.add('open');
};

window.filterDepts = function() {
  const q = document.getElementById('dept-search').value.trim().toLowerCase();
  document.querySelectorAll('.dept-card').forEach(card => {
    const text = card.textContent.toLowerCase();
    const match = !q || text.includes(q);
    card.style.display = match ? '' : 'none';
    if (q && match) card.classList.add('open');
    else if (!q) card.classList.remove('open');
  });
};

buildHub();

// Auto-open if ?dept= param in URL
const dp = new URLSearchParams(location.search).get('dept');
if (dp) {
  const target = document.querySelector(`.dept-card[data-dept="${dp}"]`);
  if (target) { target.classList.add('open'); target.scrollIntoView({ behavior:'smooth', block:'center' }); }
}
