// Goods receipt (GRN) -- printGRN.html?id=<purchase invoice id> (Session 365).
// Every figure is a STORED value from get_purchase_invoice_print() (the supplier's invoice as recorded: the rate excluding GST, the
// discount, the free quantity, the tax worked out on the server, the round-off, the ITC); this file only formats. The SERVER decides
// ORIGINAL vs DUPLICATE COPY No. N (record_document_print('grn') -- the same scheme as every other document) and the page fails closed
// if that cannot be recorded. Layout: the shared invoiceLayout model at the chosen paper size; changing the size never records a print.
import { supabase } from '../core/db/supabaseClient.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { safeErrorMessage } from '../utils/errors.js'
import { el } from '../modules/billing/invoiceLayout.js'
import { ensureSignedIn } from '../utils/signInGate.js'
import { getPaperSize, applyPaperSize, mountPaperSizeSelect, renderDocument, watchPrintPageSize } from '../modules/billing/paperSize.js'
import { STATES } from '../modules/tax/gstReturnsExport.js'

wireDelegatedEvents()
applyPaperSize(getPaperSize())

const invoiceId = new URLSearchParams(window.location.search).get('id')
const sheet    = document.getElementById('invoice')
const statusEl = document.getElementById('status')
const printBtn = document.getElementById('print-btn')

const REG = { regular: 'Regular', composition: 'Composition', unregistered: 'Unregistered' }
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
const fmtDay = d => { if (!d) return null; const p = istParts(`${String(d).slice(0, 10)}T12:00:00+05:30`); return `${p.d} ${p.m} ${p.y}` }
const fmtExp = d => { if (!d) return null; const [y, m] = String(d).split('-'); return m && y ? `${MON[Number(m) - 1]} ${y}` : String(d) }
const fmtMonth = d => { if (!d) return null; const [y, m] = String(d).split('-'); return `${MON[Number(m) - 1]} ${y}` }
const stateName = c => c ? `${c}${STATES[c] ? ' — ' + STATES[c] : ''}` : '—'
const monogram = name => (name || '').split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0].toUpperCase()).join('')

function setStatus(msg, isErr = false) { statusEl.textContent = msg || ''; statusEl.className = 'status-msg' + (isErr ? ' err' : '') }
function showError(msg) { sheet.replaceChildren(el('p', { class: 'error-box' }, msg)); printBtn.disabled = true }

export function buildModel(d, copy) {
  const h = d.invoice || {}, sup = d.supplier || {}, org = d.organisation || {}
  const orgName  = org.name || 'Pharmacy'
  const orgLines = [org.address || [org.city, org.state].filter(Boolean).join(', '), org.phone ? `Ph: ${org.phone}` : null,
                    org.gstin ? `GSTIN: ${org.gstin}` : null, org.license_number ? `Licence No.: ${org.license_number}` : null].filter(Boolean)
  // one copy number for header and footer (a GRN has no pre-tracking prints)
  const isDup  = copy.copy !== 'ORIGINAL'
  const copyNo = Number(copy.print_no) || 1
  const cancelled = h.status === 'cancelled'
  const subtitle = `Purchase invoice received · ${isDup ? 'DUPLICATE COPY · No. ' + copyNo : 'Original'}${cancelled ? ' · CANCELLED' : ''}`

  const meta = [
    { label: 'GRN No.', value: h.grn_number || '—' },
    { label: 'Received', value: fmtDT(h.posted_at) },
    { label: 'Supplier Invoice No.', value: h.supplier_invoice_no || '—' },
    { label: 'Invoice Date', value: fmtDay(h.supplier_invoice_date) },
  ]
  const fields = [
    { label: 'Supplier', value: h.supplier_name || sup.name, wide: true },
    { label: 'Supplier GSTIN', value: h.supplier_gstin || 'Not registered' },
    { label: 'GST registration', value: REG[h.supplier_registration] || h.supplier_registration || '—' },
    { label: 'Supplier state', value: stateName(h.supplier_state_code) },
    { label: 'Place of supply', value: `${stateName(h.place_of_supply)} (${h.intra_state ? 'intra-state: CGST + SGST' : 'inter-state: IGST'})`, full: true },
  ]
  if (sup.address) fields.push({ label: 'Supplier address', value: sup.address, full: true })

  let n = 0
  const rows = (d.lines || []).map(l => {
    const tax = h.intra_state ? `CGST ${money(l.cgst_amount)} + SGST ${money(l.sgst_amount)}` : `IGST ${money(l.igst_amount)}`
    return {
      no: ++n, description: l.medicine_name || 'Medicine',
      sub: [l.hsn_code ? `HSN ${l.hsn_code}` : null, `Batch ${l.batch_number}`, `Exp ${fmtExp(l.expiry_date)}`, `MRP ${money(l.mrp)}`,
            num(l.free_qty) ? `+ ${num(l.free_qty)} free` : null, num(l.discount_pct) ? `disc ${num(l.discount_pct)} % (${money(l.discount_amount)})` : null,
            `taxable ${money(l.taxable_value)}`, `GST ${num(l.gst_rate)} %: ${tax}`].filter(Boolean).join(' · '),
      qty: String(num(l.qty)), rate: money(l.rate), amount: money(l.line_total),
    }
  })
  const sections = rows.length ? [{ title: 'Items received', rows, subtotal: money(h.computed_total) }] : []

  const summary = [{ label: 'Taxable value', value: money(h.taxable_total) }]
  if (h.intra_state) { summary.push({ label: 'CGST', value: money(h.cgst_total) }, { label: 'SGST', value: money(h.sgst_total) }) }
  else summary.push({ label: 'IGST', value: money(h.igst_total) })
  summary.push({ label: 'Computed total', value: money(h.computed_total) }, { label: 'Round-off', value: money(h.round_off) })
  summary.push({ label: 'Invoice total (as printed by the supplier)', value: rupee(h.invoice_total), grand: true })
  const balance = { label: h.itc_eligible ? `Input tax credit (GSTR-3B ${fmtMonth(h.itc_period)})` : 'Input tax credit', value: rupee(h.itc_amount) }

  const footer = []
  if (cancelled) footer.push(`CANCELLED on ${fmtDT(h.cancelled_at)} by ${h.cancelled_by_name || '—'}: ${h.cancel_reason || ''}${h.cancel_self_approved ? ' (self-approved: sole administrator)' : ''}. The stock was taken out again.`)
  if (isDup) footer.push(`Duplicate copy no. ${copyNo}. The original was first printed ${fmtDT(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}.`)
  footer.push(h.itc_reason || '')
  if (h.itc_eligible && num(h.itc_amount) > 0) footer.push('ITC apportionment for exempt supplies (Rule 42 / 43): CA to confirm; nothing is reversed automatically.')
  if (h.itc_deadline_passed) footer.push(`Past the Section 16(4) date for claiming ITC (${fmtDay(h.itc_deadline)}) -- CA to confirm before claiming.`)
  if (h.gmp_override) footer.push(`GMP block overridden by the Super Admin: ${h.gmp_override_reason || ''}.`)
  if (h.remarks) footer.push(`Remarks: ${h.remarks}`)
  footer.push(`Recorded by ${h.posted_by_name || '—'}. Keep this GRN with the supplier's invoice.`)
  footer.push('Computer-generated goods receipt — not a tax invoice. · Powered by AyurXpert')

  return {
    org: { name: orgName, lines: orgLines, logoUrl: org.logo_url || null, monogram: monogram(orgName) },
    title: 'Goods Receipt (GRN)', subtitle, watermark: cancelled ? 'CANCELLED' : (isDup ? 'DUPLICATE COPY' : null), meta, demo: !!org.is_demo,
    party: { title: 'Supplier', fields },
    gst: false, descLabel: 'Medicine', noCode: true,
    sections, emptyNote: rows.length ? null : 'No lines on this goods receipt.', taxNote: null, taxSummary: null, payments: null,
    summary: { rows: summary, balance },
    words: { label: 'Invoice total in words', lines: [`${amountInWords(h.invoice_total)}.`] },
    signatures: { left: ['Received and checked by', h.posted_by_name || '____________________'], right: ['Pharmacy in-charge / Authorised signatory', `for ${orgName}`] },
    footer: footer.filter(Boolean),
  }
}

async function load() {
  if (!invoiceId) { showError('No goods receipt specified.'); return }
  if (!(await ensureSignedIn(supabase))) return
  const { data, error } = await supabase.rpc('get_purchase_invoice_print', { p_invoice: invoiceId })
  if (error || !data?.invoice) { showError(safeErrorMessage(error, 'Could not load the goods receipt.')); return }
  // Print audit first: an unmarked copy must never be printable (fail closed)
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'grn', p_doc_id: invoiceId })
  if (rec.error || !rec.data) { showError(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return }
  const model = buildModel(data, rec.data)
  const draw = size => {
    renderDocument(sheet, model, size)
    sheet.querySelector('.logo-img')?.addEventListener('error', e => e.target.remove())
  }
  draw(getPaperSize())
  mountPaperSizeSelect(document.getElementById('paper-slot'), draw)
  watchPrintPageSize(() => sheet)
  document.title = `GRN ${data.invoice.grn_number || ''} — ${data.invoice.supplier_name || ''}`.replace(/\s+/g, ' ').trim()
  printBtn.disabled = false
  setStatus('')
}

load()
