// Shared print isolation — prints ONLY the document, never the page around it.
//
// printDocument(source, { title })
//   source — an Element, or an array of Elements printed in order (e.g. a report header
//            + its result rows that live in different places on the page).
//   title  — optional; set as document.title while printing (it becomes the PDF file name
//            and the browser's header text), restored afterwards.
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

const ROOT_CLASS = 'ax-print-root';
const TEMP_CLASS = 'ax-print-root--temp';
const BODY_CLASS = 'ax-printing';

let _cleanup = null;

export function printDocument(source, { title } = {}) {
  const sources = (Array.isArray(source) ? source : [source]).filter(Boolean);
  if (!sources.length) return;

  // A previous print whose afterprint never fired (e.g. the dialog was closed oddly) —
  // clear it so two documents can never print together.
  if (_cleanup) _cleanup();

  const root = document.createElement('div');
  root.className = `${ROOT_CLASS} ${TEMP_CLASS}`;
  root.setAttribute('aria-hidden', 'true');   // a duplicate of on-screen content
  sources.forEach(src => root.appendChild(_cloneForPrint(src)));

  document.body.appendChild(root);
  document.body.classList.add(BODY_CLASS);
  const prevTitle = document.title;
  if (title) document.title = title;

  _cleanup = () => {
    root.remove();
    document.body.classList.remove(BODY_CLASS);
    document.title = prevTitle;
    window.removeEventListener('afterprint', _cleanup);
    _cleanup = null;
  };
  window.addEventListener('afterprint', _cleanup);

  window.print();
}

function _cloneForPrint(src) {
  const clone = src.cloneNode(true);
  _freezeFormValues(src, clone);

  // The source is often a hidden on-screen holder (display:none until print) — the clone
  // must be visible inside the print root.
  if (clone.style && clone.style.display === 'none') clone.style.display = '';
  clone.removeAttribute?.('hidden');

  // No duplicate ids (getElementById would start finding the copy) and no live handlers.
  [clone, ...clone.querySelectorAll('*')].forEach(el => {
    el.removeAttribute('id');
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
