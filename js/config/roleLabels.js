// roleLabels.js -- Session 386b-2b (F9, owner 14 Nov 2026): ONE readable name for every role and designation code. A screen never shows a
// raw code ("lab_tech", "staff_nurse", "super_admin", "medical_superintendent"): an unknown code is turned into plain words.
import { DESIG_MAP } from './designations.js';

export const ROLE_LABELS = Object.freeze({
  super_admin: 'Super Admin', dept_admin: 'Dept. Admin', doctor: 'Doctor', receptionist: 'Receptionist', pharmacist: 'Pharmacist',
  nurse: 'Nurse', nurse_manager: 'Nurse Manager', lab_tech: 'Lab Technician', accountant: 'Accountant', cashier: 'Cashier',
  finance_manager: 'Finance Manager', student: 'Student', therapist: 'Therapist', diet_staff: 'Diet / Pathya Staff',
  mrd_staff: 'Medical Records Staff', office_staff: 'Office Staff', store_keeper: 'Store Keeper (General Store)',
  trainee_doctor: 'Trainee Doctor', public: 'Public',
});

const words = (c) => String(c).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (x) => x.toUpperCase());

/** roleLabel('lab_tech') -> 'Lab Technician'; never the raw code */
export function roleLabel(code) {
  if (!code) return '—';
  return ROLE_LABELS[code] || words(code);
}

/** desigLabel('staff_nurse') -> the designation's label ('Staff Nurse'); never the raw code */
export function desigLabel(code) {
  if (!code) return '';
  return DESIG_MAP?.[code]?.l || words(code);
}

/** "Name (Designation or Role)" -- the way a person is named in records and messages */
export function personLabel(name, role, designation) {
  const r = designation ? desigLabel(designation) : roleLabel(role);
  return `${name || '—'}${r && r !== '—' ? ` (${r})` : ''}`;
}
