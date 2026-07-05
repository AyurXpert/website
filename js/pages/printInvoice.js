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

  // ── BILL MODE (from pharmacyPOS) ───────────────────
  if (billId) {
    document.getElementById('refLine').innerHTML = `<b>Bill ID:</b> ${_esc(billId.slice(-8).toUpperCase())}`

    const { data: bill } = await supabase
      .from('bills')
      .select('*')
      .eq('id', billId)
      .single()

    const { data: items } = await supabase
      .from('bill_items')
      .select('medicine_id, quantity, price, gst_amount')
      .eq('bill_id', billId)

    const { data: medicines } = await supabase
      .from('medicines')
      .select('id, name')

    document.getElementById('patientInfo').innerHTML = `
      <div><b>Bill ID:</b> ${_esc(bill.id)}</div>
      <div><b>Payment:</b> ${_esc(bill.payment_method) || '—'}</div>
    `

    let total = 0
    const tbody = document.getElementById('medTable')

    ;(items || []).forEach(item => {
      const med      = (medicines || []).find(m => m.id === item.medicine_id)
      const name     = med?.name || 'Unknown'
      const qty      = Number(item.quantity || 1)
      const price    = Number(item.price || 0)
      const gst      = Number(item.gst_amount || 0)
      const lineTotal = qty * price
      total += lineTotal

      tbody.innerHTML += `
        <tr>
          <td class="border p-2">${_esc(name)}</td>
          <td class="border p-2 text-center">${qty}</td>
          <td class="border p-2 text-right">₹${price.toFixed(2)}</td>
          <td class="border p-2 text-right">₹${(gst * qty).toFixed(2)}</td>
          <td class="border p-2 text-right">₹${lineTotal.toFixed(2)}</td>
        </tr>
      `
    })

    document.getElementById('totalAmount').innerText = 'Total: ₹' + total.toFixed(2)
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
