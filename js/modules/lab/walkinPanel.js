// Session 363 (TODO §259, owner Q1-Q3, Q8): reception -> 💰 Lab Bills -> "🧪 Lab only (walk-in)". A walk-in patient who comes only for
// tests: the patient (found by phone, picked explicitly -- never guessed; or registered new), the tests from the organisation's
// catalogue, "Referred by" = Self or an outside doctor. "Self" is offered only for tests that allow it (every test except the consent
// tests); a consent test (HIV, HBsAg, Anti-HCV, VDRL by default) needs an outside doctor AND the tick "written consent taken".
// The server decides everything again (create_walkin_lab_order) and refuses an unpriced test. Then the order is collected in the
// Lab Bills list below exactly like any other (the payment gate before the sample is unchanged). A walk-in is NOT an OPD visit.
// DOM nodes + textContent only; no confirm() (an in-page panel).
import { loadLabCatalogue, SECTION_LABELS, SECTION_ORDER } from './catalogue.js';
import { createPatient } from '../patient/patientService.js';
import { safeErrorMessage } from '../../utils/errors.js';
import { uhidOf } from '../../utils/uhid.js';
import { computeLabBillingLines } from '../billing/labBilling.js';

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === null || v === undefined || v === false) return;
    if (k === 'on') Object.entries(v).forEach(([ev, fn]) => e.addEventListener(ev, fn));
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  });
  kids.flat().forEach(c => { if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c)); });
  return e;
}

export function canBookWalkin(profile) {
  const r = [profile?.role, profile?.secondary_role];
  return r.includes('receptionist') || r.includes('cashier') || profile?.role === 'super_admin';
}

// slot: where the panel opens; getPatient(): reception's currently selected patient (or null); onBooked(): reload Lab Bills
export function openWalkinPanel({ supabase, tenantId, slot, getPatient, onBooked, notify }) {
  if (slot.childElementCount) { slot.replaceChildren(); return; }   // the button toggles the panel
  let patient = getPatient?.() || null;
  let cat = { tests: [] };
  let fees = null;   // owner B1: a test with no matching fee is shown "no price" and cannot be ticked (the server refuses it anyway)
  const unpriced = t => !!fees && computeLabBillingLines(new Map([[t.name, null]]), fees).unmatched.length > 0;
  const chosen = new Set();
  const msg = el('div', { class: 'wk-msg', role: 'alert' });
  const ptBox = el('div', { class: 'wk-pt' });
  const testsBox = el('div', { class: 'wk-tests' });
  const refSelf = el('input', { type: 'radio', name: 'wk-ref', value: 'self', checked: true, on: { change: () => draw() } });
  const refOut = el('input', { type: 'radio', name: 'wk-ref', value: 'outside_doctor', on: { change: () => draw() } });
  const refName = el('input', { type: 'text', maxlength: '100', placeholder: "Referring doctor's name", 'aria-label': 'Referring doctor name' });
  const refReg = el('input', { type: 'text', maxlength: '40', placeholder: 'Reg. No. (optional)', 'aria-label': 'Referring doctor registration number' });
  const outBox = el('div', { class: 'wk-out', hidden: true }, refName, refReg);
  const consent = el('input', { type: 'checkbox', 'aria-label': 'Written consent taken' });
  const consentBox = el('label', { class: 'wk-consent', hidden: true }, consent, el('span', { class: 'wk-consent-text' }));
  const notes = el('input', { type: 'text', maxlength: '500', placeholder: 'Notes for the lab (optional)', 'aria-label': 'Notes' });
  const search = el('input', { type: 'search', placeholder: '🔍 Find a test', 'aria-label': 'Find a test', on: { input: () => draw() } });
  const book = el('button', { type: 'button', class: 'q-edit-btn wk-book', id: 'wk-book', on: { click: () => submit() } }, '🧪 Book lab tests');
  const close = el('button', { type: 'button', class: 'q-edit-btn', on: { click: () => slot.replaceChildren() } }, 'Close');

  slot.replaceChildren(el('div', { class: 'wk-panel', role: 'region', 'aria-label': 'Lab only walk-in booking' },
    el('div', { class: 'wk-title' }, '🧪 Lab only (walk-in) — not an OPD visit'),
    ptBox,
    el('div', { class: 'wk-ref' }, el('span', { class: 'wk-lbl' }, 'Referred by:'),
      el('label', null, refSelf, ' Self'), el('label', null, refOut, ' Outside doctor'), outBox),
    search, testsBox, consentBox, notes, msg, el('div', { class: 'wk-actions' }, book, close)));

  const isSelf = () => refSelf.checked;
  function drawPatient() {
    if (patient) {
      ptBox.replaceChildren(el('div', { class: 'wk-ptline' }, el('strong', null, patient.name), ` · ${uhidOf(patient) || ''} · ${patient.phone || ''}`
        + (patient.age ? ` · ${patient.age} y` : '') + (patient.gender ? ` · ${patient.gender}` : '')),
        el('button', { type: 'button', class: 'q-edit-btn', on: { click: () => { patient = null; drawPatient(); } } }, 'Change patient'));
      return;
    }
    const phone = el('input', { type: 'tel', inputmode: 'numeric', maxlength: '10', placeholder: 'Phone (10 digits)', 'aria-label': 'Patient phone' });
    const found = el('div', { class: 'wk-found' });
    const find = el('button', { type: 'button', class: 'q-edit-btn', on: { click: async () => {
      const p = phone.value.replace(/\D/g, '');
      if (p.length !== 10) { found.replaceChildren(el('div', { class: 'wk-err' }, 'Enter the 10-digit phone number.')); return; }
      const { data, error } = await supabase.from('patients').select('id, name, phone, age, gender, uhid').eq('tenant_id', tenantId).eq('phone', p).order('name');
      if (error) { found.replaceChildren(el('div', { class: 'wk-err' }, safeErrorMessage(error, 'Could not search patients.'))); return; }
      // patient safety: with several patients on one phone the receptionist picks one explicitly (never the first)
      found.replaceChildren(...(data || []).map(r => el('button', { type: 'button', class: 'q-edit-btn wk-pick', on: { click: () => { patient = r; drawPatient(); } } },
        `${r.name} · ${uhidOf(r) || ''}${r.age ? ' · ' + r.age + ' y' : ''}`)), newForm(p, (data || []).length));
    } } }, 'Find');
    ptBox.replaceChildren(el('div', { class: 'wk-lbl' }, 'Patient — find by phone (or select the patient in the search above first):'), el('div', { class: 'wk-row' }, phone, find), found);
  }
  function newForm(phone, n) {
    const name = el('input', { type: 'text', maxlength: '120', placeholder: 'Full name', 'aria-label': 'New patient name' });
    const age = el('input', { type: 'number', min: '0', max: '120', placeholder: 'Age', 'aria-label': 'Age' });
    const sex = el('select', { 'aria-label': 'Sex' }, el('option', { value: '' }, 'Sex'), el('option', { value: 'male' }, 'Male'), el('option', { value: 'female' }, 'Female'), el('option', { value: 'other' }, 'Other'));
    const err = el('div', { class: 'wk-err', role: 'alert' });
    return el('div', { class: 'wk-new' }, el('div', { class: 'wk-lbl' }, n ? 'Not one of these? Register a new patient on this phone:' : 'No patient with this phone — register:'),
      el('div', { class: 'wk-row' }, name, age, sex, el('button', { type: 'button', class: 'q-edit-btn', on: { click: async () => {
        if (name.value.trim().length < 2) { err.textContent = "Enter the patient's name."; return; }
        try { patient = await createPatient(name.value, phone, tenantId, null, { age: age.value ? Number(age.value) : null, gender: sex.value || null }); drawPatient(); }
        catch (e) { err.textContent = safeErrorMessage(e, 'Could not register the patient.'); }
      } } }, 'Register')), err);
  }

  function draw() {
    outBox.hidden = isSelf();
    const q = search.value.trim().toLowerCase();
    const active = cat.tests.filter(t => t.is_active && (!q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)));
    // Q1: with "Self" a test that needs a doctor's referral cannot be ticked (and is unticked)
    cat.tests.forEach(t => { if ((isSelf() && (!t.self_referral_allowed || t.consent_required)) || unpriced(t)) chosen.delete(t.id); });
    const bySec = {};
    active.forEach(t => { (bySec[t.section] ||= []).push(t); });
    testsBox.replaceChildren(...SECTION_ORDER.filter(s => bySec[s]).map(s => el('div', { class: 'wk-sec' },
      el('div', { class: 'wk-sec-t' }, SECTION_LABELS[s] || s),
      el('div', { class: 'wk-chips' }, bySec[s].map(t => {
        const needsDoc = !t.self_referral_allowed || t.consent_required;
        const noPrice = unpriced(t);
        const off = (isSelf() && needsDoc) || noPrice;
        return el('label', { class: 'wk-chip' + (off ? ' off' : ''), title: noPrice ? 'No price in the fee master -- ask the admin' : off ? "Needs a doctor's referral" : '' },
          el('input', { type: 'checkbox', value: t.id, checked: chosen.has(t.id), disabled: off, 'data-code': t.code,
            on: { change: e => { e.target.checked ? chosen.add(t.id) : chosen.delete(t.id); draw(); } } }),
          ' ' + t.name + (noPrice ? ' (no price)' : t.consent_required ? ' (consent)' : off ? ' (doctor only)' : ''));
      })))));
    const consentNames = cat.tests.filter(t => chosen.has(t.id) && t.consent_required).map(t => t.name);
    consentBox.hidden = !consentNames.length;
    consentBox.querySelector('.wk-consent-text').textContent = ' Written consent taken from the patient for: ' + consentNames.join(', ');
    book.disabled = !chosen.size;
  }

  async function submit() {
    msg.textContent = '';
    if (!patient) { msg.textContent = 'Choose or register the patient first.'; return; }
    if (!chosen.size) { msg.textContent = 'Tick at least one test.'; return; }
    book.disabled = true;
    const { data, error } = await supabase.rpc('create_walkin_lab_order', {
      p_patient: patient.id, p_tests: [...chosen], p_referral_type: isSelf() ? 'self' : 'outside_doctor',
      p_referrer_name: isSelf() ? null : refName.value.trim() || null, p_referrer_reg_no: isSelf() ? null : refReg.value.trim() || null,
      p_consent_taken: !consentBox.hidden && consent.checked, p_notes: notes.value.trim() || null });
    book.disabled = false;
    if (error || !data?.lab_order_id) { msg.textContent = safeErrorMessage(error, 'Could not book the tests.'); return; }
    notify?.(`🧪 Booked for ${patient.name} — ₹${Number(data.amount || 0).toFixed(2)}. Collect the payment in the list below, then the lab takes the sample.`, 'success');
    slot.replaceChildren();
    onBooked?.();
  }

  drawPatient();
  testsBox.textContent = 'Loading the test list…';
  Promise.all([loadLabCatalogue(supabase, tenantId, { activeOnly: true }),
    supabase.from('fee_structures').select('id,label,amount,gst_percent,promo_price,promo_valid_until')
      .eq('tenant_id', tenantId).eq('is_active', true).in('category', ['lab', 'radiology'])]).then(([c, f]) => {
    if (c.error) { testsBox.textContent = safeErrorMessage(c.error, 'Could not load the test list.'); return; }
    cat = c;
    fees = f.error ? null : (f.data || []);
    if (!cat.tests.length) { testsBox.textContent = 'Your organisation has no lab test catalogue yet -- ask the lab in-charge (lab.html → 📚 Test catalogue).'; return; }
    draw();
  });
}

// the walk-in badge on a lab bill row ("🧪 Lab only · Self" / "· Dr X (outside)")
export function walkinBadgeText(o) {
  if (!o?.walk_in) return '';
  return '🧪 LAB ONLY · ' + (o.referral_type === 'self' ? 'Self' : (o.referred_by_name || 'outside doctor') + ' (outside)');
}
