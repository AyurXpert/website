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
//
// Session 385b: a name runs only if it is on the current page's list (js/config/pageActions.js). A new button = its name appears in
// the page's list after `node scripts/check-385b-actions.mjs --write` (CI fails until it does).

import { PAGE_ACTIONS } from '../config/pageActions.js';

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

// Session 385b (audit M3, TODO §500): only the names on THIS page's list in js/config/pageActions.js run -- never a window lookup of
// an arbitrary name. Markup that reaches a page from stored text (e.g. data-onclick="open") can no longer call window.open, fetch or a
// page function the page never put in its own buttons. The lists are generated from the pages' code and checked in CI
// (scripts/check-385b-actions.mjs). "print" is built in (the print pages' "Print / Save PDF" button).
// Never runnable, even if a list ever named them (scripts/check-385b-actions.mjs keeps an identical copy and compares):
const DENY = new Set(['open', 'close', 'print', 'alert', 'confirm', 'prompt', 'eval', 'Function', 'fetch', 'postMessage', 'setTimeout',
  'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'location', 'importScripts', 'XMLHttpRequest', 'WebSocket', 'Worker', 'focus',
  'blur', 'stop', 'scrollTo', 'scrollBy', 'moveTo', 'resizeTo', 'structuredClone', 'reportError', 'showModalDialog', 'atob', 'btoa',
  'escape', 'unescape', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'constructor', '__proto__',
  'hasOwnProperty', 'toString', 'valueOf']);
const BUILT_IN = new Map([['print', () => window.print()]]);

// The page's key in PAGE_ACTIONS: the file name of the address ("/reception", "/reception.html", "/" -> index.html). Every page that
// uses data-on* is in the site root.
function pageKey(pathname) {
  let name = '';
  try { name = decodeURIComponent(String(pathname || '/')).split('/').pop() || ''; } catch { name = ''; }
  if (!name) name = 'index.html';
  if (!/\.html?$/i.test(name)) name += '.html';
  return name;
}
const ALLOWED = new Set(Object.prototype.hasOwnProperty.call(PAGE_ACTIONS, pageKey(location.pathname))
  ? PAGE_ACTIONS[pageKey(location.pathname)] : []);

function dispatch(el, attr, e) {
  const fnName = el.getAttribute(`data-${attr}`);
  const builtIn = BUILT_IN.get(fnName);
  if (builtIn) { builtIn(); return; }
  if (!ALLOWED.has(fnName) || DENY.has(fnName)) {
    console.warn(`[domEvents] action not allowed on this page: ${fnName}`);
    return;
  }
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
