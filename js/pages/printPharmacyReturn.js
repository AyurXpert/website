// Pharmacy return / cancellation slip -- printPharmacyReturn.html?returnId=<id> (Session 344b, TODO §143).
// Every figure is a STORED value from get_pharmacy_return_print() (session 344a: the RTN number, the original bill, the
// returned lines with their share of the money, how it was settled); this file only formats. The SERVER decides
// ORIGINAL vs DUPLICATE COPY No. N (record_document_print('pharmacy_return') -- the same scheme as every other document)
// and the page fails closed if that cannot be recorded. Layout: the shared invoiceLayout model, at the chosen paper size
// (A4 / A5 / thermal 80 / 58 mm -- paperSize.js); changing the size never records another print.
import { supabase } from '../core/db/supabaseClient.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { safeErrorMessage } from '../utils/errors.js'
import { uhidOf } from '../utils/uhid.js'
import { el } from '../modules/billing/invoiceLayout.js'
import { ensureSignedIn } from '../utils/signInGate.js'
import { getPaperSize, applyPaperSize, mountPaperSizeSelect, renderDocument, watchPrintPageSize } from '../modules/billing/paperSize.js'

wireDelegatedEvents()
applyPaperSize(getPaperSize())

const returnId = new URLSearchParams(window.location.search).get('returnId')
const sheet    = document.getElementById('invoice')
const statusEl = document.getElementById('status')
const printBtn = document.getElementById('print-btn')

const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card' }
const CONDITION  = { sealed_good: 'sealed & good', opened: 'opened', damaged: 'damaged', expired: 'expired' }

const num   = v => Number(v) || 0
const money = v => num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rupee = v => `₹ ${money(v)}`
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function istParts(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(new Date(iso)).map(x => [x.type, x.value]))
  return { d: p.day, m: MON[Number(p.month) - 1], y: p.year, time: `${p.hour}:${p.minute} ${(p.dayPeriod || '').toUpperCase()}` }
}
const fmtDT  = iso => { if (!iso) return null; const p = istParts(iso); return `${p.d} ${p.m} ${p.y}, ${p.time}` }
const fmtExp = d => { if (!d) return null; const [y, m] = String(d).split('-'); return m && y ? `${MON[Number(m) - 1]} ${y}` : String(d) }
const monogram = name => (name || '').split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0].toUpperCase()).join('')

function setStatus(msg, isErr = false) { statusEl.textContent = msg || ''; statusEl.className = 'status-msg' + (isErr ? ' err' : '') }
function showError(msg) { sheet.replaceChildren(el('p', { class: 'error-box' }, msg)); printBtn.disabled = true }

export function buildModel(d, copy) {
  const r = d.return || {}, b = d.bill || {}, pt = d.patient, cust = d.customer, org = d.organisation || {}
  const isCancel = r.kind === 'cancel'
  const orgName  = org.name || 'Pharmacy'
  const orgLines = [org.address || [org.city, org.state].filter(Boolean).join(', '), org.phone ? `Ph: ${org.phone}` : null,
                    org.license_number ? `Licence No.: ${org.license_number}` : null].filter(Boolean)

  // one copy number for header and footer (this document has no pre-tracking prints: legacy is always false)
  const isDup  = copy.copy !== 'ORIGINAL'
  const copyNo = (Number(copy.print_no) || 1) + (copy.legacy ? 1 : 0)
  const title  = isCancel ? 'Cancellation Slip' : 'Return Slip'
  const subtitle = `Pharmacy · ${isCancel ? 'Bill cancelled' : 'Medicines returned'} · ${isDup ? 'DUPLICATE COPY · No. ' + copyNo : 'Original'}`

  const meta = [
    { label: 'Return No.', value: r.return_no || '—' },
    { label: 'Return Date', value: fmtDT(r.completed_at) },
    { label: 'Original Bill No.', value: b.document_number || 'Not numbered', gap: !b.document_number },
    { label: 'Bill Date', value: fmtDT(b.created_at) },
  ]

  const fields = pt ? [
    { label: 'Patient Name', value: pt.name, wide: true },
    { label: 'UHID', value: uhidOf(pt) },
  ] : [
    { label: 'Customer', value: cust?.name || 'Walk-in customer', wide: true },
  ]
  fields.push({ label: 'Reason', value: `${r.reason_code === 'wrong_entry' ? 'Wrongly entered bill' : 'Customer return'} — ${r.reason || '—'}`, full: true })

  let n = 0, sub = 0
  const rows = (d.lines || []).map(l => {
    sub += num(l.amount)
    const where = l.disposition === 'restock' ? 'back to stock' : 'to the disposal register'
    return {
      no: ++n, description: l.description || 'Medicine',
      sub: [l.batch_number ? `Batch ${l.batch_number}` : 'Batch not recorded', l.expiry_date ? `Exp ${fmtExp(l.expiry_date)}` : null,
            `${CONDITION[l.condition] || l.condition} — ${where}`].filter(Boolean).join(' · '),
      qty: String(num(l.qty)), rate: money(l.unit_price), amount: money(l.amount),
    }
  })
  const sections = rows.length ? [{ title: 'Medicines returned', rows, subtotal: money(sub) }] : []

  // the money: a same-day cancel voids the sale receipt; otherwise a refund (RCPT refund voucher) and / or less amount due
  const summary = [{ label: `Original bill total`, value: money(b.final_amount) }]
  summary.push({ label: isCancel ? 'Value cancelled' : 'Value of medicines returned', value: rupee(r.amount), grand: true })
  if (num(r.due_reduction) > 0) summary.push({ label: 'Less: amount due reduced (no cash)', value: money(r.due_reduction) })
  let balance, words, sign
  const mode = MODE_LABEL[r.refund_mode] || r.refund_mode || '—'
  if (r.settlement === 'void') {
    summary.push({ label: `Sale receipt ${r.voided_receipt_no || ''} cancelled`.replace(/\s+/g, ' ').trim(), value: money(r.refund_amount) })
    balance = { label: `Amount returned (${mode})`, value: rupee(r.refund_amount) }
  } else if (r.settlement === 'refund') {
    summary.push({ label: `Refund${r.refund_receipt_no ? ' — ' + r.refund_receipt_no : ''} (${mode})`, value: money(r.refund_amount) })
    balance = { label: `Refund paid (${mode})`, value: rupee(r.refund_amount) }
  } else {
    balance = { label: 'Refund paid', value: rupee(0) }
  }
  const refunded = num(r.refund_amount)
  if (refunded > 0) {
    words = [`Refund: ${amountInWords(refunded)}.`]
    sign = [`Received the refund of ₹ ${money(refunded)}`, 'Customer signature: ____________________']
  } else {
    words = [`Value: ${amountInWords(r.amount)}.`, 'No cash refund — the amount due on the bill is reduced.']
    sign = [`Amount due reduced by ₹ ${money(r.due_reduction || r.amount)}`, 'Customer signature: ____________________']
  }

  const footer = []
  if (isDup) footer.push(`Duplicate copy no. ${copyNo}. The original was first printed ${fmtDT(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}.`)
  footer.push(`Recorded by ${r.completed_by || '—'}. Keep this slip with the original bill.`)
  footer.push('Computer-generated return slip — not a tax invoice or credit note. · Powered by AyurXpert')

  return {
    org: { name: orgName, lines: orgLines, logoUrl: org.logo_url || null, monogram: monogram(orgName) },
    title, subtitle, watermark: isDup ? 'DUPLICATE COPY' : null, meta, demo: !!org.is_demo,
    party: { title: pt ? 'Patient Details' : 'Customer Details', fields },
    gst: false, descLabel: 'Medicine', noCode: true,
    sections, emptyNote: rows.length ? null : 'No medicines on this return.', taxNote: null, taxSummary: null, payments: null,
    summary: { rows: summary, balance },
    words: { label: refunded > 0 ? 'Refund in words' : 'Value in words', lines: words },
    signatures: { left: sign, right: ['Pharmacist / Authorised signatory', `for ${orgName}`] },
    footer,
  }
}

async function load() {
  if (!returnId) { showError('No return slip specified.'); return }
  if (!(await ensureSignedIn(supabase))) return
  const { data, error } = await supabase.rpc('get_pharmacy_return_print', { p_return: returnId })
  if (error || !data?.return) { showError(safeErrorMessage(error, 'Could not load the return slip.')); return }
  // Print audit first: an unmarked copy must never be printable (fail closed)
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'pharmacy_return', p_doc_id: returnId })
  if (rec.error || !rec.data) { showError(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return }
  const model = buildModel(data, rec.data)
  const draw = size => {
    renderDocument(sheet, model, size)
    sheet.querySelector('.logo-img')?.addEventListener('error', e => e.target.remove())
  }
  draw(getPaperSize())
  mountPaperSizeSelect(document.getElementById('paper-slot'), draw)
  watchPrintPageSize(() => sheet)
  const who = data.patient?.name || data.customer?.name || 'Walk-in customer'
  document.title = `${model.title} ${data.return.return_no || ''} — ${who}`.replace(/\s+/g, ' ').trim()
  printBtn.disabled = false
  setStatus('')
}

load()
