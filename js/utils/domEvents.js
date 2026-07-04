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

export function wireDelegatedEvents(root = document) {
  [...EVENTS, 'blur', 'focus'].forEach(evt => {
    const domEvent = BUBBLING_ALIAS[evt] || evt;
    root.addEventListener(domEvent, (e) => {
      const el = e.target.closest(`[data-on${evt}]`);
      if (!el) return;
      const fnName = el.getAttribute(`data-on${evt}`);
      const fn = window[fnName];
      if (typeof fn !== 'function') {
        console.warn(`[domEvents] no such function on window: ${fnName}`);
        return;
      }
      fn(...resolveArgs(el, `on${evt}`, e));
    });
  });
}
