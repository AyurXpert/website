// Roll Forward (roll_nursing_roster_template()) is entirely manual -- no
// cron/scheduled job generates the next cycle's real dates automatically.
// This computes, per nursing-duty department, how many days remain before
// the last already-generated duty_roster shift_date runs out, so
// nursing-admin.html/nursing-roster-template.html can warn before a
// department silently has zero scheduled shifts.
const WARNING_DAYS = 3;
const CYCLE_DAYS = { weekly: 7, fortnightly: 14, monthly: 30 };

// Session 149: also flags a department whose built template is still on an
// older cycle length than the tenant's currently-approved setting -- the
// queued transition adopts automatically the next time Generate Next Cycle
// runs for that department (roll_nursing_roster_template(), same session),
// so this is purely informational ("heads up, this is about to change"),
// not something requiring manual action. Shared here so nursing-admin.html
// and nursing-roster-template.html's banners can never disagree about it.
export async function checkCycleExpiry(supabase, tenantId, depts) {
  const deptIds = depts.map(d => d.id);
  if (!deptIds.length) return [];

  const [{ data }, { data: templates }, { data: setting }] = await Promise.all([
    supabase.rpc('get_department_roster_expiry', { p_department_ids: deptIds }),
    supabase.from('nursing_roster_templates').select('department_id,cycle_length').eq('tenant_id', tenantId).in('department_id', deptIds),
    supabase.from('nursing_roster_settings').select('cycle').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  const maxByDept = new Map((data || []).map(r => [r.department_id, r.max_shift_date]));
  const cycleLenByDept = new Map((templates || []).map(t => [t.department_id, t.cycle_length]));
  const tenantDays = CYCLE_DAYS[setting?.cycle || 'weekly'];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return depts.map(d => {
    const lastDate = maxByDept.get(d.id) || null;
    const cycleLength = cycleLenByDept.get(d.id) ?? null;
    const willTransition = cycleLength != null && cycleLength !== tenantDays;
    if (!lastDate) return { deptId: d.id, deptName: d.name, lastDate: null, daysLeft: null, status: 'none', willTransition, tenantDays, cycleLength };
    const last = new Date(lastDate);
    const daysLeft = Math.round((last - today) / 86400000);
    const status = daysLeft < 0 ? 'expired' : daysLeft <= WARNING_DAYS ? 'expiring' : 'ok';
    return { deptId: d.id, deptName: d.name, lastDate, daysLeft, status, willTransition, tenantDays, cycleLength };
  });
}
