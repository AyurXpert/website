import { supabase } from '../core/db/supabaseClient.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'

wireDelegatedEvents()

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

document.getElementById('clinic-logo').addEventListener('error', function() {
  this.style.display = 'none'
})

const urlParams      = new URLSearchParams(window.location.search)
const billId         = urlParams.get('billId')
const prescriptionId = urlParams.get('prescriptionId')

// Clinic name from sessionStorage (set by auth.js after login)
const tenantRaw = sessionStorage.getItem('ayurxpert_tenant')
const tenant    = tenantRaw ? JSON.parse(tenantRaw) : {}
document.getElementById('clinicName').innerText = tenant.name || 'AyurXpert HMS'
document.getElementById('invoiceDate').innerText = new Date().toLocaleDateString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric'
})

async function loadInvoice() {

  // ── BILL MODE (from pharmacyPOS, ipd.js discharge billing, and now OPD
  // lab charges -- Session 124 Step 5) ───────────────────
  if (billId) {
    document.getElementById('refLine').innerHTML = `<b>Bill ID:</b> ${_esc(billId.slice(-8).toUpperCase())}`

    const { data: bill } = await supabase
      .from('bills')
      .select('*')
      .eq('id', billId)
      .single()

    // bill_items holds two real shapes: pharmacy dispensing is medicine_id-
    // keyed (name comes from the medicines catalog); IPD stay charges/room
    // tariff and OPD lab charges are description-only (item.description
    // already has the full line label, e.g. "Blood — CBC"). This used to
    // only handle the medicine_id shape -- every description-only item
    // printed as "Unknown".
    const { data: items } = await supabase
      .from('bill_items')
      .select('medicine_id, description, quantity, price, total, gst_amount')
      .eq('bill_id', billId)

    const medicineIds = (items || []).map(i => i.medicine_id).filter(Boolean)
    const { data: medicines } = medicineIds.length
      ? await supabase.from('medicines').select('id, name').in('id', medicineIds)
      : { data: [] }

    document.getElementById('patientInfo').innerHTML = `
      <div><b>Bill ID:</b> ${_esc(bill.id)}</div>
      <div><b>Payment:</b> ${_esc(bill.payment_method || bill.payment_mode) || '—'}</div>
    `

    const tbody = document.getElementById('medTable')
    tbody.innerHTML = ''

    const addRow = (name, qty, price, gst, lineTotal) => {
      tbody.innerHTML += `
        <tr>
          <td class="border p-2">${_esc(name)}</td>
          <td class="border p-2 text-center">${qty}</td>
          <td class="border p-2 text-right">₹${price.toFixed(2)}</td>
          <td class="border p-2 text-right">₹${gst.toFixed(2)}</td>
          <td class="border p-2 text-right">₹${lineTotal.toFixed(2)}</td>
        </tr>
      `
    }

    // OPD consultation bills carry registration/consultation/on-request-
    // surcharge as fixed columns on `bills` itself, alongside (or instead
    // of) any bill_items -- shown as their own rows so the printed
    // breakdown actually adds up to the bill's real total.
    if (Number(bill.registration_fee) > 0)     addRow('Registration Fee',     1, Number(bill.registration_fee),     0, Number(bill.registration_fee))
    if (Number(bill.consultation_fee) > 0)     addRow('Consultation Fee',     1, Number(bill.consultation_fee),     0, Number(bill.consultation_fee))
    if (Number(bill.on_request_surcharge) > 0) addRow('On-Request Surcharge', 1, Number(bill.on_request_surcharge), 0, Number(bill.on_request_surcharge))

    ;(items || []).forEach(item => {
      const name = item.medicine_id
        ? ((medicines || []).find(m => m.id === item.medicine_id)?.name || 'Unknown')
        : (item.description || 'Unknown')
      const qty   = Number(item.quantity || 1)
      const price = Number(item.price || 0)
      // gst_amount is already the LINE's total GST (see ipd.js/opdBillItems.js),
      // not per-unit -- the old `gst * qty` here would have double-counted
      // for any qty > 1 (harmless by coincidence for pharmacy, which never
      // populates gst_amount at all, and for lab items which are always qty=1).
      const gst = Number(item.gst_amount || 0)
      const lineTotal = (item.total != null ? Number(item.total) : qty * price) + gst
      addRow(name, qty, price, gst, lineTotal)
    })

    if (!tbody.innerHTML) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center p-4 text-gray-500">No items on this bill.</td></tr>'
    }

    // bill.final_amount is meant to be the authoritative total (kept in sync
    // by addOpdBillItem()'s recompute / ipd.js's generateBill()) -- shown
    // directly rather than re-summed from the rows above to avoid drift.
    // Falls back to total_amount deliberately: found live that real, paid
    // dispensaryPOS.js pharmacy bills have final_amount stored as 0 while
    // total_amount is correct (a separate, not-yet-investigated bug in that
    // page's checkout flow). Number(...) BEFORE the `||` is required, not
    // after -- PostgREST returns numeric columns as strings, and the string
    // "0" is truthy in JS, so `bill.final_amount || bill.total_amount`
    // would never have fallen through at all (caught live: displayed
    // "Total: ₹0.00" even with this exact fallback, until fixed).
    const displayTotal = Number(bill.final_amount) || Number(bill.total_amount) || 0
    document.getElementById('totalAmount').innerText = 'Total: ₹' + displayTotal.toFixed(2)
    return
  }

  // ── PRESCRIPTION MODE (from pharmacy.html) ─────────
  if (!prescriptionId) {
    document.getElementById('medTable').innerHTML =
      '<tr><td colspan="5" class="text-center p-4 text-gray-500">No bill or prescription ID provided.</td></tr>'
    return
  }

  document.getElementById('refLine').innerHTML = `<b>Prescription ID:</b> ${_esc(prescriptionId.slice(-8).toUpperCase())}`

  // 1. Get prescription → visit → patient
  const { data: prescription, error: pErr } = await supabase
    .from('prescriptions')
    .select('id, visit_id, visits(patient_id, patients(name, phone))')
    .eq('id', prescriptionId)
    .single()

  if (pErr || !prescription) {
    document.getElementById('patientInfo').innerHTML = '<div class="text-red-500">Prescription not found.</div>'
    return
  }

  const patient = prescription?.visits?.patients || {}
  document.getElementById('patientInfo').innerHTML = `
    <div><b>Patient:</b> ${_esc(patient.name) || '—'}</div>
    <div><b>Phone:</b> ${_esc(patient.phone) || '—'}</div>
  `

  // 2. Get prescription items
  const { data: items } = await supabase
    .from('prescription_items')
    .select('medicine_id, medicine_name, quantity')
    .eq('prescription_id', prescriptionId)

  if (!items || items.length === 0) {
    document.getElementById('medTable').innerHTML =
      '<tr><td colspan="5" class="text-center p-4">No medicines found</td></tr>'
    return
  }

  // 3. Get inventory prices for these medicines
  const medIds = items.map(i => i.medicine_id).filter(Boolean)
  const { data: inventory } = medIds.length
    ? await supabase.from('inventory').select('medicine_id, mrp').in('medicine_id', medIds)
    : { data: [] }

  let total = 0
  const tbody = document.getElementById('medTable')

  items.forEach(item => {
    const inv       = (inventory || []).find(i => i.medicine_id === item.medicine_id)
    const name      = item.medicine_name || 'Unknown'
    const price     = Number(inv?.mrp || 0)
    const qty       = Number(item.quantity || 1)
    const lineTotal = price * qty
    total += lineTotal

    // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat -- name is escaped via _esc(); qty/price/lineTotal are Number()-coerced, not user strings
    tbody.innerHTML += `
      <tr>
        <td class="border p-2">${_esc(name)}</td>
        <td class="border p-2 text-center">${qty}</td>
        <td class="border p-2 text-right">₹${price.toFixed(2)}</td>
        <td class="border p-2 text-right">—</td>
        <td class="border p-2 text-right">₹${lineTotal.toFixed(2)}</td>
      </tr>
    `
  })

  document.getElementById('totalAmount').innerText = 'Total: ₹' + total.toFixed(2)

  // Add feedback link to invoice footer
  if (prescription.visit_id) {
    const feedbackUrl = `${window.location.origin}/feedback.html?visit=${prescription.visit_id}`;
    const footerEl = document.getElementById('feedback-footer');
    const urlEl    = document.getElementById('feedback-url');
    if (footerEl && urlEl) {
      footerEl.style.display = '';
      urlEl.textContent = feedbackUrl;
    }
  }
}

loadInvoice()
