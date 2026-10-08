import { requireAuth, hasModule, getCurrentProfile, getCurrentTenantId, getCurrentSecondaryRole } from '../core/auth.js';
import { initNavbar }  from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { logAudit } from '../core/auditLogger.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';
import { billCategory, BILL_CATEGORY_LABEL, OUTSTANDING_STATUSES, dueAmount, summarisePeriod, isSale, istDate } from '../modules/billing/billCategory.js';
import { notify } from '../components/notify.js';
import { canCollectOpd, isCollectableOpdBill, opdCollectControlsHtml, collectOpdBill, openReceipt } from '../modules/billing/opdPayments.js';
import { mountVisitsBillsSearch } from '../modules/billing/visitsBillsSearch.js';
import { mountReturnsQueue } from '../modules/pharmacy/returnsQueue.js';
import { mountItemTaxApprovals, mountBulkItemTax, isTaxMaker } from '../modules/pharmacy/itemTax.js';
import { mountTaxSettings } from '../modules/tax/taxSettings.js';
import { mountTaxApprovals, TAX_APPROVAL_TYPES } from '../modules/tax/taxApprovals.js';

wireDelegatedEvents();

const ALLOWED = ['super_admin','dept_admin','accountant','cashier','finance_manager','receptionist'];
await requireAuth(ALLOWED);
if (!hasModule('finance')) { window.location.replace('admin.html'); }

const _profile = getCurrentProfile();
const _role    = _profile?.role;

const sess     = getCurrentProfile();
const tenantId = getCurrentTenantId();
const _ctx     = { tenantId, userId: _profile?.id, userName: _profile?.full_name };

initNavbar();

// ── Group + sub-tab switching ───────────────────────
// (defined here, before the role-based visibility block below, since that block
// calls switchGrp() directly on load for the receptionist role)
window.switchGrp = function(grp, el) {
  document.querySelectorAll('.grp-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.grp-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('grp-' + grp).classList.add('active');
  el.classList.add('active');
  if (grp === 'insurance') loadInsuranceClaims();
};

window.switchSub = function(grp, sub, el) {
  const panel = document.getElementById('grp-' + grp);
  panel.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
  panel.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('sub-' + sub).classList.add('active');
  el.classList.add('active');
  if (sub === 'audit') loadAudits();
  if (sub === 'preauth') renderPreAuth();
  if (sub === 'vbsearch' && !_vbMounted) { _vbMounted = true; mountVisitsBillsSearch(document.getElementById('vb-search-root'), { supabase }); }
  if (sub === 'itemtax') {   // Session 345b
    mountItemTaxApprovals(document.getElementById('itemtax-approvals-root'), { supabase, onCount: n => _setBadgeEl('itemtax-badge', n) });
    if (isTaxMaker()) mountBulkItemTax(document.getElementById('itemtax-bulk-root'), { supabase });
  }
  if (sub === 'taxsettings') {   // Session 345c2a
    mountTaxApprovals(document.getElementById('taxappr-root'), { supabase, onCount: () => _refreshTaxBadge(),
      onDecided: () => { _refreshTaxBadge(); _taxCard?.reload(); } });
    _taxCard = mountTaxSettings(document.getElementById('taxsettings-root'), { supabase });
  }
  if (sub === 'pharmreturns') {
    if (!_prQueue) _prQueue = mountReturnsQueue(document.getElementById('pharmreturns-root'), { supabase, onCount: _setPrBadge, onDecided: () => window.loadAll() });
    else _prQueue.reload();
  }
};
let _taxCard = null;   // Session 345c2a: the Tax settings card (reloaded after a decision)
let _vbMounted = false;   // Visits & Bills search mounts once, on first open (Session 328)
// Session 344b: Pharmacy returns waiting for approval. The tab is shown to the roles decide_pharmacy_return() accepts
// (dept_admin / super_admin / finance_manager / accountant, primary or secondary) when the organisation has the pharmacy
// module; WHICH request this person may decide -- and the badge -- is the server's answer (approval_decide_check()).
let _prQueue = null;
function _setPrBadge(n) {
  const b = document.getElementById('pharmreturns-badge');
  if (!b) return;
  b.textContent = String(n || 0);
  b.hidden = !n;
  b.setAttribute('aria-label', `${n || 0} waiting for your decision`);
}
// Session 345b: Medicine tax (item HSN / profile requests) -- shown to the tax makers and approvers when the organisation has
// the pharmacy module; the badge is how many THIS person may decide (approval_decide_check)
function _setBadgeEl(id, n) {
  const b = document.getElementById(id);
  if (!b) return;
  b.textContent = String(n || 0); b.hidden = !n; b.setAttribute('aria-label', `${n || 0} waiting for your decision`);
}
if (hasModule('pharmacy') && (isTaxMaker() || _role === 'finance_manager' || getCurrentSecondaryRole() === 'finance_manager')) {
  document.getElementById('tab-itemtax').hidden = false;
  supabase.rpc('approval_decide_check', { p_ids: null }).then(({ data, error }) => {
    if (!error) _setBadgeEl('itemtax-badge', (data || []).filter(c => c.action_type === 'item_tax_change' && c.can_decide).length);
  });
}
// Session 345c2a: Tax settings -- the accountant / finance manager (primary or secondary) and the other tax makers; the badge
// counts every tax decision THIS person may take (item tax + IP-medicines choice + default profiles; approval_decide_check)
function _refreshTaxBadge() {
  supabase.rpc('approval_decide_check', { p_ids: null }).then(({ data, error }) => {
    if (!error) _setBadgeEl('taxsettings-badge', (data || []).filter(c => (c.action_type === 'item_tax_change' || TAX_APPROVAL_TYPES.includes(c.action_type)) && c.can_decide).length);
  });
}
if (isTaxMaker() || _role === 'finance_manager' || getCurrentSecondaryRole() === 'finance_manager') {
  document.getElementById('tab-taxsettings').hidden = false;
  _refreshTaxBadge();
}
const _PR_DECIDERS = ['dept_admin', 'super_admin', 'finance_manager', 'accountant'];
if (hasModule('pharmacy') && (_PR_DECIDERS.includes(_role) || _PR_DECIDERS.includes(getCurrentSecondaryRole()))) {
  document.getElementById('tab-pharmreturns').hidden = false;
  supabase.rpc('approval_decide_check', { p_ids: null }).then(({ data, error }) => {
    if (!error) _setPrBadge((data || []).filter(c => c.action_type === 'pharmacy_return' && c.can_decide).length);
  });
}

// Insurance Cycles state — declared here (not further down near the rest of the
// Insurance Cycles code) since the receptionist-role branch below can call
// switchGrp('insurance', ...) synchronously on load, which calls loadInsuranceClaims()
// immediately; a `let` declared later in the module is in the temporal dead zone
// until its own line runs, so reading it this early would throw.
let _insClaims = [], _insFilter = 'all', _insBillId = null;
let _insLoaded = false;

// Role-based tab visibility
// receptionist   → Insurance Cycles only
// cashier        → Revenue Tracking + Insurance Cycles (no Expenses)
// accountant     → all 3
// finance_manager→ all 3
if (_role === 'receptionist') {
  document.querySelectorAll('.grp-tab').forEach(btn => {
    if (btn.dataset.grp !== 'insurance') btn.style.display = 'none';
  });
  const insBtn = document.querySelector('.grp-tab[data-grp="insurance"]');
  if (insBtn) switchGrp('insurance', insBtn);
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#f0f7ff;border-left:4px solid #4080c0;padding:10px 16px;margin:12px 16px 0;border-radius:6px;font-size:13px;color:#1a4080';
  banner.textContent   = '🏥 Insurance Operations Mode — Revenue and expense data is not accessible from this role.';
  document.querySelector('.grp-nav')?.after(banner);
}

if (_role === 'cashier') {
  const expBtn = document.querySelector('.grp-tab[data-grp="expenses"]');
  if (expBtn) expBtn.style.display = 'none';
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#f0f7ff;border-left:4px solid #4080c0;padding:10px 16px;margin:12px 16px 0;border-radius:6px;font-size:13px;color:#1a4080';
  banner.textContent   = '🧾 Billing Mode — Expense and audit reports are not accessible from this role.';
  document.querySelector('.grp-nav')?.after(banner);
}

// ── State ──────────────────────────────────────────
let _bills = [], _expenses = [], _outstanding = [];
// Session 344a: the period's returns (by RETURN date), receipts / refunds (by receipt date) and paid-before-receipts bills
let _activity = { returns: [], receipts: [], legacy_collected: {} };

// ── §21ae CA Audit functions ──────────────────────────────
let _audits = [];

window.openAuditModal = function() {
  const sel = document.getElementById('aud-year');
  sel.innerHTML = '';
  const cy = new Date().getFullYear();
  for (let y = cy; y >= cy - 5; y--) {
    const o = document.createElement('option');
    o.value = `${y-1}-${y}`; o.textContent = `${y-1}-${y}`;
    sel.appendChild(o);
  }
  document.getElementById('aud-date').value = '';
  document.getElementById('aud-firm').value = '';
  document.getElementById('aud-url').value = '';
  document.getElementById('audit-modal').style.display = 'flex';
};
window.closeAuditModal = function() {
  document.getElementById('audit-modal').style.display = 'none';
};

window.loadAudits = async function() {
  const tbody = document.getElementById('audit-tbody');
  const { data, error } = await supabase
    .from('annual_audits')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('audit_year', { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#c0392b;padding:16px">${error.code === '42P01' ? 'Run session32_ncism_gaps.sql to activate' : _esc(safeErrorMessage(error, 'Could not load data.'))}</td></tr>`;
    return;
  }
  _audits = data || [];

  // Dec 31 alert check
  const cy = new Date().getFullYear();
  const cyYear = `${cy-1}-${cy}`;
  const currentYearDone = _audits.some(a => a.audit_year === cyYear && a.status === 'completed');
  const alertEl = document.getElementById('audit-alert');
  const today = new Date();
  if (!currentYearDone && today.getMonth() >= 9) {
    alertEl.textContent = `⚠ Annual CA audit for ${cyYear} not yet recorded as completed. NCISM Regulation 7(7) requires audit to be done and report available to MARBISM.`;
    alertEl.style.display = '';
  } else { alertEl.style.display = 'none'; }

  if (!_audits.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px">No audit records yet. Click + Add Audit to record the first one.</td></tr>';
    return;
  }
  tbody.innerHTML = _audits.map(a => `
    <tr>
      <td style="font-weight:600">${a.audit_year || '—'}</td>
      <td>${a.ca_firm_name || '—'}</td>
      <td>${a.audit_date ? new Date(a.audit_date).toLocaleDateString('en-IN') : '—'}</td>
      <td><span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${a.status==='completed'?'#e8f5ee':'#fff8e1'};color:${a.status==='completed'?'#1a4a2e':'#6b4c00'}">${a.status?.toUpperCase()}</span></td>
      <td>${a.report_url ? `<a href="${a.report_url}" target="_blank" style="color:var(--green-mid);font-size:12px">View Report</a>` : '—'}</td>
    </tr>`).join('');
};

window.saveAudit = async function() {
  const firm = document.getElementById('aud-firm').value.trim();
  const year = document.getElementById('aud-year').value;
  if (!firm) { alert('CA Firm name is required'); return; }
  const payload = {
    tenant_id: tenantId,
    audit_year: year,
    ca_firm_name: firm,
    audit_date: document.getElementById('aud-date').value || null,
    status: document.getElementById('aud-status').value,
    report_url: document.getElementById('aud-url').value.trim() || null,
  };
  const { error } = await supabase.from('annual_audits').insert(payload);
  if (error) { alert(safeErrorMessage(error, 'Could not save audit.')); return; }
  closeAuditModal();
  loadAudits();
};

// ── Date presets ────────────────────────────────────
window.applyPreset = function() {
  const p = document.getElementById('period-preset').value;
  const today = new Date();
  let from, to = _fmt(today);
  if (p === 'today')   { from = to; }
  else if (p === 'week') {
    const d = new Date(today); d.setDate(today.getDate() - today.getDay());
    from = _fmt(d);
  } else if (p === 'month') {
    from = _fmt(new Date(today.getFullYear(), today.getMonth(), 1));
  } else if (p === 'quarter') {
    const q = Math.floor(today.getMonth() / 3);
    from = _fmt(new Date(today.getFullYear(), q * 3, 1));
  } else if (p === 'year') {
    from = _fmt(new Date(today.getFullYear(), 0, 1));
  } else { return; }
  document.getElementById('date-from').value = from;
  document.getElementById('date-to').value   = to;
};

// ── Load all ────────────────────────────────────────
window.loadAll = async function() {
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;
  if (!from || !to) { _toast('Select a date range', 'error'); return; }
  await Promise.all([loadBills(from, to), loadOutstanding(), loadExpenses(from, to)]);
};

// ── Bills / Revenue ─────────────────────────────────
async function loadBills(from, to) {
  const { data, error } = await supabase
    .from('bills')
    .select('id, created_at, final_amount, total_amount, registration_fee, consultation_fee, on_request_surcharge, patient_due, amount_paid, returned_amount, bill_type, payment_mode, payment_method, payer_type, document_status, document_number, status, patients(name), insurer_name')
    .eq('tenant_id', tenantId)
    .gte('created_at', from + 'T00:00:00+05:30')
    .lte('created_at', to + 'T23:59:59.999+05:30')
    .order('created_at', { ascending: false });
  if (error) { _toast(safeErrorMessage(error, 'Could not load bills.'), 'error'); return; }
  _bills = data || [];
  // Session 344a (owner decision 6 Oct 2026): returns count on the RETURN date, collection on the receipt date
  const { data: act, error: aErr } = await supabase.rpc('finance_activity', { p_from: from, p_to: to });
  if (aErr) _toast(safeErrorMessage(aErr, 'Could not load the returns and receipts of this period — totals may be incomplete.'), 'error');
  _activity = act || { returns: [], receipts: [], legacy_collected: {} };
  await _loadLabItemTotals();
  renderRevenue(from, to);
  renderGST();
  renderDaily(from, to);
  updateKPIs();
}

// DOM helpers (Session 344a: rows built from nodes + textContent)
function _el(tag, text, style, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = String(text);
  if (style) e.style.cssText = style;
  if (cls) e.className = cls;
  return e;
}
function _setText(id, text) { const e = document.getElementById(id); if (e) e.textContent = text; }

function renderRevenue(from, to) {
  const tbody = document.getElementById('rev-tbody');
  const rets = _activity.returns || [];
  _setText('rev-period-lbl', `${_fmtD(from)} to ${_fmtD(to)} · ${_bills.length} bills · ${rets.length} returns / cancellations`);
  const k = _revenueBuckets(_bills);
  const s = summarisePeriod(_bills, _activity);

  // every bill of the period at its ORIGINAL amount (a later return / cancel does not change its day), and every
  // return / cancellation completed in the period as its own row, newest first
  const rows = [];
  for (const b of _bills) {
    const tr = _el('tr');
    tr.append(_el('td', _fmtD(istDate(b.created_at)), 'font-size:12px;white-space:nowrap'), _el('td', b.patients?.name || '—'));
    const tdT = _el('td'); tdT.append(_el('span', BILL_CATEGORY_LABEL[billCategory(b.bill_type)], 'font-size:10px', 'badge b-pending')); tr.append(tdT);
    tr.append(_el('td', '₹' + _n(b.total_amount)), _el('td', '₹' + _n((parseFloat(b.total_amount) || 0) - (parseFloat(b.final_amount) || 0))));
    const tdF = _el('td', '₹' + _n(b.final_amount), 'font-weight:500');
    if (!isSale(b)) tdF.append(_el('span', ' (not a sale: GST ' + (b.document_status || '') + ')', 'font-size:11px;color:var(--text-muted)'));
    tr.append(tdF, _el('td', (b.payment_mode || '—') + (b.insurer_name ? ' · ' + b.insurer_name : ''), 'font-size:12px'));
    const tdS = _el('td'); tdS.append(_el('span', b.status, null, 'badge b-' + String(b.status || '').replace(/[^a-z_]/g, ''))); tr.append(tdS);
    rows.push({ ts: b.created_at || '', tr });
  }
  for (const r of rets) {
    const tr = _el('tr', null, 'background:#fff8f6');
    tr.append(_el('td', _fmtD(r.date), 'font-size:12px;white-space:nowrap'),
      _el('td', `${r.return_no} — of bill ${r.document_number || '—'} (${_fmtD(r.bill_date)})`, 'font-size:12px'));
    const tdT = _el('td'); tdT.append(_el('span', r.kind === 'cancel' ? 'Cancellation' : 'Return', 'font-size:10px', 'badge b-cancelled')); tr.append(tdT);
    tr.append(_el('td', '—'), _el('td', '—'), _el('td', '− ₹' + _n(r.amount), 'font-weight:500;color:var(--red)'),
      _el('td', r.settlement === 'due' ? 'Due reduced' : r.settlement === 'void' ? 'Receipt voided' : 'Refund ' + String(r.refund_mode || '').toUpperCase(), 'font-size:12px'),
      _el('td', r.kind === 'cancel' ? 'cancelled' : 'returned'));
    rows.push({ ts: r.completed_at || '', tr });
  }
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (rows.length) tbody.replaceChildren(...rows.map(x => x.tr));
  else { const tr = _el('tr'); const td = _el('td', 'No bills in this period', null, 'empty'); td.colSpan = 8; tr.append(td); tbody.replaceChildren(tr); }

  _setText('rev-total-final', '₹' + _n(s.gross));
  _setText('rev-total-returns', '− ₹' + _n(s.returns));
  _setText('rev-total-net', '₹' + _n(s.net));
  _setText('r-reg', '₹' + _n(k.reg));
  _setText('r-con', '₹' + _n(k.con));
  _setText('r-phm', '₹' + _n(k.phm));
  _setText('r-lab', '₹' + _n(k.lab));
  _setText('r-oth', '₹' + _n(k.oth));
  _setText('r-ret', '− ₹' + _n(s.returns));
  _setText('r-net', '₹' + _n(s.net));
  _setText('r-reg-c', k.opdCnt + ' OPD bills');
  _setText('r-con-c', k.opdCnt + ' OPD bills');
  _setText('r-phm-c', k.phmCnt + ' pharmacy bills');
  _setText('r-lab-c', k.labCnt + ' bills with lab charges');
  _setText('r-oth-c', k.othCnt + ' IPD / package / other bills');
  _setText('r-ret-c', s.returnsCount + ' completed in this period');
  _setText('r-net-c', `gross ₹${_n(s.gross)} − returns ₹${_n(s.returns)}`);
}

// Session 295 -- lab charges attached to OPD bills (bill_items.item_type='lab') are part of
// those bills' final_amount but belong under Lab / Investigations, not "Other".
let _labByBill = {};
async function _loadLabItemTotals() {
  _labByBill = {};
  const ids = _bills.map(b => b.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('bill_items').select('bill_id, total, gst_amount')
      .in('bill_id', ids.slice(i, i + 200)).eq('item_type', 'lab');
    (data || []).forEach(r => {
      _labByBill[r.bill_id] = (_labByBill[r.bill_id] || 0) + (Number(r.total) || 0) + (Number(r.gst_amount) || 0);
    });
  }
}

// One pass, shared by the revenue cards and the GST summary so they can't disagree.
// OPD bill = registration + consultation (incl. on-request surcharge) + lab items + the
// rest (e.g. a Panchakarma plan estimate) under Other; investigation bills -> Lab.
function _revenueBuckets(bills) {
  const k = { reg: 0, con: 0, phm: 0, lab: 0, oth: 0, opdCnt: 0, phmCnt: 0, labCnt: 0, othCnt: 0 };
  bills.forEach(b => {
    if (!isSale(b)) return;                          // Session 344a: a GST draft / cancelled-and-reissued document is not a sale
    const f = Number(b.final_amount) || 0;           // Session 344a: the ORIGINAL amount (returns are their own line, by return date)
    const cat = billCategory(b.bill_type);
    if (cat === 'opd') {
      const reg = Number(b.registration_fee) || 0;
      const con = (Number(b.consultation_fee) || 0) + (Number(b.on_request_surcharge) || 0);
      const lab = _labByBill[b.id] || 0;
      const rest = Math.max(0, f - reg - con - lab);
      k.reg += reg; k.con += con; k.lab += lab; k.oth += rest; k.opdCnt++;
      if (lab) k.labCnt++;
      if (rest) k.othCnt++;
    } else if (cat === 'pharmacy') { k.phm += f; k.phmCnt++; }
    else if (cat === 'investigation') { k.lab += f; k.labCnt++; }
    else { k.oth += f; k.othCnt++; }
  });
  return k;
}

// ── Outstanding ─────────────────────────────────────
async function loadOutstanding() {
  const { data, error } = await supabase
    .from('bills')
    .select('id, created_at, final_amount, patient_due, amount_paid, returned_amount, bill_type, payer_type, payment_mode, status, document_status, ipd_admission_id, patients(name)')
    .eq('tenant_id', tenantId)
    // Session 295 -- bills are written 'unpaid' (reception) / 'partial' (PK advance);
    // 'pending' kept for legacy rows. A ₹0 bill (free follow-up) owes nothing.
    .in('status', OUTSTANDING_STATUSES)
    .gt('final_amount', 0)
    .order('created_at', { ascending: true });
  if (error) { _toast(safeErrorMessage(error, 'Could not load outstanding dues.'), 'error'); return; }
  _outstanding = (data || []).filter(b => dueAmount(b) > 0);
  renderOutstanding();
  updateKPIs();
}

// ── Collect a pending OPD / investigation bill (Session 324, TODO_LATER.md §96) ──
const _canCollectOpd = canCollectOpd(_profile);
window.collectOpdBill = async function(billId) {
  const res = await collectOpdBill({ supabase, billId });
  if (res.error) { _toast(safeErrorMessage(res.error, 'Could not record the payment.'), 'error'); return; }
  await logAudit('collect_opd_payment', 'bills', billId, {
    receipt_no: res.receipt_no, amount: Number(res.amount) || 0, payment_mode: res.mode,
  }, _ctx);
  _toast(`₹${_n(res.amount)} collected — receipt ${res.receipt_no}.`, 'success');
  openReceipt(res.payment_id);
  loadAll();
};

function renderOutstanding() {
  const tbody = document.getElementById('out-tbody');
  const today = new Date(); today.setHours(0,0,0,0);
  let total = 0;
  const aging = { '0-7':0, '8-30':0, '31+':0 };

  tbody.innerHTML = _outstanding.map(b => {
    const f = dueAmount(b);   // what is still owed, not the whole bill
    total += f;
    const created = new Date(b.created_at); created.setHours(0,0,0,0);
    const days = Math.floor((today - created) / 86400000);
    if (days <= 7) aging['0-7'] += f; else if (days <= 30) aging['8-30'] += f; else aging['31+'] += f;
    const ageCls = days > 30 ? 'color:var(--red)' : days > 7 ? 'color:var(--gold)' : '';
    // Session 302 -- IPD bills are collected in ipd.html's own Account drawer now
    // (deposits/split payments/refunds/receipts via the patient_payments ledger),
    // not here -- this just links straight to that admission's drawer. Shown for
    // any IPD bill still outstanding, not only self-pay: the ledger also records
    // an insurance bill's patient-share payments (release still waits on Session
    // B's insurance workflow, but collecting the share today is already useful).
    const actionCell = billCategory(b.bill_type) === 'ipd' && b.ipd_admission_id
      ? `<a class="btn btn-outline btn-sm" style="height:26px;padding:0 10px;font-size:11px;display:inline-flex;align-items:center;text-decoration:none" href="ipd.html?account=${b.ipd_admission_id}">Open in IPD →</a>`
      // Session 324 -- a pending OPD / lab bill is settled here with a receipt (§96)
      : (_canCollectOpd && isCollectableOpdBill(b) ? opdCollectControlsHtml(b.id) : '—');
    return `<tr>
      <td style="font-size:12px">${_fmtD(b.created_at?.slice(0,10))}</td>
      <td>${_esc(b.patients?.name || '—')}</td>
      <td>${BILL_CATEGORY_LABEL[billCategory(b.bill_type)]}</td>
      <td style="font-weight:500">₹${_n(f)}${f < (Number(b.final_amount) || 0) ? ` <span style="font-size:11px;color:var(--text-muted)">of ₹${_n(b.final_amount)}</span>` : ''}</td>
      <td><span class="badge b-${b.status}">${b.status}</span></td>
      <td style="${ageCls};font-weight:500">${days} days</td>
      <td style="font-size:12px">${b.payment_mode || '—'}</td>
      <td>${actionCell}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No outstanding bills</td></tr>';

  document.getElementById('out-total').textContent = '₹' + _n(total);

  document.getElementById('aging-cards').innerHTML = [
    { label:'0–7 days', val:aging['0-7'], cls:'' },
    { label:'8–30 days', val:aging['8-30'], cls:'gold' },
    { label:'31+ days', val:aging['31+'], cls:'red' },
  ].map(a => `<div class="kpi ${a.cls}">
    <div class="kpi-label">Aging: ${a.label}</div>
    <div class="kpi-val">₹${_n(a.val)}</div>
    <div class="aging-bar"><div class="aging-fill ${a.cls}" style="width:${total?Math.round(a.val/total*100):0}%"></div></div>
  </div>`).join('');
}

// ── Expenses ─────────────────────────────────────────
async function loadExpenses(from, to) {
  const { data, error } = await supabase
    .from('expense_records')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('expense_date', from)
    .lte('expense_date', to)
    .order('expense_date', { ascending: false });

  if (error && error.code === '42P01') {
    document.getElementById('exp-tbody').innerHTML =
      '<tr><td colspan="6" class="empty">Expense table not set up yet — run the SQL from the session notes to activate.</td></tr>';
    return;
  }
  if (error) { _toast(safeErrorMessage(error, 'Could not load expenses.'), 'error'); return; }
  _expenses = data || [];
  renderExpenses(from, to);
  updateKPIs();
}

function renderExpenses(from, to) {
  const tbody = document.getElementById('exp-tbody');
  document.getElementById('exp-period-lbl').textContent = `${_fmtD(from)} to ${_fmtD(to)}`;
  let total = 0;
  tbody.innerHTML = _expenses.map(e => {
    total += parseFloat(e.amount) || 0;
    return `<tr>
      <td style="font-size:12px">${_fmtD(e.expense_date)}</td>
      <td><span class="badge b-pending" style="font-size:10px">${e.category}</span></td>
      <td>${e.description || '—'}</td>
      <td style="font-size:12px">${e.vendor || '—'}</td>
      <td style="font-weight:500">₹${_n(e.amount)}</td>
      <td style="font-size:12px">${e.approved_by_name || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No expenses in this period</td></tr>';
  document.getElementById('exp-total').textContent = '₹' + _n(total);
}

// ── GST Summary ───────────────────────────────────────
function renderGST() {
  const k = _revenueBuckets(_bills);
  const rows = [
    { type:'OPD Consultation',     taxable: k.con, rate:0, cnt: k.opdCnt },
    { type:'OPD Registration',     taxable: k.reg, rate:0, cnt: k.opdCnt },
    // Session 344a: pharmacy sales of the period less the returns completed in the period (by return date)
    { type:'Pharmacy / Medicines (less returns)', taxable: Math.max(0, k.phm - summarisePeriod(_bills, _activity).cat.pharmacy.returns), rate:5, cnt: k.phmCnt },
    { type:'Lab / Investigations', taxable: k.lab, rate:0, cnt: k.labCnt },
    { type:'IPD / Package / Other', taxable: k.oth, rate:0, cnt: k.othCnt },
  ];
  let tBills=0, tTaxable=0, tCGST=0, tSGST=0, tGST=0, tInvoice=0;
  const tbody = document.getElementById('gst-tbody');
  tbody.innerHTML = rows.map(r => {
    const gst = r.taxable * r.rate / 100;
    const cgst = gst / 2, sgst = gst / 2;
    const invoice = r.taxable + gst;
    const cnt = r.cnt;
    tTaxable += r.taxable; tCGST += cgst; tSGST += sgst; tGST += gst; tInvoice += invoice;
    return `<tr>
      <td>${r.type}</td>
      <td>—</td>
      <td>₹${_n(r.taxable)}</td>
      <td>${r.rate}%${r.rate===0?' (Exempt)':''}</td>
      <td>₹${_n(cgst)}</td>
      <td>₹${_n(sgst)}</td>
      <td>₹${_n(gst)}</td>
      <td>₹${_n(invoice)}</td>
    </tr>`;
  }).join('');
  document.getElementById('gst-t-taxable').textContent = '₹' + _n(tTaxable);
  document.getElementById('gst-t-cgst').textContent    = '₹' + _n(tCGST);
  document.getElementById('gst-t-sgst').textContent    = '₹' + _n(tSGST);
  document.getElementById('gst-t-gst').textContent     = '₹' + _n(tGST);
  document.getElementById('gst-t-invoice').textContent = '₹' + _n(tInvoice);
}

// ── Daily Cash ───────────────────────────────────────
// Session 344a: per IST day -- sales at their original amount, returns / cancellations completed that day, net,
// and the money actually received that day (receipts - refunds, the shift handover's rule) by mode.
function renderDaily(from, to) {
  _setText('daily-period-lbl', `${_fmtD(from)} to ${_fmtD(to)}`);
  const days = new Set();
  _bills.forEach(b => days.add(istDate(b.created_at)));
  (_activity.returns || []).forEach(r => days.add(r.date));
  (_activity.receipts || []).forEach(p => days.add(p.date));
  const list = [...days].filter(Boolean).sort().reverse();
  const tot = { bills: 0, gross: 0, returns: 0, net: 0, cash: 0, upi: 0, collected: 0, pending: 0 };
  const rows = list.map(d => {
    const s = summarisePeriod(_bills, _activity, d);
    const pending = _bills.filter(b => istDate(b.created_at) === d).reduce((x, b) => x + dueAmount(b), 0);
    const r = { bills: s.bills, gross: s.gross, returns: s.returns, net: s.net, cash: s.byMode.cash, upi: s.byMode.upi_card, collected: s.collected, pending };
    Object.keys(tot).forEach(k => { tot[k] += r[k]; });
    const tr = _el('tr');
    tr.append(_el('td', _fmtD(d), 'font-size:12px;font-weight:500'), _el('td', r.bills), _el('td', '₹' + _n(r.gross)),
      _el('td', r.returns ? '− ₹' + _n(r.returns) : '₹0.00', r.returns ? 'color:var(--red)' : null), _el('td', '₹' + _n(r.net), 'font-weight:500'),
      _el('td', '₹' + _n(r.cash)), _el('td', '₹' + _n(r.upi)), _el('td', '₹' + _n(r.collected), 'font-weight:600;color:var(--green-deep)'),
      _el('td', '₹' + _n(r.pending), 'color:var(--red)'));
    return tr;
  });
  const tbody = document.getElementById('daily-tbody');
  if (rows.length) tbody.replaceChildren(...rows);
  else { const tr = _el('tr'); const td = _el('td', 'No data', null, 'empty'); td.colSpan = 9; tr.append(td); tbody.replaceChildren(tr); }
  _setText('d-t-bills', tot.bills);
  _setText('d-t-sales', '₹' + _n(tot.gross));
  _setText('d-t-returns', tot.returns ? '− ₹' + _n(tot.returns) : '₹0.00');
  _setText('d-t-net', '₹' + _n(tot.net));
  _setText('d-t-cash', '₹' + _n(tot.cash));
  _setText('d-t-upi', '₹' + _n(tot.upi));
  _setText('d-t-collected', '₹' + _n(tot.collected));
  _setText('d-t-pending', '₹' + _n(tot.pending));
}

// ── KPI update ────────────────────────────────────────
// Session 344a: Revenue = net sales (gross - returns completed in the period); Collected = receipts - refunds of the period
function updateKPIs() {
  const s = summarisePeriod(_bills, _activity);
  const outstanding = _outstanding.reduce((x,b)=>x+dueAmount(b),0);
  const expenses = _expenses.reduce((x,e)=>x+(parseFloat(e.amount)||0),0);

  _setText('k-revenue', '₹' + _n(s.net));
  _setText('k-revenue-sub', `Gross ₹${_n(s.gross)} − Returns ₹${_n(s.returns)}`);
  _setText('k-collected', '₹' + _n(s.collected));
  _setText('k-collected-sub', `Receipts ₹${_n(s.receiptsIn + s.legacy)} − Refunds ₹${_n(s.refundsOut)}`
    + (s.net > 0 ? ` · ${Math.round(s.collected / s.net * 100)}% of net` : ''));
  _setText('k-outstanding', '₹' + _n(outstanding));
  _setText('k-outstanding-sub', _outstanding.length + ' bills pending');
  _setText('k-expenses', '₹' + _n(expenses));
  _setText('k-expenses-sub', _expenses.length + ' entries');
  _setText('k-bills', _bills.length);
  _setText('k-bills-sub', `in selected period · ${s.returnsCount} returns / cancellations`);
}

// ── Expense modal ─────────────────────────────────────
window.openExpenseModal = function() {
  document.getElementById('ex-date').value = todayLocalStr();
  document.getElementById('ex-amount').value = '';
  document.getElementById('ex-category').value = '';
  document.getElementById('ex-vendor').value = '';
  document.getElementById('ex-desc').value = '';
  document.getElementById('ex-notes').value = '';
  document.getElementById('expense-modal').classList.add('show');
};

window.closeExpenseModal = function() {
  document.getElementById('expense-modal').classList.remove('show');
};

window.saveExpense = async function() {
  const date   = document.getElementById('ex-date').value;
  const amount = parseFloat(document.getElementById('ex-amount').value);
  const cat    = document.getElementById('ex-category').value;
  const desc   = document.getElementById('ex-desc').value.trim();
  if (!date || !amount || !cat || !desc) { _toast('Date, amount, category and description are required', 'error'); return; }

  const { error } = await supabase.from('expense_records').insert({
    tenant_id: tenantId,
    expense_date: date,
    amount,
    category: cat,
    description: desc,
    vendor: document.getElementById('ex-vendor').value.trim() || null,
    notes:  document.getElementById('ex-notes').value.trim() || null,
    recorded_by: sess.id,
    approved_by_name: sess.full_name,
  });
  if (error) { _toast(safeErrorMessage(error, 'Could not save expense.'), 'error'); return; }
  closeExpenseModal();
  _toast('Expense saved', 'success');
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;
  if (from && to) loadExpenses(from, to);
};

// ── CSV exports ───────────────────────────────────────
// Session 344a: sales rows (each bill at its original amount, on its own date) + one row per return / cancellation
// completed in the period (negative, on the return date) + Gross / Returns / Net totals
window.exportCSV = window.exportRevCSV = function() {
  const s = summarisePeriod(_bills, _activity);
  const rows = _bills.map(b => ({
    Row: isSale(b) ? 'Sale' : 'Not a sale (GST ' + (b.document_status || '') + ')', Date: istDate(b.created_at), Document: b.document_number || '',
    'Of bill': '', Patient: b.patients?.name || '', Type: b.bill_type, Total: b.total_amount, Amount: b.final_amount,
    Payment: b.payment_mode, Status: b.status,
  })).concat((_activity.returns || []).map(r => ({
    Row: r.kind === 'cancel' ? 'Cancellation' : 'Return', Date: r.date, Document: r.return_no, 'Of bill': `${r.document_number || ''} (${r.bill_date})`,
    Patient: '', Type: r.bill_type, Total: '', Amount: -Number(r.amount || 0),
    Payment: r.settlement === 'due' ? 'due reduced' : r.settlement === 'void' ? 'receipt voided' : 'refund ' + (r.refund_mode || ''), Status: r.kind,
  })));
  rows.push({ Row: 'TOTAL Gross sales', Amount: s.gross }, { Row: 'TOTAL Returns / cancellations', Amount: -s.returns },
            { Row: 'TOTAL Net', Amount: s.net }, { Row: 'TOTAL Collected (receipts - refunds)', Amount: s.collected });
  _csvDownload(rows, 'revenue');
};

window.exportOutstandingCSV = function() { _csvDownload(_outstanding.map(b => ({
  Date: b.created_at?.slice(0,10), Patient: b.patients?.name,
  Type: b.bill_type, Amount: b.final_amount, Due: dueAmount(b), Status: b.status,
})), 'outstanding'); };

window.exportExpCSV = function() { _csvDownload(_expenses.map(e => ({
  Date: e.expense_date, Category: e.category, Description: e.description,
  Vendor: e.vendor, Amount: e.amount,
})), 'expenses'); };

window.exportGSTCSV = window.exportDailyCSV = function() { _toast('Use the browser Print to save this view', 'success'); };

function _csvDownload(rows, name) {
  if (!rows.length) { _toast('No data to export', 'info'); return; }
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','), ...rows.map(r => keys.map(k => `"${String(r[k]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `${name}_${todayLocalStr()}.csv`; a.click();
}

// ── Helpers ───────────────────────────────────────────
function _fmt(d) { return d instanceof Date ? localDateStr(d) : d; }
function _fmtD(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _n(v) { return (parseFloat(v)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg, type='success') { notify(msg, type); }   // Session 323: shared top-layer notify()

// ── Insurance Cycles ──────────────────────────────────
const INSURANCE_PROVIDERS = [
  'Star Health & Allied Insurance','New India Assurance','United India Insurance',
  'National Insurance','HDFC ERGO Health','ICICI Lombard','Bajaj Allianz Health',
  'Care Health','Niva Bupa','Aditya Birla Health','Tata AIG','SBI Health Insurance',
  'Digit Insurance','Kotak Mahindra Health','Future Generali',
];
const TPA_LIST = [
  'Medi Assist India','MD India Healthcare','Vipul Medcorp','Family Health Plan (FHPL)',
  'Paramount Health Services','Heritage Health','Dedicated Healthcare Services',
  'East West Assist','Ericson TPA','Genins India','Anmol Medicare',
];

const _fmtAmt = n => {
  if (!n) return '₹0';
  if (n >= 100000) return '₹' + (n/100000).toFixed(1) + 'L';
  if (n >= 1000)   return '₹' + (n/1000).toFixed(1) + 'K';
  return '₹' + Math.round(n);
};
const _daysSince = iso => {
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d === 0 ? 'Today' : d + 'd ago';
};
const _daysStyle = iso => {
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d > 30 ? 'color:var(--red);font-weight:600' : d > 7 ? 'color:var(--gold)' : '';
};
const _csBadge = s => ({
  pre_auth_pending:  `<span class="cs-badge cs-pending">Pre-Auth ⏳</span>`,
  pre_auth_approved: `<span class="cs-badge cs-approved">Auth ✅</span>`,
  submitted:         `<span class="cs-badge cs-submitted">Submitted</span>`,
  settled:           `<span class="cs-badge cs-settled">Settled ✅</span>`,
  partial_settled:   `<span class="cs-badge cs-partial">Partial</span>`,
  rejected:          `<span class="cs-badge cs-rejected">Rejected ✗</span>`,
})[s] || '—';
const _payerChip = b => {
  if (b.payer_type === 'pmjay') return `<span class="payer-chip pmjay">PMJAY</span>`;
  if (['cghs','echs','esi'].includes(b.payer_type)) return `<span class="payer-chip gov">${b.payer_type.toUpperCase()}</span>`;
  return `<span class="payer-chip ins">${b.tpa_name||b.insurance_provider||'Insurance'}</span>`;
};

async function loadInsuranceClaims() {
  if (_insLoaded) { renderInsClaims(); return; }
  const { data } = await supabase.from('bills')
    .select('id,visit_id,final_amount,patient_due,created_at,bill_type,payer_type,tpa_name,insurance_provider,policy_number,pre_auth_number,pre_auth_status,pre_auth_amount,insurance_approved_amount,insurance_settled_amount,insurance_claim_status,patients(name),visits(id,chief_complaint,created_at)')
    .eq('tenant_id', tenantId).neq('payer_type','self_pay')
    .order('created_at',{ascending:false}).limit(200);
  _insClaims = data || [];
  _insLoaded = true;
  renderInsClaims();
  renderPreAuth();
}

window.filterInsClaims = function(status, el) {
  _insFilter = status;
  document.querySelectorAll('.ins-filter').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderInsClaims();
};

function renderInsClaims() {
  const rows = _insFilter === 'all' ? _insClaims : _insClaims.filter(b => b.insurance_claim_status === _insFilter);
  const wrap = document.getElementById('ins-claims-wrap');
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty">No insurance claims${_insFilter !== 'all' ? ' with this status' : ''}</div>`;
    return;
  }
  wrap.innerHTML = `<table>
    <thead><tr><th>Patient</th><th>Type</th><th>Payer</th><th style="text-align:right">Bill</th><th style="text-align:right">Approved</th><th style="text-align:right">Patient Due</th><th>Days</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${rows.map(b=>`<tr>
      <td><strong>${b.patients?.name||'—'}</strong>${b.visits?.chief_complaint?`<div style="font-size:11px;color:var(--text-muted)">Visit: ${b.visits.chief_complaint.slice(0,40)}</div>`:''} ${b.policy_number?`<div style="font-size:11px;color:var(--text-muted)">Policy: ${b.policy_number}</div>`:''}</td>
      <td><span class="badge b-pending" style="font-size:10px">${b.bill_type||'OPD'}</span></td>
      <td>${_payerChip(b)}</td>
      <td style="text-align:right">${_fmtAmt(b.final_amount)}</td>
      <td style="text-align:right">${b.insurance_approved_amount?_fmtAmt(b.insurance_approved_amount):'—'}</td>
      <td style="text-align:right;font-weight:600;color:var(--red)">${_fmtAmt(b.patient_due??b.final_amount)}</td>
      <td style="${_daysStyle(b.created_at)}">${_daysSince(b.created_at)}</td>
      <td>${_csBadge(b.insurance_claim_status)}</td>
      <td><button class="btn btn-outline btn-sm" data-onclick="openInsModal" data-onclick-a0="${_esc(b.id)}">✏️ Edit</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderPreAuth() {
  const rows = _insClaims.filter(b => ['pre_auth_pending','pre_auth_approved'].includes(b.insurance_claim_status));
  const wrap = document.getElementById('ins-preauth-wrap');
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty">No bills awaiting pre-auth approval</div>`;
    return;
  }
  wrap.innerHTML = `<table>
    <thead><tr><th>Patient</th><th>Payer</th><th style="text-align:right">Bill</th><th style="text-align:right">Pre-Auth Amount</th><th>Pre-Auth Ref</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${rows.map(b=>`<tr>
      <td><strong>${b.patients?.name||'—'}</strong></td>
      <td>${_payerChip(b)}</td>
      <td style="text-align:right">${_fmtAmt(b.final_amount)}</td>
      <td style="text-align:right">${b.pre_auth_amount?_fmtAmt(b.pre_auth_amount):'—'}</td>
      <td style="font-size:12px">${b.pre_auth_number||'—'}</td>
      <td>${_csBadge(b.insurance_claim_status)}</td>
      <td><button class="btn btn-outline btn-sm" data-onclick="openInsModal" data-onclick-a0="${_esc(b.id)}">✏️ Update</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

window.openInsModal = async function(billId) {
  _insBillId = billId;
  const pSel = document.getElementById('ins-provider');
  const tSel = document.getElementById('ins-tpa');
  pSel.innerHTML = '<option value="">— Select Provider —</option>' + INSURANCE_PROVIDERS.map(p=>`<option value="${p}">${p}</option>`).join('');
  tSel.innerHTML = '<option value="">— Select TPA —</option>' + TPA_LIST.map(t=>`<option value="${t}">${t}</option>`).join('');
  const {data:b} = await supabase.from('bills')
    .select('id,final_amount,patient_due,payer_type,insurance_provider,tpa_name,policy_number,pre_auth_number,pre_auth_status,pre_auth_amount,insurance_approved_amount,insurance_settled_amount,insurance_settlement_date,insurance_claim_status,pmjay_package_code,pmjay_mo_approved,is_cashless,bill_type,patients(name)')
    .eq('id',billId).single();
  if (!b) return;
  document.getElementById('ins-bill-info').innerHTML =
    `Patient: <strong>${b.patients?.name||'—'}</strong> &nbsp;|&nbsp; ${b.bill_type||'OPD'} &nbsp;|&nbsp; Bill: <strong>${_fmtAmt(b.final_amount)}</strong> &nbsp;|&nbsp; Patient Due: <strong style="color:var(--red)">${_fmtAmt(b.patient_due??b.final_amount)}</strong>`;
  document.getElementById('ins-payer-type').value    = b.payer_type||'insurance';
  pSel.value = b.insurance_provider||'';
  tSel.value = b.tpa_name||'';
  document.getElementById('ins-policy').value         = b.policy_number||'';
  document.getElementById('ins-preauth-num').value    = b.pre_auth_number||'';
  document.getElementById('ins-preauth-amt').value    = b.pre_auth_amount||'';
  document.getElementById('ins-preauth-status').value = b.pre_auth_status||'not_required';
  document.getElementById('ins-approved-amt').value   = b.insurance_approved_amount||'';
  document.getElementById('ins-claim-status').value   = b.insurance_claim_status||'pre_auth_pending';
  document.getElementById('ins-settled-amt').value    = b.insurance_settled_amount||'';
  document.getElementById('ins-settled-date').value   = b.insurance_settlement_date||'';
  document.getElementById('ins-pmjay-code').value     = b.pmjay_package_code||'';
  document.getElementById('ins-pmjay-mo').checked     = b.pmjay_mo_approved||false;
  document.getElementById('ins-cashless').checked     = b.is_cashless!==false;
  onInsPayerChange();
  document.getElementById('ins-modal-bg').classList.add('show');
};

window.onInsPayerChange = function() {
  const pt = document.getElementById('ins-payer-type').value;
  document.getElementById('ins-fields-wrap').style.display = 'block';
  document.getElementById('ins-pmjay-wrap').style.display = pt==='pmjay'?'block':'none';
};

window.closeInsModal = function() {
  document.getElementById('ins-modal-bg').classList.remove('show');
};

window.saveInsuranceDetails = async function() {
  if (!_insBillId) return;
  const pt = document.getElementById('ins-payer-type').value;
  const payload = {
    payer_type: pt,
    insurance_claim_status: document.getElementById('ins-claim-status').value,
    insurance_provider:     document.getElementById('ins-provider').value||null,
    tpa_name:               document.getElementById('ins-tpa').value||null,
    policy_number:          document.getElementById('ins-policy').value.trim()||null,
    pre_auth_number:        document.getElementById('ins-preauth-num').value.trim()||null,
    pre_auth_status:        document.getElementById('ins-preauth-status').value,
    pre_auth_amount:        parseFloat(document.getElementById('ins-preauth-amt').value)||0,
    insurance_approved_amount: parseFloat(document.getElementById('ins-approved-amt').value)||0,
    insurance_settled_amount:  parseFloat(document.getElementById('ins-settled-amt').value)||0,
    insurance_settlement_date: document.getElementById('ins-settled-date').value||null,
    pmjay_package_code:     document.getElementById('ins-pmjay-code').value.trim()||null,
    pmjay_mo_approved:      document.getElementById('ins-pmjay-mo').checked,
    is_cashless:            document.getElementById('ins-cashless').checked,
  };
  const btn = document.getElementById('ins-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const {error} = await supabase.from('bills').update(payload).eq('id',_insBillId).eq('tenant_id',tenantId);
  btn.disabled = false; btn.textContent = 'Save Details';
  if (error) { _toast(safeErrorMessage(error, 'Could not save insurance details.'),'error'); return; }
  _toast('Insurance details saved','success');
  closeInsModal();
  _insLoaded = false;
  loadInsuranceClaims();
};

// ── Init ──────────────────────────────────────────────
applyPreset();
await loadAll();
