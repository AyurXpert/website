// 353B B2 (owner 22 Oct 2026): a lab result the lab has released but the pathologist / lab in-charge has not signed off yet is shown
// as such wherever doctors see it (doctor.html, the patient's visit history / My Patients, the discharge summary, the lab report print).
// ONE wording and ONE rule for every page. An outside lab's report (entered by a doctor) is signed by that lab -- never flagged.

export const AWAITING_SIGNOFF = 'Awaiting pathologist sign-off';

export function isAwaitingSignOff(item, order) {
  if (!item || order?.performed_outside) return false;
  const v = item.result_value;
  if (v === null || v === undefined || String(v).trim() === '') return false;
  return item.authorisation_status !== 'pathologist_signed';
}

export function anyAwaitingSignOff(items, order) {
  return (items || []).some(i => isAwaitingSignOff(i, order));
}
