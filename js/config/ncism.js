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
