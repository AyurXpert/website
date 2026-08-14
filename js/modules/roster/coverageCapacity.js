// Session 166: whole-organisation nursing Coverage Capacity -- the honest "Required vs Available
// vs Structural deficit" picture, computed fresh from real live data (never a cached/manual
// number) so it answers "if we recruit one more nurse, does the gap shrink automatically" with
// a live yes: the Available side is a plain COUNT of active eligible staff, re-queried on every
// call, so a newly-recruited (or terminated) nurse is reflected the moment their profile changes
// -- no separate "register them for rostering" step needed.
//
// Required side reuses computeRequiredPerShift() (requiredStaffing.js) -- the same real
// NCISM-Schedule-XX-backed numbers the gap-detection banner and template editor already trust --
// summed across every real nursing-duty department, so this can never disagree with them.
//
// Available side assumes each person works 6 of 7 days (1 mandatory weekly off) -- the same
// assumption the whole weekly-off feature is built on. Includes the OT/CSSD/Anushastra
// designation group alongside staff_nurse/ward_sister/anm -- corrected in Session 169 (Dr.
// Venkatesh caught this live on SDM, comparing this card's headcount against the real HR
// ladder): this file originally excluded them on the theory that they "do genuinely separate
// work, not covering these 9 places' shifts", but that was stale the moment it was written --
// Session 166f had already moved 2 real OT Technicians into OT's own duty_roster slots the
// same session, and 166g formally widened preview_nursing_week()'s SQL relief pool to include
// exactly this same designation set (ot_technician/cssd_incharge/cssd_aya/anushastra_technician,
// deliberately NOT ot_attendant) as real roster-covering staff. Keep this list in sync with
// that SQL pool (sql/session166g_widen_relief_pool_ot_cssd_anushastra.sql) if it's ever revised.
import { isNursingDutyDept, shiftsForDept } from '../../config/ncism.js';
import { computeRequiredPerShift } from './requiredStaffing.js';

export const NURSING_ELIGIBLE_DESIGNATIONS = [
  'staff_nurse', 'ward_sister', 'anm',
  'ot_technician', 'cssd_incharge', 'cssd_aya', 'anushastra_technician',
];

export async function computeCoverageCapacity(supabase, tenantId) {
  const { data: depts } = await supabase.from('departments')
    .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true);
  const nursingDepts = (depts || []).filter(isNursingDutyDept);

  let requiredPerDay = 0;
  for (const dept of nursingDepts) {
    const info = await computeRequiredPerShift(supabase, tenantId, dept.name);
    // Defensive fallback only -- every currently-known nursing-duty place already has a real
    // formula (Session 166 Phase 1), this only matters if a brand-new place is ever added before
    // its own Schedule XX number is wired in.
    requiredPerDay += info?.total ?? shiftsForDept(dept).length;
  }

  const { count } = await supabase.from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('is_active', true)
    .in('designation', NURSING_ELIGIBLE_DESIGNATIONS);
  const availableHeadcount = count || 0;

  const requiredPerWeek = requiredPerDay * 7;
  const availablePerWeek = availableHeadcount * 6;
  const availablePerDay = Math.round(availablePerWeek / 7);
  const deficitPerDay = requiredPerDay - availablePerDay;
  const deficitPerWeek = requiredPerWeek - availablePerWeek;

  return {
    departmentCount: nursingDepts.length,
    requiredPerDay, requiredPerWeek,
    availableHeadcount, availablePerDay, availablePerWeek,
    deficitPerDay, deficitPerWeek,
  };
}

function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function renderCoverageCapacityHtml(data) {
  const {
    departmentCount, requiredPerDay, requiredPerWeek,
    availableHeadcount, availablePerDay, availablePerWeek,
    deficitPerDay, deficitPerWeek,
  } = data;

  const state = deficitPerDay > 0 ? 'deficit' : (deficitPerDay < 0 ? 'surplus' : 'balanced');
  const rowLabel = state === 'deficit' ? 'Structural deficit' : (state === 'surplus' ? 'Structural surplus' : 'Exactly balanced');
  const color = state === 'deficit' ? '#c0392b' : (state === 'surplus' ? '#1a4a2e' : 'var(--text-mid)');
  const dayText = deficitPerDay === 0 ? '0'
    : `~${Math.abs(deficitPerDay)} nurse${Math.abs(deficitPerDay) === 1 ? '' : 's'}/day`;
  const weekText = deficitPerWeek === 0 ? '0'
    : `${Math.abs(deficitPerWeek)} nurse-shifts/week`;

  return `
  <table class="cap-table">
    <thead><tr><th></th><th>Per day</th><th>Per week</th></tr></thead>
    <tbody>
      <tr>
        <td>Required<div class="cap-sub">Sum of every real NCISM shift across all ${departmentCount} nursing-duty places</div></td>
        <td>${requiredPerDay} nurse${requiredPerDay === 1 ? '' : 's'} on duty</td>
        <td>${requiredPerWeek} nurse-shifts</td>
      </tr>
      <tr>
        <td>Available<div class="cap-sub">${availableHeadcount} nurse${availableHeadcount === 1 ? '' : 's'} × 6 working days, 1 fixed day off each</div></td>
        <td>~${availablePerDay} nurse${availablePerDay === 1 ? '' : 's'} free</td>
        <td>${availablePerWeek} nurse-shifts</td>
      </tr>
      <tr class="cap-deficit-row">
        <td style="color:${color};font-weight:700">${_esc(rowLabel)}</td>
        <td style="color:${color};font-weight:700">${dayText}</td>
        <td style="color:${color};font-weight:700">${weekText}</td>
      </tr>
    </tbody>
  </table>`;
}

// Session 135's confirmed-live pattern: ONE channel per TABLE, never several different tables'
// postgres_changes filters bundled onto one channel -- Supabase Realtime on this project silently
// drops delivery when they're combined (found + fixed in admin.js, same fix reused here rather
// than risking a live channel that "subscribes ok" but never actually delivers an event).
export function subscribeCoverageCapacity(supabase, tenantId, onChange) {
  let debounce = null;
  const trigger = () => { clearTimeout(debounce); debounce = setTimeout(onChange, 600); };
  supabase.channel('coverage-capacity-profiles')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `tenant_id=eq.${tenantId}` }, trigger)
    .subscribe();
  supabase.channel('coverage-capacity-beds')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'beds', filter: `tenant_id=eq.${tenantId}` }, trigger)
    .subscribe();
  supabase.channel('coverage-capacity-departments')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'departments', filter: `tenant_id=eq.${tenantId}` }, trigger)
    .subscribe();
}
