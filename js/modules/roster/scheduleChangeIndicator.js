// Session 167: "Your schedule changed" indicator for plain nurse logins. Dr. Venkatesh's
// explicit ask -- lightweight, purely additive, no gate on publish. duty_roster.created_at
// (default now()) already gets refreshed on every real publish (commit_nursing_week() always
// DELETEs+re-INSERTs the target week -- see sql/session167_nurse_roster_seen_tracking.sql for
// the full reasoning and the one known limitation: a manual in-place edit via roster.js's modal
// does an UPDATE, not an INSERT, so it won't trip this check).

// Reads profiles.roster_last_seen_at fresh from the DB rather than the cached sessionStorage
// profile object set at login -- that cache only refreshes on a fresh login, so trusting it here
// would keep showing a stale "new shifts" banner even right after the nurse already viewed and
// cleared it earlier in the same session (e.g. nursing.html -> roster.html -> back to
// nursing.html without re-logging in).
export async function checkRosterChanged(supabase, tenantId, profileId) {
  const { data: prof, error: profErr } = await supabase.from('profiles').select('roster_last_seen_at').eq('id', profileId).maybeSingle();
  // Real bug found live (Session 167, Dr. Venkatesh testing as nursingip1@sdm.com): neither
  // query here originally checked its own `error` -- a genuinely failed request (RLS, network,
  // a stale/unauthenticated client) silently resolved to count=0/changed=false with zero trace
  // anywhere, indistinguishable from "nothing changed". Both errors are now surfaced.
  if (profErr) { console.error('[checkRosterChanged] profiles read failed:', profErr); return { changed: false, count: 0 }; }
  const lastSeen = prof?.roster_last_seen_at || '1970-01-01T00:00:00Z';
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Scoped to shift_date >= today deliberately -- a row's created_at can be recent even for a
  // shift that already happened (e.g. she hasn't logged in for 2 weeks), and there's nothing
  // actionable about being told a past shift was "new". Only upcoming/current shifts count.
  const { count, error: rosterErr } = await supabase.from('duty_roster')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('profile_id', profileId)
    .gte('shift_date', todayStr)
    .gt('created_at', lastSeen);
  if (rosterErr) { console.error('[checkRosterChanged] duty_roster read failed:', rosterErr); return { changed: false, count: 0 }; }
  return { changed: (count || 0) > 0, count: count || 0 };
}

// Marks the nurse's roster as "seen" right now. Called by roster.js whenever a plain `nurse`
// viewer's Weekly Schedule tab loads -- regardless of entry point (banner click, navbar link,
// direct URL) -- so the indicator can never disagree with "did she actually look." Reuses the
// existing self-row profiles UPDATE RLS (id = auth.uid()) -- no new RPC, no new grant.
export async function markRosterSeen(supabase, profileId) {
  const { error } = await supabase.from('profiles').update({ roster_last_seen_at: new Date().toISOString() }).eq('id', profileId);
  if (error) console.error('[markRosterSeen] update failed:', error); // silent failure here means the banner would keep reappearing every login -- worth being able to see why
}
