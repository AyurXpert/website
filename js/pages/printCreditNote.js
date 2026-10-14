// Credit note / refund voucher print -- printCreditNote.html?cn=<id>[&copy=supplier] | ?voucher=<refund payment id>
// (Session 345h, GST Stage 6c; plan docs/handoff/stage6c_plan.md, owner decisions D4 / D5 / D6).
// Every figure is a STORED value from get_credit_note() (the note frozen at approval: supplier and recipient snapshot, the original's
// number + date, each line at the original's own rate, totals, the refund); this file only formats. The SERVER decides the copy
// marking (record_document_print, fail closed): a credit note prints ORIGINAL FOR RECIPIENT, then REPRINT · ORIGINAL FOR RECIPIENT
// · No. N; the optional supplier copy DUPLICATE FOR SUPPLIER (its own series); a refund voucher Original / DUPLICATE COPY · No. N.
// Rule 53 particulars: the heading "CREDIT NOTE" (rule R2: never the composition sentence), the supplier's name, address and GSTIN,
// the note's number and date, the recipient, the original document's number and date, the value, taxable value, rate and the tax
// credited, the signature. No internal reference (ids, table names, session numbers) is ever printed.
// Layout: the shared invoiceLayout model at the chosen paper size (A4 / A5 / thermal 80 / 58 mm -- paperSize.js); changing the size
// never records another print.
import { supabase } from '../core/db/supabaseClient.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { safeErrorMessage } from '../utils/errors.js'
import { uhidOf } from '../utils/uhid.js'
import { el } from '../modules/billing/invoiceLayout.js'
import { ensureSignedIn } from '../utils/signInGate.js'
import { copyMarking, isSupplierCopy, openSupplierCopy } from '../modules/billing/copyMarking.js'
import { getPaperSize, applyPaperSize, mountPaperSizeSelect, renderDocument, watchPrintPageSize } from '../modules/billing/paperSize.js'
import { DEMO_TEXT } from '../modules/billing/demoBanner.js'

wireDelegatedEvents()
applyPaperSize(getPaperSize())

const params   = new URLSearchParams(window.location.search)
const cnId     = params.get('cn')
const voucher  = params.get('voucher')
const supplier = !voucher && isSupplierCopy()
const sheet    = document.getElementById('invoice')
const statusEl = document.getElementById('status')
const printBtn = document.getElementById('print-btn')
const supBtn   = document.getElementById('supplier-btn')

const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' }
const DOC = { TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply' }
const TAXCAT_LABEL = { EXEMPT: 'Exempt', NIL_RATED: 'Nil-rated', NON_GST: 'Non-GST', OUT_OF_SCOPE: 'Out of scope' }
const num   = v => Number(v) || 0
const money = v => num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rupee = v => `₹ ${money(v)}`
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function istParts(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(new Date(iso)).map(x => [x.type, x.value]))
  return { d: p.day, m: MON[Number(p.month) - 1], y: p.year, time: `${p.hour}:${p.minute} ${(p.dayPeriod || '').toUpperCase()}` }
}
const fmtDT = iso => { if (!iso) return null; const p = istParts(iso); return `${p.d} ${p.m} ${p.y}, ${p.time}` }
const fmtD  = d => { if (!d) return null; const s = String(d); const p = istParts(s.length === 10 ? `${s}T12:00:00+05:30` : s); return `${p.d} ${p.m} ${p.y}` }
const monogram = name => (name || '').split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0].toUpperCase()).join('')

function setStatus(msg, isErr = false) { statusEl.textContent = msg || ''; statusEl.className = 'status-msg' + (isErr ? ' err' : '') }
function showError(msg) { sheet.replaceChildren(el('p', { class: 'error-box' }, msg)); printBtn.disabled = true }

function orgBlock(d) {
  const n = d.note || {}, org = d.organisation || {}
  const name = n.supplier_legal_name || org.name || 'Organisation'
  const lines = [n.supplier_address || org.address || [org.city, org.state].filter(Boolean).join(', '),
                 n.supplier_gstin ? `GSTIN: ${n.supplier_gstin}${n.supplier_state_code ? ' · State code ' + n.supplier_state_code : ''}` : 'Not registered under GST',
                 org.phone ? `Ph: ${org.phone}` : null].filter(Boolean)
  return { name, lines, logoUrl: org.logo_url || null, monogram: monogram(name) }
}

const fmtExp = d => { if (!d) return null; const [y, m] = String(d).split('-'); return m ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y}` : String(d) }

// Session 345h follow-up (owner, 13 Oct 2026, the D16 principle): a credit note's print never changes after issue -- the refund as fixed
// at approval (amount + mode), never its later state (due / paid out) or the payout's receipt number
function refundText(r) {
  return `Refund: ${rupee(r.amount)} (${MODE_LABEL[r.mode] || r.mode || '—'})`
}

// Session 345h follow-up: the banner on a demo organisation's credit note / refund voucher (not a tax invoice)
// Session 345l (TODO §187): the one demo wording of every document (js/modules/billing/demoBanner.js)
const DEMO_GST_TEXT = DEMO_TEXT

// origTotals: { [credit-note line_no]: the ORIGINAL line's total } -- a line credited for less than it is a PART credit
export function buildCreditNoteModel(d, copy, { supplierCopy = false, origTotals = {} } = {}) {
  const n = d.note || {}, pt = d.patient || {}, r = d.refund || {}
  const org = orgBlock(d)
  const mk = copyMarking(copy, { supplier: supplierCopy, fmtDT })
  const withTax = !!n.with_tax
  const origLabel = DOC[n.original_document_type] || 'Bill'
  // Session 345i (Stage 6b): a pharmacy credit note (a return of a GST pharmacy bill) -- per line batch, expiry, HSN, qty x rate
  const pharmacy = String(n.bill_type || '').toLowerCase() === 'pharmacy'
  const meta = [
    { label: 'Credit Note No.', value: n.document_number || '—' },
    { label: 'Credit Note Date', value: fmtD(n.document_date) },
    { label: `Against ${origLabel} No.`, value: n.original_document_number || '—' },
    { label: `${origLabel} Date`, value: fmtD(n.original_document_date) },
  ]
  if (pharmacy && d.pharmacy_return?.return_no) meta.push({ label: 'Return No.', value: d.pharmacy_return.return_no })
  const fields = pharmacy && !d.patient ? [
    { label: 'Recipient', value: n.recipient_name || d.customer?.name || 'Walk-in customer', wide: true },
  ] : [
    { label: 'Recipient', value: n.recipient_name || pt.name || '—', wide: true },
    { label: 'UHID', value: uhidOf(pt) },
    { label: 'Address', value: n.recipient_address || 'Not recorded', gap: !n.recipient_address, wide: true },
  ]
  if (n.recipient_gstin) fields.push({ label: 'Recipient GSTIN', value: n.recipient_gstin })
  if (n.place_of_supply_state_code) fields.push({ label: 'Place of supply (state code)', value: n.place_of_supply_state_code })
  fields.push({ label: 'Reason', value: n.reason || '—', full: true })

  let i = 0, sub = 0
  const rows = (d.lines || []).map(l => {
    const taxable = l.tax_category === 'TAXABLE'
    sub += num(l.line_total)
    if (pharmacy) {
      const subText = [l.batch_number ? `Batch ${l.batch_number}` : null, l.expiry_date ? `Exp ${fmtExp(l.expiry_date)}` : null].filter(Boolean).join(' · ') || null
      return withTax
        ? { no: ++i, description: l.description || 'Medicine', sub: subText, code: l.hsn_code || null, qty: String(num(l.quantity)), rate: money(l.unit_price), disc: '—',
            taxable: taxable ? money(l.taxable_value) : '—', gstLabel: taxable ? `${num(l.gst_rate)}%` : (TAXCAT_LABEL[l.tax_category] || '—'),
            cgst: taxable ? money(l.cgst_amount) : '—', sgst: taxable ? money(l.sgst_amount) : '—', amount: money(l.line_total) }
        : { no: ++i, description: l.description || 'Medicine', sub: subText, code: l.hsn_code || null, qty: String(num(l.quantity)), rate: money(l.unit_price), amount: money(l.line_total) }
    }
    // a part (amount-based) credit: "Part credit ₹300.00 (of ₹500.00)", quantity blank; a whole-line credit keeps qty x rate
    const of = origTotals[l.line_no]
    if (of != null && num(l.line_total) < num(of) - 0.005) {
      const partText = `Part credit ₹${money(l.line_total)} (of ₹${money(of)})`
      return withTax
        ? { no: ++i, description: l.description || '—', sub: partText, part: true, code: l.sac_code || l.hsn_code || null, qty: '', rate: '', disc: '—',
            taxable: taxable ? money(l.taxable_value) : '—', gstLabel: taxable ? `${num(l.gst_rate)}%` : (TAXCAT_LABEL[l.tax_category] || '—'),
            cgst: taxable ? money(l.cgst_amount) : '—', sgst: taxable ? money(l.sgst_amount) : '—', amount: money(l.line_total) }
        : { no: ++i, description: l.description || '—', sub: partText, part: true, code: l.sac_code || l.hsn_code || null, qty: '', rate: '', amount: money(l.line_total) }
    }
    return withTax
      ? { no: ++i, description: l.description || '—', code: l.sac_code || l.hsn_code || null, qty: '1', rate: money(taxable ? l.taxable_value : l.line_total), disc: '—',
          taxable: taxable ? money(l.taxable_value) : '—', gstLabel: taxable ? `${num(l.gst_rate)}%` : (TAXCAT_LABEL[l.tax_category] || '—'),
          cgst: taxable ? money(l.cgst_amount) : '—', sgst: taxable ? money(l.sgst_amount) : '—', amount: money(l.line_total) }
      : { no: ++i, description: l.description || '—', code: l.sac_code || l.hsn_code || null, qty: '1', rate: money(l.line_total), amount: money(l.line_total) }
  })
  const sections = rows.length ? [{ title: 'Credited', rows, subtotal: money(sub) }] : []

  let taxSummary = null, taxNote = null
  if (withTax) {
    const byKey = new Map()
    for (const l of d.lines || []) {
      const taxable = l.tax_category === 'TAXABLE'
      const key = taxable ? `r${num(l.gst_rate)}` : l.tax_category || 'NONE'
      const x = byKey.get(key) || { label: taxable ? `${num(l.gst_rate)}% (${num(l.cgst_rate)}% + ${num(l.sgst_rate)}%)` : (TAXCAT_LABEL[l.tax_category] || 'Other'),
                                    value: 0, cgst: 0, sgst: 0, taxable }
      x.value += num(taxable ? l.taxable_value : l.line_total); x.cgst += num(l.cgst_amount); x.sgst += num(l.sgst_amount)
      byKey.set(key, x)
    }
    taxSummary = [...byKey.values()].map(x => ({ label: x.label, value: money(x.value), cgst: x.taxable ? money(x.cgst) : '—',
      sgst: x.taxable ? money(x.sgst) : '—', tax: x.taxable ? money(x.cgst + x.sgst) : '—' }))
  } else {
    taxNote = `Credit note against a Bill of Supply — no GST is credited.`
  }

  const summary = []
  if (withTax) {
    summary.push({ label: 'Taxable value credited', value: money(n.taxable_total) })
    summary.push({ label: 'Exempt / non-taxable value credited', value: money(num(n.exempt_total) + num(n.nil_rated_total) + num(n.non_gst_total)) })
    summary.push({ label: 'CGST credited', value: money(n.cgst_total) })
    summary.push({ label: 'SGST credited', value: money(n.sgst_total) })
  } else {
    summary.push({ label: 'Value credited', value: money(n.total_amount) })
  }
  summary.push({ label: 'Credit note total', value: rupee(n.total_amount), grand: true })
  const balance = { label: `Refund (${MODE_LABEL[r.mode] || r.mode || '—'})`, value: rupee(r.amount) }   // fixed at approval, never its later state

  const footer = []
  if (mk.footer) footer.push(mk.footer)
  footer.push(refundText(r) + '.')
  footer.push('Computer-generated credit note. · Powered by AyurXpert')
  return {
    org, title: n.heading || 'CREDIT NOTE', subtitle: mk.mark, watermark: mk.watermark, meta, demo: !!d.organisation?.is_demo, demoText: DEMO_GST_TEXT,
    party: { title: 'Recipient Details', fields },
    gst: withTax, exemptOnly: false, descLabel: pharmacy ? 'Medicine' : 'Service / Test', noCode: false,
    sections, emptyNote: rows.length ? null : 'No lines on this credit note.', taxNote, taxSummary, payments: null,
    summary: { rows: summary, balance },
    words: { label: 'Amount in words (credit note total)', lines: [`${amountInWords(n.total_amount)}.`] },
    signatures: { left: [`Issued by: ${n.issued_by || '____________________'}`, n.requested_by ? `Requested by: ${n.requested_by}` : null].filter(Boolean),
                  right: ['Authorised Signatory', `for ${org.name}`] },
    footer,
  }
}

export function buildVoucherModel(d, copy) {
  const n = d.note || {}, pt = d.patient || {}, r = d.refund || {}
  const org = orgBlock(d)
  const mk = copyMarking(copy, { fmtDT })
  return {
    org, title: 'Refund Voucher', subtitle: `Cash refund against a credit note · ${mk.mark}`, watermark: mk.watermark, demo: !!d.organisation?.is_demo, demoText: DEMO_GST_TEXT,
    meta: [
      { label: 'Voucher No.', value: r.receipt_no || '—' },
      { label: 'Paid on', value: fmtDT(r.paid_at) },
      { label: 'Credit Note No.', value: n.document_number || '—' },
      { label: `Original ${DOC[n.original_document_type] || 'Bill'} No.`, value: n.original_document_number || '—', sub: fmtD(n.original_document_date) },
    ],
    party: { title: d.patient || String(n.bill_type || '').toLowerCase() !== 'pharmacy' ? 'Patient Details' : 'Customer Details', fields: [
      { label: d.patient || String(n.bill_type || '').toLowerCase() !== 'pharmacy' ? 'Patient Name' : 'Customer', value: n.recipient_name || pt.name || (d.patient ? '—' : 'Walk-in customer'), wide: true },
      { label: 'UHID', value: uhidOf(pt) },
      { label: 'Mode', value: MODE_LABEL[r.mode] || r.mode || '—' },
      { label: 'Paid by', value: r.paid_by || '—' },
      { label: 'Against', value: `Credit note ${n.document_number || '—'} of ${fmtD(n.document_date) || '—'} · ${DOC[n.original_document_type] || 'Bill'} ${n.original_document_number || '—'} dated ${fmtD(n.original_document_date) || '—'}`, full: true },
    ] },
    gst: false, descLabel: 'Description', noCode: true,
    sections: [{ title: 'Refund', rows: [{ no: 1, description: `Refund of credit note ${n.document_number || ''}`.trim(), qty: '1', rate: money(r.amount), amount: money(r.amount) }],
                 subtotal: money(r.amount) }],
    emptyNote: null, taxNote: null, taxSummary: null, payments: null,
    summary: { rows: [{ label: 'Refund paid (cash)', value: rupee(r.amount), grand: true }], balance: { label: 'Paid in cash', value: rupee(r.amount) } },
    words: { label: 'Refund in words', lines: [`${amountInWords(r.amount)}.`] },
    signatures: { left: [`Received the refund of ${rupee(r.amount)} (${MODE_LABEL[r.mode] || r.mode || '—'})`, 'Received by (patient / attendant): ____________________ signature'],
                  right: [`Paid by: ${r.paid_by || '____________________'}`, `for ${org.name}`] },
    footer: [mk.footer, 'Computer-generated refund voucher — not a tax invoice or credit note. · Powered by AyurXpert'].filter(Boolean),
  }
}

async function load() {
  if (!cnId && !voucher) { showError('No credit note specified.'); return }
  if (!(await ensureSignedIn(supabase))) return
  let noteId = cnId
  if (voucher) {
    const { data, error } = await supabase.from('credit_note_refund_payouts').select('credit_note_id').eq('payment_id', voucher).maybeSingle()
    if (error || !data) { showError(safeErrorMessage(error, 'This refund voucher was not found.')); return }
    noteId = data.credit_note_id
  }
  const { data, error } = await supabase.rpc('get_credit_note', { p_id: noteId })
  if (error || !data?.note) { showError(safeErrorMessage(error, 'Could not load the credit note.')); return }
  if (voucher && data.refund?.payment_id !== voucher) { showError('This refund voucher does not belong to the credit note.'); return }
  // Print audit first: an unmarked copy must never be printable (fail closed)
  const type = voucher ? 'refund_voucher' : supplier ? 'credit_note_supplier' : 'credit_note'
  const rec = await supabase.rpc('record_document_print', { p_doc_type: type, p_doc_id: voucher || noteId })
  if (rec.error || !rec.data || (!voucher && !rec.data.label)) { showError(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return }
  const model = voucher ? buildVoucherModel(data, rec.data) : buildCreditNoteModel(data, rec.data, { supplierCopy: supplier, origTotals: await originalLineTotals(noteId) })
  const draw = size => {
    renderDocument(sheet, model, size)
    sheet.querySelector('.logo-img')?.addEventListener('error', e => e.target.remove())
  }
  draw(getPaperSize())
  mountPaperSizeSelect(document.getElementById('paper-slot'), draw)
  watchPrintPageSize(() => sheet)
  document.title = `${voucher ? 'Refund Voucher ' + (data.refund?.receipt_no || '') : 'Credit Note ' + (data.note.document_number || '')} — ${data.note.recipient_name || data.patient?.name || ''}`.replace(/\s+/g, ' ').trim()
  printBtn.disabled = false
  if (supBtn) supBtn.hidden = !!voucher || supplier       // D5: every credit note has the optional supplier copy
  setStatus('')
}

// each credit-note line's ORIGINAL line total (own organisation's rows, RLS) -- to mark a part credit; on any error the print simply
// keeps qty x rate (the figures themselves are the note's stored values either way)
async function originalLineTotals(noteId) {
  const cl = await supabase.from('credit_note_lines').select('line_no, original_line_id').eq('credit_note_id', noteId)
  if (cl.error || !cl.data?.length) return {}
  const bi = await supabase.from('bill_items').select('id, line_total').in('id', cl.data.map(x => x.original_line_id))
  if (bi.error || !bi.data) return {}
  const tot = new Map(bi.data.map(x => [x.id, x.line_total]))
  return Object.fromEntries(cl.data.filter(x => tot.has(x.original_line_id)).map(x => [x.line_no, tot.get(x.original_line_id)]))
}

// opened straight from the click (no await first), so the browser never blocks it as a pop-up
window.printSupplierCopy = () => openSupplierCopy()

load()
