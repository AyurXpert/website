// Shared NCISM reference data — used by register.js (org-type labelling) and
// admin.js (the Subscription tab's capacity-request UI). Kept as plain literals
// (not sourced from the DB) so the client-side fee/bed preview can render
// instantly; the SQL migration's seeding RPC keeps its own matching copy of the
// ratios since Postgres functions can't import JS.

export function isNCISMType(t) { return t === 'college' || t === 'teaching_hospital'; }

export const CLINICAL_CODES = new Set(['KAY', 'PK', 'SHAL', 'SHAK', 'KAU', 'PST', 'AGD']);

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
