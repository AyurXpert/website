// selfSignupSetting.js -- Admin → 🔧 Feature Modules → "👤 Staff self-signup" (Session 366, TODO §352). One per-organisation switch:
// may people join with only the organisation code (signup.html), or only through an invite link? Not set = OFF (invite only -- the
// owner's decision of 18 Oct 2026, Q8). Only this organisation's own ACTIVE Super Admin changes it (set_self_signup re-checks and
// audits); everyone else reads. Saved at once, never by the Feature Modules grid. DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const btnCss = on => "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;"
  + (on ? 'background:#fff;color:var(--red,#c0392b);border:1.5px solid var(--red,#c0392b)' : 'background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)');

/** renderSelfSignupSetting(box, { supabase, role, tenantId, toast }) */
export async function renderSelfSignupSetting(box, { supabase, role, tenantId, toast }) {
  if (!box) return;
  const { data: t, error } = await supabase.from('tenants').select('modules').eq('id', tenantId).single();
  box.hidden = false;
  if (error || !t) {
    box.replaceChildren(mk('div', 'font-size:12.5px;color:var(--red,#c0392b);margin-bottom:18px', safeErrorMessage(error, 'Could not load the self-signup setting.')));
    return;
  }
  const on = t.modules?.self_signup === true;
  const canChange = role === 'super_admin';
  const card = mk('div', 'border-radius:8px;padding:14px 16px;margin-bottom:18px;border:1.5px solid #a5d6b8;background:#f0fff4');
  card.append(mk('div', 'font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:8px', '👤 Staff self-signup'));
  const r = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap');
  const txt = mk('div', 'flex:1;min-width:220px');
  txt.append(mk('div', 'font-weight:600;font-size:13px;color:var(--text-dark,#1a1a1a)', 'Allow self-signup (staff join with the organisation code)'),
    mk('div', 'font-size:12.5px;color:var(--text-mid);margin-top:2px', on
      ? 'ON — anyone with the organisation code can ask to join (the request still waits for approval).'
      : 'OFF — new staff join only through an invite link (HR → NCISM Requirements / 📨 Bulk invite). Invite links always work.'));
  r.append(txt);
  const status = mk('div', 'font-size:12.5px;min-height:1em;margin-top:6px'); status.setAttribute('role', 'status');
  if (canChange) {
    const b = mk('button', btnCss(on), on ? 'Switch OFF' : 'Switch ON'); b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      const { error: e } = await supabase.rpc('set_self_signup', { p_on: !on });
      if (e) { b.disabled = false; status.style.color = 'var(--red,#c0392b)'; status.textContent = safeErrorMessage(e, 'Could not save the setting.'); return; }
      toast?.(`✓ Staff self-signup switched ${on ? 'OFF' : 'ON'}`);
      renderSelfSignupSetting(box, { supabase, role, tenantId, toast });
    });
    r.append(b);
  }
  card.append(r);
  if (!canChange) card.append(mk('div', 'font-size:12px;color:var(--text-muted);margin-top:6px', "Only this organisation's Super Admin can change this."));
  card.append(status);
  box.replaceChildren(card);
}
