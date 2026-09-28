// Local-calendar-day date helpers.
//
// `new Date().toISOString().slice(0,10)` (and the equivalent `.split('T')[0]`) is a common
// idiom for "today as YYYY-MM-DD" used all over this codebase, but it is wrong: toISOString()
// always renders in UTC, so it silently returns YESTERDAY's calendar date for any local time
// between midnight and the local UTC offset (00:00-05:30 for India Standard Time, this
// platform's primary timezone). The same problem hits any Date object built from local
// y/m/d values (e.g. `new Date(y, m, d)`) once it's serialized via toISOString() instead of
// a local formatter.
//
// Use these helpers instead, everywhere "today" or "this Date, as a local calendar day" is
// meant -- never the UTC calendar day. First identified and worked around in
// reception.js/nursing-admin.js's Reception Coverage Duty feature (Session 205); this module
// is the platform-wide fix.

export function localDateStr(date = new Date()) {
  return (date instanceof Date ? date : new Date(date)).toLocaleDateString('en-CA');
}

export function todayLocalStr() {
  return new Date().toLocaleDateString('en-CA');
}

// Asia/Kolkata-forced variants -- for the few screens (e.g. doctor.html's My Patients tab)
// where "today" must mean the IST calendar day regardless of the browser/OS clock's own
// timezone, not just whatever zone the machine happens to be set to.
const IST_TZ = 'Asia/Kolkata';

export function istDateStr(date = new Date()) {
  return (date instanceof Date ? date : new Date(date)).toLocaleDateString('en-CA', { timeZone: IST_TZ });
}

export function todayISTStr() {
  return istDateStr(new Date());
}

// UTC instant bounds [startUTC, endUTC) covering one IST calendar day (fixed UTC+5:30,
// no DST) -- for filtering a timestamptz column to that day without a UTC-boundary bug.
export function istDayRangeUTC(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  return { startUTC: start.toISOString(), endUTC: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString() };
}
