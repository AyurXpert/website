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
export const FACULTY_CONCURRENT_POSTS = new Set(['medical_director']);

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
export const NCISM_XX_ROWS = [
  // Administration
  ['Administration','Medical Director / Principal / Dean',['medical_director'],{60:1,100:1,150:1,200:1},'Sch XX/1'],
  ['Administration','Medical Superintendent',['medical_superintendent'],{60:1,100:1,150:1,200:1},'Sch XX/2'],
  ['Administration','Deputy Medical Superintendent',['deputy_medical_superintendent'],{60:1,100:1,150:2,200:2},'Sch XX/3'],
  ['Administration','Administrator (Non-clinical)',['administrative_officer'],{60:1,100:1,150:2,200:2},'Sch XX/4'],
  ['Administration','RMO / Emergency Medical Officer (24×7)',['resident_medical_officer','emergency_medical_officer'],{60:2,100:3,150:4,200:5},'Sch XX/6'],
  ['Administration','Matron / Nursing Superintendent',['nursing_superintendent'],{60:1,100:1,150:1,200:1},'Sch XX/7'],
  ['Administration','Assistant Matron',['deputy_nursing_superintendent'],{60:2,100:3,150:4,200:5},'Sch XX/8'],
  ['Administration','Office Superintendent',['opd_incharge'],{60:1,100:1,150:1,200:1},'Sch XX/9'],
  ['Administration','Multi-tasking Support Staff',['attender'],{60:3,100:3,150:4,200:4},'Sch XX/12'],
  // Finance & Accounts (separate zone from Administration).
  ['Finance & Accounts','Finance Manager / Accounts Officer',['finance_manager'],{60:1,100:1,150:1,200:1},'NCISM §Admin'],
  ['Finance & Accounts','Clerks & Accounts Staff',['accountant'],{60:1,100:2,150:3,200:4},'Sch XX/10'],
  ['Finance & Accounts','Store Keeper (Main / Pharmacy Store)',['store_keeper'],{60:1,100:1,150:1,200:1},'Sch XX/11'],
  // Reception & MRD
  ['Reception & MRD','Receptionist cum Telephone Operator',['receptionist'],{60:3,100:4,150:4,200:4},'Sch XX/16'],
  ['Reception & MRD','Registration & Billing Clerks',['registration_clerk','billing_clerk'],{60:1,100:2,150:3,200:4},'Sch XX/17'],
  ['Reception & MRD','Medical Record Technician',['medical_record_officer','medical_record_technician'],{60:1,100:1,150:1,200:1},'Sch XX/18'],
  // OPD Nursing
  ['OPD Nursing','Nursing Staff — All OPDs',['staff_nurse','ward_sister'],{60:3,100:3,150:3,200:5},'Sch XX/20'],
  ['OPD Nursing','Aya — All OPDs',['attender','anm'],{60:3,100:3,150:3,200:5},'Sch XX/21'],
  // Pharmacy
  ['Pharmacy','Pharmacist (Ayurveda-qualified)',['pharmacist'],{60:2,100:2,150:3,200:4},'Sch XX/22'],
  ['Pharmacy','Dispensary In-charge',['chief_pharmacist'],{60:1,100:1,150:1,200:1},'Sch XX/23'],
  // Diagnostics
  ['Diagnostics','Lab Technician (DMLT)',['lab_technician'],{60:2,100:2,150:3,200:4},'Sch XX/24'],
  ['Diagnostics','Lab Attendant',['lab_attendant'],{60:1,100:1,150:2,200:3},'Sch XX/25'],
  ['Diagnostics','X-ray Technician / Radiographer',['radiographer'],{60:1,100:1,150:1,200:1},'Sch XX/26'],
  ['Diagnostics','ECG Technician',['ecg_technician'],{60:1,100:1,150:2,200:2},'Sch XX/28'],
  ['Diagnostics','Nursing Staff — USG & ECG',['staff_nurse'],{60:1,100:1,150:1,200:1},'Sch XX/29'],
  ['Diagnostics','Microbiologist (MSc)',['microbiologist'],{60:1,100:1,150:1,200:1},'Sch XX/30'],
  ['Diagnostics','Lab Assistant — Microbiology',['microbiology_lab_assistant'],{60:1,100:1,150:2,200:2},'Sch XX/31'],
  // Medical IPD
  ['Medical IPD','Nursing Staff (1 per 10 beds)',['staff_nurse','ward_sister'],{60:4,100:6,150:9,200:12},'Sch XX/32'],
  ['Medical IPD','Ayah (1 per 20 beds)',['attender','anm'],{60:2,100:3,150:5,200:6},'Sch XX/33'],
  ['Medical IPD','Resident Medical Officer — Medical',['resident_medical_officer','emergency_medical_officer','general_duty_medical_officer'],{60:2,100:2,150:2,200:2},'Sch XX/34'],
  // Surgical IPD
  ['Surgical IPD','Nursing Staff (1 per 10 beds)',['staff_nurse','ward_sister'],{60:3,100:4,150:6,200:8},'Sch XX/35'],
  ['Surgical IPD','Ayah (1 per 20 beds)',['attender','anm'],{60:2,100:2,150:3,200:4},'Sch XX/36'],
  ['Surgical IPD','Resident Surgical Officer',['resident_surgical_officer','emergency_medical_officer','general_duty_medical_officer'],{60:2,100:2,150:2,200:2},'Sch XX/37'],
  // Panchakarma
  ['Panchakarma','PK Nursing Staff',['staff_nurse'],{60:1,100:1,150:2,200:2},'Sch XX/38'],
  ['Panchakarma','PK Therapists (Male + Female equal)',['pk_incharge','senior_therapist','therapist'],{60:4,100:8,150:12,200:16},'Sch XX/40'],
  ['Panchakarma','House Officer / Clinical Registrar (BAMS)',['junior_resident'],{60:1,100:1,150:1,200:1},'Sch XX/41'],
  ['Panchakarma','Clerk cum Receptionist',['receptionist'],{60:1,100:1,150:1,200:1},'Sch XX/42'],
  // Operation Theatre
  ['Operation Theatre','OT Nursing Staff',['ot_technician','staff_nurse'],{60:1,100:2,150:3,200:4},'Sch XX/43'],
  ['Operation Theatre','OT Attendants',['ot_attendant'],{60:2,100:3,150:4,200:5},'Sch XX/44'],
  ['Operation Theatre','Anushastra Karma Technician',['anushastra_technician'],{60:1,100:1,150:2,200:2},'Sch XX/45'],
  // Labour Room
  ['Labour Room','Nursing Staff — Labour Room (3 shifts)',['staff_nurse','ward_sister'],{60:3,100:3,150:6,200:6},'Sch XX/46'],
  ['Labour Room','Aya (1 per shift)',['attender','anm'],{60:3,100:3,150:3,200:3},'Sch XX/47'],
  // Therapy
  ['Kriyakalpa','Kriyakalpa Therapists',['therapist','senior_therapist'],{60:2,100:2,150:4,200:4},'Sch XX/48'],
  ['Physiotherapy','Physiotherapist',['therapist'],{60:1,100:1,150:1,200:1},'Sch XX/49'],
  ['Physiotherapy','Attendant / Aya',['attender'],{60:1,100:1,150:1,200:1},'Sch XX/50'],
  // Yoga & Wellness
  ['Yoga & Wellness','Yoga Demonstrator',['yoga_instructor'],{60:1,100:1,150:1,200:1},'Sch XX/51'],
  // Diet / Pathya
  ['Diet / Pathya','Diet In-charge (BAMS / MSc Dietetics)',['palha_diet_incharge','dietitian'],{60:1,100:1,150:1,200:1},'Sch XX/52'],
  ['Diet / Pathya','Pathya Cooks',['diet_cook'],{60:2,100:2,150:3,200:4},'Sch XX/53'],
  ['Diet / Pathya','Multi-tasking Staff',['attender'],{60:2,100:2,150:3,200:4},'Sch XX/54'],
  // CSSD (Central Sterilization)
  ['CSSD','CSSD / Sterilisation Staff',['cssd_incharge','cssd_technician'],{60:1,100:1,150:1,200:1},'Sch XX/CS1'],
  ['CSSD','CSSD / Sterilisation Aya',['cssd_aya'],{60:1,100:1,150:1,200:1},'Sch XX/CS2'],
  // Screening OPD
  ['Screening OPD','Screening OPD Nursing Staff',['staff_nurse'],{60:1,100:1,150:1,200:1},'Sch XVI §40(m)'],
];

// Optional Schedule XX rows — real per the source table, but conditional or newly-added.
// Never counted toward the mandatory ladder, required total, or compliance %.
export const NCISM_XX_OPTIONAL_ROWS = [
  ['Diagnostics','Dark Room Assistant (non-digital X-ray only)',['dark_room_assistant'],{60:1,100:1,150:1,200:1},'Sch XX/27'],
  ['Panchakarma','Cook — Preparation Room',['panchakarma_cook'],{60:1,100:1,150:2,200:2},'Sch XX/39'],
];

// 12 top-level department-tree sections, in Dr. Venkatesh's fixed order. `key` resolves to
// a department row via department.category (synthetic zones) or department.ncism_code
// (real NCISM depts).
export const ORG_TREE_DEF = [
  {key:'ADMIN',              label:'Administration',   icon:'🏛️'},
  {key:'FINANCE',            label:'Finance & Accounts',icon:'💰'},
  {key:'OPD_PARENT',         label:'OPD',               icon:'🚪'},
  {key:'IPD_PARENT',         label:'IPD',               icon:'🛏️'},
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
};

// Medical IPD / Surgical IPD's Nursing Staff + Ayah rows (Sch XX/32-33, XX/35-36) are
// genuinely per-bed ratios (1 nurse/10 beds, 1 ayah/20 beds) — computed live from real
// configured beds (bed-admin.html) rather than the static NCISM handbook per-UG-tier table.
// Medical IPD = Kayachikitsa + Panchakarma + Kaumarabhritya + Agada Tantra (Vishachikitsa);
// Surgical IPD = Shalya Tantra + Shalakya Tantra + Prasuti & Stri Roga.
export const IPD_MEDICAL_BED_CODES = ['KAY','PK','KAU','AGD'];
export const IPD_SURGICAL_BED_CODES = ['SHAL','SHAK','PST'];
export const BED_DERIVED_ROWS = {
  'Sch XX/32': {zoneKey:'IPD_MEDICAL',  per:10}, 'Sch XX/33': {zoneKey:'IPD_MEDICAL',  per:20},
  'Sch XX/35': {zoneKey:'IPD_SURGICAL', per:10}, 'Sch XX/36': {zoneKey:'IPD_SURGICAL', per:20},
};

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
        const bedRule=BED_DERIVED_ROWS[ref];
        const c=bedRule ? Math.ceil((bedTotals?.[bedRule.zoneKey]||0)/bedRule.per) : (req[ug]||0);
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
export function _collectExtraStaff(tree, ug, bedTotals, byDept){
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
        if(a>row.count) list.push({deptName:d.name, label:row.label, ref:row.ref, required:row.count, actual:a, extra:a-row.count});
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
