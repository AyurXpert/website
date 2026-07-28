// Session 137 (Nursing Roster Phase 1): resolves who currently holds "Nursing
// Head" -- the single editor allowed to write nursing duty rosters. Default
// = whoever holds the nursing_superintendent designation; an explicit
// delegate (tenants.nursing_head_delegate_id, set via the
// update_nursing_head_delegate RPC -- direct .update() is blocked by
// tenants' RLS, which restricts UPDATE to role='super_admin') overrides that
// default until reset. Shared between nursing-admin.js (the delegate/reset
// UI) and roster.js (write-access gating), so the two pages can never
// silently disagree on who's currently authorised to edit.
export async function resolveNursingHeadship(supabase, tenantId) {
  const [{ data: tenant }, { data: candidates }] = await Promise.all([
    supabase.from('tenants').select('nursing_head_delegate_id').eq('id', tenantId).single(),
    supabase.from('profiles').select('id,full_name,designation').eq('tenant_id', tenantId).eq('is_active', true)
      .in('designation', ['nursing_superintendent', 'deputy_nursing_superintendent']).order('full_name'),
  ]);
  const all = candidates || [];
  const defaultHead = all.find(c => c.designation === 'nursing_superintendent') || null;
  const delegateId = tenant?.nursing_head_delegate_id || null;
  const delegate = delegateId ? (all.find(c => c.id === delegateId) || null) : null;
  const effectiveHead = delegate || defaultHead;
  return { defaultHead, delegate, effectiveHead, candidates: all };
}

// Whether `profileId` (with `role`/`designation`) is allowed to change or use
// the current nursing-head edit authority -- the resolved effective head
// themselves, MD/Principal/MS, or super_admin.
export function canActAsNursingHead(headship, profileId, role, designation) {
  return role === 'super_admin'
    || ['medical_director','principal','medical_superintendent'].includes(designation)
    || headship.effectiveHead?.id === profileId;
}

// Session 140 (Nursing Duty Roster Phase 4): deliberately NARROWER than
// canActAsNursingHead() above -- individual shift-change requests are an
// internal nursing operational matter, explicitly NOT escalated to MD/
// Principal/MS the way template edits and headship delegation are (per the
// original Phase 3 design note: "shift-swap notifications go to the head
// only, not MS/DMS"). Only the resolved effective head themselves, or
// super_admin, can decide -- mirrors the server-side
// _nursing_head_only_ok() RPC exactly.
export function canDecideShiftChange(headship, profileId, role) {
  return role === 'super_admin' || headship.effectiveHead?.id === profileId;
}
