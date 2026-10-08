// OPD visit bill / lab bill -- printOpdBill.html?billId=<id> (Session 327c).
// One proper document for OPD and lab charges: hospital letterhead, bill number, patient + UHID, visit /
// doctor, a "Service / Test" table, totals, amount in words, and -- when the bill was paid in full at the
// moment it was created (registration, lab collect) -- the payment section, so the page IS the bill AND the
// receipt ("Bill cum Receipt"). A bill settled later keeps its separate receipt (printReceipt.html); this
// page then lists the payments received. Every figure is a stored column (bills / bill_items /
// patient_payments); this file only formats. Layout: js/modules/billing/invoiceLayout.js.
import { supabase } from '../core/db/supabaseClient.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { safeErrorMessage } from '../utils/errors.js'
import { uhidOf } from '../utils/uhid.js'
import { billCategory } from '../modules/billing/billCategory.js'
import { isCombinedPayment } from '../modules/billing/opdPayments.js'
import { renderInvoice, el } from '../modules/billing/invoiceLayout.js'
import { isDemoTenant } from '../modules/billing/demoBanner.js'
import { ensureSignedIn } from '../utils/signInGate.js'
import { copyMarking, isSupplierCopy, canPrintSupplierCopy, openSupplierCopy } from '../modules/billing/copyMarking.js'

wireDelegatedEvents()

const billId   = new URLSearchParams(window.location.search).get('billId')
const supplier = isSupplierCopy()   // Session 345c2b: ?copy=supplier = the supplier copy of a Tax Invoice
const sheet    = document.getElementById('invoice')
const statusEl = document.getElementById('status')
const printBtn = document.getElementById('print-btn')
const supBtn   = document.getElementById('supplier-btn')

const tenant = (() => { try { return JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}') } catch { return {} } })()

const MODE_LABEL   = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' }
const PAYER_LABEL  = { insurance: 'Insurance', pmjay: 'PM-JAY', cghs: 'CGHS', echs: 'ECHS', esi: 'ESI', corporate: 'Corporate' }
const DOC_TITLE    = { TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply', BILL: 'Bill' }
const TAXCAT_LABEL = { EXEMPT: 'Exempt', NIL_RATED: 'Nil-rated', NON_GST: 'Non-GST', OUT_OF_SCOPE: 'Out of scope' }
const SEX = { f: 'Female', female: 'Female', m: 'Male', male: 'Male', o: 'Other', other: 'Other' }

const num   = v => Number(v) || 0
const money = v => num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const rupee = v => `₹ ${money(v)}`
// Dates always in IST, "02 Oct 2026, 04:00 PM" (fixed month names -- en-IN's own short month is "Sept")
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function istParts(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(new Date(iso)).map(x => [x.type, x.value]))
  return { d: p.day, m: MON[Number(p.month) - 1], y: p.year, time: `${p.hour}:${p.minute} ${(p.dayPeriod || '').toUpperCase()}` }
}
const fmtDT = iso => { if (!iso) return null; const p = istParts(iso); return `${p.d} ${p.m} ${p.y}, ${p.time}` }
const fmtD  = d => { if (!d) return null; const p = istParts(d.length === 10 ? `${d}T12:00:00+05:30` : d); return `${p.d} ${p.m} ${p.y}` }
const monogram = name => (name || '').split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0].toUpperCase()).join('')

function setStatus(msg, isErr = false) { statusEl.textContent = msg || ''; statusEl.className = 'status-msg' + (isErr ? ' err' : '') }
function showError(msg) { sheet.replaceChildren(el('p', { class: 'error-box' }, msg)); printBtn.disabled = true }

function buildModel(d, copy) {
  const b = d.bill, pt = d.patient || {}, v = d.visit || {}, tax = d.tax || {}
  const isGst   = b.tax_regime === 'gst_v1'
  const isDraft = isGst && b.document_status === 'draft'
  const docType = b.document_type
  const cat     = billCategory(b.bill_type)
  const live    = d.payments.filter(p => !p.voided_at)
  const paid    = live.filter(p => p.kind === 'payment').reduce((s, p) => s + num(p.amount), 0)
  const combined = isCombinedPayment(b, d.payments)
  // No taxable line at all (e.g. a Bill of Supply for exempt healthcare services): no tax columns / tax summary
  const exemptOnly = isGst && d.items.length > 0 && !d.items.some(it => it.tax_category === 'TAXABLE')

  // ── Hospital block: a GST document prints the supplier details frozen on the bill ──
  let orgName, orgLines
  if (isGst && !isDraft && b.supplier_legal_name) {
    orgName  = b.supplier_legal_name
    orgLines = [b.supplier_address,
                b.supplier_gstin ? `GSTIN: ${b.supplier_gstin}${b.supplier_state_code ? ' · State code ' + b.supplier_state_code : ''}` : 'Not registered under GST']
  } else {
    orgName  = tenant.name || 'Hospital'
    const gstin = tax.gst_registered ? (tax.gstin || tenant.gstin) : null
    orgLines = [tenant.full_address || tenant.address || [tenant.city, tenant.state].filter(Boolean).join(', '),
                [tenant.phone ? `Ph: ${tenant.phone}` : null, tenant.email].filter(Boolean).join(' · '),
                gstin ? `GSTIN: ${gstin}` : null]
  }
  orgLines = orgLines.filter(Boolean)

  // ── Title ──
  let title = combined ? 'Bill cum Receipt' : 'Bill', watermark = null
  if (isGst) {
    if (isDraft) { title = 'Draft Bill'; watermark = 'DRAFT — NOT A TAX INVOICE' }
    else {
      title = DOC_TITLE[docType] || 'Bill'
      if (b.document_status === 'cancelled') watermark = 'CANCELLED'
    }
  }
  const kind = cat === 'investigation' ? 'Laboratory / Investigations' : 'Out-Patient'
  // Copy marking: decided by the server (record_document_print) from the print audit trail -- Session 345c2b: a Tax Invoice
  // says ORIGINAL FOR RECIPIENT / REPRINT · ... · No. N, its supplier copy the server's supplier label (js/modules/billing/copyMarking.js)
  const mk = copyMarking(copy, { supplier, fmtDT })
  const subtitle = `${kind}${combined && !(num(b.final_amount) < 0.005) ? ' · Paid in full' : ''}${num(b.final_amount) < 0.005 ? ' · No charge' : ''} · ${mk.mark}`
  if (mk.watermark && !watermark) watermark = mk.watermark

  // ── Header strip ──
  const meta = [
    // "Invoice No." only on a Tax Invoice; a Bill of Supply (and every other bill) carries a Bill No.
    { label: isGst && !isDraft && docType === 'TAX_INVOICE' ? 'Invoice No.' : 'Bill No.', value: b.document_number || 'Not numbered', gap: !b.document_number },
    // Session 345c2b (Rule 49): a finalised GST document shows its document date; anything else the date it was made
    { label: isGst && !isDraft && docType === 'TAX_INVOICE' ? 'Invoice Date' : 'Bill Date',
      value: isGst && !isDraft && b.document_date ? fmtD(b.document_date) : fmtDT(b.created_at) },
  ]
  if (v.token_number != null) meta.push({ label: 'Visit', value: `Token ${v.token_number}`, sub: v.created_at ? fmtD(v.created_at) : null })
  if (d.doctor) meta.push({ label: 'Doctor', value: d.doctor, sub: d.opd || null })

  // ── Patient ──
  const sex = SEX[(pt.gender || '').toLowerCase()] || pt.gender || null
  const ageSex = [pt.age != null ? `${pt.age} Y` : null, sex].filter(Boolean).join(' / ') || null
  const fields = [
    { label: 'Patient Name', value: pt.name, wide: true },
    { label: 'Age / Sex', value: ageSex },
    { label: 'UHID', value: uhidOf(pt) },
    { label: 'Phone', value: pt.phone },
    { label: 'Payer', value: b.payer_type && b.payer_type !== 'self_pay' ? (PAYER_LABEL[b.payer_type] || b.payer_type) : 'Self-pay' },
  ]
  fields.push({ label: 'Address', value: pt.address || 'Not recorded', gap: !pt.address, wide: true })
  // Session 345c2b (Rule 49): the recipient's GSTIN, when the bill has one
  if (isGst && b.recipient_gstin) fields.push({ label: 'Recipient GSTIN', value: b.recipient_gstin })

  // ── Charges ──
  let n = 0
  const sections = []
  if (isGst) {
    const groups = new Map()
    for (const it of d.items) {
      const k = it.bill_section || (cat === 'investigation' ? 'Investigations' : 'Consultation')
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(it)
    }
    for (const [k, items] of groups) {
      let sub = 0
      const rows = items.map(it => {
        const taxable = it.tax_category === 'TAXABLE'
        const amount = it.line_total ?? it.total
        sub += num(amount)
        return {
          no: ++n, description: it.description, code: it.sac_code || it.hsn_code || null, qty: String(num(it.quantity)), rate: money(it.price),
          disc: money(num(it.line_discount) + num(it.bill_discount_alloc)), taxable: taxable ? money(it.taxable_value) : '—',
          gstLabel: taxable ? `${num(it.gst_rate)}%` : (TAXCAT_LABEL[it.tax_category] || '—'),
          cgst: taxable ? money(it.cgst_amount) : '—', sgst: taxable ? money(it.sgst_amount) : '—', amount: money(amount) }
      })
      sections.push({ title: k, rows, subtotal: money(sub) })
    }
  } else {
    const fee = []
    if (num(b.registration_fee) > 0)      fee.push(['Registration', b.registration_fee])
    if (num(b.consultation_fee) > 0)      fee.push(['Consultation', b.consultation_fee])
    if (num(b.on_request_surcharge) > 0)  fee.push(['On-request surcharge', b.on_request_surcharge])
    if (fee.length) {
      sections.push({ title: 'Consultation', rows: fee.map(([label, amt]) => ({ no: ++n, description: label, qty: '1', rate: money(amt), amount: money(amt) })),
                      subtotal: money(fee.reduce((s, [, a]) => s + num(a), 0)) })
    }
    if (d.items.length) {
      let sub = 0
      const rows = d.items.map(it => {
        const gst = num(it.gst_amount)
        const amount = (it.total != null ? num(it.total) : num(it.quantity) * num(it.price)) + gst
        sub += amount
        return { no: ++n, description: it.description, sub: gst > 0 ? `incl. GST ${money(gst)}` : null, qty: String(num(it.quantity) || 1), rate: money(it.price), amount: money(amount) }
      })
      sections.push({ title: 'Investigations / Tests', rows, subtotal: money(sub) })
    }
  }

  // ── GST tax summary (by rate, from the stored line values) ──
  let taxSummary = null, taxNote = null
  // Session 345c2b: a Bill of Supply prints the declaration frozen on it at issue (footer) INSTEAD of the exempt note;
  // an older Bill of Supply (none frozen) keeps the note
  const declaration = isGst && !isDraft && docType === 'BILL_OF_SUPPLY' && b.bos_declaration ? b.bos_declaration : null
  if (exemptOnly && declaration) {
    taxNote = null
  } else if (exemptOnly) {
    const cats = [...new Set(d.items.map(it => TAXCAT_LABEL[it.tax_category] || 'Not taxable'))].join(' / ')
    taxNote = `GST: ${cats} — no GST is charged on this bill.`
  } else if (isGst) {
    const byKey = new Map()
    for (const it of d.items) {
      const taxable = it.tax_category === 'TAXABLE'
      const key = taxable ? `r${num(it.gst_rate)}` : it.tax_category || 'NONE'
      const r = byKey.get(key) || { label: taxable ? `${num(it.gst_rate)}% (${num(it.cgst_rate)}% + ${num(it.sgst_rate)}%)` : (TAXCAT_LABEL[it.tax_category] || 'Other'),
                                    value: 0, cgst: 0, sgst: 0, taxable }
      r.value += num(taxable ? it.taxable_value : (it.line_total ?? it.total))
      r.cgst += num(it.cgst_amount); r.sgst += num(it.sgst_amount)
      byKey.set(key, r)
    }
    taxSummary = [...byKey.values()].map(r => ({ label: r.label, value: money(r.value), cgst: r.taxable ? money(r.cgst) : '—',
      sgst: r.taxable ? money(r.sgst) : '—', tax: r.taxable ? money(r.cgst + r.sgst) : '—' }))
  }

  // ── Payment section: every ledger row (voided ones struck through) -- no internal notes are ever printed ──
  const payRows = d.payments.map(p => ({
    receiptNo: p.receipt_no, date: fmtDT(p.received_at), type: p.kind === 'refund' ? 'Refund' : 'Payment',
    mode: [MODE_LABEL[p.mode] || p.mode, p.reference].filter(Boolean).join(' · '),
    by: d.names[p.received_by] || '—', amount: (p.kind === 'refund' ? '−' : '') + money(p.amount),
    voided: !!p.voided_at, voidReason: p.void_reason }))
  const payments = payRows.length
    ? { title: combined ? 'Payment Received' : 'Payments Received', rows: payRows, totalLabel: 'Total received', total: money(paid) } : null

  // ── Summary ──
  const rows = []
  if (isGst) {
    rows.push({ label: 'Gross charges', value: money(b.gross_total) })
    rows.push({ label: 'Less: discount', value: money(num(b.line_discount_total) + num(b.bill_discount_total)) })
    if (!exemptOnly) rows.push({ label: 'Taxable value', value: money(b.taxable_total) })
    rows.push({ label: 'Exempt / non-taxable value', value: money(num(b.exempt_total) + num(b.nil_rated_total) + num(b.non_gst_total)) })
    if (!exemptOnly) {
      rows.push({ label: 'CGST', value: money(b.cgst_total) })
      rows.push({ label: 'SGST', value: money(b.sgst_total) })
    }
    rows.push({ label: docType === 'TAX_INVOICE' ? 'Invoice total' : 'Bill total', value: rupee(b.final_amount), grand: true })
  } else {
    rows.push({ label: 'Gross charges', value: money(b.total_amount ?? b.final_amount) })
    if (num(b.discount) > 0) rows.push({ label: `Less: discount${b.discount_reason ? ` (${b.discount_reason})` : ''}`, value: money(b.discount) })
    rows.push({ label: 'Net bill amount', value: rupee(b.final_amount), grand: true })
  }
  if (isGst && num(b.bill_discount_total) > 0 && b.discount_reason) rows.push({ label: `Discount reason: ${b.discount_reason}`, value: '' })
  if (payments) rows.push({ label: 'Less: payments received', value: money(paid) })

  const noCharge = num(b.final_amount) < 0.005
  const due = Math.max(num(b.final_amount) - paid, 0)
  const paidInFull = b.status === 'paid' && (due < 0.005 || !payments)
  const balance = paidInFull ? { label: 'Balance Due', value: rupee(0) } : { label: 'Balance Due', value: rupee(due) }
  const wordsLines = [`${amountInWords(b.final_amount)}.`]
  // a bill whose net amount is nil (e.g. fees were not configured then) says "No charge", never "Paid in full"
  if (noCharge) wordsLines.push('No charge.')
  else if (paidInFull) wordsLines.push(combined ? 'Paid in full — received with thanks.' : 'Paid in full.')
  else if (due > 0.005) wordsLines.push(`Balance due: ${amountInWords(due)}.`)

  const preparedBy = d.names[b.created_by] || (payments && d.names[d.payments[0]?.received_by]) || null
  const left = [`Prepared by: ${preparedBy || '____________________'}`]
  const footer = []
  if (isGst && docType === 'TAX_INVOICE' && !isDraft) footer.push('Whether tax is payable on reverse charge: No.')
  if (declaration) footer.push(declaration)
  if (combined && !supplier) footer.push('This document serves as both the bill and the payment receipt.')
  if (mk.footer) footer.push(mk.footer)
  const docWord = isDraft ? 'Draft bill — not a tax invoice' : isGst ? `Computer-generated ${(DOC_TITLE[docType] || 'bill').toLowerCase()}` : 'Computer-generated bill — not a tax invoice'
  footer.push(`${docWord}. · Powered by AyurXpert`)

  return {
    org: { name: orgName, lines: orgLines, logoUrl: tenant.logo_url || null, monogram: monogram(orgName) },
    title, subtitle, watermark, meta,
    party: { title: 'Patient Details', fields },
    demo: d.isDemo, gst: isGst, exemptOnly, descLabel: 'Service / Test', noCode: !isGst,
    sections, emptyNote: null, taxNote, taxSummary, payments,
    summary: { rows, balance },
    words: { label: `Amount in words (${!isGst ? 'net bill amount' : docType === 'TAX_INVOICE' && !isDraft ? 'invoice total' : 'bill total'})`, lines: wordsLines },
    signatures: { left, right: ['Authorised Signatory', `for ${orgName}`] },
    footer,
  }
}

async function load() {
  if (!billId) { showError('No bill specified.'); return }
  // signed out / session ended: ask to sign in before touching the document (§118)
  if (!(await ensureSignedIn(supabase))) return
  const { data: bill, error } = await supabase.from('bills').select('*').eq('id', billId).single()
  if (error || !bill) { showError(safeErrorMessage(error, 'Could not load the bill.')); return }
  // Session 334: a pharmacy bill has its own document (batch + expiry per line, pharmacist, prescriber)
  if (bill.bill_type === 'pharmacy') { window.location.replace(`printPharmacyBill.html?billId=${encodeURIComponent(billId)}`); return }

  const [items, patient, visit, pays, taxS, isDemo] = await Promise.all([
    supabase.from('bill_items')
      .select('description, quantity, price, total, gst_percent, gst_amount, line_total, line_no, tax_category, gst_rate, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, line_discount, bill_discount_alloc, sac_code, hsn_code, bill_section')
      .eq('bill_id', billId).order('line_no', { nullsFirst: false }).order('id'),
    bill.patient_id ? supabase.from('patients').select('id, uhid, name, age, gender, phone, address').eq('id', bill.patient_id).maybeSingle() : { data: null },
    bill.visit_id ? supabase.from('visits').select('token_number, doctor_id, opd_id, created_at').eq('id', bill.visit_id).maybeSingle() : { data: null },
    supabase.from('patient_payments').select('id, receipt_no, kind, amount, mode, reference, received_at, received_by, voided_at, void_reason')
      .eq('bill_id', billId).order('received_at'),
    supabase.from('tenant_tax_settings').select('gst_registered, gstin').eq('tenant_id', bill.tenant_id).maybeSingle(),
    isDemoTenant(supabase, bill.tenant_id),
  ])
  const v = visit.data
  const ids = [...new Set([bill.created_by, v?.doctor_id, ...(pays.data || []).map(p => p.received_by)].filter(Boolean))]
  const [profs, opd] = await Promise.all([
    ids.length ? supabase.from('profiles').select('id, full_name').in('id', ids) : { data: [] },
    v?.opd_id ? supabase.from('opds').select('name').eq('id', v.opd_id).maybeSingle() : { data: null },
  ])
  const names = Object.fromEntries((profs.data || []).map(p => [p.id, p.full_name]))
  const d = {
    bill, isDemo, items: items.data || [], patient: patient.data, visit: v, payments: pays.data || [], tax: taxS.data || {},
    names, doctor: v?.doctor_id ? names[v.doctor_id] || null : null, opd: opd.data?.name || null,
  }
  // Print audit: the SERVER records this print and says whether it is the Original or a Duplicate copy. If that
  // cannot be established the document is not shown at all (an unmarked copy must never be printable).
  // Session 345c2b: the supplier copy is recorded as its own document ('bill_supplier'); the server refuses it unless
  // the bill is a finalised Tax Invoice, and its answer must carry the supplier label (fail closed)
  if (supplier && !canPrintSupplierCopy(bill)) { showError('A supplier copy can be printed only for a finalised Tax Invoice.'); return }
  const rec = await supabase.rpc('record_document_print', { p_doc_type: supplier ? 'bill_supplier' : 'bill', p_doc_id: billId })
  if (rec.error || !rec.data || (supplier && !rec.data.label)) { showError(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return }
  const model = buildModel(d, rec.data)
  renderInvoice(sheet, model)
  sheet.querySelector('.logo-img')?.addEventListener('error', e => e.target.remove())
  document.title = `${model.title} ${bill.document_number || ''} — ${d.patient?.name || ''}`.replace(/\s+/g, ' ').trim()
  printBtn.disabled = false
  // Session 345c2b: the optional supplier copy -- finalised Tax Invoices only, never offered on the supplier copy itself
  if (supBtn) supBtn.hidden = supplier || !canPrintSupplierCopy(bill)
  setStatus('')
}

// opened straight from the click (no await first), so the browser never blocks it as a pop-up
window.printSupplierCopy = () => openSupplierCopy()

load()
