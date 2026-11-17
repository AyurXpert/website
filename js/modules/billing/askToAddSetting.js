// askToAddSetting.js -- Admin → 🔧 Feature Modules → "🧩 Ask to add a procedure" (Session 386b-2b M2b F24; M2c, owner 15 Nov 2026).
// One per-organisation switch, not set = OFF (internal key tenants.modules.procedure_not_in_list, setter set_procedure_not_in_list -- the
// names are kept; the meaning changed in M2c). ON: the procedure registers show "Ask to add a procedure" (a request to the Fee committee;
// nothing is recorded or billed). OFF: the button is hidden and the server refuses the request. Either way a procedure is recorded only from
// the fee list. Only this organisation's ACTIVE Super Admin changes it (the server re-checks, needs a reason and audits); everyone else
// reads. DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const btnCss = on => "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;"
  + (on ? 'background:#fff;color:var(--red,#c0392b);border:1.5px solid var(--red,#c0392b)' : 'background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)');

/** renderAskToAddSetting(box, { supabase, role, tenantId, toast }) */
export async function renderAskToAddSetting(box, { supabase, role, tenantId, toast }) {
  if (!box) return;
  const { data: t, error } = await supabase.from('tenants').select('modules').eq('id', tenantId).single();
  box.hidden = false;
  if (error || !t) {
    box.replaceChildren(mk('div', 'font-size:12.5px;color:var(--red,#c0392b);margin-bottom:18px', safeErrorMessage(error, 'Could not load the "Ask to add a procedure" setting.')));
    return;
  }
  const on = t.modules?.procedure_not_in_list === true;
  const canChange = role === 'super_admin';
  const card = mk('div', 'border-radius:8px;padding:14px 16px;margin-bottom:18px;border:1.5px solid #a5d6b8;background:#f0fff4');
  card.append(mk('div', 'font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:8px', '🧩 Ask to add a procedure'));
  const r = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap');
  const txt = mk('div', 'flex:1;min-width:220px');
  txt.append(mk('div', 'font-weight:600;font-size:13px;color:var(--text-dark,#1a1a1a)', 'Let doctors (and the nurses / therapists who record procedures) ask the Fee committee to add a procedure that is not in the fee list'),
    mk('div', 'font-size:12.5px;color:var(--text-mid);margin-top:2px', on
      ? "ON — Doctors (and the nurses / therapists who record procedures) use 'Ask to add a procedure' to ask the Fee committee to add a procedure that is not in the fee list. Nothing is recorded or billed until it is added; then they record it from the list."
      : "OFF — the 'Ask to add a procedure' button is hidden. Only procedures from the fee list can be recorded."));
  r.append(txt);
  const status = mk('div', 'font-size:12.5px;min-height:1em;margin-top:6px'); status.setAttribute('role', 'status');
  if (canChange) {
    const why = mk('input', 'min-height:44px;flex:1;min-width:200px;padding:0 10px;border:1.5px solid var(--border,#ccc);border-radius:8px');
    why.type = 'text'; why.maxLength = 300; why.placeholder = 'Reason for the change (required)'; why.setAttribute('aria-label', 'Reason for changing the Ask to add a procedure setting');
    const b = mk('button', btnCss(on), on ? 'Switch OFF' : 'Switch ON'); b.type = 'button';
    b.addEventListener('click', async () => {
      const reason = why.value.trim();
      if (reason.length < 5 || /[<>]/.test(reason)) {
        status.style.color = 'var(--red,#c0392b)'; status.textContent = 'Give a reason (5 to 300 characters, without < or >).'; return;
      }
      b.disabled = true;
      const { error: e } = await supabase.rpc('set_procedure_not_in_list', { p_on: !on, p_reason: reason });
      if (e) { b.disabled = false; status.style.color = 'var(--red,#c0392b)'; status.textContent = safeErrorMessage(e, 'Could not save the setting.'); return; }
      toast?.(`✓ "Ask to add a procedure" switched ${on ? 'OFF' : 'ON'}`);
      renderAskToAddSetting(box, { supabase, role, tenantId, toast });
    });
    r.append(why, b);
  }
  card.append(r);
  if (!canChange) card.append(mk('div', 'font-size:12px;color:var(--text-muted);margin-top:6px', "Only this organisation's Super Admin can change this."));
  card.append(status);
  box.replaceChildren(card);
}
