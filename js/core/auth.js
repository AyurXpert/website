// js/core/auth.js
// AyurXpert — complete authentication module
// Handles: login, logout, tenant registration, staff signup,
//          approval workflow, session management, route protection

import { supabase } from './db/supabaseClient.js';
import {
  ROLES,
  ROLE_HOME,
  PUBLIC_PAGES,
  SESSION_KEYS,
  MFA_MANDATORY_ROLES,
  SUPABASE_URL,
} from '../config/constants.js';
import { logAudit } from './auditLogger.js';
import { safeErrorMessage } from '../utils/errors.js';
import { RETURN_KEY, safeReturnPath } from '../utils/signInGate.js';
import { rememberOrgCode } from '../utils/rememberedOrg.js';
import { getTabUser, setTabUser, clearTabUser, blockTab, isTabBlocked, onTabBlocked } from './tabUser.js';
import { isRuleDHod } from '../utils/hodAccess.js';

// TODO §253: a designation that has its own landing page (role home otherwise).
// The yoga instructor is role 'therapist' + designation 'yoga_instructor' and works on
// yoga.html, not on the Panchakarma sessions page that every other therapist lands on.
const DESIGNATION_HOME = {
  yoga_instructor: 'yoga.html',
};

export function getHomePage(profile) {
  if (profile?.role === ROLES.THERAPIST && DESIGNATION_HOME[profile?.designation]) {
    return DESIGNATION_HOME[profile.designation];
  }
  return ROLE_HOME[profile?.role] || 'admin.html';
}

// Session 354b (owner, 21 Oct 2026): pages a designation may not open although its role may.
// The yoga instructor has no Panchakarma, Kriya Kalpa or Anushastra work (owner, 21 Oct 2026).
// One list for both the menu (navbar.js hides the link) and requireAuth (redirects to the
// designation's home). A second role grants its own access on top, so it lifts the restriction.
const DESIGNATION_DENIED_PAGES = {
  yoga_instructor: ['therapist.html', 'kriyakalpa.html', 'anushastra.html'],
};

export function isPageDeniedForDesignation(profile, page) {
  if (profile?.role !== ROLES.THERAPIST || profile?.secondary_role) return false;
  return (DESIGNATION_DENIED_PAGES[profile?.designation] || []).includes(page);
}

// §432 (owner, 5 Nov 2026): a hospital, teaching hospital or college has its own front-desk staff, so an account whose only way to Reception is the
// role doctor does not work there. A clinic, PK centre or dispensary keeps it. The same rule as the server's _doctor_desk_closed(), which also refuses
// the writes; a second role cashier opens the page for its Lab Bills only.
const STAFFED_FRONT_DESK_TYPES = ['hospital', 'teaching_hospital', 'college'];
export function isReceptionClosedForDoctor(profile, tenant) {
  const roles = [profile?.role, profile?.secondary_role];
  if (!roles.includes(ROLES.DOCTOR) || roles.some(r => ['receptionist', 'nurse', 'dept_admin', 'super_admin', 'cashier'].includes(r))) return false;
  return !tenant?.type || STAFFED_FRONT_DESK_TYPES.includes(tenant.type);
}

// §435 (owner, 6 Nov 2026): pages closed to a doctor at a hospital, teaching hospital or college; a clinic, PK centre or dispensary keeps them. One list for requireAuth, the
// menu (navbar.js) and dept-hub.js. others = the other roles that have the page, primary or second (null = any other role); hod = a department head keeps it (Rule D);
// designations = an office that works on the page. An account with another way in keeps the page, as with Reception above.
// Opening a page is not writing on it: the server decides (§445). Owner, 6 Nov 2026: HODs keep the five quality pages until the fine-tuning by department (§446, after the pilot).
const OFFICE_DOCTORS = ['medical_superintendent', 'deputy_medical_superintendent', 'resident_medical_officer'];
const DOCTOR_CLOSED_PAGES = {
  'shift-close.html': { others: ['receptionist', 'nurse', 'cashier', 'accountant', 'finance_manager', 'dept_admin', 'super_admin', 'lab_tech', 'pharmacist', 'nurse_manager', 'therapist'] },
  'lab-nabl.html': { others: ['lab_tech', 'nurse', 'dept_admin', 'super_admin'], designations: ['pathologist', 'lab_incharge', ...OFFICE_DOCTORS], hod: true },
  'aushadha-nirman.html': { others: ['pharmacist', 'dept_admin', 'super_admin'], designations: OFFICE_DOCTORS, hod: true },
  'sterilisation.html': { others: ['nurse', 'receptionist', 'dept_admin', 'super_admin'], designations: ['cssd_incharge', ...OFFICE_DOCTORS], hod: true },
  'bmw.html': { others: ['nurse', 'receptionist', 'dept_admin', 'super_admin'], designations: ['bmw_officer', ...OFFICE_DOCTORS], hod: true },
  'iqac.html': { others: ['receptionist', 'dept_admin', 'super_admin'], designations: ['iqac_coordinator', ...OFFICE_DOCTORS], hod: true },
  'pk-protocol-admin.html': { others: null, designations: ['pk_incharge', 'medical_director', 'principal', 'medical_superintendent', 'deputy_medical_superintendent'] },
  'fee-admin.html': { others: ['dept_admin', 'super_admin', 'accountant', 'finance_manager'], hod: true },   // Session 359: the HOD gives step 1 of a fee
};
export function isPageClosedForDoctor(profile, tenant, page) {
  const rule = DOCTOR_CLOSED_PAGES[page];
  const roles = [profile?.role, profile?.secondary_role].filter(Boolean);
  if (!rule || !roles.includes(ROLES.DOCTOR)) return false;
  if (tenant?.type && !STAFFED_FRONT_DESK_TYPES.includes(tenant.type)) return false;
  if (roles.some(r => r !== ROLES.DOCTOR && (rule.others === null || rule.others.includes(r)))) return false;
  if ((rule.designations || []).includes(profile?.designation)) return false;
  return !(rule.hod && isRuleDHod(profile));
}


// 27 Aug 2026 — shared safety net for every signup flow below. Both
// registerTenant() and registerStaff() call auth.signUp() BEFORE writing the
// row(s) that make the account usable (tenants+profiles, or just profiles).
// If any of those writes then fails — for any reason, not just the specific
// state_reg_id bug this was built for (see memory
// `auth_js_state_reg_id_signup_bug.md`) — the auth.users row is otherwise
// permanently orphaned: no profile means no way to log in or be approved,
// but the email is already taken, so retrying signup fails with "already
// registered." Call this right before throwing on any post-signUp() write
// failure, so the same email is immediately safe to retry with.
//
// signup-rollback (Edge Function) deletes ONLY the calling user's own
// account, and only after re-verifying server-side that it truly has zero
// profile rows — see that function's own comments for the full safety
// reasoning. This helper is deliberately best-effort and swallows its own
// errors: a rollback failure (network blip, function down) must never mask
// or replace the real error the caller is already about to throw.
// orphanedTenantId: pass the just-created tenants.id when a WRITE AFTER the
// tenant row (i.e. the profile insert) is what failed — registerTenant()'s
// tenant-insert failure itself has no tenant row to clean up yet, so it's
// omitted there.
async function _rollbackFailedSignup(orphanedTenantId = null) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/signup-rollback`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        ...(orphanedTenantId ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(orphanedTenantId ? { body: JSON.stringify({ orphanedTenantId }) } : {}),
    });
    // Local session now points at a deleted (or otherwise no-longer-usable)
    // account either way — clear it so a retry starts clean instead of
    // carrying a stale token.
    if (res.ok) await supabase.auth.signOut();
  } catch (err) {
    console.warn('_rollbackFailedSignup failed (non-fatal):', err);
  }
}


// ═══════════════════════════════════════════════════════════
// 1. TENANT REGISTRATION
//    Called from register.html when a NEW hospital/clinic
//    subscribes to AyurXpert for the first time.
//    Creates: auth user + tenant row + super_admin profile
// ═══════════════════════════════════════════════════════════

export async function registerTenant({
  tenantName, tenantType, fullName,
  email, password, phone, city, state
}) {
  try {
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    });
    if (authError) {
      // safeErrorMessage() is deliberately generic everywhere else (never
      // echoes raw Postgres/Auth internals to end users), but "this email
      // already has an account" is not sensitive here -- it's the single
      // most actionable thing a signing-up user can hear, and every
      // mainstream signup form says exactly this. Emails are unique across
      // the whole Supabase project, not per-tenant, so this commonly fires
      // when someone reuses an email already registered under a different
      // organisation, not just a real duplicate signup attempt.
      const already = authError.code === 'user_already_exists'
        || /already registered|already exists/i.test(authError.message || '');
      throw new Error(already
        ? 'This email is already registered on AyurXpert (possibly under a different organisation). Please use a different email address.'
        : safeErrorMessage(authError, 'Could not create account. Please try again.'));
    }

    const userId = authData.user.id;

    // Session 305: organisation + super_admin profile are created together, server-side, with
    // platform defaults for plan/subscription fields (sql/session305d_tenant_registration_lockdown.sql)
    // -- browsers can no longer insert tenants directly. One transaction, so no orphaned tenant.
    const { data: tenant, error: tenantError } = await supabase.rpc('register_tenant', {
      p_tenant_name: tenantName,
      p_tenant_type: tenantType,
      p_full_name:   fullName,
      p_phone:       phone || null,
      p_city:        city  || null,
      p_state:       state || null,
    });
    if (tenantError || !tenant?.id) {
      await _rollbackFailedSignup();
      throw new Error(safeErrorMessage(tenantError, 'Could not create organisation. Please try again with the same email address.'));
    }

    // Gives hospital/pk_center/clinic tenants a working department/OPD/bed structure
    // from their very first login instead of a completely empty bed-admin.html/
    // opd-admin.html — teaching_hospital/college go through the separate NCISM
    // subscription-request flow instead (platform_approve_ncism_request), unaffected
    // here. Non-fatal: a seeding hiccup shouldn't roll back a successful registration —
    // the admin can always add departments/OPDs manually if this silently fails.
    if (['hospital', 'pk_center', 'clinic'].includes(tenantType)) {
      const { error: seedError } = await supabase.rpc('seed_default_org_structure', { p_tenant_id: tenant.id });
      if (seedError) console.error('seed_default_org_structure error:', seedError);
    }

    return { success: true, tenant, userId };

  } catch (error) {
    console.error('registerTenant error:', error);
    return { success: false, error: error.message };
  }
}


// ═══════════════════════════════════════════════════════════
// 2. STAFF SIGNUP
//    Called from signup.html when a doctor / receptionist /
//    pharmacist etc. joins an existing hospital.
//    Creates: auth user + profile with status = pending_approval
// ═══════════════════════════════════════════════════════════

export async function registerStaff({
  fullName, email, password, phone, gender = null, dateOfBirth = null,
  role, tenantCode, hprId = null, stateRegId = null, departmentId = null, inviteToken = null
}) {
  try {
    const { data: subRows, error: tenantError } = await supabase
      .rpc('get_tenant_subscription_info', { p_code: tenantCode });

    const info = subRows?.[0] || null;

    if (tenantError || !info) throw new Error(
      'Organisation code not found. Please check the code with your admin.'
    );

    // Subscription checks
    if (info.subscription_status === 'suspended')
      throw new Error('This organisation\'s account is suspended. Please contact your administrator.');
    if (info.subscription_status === 'expired')
      throw new Error('This organisation\'s subscription has expired. Please ask your admin to renew.');
    if (info.max_users && info.current_user_count >= info.max_users)
      throw new Error(`Organisation has reached its staff limit (${info.max_users} users). Ask your admin to upgrade the plan.`);

    const tenant = { id: info.tenant_id, name: info.tenant_name, type: info.tenant_type };

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    });
    if (authError) {
      // safeErrorMessage() is deliberately generic everywhere else (never
      // echoes raw Postgres/Auth internals to end users), but "this email
      // already has an account" is not sensitive here -- it's the single
      // most actionable thing a signing-up user can hear, and every
      // mainstream signup form says exactly this. Emails are unique across
      // the whole Supabase project, not per-tenant, so this commonly fires
      // when someone reuses an email already registered under a different
      // organisation, not just a real duplicate signup attempt.
      const already = authError.code === 'user_already_exists'
        || /already registered|already exists/i.test(authError.message || '');
      throw new Error(already
        ? 'This email is already registered on AyurXpert (possibly under a different organisation). Please use a different email address.'
        : safeErrorMessage(authError, 'Could not create account. Please try again.'));
    }

    // Session 349 (TODO §213): the profile is created on the server -- the browser can no longer insert one (or choose its own rights).
    // Without an invite: the role from the signup list, no designation / second role / monitoring / department scope. With an invite
    // (signup.html?pinv=): everything comes from the invite row, which the server marks used in the same step.
    const { error: profileError } = await supabase.rpc('register_staff_profile', {
      p_tenant_code: tenantCode, p_role: role, p_full_name: fullName, p_phone: phone || null, p_gender: gender || null,
      p_date_of_birth: dateOfBirth || null, p_hpr_id: hprId || null, p_registration_number: stateRegId || null,
      p_department_id: departmentId || null, p_invite_token: inviteToken || null,
    });
    if (profileError) {
      // registerStaff() has no tenant row of its own to clean up (it joins an
      // existing tenant) — only the just-created auth account, via the shared
      // _rollbackFailedSignup() helper (see its own comment above).
      await _rollbackFailedSignup();
      throw new Error(safeErrorMessage(profileError, 'Could not create profile. Please try again with the same email address.'));
    }

    return {
      success: true,
      userId: authData.user.id,
      message: `Your request has been sent to ${tenant.name}. You will receive an email once your account is approved.`
    };

  } catch (error) {
    console.error('registerStaff error:', error);
    return { success: false, error: error.message };
  }
}


// ═══════════════════════════════════════════════════════════
// 3. LOGIN
//    Works for ALL roles. Blocks login if not active.
// ═══════════════════════════════════════════════════════════

// Writes the app's own "logged in" sessionStorage state and redirects to the
// role's landing page. Must only ever be called once aal2 is satisfied for a
// user who has a verified MFA factor (see the aal check in login() below) —
// this is deliberately the ONE place that establishes app-level login state,
// so an MFA challenge that hasn't been completed yet can never look "logged in".
async function _finalizeLogin(user, profile) {
  sessionStorage.setItem(SESSION_KEYS.USER,      JSON.stringify(user));
  sessionStorage.setItem(SESSION_KEYS.PROFILE,   JSON.stringify(profile));
  sessionStorage.setItem(SESSION_KEYS.TENANT,    JSON.stringify(profile.tenants));
  sessionStorage.setItem(SESSION_KEYS.TENANT_ID, profile.tenant_id);
  sessionStorage.setItem(SESSION_KEYS.ROLE,      profile.role);
  sessionStorage.setItem(SESSION_KEYS.SECONDARY_ROLE, profile.secondary_role || '');
  sessionStorage.setItem(SESSION_KEYS.MONITORING_ACCESS, profile.has_monitoring_access ? '1' : '');
  setTabUser(profile.id); // §250: this tab now belongs to this user
  _noteSignIn(); // §434: a new sign-in starts the idle time again
  // §319 (Session 362): this browser now remembers the account's OWN organisation for the login page's branding (only here: after a
  // SUCCESSFUL sign-in, MFA done -- never from an email lookup)
  rememberOrgCode(profile.tenants?.tenant_code);

  // §7h — the organisation's modules, decided by the server (type defaults + overrides, Session 331)
  await _loadModules();

  await logAudit('login', 'profiles', profile.id,
    { role: profile.role, tenant: profile.tenants?.name },
    { tenantId: profile.tenant_id, userId: profile.id, userName: profile.full_name }
  );

  // §118 -- signed in from a print page's "Sign in" button: go back to that document (our own print pages only)
  let back = null;
  try { back = safeReturnPath(sessionStorage.getItem(RETURN_KEY)); sessionStorage.removeItem(RETURN_KEY); } catch { back = null; }
  const destination = back || getHomePage(profile);
  window.location.href = destination;
}

export async function login({ email, password }) {
  // §250: signing in on this tab makes it the new user's tab -- forget the old one first,
  // or the request guard would refuse the new user's own sign-in requests
  clearTabUser();
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email, password
    });
    if (error) throw error;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*, tenants(*)')
      .eq('id', data.user.id)
      .single();

    if (profileError) throw new Error(
      'Profile not found. Please contact your administrator.'
    );

    // Session 204 — allowlist, not a blocklist: only 'active' may proceed. The
    // previous version explicitly listed 4 statuses to block (pending_approval/
    // approved/rejected/suspended), but profiles.status has 8 real values —
    // on_leave/inactive/blocked (exactly what hr.js's "Mark On Leave"/"Mark
    // Inactive"/"Block" actions set) were silently missing, so login() let them
    // straight through. requireAuth() on the very next page load did still catch
    // them (it already used a correct allowlist), but as a confusing flash-then-
    // bounce instead of a clear message here. Fail-closed for any future status
    // value too, not just the ones anticipated today.
    if (profile.status !== 'active') {
      await supabase.auth.signOut({ scope: 'global' });
      const statusMessages = {
        pending_approval: 'Your account is pending approval. Please wait for your administrator to activate it.',
        approved:         'Your account is approved but department access has not been assigned yet. Please wait.',
        rejected:         'Your account request was not approved. Please contact your administrator.',
        suspended:        'Your account has been suspended. Please contact your administrator.',
        on_leave:         'Your account is currently marked on leave. Please contact your administrator.',
        inactive:         'Your account has been marked inactive. Please contact your administrator.',
        blocked:          'Your account has been blocked. Please contact your administrator.',
      };
      throw new Error(statusMessages[profile.status] || 'Your account is not active. Please contact your administrator.');
    }

    // MFA gate: if this user has a verified TOTP factor, the session is only at
    // aal1 right after signInWithPassword — do NOT establish app-level "logged
    // in" state yet. Hand back to the caller so it can show a code-entry step;
    // verifyMfaAndFinishLogin() below completes the login once the code checks out.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === 'aal2' && aal.nextLevel !== aal.currentLevel) {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totpFactor = factors?.totp?.find(f => f.status === 'verified');
      return { success: true, mfaRequired: true, factorId: totpFactor?.id };
    }

    await _finalizeLogin(data.user, profile);
    return { success: true };

  } catch (error) {
    console.error('login error:', error);
    return { success: false, error: error.message };
  }
}

// Completes the MFA challenge login() deferred (see the aal check above) and
// finishes the login the same way login() would have for a non-MFA account.
export async function verifyMfaAndFinishLogin({ factorId, code }) {
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) throw new Error(safeErrorMessage(error, 'Invalid code. Please try again.'));

    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*, tenants(*)')
      .eq('id', user.id)
      .single();
    if (profileError) throw new Error('Profile not found. Please contact your administrator.');

    await _finalizeLogin(user, profile);
    return { success: true };
  } catch (error) {
    console.error('verifyMfaAndFinishLogin error:', error);
    return { success: false, error: error.message };
  }
}

// Session 129 -- self-service recovery when the authenticator app/device is
// unavailable. The caller already has a valid aal1 session at this point
// (login() already completed signInWithPassword() before the MFA screen
// renders), so mfa-backup-verify only needs that session's JWT, not the
// password again. On success the account's TOTP factor(s) are already gone
// server-side, so requireAuth()'s existing mandatory-MFA check will force a
// fresh enrollment on the very next protected-page load -- no new logic
// needed here beyond finishing this login exactly like a normal MFA pass.
export async function verifyBackupCodeAndFinishLogin({ code }) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Session expired. Please log in again.');

    const res = await fetch('https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/mfa-backup-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ code }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Invalid or already-used backup code.');

    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*, tenants(*)')
      .eq('id', user.id)
      .single();
    if (profileError) throw new Error('Profile not found. Please contact your administrator.');

    await _finalizeLogin(user, profile);
    return { success: true };
  } catch (error) {
    console.error('verifyBackupCodeAndFinishLogin error:', error);
    return { success: false, error: error.message };
  }
}


// ═══════════════════════════════════════════════════════════
// 4. LOGOUT
// ═══════════════════════════════════════════════════════════

export async function logout() {
  clearTimeout(_inactivityTimer);
  // Session 371B (plan session 370 B8 / D1a 7): signing out ends my open duty sessions (registration, screening ...) on the server.
  // Best effort, at most 2 s -- a slow network must never stop a sign-out; the nightly job ends anything left open.
  try {
    await Promise.race([supabase.rpc('end_my_duty'), new Promise(r => setTimeout(r, 2000))]);
  } catch { /* the sign-out goes on */ }
  const { error } = await supabase.auth.signOut({ scope: 'global' }); // invalidate ALL sessions on all devices
  // Owner, 6 Nov 2026: the server could not be told (no connection), and the library then keeps the session: this browser's copy goes here, signed out means signed out
  if (error) { try { localStorage.removeItem(supabase.auth.storageKey); } catch { /* storage blocked */ } }
  sessionStorage.clear();
  window.location.replace('login.html'); // replace prevents back-button returning to protected page
}


// ═══════════════════════════════════════════════════════════
// 5. APPROVAL WORKFLOW
// ═══════════════════════════════════════════════════════════

export async function getPendingApprovals() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, phone, created_at, designation, department_id, secondary_role, has_monitoring_access, scope_department_id')   // Session 349: everything requested
    .eq('tenant_id', getCurrentTenantId())
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true });

  if (error) { console.error('getPendingApprovals error:', error); return []; }
  return data;
}

export async function approveStaff(profileId, departmentId) {
  const { error } = await supabase
    .from('profiles')
    .update({
      status:        'approved',
      department_id: departmentId,
      approved_by:   getCurrentProfile().id,
      approved_at:   new Date().toISOString(),
    })
    .eq('id', profileId)
    .eq('tenant_id', getCurrentTenantId());

  if (error) return { success: false, error: safeErrorMessage(error, 'Could not approve staff.') };
  return { success: true };
}

export async function rejectStaff(profileId, reason = '') {
  const { error } = await supabase
    .from('profiles')
    .update({
      status:           'rejected',
      rejection_reason: reason,
      approved_by:      getCurrentProfile().id,
      approved_at:      new Date().toISOString(),
    })
    .eq('id', profileId)
    .eq('tenant_id', getCurrentTenantId());

  if (error) return { success: false, error: safeErrorMessage(error, 'Could not reject staff request.') };
  return { success: true };
}

export async function activateStaff(profileId, permissions) {
  try {
    const { error: permError } = await supabase
      .from('profile_departments')
      .insert({
        profile_id:            profileId,
        department_id:         permissions.departmentId,
        tenant_id:             getCurrentTenantId(),
        can_access_opd:        permissions.opd        || false,
        can_access_ipd:        permissions.ipd        || false,
        can_access_pharmacy:   permissions.pharmacy   || false,
        can_access_lab:        permissions.lab        || false,
        can_access_accounts:   permissions.accounts   || false,
        can_access_hr:         permissions.hr         || false,
        can_access_panchkarma: permissions.panchkarma || false,
        can_access_store:      permissions.store      || false,
        can_access_reports:    permissions.reports    || false,
        can_read:              permissions.canRead    ?? true,
        can_write:             permissions.canWrite   || false,
        can_delete:            permissions.canDelete  || false,
        assigned_by:           getCurrentProfile().id,
      });
    if (permError) throw new Error(safeErrorMessage(permError, 'Could not save staff permissions.'));

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ status: 'active', is_active: true })
      .eq('id', profileId)
      .eq('tenant_id', getCurrentTenantId());
    if (profileError) throw new Error(safeErrorMessage(profileError, 'Could not activate staff.'));

    return { success: true };
  } catch (error) {
    console.error('activateStaff error:', error);
    return { success: false, error: error.message };
  }
}

export async function suspendStaff(profileId) {
  const { error } = await supabase
    .from('profiles')
    .update({ status: 'suspended', is_active: false })
    .eq('id', profileId)
    .eq('tenant_id', getCurrentTenantId());

  if (error) return { success: false, error: safeErrorMessage(error, 'Could not suspend staff.') };
  return { success: true };
}


// ═══════════════════════════════════════════════════════════
// 6. SESSION HELPERS
// ═══════════════════════════════════════════════════════════

export function getCurrentProfile() {
  const raw = sessionStorage.getItem(SESSION_KEYS.PROFILE);
  return raw ? JSON.parse(raw) : null;
}

export function getCurrentTenantId() {
  return sessionStorage.getItem(SESSION_KEYS.TENANT_ID) || null;
}

export function getCurrentRole() {
  return sessionStorage.getItem(SESSION_KEYS.ROLE) || null;
}

// A second, additive system-access role (e.g. a doctor who also holds
// dept_admin for a Deputy MS / HOD-type position) -- null for the vast
// majority of staff who only ever have one role.
export function getCurrentSecondaryRole() {
  return sessionStorage.getItem(SESSION_KEYS.SECONDARY_ROLE) || null;
}

// A narrow, read-only cross-cutting grant (e.g. Deputy MS) -- deliberately
// separate from role/secondaryRole, since it never unlocks a write action,
// only page-load access to pages independently verified to be mutation-free.
export function getCurrentHasMonitoringAccess() {
  return sessionStorage.getItem(SESSION_KEYS.MONITORING_ACCESS) === '1';
}

export function getCurrentTenant() {
  const raw = sessionStorage.getItem(SESSION_KEYS.TENANT);
  return raw ? JSON.parse(raw) : null;
}

// §7h — the server's answer for this organisation (get_my_modules(): every module key -> true / false,
// from module_defaults + tenants.modules overrides). Session 331: no longer defaulted in the browser.
async function _loadModules() {
  const { data, error } = await supabase.rpc('get_my_modules');
  if (error || !data || typeof data !== 'object') {
    sessionStorage.removeItem(SESSION_KEYS.MODULES);   // fail closed: hasModule() is false until they load
    return;
  }
  sessionStorage.setItem(SESSION_KEYS.MODULES, JSON.stringify(data));
}

// §7h — true only if the server said this module is on for this organisation. Fails CLOSED (Session 331):
// before, a missing map (e.g. a new tab) meant every module was on.
export function hasModule(key) {
  const raw = sessionStorage.getItem(SESSION_KEYS.MODULES);
  if (!raw) return false;
  try { return JSON.parse(raw)[key] === true; } catch { return false; }
}

export function getCurrentModules() {
  const raw = sessionStorage.getItem(SESSION_KEYS.MODULES);
  return raw ? JSON.parse(raw) : {};
}


// ═══════════════════════════════════════════════════════════
// 7. ROUTE GUARD
//    Add to top of every protected page:
//    import { requireAuth } from './js/core/auth.js';
//    await requireAuth(['doctor', 'receptionist']);
// ═══════════════════════════════════════════════════════════

// --- Security hardening (WASA remediation) ---

// Inject security meta tags once per page load
function _injectSecurityMeta() {
  if (document.querySelector('meta[name="ax-sec"]')) return;
  const head = document.head;
  const add = (attrs) => {
    const m = document.createElement('meta');
    Object.entries(attrs).forEach(([k, v]) => m.setAttribute(k, v));
    head.appendChild(m);
  };
  // CSP — dedicated directives per WASA retest requirement (unsafe-eval removed)
  add({ 'http-equiv': 'Content-Security-Policy',
        content: [
          "default-src 'none'",
          "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://static.cloudflareinsights.com",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
          "img-src 'self' data: blob: https://*.supabase.co",
          "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://abhasbx.abdm.gov.in https://phrsbx.abdm.gov.in https://healthid.abdm.gov.in https://cloudflareinsights.com https://static.cloudflareinsights.com",
          "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
          "manifest-src 'self'",
          "worker-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'"
        ].join('; ')
      });
  // Prevent MIME sniffing
  add({ 'http-equiv': 'X-Content-Type-Options', content: 'nosniff' });
  // Referrer policy
  add({ name: 'referrer', content: 'strict-origin-when-cross-origin' });
  // Prevent caching of authenticated pages (back-button after logout)
  add({ 'http-equiv': 'Cache-Control', content: 'no-store, no-cache, must-revalidate, private' });
  add({ 'http-equiv': 'Pragma', content: 'no-cache' });
  add({ name: 'ax-sec', content: '1' }); // sentinel
}

// Clickjacking frame-buster
function _frameGuard() {
  if (window !== window.top) {
    window.top.location.href = window.location.href;
  }
}

// 15-minute inactivity auto-logout (NDHM §2.1.4.7)
// §434 (owner, 5 Nov 2026): ONE idle time for all tabs of a browser, kept in localStorage. Activity in any tab counts for every tab, and because the time
// is stored, a computer that slept or a browser that was closed past the limit is signed out on its next page load.
const _ACTIVITY_KEY = 'ax_last_activity';
const _ACTIVITY_WRITE_MS = 5000;   // mouse moves are many: store at most this often
let _inactivityTimer = null;
let _lastActivity = 0;             // this tab's copy, in case the browser refuses localStorage
let _lastMouse = null;
let _idleWatching = false;
const _INACTIVITY_MS = 15 * 60 * 1000;
const _INACTIVITY_WARN_MS = 2 * 60 * 1000; // warn 2 min before the forced logout

// Session was silently dying mid-consultation with zero warning — a doctor mid-typing
// a long clinical note would lose it all with no chance to react. Surface a warning
// banner before the forced logout; any tracked activity (which already reaches this
// listener) dismisses it and pushes the deadline back out, same as before.
function _showInactivityWarning() {
  if (document.getElementById('ax-inactivity-warning')) return;
  const banner = document.createElement('div');
  banner.id = 'ax-inactivity-warning';
  banner.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;background:#c0392b;color:#fff;padding:14px 20px;border-radius:8px;font:600 14px "DM Sans",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:320px';
  banner.textContent = '⚠️ You will be logged out in 2 minutes due to inactivity. Move the mouse or press a key to stay logged in.';
  document.body.appendChild(banner);
}

function _hideInactivityWarning() {
  document.getElementById('ax-inactivity-warning')?.remove();
}

function _storedActivity() {
  try { return Number(localStorage.getItem(_ACTIVITY_KEY)) || 0; } catch { return 0; }
}

function _storeActivity(now) {
  _lastActivity = now;
  try { localStorage.setItem(_ACTIVITY_KEY, String(now)); } catch { /* this tab's copy still counts */ }
}

function _noteSignIn() { _storeActivity(Date.now()); }

// Runs at each deadline and whenever another tab reports activity: the stored time decides, so a tab asleep behind another never signs out a working user.
function _checkIdle() {
  clearTimeout(_inactivityTimer);
  // §250: a blocked tab must not sign the OTHER person out 15 minutes later
  if (isTabBlocked()) { _hideInactivityWarning(); return; }
  const idle = Date.now() - Math.max(_lastActivity, _storedActivity());
  if (idle >= _INACTIVITY_MS) { logout(); return; }
  const warnAt = _INACTIVITY_MS - _INACTIVITY_WARN_MS;
  if (idle >= warnAt) _showInactivityWarning(); else _hideInactivityWarning();
  _inactivityTimer = setTimeout(_checkIdle, (idle >= warnAt ? _INACTIVITY_MS : warnAt) - idle);
}

function _noteActivity(e) {
  if (isTabBlocked()) return;
  if (e.type === 'mousemove') {
    // Chrome sends a mousemove with the same position when the page changes under a still mouse (a live queue): that is not a person
    if (_lastMouse && _lastMouse.x === e.screenX && _lastMouse.y === e.screenY) return;
    _lastMouse = { x: e.screenX, y: e.screenY };
  }
  const now = Date.now();
  const warned = !!document.getElementById('ax-inactivity-warning');
  if (!warned && now - _lastActivity < _ACTIVITY_WRITE_MS) return;
  _storeActivity(now);
  if (warned) _checkIdle();
}

function _startInactivityWatch() {
  if (!_storedActivity()) _storeActivity(Date.now());   // the first page after this release, or storage cleared: start the time, do not sign out
  if (!_idleWatching) {
    _idleWatching = true;
    // capture: a scroll inside a panel does not reach document otherwise, and a page's own stopPropagation does not hide activity
    ['click', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach(ev =>
      document.addEventListener(ev, _noteActivity, { passive: true, capture: true })
    );
    window.addEventListener('storage', e => { if (e.key === _ACTIVITY_KEY) _checkIdle(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _checkIdle(); });   // back from sleep
    window.addEventListener('focus', _checkIdle);
  }
  _checkIdle();
}

// ── §250: one sign-in per browser, one user per tab ──────────────────────────────
// Checks the browser's signed-in user against the user this tab was opened as.
// Run on every auth change (also fired for other tabs), on the cross-tab `storage`
// event and whenever the tab comes back to the front.
async function _checkTabUser() {
  const pinned = getTabUser();
  if (!pinned || isTabBlocked()) return;
  const { data: { session }, error } = await supabase.auth.getSession();
  // §433: a refresh that met a network error is no answer, the same rule as requireAuth(): keep the tab, the next check decides
  if (_noAnswer(error)) return;
  if (!session) blockTab('');
  else if (session.user.id !== pinned) blockTab(session.user.email || 'another account');
}

let _tabUserWatching = false;
function _watchTabUser() {
  if (_tabUserWatching) return;
  _tabUserWatching = true;
  onTabBlocked(() => {
    clearTimeout(_inactivityTimer);
    _hideInactivityWarning();
    try { supabase.removeAllChannels(); } catch { /* realtime may not be in use */ }
  });
  supabase.auth.onAuthStateChange(() => { setTimeout(_checkTabUser, 0); }); // never await inside the callback
  window.addEventListener('storage', e => {
    if (e.key === null || (e.key.startsWith('sb-') && e.key.endsWith('-auth-token'))) _checkTabUser();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) _checkTabUser(); });
  window.addEventListener('focus', _checkTabUser);
}

// §424 (owner, 5 Nov 2026): only a definite answer may send someone away. A refusal from the server is one (4xx: refresh token refused, no such
// row, not allowed); a network error, a server error or a timeout is NO answer: never sign the user out or redirect on it.
const _noAnswer = (error, status = error?.status) => !!error && !(status >= 400 && status < 500 && status !== 408 && status !== 429);
// Stop here with the page still hidden: authGate.js shows "taking longer than usual" + Retry / Go to sign-in 8 s after the files load. The promise never
// resolves, so the page's own code does not run. A page without the gate (or if its file failed) is shown rather than left blank.
function _waitForAnswer() {
  if (!window.axAuthGate) document.documentElement.style.visibility = '';
  return new Promise(() => {});
}

// §441 (reproduced, 378b): a 401 from the database means it refused this token, not that this person is signed out. A device clock behind the server's is enough: the browser
// keeps a token the server calls expired, and this used to sign the person out on every device. So a 401 asks the auth server, the one place that can say "signed out": a
// session it refuses to refresh is a definite answer; a new token gets one more try; anything else is no answer (_waitForAnswer), never a sign-out.
async function _readOwnProfile(read) {
  const first = await read();
  if (first.status !== 401) return first;
  const { error } = await supabase.auth.refreshSession();
  if (error) return _noAnswer(error) ? { noAnswer: true } : { signedOut: true };
  const second = await read();
  return second.status === 401 ? { noAnswer: true } : second;
}
function _goToSignIn() {
  sessionStorage.clear();
  window.location.replace('login.html');
  return new Promise(() => {});   // §424: as below
}

export async function requireAuth(allowedRoles = [], redirectTo = 'login.html', { monitoringSafe = false } = {}) {
  // Hide page content immediately — prevents cached page flashing after logout (WASA 5.7)
  document.documentElement.style.visibility = 'hidden';

  _frameGuard();
  _injectSecurityMeta();

  const currentPage = window.location.pathname.split('/').pop();
  if (PUBLIC_PAGES.includes(currentPage) || PUBLIC_PAGES.includes(currentPage + '.html')) {
    document.documentElement.style.visibility = '';
    return;
  }

  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (_noAnswer(sessionError)) return _waitForAnswer();   // e.g. an expired token whose refresh hit a network error: not known to be signed out

  if (!session) {
    sessionStorage.clear();
    window.location.replace(redirectTo);
    // §424: stop here. The promise never resolves, so the page's own code cannot run and overwrite this redirect (dept-admin and fee-admin
    // used to send a signed-out visitor on to the public home, finance / hr / mrd / quality / recruitment to admin.html).
    return new Promise(() => {});
  }

  // §250: this tab was opened as someone else, who has since been replaced in another tab --
  // never switch the page over to the new user silently: block, and stop the page's own code
  // (this promise never resolves, so nothing after `await requireAuth(...)` runs).
  const pinnedUser = getTabUser();
  if (pinnedUser && pinnedUser !== session.user.id) {
    blockTab(session.user.email || 'another account');
    return new Promise(() => {});
  }

  // Check if cached profile belongs to the current session user.
  // On shared computers, a different user's cached data must be evicted.
  const cachedRaw = sessionStorage.getItem(SESSION_KEYS.PROFILE);
  const cachedProfile = cachedRaw ? JSON.parse(cachedRaw) : null;
  const needsFetch = !cachedProfile || cachedProfile.id !== session.user.id;

  if (needsFetch) {
    sessionStorage.clear(); // evict any stale cross-user data
    const read = await _readOwnProfile(() => supabase
      .from('profiles')
      .select('*, tenants(*)')
      .eq('id', session.user.id)
      .single());
    if (read.noAnswer) return _waitForAnswer();
    if (read.signedOut) return _goToSignIn();
    const { data: profile, error: profileError, status: profileStatus } = read;
    if (_noAnswer(profileError, profileStatus)) return _waitForAnswer();

    if (!profile || profile.status !== 'active') {
      await supabase.auth.signOut({ scope: 'global' });
      window.location.replace('login.html');
      return new Promise(() => {});   // §424: as above
    }

    sessionStorage.setItem(SESSION_KEYS.PROFILE,   JSON.stringify(profile));
    sessionStorage.setItem(SESSION_KEYS.TENANT,    JSON.stringify(profile.tenants));
    sessionStorage.setItem(SESSION_KEYS.TENANT_ID, profile.tenant_id);
    sessionStorage.setItem(SESSION_KEYS.ROLE,      profile.role);
    sessionStorage.setItem(SESSION_KEYS.SECONDARY_ROLE, profile.secondary_role || '');
    sessionStorage.setItem(SESSION_KEYS.MONITORING_ACCESS, profile.has_monitoring_access ? '1' : '');
  } else {
    // Session 204 — real, currently-live gap found this session: the cached profile
    // (role/tenant/etc.) only refreshing on a fresh login is an accepted, lower-
    // urgency characteristic elsewhere in this codebase, but whether this account is
    // still ALLOWED to be here at all was never re-verified once a cache existed —
    // an admin blocking/deactivating someone already logged in had zero effect until
    // that session naturally ended (tab close / cache clear), since this entire block
    // was skipped whenever cachedProfile was already present. One lightweight
    // status-only query per page load closes that, without touching the existing
    // once-per-login caching behaviour for everything else.
    const read = await _readOwnProfile(() => supabase
      .from('profiles')
      .select('status')
      .eq('id', session.user.id)
      .single());
    if (read.noAnswer) return _waitForAnswer();
    if (read.signedOut) return _goToSignIn();
    const { data: statusRow, error: statusError, status: statusStatus } = read;
    if (_noAnswer(statusError, statusStatus)) return _waitForAnswer();

    if (!statusRow || statusRow.status !== 'active') {
      sessionStorage.clear();
      await supabase.auth.signOut({ scope: 'global' });
      window.location.replace('login.html');
      return new Promise(() => {});   // §424: as above
    }
  }

  // Session 331: modules come from the server on EVERY protected page load, in every tab -- this block
  // used to skip them when it re-fetched the profile, and hasModule() then treated every module as on.
  await _loadModules();

  // Session 354b: e.g. the yoga instructor opening therapist.html directly -> yoga.html.
  // The promise never resolves, so the page's own code (its data loads) never runs meanwhile.
  if (isPageDeniedForDesignation(getCurrentProfile(), currentPage)) {
    document.documentElement.style.visibility = '';
    window.location.replace(getHomePage(getCurrentProfile()));
    return new Promise(() => {});
  }

  // §432, §435: this replaces the page before it shows, so the doctor sees no frame of it
  if ((currentPage === 'reception.html' && isReceptionClosedForDoctor(getCurrentProfile(), getCurrentTenant()))
      || isPageClosedForDoctor(getCurrentProfile(), getCurrentTenant(), currentPage)) {
    window.location.replace(getHomePage(getCurrentProfile()));
    return new Promise(() => {});
  }

  if (allowedRoles.length > 0) {
    const role = getCurrentRole();
    const secondaryRole = getCurrentSecondaryRole();
    // super_admin can access any protected page. A secondary_role (e.g. a
    // doctor also holding dept_admin for Deputy MS / HOD-type positions) grants
    // the SAME access as if it were the primary role, on top of -- never
    // instead of -- whatever the primary role already allows. monitoringSafe
    // is narrower still: it's set only on pages independently verified to
    // contain zero mutating actions (or whose one write is already RLS-gated
    // to a different role), so a monitoring-access grant can never reach a
    // page that lets it actually change anything (Session 119).
    const hasAccess = role === ROLES.SUPER_ADMIN
      || allowedRoles.includes(role)
      || (secondaryRole && allowedRoles.includes(secondaryRole))
      || (monitoringSafe && getCurrentHasMonitoringAccess());
    if (!hasAccess) {
      window.location.replace(getHomePage(getCurrentProfile()));
      return;
    }
  }

  // MFA enforcement (CERT-In §4.1) for privileged/sensitive roles — checked live
  // against Supabase every load (never cached in sessionStorage, unlike the
  // profile above): a stale cache could either falsely lock someone out right
  // after they enroll, or worse, leave a real gap open after an admin reset.
  // Only queried for the mandatory-role population to avoid the extra Auth-API
  // round trip for every other role's page loads.
  // A secondary_role grant (e.g. Medical Superintendent given dept_admin's
  // HR/Approvals access) extends page access the same as the primary role
  // (see hasAccess above) -- MFA enforcement must extend the same way, or
  // someone with real admin-equivalent access never gets forced to enroll.
  const mfaCheckSecondaryRole = getCurrentSecondaryRole();
  const mfaMandatory = MFA_MANDATORY_ROLES.includes(getCurrentRole())
    || (mfaCheckSecondaryRole && MFA_MANDATORY_ROLES.includes(mfaCheckSecondaryRole));
  if (mfaMandatory && currentPage !== 'account-settings.html') {
    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (_noAnswer(factorsError)) return _waitForAnswer();
    const hasVerifiedFactor = factors?.totp?.some(f => f.status === 'verified');
    if (!hasVerifiedFactor) {
      window.location.replace('account-settings.html?mfa_required=1');
      return;
    }
  }

  setTabUser(session.user.id); // §250: remember who this tab was opened as
  _watchTabUser();
  document.documentElement.style.visibility = ''; // show page — auth confirmed
  _startInactivityWatch(); // auto-logout after 15 min inactivity (warning at 13)
}


// ═══════════════════════════════════════════════════════════
// 8. ROLE HELPERS
// ═══════════════════════════════════════════════════════════

export function hasRole(...roles)    { return roles.includes(getCurrentRole()); }
export function isSuperAdmin()      { return hasRole(ROLES.SUPER_ADMIN); }
export function isDeptAdmin()       { return hasRole(ROLES.DEPT_ADMIN); }
export function isDoctor()          { return hasRole(ROLES.DOCTOR); }
export function isReceptionist()    { return hasRole(ROLES.RECEPTIONIST); }
export function isPharmacist()      { return hasRole(ROLES.PHARMACIST); }
export function isNurse()           { return hasRole(ROLES.NURSE); }
export function isLabTech()         { return hasRole(ROLES.LAB_TECH); }
export function isAccountant()      { return hasRole(ROLES.ACCOUNTANT); }
export function isAdmin()           { return hasRole(ROLES.SUPER_ADMIN, ROLES.DEPT_ADMIN); }