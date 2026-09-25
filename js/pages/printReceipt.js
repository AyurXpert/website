import { supabase } from '../core/db/supabaseClient.js'
import { getCurrentTenantId } from '../core/auth.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { computeIpdChargesToDate } from '../modules/billing/ipdChargesToDate.js'

wireDelegatedEvents()

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _n(v){ return Number(v||0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

document.getElementById('clinic-logo').addEventListener('error', function() { this.style.display = 'none' })

const KIND_LABEL = { advance: 'Advance', deposit: 'Deposit', payment: 'Payment', refund: 'Refund' };
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' };

const params    = new URLSearchParams(window.location.search);
const paymentId = params.get('payment');
const admId     = params.get('interim');

// Clinic letterhead — same pattern as printInvoice.js
const tenantRaw = sessionStorage.getItem('ayurxpert_tenant');
const tenant    = tenantRaw ? JSON.parse(tenantRaw) : {};
const tenantId  = getCurrentTenantId();
document.getElementById('clinicName').textContent = tenant.name || 'AyurXpert HMS';
const addr = tenant.full_address || tenant.address;
if (addr) { const el = document.getElementById('clinicAddress'); el.textContent = addr; el.style.display = ''; }
if (tenant.gstin) { const el = document.getElementById('clinicGstin'); el.textContent = `GSTIN: ${tenant.gstin}`; el.style.display = ''; }
if (tenant.logo_url) { const img = document.getElementById('clinic-logo'); img.src = tenant.logo_url; img.style.display = ''; }

function _fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

async function loadReceipt() {
  const { data: pp, error } = await supabase
    .from('patient_payments')
    .select(`id, kind, amount, mode, reference, notes, receipt_no, received_at, received_by, voided_at, void_reason,
      ipd_admissions(id, admission_date, patients(name, phone, age, gender), beds(bed_number, ward_name), departments(name))`)
    .eq('id', paymentId).single();

  if (error || !pp) {
    document.getElementById('patientInfo').innerHTML = `<span class="text-red-600">Receipt not found.</span>`;
    return;
  }

  const isRefund = pp.kind === 'refund';
  document.getElementById('docTitle').textContent = isRefund ? 'REFUND VOUCHER' : 'RECEIPT';

  document.getElementById('receiptMeta').innerHTML = `
    <div><b>${_esc(pp.receipt_no)}</b></div>
    <div>${_fmtDateTime(pp.received_at)}</div>
  `;

  const adm = pp.ipd_admissions || {};
  const pt  = adm.patients || {};
  const bed = adm.beds || {};
  document.getElementById('patientInfo').innerHTML = `
    <div><b>Patient:</b> ${_esc(pt.name || '—')}</div>
    <div><b>Admission:</b> ${adm.admission_date || '—'}${bed.bed_number ? ' · Bed ' + _esc(bed.bed_number) : ''}${adm.departments?.name ? ' · ' + _esc(adm.departments.name) : ''}</div>
  `;

  // pp.notes is free text a billing user typed (a refund/void reason) -- escape it, same
  // class of stored-XSS bug found elsewhere in this codebase (nursing.html free-text fields).
  const desc = `${KIND_LABEL[pp.kind] || pp.kind}${pp.notes ? ' — ' + _esc(pp.notes) : ''}`;
  document.getElementById('lineTable').innerHTML = `
    <tr>
      <td class="py-1">${_esc(desc)}</td>
      <td class="py-1 text-right">${MODE_LABEL[pp.mode] || pp.mode}${pp.reference && pp.mode !== 'cash' ? ' · ' + _esc(pp.reference) : ''}</td>
    </tr>
  `;

  document.getElementById('totalAmount').textContent = `${isRefund ? 'Refunded' : 'Received'}: ₹${_n(pp.amount)}`;
  document.getElementById('amountWords').textContent = amountInWords(pp.amount);

  if (pp.received_by) {
    const { data: staff } = await supabase.from('profiles').select('full_name').eq('id', pp.received_by).maybeSingle();
    document.getElementById('receivedByLine').textContent = `Received by: ${staff?.full_name || '—'}`;
  }

  if (pp.voided_at) {
    document.getElementById('void-watermark').style.display = '';
    const line = document.getElementById('voidLine');
    line.style.display = '';
    line.textContent = `VOID — ${pp.void_reason || ''} (${_fmtDateTime(pp.voided_at)})`;
  }
}

async function loadInterim() {
  const { data: adm, error } = await supabase
    .from('ipd_admissions')
    .select('id, admission_date, admitted_at, charges_locked_at, patients(name, phone, age, gender), beds(bed_number, bed_type, ward_name), departments(name)')
    .eq('id', admId).single();

  if (error || !adm) {
    document.getElementById('patientInfo').innerHTML = `<span class="text-red-600">Admission not found.</span>`;
    return;
  }

  document.getElementById('docTitle').textContent = 'INTERIM BILL';
  document.getElementById('notaxNote').style.display = '';
  document.getElementById('receiptMeta').innerHTML = `<div>${_fmtDateTime(new Date().toISOString())}</div>`;

  const pt  = adm.patients || {};
  const bed = adm.beds || {};
  document.getElementById('patientInfo').innerHTML = `
    <div><b>Patient:</b> ${_esc(pt.name || '—')}</div>
    <div><b>Admission:</b> ${adm.admission_date || '—'}${bed.bed_number ? ' · Bed ' + _esc(bed.bed_number) : ''}${adm.departments?.name ? ' · ' + _esc(adm.departments.name) : ''}</div>
  `;

  const [charges, acctRes] = await Promise.all([
    computeIpdChargesToDate({ supabase, tenantId, admission: adm }),
    supabase.rpc('get_ipd_account', { p_adm: admId }),
  ]);
  // get_ipd_account is restricted to billing roles (matches the Account drawer that
  // links here) -- a role without access gets a real error, not a zero. Showing ₹0.00
  // in that case would look like a confirmed real figure instead of "not available".
  const acc = acctRes.data;
  const acctBlocked = !!acctRes.error;

  const rows = [];
  if (charges.tariff.error) {
    rows.push(`<tr><td colspan="2" class="py-1 text-red-600 text-xs">${_esc(charges.tariff.error)}</td></tr>`);
  } else {
    rows.push(`<tr><td class="py-1">Room Tariff — ${charges.tariff.days} day${charges.tariff.days>1?'s':''} × ${_esc(bed.bed_type||'')}</td><td class="py-1 text-right">₹${_n(charges.tariffTotal)}</td></tr>`);
  }
  charges.charges.forEach(c => {
    rows.push(`<tr><td class="py-1">${_esc(c.description)}</td><td class="py-1 text-right">₹${_n(c.amount)}</td></tr>`);
  });
  rows.push(`<tr><td class="py-1 border-t font-semibold">Charges so far</td><td class="py-1 text-right border-t font-semibold">₹${_n(charges.total)}</td></tr>`);
  rows.push(acctBlocked
    ? `<tr><td class="py-1">Money held (advance + deposits)</td><td class="py-1 text-right text-red-600 text-xs">not available to this role</td></tr>`
    : `<tr><td class="py-1">Money held (advance + deposits)</td><td class="py-1 text-right">₹${_n(acc.held || 0)}</td></tr>`);
  document.getElementById('lineTable').innerHTML = rows.join('');

  if (acctBlocked) {
    document.getElementById('totalAmount').textContent = `Charges so far: ₹${_n(charges.total)} (balance needs a billing role to compute)`;
    document.getElementById('amountWords').style.display = 'none';
    return;
  }

  const balance = charges.total - (Number(acc.held) || 0);
  document.getElementById('totalAmount').textContent = balance >= 0
    ? `Estimated balance: ₹${_n(balance)}`
    : `Estimated refund due: ₹${_n(-balance)}`;
  document.getElementById('amountWords').style.display = 'none';
}

if (paymentId) loadReceipt();
else if (admId) loadInterim();
else document.getElementById('patientInfo').innerHTML = `<span class="text-red-600">No receipt or admission specified.</span>`;
