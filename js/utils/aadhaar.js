// Session 371 §394 (owner, 1 Nov 2026): the Aadhaar box on the ABHA tab -- one box, grouped "1234 5678 9012" while typing, digits only,
// paste with or without spaces / dashes, "N of 12 digits", only 12 digits accepted; after the number is accepted the page shows it
// masked "XXXX XXXX 9012". The full number is never stored: it lives only in the box until the OTP is sent (then the box is emptied)
// and goes to ABDM encrypted with ABDM's public key (abdmService.js). Pure functions -- no DOM, no storage.

// the digits only, at most 12
export const aadhaarDigits = raw => String(raw ?? '').replace(/\D/g, '').slice(0, 12);

// "123456789012" -> "1234 5678 9012" (partial input grouped the same way)
export const formatAadhaar = digits => aadhaarDigits(digits).replace(/(\d{4})(?=\d)/g, '$1 ');

// "N of 12 digits"
export const aadhaarCountText = digits => `${aadhaarDigits(digits).length} of 12 digits`;

// the message when the number is not exactly 12 digits (null when it is)
export const aadhaarLengthError = digits => {
  const n = aadhaarDigits(digits).length;
  return n === 12 ? null : `Enter all 12 digits of the Aadhaar number (${n} of 12 entered).`;
};

// "XXXX XXXX 9012" -- only the last 4 digits are ever shown after the number is accepted
export const maskAadhaar = digits => {
  const d = aadhaarDigits(digits);
  return d.length === 12 ? `XXXX XXXX ${d.slice(8)}` : '';
};

// Wires one input box: groups while typing (keeps the caret after the same digit), cleans a paste, updates the counter element.
export function wireAadhaarBox(input, counter) {
  if (!input) return;
  const show = () => { if (counter) counter.textContent = aadhaarCountText(input.value); };
  const regroup = () => {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, '').length;
    input.value = formatAadhaar(input.value);
    let pos = 0, seen = 0;
    while (pos < input.value.length && seen < before) { if (/\d/.test(input.value[pos])) seen++; pos++; }
    try { input.setSelectionRange(pos, pos); } catch { /* a password box in some browsers */ }
    show();
  };
  input.addEventListener('input', regroup);
  input.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text');
    if (text == null) return;
    e.preventDefault();
    input.value = formatAadhaar(input.value.slice(0, input.selectionStart ?? 0) + text + input.value.slice(input.selectionEnd ?? input.value.length));
    show();
  });
  show();
}
