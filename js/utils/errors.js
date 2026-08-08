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

  return fallback;
}
