// 353B B2 (owner 22 Oct 2026): a lab result the lab has released but the pathologist / lab in-charge has not signed off yet is shown
// as such wherever doctors see it (doctor.html, the patient's visit history / My Patients, the discharge summary, the lab report print).
// ONE wording and ONE rule for every page. An outside lab's report (entered by a doctor) is signed by that lab -- never flagged.

export const AWAITING_SIGNOFF = 'Awaiting pathologist sign-off';
// §263 (e): the banner of a printed report with any such result
export const PROVISIONAL_REPORT = 'PROVISIONAL REPORT — not yet signed off';

export function isAwaitingSignOff(item, order) {
  if (!item || order?.performed_outside) return false;
  const v = item.result_value;
  if (v === null || v === undefined || String(v).trim() === '') return false;
  return item.authorisation_status !== 'pathologist_signed';
}

export function anyAwaitingSignOff(items, order) {
  return (items || []).some(i => isAwaitingSignOff(i, order));
}

// §267 (owner decision 23 Oct 2026, folded into session 363): a result that is back at "pending" with a value -- re-opened by the
// pathologist / lab in-charge, set "Back to pending", or entered but not yet released -- is NOT shown to doctors or on a print: its
// value is replaced by this text until the lab releases it again. ONE rule for every page.
export const UNDER_CORRECTION = 'Result under correction by the lab';
export const NOT_RELEASED = 'Result not yet released by the lab';

export function hiddenValueText(item, order) {
  if (!item || order?.performed_outside) return null;
  const v = item.result_value;
  if (v === null || v === undefined || String(v).trim() === '') return null;
  if ((item.authorisation_status || 'pending') !== 'pending') return null;
  // a re-opened result once carried a sign-off / a release: the order was completed, or the result has been verified before
  return order?.status === 'completed' || item.authorised_at || item.previously_released ? UNDER_CORRECTION : NOT_RELEASED;
}
