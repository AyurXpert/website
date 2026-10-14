// creditNoteAsk.js -- "Ask for a credit note" (Session 345h, GST Stage 6c; plan docs/handoff/stage6c_plan.md, owner decisions D1-D15).
// Opened from a paid GST document's row in Visits & Bills and from the IPD Account drawer. Every figure, rule and refusal is the
// SERVER's: credit_note_preview() gives the deadline (rule R3), each line with what is already credited and what is left, what can
// still be refunded, a request already waiting and -- for the lines chosen -- the exact split request_credit_note() will store (the
// tax of each line at the ORIGINAL's rate, the last credit of a line taking the exact remainder). Nothing is computed here.
// D1 (amended by the owner, 13 Oct 2026 -- Session 345i): asked by a receptionist, cashier, accountant, finance manager or super admin;
// a tax approver (super admin / finance manager) other than the asker approves (Tax & Invoicing / HR -> Approvals).
// D2: an amount per line (rupees and paise, at most what is left) or the whole bill. D3: cash / UPI / card / cheque / NEFT, a
// reference for anything but cash; the default is the original receipt's mode. D4: a CASH refund becomes "refund due" when approved
// and is paid out by the counter from its own shift (a refund voucher prints); other modes are recorded at approval.
// DOM nodes + textContent only (descriptions and reasons are user-entered text); no native confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js'
import { el } from './invoiceLayout.js'

export const ASK_ROLES = ['super_admin', 'finance_manager', 'accountant', 'receptionist', 'cashier']
const ASK_TYPES = ['TAX_INVOICE', 'BILL_OF_SUPPLY']
const ASK_BILLS = ['consultation', 'opd', 'investigation', 'ipd']
const MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['cheque', 'Cheque'], ['neft', 'NEFT / bank transfer']]
const DOC = { TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply' }
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtD = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
let _n = 0
const uid = p => `${p}-${++_n}`

// The button is offered on a finalised GST Tax Invoice / Bill of Supply of a consultation, investigation or IPD bill to the asker
// roles; whether it can really be credited (paid, self-pay, within the limit, nothing waiting) is the server's answer in the panel.
export function canAskCreditNote(role, bill) {
  return ASK_ROLES.includes(role) && !!bill && ASK_TYPES.includes(bill.document_type)
    && ASK_BILLS.includes(String(bill.bill_type || '').toLowerCase()) && !bill.cancelled
}

// Owner, 13 Oct 2026: "Ask" is offered only while the server says the bill can still be credited -- eligible (paid, self-pay, within the
// time limit, nothing waiting) AND something is left on its lines (credit_note_preview: the whole remainder splits without an error).
// Earlier credit notes, paid out or not, do not matter. Any error = not offered (the panel would refuse anyway).
export async function canStillCredit(supabase, billId) {
  const { data, error } = await supabase.rpc('credit_note_preview', { p_bill: billId, p_lines: null })
  return !error && !!data?.eligible && !data.split_error && Number(data.split_total) > 0
}

/** openCreditNoteAsk({ supabase, billId, onDone }) -- a modal panel; onDone() after a request was sent */
export function openCreditNoteAsk({ supabase, billId, onDone } = {}) {
  const dlg = el('dialog', { class: 'cn-dialog', 'aria-labelledby': uid('cn-h') })
  const hId = dlg.getAttribute('aria-labelledby')
  const body = el('div', { class: 'cn-body' }, el('p', { class: 'cn-status' }, 'Loading…'))
  dlg.appendChild(body)
  document.body.appendChild(dlg)
  dlg.addEventListener('close', () => dlg.remove())
  dlg.showModal()
  const close = () => dlg.close()
  const closeBtn = () => { const b = el('button', { type: 'button', class: 'cn-btn' }, 'Close'); b.addEventListener('click', close); return b }

  let pv = null, whole = true, seq = 0, timer = null
  const amounts = new Map()          // line_id -> input
  const status = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
  const sum = el('div', { class: 'cn-sum', 'aria-live': 'polite' })
  const reason = el('textarea', { class: 'cn-input', id: uid('cn-reason'), maxlength: '500', placeholder: 'Why is this bill being credited? (at least 5 characters)' })
  const mode = el('select', { class: 'cn-sel', id: uid('cn-mode') }, MODES.map(([v, l]) => el('option', { value: v }, l)))
  const ref = el('input', { class: 'cn-input', id: uid('cn-ref'), maxlength: '80', placeholder: 'UPI / card / cheque / NEFT reference' })
  const modeNote = el('div', { class: 'cn-note' })
  const send = el('button', { type: 'button', class: 'cn-btn cn-btn-go' }, 'Send for approval')

  function chosenLines() {
    if (whole) return null
    const out = []
    for (const [id, inp] of amounts) {
      const v = inp.value.trim()
      if (v === '') continue
      out.push({ line_id: id, amount: Number(v) })
    }
    return out
  }
  function localProblem() {
    if (whole) return null
    const ls = chosenLines()
    if (!ls.length) return 'Enter an amount for at least one line.'
    for (const l of ls) if (!(l.amount > 0) || Math.round(l.amount * 100) !== l.amount * 100) return 'Each amount must be above zero, in rupees and paise.'
    return null
  }
  function syncMode() {
    const cash = mode.value === 'cash'
    ref.disabled = cash
    if (cash) ref.value = ''
    modeNote.textContent = cash
      ? 'Cash: when this credit note is approved the refund is "due" — a cashier pays it out from their own shift and prints the refund voucher. Nothing is counted in the approver’s cash drawer.'
      : 'This refund is recorded when the credit note is approved, with the reference you enter. No cash drawer is involved.'
  }
  function renderSplit(p) {
    sum.replaceChildren()
    if (p.split_error) { sum.appendChild(el('span', { class: 'cn-status err' }, p.split_error)); send.disabled = true; return }
    if (!p.split) { sum.appendChild(el('span', null, '—')); send.disabled = true; return }
    const tax = Number(p.split_tax || 0)
    const cg = p.split.reduce((s, x) => s + Number(x.cgst_amount || 0), 0), sg = p.split.reduce((s, x) => s + Number(x.sgst_amount || 0), 0)
    sum.append(
      el('div', null, 'Credit note total: ', el('strong', null, rupee(p.split_total))),
      p.bill.with_tax ? el('div', null, `GST reversed: ${rupee(tax)} (CGST ${rupee(cg)} + SGST ${rupee(sg)}) — at the original bill's own rates`)
                      : el('div', null, 'No GST on this credit note (the original is a Bill of Supply).'),
      el('div', { class: 'cn-sub' }, `Refund on this note: ${rupee(p.split_total)} · Can still be refunded on this bill: ${rupee(p.refundable)}`))
    send.disabled = false
  }
  async function refresh() {
    clearTimeout(timer)
    const mine = ++seq
    const prob = localProblem()
    if (prob) { sum.replaceChildren(el('span', { class: 'cn-status err' }, prob)); send.disabled = true; return }
    const { data, error } = await supabase.rpc('credit_note_preview', { p_bill: billId, p_lines: chosenLines() })
    if (mine !== seq) return
    if (error) { sum.replaceChildren(el('span', { class: 'cn-status err' }, safeErrorMessage(error, 'Could not check the credit note.'))); send.disabled = true; return }
    renderSplit(data)
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 350) }

  function render(p) {
    const b = p.bill
    const title = el('h2', { class: 'cn-h', id: hId }, 'Ask for a credit note')
    const what = el('p', { class: 'cn-sub' }, `Against ${DOC[b.document_type] || 'bill'} ${b.document_number || '—'} dated ${fmtD(b.document_date)} · ${rupee(b.final_amount)}`)
    if (!p.eligible) {
      body.replaceChildren(title, what,
        p.deadline ? el('div', { class: 'cn-deadline' }, `Credit allowed until ${fmtD(p.deadline)}`) : null,
        el('div', { class: 'cn-note', role: 'alert' }, p.reason || 'A credit note cannot be issued on this bill.'),
        el('div', { class: 'cn-row' }, closeBtn()))
      return
    }
    const nm = uid('cn-scope')
    const rWhole = el('input', { type: 'radio', name: nm, value: 'whole', checked: true })
    const rLines = el('input', { type: 'radio', name: nm, value: 'lines' })
    const rows = (p.lines || []).map(l => {
      const left = Number(l.left || 0)
      const inp = el('input', { class: 'cn-amt', type: 'number', inputmode: 'decimal', min: '0.01', step: '0.01', max: String(left), disabled: true,
                                'aria-label': `Amount to credit on line ${l.line_no}` })
      if (left <= 0) inp.setAttribute('data-nothing-left', '1')
      amounts.set(l.line_id, inp)
      inp.addEventListener('input', later)
      const fill = el('button', { type: 'button', class: 'cn-btn', disabled: true, 'aria-label': `Credit the whole of line ${l.line_no}` }, 'Whole line')
      fill.addEventListener('click', () => { inp.value = left.toFixed(2); later() })
      inp._fill = fill
      return el('tr', null,
        el('td', null, String(l.line_no ?? '')),
        el('td', null, l.description || '—'),
        el('td', null, l.sac_code || l.hsn_code || '—'),
        el('td', null, l.tax_category === 'TAXABLE' ? `${Number(l.gst_rate)}%` : 'Exempt'),
        el('td', { class: 'num' }, rupee(l.line_total)),
        el('td', { class: 'num' }, rupee(l.credited)),
        el('td', { class: 'num' }, rupee(left)),
        el('td', null, el('span', { class: 'cn-row', style: 'margin:0' }, inp, fill)))
    })
    const setScope = () => {
      whole = rWhole.checked
      for (const inp of amounts.values()) {
        const none = inp.getAttribute('data-nothing-left') === '1'
        inp.disabled = whole || none; inp._fill.disabled = whole || none
        if (whole) inp.value = ''
      }
      refresh()
    }
    rWhole.addEventListener('change', setScope); rLines.addEventListener('change', setScope)
    mode.value = MODES.some(([v]) => v === p.default_refund_mode) ? p.default_refund_mode : 'cash'
    mode.addEventListener('change', syncMode); syncMode()
    send.addEventListener('click', submit)
    body.replaceChildren(title, what,
      el('div', { class: 'cn-deadline' }, `Credit allowed until ${fmtD(p.deadline)}`),
      el('p', { class: 'cn-sub' }, 'A credit note is a new GST document (CN series) that quotes this bill’s number and date. The bill itself never changes. A second person (Super Admin or Finance Manager, never you) approves it.'),
      el('fieldset', { style: 'border:none;padding:0;margin:0' }, el('legend', { class: 'cn-lbl' }, 'What is credited'),
        el('label', { class: 'cn-radio' }, rWhole, 'The whole bill (everything still left)'),
        el('label', { class: 'cn-radio' }, rLines, 'Chosen lines (an amount per line)')),
      el('div', { class: 'cn-tablewrap' }, el('table', { class: 'cn-table' },
        el('thead', null, el('tr', null, ['#', 'Service / test', 'SAC / HSN', 'GST', 'Line total', 'Credited', 'Left', 'Credit now'].map((h, i) =>
          el('th', { scope: 'col', class: i >= 4 && i <= 6 ? 'num' : null }, h)))),
        el('tbody', null, rows))),
      sum,
      el('label', { class: 'cn-lbl', for: reason.id }, 'Reason (printed on the credit note)'), reason,
      el('div', { class: 'cn-row' },
        el('span', null, el('label', { class: 'cn-lbl', for: mode.id }, 'Refund by'), mode),
        el('span', { style: 'flex:1;min-width:220px' }, el('label', { class: 'cn-lbl', for: ref.id }, 'Reference (not for cash)'), ref)),
      modeNote, status,
      el('div', { class: 'cn-row' }, send, closeBtn()))
    refresh()
  }

  async function submit() {
    const prob = localProblem()
    if (prob) { status.textContent = prob; status.className = 'cn-status err'; return }
    if (reason.value.trim().length < 5) { status.textContent = 'Give the reason for the credit note (at least 5 characters).'; status.className = 'cn-status err'; reason.focus(); return }
    if (mode.value !== 'cash' && !ref.value.trim()) { status.textContent = 'Enter the refund reference (UPI / card / cheque / NEFT number).'; status.className = 'cn-status err'; ref.focus(); return }
    send.disabled = true
    status.textContent = 'Sending…'; status.className = 'cn-status'
    const { data, error } = await supabase.rpc('request_credit_note', {
      p_original: billId, p_reason: reason.value.trim(), p_refund_mode: mode.value,
      p_lines: chosenLines(), p_refund_reference: mode.value === 'cash' ? null : ref.value.trim() })
    if (error) { status.textContent = safeErrorMessage(error, 'Could not send the request.'); status.className = 'cn-status err'; send.disabled = false; return }
    body.replaceChildren(
      el('h2', { class: 'cn-h', id: hId }, 'Sent for approval'),
      el('p', { class: 'cn-status ok', role: 'status' }, `A credit note of ${rupee(data?.total)} against ${pv.bill.document_number} is waiting for approval.`),
      el('p', { class: 'cn-sub' }, 'A Super Admin or Finance Manager (not you) decides it in 🧾 Tax & Invoicing → “Tax settings waiting for approval”, or in HR → Approvals. The credit note gets its number when it is approved.'),
      el('div', { class: 'cn-row' }, closeBtn()))
    try { onDone && onDone() } catch (_) { /* the list refresh is best-effort */ }
  }

  ;(async () => {
    const { data, error } = await supabase.rpc('credit_note_preview', { p_bill: billId, p_lines: null })
    if (error || !data) {
      body.replaceChildren(el('p', { class: 'cn-status err', role: 'alert' }, safeErrorMessage(error, 'Could not open the credit note.')), el('div', { class: 'cn-row' }, closeBtn()))
      return
    }
    pv = data
    render(data)
  })()
}
