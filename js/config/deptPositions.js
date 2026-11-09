// Session 383 (owner, rehearsal 9 Nov 2026): which positions are offered for a department -- in "Invite one person" and in the bulk
// invite table (a row's Position must be one of its department's positions, else red). A department is recognised by its NCISM code or
// its structure category (the same key the HR structure uses: ncism_code || category). A department this map does not know (a custom
// one), or "No specific department", offers every position; the form keeps a "Show all positions" link for the exceptions.
// A page convenience only: the server decides what may be invited (create_position_invite / preview_position_invites), not this list.
import { DESIGS } from './designations.js';

const cat = c => DESIGS.filter(d => d.cat === c).map(d => d.v);
const keys = (...parts) => [...new Set(parts.flat())];

// the people every department may have
const ATTENDANT = ['attender'];
// reception / medical records (the OPD front desk and Administration)
const FRONT_DESK = ['receptionist', 'registration_clerk', 'billing_clerk', 'medical_record_officer', 'medical_record_technician', 'public_relations_officer'];
// a clinical teaching department: faculty, medical officers, PG / intern (invited one at a time), nursing, therapists, attendants
const CLINICAL = keys(cat('Faculty'), cat('Clinical'), cat('Academic'), cat('Nursing'), cat('Therapy'), ATTENDANT, ['ot_attendant']);
// an in-patient / emergency area: doctors on duty, nursing, attendants (no OPD therapists)
const WARD = keys(cat('Faculty'), cat('Clinical'), cat('Academic'), cat('Nursing'), ATTENDANT, ['ot_attendant', 'cssd_aya']);

const BY_KEY = {
  ADMIN: keys(cat('Administration'), FRONT_DESK, ['store_keeper', 'maintenance_engineer', 'maintenance_supervisor', 'bmw_officer', 'driver'], ATTENDANT),
  FINANCE: keys(['finance_manager', 'accountant', 'cashier', 'billing_clerk', 'store_keeper'], ATTENDANT),   // cashier: owner, 9 Nov 2026
  PHARMACY: keys(cat('Pharmacy'), ['store_keeper'], ATTENDANT),
  DIAGNOSTICS: keys(cat('Diagnostics'), ATTENDANT),
  DIET_PATHYA: keys(['dietitian', 'palha_diet_incharge', 'diet_cook', 'panchakarma_cook'], ATTENDANT),
  PHYSIOTHERAPY: keys(['medical_officer', 'senior_therapist', 'therapist', 'therapy_assistant', 'wellness_counsellor'], ATTENDANT),
  HOUSEKEEPING: ['sanitation_supervisor', 'sanitation_worker', 'cssd_aya', 'attender'],
  LAUNDRY: ['laundry_supervisor', 'laundry_worker', 'attender'],
  SECURITY: ['security_supervisor', 'security_guard'],
  OPD_PARENT: keys(CLINICAL, FRONT_DESK),
  IPD_PARENT: WARD,
  IPD_MEDICAL: WARD,
  IPD_SURGICAL: WARD,
  OT: keys(WARD, ['ot_technician', 'cssd_incharge', 'cssd_technician', 'anushastra_technician']),
  ATYAYIKA: WARD,
  LABOUR_ROOM: WARD,
  KRIYAKALPA: keys(WARD, cat('Therapy'), ['ophthalmic_technician', 'ent_technician']),
  PK: keys(CLINICAL, ['pk_incharge', 'panchakarma_cook']),
  SW: keys(cat('Faculty'), cat('Academic'), cat('Wellness'), cat('Therapy'), ATTENDANT),
};

/** The department's key, the same way the HR structure reads it (ncism_code first, then category). */
export function deptKindKey(dept) {
  return (dept && (dept.ncism_code || dept.category)) || null;
}

/** The positions (designation keys) offered for a department; null = every position (no department, or a kind not known here). */
export function positionsForDept(dept) {
  if (!dept) return null;
  const k = deptKindKey(dept);
  if (k && BY_KEY[k]) return new Set(BY_KEY[k]);
  // any other department with an NCISM code, or a clinical one, is a clinical teaching department (Kayachikitsa, Shalya, Prasuti ...)
  if (dept.ncism_code || dept.category === 'clinical') return new Set(CLINICAL);
  return null;
}
