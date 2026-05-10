// Registers the AyurXpert service worker.
// Import this as a module in every HTML page.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .catch(() => {});
  });
}
