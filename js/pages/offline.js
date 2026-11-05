// Deliberately self-contained (no imports) -- this page must render and
// function even when this file is the only offline-cached script available.
window.reloadPage = function() {
  location.reload();
};

// TODO §423 (owner, 4 Nov 2026): the service worker also lands here when the server cannot be reached although this device is online.
// Only a device that is really offline is told about its internet.
function showState() {
  const offline = navigator.onLine === false;
  const title = offline ? 'No Internet Connection' : 'Could not reach AyurXpert';
  document.getElementById('off-icon').textContent = offline ? '📶' : '⚠️';
  document.getElementById('off-title').textContent = title;
  document.getElementById('off-text').textContent = offline
    ? 'AyurXpert needs a connection to sync patient data and records. Please check your Wi-Fi or mobile data and try again.'
    : 'Please try again.';
  document.getElementById('off-hint').hidden = !offline;
  document.title = title;
}
showState();
window.addEventListener('online', showState);
window.addEventListener('offline', showState);

document.querySelector('[data-onclick="reloadPage"]').addEventListener('click', () => {
  window.reloadPage();
});
