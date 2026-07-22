// internRotation.js — Session 128.
//
// Computes a suggested full-year (12-stop) rotation sequence for interns across
// the 7 real NCISM clinical departments (85% share, split by their existing
// Table-8 bed ratios) plus Lab/Screening/Pharmacy (5% share, split evenly) --
// per Dr. Venkatesh's explicit ratio instructions. This is a STARTING SUGGESTION
// for Deputy MS to review/adjust before submitting for Medical Superintendent
// approval, not a rigid formula -- rounding always leaves some slack, which is
// exactly why a human reviews it rather than this silently taking effect.
//
// Deliberately pure/DB-free: takes plain intern records and a start date,
// returns area *codes* (not department ids) -- the caller resolves those
// against the tenant's real departments table, keeping this module testable
// in isolation and reusable regardless of how departments are named per tenant.

// Same ratios as js/config/ncism.js's UG_BED_RATIOS (kept as a literal copy
// here rather than importing, since that file is HTML-facing config and this
// module intentionally has zero DOM/Supabase dependencies).
const CLINICAL_RATIOS = { PK: .25, KAY: .20, SHAL: .20, SHAK: .10, KAU: .10, PST: .10, AGD: .05 };
const SUPPORT_AREAS = ['lab', 'screening', 'pharmacy'];
const CLINICAL_SHARE = 0.85;
const SUPPORT_SHARE = 0.05;
const N_STOPS = 12; // one stop per month across a 12-month internship
const PRIORITY_ORDER = ['PK', 'KAY', 'SHAL', 'KAU', 'PST', 'SHAK', 'AGD', 'lab', 'screening', 'pharmacy'];

// Largest-remainder (Hamilton) apportionment -- guarantees the per-area stop
// counts sum to exactly N_STOPS despite each area's exact share being
// fractional, same class of technique already used for seat/bed allocation
// elsewhere in this app.
//
// Every area gets a floor of 1 stop first -- at N_STOPS=12, Lab/Screening/
// Pharmacy's raw 1.67%-each share rounds to 0 under plain proportional
// apportionment, silently dropping them from the rotation entirely (caught by
// testing this against real numbers, not by inspection). The whole point of
// including them is that every intern actually rotates through them, so a
// department/area with real demand for interns must never be allocated zero.
function _apportionStops() {
  const weights = {};
  for (const [code, ratio] of Object.entries(CLINICAL_RATIOS)) weights[code] = ratio * CLINICAL_SHARE;
  for (const area of SUPPORT_AREAS) weights[area] = SUPPORT_SHARE / SUPPORT_AREAS.length;

  const keys = Object.keys(weights);
  const floorEach = 1;
  const reserved = keys.length * floorEach;
  const remainingStops = Math.max(0, N_STOPS - reserved);

  const exact = keys.map(k => weights[k] * remainingStops);
  const floors = exact.map(Math.floor);
  const allocated = floors.reduce((a, b) => a + b, 0);
  const remaining = remainingStops - allocated;

  const remainders = keys.map((k, i) => ({ k, r: exact[i] - floors[i] })).sort((a, b) => b.r - a.r);
  const counts = Object.fromEntries(keys.map((k, i) => [k, floorEach + floors[i]]));
  for (let i = 0; i < remaining; i++) counts[remainders[i].k]++;
  return counts;
}

export function computeStopCounts() {
  return _apportionStops();
}

// interns: array of { id, name } (or any shape with an `id`). startDate: 'YYYY-MM-DD'.
// Returns: array of { intern, postings: [{ profile_id, area_code, start_date, end_date }] }
export function computeInternRotationPlan(interns, startDate) {
  const counts = _apportionStops();
  const sequence = [];
  PRIORITY_ORDER.forEach(code => { for (let i = 0; i < (counts[code] || 0); i++) sequence.push(code); });

  // Explicit UTC construction -- 'T00:00:00' (no Z) parses as LOCAL midnight,
  // and .toISOString() below always emits UTC, so any positive UTC offset
  // (e.g. IST, UTC+5:30) silently shifted every computed date back by a day.
  // Caught by testing with a real date, not by inspection.
  const start = new Date(startDate + 'T00:00:00Z');

  return interns.map((intern, idx) => {
    const offset = sequence.length ? idx % sequence.length : 0;
    const rotated = [...sequence.slice(offset), ...sequence.slice(0, offset)];
    const postings = rotated.map((areaCode, stopIdx) => {
      // Real calendar-month arithmetic (setUTCMonth), not a fixed 30-day block --
      // 12 x 30 days is only 360 days, drifting ~5 days short of a true year by
      // the last stop. setUTCMonth correctly handles variable month lengths
      // (28-31 days) and year rollover on its own.
      const stopStart = new Date(start); stopStart.setUTCMonth(stopStart.getUTCMonth() + stopIdx);
      const stopEnd    = new Date(start); stopEnd.setUTCMonth(stopEnd.getUTCMonth() + stopIdx + 1);
      stopEnd.setUTCDate(stopEnd.getUTCDate() - 1);
      return {
        profile_id: intern.id,
        area_code: areaCode,
        start_date: stopStart.toISOString().slice(0, 10),
        end_date: stopEnd.toISOString().slice(0, 10),
      };
    });
    return { intern, postings };
  });
}

export const CLINICAL_CODES = Object.keys(CLINICAL_RATIOS);
export const ROTATION_AREA_CODES = PRIORITY_ORDER;
