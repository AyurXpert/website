// returnPanel.js -- pharmacy "Return / Cancel" panel (Session 344b, TODO §143). Mounted in the dispensary's 🧾 Bills screen.
// Every figure, rule and refusal is the SERVER's (session 344a): preview_pharmacy_return() shows the bill's lines with
// sold / returned / waiting / returnable and -- for the quantities typed -- the kind (full cancel or partial return), the
// money (pro-rata to the paisa), how it is settled (receipt voided / refund / amount due reduced), where each line goes
// (back to its exact batch, or the disposal register) and every reason it cannot be done (window passed, NDPS / H1 bill,
// GST bill, returns switched off, role). request_pharmacy_return() records it: with "Returns need a second person's
// approval" ON it waits for a checker (the RTN number is given when it is approved); OFF, the maker completes it at once
// and the slip can be printed from that click. Nothing here is trusted by the server.
// DOM nodes + textContent only (medicine and customer names are user-entered text); no native confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js';
import { istDayStartUTC, todayISTStr } from '../../utils/dateUtils.js';

const CONDITIONS = [
  { v: 'sealed_good', l: 'Sealed & good' },
  { v: 'opened', l: 'Opened' },
  { v: 'damaged', l: 'Damaged' },
  { v: 'expired', l: 'Expired' },
];
const DISPOSAL = [
  { v: 'return_supplier', l: 'Return to supplier' },
  { v: 'incineration', l: 'Incineration' },
  { v: 'municipal_bmw', l: 'Bio-medical waste (CBWTF)' },
  { v: 'autoclave', l: 'Autoclave' },
  { v: 'drain_disposal', l: 'Drain disposal (liquids)' },
];
const MODE = { cash: 'Cash', upi: 'UPI', card: 'Card' };
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtExp = d => { if (!d) return null; const [y, m] = String(d).split('-'); return m ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${y}` : String(d); };

export function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
  return e;
}
const btn = (label, cls, onClick, attrs = {}) => { const b = el('button', { type: 'button', class: cls, ...attrs }, label); b.addEventListener('click', onClick); return b; };
let _uid = 0;
const uid = p => `${p}-${++_uid}`;

// What the settlement means at the counter, in words
export function settlementText(s, amount, refund, due, mode) {
  if (s === 'void') return `The sale receipt is cancelled — give back ${rupee(refund)} (${MODE[mode] || mode || 'as paid'}).`;
  if (s === 'refund') return `Refund ${rupee(refund)} by ${MODE[mode] || mode || 'the original mode'}${Number(due) > 0 ? `; the amount due also goes down by ${rupee(due)}` : ''}.`;
  if (s === 'due') return `Credit sale — nothing is paid back; the amount due goes down by ${rupee(due || amount)}.`;
  if (s === 'none') return 'No money changes hands.';
  return '';
}

/**
 * mountReturnPanel(root, { supabase, counterOnly, onChanged })
 *   counterOnly -- a cashier: today's list shows only counter-sale bills (the server refuses the others anyway)
 *   onChanged   -- called after a return was recorded (e.g. refresh the checker queue)
 * returns { openBill(billId) } so a bill row elsewhere can open the panel on that bill.
 */
export function mountReturnPanel(root, { supabase, counterOnly = false, onChanged } = {}) {
  const findId = uid('rp-find');
  const find = el('input', { id: findId, class: 'rp-input', type: 'text', maxlength: '40', autocomplete: 'off', placeholder: 'Bill no., e.g. B/2026-27/000123', 'aria-label': 'Pharmacy bill number' });
  const status = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const today = el('div', { class: 'rp-today' });
  const work = el('div', { class: 'rp-work' });
  const goFind = btn('Find bill', 'rp-btn rp-btn-go', () => findByNumber());
  const refresh = btn("↻ Today's bills", 'rp-btn', () => loadToday());
  find.addEventListener('keydown', e => { if (e.key === 'Enter') findByNumber(); });

  const hId = uid('rp-h');
  root.replaceChildren(el('section', { class: 'rp-card', 'aria-labelledby': hId },
    el('h3', { class: 'rp-h', id: hId }, '↩ Return / Cancel a pharmacy bill'),
    el('p', { class: 'rp-sub' }, "Type the bill number, or pick one of today's bills. The server checks every rule (return window, NDPS / Schedule H1, GST bills, the organisation's return settings) and works out the money."),
    el('div', { class: 'rp-row' }, el('label', { for: findId, class: 'rp-lbl' }, 'Bill no.'), find, goFind, refresh),
    status, today, work));

  let state = null;          // { billId, base (preview with no lines), pv (latest preview), inputs }
  let seq = 0, timer = null;

  function setStatus(msg, err = false) { status.textContent = msg || ''; status.className = 'rp-status' + (err ? ' err' : ''); }

  async function loadToday() {
    today.replaceChildren(el('div', { class: 'rp-muted' }, "Loading today's bills…"));
    let q = supabase.from('bills')
      .select('id, document_number, created_at, final_amount, status, sale_channel, recipient_name, patient_id, returned_amount')
      .eq('bill_type', 'pharmacy').gte('created_at', istDayStartUTC(todayISTStr())).order('created_at', { ascending: false }).limit(60);
    if (counterOnly) q = q.eq('sale_channel', 'counter');
    const { data, error } = await q;
    if (error) { today.replaceChildren(el('div', { class: 'rp-err' }, safeErrorMessage(error, "Could not load today's bills."))); return; }
    if (!data?.length) { today.replaceChildren(el('div', { class: 'rp-muted' }, 'No pharmacy bills today.')); return; }
    const pids = [...new Set(data.map(b => b.patient_id).filter(Boolean))];
    const names = new Map();
    if (pids.length) {
      const { data: pts } = await supabase.from('patients').select('id, name').in('id', pids);
      for (const p of pts || []) names.set(p.id, p.name);
    }
    today.replaceChildren(el('div', { class: 'rp-lbl' }, "Today's pharmacy bills"),
      el('div', { class: 'rp-list' }, data.map(b => {
        const who = names.get(b.patient_id) || (b.sale_channel === 'counter' ? (b.recipient_name || 'Walk-in customer') : '—');
        const tag = b.status === 'cancelled' ? ' · CANCELLED' : Number(b.returned_amount) > 0 ? ` · returned ${rupee(b.returned_amount)}` : '';
        return btn([el('strong', null, b.document_number || 'Not numbered'), ` · ${who} · ${rupee(b.final_amount)} · ${when(b.created_at)}${tag}`],
          'rp-hit', () => openBill(b.id), { 'data-bill': b.id });
      })));
  }

  async function findByNumber() {
    const v = find.value.trim().toUpperCase();
    if (!/^B\/[A-Z0-9/-]{3,}$/.test(v)) { setStatus('Type a pharmacy bill number such as B/2026-27/000123.', true); find.focus(); return; }
    setStatus('Looking for the bill…');
    const { data, error } = await supabase.from('bills').select('id').eq('bill_type', 'pharmacy').eq('document_number', v).limit(2);
    if (error) { setStatus(safeErrorMessage(error, 'Could not find the bill.'), true); return; }
    if (!data?.length) { setStatus(`No pharmacy bill ${v} in this organisation.`, true); return; }
    setStatus('');
    openBill(data[0].id);
  }

  async function openBill(billId) {
    const mine = ++seq;
    clearTimeout(timer);
    work.replaceChildren(el('div', { class: 'rp-muted' }, 'Checking the bill…'));
    const { data, error } = await supabase.rpc('preview_pharmacy_return', { p_bill: billId, p_lines: null });
    if (mine !== seq) return;
    if (error || !data) {
      // e.g. "GST pharmacy returns wait for credit-note rules." / "Your role (doctor) cannot look at pharmacy returns."
      state = null;
      work.replaceChildren(el('div', { class: 'rp-issues', role: 'alert' }, el('strong', null, 'This bill cannot be returned here: '),
        safeErrorMessage(error, 'Could not check the bill.')));
      return;
    }
    state = { billId, base: data, pv: data, qty: new Map(), cond: new Map(), result: null };
    for (const l of data.lines || []) { state.qty.set(l.bill_item_id, 0); state.cond.set(l.bill_item_id, 'sealed_good'); }
    render();
    work.querySelector('input.rp-qty')?.focus();
  }

  function selectedLines() {
    return (state?.base.lines || []).filter(l => state.qty.get(l.bill_item_id) > 0)
      .map(l => ({ bill_item_id: l.bill_item_id, qty: state.qty.get(l.bill_item_id), condition: state.cond.get(l.bill_item_id) }));
  }

  function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(rePreview, 300);
  }
  async function rePreview() {
    if (!state) return;
    const mine = ++seq;
    const lines = selectedLines();
    const { data, error } = await supabase.rpc('preview_pharmacy_return', { p_bill: state.billId, p_lines: lines.length ? lines : null });
    if (mine !== seq || !state) return;
    if (error || !data) { state.pv = { ...state.base, ok: false, issues: [safeErrorMessage(error, 'Could not check the return.')] }; }
    else state.pv = data;
    renderSummary();
  }

  // ── the form ────────────────────────────────────────────────────────────────────────
  let refs = {};
  function render() {
    const b = state.base.bill || {};
    const head = el('div', { class: 'rp-billhead' },
      el('div', null, el('strong', null, `Bill ${b.document_number || '—'}`), ` · ${when(b.created_at)} · ${b.sale_channel === 'counter' ? 'Counter sale' : 'Prescription'}`),
      el('div', null, `Bill total ${rupee(b.final_amount)} · paid ${rupee(b.paid)}${Number(b.refunded) > 0 ? ` · refunded ${rupee(b.refunded)}` : ''} · paid by ${MODE[b.payment_mode] || b.payment_mode || '—'}`
        + `${Number(b.returned_amount) > 0 ? ` · returned so far ${rupee(b.returned_amount)}` : ''}${b.status === 'cancelled' ? ' · CANCELLED' : ''}`),
      el('div', { class: 'rp-muted' }, `${state.base.same_day ? 'Sold today — a full cancel is allowed.' : `Sold ${state.base.days_since_sale} day(s) ago.`} Returns are accepted within ${state.base.window_days} day(s) of the sale.`));

    const rows = (state.base.lines || []).map(l => {
      const qid = uid('rp-q'), cid = uid('rp-c');
      const qty = el('input', { id: qid, class: 'rp-qty', type: 'number', min: '0', max: String(l.returnable), step: '1', value: '0', inputmode: 'numeric',
        'aria-label': `Quantity of ${l.medicine} to return (up to ${l.returnable})`, disabled: l.returnable <= 0 ? true : null });
      qty.addEventListener('input', () => {
        let n = Math.floor(Number(qty.value) || 0);
        if (n < 0) n = 0;
        state.qty.set(l.bill_item_id, n);
        schedulePreview();
      });
      const cond = el('select', { id: cid, class: 'rp-sel', 'aria-label': `Condition of ${l.medicine}`, disabled: l.returnable <= 0 ? true : null },
        CONDITIONS.map(c => el('option', { value: c.v }, c.l)));
      cond.addEventListener('change', () => { state.cond.set(l.bill_item_id, cond.value); schedulePreview(); });
      const goes = el('span', { class: 'rp-goes', 'data-goes': l.bill_item_id }, '—');
      return el('tr', null,
        el('td', null, l.medicine || '—', el('br'), el('span', { class: 'rp-muted' },
          [l.batch_number ? `Batch ${l.batch_number}` : 'Batch not recorded', l.expiry_date ? `Exp ${fmtExp(l.expiry_date)}` : null, l.expired ? 'EXPIRED' : null].filter(Boolean).join(' · '))),
        el('td', { class: 'num' }, String(l.sold)),
        el('td', { class: 'num' }, String(l.returned)),
        el('td', { class: 'num' }, String(l.pending)),
        el('td', { class: 'num' }, String(l.returnable)),
        el('td', null, qty), el('td', null, cond), el('td', null, goes));
    });
    const table = el('table', { class: 'rp-table' },
      el('caption', { class: 'rp-sr' }, 'Medicines on this bill'),
      el('thead', null, el('tr', null, ['Medicine', 'Sold', 'Returned', 'Waiting', 'Can return', 'Return now', 'Condition', 'Goes to']
        .map((h, i) => el('th', { scope: 'col', class: i >= 1 && i <= 4 ? 'num' : null }, h)))),
      el('tbody', null, rows));

    const all = btn('Return everything', 'rp-btn', () => {
      for (const l of state.base.lines || []) state.qty.set(l.bill_item_id, l.returnable);
      work.querySelectorAll('input.rp-qty').forEach((q, i) => { q.value = String(state.base.lines[i].returnable); });
      rePreview();
    });
    const none = btn('Clear', 'rp-btn', () => {
      for (const l of state.base.lines || []) state.qty.set(l.bill_item_id, 0);
      work.querySelectorAll('input.rp-qty').forEach(q => { q.value = '0'; });
      rePreview();
    });

    // reason type + reason
    const rc = uid('rp-rc');
    const rcCust = el('input', { type: 'radio', name: rc, id: rc + 'a', value: 'customer_return', checked: true });
    const rcWrong = el('input', { type: 'radio', name: rc, id: rc + 'b', value: 'wrong_entry' });
    const reasonId = uid('rp-reason');
    const reason = el('textarea', { id: reasonId, class: 'rp-input rp-reason', rows: '2', maxlength: '500', placeholder: 'e.g. Customer returned an unopened pack; wrong medicine supplied' });
    // refund mode
    const modeId = uid('rp-mode'), refId = uid('rp-ref'), mrId = uid('rp-mr');
    const mode = el('select', { id: modeId, class: 'rp-sel' });
    const ref = el('input', { id: refId, class: 'rp-input', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'UPI ref no. / card approval code' });
    const mreason = el('input', { id: mrId, class: 'rp-input', type: 'text', maxlength: '200', autocomplete: 'off', placeholder: 'Why cash instead of the original mode' });
    // disposal
    const dmId = uid('rp-dm'), wId = uid('rp-w');
    const dmethod = el('select', { id: dmId, class: 'rp-sel' }, el('option', { value: '' }, '— choose —'), DISPOSAL.map(d => el('option', { value: d.v }, d.l)));
    const witness = el('input', { id: wId, class: 'rp-input', type: 'text', maxlength: '100', autocomplete: 'off', placeholder: 'Name of the witness' });

    const summary = el('div', { class: 'rp-summary', role: 'status', 'aria-live': 'polite' });
    const modeWrap = el('div', { class: 'rp-field' }, el('label', { for: modeId, class: 'rp-lbl' }, 'Refund mode'), mode);
    const refWrap = el('div', { class: 'rp-field' }, el('label', { for: refId, class: 'rp-lbl' }, 'UPI / card refund reference'), ref);
    const mrWrap = el('div', { class: 'rp-field' }, el('label', { for: mrId, class: 'rp-lbl' }, 'Reason for refunding in cash (required)'), mreason);
    const dispWrap = el('fieldset', { class: 'rp-fieldset' }, el('legend', null, 'Disposal register (opened, damaged or expired medicines are never restocked)'),
      el('div', { class: 'rp-grid2' },
        el('div', { class: 'rp-field' }, el('label', { for: dmId, class: 'rp-lbl' }, 'Disposal method'), dmethod),
        el('div', { class: 'rp-field' }, el('label', { for: wId, class: 'rp-lbl' }, 'Witness name (required)'), witness)));
    const submitMsg = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
    const submit = btn('Record the return', 'rp-btn rp-btn-go', () => doSubmit());
    const cancel = btn('Close', 'rp-btn', () => { state = null; seq++; work.replaceChildren(); });

    for (const x of [reason, ref, mreason, witness]) x.addEventListener('input', () => renderSummary());
    for (const x of [mode, dmethod, rcCust, rcWrong]) x.addEventListener('change', () => renderSummary());

    refs = { summary, mode, modeWrap, ref, refWrap, mreason, mrWrap, dispWrap, dmethod, witness, reason, rcCust, rcWrong, submit, submitMsg };

    work.replaceChildren(el('div', { class: 'rp-form' },
      head,
      state.base.ok === false && (state.base.issues || []).length
        ? el('div', { class: 'rp-issues', role: 'alert' }, el('strong', null, 'This bill cannot be returned as it is:'),
            el('ul', null, state.base.issues.map(t => el('li', null, t))))
        : null,
      el('div', { class: 'rp-tablewrap' }, table),
      el('div', { class: 'rp-row' }, all, none),
      summary,
      el('fieldset', { class: 'rp-fieldset' }, el('legend', null, 'Why'),
        el('div', { class: 'rp-row' },
          el('label', { for: rc + 'a', class: 'rp-radio' }, rcCust, 'Customer return'),
          el('label', { for: rc + 'b', class: 'rp-radio' }, rcWrong, 'Wrongly entered bill')),
        el('div', { class: 'rp-field' }, el('label', { for: reasonId, class: 'rp-lbl' }, 'Reason (at least 5 characters)'), reason)),
      el('div', { class: 'rp-grid2' }, modeWrap, refWrap, mrWrap),
      dispWrap,
      el('div', { class: 'rp-actions' }, cancel, submit),
      submitMsg));
    renderSummary();
  }

  function renderSummary() {
    if (!state || !refs.summary) return;
    const pv = state.pv || {};
    const lines = selectedLines();
    // each line's destination (server's disposition for the quantities typed)
    for (const l of pv.lines || []) {
      const g = work.querySelector(`[data-goes="${CSS.escape(l.bill_item_id)}"]`);
      if (!g) continue;
      g.textContent = l.qty > 0 ? (l.disposition === 'restock' ? `Back to stock (batch ${l.batch_number || '—'})` : 'Disposal register') : '—';
      g.className = 'rp-goes' + (l.qty > 0 ? (l.disposition === 'restock' ? ' ok' : ' warn') : '');
    }
    const kids = [];
    if (!lines.length) {
      kids.push(el('div', { class: 'rp-muted' }, 'Type how many of each medicine come back, and their condition.'));
    } else if (pv.ok === false) {
      kids.push(el('div', { class: 'rp-issues', role: 'alert' }, el('strong', null, 'This cannot be recorded as it is:'),
        el('ul', null, (pv.issues || ['Not allowed.']).map(t => el('li', null, t)))));
    } else {
      kids.push(el('div', { class: 'rp-kind' }, pv.kind === 'cancel' ? 'FULL CANCELLATION of the bill' : 'Partial return'));
      kids.push(el('dl', { class: 'rp-kv' },
        el('dt', null, 'Value of the return'), el('dd', null, rupee(pv.amount)),
        el('dt', null, 'Money'), el('dd', null, settlementText(pv.settlement, pv.amount, pv.refund_amount, pv.due_reduction, chosenMode(pv)))));
      if (pv.completes_bill && pv.bill?.prescription_id) kids.push(el('div', { class: 'rp-note' }, 'Everything on this prescription bill comes back — the prescription goes back to the dispensing queue.'));
      kids.push(el('div', { class: 'rp-note' }, pv.settings?.returns_need_approval
        ? "Returns need a second person's approval here: this is sent for approval, and nothing changes (stock, money, bill) until it is approved."
        : 'This organisation completes returns at once (no second approval): stock, money and the bill change when you record it.'));
    }
    refs.summary.replaceChildren(...kids);

    // refund mode: the original mode, or cash (cash for a UPI / card sale needs a reason) -- shown when money goes back
    const moneyBack = lines.length && pv.ok !== false && (pv.settlement === 'refund' || pv.settlement === 'void');
    const def = pv.refund_mode_default || pv.bill?.payment_mode || 'cash';
    if (refs.mode.dataset.def !== def) {
      refs.mode.replaceChildren(el('option', { value: def }, `${MODE[def] || def} (as paid)`), def !== 'cash' ? el('option', { value: 'cash' }, 'Cash instead') : null);
      refs.mode.dataset.def = def;
    }
    refs.modeWrap.hidden = !moneyBack || pv.settlement === 'void';      // a same-day void gives back the receipt's own mode
    const m = chosenMode(pv);
    refs.refWrap.hidden = !(moneyBack && pv.settlement === 'refund' && (m === 'upi' || m === 'card'));
    refs.mrWrap.hidden = !(moneyBack && pv.settlement === 'refund' && m === 'cash' && def !== 'cash');
    refs.dispWrap.hidden = !(lines.length && pv.has_dispose);
    // the submit button
    const reasonOk = refs.reason.value.trim().length >= 5;
    const witnessOk = refs.dispWrap.hidden || (refs.dmethod.value && refs.witness.value.trim());
    const mrOk = refs.mrWrap.hidden || refs.mreason.value.trim().length >= 5;
    const ready = lines.length && pv.ok !== false && reasonOk && witnessOk && mrOk && !state.result;
    refs.submit.disabled = !ready;
    refs.submit.textContent = pv.settings?.returns_need_approval ? 'Send for approval' : (pv.kind === 'cancel' ? 'Cancel the bill' : 'Record the return');
    refs.submitMsg.textContent = !lines.length || pv.ok === false ? '' : !reasonOk ? 'Give the reason (at least 5 characters).'
      : !witnessOk ? 'Choose the disposal method and enter the witness name.' : !mrOk ? 'Give the reason for refunding in cash.' : '';
    refs.submitMsg.className = 'rp-status';
  }
  function chosenMode(pv) {
    return refs.mode && !refs.modeWrap?.hidden ? refs.mode.value : (pv.refund_mode_default || 'cash');
  }

  async function doSubmit() {
    if (!state || refs.submit.disabled) return;
    const pv = state.pv;
    refs.submit.disabled = true; refs.submit.textContent = 'Saving…';      // double-click safe
    const m = chosenMode(pv);
    const args = {
      p_bill: state.billId,
      p_lines: selectedLines(),
      p_reason: refs.reason.value.trim(),
      p_reason_code: refs.rcWrong.checked ? 'wrong_entry' : 'customer_return',
      p_refund_mode: refs.modeWrap.hidden ? null : m,
      p_refund_reference: refs.refWrap.hidden ? null : (refs.ref.value.trim() || null),
      p_mode_reason: refs.mrWrap.hidden ? null : refs.mreason.value.trim(),
      p_disposal_method: refs.dispWrap.hidden ? null : refs.dmethod.value,
      p_witness: refs.dispWrap.hidden ? null : refs.witness.value.trim(),
    };
    const { data, error } = await supabase.rpc('request_pharmacy_return', args);
    if (error || !data) {
      renderSummary();
      refs.submitMsg.textContent = safeErrorMessage(error, 'Could not record the return.');
      refs.submitMsg.className = 'rp-status err';
      return;
    }
    state.result = data;
    showResult(data, pv);
    if (onChanged) onChanged(data);
  }

  function showResult(r, pv) {
    const b = pv.bill || {};
    const kv = [];
    const pair = (k, v) => kv.push(el('dt', null, k), el('dd', null, v));
    let body;
    if (r.status === 'pending') {
      pair('Bill', b.document_number || '—');
      pair('Request', r.kind === 'cancel' ? 'Full cancellation' : 'Partial return');
      pair('Estimated value', rupee(r.estimate));
      body = [el('h4', { class: 'rp-done-h' }, '⏳ Sent for approval'),
        el('dl', { class: 'rp-kv' }, kv),
        el('p', { class: 'rp-note' }, 'Nothing changes until another authorised person approves it (Finance → Pharmacy returns, or the queue below). The RTN number is given when it is approved; the slip can then be printed from 🧾 Bills.')];
    } else {
      pair('Return no.', r.return_no || '—');
      pair('Bill', b.document_number || '—');
      pair('Value', rupee(r.amount));
      pair('Money', settlementText(r.settlement, r.amount, r.refund_amount, r.due_reduction, r.refund_mode));
      if (r.refund_receipt_no) pair('Refund receipt', r.refund_receipt_no);
      const msg = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
      const print = btn('🖨 Print return slip', 'rp-btn rp-btn-go', () => {
        const w = window.open(`printPharmacyReturn.html?returnId=${encodeURIComponent(r.return_id)}`, '_blank');
        msg.textContent = w ? 'The slip opened in a new tab — print it there.'
          : `The slip page could not open — the browser blocked it. Allow pop-ups for this site and press the button again, or reprint ${r.return_no} any time from 🧾 Bills.`;
        msg.className = 'rp-status' + (w ? '' : ' err');
      });
      body = [el('h4', { class: 'rp-done-h' }, r.kind === 'cancel' ? '✓ Bill cancelled' : '✓ Return recorded'),
        el('dl', { class: 'rp-kv' }, kv), el('div', { class: 'rp-actions' }, print), msg];
    }
    work.replaceChildren(el('div', { class: 'rp-done', role: 'region', 'aria-label': 'Return recorded' }, body,
      el('div', { class: 'rp-actions' }, btn('Done', 'rp-btn', () => { state = null; work.replaceChildren(); loadToday(); }))));
    work.querySelector('.rp-btn-go, .rp-btn')?.focus();
  }

  loadToday();
  return { openBill, reloadToday: loadToday };
}
