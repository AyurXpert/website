// Sanitizes backend errors before showing them to users.
// Raw Supabase/PostgREST error.message can surface constraint names,
// column names, and other schema detail — CERT-In Application Security
// Guidelines §4.13 requires generic user-facing messages, with full
// detail logged server-side/console only, not shown in the UI.
//
// Usage: replace `_alert('error', 'Save failed: ' + error.message)`
// with   `_alert('error', safeErrorMessage(error, 'Save failed. Please try again.'))`
export function safeErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  console.error(error);

  // Every role-gated RPC in this app (dept_admin_approve_staff, hod_*, request_approval,
  // decide_approval, apply_tenant_migration, etc.) raises this exact "Not authorized"
  // message when the caller's session doesn't carry an admin-equivalent role. The most
  // common real-world cause isn't a permissions bug — it's Supabase Auth's session living
  // in localStorage, shared across every browser tab: opening a staff invite/signup link
  // in a second tab silently swaps the active session for the whole browser, so an
  // already-open admin tab starts sending requests as the newly-logged-in account instead.
  // Naming that directly here (instead of the generic fallback) saves a support round-trip
  // for every admin who hits this while onboarding staff.
  if (error?.code === 'P0001' && error?.message === 'Not authorized') {
    return "You're logged in as a different account in another tab (or your session changed) — log out, log back in as an admin, and try again.";
  }

  // update_tenant_abdm_facility()'s cross-tenant HFR Facility ID conflict guard
  // (Session 158) — the message itself is deliberately written to be safe to show
  // (no schema/constraint names, just the conflicting organisation's name), and
  // actionable: a super_admin needs to know WHY their save was rejected here, not
  // just that it failed.
  if (error?.code === 'P0001' && error?.message?.startsWith('This Facility ID is already registered')) {
    return error.message;
  }

  // Session 306 statutory-register guards (sql/session306_statutory_registers_lockdown.sql) —
  // plain, schema-free messages written to be shown to staff as-is.
  const REGISTER_MSGS = ['NDPS balance', 'An NDPS entry', 'An opening balance', 'Quantity must',
    'A correction', 'The entry being corrected', 'Register entries cannot', 'These minutes are final',
    'MLC details', 'This imaging report has been released', 'Exit time is already', 'This incident is closed',
    'A disposal entry'];
  if (error?.code === 'P0001' && REGISTER_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 310 money-tables RPCs (sql/session310_partd_money_tables2_lockdown.sql) —
  // redeem_patient_package / cancel_patient_package / void_expense_record. Same as the
  // register guards above: plain, schema-free, written to be shown to staff as-is — the
  // specific reason (over-limit vs. wrong role vs. already voided) matters to what the
  // staff member does next, so the generic fallback would actively hide useful information.
  const PACKAGE_EXPENSE_MSGS = ['Your role cannot redeem', 'Your role cannot void',
    'This package is', 'This package has no sessions remaining', 'Package not found',
    'Only an active package', 'Give a reason for cancelling', 'Give a reason for voiding',
    'This expense is already voided', 'Expense record not found', 'Only super_admin or dept_admin can cancel'];
  if ((error?.code === 'P0001' || error?.code === '22023' || error?.code === '42501' || error?.code === 'P0002')
      && PACKAGE_EXPENSE_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 311/312 IPD insurance RPCs (sql/session311_ipd_insurance_phase1.sql,
  // sql/session312_ipd_insurance_fixes.sql) -- same reasoning as the two blocks above: plain,
  // schema-free, staff-actionable messages. Found missing live (Session 312): a double-submit's
  // second call correctly hit "There is no pending pre-authorization request on this case." but
  // it wasn't allowlisted, so it silently became the generic fallback text and the real reason
  // was never seen -- masked the actual duplicate-click bug during testing.
  const INSURANCE_MSGS = ['A payer type must be chosen', 'Invalid payer type', 'A valid advance amount',
    'Advance amount cannot be negative', 'Advance payment mode is required', 'Cashless or reimbursement',
    'This patient already has an open IPD admission', 'Admission advice record not found',
    'This admission advice has already been', "Not authorized to change an admission's payer",
    'A reason (at least 5 characters)', 'Admission not found', 'This admission is already discharged',
    'Payer is already', 'Insurance case not found', 'This case is closed',
    'A pre-authorization request is already', 'A valid pre-authorization amount',
    "The insurer's reference number is required", "The insurer's approval/rejection document is required",
    'A rejection reason is required', 'A valid approved amount is required',
    'There is no pending pre-authorization', 'A valid enhancement amount',
    'An enhancement can only be requested', 'This enhancement has already been decided',
    'Enhancement request not found', 'Non-payable amount cannot be negative',
    'Final approval for a cashless case', 'Decision status must be approved or rejected',
    'An enhancement request is already pending'];
  if (error?.code === 'P0001' && INSURANCE_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  return fallback;
}
