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
  // Session 316 fix: several of these RPCs' own role checks (e.g. "Not authorized to change
  // an admission's payer") raise with ERRCODE 42501, not the default P0001 -- this condition
  // only ever checked P0001, so every 42501 message here was silently falling through to the
  // generic fallback text since Session 311. Widened to match PACKAGE_EXPENSE_MSGS's own
  // broader pattern above, which already got this right.
  if ((error?.code === 'P0001' || error?.code === '42501')
      && INSURANCE_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 316 ipd_admissions write guard (sql/session316_ipd_admissions_write_guard.sql) +
  // the pre-existing lock_ipd_charges() (Session 305e). Same reasoning again -- plain,
  // schema-free messages naming exactly which field-group or role check failed.
  const IPD_WRITE_GUARD_MSGS = ['Only super_admin can force a status change', 'Invalid status:',
    'Invalid status transition', 'Your role cannot order a discharge or exit',
    'Your role cannot generate an IPD bill', 'Your role cannot release the final discharge record',
    'Your role cannot edit the discharge summary', 'Your role cannot initiate a care plan',
    'Your role cannot change the diet order', 'This combination of fields',
    'Your role cannot lock IPD charges', 'Charges can be locked only after', 'Admission not found'];
  // 42501 (role checks + the trigger's own messages), 22023 and P0002 (lock_ipd_charges'
  // pre-existing explicit codes) -- not just P0001.
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && IPD_WRITE_GUARD_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 324 OPD payment collection + paid-bill stop-gap (sql/session324_opd_payments.sql).
  // Plain, staff-actionable reasons (wrong mode, missing UPI reference, already paid...).
  const OPD_PAYMENT_MSGS = ['This bill is already marked paid', 'This bill is ', 'Only OPD and investigation bills',
    'Insurance / scheme bills', 'Choose a payment mode', 'Enter the UPI / card', 'This bill has no patient',
    'OPD receipt', 'Your role (', 'This record belongs to another organisation', 'Your account is not active'];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && OPD_PAYMENT_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 323 GST OPD / investigation billing (sql/session323_gst_stage2.sql) + the shared
  // GST engine messages it surfaces (Accounts-review block, discount bound). Same reasoning:
  // the reason decides what reception does next (fix the fee master, pick another package...).
  const OPD_GST_MSGS = ['This organisation bills', 'Unknown payment status', 'Unknown payment mode',
    'Unknown payer type', 'Give a reason for the discount', 'This visit already has an OPD bill',
    'This visit was deleted', 'This package does not belong', 'Add at least one charge', 'Line ',
    'The bill discount', 'This bill cannot be finalised', 'IPD investigations are charged',
    'This order is still awaiting', 'This test was done outside', "This order's charge has already",
    'Could not find the patient for this order', 'Your role (', 'This record belongs to another organisation',
    'Your account is not active', 'Tax settings are missing', 'No registration / consultation fee',
    // Session 325 (legacy server pricing) + controlled discount (TODO §98)
    'OPD visit and investigation bills are created only', 'Charges are added to a visit', 'GST bills are created only',
    'Lines of a GST bill', 'Charges cannot be added', 'Only OPD', 'The discount cannot', 'Your role may give',
    'Insurance / scheme bills take no discount', 'The same kind of charge', 'A visit bill takes', 'This bill is already marked paid',
    // Session 327 (receipts at the counter)
    'Choose Cash, UPI or Card', 'Enter the UPI / card transaction reference',
    // Session 328 (Visits & Bills search, print audit)
    'The date range', 'Type at least', 'The end date', 'Document not found', 'Unknown document type', 'You can print only',
    // Session 329 (shift close & cash handover)
    'Nothing to close', 'Enter the cash counted', 'The counted cash differs', 'The denomination count', 'A denomination count',
    'Unknown denomination', 'Note counts', 'The shift totals changed', 'Closing on behalf', 'Only a dept_admin', 'That user belongs',
    'You cannot acknowledge', 'Your role cannot', 'Handover not found', 'A remark', 'Decision must be', 'Unknown scope', 'Unknown status',
    'Receipt ', 'Handover HO/'];
  // Session 337 professional identity on bills (sql/session337_professional_identity_credentials.sql):
  // My Profile submission, HR -> Credentials verify / reject / correct, organisation licence.
  const CREDENTIAL_MSGS = ['Not signed in.', 'Your staff profile was not found', 'Only clinical, nursing',
    'Registration No. is too long', 'Issuing council / board is too long', 'Qualification is too long', 'Licence no. is too long',
    'Enter the Registration No.', 'These details are already verified', 'Only a Super Admin or Dept. Admin can',
    'Submission not found', 'This submission was already', 'You cannot verify or reject your own',
    'Give the reason for rejecting', 'Reason is too long', 'Staff member not found in your organisation',
    'You cannot correct your own', 'A registration is recorded only', 'Give the reason for the correction',
    'Nothing to change', 'Nothing on file to verify', "Only a Super Admin can change the organisation", 'Organisation not found',
    'Registration No., council and qualification are changed', 'The drug / pharmacy licence no. is changed'];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && CREDENTIAL_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 338: HPR ID in the credential flow, medical certificates, prescription print / reprint.
  const DOC_IDENTITY_MSGS = ['HPR ID must be exactly 14 digits', 'Registration No., council, qualification and HPR ID are changed',
    'Only a doctor can issue a medical certificate', 'Patient not found', 'Visit not found for this patient',
    'Choose the certificate type', 'Choose the advice', 'The rest end date is before', 'Write the advice in Remarks',
    'Diagnosis or remarks are too long', 'Your role cannot print prescriptions', 'Your role cannot view or print medical certificates', 'This prescription was deleted',
    'This prescription is not finalised yet', 'Too many visits at once', 'Your account is not active', 'Document not found'];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && DOC_IDENTITY_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 339: platform-admin medicine catalogue + the "withdrawn medicine" guard on new prescription lines / receipts.
  const CATALOGUE_MSGS = ['Only the AyurXpert platform administrator', 'Enter the medicine name', 'Choose the form', 'Enter the pack / unit',
    'Unknown form', 'HSN must be', 'The default GST rate', 'This medicine is already', 'Medicine not found', 'Say whether the medicine',
    'Give the reason for deactivating', 'Reason is too long', 'Name is too long', 'Strength is too long', 'Pack / unit is too long',
    'Manufacturer is too long', 'Category is too long', 'Unknown status filter',
    // Session 340: each organisation's own medicine list
    'Only the pharmacy team or an administrator can add a medicine', 'Only an administrator or the pharmacy in-charge',
    'This medicine is already in your list', 'That medicine is not in this organisation', 'A medicine always belongs',
    'Brand is too long', 'Sign in again', 'Your account is not active',
    // Session 340b: a form, once set, cannot be cleared
    'The form cannot be cleared'];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && (CATALOGUE_MSGS.some(m => error?.message?.startsWith(m))
          || /^".{1,200}" has been withdrawn from the AyurXpert medicine catalogue/.test(error?.message || ''))) {
    return error.message;
  }

  // Session 344a/b pharmacy returns (preview / request / decide_pharmacy_return, the return slip) -- plain, schema-free
  // messages written to be shown to staff as-is: the reason (GST bill, role, own request, window, missing witness / UPI
  // reference ...) is what the person at the counter must act on.
  const PHARMACY_RETURN_MSGS = ['GST pharmacy returns wait for credit-note rules', 'Your role (', 'Your account is not active',
    'This organisation does not have the pharmacy module', 'Bill not found in this organisation', 'This is not a pharmacy bill',
    'The lines to return are not in the expected form', 'This return is not waiting to be completed',
    'The bill changed since this return was requested', 'Enter the UPI / card refund transaction reference',
    'Opened, damaged or expired medicines go to the disposal register', 'The batch of "', 'Choose the bill',
    'Give the reason for the return', 'Say whether this is a customer return', 'Choose at least one medicine to return',
    'A cashier can return only counter-sale bills', 'This pharmacy does not accept customer returns', 'Refund by cash, UPI or card only',
    'Refund in the original payment mode', 'Give the reason for refunding a ', 'Enter the name of the witness for the disposal',
    'Return not found in this organisation', 'This return was already ', 'You cannot decide your own return',
    'Choose approve or reject', 'This bill has an NDPS or Schedule H1 medicine', 'Returns are accepted only within',
    'A selected line is not on this bill', 'The same bill line is selected twice', 'Line '];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && PHARMACY_RETURN_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 345b medicine tax (HSN / profile) requests and their decisions through decide_approval -- plain, staff-actionable
  const ITEM_TAX_MSGS = ['Only an administrator or the accounts team can change an item', 'At most 500 medicines in one request',
    'Choose at least one medicine', 'The HSN is changed with', 'A new medicine gets the organisation', 'An HSN code is 4, 6 or 8 digits',
    'Only this organisation\'s Super Admin can change the default HSN', 'Give the reason for rejecting', 'This tax change request is not pending',
    'You cannot decide your own request', 'Not authorized to decide this request', 'Request already decided', 'Choose approve or reject'];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && ITEM_TAX_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 345c / 345c2a: the Tax & Invoicing card (IP-medicines choice, default profiles, declaration, pharmacy go-live) --
  // the server's own plain messages, safe to show as they are
  const TAX_SETTINGS_MSGS = ['Only an administrator or the accounts team can', 'Choose EXEMPT or CHARGEABLE', 'The effective date',
    'Choose the exempt goods profile', 'A fallback profile applies only', 'An exempt profile applies only', 'The exempt profile',
    'The fallback profile', 'The tax profile "', 'An IP-medicines tax request is already waiting', 'Nothing changes',
    'The OP medicines (goods) default', 'The treatment services default', 'The wellness services default',
    'A default tax profiles request is already waiting', 'The default tax profiles changed since', 'Only this organisation\'s Super Admin',
    'Your account is not active', 'The declaration', 'Pharmacy GST cannot go live', 'The pharmacy GST go-live date',
    'The GST go-live date', 'No IP-medicines tax choice', 'The IP-medicines exempt profile', 'No IP tax profile for',
    'Medicine charges and tax profiles are added only', 'Give the reason for rejecting', 'You cannot decide your own request',
    'Not authorized to decide this request', 'Request already decided', 'Choose approve or reject'];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && TAX_SETTINGS_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 345c2b: the supplier copy of a bill (record_document_print 'bill_supplier') -- the server's plain refusal
  if (error?.code === '22023' && error?.message?.startsWith('A supplier copy can be printed only for a finalised Tax Invoice')) {
    return error.message;
  }

  // A page opened before a billing release still calls the retired function -- say what to do.
  // (PostgREST says "Could not find the function ..." when the signature changed -- Session 327 added a reference argument)
  if (/permission denied for function (add_opd_bill_item|create_opd_bill|create_investigation_bill)|Could not find the function public\.(create_opd_bill|create_investigation_bill)/.test(error?.message || '')) {
    return 'This page is out of date. Please reload the page.';
  }
  if (['P0001','42501','22023','P0002','40001'].includes(error?.code)
      && OPD_GST_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  return fallback;
}
