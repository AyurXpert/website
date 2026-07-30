// Roll Forward (roll_nursing_roster_template()) is entirely manual -- no
// cron/scheduled job generates the next cycle's real dates automatically.
// This computes, per nursing-duty department, how many days remain before
// the last already-generated duty_roster shift_date runs out, so
// nursing-admin.html/nursing-roster-template.html can warn before a
// department silently has zero scheduled shifts.
const WARNING_DAYS = 3;

export async function checkCycleExpiry(supabase, depts) {
  const deptIds = depts.map(d => d.id);
  if (!deptIds.length) return [];

  const { data } = await supabase.rpc('get_department_roster_expiry', { p_department_ids: deptIds });
  const maxByDept = new Map((data || []).map(r => [r.department_id, r.max_shift_date]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return depts.map(d => {
    const lastDate = maxByDept.get(d.id) || null;
    if (!lastDate) return { deptId: d.id, deptName: d.name, lastDate: null, daysLeft: null, status: 'none' };
    const last = new Date(lastDate);
    const daysLeft = Math.round((last - today) / 86400000);
    const status = daysLeft < 0 ? 'expired' : daysLeft <= WARNING_DAYS ? 'expiring' : 'ok';
    return { deptId: d.id, deptName: d.name, lastDate, daysLeft, status };
  });
}
