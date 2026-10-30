// abdmShareSetting.js -- Admin → 🔧 Feature Modules → "🔗 Share health records via ABDM" (Session 367, TODO §332). One
// per-organisation switch: may ABDM requests receive this organisation's patients' health records? Not set = OFF (owner, 29 Oct
// 2026, Q4). OFF = abdm-hip builds and pushes nothing (ABDM is told FAILED); linking, ABHA verification and consents still work.
// Only this organisation's own ACTIVE Super Admin changes it, with a reason (set_abdm_share_records re-checks and audits);
// everyone else reads. Saved at once, never by the Feature Modules grid. DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const btnCss = on => "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;"
  + (on ? 'background:#fff;color:var(--red,#c0392b);border:1.5px solid var(--red,#c0392b)' : 'background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)');

/** renderAbdmShareSetting(box, { supabase, role, tenantId, toast }) */
export async function renderAbdmShareSetting(box, { supabase, role, tenantId, toast }) {
  if (!box) return;
  const { data: t, error } = await supabase.from('tenants').select('modules').eq('id', tenantId).single();
  box.hidden = false;
  if (error || !t) {
    box.replaceChildren(mk('div', 'font-size:12.5px;color:var(--red,#c0392b);margin-bottom:18px', safeErrorMessage(error, 'Could not load the ABDM sharing setting.')));
    return;
  }
  const on = t.modules?.abdm_share_records === true;
  const canChange = role === 'super_admin';
  const card = mk('div', 'border-radius:8px;padding:14px 16px;margin-bottom:18px;border:1.5px solid #a5d6b8;background:#f0fff4');
  card.append(mk('div', 'font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:8px', '🔗 Share health records via ABDM'));
  const r = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap');
  const txt = mk('div', 'flex:1;min-width:220px');
  txt.append(mk('div', 'font-weight:600;font-size:13px;color:var(--text-dark,#1a1a1a)', on ? 'ON — records are shared' : 'OFF — no records are shared'),
    mk('div', 'font-size:12.5px;color:var(--text-mid);margin-top:2px', on
      ? "When a patient's consent asks for records, they are sent — only to ABDM or a trusted address, only the visits the consent names."
      : 'Requests for records are refused (ABDM is told). ABHA verification, linking and consents keep working.'));
  r.append(txt);
  card.append(r);
  const status = mk('div', 'font-size:12.5px;min-height:1em;margin-top:6px'); status.setAttribute('role', 'status');
  if (canChange) {
    const row = mk('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:10px');
    const lab = mk('label', 'flex:1;min-width:220px;font-size:12.5px;color:var(--text-mid)', 'Reason for the change (required)');
    const inp = mk('input', 'display:block;width:100%;box-sizing:border-box;min-height:44px;margin-top:4px;padding:0 10px;border:1.5px solid var(--border,#d6d0c4);border-radius:8px;font:14px \'DM Sans\',sans-serif');
    inp.type = 'text'; inp.maxLength = 300; inp.autocomplete = 'off';
    lab.append(inp);
    const b = mk('button', btnCss(on), on ? 'Switch OFF' : 'Switch ON'); b.type = 'button';
    b.addEventListener('click', async () => {
      const reason = inp.value.trim();
      if (reason.length < 5) { status.style.color = 'var(--red,#c0392b)'; status.textContent = 'Please give a reason (at least 5 characters).'; inp.focus(); return; }
      b.disabled = true;
      const { data, error: e } = await supabase.rpc('set_abdm_share_records', { p_on: !on, p_reason: reason });
      if (e || !data) { b.disabled = false; status.style.color = 'var(--red,#c0392b)'; status.textContent = safeErrorMessage(e, 'Could not save the setting.'); return; }
      toast?.(`✓ ABDM record sharing switched ${on ? 'OFF' : 'ON'}`);
      renderAbdmShareSetting(box, { supabase, role, tenantId, toast });
    });
    row.append(lab, b);
    card.append(row);
  } else {
    card.append(mk('div', 'font-size:12px;color:var(--text-muted);margin-top:6px', "Only this organisation's Super Admin can change this."));
  }
  card.append(status);
  box.replaceChildren(card);
}
