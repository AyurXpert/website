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

// Session 338d: medical certificates are confidential clinical documents -- never listed, searched or printed by a
// pharmacist or cashier / accountant / finance_manager (the server refuses them too: _certificate_caller()).
// Reception reprints them at the counter. Mirrors the server's role list.
const CERTIFICATE_ROLES = ['doctor', 'trainee_doctor', 'mrd_staff', 'dept_admin', 'super_admin', 'receptionist']

const BILL_LABEL = { consultation: 'Visit bill', opd: 'Visit bill', investigation: 'Lab bill', pharmacy: 'Pharmacy bill' }
const STATUS_LABEL = { waiting: 'Waiting', in_progress: 'With doctor', completed: 'Completed', incomplete: 'Incomplete' }
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' }
const BTN = 'min-height:44px;min-width:44px;padding:0 12px;font-size:12px;font-weight:600;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:#fff;color:var(--green-deep)'
const INPUT = 'min-height:44px;font-size:13px;border:1px solid var(--border);border-radius:6px;padding:0 10px;background:#fff'

const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const day = iso => iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—'

function printedHint(n) {
  return n > 0 ? `Printed ${n}× — the next print is a Duplicate copy` : 'Not printed yet — the first print is the Original'
}

function printButton(label, hintCount, onClick) {
  const b = el('button', { type: 'button', style: BTN, title: printedHint(hintCount) }, label)
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
  if (combined) {
    box.appendChild(printButton('🖨 Bill cum Receipt', bill.prints, () => openBill(bill.id)))
    return box
  }
  box.appendChild(printButton('🖨 Bill', bill.prints, () => openBill(bill.id)))
  for (const p of bill.payments || []) {
    box.appendChild(printButton(`🧾 ${p.receipt_no}${p.voided ? ' (void)' : ''}`, p.prints, () => openReceipt(p.id)))
  }
  return box
}

function billRow(bill) {
  const type = BILL_LABEL[String(bill.bill_type || '').toLowerCase()] || 'Bill'
  const pays = (bill.payments || []).filter(p => !p.voided && p.kind !== 'refund')
  const paidVia = pays.length ? pays.map(p => MODE_LABEL[p.mode] || p.mode).join(' + ') : null
  return el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--border)' },
    el('span', { style: 'min-width:130px;font-weight:600' }, bill.document_number || 'Not numbered'),
    el('span', { style: 'min-width:80px;color:var(--text-mid)' }, type),
    el('span', { style: 'min-width:80px;font-weight:600' }, inr(bill.final_amount)),
    el('span', { style: 'min-width:120px;color:var(--text-muted);font-size:12px' },
      // a bill whose net amount is nil (fees were not configured then) reads "No charge", like its print -- never "PAID"
      Number(bill.final_amount || 0) < 0.005 ? 'NO CHARGE' : `${String(bill.status || '').toUpperCase()}${paidVia ? ' · ' + paidVia : ''}`),
    reprintButtons(bill))
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

function resultCard(row) {
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
  for (const b of row.bills || []) card.appendChild(billRow(b))
  return card
}

export function mountVisitsBillsSearch(root, { supabase }) {
  const today = todayISTStr()
  const showCerts = CERTIFICATE_ROLES.includes(getCurrentRole())
  const q = el('input', { type: 'text', id: 'vb-q', maxlength: '80', style: INPUT + ';flex:1;min-width:240px',
    placeholder: showCerts ? 'UHID, patient name, phone, bill no. (B/…), receipt no. (RCPT/…) or certificate no. (MC/…)' : 'UHID, patient name, phone, bill no. (B/…) or receipt no. (RCPT/…)',
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
          ? 'Open and completed visits with their OPD / lab bills, receipts, prescriptions and medical certificates. A UHID (AYX/…), bill no. (B/…), receipt no. (RCPT/…) or certificate no. (MC/…) is searched across ALL dates. '
          : 'Open and completed visits with their bills, receipts and prescriptions. A UHID (AYX/…), bill no. (B/…) or receipt no. (RCPT/…) is searched across ALL dates. ')
        + 'A name or phone uses the date range (at most 31 days) unless you tick “All dates”. Newest first, at most 100 shown. '
        + 'Every reprint after the first is marked “Duplicate copy”.'),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, q, from, el('span', null, 'to'), to, allLabel, go, clear),
      status, results))

  // UHID / bill / receipt numbers run only on Enter or the button; a name or phone also runs by itself once typing pauses.
  const isNumberPattern = v => /^(B|RCPT|MC)\//i.test(v) || /^[A-Za-z]{2,6}\/\d{4}\//.test(v)
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
    results.replaceChildren(...rows.map(resultCard))
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
