// Shared print isolation — prints ONLY the document, never the page around it.
//
// printDocument(source, { title, size })
//   source — an Element, or an array of Elements printed in order (e.g. a report header
//            + its result rows that live in different places on the page).
//   title  — optional; set as document.title while printing (it becomes the PDF file name
//            and the browser's header text), restored afterwards.
//   size   — optional; 'A4' (default, portrait), 'A4-landscape' or 'A3-landscape' for wide
//            registers/flowsheets.
//
// How it works: the source is deep-cloned into a fresh `.ax-print-root` container appended
// as the LAST child of <body>, and <body> gets the `ax-printing` class. css/print.css then
// hides every other direct child of <body> while printing — a true allowlist, so a new
// banner, drawer, navbar or message added anywhere on the page later can never leak onto
// paper (the old per-page hide-lists leaked anything they didn't name; see TODO_LATER §77).
// Form controls are replaced by plain text in the clone, because a cloned <input>/<select>/
// <textarea> prints as an empty box or a placeholder, not as what the user typed.
// Everything is removed again on `afterprint`.
//
// The page must load css/print.css. CSP-safe: no inline script, no injected <style>.
// Dedicated print pages (printInvoice.html etc.) don't need this function — they wrap their
// document in <div class="ax-print-root"> and put `ax-printing` on <body> directly.
// Popups (e.g. the dispensary medicine label) are their own document and need neither —
// they just call w.print() from script, never an inline onload (blocked by our CSP).

import { setPrintPageSize, clearPrintPageSize } from './printPageSize.js';

const ROOT_CLASS = 'ax-print-root';
const TEMP_CLASS = 'ax-print-root--temp';
const BODY_CLASS = 'ax-printing';

let _cleanup = null;

// + Session 336 paper sizes for slips / receipts: 'a5', 't80', 't58' (css/paper-size.css; 'a4' = no class)
const SIZES = new Set(['A4-landscape', 'A3-landscape', 'a5', 't80', 't58']);
const PAPER_SIZES = new Set(['a5', 't80', 't58']);

export function printDocument(source, { title, size } = {}) {
  const sources = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (!sources.length) return;

  // A previous print whose afterprint never fired (e.g. the dialog was closed oddly) —
  // clear it so two documents can never print together.
  if (_cleanup) _cleanup();

  const root = document.createElement('div');
  root.className = `${ROOT_CLASS} ${TEMP_CLASS}`;
  if (SIZES.has(size)) root.classList.add(`ax-size-${size}`);
  root.setAttribute('aria-hidden', 'true');   // a duplicate of on-screen content
  sources.forEach(src => root.appendChild(_cloneForPrint(src)));

  document.body.appendChild(root);
  document.body.classList.add(BODY_CLASS);
  const prevTitle = document.title;
  if (title) document.title = title;

  // A5 / thermal: the printed page itself must change size (Chrome ignores a roll's `auto` height, so the
  // slip is measured at the roll width -- js/utils/printPageSize.js). A4 / landscape keep css/print.css.
  const paper = PAPER_SIZES.has(size) ? size : null;
  if (paper) setPrintPageSize(paper, root);

  _cleanup = () => {
    if (paper) clearPrintPageSize();
    root.remove();
    document.body.classList.remove(BODY_CLASS);
    document.title = prevTitle;
    window.removeEventListener('afterprint', _cleanup);
    _cleanup = null;
  };
  window.addEventListener('afterprint', _cleanup);

  window.print();
}

// Keeps only the elements currently visible on screen — for sections that are hidden because
// they don't apply yet (no patient selected, empty state), as opposed to print-only holders
// like #mc-print, which printDocument() deliberately shows.
export function shown(...els) {
  return els.filter(el => el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
}

// Standard printed letterhead for registers/logs that have none of their own: hospital name
// (from the logged-in tenant), document title, optional subtitle, printed date. Pass it as the
// first element: printDocument([docHeader('ANC Register', patientName), tableEl], ...).
export function docHeader(title, subtitle = '') {
  let tenant = {};
  try { tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}') || {}; } catch { /* none */ }
  const printed = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = 'ax-doc-header';
  const name = document.createElement('div'); name.className = 'ax-doc-org';   name.textContent = tenant.name || '';
  const t    = document.createElement('div'); t.className    = 'ax-doc-title'; t.textContent    = title;
  el.append(name, t);
  if (subtitle) { const s = document.createElement('div'); s.className = 'ax-doc-sub'; s.textContent = subtitle; el.append(s); }
  const p = document.createElement('div'); p.className = 'ax-doc-printed'; p.textContent = `Printed: ${printed}`;
  el.append(p);
  return el;
}

function _cloneForPrint(src) {
  const clone = src.cloneNode(true);
  _freezeFormValues(src, clone);

  // The source is often a hidden on-screen holder (display:none until print, inline or via a
  // class rule like `.print-header{display:none}`) — the clone must be visible in the root.
  clone.removeAttribute?.('hidden');
  if (clone.style) {
    if (clone.style.display === 'none') clone.style.display = '';
    if (getComputedStyle(src).display === 'none') clone.style.setProperty('display', 'block', 'important');
  }

  // The source's own id usually carries a "hidden on screen" rule (#mc-print{display:none}),
  // so the copy's root drops it. Descendant ids are kept so register pages' #id-based table
  // styling still applies on paper; getElementById keeps finding the original, which comes
  // first in the document (the print root is <body>'s last child). No live handlers.
  clone.removeAttribute('id');
  [clone, ...clone.querySelectorAll('*')].forEach(el => {
    for (const a of [...el.attributes]) {
      if (a.name.startsWith('data-on')) el.removeAttribute(a.name);
    }
  });
  return clone;
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'button', 'submit', 'reset', 'image', 'file']);
const FIELDS = 'input,select,textarea';

// Pair original and cloned controls by document order (a deep clone keeps the same order)
// and swap each cloned control for a <span> holding the value the user actually entered.
function _freezeFormValues(src, clone) {
  const origs  = src.matches?.(FIELDS)   ? [src]   : [...src.querySelectorAll(FIELDS)];
  const copies = clone.matches?.(FIELDS) ? [clone] : [...clone.querySelectorAll(FIELDS)];
  origs.forEach((orig, i) => {
    const copy = copies[i];
    if (!copy || copy === clone) return;
    const tag  = orig.tagName;
    const type = (orig.type || '').toLowerCase();
    if (tag === 'INPUT' && SKIP_INPUT_TYPES.has(type)) { copy.remove(); return; }

    const span = document.createElement('span');
    span.className = `${orig.className || ''} ax-print-field`.trim();
    span.textContent = _displayValue(orig, tag, type);
    copy.replaceWith(span);
  });
}

function _displayValue(el, tag, type) {
  if (tag === 'SELECT') {
    return [...el.selectedOptions]
      .filter(o => o.value !== '')            // "— Select —" placeholders print as blank
      .map(o => o.textContent.trim())
      .join(', ');
  }
  if (tag === 'TEXTAREA') return el.value;
  if (type === 'checkbox' || type === 'radio') return el.checked ? '☑' : '☐';
  if (!el.value) return '';
  if (type === 'date') return _fmt(el.value + 'T00:00', { day:'2-digit', month:'short', year:'numeric' });
  if (type === 'datetime-local') return _fmt(el.value, { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  return el.value;
}

function _fmt(v, opts) {
  const d = new Date(v);
  return isNaN(d) ? v : d.toLocaleString('en-IN', opts);
}
