import { registerTenant } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { isValidEmail, isValidPhone, validatePassword } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

/* ─────────────────────────────────────────
   ORG TYPE DATA
───────────────────────────────────────── */
const ORG_DATA = {
  /* ── Row 1 — Clinical Patient Care ── */
  clinic: {
    name: 'Clinic', system: 'Clinic Management System',
    tag: 'OPD · Prescription · Billing', abbr: 'CL', cat: 'clinical', nabh: true,
    features: ['Token-based OPD queue','Doctor consultation + NAMASTE coding','ABHA enrollment & Scan & Share','Pharmacy dispensing + billing','Prescription printing']
  },
  pk_center: {
    name: 'Panchakarma Center', system: 'Panchakarma Management System',
    tag: 'Therapy · Scheduling · Palha Diet', abbr: 'PK', cat: 'clinical', nabh: true,
    features: ['Purva / Pradhana / Paschatkarma tracking','Therapist assignment & scheduling','ABHA-linked treatment records','Day-care session documentation','Palha diet & PK feedback loop']
  },
  hospital: {
    name: 'Ayurveda Hospital', system: 'Hospital Management System',
    tag: 'OPD · IPD · Beds · Multi-dept', abbr: 'HO', cat: 'clinical', nabh: true,
    features: ['All Clinic features + full IPD management','Bed allocation & live availability','Multi-department OPD routing','Panchakarma therapy module','Pharmacy + purchase management']
  },
  /* ── Row 2 — NCISM / Academic / Publishing ── */
  college: {
    name: 'College', system: 'College Management System',
    tag: 'Academic · NCISM Compliant', abbr: 'AC', cat: 'education', nabh: true, ncism: true,
    features: ['NCISM academic compliance tracking','Faculty & student management','Academic calendar & timetable','Examination management','Attendance & exposure records']
  },
  teaching_hospital: {
    name: 'Teaching Hospital', system: 'Hospital Management System',
    tag: 'NCISM Mandatory · OPD · IPD · UG/PG', abbr: 'TH', cat: 'education', nabh: true, ncism: true,
    features: ['All Hospital features + NCISM compliance','10 mandatory OPDs auto-seeded on setup','1:2 OPD ratio monitoring — Table-7','Department-wise bed matrix — Table-8','Screening OPD mandatory routing']
  },
  journal: {
    name: 'Journal / Publication', system: 'Journal Management System',
    tag: 'Academic publishing · Peer review', abbr: 'JP', cat: 'trade',
    features: ['Article submission portal','Peer review workflow','Author management','Publication archive','DOI integration (planned)']
  },
  /* ── Row 3 — Support & Commercial ── */
  dispensary: {
    name: 'Dispensary', system: 'Dispensary Management System',
    tag: 'Medicine dispensing · Billing', abbr: 'DI', cat: 'clinical', nabh: true,
    features: ['Prescription-based dispensing','AFI formulation database (275+)','Stock + expiry tracking','Purchase order management','Billing + invoices']
  },
  laboratory: {
    name: 'Diagnostic Lab', system: 'Laboratory Management System',
    tag: 'Pathology · Diagnostics', abbr: 'LA', cat: 'diag', nabh: true,
    features: ['Lab order intake from OPD','Result entry + QC','Digital report delivery','Sample tracking','Barcode-based sample management']
  },
  pharma: {
    name: 'Pharma Company', system: 'Pharma Management System',
    tag: 'Manufacturing · Sales · Distribution', abbr: 'PH', cat: 'pharma',
    features: ['Product catalogue management','Batch & expiry tracking','GRN / purchase orders','Dealer-distributor network','AFI formulation reference']
  },
  raw_drug_supplier: {
    name: 'Raw Drug Supplier', system: 'Supplier Management System',
    tag: 'Dravya supply chain', abbr: 'RD', cat: 'pharma',
    features: ['Supplier product catalogue','Stock management','Quality batch tracking','Purchase order management','Retailer network']
  },
  instrument_supplier: {
    name: 'Instrument Supplier', system: 'Supplier Management System',
    tag: 'Surgical & diagnostic equipment', abbr: 'IS', cat: 'pharma',
    features: ['Equipment catalogue','Order management','Service & AMC tracking','Hospital supply network','Invoice management']
  },
  chemical_supplier: {
    name: 'Chemical Supplier', system: 'Supplier Management System',
    tag: 'Lab chemicals & reagents', abbr: 'CS', cat: 'pharma',
    features: ['Chemical catalogue','Batch certification','Order management','Lab network integration','Invoice & compliance']
  },
  dealer: {
    name: 'Dealer / Distributor', system: 'Distribution Management System',
    tag: 'Medicine distribution · Trade', abbr: 'DD', cat: 'trade',
    features: ['Multi-brand stock management','Retailer order processing','Invoice + credit notes','Expiry batch tracking','Pharma network integration']
  },
};

/* ─────────────────────────────────────────
   STATE
───────────────────────────────────────── */
let selectedOrgType = null;
let selectedIntake  = null;
let gpsCoords       = null;

const CLINICAL_CODES = new Set(['KAY','PK','SHAL','SHAK','KAU','PST','AGD']);
const UG_BED_RATIOS  = { KAY:.20, PK:.25, SHAL:.20, SHAK:.10, KAU:.10, AGD:.05, PST:.10 };
const WARD_NAMES     = { KAY:'General Ward', PK:'Panchakarma Ward', SHAL:'Surgical Ward', SHAK:'ENT Ward', KAU:'Paediatric Ward', AGD:'General Ward', PST:'Maternity Ward' };

const NCISM_OPDS = [
  { name:'Screening OPD',           ncism_code:'SCREEN', description:'Mandatory triage for all new patients before specialty routing' },
  { name:'Kayachikitsa OPD',        ncism_code:'KAY',    description:'Internal Medicine' },
  { name:'Panchakarma OPD',         ncism_code:'PK',     description:'Panchakarma therapies' },
  { name:'Shalya Tantra OPD',       ncism_code:'SHAL',   description:'Surgery' },
  { name:'Shalakya Tantra OPD',     ncism_code:'SHAK',   description:'ENT & Ophthalmology' },
  { name:'Kaumarabhritya OPD',      ncism_code:'KAU',    description:'Paediatrics' },
  { name:'Swasthavritta OPD',       ncism_code:'SW',     description:'Preventive & Social Medicine' },
  { name:'Prasuti & Stri Roga OPD', ncism_code:'PST',    description:'Obstetrics & Gynaecology' },
  { name:'Agada Tantra OPD',        ncism_code:'AGD',    description:'Toxicology & Forensic Medicine' },
  { name:'Rog Nidana OPD',          ncism_code:'RNV',    description:'Pathology & Diagnosis' },
];

const NCISM_DEPTS = [
  { name:'Kayachikitsa',                    ncism_code:'KAY',  type:'clinical' },
  { name:'Panchakarma',                     ncism_code:'PK',   type:'clinical' },
  { name:'Shalya Tantra',                   ncism_code:'SHAL', type:'clinical' },
  { name:'Shalakya Tantra',                 ncism_code:'SHAK', type:'clinical' },
  { name:'Kaumarabhritya',                  ncism_code:'KAU',  type:'clinical' },
  { name:'Prasuti & Stri Roga',             ncism_code:'PST',  type:'clinical' },
  { name:'Agada Tantra',                    ncism_code:'AGD',  type:'clinical' },
  { name:'Swasthavritta & Yoga',            ncism_code:'SW',   type:'para_clinical' },
  { name:'Rog Nidana & Vikruti Vigyana',    ncism_code:'RNV',  type:'para_clinical' },
  { name:'Dravyaguna',                      ncism_code:'DG',   type:'pre_clinical' },
  { name:'Rasashastra & Bhaishajya Kalpana',ncism_code:'RBK',  type:'pre_clinical' },
  { name:'Sanskrit & Samhita',              ncism_code:'SS',   type:'pre_clinical' },
  { name:'Rachana & Kriya Sharir',          ncism_code:'RS',   type:'para_clinical' },
];

function isNCISMType(t) { return t === 'college' || t === 'teaching_hospital'; }

/* ─────────────────────────────────────────
   RENDER ORG CARDS
───────────────────────────────────────── */
const CARD_ICONS = {
  clinic:'🩺', pk_center:'🌿', hospital:'🏥',
  college:'🎓', teaching_hospital:'🏛', journal:'📰',
  dispensary:'💊', laboratory:'🔬', pharma:'🏭',
  raw_drug_supplier:'🌱', instrument_supplier:'🔧', chemical_supplier:'⚗️', dealer:'🚚',
};

const CARD_MARKETING = {
  clinic:['See more patients with smart token queues','ABHA Health ID linked in under 60 seconds','E-prescriptions sent to pharmacy instantly','Works offline — no internet, no problem','ABDM-compliant from your very first patient'],
  pk_center:['Purva, Pradhana & Paschatkarma — all tracked','Therapist schedules & assignments at a glance','ABHA-linked treatment records per patient','Palha diet indent & kitchen management','PK feedback loop — therapy → doctor alert'],
  hospital:['Full OPD & IPD managed in one platform','Every patient gets an ABHA Health ID','Dept-wise routing & live bed availability','From admission to discharge, fully digital','Panchakarma therapy module built in'],
  college:['NCISM academic compliance built in','Faculty, student & attendance management','Academic timetable & examination records','Integrated with Teaching Hospital HMS','College Management System — NCISM ready'],
  teaching_hospital:['NCISM OPDs, depts & beds — auto-seeded','1:2 OPD ratio compliance always in check','Mandatory Screening OPD flow built in','Table-7 & Table-8 reports ready to submit','PG seat tracking & ward round notes'],
  journal:['Article submission portal','Peer review workflow management','Author & editorial management','Publication archive with search','DOI integration (planned)'],
  dispensary:['Dispense prescriptions in seconds','275+ AFI classical formulations built in','Expiry alerts before stock is a problem','GST billing & professional invoices','Connected to prescribing doctors in real time'],
  laboratory:['Lab orders arrive the moment a doctor sends them','Digital reports delivered to patients instantly','Quality control & sample tracking built in','Integrated with OPD — no double entry','Barcode-based sample management'],
  pharma:['Product catalogue management','Batch & expiry tracking','GRN / purchase orders','Dealer-distributor network','AFI formulation reference built in'],
  raw_drug_supplier:['Manage your full Dravya catalogue digitally','Quality batch documentation, always ready','Order fulfilment tracked end-to-end','Direct supply to hospitals & dispensaries','Digital delivery records, audit-ready'],
  instrument_supplier:['Full equipment catalogue & spec sheets online','AMC & service schedules tracked automatically','Order delivery tracked from quote to receipt','Connected to hospital procurement teams','Professional invoicing & documentation'],
  chemical_supplier:['Chemical catalogue with batch certification','Lab network integration','Order management & invoicing','Quality & compliance documentation','Retailer network management'],
  dealer:['Multi-brand stock management','Retailer order processing','Invoice + credit notes','Expiry batch tracking','Pharma network integration'],
  pharma:['Your entire product catalogue, digitised','Batch tracking from manufacturing to delivery','GRN & purchase orders handled automatically','Direct link to your dealer-distributor network','AFI formulation reference always at hand'],
  raw_drug_supplier:['Manage your full Dravya catalogue digitally','Quality batch documentation, always ready','Order fulfilment tracked end-to-end','Direct supply to hospitals & dispensaries','Digital delivery records, audit-ready'],
  instrument_supplier:['Full equipment catalogue & spec sheets online','AMC & service schedules tracked automatically','Order delivery tracked from quote to receipt','Connected to hospital procurement teams','Professional invoicing & documentation'],
  chemical_supplier:['Chemical & reagent catalogue, always current','Batch certification records, digitally stored','Lab supply orders managed in one place','Compliance documentation, always ready','Secure order tracking for every shipment'],
  dealer:['Every brand, every stock level — one dashboard','Retailer orders processed & tracked digitally','Expiry batch alerts before they become a problem','Automated invoicing & credit note management','Direct integration with pharma suppliers'],
  journal:['Receive & review submissions entirely online','Peer review workflow, structured & trackable','Author & reviewer database, always organised','Digital publication archive, searchable forever','DOI integration — coming soon'],
};

(function renderOrgCards() {
  const container = document.getElementById('org-cards-container');
  if (!container) return;

  const ROW1 = ['clinic', 'pk_center', 'hospital'];
  const ROW2 = ['college', 'teaching_hospital', 'journal'];
  const ROW3 = ['dispensary', 'laboratory', 'pharma', 'raw_drug_supplier', 'instrument_supplier', 'chemical_supplier', 'dealer'];

  function buildCard(typeKey) {
    const d = ORG_DATA[typeKey];
    const icon     = CARD_ICONS[typeKey] || '🏢';
    const benefits = CARD_MARKETING[typeKey] || d.features;
    const featItems = benefits.map(f => `<li>${f}</li>`).join('');
    const badges = [
      '<span class="org-nabh-badge">NABH</span>',
      d.ncism ? '<span class="org-ncism-badge">NCISM</span>' : ''
    ].join('');

    const card = document.createElement('div');
    card.className = `org-card cat-${d.cat}`;
    card.innerHTML = `
      <div class="org-icon-wrap">${icon}</div>
      <div class="org-name">${d.name}</div>
      <div class="org-system-name">${d.system}</div>
      <div class="org-badges">${badges}</div>
      <div class="org-desc">${d.tag}</div>
      <div class="org-arrow">Register &rarr;</div>
      <div class="org-overlay">
        <div class="ov-label">What's included</div>
        <div class="ov-name">${d.name}</div>
        <ul class="ov-list">${featItems}</ul>
        <button class="ov-btn" data-type="${typeKey}">Register ${d.name} &rarr;</button>
      </div>`;

    card.querySelector('.ov-btn').addEventListener('click', e => {
      e.stopPropagation();
      selectOrgType(typeKey);
    });
    card.addEventListener('click', function(e) {
      if (e.target.closest('.ov-btn')) return;
      const isTouch = !window.matchMedia('(hover:hover)').matches;
      if (isTouch) {
        if (!card.classList.contains('show-overlay')) {
          document.querySelectorAll('.org-card').forEach(c => c.classList.remove('show-overlay'));
          card.classList.add('show-overlay');
        } else {
          selectOrgType(typeKey);
        }
        return;
      }
      selectOrgType(typeKey);
    });
    return card;
  }

  const row1 = document.createElement('div');
  row1.className = 'org-row-1';
  ROW1.forEach(k => row1.appendChild(buildCard(k)));

  const row2 = document.createElement('div');
  row2.className = 'org-row-1';
  ROW2.forEach(k => row2.appendChild(buildCard(k)));

  const row3 = document.createElement('div');
  row3.className = 'org-row-1';
  ROW3.forEach(k => row3.appendChild(buildCard(k)));

  const row3label = document.createElement('div');
  row3label.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-top:12px;margin-bottom:-4px;padding-left:2px';
  row3label.textContent = 'Dispensary, Diagnostics & Commercial';

  container.appendChild(row1);
  container.appendChild(row2);
  container.appendChild(row3label);
  container.appendChild(row3);

  document.addEventListener('click', e => {
    if (!e.target.closest('.org-card'))
      document.querySelectorAll('.org-card').forEach(c => c.classList.remove('show-overlay'));
  });
})();

/* ─────────────────────────────────────────
   URL PARAM AUTO-SELECT
───────────────────────────────────────── */
(function() {
  const t = new URLSearchParams(window.location.search).get('type');
  if (t && ORG_DATA[t]) selectOrgType(t);
})();

/* ─────────────────────────────────────────
   ORG TYPE SELECTION
───────────────────────────────────────── */
window.selectOrgType = function(type) {
  if (!ORG_DATA[type]) return;
  const d = ORG_DATA[type];

  // REGISTRATION INACTIVE — show contact popup (see TODO_LATER.md §17b to activate)
  document.getElementById('contact-org-name').textContent = d.name;
  document.getElementById('contact-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  return;

  selectedOrgType = type;
  document.getElementById('sc-icon').textContent  = d.abbr;
  document.getElementById('sc-icon').className    = `sc-icon cat-${d.cat}`;
  document.getElementById('sc-name').textContent  = d.name;
  document.getElementById('sc-tag').textContent   = d.tag;
  const ind3 = document.getElementById('step-ind-3');
  const ind4 = document.getElementById('step-ind-4');
  if (isNCISMType(type)) { ind4.style.display=''; ind3.classList.remove('no-connector'); }
  else { ind4.style.display='none'; ind3.classList.add('no-connector'); }
  document.getElementById('marketing-page').style.display = 'none';
  document.getElementById('reg-form').style.display = 'block';
  showStep(1);
  window.scrollTo({ top:0, behavior:'smooth' });
};

window.closeContactOverlay = function() {
  document.getElementById('contact-overlay').style.display = 'none';
  document.body.style.overflow = '';
};

window._closeContactOverlayIfBackdrop = function(isTarget) {
  if (isTarget) closeContactOverlay();
};

window._scrollToChooseType = function() {
  document.getElementById('choose-type').scrollIntoView({ behavior: 'smooth' });
};

window._closeMenuAndScrollToChooseType = function() {
  closeMktMenu();
  document.getElementById('choose-type').scrollIntoView({ behavior: 'smooth' });
};

window.changeOrgType = function() {
  selectedOrgType = null;
  selectedIntake  = null;
  document.querySelectorAll('.intake-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('marketing-page').style.display = '';
  document.getElementById('reg-form').style.display = 'none';
  setTimeout(() => {
    document.getElementById('choose-type').scrollIntoView({ behavior: 'smooth' });
  }, 50);
};

/* ─────────────────────────────────────────
   STEP NAVIGATION
───────────────────────────────────────── */
window.nextStep = function(from) {
  from = Number(from);
  clearAlert();
  if (from === 1) {
    const name  = document.getElementById('org-name').value.trim();
    const state = document.getElementById('org-state').value;
    const city  = document.getElementById('org-city').value.trim();
    const phone = document.getElementById('org-phone').value.trim();
    if (!name)  return showAlert('Please enter your organisation name.');
    if (!state) return showAlert('Please select your state.');
    if (!city)  return showAlert('Please enter your city or district.');
    if (!phone) return showAlert('Please enter your phone number.');
    showStep(2);
  } else if (from === 2) {
    const name    = document.getElementById('admin-name').value.trim();
    const email   = document.getElementById('admin-email').value.trim();
    const phone   = document.getElementById('admin-phone').value.trim();
    const pw      = document.getElementById('admin-password').value;
    const confirm = document.getElementById('admin-confirm').value;
    if (!name)          return showAlert('Please enter your full name.');
    if (!email)         return showAlert('Please enter your email address.');
    if (!isValidEmail(email)) return showAlert('Please enter a valid email address.');
    if (!phone)         return showAlert('Please enter your phone number.');
    if (!isValidPhone(phone)) return showAlert('Please enter a valid 10-digit mobile number.');
    const pwCheck = validatePassword(pw);
    if (!pwCheck.valid) return showAlert(pwCheck.message);
    if (pw !== confirm) return showAlert('Passwords do not match. Please re-enter.');
    showStep(3);
  }
};

window.goBack = function(to) { clearAlert(); showStep(Number(to)); };

function showStep(n) {
  [1,2,3,4].forEach(i => {
    const el = document.getElementById(`step-${i}`);
    if (el) el.style.display = i === n ? 'block' : 'none';
    const ind = document.getElementById(`step-ind-${i}`);
    if (ind) {
      ind.classList.remove('active','done');
      if (i < n)   ind.classList.add('done');
      if (i === n) ind.classList.add('active');
    }
  });
  if (n === 3) {
    const btn = document.getElementById('btn-step3');
    if (btn) btn.querySelector('.btn-text').textContent =
      isNCISMType(selectedOrgType) ? 'Next: NCISM Setup →' : 'Register & Start';
  }
  if (n === 4 && selectedIntake) updatePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.handleStep3Btn = async function(btn) {
  clearAlert();
  if (isNCISMType(selectedOrgType)) {
    showStep(4);
  } else {
    await handleRegister(btn);
  }
};

/* ─────────────────────────────────────────
   NCISM STEP 4
───────────────────────────────────────── */
window.selectIntake = function(val, el) {
  selectedIntake = Number(val);
  document.querySelectorAll('.intake-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  updatePreview();
};

window.togglePGDept = function(cb, code) {
  const row   = document.getElementById(`pgd-${code}`);
  const input = document.getElementById(`pgs-${code}`);
  if (cb.checked) { row.classList.remove('off'); input.disabled = false; }
  else            { row.classList.add('off');    input.disabled = true; }
  updatePreview();
};

function getSelectedPGDepts() {
  const result = [];
  document.querySelectorAll('.pg-cb:checked').forEach(cb => {
    const code  = cb.value;
    const seats = parseInt(document.getElementById(`pgs-${code}`)?.value) || 0;
    result.push({ code, seats, isClinical: CLINICAL_CODES.has(code) });
  });
  return result;
}

window.updatePreview = function() {
  if (!selectedIntake) return;
  const ug = selectedIntake;
  const pg = getSelectedPGDepts();
  const depts = [
    { name:'Kayachikitsa',        code:'KAY'  },
    { name:'Panchakarma',         code:'PK'   },
    { name:'Shalya Tantra',       code:'SHAL' },
    { name:'Shalakya Tantra',     code:'SHAK' },
    { name:'Kaumarabhritya',      code:'KAU'  },
    { name:'Agada Tantra',        code:'AGD'  },
    { name:'Prasuti & Stri Roga', code:'PST'  },
  ];
  let totalBeds = 0;
  const rows = depts.map(d => {
    const ugB = Math.round(ug * (UG_BED_RATIOS[d.code] || 0));
    const pgD = pg.find(p => p.code === d.code);
    const pgB = pgD ? pgD.seats * 4 : 0;
    const tot = ugB + pgB;
    totalBeds += tot;
    return `<tr><td>${d.name}</td><td class="r">${ugB}</td><td class="r">${pgB||'—'}</td><td class="rt">${tot}</td></tr>`;
  });
  rows.push(`<tr class="trow"><td>Total</td><td class="r"></td><td class="r"></td><td class="rt">${totalBeds}</td></tr>`);
  document.getElementById('pv-tbody').innerHTML      = rows.join('');
  document.getElementById('pv-opd-day').textContent  = ug * 2;
  document.getElementById('pv-opd-year').textContent = (ug * 2 * 300).toLocaleString('en-IN');
  document.getElementById('pv-total-beds').textContent = totalBeds;
};

function seedMark(i, state) {
  const el = document.getElementById(`si-${i}`);
  if (!el) return;
  const icons = { active:'&#9654; ', done:'&#10003; ', err:'&#10007; ' };
  el.className = `seed-item ${state}`;
  const txt = el.textContent.replace(/^.\s/, '');
  el.innerHTML = (icons[state] || '&#9675; ') + txt;
}

async function seedNCISMData(tenantId, ugIntake) {
  document.getElementById('seed-prog').style.display = 'block';
  const pg = getSelectedPGDepts();
  const totalPGSeats = pg.reduce((s,d) => s + d.seats, 0);

  seedMark(1,'active');
  try {
    await supabase.from('tenants').update({
      ug_intake: ugIntake, opd_daily_target: ugIntake * 2,
      working_days_per_week: 6, pg_student_strength: totalPGSeats,
    }).eq('id', tenantId);
  } catch(e) { console.warn('NCISM tenant columns not yet added — run §15c SQL:', e); }
  seedMark(1,'done');

  seedMark(2,'active');
  const opdRows = NCISM_OPDS.map(o => ({ tenant_id:tenantId, name:o.name, description:o.description, is_active:true, ncism_code:o.ncism_code }));
  const { data: cOPDs, error: opdErr } = await supabase.from('opds').insert(opdRows).select('id,ncism_code');
  if (opdErr) { console.error('OPD seeding failed:', opdErr.message); seedMark(2,'err'); }
  else { seedMark(2,'done'); }
  const opdMap = {};
  if (cOPDs) cOPDs.forEach(o => { opdMap[o.ncism_code] = o.id; });

  seedMark(3,'active');
  const deptRows = NCISM_DEPTS.map(d => {
    const p = pg.find(x => x.code === d.ncism_code);
    return { tenant_id:tenantId, name:d.name, ncism_code:d.ncism_code, type:d.type, is_active:true,
      pg_seats_sanctioned: p ? p.seats : 0, is_pg_dept: p ? true : false,
      opd_id: opdMap[d.ncism_code] || null };
  });
  const { data: cDepts, error: deptErr } = await supabase.from('departments').insert(deptRows).select('id,ncism_code,type');
  if (deptErr) { console.error('Department seeding failed:', deptErr.message); seedMark(3,'err'); }
  else { seedMark(3,'done'); }

  seedMark(4,'active');
  if (cDepts) {
    const bedRows = [];
    cDepts.forEach(dept => {
      if (!CLINICAL_CODES.has(dept.ncism_code)) return;
      const ugB  = Math.floor(ugIntake * (UG_BED_RATIOS[dept.ncism_code] || 0));
      const pgD  = pg.find(p => p.code === dept.ncism_code);
      const pgB  = pgD ? pgD.seats * 4 : 0;
      const ward = WARD_NAMES[dept.ncism_code] || 'General Ward';
      for (let i = 1; i <= ugB + pgB; i++) {
        bedRows.push({ tenant_id:tenantId, department_id:dept.id,
          bed_number:`${dept.ncism_code}-${String(i).padStart(2,'0')}`,
          ward_name:ward, bed_type:'general', status:'vacant', floor_number:1 });
      }
    });
    if (bedRows.length) {
      const { error: bedErr } = await supabase.from('beds').insert(bedRows);
      if (bedErr) { console.error('Bed seeding failed:', bedErr.message); seedMark(4,'err'); }
      else seedMark(4,'done');
    } else seedMark(4,'done');
  } else seedMark(4,'done');

  seedMark(5,'active');
  await new Promise(r => setTimeout(r,400));
  seedMark(5,'done');
}

/* ─────────────────────────────────────────
   REGISTRATION
───────────────────────────────────────── */
window.handleRegister = async function(btn) {
  clearAlert();
  setLoading(btn, true);
  if (isNCISMType(selectedOrgType) && !selectedIntake) {
    showAlert('Please select your UG intake strength above.');
    setLoading(btn, false); return;
  }
  try {
    const result = await registerTenant({
      tenantName: document.getElementById('org-name').value.trim(),
      tenantType: selectedOrgType,
      fullName:   document.getElementById('admin-name').value.trim(),
      email:      document.getElementById('admin-email').value.trim(),
      password:   document.getElementById('admin-password').value,
      phone:      document.getElementById('admin-phone').value.trim(),
      city:       document.getElementById('org-city').value.trim(),
      state:      document.getElementById('org-state').value,
    });
    if (!result.success) { showAlert(result.error || 'Registration failed. Please try again.'); setLoading(btn,false); return; }

    const updates = {};
    const tagline = document.getElementById('org-tagline').value.trim();
    const address = document.getElementById('org-address').value.trim();
    const gstin   = document.getElementById('org-gstin').value.trim();
    if (tagline)   updates.tagline      = tagline;
    if (address)   updates.full_address = address;
    if (gstin)     updates.gstin        = gstin;
    if (gpsCoords) { updates.lat = gpsCoords.lat; updates.lng = gpsCoords.lng; }

    const logoFile = document.getElementById('logo-file').files[0];
    if (logoFile) {
      const ext  = logoFile.name.split('.').pop().toLowerCase();
      const path = `${result.tenant.id}/logo.${ext}`;
      const { error: uploadErr } = await supabase.storage.from('tenant-logos').upload(path, logoFile, { upsert:true });
      if (!uploadErr) {
        const { data: urlData } = supabase.storage.from('tenant-logos').getPublicUrl(path);
        updates.logo_url = urlData.publicUrl;
      }
    }
    if (Object.keys(updates).length) await supabase.from('tenants').update(updates).eq('id', result.tenant.id);

    if (isNCISMType(selectedOrgType) && selectedIntake) {
      btn.disabled = true;
      document.getElementById('seed-prog').style.display = 'block';
      seedMark(1,'active');
      const { error: seedErr } = await supabase.rpc('seed_ncism_data', {
        p_tenant_id: result.tenant.id,
        p_ug_intake: selectedIntake
      });
      if (seedErr) {
        console.error('NCISM seeding failed:', seedErr.message);
        [1,2,3,4,5].forEach(i => seedMark(i,'err'));
      } else {
        [1,2,3,4,5].forEach(i => seedMark(i,'done'));
      }
    }

    document.getElementById('tenant-code-display').textContent = result.tenant.tenant_code || '—';
    if (isNCISMType(selectedOrgType)) {
      document.getElementById('ncism-badge').style.display = 'inline-block';
      document.getElementById('success-subtitle').innerHTML =
        `Your Ayurveda college portal is live.<br>Share the code below with your staff so they can join.`;
    }
    document.getElementById('progress').style.display  = 'none';
    document.getElementById('sel-chip').style.display  = 'none';
    [1,2,3,4].forEach(i => { const el = document.getElementById(`step-${i}`); if(el) el.style.display='none'; });
    document.getElementById('alert').classList.remove('show');
    document.getElementById('success-screen').style.display = 'block';
    window.scrollTo({ top:0, behavior:'smooth' });

  } catch(err) {
    console.error('Registration error:', err);
    showAlert('Something went wrong. Please check your details and try again.');
    setLoading(btn, false);
  }
};

/* ─────────────────────────────────────────
   UTILITIES
───────────────────────────────────────── */
window.toggleFaq = function(id) {
  document.getElementById(id)?.classList.toggle('open');
};

window.togglePw = function(inputId, btn) {
  const input = document.getElementById(inputId);
  const isText = input.type === 'text';
  input.type = isText ? 'password' : 'text';
  btn.innerHTML = isText ? '&#128065;' : '&#128584;';
};

window.previewLogo = function(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 2 * 1024 * 1024) { showAlert('Logo must be under 2 MB. Please choose a smaller image.'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('logo-preview');
    preview.src = e.target.result; preview.style.display = 'block';
    document.getElementById('logo-upload-text').style.display = 'none';
  };
  reader.readAsDataURL(file);
};

window.detectLocation = function() {
  const statusEl = document.getElementById('gps-status');
  statusEl.textContent = 'Detecting your location…'; statusEl.className = 'gps-status';
  if (!navigator.geolocation) { statusEl.textContent = 'GPS not supported. Please enter your address manually.'; return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      gpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      document.getElementById('org-location').value = `${gpsCoords.lat.toFixed(6)}, ${gpsCoords.lng.toFixed(6)}`;
      statusEl.textContent = '✓ Location detected successfully'; statusEl.className = 'gps-status ok';
    },
    () => { statusEl.textContent = 'Could not detect GPS. You can add it later from Settings.'; }
  );
};

function showAlert(msg) {
  document.getElementById('alert-text').textContent = msg;
  document.getElementById('alert').classList.add('show');
  window.scrollTo({ top:0, behavior:'smooth' });
}
function clearAlert() { document.getElementById('alert').classList.remove('show'); }
function setLoading(btn, on) { if(btn) { btn.classList.toggle('loading',on); btn.disabled = on; } }

/* ─────────────────────────────────────────
   LOGO FALLBACK (PNG missing -> SVG icon)
───────────────────────────────────────── */
['mkt-nav-logo','fh-logo-img'].forEach(id => {
  const img = document.getElementById(id);
  if (img) img.addEventListener('error', () => { img.src = 'assets/icon.svg'; });
});

/* ─────────────────────────────────────────
   MOBILE NAV
───────────────────────────────────────── */
const hamburger = document.getElementById('mkt-hamburger');
const mobileNav = document.getElementById('mkt-nav-mobile');
if (hamburger) {
  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    mobileNav.classList.toggle('open');
  });
}
window.closeMktMenu = function() {
  hamburger?.classList.remove('open');
  mobileNav?.classList.remove('open');
};
document.addEventListener('click', e => {
  if (!e.target.closest('.mkt-nav')) window.closeMktMenu();
});
