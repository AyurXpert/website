// creditNoteList.js -- credit notes on the finance screen + "Credit notes against this bill" (Session 345h, GST Stage 6c).
// Data: search_credit_notes() (a CN or original number searches every date; otherwise the date range; "Refunds due" lists every
// cash refund still to be paid out) and credit_notes_for_bills() -- organisation and role checks are the server's.
// Owner decision D4: a cash refund is "refund due" until a person at the counter pays it out from THEIR OWN shift
// (pay_credit_note_refund -> received_by = them; only that payout counts in a cash drawer / shift handover) and prints a refund
// voucher. Print pages are opened straight from the click (never after an await -- a pop-up blocker would stop it).
// DOM nodes + textContent only (patient names and reasons are user-entered text); no native confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js'
import { todayISTStr } from '../../utils/dateUtils.js'
import { el } from './invoiceLayout.js'

export const PAYOUT_ROLES = ['receptionist', 'cashier', 'accountant', 'finance_manager', 'dept_admin', 'super_admin']
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtD = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const MODE = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' }

export const creditNoteUrl = (id, supplier = false) => `printCreditNote.html?cn=${encodeURIComponent(id)}${supplier ? '&copy=supplier' : ''}`
export const voucherUrl = paymentId => `printCreditNote.html?voucher=${encodeURIComponent(paymentId)}`
const open = url => window.open(url, '_blank', 'noopener')

function btn(label, onClick, { go = false, title = null } = {}) {
  const b = el('button', { type: 'button', class: go ? 'cn-btn cn-btn-go' : 'cn-btn', title }, label)
  b.addEventListener('click', onClick)
  return b
}
export function refundPill(state) {
  if (state === 'due') return el('span', { class: 'cn-pill due' }, 'Refund due (cash)')
  if (state === 'paid') return el('span', { class: 'cn-pill paid' }, 'Refunded')
  return null
}

/** The "Credit notes against this bill" bit of a bill row: each note (print) and its refund state; a waiting request. */
export function creditNoteLinks(entry) {
  if (!entry) return null
  const box = el('span', { class: 'cn-links' })
  for (const n of entry.notes || []) {
    box.append(btn(`🧾 ${n.document_number} · ${rupee(n.total_amount)}`, () => open(creditNoteUrl(n.id)), { title: 'Print the credit note' }), refundPill(n.refund_status))
  }
  if (entry.waiting) box.appendChild(el('span', { class: 'cn-pill wait' }, 'Credit note waiting for approval'))
  return box.childNodes.length ? box : null
}

/** Fetch "credit notes against" these bills: { billId: { notes, waiting } } (an error or another role simply shows nothing). */
export async function creditNotesForBills(supabase, billIds) {
  const ids = [...new Set((billIds || []).filter(Boolean))]
  if (!ids.length) return {}
  const { data, error } = await supabase.rpc('credit_notes_for_bills', { p_bill_ids: ids })
  return error || !data ? {} : data
}

// An in-page payout step for one refund due (D4): confirm -> pay_credit_note_refund -> "Print refund voucher" (a fresh click)
export function payoutBox(supabase, n, onPaid) {
  const box = el('span', { class: 'cn-links' })
  const status = el('span', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
  const start = btn(`Pay out ${rupee(n.total_amount)} cash`, () => {
    const ok = btn('Confirm: I am handing over the cash', async () => {
      ok.disabled = true; no.disabled = true
      status.textContent = 'Recording…'; status.className = 'cn-status'
      const { data, error } = await supabase.rpc('pay_credit_note_refund', { p_credit_note: n.id })
      if (error) { status.textContent = safeErrorMessage(error, 'Could not record the payout.'); status.className = 'cn-status err'; ok.disabled = false; no.disabled = false; return }
      // the voucher button stays until "Done" (a refresh straight away would remove it before it could be clicked)
      box.replaceChildren(el('span', { class: 'cn-status ok' }, `Paid out ${rupee(data.amount)} — receipt ${data.receipt_no}. It counts in your shift.`),
        btn('🖨 Print refund voucher', () => open(voucherUrl(data.payment_id)), { go: true }),
        btn('Done', () => { try { onPaid && onPaid() } catch (_) { /* best-effort refresh */ } }))
    }, { go: true })
    const no = btn('Cancel', () => box.replaceChildren(start, status))
    box.replaceChildren(el('span', { class: 'cn-sub', style: 'margin:0' }, `Hand ${rupee(n.total_amount)} in cash to ${n.patient || 'the patient'}. It will count in YOUR shift.`), ok, no, status)
  }, { go: true })
  box.append(start, status)
  return box
}

/** mountCreditNoteList(root, { supabase, role }) -- the finance screen's credit-note panel */
export function mountCreditNoteList(root, { supabase, role } = {}) {
  const canPay = PAYOUT_ROLES.includes(role)
  const today = todayISTStr()
  const q = el('input', { type: 'text', class: 'cn-input', maxlength: '80', style: 'flex:1;min-width:220px',
    placeholder: 'CN number (CN/…), original bill number (TI/…, BS/…), patient name or UHID', 'aria-label': 'Search credit notes' })
  const from = el('input', { type: 'date', class: 'cn-input', value: (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10) })(), 'aria-label': 'From date' })
  const to = el('input', { type: 'date', class: 'cn-input', value: today, 'aria-label': 'To date' })
  const show = el('select', { class: 'cn-sel', 'aria-label': 'Show' },
    el('option', { value: '' }, 'All (issued + waiting)'), el('option', { value: 'issued' }, 'Issued'),
    el('option', { value: 'refund_due' }, 'Cash refunds due (all dates)'), el('option', { value: 'waiting' }, 'Waiting for approval'))
  if (role === 'cashier' || role === 'receptionist') show.value = 'refund_due'
  const status = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
  const table = el('div', { class: 'cn-tablewrap' })
  root.replaceChildren(el('div', { class: 'cn-card' },
    el('h3', { class: 'cn-h' }, 'Credit notes'),
    el('p', { class: 'cn-sub' }, 'Credit notes issued against GST bills, requests waiting for approval, and cash refunds still to be paid out. A cash refund is paid out from the counter of the person handing over the money — it counts in their shift and prints a refund voucher. A number searches every date.'),
    el('div', { class: 'cn-row' }, q, from, el('span', null, 'to'), to, show, btn('🔎 Search', run, { go: true })),
    status, table))

  let seq = 0
  async function run() {
    const mine = ++seq
    status.textContent = 'Searching…'; status.className = 'cn-status'
    const { data, error } = await supabase.rpc('search_credit_notes', {
      p_query: q.value.trim() || null, p_from: from.value || null, p_to: to.value || null, p_status: show.value || null })
    if (mine !== seq) return
    if (error) { status.textContent = safeErrorMessage(error, 'Could not load the credit notes.'); status.className = 'cn-status err'; table.replaceChildren(); return }
    const rows = data?.notes || []
    status.textContent = rows.length ? `${rows.length} shown.` : (show.value === 'refund_due' ? 'No cash refund is waiting to be paid out.' : 'Nothing found.')
    if (!rows.length) { table.replaceChildren(); return }
    table.replaceChildren(el('table', { class: 'cn-table' },
      el('thead', null, el('tr', null, ['Credit note', 'Date', 'Patient', 'Against', 'Amount', 'Refund', ''].map((h, i) =>
        el('th', { scope: 'col', class: i === 4 ? 'num' : null }, h)))),
      el('tbody', null, rows.map(n => {
        const waiting = n.status === 'waiting'
        const actions = el('span', { class: 'cn-links' })
        if (!waiting) {
          actions.append(btn('🖨 Print', () => open(creditNoteUrl(n.id)), { title: 'ORIGINAL FOR RECIPIENT, then REPRINT' }),
                         btn('Supplier copy', () => open(creditNoteUrl(n.id, true)), { title: 'DUPLICATE FOR SUPPLIER' }))
          if (n.refund_status === 'due' && canPay) actions.appendChild(payoutBox(supabase, n, run))
        }
        return el('tr', null,
          el('td', null, waiting ? el('span', { class: 'cn-pill wait' }, 'Waiting for approval') : el('strong', null, n.document_number)),
          el('td', null, waiting ? fmtD(n.issued_at) : fmtD(n.document_date)),
          el('td', null, n.patient || '—', n.uhid ? el('div', { class: 'cn-sub', style: 'margin:0' }, n.uhid) : null),
          el('td', null, `${n.original_document_number || '—'} (${fmtD(n.original_document_date)})`),
          el('td', { class: 'num' }, rupee(n.total_amount), Number(n.tax_total) > 0 ? el('div', { class: 'cn-sub', style: 'margin:0' }, `GST ${rupee(n.tax_total)}`) : null),
          el('td', null, MODE[n.refund_mode] || n.refund_mode || '—', ' ', waiting ? null : refundPill(n.refund_status)),
          el('td', null, actions))
      }))))
  }
  q.addEventListener('keydown', e => { if (e.key === 'Enter') run() })
  show.addEventListener('change', run)
  run()
  return { refresh: run }
}
