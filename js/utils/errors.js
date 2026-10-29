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
    'Not authorized to decide this request', 'Request already decided', 'Choose approve or reject',
    // Session 345e: room tax profiles (request_room_tax_change / _room_tax_apply) and the document numbering (set_document_numbering)
    'Choose both room profiles', 'The room profile for', 'The wellness room profile', 'A room tax request is already waiting',
    'Enter a prefix for the', 'The prefix "', 'Each document type needs its own prefix', 'The number width must be',
    'The Tax Invoice ', 'The Bill of Supply ', 'The Bill ', 'The Receipt ', 'The Credit note ', 'The Debit note ',
    // Session 345g: credit notes (request_credit_note / _credit_note_apply through decide_approval)
    'A credit note can be issued only', 'A GST pharmacy bill is credited', 'Credit notes are available', 'Credit notes on insured bills',
    'This bill is not fully paid', 'The time for a credit note', 'Give the reason for the credit note', 'Choose how the money is refunded',
    'Enter the refund reference', 'A credit note for ', 'Choose at least one line', 'A chosen line is not', 'Each line can be chosen only once',
    'Line ', 'Nothing is left to credit', 'At most ₹', 'The bill changed since this credit note',
    // Session 345h: credit-note screens, the cash payout (D4), the annual-return date (D9), the credit-note prints
    'Credit note ', 'The refund of ', "The admission's account no longer owes", 'Only ₹', 'Bill not found', 'Document not found',
    'Unknown status filter', 'Too many bills at once', 'Super Admin or Finance Manager can view', 'Give the financial year as four digits',
    'The annual return for ', 'Your role (',
    // Session 345f: the registration type (request_gst_scheme_change / _gst_scheme_apply) and the composition tax base
    'Choose the registration type', 'The organisation is not marked GST-registered', 'Enter the reference of your',
    'Composition can start only', 'The registration type ', 'A registration type request is already waiting',
    'Choose the tax base', 'Enter your CA', 'A composition tax base request is already waiting',
    'A composition taxable person', 'The composition tax base'];
  if (['P0001','42501','22023','P0002'].includes(error?.code)
      && TAX_SETTINGS_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }
  // Session 345f (F9): a credit note / pharmacy return across a change of registration type -- the message starts with the bill's
  // own document number, so it is matched by its fixed wording
  if (['P0001','22023'].includes(error?.code) && error?.message?.includes('across a change of registration type')) {
    return error.message;
  }

  // Session 345j: the tax profile editor (session-299 functions + the 345j guards and rate rule) -- plain, staff-actionable
  const TAX_PROFILE_MSGS = ['Tax version not found', 'Only a draft can be submitted', 'Only a draft tax version can be deleted',
    'This version starts on ', 'Only an approver can', 'You created or submitted this version', 'Choose approve or reject',
    'Give a reason for rejecting', 'Give a reason for retiring', 'Only an approved version can be retired', 'This tax profile is in use',
    'A GST rate must be between', 'This version is not pending', 'Only a migration-created version', 'The platform GST rate rule',
    'Tax version status changes go through', 'Only the fields allowed for this step', 'This version was used on finalized bills'];
  if (['P0001','42501','22023'].includes(error?.code) && (TAX_PROFILE_MSGS.some(m => error?.message?.startsWith(m))
      || /^Version \d+ of this profile is already waiting for approval\./.test(error?.message || ''))) {
    return error.message;
  }
  if (error?.code === '42501' && error?.message === 'Not allowed.') {
    return 'Your role cannot change tax profiles (Super Admin, Dept Admin, Finance Manager or Accountant only).';
  }

  // Session 347 (TODO §198): the OPD workflow setter -- plain, staff-actionable
  const OPD_WF_MSGS = ["Only this organisation's Super Admin can change the OPD workflow", 'Unknown OPD workflow setting', 'Choose on or off',
    'This organisation has no active Screening OPD', 'The Screening OPD is set by the system only'];
  if (['P0001','42501','22023'].includes(error?.code) && OPD_WF_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 345o (TODO §191): cancelling an IPD bill (cancel_bill) and the cancelled bill's reprint -- the server's plain refusals; which
  // one it is (a payment, a credit note, the insurance stage, a filed month) decides what the person does next
  const IPD_CANCEL_MSGS = ['Give a cancellation reason', 'Only a finalised GST bill can be cancelled', 'Only IPD bills can be cancelled',
    'The admission is no longer at the bill-generated stage', 'A payment or refund is recorded against bill', 'A credit note exists or is waiting',
    'An insurance write-off is recorded', 'The insurance claim on bill', 'This bill does not belong to this admission'];
  if (['P0001','42501','22023','P0002'].includes(error?.code) && (IPD_CANCEL_MSGS.some(m => error?.message?.startsWith(m))
      || /^Bill \S+ is (in a period already reported in GSTR-1|\S+ -- it cannot be cancelled)/.test(error?.message || ''))) {
    return error.message;
  }

  // Session 349 (TODO §213): staff signup (register_staff_profile), invites (create / revoke_position_invite) and the approval
  // (dept_admin_approve_staff) -- the server's plain refusals; which one it is decides what the person does next
  const SIGNUP_INVITE_MSGS = ['This invite link', 'This invite belongs to another organisation', 'This role cannot be requested at signup',
    'Your staff profile already exists', 'Please enter your full name', 'Department not found in this organisation',
    'Organisation code not found', 'Only an active Super Admin or Dept Admin can create an invite', 'This role cannot be invited',
    'Choose the position (designation) for the invite', 'Secondary role must be different from HMS Login Role',
    'Only the Super Admin can create an invite for', 'A Dept Admin can scope an invite only to his own department',
    'Enter a phone number or email to invite', 'Invite not found', 'Only a pending invite can be cancelled',
    'You cannot approve your own account', 'This account is not waiting for approval', 'Only the Super Admin can approve a request for',
    'Staff member not found in your organisation'];
  if (error?.code === 'P0001' && SIGNUP_INVITE_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 366 (TODO §350-§353, plan §0.1): invite expiry / email match / the self-signup switch, the bulk invite, re-send, the staff
  // limit, phone + login email changes -- the server's plain refusals, shown as written (which one it is decides what the person does next)
  const STAFF_366_MSGS = ['This invite link has expired', 'This invite was made for a different email address',
    'This organisation adds new staff by invite only', 'Enter a valid 10-digit mobile number', 'Enter a valid email address',
    'This organisation has reached its staff limit', 'Only the active Super Admin', "Only this organisation's Super Admin can change self-signup",
    'The file has no rows', 'The file has ', 'A file can hold at most 300 rows', 'Choose between 1 and 300', 'Only a pending invite can be re-sent',
    'Give the reason for the change', 'The login email of a relieved or blocked account', "That is already this staff member's login email",
    'This email is already used by another AyurXpert login', 'A phone number is changed through', 'This account has been relieved', 'Choose on or off'];
  if (['P0001', '42501', '22023'].includes(error?.code) && STAFF_366_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 350 (TODO §214 + owner addition A): designations (dept_admin_update_designation), invites and the approval -- who may give
  // a powerful position or a department scope; the server's plain refusals, which one it is decides what the person does next
  const DESIG_RIGHTS_MSGS = ['You cannot change your own designation', 'Only the Super Admin can change the designation of an admin',
    'Only the Super Admin can give or remove this position', 'Only the Super Admin can make this change',
    'A Dept Admin can change designations only in their own department', 'Only the Super Admin can give a department scope',
    'Only the Super Admin can create an invite for', 'Only the Super Admin can approve a request for',
    'You cannot reactivate your own account', 'This account has not been approved yet', 'Only the Super Admin can reactivate',
    'A Dept Admin can reactivate only staff of their own department'];
  if (error?.code === 'P0001' && DESIG_RIGHTS_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 348 (TODO §209 / §211 / §212): OPD Management (opd_doctor_*) and the HOD functions (hod_*) -- the server's plain refusals;
  // who may change an OPD's doctors / which department / which organisation decides what the person does next
  const OPD_DOCTOR_MSGS = ["Only an active super admin, or the department admin (HOD) of this OPD's department, can change its doctors",
    'Not authorized for this department', 'This OPD does not belong to your department', 'Doctor not found in your organisation',
    'Assignment not found', 'Choose active or not active', 'NCISM §7 mandates dedicated consultants', 'Staff member not found in your organisation',
    'Shift not found in your department', 'Trainee not found in your organisation', 'This profile is not a Trainee Doctor'];
  if (error?.code === 'P0001' && OPD_DOCTOR_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // Session 353C (TODO §216, F-347-1): patients / visits / admissions -- the server's plain refusals (who may change what, the
  // correction rule, the queue-edit doctor rule, the admission-date bounds); each says what the person does next
  const PATIENT_VISIT_MSGS = ["Your role cannot change a patient", 'A recorded ', 'Your role cannot link an ABHA', 'The allergy flag is cleared only',
    'Only a doctor can record the Prakriti', "A patient's ", 'Only MRD staff or the Super Admin', 'Patient not found in your organisation',
    'Reception can correct', 'Give a reason for the correction', 'Nothing to change', "Enter the patient's name", 'Enter a valid phone',
    'Choose the gender', 'Enter a valid date of birth', 'Enter a valid age', 'Choose a valid blood group', 'The address is too long',
    'The allergy flag must be', 'This detail cannot be changed here', 'A new visit starts in the queue', 'The patient or OPD of this visit',
    'The chosen doctor is not an active doctor', 'This visit was deleted', 'Only a doctor can start', 'Only a doctor completes',
    'Your role cannot close a visit', 'Give a reason for closing the visit', 'A completed visit cannot be reopened', 'A visit cannot move from',
    'The incomplete reason is set only', 'The doctor can be changed only', 'Your role cannot change this visit', 'The visit type can be changed only',
    'Only a doctor can record the consultation', 'A visit is deleted only through', "A visit's ", 'Visit not found in your organisation',
    'This visit is already deleted', 'Only a visit not yet seen', 'This visit has a bill', 'Give a reason for deleting the visit',
    'Enter the admission date', 'The admission date cannot be in the future', 'The admission date is more than 3 days back',
    'Give a reason for the late admission entry', 'The admission date must be today', 'Only reception or admin can admit',
    'Bed not found in your organisation', 'Department not found in your organisation', 'The admitting doctor is not a staff member',
    'The visit is not this patient', 'The assigned screener is not a staff member'];
  if (['P0001','42501','22023','P0002'].includes(error?.code) && PATIENT_VISIT_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }

  // TODO §261 (C, owner 22 Oct 2026): the server's refusals of result entry / release by a non-lab role, in one plain sentence
  const LAB_ONLY_MSGS = ['Lab collection, results and the report are recorded by the lab', 'Lab results are entered by the lab',
    'A result with a value is verified by the lab'];
  if (['P0001','42501'].includes(error?.code) && LAB_ONLY_MSGS.some(m => error?.message?.startsWith(m))) {
    return 'Only lab staff can enter or change results.';
  }

  // Session 353B (TODO §232): the shared-row tables (lab results / sign-off, PK sessions / clearance, Kriya Kalpa, blood bank, Palha diet) --
  // the server's plain refusals are shown as they are
  const SHARED_ROW_MSGS = ['A new lab order', 'Lab collection, results', 'Payment is still pending for this order', 'Lab results are signed off',
    'This lab order is already signed off', 'From this page a pending payment', "A trainee's draft lab order", 'An outside-lab result',
    'Payments are recorded by the billing counter', 'This part of the lab order', 'A lab result is signed off later', 'Lab results are entered',
    'A signed lab result is frozen', 'This result is verified', 'A result with a value', 'Only the lab or the pathologist', 'You entered this result',
    'A lab result goes pending', 'The sign-off is recorded', 'The test of a lab order', 'A new PK session', 'PK fitness clearance is given',
    'PK sessions are updated', 'The clearance is recorded', 'The PK schedule', 'A Kriya Kalpa session is cancelled', 'Kriya Kalpa sessions are carried out',
    'The Kriya Kalpa fitness clearance', 'The Kriya Kalpa prescription', 'A new blood request', 'Blood is issued', 'The cross-match is recorded',
    'A blood request is cancelled', 'The transfusion is recorded', 'A transfusion reaction', 'This blood request cannot go back', 'The blood request itself',
    'A bag is marked issued', 'An issued bag', 'A new diet indent', 'A served or cancelled diet indent', 'A diet indent is', 'The diet indent is prepared',
    'A diet indent only moves', 'Serving is recorded', 'The patient / admission of a diet indent', 'Only a request with a compatible',
    'Blood request not found', 'Only the pathologist or the lab in-charge', 'Give the reason for re-opening', 'Lab result not found', 'Only a signed result',
    'A PK session is rescheduled', 'PK session not found', 'Only a skipped session', 'Pick today or a later date',
    'A blood request needs the patient'];
  if (['P0001','42501','P0002','22023'].includes(error?.code) && (SHARED_ROW_MSGS.some(m => error?.message?.startsWith(m))
      || /^Bag \S+ (is not available in your blood bank stock\.|has expired \(.+\)\.|is .+, the request is for .+\.)$/.test(error?.message || ''))) {
    return error.message;
  }
  const SHARED_ROW_TABLES = ['lab_orders', 'lab_order_items', 'pk_therapy_sessions', 'pk_therapy_session_therapists', 'kriyakalpa_sessions',
    'blood_bank_requests', 'blood_bank_inventory', 'palha_diet_indents'];
  const rlsB = /violates row-level security policy for table "([a-z_]+)"/.exec(error?.message || '');
  if (error?.code === '42501' && rlsB && SHARED_ROW_TABLES.includes(rlsB[1])) {
    return 'Your role can view this record but not save it here -- lab orders by doctors, results by the lab, sign-off by the pathologist / lab in-charge, PK sessions by their therapist (planned by the PK in-charge), clearance by a doctor, blood stock and issue by the blood bank technician, diet orders by doctors / nurses and serving by the diet kitchen.';
  }
  const deniedB = /^permission denied for table ([a-z_]+)$/.exec(error?.message || '');
  if (error?.code === '42501' && deniedB && SHARED_ROW_TABLES.includes(deniedB[1])) {
    return 'This record cannot be deleted. Record a correction or change its status instead.';
  }

  // Session 353A (TODO §232): the role record locks on the clinical tables -- the server's plain refusals (author / organisation fixed,
  // the case team, the nurse / therapist columns, a link to another organisation, the department change rule)
  const RECORD_LOCK_MSGS = ['The recorded by of a record', 'The created by of a record', 'The created at of a record', 'The tenant id of a record',
    'The done by of a record', 'The assessed by of a record', 'The reported by of a record', 'The audited by of a record', 'The inserted by of a record',
    'The marked by of a record', 'The detected by of a record', 'The tech id of a record',
    'The linked ', 'Only the surgeon team or the Shalya HOD', 'Only the case doctor or the', 'Only the session doctor or the Shalya HOD',
    'A nurse records the ANC vitals', 'A nurse adds the vitals only', 'You cannot change your own department', 'Only the Super Admin can change the department',
    'Only the Super Admin or the HOD of both departments',
    // A4 (owner 21 Oct 2026): a NABL non-conformance is reviewed / closed only by the lab in-charge or pathologist
    'A non-conformance is raised as open', 'A closed non-conformance'];
  if (['P0001','42501','P0002'].includes(error?.code) && (RECORD_LOCK_MSGS.some(m => error?.message?.startsWith(m))
      || /^The [a-z ]+ is not a staff member of your organisation\.$/.test(error?.message || ''))) {
    return error.message;
  }
  // ... and a refused insert / update on one of those tables (row-level security): say who writes it, not a generic failure
  const LOCKED_TABLES = ['nursing_vitals', 'nursing_notes', 'nursing_io', 'nursing_handovers', 'risk_assessments', 'ward_procedures', 'icu_flowsheets',
    'patient_devices', 'hai_events', 'emergency_kit_audits', 'nursing_zone_assignments', 'lab_qc_runs', 'lab_instruments', 'reagent_batches',
    'lab_nc_reports', 'yoga_sessions', 'yoga_attendance', 'physiotherapy_sessions', 'ot_cases', 'minor_ot_procedures', 'ks_sessions',
    'ks_thread_changes', 'anushastra_sessions', 'ot_procedures', 'anc_visits', 'partograph_entries', 'deliveries', 'lab_reports', 'lab_samples'];
  const rls = /violates row-level security policy for table "([a-z_]+)"/.exec(error?.message || '');
  if (error?.code === '42501' && rls && LOCKED_TABLES.includes(rls[1])) {
    return 'Your role can view this record but not save it here -- it is written by the staff who own it (e.g. nursing charts by nurses, lab entries by the lab, OT / Kshara Sutra / Anushastra by the Shalya team, IPD OT procedures by Shalya or Prasuti & Stri Roga, ANC / Labour Room by Prasuti & Stri Roga).';
  }
  const denied = /^permission denied for table ([a-z_]+)$/.exec(error?.message || '');
  if (error?.code === '42501' && denied && LOCKED_TABLES.includes(denied[1])) {
    return 'This record cannot be deleted. Record a correction or change its status instead.';
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

  // Session 356 (TODO §265-A / §265-B): admission advice, admission without advice, refused admission, emergency admission --
  // the server's plain refusals are shown as they are
  const ADMISSION_MSGS = ['Only an active consultant doctor can', 'Patient not found in your organisation', 'An admission is advised during the consultation',
    'Select the department for the admission', 'The field ', 'The admission advice is missing', 'The planned procedures must be', 'Too many planned procedures',
    'A planned procedure line', 'Enter the clinical indication', 'A field of the admission advice', 'The expected duration must',
    'The estimate of the admission advice', 'This patient already has a pending admission advice', 'This patient is already admitted',
    'The Panchakarma care plan is not', 'Only the doctor who wrote the Panchakarma', 'Admission advice not found', 'Only the doctor who advised',
    'This admission advice is already', 'Give a reason for cancelling the advice', 'Only the admission counter can record', 'Give the reason the patient refused',
    'Admission advice record not found', 'This admission advice has already been', 'The admitting doctor is the doctor who advised',
    'The department is the one the doctor advised', 'The visit is the one the admission', 'The doctor who advised this admission no longer',
    'An admission needs a doctor', 'Give the reason for admitting without', 'The admitting doctor must be an active', "This consultation's disposition is Admission",
    'This visit is already completed and has no admission advice', 'Only the RMO / CMO on duty', 'Only an active Resident Medical Officer',
    'Select a bed of your organisation', 'The consultant must be an active', "Choose today's on-call consultant", 'Give the reason for the emergency admission',
    'This patient already has an open IPD admission', 'Admission not found in your organisation', 'Only an emergency admission is confirmed',
    'Only the consultant the patient was admitted under', 'This emergency admission is already confirmed', 'Your role cannot see the emergency admissions',
    'Your role cannot print this form', 'There is no recorded refusal of admission'];
  if (['P0001','42501','22023','P0002','23505','23514'].includes(error?.code) && ADMISSION_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }
  // Session 357 (TODO §265-C / §275): the admission counter, the deposit rule and the waiver
  const COUNTER_MSGS = ['Choose a room type preference', 'Only the admission counter can set the payer', 'This admission advice is already',
    'Choose the payer', 'Cashless or reimbursement must be chosen', 'Enter the insurance company', 'Enter the policy number', 'The co-pay must be',
    'A field of the insurance details', 'A pre-authorization is waiting for the insurer', 'The pre-authorization of this case is approved',
    'Only the Finance Manager, the Medical Superintendent or the Super Admin', 'Waive the deposit of one', 'Give the reason for waiving the deposit',
    'Only a self-pay admission needs a deposit', 'The deposit of this admission advice is already waived', 'There is no deposit due',
    'A self-pay admission needs a deposit of more than', 'The payer of this admission was set at the counter',
    'Your role cannot see the admissions awaiting a deposit', 'Only the Medical Superintendent or the Super Admin can see the deposit waivers'];
  if (['P0001','42501','22023','P0002'].includes(error?.code) && COUNTER_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }
  // Session 357c (TODO §282): the insurance / corporate deposit, the bed type against the advice, the suggested deposit, the advance policy
  const S357C_MSGS = ['An admission needs a deposit of more than', 'The doctor advised ', 'A government scheme admission',
    'Your role cannot see the suggested deposit', 'Admission advice not found in your organisation',
    'Only the Super Admin can change the admission advance policy', 'Advance percentages must be between', 'The default advance amount cannot be',
    'The admission advance policy is changed only in Fee Admin'];
  if (['42501','22023','P0002'].includes(error?.code) && S357C_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }
  // Session 358 (TODO §265-D / §243 / §274 / §290): finishing a visit, awaiting reports, the casualty registration, the Emergency OPD
  const S358_MSGS = ['Only an active doctor', 'Unknown way to finish the consultation', 'Visit not found in your organisation',
    'Open the visit from Awaiting reports first', 'Only the doctor of this visit', 'Choose the disposition after the reports',
    'This visit is already closed', 'This visit is waiting for reports', 'Save the consultation note first', 'Save the final consultation note first',
    'Record the provisional diagnosis', 'Awaiting reports needs at least one investigation', 'There is no prescription for this visit',
    'This visit has a prescription', 'Write a short note', 'Record the final diagnosis', 'This visit was completed without a prescription',
    'This visit is not waiting for reports', 'Only the Super Admin re-assigns', 'Only a visit waiting for reports is re-assigned',
    'The new doctor must be an active', 'Give the reason for the re-assignment', "Your role cannot record the patient's return",
    'Your role cannot see this list', 'Only the RMO / CMO / EMO on duty', 'Choose the sex', 'Enter the approximate age', 'Enter the chief complaint',
    'The phone number is not valid', 'The brought-by phone number is not valid', "Enter the patient's name, or tick", 'A medico-legal case',
    'Enter the time the police were informed', 'A field is too long', 'Only reception, MRD or the Super Admin completes', 'Patient not found in your organisation',
    'Nothing to save', 'The address is too long', 'The date of birth is', 'The blood group is not valid', "An unidentified patient's identity",
    'The casualty register entry', 'This casualty register entry', 'Only the Super Admin marks the Emergency OPD', 'OPD not found in your organisation',
    'Activate the OPD first', 'The Screening OPD cannot be the Emergency OPD', 'The Emergency OPD is marked by the Super Admin',
    'This is the Emergency OPD', 'An emergency visit stays in the Emergency OPD'];
  if (['P0001','42501','22023','P0002','23505','23514'].includes(error?.code) && S358_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }
  if (['42501','22023'].includes(error?.code) && /^The (phone|address|date of birth|blood group) is already recorded|^The \w[\w ]* is not completed here/.test(error?.message || '')) {
    return error.message;
  }
  // Session 359 (TODO §293 / §295): fee approval, the role rule (rule 3), the lab Urgent / waiver, the roles of an account, the nursing head
  const S359_MSGS = ['A new fee starts as Pending', 'A fee is approved, activated or rejected only', 'Only an active Super Admin can deactivate a fee',
    'Only an active Super Admin can set or clear a promo price', 'An active fee is changed only by the Super Admin', 'Choose approve or reject',
    'Choose between 1 and 1000 fees', 'A rejection needs a reason', 'Fee not found in your organisation', 'You cannot approve or reject a fee you created yourself',
    'Fee "', 'Only the head of the fee', 'The final approval of a fee', 'Only a Pending or Dept. Approved fee', 'Choose a period of up to one year',
    'Give the role ', 'Only an active receptionist, cashier or the Super Admin', 'Lab order not found in your organisation', 'Give the reason (5 to 500',
    'Only an open, unpaid order', 'A listed price is not an active lab', 'Only the Finance Manager, the Medical Superintendent or the Super Admin can waive',
    'Only an unpaid OPD order', 'This test is already on a bill', 'The order has no priced test', 'Use "Urgent -- proceed before payment"',
    "Only an active Super Admin can change a staff member's role", 'Staff member not found in your organisation', 'You cannot change your own role',
    'The role of a Super Admin is not changed here', "Only an active account's role", 'Choose a valid role', 'Secondary role must be different',
    'Delegate must be an active Deputy Nursing Superintendent', 'Only super_admin can promote staff', 'Staff member must be an active account',
    "This is the organisation's last active Super Admin"];
  if (['P0001','42501','22023','23514'].includes(error?.code) && S359_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }
  // Session 365: suppliers' GST identity, the GST goods receipt (GRN) + its cancel, the stock ledger, the pharmacy dashboard --
  // the server's plain refusals are shown as they are
  const S365_MSGS = ['Only the pharmacy team or an administrator can add or change a supplier', "Enter the supplier's name",
    "Choose the supplier's GST registration", "Enter the supplier's GSTIN", 'The GSTIN ', 'An unregistered supplier has no GSTIN',
    'Choose the state of an unregistered supplier', 'The PAN is not', 'The email address is not valid', 'A supplier field is too long',
    'The GMP certificate expiry is not a date', 'A supplier with the GSTIN ', "That supplier is not in this organisation's register",
    "Choose a supplier from this organisation's register", 'The supplier ', "Record the supplier's GST registration", 'Purchase blocked:',
    'Only an active Super Admin can override the GMP block', 'Give the reason for overriding the GMP block', "Enter the supplier's invoice",
    'Reverse charge purchases are not supported', 'The remarks are too long', 'Choose the place of supply', 'Add at least one item to receive',
    'A goods receipt can have at most', 'Line ', 'The invoice total is not a number', 'Only the pharmacy team or an administrator can record a goods receipt',
    "The supplier's invoice total", 'This supplier invoice (', 'Goods receipt not found', 'Only the pharmacy in-charge or the finance manager',
    'This goods receipt is already cancelled', 'Give the reason for cancelling', 'The person who recorded a goods receipt', "This goods receipt's ITC period",
    'Part of this stock is already sold or used', 'Your role cannot see the stock ledger', 'Medicine not found in your organisation',
    'Choose a period of up to 400 days', 'Your role cannot see the goods receipts', 'Your role cannot see the pharmacy dashboard',
    'Receive Stock now records', 'Sign in again'];
  if (['P0001','42501','22023','P0002','23505'].includes(error?.code) && S365_MSGS.some(m => error?.message?.startsWith(m))) {
    return error.message;
  }
  if (error?.code === '42501' && error?.message === 'Not authorized') {   // 359: an inactive / relieved account, or no right at all
    return 'Your account is not allowed to do this (it may not be active). Ask the Super Admin.';
  }
  if (error?.code === '42501' && /^permission denied for (table|column) doctor_alerts/.test(error?.message || '')) {
    return 'Only your own alerts can be opened or marked read.';
  }
  if (error?.code === '42501' && /^permission denied for table admission_advice(_items)?$/.test(error?.message || '')) {
    return 'An admission advice is sent and changed only by the advising doctor (doctor.html → Admission tab).';
  }

  // Session 357b: anything not shown as written above never ends as the bare fallback -- the cause in plain words
  // + the SQLSTATE code (safe to show). Database wording, table and constraint names stay hidden.
  if (error?.message === 'This page was opened as another user. Reload to continue.') return error.message;
  const cause = _errorCause(error);
  const code = error?.code ? String(error.code) : '';
  if (!cause && !code) return fallback;
  return `${String(fallback).replace(/[.\s]+$/, '')}${cause ? ' — ' + cause : ''}${code ? ` (error code ${code})` : ''}.`;
}

// Session 357b: a check rule the browser can break, named by its form field (never the constraint name)
const CHECK_RULE_FIELDS = {
  admission_advice_payer_type_check: 'the expected payer is not one of the allowed choices',
  admission_advice_service_nature_chk: 'the nature of the service is not one of the allowed choices',
  ipd_admissions_payer_type_check: 'the payer is not one of the allowed choices',
};
function _errorCause(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  if (!code && /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return 'the server could not be reached; check the internet connection and try again';
  }
  if (code === 'PGRST301' || code === 'PGRST303' || /jwt expired|invalid jwt/i.test(msg)) return 'your sign-in has expired; sign in again';
  if (code === 'PGRST202' || code === '42883') return 'this page and the server do not match; reload the page';
  if (code === '57014') return 'the server took too long; try again';
  if (code === '40001' || code === '40P01' || code === '55P03') return 'the record was busy; try again';
  if (code === '23514') {
    const rule = (msg.match(/check constraint "([^"]+)"/) || [])[1];
    return CHECK_RULE_FIELDS[rule] || 'a value on this form is not allowed';
  }
  if (code === '23502') return 'a required value is missing';
  if (code === '23503') return 'it refers to a record that does not exist or is not allowed';
  if (code === '23505') return 'this record already exists';
  if (['22P02', '22003', '22007', '22008', '22001'].includes(code)) return 'a value has the wrong format or is too long';
  if (code === '42501') return 'your role is not allowed to do this';
  return '';
}
