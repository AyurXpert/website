// overflowSetting.js -- Admin → 🔧 Feature Modules → "⏱ Screening: show a waiting patient to every counter after N minutes"
// (Session 375, TODO §407, owner Q5). A patient waiting this long at Screening appears for EVERY active counter, marked "Waiting N min"
// (server: screening_queue_today). Not set = 10 minutes; 3–60; only the organisation's ACTIVE Super Admin changes it, with a reason
// (set_screening_overflow_minutes, audited; the key is in the modules guard). Everyone else reads. DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const BTN = "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;";

// the minutes box -> { minutes, error }
export function validateOverflowMinutes(raw) {
  const t = String(raw ?? '').trim();
  const n = Number(t);
  if (t === '' || !Number.isInteger(n) || n < 3 || n > 60) return { minutes: null, error: 'Choose between 3 and 60 minutes.' };
  return { minutes: n, error: null };
}

/** renderOverflowSetting(box, { supabase, toast }) */
export async function renderOverflowSetting(box, { supabase, toast }) {
  if (!box) return;
  const { data, error } = await supabase.rpc('screening_overflow_setting');
  box.hidden = false;
  if (error || !data) {
    box.replaceChildren(mk('div', 'font-size:12.5px;color:var(--red,#c0392b);margin-bottom:18px', safeErrorMessage(error, 'Could not load the Screening waiting time.')));
    return;
  }
  const card = mk('div', 'border-radius:8px;padding:14px 16px;margin-bottom:18px;border:1.5px solid var(--green-mid,#2d6a4f);background:#f4f8f5');
  card.id = 'screening-overflow-card';
  card.append(mk('div', 'font-weight:600;font-size:14px;color:var(--green-deep,#1a4a2e);margin-bottom:4px', '⏱ Screening: waiting time before every counter sees a patient'),
    mk('div', 'font-size:12.5px;color:var(--text-mid,#4a4a4a);margin-bottom:10px',
      `Each Screening counter sees its own share of the waiting patients. A patient waiting longer than this appears for every active counter, marked "Waiting N min". Now: ${data.minutes} minutes${data.is_set ? '' : ' (the default)'}.`));
  if (!data.can_change) {
    card.append(mk('div', 'font-size:12px;color:var(--text-muted,#6b6b6b)', 'Only the Super Admin can change it.'));
    box.replaceChildren(card);
    return;
  }
  const row = mk('div', 'display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end');
  const f1 = mk('div', 'display:flex;flex-direction:column;gap:4px');
  const l1 = mk('label', 'font-size:12px;font-weight:600', 'Minutes (3–60)'); l1.htmlFor = 'sof-minutes';
  const inp = mk('input', 'min-height:44px;width:90px;padding:0 8px;font:inherit'); inp.id = 'sof-minutes'; inp.type = 'number'; inp.min = '3'; inp.max = '60'; inp.step = '1';
  inp.value = String(data.minutes);
  f1.append(l1, inp);
  const f2 = mk('div', 'display:flex;flex-direction:column;gap:4px;flex:1;min-width:220px');
  const l2 = mk('label', 'font-size:12px;font-weight:600', 'Reason (5 to 300 characters)'); l2.htmlFor = 'sof-reason';
  const reason = mk('input', 'min-height:44px;padding:0 8px;font:inherit'); reason.id = 'sof-reason'; reason.type = 'text'; reason.maxLength = 300;
  f2.append(l2, reason);
  const save = mk('button', BTN + 'border:none;background:var(--green-deep,#1a4a2e);color:#fff', 'Save'); save.type = 'button';
  const reset = mk('button', BTN + 'border:1px solid var(--border,#d8d2c4);background:#fff', 'Back to 10 (default)'); reset.type = 'button';
  const msg = mk('div', 'font-size:12.5px;width:100%;min-height:1em;color:var(--red,#c0392b)'); msg.setAttribute('role', 'status');
  row.append(f1, f2, save, reset, msg);
  card.append(row);
  const send = async minutes => {
    const r = reason.value.trim();
    if (r.length < 5 || r.length > 300) { msg.textContent = 'Give a reason (5 to 300 characters).'; reason.focus(); return; }
    save.disabled = reset.disabled = true;
    const { error: e } = await supabase.rpc('set_screening_overflow_minutes', { p_minutes: minutes, p_reason: r });
    save.disabled = reset.disabled = false;
    if (e) { msg.textContent = safeErrorMessage(e, 'Could not save the waiting time.'); return; }
    toast?.('Screening waiting time saved.');
    await renderOverflowSetting(box, { supabase, toast });
  };
  save.addEventListener('click', () => {
    const v = validateOverflowMinutes(inp.value);
    if (v.error) { msg.textContent = v.error; inp.focus(); return; }
    send(v.minutes);
  });
  reset.addEventListener('click', () => send(null));
  box.replaceChildren(card);
}
