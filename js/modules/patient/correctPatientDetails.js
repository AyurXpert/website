// "Correct patient details" (Session 353C, TODO §216, owner decision D11 of 20 Oct 2026).
//
// The ONLY way to change a recorded name, phone, gender, date of birth, age, blood group, address or to clear the allergy flag:
// the server function correct_patient_details(patient, changes, reason) decides who may (an active MRD staff member or the Super
// Admin always; a receptionist only on the patient's registration day, Asia/Kolkata date) and writes every change, old + new, with
// the reason, to patient_change_log. This panel is the display copy of that rule (canCorrectPatient) plus the in-page form --
// no native confirm() / prompt(); built from DOM nodes + textContent only.
//
// Used by reception.html (the patient card) and mrd.html (the patient file).

import { noAutofill } from '../../utils/noAutofill.js';   // Session 358 (§285)
import { safeErrorMessage } from '../../utils/errors.js';
import { istDateStr, todayISTStr } from '../../utils/dateUtils.js';
import { canCorrectIdentity } from '../../utils/staffPowers.js';   // Session 359 (§305)
import { genderCode } from '../../utils/gender.js';                  // Session 371B (B3)

// Session 371B (plan session 370 B3 / B4 / B5, §244 + Q10): gender M / F / O; the address in five parts (the server joins them into
// patients.address -- an old one-line address is shown for reference and is not split); "no mobile". After the day's consultation is
// completed only MRD / the Office Superintendent (who holds the MRD role, C17 / Q12) / the active Super Admin correct, with a reason.
const GENDERS = [['', '— Not recorded —'], ['M', 'Male'], ['F', 'Female'], ['O', 'Other']];
const ADDR = [['address_line', 'House / street', 200], ['address_town', 'Village / town', 100], ['address_district', 'District', 100],
  ['address_state', 'State', 100], ['address_pin', 'PIN code', 6]];
const BLOOD = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
// a change of these on an ABHA-linked patient must still match the ABHA record (allowed, audited -- the page warns)
const ABHA_FIELDS = ['name', 'gender', 'date_of_birth', 'age'];

const _has = (p, r) => p?.role === r || p?.secondary_role === r;

// Display copy of the server rule. The server decides; this only hides the button where it would be refused.
// Session 359 (§305): + an ACTIVE account only, and an unidentified casualty patient (358: patients.is_unidentified) is corrected only by
// MRD staff / the Super Admin (the server's _patients_358_identity) -- reception no longer sees a button the server would refuse.
// + 371B (§244 / Q10): reception only BEFORE that day's consultation is completed (opts.consultationCompleted, read by the caller)
export function canCorrectPatient(profile, patient, opts = {}) {
  if (!profile || !patient) return false;
  if (!canCorrectIdentity(profile, patient)) return false;
  if (profile.role === 'super_admin' || _has(profile, 'mrd_staff')) return true;
  // owner 1 Nov 2026 (rehearsal item 16): reception corrects ANY patient while the patient has a visit TODAY that is not yet consulted
  // (opts.openVisitToday, read by the page) and today's consultation is not completed; without opts.openVisitToday (a caller that
  // does not read today's visits) the older registration-day copy is kept. The server decides again.
  if (_has(profile, 'receptionist')) {
    if (opts.consultationCompleted) return false;
    if (typeof opts.openVisitToday === 'boolean') return opts.openVisitToday;
    return !!patient.created_at && istDateStr(new Date(patient.created_at)) === todayISTStr();
  }
  return false;
}
export const AFTER_CONSULTATION_TEXT = "After today's consultation is completed, patient details are corrected only by Medical Records (MRD) or the Office Superintendent, with a reason.";

function _el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined && v !== null) e.setAttribute(k, v); });
  if (text !== undefined) e.textContent = text;
  return e;
}

function _field(labelText, input, id) {
  const wrap = _el('div', { class: 'cpd-field' });
  wrap.appendChild(_el('label', { for: id }, labelText));
  input.id = id;
  wrap.appendChild(input);
  return wrap;
}

// opts: { supabase, patient (row: id, name, phone, gender, date_of_birth, age, blood_group, address, has_allergies, abha_number, uhid),
//         uhidText, onSaved(newValues), notify }
export function openCorrectPatientDetails({ supabase, patient, uhidText, onSaved, notify }) {
  document.getElementById('cpd-overlay')?.remove();
  const prevFocus = document.activeElement;

  const overlay = _el('div', { id: 'cpd-overlay', class: 'cpd-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cpd-title' });
  const panel = _el('div', { class: 'cpd-panel' });
  overlay.appendChild(panel);
  noAutofill(panel, 'axc');   // Session 358 (§285): no browser autofill of another patient's details

  panel.appendChild(_el('h2', { id: 'cpd-title', class: 'cpd-title' }, 'Correct patient details'));
  panel.appendChild(_el('p', { class: 'cpd-sub' }, `${patient.name || '—'} · UHID ${uhidText || patient.uhid || '—'}`));
  panel.appendChild(_el('p', { class: 'cpd-help' },
    'Change only what was recorded wrongly. Every change is saved with your name, the old and new value and your reason. The UHID never changes; the ABHA is linked at Reception. ' + AFTER_CONSULTATION_TEXT));

  const name = _el('input', { type: 'text', maxlength: '200', autocomplete: 'off' }); name.value = patient.name || '';
  const phone = _el('input', { type: 'tel', maxlength: '14', autocomplete: 'off', inputmode: 'numeric' }); phone.value = patient.phone || '';
  const gender = _el('select');
  GENDERS.forEach(([v, t]) => { const o = _el('option', { value: v }, t); gender.appendChild(o); });
  gender.value = genderCode(patient.gender) || '';
  const dob = _el('input', { type: 'date', max: todayISTStr() }); dob.value = patient.date_of_birth || '';
  const age = _el('input', { type: 'number', min: '0', max: '150', step: '1' }); age.value = patient.age ?? '';
  const blood = _el('select');
  BLOOD.forEach(v => blood.appendChild(_el('option', { value: v }, v || '— Unknown —')));
  blood.value = BLOOD.includes((patient.blood_group || '').toUpperCase()) ? (patient.blood_group || '').toUpperCase() : '';
  const addr = {};
  ADDR.forEach(([k, , max]) => { addr[k] = _el('input', { type: 'text', maxlength: String(max), autocomplete: 'off', ...(k === 'address_pin' ? { inputmode: 'numeric' } : {}) }); addr[k].value = patient[k] || ''; });
  const noMobile = _el('input', { type: 'checkbox', id: 'cpd-no-mobile' }); noMobile.checked = !!patient.no_mobile;

  const grid = _el('div', { class: 'cpd-grid' });
  grid.appendChild(_field('Name', name, 'cpd-name'));
  grid.appendChild(_field('Phone', phone, 'cpd-phone'));
  grid.appendChild(_field('Gender', gender, 'cpd-gender'));
  grid.appendChild(_field('Date of birth', dob, 'cpd-dob'));
  grid.appendChild(_field('Age (years)', age, 'cpd-age'));
  grid.appendChild(_field('Blood group', blood, 'cpd-blood'));
  panel.appendChild(grid);
  const nmRow = _el('div', { class: 'cpd-check' });
  nmRow.appendChild(noMobile);
  nmRow.appendChild(_el('label', { for: 'cpd-no-mobile' }, 'Patient has no mobile'));
  panel.appendChild(nmRow);
  const agrid = _el('div', { class: 'cpd-grid' });
  ADDR.forEach(([k, label]) => agrid.appendChild(_field(label, addr[k], `cpd-${k.replace('_', '-')}`)));
  panel.appendChild(_el('div', { class: 'cpd-sub' }, 'Address'));
  if (patient.address && !ADDR.some(([k]) => patient[k])) {
    panel.appendChild(_el('p', { class: 'cpd-help' }, `Recorded address (one line, not split): ${patient.address}. Fill the parts below to replace it.`));
  }
  panel.appendChild(agrid);

  let allergy = null;
  if (patient.has_allergies) {
    const row = _el('div', { class: 'cpd-check' });
    allergy = _el('input', { type: 'checkbox', id: 'cpd-allergy' });
    allergy.checked = true;
    row.appendChild(allergy);
    row.appendChild(_el('label', { for: 'cpd-allergy' }, 'Patient has recorded allergies (untick only if the flag was set by mistake)'));
    panel.appendChild(row);
  }

  const warn = _el('div', { class: 'cpd-warn', role: 'note', hidden: '' },
    '⚠ This patient has an ABHA linked. A changed name, gender, date of birth or age must match the ABHA record — check a government photo ID.');
  panel.appendChild(warn);

  const reason = _el('textarea', { rows: '2', maxlength: '500', placeholder: 'Why is this being corrected? (required)' });
  panel.appendChild(_field('Reason for the correction', reason, 'cpd-reason'));

  const msg = _el('div', { class: 'cpd-msg', role: 'alert', 'aria-live': 'assertive' });
  panel.appendChild(msg);

  const actions = _el('div', { class: 'cpd-actions' });
  const cancel = _el('button', { type: 'button', class: 'cpd-cancel' }, 'Cancel');
  const save = _el('button', { type: 'button', class: 'cpd-save' }, 'Save corrections');
  actions.appendChild(cancel);
  actions.appendChild(save);
  panel.appendChild(actions);

  const read = () => ({
    name: name.value.trim(), phone: phone.value.trim(), gender: gender.value, date_of_birth: dob.value,
    age: age.value.trim(), blood_group: blood.value, no_mobile: noMobile.checked,
    ...Object.fromEntries(ADDR.map(([k]) => [k, addr[k].value.trim()])),
  });
  // compared with what the form showed at opening, so an old value the lists cannot show (e.g. a legacy 'M') is never cleared silently
  const current = read();
  const collect = () => {
    const vals = read();
    const changes = {};
    Object.entries(vals).forEach(([k, v]) => { if (v !== current[k]) changes[k] = k === 'age' ? (v === '' ? null : Number(v)) : k === 'no_mobile' ? v : (v === '' ? null : v); });
    if (allergy && !allergy.checked) changes.has_allergies = false;
    return changes;
  };
  const refreshWarn = () => {
    const ch = collect();
    warn.hidden = !(patient.abha_number && ABHA_FIELDS.some(k => k in ch));
  };
  [name, gender, dob, age].forEach(e => e.addEventListener('input', refreshWarn));
  gender.addEventListener('change', refreshWarn);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  save.addEventListener('click', async () => {
    msg.textContent = '';
    const changes = collect();
    if (!Object.keys(changes).length) { msg.textContent = 'Nothing to change — the values are the same as on record.'; return; }
    if (changes.name === null) { msg.textContent = 'Enter the patient\'s name.'; return; }
    if (changes.phone && !/^[6-9]\d{9}$/.test(String(changes.phone).replace(/\D/g, '').slice(-10))) { msg.textContent = 'The mobile must be 10 digits starting with 6, 7, 8 or 9.'; phone.focus(); return; }
    if (changes.phone) changes.phone = String(changes.phone).replace(/\D/g, '').slice(-10);
    if (changes.address_pin && !/^[1-9]\d{5}$/.test(changes.address_pin)) { msg.textContent = 'The PIN code must be 6 digits.'; addr.address_pin.focus(); return; }
    const why = reason.value.trim();
    if (why.length < 5) { msg.textContent = 'Give a reason for the correction (at least 5 characters).'; reason.focus(); return; }
    save.disabled = true; save.textContent = 'Saving…';
    const { data, error } = await supabase.rpc('correct_patient_details', { p_patient: patient.id, p_changes: changes, p_reason: why });
    save.disabled = false; save.textContent = 'Save corrections';
    if (error) { msg.textContent = safeErrorMessage(error, 'The correction could not be saved. Please try again.'); return; }
    const saved = {};
    (data?.changed || []).forEach(k => { saved[k] = changes[k]; });
    close();
    if (notify) notify(`Patient details corrected (${(data?.changed || []).length} field${(data?.changed || []).length === 1 ? '' : 's'}).`, 'success');
    if (onSaved) onSaved(saved, data);
  });

  document.body.appendChild(overlay);
  name.focus();
}
