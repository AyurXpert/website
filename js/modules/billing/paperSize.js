// Paper sizes for printed documents (Session 336): A4 (default) · A5 · Thermal 80 mm · Thermal 58 mm.
// One shared helper so every print can adopt it (pharmacy bill, receipt and shift handover slip first; OPD / lab /
// invoice prints next -- TODO_LATER.md §130). Styling: css/paper-size.css.
//
// Choosing a size NEVER records a print: it only re-lays out what is already on the page (or, for printDocument
// slips, is used at the next print). The print audit (record_document_print) stays exactly where it was.
// The choice is remembered per device (localStorage, guarded -- falls back to A4).
import { renderInvoice } from './invoiceLayout.js';
import { DEMO_TEXT } from './demoBanner.js';
import { setPrintPageSize } from '../../utils/printPageSize.js';

export const PAPER_SIZES = [
  { key: 'a4',  label: 'A4' },
  { key: 'a5',  label: 'A5' },
  { key: 't80', label: 'Thermal 80 mm' },
  { key: 't58', label: 'Thermal 58 mm' },
];
const KEY = 'ax_paper_size';
const VALID = new Set(PAPER_SIZES.map(s => s.key));

export function getPaperSize() {
  try { const v = localStorage.getItem(KEY); return VALID.has(v) ? v : 'a4'; } catch { return 'a4'; }
}
export function setPaperSize(v) {
  if (!VALID.has(v)) return;
  try { localStorage.setItem(KEY, v); } catch { /* private mode etc. -- still applies to this page */ }
}
export const isThermal = size => size === 't80' || size === 't58';

// <html data-paper="..."> drives css/paper-size.css for the bill and receipt pages
export function applyPaperSize(size) {
  document.documentElement.dataset.paper = VALID.has(size) ? size : 'a4';
}

// Keeps the PRINTED page size (@page, js/utils/printPageSize.js) in step with the chosen paper for a dedicated print
// page: now, once web fonts have loaded (they change the thermal height), and again just before every print
// (Ctrl+P or the Print button). getEl() returns the element that prints. Call refreshPrintPageSize() after a re-render.
let _getEl = null;
export function refreshPrintPageSize() {
  if (_getEl) setPrintPageSize(document.documentElement.dataset.paper || 'a4', _getEl());
}
export function watchPrintPageSize(getEl) {
  _getEl = getEl;
  refreshPrintPageSize();
  document.fonts?.ready?.then(refreshPrintPageSize).catch(() => { /* fonts unavailable -- already set */ });
  window.addEventListener('beforeprint', refreshPrintPageSize);
}

// An accessible <select> (44 px) placed in `container`; onChange(size) after the choice is stored + applied.
export function mountPaperSizeSelect(container, onChange) {
  if (!container) return null;
  const id = `ax-paper-${Math.random().toString(36).slice(2, 8)}`;
  const wrap = document.createElement('label');
  wrap.className = 'ax-paper-pick no-print';
  wrap.htmlFor = id;
  wrap.appendChild(document.createTextNode('Paper'));
  const sel = document.createElement('select');
  sel.id = id;
  sel.setAttribute('aria-label', 'Paper size');
  for (const s of PAPER_SIZES) {
    const o = document.createElement('option');
    o.value = s.key; o.textContent = s.label;
    sel.appendChild(o);
  }
  sel.value = getPaperSize();
  sel.addEventListener('change', () => {
    setPaperSize(sel.value); applyPaperSize(sel.value);
    if (onChange) onChange(sel.value);
    refreshPrintPageSize();   // printed page follows the new layout (no-op where watchPrintPageSize wasn't called)
  });
  wrap.appendChild(sel);
  container.appendChild(wrap);
  return sel;
}

// Renders an invoiceLayout model at the chosen size: A4 / A5 = the standard layout (A5 is scaled by CSS); thermal =
// renderThermal. Same model, so nothing legally required differs between sizes.
export function renderDocument(sheet, model, size) {
  if (isThermal(size)) renderThermal(sheet, model);
  else renderInvoice(sheet, model);
}

function n(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === '') continue;
    e.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
  return e;
}
const kv = (k, v, cls) => n('div', `th-kv${cls ? ' ' + cls : ''}`, n('span', null, k), n('span', null, v ?? '—'));
const rule = () => n('div', 'th-rule');

// Thermal roll layout from the same invoiceLayout model: compact header, one column, each item as two lines
// (name; then batch · exp · qty × rate = amount), totals, receipts, words, signatures, footer. DOM nodes only.
export function renderThermal(sheet, m) {
  const doc = n('div', 'th-doc');
  if (m.demo) doc.appendChild(n('div', 'demo-banner', DEMO_TEXT));

  // header
  doc.appendChild(n('div', 'th-org', m.org?.name || ''));
  for (const l of m.org?.lines || []) doc.appendChild(n('div', 'th-orgline', l));
  doc.appendChild(n('div', 'th-title', m.title));
  if (m.subtitle) doc.appendChild(n('div', 'th-sub', m.subtitle));
  if (m.watermark) doc.appendChild(n('div', 'th-copy', m.watermark));
  doc.appendChild(rule());

  // bill no. / date / prescriber ...
  for (const f of m.meta || []) doc.appendChild(kv(f.label, [f.value, f.sub ? ` (${f.sub})` : ''].join('')));
  doc.appendChild(rule());

  // patient
  for (const f of m.party?.fields || []) doc.appendChild(kv(f.label, f.value));
  doc.appendChild(rule());

  // items: two lines each
  for (const s of m.sections || []) {
    if (s.title && (m.sections.length > 1)) doc.appendChild(n('div', 'th-line1', s.title));
    for (const r of s.rows) {
      doc.appendChild(n('div', 'th-line1', `${r.no}. ${r.description}`));
      const parts = [];
      if (r.sub) parts.push(r.sub);
      if (m.gst) {
        if (r.code) parts.push(`HSN ${r.code}`);
        if (r.gstLabel && r.gstLabel !== '—') parts.push(`GST ${r.gstLabel}`);
      }
      parts.push(`${r.qty} × ${r.rate} = ${r.amount}`);
      doc.appendChild(n('div', 'th-line2', parts.join(' · ')));
    }
    if (m.sections.length > 1) doc.appendChild(kv(`${s.title} subtotal`, s.subtotal, 'th-small'));
  }
  if (!(m.sections || []).length && m.emptyNote) doc.appendChild(n('div', 'th-small', m.emptyNote));
  if (m.taxNote) doc.appendChild(n('div', 'th-small', m.taxNote));
  doc.appendChild(rule());

  // totals
  for (const r of m.summary?.rows || []) doc.appendChild(kv(r.label, r.value, r.grand ? 'th-grand' : null));
  if (m.summary?.balance) doc.appendChild(kv(m.summary.balance.label, m.summary.balance.value, 'th-grand'));

  // GST tax summary
  if (m.taxSummary && m.taxSummary.length) {
    doc.appendChild(rule());
    doc.appendChild(n('div', 'th-line1', 'Tax summary'));
    for (const t of m.taxSummary) {
      doc.appendChild(n('div', 'th-line2', `${t.label}: value ${t.value} · CGST ${t.cgst} · SGST ${t.sgst} · tax ${t.tax}`));
    }
  }

  // receipts
  if (m.payments) {
    doc.appendChild(rule());
    doc.appendChild(n('div', 'th-line1', m.payments.title || 'Payments'));
    for (const p of m.payments.rows) {
      const line = n('div', p.voided ? 'th-line2 th-void' : 'th-line2',
        [p.receiptNo, p.date].filter(Boolean).join(' · '), n('br'),
        [p.type, p.mode, p.by && p.by !== '—' ? `by ${p.by}` : null, p.amount].filter(Boolean).join(' · '));
      doc.appendChild(line);
      if (p.voided) doc.appendChild(n('div', 'th-small', `VOID — ${p.voidReason || 'no reason recorded'} (not counted)`));
    }
    doc.appendChild(kv(m.payments.totalLabel, m.payments.total, 'th-small'));
  }

  // amount in words
  if (m.words) {
    doc.appendChild(rule());
    doc.appendChild(n('div', 'th-small', m.words.label));
    for (const l of m.words.lines) doc.appendChild(n('div', null, l));
  }

  // signatures
  doc.appendChild(rule());
  for (const l of m.signatures?.left || []) doc.appendChild(n('div', 'th-small', l));
  doc.appendChild(n('div', null, ' '));
  for (const l of m.signatures?.right || []) doc.appendChild(n('div', 'th-small th-c', l));

  // footer
  doc.appendChild(rule());
  for (const l of m.footer || []) doc.appendChild(n('div', 'th-small th-c', l));

  sheet.replaceChildren(doc);
}
