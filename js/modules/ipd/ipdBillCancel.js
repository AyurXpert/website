// ipdBillCancel.js -- "Cancel bill" and "Cancelled bills" in the IPD Account drawer (Session 345o, TODO §191; plan + owner decisions
// docs/handoff/session191_plan.md, 16 Oct 2026). Every rule is the SERVER's (cancel_bill): an unpaid IPD GST bill, or one settled
// only by the admission deposit; no payment / refund / credit note / write-off against it; insurance only up to pre-auth approved;
// never in a month marked filed (GSTR-1). Cancelled by an ACTIVE super admin or finance manager only (role or secondary role) with a
// reason of at least 10 characters; the number is kept, the admission goes back to "charges locked" and a corrected bill is generated
// again; a deposit stays on the admission. The server's refusal is shown as it is.
// DOM nodes + textContent only (reasons are user-entered text); no native confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js'
import { el } from '../billing/invoiceLayout.js'

export const CANCEL_ROLES = ['super_admin', 'finance_manager']
const DOC = { TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply' }
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtDT = d => d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
let _n = 0
const uid = p => `${p}-${++_n}`

/** Shown only to the cancel roles, for a finalised GST bill while the admission is at "bill generated" / "paid" (the server decides the rest). */
export function canOfferCancel(role, secondary, acc) {
  const roleOk = CANCEL_ROLES.includes(role) || CANCEL_ROLES.includes(secondary)
  return roleOk && !!acc?.bill_id && acc.tax_regime === 'gst_v1' && acc.document_status === 'finalized'
    && ['bill_generated', 'paid_cleared'].includes(acc.admission_status)
}

/** renderCancelBill(slot, { supabase, acc, onDone }) -- a "Cancel this bill" button that opens an in-page panel in the slot. */
export function renderCancelBill(slot, { supabase, acc, onDone }) {
  const docName = DOC[acc.document_type] || 'bill'
  const open = el('button', { type: 'button', class: 'cn-btn', 'aria-expanded': 'false' }, '✕ Cancel this bill')
  const box = el('div', { class: 'cn-sum', hidden: true })
  const rid = uid('cx-reason')
  const reason = el('textarea', { id: rid, class: 'cn-input', maxlength: '500', rows: '2', 'aria-describedby': rid + '-h' })
  const status = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
  const go = el('button', { type: 'button', class: 'cn-btn cn-btn-go' }, 'Cancel the bill')
  const keep = el('button', { type: 'button', class: 'cn-btn' }, 'Keep the bill')
  box.append(
    el('p', { class: 'cn-sub' },
      el('strong', null, `Cancel ${docName} ${acc.document_number || ''}?`), ' ',
      'The number is kept and shown as cancelled (it is never reused). The admission goes back to "charges locked" so the charges can ',
      'be corrected and a new bill generated. A deposit stays with the admission and is used by the new bill. Not possible once a ',
      'payment, refund, credit note or insurance claim is recorded, or in a month already filed -- then use a credit note.'),
    el('label', { class: 'cn-lbl', for: rid }, 'Reason (at least 10 characters) *'),
    reason,
    el('div', { id: rid + '-h', class: 'cn-sub' }, 'For example: wrong room type, wrong payer, a missing charge.'),
    el('div', { class: 'cn-row' }, go, keep),
    status)
  const setOpen = on => { box.hidden = !on; open.setAttribute('aria-expanded', String(on)); if (on) reason.focus(); else { reason.value = ''; status.textContent = ''; status.className = 'cn-status' } }
  open.addEventListener('click', () => setOpen(box.hidden))
  keep.addEventListener('click', () => setOpen(false))
  go.addEventListener('click', async () => {
    const r = reason.value.trim()
    if (r.length < 10) { status.className = 'cn-status err'; status.textContent = 'Give a reason of at least 10 characters.'; reason.focus(); return }
    go.disabled = keep.disabled = true
    status.className = 'cn-status'; status.textContent = 'Cancelling…'
    const { error } = await supabase.rpc('cancel_bill', { p_bill: acc.bill_id, p_reason: r })
    go.disabled = keep.disabled = false
    if (error) { status.className = 'cn-status err'; status.textContent = safeErrorMessage(error, 'Could not cancel the bill.'); return }
    status.className = 'cn-status ok'; status.textContent = `${acc.document_number || 'The bill'} is cancelled.`
    onDone?.()
  })
  slot.replaceChildren(el('div', { class: 'sec' }, 'Cancel Bill'), el('div', { class: 'cn-row' }, open), box)
}

/** renderCancelledBills(slot, { supabase, admId, onReprint }) -- the admission's cancelled bills, each with "Reprint". */
export async function renderCancelledBills(slot, { supabase, admId, onReprint }) {
  const { data, error } = await supabase.rpc('get_ipd_cancelled_bills', { p_adm: admId })
  if (!slot.isConnected) return
  if (error) { slot.replaceChildren(el('div', { class: 'cn-status err' }, safeErrorMessage(error, 'Could not load the cancelled bills.'))); return }
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) { slot.replaceChildren(); return }
  const list = el('div', null)
  for (const b of rows) {
    const btn = el('button', { type: 'button', class: 'cn-btn', 'aria-label': `Reprint cancelled bill ${b.document_number}` }, '🖨 Reprint')
    btn.addEventListener('click', () => onReprint(b.id))
    list.append(el('div', { class: 'cn-sum' },
      el('div', null, el('strong', null, `${b.document_number}`), ` · ${DOC[b.document_type] || 'Bill'} · ${rupee(b.final_amount)} · CANCELLED`),
      el('div', { class: 'cn-sub' }, `Cancelled ${fmtDT(b.cancelled_at)}${b.cancelled_by_name ? ' by ' + b.cancelled_by_name : ''}`,
        b.replaced_by ? ` · replaced by ${b.replaced_by}` : ''),
      el('div', { class: 'cn-sub' }, `Reason: ${b.cancel_reason || '—'}`),
      el('div', { class: 'cn-row' }, btn)))
  }
  slot.replaceChildren(el('div', { class: 'sec' }, 'Cancelled Bills'), list)
}
