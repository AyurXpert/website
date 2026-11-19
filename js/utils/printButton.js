// Session 386f (TODO §510, 19 Nov 2026): the user guides' "Print / Save PDF" buttons, without an inline onclick="window.print()"
// (no page needs script 'unsafe-inline' any more). A button marked data-print opens the browser's print dialog.
document.addEventListener('click', e => {
  if (e.target.closest('[data-print]')) window.print();
});
