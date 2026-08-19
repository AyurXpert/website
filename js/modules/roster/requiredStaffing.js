import { _computeIpdBedTotals, _combinedIpdNursingSplit, NCISM_XX_ROWS } from '../../config/ncismStaffCompliance.js';
import { OPD_POOLED_NURSE_COUNT, OPD_COVERAGE_GROUPS, OT_NURSE_COUNT, ATYAYIKA_NURSE_COUNT, isNursingDutyDept, shiftsForDept } from '../../config/ncism.js';

// Shared by nursing-roster-template.js and nursing-admin.js -- both need the
// exact same per-department required-headcount numbers so the two pages can
// never disagree.
//
// Real bug found live on SDM (Dr. Venkatesh, 19 recruited nurses but the
// roster demanded ~42 concurrent seats): this used to return a per-SHIFT
// count that every caller then multiplied by the department's shift count
// (3 for a round-the-clock ward) to get a "total". But the bed-derived
// number (bedCount/10) and the OPD/OT intake-tier numbers ARE ALREADY the
// real NCISM Schedule XX TOTAL for that department (verified against
// nursing-admin.js's own compliance ladder, e.g. Schedule XX/32's Medical
// IPD total of 6 for a 100-intake tier exactly equals 60 beds / 10) --
// multiplying by 3 shifts was demanding 3x more nurses than NCISM actually
// requires. Now returns the TOTAL only; distributeAcrossShifts() below
// spreads that total across the department's actual shifts.
//
// Session 150 (MESA&R UG 2026-27 circular): Medical+Surgical IPD nursing is now ONE combined
// ratio (_combinedIpdNursingSplit, ncismStaffCompliance.js) rather than two independent
// 1-per-10-bed pools -- reused here (not reimplemented) so this page's suggested nurse count
// can never drift from the compliance ladder's Required number.
// Exported (Session 179) so realBedSlicing.js's callers (nursing-roster-template.js) can
// resolve the same department-name -> zone-key mapping without a second hand-copied map.
export const BED_DEPT_ZONE = { 'Medical In-Patients': 'IPD_MEDICAL', 'Surgical In-Patients': 'IPD_SURGICAL' };

function _ugTier(ugRaw) {
  return [60, 100, 150, 200].includes(ugRaw) ? ugRaw : (ugRaw >= 150 ? 150 : ugRaw >= 100 ? 100 : ugRaw > 0 ? 60 : 0);
}

// Session 166 Phase 1: real finding from a live capacity audit on SDM -- this function only ever
// covered 3 of the 9 real nursing-duty places (bed-derived + OPD + OT + Atyayika); every other
// place (Panchakarma/Labour Room/Screening OPD/Diagnostics) fell through to null, and every
// CALLER of computeRequiredPerShift() independently defaulted a null result to a naive "1 per
// shift" guess -- which happened to be numerically correct for 3 of those 4 places by pure
// coincidence, and silently WRONG for the 4th: Diagnostics had a real Sch XX nursing line before
// the 2026-27 MESA&R circular, but Session 150 confirmed it was removed outright (no line in the
// new schedule) -- the roster has been demanding a phantom nurse there ever since, contributing a
// real (if small) false gap to every compliance count and capacity calculation built on this data.
//
// Fixed properly: looked up directly from NCISM_XX_ROWS (the canonical Schedule XX table) by its
// real schedule reference, not hand-copied into a second table here -- if a future circular
// changes these numbers again, this stays correct automatically instead of silently drifting the
// way the old "1 per shift" guess did. Diagnostics gets an explicit `{mode:'none', total:0}` --
// distinct from "no data, guess 1" -- so a confirmed real zero can never be mistaken for an unknown.
const SCHEDULE_REF_BY_DEPT = { 'Panchakarma': 'Sch XX/32', 'Labour Room': 'Sch XX/38', 'Screening OPD': 'Sch XVI §40(m)' };
function _reqFromScheduleRef(deptName, ugTier) {
  const ref = SCHEDULE_REF_BY_DEPT[deptName];
  if (!ref) return null;
  const row = NCISM_XX_ROWS.find(r => r[0] === deptName && r[4] === ref);
  return row ? (row[3]?.[ugTier] ?? null) : null;
}

export async function computeRequiredPerShift(supabase, tenantId, deptName) {
  const zone = BED_DEPT_ZONE[deptName];
  if (zone) {
    const [{ data: allDepts }, { data: beds }] = await Promise.all([
      supabase.from('departments').select('id,ncism_code').eq('tenant_id', tenantId).eq('is_active', true),
      supabase.from('beds').select('department_id').eq('tenant_id', tenantId),
    ]);
    const bedTotals = _computeIpdBedTotals(allDepts || [], beds || []);
    const bedCount = bedTotals[zone] || 0;
    const total = _combinedIpdNursingSplit(bedTotals)[zone] || 0;
    return total > 0 ? { mode: 'bed', bedCount, total } : null;
  }
  if (deptName === 'OPD') {
    const { data: tenantRow } = await supabase.from('tenants').select('ug_intake').eq('id', tenantId).single();
    const total = OPD_POOLED_NURSE_COUNT[_ugTier(tenantRow?.ug_intake)] || 0;
    return total > 0 ? { mode: 'opd', total, groups: OPD_COVERAGE_GROUPS } : null;
  }
  if (deptName === 'Operation Theatre (Major + Minor + CSSD)') {
    const { data: tenantRow } = await supabase.from('tenants').select('ug_intake').eq('id', tenantId).single();
    const total = OT_NURSE_COUNT[_ugTier(tenantRow?.ug_intake)] || 0;
    return total > 0 ? { mode: 'ot', total } : null;
  }
  // Session 152 (TODO_LATER §53 piece 3) -- Sch XX/18, same intake-tier-table pattern as OT above.
  if (deptName === 'Atyayika / Emergency') {
    const { data: tenantRow } = await supabase.from('tenants').select('ug_intake').eq('id', tenantId).single();
    const total = ATYAYIKA_NURSE_COUNT[_ugTier(tenantRow?.ug_intake)] || 0;
    return total > 0 ? { mode: 'atyayika', total } : null;
  }
  // Diagnostics: confirmed zero -- see the comment on SCHEDULE_REF_BY_DEPT above. Explicit, not
  // just "falls through to null", so callers never guess 1 here.
  if (deptName === 'Diagnostics') return { mode: 'none', total: 0 };
  if (SCHEDULE_REF_BY_DEPT[deptName]) {
    const { data: tenantRow } = await supabase.from('tenants').select('ug_intake').eq('id', tenantId).single();
    const total = _reqFromScheduleRef(deptName, _ugTier(tenantRow?.ug_intake));
    return total != null ? { mode: 'schedule', total } : null;
  }
  return null;
}

// Spreads a department's real required TOTAL across its actual shifts as
// evenly as possible (front-loads the remainder onto the earlier shifts, in
// shiftsForDept()'s own order -- arbitrary but deterministic). A single-
// shift department (OPD's 'general') trivially gets the whole total.
export function distributeAcrossShifts(total, shifts) {
  const n = shifts.length;
  const base = Math.floor(total / n);
  const remainder = total % n;
  const result = {};
  shifts.forEach((s, i) => { result[s] = base + (i < remainder ? 1 : 0); });
  return result;
}

// Session 166 Phase 2: the flat {department_id, shift_type, required} array preview_nursing_week()/
// commit_nursing_week() (the weekly solver RPCs) take as input -- built here, once, so every
// caller (the new Generate Week page, and roster.js's own gap-detection banner if it's ever
// refactored to share this instead of its own parallel loop) computes the exact same matrix from
// the exact same real NCISM-formula numbers, never a second hand-built copy.
export async function buildRequiredMatrix(supabase, tenantId) {
  const { data: depts } = await supabase.from('departments')
    .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true);
  const nursingDepts = (depts || []).filter(isNursingDutyDept);

  const rows = [];
  for (const dept of nursingDepts) {
    const shifts = shiftsForDept(dept);
    const info = await computeRequiredPerShift(supabase, tenantId, dept.name);
    const byShift = (info?.total != null) ? distributeAcrossShifts(info.total, shifts) : Object.fromEntries(shifts.map(s => [s, 1]));
    shifts.forEach(s => rows.push({ department_id: dept.id, shift_type: s, required: byShift[s] || 0 }));
  }
  return rows;
}
