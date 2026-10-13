// creditNotePrint.js -- owner decision D16 (13 Oct 2026, Option A as per GST law): an issued bill's print stays identical to its original
// except the duplicate marking. Credit notes and their refunds are documented ONLY on their own documents (the credit note, the refund
// voucher) and on screens. So every BILL print leaves out the payments that belong to a credit note -- the cash payouts
// (credit_note_refund_payouts.payment_id) AND the non-cash refunds recorded at approval (credit_notes.refund_payment_id) -- and the IPD
// final bill / interim show the balance as it was before the credit notes. Read with the organisation's own rows (RLS); any read error
// THROWS, and the print page refuses to show the document (fail closed) -- a bill must never print with a credit note's refund on it.

const num = v => Number(v) || 0;

/**
 * The credit-note refunds of these bills.
 * @returns {Promise<{ credited: Map<string, number>, paymentIds: Set<string>, receiptNos: Set<string>, rows: Array<object> }>}
 *   credited: bill id -> the total of its credit notes; paymentIds / receiptNos: every credit-note refund payment (voided or not);
 *   rows: those payments (id, receipt_no, amount, voided_at, bill_id, ipd_admission_id)
 */
export async function creditNoteExclusions(supabase, billIds) {
  const ids = [...new Set((billIds || []).filter(Boolean))]
  const out = { credited: new Map(), paymentIds: new Set(), receiptNos: new Set(), rows: [] }
  if (!ids.length) return out
  const cn = await supabase.from('credit_notes').select('id, original_bill_id, total_amount, refund_payment_id').in('original_bill_id', ids)
  if (cn.error) throw cn.error
  const notes = cn.data || []
  if (!notes.length) return out
  for (const n of notes) out.credited.set(n.original_bill_id, num(out.credited.get(n.original_bill_id)) + num(n.total_amount))
  const po = await supabase.from('credit_note_refund_payouts').select('payment_id').in('credit_note_id', notes.map(n => n.id))
  if (po.error) throw po.error
  const payIds = [...new Set([...notes.map(n => n.refund_payment_id), ...(po.data || []).map(x => x.payment_id)].filter(Boolean))]
  if (!payIds.length) return out
  const pp = await supabase.from('patient_payments').select('id, receipt_no, amount, voided_at, bill_id, ipd_admission_id').in('id', payIds)
  if (pp.error) throw pp.error
  if ((pp.data || []).length !== payIds.length) throw new Error('A credit-note refund could not be read.')
  for (const p of pp.data) { out.paymentIds.add(p.id); out.receiptNos.add(p.receipt_no) }
  out.rows = pp.data
  return out
}

/**
 * IPD: the account balance as it was before the credit notes (the server's balance + what was credited - the credit-note refunds paid),
 * cross-checked with the STORED bill values: final_amount - insurance_approved_amount - advance_credited - (payments - other post-bill
 * refunds). Throws when they disagree (the print is refused rather than show a figure that does not match the stored bill).
 * Only for a bill WITH credit notes -- every other bill keeps the server's balance untouched (byte-identical prints).
 * @param {object} acc     _ipd_account() (balance, credited)
 * @param {object} bill    the bills row (final_amount, insurance_approved_amount, advance_credited)
 * @param {Array}  ledger  the admission's payments (kind, amount, bill_id, voided_at, receipt_no)
 * @param {object} ex      creditNoteExclusions() for this bill
 */
export function balanceBeforeCreditNotes(acc, bill, ledger, ex) {
  const credited = num(ex.credited.get(bill.id))
  if (Math.abs(num(acc.credited) - credited) > 0.005) throw new Error('The credit notes of this bill could not be matched -- ask the accounts team.')
  const live = (ledger || []).filter(p => !p.voided_at)
  const cnRefunds = live.filter(p => p.kind === 'refund' && ex.receiptNos.has(p.receipt_no)).reduce((s, p) => s + num(p.amount), 0)
  const fromServer = num(acc.balance) + credited - cnRefunds
  const payments = live.filter(p => p.kind === 'payment').reduce((s, p) => s + num(p.amount), 0)
  const otherPostBill = live.filter(p => p.kind === 'refund' && p.bill_id && !ex.receiptNos.has(p.receipt_no)).reduce((s, p) => s + num(p.amount), 0)
  const fromStored = num(bill.final_amount) - num(bill.insurance_approved_amount) - num(bill.advance_credited) - (payments - otherPostBill)
  if (Math.abs(fromServer - fromStored) > 0.005) throw new Error('The bill\'s balance does not match its stored totals -- the print is refused; ask the accounts team.')
  return Math.round(fromServer * 100) / 100
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A payment that is a credit-note refund -> where its document is, built ONLY from ids read back from the database (checked as uuids):
 * { voucher: true, url } (a cash payout -> its refund voucher) or { voucher: false, url } (non-cash -> the credit note); null otherwise.
 */
export async function creditNoteOfPayment(supabase, paymentId) {
  const [po, cn] = await Promise.all([
    supabase.from('credit_note_refund_payouts').select('credit_note_id, payment_id').eq('payment_id', paymentId).maybeSingle(),
    supabase.from('credit_notes').select('id').eq('refund_payment_id', paymentId).maybeSingle(),
  ])
  if (po.error) throw po.error
  if (cn.error) throw cn.error
  if (po.data) {
    if (!UUID.test(String(po.data.payment_id))) throw new Error('Unexpected refund id.')
    return { voucher: true, creditNoteId: po.data.credit_note_id, url: `printCreditNote.html?voucher=${po.data.payment_id}` }
  }
  if (cn.data) {
    if (!UUID.test(String(cn.data.id))) throw new Error('Unexpected credit note id.')
    return { voucher: false, creditNoteId: cn.data.id, url: `printCreditNote.html?cn=${cn.data.id}` }
  }
  return null
}
