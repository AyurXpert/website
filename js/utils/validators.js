// Centralized input validation + output escaping helpers.
// Consolidates checks that were previously duplicated inline across
// signup.html, register.html, and login.js.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line security/detect-unsafe-regex -- reviewed: linear-time (bounded optional prefix + fixed-length digit match), no nested/overlapping repetition, not vulnerable to ReDoS
const PHONE_RE = /^(\+91[\-\s]?)?[6-9]\d{9}$/;

export function isValidEmail(email) {
  return EMAIL_RE.test(String(email ?? '').trim());
}

export function isValidPhone(phone) {
  return PHONE_RE.test(String(phone ?? '').trim().replace(/\s+/g, ''));
}

// Length + complexity (upper, lower, digit, special char) — CERT-In
// Application Security Guidelines §4.1 calls for length AND complexity,
// not length alone.
export function validatePassword(pw) {
  const s = String(pw ?? '');
  if (s.length < 8)            return { valid: false, message: 'Password must be at least 8 characters.' };
  if (!/[a-z]/.test(s))        return { valid: false, message: 'Password must include a lowercase letter.' };
  if (!/[A-Z]/.test(s))        return { valid: false, message: 'Password must include an uppercase letter.' };
  if (!/[0-9]/.test(s))        return { valid: false, message: 'Password must include a number.' };
  if (!/[^a-zA-Z0-9]/.test(s)) return { valid: false, message: 'Password must include a special character.' };
  return { valid: true, message: '' };
}

// Escape a value for safe interpolation into innerHTML.
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
