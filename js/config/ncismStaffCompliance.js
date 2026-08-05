// ── NCISM Staff Compliance — canonical, department-tree-scoped computation ──
// Session 136: extracted from admin.js so this ONE implementation can be shared by every
// page that states an NCISM staff compliance number (admin.html's HR tabs and Statistics
// checklist, and ncism-compliance.html's standalone report). Before this extraction,
// ncism-compliance.html had its own separate, materially less accurate role-based
// computation (e.g. counting every profile with role='doctor' or 'dept_admin' as "faculty"
// regardless of actual designation) that could show a different number for the same real
// staffing state than admin.html's designation-based, department-scoped ladder — a real
// accuracy risk on the exact page an external NCISM/university auditor would review.
// Every function here is pure (takes real fetched data as parameters, no supabase/DOM
// access) so it can be safely imported into any page module without side effects.

import { SCHEDULE_IV, NCISM_OPDS } from './ncism.js';

// Faculty (Schedule I) posts that are typically held concurrently by an existing faculty
// member per NCISM regulation (e.g. Medical Director) — still tracked as an individual
// ladder row (a tenant can record who holds the title and Invite if genuinely vacant) but
// excluded from every AGGREGATE minimum-headcount total, so a Professor already counted in
// the Schedule I faculty ladder isn't double-counted as a second, separate person.
// Session 150 (MESA&R UG 2026-27 circular, confirmed with Dr. Venkatesh's NCISM consultant):
// added 'palha_diet_incharge' — the new Schedule XX describes Pathya In-charge as "assign
// additional charge to a Dietician or any teaching faculty", i.e. an existing staff member's
// added responsibility, not a dedicated new headcount, the same shape as Medical Director.
export const FACULTY_CONCURRENT_POSTS = new Set(['medical_director', 'palha_diet_incharge']);

// Real Schedule XX operational-staff requirements, one row per position. `keys` lists every
// designation that can fill the post — almost always because the same real person could be
// tagged with either title (e.g. staff_nurse/ward_sister), except Sch XX/43 "OT Nursing
// Staff" which genuinely accepts either a Staff Nurse OR an OT Technician (confirmed with
// Dr. Venkatesh) — any aggregation across this table (see _computeGrandCompliance/
// _collectExtraStaff below, and _renderStaffingPlan/_renderComplianceSummaryBanner in
// admin.js) must attribute a row to keys[0] only wherever it groups rows by designation, to
// avoid a single row's requirement being counted twice into two different designation
// buckets (Session 136 -- confirmed via exhaustive sweep this is the ONLY row whose keys
// span two conceptually different designation groups in the whole table).
// Session 150 (MESA&R UG 2026-27 circular, Ref No. 3/2026/MARB/Visitation, 15.01.2026, item
// 13 — "Schedule XX shall be replaced by the following") — confirmed with Dr. Venkatesh's
// NCISM consultant before implementing. Refs below use the NEW document's own row numbering
// (1-45), not the old schedule's. Rows genuinely absent from the new table (Administrator
// (Non-clinical), Dispensary In-charge, Diagnostics' USG & ECG nursing, Lab Assistant —
// Microbiology, PK's Clerk cum Receptionist, Kriyakalpa Therapists) were removed outright,
// not merely deprioritised — the new document lists nothing in their place. Two rows moved
// from a flat UG-intake-tier lookup to a total-hospital-bed THRESHOLD bracket (Assistant
// Matron, Registration & Billing Clerks — see BED_BRACKET_ROWS below); Medical + Surgical IPD
// nursing merged into one combined ratio (see _combinedIpdNursingSplit below, Dr. Venkatesh's
// explicit choice to keep splitting the combined total proportionally across both ward cards
// rather than showing one merged line). See memory `mesar_2026_27_schedule_xx_implementation.md`.
export const NCISM_XX_ROWS = [
  // Administration
  ['Administration','Medical Director / Principal / Dean',['medical_director'],{60:1,100:1,150:1,200:1},'Sch I (apex)'],
  ['Administration','Medical Superintendent',['medical_superintendent'],{60:1,100:1,150:1,200:1},'Sch XX/1'],
  ['Administration','Deputy Medical Superintendent',['deputy_medical_superintendent'],{60:1,100:1,150:2,200:2},'Sch XX/2'],
  ['Administration','RMO / Emergency Medical Officer (24×7)',['resident_medical_officer','emergency_medical_officer'],{60:2,100:3,150:4,200:5},'Sch XX/3'],
  ['Administration','Matron / Nursing Superintendent',['nursing_superintendent'],{60:1,100:1,150:1,200:1},'Sch XX/4'],
  ['Administration','Assistant Matron (day + night shifts)',['deputy_nursing_superintendent'],{60:2,100:2,150:4,200:4},'Sch XX/5'],
  ['Administration','Office Superintendent',['opd_incharge'],{60:1,100:1,150:1,200:1},'Sch XX/6'],
  ['Administration','Multi-tasking Support Staff',['attender'],{60:3,100:3,150:4,200:4},'Sch XX/9'],
  // Finance & Accounts (separate zone from Administration).
  ['Finance & Accounts','Finance Manager / Accounts Officer',['finance_manager'],{60:1,100:1,150:1,200:1},'NCISM §Admin'],
  ['Finance & Accounts','Clerks & Accountants',['accountant'],{60:1,100:2,150:3,200:4},'Sch XX/7'],
  ['Finance & Accounts','Store Keeper (Main / Pharmacy Store)',['store_keeper'],{60:1,100:1,150:1,200:1},'Sch XX/8'],
  // Reception & MRD
  ['Reception & MRD','Receptionist cum Telephone Operator',['receptionist'],{60:1,100:1,150:1,200:1},'Sch XX/14'],
  ['Reception & MRD','Registration & Billing Clerks',['registration_clerk','billing_clerk'],{60:2,100:2,150:4,200:4},'Sch XX/15'],
  ['Reception & MRD','Medical Record Technician',['medical_record_officer','medical_record_technician'],{60:1,100:1,150:1,200:1},'Sch XX/16'],
  // OPD Nursing — Sch XX/18 names 3 SPECIFIC posts ("one each for atyayika, Shalya and
  // Prasuti and Streeroga"), not a pool across all 10 outpatient clinics like the old
  // schedule's "All OPDs" framing. Session 151: split into 3 dedicated rows, each attributed
  // directly to its real department (no double-counting -- the 3 rows sum to the exact same
  // total the old pooled row had: 3/3/3/5). Atyayika/Emergency is a NEW department (see
  // ORG_TREE_DEF's 'ATYAYIKA' entry below) backing emergency.html, which already existed as a
  // clinical module but had zero department/NCISM wiring until now. The 200-tier's "5(1+2+2)"
  // breakdown is the only tier the source document splits explicitly; 60/100/150's flat "3" is
  // taken as 1 each (1+1+1=3), the only reading that reconciles with the pooled total.
  ['Atyayika / Emergency','Nursing Staff — Atyayika (Emergency)',['staff_nurse','ward_sister'],{60:1,100:1,150:1,200:1},'Sch XX/18'],
  ['Shalya Tantra Nursing','Nursing Staff — Shalya Tantra OPD',['staff_nurse','ward_sister'],{60:1,100:1,150:1,200:2},'Sch XX/18'],
  ['Prasuti & Stri Roga Nursing','Nursing Staff — Prasuti & Stri Roga OPD',['staff_nurse','ward_sister'],{60:1,100:1,150:1,200:2},'Sch XX/18'],
  // Aya/MTS (Sch XX/19) has no per-post breakdown in the source document -- stays pooled.
  ['OPD Nursing','Aya — All OPDs',['attender','anm'],{60:3,100:3,150:3,200:5},'Sch XX/19'],
  // Pharmacy
  ['Pharmacy','Pharmacist (Ayurveda-qualified)',['pharmacist'],{60:2,100:2,150:3,200:4},'Sch XX/20'],
  // Diagnostics
  ['Diagnostics','Lab Technician (DMLT)',['lab_technician'],{60:2,100:2,150:3,200:4},'Sch XX/21'],
  ['Diagnostics','Lab Attendant',['lab_attendant'],{60:1,100:1,150:2,200:3},'Sch XX/22'],
  ['Diagnostics','X-ray Technician / Radiographer',['radiographer'],{60:1,100:1,150:1,200:1},'Sch XX/23'],
  ['Diagnostics','Dark Room Assistant (non-digital X-ray only)',['dark_room_assistant'],{60:1,100:1,150:1,200:1},'Sch XX/24'],
  ['Diagnostics','ECG Technician',['ecg_technician'],{60:1,100:1,150:2,200:2},'Sch XX/25'],
  ['Diagnostics','Microbiologist (MSc, part-time)',['microbiologist'],{60:1,100:1,150:1,200:1},'Sch XX/26'],
  // Medical IPD — Nursing Staff row's {ug} numbers are unused (see _combinedIpdNursingSplit,
  // deptRequirement's ref==='Sch XX/27' branch overrides them from real bed counts).
  ['Medical IPD','Nursing Staff (combined 1 per 30 IPD beds + relievers, split by bed share)',['staff_nurse','ward_sister'],{60:0,100:0,150:0,200:0},'Sch XX/27'],
  ['Medical IPD','MTS (1 per 20 beds)',['attender','anm'],{60:2,100:3,150:5,200:6},'Sch XX/28'],
  ['Medical IPD','Resident Medical Officer — Medical',['resident_medical_officer','emergency_medical_officer','general_duty_medical_officer'],{60:2,100:2,150:2,200:2},'Sch XX/29'],
  // Surgical IPD
  ['Surgical IPD','Nursing Staff (combined 1 per 30 IPD beds + relievers, split by bed share)',['staff_nurse','ward_sister'],{60:0,100:0,150:0,200:0},'Sch XX/27'],
  ['Surgical IPD','MTS (1 per 20 beds)',['attender','anm'],{60:2,100:2,150:3,200:4},'Sch XX/30'],
  ['Surgical IPD','Resident Surgical Officer',['resident_surgical_officer','emergency_medical_officer','general_duty_medical_officer'],{60:2,100:2,150:2,200:2},'Sch XX/31'],
  // Panchakarma
  ['Panchakarma','PK Nursing Staff',['staff_nurse'],{60:1,100:1,150:2,200:2},'Sch XX/32'],
  ['Panchakarma','PK Therapists (Male + Female equal)',['pk_incharge','senior_therapist','therapist'],{60:6,100:10,150:16,200:20},'Sch XX/33'],
  ['Panchakarma','House Officer / Clinical Registrar (BAMS)',['junior_resident'],{60:1,100:1,150:1,200:1},'Sch XX/34'],
  // Operation Theatre
  ['Operation Theatre','OT Nursing Staff',['ot_technician','staff_nurse'],{60:1,100:2,150:3,200:4},'Sch XX/35'],
  ['Operation Theatre','OT Attendants',['ot_attendant'],{60:2,100:3,150:4,200:5},'Sch XX/36'],
  ['Operation Theatre','Anushastra Karma Technician',['anushastra_technician'],{60:1,100:1,150:2,200:2},'Sch XX/37'],
  // Labour Room
  ['Labour Room','Nursing Staff — Labour Room (3 shifts)',['staff_nurse','ward_sister'],{60:3,100:3,150:6,200:6},'Sch XX/38'],
  ['Labour Room','MTS — preferably Female (1 per shift)',['attender','anm'],{60:3,100:3,150:3,200:3},'Sch XX/39'],
  // Physiotherapy
  ['Physiotherapy','Physiotherapist',['therapist'],{60:1,100:1,150:1,200:1},'Sch XX/40'],
  ['Physiotherapy','Attendant / MTS',['attender'],{60:1,100:1,150:1,200:1},'Sch XX/41'],
  // Yoga & Wellness
  ['Yoga & Wellness','Yoga Demonstrator',['yoga_instructor'],{60:1,100:1,150:1,200:1},'Sch XX/42'],
  // Diet / Pathya — In-charge tracked via FACULTY_CONCURRENT_POSTS (additional-charge post,
  // not a dedicated headcount — see that Set's comment).
  ['Diet / Pathya','Diet In-charge (additional charge — Dietician or teaching faculty)',['palha_diet_incharge','dietitian'],{60:1,100:1,150:1,200:1},'Sch XX/43'],
  ['Diet / Pathya','Pathya Cooks',['diet_cook'],{60:2,100:2,150:3,200:4},'Sch XX/44'],
  ['Diet / Pathya','Multi-tasking Staff',['attender'],{60:2,100:2,150:3,200:4},'Sch XX/45'],
  // CSSD (Central Sterilization) — not a real official Schedule XX line item (custom-added,
  // "CS" ref), untouched by this circular.
  ['CSSD','CSSD / Sterilisation Staff',['cssd_incharge','cssd_technician'],{60:1,100:1,150:1,200:1},'Sch XX/CS1'],
  ['CSSD','CSSD / Sterilisation Aya',['cssd_aya'],{60:1,100:1,150:1,200:1},'Sch XX/CS2'],
  // Screening OPD — Sch XVI §40(m), a different schedule, untouched by this circular.
  ['Screening OPD','Screening OPD Nursing Staff',['staff_nurse'],{60:1,100:1,150:1,200:1},'Sch XVI §40(m)'],
];

// Optional Schedule XX rows — real per the source table, but conditional or newly-added.
// Never counted toward the mandatory ladder, required total, or compliance %.
// Session 150: Dark Room Assistant promoted to mandatory (new Sch XX/24 lists it
// unconditionally, no longer "non-digital X-ray only" caveat in the requirements table
// itself — kept the caveat in the label since it's still true in practice). Kriyakalpa
// Therapists demoted here — the new Schedule XX has no Kriyakalpa section at all; kept
// visible/trackable rather than deleted outright since kriyakalpa.html is a real tracked
// clinical module, just no longer NCISM-mandated.
export const NCISM_XX_OPTIONAL_ROWS = [
  ['Panchakarma','Cook — Preparation Room',['panchakarma_cook'],{60:1,100:1,150:2,200:2},'Sch XX/39 (2024 numbering, not in 2026-27 replacement)'],
  ['Kriyakalpa','Kriyakalpa Therapists',['therapist','senior_therapist'],{60:2,100:2,150:4,200:4},'no longer in Sch XX (2026-27)'],
];

// Session 153 follow-up: 3 designations that were REMOVED OUTRIGHT by the 2026-27 circular
// (Session 150) -- no row anywhere in NCISM_XX_ROWS/NCISM_XX_OPTIONAL_ROWS, unlike Kriyakalpa
// Therapists above (whose keys, staff_nurse/therapist, are still tracked elsewhere -- these 3
// have zero remaining tracked use anywhere). Confirmed against designations.js's own "no longer
// a dedicated Sch XX post" notes -- deliberately a small curated list, not an inferred "anything
// not in NCISM_XX_ROWS" check, since most designations in this app (nurse_manager, mrd_staff,
// etc.) were never meant to be Sch XX-tracked at all and would be massively over-flagged by a
// blanket check. Real staff still holding one of these now show up in _collectExtraStaff() below
// as fully "extra" (required=0) instead of silently vanishing from every compliance view --
// found live (Dr. Venkatesh, 5 Aug 2026) when SDM's real Administrator/Dispensary In-charge
// staff turned up as unexplained "—/—/—/1/⚠️" ghost rows in admin.html's legacy summary table
// with no way to act on them anywhere, including the Extra Staff tab, which should have caught
// them but couldn't (its ladder walk only ever iterates rows that still exist).
export const FORMER_NCISM_DESIGNATIONS = [
  {key:'administrative_officer', label:'Administrator (Non-clinical)'},
  {key:'chief_pharmacist', label:'Dispensary In-charge / Chief Pharmacist'},
  {key:'microbiology_lab_assistant', label:'Lab Assistant — Microbiology'},
];

// 13 top-level department-tree sections, in Dr. Venkatesh's fixed order. `key` resolves to
// a department row via department.category (synthetic zones) or department.ncism_code
// (real NCISM depts).
// Session 151: added ATYAYIKA -- Schedule XIX treats Atyayika (Emergency) as its own
// OPD+IPD-hybrid zone, distinct from every other schedule (the MESA&R UG 2026-27 circular's
// item 12 references it separately from Schedule XX). Kept top-level rather than nested under
// OPD/IPD, same treatment as Labour Room/Kriyakalpa (operationally distinct zones that also
// straddle OPD/IPD character). Auto-seedable for both new and existing NCISM tenants via
// admin.js's existing seedHrOrgStructure() -- adding one ORG_TREE_DEF entry is the whole
// change needed there, no separate SQL migration (same pattern OT/IPD_MEDICAL/IPD_SURGICAL
// used originally). Backs emergency.html, which already existed as a real clinical module
// (Case Register/RMO Duty Log/Observation Beds/MLC Register) but had zero department/NCISM
// wiring until now -- this only wires the NCISM staffing-compliance side; emergency.html's own
// clinical tables are still self-contained (no department_id), left unchanged.
export const ORG_TREE_DEF = [
  {key:'ADMIN',              label:'Administration',   icon:'🏛️'},
  {key:'FINANCE',            label:'Finance & Accounts',icon:'💰'},
  {key:'OPD_PARENT',         label:'OPD',               icon:'🚪'},
  {key:'IPD_PARENT',         label:'IPD',               icon:'🛏️'},
  {key:'ATYAYIKA',           label:'Atyayika / Emergency', icon:'🚑'},
  {key:'PK',                 label:'Panchakarma',       icon:'🌿'},
  {key:'LABOUR_ROOM',        label:'Labour Room',       icon:'🤱'},
  {key:'KRIYAKALPA',         label:'Kriyakalpa',        icon:'👁️'},
  {key:'SW',                 label:'Yoga & Wellness',   icon:'🧘'},
  {key:'DIET_PATHYA',        label:'Diet / Pathya',     icon:'🍲'},
  {key:'PHYSIOTHERAPY',      label:'Physiotherapy',     icon:'🦵'},
  {key:'DIAGNOSTICS',        label:'Diagnostics',       icon:'🔬'},
  {key:'PHARMACY',           label:'Pharmacy',          icon:'💊'},
  {key:'HOUSEKEEPING',       label:'House Keeping',     icon:'🧹'},
  {key:'LAUNDRY',            label:'Laundry',           icon:'🧺'},
  {key:'SECURITY',           label:'Security',          icon:'🛡️'},
];

// Real NCISM_DEPTS teaching-department ncism_codes that nest under the OPD umbrella.
// Panchakarma + Swasthavritta-Yoga are excluded — they stay top-level per Dr. Venkatesh's spec.
export const OPD_CHILD_NCISM_CODES = ['KAY','SHAL','SHAK','KAU','PST','AGD'];

// ncism_code takes priority — it's the specific identifier for real NCISM depts; some
// pre-existing rows carry an unrelated legacy `category` value that would otherwise shadow
// the real match.
export function _deptKey(d){ return (d && (d.ncism_code || d.category)) || null; }

// Session 96: the "OPD" section's children are built from the real `opds` table rather than
// `departments.parent_department_id`, so it always reflects whatever OPDs are actually
// configured, and Shalakya shows as its real 2-way split (Shalakya-Netra/SHNT,
// Shalakya-KNM/SHAK) instead of one merged department row. Only 'SHNT' needs remapping to
// its owning department's code ('SHAK', per Table-8/Note 2 — one combined faculty pool,
// ~50% each speciality); every other OPD code already equals its owning department's
// ncism_code.
export function _buildOpdChildren(opds, byKey){
  const order = NCISM_OPDS.map(o=>o.ncism_code);
  const sorted = [...(opds||[])].sort((a,b)=>{
    const ia=order.indexOf(a.ncism_code), ib=order.indexOf(b.ncism_code);
    if(ia===-1 && ib===-1) return (a.name||'').localeCompare(b.name||'');
    if(ia===-1) return 1;
    if(ib===-1) return -1;
    return ia-ib;
  });
  const shak = sorted.find(o=>o.ncism_code==='SHAK'), shnt = sorted.find(o=>o.ncism_code==='SHNT');
  return sorted.map(opd=>{
    const deptCode = opd.ncism_code==='SHNT' ? 'SHAK' : opd.ncism_code;
    const owner = deptCode ? byKey[deptCode] : null;
    if(!owner) return {id:opd.id, name:opd.name, ncism_code:opd.ncism_code||null};
    return {...owner, name:opd.name, ncism_code:opd.ncism_code,
      _facultyOnlyView: deptCode==='PK' || deptCode==='SW',
      _sharedWith: deptCode==='SHAK' ? (opd.ncism_code==='SHAK' ? shnt?.name : shak?.name) : null};
  });
}

// Builds the 12-section tree from a flat departments list + the tenant's real OPDs. Sections
// not yet seeded come back with dept:null so callers can render a "seed structure" prompt.
export function buildDeptTree(depts, opds){
  const byKey = {};
  (depts||[]).forEach(d=>{ const k=_deptKey(d); if(k && !byKey[k]) byKey[k]=d; });
  return ORG_TREE_DEF.map(def=>{
    const dept = byKey[def.key] || null;
    if(def.key==='OPD_PARENT'){
      return {def, dept, children: dept ? _buildOpdChildren(opds, byKey) : []};
    }
    const children = dept
      ? (depts||[]).filter(d=>d.parent_department_id===dept.id).sort((a,b)=>(a.name||'').localeCompare(b.name||''))
      : [];
    return {def, dept, children};
  });
}

// Departments that carry the Schedule I faculty ladder (6 OPD-child teaching depts + PK + SW)
export const SCHEDULE_I_CODES = [...OPD_CHILD_NCISM_CODES, 'PK', 'SW'];

// Dedupes rows by id before summing requirement/actual totals — needed because the OPD
// section's Shalakya children intentionally share one real department id (2 display cards, 1
// real department/faculty pool), which would otherwise double-count in any aggregate loop.
// Display loops that render individual cards must NOT use this — both Shalakya cards need to
// render.
//
// Session 134 fix: naive "first occurrence wins" silently kept the WRONG twin every time —
// NCISM_OPDS always lists Shalakya-Netra before Shalakya-KNM, and Netra's clone is the one
// _buildOpdChildren deliberately zeroes out (ncism_code:'SHNT', not in SCHEDULE_I_CODES, so
// it never carries the real Schedule I requirement) — so the naive version always kept the
// empty twin and silently dropped the real one. Now prefers whichever twin actually carries
// a real Schedule I code.
export function _dedupById(rows){
  const byId = new Map();
  rows.forEach(d=>{
    if(!d) return;
    const existing = byId.get(d.id);
    if(!existing || (!SCHEDULE_I_CODES.includes(existing.ncism_code) && SCHEDULE_I_CODES.includes(d.ncism_code))){
      byId.set(d.id, d);
    }
  });
  return [...byId.values()];
}

// Session 96: real per-department Schedule IV requirement (SCHEDULE_IV in ncism.js), summing
// each actually-configured Schedule-I department's own requirement; falls back to the full
// SCHEDULE_I_CODES list (still per-department, not a flat multiply) when no real departments
// exist yet, e.g. before first seed.
export function _scheduleIFacultyTotal(depts, ug) {
  const real = (depts||[]).filter(d => d.ncism_code && SCHEDULE_I_CODES.includes(d.ncism_code));
  const codes = real.length ? real.map(d => d.ncism_code) : SCHEDULE_I_CODES;
  const tot = {p:0, a:0, b:0};
  codes.forEach(code => {
    const req = SCHEDULE_IV[code]?.[ug];
    if (req) { tot.p += req.prof; tot.a += req.assoc; tot.b += req.asst; }
  });
  return {p:tot.p, a:tot.a, b:tot.b, count: codes.length};
}

// Maps each NCISM_XX_ROWS zone label onto the department key (category or ncism_code) it lives under
export const ORG_ZONE_MAP = {
  'Administration':'ADMIN', 'Finance & Accounts':'FINANCE', 'Reception & MRD':'ADMIN',
  'OPD Nursing':'OPD_PARENT', 'Pharmacy':'PHARMACY', 'Diagnostics':'DIAGNOSTICS',
  'Medical IPD':'IPD_MEDICAL', 'Surgical IPD':'IPD_SURGICAL', 'Panchakarma':'PK',
  'Operation Theatre':'OT', 'Labour Room':'LABOUR_ROOM', 'Kriyakalpa':'KRIYAKALPA',
  'Physiotherapy':'PHYSIOTHERAPY', 'Yoga & Wellness':'SW', 'Diet / Pathya':'DIET_PATHYA',
  'CSSD':'OT', 'Screening OPD':'SCREEN',
  // Session 151: the 3-way OPD Nursing split -- Atyayika/Emergency is the new top-level
  // ATYAYIKA zone; Shalya Tantra / Prasuti & Stri Roga map directly to their own real
  // ncism_code (SHAL/PST) so the row shows on their existing Schedule-I teaching-department
  // cards, not a separate synthetic zone.
  'Atyayika / Emergency':'ATYAYIKA', 'Shalya Tantra Nursing':'SHAL', 'Prasuti & Stri Roga Nursing':'PST',
};

// Medical IPD / Surgical IPD's Nursing Staff + MTS rows are genuinely per-bed derived —
// computed live from real configured beds (bed-admin.html) rather than the static NCISM
// handbook per-UG-tier table. Nursing Staff (Sch XX/27) is the Session 150 combined ratio
// (_combinedIpdNursingSplit); MTS (Sch XX/28, XX/30) is still a plain 1-per-20-beds ratio
// (BED_DERIVED_ROWS). Medical IPD = Kayachikitsa + Panchakarma + Kaumarabhritya + Agada Tantra
// (Vishachikitsa); Surgical IPD = Shalya Tantra + Shalakya Tantra + Prasuti & Stri Roga.
export const IPD_MEDICAL_BED_CODES = ['KAY','PK','KAU','AGD'];
export const IPD_SURGICAL_BED_CODES = ['SHAL','SHAK','PST'];
// Session 150: Nursing Staff (old Sch XX/32, XX/35) moved out to the combined-ratio branch
// below (_combinedIpdNursingSplit) — only the per-bed MTS/Ayah rows still use this plain
// ratio mechanism.
export const BED_DERIVED_ROWS = {
  'Sch XX/28': {zoneKey:'IPD_MEDICAL',  per:20},
  'Sch XX/30': {zoneKey:'IPD_SURGICAL', per:20},
};

// Session 150 (MESA&R UG 2026-27): a total-hospital-bed THRESHOLD bracket, replacing a flat
// UG-intake-tier lookup — Assistant Matron and Registration & Billing Clerks are no longer
// sized off the UG intake tier at all, just whether the tenant has ≤100 or 101-200 real beds
// (Medical + Surgical IPD combined).
export const BED_BRACKET_ROWS = {
  'Sch XX/5':  {threshold:100, low:2, high:4},
  'Sch XX/15': {threshold:100, low:2, high:4},
};

// Session 150 (MESA&R UG 2026-27, new Sch XX/27): Medical + Surgical IPD nursing is now ONE
// combined ratio — 1 nurse per 30 total IPD beds across 3 shifts, plus a shared reliever pool
// (1 up to 100 total beds, 2 above) — instead of two independent 1-per-10-bed pools. This is
// the same reliever concept the Relief Pool feature (Session 149) was built to cover, now
// formally backed by regulation. Dr. Venkatesh's explicit choice: keep showing a nursing line
// on both the Medical IPD and Surgical IPD cards, splitting the combined total proportionally
// by each ward's real bed share (rounding drift absorbed into Surgical's share so the two
// always sum exactly to the combined total).
export function _combinedIpdNursingSplit(bedTotals){
  const med = bedTotals?.IPD_MEDICAL||0, surg = bedTotals?.IPD_SURGICAL||0, total = med+surg;
  if(!total) return {IPD_MEDICAL:0, IPD_SURGICAL:0};
  const perShift = Math.ceil(total/30);
  const relievers = total<=100 ? 1 : 2;
  const combined = perShift*3 + relievers;
  const medCount = Math.round(combined*med/total);
  return {IPD_MEDICAL:medCount, IPD_SURGICAL:combined-medCount};
}

// Required-staff ladder for a single department row. mandated=false means NCISM prescribes
// no headcount for this function (Housekeeping/Laundry/Security) — never fabricate a number
// in that case, just track actual staff. bedTotals (optional) — {IPD_MEDICAL:n,
// IPD_SURGICAL:n} real configured bed counts — overrides the static per-UG-tier table for
// the genuinely per-bed Nursing/Ayah rows (BED_DERIVED_ROWS).
export function deptRequirement(dept, ug, bedTotals){
  if(!dept || !ug) return {mandated:false, ladder:[], required:0, optional:[]};
  const ladder=[];
  let mandated=false;

  // Panchakarma/Swasthavritta&Yoga are real teaching depts (Schedule I) AND real Schedule XX
  // operational zones. Shown in exactly one place each, never both: their Schedule I faculty
  // ladder appears nested under "OPD" (dept._facultyOnlyView — a synthetic clone built by
  // _buildOpdChildren from the real opds table, not a real re-parenting), while their own
  // top-level Panchakarma/Yoga & Wellness section shows only Schedule XX operational staff.
  const facultyOnly = !!dept._facultyOnlyView;
  const operationalOnly = !facultyOnly && (dept.ncism_code==='PK' || dept.ncism_code==='SW');

  if(!operationalOnly && dept.ncism_code && SCHEDULE_I_CODES.includes(dept.ncism_code)){
    mandated=true;
    const fac=SCHEDULE_IV[dept.ncism_code]?.[ug] || {prof:0,assoc:0,asst:0};
    const z='Teaching Faculty (Schedule I)';
    if(fac.prof) ladder.push({zone:z, label:'Professor / HOD',        count:fac.prof, ref:'Sch I', keys:['professor','hod']});
    if(fac.assoc) ladder.push({zone:z, label:'Associate Professor',     count:fac.assoc, ref:'Sch I', keys:['associate_professor']});
    if(fac.asst) ladder.push({zone:z, label:'Assistant Professor',     count:fac.asst, ref:'Sch I', keys:['assistant_professor']});
    if(dept.is_pg_dept){
      const seats=dept.pg_seats_sanctioned||3, pgBeds=seats*4;
      ladder.push({zone:z, label:'Senior Resident (PG)',            count:Math.ceil(seats/3),      ref:'PG 1 per 3 seats',  keys:['senior_resident']});
      ladder.push({zone:z, label:'Staff Nurse (+PG beds)',           count:Math.ceil(pgBeds/10),     ref:'PG 1 per 10 beds', keys:['staff_nurse','ward_sister']});
      ladder.push({zone:z, label:'Ayah / Attendant (+PG beds)',      count:Math.ceil(pgBeds/20),     ref:'PG 1 per 20 beds', keys:['attender','anm']});
      if(dept.ncism_code==='PK') ladder.push({zone:z, label:'PK Therapist (+PG)', count:Math.ceil(seats/3)*2, ref:'PG PK', keys:['pk_incharge','senior_therapist','therapist']});
      if(seats>3) ladder.push({zone:z, label:'Assistant Professor (+PG)',  count:Math.ceil((seats-3)/3), ref:'PG', keys:['assistant_professor']});
      if(seats>6) ladder.push({zone:z, label:'Associate Professor (+PG)',  count:Math.ceil((seats-6)/3), ref:'PG', keys:['associate_professor']});
    }
  }

  const key=_deptKey(dept);
  if(!facultyOnly){
    const rows=NCISM_XX_ROWS.filter(r=>ORG_ZONE_MAP[r[0]]===key);
    if(rows.length){
      mandated=true;
      rows.forEach(([zone,label,keys,req,ref])=>{
        let c;
        if(ref==='Sch XX/27'){
          c = _combinedIpdNursingSplit(bedTotals)[zone==='Medical IPD' ? 'IPD_MEDICAL' : 'IPD_SURGICAL'];
        } else {
          const bedRule=BED_DERIVED_ROWS[ref];
          const bracket=BED_BRACKET_ROWS[ref];
          if(bedRule) c=Math.ceil((bedTotals?.[bedRule.zoneKey]||0)/bedRule.per);
          else if(bracket){ const tb=(bedTotals?.IPD_MEDICAL||0)+(bedTotals?.IPD_SURGICAL||0); c = tb<=bracket.threshold ? bracket.low : bracket.high; }
          else c = req[ug]||0;
        }
        if(c){ ladder.push({zone,label,count:c,ref,keys,facultyHeld:FACULTY_CONCURRENT_POSTS.has(keys[0])}); }
      });
    }
  }

  const optional=facultyOnly ? [] : NCISM_XX_OPTIONAL_ROWS.filter(r=>ORG_ZONE_MAP[r[0]]===key)
    .map(([,label,keys,req,ref])=>({label,count:req[ug]||0,ref,keys}));

  if(!mandated) return {mandated:false, ladder:[], required:0, optional};
  // facultyHeld rows (Medical Director/MS/Deputy MS) still appear in the ladder for
  // per-position tracking/Invite, but never contribute to the aggregate required total.
  return {mandated:true, ladder, required:ladder.reduce((s,r)=>s+(r.facultyHeld?0:r.count),0), optional};
}

// Real configured bed counts, summed per IPD sub-section grouping (BED_DERIVED_ROWS above).
export function _computeIpdBedTotals(depts, bedsRows){
  const deptCode = {}; (depts||[]).forEach(d=>{ deptCode[d.id]=d.ncism_code; });
  const byCode = {}; (bedsRows||[]).forEach(b=>{ const c=deptCode[b.department_id]; if(c) byCode[c]=(byCode[c]||0)+1; });
  const sum = codes => codes.reduce((s,c)=>s+(byCode[c]||0),0);
  return { IPD_MEDICAL: sum(IPD_MEDICAL_BED_CODES), IPD_SURGICAL: sum(IPD_SURGICAL_BED_CODES) };
}

// Grand compliance across the whole configured department tree — per-position min-capped,
// deduped by id. The ONE canonical Required/Recruited computation — every page that states
// an aggregate NCISM staff compliance number should call this, not maintain its own sum.
export function _computeGrandCompliance(tree, ug, bedTotals, cntDeptD){
  let grandReq=0, grandMet=0;
  tree.forEach(node=>{
    if(!node.dept) return;
    _dedupById([node.dept, ...node.children]).forEach(d=>{
      const r=deptRequirement(d,ug,bedTotals);
      if(!r.mandated) return;
      r.ladder.forEach(row=>{ if(row.facultyHeld) return; grandReq+=row.count; grandMet+=Math.min(cntDeptD(d.id,row.keys),row.count); });
    });
  });
  return {grandReq, grandMet};
}

// Positions recruited above the NCISM minimum — walks the same deduped tree as
// _computeGrandCompliance, collects every ladder row where actual > required.
// Session 153: also returns the real staff (id, full_name, department_id) holding that
// position in that department -- ALL of them, not just "the extra ones" (there's no seniority/
// hire-date signal anywhere that could honestly say WHICH specific person is the surplus one --
// fabricating that would be worse than not picking at all). admin.js's Extra Staff tab lists
// them all so a real person (Dr. Venkatesh) makes that judgment call, with Terminate/Depute
// actions on each -- never an algorithm silently choosing for him. byDept entries need id/
// full_name populated by the caller for this to work (cntDeptD itself only ever needed
// designation, so this is additive, not a breaking change to any existing caller).
// deptNameById (optional, Session 153 follow-up): deptId -> name lookup for the
// FORMER_NCISM_DESIGNATIONS pass below, which isn't reachable via the tree walk (that walk only
// ever visits departments/rows the current NCISM_XX_ROWS still mandates). Omitting it just falls
// back to '—' for those rows' deptName -- harmless for ncism-compliance.js's caller, which only
// ever sums .extra and never renders deptName/staff.
export function _collectExtraStaff(tree, ug, bedTotals, byDept, deptNameById){
  const cntDeptD=(deptId,keys)=>(byDept[deptId]||[]).filter(s=>(keys||[]).includes(s.designation)).length;
  const list=[];
  tree.forEach(node=>{
    if(!node.dept) return;
    _dedupById([node.dept, ...node.children]).forEach(d=>{
      const r=deptRequirement(d,ug,bedTotals);
      if(!r.mandated) return;
      r.ladder.forEach(row=>{
        if(row.facultyHeld) return;
        const a=cntDeptD(d.id,row.keys);
        if(a>row.count){
          const staff=(byDept[d.id]||[]).filter(s=>(row.keys||[]).includes(s.designation))
            .map(s=>({id:s.id, full_name:s.full_name}));
          list.push({deptId:d.id, deptName:d.name, label:row.label, ref:row.ref, required:row.count, actual:a, extra:a-row.count, staff});
        }
      });
    });
  });

  // Session 153 follow-up: staff holding a FORMER_NCISM_DESIGNATIONS key are 100% "extra" by
  // definition (required=0 -- the position doesn't exist in the current schedule at all) and
  // would otherwise never surface anywhere, since the tree walk above only ever iterates rows
  // that still exist. Scanned across every department real staff are actually posted to (not
  // just tree-walked NCISM departments), so nobody's missed regardless of where they landed.
  Object.entries(byDept).forEach(([deptId, staffList])=>{
    FORMER_NCISM_DESIGNATIONS.forEach(({key,label})=>{
      const matched=(staffList||[]).filter(s=>s.designation===key);
      if(!matched.length) return;
      list.push({
        deptId, deptName:(deptNameById && deptNameById[deptId]) || '—',
        label, ref:'Removed from Sch XX (2026-27 circular)',
        required:0, actual:matched.length, extra:matched.length,
        staff:matched.map(s=>({id:s.id, full_name:s.full_name})),
      });
    });
  });

  return list;
}

function _esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// ── Shared compliance summary banner ─────────────────────────────────────────
// Wherever NCISM staff compliance is shown, it should read the same way and never look
// confusing -- (1) Required vs Recruited, capped so it reads "127/127" when genuinely fully
// staffed rather than a raw number that can overshoot; (2) any staff recruited ABOVE the
// minimum called out separately with an explanation, never folded into the compliance
// number; (3) the true total headcount of the organisation, so nothing looks hidden. Always
// sourced from _computeGrandCompliance()/_collectExtraStaff() above, so this can never
// disagree with any page that computes its Required/Recruited numbers the same way.
export function _renderComplianceSummaryBanner({grandReq, grandMet, extraList, totalOrgStaff}){
  const pct = grandReq>0 ? Math.round(Math.min(grandMet,grandReq)/grandReq*100) : 100;
  const hc = pct>=100?'#2d7a4f':pct>=80?'#c9902a':'#c0392b';
  const extra = extraList||[];
  const extraTotal = extra.reduce((s,r)=>s+r.extra,0);
  return '<div style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px">'
    +'<div style="background:'+hc+';color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">'
      +'<div style="font-weight:700;font-size:14px">'+(pct>=100?'✅':'⚠️')+' NCISM Staff Compliance</div>'
      +'<div style="font-size:15px;font-weight:700">Required '+grandReq+' · Recruited '+Math.min(grandMet,grandReq)+' <span style="font-weight:400;font-size:12px;opacity:.85">('+pct+'%)</span></div>'
    +'</div>'
    +(extraTotal>0
      ? '<div style="padding:10px 16px;background:#fff8ec;border-bottom:1px solid var(--border);font-size:12.5px;line-height:1.6">'
        +'<strong>➕ '+extraTotal+' staff recruited above the NCISM minimum</strong> — not a compliance problem, just staff to be aware of when planning transfers, budget, or new invites: '
        +extra.map(r=>_esc(r.label)+' in '+_esc(r.deptName)+' (required '+r.required+', have '+r.actual+', <strong>+'+r.extra+'</strong>)').join('; ')
        +'</div>'
      : '')
    +'<div style="padding:9px 16px;background:#f5faf7;font-size:12.5px;color:var(--text-muted);display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
      +'<span>👥 Total Staff in Organisation: <strong style="color:var(--text-dark);font-size:13.5px">'+totalOrgStaff+'</strong></span>'
      +(totalOrgStaff>grandMet+extraTotal
        ?'<span>(includes '+(totalOrgStaff-grandMet-extraTotal)+' account(s) outside NCISM tracking, e.g. platform/admin logins or roles Schedule I/XX doesn\'t cover)</span>'
        :'')
    +'</div>'
  +'</div>';
}
