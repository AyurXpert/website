// visitsBillsSearch.js -- "Visits & Bills" (Session 328, TODO_LATER.md §105).
// A read-only search over visits (open AND completed) and their OPD / lab bills and receipts, so a bill or
// receipt from any past day can be found and reprinted without depending on the live queue. One module,
// mounted by reception.html (receptionist, dept_admin, super_admin) and finance.html (cashier, accountant,
// finance_manager, dept_admin, super_admin). Data comes from the search_visits_bills() RPC
// (sql/session328_visits_bills_search_and_print_audit.sql): the organisation and the role check are the
// server's -- nothing here is trusted. Whether a print is the Original or a Duplicate copy is decided by the
// server when the print page opens (record_document_print); this module only opens the documents.
// Built with createElement / textContent only (no innerHTML): patient names are user-entered text.
import { el } from './invoiceLayout.js'
import { openBill, openReceipt, isCombinedPayment } from './opdPayments.js'
import { safeErrorMessage } from '../../utils/errors.js'
import { todayISTStr } from '../../utils/dateUtils.js'
import { getCurrentRole } from '../../core/auth.js'
// Session 345h (GST Stage 6c): "Ask for a credit note" on a paid GST document, and the credit notes against each bill
import { canAskCreditNote, openCreditNoteAsk, canStillCredit } from './creditNoteAsk.js'
import { creditNoteLinks, creditNotesForBills, payoutBox, canPayOut } from './creditNoteList.js'
import { creditNoteExclusions, creditNoteOfPayment } from './creditNotePrint.js'

// Session 338d: medical certificates are confidential clinical documents -- never listed, searched or printed by a
// pharmacist or cashier / accountant / finance_manager (the server refuses them too: _certificate_caller()).
// Reception reprints them at the counter. Mirrors the server's role list.
const CERTIFICATE_ROLES = ['doctor', 'trainee_doctor', 'mrd_staff', 'dept_admin', 'super_admin', 'receptionist']

const BILL_LABEL = { consultation: 'Visit bill', opd: 'Visit bill', investigation: 'Lab bill', pharmacy: 'Pharmacy bill' }
const STATUS_LABEL = { waiting: 'Waiting', in_progress: 'With doctor', completed: 'Completed', incomplete: 'Incomplete', awaiting_reports: 'Awaiting reports' }
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' }
const BTN = 'min-height:44px;min-width:44px;padding:0 12px;font-size:12px;font-weight:600;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:#fff;color:var(--green-deep)'
const INPUT = 'min-height:44px;font-size:13px;border:1px solid var(--border);border-radius:6px;padding:0 10px;background:#fff'

const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const day = iso => iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—'

// Session 345c2b: a Tax Invoice's reprint is a "REPRINT" (its first print the ORIGINAL FOR RECIPIENT); every other document
// keeps Original / Duplicate copy. Supplier copies are a separate series and never counted here.
// Session 345l (TODO §184): the hint names the copy number the next print gets (the original = print 1, so the next = n + 1)
function printedHint(n, taxInvoice = false) {
  if (taxInvoice) return n > 0 ? `Printed ${n}× — the next print is REPRINT · ORIGINAL FOR RECIPIENT · No. ${n + 1}` : 'Not printed yet — the first print is the ORIGINAL FOR RECIPIENT'
  return n > 0 ? `Printed ${n}× — the next print is DUPLICATE COPY · No. ${n + 1}` : 'Not printed yet — the first print is the Original'
}

function printButton(label, hintCount, onClick, taxInvoice = false) {
  const b = el('button', { type: 'button', style: BTN, title: printedHint(hintCount, taxInvoice) }, label)
  b.addEventListener('click', onClick)
  return b
}

// One bill's reprint buttons: a paid-in-full-at-creation bill is ONE "Bill cum Receipt"; anything else is the
// bill plus each of its receipts (the receipt of a later collection stays a separate document).
function reprintButtons(bill) {
  const live = (bill.payments || []).filter(p => !p.voided && p.kind !== 'refund')
  const forTest = live.map(p => ({ amount: p.amount, received_at: p.received_at, kind: p.kind, voided_at: null }))
  const combined = isCombinedPayment({ final_amount: bill.final_amount, created_at: bill.created_at }, forTest)
  const box = el('span', { style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' })
  const ti = bill.document_type === 'TAX_INVOICE'   // Session 345c2b (_s328_bill_json returns it)
  if (combined) {
    box.appendChild(printButton('🖨 Bill cum Receipt', bill.prints, () => openBill(bill.id), ti))
    return box
  }
  box.appendChild(printButton('🖨 Bill', bill.prints, () => openBill(bill.id), ti))
  for (const p of bill.payments || []) {
    const b = printButton(`🧾 ${p.receipt_no}${p.voided ? ' (void)' : ''}`, p.prints, () => openReceipt(p.id))
    b.setAttribute('data-pay-id', p.id)
    box.appendChild(b)
  }
  return box
}

// Session 344b: a pharmacy bill's returns / cancellations (search_visits_bills -> _s328_bill_json 'returns'): a completed
// one reprints its slip (RTN/...) through printPharmacyReturn.html -- the print page decides Original / DUPLICATE COPY No. N;
// one waiting for approval is only listed. `onReturn(billId)` (the dispensary only) adds a "Return / Cancel" button.
function returnButtons(bill, onReturn) {
  const box = el('span', { style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' })
  for (const r of bill.returns || []) {
    if (r.status === 'completed' && r.return_no) {
      box.appendChild(printButton(`↩ ${r.return_no}${r.kind === 'cancel' ? ' (cancellation)' : ''}`, r.prints,
        () => window.open(`printPharmacyReturn.html?returnId=${encodeURIComponent(r.id)}`, '_blank')))
    } else if (r.status === 'pending') {
      box.appendChild(el('span', { style: 'font-size:12px;color:var(--text-mid)' }, `↩ ${r.kind === 'cancel' ? 'Cancellation' : 'Return'} waiting for approval`))
    }
  }
  if (onReturn && String(bill.bill_type || '').toLowerCase() === 'pharmacy' && !bill.cancelled) {
    const b = el('button', { type: 'button', style: BTN, 'data-return-bill': bill.id }, '↩ Return / Cancel')
    b.addEventListener('click', () => onReturn(bill.id))
    box.appendChild(b)
  }
  return box.childNodes.length ? box : null
}

function billRow(bill, onReturn, ctx = {}) {
  const type = BILL_LABEL[String(bill.bill_type || '').toLowerCase()] || 'Bill'
  const pays = (bill.payments || []).filter(p => !p.voided && p.kind !== 'refund')
  const paidVia = pays.length ? pays.map(p => MODE_LABEL[p.mode] || p.mode).join(' + ') : null
  const returned = Number(bill.returned_amount || 0)
  return el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--border)' },
    el('span', { style: 'min-width:130px;font-weight:600' }, bill.document_number || 'Not numbered'),
    el('span', { style: 'min-width:80px;color:var(--text-mid)' }, type),
    el('span', { style: 'min-width:80px;font-weight:600' }, inr(bill.final_amount)),
    el('span', { style: 'min-width:120px;color:var(--text-muted);font-size:12px' },
      // a bill whose net amount is nil (fees were not configured then) reads "No charge", like its print -- never "PAID"
      Number(bill.final_amount || 0) < 0.005 ? 'NO CHARGE'
        : bill.cancelled ? 'CANCELLED'
        : `${String(bill.status || '').toUpperCase()}${paidVia ? ' · ' + paidVia : ''}${returned > 0 ? ' · returned ' + inr(returned) : ''}`),
    reprintButtons(bill), returnButtons(bill, onReturn), creditNoteBits(bill, ctx))
}

// Session 345h: the slot the credit notes against this bill go into (filled after the search, one batched read) and, for the
// asker roles (D1), "Ask for a credit note" on a paid GST Tax Invoice / Bill of Supply -- the panel shows the server's answer
function creditNoteBits(bill, ctx) {
  const box = el('span', { 'data-cn-bill': bill.id, style: 'display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap' })
  if (ctx.supabase && bill.status === 'paid' && canAskCreditNote(ctx.role, bill)) {
    // hidden until the server confirms something can still be credited (shown after the search, below)
    const b = el('button', { type: 'button', style: BTN, 'data-cn-ask': bill.id, hidden: true }, '↶ Ask for a credit note')
    b.addEventListener('click', () => openCreditNoteAsk({ supabase: ctx.supabase, billId: bill.id, onDone: ctx.refresh }))
    box.appendChild(b)
  }
  return box
}

// Session 338: a visit's finalised prescriptions, reprinted through record_document_print('prescription') -- the
// print page decides Original / DUPLICATE COPY No. N. Listed by list_visit_prescriptions() (prescription-print roles:
// reception, pharmacist, doctors, nurse, MRD, super_admin); for other roles the call is refused and nothing is shown.
function prescriptionRow(rx) {
  const b = printButton('🖨 Prescription', rx.prints, () => window.open(`printPrescription.html?rxId=${encodeURIComponent(rx.id)}`, '_blank'))
  return el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--border)' },
    el('span', { style: 'min-width:130px;font-weight:600' }, 'Prescription'),
    el('span', { style: 'min-width:160px;color:var(--text-mid);font-size:12px' }, `${day(rx.created_at)}${rx.prescriber ? ' · ' + rx.prescriber : ''}`),
    b)
}

// Session 338b: the visit's medical certificates (MC/<fy>/<n>), same roles and pattern as prescriptions
const CERT_LABEL = { medical: 'Medical', fitness: 'Fitness', sick_leave: 'Sick leave' }
function certificateRow(c) {
  const b = printButton(`🖨 ${c.certificate_no}`, c.prints, () => window.open(`printMedicalCertificate.html?certId=${encodeURIComponent(c.id)}`, '_blank'))
  return el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--border)' },
    el('span', { style: 'min-width:130px;font-weight:600' }, `${CERT_LABEL[c.cert_type] || 'Medical'} certificate`),
    el('span', { style: 'min-width:160px;color:var(--text-mid);font-size:12px' }, `${day(c.issued_at)}${c.doctor ? ' · ' + c.doctor : ''}`),
    b)
}

// a certificate with no visit on the screen (e.g. issued from the patient's history with no visit): its own card
function certificateCard(c) {
  const p = c.patient || {}
  return el('div', { style: 'border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin:0 0 10px;background:#fff' },
    el('div', { style: 'display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px' },
      el('strong', { style: 'font-size:14px' }, p.name || '—'),
      el('span', { style: 'font-size:12px;color:var(--text-mid)' }, `UHID ${p.uhid || '—'}`),
      p.phone ? el('span', { style: 'font-size:12px;color:var(--text-muted)' }, p.phone) : null),
    el('div', { style: 'font-size:12px;color:var(--text-mid);margin-bottom:4px' },
      c.visit_id ? `Medical certificate · ${when(c.issued_at)}` : `Medical certificate (not linked to a visit) · ${when(c.issued_at)}`),
    certificateRow(c))
}

function resultCard(row, onReturn, ctx = {}) {
  const p = row.patient || {}
  const v = row.visit
  // Session 341: a counter (walk-in) sale with no patient shows the customer typed at the counter, or "Walk-in customer"
  const c = row.customer
  const head = c
    ? el('div', { style: 'display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px' },
        el('strong', { style: 'font-size:14px' }, c.name || 'Walk-in customer'),
        el('span', { style: 'font-size:12px;color:var(--text-mid)' }, 'No patient record'),
        c.phone ? el('span', { style: 'font-size:12px;color:var(--text-muted)' }, c.phone) : null)
    : el('div', { style: 'display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px' },
        el('strong', { style: 'font-size:14px' }, p.name || '—'),
        el('span', { style: 'font-size:12px;color:var(--text-mid)' }, `UHID ${p.uhid || '—'}`),
        p.phone ? el('span', { style: 'font-size:12px;color:var(--text-muted)' }, p.phone) : null)
  const sub = v
    ? el('div', { style: 'font-size:12px;color:var(--text-mid);margin-bottom:4px' },
        `${when(v.created_at)} · Token ${v.token ?? '—'} · ${STATUS_LABEL[v.status] || v.status || '—'}`
        + `${v.doctor ? ' · ' + v.doctor : ''}${v.opd ? ' · ' + v.opd : ''}`)
    : el('div', { style: 'font-size:12px;color:var(--text-mid);margin-bottom:4px' },
        row.counter
          ? `Counter sale — no prescription · ${day(row.bills?.[0]?.created_at)}`
          : `No visit on this bill (e.g. a lab test advised for the next visit) · ${day(row.bills?.[0]?.created_at)}`)
  const card = el('div', { style: 'border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin:0 0 10px;background:#fff' }, head, sub)
  if (v) card.dataset.visitId = v.id
  if (!row.bills || !row.bills.length) card.appendChild(el('div', { style: 'font-size:12px;color:var(--text-muted);padding-top:4px' }, 'No OPD or lab bill on this visit.'))
  for (const b of row.bills || []) card.appendChild(billRow(b, onReturn, ctx))
  return card
}

// onCreditNote(number) (Finance only, Session 345l): a credit-note number searched here is opened in Finance -> 🧾 Credit notes
export function mountVisitsBillsSearch(root, { supabase, onReturn = null, onCreditNote = null }) {
  const today = todayISTStr()
  const showCerts = CERTIFICATE_ROLES.includes(getCurrentRole())
  const q = el('input', { type: 'text', id: 'vb-q', maxlength: '80', style: INPUT + ';flex:1;min-width:240px',
    placeholder: showCerts ? 'UHID, patient name, phone, bill / invoice no. (B/…, TI/…, BS/…), receipt no. (RCPT/…), return no. (RTN/…) or certificate no. (MC/…)' : 'UHID, patient name, phone, bill / invoice no. (B/…, TI/…, BS/…), receipt no. (RCPT/…) or return no. (RTN/…)',
    'aria-label': showCerts ? 'Search visits, bills and certificates' : 'Search visits and bills' })
  const from = el('input', { type: 'date', id: 'vb-from', value: today, style: INPUT, 'aria-label': 'From date' })
  const to = el('input', { type: 'date', id: 'vb-to', value: today, style: INPUT, 'aria-label': 'To date' })
  const all = el('input', { type: 'checkbox', id: 'vb-all', style: 'width:18px;height:18px;margin:0' })
  const allLabel = el('label', { for: 'vb-all', style: 'display:inline-flex;align-items:center;gap:6px;min-height:44px;font-size:13px;cursor:pointer' }, all, 'All dates')
  const go = el('button', { type: 'button', style: BTN.replace('background:#fff;color:var(--green-deep)', 'background:var(--green-deep);color:#fff') }, '🔎 Search')
  const clear = el('button', { type: 'button', style: BTN }, 'Reset')
  const status = el('div', { role: 'status', 'aria-live': 'polite', style: 'font-size:12px;color:var(--text-mid);margin:6px 0' })
  const results = el('div', { id: 'vb-results' })

  root.replaceChildren(
    el('div', { style: 'padding:12px' },
      el('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:8px' },
        (showCerts
          ? 'Open and completed visits with their OPD / lab bills, receipts, prescriptions and medical certificates. A UHID (AYX/…), any bill or invoice no. of this organisation (B/…, Tax Invoice TI/…, Bill of Supply BS/…), receipt no. (RCPT/…), pharmacy return no. (RTN/…) or certificate no. (MC/…) is searched across ALL dates. '
          : 'Open and completed visits with their bills, receipts, pharmacy returns and prescriptions. A UHID (AYX/…), any bill or invoice no. of this organisation (B/…, Tax Invoice TI/…, Bill of Supply BS/…), receipt no. (RCPT/…) or pharmacy return no. (RTN/…) is searched across ALL dates. ')
        + 'A name or phone uses the date range (at most 31 days) unless you tick “All dates”. Newest first, at most 100 shown. '
        + 'Every reprint is marked with its copy number — “REPRINT · … No. N” on a Tax Invoice, “DUPLICATE COPY · No. N” on other documents.'),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, q, from, el('span', null, 'to'), to, allLabel, go, clear),
      status, results))

  // UHID / bill / receipt / return numbers run only on Enter or the button; a name or phone also runs by itself once typing pauses.
  const isNumberPattern = v => /^(B|RCPT|RTN|MC)\//i.test(v) || /^[A-Za-z]{2,6}\/\d{4}\//.test(v)
  let timer = null
  let seq = 0
  // The same rule the server applies: a UHID / bill / receipt number always ignores the dates (dim them as a hint).
  function syncDates() {
    const v = q.value.trim()
    const byNumber = isNumberPattern(v)
    const ignored = byNumber || (all.checked && v.length > 0)
    from.disabled = to.disabled = ignored
    from.style.opacity = to.style.opacity = ignored ? '0.5' : '1'
    all.disabled = byNumber
  }

  async function run() {
    clearTimeout(timer)
    const mine = ++seq
    syncDates()
    status.textContent = 'Searching…'
    results.replaceChildren()
    const args = { p_q: q.value.trim() || null, p_from: from.value || null, p_to: to.value || null, p_all_dates: all.checked }
    // Session 338c: medical certificates are searched on their own (a certificate may have no visit at all) -- by MC
    // number or UHID across all dates, by name / phone in the date range. A role that cannot print them gets none.
    const [vb, mc] = await Promise.all([
      supabase.rpc('search_visits_bills', args),
      showCerts ? supabase.rpc('search_medical_certificates', args) : Promise.resolve({ data: null, error: null }),
    ])
    if (mine !== seq) return                       // a newer search started meanwhile: drop this answer
    const certs = !mc.error && Array.isArray(mc.data?.rows) ? mc.data.rows : []
    if (vb.error && !certs.length) { status.textContent = safeErrorMessage(vb.error, 'Could not search. Please try again.'); return }
    const data = vb.data || {}
    // Session 345l (TODO §185): a credit note is not a bill -- the server answers a hint for its number
    if (!vb.error && data.hint === 'credit_note') {
      const cnNo = q.value.trim()
      status.replaceChildren(el('span', { 'data-cn-hint': '1' }, `${cnNo} is a credit note — credit notes are under Finance → 🧾 Credit notes`
        + (onCreditNote ? '.' : ' (and on the bill they were issued against).')))
      if (onCreditNote) {
        const open = el('button', { type: 'button', style: BTN + ';margin-left:8px', 'data-cn-open': '1' }, 'Open in 🧾 Credit notes')
        open.addEventListener('click', () => onCreditNote(cnNo))
        status.appendChild(open)
      }
      return
    }
    const rows = vb.error ? [] : (data.rows || [])
    if (!rows.length && !certs.length) {
      status.textContent = 'Nothing found. Check the spelling, or tick “All dates”.'
      return
    }
    const src = rows.length ? data : mc.data
    const scope = src.all_dates ? 'across all dates' : `${src.from === src.to ? day(src.from + 'T12:00:00+05:30') : day(src.from + 'T12:00:00+05:30') + ' to ' + day(src.to + 'T12:00:00+05:30')}`
    status.textContent = `${rows.length} visit / bill result${rows.length === 1 ? '' : 's'}`
      + (certs.length ? ` and ${certs.length} medical certificate${certs.length === 1 ? '' : 's'}` : '') + ` shown ${scope}`
      + ((data.truncated || mc.data?.truncated) ? ' — only the latest are shown; refine your search.' : '.')
    const ctx = { supabase, role: getCurrentRole(), refresh: () => run() }
    const patientOf = new Map(rows.flatMap(r => (r.bills || []).map(b => [b.id, r.patient?.name || r.customer?.name || null])))
    const billTypeOf = new Map(rows.flatMap(r => (r.bills || []).map(b => [b.id, b.bill_type])))   // Session 345l: who may pay out
    results.replaceChildren(...rows.map(r => resultCard(r, onReturn, ctx)))
    // Session 345h: the credit notes against the GST documents shown (a refusal for a role simply shows none)
    const gstIds = rows.flatMap(r => (r.bills || []).filter(b => b.document_type === 'TAX_INVOICE' || b.document_type === 'BILL_OF_SUPPLY').map(b => b.id))
    // owner, 13 Oct 2026: "Ask" only while the bill can still be credited (eligible + a remainder), whatever its earlier credit notes
    const asks = [...results.querySelectorAll('[data-cn-ask]')]
    ;(async () => {
      for (let i = 0; i < asks.length; i += 4) {
        const batch = asks.slice(i, i + 4)
        const oks = await Promise.all(batch.map(b => canStillCredit(supabase, b.getAttribute('data-cn-ask'))))
        if (mine !== seq) return
        batch.forEach((b, k) => { if (oks[k]) b.hidden = false; else b.remove() })
      }
    })()
    if (gstIds.length) {
      // Session 345h (D16): a credit note's refund row stays on screen but opens its refund voucher / credit note, never a plain receipt
      creditNoteExclusions(supabase, gstIds).then(ex => {
        if (mine !== seq) return
        for (const id of ex.paymentIds) {
          const old = results.querySelector(`[data-pay-id="${CSS.escape(id)}"]`)
          if (!old) continue
          const row = ex.rows.find(r => r.id === id)
          const nb = el('button', { type: 'button', style: BTN, 'data-pay-id': id, 'data-cn-refund': '1', title: 'A credit note refund -- opens its refund voucher / credit note' },
            `↩ ${row?.receipt_no || 'Refund'} · credit-note refund`)
          // the page decides which document (opened from the click, before any await)
          nb.addEventListener('click', () => {
            const w = window.open('', '_blank')
            creditNoteOfPayment(supabase, id).then(c => { if (w) w.location = c ? c.url : 'about:blank' })
              .catch(() => { if (w) w.close() })
          })
          old.replaceWith(nb)
        }
      }).catch(() => { /* a screen: the plain button stays, and printReceipt itself redirects a credit-note refund */ })
      creditNotesForBills(supabase, gstIds).then(map => {
        if (mine !== seq) return
        for (const [id, entry] of Object.entries(map)) {
          const slot = results.querySelector(`[data-cn-bill="${CSS.escape(id)}"]`)
          const links = creditNoteLinks(entry)
          if (slot && links) slot.prepend(links)
          // Session 345h follow-up: a cash refund still due is paid out right here, from the counter's own shift (D4) -- the same
          // pay_credit_note_refund + refund voucher as Finance -> Credit notes; only for the roles that may pay out (Session 345l, TODO §183:
          // the 345i rule canPayOut -- the pharmacist too, for a PHARMACY bill's credit note; the server decides again)
          if (slot) {
            for (const n of entry.notes || []) {
              const note = { ...n, bill_type: billTypeOf.get(id), patient: patientOf.get(id) }
              if (n.refund_status === 'due' && canPayOut(ctx.role, note)) slot.appendChild(payoutBox(supabase, note, () => run()))
            }
          }
        }
      })
    }
    // a certificate goes on its visit's card when that visit is shown; otherwise it gets a card of its own
    for (const c of certs) {
      const card = c.visit_id ? [...results.children].find(x => x.dataset.visitId === c.visit_id) : null
      if (card) card.appendChild(certificateRow(c))
      else results.appendChild(certificateCard(c))
    }
    // prescriptions of the visits shown (a separate read: a refusal for a non-clinical role simply shows none)
    const vids = rows.filter(r => r.visit).map(r => r.visit.id)
    if (!vids.length) return
    const rx = await supabase.rpc('list_visit_prescriptions', { p_visit_ids: vids })
    if (mine !== seq || rx.error || !Array.isArray(rx.data)) return
    for (const p of rx.data) {
      const card = [...results.children].find(c => c.dataset.visitId === p.visit_id)
      if (card) card.appendChild(prescriptionRow(p))
    }
  }
  go.addEventListener('click', run)
  q.addEventListener('input', () => {
    syncDates()
    clearTimeout(timer)
    const v = q.value.trim()
    if (v.length >= 3 && !isNumberPattern(v)) timer = setTimeout(run, 400)
  })
  all.addEventListener('change', syncDates)
  q.addEventListener('keydown', e => { if (e.key === 'Enter') run() })
  clear.addEventListener('click', () => { q.value = ''; all.checked = false; from.value = today; to.value = today; run() })
  run()
}
