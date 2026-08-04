import { _computeIpdBedTotals, _combinedIpdNursingSplit } from '../../config/ncismStaffCompliance.js';
import { OPD_POOLED_NURSE_COUNT, OPD_COVERAGE_GROUPS, OT_NURSE_COUNT } from '../../config/ncism.js';

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
const BED_DEPT_ZONE = { 'Medical In-Patients': 'IPD_MEDICAL', 'Surgical In-Patients': 'IPD_SURGICAL' };

function _ugTier(ugRaw) {
  return [60, 100, 150, 200].includes(ugRaw) ? ugRaw : (ugRaw >= 150 ? 150 : ugRaw >= 100 ? 100 : ugRaw > 0 ? 60 : 0);
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
