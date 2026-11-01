// Session 371B (plan session 370 Part C "Date-range view", owner answers 1 + 11, Q11): NCISM OPD compliance for a period.
// The NCISM figure = the AVERAGE PER OPD DAY (patients ÷ OPD days) against UG intake × 2 (Reg. 42 Table-7). OPD days = the days the
// server marks is_opd_day (weekly off and the hospital's holidays left out); patients seen on a non-OPD day still count.
// Days at / above the hospital's 75 % line and the shortfall to that line are a hospital aid, not an NCISM rule.
// "Academic year" appears only when the organisation's Super Admin has set its start month (Q11) -- no month is guessed.
// Everything comes from ncism_opd_daily / ncism_opd_day_list (Build A). PDF = a clean portrait print (A4-clean); Excel = .xlsx.
import { addDays, alertLine } from './ncismStrip.js';
// printDocument / xlsxWriter are loaded when used (keeps the pure models importable on their own)

export const MAX_DAYS = 400;

// rows = ncism_opd_daily(from, to); settings = ncism_settings()
export function rangeModel(rows, settings) {
  const target = Number(rows?.[0]?.target ?? settings?.target_per_day ?? 0) || 0;
  const pct = Number(settings?.alert_pct ?? 75);
  const line = alertLine(target, pct);
  const opd = (rows || []).filter(r => r.is_opd_day !== false);
  const notOpd = (rows || []).filter(r => r.is_opd_day === false);
  const sum = (list, k) => list.reduce((s, r) => s + Number(r[k] || 0), 0);
  const registered = sum(rows || [], 'total');
  const avg = opd.length ? registered / opd.length : 0;
  const below = opd.filter(r => Number(r.total || 0) < line);
  return {
    target, alertPct: pct, line, days: (rows || []).length, opdDays: opd.length,
    weeklyOff: notOpd.filter(r => r.day_note === 'weekly off').length,
    holidays: notOpd.filter(r => r.day_note && r.day_note !== 'weekly off').length,
    otherClosed: notOpd.filter(r => !r.day_note).length,
    targetPeriod: target * opd.length, registered, newPatients: sum(rows || [], 'new_patients'), followup: sum(rows || [], 'followup_patients'),
    avg: Math.round(avg * 10) / 10, achievedPct: target > 0 ? Math.round(avg * 1000 / target) / 10 : 0,
    daysAtLine: opd.length - below.length, daysBelow: below.length,
    shortfall: below.reduce((s, r) => s + (line - Number(r.total || 0)), 0),
  };
}

// The quick ranges. today = 'YYYY-MM-DD' (IST). startMonth = 1..12 or null (Q11: no "Academic year" until it is set)
export function quickRanges(today, startMonth) {
  const [y, mo, d] = today.split('-').map(Number);
  const iso = (Y, M, D) => `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  const lastMonthEnd = addDays(iso(y, mo, 1), -1);
  const out = [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'week', label: 'This week', from: monday, to: today },
    { key: 'month', label: 'This month', from: iso(y, mo, 1), to: today },
    { key: 'lastmonth', label: 'Last month', from: lastMonthEnd.slice(0, 8) + '01', to: lastMonthEnd },
    { key: 'rolling', label: 'Rolling 12 months', from: addDays(today, -364), to: today },
  ];
  const sm = Number(startMonth);
  if (Number.isInteger(sm) && sm >= 1 && sm <= 12) {
    const startY = mo >= sm ? y : y - 1;
    const start = iso(startY, sm, 1);
    out.push({ key: 'academic', label: 'This academic year', from: start, to: today });
    out.push({ key: 'lastacademic', label: 'Last academic year', from: iso(startY - 1, sm, 1), to: addDays(start, -1) });
  }
  return out;
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
const fmtDay = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const fmtFull = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const n = v => Number(v || 0).toLocaleString('en-IN');

// One day's bar: [the number on top (when there is room), the coloured fill]. A day with patients is never thinner than
// the CSS minimum (ncr-fill-has); an empty non-OPD day keeps a small grey stub so it still reads "not an OPD day".
function barParts(tot, off, max, showNum) {
  const fill = el('span', 'ncr-fill' + (tot > 0 ? ' ncr-fill-has' : off ? ' ncr-fill-offstub' : ''));
  fill.style.height = `${(tot / max) * 100}%`;
  const parts = [];
  if (showNum && tot > 0) parts.push(el('span', 'ncr-num', String(tot)));
  parts.push(fill);
  return parts;
}

function card(label, value, sub, warn) {
  const c = el('div', 'ncr-card' + (warn ? ' ncr-card-warn' : ''));
  c.append(el('div', 'ncr-card-l', label), el('div', 'ncr-card-v', value), el('div', 'ncr-card-s', sub));
  return c;
}

// Opens the dialog. errorText(error, fallback) = the page's safeErrorMessage.
export function openNcismRange({ supabase, today, settings, errorText, tenantName = '' }) {
  document.getElementById('ncr-dialog')?.remove();
  const dlg = el('div', 'ncr-overlay');
  dlg.id = 'ncr-dialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'ncr-title');
  const box = el('div', 'ncr-box');
  dlg.append(box);

  const head = el('div', 'ncr-head');
  const titles = el('div', 'ncr-titles');
  const h = el('h2', 'ncr-title', 'NCISM OPD compliance — date range');
  h.id = 'ncr-title';
  titles.append(h, el('div', 'ncr-sub', 'Each patient counted once per day · new + follow-up · target = UG intake × 2 per OPD day · tele-consultations not counted'));
  const close = el('button', 'ncr-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the date-range view');
  head.append(titles, close);

  const ctl = el('div', 'ncr-ctl');
  const mk = (id, label, type) => { const w = el('div', 'ncr-fld'); const l = el('label', null, label); l.htmlFor = id; const i = el('input'); i.type = type; i.id = id; w.append(l, i); return [w, i]; };
  const [fw, fromI] = mk('ncr-from', 'From', 'date');
  const [tw, toI] = mk('ncr-to', 'To', 'date');
  const qw = el('div', 'ncr-fld');
  const ql = el('label', null, 'Quick range'); ql.htmlFor = 'ncr-quick';
  const quick = el('select'); quick.id = 'ncr-quick';
  const ranges = quickRanges(today, settings?.academic_year_start_month ?? null);
  quick.append(new Option('— custom —', ''));
  ranges.forEach(r => quick.append(new Option(r.label, r.key)));
  qw.append(ql, quick);
  const show = el('button', 'ncr-btn ncr-btn-main', 'Show'); show.type = 'button';
  const pdf = el('button', 'ncr-btn', '🖨 PDF'); pdf.type = 'button';
  const xls = el('button', 'ncr-btn', '⬇ Excel'); xls.type = 'button';
  ctl.append(fw, tw, qw, show, pdf, xls);

  const msg = el('div', 'ncr-msg'); msg.setAttribute('role', 'status');
  const body = el('div', 'ncr-body');
  box.append(head, ctl, msg, body);
  document.body.append(dlg);

  let rows = [], model = null, from = '', to = '';
  const month = ranges.find(r => r.key === 'month');
  fromI.value = month.from; toI.value = month.to; fromI.max = today; toI.max = today; quick.value = 'month';
  // Owner (31 Oct 2026, rehearsal): dates changed by hand -> the box shows the quick range they match, else "— custom —"
  const syncQuick = () => { quick.value = ranges.find(r => r.from === fromI.value && r.to === toI.value)?.key || ''; };
  fromI.addEventListener('input', syncQuick); toI.addEventListener('input', syncQuick);
  fromI.addEventListener('change', syncQuick); toI.addEventListener('change', syncQuick);

  const shut = () => { dlg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') shut(); };
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', shut);
  dlg.addEventListener('click', e => { if (e.target === dlg) shut(); });
  quick.addEventListener('change', () => {
    const r = ranges.find(x => x.key === quick.value);
    if (r) { fromI.value = r.from; toI.value = r.to; load(); }
  });
  show.addEventListener('click', () => load());

  async function load() {
    msg.textContent = '';
    const f = fromI.value, t = toI.value;
    if (!f || !t) { msg.textContent = 'Choose both dates.'; return; }
    if (f > t) { msg.textContent = 'The From date is after the To date.'; return; }
    const span = (Date.parse(t) - Date.parse(f)) / 86400000 + 1;
    if (span > MAX_DAYS) { msg.textContent = `Choose a period of up to ${MAX_DAYS} days.`; return; }
    msg.textContent = 'Loading…';
    const { data, error } = await supabase.rpc('ncism_opd_daily', { p_from: f, p_to: t });
    if (error) { msg.textContent = errorText(error, 'The NCISM count could not be loaded.'); body.replaceChildren(); rows = []; model = null; return; }
    rows = (data || []).slice().sort((a, b) => (a.day < b.day ? -1 : 1));
    from = f; to = t;
    model = rangeModel(rows, settings);
    msg.textContent = '';
    render();
  }

  function render() {
    const m = model;
    const cards = el('div', 'ncr-cards');
    const excluded = [m.weeklyOff ? `${m.weeklyOff} weekly off` : '', m.holidays ? `${m.holidays} holiday${m.holidays > 1 ? 's' : ''}` : '',
      m.otherClosed ? `${m.otherClosed} closed` : ''].filter(Boolean).join(' · ') || 'none excluded';
    cards.append(
      card('OPD days', n(m.opdDays), excluded),
      card('Target for period', n(m.targetPeriod), `${n(m.target)} × ${n(m.opdDays)} OPD days`),
      card('Seen (NCISM)', n(m.registered), `New ${n(m.newPatients)} · Follow-up ${n(m.followup)}`),
      card('Average per OPD day (NCISM)', n(m.avg), `${m.achievedPct}% of ${n(m.target)}`),
      card(`Days at or above ${m.alertPct}%`, `${n(m.daysAtLine)} of ${n(m.opdDays)}`,
        m.daysBelow ? `${n(m.daysBelow)} below — shortfall ${n(m.shortfall)} to the ${m.alertPct}% line` : 'none below', m.daysBelow > 0));

    const fig = el('figure', 'ncr-fig');
    const cap = el('figcaption', 'ncr-cap');
    const legend = (cls, text) => { const s = el('span', 'ncr-leg'); s.append(el('span', `ncr-sw ${cls}`), document.createTextNode(text)); return s; };
    cap.append(el('strong', null, 'Patients per day'), legend('ncr-sw-ok', `▲ at or above ${m.alertPct}%`),
      legend('ncr-sw-low', `▼ below ${m.alertPct}% (striped)`), legend('ncr-sw-off', 'not an OPD day'), legend('ncr-sw-line', `${m.alertPct}% line (${m.line})`));
    const max = Math.max(m.target, ...rows.map(r => Number(r.total || 0)), 1);
    const plot = el('div', 'ncr-plot');
    if (rows.length > 60) plot.classList.add('ncr-dense');
    const lineEl = el('div', 'ncr-plot-line');
    lineEl.style.bottom = `${(m.line / max) * 100}%`;
    const tgtEl = el('div', 'ncr-plot-target');
    tgtEl.style.bottom = `${(m.target / max) * 100}%`;
    const yl = el('div', 'ncr-ylab', String(m.line)); yl.style.bottom = `${(m.line / max) * 100}%`;
    const yt = el('div', 'ncr-ylab ncr-ylab-t', String(m.target)); yt.style.bottom = `${(m.target / max) * 100}%`;
    plot.append(tgtEl, lineEl, yl, yt);
    // Owner (31 Oct 2026, rehearsal): every day is a FULL-HEIGHT clickable column; a day with patients always shows a visible
    // bar (never a hairline) with its number on top; a day that is not an OPD day stays grey and is marked "off" when empty.
    const bars = el('div', 'ncr-bars');
    const showNums = rows.length <= 62;
    for (const r of rows) {
      const tot = Number(r.total || 0);
      const off = r.is_opd_day === false;
      const ok = tot >= m.line && m.line > 0;
      const b = el('button', `ncr-bar ${off ? 'ncr-bar-off' : ok ? 'ncr-bar-ok' : 'ncr-bar-low'}`);
      b.type = 'button';
      const state = off ? `not an OPD day${r.day_note ? ' (' + r.day_note + ')' : ''}` : ok ? `at or above the ${m.alertPct}% line` : `below the ${m.alertPct}% line`;
      b.setAttribute('aria-label', `${fmtFull(r.day)}: ${tot} patients (new ${r.new_patients || 0}, follow-up ${r.followup_patients || 0}) — ${state}. Open the list.`);
      b.title = `${fmtFull(r.day)}: ${tot} — ${state}`;
      b.append(...barParts(tot, off, max, showNums));
      b.addEventListener('click', () => openDay(r.day));
      bars.append(b);
    }
    plot.append(bars);
    const axis = el('div', 'ncr-axis');
    if (rows.length) {
      const picks = [0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter((v, i, a) => a.indexOf(v) === i);
      picks.forEach(i => axis.append(el('span', null, fmtDay(rows[i].day))));
    }
    fig.append(cap, plot, axis);

    // table view (the same numbers as text -- the chart is never the only way to read them)
    const det = el('details', 'ncr-table-wrap');
    det.append(el('summary', null, 'Show the numbers as a table'));
    const tbl = el('table', 'ncr-table');
    const thead = el('thead'); const trh = el('tr');
    ['Day', 'OPD day', 'New', 'Follow-up', 'Total', `At ${m.alertPct}% line`].forEach(t => trh.append(el('th', null, t)));
    thead.append(trh);
    const tb = el('tbody');
    rows.forEach(r => {
      const tr = el('tr');
      const tot = Number(r.total || 0);
      [fmtFull(r.day), r.is_opd_day === false ? `No — ${r.day_note || 'closed'}` : 'Yes', n(r.new_patients), n(r.followup_patients), n(tot),
        r.is_opd_day === false ? '—' : (tot >= m.line ? '▲ yes' : '▼ no')].forEach(v => tr.append(el('td', null, v)));
      tb.append(tr);
    });
    tbl.append(thead, tb);
    det.append(tbl);

    const day = el('div', 'ncr-day'); day.id = 'ncr-day';
    body.replaceChildren(cards, fig, el('div', 'ncr-note', 'Click a day (or press Enter on it) to see that day\'s patients. Holidays and the weekly off are set by the hospital and left out of the target.'), day, det);
  }

  async function openDay(dayIso) {
    const box2 = document.getElementById('ncr-day');
    box2.replaceChildren(el('div', 'ncr-msg', `Loading ${fmtFull(dayIso)}…`));
    const { data, error } = await supabase.rpc('ncism_opd_day_list', { p_day: dayIso });
    if (error) { box2.replaceChildren(el('div', 'ncr-msg ncr-msg-err', errorText(error, 'That day\'s list could not be loaded.'))); return; }
    const list = (data || []).slice().sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)));
    const h3 = el('h3', 'ncr-day-h', `${fmtFull(dayIso)} — ${list.length} patient${list.length === 1 ? '' : 's'} (new ${list.filter(x => x.is_new).length} · follow-up ${list.filter(x => !x.is_new).length})`);
    h3.tabIndex = -1;
    const HEAD = ['UHID', 'Name', 'New / follow-up', 'OPD', 'First seen'];
    const cells = p => [p.uhid || '—', p.name || '—', p.is_new ? 'New' : 'Follow-up', p.opd_name || '—',
      p.first_seen ? new Date(p.first_seen).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—'];
    const t = el('table', 'ncr-table');
    const hr = el('tr');
    HEAD.forEach(x => hr.append(el('th', null, x)));
    const th = el('thead'); th.append(hr);
    const tb = el('tbody');
    list.forEach(p => {
      const tr = el('tr');
      cells(p).forEach(v => tr.append(el('td', null, v)));
      tb.append(tr);
    });
    t.append(th, tb);
    // Owner (31 Oct 2026, rehearsal): the day's list downloads as Excel and prints as a clean PDF
    const dayBar = el('div', 'ncr-day-bar');
    const dPdf = el('button', 'ncr-btn', '🖨 PDF of this day'); dPdf.type = 'button';
    const dXls = el('button', 'ncr-btn', '⬇ Excel of this day'); dXls.type = 'button';
    dPdf.addEventListener('click', async () => {
      const { printDocument, docHeader } = await import('../../utils/printDocument.js');
      const sum = el('div', 'ncr-print-sum', h3.textContent);
      const hdr = docHeader('NCISM OPD — patients of the day', fmtFull(dayIso));
      const org = hdr.querySelector('.ax-doc-org'); if (org && !org.textContent && tenantName) org.textContent = tenantName;
      printDocument([hdr, sum, t], { title: `NCISM OPD patients ${dayIso}`, size: 'A4-clean' });
    });
    dXls.addEventListener('click', async () => {
      const { xlsxBlob, downloadBlob } = await import('../../utils/xlsxWriter.js');
      const sheet = [['NCISM OPD — patients of the day', dayIso], [], HEAD].concat(list.map(cells));
      downloadBlob(xlsxBlob([{ name: 'Patients', rows: sheet }]), `ncism_opd_patients_${dayIso}.xlsx`);
    });
    dayBar.append(h3);
    if (list.length) dayBar.append(dPdf, dXls);
    box2.replaceChildren(dayBar, list.length ? t : el('div', 'ncr-msg', 'No counted patient on this day.'));
    h3.focus();
  }

  pdf.addEventListener('click', async () => {
    if (!model) { msg.textContent = 'Press Show first.'; return; }
    const { printDocument, docHeader } = await import('../../utils/printDocument.js');
    const hdr = docHeader('NCISM OPD compliance', `Period: ${fmtFull(from)} – ${fmtFull(to)}`);
    const org = hdr.querySelector('.ax-doc-org'); if (org && !org.textContent && tenantName) org.textContent = tenantName;
    printDocument([hdr, ...printParts()], { title: `NCISM OPD ${from} to ${to}`, size: 'A4-clean' });
  });

  // Owner (31 Oct 2026, rehearsal): a clean PORTRAIT print -- the hospital name + period (docHeader), the cards, a chart that
  // prints (plain blocks, not the on-screen buttons -- print.css hides every button on paper), and the daily table. No
  // "Click a day" hint, no day list, no browser header / footer (size 'A4-clean').
  function printParts() {
    const m = model;
    const cards = body.querySelector('.ncr-cards').cloneNode(true);
    cards.classList.add('ncr-print-cards');
    const fig = el('div', 'ncr-fig ncr-print-fig');
    const cap = body.querySelector('.ncr-cap').cloneNode(true);
    const max = Math.max(m.target, ...rows.map(r => Number(r.total || 0)), 1);
    const plot = el('div', 'ncr-plot ncr-print-plot');
    const at = v => `${(v / max) * 100}%`;
    const lineEl = el('div', 'ncr-plot-line'); lineEl.style.bottom = at(m.line);
    const tgtEl = el('div', 'ncr-plot-target'); tgtEl.style.bottom = at(m.target);
    const yl = el('div', 'ncr-ylab', String(m.line)); yl.style.bottom = at(m.line);
    const yt = el('div', 'ncr-ylab ncr-ylab-t', String(m.target)); yt.style.bottom = at(m.target);
    const bars = el('div', 'ncr-bars');
    const showNums = rows.length <= 31;
    for (const r of rows) {
      const tot = Number(r.total || 0);
      const off = r.is_opd_day === false;
      const ok = tot >= m.line && m.line > 0;
      const col = el('div', `ncr-bar ${off ? 'ncr-bar-off' : ok ? 'ncr-bar-ok' : 'ncr-bar-low'}`);
      col.append(...barParts(tot, off, max, showNums));
      bars.append(col);
    }
    plot.append(tgtEl, lineEl, yl, yt, bars);
    if (rows.length > 62) plot.classList.add('ncr-dense');
    fig.append(cap, plot, body.querySelector('.ncr-axis').cloneNode(true));
    const tbl = body.querySelector('.ncr-table-wrap table').cloneNode(true);
    return [cards, fig, el('div', 'ncr-print-h', 'Daily figures'), tbl];
  }
  xls.addEventListener('click', async () => {
    if (!model) { msg.textContent = 'Press Show first.'; return; }
    const m = model;
    const summary = [['NCISM OPD compliance', `${from} to ${to}`], ['OPD days', m.opdDays], ['Target per OPD day', m.target], ['Target for period', m.targetPeriod],
      ['Seen (NCISM)', m.registered], ['New', m.newPatients], ['Follow-up', m.followup], ['Average per OPD day (NCISM)', m.avg], ['Achieved %', m.achievedPct],
      [`Days at or above ${m.alertPct}% (hospital line, not NCISM)`, m.daysAtLine], ['Days below', m.daysBelow], ['Shortfall to the line', m.shortfall]];
    const daily = [['Day', 'OPD day', 'Note', 'New', 'Follow-up', 'Total', 'Target']].concat(rows.map(r =>
      [r.day, r.is_opd_day === false ? 'No' : 'Yes', r.day_note || '', Number(r.new_patients || 0), Number(r.followup_patients || 0), Number(r.total || 0), Number(r.target || m.target)]));
    const { xlsxBlob, downloadBlob } = await import('../../utils/xlsxWriter.js');
    downloadBlob(xlsxBlob([{ name: 'Summary', rows: summary }, { name: 'Daily', rows: daily }]), `ncism_opd_${from}_to_${to}.xlsx`);
  });

  load();
  fromI.focus();
  return { close: shut };
}
