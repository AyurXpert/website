// chargeRights.js -- Session 386b-1 (TODO §547 / §548 / §556, owner answers 11 Nov 2026; docs/handoff/session386b_plan.md §0a).
// PAGE COPY of the server rules in sql/session386b1_charge_rights_pk_fee.sql -- it only decides which buttons a page shows.
// The SERVER decides every change (cancel_ipd_stay_charge, lock_ipd_charges, the stay_charges insert policy, request_ipd_charge_*,
// decide_ipd_charge_request, resolve_ipd_unpriced_item). Keep this file and the SQL lists equal.

// designations that never hold a charge / money power, whatever their role (server: _no_charge_power_desig)
export const NO_CHARGE_POWER_DESIGS = ['store_keeper', 'attender', 'ot_attendant', 'cssd_aya', 'cssd_technician', 'ot_technician',
  'anushastra_technician', 'cssd_incharge']

const TRAINEE_DESIGS = ['pg_scholar', 'intern', 'nursing_intern']
const TRAINEE_ROLES = ['trainee_doctor', 'student']

function _base(p) {
  if (!p || (p.status && p.status !== 'active') || p.is_active === false || p.terminated_at) return false
  if (TRAINEE_DESIGS.includes(p.designation) || TRAINEE_ROLES.includes(p.role) || TRAINEE_ROLES.includes(p.secondary_role)) return false
  if (p.role !== 'super_admin' && NO_CHARGE_POWER_DESIGS.includes(p.designation)) return false
  return true
}
const _has = (p, roles) => roles.includes(p.role) || roles.includes(p.secondary_role)
const _isMs = p => p.designation === 'medical_superintendent'

/** add / cancel a manual charge before the lock, lock the charges (server: _ipd_charge_ward_ok) */
export function canWardCharge(p) {
  return _base(p) && (p.role === 'super_admin' || _has(p, ['nurse', 'nurse_manager']) || _isMs(p))
}

/** after the lock, ask to cancel / add a line (server: _ipd_charge_requester_ok) */
export function canRequestCharge(p) {
  return _base(p) && (p.role === 'super_admin' || _has(p, ['receptionist', 'cashier', 'accountant', 'finance_manager', 'dept_admin']) || _isMs(p))
}

/** decide those requests; price / cancel unpriced items (server: _ipd_charge_decider_ok) */
export function canDecideCharge(p) {
  return _base(p) && (p.role === 'super_admin' || _has(p, ['accountant', 'finance_manager']) || _isMs(p))
}

/** a line the server posted -- never cancelled directly (server: cancel_ipd_stay_charge) */
export const SERVER_POSTED_SOURCES = ['pk_session', 'pharmacy']
export const isServerPosted = c => SERVER_POSTED_SOURCES.includes(String(c?.source || '').toLowerCase())
