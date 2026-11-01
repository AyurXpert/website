// Session 371B (plan session 370 B1 + owner answer 1, 30 Oct 2026): the purple NCISM OPD strip on reception.
// Every number comes from the SERVER's one count (ncism_opd_daily / ncism_settings, Build A) -- the page never counts visits itself.
//   (a) TODAY vs the daily target (UG intake x 2), with the hospital's 75 % alert line (labelled: not an NCISM rule);
//   (b) the running yearly average = patients of the last 12 months / 300 days (Reg. 42 Table-7 note). When the organisation's
//       first visit is less than 12 months ago, the strip says "since <date>" and divides by the OPD days so far.
// Shown only for an NCISM organisation type (ncism_settings().ncism_type).

const DAY = 86400000;
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const fmtDay = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

// The 75 % line in patients (rounded UP: "75 % of 200" = 150, of 150 = 113)
export const alertLine = (target, pct) => (target > 0 ? Math.ceil(target * (pct ?? 75) / 100) : 0);

// settings = ncism_settings(); today = 'YYYY-MM-DD' (IST); todayRow = that day's ncism_opd_daily row (or none);
// yearRows = ncism_opd_daily(today - 364, today); firstVisit = 'YYYY-MM-DD' of the organisation's first visit (or null)
export function stripModel({ settings, today, todayRow, yearRows, firstVisit }) {
  const target = Number(todayRow?.target ?? settings?.target_per_day ?? 0) || 0;
  const pctLine = Number(settings?.alert_pct ?? 75);
  const total = Number(todayRow?.total ?? 0), nw = Number(todayRow?.new_patients ?? 0), fu = Number(todayRow?.followup_patients ?? 0);
  const line = alertLine(target, pctLine);
  const m = {
    target, alertPct: pctLine, line, total, newPatients: nw, followup: fu,
    stillToRegister: Math.max(target - total, 0),
    pct: target > 0 ? Math.round(total * 100 / target) : 0,
    moreToLine: Math.max(line - total, 0),
    isOpdDay: todayRow ? todayRow.is_opd_day !== false : true,
    dayNote: todayRow?.day_note || null,
    avg: null, avgLabel: '', avgSince: null,
  };
  const from = addDays(today, -364);
  const rows = (yearRows || []).filter(r => r.day >= from && r.day <= today);
  const sum = rows.reduce((s, r) => s + Number(r.total || 0), 0);
  if (firstVisit && firstVisit > from) {
    const since = rows.filter(r => r.day >= firstVisit);
    const opd = since.filter(r => r.is_opd_day !== false).length;
    m.avg = opd > 0 ? Math.round(since.reduce((s, r) => s + Number(r.total || 0), 0) / opd) : null;
    m.avgSince = firstVisit;
    m.avgLabel = `Average per OPD day since ${fmtDay(firstVisit)}`;
  } else if (firstVisit) {
    m.avg = Math.round(sum / 300);
    m.avgLabel = '12-month average (patients ÷ 300 days)';
  }
  return m;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function stat(label, value, sub) {
  const d = el('div', 'nc-stat');
  d.append(el('div', 'nc-stat-l', label), el('div', 'nc-stat-v', String(value)));
  if (sub) d.append(el('div', 'nc-stat-s', sub));
  return d;
}

// Renders the strip into `root` (a <section>). Returns the model (or null when hidden / not loaded).
export async function mountNcismStrip({ supabase, tenantId, root, today, onOpenRange }) {
  if (!root) return null;
  const { data: settings, error: sErr } = await supabase.rpc('ncism_settings');
  if (sErr || !settings || !settings.ncism_type) { root.hidden = true; return null; }
  const [d, y, f] = await Promise.all([
    supabase.rpc('ncism_opd_daily', { p_from: today, p_to: today }),
    supabase.rpc('ncism_opd_daily', { p_from: addDays(today, -364), p_to: today }),
    supabase.from('visits').select('created_at').eq('tenant_id', tenantId).eq('is_deleted', false).order('created_at', { ascending: true }).limit(1),
  ]);
  root.hidden = false;
  root.replaceChildren();
  const inner = el('div', 'nc-inner');
  root.append(inner);
  if (d.error || y.error) {
    inner.append(el('span', 'nc-chip', 'NCISM OPD'), el('span', 'nc-msg', 'The NCISM count could not be loaded. Reload the page to try again.'));
    return null;
  }
  const firstVisit = f.data?.[0]?.created_at ? new Date(f.data[0].created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null;
  const m = stripModel({ settings, today, todayRow: (d.data || [])[0], yearRows: y.data || [], firstVisit });

  const head = el('div', 'nc-head');
  head.append(el('div', 'nc-chip', `NCISM OPD · TODAY ${new Date(today + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' }).toUpperCase()}`),
    el('div', 'nc-sub', m.isOpdDay ? 'Target = UG intake × 2 per OPD day' : `Not an OPD day${m.dayNote ? ' — ' + m.dayNote : ''} (patients seen still count)`));
  const stats = el('div', 'nc-stats');
  stats.append(stat('Target', m.target), stat('Registered', m.total, `New ${m.newPatients} · Follow-up ${m.followup}`), stat('Still to register', m.stillToRegister));

  const meter = el('div', 'nc-meter');
  const top = el('div', 'nc-meter-top');
  top.append(el('span', 'nc-pct', `${m.pct}% of target`),
    el('span', m.moreToLine > 0 ? 'nc-more' : 'nc-ok', m.moreToLine > 0 ? `${m.moreToLine} more to reach ${m.alertPct}% (${m.line})` : `✓ ${m.alertPct}% line reached`));
  const bar = el('div', 'nc-bar');
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', `Today ${m.total} of ${m.target} patients, ${m.pct} per cent; hospital alert line ${m.alertPct} per cent`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(m.target || 0));
  bar.setAttribute('aria-valuenow', String(m.total));
  const fill = el('div', `nc-fill ${m.total >= m.line && m.line > 0 ? 'nc-fill-ok' : 'nc-fill-low'}`);
  fill.style.width = `${Math.min(m.pct, 100)}%`;
  const mark = el('div', 'nc-line');
  mark.style.left = `${Math.min(m.alertPct, 100)}%`;
  bar.append(fill, mark);
  const lineLbl = el('div', 'nc-line-lbl');
  const lbl = el('span', null, `${m.alertPct}% · hospital alert line (not an NCISM rule)`);
  lbl.style.left = `${Math.min(m.alertPct, 100)}%`;
  lineLbl.append(lbl);
  meter.append(top, bar, lineLbl);

  const year = el('div', 'nc-year');
  if (m.avg !== null) {
    year.append(el('div', 'nc-stat-l', m.avgLabel), el('div', 'nc-stat-v', `${m.avg} / day`),
      el('div', 'nc-stat-s', `${m.target > 0 ? Math.round(m.avg * 100 / m.target) : 0}% of ${m.target}`));
  } else {
    year.append(el('div', 'nc-stat-l', 'Yearly average'), el('div', 'nc-stat-s', 'No counted visits yet'));
  }

  const btn = el('button', 'nc-range-btn', '📅 Date range');
  btn.type = 'button';
  btn.addEventListener('click', () => onOpenRange?.(settings));
  inner.append(head, stats, meter, year, btn);
  return m;
}
