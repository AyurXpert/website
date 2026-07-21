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
  DEFAULT_MODULES,
  MFA_MANDATORY_ROLES,
} from '../config/constants.js';
import { logAudit } from './auditLogger.js';
import { safeErrorMessage } from '../utils/errors.js';


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

    const { data: tenant, error: tenantError } = await supabase
      .from('tenants')
      .insert({
        name:      tenantName,
        type:      tenantType,
        city,
        state,
        phone,
        email,
        is_active: true,
      })
      .select()
      .single();
    if (tenantError) throw new Error(safeErrorMessage(tenantError, 'Could not create organisation. Please try again.'));

    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id:        userId,
        tenant_id: tenant.id,
        role:      ROLES.SUPER_ADMIN,
        full_name: fullName,
        phone,
        status:    'active',
        is_active: true,
      });
    if (profileError) throw new Error(safeErrorMessage(profileError, 'Could not create profile. Please try again.'));

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
  fullName, email, password, phone,
  role, tenantCode, hprId = null, stateRegId = null, departmentId = null, designation = null, secondaryRole = null,
  hasMonitoringAccess = false, scopeDepartmentId = null
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

    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id:        authData.user.id,
        tenant_id: tenant.id,
        role,
        full_name: fullName,
        phone,
        status:    'pending_approval',
        is_active: false,
        ...(hprId        ? { hpr_id:         hprId        } : {}),
        ...(stateRegId   ? { state_reg_id:   stateRegId   } : {}),
        ...(departmentId ? { department_id:  departmentId } : {}),
        ...(designation  ? { designation:    designation  } : {}),
        ...(secondaryRole ? { secondary_role: secondaryRole } : {}),
        ...(hasMonitoringAccess ? { has_monitoring_access: true } : {}),
        ...(scopeDepartmentId ? { scope_department_id: scopeDepartmentId } : {}),
      });
    if (profileError) throw new Error(safeErrorMessage(profileError, 'Could not create profile. Please try again.'));

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

  // §7h — compute effective modules: type defaults merged with tenant overrides
  const _defMods = DEFAULT_MODULES[profile.tenants?.type] || {};
  const _tenMods = profile.tenants?.modules || {};
  sessionStorage.setItem(SESSION_KEYS.MODULES, JSON.stringify({ ..._defMods, ..._tenMods }));

  await logAudit('login', 'profiles', profile.id,
    { role: profile.role, tenant: profile.tenants?.name },
    { tenantId: profile.tenant_id, userId: profile.id, userName: profile.full_name }
  );

  const destination = ROLE_HOME[profile.role] || 'admin.html';
  window.location.href = destination;
}

export async function login({ email, password }) {
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

    if (profile.status === 'pending_approval') {
      await supabase.auth.signOut({ scope: 'global' });
      throw new Error('Your account is pending approval. Please wait for your administrator to activate it.');
    }
    if (profile.status === 'approved') {
      await supabase.auth.signOut({ scope: 'global' });
      throw new Error('Your account is approved but department access has not been assigned yet. Please wait.');
    }
    if (profile.status === 'rejected') {
      await supabase.auth.signOut({ scope: 'global' });
      throw new Error('Your account request was not approved. Please contact your administrator.');
    }
    if (profile.status === 'suspended') {
      await supabase.auth.signOut({ scope: 'global' });
      throw new Error('Your account has been suspended. Please contact your administrator.');
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


// ═══════════════════════════════════════════════════════════
// 4. LOGOUT
// ═══════════════════════════════════════════════════════════

export async function logout() {
  clearTimeout(_inactivityTimer);
  await supabase.auth.signOut({ scope: 'global' }); // invalidate ALL sessions on all devices
  sessionStorage.clear();
  window.location.replace('login.html'); // replace prevents back-button returning to protected page
}


// ═══════════════════════════════════════════════════════════
// 5. APPROVAL WORKFLOW
// ═══════════════════════════════════════════════════════════

export async function getPendingApprovals() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, phone, created_at')
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

// §7h — returns true if module is enabled for this tenant.
// Defaults to true when no modules are stored (backwards-compatible).
export function hasModule(key) {
  const raw = sessionStorage.getItem(SESSION_KEYS.MODULES);
  if (!raw) return true;
  const mods = JSON.parse(raw);
  return mods[key] !== false;
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
let _inactivityTimer = null;
let _inactivityWarnTimer = null;
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
  banner.textContent = '⚠️ You will be logged out in 2 minutes due to inactivity. Click or type anywhere on this page to stay logged in.';
  document.body.appendChild(banner);
}

function _hideInactivityWarning() {
  document.getElementById('ax-inactivity-warning')?.remove();
}

function _resetInactivity() {
  clearTimeout(_inactivityTimer);
  clearTimeout(_inactivityWarnTimer);
  _hideInactivityWarning();
  _inactivityWarnTimer = setTimeout(_showInactivityWarning, _INACTIVITY_MS - _INACTIVITY_WARN_MS);
  _inactivityTimer = setTimeout(() => logout(), _INACTIVITY_MS);
}

function _startInactivityWatch() {
  ['click', 'keydown', 'touchstart', 'scroll'].forEach(ev =>
    document.addEventListener(ev, _resetInactivity, { passive: true })
  );
  _resetInactivity();
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

  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    sessionStorage.clear();
    window.location.replace(redirectTo);
    return;
  }

  // Check if cached profile belongs to the current session user.
  // On shared computers, a different user's cached data must be evicted.
  const cachedRaw = sessionStorage.getItem(SESSION_KEYS.PROFILE);
  const cachedProfile = cachedRaw ? JSON.parse(cachedRaw) : null;
  const needsFetch = !cachedProfile || cachedProfile.id !== session.user.id;

  if (needsFetch) {
    sessionStorage.clear(); // evict any stale cross-user data
    const { data: profile } = await supabase
      .from('profiles')
      .select('*, tenants(*)')
      .eq('id', session.user.id)
      .single();

    if (!profile || profile.status !== 'active') {
      await supabase.auth.signOut({ scope: 'global' });
      window.location.replace('login.html');
      return;
    }

    sessionStorage.setItem(SESSION_KEYS.PROFILE,   JSON.stringify(profile));
    sessionStorage.setItem(SESSION_KEYS.TENANT,    JSON.stringify(profile.tenants));
    sessionStorage.setItem(SESSION_KEYS.TENANT_ID, profile.tenant_id);
    sessionStorage.setItem(SESSION_KEYS.ROLE,      profile.role);
    sessionStorage.setItem(SESSION_KEYS.SECONDARY_ROLE, profile.secondary_role || '');
    sessionStorage.setItem(SESSION_KEYS.MONITORING_ACCESS, profile.has_monitoring_access ? '1' : '');
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
      window.location.replace(ROLE_HOME[role] || 'admin.html');
      return;
    }
  }

  // MFA enforcement (CERT-In §4.1) for privileged/sensitive roles — checked live
  // against Supabase every load (never cached in sessionStorage, unlike the
  // profile above): a stale cache could either falsely lock someone out right
  // after they enroll, or worse, leave a real gap open after an admin reset.
  // Only queried for the mandatory-role population to avoid the extra Auth-API
  // round trip for every other role's page loads.
  if (MFA_MANDATORY_ROLES.includes(getCurrentRole()) && currentPage !== 'account-settings.html') {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const hasVerifiedFactor = factors?.totp?.some(f => f.status === 'verified');
    if (!hasVerifiedFactor) {
      window.location.replace('account-settings.html?mfa_required=1');
      return;
    }
  }

  document.documentElement.style.visibility = ''; // show page — auth confirmed
  _startInactivityWatch(); // auto-logout after 30 min inactivity
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