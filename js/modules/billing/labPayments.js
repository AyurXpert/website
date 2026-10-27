// labPayments.js -- Session 359 (TODO §295, owner Q4 / Q5 / Q6, 25 Oct 2026): the lab "Urgent -- proceed before payment" and the real fee
// waiver, both with a reason, both logged by the server (lab_payment_events: who, when, reason, order, amount).
//   Urgent   mark_lab_order_urgent(order, reason, fee ids) -- reception / cashier / Super Admin; the order stays OWED ("Urgent -- unpaid",
//            stored as 'waived') until collected.
//   Waiver   waive_lab_order(order, reason, fee ids) -- the finance manager (role) / the Medical Superintendent / the Super Admin; the
//            charge is forgiven in full (stored as 'fee_waived').
//   Lists    list_lab_outstanding() (reception, cashier, accountant, finance manager, Super Admin; the MS views) and list_lab_waivers().
// In-page panels only (no confirm() / prompt() in a money flow); built from DOM nodes + textContent. Who sees which button:
// js/utils/staffPowers.js (the server decides).
import { safeErrorMessage } from '../../utils/errors.js';
import { computeLabBillingLines, labItemsToSelection } from './labBilling.js';
import { canWaiveLabBill } from '../../utils/staffPowers.js';

const _rs = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const _date = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(text, css) {
  const b = el('button', 'min-height:44px;padding:0 14px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;' + (css || ''), text);
  b.type = 'button';
  return b;
}

export const LAB_PAYMENT_LABEL = { pending: 'Payment due', waived: 'Urgent — unpaid', fee_waived: 'Fee waived', paid: 'Paid', ipd_credit: 'IPD account' };

// the reason panel: mode 'urgent' | 'waive'. order = { id, patient_name, tests, amount }; feeIds = the priced lines' fee ids
export function buildLabReasonPanel({ supabase, mode, order, feeIds, onDone, onClose }) {
  const urgent = mode === 'urgent';
  const panel = el('div', 'margin:8px 0;padding:12px 14px;border:1.5px solid ' + (urgent ? '#a01a1a' : 'var(--green-mid)') + ';border-radius:8px;background:' + (urgent ? '#fff6f4' : '#f7fbf8'));
  panel.setAttribute('role', 'group');
  panel.append(el('div', 'font-size:13px;font-weight:700;color:' + (urgent ? '#7a1a1a' : 'var(--green-deep)') + ';margin-bottom:6px',
    urgent ? `🚨 Urgent — send to the lab before payment — ${order.patient_name || 'patient'}` : `Waive the lab charge — ${order.patient_name || 'patient'}`));
  panel.append(el('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:8px', urgent
    ? `${order.tests || ''} — the lab may start now; the charge${order.amount ? ' (' + _rs(order.amount) + ')' : ''} stays OWED and is collected later. Your name, the time and the reason are recorded.`
    : `${order.tests || ''} — the full charge${order.amount ? ' (' + _rs(order.amount) + ')' : ''} is forgiven and will not be collected. Your name, the time and the reason are recorded in the waiver report.`));
  const id = `lp-reason-${mode}-${order.id}`;
  const lab = el('label', 'display:block;font-size:12px;font-weight:600;color:var(--text-mid);margin-bottom:4px', 'Reason (required, 5–500 characters)');
  lab.htmlFor = id;
  const ta = el('textarea', 'width:100%;min-height:60px;padding:8px;border:1.5px solid var(--border);border-radius:7px;font:inherit;font-size:13px;box-sizing:border-box');
  ta.id = id; ta.maxLength = 500;
  const msg = el('div', 'font-size:12.5px;font-weight:600;margin:6px 0', '');
  msg.setAttribute('role', 'status');
  const ok = btn(urgent ? 'Send to the lab as urgent' : 'Waive the charge', urgent ? 'background:#a01a1a;color:#fff;border:none' : 'background:var(--green-deep);color:#fff;border:none');
  const cancel = btn('Cancel', 'background:#fff;color:var(--text-dark);border:1.5px solid var(--border)');
  const actions = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px');
  actions.append(ok, cancel);
  panel.append(lab, ta, msg, actions);
  cancel.addEventListener('click', () => onClose?.());
  let busy = false;
  ok.addEventListener('click', async () => {
    if (busy) return;
    const reason = ta.value.trim();
    if (reason.length < 5) { msg.style.color = '#a01a1a'; msg.textContent = 'Give the reason (at least 5 characters).'; ta.focus(); return; }
    busy = true; ok.disabled = true;
    try {
      const fn = urgent ? 'mark_lab_order_urgent' : 'waive_lab_order';
      const { error } = await supabase.rpc(fn, { p_lab_order: order.id, p_reason: reason, p_fee_ids: feeIds || [] });
      if (error) { msg.style.color = '#a01a1a'; msg.textContent = safeErrorMessage(error, urgent ? 'Could not send the order as urgent.' : 'Could not waive the charge.'); return; }
      onDone?.(urgent ? 'Sent to the lab as urgent — the charge is still owed and shows in the outstanding list.' : 'The charge is waived — recorded in the waiver report.');
    } finally { busy = false; ok.disabled = false; }
  });
  setTimeout(() => ta.focus(), 0);
  return panel;
}

// Session 362 (TODO §313): the owed amount as shown -- the amount recorded when the order was marked urgent; otherwise today's price
// from the fee master, marked as an estimate; "No price set" when a test has no fee (never a partial amount)
export function owedAmountText(recorded, priced) {
  if (recorded != null) return _rs(recorded);
  if (!priced) return '—';
  if (priced.unmatched?.length) return 'No price set';
  if (!priced.feeIds?.length) return '—';
  return `≈ ${_rs(priced.amount)} (today's price)`;
}

// the priced fee lines of some orders (the same pricing as reception's Collect): { [orderId]: { feeIds, amount, unmatched } }
export async function priceLabOrders({ supabase, tenantId, orderIds }) {
  const out = {};
  if (!orderIds?.length) return out;
  const [{ data: items }, { data: feeRows }] = await Promise.all([
    supabase.from('lab_order_items').select('order_id, test_name, panel_label').in('order_id', orderIds),
    supabase.from('fee_structures').select('id,label,amount,gst_percent,promo_price,promo_valid_until')
      .eq('tenant_id', tenantId).eq('is_active', true).in('category', ['lab', 'radiology']),
  ]);
  for (const id of orderIds) {
    const priced = computeLabBillingLines(labItemsToSelection((items || []).filter(i => i.order_id === id)), feeRows || []);
    out[id] = { feeIds: priced.lines.map(l => l.fee_structure_id), amount: priced.lines.reduce((s, l) => s + (Number(l.price) || 0), 0),
                unmatched: priced.unmatched || [] };
  }
  return out;
}

// the outstanding list (urgent, unpaid) -- with the Waive button for the finance manager / MS / Super Admin
export async function loadLabOutstanding({ supabase, tenantId, profile, container, countEl }) {
  if (!container) return;
  const msg = el('div', 'font-size:12.5px;margin:4px 0', 'Loading…');
  msg.setAttribute('role', 'status');
  container.replaceChildren(msg);
  const { data, error } = await supabase.rpc('list_lab_outstanding');
  if (error) { msg.textContent = safeErrorMessage(error, 'Could not load the outstanding lab charges.'); return; }
  if (countEl) countEl.textContent = data?.length ? `${data.length} owed` : '';
  if (!data?.length) { msg.textContent = 'No urgent lab order is waiting for payment.'; return; }
  msg.textContent = `${data.length} urgent order${data.length > 1 ? 's' : ''} sent to the lab before payment — still owed (collect at reception → Lab Bills).`;
  const canWaive = canWaiveLabBill(profile);
  // Session 362 (TODO §313): priced for the Waive button AND for a row with no recorded amount (marked urgent before 362, or a test
  // with no price) -- shown as "≈ ₹X (today's price)"; a recorded amount is shown as recorded
  const priced = await priceLabOrders({ supabase, tenantId, orderIds: data.filter(r => canWaive || r.amount == null).map(r => r.lab_order_id) });
  const t = el('table', 'width:100%;border-collapse:collapse;font-size:12px');
  const hr = document.createElement('tr');
  for (const h of ['Patient', 'UHID', 'Tests', 'Urgent since', 'By', 'Reason', 'Days owed', 'Amount', '']) {
    hr.append(el('th', 'text-align:left;padding:6px;border-bottom:1.5px solid var(--border);color:var(--text-mid)', h));
  }
  const thead = document.createElement('thead'); thead.append(hr);
  const tb = document.createElement('tbody');
  for (const r of data) {
    const tr = document.createElement('tr');
    for (const v of [r.patient_name, r.uhid, r.tests, _date(r.urgent_at), r.urgent_by_name || (r.reason ? 'Ordered STAT' : '—'),
                     r.reason || 'Marked urgent before the log existed', String(r.days_owed ?? 0), owedAmountText(r.amount, priced[r.lab_order_id])]) {
      tr.append(el('td', 'padding:6px;border-bottom:1px solid var(--border);vertical-align:top', v || '—'));
    }
    const act = el('td', 'padding:6px;border-bottom:1px solid var(--border);vertical-align:top');
    if (canWaive) {
      const p = priced[r.lab_order_id] || { feeIds: [], amount: 0, unmatched: [] };
      const b = btn('Waive charge', 'background:#fff;color:var(--green-deep);border:1.5px solid var(--green-mid);min-height:36px;font-size:12px');
      if (p.unmatched.length) { b.disabled = true; b.title = 'No price set for: ' + p.unmatched.join(', '); }
      b.addEventListener('click', () => {
        const row = document.createElement('tr'); const cell = el('td'); cell.colSpan = 9; row.append(cell);
        cell.append(buildLabReasonPanel({ supabase, mode: 'waive', feeIds: p.feeIds,
          order: { id: r.lab_order_id, patient_name: r.patient_name, tests: r.tests, amount: p.amount },
          onDone: m => { msg.textContent = m; loadLabOutstanding({ supabase, tenantId, profile, container, countEl }); },
          onClose: () => row.remove() }));
        tr.after(row);
      });
      act.append(b);
    }
    tr.append(act);
    tb.append(tr);
  }
  t.append(thead, tb);
  const wrap = el('div', 'overflow-x:auto');
  wrap.append(t);
  container.append(wrap);
}

// the waiver report, one month (the finance manager / MS / Super Admin)
export async function loadLabWaivers({ supabase, container, countEl }) {
  if (!container) return;
  container.replaceChildren();
  const head = el('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:8px');
  const m = el('input', 'height:36px;padding:0 8px;border:1.5px solid var(--border);border-radius:7px');
  m.type = 'month'; m.id = 'lw-month';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  m.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lab = el('label', 'display:flex;flex-direction:column;font-size:12px;font-weight:600;color:var(--text-mid)', 'Month');
  lab.htmlFor = 'lw-month';
  lab.append(m);
  head.append(lab);
  const msg = el('div', 'font-size:12px;margin:4px 0', '');
  msg.setAttribute('role', 'status');
  const out = el('div');
  container.append(head, msg, out);
  async function run() {
    const [y, mo] = m.value.split('-').map(Number);
    const from = `${m.value}-01`;
    const to = `${m.value}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
    const { data, error } = await supabase.rpc('list_lab_waivers', { p_from: from, p_to: to });
    out.replaceChildren();
    if (error) { msg.textContent = safeErrorMessage(error, 'Could not load the lab waivers.'); return; }
    const total = (data || []).reduce((s, r) => s + Number(r.amount || 0), 0);
    msg.textContent = data?.length ? `${data.length} waiver${data.length > 1 ? 's' : ''} — ${_rs(total)} forgiven` : 'No lab charge was waived in this month.';
    if (countEl) countEl.textContent = `${data?.length || 0} in ${new Date(`${from}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`;
    if (!data?.length) return;
    const t = el('table', 'width:100%;border-collapse:collapse;font-size:12px');
    const hr = document.createElement('tr');
    for (const h of ['Date', 'Patient', 'UHID', 'Tests', 'Amount', 'Waived by', 'Reason']) {
      hr.append(el('th', 'text-align:left;padding:6px;border-bottom:1.5px solid var(--border);color:var(--text-mid)', h));
    }
    const thead = document.createElement('thead'); thead.append(hr);
    const tb = document.createElement('tbody');
    for (const r of data) {
      const tr = document.createElement('tr');
      for (const v of [_date(r.waived_at), r.patient_name, r.uhid, r.tests, r.amount != null ? _rs(r.amount) : '—', r.waived_by_name, r.reason]) {
        tr.append(el('td', 'padding:6px;border-bottom:1px solid var(--border);vertical-align:top', v || '—'));
      }
      tb.append(tr);
    }
    t.append(thead, tb);
    const wrap = el('div', 'overflow-x:auto');
    wrap.append(t);
    out.append(wrap);
  }
  m.addEventListener('change', run);
  await run();
}
