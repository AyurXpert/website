// Session 159: shared "uncovered absence" check -- shared by roster.js's
// On-Ground Duty Monitor (inline row status) and nursing-admin.js (live
// banner) so the two pages can never disagree on what still needs a human's
// attention, same pattern as requiredStaffing.js/cycleExpiry.js.
//
// mark_duty_attendance() (sql/session159_absence_auto_coverage.sql) already
// tries to auto-fill an absence from the relief pool at the moment it's
// marked -- this only needs to find whatever it couldn't fill, for a given
// date, across a given set of departments.

// Returns [{ id, department_id, department_name, shift_type, profile_name }]
// for every shift marked 'absent' on dateStr, scoped to deptIds, that has NO
// covering row pointing back to it (duty_roster.covering_for_id).
export async function findUncoveredAbsences(supabase, tenantId, deptIds, dateStr) {
  if (!deptIds?.length) return [];

  const { data: absent } = await supabase.from('duty_roster')
    .select('id,department_id,shift_type,departments(name),profiles!duty_roster_profile_id_fkey(full_name)')
    .eq('tenant_id', tenantId).eq('shift_date', dateStr)
    .eq('attendance_status', 'absent').in('department_id', deptIds);
  if (!absent?.length) return [];

  const ids = absent.map(r => r.id);
  const { data: covering } = await supabase.from('duty_roster')
    .select('covering_for_id').eq('tenant_id', tenantId).in('covering_for_id', ids);
  const coveredSet = new Set((covering || []).map(r => r.covering_for_id));

  return absent
    .filter(r => !coveredSet.has(r.id))
    .map(r => ({
      id: r.id, department_id: r.department_id,
      department_name: r.departments?.name || '—',
      shift_type: r.shift_type,
      profile_name: r.profiles?.full_name || '—',
    }));
}
