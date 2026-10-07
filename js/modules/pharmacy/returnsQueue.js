// returnsQueue.js -- pending pharmacy returns waiting for a second person (Session 344b, TODO §143 owner decision 1).
// Mounted on the dispensary's 🧾 Bills screen and on Finance → Pharmacy returns. Shows each pending return: its bill, the
// lines, the estimated value, who asked and why. Whether THIS viewer may Approve / Reject comes from the SERVER
// (approval_decide_check(), the same rules as decide_pharmacy_return(): active dept_admin / super_admin / finance_manager /
// accountant, never the person who asked) -- no screen keeps its own copy of the rules; decide_pharmacy_return() refuses
// anyway. Approve / Reject happen in an in-page panel (reason required to reject); never a native confirm() / prompt().
// DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';
import { el, settlementText } from './returnPanel.js';

const CONDITION = { sealed_good: 'Sealed & good', opened: 'Opened', damaged: 'Damaged', expired: 'Expired' };
const MODE = { cash: 'Cash', upi: 'UPI', card: 'Card' };
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const REASON_TEXT = {
  own_request: 'You asked for this return — another authorised person must decide it.',
  inactive: 'Your account is not active.',
  not_authorised: 'Waiting for the administrator, accountant or finance manager.',
  already_decided: 'Already decided.',
};
const btn = (label, cls, onClick, attrs = {}) => { const b = el('button', { type: 'button', class: cls, ...attrs }, label); b.addEventListener('click', onClick); return b; };
let _n = 0;

/**
 * mountReturnsQueue(root, { supabase, onCount, onDecided })
 *   onCount(n)  -- how many pending returns THIS viewer may decide (for a tab badge)
 *   onDecided() -- after an approve / reject
 * returns { reload }
 */
export function mountReturnsQueue(root, { supabase, onCount, onDecided } = {}) {
  const hId = `rq-h-${++_n}`;
  const status = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'rq-list' });
  root.replaceChildren(el('section', { class: 'rp-card', 'aria-labelledby': hId },
    el('div', { class: 'rp-row rq-head' },
      el('h3', { class: 'rp-h', id: hId }, '⚖️ Pharmacy returns waiting for approval'),
      btn('↻ Refresh', 'rp-btn', () => reload())),
    el('p', { class: 'rp-sub' }, 'Nothing changes (stock, money, bill) until a return is approved. The person who asked can never approve their own return.'),
    status, list));

  async function reload() {
    status.textContent = 'Loading…'; status.className = 'rp-status';
    const { data: rets, error } = await supabase.from('pharmacy_returns')
      .select('id, bill_id, kind, reason_code, reason, refund_mode, refund_reference, mode_reason, disposal_method, witnessed_by, requested_by, requested_at, approval_id')
      .eq('status', 'pending').order('requested_at', { ascending: true }).limit(100);
    if (error) { status.textContent = safeErrorMessage(error, 'Could not load the pending returns.'); status.className = 'rp-status err'; list.replaceChildren(); onCount?.(0); return; }
    if (!rets?.length) { status.textContent = 'No pharmacy return is waiting for approval.'; list.replaceChildren(); onCount?.(0); return; }

    const ids = rets.map(r => r.id), billIds = [...new Set(rets.map(r => r.bill_id))], makerIds = [...new Set(rets.map(r => r.requested_by))];
    const apprIds = rets.map(r => r.approval_id).filter(Boolean);
    const [linesR, billsR, makersR, apprR, checkR] = await Promise.all([
      supabase.from('pharmacy_return_lines').select('return_id, description, batch_number, qty, unit_price, condition, disposition').in('return_id', ids),
      supabase.from('bills').select('id, document_number, created_at, final_amount, sale_channel, recipient_name, patient_id, payment_mode').in('id', billIds),
      supabase.from('profiles').select('id, full_name').in('id', makerIds),
      supabase.from('pending_approvals').select('id, payload').in('id', apprIds),
      supabase.rpc('approval_decide_check', { p_ids: apprIds }),
    ]);
    const bills = new Map((billsR.data || []).map(b => [b.id, b]));
    const pids = [...new Set((billsR.data || []).map(b => b.patient_id).filter(Boolean))];
    const pts = new Map();
    if (pids.length) {
      const { data } = await supabase.from('patients').select('id, name, uhid').in('id', pids);
      for (const p of data || []) pts.set(p.id, p);
    }
    const makers = new Map((makersR.data || []).map(p => [p.id, p.full_name]));
    const appr = new Map((apprR.data || []).map(a => [a.id, a.payload || {}]));
    // the SERVER's answer per request; if it could not be had, nobody gets buttons (fail closed)
    const check = new Map(checkR.error ? [] : (checkR.data || []).map(c => [c.id, c]));
    const byRet = new Map(ids.map(i => [i, []]));
    for (const l of linesR.data || []) byRet.get(l.return_id)?.push(l);

    let mine = 0;
    list.replaceChildren(...rets.map(r => {
      const b = bills.get(r.bill_id) || {};
      const c = check.get(r.approval_id);
      if (c?.can_decide) mine++;
      return card(r, b, pts.get(b.patient_id), makers.get(r.requested_by), appr.get(r.approval_id), byRet.get(r.id) || [], c);
    }));
    status.textContent = `${rets.length} return${rets.length === 1 ? '' : 's'} waiting · ${mine} you can decide`
      + (checkR.error ? ' — could not check who may decide; try Refresh.' : '.');
    status.className = 'rp-status' + (checkR.error ? ' err' : '');
    onCount?.(mine);
  }

  function card(r, b, pt, maker, payload, lines, c) {
    const who = pt ? `${pt.name || '—'}${pt.uhid ? ' · UHID ' + pt.uhid : ''}` : (b.sale_channel === 'counter' ? (b.recipient_name || 'Walk-in customer') : '—');
    const mode = r.refund_mode || b.payment_mode;
    const rows = lines.map(l => el('tr', null,
      el('td', null, l.description || '—', el('br'), el('span', { class: 'rp-muted' }, l.batch_number ? `Batch ${l.batch_number}` : 'Batch not recorded')),
      el('td', { class: 'num' }, String(l.qty)), el('td', { class: 'num' }, rupee(l.unit_price)),
      el('td', null, CONDITION[l.condition] || l.condition), el('td', null, l.disposition === 'restock' ? 'Back to stock' : 'Disposal register')));
    const msg = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
    const actions = el('div', { class: 'rp-actions' });
    const needsRef = (mode === 'upi' || mode === 'card') && !r.refund_reference;
    if (c?.can_decide) {
      actions.append(
        btn('✕ Reject', 'rp-btn rp-btn-no', () => decidePanel(r, false, needsRef, actions, msg), { 'data-decide': 'reject' }),
        btn('✅ Approve', 'rp-btn rp-btn-go', () => decidePanel(r, true, needsRef, actions, msg), { 'data-decide': 'approve' }));
    } else {
      actions.append(el('span', { class: 'rp-muted', 'data-decide': 'none' }, REASON_TEXT[c?.reason] || 'Waiting for another authorised person.'));
    }
    return el('article', { class: 'rq-card', 'data-return': r.id },
      el('div', { class: 'rq-top' },
        el('strong', null, r.kind === 'cancel' ? 'Full cancellation' : 'Partial return'),
        el('span', null, ` · Bill ${b.document_number || '—'} (${when(b.created_at)}) · bill total ${rupee(b.final_amount)}`)),
      el('div', { class: 'rq-meta' }, `${who} · estimated value ${rupee(payload?.estimate)} · refund by ${MODE[mode] || mode || '—'}${r.refund_reference ? ' · ref ' + r.refund_reference : ''}`),
      el('div', { class: 'rq-meta' }, `Asked by ${maker || '—'} · ${when(r.requested_at)} · ${r.reason_code === 'wrong_entry' ? 'Wrongly entered bill' : 'Customer return'}: “${r.reason}”`),
      r.mode_reason ? el('div', { class: 'rq-meta' }, `Cash instead of ${MODE[b.payment_mode] || b.payment_mode}: “${r.mode_reason}”`) : null,
      r.witnessed_by ? el('div', { class: 'rq-meta' }, `Disposal witnessed by ${r.witnessed_by}`) : null,
      el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table' },
        el('thead', null, el('tr', null, ['Medicine', 'Qty', 'Rate', 'Condition', 'Goes to'].map((h, i) => el('th', { scope: 'col', class: i === 1 || i === 2 ? 'num' : null }, h)))),
        el('tbody', null, rows))),
      actions, msg);
  }

  // in-page decision panel: Approve (optional note; the UPI / card refund reference when none was given) / Reject (reason required)
  function decidePanel(r, approve, needsRef, actions, msg) {
    const noteId = `rq-note-${++_n}`, refId = `rq-ref-${_n}`;
    const note = el('textarea', { id: noteId, class: 'rp-input', rows: '2', maxlength: '500',
      placeholder: approve ? 'Note (optional)' : 'Why it is rejected (at least 5 characters)' });
    const ref = needsRef && approve ? el('input', { id: refId, class: 'rp-input', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'UPI ref no. / card approval code' }) : null;
    const go = btn(approve ? 'Confirm approval' : 'Confirm rejection', approve ? 'rp-btn rp-btn-go' : 'rp-btn rp-btn-no', async () => {
      const n = note.value.trim();
      if (!approve && n.length < 5) { msg.textContent = 'Give the reason for rejecting (at least 5 characters).'; msg.className = 'rp-status err'; note.focus(); return; }
      if (ref && !ref.value.trim()) { msg.textContent = 'Enter the UPI / card refund reference.'; msg.className = 'rp-status err'; ref.focus(); return; }
      go.disabled = true; back.disabled = true; go.textContent = 'Saving…';
      const { data, error } = await supabase.rpc('decide_pharmacy_return', {
        p_return: r.id, p_approve: approve, p_note: n || null, p_refund_reference: ref ? ref.value.trim() : null });
      if (error || !data) {
        msg.textContent = safeErrorMessage(error, 'Could not decide this return.'); msg.className = 'rp-status err';
        go.disabled = false; back.disabled = false; go.textContent = approve ? 'Confirm approval' : 'Confirm rejection';
        return;
      }
      if (data.status === 'completed') {
        const print = btn(`🖨 Print slip ${data.return_no}`, 'rp-btn rp-btn-go', () => {
          const w = window.open(`printPharmacyReturn.html?returnId=${encodeURIComponent(data.return_id)}`, '_blank');
          msg.textContent = w ? 'The slip opened in a new tab.' : `The browser blocked the slip page — allow pop-ups and press again, or reprint ${data.return_no} from Visits & Bills.`;
          msg.className = 'rp-status' + (w ? '' : ' err');
        });
        actions.replaceChildren(el('span', { class: 'rp-ok' }, `✓ Approved — ${data.return_no}. ${settlementText(data.settlement, data.amount, data.refund_amount, data.due_reduction, data.refund_mode)}`), print);
        msg.textContent = '';
      } else {
        actions.replaceChildren(el('span', { class: 'rp-muted' }, '✕ Rejected — nothing was changed.'));
        msg.textContent = '';
      }
      onDecided?.(data);
    }, { 'data-confirm': approve ? 'approve' : 'reject' });
    const back = btn('Back', 'rp-btn', () => { reload(); });
    actions.replaceChildren(el('div', { class: 'rq-decide', role: 'group', 'aria-label': approve ? 'Approve this return' : 'Reject this return' },
      el('label', { for: noteId, class: 'rp-lbl' }, approve ? 'Approve — note (optional)' : 'Reject — reason (required)'), note,
      ref ? [el('label', { for: refId, class: 'rp-lbl' }, 'UPI / card refund reference (required)'), ref] : null,
      el('div', { class: 'rp-actions' }, back, go)));
    note.focus();
  }

  reload();
  return { reload };
}
