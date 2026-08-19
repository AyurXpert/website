// Session 179: real per-nurse bed-range slicing, tied to actual `beds.bed_number` values
// (bed-admin.html's Session 179 Piece 1-3 ward-type-first/zone-restricted numbering) instead of
// the old abstract duty_roster.bed_range_start/end (an even split of a zone's pooled bed COUNT,
// never tied to a real bed -- see nursing.js's own history of this exact limitation).
//
// Dr. Venkatesh's explicit design call after discussing the alternative (whole bed-TYPE rooms
// per nurse): don't reason about ward TYPE at all -- different tenants configure completely
// different ward mixes, so any type-aware logic would only work for hospitals shaped like SDM.
// Slice PURELY by sorted real bed NUMBER instead -- generic across any tenant's configuration,
// and realistic too: a single large ward routinely splits its beds by number range among
// several nurses in real hospitals, not necessarily kept whole per nurse. A slice can therefore
// legitimately skip numbers that belong to a different physical ward/zone (e.g. Medical
// In-Patients' sorted numbers have real gaps at 13-20, 33-40, ... -- Surgical Ward's numbers,
// interleaved by bed-admin.js's own ward-type-first scheme) -- compressToRangeText() reflects
// that honestly instead of showing a misleading min-max span.
//
// This module is the SINGLE source of truth for "what does slot N of M actually cover" --
// nursing-roster-template.js (planning) and nursing.html (real-time charting) both call it, so
// the two can never disagree about what a nurse's assigned range means.

// Pure, DB-free -- splits `n` items evenly across `totalSlots`, front-loading the remainder
// onto earlier slots (same convention distributeAcrossShifts() in requiredStaffing.js already
// uses, so a department's real-bed slicing and its shift-total distribution stay consistent
// with each other). Returns the [start,end) index range (0-based, end-exclusive) for
// `slotIndex` (1-based).
export function sliceRange(n, slotIndex, totalSlots) {
  if (!n || !totalSlots || slotIndex < 1 || slotIndex > totalSlots) return { start: 0, end: 0 };
  const base = Math.floor(n / totalSlots);
  const remainder = n % totalSlots;
  let start = 0;
  for (let i = 1; i < slotIndex; i++) start += base + (i <= remainder ? 1 : 0);
  const count = base + (slotIndex <= remainder ? 1 : 0);
  return { start, end: start + count };
}

// Compresses a sorted array of distinct integers into a human-readable range string, e.g.
// [1,2,3,5,6,8] -> "1–3, 5–6, 8". Deliberately never collapses to a bare min-max (e.g. "1–8")
// -- that would silently imply she covers numbers 4 and 7 too, which could belong to a
// different ward/zone entirely. Honest gaps stay visible.
export function compressToRangeText(sortedNums) {
  if (!sortedNums || !sortedNums.length) return '';
  const parts = [];
  let rangeStart = sortedNums[0], prev = sortedNums[0];
  for (let i = 1; i <= sortedNums.length; i++) {
    const cur = sortedNums[i];
    if (cur === prev + 1) { prev = cur; continue; }
    parts.push(rangeStart === prev ? `${rangeStart}` : `${rangeStart}–${prev}`);
    if (i < sortedNums.length) { rangeStart = cur; prev = cur; }
  }
  return parts.join(', ');
}

// Real, sorted bed NUMBER values (not full bed rows) for every bed belonging to the given
// department set -- the exact same department-id scoping nursing.html's own zone/standalone
// ward selection already uses (deptIds), so this can never disagree with which patients are
// shown there. bed_number's numeric part is parsed the same way every other Session 179 piece
// already does (`<PREFIX>-<NUM>`).
export async function fetchZoneRealBedNumbers(supabase, tenantId, deptIds) {
  if (!deptIds || !deptIds.length) return [];
  const { data, error } = await supabase.from('beds').select('bed_number')
    .eq('tenant_id', tenantId).in('department_id', deptIds);
  if (error) { console.error('[realBedSlicing] beds fetch failed:', error); return []; }
  const nums = (data || [])
    .map(b => parseInt((b.bed_number || '').split('-').pop()))
    .filter(n => !isNaN(n));
  return [...new Set(nums)].sort((a, b) => a - b);
}

// The one function every caller should use -- guarantees "her slice" means the exact same
// thing everywhere it's computed. Returns null if there's nothing to slice (no real beds
// configured yet for this department set, or slotIndex/totalSlots don't resolve to anything).
//
// Session 179 follow-up (Dr. Venkatesh, live correction): the real bed_number VALUES (rangeText,
// e.g. "1-12, 21-28") are honest but not what real wards actually communicate at handover --
// "beds 1-20 / 21-40 / 41-60" is the clean, memorable shape staff actually use, matching his own
// worked example (Male General + Female General Ward's combined 20 beds go to one nurse as one
// round block). The fix keeps the exact same slicing (still 100% real-bed-based for who actually
// shows up in the list -- `numbers` is unchanged) but displays her POSITION within the zone's
// sorted bed count (1st, 2nd, 3rd bed...) instead of the real, possibly-gapped bed number. A
// position range can never have gaps -- it's a contiguous index range by construction, unlike
// real bed numbers which skip whenever they cross into a different zone's territory. `numbers`
// (the real bed_number values, used for the actual patient-list filter) is untouched.
export async function computeNurseBedSlice(supabase, tenantId, deptIds, slotIndex, totalSlots) {
  const allNums = await fetchZoneRealBedNumbers(supabase, tenantId, deptIds);
  if (!allNums.length) return null;
  const { start, end } = sliceRange(allNums.length, slotIndex, totalSlots);
  const mySlice = allNums.slice(start, end);
  if (!mySlice.length) return null;
  const positionRangeText = (start + 1) === end ? `${end}` : `${start + 1}–${end}`;
  return {
    numbers: mySlice,
    rangeText: positionRangeText,        // clean position range, e.g. "1–20" -- what's shown
    realNumberRangeText: compressToRangeText(mySlice), // real (gapped) bed numbers -- kept for anyone who wants the literal bed_number detail
    zoneTotal: allNums.length,
  };
}
