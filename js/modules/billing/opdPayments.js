// opdPayments.js -- Session 324 (TODO_LATER.md §96).
//
// Settles a pending OPD / investigation bill in full through record_opd_bill_payment()
// (sql/session324_opd_payments.sql): the bill becomes "paid" and the payment gets a
// receipt number from the organisation's RCPT series -- the same ledger and receipt print
// page (printReceipt.html) IPD payments already use. Used by reception's queue and
// finance's Outstanding list.
import { billCategory } from './billCategory.js';

// = the database's own role list (record_opd_bill_payment); the page only hides the button.
const COLLECT_ROLES = ['receptionist', 'cashier', 'accountant', 'finance_manager', 'super_admin', 'dept_admin'];

export function canCollectOpd(profile) {
  return COLLECT_ROLES.includes(profile?.role) || COLLECT_ROLES.includes(profile?.secondary_role);
}

// Same conditions the server checks -- a button never offers something it will refuse.
export function isCollectableOpdBill(b) {
  return !!b && ['opd', 'investigation'].includes(billCategory(b.bill_type))
    && ['pending', 'unpaid'].includes(b.status)
    && (b.payer_type || 'self_pay') === 'self_pay'
    && Number(b.final_amount) > 0
    && b.document_status !== 'draft' && b.document_status !== 'cancelled';
}

// Mode picker + reference box + button. The page provides window.collectOpdBill(billId).
// billId is a uuid from our own query; the ids are safe in attributes. Its own class, not
// reception's .q-edit-btn (the queue binds every .q-edit-btn to its Edit dialog).
export function opdCollectControlsHtml(billId) {
  // WCAG 2.1 AA touch targets: every control is at least 44 × 44 px.
  return `<span class="opd-collect" style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
    <select id="opdpm-${billId}" aria-label="Payment mode" style="min-height:44px;min-width:76px;font-size:13px;border-radius:6px;border:1px solid var(--border);padding:0 6px">
      <option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option>
    </select>
    <input id="opdref-${billId}" aria-label="UPI / card reference" placeholder="Ref (UPI/card)" maxlength="60"
      style="min-height:44px;width:130px;font-size:13px;border-radius:6px;border:1px solid var(--border);padding:0 8px">
    <button type="button" class="opd-collect-btn" data-onclick="collectOpdBill" data-onclick-a0="${billId}"
      style="min-height:44px;min-width:44px;padding:0 14px;font-size:13px;font-weight:600;border:none;border-radius:6px;cursor:pointer;background:var(--green-mid);color:#fff">💰 Collect</button>
  </span>`;
}

// Reads the row's own controls, calls the RPC. Returns the RPC result or { error }.
export async function collectOpdBill({ supabase, billId }) {
  const mode = document.getElementById('opdpm-' + billId)?.value || 'cash';
  const reference = document.getElementById('opdref-' + billId)?.value?.trim() || null;
  const { data, error } = await supabase.rpc('record_opd_bill_payment', {
    p_bill: billId, p_mode: mode, p_reference: mode === 'cash' ? null : reference,
  });
  return error ? { error } : data;
}

export function openReceipt(paymentId) {
  window.open(`printReceipt.html?payment=${encodeURIComponent(paymentId)}`, '_blank');
}
