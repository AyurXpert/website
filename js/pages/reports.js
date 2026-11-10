// reports.html -- moved out of the page in Session 384 (TODO §492) so the page can carry a strict Content-Security-Policy (no inline script).
import { requireAuth, getCurrentProfile, getCurrentTenant, getCurrentTenantId, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { localDateStr } from '../utils/dateUtils.js';
import { summarisePeriod, dueAmount } from '../modules/billing/billCategory.js';
import { escapeHtml } from '../utils/validators.js';   // Session 384 (§492): every database text in innerHTML is escaped

await requireAuth(['lab_tech', 'accountant', 'cashier', 'finance_manager', 'dept_admin', 'super_admin'], 'login.html', { monitoringSafe: true });
initNavbar();

const role     = getCurrentRole();
const tenantId = getCurrentTenantId();

// ── Set up tabs based on role ──────────────────────
const tabBar    = document.getElementById('tab-bar');
const isAcct    = ['accountant','cashier','finance_manager','dept_admin','super_admin'].includes(role);
const isLabTech = role === 'lab_tech';

document.getElementById('page-subtitle').textContent =
  isLabTech ? 'Lab investigation orders and results' : 'Billing and revenue reports';

if (isAcct && isLabTech) {
  // super_admin can see both (edge case)
  tabBar.style.display = 'flex';
  tabBar.innerHTML = `
    <button class="tab-btn active" data-panel="billing">Billing</button>
    <button class="tab-btn" data-panel="lab">Lab</button>
  `;
} else if (isAcct) {
  document.getElementById('panel-billing').classList.add('active');
} else {
  document.getElementById('panel-lab').classList.add('active');
}

// For super_admin, show both tabs
if (role === 'super_admin') {
  tabBar.style.display = 'flex';
  tabBar.innerHTML = `
    <button class="tab-btn active" data-panel="billing">Billing</button>
    <button class="tab-btn" data-panel="lab">Lab</button>
  `;
  document.getElementById('panel-billing').classList.add('active');
}

tabBar.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
});

// ── Date defaults (last 30 days) ────────────────────
const today = new Date();
const from30 = new Date(today); from30.setDate(today.getDate() - 29);
const toISO   = localDateStr(today);
const fromISO = localDateStr(from30);
document.getElementById('date-from').value = fromISO;
document.getElementById('date-to').value   = toISO;

// ── Load billing data ───────────────────────────────
async function loadBilling() {
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;
  if (!from || !to) return;

  const toEnd = to + 'T23:59:59.999+05:30';   // Session 344a: IST day boundaries (as the returns / receipts of the period)

  const { data: bills, error } = await supabase
    .from('bills')
    .select('id, total_amount, final_amount, returned_amount, patient_due, amount_paid, status, bill_type, payer_type, document_status, payment_mode, payment_method, created_at, patient_id')
    .eq('tenant_id', tenantId)
    .gte('created_at', from + 'T00:00:00+05:30')
    .lte('created_at', toEnd)
    .order('created_at', { ascending: false });

  if (error) { console.error(error); return; }
  const rows = bills || [];

  // Summary
  const paid      = rows.filter(b => b.status === 'paid');
  const pending   = rows.filter(b => b.status === 'pending');
  const cancelled = rows.filter(b => b.status === 'cancelled');
  const partial   = rows.filter(b => b.status === 'partial');

  // Session 344a (owner decision 6 Oct 2026): sales = bills of the range at their ORIGINAL amount; returns /
  // cancellations count on the day they were completed; net = sales - returns; pending = what is still due now
  const { data: act, error: aErr } = await supabase.rpc('finance_activity', { p_from: from, p_to: to });
  if (aErr) console.error(aErr);
  const fin     = summarisePeriod(rows, act || { returns: [], receipts: [], legacy_collected: {} });
  const pendAmt = rows.filter(b => ['unpaid', 'pending', 'partial'].includes(b.status)).reduce((s, b) => s + dueAmount(b), 0);
  const fmt     = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  document.getElementById('s-revenue').textContent  = fmt(fin.net);
  document.getElementById('s-rev-sub').textContent  = `Gross ${fmt(fin.gross)} − Returns ${fmt(fin.returns)} · Collected ${fmt(fin.collected)}`;
  document.getElementById('s-bills').textContent    = fin.bills;
  document.getElementById('s-bills-sub').textContent = `${paid.length} paid · ${fin.returnsCount} returns / cancellations`;
  document.getElementById('s-pending').textContent  = fmt(pendAmt);
  document.getElementById('s-avg').textContent      = fin.bills ? fmt(Math.round(fin.gross / fin.bills)) : '₹0';

  document.getElementById('st-paid').textContent      = paid.length;
  document.getElementById('st-pending').textContent   = pending.length;
  document.getElementById('st-cancelled').textContent = cancelled.length;
  document.getElementById('st-partial').textContent   = partial.length;

  // Recent bills table
  const wrap = document.getElementById('bills-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">No bills in selected date range.</div>';
    return;
  }

  // Get patient names
  const patientIds = [...new Set(rows.map(b => b.patient_id).filter(Boolean))];
  const { data: patients } = patientIds.length
    ? await supabase.from('patients').select('id, name').in('id', patientIds)
    : { data: [] };
  const patMap = Object.fromEntries((patients || []).map(p => [p.id, p.name]));

  const statusTag = s => {
    if (s === 'paid')      return `<span class="tag tag-paid">Paid</span>`;
    if (s === 'cancelled') return `<span class="tag tag-cancelled">Cancelled</span>`;
    return `<span class="tag tag-pending">${escapeHtml(String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1))}</span>`;
  };

  const rows50 = rows.slice(0, 50);
  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Patient</th>
          <th>Type</th>
          <th>Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows50.map(b => `
          <tr>
            <td>${new Date(b.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</td>
            <td>${escapeHtml(patMap[b.patient_id] || '—')}</td>
            <td style="text-transform:capitalize">${escapeHtml((b.bill_type || 'opd').replace(/_/g,' '))}</td>
            <td>₹${Number(b.final_amount || b.total_amount || 0).toLocaleString('en-IN')}</td>
            <td>${statusTag(b.status)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${rows.length > 50 ? `<div class="empty" style="padding:10px">Showing 50 of ${rows.length} bills.</div>` : ''}
  `;
}

if (isAcct || role === 'super_admin') {
  loadBilling();
  document.getElementById('btn-apply').addEventListener('click', loadBilling);
}
