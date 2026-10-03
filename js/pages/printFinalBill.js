// IPD Final Bill / Invoice (Session 320). One document per admission: printFinalBill.html?adm=<id>.
// All data comes from the read-only get_ipd_final_bill() RPC (billing roles only, tenant-checked
// server-side); every money figure is a stored column or _ipd_account()'s balance -- this file
// only formats and groups. Layout is the shared js/modules/billing/invoiceLayout.js; this file
// is the IPD adapter that fills its model.
import { supabase } from '../core/db/supabaseClient.js'
import { getCurrentRole, getCurrentSecondaryRole, getCurrentTenantId } from '../core/auth.js'
import { wireDelegatedEvents } from '../utils/domEvents.js'
import { amountInWords } from '../utils/amountInWords.js'
import { safeErrorMessage } from '../utils/errors.js'
import { uhidOf } from '../utils/uhid.js'
import { renderInvoice, el } from '../modules/billing/invoiceLayout.js'
import { isDemoTenant } from '../modules/billing/demoBanner.js'

wireDelegatedEvents()

const admId    = new URLSearchParams(window.location.search).get('adm');
const sheet    = document.getElementById('invoice');
const statusEl = document.getElementById('status');
const printBtn = document.getElementById('print-btn');
const adminBar = document.getElementById('admin-bar');

const KIND_LABEL  = { advance: 'Advance', deposit: 'Deposit', payment: 'Payment', refund: 'Refund' };
const MODE_LABEL  = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' };
const PAYER_LABEL = { insurance: 'Insurance', pmjay: 'PM-JAY', cghs: 'CGHS', echs: 'ECHS', esi: 'ESI', corporate: 'Corporate' };
const TAXCAT_LABEL = { EXEMPT: 'Exempt', NIL_RATED: 'Nil-rated', NON_GST: 'Non-GST', OUT_OF_SCOPE: 'Out of scope' };
const DOC_TITLE   = { TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply', BILL: 'Bill' };
const CATS = [
  ['room', 'Room & Accommodation'], ['consult', 'Consultation & Visits'], ['proc', 'Procedures / Panchakarma'],
  ['pharmacy', 'Pharmacy'], ['invest', 'Investigations'], ['other', 'Other Charges'],
];

const num   = v => Number(v) || 0;
const money = v => num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupee = v => `₹ ${money(v)}`;
// Dates always in IST, "29 Sep 2026, 04:00 PM" (fixed month names -- en-IN's own short month is "Sept")
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _istParts(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { d: p.day, m: MON[Number(p.month) - 1], y: p.year, time: `${p.hour}:${p.minute} ${(p.dayPeriod || '').toUpperCase()}` };
}
const fmtDT = iso => { if (!iso) return null; const p = _istParts(iso); return `${p.d} ${p.m} ${p.y}, ${p.time}`; };
const fmtD  = d => { if (!d) return null; const p = _istParts(d.length === 10 ? `${d}T12:00:00+05:30` : d); return `${p.d} ${p.m} ${p.y}`; };
const istDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD
const UPPER_WORDS = new Set(['ac', 'icu', 'hdu', 'iccu', 'nicu', 'picu']);
const titleCase = s => (s || '').replace(/[_-]+/g, ' ').split(' ')
  .map(w => UPPER_WORDS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const SEX = { f: 'Female', female: 'Female', m: 'Male', male: 'Male', o: 'Other', other: 'Other' };

let _data = null;

function category(it) {
  const sec = (it.bill_section || '').toLowerCase();
  const t   = (it.item_type || it.source_type || '').toLowerCase();
  if (sec === 'room' || t === 'room_tariff' || t === 'room_day') return 'room';
  if (sec.startsWith('consult') || /consult|visit/.test(t)) return 'consult';
  if (sec === 'panchakarma' || sec.startsWith('procedure') || t === 'pk_session' || t.includes('procedure')) return 'proc';
  if (sec === 'pharmacy' || t === 'pharmacy') return 'pharmacy';
  if (sec.startsWith('investigation') || t === 'lab' || t === 'imaging' || t === 'order') return 'invest';
  return 'other';
}

function payerInfo(d) {
  const b = d.bill || {}, ins = d.insurance;
  const type = b.payer_type || d.admission.payer_type || 'self_pay';
  if (type === 'self_pay') return { type, short: 'Self-pay', label: 'Self-pay', name: null, mode: null, ids: null };
  const label   = PAYER_LABEL[type] || titleCase(type);
  const insurer = ins?.insurer_name || b.insurance_provider || null;
  const tpa     = ins?.tpa_name || b.tpa_name || null;
  const cashless = ins?.is_cashless ?? b.is_cashless;
  const mode    = cashless === true ? 'Cashless' : cashless === false ? 'Reimbursement' : null;
  const name    = [insurer, tpa ? `TPA: ${tpa}` : null].filter(Boolean).join(' · ') || label;
  const policy  = ins?.policy_number || b.policy_number;
  const ids = [policy ? `Policy ${policy}` : null, ins?.member_id ? `Member ID ${ins.member_id}` : null,
               ins?.pmjay_package_code ? `Package ${ins.pmjay_package_code}` : null].filter(Boolean).join(' · ') || null;
  return { type, label, name, mode, ids, short: `${name}${mode ? ' — ' + mode : ''}` };
}

function monogram(name) {
  const first = (name || '').split(/\s+/)[0] || '';
  if (/^[A-Z]{2,4}$/.test(first)) return first;
  return (name || '').split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0].toUpperCase()).join('');
}

function buildModel(d) {
  const t = d.tenant || {}, tax = d.tax || {}, adm = d.admission, pt = d.patient || {}, b = d.bill, acc = d.account || {};
  const isGst     = b.tax_regime === 'gst_v1';
  const isDraft   = isGst && b.document_status === 'draft';
  const docType   = b.document_type;
  const payer     = payerInfo(d);
  // No taxable line at all (e.g. a Bill of Supply for exempt healthcare services): no tax columns / tax summary
  const exemptOnly = isGst && d.items.length > 0 && !d.items.some(it => it.tax_category === 'TAXABLE');

  // ── Hospital block: a GST document prints the supplier details frozen on the bill ──
  let orgName, orgLines;
  if (isGst && !isDraft && b.supplier_legal_name) {
    orgName  = b.supplier_legal_name;
    orgLines = [b.supplier_address,
                b.supplier_gstin ? `GSTIN: ${b.supplier_gstin}${b.supplier_state_code ? ' · State code ' + b.supplier_state_code : ''}` : 'Not registered under GST'];
  } else {
    orgName  = t.name || 'Hospital';
    const gstin = tax.gst_registered ? (tax.gstin || t.gstin) : null;
    orgLines = [t.address || [t.city, t.state].filter(Boolean).join(', '),
                [t.phone ? `Ph: ${t.phone}` : null, t.email].filter(Boolean).join(' · '),
                gstin ? `GSTIN: ${gstin}` : 'Not registered under GST'];
  }
  orgLines = orgLines.filter(Boolean);

  // ── Title ──
  let title = 'Final Bill', subtitle = 'In-Patient · Original', watermark = null;
  if (isGst) {
    if (isDraft) { title = 'Draft Bill'; subtitle = 'In-Patient'; watermark = 'DRAFT — NOT A TAX INVOICE'; }
    else {
      title = DOC_TITLE[docType] || 'Bill';
      subtitle = docType === 'TAX_INVOICE' ? 'In-Patient · Original for Recipient' : 'In-Patient · Original';
      if (b.document_status === 'cancelled') watermark = 'CANCELLED';
    }
  }

  // ── Bill To (decision 5): tenant default, per-bill override; GST uses the frozen recipient ──
  const addressee = b.invoice_addressee || tax.invoice_addressee || 'patient';
  let billTo = pt.name, billToSub = null;
  if (isGst) {
    billTo = b.recipient_name || pt.name;
    billToSub = b.recipient_gstin ? `GSTIN ${b.recipient_gstin}` : null;
  } else if (addressee === 'payer' && payer.type !== 'self_pay') {
    billTo = payer.name; billToSub = `for patient ${pt.name || ''}`.trim();
  }

  const meta = [
    // "Invoice No." / "Invoice Date" only on a Tax Invoice; a Bill of Supply carries a Bill No.
    { label: isGst && !isDraft && docType === 'TAX_INVOICE' ? 'Invoice No.' : 'Bill No.', value: b.document_number || (isDraft ? 'Issued on finalisation' : 'Not numbered'),
      gap: !b.document_number },
    { label: isGst && !isDraft && docType === 'TAX_INVOICE' ? 'Invoice Date' : 'Bill Date',
      value: isGst && !isDraft ? fmtD(b.document_date) : fmtDT(b.created_at),
      sub: isGst && b.place_of_supply_state_code ? `Place of supply: state ${b.place_of_supply_state_code}` : null },
  ];
  meta.push({ label: 'Bill To', value: billTo, sub: billToSub, wide: true });
  meta.push({ label: 'Payer', value: payer.short, sub: payer.ids, wide: true });

  // ── Patient & Admission ──
  const sex = SEX[(pt.gender || '').toLowerCase()] || pt.gender || null;
  const ageSex = [pt.age != null ? `${pt.age} Y` : null, sex].filter(Boolean).join(' / ') || null;
  const endAt = adm.discharged_at || adm.clinically_discharged_at;
  let los = null;
  if (adm.is_day_care) los = 'Day care';
  else if (adm.admitted_at && endAt) {
    const n = Math.max(1, Math.round((new Date(istDay(endAt)) - new Date(istDay(adm.admitted_at))) / 86400000));
    los = `${n} day${n > 1 ? 's' : ''}`;
  }
  const bed = d.bed ? [d.bed.bed_number, titleCase(d.bed.bed_type), d.bed.ward_name].filter(Boolean).join(' · ') : null;
  const fields = [
    { label: 'Patient Name', value: pt.name, wide: true },
    { label: 'Age / Sex', value: ageSex },
    { label: 'UHID', value: uhidOf(pt) },
    { label: 'IP No.', value: adm.ip_number || 'Not numbered', gap: !adm.ip_number },
    { label: 'Phone', value: pt.phone },
    { label: 'Admitted', value: fmtDT(adm.admitted_at) || fmtD(adm.admission_date) },
    { label: 'Discharged', value: fmtDT(endAt) || 'Still admitted', gap: !endAt },
    { label: 'Length of Stay', value: los || '—' },
    { label: 'Bed / Ward', value: bed },
    { label: 'Department', value: d.department },
    { label: 'Treating Doctor', value: d.doctor },
    { label: 'Payer', value: payer.type === 'self_pay' ? 'Self-pay' : `${payer.label}${payer.mode ? ' — ' + payer.mode : ''}` },
  ];
  if (payer.type !== 'self_pay') {
    fields.push({ label: 'Insurer / TPA / Policy', value: [payer.name, payer.ids].filter(Boolean).join(' · '), wide: true });
  }
  fields.push({ label: 'Address', value: pt.address || 'Not recorded', gap: !pt.address, wide: true });

  // ── Charges, grouped ──
  const groups = new Map(CATS.map(([k]) => [k, []]));
  for (const it of d.items) groups.get(category(it)).push(it);
  let lineNo = 0;
  const sections = [];
  for (const [key, label] of CATS) {
    const items = groups.get(key);
    if (!items.length) continue;
    let sub = 0;
    const rows = items.map(it => {
      const q = num(it.quantity);
      const unit = it.unit || (it.item_type === 'room_tariff' ? 'day' : null);
      const amount = it.line_total ?? it.total;
      sub += num(amount);
      const taxable = it.tax_category === 'TAXABLE';
      return {
        no: ++lineNo, description: it.description, sub: it.charge_date ? fmtD(it.charge_date) : null,
        code: it.sac_code || it.hsn_code || null,
        qty: unit ? `${q} ${unit}${q > 1 ? 's' : ''}` : String(q),
        rate: money(it.price),
        disc: money(num(it.line_discount) + num(it.bill_discount_alloc)),
        taxable: taxable ? money(it.taxable_value) : '—',
        gstLabel: taxable ? `${num(it.gst_rate)}%` : (TAXCAT_LABEL[it.tax_category] || '—'),
        cgst: taxable ? money(it.cgst_amount) : '—',
        sgst: taxable ? money(it.sgst_amount) : '—',
        amount: money(amount),
      };
    });
    sections.push({ title: label, rows, subtotal: money(sub) });
  }

  // ── GST tax summary (by rate, from the stored line values) ──
  let taxSummary = null, taxNote = null;
  if (exemptOnly) {
    const cats = [...new Set(d.items.map(it => TAXCAT_LABEL[it.tax_category] || 'Not taxable'))].join(' / ');
    taxNote = `GST: ${cats} — no GST is charged on this bill.`;
  } else if (isGst) {
    const byKey = new Map();
    for (const it of d.items) {
      const taxable = it.tax_category === 'TAXABLE';
      const key = taxable ? `r${num(it.gst_rate)}` : it.tax_category || 'NONE';
      const r = byKey.get(key) || { label: taxable ? `${num(it.gst_rate)}% (${num(it.cgst_rate)}% + ${num(it.sgst_rate)}%)` : (TAXCAT_LABEL[it.tax_category] || 'Other'),
                                    value: 0, cgst: 0, sgst: 0, taxable };
      r.value += num(taxable ? it.taxable_value : (it.line_total ?? it.total));
      r.cgst  += num(it.cgst_amount); r.sgst += num(it.sgst_amount);
      byKey.set(key, r);
    }
    taxSummary = [...byKey.values()].map(r => ({
      label: r.label, value: money(r.value),
      cgst: r.taxable ? money(r.cgst) : '—', sgst: r.taxable ? money(r.sgst) : '—',
      tax: r.taxable ? money(r.cgst + r.sgst) : '—' }));
  }

  // ── Payments: every ledger row, voided ones struck through with the reason ──
  const live = d.payments.filter(p => !p.voided_at);
  const sumKind = (kinds, pred = () => true) => live.filter(p => kinds.includes(p.kind) && pred(p)).reduce((s, p) => s + num(p.amount), 0);
  const payRows = d.payments.map(p => ({
    receiptNo: p.receipt_no, date: fmtDT(p.received_at),
    type: (KIND_LABEL[p.kind] || p.kind) + (p.kind === 'refund' && !p.bill_id ? ' (before bill)' : ''),
    mode: [MODE_LABEL[p.mode] || p.mode, p.reference].filter(Boolean).join(' · '),
    amount: (p.kind === 'refund' ? '−' : '') + money(p.amount),
    voided: !!p.voided_at, voidReason: p.void_reason,
  }));
  const insApproved = num(b.insurance_approved_amount);
  if (insApproved > 0) {
    payRows.push({
      receiptNo: 'Insurance', date: fmtD(d.insurance?.final_approval_at) || '—', type: 'Insurance approval',
      mode: [payer.name, d.insurance?.final_approval_reference_number].filter(Boolean).join(' · '),
      amount: money(insApproved), voided: false });
  }
  const netReceived = sumKind(['advance', 'deposit', 'payment']) - sumKind(['refund']);

  // ── Summary: stored totals; balance is _ipd_account()'s own figure ──
  const rows = [];
  if (isGst) {
    rows.push({ label: 'Gross charges', value: money(b.gross_total) });
    rows.push({ label: 'Less: discount', value: money(num(b.line_discount_total) + num(b.bill_discount_total)) });
    if (!exemptOnly) rows.push({ label: 'Taxable value', value: money(b.taxable_total) });
    rows.push({ label: 'Exempt / non-taxable value', value: money(num(b.exempt_total) + num(b.nil_rated_total) + num(b.non_gst_total)) });
    if (!exemptOnly) {
      rows.push({ label: 'CGST', value: money(b.cgst_total) });
      rows.push({ label: 'SGST', value: money(b.sgst_total) });
    }
    rows.push({ label: docType === 'TAX_INVOICE' ? 'Invoice total' : 'Bill total', value: rupee(b.final_amount), grand: true });
  } else {
    rows.push({ label: 'Gross charges', value: money(b.total_amount ?? b.final_amount) });
    rows.push({ label: 'Less: discount', value: money(b.discount) });
    rows.push({ label: 'Tax', value: 'Not applicable' });
    rows.push({ label: 'Net bill amount', value: rupee(b.final_amount), grand: true });
  }
  if (payer.type !== 'self_pay' || insApproved > 0) rows.push({ label: 'Less: insurance approved', value: money(insApproved) });
  rows.push({ label: 'Less: advance applied', value: money(b.advance_credited) });
  rows.push({ label: 'Less: payments received', value: money(sumKind(['payment'])) });
  const postBillRefunds = sumKind(['refund'], p => !!p.bill_id);
  if (postBillRefunds > 0) rows.push({ label: 'Add: refunds paid', value: money(postBillRefunds) });

  const bal = num(acc.balance);
  const balance = bal < -0.005 ? { label: 'Refundable', value: rupee(-bal) } : { label: 'Balance Due', value: rupee(Math.max(bal, 0)) };
  const wordsLines = [`${amountInWords(b.final_amount)}.`];
  if (Math.abs(bal) < 0.005) wordsLines.push(b.status === 'paid' ? 'Paid in full.' : 'Nothing due.');
  else if (bal > 0) wordsLines.push(`Balance due: ${amountInWords(bal)}.`);
  else wordsLines.push(`Refundable: ${amountInWords(-bal)}.`);

  const preparedBy = b.created_by_name || b.finalized_by_name;
  const left = [`Prepared by: ${preparedBy || '____________________'}`];
  if (isGst && b.finalized_at) left.push(`Finalised ${fmtDT(b.finalized_at)}`);

  const footer = [];
  if (isGst && docType === 'TAX_INVOICE' && !isDraft) footer.push('Whether tax is payable on reverse charge: No.');
  const docWord = isDraft ? 'Draft bill — not a tax invoice' : isGst ? `Computer-generated ${(DOC_TITLE[docType] || 'bill').toLowerCase()}` : 'Computer-generated bill — not a tax invoice';
  footer.push(`${docWord}. Receipts were issued separately at the time of payment. · Powered by AyurXpert`);

  return {
    org: { name: orgName, lines: orgLines, logoUrl: t.logo_url || null, monogram: monogram(orgName) },
    title, subtitle, watermark, meta,
    party: { title: 'Patient & Admission', fields },
    demo: d.isDemo, gst: isGst, exemptOnly, sections, emptyNote: null, taxNote, taxSummary,
    payments: { rows: payRows, totalLabel: 'Net received from patient (voided excluded)', total: money(netReceived) },
    summary: { rows, balance },
    words: { label: `Amount in words (${!isGst ? 'net bill amount' : docType === 'TAX_INVOICE' && !isDraft ? 'invoice total' : 'bill total'})`, lines: wordsLines },
    signatures: { left, right: ['Authorised Signatory', `for ${orgName}`] },
    footer,
  };
}

// ── Audited per-bill "Bill to" override (decision 5) -- legacy bills, admins only ──
function renderAdminBar(d) {
  const role = getCurrentRole(), sec = getCurrentSecondaryRole();
  const isAdmin = ['super_admin', 'dept_admin'].includes(role) || sec === 'dept_admin';
  if (!isAdmin || d.bill.tax_regime !== 'legacy') { adminBar.hidden = true; return; }
  const dflt = d.tax?.invoice_addressee === 'payer' ? 'Payer' : 'Patient';
  const cur = d.bill.invoice_addressee || '';
  const sel = el('select', { id: 'addr-sel', 'aria-label': 'Bill to' },
    [['', `Organisation default (${dflt})`], ['patient', 'Patient'], ['payer', 'Payer']].map(([v, l]) =>
      el('option', { value: v, selected: v === cur }, l)));
  adminBar.replaceChildren(
    el('label', { for: 'addr-sel' }, 'Bill to'), sel,
    el('input', { id: 'addr-reason', type: 'text', placeholder: 'Reason (required, audited)', 'aria-label': 'Reason for change' }),
    el('button', { class: 'btn btn-secondary', type: 'button', 'data-onclick': 'saveAddressee' }, 'Change bill-to'));
  adminBar.hidden = false;
}

window.saveAddressee = async function() {
  const val = document.getElementById('addr-sel').value || null;
  const reason = document.getElementById('addr-reason').value.trim();
  setStatus('Saving…');
  const { error } = await supabase.rpc('set_bill_invoice_addressee', { p_bill: _data.bill.id, p_addressee: val, p_reason: reason });
  if (error) { setStatus(safeErrorMessage(error, 'Could not change who the bill is addressed to.'), true); return; }
  setStatus('Bill-to changed (audited).');
  await load();
};

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status-msg' + (isErr ? ' err' : '');
}

function showError(msg) {
  sheet.replaceChildren(el('p', { class: 'error-box' }, msg));
  printBtn.disabled = true;
  adminBar.hidden = true;
}

async function load() {
  if (!admId) { showError('No admission specified.'); return; }
  // get_ipd_final_bill only answers for the caller's own organisation, so that is the document's tenant
  const [{ data, error }, isDemo] = await Promise.all([
    supabase.rpc('get_ipd_final_bill', { p_adm: admId }),
    isDemoTenant(supabase, getCurrentTenantId()),
  ]);
  if (error) { showError(safeErrorMessage(error, 'Could not load the bill.')); return; }
  if (!data?.bill) { showError('No bill has been generated for this admission yet.'); return; }
  data.isDemo = isDemo;
  _data = data;
  const model = buildModel(data);
  renderInvoice(sheet, model);
  sheet.querySelector('.logo-img')?.addEventListener('error', e => e.target.remove());
  document.title = `${model.title} ${data.bill.document_number || ''} — ${data.patient?.name || ''}`.replace(/\s+/g, ' ').trim();
  printBtn.disabled = false;
  renderAdminBar(data);
}

load();
