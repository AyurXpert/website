// Session 357 (TODO §265-C): the admission counter between a doctor's advice and the bed -- shared by reception.html (the
// counter), doctor.html ("💰 Awaiting deposit" box, the MS's waiver report) and admin.html (the Super Admin's waiver report).
// The SERVER decides everything (sql/session357_admission_counter.sql): start_admission_counter (payer + the insurance case on
// the advice), request_pre_auth / record_pre_auth_decision (unchanged, on the advice's case), waive_admission_deposit
// (finance_manager / MS / super_admin, reason), list_awaiting_deposit, list_deposit_waivers. Built from DOM nodes + textContent
// only; every refusal is the server's message (errors.js); a write counts as saved only when the server confirms it.
import { noAutofill } from '../../utils/noAutofill.js';   // Session 358 (§285)
import { safeErrorMessage } from '../../utils/errors.js';

export const PAYERS = [
  ['self_pay', 'Self-pay'], ['insurance', 'Private insurance'], ['corporate', 'Corporate'],
  ['pmjay', 'PM-JAY'], ['cghs', 'CGHS'], ['echs', 'ECHS'], ['esi', 'ESI'],
];
export const SCHEMES = ['pmjay', 'cghs', 'echs', 'esi'];
export const payerLabel = p => (PAYERS.find(x => x[0] === p) || [p, p || '—'])[1];

export const STAGES = {
  at_counter: ['Advised — waiting at the admission counter', '#e8f0fb', '#1a4080'],
  awaiting_deposit: ['Self-pay — awaiting the deposit', '#fff8e1', '#7a5200'],
  deposit_waived: ['Deposit waived — ready to admit', '#e8f5ee', '#1a4a2e'],
  pre_auth_not_requested: ['Insurance — pre-auth not requested yet', '#e8f0fb', '#1a4080'],
  pre_auth_pending: ['Insurance — pre-auth pending with the insurer', '#fff8e1', '#7a5200'],
  pre_auth_approved: ['Insurance — pre-auth approved', '#e8f5ee', '#1a4a2e'],
  pre_auth_rejected: ['Insurance — pre-auth rejected', '#fdecea', '#a01a1a'],
  deposit_due: ['Admitted — deposit due', '#fdecea', '#a01a1a'],
  admitted: ['Admitted today', '#e8f5ee', '#1a4a2e'],
  admitted_pre_auth_not_requested: ['⚠ Admitted — pre-auth not requested', '#fff1e0', '#8a3a00'],   // Session 357c (Q1)
};
const _rs = n => '₹' + Number(n || 0).toLocaleString('en-IN');
const _date = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}
export function stageChip(stage) {
  const [label, bg, fg] = STAGES[stage] || [stage || '—', '#eee', '#333'];
  const c = el('span', `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${bg};color:${fg}`, label);
  c.className = 'badge';
  return c;
}
function btn(label, primary, onClick) {
  const b = el('button', primary
    ? `min-height:44px;padding:0 14px;background:${primary};color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif`
    : "min-height:44px;padding:0 14px;background:#fff;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-family:'DM Sans',sans-serif", label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function field(labelText, input, hint) {
  const w = el('div', 'margin-bottom:8px');
  const l = el('label', 'display:block;font-size:12px;font-weight:600;color:var(--text-mid);margin-bottom:3px', labelText);
  input.id = input.id || ('ac-' + Math.random().toString(36).slice(2, 9));
  l.htmlFor = input.id;
  input.style.cssText = (input.style.cssText || '') + ";width:100%;box-sizing:border-box;min-height:40px;font-family:'DM Sans',sans-serif;font-size:13px";
  w.append(l, input);
  if (hint) w.append(el('div', 'font-size:11px;color:var(--text-muted);margin-top:2px', hint));
  return w;
}
function input(type, attrs = {}) {
  const i = document.createElement(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'select' && type !== 'textarea') i.type = type;
  Object.assign(i, attrs);
  return i;
}
function status(msgEl, text, ok) {
  msgEl.textContent = text;
  msgEl.style.color = ok ? 'var(--green-deep)' : 'var(--red, #a01a1a)';
  msgEl.hidden = !text;
}

// ── the "Awaiting deposit" list (doctor.html box: own patients; reception: everything, incl. admitted with a deposit due) ──
export function awaitingRows(rows, { onAccount } = {}) {
  return rows.map(r => {
    const row = el('div', 'padding:6px 0;border-top:1px dashed var(--border);font-size:11.5px;line-height:1.45');
    row.append(el('div', 'font-weight:600', `${r.patient_name || '—'} · ${r.uhid || '—'} · ${r.department_name || ''}`));
    const meta = el('div', 'color:var(--text-mid)');
    meta.textContent = r.kind === 'advice'
      ? `Advised ${_date(r.since)} by ${r.doctor_name || '—'} · ${payerLabel(r.payer_type)}`
        + (r.suggested_deposit ? ` · suggested deposit ${_rs(r.suggested_deposit)}` : '') + ` · expires ${_date(r.expires_at)}`
      : `Admitted ${_date(r.since)} under ${r.doctor_name || '—'} · ${payerLabel(r.payer_type)}`;
    row.append(meta, stageChip(r.stage));
    if (r.kind === 'admission' && r.stage === 'deposit_due' && onAccount) {
      const b = btn('💳 Collect the deposit', 'var(--green-deep)', () => onAccount(r.id));
      b.style.marginTop = '4px';
      row.append(b);
    }
    return row;
  });
}
export async function loadAwaitingDeposit({ supabase, box, list, onAccount, filter }) {
  if (!box || !list) return [];
  const { data, error } = await supabase.rpc('list_awaiting_deposit');
  const rows = (error ? [] : (data || [])).filter(filter || (() => true));
  list.replaceChildren(...awaitingRows(rows, { onAccount }));
  box.hidden = rows.length === 0;
  return error ? null : (data || []);
}

// ── the waiver report (owner addition 8): the MS / Super Admin (+ the finance manager, 357c B5), read-only, one month ──
export async function loadDepositWaivers({ supabase, container, countEl }) {
  if (!container) return;
  container.replaceChildren();
  const head = el('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:8px');
  const m = input('month');
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  m.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const mf = field('Month', m);
  mf.style.cssText = 'margin:0;min-width:180px';
  head.append(mf);
  const out = el('div');
  const msg = el('div', 'font-size:12px;margin:4px 0', '');
  msg.setAttribute('role', 'status');
  container.append(head, msg, out);
  async function run() {
    const { data, error } = await supabase.rpc('list_deposit_waivers', { p_month: `${m.value}-01` });
    out.replaceChildren();
    if (error) { status(msg, safeErrorMessage(error, 'Could not load the deposit waivers.'), false); return; }
    status(msg, data?.length ? `${data.length} waiver${data.length > 1 ? 's' : ''}` : 'No deposit was waived in this month.', true);
    if (countEl) {   // Session 357c (f): the month's count in the card header
      const label = new Date(`${m.value}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      countEl.textContent = `${data?.length || 0} in ${label}`;
    }
    if (!data?.length) return;
    const t = el('table', 'width:100%;border-collapse:collapse;font-size:12px');
    const hr = document.createElement('tr');
    for (const h of ['Date', 'Patient', 'UHID', 'Suggested deposit', 'Waived by', 'Advising doctor', 'Reason', 'Now']) {
      hr.append(el('th', 'text-align:left;padding:6px;border-bottom:1.5px solid var(--border);color:var(--text-mid)', h));
    }
    const thead = document.createElement('thead'); thead.append(hr);
    const tb = document.createElement('tbody');
    for (const r of data) {
      const tr = document.createElement('tr');
      for (const v of [_date(r.waived_at), r.patient_name, r.uhid, r.suggested_deposit != null ? _rs(r.suggested_deposit) : '—', r.waived_by_name,
                       r.advising_doctor_name, r.reason,
                       r.kind === 'advice' ? `Advice ${r.status === 'declined' ? 'refused by the patient' : r.status}` : `Admission (${r.status})`]) {
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

// ── the counter panel on one advice (reception) ──
// mode: 'payer' | 'preauth_request' | 'preauth_decision' | 'waive'
export function buildCounterPanel({ supabase, tenantId, advice, mode, caseRow, onDone, onClose }) {
  const panel = el('div', 'margin:8px;padding:12px 14px;border:1.5px solid var(--green-mid);border-radius:8px;background:#f7fbf8');
  const titles = { payer: 'Payer & insurance', preauth_request: 'Request pre-authorization', preauth_decision: "Record the insurer's decision",
                   waive: 'Waive the deposit' };
  panel.append(el('div', 'font-size:13px;font-weight:700;color:var(--green-deep);margin-bottom:8px',
    `${titles[mode]} — ${advice.patient_name || 'patient'}`));
  const msg = el('div', 'font-size:12.5px;font-weight:600;margin:6px 0', '');
  msg.setAttribute('role', 'status');
  msg.hidden = true;
  const actions = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:6px');
  let busy = false;
  const guard = async (b, fn) => {
    if (busy) return;
    busy = true; b.disabled = true;
    try { await fn(); } finally { busy = false; b.disabled = false; }
  };

  if (mode === 'payer') {
    const payer = input('select');
    for (const [v, l] of PAYERS) { const o = document.createElement('option'); o.value = v; o.textContent = l; payer.append(o); }
    payer.value = advice.payer_type || 'self_pay';
    const ins = input('text', { maxLength: 200 }); const tpa = input('text', { maxLength: 200 });
    const pol = input('text', { maxLength: 100 }); const mem = input('text', { maxLength: 100 }); const pkg = input('text', { maxLength: 50 });
    const cash = input('select');
    for (const [v, l] of [['', '— choose —'], ['true', 'Cashless'], ['false', 'Reimbursement']]) { const o = document.createElement('option'); o.value = v; o.textContent = l; cash.append(o); }
    const copay = input('number', { min: 0, max: 100, step: 'any' });
    const insBox = el('div');
    const fIns = field('Insurance company (required for private insurance)', ins);
    const fPkg = field('PM-JAY package code', pkg);
    const fCash = field('Cashless or reimbursement', cash);
    insBox.append(fIns, field('TPA', tpa), field('Policy number (required for private insurance)', pol), field('Member / card ID', mem), fPkg, fCash,
      field('Co-pay %', copay));
    const sync = () => {
      const p = payer.value;
      insBox.hidden = p === 'self_pay';
      fPkg.hidden = p !== 'pmjay';
      fCash.hidden = SCHEMES.includes(p);
      fIns.hidden = SCHEMES.includes(p);
    };
    payer.addEventListener('change', sync);
    panel.append(field('Payer', payer, 'The doctor and the department of the advice are not changed here.'), insBox);
    sync();
    const save = btn('Save payer', 'var(--green-deep)');
    save.addEventListener('click', () => guard(save, async () => {
      const p = payer.value;
      const { error } = await supabase.rpc('start_admission_counter', {
        p_advice_id: advice.id, p_payer_type: p,
        p_insurer_name: p === 'self_pay' ? null : (ins.value.trim() || null), p_tpa_name: p === 'self_pay' ? null : (tpa.value.trim() || null),
        p_policy_number: p === 'self_pay' ? null : (pol.value.trim() || null), p_member_id: p === 'self_pay' ? null : (mem.value.trim() || null),
        p_pmjay_package_code: p === 'pmjay' ? (pkg.value.trim() || null) : null,
        p_is_cashless: p === 'self_pay' || SCHEMES.includes(p) ? null : (cash.value === '' ? null : cash.value === 'true'),
        p_co_pay_pct: p === 'self_pay' || copay.value === '' ? null : Number(copay.value),
      });
      if (error) { status(msg, safeErrorMessage(error, 'Could not save the payer.'), false); return; }
      status(msg, p === 'self_pay' ? '✓ Saved: self-pay — collect the deposit when admitting.'
        : SCHEMES.includes(p) ? '✓ Saved — the case is open on this advice. Request the pre-authorization next.'
        : '✓ Saved — the insurance case is open on this advice. Request the pre-authorization next; a deposit of more than ₹0 is collected when admitting.', true);
      onDone?.();
    }));
    actions.append(save);
  } else if (mode === 'preauth_request') {
    const amt = input('number', { min: 1, step: 'any' });
    if (advice.estimated_total) amt.value = advice.estimated_total;
    panel.append(field('Amount requested from the insurer (₹)', amt, caseRow ? `${caseRow.insurer_name || ''} · policy ${caseRow.policy_number || '—'}` : ''));
    const go = btn('Request pre-authorization', 'var(--green-deep)');
    go.addEventListener('click', () => guard(go, async () => {
      const n = Number(amt.value);
      if (!(n > 0)) { status(msg, 'Enter the amount requested (more than ₹0).', false); return; }
      const { error } = await supabase.rpc('request_pre_auth', { p_case_id: caseRow?.id, p_amount: n });
      if (error) { status(msg, safeErrorMessage(error, 'Could not request the pre-authorization.'), false); return; }
      status(msg, '✓ Requested — the patient may be admitted while the insurer decides.', true);
      onDone?.();
    }));
    actions.append(go);
  } else if (mode === 'preauth_decision') {
    const dec = input('select');
    for (const [v, l] of [['approved', 'Approved'], ['rejected', 'Rejected']]) { const o = document.createElement('option'); o.value = v; o.textContent = l; dec.append(o); }
    const amt = input('number', { min: 0, step: 'any' });
    const ref = input('text', { maxLength: 100 });
    const reason = input('textarea', { maxLength: 500 });
    const file = input('file', { accept: '.pdf,image/*' });
    const fAmt = field('Approved amount (₹)', amt);
    const fReason = field('Rejection reason (required when rejected)', reason, 'A rejected pre-authorization makes the patient self-pay — the deposit rule then applies.');
    const sync = () => { fAmt.hidden = dec.value !== 'approved'; fReason.hidden = dec.value !== 'rejected'; };
    dec.addEventListener('change', sync);
    panel.append(field('Decision', dec), fAmt, field("Insurer's reference number", ref), fReason, field("Insurer's letter (PDF or photo)", file));
    sync();
    const go = btn('Record the decision', 'var(--green-deep)');
    go.addEventListener('click', () => guard(go, async () => {
      if (!ref.value.trim()) { status(msg, "Enter the insurer's reference number.", false); return; }
      if (dec.value === 'rejected' && !reason.value.trim()) { status(msg, 'Enter the rejection reason.', false); return; }
      const f = file.files?.[0];
      if (!f) { status(msg, "Choose the insurer's letter to upload.", false); return; }
      const path = `${tenantId}/advice-${advice.id}/preauth/${Date.now()}_${f.name.replace(/[^\w.\-]+/g, '_')}`;
      const up = await supabase.storage.from('insurance-documents').upload(path, f);
      if (up.error) { status(msg, safeErrorMessage(up.error, 'Could not upload the letter.'), false); return; }
      const { error } = await supabase.rpc('record_pre_auth_decision', {
        p_case_id: caseRow?.id, p_status: dec.value, p_approved_amount: dec.value === 'approved' ? Number(amt.value || 0) : null,
        p_reference_number: ref.value.trim(), p_document_path: path, p_rejection_reason: dec.value === 'rejected' ? reason.value.trim() : null,
      });
      if (error) { status(msg, safeErrorMessage(error, 'Could not record the decision.'), false); return; }
      status(msg, dec.value === 'approved' ? '✓ Recorded: pre-authorization approved.'
        : '✓ Recorded: rejected — the patient is now self-pay; collect the deposit (or a waiver) before the bed.', true);
      onDone?.();
    }));
    actions.append(go);
  } else if (mode === 'waive') {
    const reason = input('textarea', { maxLength: 500 });
    reason.placeholder = 'e.g. below poverty line, approved by the Medical Superintendent';
    panel.append(el('div', 'font-size:12px;color:var(--text-mid);margin-bottom:6px',
      `Suggested deposit ${_rs(advice.suggested_deposit)} (${payerLabel(advice.payer_type || 'self_pay')}). Only the Finance Manager, the Medical Superintendent or the Super Admin can waive it; the waiver is in the monthly waiver report.`),
      field('Reason (required, 5 to 500 characters)', reason));
    const go = btn('Waive the deposit', 'var(--gold)');
    go.addEventListener('click', () => guard(go, async () => {
      if (reason.value.trim().length < 5) { status(msg, 'Give the reason for waiving the deposit (at least 5 characters).', false); return; }
      const args = advice.kind === 'admission'
        ? { p_advice_id: null, p_admission_id: advice.id, p_reason: reason.value.trim() }
        : { p_advice_id: advice.id, p_admission_id: null, p_reason: reason.value.trim() };
      const { data, error } = await supabase.rpc('waive_admission_deposit', args);
      if (error || !data) { status(msg, safeErrorMessage(error, 'Could not waive the deposit.'), false); return; }
      status(msg, '✓ Deposit waived — recorded with your name and the reason.', true);
      onDone?.();
    }));
    actions.append(go);
  }
  actions.append(btn('Close', null, () => onClose?.()));
  panel.append(msg, actions);
  noAutofill(panel, 'axp');   // Session 358 (§285): Payer & insurance -- no browser autofill (company, policy, member id)
  return panel;
}

// May this signed-in person waive a deposit (the button only -- the server decides)?
export const canWaiveDeposit = p => !!p && p.status === 'active' && (p.role === 'super_admin' || p.role === 'finance_manager'
  || p.secondary_role === 'finance_manager' || p.designation === 'medical_superintendent');
export const isAdmissionOverseer = p => !!p && p.status === 'active' && (p.role === 'super_admin' || p.designation === 'medical_superintendent');
// Session 357c (B5, owner 25 Oct 2026): who may read the deposit-waiver report (the button only -- list_deposit_waivers decides)
export const canSeeWaiverReport = p => isAdmissionOverseer(p) || (!!p && p.status === 'active'
  && (p.role === 'finance_manager' || p.secondary_role === 'finance_manager'));
