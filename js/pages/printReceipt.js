import { supabase } from '../core/db/supabaseClient.js'
import { getCurrentTenantId } from '../core/auth.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { safeErrorMessage } from '../utils/errors.js'
import { computeIpdChargesToDate } from '../modules/billing/ipdChargesToDate.js'
import { isDemoTenant, demoBannerEl } from '../modules/billing/demoBanner.js'
import { ensureSignedIn } from '../utils/signInGate.js'
import { getPaperSize, applyPaperSize, mountPaperSizeSelect, watchPrintPageSize, refreshPrintPageSize } from '../modules/billing/paperSize.js'

// Session 336: A4 / A5 / thermal 80 / 58 mm (css/paper-size.css), remembered per device. Changing it only re-lays
// out the page -- it never records another print. The printed page size follows it (thermal height measured).
applyPaperSize(getPaperSize())
mountPaperSizeSelect(document.getElementById('paper-slot'))
watchPrintPageSize(() => document.getElementById('receipt'))

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
// A demo organisation's receipts are test documents -- banner inside #receipt so it prints
isDemoTenant(supabase, tenantId).then(demo => { if (demo) document.getElementById('receipt').prepend(demoBannerEl()); });

function _fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

async function loadReceipt() {
  const { data: pp, error } = await supabase
    .from('patient_payments')
    .select(`id, kind, amount, mode, reference, notes, receipt_no, received_at, received_by, voided_at, void_reason, patient_id, bill_id,
      ipd_admissions(id, admission_date, patients(name, phone, age, gender), beds(bed_number, ward_name), departments(name))`)
    .eq('id', paymentId).single();

  if (error || !pp) {
    document.getElementById('patientInfo').innerHTML = `<span class="text-red-600">Receipt not found.</span>`;
    return;
  }

  // Print audit: the SERVER records this print and says whether it is the Original or a Duplicate copy
  // (fail closed: an unmarked receipt is never shown).
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'receipt', p_doc_id: paymentId });
  if (rec.error || !rec.data) {
    document.getElementById('patientInfo').textContent = safeErrorMessage(rec.error, 'Could not record this print. Please try again.');
    document.getElementById('receiptMeta').textContent = '';
    return;
  }
  const copy = rec.data;
  const isDup = copy.copy !== 'ORIGINAL';
  // ONE copy number for header and footer: a pre-tracking document's assumed original is copy 1, so its first tracked reprint is No. 2
  const copyNo = (Number(copy.print_no) || 1) + (copy.legacy ? 1 : 0);

  const isRefund = pp.kind === 'refund';
  document.getElementById('docTitle').textContent = `${isRefund ? 'REFUND VOUCHER' : 'RECEIPT'} — ${isDup ? 'DUPLICATE COPY · No. ' + copyNo : 'ORIGINAL'}`;
  if (isDup) {
    const note = document.createElement('div');
    note.className = 'text-xs text-gray-600 italic mb-2';
    note.textContent = `Duplicate copy no. ${copyNo}. ${copy.legacy
      ? 'Issued before print tracking began — an original may already have been given to the patient.'
      : `The original was first printed ${_fmtDateTime(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}.`}`;
    document.getElementById('amountWords').after(note);
  }

  document.getElementById('receiptMeta').innerHTML = `
    <div><b>${_esc(pp.receipt_no)}</b></div>
    <div>${_esc(_fmtDateTime(pp.received_at))}</div>
  `;

  const adm = pp.ipd_admissions || {};
  const pt  = adm.patients || {};
  const bed = adm.beds || {};
  if (pp.ipd_admissions) {
    document.getElementById('patientInfo').innerHTML = `
      <div><b>Patient:</b> ${_esc(pt.name || '—')}</div>
      <div><b>Admission:</b> ${_esc(adm.admission_date || '—')}${bed.bed_number ? ' · Bed ' + _esc(bed.bed_number) : ''}${adm.departments?.name ? ' · ' + _esc(adm.departments.name) : ''}</div>
    `;
  } else {
    // Session 324 -- an OPD / investigation bill payment (record_opd_bill_payment) has no
    // admission: show the patient and the bill it settled instead.
    // Session 341: a counter-sale receipt has no patient -- it shows the customer typed at the counter (or Walk-in)
    const [{ data: opdPt }, { data: opdBill }] = await Promise.all([
      pp.patient_id ? supabase.from('patients').select('name, uhid').eq('id', pp.patient_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from('bills').select('bill_type, document_number, created_at, sale_channel, recipient_name').eq('id', pp.bill_id).maybeSingle(),
    ]);
    const billLabel = opdBill?.sale_channel === 'counter' ? 'Pharmacy bill (counter sale)'
      : { consultation: 'OPD visit bill', investigation: 'Lab / investigation bill', pharmacy: 'Pharmacy bill' }[String(opdBill?.bill_type || '').toLowerCase()] || 'OPD bill';
    // built from DOM nodes + textContent (names are user-entered text)
    const line = (label, text) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = label;
      d.append(b, ' ' + text);
      return d;
    };
    document.getElementById('patientInfo').replaceChildren(
      pp.patient_id
        ? line('Patient:', `${opdPt?.name || '—'}${opdPt?.uhid ? ' · UHID ' + opdPt.uhid : ''}`)
        : line('Customer:', opdBill?.recipient_name || 'Walk-in customer'),
      line('Against:', `${billLabel}${opdBill?.document_number ? ' ' + opdBill.document_number : ''} · ${_fmtDateTime(opdBill?.created_at)}`));
  }

  // pp.notes is free text a billing user typed (a refund/void reason) -- escape it, same
  // class of stored-XSS bug found elsewhere in this codebase (nursing.html free-text fields).
  const desc = `${KIND_LABEL[pp.kind] || pp.kind}${pp.notes ? ' — ' + pp.notes : ''}`;  // escaped once, in the line below
  document.getElementById('lineTable').innerHTML = `
    <tr>
      <td class="py-1">${_esc(desc)}</td>
      <td class="py-1 text-right">${_esc(MODE_LABEL[pp.mode] || pp.mode)}${pp.reference && pp.mode !== 'cash' ? ' · ' + _esc(pp.reference) : ''}</td>
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

  // Session 342 (TODO §141, owner decision 5 Oct 2026): every interim print is logged as 'ipd_interim' (numbered per
  // admission) BEFORE anything is shown -- fail closed. It is a statement whose figures change, so it is never a
  // "DUPLICATE": header and footer both say "Interim statement · print N · as on <date time>".
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'ipd_interim', p_doc_id: admId });
  if (rec.error || !rec.data) {
    document.getElementById('patientInfo').textContent = safeErrorMessage(rec.error, 'Could not record this print. Please try again.');
    return;
  }
  const stamp = `Interim statement · print ${Number(rec.data.print_no) || 1} · as on ${_fmtDateTime(rec.data.printed_at || new Date().toISOString())}`;
  document.getElementById('docTitle').textContent = 'INTERIM STATEMENT';
  document.getElementById('receiptMeta').textContent = stamp;
  const note = document.getElementById('notaxNote');
  note.textContent = `${stamp} — not a bill, not a tax invoice.`;
  note.style.display = '';

  const pt  = adm.patients || {};
  const bed = adm.beds || {};
  document.getElementById('patientInfo').innerHTML = `
    <div><b>Patient:</b> ${_esc(pt.name || '—')}</div>
    <div><b>Admission:</b> ${_esc(adm.admission_date || '—')}${bed.bed_number ? ' · Bed ' + _esc(bed.bed_number) : ''}${adm.departments?.name ? ' · ' + _esc(adm.departments.name) : ''}</div>
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
    // Session 319 -- the fee's own admin-set label, not the raw bed_type key (patient-facing print).
    rows.push(`<tr><td class="py-1">Room Tariff — ${charges.tariff.days} day${charges.tariff.days>1?'s':''} × ${_esc(charges.tariff.label || 'Room charges')}</td><td class="py-1 text-right">₹${_n(charges.tariffTotal)}</td></tr>`);
  }
  charges.charges.forEach(c => {
    rows.push(`<tr><td class="py-1">${_esc(c.description)}</td><td class="py-1 text-right">₹${_n(c.amount)}</td></tr>`);
  });
  rows.push(`<tr><td class="py-1 border-t font-semibold">Charges so far</td><td class="py-1 text-right border-t font-semibold">₹${_n(charges.total)}</td></tr>`);
  // If a bill has since been raised, the held money is already credited to it -- label
  // it as applied (same rule as the Account drawer's Money Held tile).
  const billRaised = !!(acc && acc.bill_id);
  const heldLabel  = billRaised ? 'Advance / deposits applied to bill' : 'Money held (advance + deposits)';
  rows.push(acctBlocked
    ? `<tr><td class="py-1">Money held (advance + deposits)</td><td class="py-1 text-right text-red-600 text-xs">not available to this role</td></tr>`
    : `<tr><td class="py-1">${heldLabel}</td><td class="py-1 text-right">₹${_n(acc.held || 0)}</td></tr>`);
  document.getElementById('lineTable').innerHTML = rows.join('');

  if (acctBlocked) {
    document.getElementById('totalAmount').textContent = `Charges so far: ₹${_n(charges.total)} (balance needs a billing role to compute)`;
    document.getElementById('amountWords').style.display = 'none';
    return;
  }

  // After a bill exists the server's own balance is authoritative (held is already netted into it).
  const balance = billRaised ? (Number(acc.balance) || 0) : charges.total - (Number(acc.held) || 0);
  document.getElementById('totalAmount').textContent = balance >= 0
    ? `Estimated balance: ₹${_n(balance)}`
    : `Estimated refund due: ₹${_n(-balance)}`;
  document.getElementById('amountWords').style.display = 'none';
}

async function start() {
  // signed out / session ended: ask to sign in before touching the document (§118)
  if (!(await ensureSignedIn(supabase))) return;
  if (paymentId) await loadReceipt();
  else if (admId) await loadInterim();
  else document.getElementById('patientInfo').textContent = 'No receipt or admission specified.';
}
start().finally(refreshPrintPageSize);
