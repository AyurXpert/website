// billCategory.js -- Session 295. One place that decides how a bill is classified and
// how much of it counts as collected / still due, for finance.html and admin.html.
//
// Why: bills.bill_type is free text and the writers never agreed on spelling --
// reception.js writes 'consultation', activate_pk_care_plan() writes 'OPD', older rows
// have 'opd', ipd.js 'ipd', dispensaryPOS.js 'pharmacy', the lab deferred path
// 'investigation'. The readers each compared against ONE spelling ('opd' in finance.js,
// 'OPD'/'IPD' in admin.js), so real OPD revenue fell into "Other / IPD / Package" and
// admin's OPD/IPD rows were ~always 0. Likewise bills.status: writers use
// 'paid' / 'unpaid' / 'partial', but the outstanding lists only looked for
// 'pending'/'partial' -- an unpaid bill never appeared. Readers normalise here instead
// of rewriting historical rows.

export function billCategory(billType) {
  const t = String(billType || '').trim().toLowerCase();
  if (!t || t === 'opd' || t === 'consultation') return 'opd';
  if (t === 'ipd') return 'ipd';
  if (t === 'pharmacy') return 'pharmacy';
  if (t === 'investigation' || t === 'lab') return 'investigation';
  return 'other';
}

export const BILL_CATEGORY_LABEL = {
  opd: 'OPD', ipd: 'IPD', pharmacy: 'Pharmacy', investigation: 'Lab / Investigation', other: 'Other',
};

// Statuses that still have money to collect ('pending' kept for any legacy row).
export const OUTSTANDING_STATUSES = ['unpaid', 'pending', 'partial'];

// Amount still owed by the patient. patient_due is a generated column
// (final_amount - insurance_approved_amount - advance_credited); fall back to final.
// Session 302 -- also subtracts amount_paid (the IPD payments ledger's running total of
// payments made against an already-generated bill). amount_paid is 0 for every bill type
// other than IPD-via-the-ledger, so this is a strict refinement, not a behaviour change,
// for OPD/pharmacy/lab bills and for any IPD bill that predates the ledger.
export function dueAmount(b) {
  if (b.status === 'paid') return 0;
  const due  = b.patient_due !== undefined && b.patient_due !== null ? Number(b.patient_due) : Number(b.final_amount);
  const paid = Number(b.amount_paid) || 0;
  const remaining = (Number.isFinite(due) ? due : 0) - paid;
  return Math.max(0, remaining);
}

// Amount actually received. A 'partial' bill (e.g. a Panchakarma plan's advance against
// its full estimate) counts only what was paid, never the whole estimate.
export function collectedAmount(b) {
  const f = Number(b.final_amount) || 0;
  if (b.status === 'paid') return f;
  if (b.status === 'partial') return Math.max(0, f - dueAmount(b));
  return 0;
}
