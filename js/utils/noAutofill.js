// noAutofill.js -- Session 358 (TODO §285): switch off the browser's autofill on patient / payer forms.
// Found in the 357c browser check: Chrome filled reception's registration form with ANOTHER patient's details (patient safety).
// Chrome ignores autocomplete="off" on name / phone / address-like fields, so every field gets its own non-standard autocomplete
// token (new on every page load) and, when it has none, a non-guessable name. The ids stay (the page code uses them).
// One-time-code (OTP) boxes keep their own setting.
const _rand = Math.random().toString(36).slice(2, 8);

export function noAutofill(root, prefix = 'ax') {
  if (!root) return;
  root.querySelectorAll('input, select, textarea').forEach((el, i) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(type)) return;
    if (el.classList.contains('otp-box') || el.getAttribute('autocomplete') === 'one-time-code') return;
    const key = (el.id || `f${i}`).replace(/[^a-z0-9]/gi, '').slice(0, 16);
    el.setAttribute('autocomplete', `${prefix}-${key}-${_rand}`);
    if (!el.getAttribute('name')) el.setAttribute('name', `${prefix}${_rand}${i}`);
  });
}
