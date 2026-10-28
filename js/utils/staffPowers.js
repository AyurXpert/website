// staffPowers.js -- Session 359 (TODO §293, owner 25 Oct 2026): who may do what. The browser's DISPLAY copy of the server's role gates:
// it only decides which buttons a viewer sees -- the server decides every action. scripts/check-359-powers.mjs compares these lists with
// sql/session359_role_rule.sql.
//
//   Rule 1  the ROLE decides what a person may do -- primary OR second role, ACTIVE accounts only (server: _staff_write_ok; the Super
//           Admin counts as holding every role; a trainee never).
//   Rule 2  a designation gives a power only for an office with no role of its own (the Medical Superintendent ...).
//   Rule 3  a designation with a matching role needs that role (DESIG_REQUIRED_ROLE; server: _designation_role_refusal).
// Every check takes the signed-in profile (getCurrentProfile()) and never throws on an unknown role.
import { isRuleDHod } from './hodAccess.js';

const TRAINEE_DESIGS = ['pg_scholar', 'intern', 'nursing_intern'];
const TRAINEE_ROLES = ['trainee_doctor', 'student'];
const norm = v => String(v ?? '').trim().toLowerCase();

// rule 3: designation -> the role it needs (primary or second). = _designation_role_refusal in sql/session359_role_rule.sql
export const DESIG_REQUIRED_ROLE = {
  finance_manager: 'finance_manager',
  nursing_superintendent: 'nurse_manager',
  deputy_nursing_superintendent: 'nurse_manager',
  medical_record_officer: 'mrd_staff',
  medical_record_technician: 'mrd_staff',
  medical_superintendent: 'dept_admin',
  medical_director: 'dept_admin',
  principal: 'dept_admin',
  chief_pharmacist: 'pharmacist',   // Session 365: the pharmacy in-charge needs the role pharmacist (sql/session365_*.sql)
};
const ROLE_LABEL = { finance_manager: 'Finance Manager', nurse_manager: 'Nurse Manager', mrd_staff: 'MRD Staff', dept_admin: 'Dept Admin',
  pharmacist: 'Pharmacist' };

// the role lists of the server gates (sql/session359_role_rule.sql) -- scripts/check-359-powers.mjs reads them
export const GATE_ROLES = {
  feeMaker: ['accountant'],                                   // _fee_structures_maker_ok
  feeAdmin: ['dept_admin'],                                   // _fee_structures_write_ok (fee content, packages)
  feeFinal: ['finance_manager'],                              // _fee_final_approver_ok (+ the MS office)
  writeOffRequest: ['accountant', 'finance_manager', 'dept_admin'],   // _write_off_requester_ok
  writeOffApprove: ['finance_manager'],                       // _write_off_approver_ok
  labUrgent: ['receptionist', 'cashier'],                     // mark_lab_order_urgent
  labWaive: ['finance_manager'],                              // waive_lab_order = _deposit_waiver_ok (+ the MS office)
  labOutstanding: ['receptionist', 'cashier', 'accountant', 'finance_manager'],   // list_lab_outstanding (+ the MS office, view)
  taxApprove: ['finance_manager'],                            // _tax_approver_ok
};
// offices (rule 2): designations whose power is the office itself
export const FEE_NO_STEP1_DESIGS = ['medical_director', 'principal'];   // owner Q12: they approve no fee

export function isActive(p) {
  return !!p && p.status === 'active' && p.is_active === true && !p.terminated_at && !p.is_platform_admin;
}
function isTrainee(p) {
  return TRAINEE_DESIGS.includes(norm(p?.designation)) || TRAINEE_ROLES.includes(p?.role) || TRAINEE_ROLES.includes(p?.secondary_role);
}
// = _staff_write_ok(roles): active, not a trainee, the role as primary OR second role; the Super Admin always
export function hasRole(p, roles) {
  if (!isActive(p) || isTrainee(p)) return false;
  if (p.role === 'super_admin') return true;
  return (roles || []).some(r => p.role === r || p.secondary_role === r);
}
export function isOffice(p, designation) {
  return isActive(p) && norm(p.designation) === designation;
}
const isMS = p => isOffice(p, 'medical_superintendent');
const isSuperAdmin = p => isActive(p) && p.role === 'super_admin';

// ── money: deposits, lab, write-offs, tax ──
export const canWaiveDeposit = p => hasRole(p, ['finance_manager']) || isMS(p);           // _deposit_waiver_ok
export const canMarkLabUrgent = p => hasRole(p, GATE_ROLES.labUrgent);
export const canWaiveLabBill = p => hasRole(p, GATE_ROLES.labWaive) || isMS(p);
export const canSeeLabOutstanding = p => hasRole(p, GATE_ROLES.labOutstanding) || isMS(p);
export const canRequestWriteOff = p => hasRole(p, GATE_ROLES.writeOffRequest);
export const canApproveWriteOff = p => hasRole(p, GATE_ROLES.writeOffApprove);
export const canApproveTax = p => hasRole(p, GATE_ROLES.taxApprove);
export const canChangeAdvancePolicy = p => isSuperAdmin(p);                               // set_ipd_advance_policy

// ── fees (owner Q7 / Q12 / Q14) ──
export const canMakeFee = p => hasRole(p, GATE_ROLES.feeMaker) || hasRole(p, GATE_ROLES.feeAdmin);
export const canEditFeeContent = p => hasRole(p, GATE_ROLES.feeAdmin);
export const isFeeFinalApprover = p => hasRole(p, GATE_ROLES.feeFinal) || isMS(p);
// step 1 = the head of the fee's department (rule D: _hod_dept_ok -- an unscoped dept_admin heads every department), never the MD / Principal
export function isFeeStep1Approver(p, departmentId) {
  if (!departmentId || !isActive(p)) return false;
  if (p.role === 'super_admin') return true;
  if (FEE_NO_STEP1_DESIGS.includes(norm(p.designation))) return false;
  if (p.role === 'dept_admin' || p.secondary_role === 'dept_admin') return !p.scope_department_id || p.scope_department_id === departmentId;
  return isRuleDHod(p) && p.role === 'doctor' && p.scope_department_id === departmentId;
}
// which approval buttons a fee row shows (the server decides; the maker never decides their own fee -- the sole-Super-Admin exception
// is decided by the server, so the Super Admin still sees the buttons on his own fee)
export function feeDecision(p, fee) {
  if (!p || !fee) return { approve: false, reject: false };
  const own = fee.created_by && fee.created_by === p.id && p.role !== 'super_admin';
  if (own) return { approve: false, reject: false };
  const final = isFeeFinalApprover(p);
  const step1 = isFeeStep1Approver(p, fee.department_id);
  if (fee.approval_status === 'pending') {
    const approve = fee.department_id ? step1 : final;
    return { approve, reject: final || step1, label: fee.department_id && step1 && !final ? '✓ Approve (department)' : '✓ Approve' };
  }
  if (fee.approval_status === 'dept_approved') return { approve: final, reject: final, label: '⚡ Final approval' };
  return { approve: false, reject: false };
}
// who opens fee-admin.html: the fee makers, the admin tier, the final approvers, a department head (doctor with a scope)
export function canOpenFeeAdmin(p) {
  return canMakeFee(p) || isFeeFinalApprover(p) || (p?.role === 'doctor' && isRuleDHod(p));
}

// ── patients (§305: the display copy of correct_patient_details + the 358 unidentified rule) ──
// (canCorrectPatient lives in js/modules/patient/correctPatientDetails.js, which uses the rule below)
export function canCorrectIdentity(p, patient) {
  if (!isActive(p) || isTrainee(p)) return false;
  if (p.role === 'super_admin' || p.role === 'mrd_staff' || p.secondary_role === 'mrd_staff') return true;
  return !patient?.is_unidentified && (p.role === 'receptionist' || p.secondary_role === 'receptionist');
}

// ── emergency (rule 2: offices) ──
export const canAdmitEmergency = p => isActive(p) && !isTrainee(p)
  && ['resident_medical_officer', 'cmo', 'emergency_medical_officer'].includes(norm(p.designation));

// rule 3: the message the server gives, or null when the designation and the roles fit
export function designationRoleProblem(role, secondaryRole, designation) {
  const need = DESIG_REQUIRED_ROLE[norm(designation)];
  if (!need || role === 'super_admin' || role === need || secondaryRole === need) return null;
  return `Give the role ${ROLE_LABEL[need]} first (primary or second role) -- the designation needs it.`;
}
