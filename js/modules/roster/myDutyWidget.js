// Session 168: "My Duty" widget for nursing.html -- a PERMANENT dashboard card showing a plain
// `nurse`'s own current-cycle and next-cycle duty postings, not just the Session 167 one-shot
// "your roster changed" banner (that banner tells her something changed; this answers "where am
// I posted", every time she opens the page, whether or not anything recently changed).
// Dr. Venkatesh's explicit ask (13 Aug 2026): "can nursing.html show current cycle duty places
// as well as next cycle duty posting permanently."
//
// "Current cycle" / "next cycle" are NOT stored anywhere -- duty_roster is just plain shift_date
// rows (Session 166/167's solver writes one row per real shift, no period/cycle column) -- so
// both ranges are derived fresh from today's date + the tenant's approved Roster Cycle setting
// (nursing_roster_settings.cycle: weekly/fortnightly/monthly), using the exact same
// Monday-anchored math nursingRosterGenerate.js already uses to define "this period" for
// generation. That's deliberate: this widget and the Generate Roster page can never disagree
// about where one period ends and the next begins.
import { shiftTimes, shiftNames } from '../../config/ncism.js';

const CYCLE_WEEKS  = { weekly: 1, fortnightly: 2, monthly: 4 };
const CYCLE_LABELS = { weekly: 'week', fortnightly: 'fortnight', monthly: '4-week period' };
// 0=Sunday..6=Saturday, matching profiles.weekly_off_day's stored convention (JS Date.getDay())
// -- same array roster.js's WEEKDAY_NAMES already uses, duplicated here rather than shared
// since there's no common weekday-names module in the codebase yet (nursing-roster-template.js
// keeps its own copy too).
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function _getMonday(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const m = new Date(d);
  m.setDate(m.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function _addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function _dateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function _fmtShort(dStr) { return new Date(dStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
function _fmtDay(dStr) { return new Date(dStr + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }); }

// Pure, DB-free -- exported mainly so it can be unit-reasoned-about/reused without a live client.
export function computeDutyPeriods(cycle, today = new Date()) {
  const weeks = CYCLE_WEEKS[cycle] || 1;
  const spanDays = weeks * 7;
  const thisMonday = _getMonday(today);
  const currentStart = thisMonday;
  const currentEnd = _addDays(thisMonday, spanDays - 1);
  const nextStart = _addDays(thisMonday, spanDays);
  const nextEnd = _addDays(nextStart, spanDays - 1);
  return {
    cycle, weeks,
    today: _dateStr(today),
    current: { start: _dateStr(currentStart), end: _dateStr(currentEnd) },
    next: { start: _dateStr(nextStart), end: _dateStr(nextEnd) },
  };
}

// Reads the tenant's cycle + shift-pattern settings, computes the two period ranges, and fetches
// this one nurse's own duty_roster rows spanning both in a single query (the two ranges are
// contiguous, so one gte/lte covers both -- split client-side after). Department names fetched
// separately, matching the codebase's existing convention (roster.js/nursingRosterGenerate.js
// both do a plain id->name lookup rather than an embedded join -- duty_roster's FK shape hasn't
// been checked for a department embed, and this avoids that risk entirely).
export async function fetchMyDuty(supabase, tenantId, profileId) {
  const { data: settings, error: settingsErr } = await supabase.from('nursing_roster_settings')
    .select('cycle,shift_pattern').eq('tenant_id', tenantId).maybeSingle();
  if (settingsErr) console.error('[fetchMyDuty] settings read failed:', settingsErr); // non-fatal -- falls back to defaults below

  const cycle = settings?.cycle || 'weekly';
  const pattern = settings?.shift_pattern || 'six_six_twelve';
  const shiftLabels = shiftNames(pattern);
  const shiftTimesMap = shiftTimes(pattern);
  const periods = computeDutyPeriods(cycle);

  // Session 168 follow-up (2nd round): Dr. Venkatesh's feedback -- her fixed weekly-off WEEKDAY
  // (profiles.weekly_off_day, set via roster.js's Leave & Weekly Off tab) was nowhere on this
  // card at all, only whether TODAY happened to be a day with zero shifts. Both are genuinely
  // useful and different questions ("which day do I get off every week" vs "am I off today") --
  // fetched alongside duty_roster rather than replacing anything. Same tenant-wide profiles
  // SELECT RLS every other page already reads this column under (roster.js reads it for staff
  // other than the viewer themselves), so no new grant needed for a nurse to read her own.
  const [{ data: rows, error: rosterErr }, { data: prof, error: profErr }] = await Promise.all([
    supabase.from('duty_roster')
      .select('id,department_id,shift_date,shift_type,bed_range_start,bed_range_end,notes,is_relief_assignment,is_confirmed')
      .eq('tenant_id', tenantId).eq('profile_id', profileId)
      .gte('shift_date', periods.current.start).lte('shift_date', periods.next.end)
      .order('shift_date', { ascending: true }),
    supabase.from('profiles').select('weekly_off_day').eq('id', profileId).maybeSingle(),
  ]);
  if (rosterErr) { console.error('[fetchMyDuty] duty_roster read failed:', rosterErr); return null; }
  if (profErr) console.error('[fetchMyDuty] weekly_off_day read failed:', profErr); // non-fatal -- card still renders, just without this line

  const deptIds = [...new Set((rows || []).map(r => r.department_id).filter(Boolean))];
  const deptNames = {};
  if (deptIds.length) {
    const { data: depts, error: deptErr } = await supabase.from('departments').select('id,name').in('id', deptIds);
    if (deptErr) console.error('[fetchMyDuty] departments read failed:', deptErr);
    (depts || []).forEach(d => { deptNames[d.id] = d.name; });
  }

  const currentRows = (rows || []).filter(r => r.shift_date <= periods.current.end);
  const nextRows = (rows || []).filter(r => r.shift_date >= periods.next.start);
  const weeklyOffDay = (prof?.weekly_off_day != null) ? prof.weekly_off_day : null;
  return { cycle, periods, shiftLabels, shiftTimesMap, deptNames, currentRows, nextRows, weeklyOffDay };
}

function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// Session 168 follow-up (3rd round): Dr. Venkatesh's feedback -- every row in the expanded
// grid looked identical regardless of whether that day had already passed, so a nurse scanning
// the list had no visual anchor for "where am I right now" beyond reading every date by hand.
// `todayStr` drives 3 states per row: already-completed (faded + a checkmark), today (gold
// highlight, same semantic Session 145's roster.html today-column fix already uses for "today"),
// and upcoming (unstyled, the original look). Purely a display classification -- doesn't touch
// which rows get fetched or how they're grouped.
function _rowsHtml(rows, deptNames, shiftLabels, shiftTimesMap, todayStr) {
  if (!rows.length) return '';
  return '<table class="my-duty-table"><tbody>' + rows.map(r => {
    const dept = _esc(deptNames[r.department_id] || '—');
    const shiftLabel = _esc(shiftLabels[r.shift_type] || r.shift_type);
    const shiftTime = _esc(shiftTimesMap[r.shift_type] || '');
    const beds = (r.bed_range_start && r.bed_range_end) ? ` · Beds ${r.bed_range_start}–${r.bed_range_end}` : '';
    const note = r.notes ? ` · ${_esc(r.notes)}` : '';
    const relief = r.is_relief_assignment ? ' <span class="my-duty-badge">🔁 Extra duty</span>' : '';
    const confirmed = r.is_confirmed ? '' : ' <span class="my-duty-pending">Pending confirm</span>';
    const isPast = r.shift_date < todayStr;
    const isToday = r.shift_date === todayStr;
    const rowClass = isToday ? 'my-duty-row-today' : (isPast ? 'my-duty-row-past' : '');
    const dateMark = isPast ? ' ✓' : (isToday ? ' •' : '');
    return `<tr class="${rowClass}">
      <td class="my-duty-date">${_esc(_fmtDay(r.shift_date))}${dateMark}</td>
      <td>
        <div class="my-duty-dept">${dept}${relief}${confirmed}</div>
        <div class="my-duty-shift">${shiftLabel} · ${shiftTime}${beds}${note}</div>
      </td>
    </tr>`;
  }).join('') + '</tbody></table>';
}

// Session 168 follow-up (13 Aug 2026, Dr. Venkatesh's explicit ask after seeing the first
// version live): the full This-Week/Next-Week grid was always fully expanded, pushing the
// actual clinical tabs below the fold every time a nurse opened the page. Split into an
// always-visible ONE-LINE "today" summary (this function) + the full grid tucked behind a
// click-to-expand dropdown (renderMyDutyHtml(), now only rendered into the hidden section --
// see nursing.js/nursing.html). "Day Off" here is the same ground-truth signal Session 166's
// roster.html badge uses -- zero duty_roster rows anywhere for her today, not a computed
// weekly-off-day guess -- so it can never disagree with what the roster grid itself shows.
export function renderTodayHtml(data) {
  const { periods, shiftLabels, shiftTimesMap, deptNames, currentRows, weeklyOffDay } = data;
  const dateLabel = _esc(_fmtDay(periods.today));
  const todaysRows = currentRows.filter(r => r.shift_date === periods.today);
  const isWeeklyOffToday = weeklyOffDay != null && new Date(periods.today + 'T00:00:00').getDay() === weeklyOffDay;

  // Weekly-off-day line is a SEPARATE fact from today's status -- "which weekday do I get off
  // every week" (a fixed, standing assignment) vs. "am I off today specifically" (today's row(s)
  // above, ground-truth from real duty_roster data). Shown every time, not just when they
  // coincide, and called out with a matching pill when they do (today IS her regular off day).
  const offLabel = weeklyOffDay != null ? WEEKDAY_NAMES[weeklyOffDay] : 'Not set yet';
  const offLine = `<div class="my-duty-weeklyoff">😴 Weekly Off day: <strong>${_esc(offLabel)}</strong>${isWeeklyOffToday ? ' <span class="my-duty-badge">Today</span>' : ''}</div>`;

  if (!todaysRows.length) {
    return `<div class="my-duty-today-row">
      <span class="my-duty-today-date">${dateLabel}</span>
      <span class="my-duty-today-status off">😴 Day Off</span>
    </div>${offLine}`;
  }

  return todaysRows.map(r => {
    const dept = _esc(deptNames[r.department_id] || '—');
    const shiftLabel = _esc(shiftLabels[r.shift_type] || r.shift_type);
    const shiftTime = _esc(shiftTimesMap[r.shift_type] || '');
    const beds = (r.bed_range_start && r.bed_range_end) ? ` · Beds ${r.bed_range_start}–${r.bed_range_end}` : '';
    const note = r.notes ? ` · ${_esc(r.notes)}` : '';
    const relief = r.is_relief_assignment ? ' <span class="my-duty-badge">🔁 Extra duty</span>' : '';
    return `<div class="my-duty-today-row">
      <span class="my-duty-today-date">${dateLabel}</span>
      <span class="my-duty-today-status duty">🩺 On Duty</span>
      <span class="my-duty-today-detail">${dept} · ${shiftLabel} · ${shiftTime}${beds}${note}${relief}</span>
    </div>`;
  }).join('') + offLine;
}

// Renders both columns (the full current-cycle + next-cycle grid) -- lives inside the
// click-to-expand dropdown, hidden by default; renderTodayHtml() above is what's always
// visible. `data` is exactly what fetchMyDuty() returns (or null, handled by the caller --
// see nursing.js, which just skips rendering entirely on a failed fetch rather than
// showing an empty/misleading card).
export function renderMyDutyHtml(data) {
  const { periods, shiftLabels, shiftTimesMap, deptNames, currentRows, nextRows } = data;
  const periodWord = CYCLE_LABELS[data.cycle] || 'week';
  const periodWordCap = periodWord.charAt(0).toUpperCase() + periodWord.slice(1);

  const currentBody = currentRows.length
    ? _rowsHtml(currentRows, deptNames, shiftLabels, shiftTimesMap, periods.today)
    : `<div class="my-duty-empty">No duty scheduled this ${periodWord}.</div>`;
  const nextBody = nextRows.length
    ? _rowsHtml(nextRows, deptNames, shiftLabels, shiftTimesMap, periods.today)
    : `<div class="my-duty-empty">Not published yet — check back closer to ${_fmtShort(periods.next.start)}.</div>`;

  return `
    <div class="my-duty-col">
      <div class="my-duty-col-hdr"><span>📅 This ${periodWordCap}</span><span class="my-duty-range">${_fmtShort(periods.current.start)} – ${_fmtShort(periods.current.end)}</span></div>
      ${currentBody}
    </div>
    <div class="my-duty-col">
      <div class="my-duty-col-hdr"><span>🔜 Next ${periodWordCap}</span><span class="my-duty-range">${_fmtShort(periods.next.start)} – ${_fmtShort(periods.next.end)}</span></div>
      ${nextBody}
    </div>`;
}
