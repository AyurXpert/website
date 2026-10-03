// Pharmacy bill / Bill cum Receipt -- printPharmacyBill.html?billId=<id> (Session 334, GST Stage 3 Part D).
// Every figure is a STORED value from get_pharmacy_bill_print() (one line per batch, with its batch number and
// expiry; totals, discount, round off; receipts); this file only formats. The SERVER decides ORIGINAL vs
// DUPLICATE COPY (record_document_print) and the page fails closed if that cannot be recorded.
// Layout: js/modules/billing/invoiceLayout.js (shared with the OPD / lab and IPD bills).
import { supabase } from '../core/db/supabaseClient.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { safeErrorMessage } from '../utils/errors.js'
import { uhidOf } from '../utils/uhid.js'
import { isCombinedPayment } from '../modules/billing/opdPayments.js'
import { el } from '../modules/billing/invoiceLayout.js'
import { getPaperSize, applyPaperSize, mountPaperSizeSelect, renderDocument } from '../modules/billing/paperSize.js'

wireDelegatedEvents()
applyPaperSize(getPaperSize())   // Session 336: A4 / A5 / thermal 80 / 58 mm, remembered per device

const billId   = new URLSearchParams(window.location.search).get('billId')
const sheet    = document.getElementById('invoice')
const statusEl = document.getElementById('status')
const printBtn = document.getElementById('print-btn')

const MODE_LABEL   = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT', credit: 'Credit / Due' }
const DOC_TITLE    = { TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply', BILL: 'Bill' }
const TAXCAT_LABEL = { EXEMPT: 'Exempt', NIL_RATED: 'Nil-rated', NON_GST: 'Non-GST', OUT_OF_SCOPE: 'Out of scope' }
const SEX = { f: 'Female', female: 'Female', m: 'Male', male: 'Male', o: 'Other', other: 'Other' }

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

function buildModel(d, copy) {
  const b = d.bill, pt = d.patient || {}, org = d.organisation || {}, tax = d.tax || {}, rx = d.prescription, ph = d.pharmacist
  const isGst   = b.tax_regime === 'gst_v1'
  const isDraft = isGst && b.document_status === 'draft'
  const docType = b.document_type
  const live    = (d.payments || []).filter(p => !p.voided)
  const paid    = live.filter(p => p.kind === 'payment').reduce((s, p) => s + num(p.amount), 0)
  const combined = isCombinedPayment({ final_amount: b.final_amount, created_at: b.created_at },
                                     (d.payments || []).map(p => ({ ...p, voided_at: p.voided ? 'x' : null })))
  const noCharge = num(b.final_amount) < 0.005

  // ── Pharmacy header: a GST document prints the supplier details frozen on it; a plain bill, the organisation ──
  let orgName, orgLines
  if (isGst && !isDraft && b.supplier_legal_name) {
    orgName  = b.supplier_legal_name
    orgLines = [b.supplier_address,
                b.supplier_gstin ? `GSTIN: ${b.supplier_gstin}${b.supplier_state_code ? ' · State code ' + b.supplier_state_code : ''}` : 'Not registered under GST']
  } else {
    orgName  = org.name || 'Pharmacy'
    orgLines = [org.address || [org.city, org.state].filter(Boolean).join(', '),
                [org.phone ? `Ph: ${org.phone}` : null, org.email].filter(Boolean).join(' · '),
                tax.gst_registered && tax.gstin ? `GSTIN: ${tax.gstin}` : null]
  }
  if (org.license_number) orgLines.push(`Licence No.: ${org.license_number}`)
  orgLines = orgLines.filter(Boolean)

  // ── Title / copy ──
  let title = combined && !noCharge ? 'Bill cum Receipt' : 'Bill', watermark = null
  if (isGst) {
    if (isDraft) { title = 'Draft Bill'; watermark = 'DRAFT — NOT A TAX INVOICE' }
    else { title = DOC_TITLE[docType] || 'Bill'; if (b.document_status === 'cancelled') watermark = 'CANCELLED' }
  }
  const isDup  = copy.copy !== 'ORIGINAL'
  const copyNo = (Number(copy.print_no) || 1) + (copy.legacy ? 1 : 0)
  if (isDup && !watermark) watermark = 'DUPLICATE COPY'
  const subtitle = `Pharmacy${combined && !noCharge ? ' · Paid in full' : ''}${noCharge ? ' · No charge' : ''} · ${isDup ? 'DUPLICATE COPY · No. ' + copyNo : 'Original'}`

  const meta = [
    { label: isGst && !isDraft && docType === 'TAX_INVOICE' ? 'Invoice No.' : 'Bill No.', value: b.document_number || 'Not numbered', gap: !b.document_number },
    { label: isGst && !isDraft && docType === 'TAX_INVOICE' ? 'Invoice Date' : 'Bill Date', value: fmtDT(b.created_at) },
  ]
  if (rx?.prescriber) meta.push({ label: 'Prescribed by', value: rx.prescriber,
    sub: rx.prescriber_registration_number ? `Reg. No. ${rx.prescriber_registration_number}` : 'Reg. No. not recorded' })

  // ── Patient ──
  const sex = SEX[(pt.gender || '').toLowerCase()] || pt.gender || null
  const fields = [
    { label: 'Patient Name', value: pt.name, wide: true },
    { label: 'Age / Sex', value: [pt.age != null ? `${pt.age} Y` : null, sex].filter(Boolean).join(' / ') || null },
    { label: 'UHID', value: uhidOf(pt) },
    { label: 'Phone', value: pt.phone },
    { label: 'Payment', value: MODE_LABEL[b.payment_mode] || b.payment_method || '—' },
  ]

  // ── Medicines: one row per batch -- batch + expiry under the name; HSN / tax columns on a GST document ──
  const exemptOnly = isGst && d.lines.length > 0 && !d.lines.some(l => l.tax_category === 'TAXABLE')
  let n = 0, sub = 0
  const rows = d.lines.map(l => {
    const taxable = l.tax_category === 'TAXABLE'
    const amount = isGst ? (l.line_total ?? l.total) : l.total
    sub += num(amount)
    const batchLine = [l.batch_number ? `Batch ${l.batch_number}` : 'Batch not recorded', l.expiry_date ? `Exp ${fmtExp(l.expiry_date)}` : null]
      .filter(Boolean).join(' · ')
    return {
      no: ++n, description: l.description, sub: batchLine, code: l.hsn_code || null,
      qty: String(num(l.qty)), rate: money(l.price),
      disc: money(num(l.line_discount) + num(l.bill_discount_alloc)), taxable: taxable ? money(l.taxable_value) : '—',
      gstLabel: taxable ? `${num(l.gst_rate)}%` : (TAXCAT_LABEL[l.tax_category] || '—'),
      cgst: taxable ? money(l.cgst_amount) : '—', sgst: taxable ? money(l.sgst_amount) : '—', amount: money(amount),
    }
  })
  const sections = rows.length ? [{ title: 'Medicines', rows, subtotal: money(sub) }] : []

  // ── GST tax summary ──
  let taxSummary = null, taxNote = null
  if (exemptOnly) {
    taxNote = `GST: ${[...new Set(d.lines.map(l => TAXCAT_LABEL[l.tax_category] || 'Not taxable'))].join(' / ')} — no GST is charged on this bill.`
  } else if (isGst) {
    const byKey = new Map()
    for (const l of d.lines) {
      const taxable = l.tax_category === 'TAXABLE'
      const key = taxable ? `r${num(l.gst_rate)}` : l.tax_category || 'NONE'
      const r = byKey.get(key) || { label: taxable ? `${num(l.gst_rate)}% (${num(l.cgst_rate)}% + ${num(l.sgst_rate)}%)` : (TAXCAT_LABEL[l.tax_category] || 'Other'),
                                    value: 0, cgst: 0, sgst: 0, taxable }
      r.value += num(taxable ? l.taxable_value : (l.line_total ?? l.total)); r.cgst += num(l.cgst_amount); r.sgst += num(l.sgst_amount)
      byKey.set(key, r)
    }
    taxSummary = [...byKey.values()].map(r => ({ label: r.label, value: money(r.value), cgst: r.taxable ? money(r.cgst) : '—',
      sgst: r.taxable ? money(r.sgst) : '—', tax: r.taxable ? money(r.cgst + r.sgst) : '—' }))
  }

  // ── Receipts (voided ones struck through) ──
  const payRows = (d.payments || []).map(p => ({
    receiptNo: p.receipt_no, date: fmtDT(p.received_at), type: p.kind === 'refund' ? 'Refund' : 'Payment',
    mode: [MODE_LABEL[p.mode] || p.mode, p.mode !== 'cash' ? p.reference : null].filter(Boolean).join(' · '),
    by: p.received_by || '—', amount: (p.kind === 'refund' ? '−' : '') + money(p.amount),
    voided: !!p.voided, voidReason: p.void_reason }))
  const payments = payRows.length ? { title: combined ? 'Payment Received' : 'Payments Received', rows: payRows, totalLabel: 'Total received', total: money(paid) } : null

  // ── Summary: gross, discount (+reason), round off, total ──
  const summary = []
  if (isGst) {
    summary.push({ label: 'Gross (MRP)', value: money(b.gross_total) })
    summary.push({ label: 'Less: discount', value: money(num(b.line_discount_total) + num(b.bill_discount_total)) })
    if (!exemptOnly) summary.push({ label: 'Taxable value', value: money(b.taxable_total) })
    summary.push({ label: 'Exempt / non-taxable value', value: money(num(b.exempt_total) + num(b.nil_rated_total) + num(b.non_gst_total)) })
    if (!exemptOnly) { summary.push({ label: 'CGST (included in MRP)', value: money(b.cgst_total) }); summary.push({ label: 'SGST (included in MRP)', value: money(b.sgst_total) }) }
    summary.push({ label: docType === 'TAX_INVOICE' ? 'Invoice total' : 'Bill total', value: rupee(b.final_amount), grand: true })
  } else {
    const gross = num(b.total_amount), disc = num(b.discount)
    const roundOff = Math.round((num(b.final_amount) - (gross - disc)) * 100) / 100
    summary.push({ label: 'Gross (MRP)', value: money(gross) })
    if (disc > 0) summary.push({ label: `Less: discount${b.discount_reason ? ` (${b.discount_reason})` : ''}`, value: money(disc) })
    if (Math.abs(roundOff) >= 0.005) summary.push({ label: 'Round off', value: (roundOff > 0 ? '+' : '−') + money(Math.abs(roundOff)) })
    summary.push({ label: 'Net bill amount', value: rupee(b.final_amount), grand: true })
  }
  if (payments) summary.push({ label: 'Less: payments received', value: money(paid) })
  const due = Math.max(num(b.final_amount) - paid, 0)
  const balance = { label: 'Balance Due', value: rupee(due) }
  const words = [`${amountInWords(b.final_amount)}.`]
  if (noCharge) words.push('No charge.')
  else if (due < 0.005) words.push(combined ? 'Paid in full — received with thanks.' : 'Paid in full.')
  else words.push(`Balance due: ${amountInWords(due)}.`)

  // ── Signatures: the pharmacist who dispensed it (name, qualification, registration no.) ──
  const left = [`Dispensed by: ${ph?.name || '____________________'}`]
  if (ph?.qualification) left.push(ph.qualification)
  left.push(ph?.registration_number ? `Pharmacist Reg. No. ${ph.registration_number}` : 'Pharmacist Reg. No. ____________')

  const footer = []
  if (isGst && docType === 'TAX_INVOICE' && !isDraft) footer.push('Whether tax is payable on reverse charge: No.')
  if (combined && !noCharge) footer.push('This document serves as both the bill and the payment receipt.')
  footer.push('Medicines once sold are taken back only as per the pharmacy\'s return policy, with this bill.')
  if (isDup) {
    footer.push(`Duplicate copy no. ${copyNo}. ${copy.legacy
      ? 'Issued before print tracking began — an original may already have been given to the patient.'
      : `The original was first printed ${fmtDT(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}.`}`)
  }
  footer.push(`${isDraft ? 'Draft bill — not a tax invoice' : isGst ? `Computer-generated ${(DOC_TITLE[docType] || 'bill').toLowerCase()}` : 'Computer-generated bill — not a tax invoice'}. · Powered by AyurXpert`)

  return {
    org: { name: orgName, lines: orgLines, logoUrl: org.logo_url || null, monogram: monogram(orgName) },
    title, subtitle, watermark, meta, demo: !!org.is_demo,
    party: { title: 'Patient Details', fields },
    gst: isGst, exemptOnly, descLabel: 'Medicine', noCode: !isGst,
    sections, emptyNote: rows.length ? null : 'No medicines on this bill.', taxNote, taxSummary, payments,
    summary: { rows: summary, balance },
    words: { label: `Amount in words (${isGst && docType === 'TAX_INVOICE' && !isDraft ? 'invoice total' : 'bill total'})`, lines: words },
    signatures: { left, right: ['Registered Pharmacist', `for ${orgName}`] },
    footer,
  }
}

async function load() {
  if (!billId) { showError('No bill specified.'); return }
  const { data, error } = await supabase.rpc('get_pharmacy_bill_print', { p_bill: billId })
  if (error || !data?.bill) { showError(safeErrorMessage(error, 'Could not load the bill.')); return }
  // Print audit first: an unmarked copy must never be printable (fail closed)
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'bill', p_doc_id: billId })
  if (rec.error || !rec.data) { showError(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return }
  const model = buildModel(data, rec.data)
  const draw = size => {
    renderDocument(sheet, model, size)
    sheet.querySelector('.logo-img')?.addEventListener('error', e => e.target.remove())
  }
  draw(getPaperSize())
  // changing the paper size only re-lays out THIS copy -- it never records another print (no server call)
  mountPaperSizeSelect(document.getElementById('paper-slot'), draw)
  document.title = `${model.title} ${data.bill.document_number || ''} — ${data.patient?.name || ''}`.replace(/\s+/g, ' ').trim()
  printBtn.disabled = false
  setStatus('')
}

load()
