// Registers the AyurXpert service worker and checks for an update on every load.
// Session 357c (TODO §108 (c), owner Q5): a new worker (a deploy) NEVER reloads the page by itself any more -- an open form would lose
// what was typed. It announces 'ax-sw-updated'; js/utils/versionCheck.js shows "AyurXpert has been updated — Reload".
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const hadController = !!navigator.serviceWorker.controller;   // the first install is not an "update"
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      // Force an update check on every page load so stale SW versions are evicted promptly.
      reg.update();
      // When a new SW takes over: tell the page (the "Reload" banner) -- no automatic reload
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) window.dispatchEvent(new CustomEvent('ax-sw-updated'));
      });
    } catch (_) {}
  });
}
