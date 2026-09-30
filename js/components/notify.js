// Shared user-message component (Session 322 pilot).
//
// Every page used to render its own toast / alert bar at some page-chosen z-index, and 27 pages'
// messages ended up hidden BEHIND their own open drawer or modal (audit, 30 Sep 2026). This puts
// every message in the browser's TOP LAYER via the Popover API: above every z-index and every
// stacking context, drawers and modals included. The container is hidden and re-shown on every
// call, so a message is always re-promoted above anything that entered the top layer since.
//
//   notify(message, type = 'info', { action: { label, onClick }, timeout })
//   dismissNotify()          -- remove every message (e.g. when a form is reset)
//
// Types: success | info | warning auto-hide (~4 s); error stays until its close button is used.
// CSP-safe: no inline script or style -- markup built with createElement, styling in
// css/notify.css (loaded here if the page didn't link it), handlers via addEventListener.
// Accessibility: errors are role="alert" (assertive), the rest role="status" (polite); showing a
// message never moves keyboard focus.
// Fallback for browsers without the Popover API (Chrome <114, Safari <17, Firefox <125): the same
// container is a fixed element at the maximum z-index, appended last in <body>.

const TYPES = {
  success: { icon: '✓', label: 'Success' },
  info:    { icon: 'ℹ', label: 'Info' },
  warning: { icon: '⚠', label: 'Warning' },
  error:   { icon: '⚠', label: 'Error' },
};
const AUTO_HIDE_MS = 4000;
const MAX_VISIBLE  = 4;
const HAS_POPOVER  = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

let _host = null;

function _ensureStylesheet() {
  if (document.querySelector('link[data-ax-notify]') ||
      [...document.styleSheets].some(s => (s.href || '').includes('/css/notify.css'))) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/notify.css', import.meta.url).href;
  link.dataset.axNotify = '1';
  document.head.appendChild(link);
}

function _getHost() {
  if (_host && _host.isConnected) return _host;
  _ensureStylesheet();
  _host = document.createElement('div');
  _host.id = 'ax-notify';
  _host.className = HAS_POPOVER ? 'ax-notify' : 'ax-notify ax-notify--fallback';
  if (HAS_POPOVER) _host.setAttribute('popover', 'manual');
  document.body.appendChild(_host);
  return _host;
}

// (Re-)enter the top layer, above anything shown since. Never moves focus.
function _raise(host) {
  if (HAS_POPOVER) {
    try { if (host.matches(':popover-open')) host.hidePopover(); } catch { /* not showing */ }
    try { host.showPopover(); } catch { /* detached / not supported: stays a fixed element */ }
  } else {
    document.body.appendChild(host);          // last in <body> wins among equal z-indexes
    host.classList.add('ax-notify--open');
  }
}

function _hideIfEmpty(host) {
  if (host.childElementCount) return;
  if (HAS_POPOVER) { try { if (host.matches(':popover-open')) host.hidePopover(); } catch { /* ignore */ } }
  else host.classList.remove('ax-notify--open');
}

function _remove(item) {
  const host = item.parentElement;
  clearTimeout(item._axTimer);
  item.remove();
  if (host) _hideIfEmpty(host);
}

export function notify(message, type = 'info', opts = {}) {
  const t = TYPES[type] ? type : 'info';
  const host = _getHost();
  const text = String(message ?? '');

  // the same message twice in a row replaces itself instead of stacking
  const last = host.lastElementChild;
  if (last && last.dataset.type === t && last.dataset.text === text) _remove(last);
  while (host.childElementCount >= MAX_VISIBLE) _remove(host.firstElementChild);

  const item = document.createElement('div');
  item.className = `ax-notify__item ax-notify__item--${t}`;
  item.dataset.type = t;
  item.dataset.text = text;
  item.setAttribute('role', t === 'error' ? 'alert' : 'status');
  item.setAttribute('aria-live', t === 'error' ? 'assertive' : 'polite');
  item.setAttribute('aria-atomic', 'true');

  const icon = document.createElement('span');
  icon.className = 'ax-notify__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = TYPES[t].icon;

  const body = document.createElement('div');
  body.className = 'ax-notify__body';
  const label = document.createElement('span');
  label.className = 'ax-notify__label';
  label.textContent = TYPES[t].label + ': ';
  const msg = document.createElement('span');
  msg.className = 'ax-notify__text';
  msg.textContent = text;
  body.append(label, msg);
  item.append(icon, body);

  if (opts.action && opts.action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ax-notify__action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => { try { opts.action.onClick?.(); } finally { _remove(item); } });
    item.appendChild(btn);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ax-notify__close';
  close.setAttribute('aria-label', 'Dismiss message');
  close.textContent = '×';
  close.addEventListener('click', () => _remove(item));
  item.appendChild(close);

  host.appendChild(item);
  _raise(host);

  const timeout = opts.timeout ?? (t === 'error' ? 0 : AUTO_HIDE_MS);
  if (timeout > 0) item._axTimer = setTimeout(() => _remove(item), timeout);
  return item;
}

export function dismissNotify() {
  if (!_host) return;
  [..._host.children].forEach(_remove);
}
