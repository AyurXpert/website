// Session 371B (plan session 370 B4 / B5 / B6, D1a 1-3): the registration form's own checks. Pure rules (unit-tested by
// scripts/check-370-reception.mjs) + one helper that marks the fields on the page. The server re-checks every rule for a NEW
// patient (_patients_browser_insert, Build A) -- the page only saves the receptionist a round trip; it never decides alone.
import { genderCode } from '../../utils/gender.js';

// The "No mobile" reasons (B4). 'Emergency' is offered only for an Emergency visit (§299: never block an emergency).
export const NO_MOBILE_REASONS = ['Child (no own phone)', 'Elderly (family phone)', 'Refuses to give', 'Has no phone'];
export const NO_MOBILE_EMERGENCY = 'Emergency — not available now';

// Whatever was typed (spaces, +91, a leading 0) -> the last 10 digits, or '' when fewer than 10 digits were typed.
export function normaliseMobile(text) {
  const d = String(text ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}
export function isValidMobile(d) { return /^[6-9]\d{9}$/.test(String(d ?? '')); }
export function isValidPin(p) { return /^[1-9]\d{5}$/.test(String(p ?? '').trim()); }

// What the search box text looks like. The search box only SEARCHES -- nothing typed in it is ever saved (D1a 1).
export function searchKind(text) {
  const v = String(text ?? '').trim();
  if (!v) return { kind: 'empty' };
  if (/^AYX[\s\-/]*\d/i.test(v)) return { kind: 'uhid', value: v };
  const digits = v.replace(/\D/g, '');
  if (/^[+\d\s\-()]+$/.test(v) && digits.length >= 6) {
    return digits.length >= 10 ? { kind: 'mobile', value: digits.slice(-10) } : { kind: 'partial', value: digits };
  }
  if (v.length >= 3) return { kind: 'name', value: v };
  return { kind: 'short' };
}

function _age(dobIso, today) {
  const b = new Date(dobIso + 'T00:00:00');
  if (isNaN(b)) return null;
  let a = today.getFullYear() - b.getFullYear();
  if (today.getMonth() < b.getMonth() || (today.getMonth() === b.getMonth() && today.getDate() < b.getDate())) a--;
  return a;
}

// v = { isNew, isEmergency, name, mobile (raw text), noMobile, noMobileReason, age, dob, gender, town, district, pin,
//       complaint, opdId, apptMode, apptDate, apptTime }
// -> [{ field, message }] in screen order. Field keys are the ones FIELD_IDS maps to elements.
export function validateRegistration(v, today = new Date()) {
  const errs = [];
  const add = (field, message) => errs.push({ field, message });
  if (!String(v.name ?? '').trim()) add('name', 'Enter the full name');
  if (v.isNew) {
    const m = normaliseMobile(v.mobile);
    const typed = String(v.mobile ?? '').replace(/\D/g, '');
    if (v.noMobile) {
      if (!String(v.noMobileReason ?? '').trim()) add('noMobileReason', 'Choose why there is no mobile');
    } else if (!typed) {
      if (!v.isEmergency) add('mobile', 'Enter a 10-digit mobile, or tick "Patient has no mobile"');
    } else if (!isValidMobile(m) || typed.length > 12) {
      add('mobile', 'Mobile must be 10 digits starting with 6, 7, 8 or 9');
    }
    const ageTyped = String(v.age ?? '').trim() !== '';
    const ageN = Number(v.age);
    if (!ageTyped && !v.dob) add('age', 'Enter the age (or the date of birth)');
    else if (ageTyped && (!Number.isInteger(ageN) || ageN < 0 || ageN > 120)) add('age', 'Age must be a whole number from 0 to 120');
    if (v.dob) {
      const a = _age(v.dob, today);
      if (a === null || a < 0) add('dob', 'The date of birth cannot be in the future');
      else if (a > 120) add('dob', 'The date of birth is more than 120 years ago');
    }
    if (!genderCode(v.gender)) add('gender', 'Choose the gender');
    if (!v.isEmergency) {
      if (!String(v.town ?? '').trim()) add('town', 'Enter the village / town');
      if (!String(v.district ?? '').trim()) add('district', 'Enter the district');
    }
  }
  if (String(v.pin ?? '').trim() && !isValidPin(v.pin)) add('pin', 'PIN must be 6 digits');
  if (v.apptMode) {
    if (!v.apptDate) add('apptDate', 'Choose the appointment date');
    if (!v.apptTime) add('apptTime', 'Choose the appointment time');
  } else if (!String(v.complaint ?? '').trim()) add('complaint', 'Enter the chief complaint');
  return errs;
}

// Field key -> the element that gets the red border (the message goes right under it).
export const FIELD_IDS = {
  name: 'name', mobile: 'rx-mobile', noMobileReason: 'rx-no-mobile-reason', age: 'f-age', dob: 'f-dob', gender: 'rx-gender-group',
  town: 'rx-addr-town', district: 'rx-addr-district', pin: 'rx-addr-pin', complaint: 'complaint', opd: 'opd',
  apptDate: 'appt-date', apptTime: 'appt-time',
};
const LABEL = {
  name: 'Full name', mobile: 'Mobile', noMobileReason: 'No-mobile reason', age: 'Age', dob: 'Date of birth', gender: 'Gender',
  town: 'Village / town', district: 'District', pin: 'PIN code', complaint: 'Chief complaint', opd: 'OPD', apptDate: 'Date', apptTime: 'Time',
};

// Marks the fields (red border + aria-invalid + a message under each) and fills the sticky bar's line.
export function showFieldErrors(errs, { barEl } = {}) {
  document.querySelectorAll('.rx-bad').forEach(el => { el.classList.remove('rx-bad'); el.removeAttribute('aria-invalid'); });
  document.querySelectorAll('.rx-err[data-rx-err]').forEach(el => el.remove());
  for (const e of errs) {
    const el = document.getElementById(FIELD_IDS[e.field]);
    if (!el) continue;
    el.classList.add('rx-bad');
    el.setAttribute('aria-invalid', 'true');
    const msg = document.createElement('div');
    msg.className = 'rx-err';
    msg.dataset.rxErr = e.field;
    msg.id = `${FIELD_IDS[e.field]}-err`;
    msg.setAttribute('role', 'alert');
    msg.textContent = e.message;
    el.setAttribute('aria-describedby', msg.id);
    (el.closest('.rx-field') || el.parentElement).append(msg);
  }
  if (barEl) {
    barEl.textContent = errs.length
      ? `${errs.length} field${errs.length > 1 ? 's' : ''} need${errs.length > 1 ? '' : 's'} fixing (${errs.map(e => LABEL[e.field] || e.field).join(', ')})`
      : '';
  }
  if (errs.length) document.getElementById(FIELD_IDS[errs[0].field])?.focus?.({ preventScroll: false });
  return errs.length;
}

// One field corrected -> its own mark goes at once (the bar is recounted at the next Register press)
export function clearFieldError(el) {
  if (!el?.classList?.contains('rx-bad')) return;
  el.classList.remove('rx-bad');
  el.removeAttribute('aria-invalid');
  document.getElementById(`${el.id}-err`)?.remove();
}

// The address parts for the server (B5). The server joins them into patients.address; an empty part is not sent.
export function addressParts({ line, town, district, state, pin }) {
  const out = {};
  const put = (k, val) => { const s = String(val ?? '').trim(); if (s) out[k] = s; };
  put('address_line', line); put('address_town', town); put('address_district', district); put('address_state', state); put('address_pin', pin);
  return out;
}
