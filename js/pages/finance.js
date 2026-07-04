import { requireAuth, hasModule, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar }  from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

const ALLOWED = ['super_admin','dept_admin','accountant','cashier','finance_manager','receptionist'];
await requireAuth(ALLOWED);
if (!hasModule('finance')) { window.location.replace('admin.html'); }

const _profile = getCurrentProfile();
const _role    = _profile?.role;

const sess     = getCurrentProfile();
const tenantId = getCurrentTenantId();

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
};

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
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#c0392b;padding:16px">${error.code === '42P01' ? 'Run session32_ncism_gaps.sql to activate' : error.message}</td></tr>`;
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
  if (error) { alert(error.message); return; }
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
    .select('id, created_at, final_amount, total_amount, registration_fee, consultation_fee, bill_type, payment_mode, status, patients(name), insurer_name')
    .eq('tenant_id', tenantId)
    .gte('created_at', from + 'T00:00:00')
    .lte('created_at', to + 'T23:59:59')
    .order('created_at', { ascending: false });
  if (error) { _toast('Error: ' + error.message, 'error'); return; }
  _bills = data || [];
  renderRevenue(from, to);
  renderGST();
  renderDaily(from, to);
  updateKPIs();
}

function renderRevenue(from, to) {
  const tbody = document.getElementById('rev-tbody');
  document.getElementById('rev-period-lbl').textContent = `${_fmtD(from)} to ${_fmtD(to)} · ${_bills.length} bills`;

  let regTotal=0, conTotal=0, phmTotal=0, othTotal=0;
  let regCnt=0, conCnt=0, phmCnt=0, othCnt=0, grandFinal=0;

  tbody.innerHTML = _bills.map(b => {
    const f = parseFloat(b.final_amount)||0;
    grandFinal += (['paid','partial'].includes(b.status) ? f : 0);
    const bt = b.bill_type || 'opd';
    if (bt === 'opd') { regTotal += parseFloat(b.registration_fee)||0; conTotal += parseFloat(b.consultation_fee)||0; regCnt++; conCnt++; }
    else if (bt === 'pharmacy') { phmTotal += f; phmCnt++; }
    else { othTotal += f; othCnt++; }
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${_fmtD(b.created_at?.slice(0,10))}</td>
      <td>${b.patients?.name || '—'}</td>
      <td><span class="badge b-pending" style="font-size:10px">${bt}</span></td>
      <td>₹${_n(b.total_amount)}</td>
      <td>₹${_n((parseFloat(b.total_amount)||0)-(parseFloat(b.final_amount)||0))}</td>
      <td style="font-weight:500">₹${_n(b.final_amount)}</td>
      <td style="font-size:12px">${b.payment_mode || '—'}${b.insurer_name ? ' · ' + b.insurer_name : ''}</td>
      <td><span class="badge b-${b.status}">${b.status}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No bills in this period</td></tr>';

  document.getElementById('rev-total-final').textContent = '₹' + _n(grandFinal);
  document.getElementById('r-reg').textContent = '₹' + _n(regTotal);
  document.getElementById('r-con').textContent = '₹' + _n(conTotal);
  document.getElementById('r-phm').textContent = '₹' + _n(phmTotal);
  document.getElementById('r-oth').textContent = '₹' + _n(othTotal);
  document.getElementById('r-reg-c').textContent = regCnt + ' OPD bills';
  document.getElementById('r-con-c').textContent = conCnt + ' consultations';
  document.getElementById('r-phm-c').textContent = phmCnt + ' pharmacy bills';
  document.getElementById('r-oth-c').textContent = othCnt + ' other bills';
}

// ── Outstanding ─────────────────────────────────────
async function loadOutstanding() {
  const { data, error } = await supabase
    .from('bills')
    .select('id, created_at, final_amount, bill_type, payment_mode, status, patients(name)')
    .eq('tenant_id', tenantId)
    .in('status', ['pending','partial'])
    .order('created_at', { ascending: true });
  if (error) { _toast('Error: ' + error.message, 'error'); return; }
  _outstanding = data || [];
  renderOutstanding();
  updateKPIs();
}

function renderOutstanding() {
  const tbody = document.getElementById('out-tbody');
  const today = new Date(); today.setHours(0,0,0,0);
  let total = 0;
  const aging = { '0-7':0, '8-30':0, '31+':0 };

  tbody.innerHTML = _outstanding.map(b => {
    const f = parseFloat(b.final_amount) || 0;
    total += f;
    const created = new Date(b.created_at); created.setHours(0,0,0,0);
    const days = Math.floor((today - created) / 86400000);
    if (days <= 7) aging['0-7'] += f; else if (days <= 30) aging['8-30'] += f; else aging['31+'] += f;
    const ageCls = days > 30 ? 'color:var(--red)' : days > 7 ? 'color:var(--gold)' : '';
    return `<tr>
      <td style="font-size:12px">${_fmtD(b.created_at?.slice(0,10))}</td>
      <td>${b.patients?.name || '—'}</td>
      <td>${b.bill_type || 'opd'}</td>
      <td style="font-weight:500">₹${_n(b.final_amount)}</td>
      <td><span class="badge b-${b.status}">${b.status}</span></td>
      <td style="${ageCls};font-weight:500">${days} days</td>
      <td style="font-size:12px">${b.payment_mode || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No outstanding bills</td></tr>';

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
  if (error) { _toast('Error: ' + error.message, 'error'); return; }
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
  const rows = [
    { type:'OPD Consultation', taxable: _bills.filter(b=>b.bill_type==='opd').reduce((s,b)=>s+(parseFloat(b.consultation_fee)||0),0), rate:0 },
    { type:'OPD Registration', taxable: _bills.filter(b=>b.bill_type==='opd').reduce((s,b)=>s+(parseFloat(b.registration_fee)||0),0), rate:0 },
    { type:'Pharmacy / Medicines', taxable: _bills.filter(b=>b.bill_type==='pharmacy').reduce((s,b)=>s+(parseFloat(b.final_amount)||0),0), rate:5 },
    { type:'IPD / Package', taxable: _bills.filter(b=>!['opd','pharmacy'].includes(b.bill_type||'opd')).reduce((s,b)=>s+(parseFloat(b.final_amount)||0),0), rate:0 },
  ];
  let tBills=0, tTaxable=0, tCGST=0, tSGST=0, tGST=0, tInvoice=0;
  const tbody = document.getElementById('gst-tbody');
  tbody.innerHTML = rows.map(r => {
    const gst = r.taxable * r.rate / 100;
    const cgst = gst / 2, sgst = gst / 2;
    const invoice = r.taxable + gst;
    const cnt = _bills.filter(b => r.type.startsWith('OPD') ? b.bill_type==='opd' : r.type.startsWith('Pharmacy') ? b.bill_type==='pharmacy' : true).length;
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
function renderDaily(from, to) {
  document.getElementById('daily-period-lbl').textContent = `${_fmtD(from)} to ${_fmtD(to)}`;
  const byDay = {};
  _bills.forEach(b => {
    const d = b.created_at?.slice(0,10);
    if (!byDay[d]) byDay[d] = { bills:0, cash:0, upi:0, credit:0, ins:0, collected:0, pending:0 };
    const f = parseFloat(b.final_amount) || 0;
    byDay[d].bills++;
    if (b.status === 'paid' || b.status === 'partial') {
      if (b.payment_mode === 'cash') byDay[d].cash += f;
      else if (b.payment_mode === 'Insurance / TPA') byDay[d].ins += f;
      else if (b.payment_mode === 'credit') byDay[d].credit += f;
      else byDay[d].upi += f;
      byDay[d].collected += f;
    } else { byDay[d].pending += f; }
  });
  const days = Object.keys(byDay).sort().reverse();
  let tBills=0,tCash=0,tUpi=0,tCred=0,tIns=0,tCol=0,tPend=0;
  const tbody = document.getElementById('daily-tbody');
  tbody.innerHTML = days.map(d => {
    const r = byDay[d];
    tBills+=r.bills;tCash+=r.cash;tUpi+=r.upi;tCred+=r.credit;tIns+=r.ins;tCol+=r.collected;tPend+=r.pending;
    return `<tr>
      <td style="font-size:12px;font-weight:500">${_fmtD(d)}</td>
      <td>${r.bills}</td>
      <td>₹${_n(r.cash)}</td>
      <td>₹${_n(r.upi)}</td>
      <td>₹${_n(r.credit)}</td>
      <td>₹${_n(r.ins)}</td>
      <td style="font-weight:600;color:var(--green-deep)">₹${_n(r.collected)}</td>
      <td style="color:var(--red)">₹${_n(r.pending)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No data</td></tr>';
  ['d-t-bills','d-t-cash','d-t-upi','d-t-credit','d-t-ins','d-t-collected','d-t-pending'].forEach((id,i) => {
    document.getElementById(id).textContent = i===0 ? tBills : '₹'+_n([0,tCash,tUpi,tCred,tIns,tCol,tPend][i]);
  });
}

// ── KPI update ────────────────────────────────────────
function updateKPIs() {
  const total    = _bills.reduce((s,b) => s + (parseFloat(b.final_amount)||0), 0);
  const collected= _bills.filter(b=>['paid','partial'].includes(b.status)).reduce((s,b)=>s+(parseFloat(b.final_amount)||0),0);
  const outstanding = _outstanding.reduce((s,b)=>s+(parseFloat(b.final_amount)||0),0);
  const expenses = _expenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);

  document.getElementById('k-revenue').textContent = '₹' + _n(total);
  document.getElementById('k-revenue-sub').textContent = _bills.length + ' bills';
  document.getElementById('k-collected').textContent = '₹' + _n(collected);
  document.getElementById('k-collected-sub').textContent = total ? Math.round(collected/total*100) + '% collection rate' : '';
  document.getElementById('k-outstanding').textContent = '₹' + _n(outstanding);
  document.getElementById('k-outstanding-sub').textContent = _outstanding.length + ' bills pending';
  document.getElementById('k-expenses').textContent = '₹' + _n(expenses);
  document.getElementById('k-expenses-sub').textContent = _expenses.length + ' entries';
  document.getElementById('k-bills').textContent = _bills.length;
  document.getElementById('k-bills-sub').textContent = 'in selected period';
}

// ── Expense modal ─────────────────────────────────────
window.openExpenseModal = function() {
  document.getElementById('ex-date').value = new Date().toISOString().slice(0,10);
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
  if (error) { _toast('Error: ' + error.message, 'error'); return; }
  closeExpenseModal();
  _toast('Expense saved', 'success');
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;
  if (from && to) loadExpenses(from, to);
};

// ── CSV exports ───────────────────────────────────────
window.exportCSV = window.exportRevCSV = function() { _csvDownload(_bills.map(b => ({
  Date: b.created_at?.slice(0,10), Patient: b.patients?.name,
  Type: b.bill_type, Total: b.total_amount, Final: b.final_amount,
  Payment: b.payment_mode, Status: b.status,
})), 'revenue'); };

window.exportOutstandingCSV = function() { _csvDownload(_outstanding.map(b => ({
  Date: b.created_at?.slice(0,10), Patient: b.patients?.name,
  Type: b.bill_type, Amount: b.final_amount, Status: b.status,
})), 'outstanding'); };

window.exportExpCSV = function() { _csvDownload(_expenses.map(e => ({
  Date: e.expense_date, Category: e.category, Description: e.description,
  Vendor: e.vendor, Amount: e.amount,
})), 'expenses'); };

window.exportGSTCSV = window.exportDailyCSV = function() { _toast('Use the browser Print to save this view', 'success'); };

function _csvDownload(rows, name) {
  if (!rows.length) { _toast('No data to export', 'error'); return; }
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','), ...rows.map(r => keys.map(k => `"${String(r[k]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `${name}_${new Date().toISOString().slice(0,10)}.csv`; a.click();
}

// ── Helpers ───────────────────────────────────────────
function _fmt(d) { return d instanceof Date ? d.toISOString().slice(0,10) : d; }
function _fmtD(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _n(v) { return (parseFloat(v)||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

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
  if (error) { _toast('Error: '+error.message,'error'); return; }
  _toast('Insurance details saved','success');
  closeInsModal();
  _insLoaded = false;
  loadInsuranceClaims();
};

// ── Init ──────────────────────────────────────────────
applyPreset();
await loadAll();
