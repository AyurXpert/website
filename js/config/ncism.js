// Shared NCISM reference data — used by register.js (org-type labelling) and
// admin.js (the Subscription tab's capacity-request UI). Kept as plain literals
// (not sourced from the DB) so the client-side fee/bed preview can render
// instantly; the SQL migration's seeding RPC keeps its own matching copy of the
// ratios since Postgres functions can't import JS.

export function isNCISMType(t) { return t === 'college' || t === 'teaching_hospital'; }

export const CLINICAL_CODES = new Set(['KAY', 'PK', 'SHAL', 'SHAK', 'KAU', 'PST', 'AGD']);

// Session 141: real nursing-duty PLACES, confirmed with Dr. Venkatesh --
// replaces the old NURSING_DUTY_CODES/NURSING_DEPT_NAMES pairing, which
// listed the 7 individual clinical department codes (Kayachikitsa, Shalya
// Tantra, etc.) as if each needed its own dedicated nursing duty roster.
// Per NCISM Schedule XX, OPD nursing (Sch XX/18) is one POOLED "All OPDs"
// duty, not one nurse per specialty clinic -- so the real places are the
// ones below, split into two groups by whether they need round-the-clock
// coverage or a single 9am-5pm "General Duty" shift (see shiftsForDept()).
//
// Matched by ncism_code where a stable code exists across tenants (PK,
// SCREEN/legacy SCREENING_OPD); by exact name otherwise, since OPD/
// Diagnostics/Medical & Surgical In-Patients/Operation Theatre/Labour Room
// have no ncism_code at all. Every tenant registered since Session 95's
// default org seeding already gets Medical In-Patients/Surgical In-Patients
// as real departments (confirmed live on both SDM and the WASA test tenant)
// -- so this list applies uniformly, no split-vs-not-split branching needed.
export const NURSING_GENERAL_DUTY_CODES = new Set(['PK', 'PANCHAKARMA', 'SCREEN', 'SCREENING_OPD']);
export const NURSING_GENERAL_DUTY_NAMES = new Set(['OPD', 'Diagnostics']);
// Session 152 (TODO_LATER §53 piece 3): Atyayika/Emergency joins the round-the-clock group,
// not the day-only one -- Schedule XIX treats it as an ICU-character ward (§21f: fully
// air-conditioned, oxygen/vacuum outlets, nursing counter inside), and emergency.js's own RMO
// Duty Log already runs a 3-shift Morning/Evening/Night pattern for it, not a single day shift.
export const NURSING_24X7_NAMES = new Set(['Medical In-Patients', 'Surgical In-Patients', 'Operation Theatre (Major + Minor + CSSD)', 'Labour Room', 'Atyayika / Emergency']);

export function isNursingDutyDept(dept) {
  return NURSING_GENERAL_DUTY_CODES.has(dept?.ncism_code) || NURSING_GENERAL_DUTY_NAMES.has(dept?.name) || NURSING_24X7_NAMES.has(dept?.name);
}

// Which shift(s) apply to this place -- a single 'general' (9am-5pm) shift
// for the 4 day-only places, or the classic 3-shift round-the-clock ward
// pattern for the other 4. Any department NOT in either nursing-duty set
// (Administration, academic departments, etc.) keeps the classic 3-shift
// default -- this only overrides the shift model for real nursing places,
// leaving roster.html's existing RMO/EMO/GDMO doctor-duty behavior for
// every other department untouched.
export function shiftsForDept(dept) {
  if (NURSING_GENERAL_DUTY_CODES.has(dept?.ncism_code) || NURSING_GENERAL_DUTY_NAMES.has(dept?.name)) return ['general'];
  return ['morning', 'afternoon', 'night'];
}

// Real-usage bug found on SDM (Dr. Venkatesh): Fill All (Fixed Teams) fills
// one department at a time with no awareness of what that same nurse is
// already committed to in every OTHER department -- since General Duty
// (09:00-17:00) physically overlaps both Morning (06:00-14:00) and
// Afternoon (14:00-22:00), the same nurse ended up posted to several
// departments at once for the same real hours (e.g. Morning in Labour Room
// AND General Duty in OPD/Diagnostics/Panchakarma/Screening OPD, every
// single day). Night (22:00-06:00) never overlaps anything else -- shifts
// only touch at the boundary, not across it. Static table over interval
// math since there are only 4 known shift types.
const SHIFT_OVERLAPS = {
  morning:   { morning: true,  afternoon: false, night: false, general: true  },
  afternoon: { morning: false, afternoon: true,  night: false, general: true  },
  night:     { morning: false, afternoon: false, night: true,  general: false },
  general:   { morning: true,  afternoon: true,  night: false, general: true  },
};
export function shiftsOverlap(a, b) { return !!SHIFT_OVERLAPS[a]?.[b]; }

// Session 142: NCISM Schedule XX/20 "Nursing Staff — All OPDs" -- a pooled
// duty desk, not one nurse per specialty clinic, sized by UG intake tier
// (same table nursing-admin.js's compliance ladder already uses).
export const OPD_POOLED_NURSE_COUNT = { 60: 3, 100: 3, 150: 3, 200: 5 };

// Confirmed with Dr. Venkatesh: the pooled OPD nurses are split into 3
// physical/specialty coverage zones across the 10 real Schedule XVIII
// outpatient clinics (Screening OPD included -- it's one of the 10, distinct
// from the standalone "Screening OPD" nursing-duty PLACE above, which
// instead covers triage staffing, not this pooled OPD-consultation duty).
// Only 3 zones are defined -- a 200-intake tier's 5th (and 4th) required
// nurse falls back to an unlabelled generic slot rather than a fabricated
// 4th/5th zone nobody has specified.
export const OPD_COVERAGE_GROUPS = [
  'Kayachikitsa, Agada Tantra, Panchakarma, Kaumarabhritya OPD',
  'Screening OPD, Swasthavritta, Shalya Tantra OPD',
  'Shalakya (Netra), Shalakya (Karna-Nasa-Mukha), Prasuti & Stri Roga OPD',
];

// Schedule XX/43 "OT Nursing Staff" -- same verified table nursing-admin.js's
// compliance ladder (NURSING_XX_ROWS) already uses. Extracted here so the
// roster/rotation features (requiredStaffing.js) can apply the real NCISM
// total instead of the generic "1 per shift" default that was previously
// standing in for it (2 for a 100-intake tier, not 3).
export const OT_NURSE_COUNT = { 60: 1, 100: 2, 150: 3, 200: 4 };

// Session 152 (TODO_LATER §53 piece 3): Schedule XX/18 "Nursing Staff -- Atyayika (Emergency)"
// -- same verified per-UG-tier table ncismStaffCompliance.js's ORG_TREE_DEF ATYAYIKA row
// already uses for the HR compliance ladder (Session 151). Extracted here on the same pattern
// as OT_NURSE_COUNT so nursing-roster-template.js's suggested-slot count can't drift from the
// compliance ladder's Required number.
export const ATYAYIKA_NURSE_COUNT = { 60: 1, 100: 1, 150: 1, 200: 1 };

export const UG_BED_RATIOS = { KAY: .20, PK: .25, SHAL: .20, SHAK: .10, KAU: .10, AGD: .05, PST: .10 };

export const WARD_NAMES = {
  KAY: 'General Ward', PK: 'Panchakarma Ward', SHAL: 'Surgical Ward', SHAK: 'ENT Ward',
  KAU: 'Paediatric Ward', AGD: 'General Ward', PST: 'Maternity Ward',
};

// Session 94: cross-checked against the real Schedule XVIII (OPD equipment) document —
// Shalakya is 2 separate mandatory OPD units (Netra / Karna-Nasa-Mukha), not 1, and
// "Rog Nidana OPD" was never one of the real 10 — Rog Nidana & Vikruti Vigyana is a real
// academic department (see NCISM_DEPTS below) but has no dedicated Schedule XVIII OPD
// unit. The Shalakya split only applies to opds (patient routing) — departments/beds
// stay one combined "Shalakya Tantra" (Table-8: one combined 10% ward; see UG_BED_RATIOS).
export const NCISM_OPDS = [
  { name: 'Screening OPD',                        ncism_code: 'SCREEN', description: 'Mandatory triage for all new patients before specialty routing' },
  { name: 'Kayachikitsa OPD',                     ncism_code: 'KAY',    description: 'Internal Medicine' },
  { name: 'Panchakarma OPD',                      ncism_code: 'PK',     description: 'Panchakarma therapies' },
  { name: 'Shalya Tantra OPD',                    ncism_code: 'SHAL',   description: 'Surgery, with attached Minor OT' },
  { name: 'Shalakya – Netra OPD',                 ncism_code: 'SHNT',   description: 'Ophthalmology' },
  { name: 'Shalakya – Karna, Nasa & Mukha OPD',   ncism_code: 'SHAK',   description: 'ENT' },
  { name: 'Kaumarabhritya OPD',                   ncism_code: 'KAU',    description: 'Paediatrics' },
  { name: 'Swasthavritta OPD',                    ncism_code: 'SW',     description: 'Preventive & Social Medicine' },
  { name: 'Prasuti & Stri Roga OPD',               ncism_code: 'PST',    description: 'Obstetrics & Gynaecology' },
  { name: 'Agada Tantra OPD',                     ncism_code: 'AGD',    description: 'Visha Chikitsa — Toxicology & Forensic Medicine' },
];

// 14 departments per NCISM Schedule IV (faculty ratios) / Schedule III (teaching space) —
// Rachana Sharira and Kriya Sharira are two separate departments in the regulation
// (distinct faculty counts, room areas, non-teaching staff), not one merged dept.
export const NCISM_DEPTS = [
  { name: 'Kayachikitsa',                     ncism_code: 'KAY', type: 'clinical' },
  { name: 'Panchakarma',                      ncism_code: 'PK',  type: 'clinical' },
  { name: 'Shalya Tantra',                    ncism_code: 'SHAL', type: 'clinical' },
  { name: 'Shalakya Tantra',                  ncism_code: 'SHAK', type: 'clinical' },
  { name: 'Kaumarabhritya',                   ncism_code: 'KAU', type: 'clinical' },
  { name: 'Prasuti & Stri Roga',               ncism_code: 'PST', type: 'clinical' },
  { name: 'Agada Tantra',                     ncism_code: 'AGD', type: 'clinical' },
  { name: 'Swasthavritta & Yoga',             ncism_code: 'SW',  type: 'para_clinical' },
  { name: 'Rog Nidana & Vikruti Vigyana',      ncism_code: 'RNV', type: 'para_clinical' },
  { name: 'Dravyaguna',                       ncism_code: 'DG',  type: 'pre_clinical' },
  { name: 'Rasashastra & Bhaishajya Kalpana',  ncism_code: 'RBK', type: 'pre_clinical' },
  { name: 'Sanskrit & Samhita',               ncism_code: 'SS',  type: 'pre_clinical' },
  { name: 'Rachana Sharira',                  ncism_code: 'RS',  type: 'pre_clinical' },
  { name: 'Kriya Sharira',                    ncism_code: 'KS',  type: 'pre_clinical' },
];

// Schedule IV (Regulation 34) — real per-department minimum teaching staff, transcribed
// from the official NCISM Approval Process Handbook (p.56) and cross-checked column-by-
// column against the schedule's own Sub-total/Grand-total rows (60:36, 100:51, 150:70,
// 200:90 — every column of all 4 tiers reconciles exactly) — Session 96. Single source of
// truth for both ncism-compliance.js (Faculty Strength) and admin.js (HR → NCISM Staffing
// Compliance) — both previously had their own independent, wrong approximations that
// collapsed all departments into 3 uniform buckets (clinical/para-clinical/pre-clinical).
// 60-intake note: Schedule IV's own column layout differs here — a single flexible
// "Professor or Associate Professor" senior post (represented below as prof:1, assoc:0)
// plus a separate Assistant Professor count, NOT 3 distinct columns like the other tiers —
// EXCEPT Kayachikitsa, confirmed by Dr. Venkatesh and by the column checksum (15 across 14
// depts only resolves if one dept counts twice) to require a Professor AND an Associate
// Professor both mandatorily.
export const SCHEDULE_IV = {
  SS:   { 60:{prof:1,assoc:0,asst:3}, 100:{prof:1,assoc:1,asst:3}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  RS:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  KS:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  DG:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  RBK:  { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  RNV:  { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  AGD:  { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  SW:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:2,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  KAY:  { 60:{prof:1,assoc:1,asst:1}, 100:{prof:1,assoc:2,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  PK:   { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:2}, 200:{prof:2,assoc:2,asst:3} },
  SHAL: { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  SHAK: { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  PST:  { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  KAU:  { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:2} },
};
