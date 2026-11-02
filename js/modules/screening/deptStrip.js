// Session 374B (plan docs/handoff/session373_plan.md B9, contract §10.2): the purple NCISM strip on the Screening page.
//   Top line   = the SAME server count as reception (ncism_opd_daily; "Seen today (NCISM) N / target" + the 75 % hospital alert line).
//   Department bars = ncism_opd_dept_daily: patients seen today in each clinical department vs the HOSPITAL target (share × daily
//   target). NCISM sets no department-wise OPD figure (plan §A) -- every target is labelled "hospital target — not an NCISM rule".
//   "Screened, not yet seen by a department doctor: N" = screening_today_stats().screened_not_seen (information only).
//   📅 Date range: department totals for a period (≤ 400 days), a daily table, PDF + Excel.
// The strip INFORMS only: no department is coloured, ordered or suggested because it is short (B9) -- screening.js's complaint
// suggestion never reads this module.
// Owner 2 Nov 2026: F1 each department in its own colour (deptColours.js), always with its name; F2 a department bar opens that
// department's day-by-day chart (seen vs its daily target, the 75 % hospital alert line, a date range, PDF / Excel); G2 the PDFs print
// only their own document (printDocument + css/print.css).
import { stripModel, addDays } from '../reception/ncismStrip.js';
import { MAX_DAYS, quickRanges } from '../reception/ncismRange.js';
import { deptColour, deptLabel } from './deptColours.js';

export const TARGET_NOTE = 'hospital target — not an NCISM rule';
const oneDec = x => Math.round(x * 10) / 10;
const num = v => (v === null || v === undefined ? null : Number(v));

// rows = ncism_opd_dept_daily for ONE day -> bars [{ id, name, code, seen, target, stillNeeded, pct, sharePct }]; target null = none set
export function deptTodayModel(rows) {
  return (rows || []).map(r => {
    const seen = Number(r.seen || 0), target = num(r.target);
    return { id: r.department_id, name: r.department_name || '—', code: r.ncism_code || '', seen, target, sharePct: num(r.share_pct),
      stillNeeded: target === null ? null : Math.max(target - seen, 0), pct: target > 0 ? Math.round(seen * 100 / target) : null };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// deptRows = ncism_opd_dept_daily(from, to); dailyRows = ncism_opd_daily(from, to) (only for which days are OPD days)
// -> { opdDays, depts: [{ id, name, code, seen, targetPerDay, targetPeriod, avg, pct }], days: [day...] }
export function deptRangeModel(deptRows, dailyRows) {
  const offDays = new Set((dailyRows || []).filter(r => r.is_opd_day === false).map(r => r.day));
  const days = [...new Set([...(dailyRows || []).map(r => r.day), ...(deptRows || []).map(r => r.day)])].sort();
  const opdDays = days.filter(d => !offDays.has(d)).length;
  const by = new Map();
  for (const r of deptRows || []) {
    const k = r.department_id;
    const d = by.get(k) || { id: k, name: r.department_name || '—', code: r.ncism_code || '', seen: 0, targetPerDay: null, perDay: {} };
    d.seen += Number(r.seen || 0);
    d.perDay[r.day] = Number(r.seen || 0);
    if (r.target !== null && r.target !== undefined) d.targetPerDay = Number(r.target);   // the latest day's target wins (rows by day)
    by.set(k, d);
  }
  const depts = [...by.values()].map(d => {
    const targetPeriod = d.targetPerDay === null ? null : d.targetPerDay * opdDays;
    return { ...d, targetPeriod, avg: opdDays > 0 ? oneDec(d.seen / opdDays) : 0, pct: targetPeriod > 0 ? Math.round(d.seen * 100 / targetPeriod) : null };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { opdDays, depts, days };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const fmtFull = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function deptBar(b, i, onOpen) {
  // F2: the whole bar is a button that opens the department's own day-by-day chart
  const row = el('button', 'sd-dept');
  row.type = 'button';
  row.setAttribute('aria-label', `${b.name}: open the day-by-day chart`);
  if (onOpen) row.addEventListener('click', () => onOpen(b, i)); else row.disabled = true;
  const head = el('div', 'sd-dept-head');
  const name = el('span', 'sd-dept-name');
  name.append(deptLabel(b.name, b.code, i));
  head.append(name, el('span', 'sd-dept-num',
    b.target === null ? `Seen ${b.seen} · no hospital target set` : `Seen ${b.seen} of ${b.target} · still needed ${b.stillNeeded}`));
  const bar = el('div', 'sd-dept-bar');
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', b.target === null ? `${b.name}: ${b.seen} patients seen today; no hospital target set`
    : `${b.name}: ${b.seen} of ${b.target} patients seen today (hospital target, not an NCISM rule)`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(b.target || 0));
  bar.setAttribute('aria-valuenow', String(b.seen));
  const fill = el('div', 'sd-dept-fill');
  fill.style.background = deptColour(b.code, i);
  fill.style.width = `${b.target > 0 ? Math.min(100, Math.round(b.seen * 100 / b.target)) : 0}%`;
  bar.append(fill);
  row.append(head, bar);
  return row;
}

// root = <section id="scr-ncism-strip">. stats = screening_today_stats() (or null). Returns { settings } or null when hidden.
export async function mountScreeningStrip({ supabase, root, today, stats, onOpenRange, onOpenDept }) {
  if (!root) return null;
  const { data: settings, error: sErr } = await supabase.rpc('ncism_settings');
  if (sErr || !settings || !settings.ncism_type) { root.hidden = true; return null; }
  const [d, dd] = await Promise.all([
    supabase.rpc('ncism_opd_daily', { p_from: today, p_to: today }),
    supabase.rpc('ncism_opd_dept_daily', { p_from: today, p_to: today }),
  ]);
  root.hidden = false;
  root.replaceChildren();
  const inner = el('div', 'sd-inner');
  root.append(inner);
  if (d.error) {
    inner.append(el('span', 'nc-chip', 'NCISM OPD'), el('span', 'nc-msg', 'The NCISM count could not be loaded. Reload the page to try again.'));
    return null;
  }
  const m = stripModel({ settings, today, todayRow: (d.data || [])[0], yearRows: [], firstVisit: null });
  const top = el('div', 'sd-top');
  const chip = el('div', 'nc-chip', 'NCISM OPD · SCREENING');
  const line = el('div', 'sd-topline');
  line.append(el('strong', 'sd-big', `Seen today (NCISM) ${m.total} / ${m.target}`),
    el('span', m.moreToLine > 0 ? 'nc-more' : 'nc-ok', m.moreToLine > 0 ? `${m.moreToLine} more to reach ${m.alertPct}% (${m.line}) · hospital alert line (not an NCISM rule)` : `✓ ${m.alertPct}% hospital alert line reached`));
  const extra = el('div', 'sd-extra');
  if (stats && stats.screened_not_seen !== undefined && stats.screened_not_seen !== null) extra.append(el('span', null, `Screened, not yet seen by a department doctor: ${stats.screened_not_seen}`));
  const btn = el('button', 'nc-range-btn', '📅 Date range');
  btn.type = 'button';
  btn.id = 'scr-range-btn';
  btn.addEventListener('click', () => onOpenRange?.(settings));
  top.append(chip, line, extra, btn);

  const depts = el('div', 'sd-depts');
  if (dd.error) depts.append(el('div', 'nc-msg', 'The department figures could not be loaded.'));
  else {
    const bars = deptTodayModel(dd.data);
    if (!bars.length) depts.append(el('div', 'sd-note', 'No clinical department with an active OPD.'));
    bars.forEach((b, i) => depts.append(deptBar(b, i, onOpenDept ? (bb, ii) => onOpenDept(settings, bb, ii) : null)));
  }
  inner.append(top, depts, el('div', 'sd-note', `Department bars: patients seen today in that department's OPD(s) by a doctor · targets = ${TARGET_NOTE} (Admin → Feature Modules → OPD department targets).`));
  return { settings };
}

// The date-range dialog (reuses the reception dialog's look: css/reception.css .ncr-*). errorText = the page's safeErrorMessage.
export function openDeptRange({ supabase, today, settings, errorText, tenantName = '' }) {
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
  const h = el('h2', 'ncr-title', 'OPD departments — date range');
  h.id = 'ncr-title';
  titles.append(h, el('div', 'ncr-sub', `Patients seen in each clinical department (each patient once per day per department) · targets = ${TARGET_NOTE}`));
  const close = el('button', 'ncr-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the date-range view');
  head.append(titles, close);

  const ctl = el('div', 'ncr-ctl');
  const mk = (id, label) => { const w = el('div', 'ncr-fld'); const l = el('label', null, label); l.htmlFor = id; const i = el('input'); i.type = 'date'; i.id = id; w.append(l, i); return [w, i]; };
  const [fw, fromI] = mk('sdr-from', 'From');
  const [tw, toI] = mk('sdr-to', 'To');
  const qw = el('div', 'ncr-fld');
  const ql = el('label', null, 'Quick range'); ql.htmlFor = 'sdr-quick';
  const quick = el('select'); quick.id = 'sdr-quick';
  const ranges = quickRanges(today, settings?.academic_year_start_month ?? null);
  quick.append(new Option('— custom —', ''));
  ranges.forEach(r => quick.append(new Option(r.label, r.key)));
  qw.append(ql, quick);
  const show = el('button', 'ncr-btn ncr-btn-main', 'Show'); show.type = 'button';
  const pdf = el('button', 'ncr-btn', '🖨 PDF'); pdf.type = 'button'; pdf.id = 'sdr-pdf';
  const xls = el('button', 'ncr-btn', '⬇ Excel'); xls.type = 'button'; xls.id = 'sdr-xls';
  ctl.append(fw, tw, qw, show, pdf, xls);
  const msg = el('div', 'ncr-msg'); msg.setAttribute('role', 'status'); msg.id = 'sdr-msg';
  const body = el('div', 'ncr-body');
  box.append(head, ctl, msg, body);
  document.body.append(dlg);

  let model = null, from = '', to = '';
  const month = ranges.find(r => r.key === 'month');
  fromI.value = month.from; toI.value = month.to; fromI.max = today; toI.max = today; quick.value = 'month';
  const syncQuick = () => { quick.value = ranges.find(r => r.from === fromI.value && r.to === toI.value)?.key || ''; };
  ['input', 'change'].forEach(ev => { fromI.addEventListener(ev, syncQuick); toI.addEventListener(ev, syncQuick); });
  const shut = () => { dlg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') shut(); };
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', shut);
  dlg.addEventListener('click', e => { if (e.target === dlg) shut(); });
  quick.addEventListener('change', () => { const r = ranges.find(x => x.key === quick.value); if (r) { fromI.value = r.from; toI.value = r.to; load(); } });
  show.addEventListener('click', () => load());

  async function load() {
    msg.textContent = '';
    const f = fromI.value, t = toI.value;
    if (!f || !t) { msg.textContent = 'Choose both dates.'; return; }
    if (f > t) { msg.textContent = 'The From date is after the To date.'; return; }
    if ((Date.parse(t) - Date.parse(f)) / 86400000 + 1 > MAX_DAYS) { msg.textContent = `Choose a period of up to ${MAX_DAYS} days.`; return; }
    msg.textContent = 'Loading…';
    const [dd, d] = await Promise.all([supabase.rpc('ncism_opd_dept_daily', { p_from: f, p_to: t }), supabase.rpc('ncism_opd_daily', { p_from: f, p_to: t })]);
    const e = dd.error || d.error;
    if (e) { msg.textContent = errorText(e, 'The department figures could not be loaded.'); body.replaceChildren(); model = null; return; }
    from = f; to = t;
    model = deptRangeModel(dd.data || [], d.data || []);
    msg.textContent = '';
    render();
  }
  const HEAD = ['Department', 'Seen', 'Average per OPD day', 'Hospital target / day', 'Target for period', '% of target'];
  const deptCells = (x, i) => [deptLabel(x.name, x.code, i), String(x.seen), String(x.avg), x.targetPerDay === null ? '—' : String(x.targetPerDay), x.targetPeriod === null ? '—' : String(x.targetPeriod), x.pct === null ? '—' : `${x.pct}%`];
  const table = cellTable;
  function dailyRows() { return model.days.map(day => [fmtFull(day), ...model.depts.map(x => String(x.perDay[day] ?? 0))]); }
  const dailyHead = () => ['Day', ...model.depts.map((x, i) => deptLabel(x.name, x.code, i))];
  function render() {
    const cards = el('div', 'ncr-cards');
    const card = (l, v, s) => { const c = el('div', 'ncr-card'); c.append(el('div', 'ncr-card-l', l), el('div', 'ncr-card-v', v)); if (s) c.append(el('div', 'ncr-card-s', s)); return c; };
    cards.append(card('OPD days', String(model.opdDays), 'weekly off and holidays left out'),
      card('Seen in departments', String(model.depts.reduce((s, x) => s + x.seen, 0)), 'a patient seen in two departments counts in both'));
    const main = table(HEAD, model.depts.map(deptCells));
    main.id = 'sdr-table';
    const det = el('details', 'ncr-table-wrap');
    det.append(el('summary', null, 'Show the daily figures per department'), table(dailyHead(), dailyRows()));
    body.replaceChildren(cards, main, el('div', 'ncr-note', `Targets are the ${TARGET_NOTE}: share × the daily target, set by the Super Admin.`), det);
  }
  pdf.addEventListener('click', async () => {
    if (!model) { msg.textContent = 'Press Show first.'; return; }
    const { printDocument, docHeader } = await import('../../utils/printDocument.js');
    const hdr = docHeader('OPD departments — patients seen', `Period: ${fmtFull(from)} – ${fmtFull(to)} · targets = ${TARGET_NOTE}`);
    const org = hdr.querySelector('.ax-doc-org'); if (org && !org.textContent && tenantName) org.textContent = tenantName;
    printDocument([hdr, table(HEAD, model.depts.map(deptCells)), el('div', 'ncr-print-h', 'Daily figures'), table(dailyHead(), dailyRows())],
      { title: `OPD departments ${from} to ${to}`, size: 'A4-clean' });
  });
  xls.addEventListener('click', async () => {
    if (!model) { msg.textContent = 'Press Show first.'; return; }
    const { xlsxBlob, downloadBlob } = await import('../../utils/xlsxWriter.js');
    const summary = [['OPD departments — patients seen', `${from} to ${to}`], ['Targets', TARGET_NOTE], ['OPD days', model.opdDays], [],
      HEAD].concat(model.depts.map(x => [x.name, x.seen, x.avg, x.targetPerDay ?? '', x.targetPeriod ?? '', x.pct ?? '']));
    const daily = [['Day', ...model.depts.map(x => x.name)]].concat(model.days.map(day => [day, ...model.depts.map(x => x.perDay[day] ?? 0)]));
    downloadBlob(xlsxBlob([{ name: 'Departments', rows: summary }, { name: 'Daily', rows: daily }]), `opd_departments_${from}_to_${to}.xlsx`);
  });
  load();
  fromI.focus();
  return { close: shut };
}

// a table whose cells are text or DOM nodes (a department's colour dot + name)
function cellTable(headRow, rows) {
  const t = el('table', 'ncr-table');
  const th = el('thead'); const tr = el('tr');
  headRow.forEach(x => { const c = el('th'); c.scope = 'col'; c.append(x instanceof Node ? x : document.createTextNode(String(x))); tr.append(c); });
  th.append(tr);
  const tb = el('tbody');
  rows.forEach(r => { const row = el('tr'); r.forEach(v => { const c = el('td'); c.append(v instanceof Node ? v : document.createTextNode(String(v))); row.append(c); }); tb.append(row); });
  t.append(th, tb);
  return t;
}

// F2: one department, day by day. deptRows = ncism_opd_dept_daily(from, to) (all departments), dailyRows = ncism_opd_daily(from, to)
// (which days are OPD days), alertPct = the hospital's alert line (75). -> { days: [{ day, seen, target, line, off, offNote }], opdDays,
// total, avg, metLine, metTarget }
export function deptChartModel(deptRows, dailyRows, deptId, alertPct = 75) {
  const off = new Map((dailyRows || []).filter(r => r.is_opd_day === false).map(r => [r.day, r.day_note || 'no OPD']));
  const mine = (deptRows || []).filter(r => r.department_id === deptId).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const days = mine.map(r => {
    const target = num(r.target);
    return { day: r.day, seen: Number(r.seen || 0), target, line: target === null ? null : Math.ceil(target * alertPct / 100),
             off: off.has(r.day), offNote: off.get(r.day) || '' };
  });
  const open = days.filter(d => !d.off);
  const total = days.reduce((s, d) => s + d.seen, 0);
  return { days, opdDays: open.length, total, avg: open.length ? oneDec(open.reduce((s, d) => s + d.seen, 0) / open.length) : 0,
           metLine: open.filter(d => d.line !== null && d.seen >= d.line).length,
           metTarget: open.filter(d => d.target !== null && d.seen >= d.target).length };
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}
const shortDay = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });

// the bar chart (SVG built from nodes -- no HTML strings): a bar per day in the department's colour, the daily target as a dashed line,
// the alert line as a dotted line, days without OPD in grey with "off"
export function deptChartSvg(model, colour, alertPct = 75) {
  const W = 760, H = 270, L = 40, R = 12, T = 14, B = 46;
  const n = Math.max(model.days.length, 1);
  const max = Math.max(1, ...model.days.map(d => Math.max(d.seen, d.target || 0)));
  const y = v => T + (H - T - B) * (1 - v / max);
  const bw = (W - L - R) / n;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', class: 'sdc-svg' });
  root.append(svg('title', {}, `Patients seen per day, with the daily target and the ${alertPct}% hospital alert line`));
  [0, 0.5, 1].forEach(f => {
    const v = Math.round(max * f);
    root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#e0e6e2', 'stroke-width': 1 }),
      svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#3d5a47' }, String(v)));
  });
  const every = Math.ceil(n / 15);
  model.days.forEach((d, i) => {
    const x = L + i * bw, w = Math.max(1, bw * 0.7);
    const bar = svg('rect', { x: x + bw * 0.15, y: y(d.seen), width: w, height: Math.max(0, H - B - y(d.seen)), fill: d.off ? '#b9c2bc' : colour,
      'data-day': d.day, class: 'sdc-bar' });
    bar.append(svg('title', {}, `${shortDay(d.day)}: seen ${d.seen}${d.target !== null ? ` of ${d.target}` : ''}${d.off ? ` (${d.offNote})` : ''}`));
    root.append(bar);
    if (d.off) root.append(svg('text', { x: x + bw / 2, y: H - B - 3, 'text-anchor': 'middle', 'font-size': 9, fill: '#3d5a47' }, 'off'));
    if (i % every === 0) root.append(svg('text', { x: x + bw / 2, y: H - B + 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#3d5a47' }, shortDay(d.day)));
  });
  const path = key => model.days.map((d, i) => (d[key] === null ? null : `${L + i * bw},${y(d[key])} ${L + (i + 1) * bw},${y(d[key])}`)).filter(Boolean).join(' ');
  const tp = path('target'), lp = path('line');
  if (tp) root.append(svg('polyline', { points: tp, fill: 'none', stroke: '#1a2e22', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }));
  if (lp) root.append(svg('polyline', { points: lp, fill: 'none', stroke: '#c9902a', 'stroke-width': 2, 'stroke-dasharray': '2 3' }));
  // the key (words, never colour alone)
  const ky = H - 12;
  root.append(svg('rect', { x: L, y: ky - 8, width: 12, height: 8, fill: colour }), svg('text', { x: L + 16, y: ky, 'font-size': 11, fill: '#1a2e22' }, 'Seen'),
    svg('line', { x1: L + 70, x2: L + 94, y1: ky - 4, y2: ky - 4, stroke: '#1a2e22', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }),
    svg('text', { x: L + 98, y: ky, 'font-size': 11, fill: '#1a2e22' }, `Daily target (${TARGET_NOTE})`),
    svg('line', { x1: L + 400, x2: L + 424, y1: ky - 4, y2: ky - 4, stroke: '#c9902a', 'stroke-width': 2, 'stroke-dasharray': '2 3' }),
    svg('text', { x: L + 428, y: ky, 'font-size': 11, fill: '#1a2e22' }, `${alertPct}% hospital alert line`));
  return root;
}

// the dialog (same look as the date-range one)
export function openDeptChart({ supabase, today, settings, dept, index = 0, errorText, tenantName = '' }) {
  document.getElementById('ncr-dialog')?.remove();
  const alertPct = Number(settings?.alert_pct) || 75;
  const colour = deptColour(dept.code, index);
  const dlg = el('div', 'ncr-overlay');
  dlg.id = 'ncr-dialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-labelledby', 'ncr-title');
  const box = el('div', 'ncr-box');
  dlg.append(box);
  const head = el('div', 'ncr-head');
  const titles = el('div', 'ncr-titles');
  const h = el('h2', 'ncr-title');
  h.id = 'ncr-title';
  h.append(deptLabel(dept.name, dept.code, index), document.createTextNode(' — day by day'));
  titles.append(h, el('div', 'ncr-sub', `Patients seen per day in this department vs its daily target · targets = ${TARGET_NOTE}`));
  const close = el('button', 'ncr-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the department chart');
  head.append(titles, close);
  const ctl = el('div', 'ncr-ctl');
  const mk = (id, label) => { const w = el('div', 'ncr-fld'); const l = el('label', null, label); l.htmlFor = id; const i = el('input'); i.type = 'date'; i.id = id; w.append(l, i); return [w, i]; };
  const [fw, fromI] = mk('sdc-from', 'From');
  const [tw, toI] = mk('sdc-to', 'To');
  const qw = el('div', 'ncr-fld');
  const ql = el('label', null, 'Quick range'); ql.htmlFor = 'sdc-quick';
  const quick = el('select'); quick.id = 'sdc-quick';
  const ranges = quickRanges(today, settings?.academic_year_start_month ?? null);
  quick.append(new Option('— custom —', ''));
  ranges.forEach(r => quick.append(new Option(r.label, r.key)));
  qw.append(ql, quick);
  const show = el('button', 'ncr-btn ncr-btn-main', 'Show'); show.type = 'button';
  const pdf = el('button', 'ncr-btn', '🖨 PDF'); pdf.type = 'button'; pdf.id = 'sdc-pdf';
  const xls = el('button', 'ncr-btn', '⬇ Excel'); xls.type = 'button'; xls.id = 'sdc-xls';
  ctl.append(fw, tw, qw, show, pdf, xls);
  const msg = el('div', 'ncr-msg'); msg.setAttribute('role', 'status'); msg.id = 'sdc-msg';
  const body = el('div', 'ncr-body');
  box.append(head, ctl, msg, body);
  document.body.append(dlg);

  let model = null, from = '', to = '';
  const month = ranges.find(r => r.key === 'month');
  fromI.value = month.from; toI.value = month.to; fromI.max = today; toI.max = today; quick.value = 'month';
  const syncQuick = () => { quick.value = ranges.find(r => r.from === fromI.value && r.to === toI.value)?.key || ''; };
  ['input', 'change'].forEach(ev => { fromI.addEventListener(ev, syncQuick); toI.addEventListener(ev, syncQuick); });
  const shut = () => { dlg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') shut(); };
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', shut);
  dlg.addEventListener('click', e => { if (e.target === dlg) shut(); });
  quick.addEventListener('change', () => { const r = ranges.find(x => x.key === quick.value); if (r) { fromI.value = r.from; toI.value = r.to; load(); } });
  show.addEventListener('click', () => load());

  const HEAD = ['Day', 'Seen', 'Daily target', `${alertPct}% line`, 'Reached'];
  // V7 (owner 2 Nov 2026): a day's bar (or its row) -> that day's patients of THIS department (the same count as the bar), PDF / Excel
  const dayBox = el('div', 'sdc-day');
  dayBox.id = 'sdc-day';
  dayBox.setAttribute('aria-live', 'polite');
  let dayRows = null, dayIso = '';
  const DAY_HEAD = ['#', 'UHID', 'Name', 'New / Return', 'OPD', 'First seen'];
  const dayCells = () => dayRows.map((r, i) => [String(i + 1), r.uhid || '—', r.name || '—', r.is_new ? 'New' : 'Return', r.opd_name || '—',
    r.first_seen ? new Date(r.first_seen).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—']);
  async function showDay(day) {
    dayIso = day; dayRows = null;
    dayBox.replaceChildren(el('div', 'ncr-msg', 'Loading the patients…'));
    const { data, error } = await supabase.rpc('ncism_opd_dept_day_list', { p_day: day, p_department: dept.id });
    if (dayIso !== day) return;
    if (error) { dayBox.replaceChildren(el('div', 'ncr-msg', errorText(error, 'The patients of that day could not be loaded.'))); return; }
    dayRows = data || [];
    const head = el('div', 'ncr-ctl');
    const title = el('h3', 'ncr-print-h', `${dept.name} — ${fmtFull(day)}: ${dayRows.length} patient${dayRows.length === 1 ? '' : 's'}`);
    const dp = el('button', 'ncr-btn', '🖨 PDF of the day'); dp.type = 'button'; dp.id = 'sdc-day-pdf';
    const dx = el('button', 'ncr-btn', '⬇ Excel of the day'); dx.type = 'button'; dx.id = 'sdc-day-xls';
    head.append(dp, dx);
    dp.addEventListener('click', async () => {
      const { printDocument, docHeader } = await import('../../utils/printDocument.js');
      const hdr = docHeader(`${dept.name} — patients seen on ${fmtFull(day)}`, `${dayRows.length} patient${dayRows.length === 1 ? '' : 's'} · the NCISM count (each patient once)`);
      const org = hdr.querySelector('.ax-doc-org'); if (org && !org.textContent && tenantName) org.textContent = tenantName;
      printDocument([hdr, cellTable(DAY_HEAD, dayCells())], { title: `${dept.name} ${day}`, size: 'A4-clean' });
    });
    dx.addEventListener('click', async () => {
      const { xlsxBlob, downloadBlob } = await import('../../utils/xlsxWriter.js');
      downloadBlob(xlsxBlob([{ name: 'Patients', rows: [[`${dept.name} — patients seen`, day], [], DAY_HEAD].concat(dayCells()) }]),
        `opd_${String(dept.code || 'dept').toLowerCase()}_patients_${day}.xlsx`);
    });
    dayBox.replaceChildren(title, dayRows.length ? cellTable(DAY_HEAD, dayCells()) : el('div', 'ncr-msg', 'No patient counted in this department that day.'), head);
    dayBox.scrollIntoView?.({ block: 'nearest' });
  }
  function wireDays(svgEl, tbl) {
    svgEl.querySelectorAll('rect.sdc-bar').forEach(r => {
      const day = r.getAttribute('data-day');
      r.setAttribute('role', 'button'); r.setAttribute('tabindex', '0'); r.style.cursor = 'pointer';
      r.setAttribute('aria-label', `${fmtFull(day)}: show the patients`);
      r.addEventListener('click', () => showDay(day));
      r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDay(day); } });
    });
    tbl.querySelectorAll('tbody tr').forEach((tr, i) => {
      const d = model.days[i]; if (!d) return;
      const td = tr.firstElementChild; const b = el('button', 'ncr-day-btn', td.textContent); b.type = 'button';
      b.setAttribute('aria-label', `${fmtFull(d.day)}: show the patients`);
      b.addEventListener('click', () => showDay(d.day));
      td.replaceChildren(b);
    });
  }
  const rowsOf = () => model.days.map(d => [fmtFull(d.day), String(d.seen), d.target === null ? '—' : String(d.target), d.line === null ? '—' : String(d.line),
    d.off ? `no OPD (${d.offNote})` : d.target === null ? '—' : d.seen >= d.target ? 'target' : d.seen >= d.line ? `${alertPct}% line` : 'below the line']);
  const summary = () => {
    const cards = el('div', 'ncr-cards');
    const card = (l, v, sub) => { const c = el('div', 'ncr-card'); c.append(el('div', 'ncr-card-l', l), el('div', 'ncr-card-v', v)); if (sub) c.append(el('div', 'ncr-card-s', sub)); return c; };
    cards.append(card('Seen in the period', String(model.total)), card('OPD days', String(model.opdDays), 'weekly off and holidays left out'),
      card('Average per OPD day', String(model.avg)), card(`Days at the ${alertPct}% line`, String(model.metLine), `of ${model.opdDays}`),
      card('Days at the target', String(model.metTarget), `of ${model.opdDays}`));
    return cards;
  };
  async function load() {
    msg.textContent = '';
    const f = fromI.value, t = toI.value;
    if (!f || !t) { msg.textContent = 'Choose both dates.'; return; }
    if (f > t) { msg.textContent = 'The From date is after the To date.'; return; }
    if ((Date.parse(t) - Date.parse(f)) / 86400000 + 1 > MAX_DAYS) { msg.textContent = `Choose a period of up to ${MAX_DAYS} days.`; return; }
    msg.textContent = 'Loading…';
    const [dd, d] = await Promise.all([supabase.rpc('ncism_opd_dept_daily', { p_from: f, p_to: t }), supabase.rpc('ncism_opd_daily', { p_from: f, p_to: t })]);
    const e = dd.error || d.error;
    if (e) { msg.textContent = errorText(e, 'The department figures could not be loaded.'); body.replaceChildren(); model = null; return; }
    from = f; to = t;
    model = deptChartModel(dd.data || [], d.data || [], dept.id, alertPct);
    msg.textContent = model.days.length ? '' : 'No figures for this department in the period.';
    const det = el('details', 'ncr-table-wrap');
    const tbl = cellTable(HEAD, rowsOf());
    det.append(el('summary', null, 'Show the figures day by day'), tbl);
    const chart = deptChartSvg(model, colour, alertPct);
    wireDays(chart, tbl);
    dayRows = null; dayIso = ''; dayBox.replaceChildren(el('div', 'ncr-note', 'Click a day\'s bar (or the day in the table) to see that day\'s patients.'));
    body.replaceChildren(summary(), chart, dayBox, det);
  }
  pdf.addEventListener('click', async () => {
    if (!model) { msg.textContent = 'Press Show first.'; return; }
    const { printDocument, docHeader } = await import('../../utils/printDocument.js');
    const hdr = docHeader(`${dept.name} — patients seen per day`, `Period: ${fmtFull(from)} – ${fmtFull(to)} · targets = ${TARGET_NOTE}`);
    const org = hdr.querySelector('.ax-doc-org'); if (org && !org.textContent && tenantName) org.textContent = tenantName;
    printDocument([hdr, summary(), deptChartSvg(model, colour, alertPct), cellTable(HEAD, rowsOf())], { title: `${dept.name} ${from} to ${to}`, size: 'A4-clean' });
  });
  xls.addEventListener('click', async () => {
    if (!model) { msg.textContent = 'Press Show first.'; return; }
    const { xlsxBlob, downloadBlob } = await import('../../utils/xlsxWriter.js');
    const rows = [[`${dept.name} — patients seen per day`, `${from} to ${to}`], ['Targets', TARGET_NOTE], ['Seen', model.total], ['OPD days', model.opdDays],
      ['Average per OPD day', model.avg], [], HEAD].concat(model.days.map(d => [d.day, d.seen, d.target ?? '', d.line ?? '', d.off ? `no OPD (${d.offNote})` : '']));
    downloadBlob(xlsxBlob([{ name: 'Day by day', rows }]), `opd_${String(dept.code || 'dept').toLowerCase()}_${from}_to_${to}.xlsx`);
  });
  load();
  fromI.focus();
  return { close: shut };
}

export { addDays };
