// Session 351 (TODO §233, owner 19 Oct 2026): Relieve / Reactivate / Block / Unblock / Suspend / On Leave.
// The browser's DISPLAY copy of the server rule public._staff_action_refusal (sql/session351_relieve_and_staff_status.sql): it only
// decides which buttons a viewer sees -- the server decides every action (the set-staff-status Edge Function calls the RPC with the
// viewer's own token). scripts/check-351-staff-actions.mjs compares the lists with the SQL.
import { isPowerfulPosition } from '../config/designations.js';
import { SUPABASE_URL } from '../config/constants.js';

// the reason types a Relieve requires (stored as the key; "Terminated" appears only for the disciplinary type)
export const RELIEVE_REASON_TYPES = [
  { v: 'resigned',                l: 'Resigned' },
  { v: 'retired',                 l: 'Retired' },
  { v: 'transferred',             l: 'Transferred' },
  { v: 'contract_ended',          l: 'Contract ended' },
  { v: 'deceased',                l: 'Deceased' },
  { v: 'absconding',              l: 'Absconding' },
  { v: 'terminated_disciplinary', l: 'Terminated (disciplinary)' },
];
const REASON_LABEL = Object.fromEntries(RELIEVE_REASON_TYPES.map(r => [r.v, r.l]));

// who may act: an ACTIVE super_admin, Medical Director or Medical Superintendent
export const DECIDER_DESIGS = ['medical_director', 'medical_superintendent'];
// a target that is not a pending / rejected signup
export const ACTIONABLE_STATUSES = ['active', 'inactive', 'suspended', 'on_leave', 'blocked'];

const norm = v => String(v ?? '').trim().toLowerCase();

export function isStaffActionDecider(me) {
  if (!me || me.is_platform_admin) return false;
  if (me.status !== 'active' || me.is_active !== true || me.terminated_at) return false;
  return me.role === 'super_admin' || DECIDER_DESIGS.includes(norm(me.designation));
}

// an admin, a powerful position (THE single list) or a department-scoped account: the super_admin only
export function isSuperOnlyTarget(t) {
  return !t || !t.role || t.role === 'super_admin' || t.role === 'dept_admin' || t.secondary_role === 'dept_admin'
    || isPowerfulPosition(t.role, t.designation) || !!t.scope_department_id;
}

// may `me` relieve / reactivate / change the status of `t` (display only)
export function canActOnStaff(me, t) {
  if (!isStaffActionDecider(me) || !t || !t.id || t.id === me.id) return false;
  if (t.is_platform_admin || t.role === 'platform_admin') return false;
  if (!ACTIONABLE_STATUSES.includes(t.status)) return false;
  return me.role === 'super_admin' || !isSuperOnlyTarget(t);
}

// the label on the Relieved Staff tab
export function relievedLabel(reasonType) {
  if (!reasonType) return 'Relieved – reason not recorded';
  if (reasonType === 'terminated_disciplinary') return 'Terminated (disciplinary)';
  return 'Relieved – ' + (REASON_LABEL[reasonType] || reasonType);
}

// the set-staff-status Edge Function (v4): { targetUserId, action: 'relieve' | 'reactivate', ... } or { targetUserId, newStatus }.
// Returns { success: true } or { error: <the server's plain message> }.
export async function callStaffStatus(supabase, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not signed in.' };
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/set-staff-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: 'Could not reach the server. Check the connection and try again.' };
  }
  let result = {};
  try { result = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) return { error: result.error || 'The change could not be saved. Please try again.' };
  return { success: true };
}
