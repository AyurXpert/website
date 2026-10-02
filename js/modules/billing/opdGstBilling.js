// opdGstBilling.js -- Session 323 (GST Stage 2), extended Session 325 (TODO_LATER.md §95).
//
// OPD registration/consultation bills and lab/investigation bills. The server is the only
// calculator: the browser sends fee_structures ids (+ quantities), never an amount
// (sql/session323_gst_stage2.sql, sql/session325_legacy_server_pricing.sql).
//
// EVERY organisation uses these calls now. The server decides the regime itself: a GST-live
// organisation gets tax, a number and a finalised invoice (regime 'gst_v1'); every other
// organisation gets today's plain bill priced from the same fee master (regime 'legacy', same
// amounts as the browser used to type). Callers branch on the RESPONSE's `regime`; the cached
// regime below only drives the screen (GST preview, labels), never an amount.

let _regime = null;   // cached per page load: { consultation, investigation, gst_registered }

// One RPC per page load. Any failure means "legacy" for the SCREEN only -- the server still
// chooses the real regime for every bill it creates.
export async function getOpdBillingRegime(supabase) {
  if (_regime) return _regime;
  const { data, error } = await supabase.rpc('get_opd_billing_regime');
  _regime = (!error && data) ? data : { consultation: 'legacy', investigation: 'legacy', gst_registered: false };
  return _regime;
}

// The same fee twice (e.g. urine + blood culture both price as "Culture & Sensitivity")
// becomes one line with qty 2 -- the server refuses a repeated fee line.
function _lines(feeIds, regime = 'gst_v1') {
  // legacy: one row per fee id exactly as the per-test loop used to write them (the server
  // sums them either way); GST: a repeated fee becomes one line with a quantity.
  if (regime !== 'gst_v1') return feeIds.filter(Boolean).map(id => ({ fee_structure_id: id, qty: 1 }));
  const qty = new Map();
  feeIds.filter(Boolean).forEach(id => qty.set(id, (qty.get(id) || 0) + 1));
  return [...qty].map(([id, n]) => ({ fee_structure_id: id, qty: n }));
}

// Read-only estimate (no bill, no number). Returns the RPC's jsonb or { error }.
export async function previewOpdBill({ supabase, billType, feeIds, packageCover = false }) {
  const { data, error } = await supabase.rpc('preview_opd_bill', {
    p_bill_type: billType, p_lines: _lines(feeIds), p_bill_discount: 0,
    p_service_nature: 'treatment', p_package_cover: !!packageCover,
  });
  return error ? { error } : data;
}

// Creates the visit's bill: GST-live -> finalised invoice (Tax Invoice / Bill of Supply / Bill);
// otherwise today's plain bill (registration / consultation / surcharge columns, no number).
// A package, when given, is redeemed in the same transaction -- no bill without the session.
export async function createOpdBill({ supabase, visitId, feeIds, payerType, paymentMode, paymentStatus, paymentReference = null, patientPackageId = null, regime = 'gst_v1' }) {
  const { data, error } = await supabase.rpc('create_opd_bill', {
    p_visit: visitId, p_lines: _lines(feeIds, regime), p_payer_type: payerType,
    p_payment_mode: paymentMode, p_payment_status: paymentStatus,
    p_bill_discount: 0, p_discount_reason: null,
    p_patient_package_id: patientPackageId, p_service_nature: 'treatment',
    // Session 327: money received at registration gets a receipt (RCPT); UPI / card need the transaction reference
    p_payment_reference: paymentMode === 'cash' ? null : (paymentReference || null),
  });
  return error ? { error } : data;
}

// The lab/radiology charge, billed when reception collects it (legacy: only when it is not already
// on the visit bill -- an order already billed is just marked collected); marks the order paid.
export async function createInvestigationBill({ supabase, labOrderId, feeIds, paymentMode, reference = null, regime = 'gst_v1' }) {
  // Session 327: the receipt (RCPT number) is issued by this same call; UPI / card need the transaction reference.
  const { data, error } = await supabase.rpc('create_investigation_bill', {
    p_lab_order: labOrderId, p_lines: _lines(feeIds, regime), p_payment_mode: paymentMode,
    p_reference: paymentMode === 'cash' ? null : (reference || null),
  });
  return error ? { error } : data;
}

export const DOCUMENT_TYPE_LABEL = {
  TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply', BILL: 'Bill',
};
