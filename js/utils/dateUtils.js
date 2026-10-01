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

// TODO §59 (1 Oct 2026): these two now return the Asia/Kolkata calendar date, not the device
// clock's — so "today" is right even on a device set to UTC or another zone, between 00:00 and
// 05:30 IST included. On an IST device the result is identical to before. Every existing caller
// (~275) gets this through these names; new code may call istDateStr()/todayISTStr() directly.
export function localDateStr(date = new Date()) {
  return istDateStr(date);
}

export function todayLocalStr() {
  return todayISTStr();
}

// Last calendar day of a 'YYYY-MM' month, as 'YYYY-MM-DD'. A fixed month + '-31' is an invalid
// date for 30-day months and February (e.g. '2026-09-31'), which Postgres rejects with HTTP 400.
export function monthEndStr(month) {
  const [y, m] = String(month).split('-').map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
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

// Start instant of an IST day / end instant (exclusive) of an IST day, for .gte()/.lt() filters
// on timestamptz columns over a 'from'..'to' date range. A naive `date + 'T00:00:00'` is read
// by the database (TimeZone = UTC) as UTC, so "today" used to run 05:30 → 05:30 IST.
export function istDayStartUTC(dateStr) { return istDayRangeUTC(dateStr).startUTC; }
export function istDayEndUTC(dateStr)   { return istDayRangeUTC(dateStr).endUTC; }

// 'YYYY-MM' of the IST month (default: now). toISOString().slice(0,7) gave last month on the
// 1st between 00:00 and 05:30 IST.
export function istMonthStr(date = new Date()) {
  return istDateStr(date).slice(0, 7);
}

// <input type="datetime-local"> value ('YYYY-MM-DDTHH:mm') showing a moment in IST wall-clock
// time (default: now). toISOString().slice(0,16) showed UTC wall-clock time — 5h30m behind —
// and since the input is saved back as local time, a default or edited value was stored 5h30m
// earlier than it really was.
export function istDateTimeLocalStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// The reverse: a datetime-local value typed/shown in IST → ISO instant for a timestamptz column,
// independent of the device's own timezone (new Date(value) would use the device's zone).
export function istInputToISO(value) {
  if (!value) return null;
  return new Date(`${value.length === 16 ? value + ':00' : value}+05:30`).toISOString();
}
