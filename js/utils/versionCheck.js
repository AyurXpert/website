// Session 357c (TODO §282 (e) = §108 (c), owner answer Q5, 24 Oct 2026): "AyurXpert has been updated — Reload".
// A tab left open across a deploy keeps running the code it loaded (the no-cache headers only help the NEXT navigation). This reads
// version.json (written into the website by scripts/sync-website.ps1: { build, at }) when the page loads, every 5 minutes and when the
// tab becomes visible again; when the build differs from the one the page started with, a banner offers "Reload". It NEVER reloads
// by itself -- an open form keeps what was typed until the user chooses to reload. The service worker's update (js/pwa/register-sw.js)
// shows the same banner. No version.json (local Live Server, offline) = nothing happens. Built from DOM nodes + textContent only.
//
// Loaded once per page: by js/components/navbar.js (every app page) and js/utils/printDocument.js (pages that print).
const EVERY_MS = 5 * 60 * 1000;
const G = (window.__axVersionCheck ||= { started: false, base: null, shown: false, dismissedFor: null });

async function _readBuild() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.build === 'string' && j.build ? j.build : null;
  } catch { return null; }
}

function _el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

export function showUpdateBanner(reason = 'version') {
  if (G.shown || document.getElementById('ax-update-banner')) return;
  G.shown = true;
  const bar = _el('div', 'position:fixed;left:16px;right:16px;bottom:16px;z-index:4000;max-width:640px;margin:0 auto;display:flex;flex-wrap:wrap;'
    + 'align-items:center;gap:10px;padding:10px 14px;background:var(--green-deep,#1a4a2e);color:var(--cream,#faf8f3);border-radius:10px;'
    + "box-shadow:0 8px 28px rgba(0,0,0,.25);font-family:'DM Sans',sans-serif;font-size:13.5px;line-height:1.4");
  bar.id = 'ax-update-banner';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.dataset.reason = reason;
  const msg = _el('div', 'flex:1 1 260px', 'AyurXpert has been updated — reload to use the new version. What you typed stays on the page until you reload.');
  const go = _el('button', 'min-height:44px;padding:0 16px;border:none;border-radius:8px;background:var(--gold,#c9902a);color:#1a1a1a;'
    + "font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:13.5px", 'Reload');
  go.type = 'button';
  go.addEventListener('click', () => window.location.reload());
  const later = _el('button', 'min-height:44px;padding:0 12px;border:1px solid rgba(250,248,243,.6);border-radius:8px;background:none;'
    + "color:inherit;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:13px", 'Later');
  later.type = 'button';
  later.addEventListener('click', () => { bar.remove(); G.shown = false; G.dismissedFor = G.latest || 'sw'; });
  bar.append(msg, go, later);
  document.body.append(bar);
}

async function _check() {
  const b = await _readBuild();
  if (!b) return;
  G.latest = b;
  if (G.base === null) { G.base = b; return; }
  if (b !== G.base && G.dismissedFor !== b) showUpdateBanner('version');
}

export function startVersionCheck() {
  if (G.started) return;
  G.started = true;
  _check();
  setInterval(_check, EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') _check(); });
  // js/pwa/register-sw.js: a new service worker took over (a deploy) -- the same banner instead of an automatic reload
  window.addEventListener('ax-sw-updated', () => { if (G.dismissedFor !== 'sw') showUpdateBanner('service-worker'); });
}

startVersionCheck();
