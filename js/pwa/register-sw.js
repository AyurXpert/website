// Registers the AyurXpert service worker and forces immediate update on every load.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      // Force an update check on every page load so stale SW versions are evicted promptly.
      reg.update();
      // When a new SW takes over, reload once to pick up fresh assets/CSP headers.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!sessionStorage.getItem('_sw_reloaded')) {
          sessionStorage.setItem('_sw_reloaded', '1');
          window.location.reload();
        }
      });
    } catch (_) {}
  });
}
