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

// Amount still owed by the patient NOW. patient_due is a generated column
// (final_amount - insurance_approved_amount - advance_credited); fall back to final.
// Session 302 -- also subtracts amount_paid (the IPD payments ledger's running total of
// payments made against an already-generated bill). amount_paid is 0 for every bill type
// other than IPD-via-the-ledger, so this is a strict refinement, not a behaviour change,
// for OPD/pharmacy/lab bills and for any IPD bill that predates the ledger.
// Session 344a -- minus what a pharmacy return took off the bill (a credit sale's return lowers the due);
// a cancelled bill owes nothing. (Outstanding is always the CURRENT amount due.)
export function dueAmount(b) {
  if (b.status === 'paid' || b.status === 'cancelled') return 0;
  const due  = b.patient_due !== undefined && b.patient_due !== null ? Number(b.patient_due) : Number(b.final_amount);
  const paid = Number(b.amount_paid) || 0;
  const returned = Number(b.returned_amount) || 0;
  const remaining = (Number.isFinite(due) ? due : 0) - paid - returned;
  return Math.max(0, remaining);
}

// ── Session 344a: period totals by date (owner decision 6 Oct 2026) ─────────────────────────────────────────
// Returns and cancellations count on the RETURN date, never on the original bill's date, so a closed day or
// month never changes:
//   Sales (gross) = bills dated in the period at their ORIGINAL amount (a bill cancelled or returned on a later
//                   day still counts in its own day; a GST draft / cancelled-and-reissued document is not a sale);
//   Returns       = returns / cancellations COMPLETED in the period (finance_activity().returns);
//   Net           = Sales - Returns;
//   Collected     = receipts received in the period - refunds paid in the period (the shift handover's rule),
//                   + bills of the period that were paid before receipts existed (finance_activity().legacy_collected).
// A same-day cancel therefore nets to 0 on that same day.
export function isSale(b) {
  const ds = b.document_status || '';
  return ds !== 'draft' && ds !== 'cancelled';
}
export function grossAmount(b) { return Number(b.final_amount) || 0; }

// the IST calendar date (YYYY-MM-DD) of a timestamp
export function istDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

const _cats = () => ({ opd: { gross: 0, returns: 0, count: 0 }, ipd: { gross: 0, returns: 0, count: 0 },
  pharmacy: { gross: 0, returns: 0, count: 0 }, investigation: { gross: 0, returns: 0, count: 0 }, other: { gross: 0, returns: 0, count: 0 } });
const _r2 = n => Math.round(n * 100) / 100;

// bills: rows with final_amount, bill_type, document_status, payer_type, payment_mode, created_at (only those of the period);
// activity: finance_activity(from, to) for the same period; day (optional 'YYYY-MM-DD') limits everything to that IST day.
export function summarisePeriod(bills, activity, day) {
  const a = activity || {};
  const sales = (bills || []).filter(b => isSale(b) && (!day || istDate(b.created_at) === day));
  const rets  = (a.returns || []).filter(r => !day || r.date === day);
  const rcpts = (a.receipts || []).filter(p => !day || p.date === day);
  const legacy = a.legacy_collected || {};
  const cat = _cats();
  const payer = { self_pay: { gross: 0, returns: 0 }, insured: { gross: 0, returns: 0 } };
  const byMode = { cash: 0, upi_card: 0, other: 0 };
  let gross = 0, returns = 0, receiptsIn = 0, refundsOut = 0, legacyIn = 0;
  for (const b of sales) {
    const g = grossAmount(b), c = billCategory(b.bill_type);
    gross += g; cat[c].gross += g; cat[c].count++;
    payer[(b.payer_type || 'self_pay') === 'self_pay' ? 'self_pay' : 'insured'].gross += g;
    const l = Number(legacy[b.id]) || 0;
    if (l) {
      legacyIn += l;
      const m = String(b.payment_mode || b.payment_method || '').toLowerCase();
      if (m === 'cash') byMode.cash += l; else if (m === 'upi' || m === 'card') byMode.upi_card += l; else byMode.other += l;
    }
  }
  for (const r of rets) {
    const v = Number(r.amount) || 0, c = billCategory(r.bill_type);
    returns += v; cat[c].returns += v;
    payer[(r.payer_type || 'self_pay') === 'self_pay' ? 'self_pay' : 'insured'].returns += v;
  }
  for (const p of rcpts) {
    const v = Number(p.amount) || 0, sign = p.kind === 'refund' ? -1 : 1;
    if (sign > 0) receiptsIn += v; else refundsOut += v;
    if (p.mode === 'cash') byMode.cash += sign * v; else if (p.mode === 'upi' || p.mode === 'card') byMode.upi_card += sign * v; else byMode.other += sign * v;
  }
  for (const k of Object.keys(cat)) { cat[k].gross = _r2(cat[k].gross); cat[k].returns = _r2(cat[k].returns); cat[k].net = _r2(cat[k].gross - cat[k].returns); }
  for (const k of Object.keys(payer)) { payer[k].net = _r2(payer[k].gross - payer[k].returns); }
  for (const k of Object.keys(byMode)) byMode[k] = _r2(byMode[k]);
  return { gross: _r2(gross), returns: _r2(returns), net: _r2(gross - returns), receiptsIn: _r2(receiptsIn), refundsOut: _r2(refundsOut),
           legacy: _r2(legacyIn), collected: _r2(receiptsIn - refundsOut + legacyIn), bills: sales.length, returnsCount: rets.length,
           cat, payer, byMode };
}
