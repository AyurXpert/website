// Generic CSP-safe delegated event dispatcher.
//
// Replaces inline onclick="fn('a','b')" / onchange="fn(this)" attributes — which require
// 'unsafe-inline' in a page's script-src CSP directive — with data-* attributes that a
// single delegated listener resolves and calls via window[fnName](...args).
//
// Markup pattern:
//   <button data-onclick="fnName" data-onclick-a0="value" data-onclick-a1="value2">
//   <select data-onchange="fnName" data-onchange-a0="@this">
//
// Special argument tokens (case-sensitive, exact match only):
//   "@this"     -> the element itself
//   "@checked"  -> el.checked (for checkboxes/radios)
//   "@value"    -> el.value
//   "@event"    -> the raw DOM event (for e.g. event.stopPropagation())
//   "@isTarget" -> boolean, true if the event's original target IS this element
//                  (replaces the common inline `if(event.target===this) ...` backdrop-click guard)
//   "@true" / "@false" -> literal booleans (data-* attributes can only carry strings, so a plain
//                  "false" string would otherwise be truthy)
//   "@null"     -> literal null (for handlers like fn(null, 'id') where the first positional
//                  arg is deliberately absent — a raw "null" string would otherwise be a truthy,
//                  non-empty string and break `id ? ... : ...` branches expecting real null)

const EVENTS = ['click', 'change', 'input'];

// blur/focus don't bubble, so a single delegated document-level listener can't use them
// directly — focusout/focusin are their bubbling equivalents, fired at the same time.
// Exposed to markup as data-onblur/data-onfocus (matching the inline-handler names authors
// already know) while listening on the bubbling variant under the hood.
const BUBBLING_ALIAS = { blur: 'focusout', focus: 'focusin' };

// Elements that are already natively keyboard-focusable and already treat Enter/Space (or
// Enter alone, for links) as activation — a data-onclick on one of these needs no help.
// Everything else (div/span/li/etc. used as a clickable surface) gets tabindex+role injected
// below so keyboard-only users can actually reach and activate it, not just point-and-click it.
const NATIVELY_INTERACTIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);

function resolveArgs(el, attr, e) {
  const args = [];
  let i = 0;
  while (el.hasAttribute(`data-${attr}-a${i}`)) {
    const raw = el.getAttribute(`data-${attr}-a${i}`);
    if (raw === '@this') args.push(el);
    else if (raw === '@checked') args.push(el.checked);
    else if (raw === '@value') args.push(el.value);
    else if (raw === '@event') args.push(e);
    else if (raw === '@isTarget') args.push(e.target === el);
    else if (raw === '@true') args.push(true);
    else if (raw === '@false') args.push(false);
    else if (raw === '@null') args.push(null);
    else args.push(raw);
    i++;
  }
  return args;
}

function dispatch(el, attr, e) {
  const fnName = el.getAttribute(`data-${attr}`);
  const fn = window[fnName];
  if (typeof fn !== 'function') {
    console.warn(`[domEvents] no such function on window: ${fnName}`);
    return;
  }
  fn(...resolveArgs(el, attr, e));
}

// Makes every non-natively-interactive data-onclick element keyboard reachable: adds
// tabindex="0" (so Tab can land on it) and role="button" (so a screen reader announces it as
// one) unless the element already declares either attribute itself. Safe to call repeatedly —
// already-enhanced elements are skipped, so it can run on the initial document and again on
// any subtree added later.
function enhanceKeyboardReachability(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const els = root.querySelectorAll('[data-onclick]');
  const all = typeof root.matches === 'function' && root.matches('[data-onclick]') ? [root, ...els] : els;
  all.forEach(el => {
    if (NATIVELY_INTERACTIVE.has(el.tagName)) return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  });
}

export function wireDelegatedEvents(root = document) {
  [...EVENTS, 'blur', 'focus'].forEach(evt => {
    const domEvent = BUBBLING_ALIAS[evt] || evt;
    root.addEventListener(domEvent, (e) => {
      const el = e.target.closest(`[data-on${evt}]`);
      if (!el) return;
      dispatch(el, `on${evt}`, e);
    });
  });

  // Keyboard support for data-onclick elements that aren't natively interactive: Enter/Space
  // activates them the same way a click would, matching the ARIA "button" pattern.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[data-onclick]');
    // el !== e.target guards against a nested native control (a real <button>/<a> inside a
    // data-onclick wrapper) bubbling its own Enter/Space up to the wrapper and double-firing —
    // only fire when the keydown happened on the enhanced element itself (i.e. it has focus).
    if (!el || el !== e.target || NATIVELY_INTERACTIVE.has(el.tagName)) return;
    e.preventDefault(); // stop Space from scrolling the page
    dispatch(el, 'onclick', e);
  });

  enhanceKeyboardReachability(root === document ? document.body : root);

  // Catch data-onclick elements added to the DOM after this initial pass (modals, dynamically
  // rendered rows/cards, etc.) — the click/keydown listeners above already work for these via
  // bubbling, but the tabindex/role injection needs to run again whenever new nodes land.
  const observeRoot = root === document ? document.body : root;
  if (observeRoot && typeof MutationObserver !== 'undefined') {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1) enhanceKeyboardReachability(node);
        });
      }
    }).observe(observeRoot, { childList: true, subtree: true });
  }
}
