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
} from '../config/constants.js';
import { logAudit } from './auditLogger.js';


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
    if (authError) throw authError;

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
    if (tenantError) throw tenantError;

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
    if (profileError) throw profileError;

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
  role, tenantCode, hprId = null, stateRegId = null, departmentId = null
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
    if (authError) throw authError;

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
      });
    if (profileError) throw profileError;

    return {
      success: true,
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

    sessionStorage.setItem(SESSION_KEYS.USER,      JSON.stringify(data.user));
    sessionStorage.setItem(SESSION_KEYS.PROFILE,   JSON.stringify(profile));
    sessionStorage.setItem(SESSION_KEYS.TENANT,    JSON.stringify(profile.tenants));
    sessionStorage.setItem(SESSION_KEYS.TENANT_ID, profile.tenant_id);
    sessionStorage.setItem(SESSION_KEYS.ROLE,      profile.role);

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

    return { success: true };

  } catch (error) {
    console.error('login error:', error);
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

  if (error) return { success: false, error: error.message };
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

  if (error) return { success: false, error: error.message };
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
    if (permError) throw permError;

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ status: 'active', is_active: true })
      .eq('id', profileId)
      .eq('tenant_id', getCurrentTenantId());
    if (profileError) throw profileError;

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

  if (error) return { success: false, error: error.message };
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

// 30-minute inactivity auto-logout
let _inactivityTimer = null;
const _INACTIVITY_MS = 30 * 60 * 1000;

function _resetInactivity() {
  clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(() => logout(), _INACTIVITY_MS);
}

function _startInactivityWatch() {
  ['click', 'keydown', 'touchstart', 'scroll'].forEach(ev =>
    document.addEventListener(ev, _resetInactivity, { passive: true })
  );
  _resetInactivity();
}

export async function requireAuth(allowedRoles = [], redirectTo = 'login.html') {
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
  }

  if (allowedRoles.length > 0) {
    const role = getCurrentRole();
    // super_admin can access any protected page
    if (role !== ROLES.SUPER_ADMIN && !allowedRoles.includes(role)) {
      window.location.replace(ROLE_HOME[role] || 'admin.html');
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