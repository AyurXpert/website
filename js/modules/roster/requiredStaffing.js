import { _computeIpdBedTotals } from '../../config/ncismStaffCompliance.js';
import { OPD_POOLED_NURSE_COUNT, OPD_COVERAGE_GROUPS } from '../../config/ncism.js';

// Shared by nursing-roster-template.js and nursing-admin.js (Session 144's
// department rotation preview needs the exact same per-department required-
// headcount numbers the template editor already computes, so this was
// extracted out rather than duplicated) -- two different sources depending
// on the department:
// (a) Medical/Surgical In-Patients: bed-derived (1 per 10 beds), reusing the
//     same _computeIpdBedTotals() grouping the NCISM staffing ladder uses
//     (real beds are still tracked under the original clinical departments'
//     ncism_code, not under these two rows directly).
// (b) OPD: a flat, UG-intake-tier-based headcount (Sch XX/20) split into 3
//     named coverage zones across the 10 real Schedule XVIII outpatient
//     clinics (Session 142).
// Every other nursing-duty department (Labour Room, OT, Panchakarma,
// Screening OPD, Diagnostics) has no formal suggestion source -- returns
// null, meaning "1 per shift" is the caller's own default.
const BED_DEPT_ZONE = { 'Medical In-Patients': 'IPD_MEDICAL', 'Surgical In-Patients': 'IPD_SURGICAL' };

export async function computeRequiredPerShift(supabase, tenantId, deptName) {
  const zone = BED_DEPT_ZONE[deptName];
  if (zone) {
    const [{ data: allDepts }, { data: beds }] = await Promise.all([
      supabase.from('departments').select('id,ncism_code').eq('tenant_id', tenantId).eq('is_active', true),
      supabase.from('beds').select('department_id').eq('tenant_id', tenantId),
    ]);
    const bedTotals = _computeIpdBedTotals(allDepts || [], beds || []);
    const bedCount = bedTotals[zone] || 0;
    return bedCount > 0 ? { mode: 'bed', bedCount, perShift: Math.ceil(bedCount / 10) } : null;
  }
  if (deptName === 'OPD') {
    const { data: tenantRow } = await supabase.from('tenants').select('ug_intake').eq('id', tenantId).single();
    const ugRaw = tenantRow?.ug_intake;
    const ug = [60, 100, 150, 200].includes(ugRaw) ? ugRaw : (ugRaw >= 150 ? 150 : ugRaw >= 100 ? 100 : ugRaw > 0 ? 60 : 0);
    const perShift = OPD_POOLED_NURSE_COUNT[ug] || 0;
    return perShift > 0 ? { mode: 'opd', perShift, groups: OPD_COVERAGE_GROUPS } : null;
  }
  return null;
}
