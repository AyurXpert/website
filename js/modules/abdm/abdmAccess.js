// abdmAccess.js -- subscription.html → "🏛️ ABDM access" (Session 379a, owner 7 Nov 2026). Which organisations may use ABDM. Not set = OFF. Only an ACTIVE platform admin changes it,
// with a reason (platform_set_abdm_access re-checks and audits): an owner-approved exception to "organisation settings belong to that organisation's Super Admin". An HFR ID alone
// opens nothing. DOM nodes + textContent only; one click handler per button.
import { safeErrorMessage } from '../../utils/errors.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const inputCss = "width:100%;box-sizing:border-box;min-height:44px;padding:0 10px;border:1.5px solid var(--border);border-radius:8px;font:14px 'DM Sans',sans-serif";
const btnCss = on => "min-height:44px;padding:0 14px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;"
  + (on ? 'background:#fff;color:var(--red,#c0392b);border:1.5px solid var(--red,#c0392b)' : 'background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)');
const cellCss = 'padding:8px 10px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle';

// The answer to a press sits directly under that organisation's row (7 Nov 2026, owner's rehearsal: one small line above the table was not seen). Never colour alone: ✅ / ⚠️ + words.
function showRowMessage(cell, ok, text) {
  cell.textContent = `${ok ? '✅' : '⚠️'} ${text}`;
  cell.setAttribute('role', ok ? 'status' : 'alert');
  cell.dataset.result = ok ? 'ok' : 'refused';
  cell.style.cssText = 'padding:10px 12px;font-size:14px;font-weight:600;line-height:1.4;border-bottom:1px solid var(--border);'
    + (ok ? 'color:var(--green-deep);background:#e8f5ee' : 'color:var(--red,#c0392b);background:#fdecea');
  cell.parentElement.style.display = '';
  cell.parentElement.scrollIntoView({ block: 'nearest' });
}

/** renderAbdmAccess(box, { supabase, flash }): flash = { code, ok, text }, the answer to show under that organisation's row after a change */
export async function renderAbdmAccess(box, { supabase, flash = null }) {
  if (!box) return;
  if (!flash) box.replaceChildren(mk('div', 'color:var(--text-muted);font-size:13px', 'Loading…'));
  const { data: rows, error } = await supabase.from('tenants').select('id, name, tenant_code, type, hfr_id, modules').neq('type', 'platform').order('name');
  if (error) {
    const lines = [mk('div', 'font-size:13px;color:var(--red,#c0392b)', `⚠️ ${safeErrorMessage(error, 'Could not load the organisations.')}`)];
    if (flash) lines.unshift(mk('div', 'font-size:14px;font-weight:600;color:var(--green-deep);margin-bottom:8px', `✅ ${flash.text}`));
    box.replaceChildren(...lines); return;
  }

  const intro = mk('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:14px;line-height:1.5',
    'ABDM is off for every organisation unless it is opened here. An organisation that is off sees "ABDM — coming soon" and the server refuses it, even if it holds an HFR ID.');
  const tw = mk('div', 'overflow-x:auto');
  const tbl = mk('table', 'width:100%;border-collapse:collapse');
  const hd = mk('tr');
  for (const h of ['Organisation', 'Code', 'ABDM', 'HFR ID held', 'Reason (required)', '']) hd.append(mk('th', 'text-align:left;padding:8px 10px;font-size:12px;border-bottom:1.5px solid var(--border)', h));
  tbl.append(hd);
  let flashCell = null;
  for (const t of rows || []) {
    const on = t.modules?.abdm === true;
    const tr = mk('tr'); tr.dataset.code = t.tenant_code || '';
    const reason = mk('input', inputCss); reason.type = 'text'; reason.maxLength = 300; reason.autocomplete = 'off'; reason.setAttribute('aria-label', `Reason for ${t.name}`);
    const b = mk('button', btnCss(on), on ? 'Close ABDM' : 'Open ABDM'); b.type = 'button';
    const msgRow = mk('tr'); msgRow.style.display = 'none'; msgRow.dataset.msgFor = t.tenant_code || '';
    const msg = mk('td'); msg.colSpan = 6; msgRow.append(msg);
    b.addEventListener('click', async () => {
      msgRow.style.display = 'none';
      b.disabled = true;
      const { data, error: e } = await supabase.rpc('platform_set_abdm_access', { p_tenant: t.id, p_on: !on, p_reason: reason.value });
      b.disabled = false;
      if (e) { showRowMessage(msg, false, safeErrorMessage(e, 'Could not change ABDM access.')); reason.focus(); return; }
      await renderAbdmAccess(box, { supabase, flash: { code: t.tenant_code || '', ok: true, text: `${t.name}: ABDM ${data.abdm ? 'open' : 'closed'}.` } });
    });
    const cReason = mk('td', cellCss); cReason.append(reason);
    const cBtn = mk('td', cellCss); cBtn.append(b);
    tr.append(mk('td', cellCss, t.name), mk('td', cellCss, t.tenant_code || '—'), mk('td', `${cellCss};font-weight:600`, on ? 'ON' : 'OFF'), mk('td', cellCss, t.hfr_id ? 'Yes' : 'No'), cReason, cBtn);
    tbl.append(tr, msgRow);
    if (flash && flash.code === (t.tenant_code || '')) flashCell = msg;
  }
  tw.append(tbl);
  box.replaceChildren(intro, tw);
  if (flashCell) showRowMessage(flashCell, flash.ok, flash.text);
}
