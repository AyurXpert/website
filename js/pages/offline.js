// Deliberately self-contained (no imports) -- this page must render and
// function even when this file is the only offline-cached script available.
window.reloadPage = function() {
  location.reload();
};

document.querySelector('[data-onclick="reloadPage"]').addEventListener('click', () => {
  window.reloadPage();
});
