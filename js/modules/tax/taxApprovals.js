// taxApprovals.js -- the IP-medicines choice, default tax profile and room tax profile (Session 345e) requests waiting for
// approval (Session 345c2a; the itemTax.js pattern). Each request shows who asked, why, and an old -> new table; Approve / Reject (a reason of at least 5
// characters to reject) only where the server says this person may decide (approval_decide_check). The decision itself is
// decide_approval (re-checked on the server). DOM nodes + textContent only; no native confirm() / alert() / prompt().
import { safeErrorMessage } from '../../utils/errors.js';
import { el } from '../pharmacy/returnPanel.js';

export const TAX_APPROVAL_TYPES = ['ip_medicine_tax', 'tax_defaults_change', 'room_tax_change', 'credit_note', 'gst_scheme_change', 'composition_tax_base'];   // Session 345f: + 2
const btn = (label, cls, onClick, attrs = {}) => { const b = el('button', { type: 'button', class: cls, ...attrs }, label); b.addEventListener('click', onClick); return b; };
let _n = 0;
const uid = p => `${p}-${++_n}`;
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtD = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const TITLE = { ip_medicine_tax: 'IP-medicines tax choice', tax_defaults_change: 'Default tax profiles', room_tax_change: 'Room tax profiles (IPD)',
  credit_note: 'Credit note', gst_scheme_change: 'Registration type (regular / composition)', composition_tax_base: 'Composition tax base' };
const inr = n => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const REASON = { own_request: 'You asked for this change — another authorised person decides it.', inactive: 'Your account is not active.',
  not_authorised: 'Waiting for the Super Admin or Finance Manager.' };

function choiceText(c) {
  if (!c) return 'none';
  return c.treatment === 'EXEMPT' ? `EXEMPT — ${c.exempt_profile_name || '—'}`
    : `CHARGEABLE — own IP profile${c.fallback_profile_name ? `, else ${c.fallback_profile_name}` : ' (no fallback)'}`;
}
// old -> new rows for a request
function rowsFor(a) {
  const p = a.payload || {};
  if (a.action_type === 'ip_medicine_tax') {
    return [['Choice', choiceText(p.old), choiceText(p)],
            ['Effective from', p.old?.effective_from ? fmtD(p.old.effective_from) : '—', fmtD(p.effective_from)]];
  }
  if (a.action_type === 'credit_note') {       // Session 345g: what is credited (per line) and refunded -- the server re-checks at approval
    const ls = Array.isArray(p.lines) ? p.lines : [];
    return [['Against', `${p.original_document_number || '—'} (${fmtD(p.original_document_date)})`, p.with_tax ? 'Credit note (with GST)' : 'Credit note (Bill of Supply, no GST)'],
            ...ls.map(l => [`Line ${l.original_line_no}: ${l.description || '—'}`, '—',
              `${inr(l.line_total)}${Number(l.cgst_amount) || Number(l.sgst_amount) ? ` (CGST ${inr(l.cgst_amount)} + SGST ${inr(l.sgst_amount)})` : ''}`]),
            ['Refund', '—', `${inr(p.total)} by ${String(p.refund_mode || '—').toUpperCase()}${p.refund_reference ? ' · ' + p.refund_reference : ''}`],
            ['Credit allowed until', '—', fmtD(p.deadline)]];
  }
  if (a.action_type === 'gst_scheme_change') {   // Session 345f: regular <-> composition from a date (the server re-checks every date rule)
    const S = { regular: 'Regular', composition: 'Composition' };
    return [['Registration type', S[p.old?.scheme] || 'not recorded', S[p.scheme] || p.scheme || '—'],
            ['Effective from', p.old?.effective_from ? fmtD(p.old.effective_from) : '—', fmtD(p.effective_from)],
            ['Reference (CMP-02 / CMP-04)', p.old?.reference || '—', p.reference || '—']];
  }
  if (a.action_type === 'composition_tax_base') {   // Session 345f (R7): never changes a bill -- used by the GST reports only
    const B = { unconfirmed: 'Not confirmed yet', taxable_only: 'Taxable supplies only', taxable_and_exempt: 'Taxable + exempt supplies' };
    return [['Composition tax base', B[p.old] || 'Not confirmed yet', B[p.base] || p.base || '—'],
            ['Effective from', '—', fmtD(p.effective_from)], ['CA confirmation', '—', p.reference || '—']];
  }
  if (a.action_type === 'room_tax_change') {   // Session 345e
    const o = p.old || {};
    return [['Taxable rooms', o.taxable_profile_name || 'not set', p.taxable_profile_name || 'not set'],
            ['Exempt rooms', o.exempt_profile_name || 'not set', p.exempt_profile_name || 'not set'],
            ['Wellness stays', o.wellness_profile_name || 'not set', p.wellness_profile_name || 'not set'],
            ['Effective from', o.effective_from ? fmtD(o.effective_from) : '—', fmtD(p.effective_from)]];
  }
  const on = p.old_names || {}, nn = p.new_names || {};
  return [['OP medicines (goods)', on.goods_op || 'not set', nn.goods_op || 'not set'],
          ['Treatment services', on.treatment || 'not set', nn.treatment || 'not set'],
          ['Wellness services', on.wellness || 'not set', nn.wellness || 'not set']]
    .map(r => [...r, r[1] !== r[2]]);
}

/**
 * @param {HTMLElement} root
 * @param {{ supabase: any, onCount?: Function, onDecided?: Function }} opts
 *   onDecided(approve, text) -- the host may reload and re-mount; it gets the text so it can keep the result on screen
 */
export function mountTaxApprovals(root, { supabase, onCount, onDecided } = {}) {
  const hId = uid('ta-h');
  const status = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'rq-list' });
  root.replaceChildren(el('section', { class: 'rp-card', 'aria-labelledby': hId, 'data-tax-approvals': '' },
    el('div', { class: 'rp-row rq-head' }, el('h3', { class: 'rp-h', id: hId }, '⚖️ Tax settings waiting for approval'), btn('↻ Refresh', 'rp-btn', () => reload())),
    el('p', { class: 'rp-sub' }, 'Approving applies the change at once (re-checked now); bills already issued never change. The person who asked can never approve their own request (except an organisation\'s only Super Admin).'),
    status, list));

  async function reload() {
    status.textContent = 'Loading…'; status.className = 'rp-status';
    const { data, error } = await supabase.from('pending_approvals').select('id, action_type, payload, reason, requested_by, requested_at')
      .in('action_type', TAX_APPROVAL_TYPES).eq('status', 'pending').order('requested_at', { ascending: true });
    if (error) { status.textContent = safeErrorMessage(error, 'Could not load the requests.'); status.className = 'rp-status err'; onCount?.(0); return; }
    if (!data?.length) { status.textContent = 'No tax settings request is waiting for approval.'; list.replaceChildren(); onCount?.(0); return; }
    const [chk, who] = await Promise.all([
      supabase.rpc('approval_decide_check', { p_ids: data.map(a => a.id) }),
      supabase.from('profiles').select('id, full_name').in('id', [...new Set(data.map(a => a.requested_by))]),
    ]);
    const can = new Map(chk.error ? [] : (chk.data || []).map(c => [c.id, c]));
    const names = new Map((who.data || []).map(p => [p.id, p.full_name]));
    let mine = 0;
    list.replaceChildren(...data.map(a => {
      const c = can.get(a.id);
      if (c?.can_decide) mine++;
      const msg = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
      const actions = el('div', { class: 'rp-actions' });
      if (c?.can_decide) {
        actions.append(btn('✕ Reject', 'rp-btn rp-btn-no', () => panel(a, false, actions, msg), { 'data-decide': 'reject' }),
                       btn('✅ Approve', 'rp-btn rp-btn-go', () => panel(a, true, actions, msg), { 'data-decide': 'approve' }));
      } else {
        actions.append(el('span', { class: 'rp-muted', 'data-decide': 'none' }, REASON[c?.reason] || 'Waiting for another authorised person.'));
      }
      return el('article', { class: 'rq-card', 'data-request': a.id, 'data-type': a.action_type },
        el('div', { class: 'rq-top' }, el('strong', null, TITLE[a.action_type] || a.action_type), ` · asked by ${names.get(a.requested_by) || '—'} · ${when(a.requested_at)}`),
        a.reason ? el('div', { class: 'rq-meta' }, `Reason: “${a.reason}”`) : null,
        el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table' },
          el('thead', null, el('tr', null, ['', 'Now', 'Requested'].map(h => el('th', { scope: 'col' }, h)))),
          el('tbody', null, rowsFor(a).map(([k, o, n]) => el('tr', null, el('th', { scope: 'row' }, k), el('td', null, o), el('td', null, n)))))),
        actions, msg);
    }));
    status.textContent = `${data.length} request(s) waiting · ${mine} you can decide` + (chk.error ? ' — could not check who may decide; try Refresh.' : '.');
    status.className = 'rp-status' + (chk.error ? ' err' : '');
    onCount?.(mine);
  }

  function panel(a, approve, actions, msg) {
    const nId = uid('ta-n');
    const note = el('textarea', { id: nId, class: 'rp-input', rows: '2', maxlength: '500', placeholder: approve ? 'Note (optional)' : 'Why it is rejected (at least 5 characters)' });
    const back = btn('Back', 'rp-btn', () => reload());
    const go = btn(approve ? 'Confirm approval' : 'Confirm rejection', approve ? 'rp-btn rp-btn-go' : 'rp-btn rp-btn-no', async () => {
      const n = note.value.trim();
      if (!approve && n.length < 5) { msg.textContent = 'Give the reason for rejecting (at least 5 characters).'; msg.className = 'rp-status err'; note.focus(); return; }
      go.disabled = true; back.disabled = true; go.textContent = 'Saving…';
      const { error } = await supabase.rpc('decide_approval', { p_request_id: a.id, p_approve: approve, p_notes: n || null });
      if (error) {
        msg.textContent = safeErrorMessage(error, 'Could not decide this request.'); msg.className = 'rp-status err';
        go.disabled = false; back.disabled = false; go.textContent = approve ? 'Confirm approval' : 'Confirm rejection';
        return;
      }
      let done = approve ? '✓ Approved — the change is applied.' : '✕ Rejected — nothing was changed.';
      // Session 345h follow-up: a credit note says which note was issued and what happens to the money (D4)
      if (approve && a.action_type === 'credit_note') done = await creditNoteDone(a) || done;
      actions.replaceChildren(el('span', { class: approve ? 'rp-ok' : 'rp-muted', 'data-decided': approve ? 'approved' : 'rejected' }, done));
      msg.textContent = '';
      refreshCount();
      onDecided?.(approve, done);
    }, { 'data-confirm': approve ? 'approve' : 'reject' });
    actions.replaceChildren(el('div', { class: 'rq-decide', role: 'group', 'aria-label': approve ? 'Approve this request' : 'Reject this request' },
      el('label', { for: nId, class: 'rp-lbl' }, approve ? 'Approve — note (optional)' : 'Reject — reason (required)'), note,
      el('div', { class: 'rp-actions' }, back, go)));
    // Session 345c2b (TODO §159): bring the WHOLE card (its old -> new table) into view; its scroll-margin-top keeps it
    // below a sticky page header -- a plain focus() scrolled only the note box into view, the table under the header
    note.focus({ preventScroll: true });
    actions.closest('.rq-card')?.scrollIntoView({ block: 'start' });
  }

  // the issued note (it gets its number at approval): "Credit note CN/… issued — ₹300.00 cash refund due" / "… refunded by UPI"
  async function creditNoteDone(a) {
    const { data } = await supabase.from('credit_notes').select('document_number, total_amount, refund_mode, refund_payment_id')
      .eq('approval_id', a.id).maybeSingle();
    if (!data) return null;
    const amt = inr(data.total_amount);
    return `✓ Credit note ${data.document_number} issued — ` + (data.refund_mode === 'cash' && !data.refund_payment_id
      ? `${amt} cash refund due (paid out at the counter)` : `${amt} refunded by ${String(data.refund_mode || '').toUpperCase()}`);
  }
  // after a decision: the waiting / you-can-decide line and the badge are counted again (the decided card stays on screen)
  async function refreshCount() {
    const { data, error } = await supabase.from('pending_approvals').select('id').in('action_type', TAX_APPROVAL_TYPES).eq('status', 'pending');
    if (error) return;
    const chk = data?.length ? await supabase.rpc('approval_decide_check', { p_ids: data.map(x => x.id) }) : { data: [] };
    const mine = (chk.data || []).filter(c => c.can_decide).length;
    status.textContent = data?.length ? `${data.length} request(s) waiting · ${mine} you can decide.` : 'No tax settings request is waiting for approval.';
    status.className = 'rp-status';
    onCount?.(mine);
  }

  reload();
  return { reload };
}
