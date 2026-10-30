// abdmPushHosts.js -- subscription.html → "🔗 ABDM push hosts" (Session 367, TODO §332, owner Q3). The list of hospital (HIU) addresses
// our records may be pushed to, besides ABDM's own (abdm.gov.in, always allowed) and our own transfer address. Only an ACTIVE platform
// admin reads / adds / removes (abdm_push_hosts_list / add_abdm_push_host / remove_abdm_push_host re-check and audit); a reason is
// required; a removed host stays listed as removed (never deleted). DOM nodes + textContent only; one click handler per button.
import { safeErrorMessage } from '../../utils/errors.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const inputCss = "display:block;width:100%;box-sizing:border-box;min-height:44px;margin-top:4px;padding:0 10px;border:1.5px solid var(--border,#d6d0c4);border-radius:8px;font:14px 'DM Sans',sans-serif";
const btnCss = "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)";
const fmt = d => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** renderAbdmPushHosts(box, { supabase, toast }) */
export async function renderAbdmPushHosts(box, { supabase, toast }) {
  if (!box) return;
  box.replaceChildren(mk('div', 'color:var(--text-muted);font-size:13px', 'Loading…'));
  const { data: rows, error } = await supabase.rpc('abdm_push_hosts_list');
  if (error) { box.replaceChildren(mk('div', 'font-size:13px;color:var(--red,#c0392b)', safeErrorMessage(error, 'Could not load the list.'))); return; }

  const intro = mk('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:14px;line-height:1.5',
    "Health records (and our ABDM sign-in token) are sent ONLY to ABDM's own addresses (abdm.gov.in — always allowed), to our own "
    + 'transfer address, or to a hospital address on this list. Add a host only after confirming it belongs to that hospital. Every change is audited.');
  const status = mk('div', 'font-size:12.5px;min-height:1em;margin:6px 0 12px'); status.setAttribute('role', 'status');
  const fail = (e, msg) => { status.style.color = 'var(--red,#c0392b)'; status.textContent = safeErrorMessage(e, msg); };

  // add
  const add = mk('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end');
  const lh = mk('label', 'flex:1;min-width:200px;font-size:12.5px;color:var(--text-mid)', 'Host name (e.g. hiu.example.in — no https://, no path)');
  const ih = mk('input', inputCss); ih.type = 'text'; ih.maxLength = 253; ih.autocomplete = 'off'; lh.append(ih);
  const lr = mk('label', 'flex:1;min-width:200px;font-size:12.5px;color:var(--text-mid)', 'Reason (required)');
  const ir = mk('input', inputCss); ir.type = 'text'; ir.maxLength = 300; ir.autocomplete = 'off'; lr.append(ir);
  const ba = mk('button', btnCss, '＋ Add host'); ba.type = 'button';
  ba.addEventListener('click', async () => {
    ba.disabled = true;
    const { data, error: e } = await supabase.rpc('add_abdm_push_host', { p_host: ih.value, p_reason: ir.value });
    if (e || !data) { ba.disabled = false; fail(e, 'Could not add the host.'); return; }
    toast?.('✓ Host added');
    renderAbdmPushHosts(box, { supabase, toast });
  });
  add.append(lh, lr, ba);

  // list
  const table = mk('table', 'width:100%;border-collapse:collapse;font-size:13px;margin-top:16px');
  const hr = mk('tr');
  for (const h of ['Host', 'Reason', 'Added', 'Status', '']) hr.append(mk('th', 'text-align:left;padding:8px;border-bottom:1.5px solid var(--border,#d6d0c4)', h));
  const thead = mk('thead'); thead.append(hr);
  const tbody = mk('tbody');
  if (!rows?.length) {
    const tr = mk('tr'); const td = mk('td', 'padding:16px 8px;color:var(--text-muted)', 'No hosts yet — only ABDM and our own address are allowed.');
    td.colSpan = 5; tr.append(td); tbody.append(tr);
  }
  for (const r of (rows || [])) {
    const tr = mk('tr');
    const cell = t => mk('td', 'padding:8px;border-bottom:1px solid var(--border,#ece7dc);vertical-align:top', t);
    tr.append(cell(r.host), cell(r.reason), cell(`${fmt(r.added_at)} · ${r.added_by_name ?? '—'}`),
      cell(r.removed_at ? `Removed ${fmt(r.removed_at)} · ${r.removed_by_name ?? '—'} — ${r.removed_reason ?? ''}` : 'Active'));
    const act = cell('');
    if (!r.removed_at) {
      const br = mk('button', 'min-height:44px;padding:0 12px;border-radius:8px;font:600 12.5px \'DM Sans\',sans-serif;cursor:pointer;background:#fff;color:var(--red,#c0392b);border:1.5px solid var(--red,#c0392b)', 'Remove…');
      br.type = 'button';
      br.addEventListener('click', () => {
        // in-page reason panel (no native prompt / confirm)
        const p = mk('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:6px');
        const l = mk('label', 'min-width:180px;font-size:12px;color:var(--text-mid)', 'Reason for removing');
        const i = mk('input', inputCss); i.type = 'text'; i.maxLength = 300; l.append(i);
        const ok = mk('button', btnCss, 'Remove'); ok.type = 'button';
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          const { data, error: e } = await supabase.rpc('remove_abdm_push_host', { p_id: r.id, p_reason: i.value });
          if (e || !data) { ok.disabled = false; fail(e, 'Could not remove the host.'); return; }
          toast?.('✓ Host removed');
          renderAbdmPushHosts(box, { supabase, toast });
        });
        p.append(l, ok);
        act.replaceChildren(p);
        i.focus();
      });
      act.append(br);
    }
    tr.append(act);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const wrap = mk('div', 'overflow-x:auto'); wrap.append(table);
  box.replaceChildren(intro, add, status, wrap);
}
