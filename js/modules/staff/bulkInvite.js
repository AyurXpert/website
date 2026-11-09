// bulkInvite.js -- Admin → HR → 📨 Bulk invite (Session 366, TODO §351; owner answers Q4 / Q5 / Q9 / Q10 / Q13). Super Admin only
// (the server refuses anyone else).
//   1. Download a CSV template: one row per open position of the NCISM ladder (department, designation, role filled; name / phone /
//      email blank), or a blank one.
//   2. Upload it -> the CHECK screen: parsed here, then preview_position_invites() on the server (nothing saved). Every row OK or its
//      errors; Create stays disabled while ANY row has an error or the staff limit would be passed (the whole file or nothing).
//   3. Create -> create_position_invites_bulk() (one batch, 14-day links).
//   4. Email all (send-staff-invites, the server re-checks) · WhatsApp per row (wa.me, from the user's click) · Download links (CSV).
//   5. Pending invites of the organisation: status (pending / expired), expiry, last e-mailed; Re-send (a NEW link, the old one stops),
//      Email, WhatsApp, Copy, Cancel.
// The CSV never carries a second role, monitoring access or a department scope (Q10) -- those stay single invites.
// Session 383 (§372 + owner item 3, D6-D8): an Excel (.xlsx) template made for THIS organisation with dropdowns (its departments, its
// non-powerful positions by readable name, the roles); .xlsx or .csv upload -> the on-screen TABLE (inviteTable.js) with the same
// dropdowns per row, "+ Add row" and paste from Excel; a value that is not an exact match is red and must be picked; then the same
// server Check -> Create. Powerful roles / positions and interns / PG scholars are invited one at a time.
// DOM nodes + textContent only; no confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js';
import { DESIG_MAP } from '../../config/designations.js';
import { BTN, BTN_OUT, inviteLink, inviteMessage, whatsAppButton, emailInvites, fmtDate } from './staffContacts.js';
import { inviteLists, templateSheets, rawRows, mountInviteTable, COLS } from './inviteTable.js';
import { xlsxBlob, downloadBlob } from '../../utils/xlsxWriter.js';
import { readXlsxRows } from '../../utils/xlsxReader.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
export const CSV_COLUMNS = ['department', 'designation', 'role', 'full_name', 'phone', 'email'];
const RED = 'var(--red,#c0392b)';

// ── CSV (RFC 4180: quotes, doubled quotes, commas / newlines inside quotes, CRLF, a UTF-8 BOM) ──
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}
// a spreadsheet must never run a cell as a formula (CSV injection): a leading = + - @ (or tab / CR) gets a quote mark in front
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCsv(rows) { return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

// the file -> row objects (+ the problems found here: missing / unknown columns, unknown designation keys)
export function rowsFromCsv(text) {
  const all = parseCsv(text);
  if (!all.length) return { rows: [], problem: 'The file is empty.' };
  const head = all[0].map(h => String(h).trim().toLowerCase());
  const missing = CSV_COLUMNS.filter(c => !head.includes(c));
  if (missing.length) return { rows: [], problem: `The first line must name the columns: ${CSV_COLUMNS.join(', ')} (missing: ${missing.join(', ')}).` };
  const extra = head.filter(h => h && !CSV_COLUMNS.includes(h));
  const rows = all.slice(1).map(r => {
    const o = {};
    // every named column is sent: an extra one such as secondary_role is refused by the server (Q10), never silently dropped
    head.forEach((h, i) => { const v = String(r[i] ?? '').trim(); if (v && h) o[h] = v; });
    return o;
  });
  return { rows, extra };
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const posLabel = k => DESIG_MAP[k]?.l || k || '—';

/** mountBulkInvite(box, { supabase, tenantName, isNcism, templateRows, depts, roles: [{key,label}], defaultRole(desig), toast, onChange }) */
export async function mountBulkInvite(box, opts) {
  const { supabase, tenantName, toast } = opts;
  const lists = inviteLists({ depts: opts.depts || [], roles: opts.roles || [] });
  const defaultRole = opts.defaultRole || (() => '');
  const deptLabel = id => lists.depts.find(d => d.id === id)?.label || '';
  const roleLabel = k => lists.roles.find(r => r.key === k)?.label || k || '';
  box.replaceChildren();
  const card = mk('div', 'background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:16px');
  card.append(mk('div', "font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--green-deep);margin-bottom:6px", '📨 Bulk invite'),
    mk('p', 'font-size:13px;color:var(--text-mid);margin:0 0 12px',
      'Invite many staff at once: download the Excel template (dropdowns for Department, Position and Role), fill it, upload it — or add / paste '
      + 'rows in the table below. Each person gets their own join link (works 14 days, used once) by email or WhatsApp. After they sign up, '
      + 'approve them in Login Access. Powerful positions (Medical Superintendent, Finance Manager …), a second role, monitoring access, a '
      + 'department scope and interns / PG scholars are invited one at a time (＋ Invite one person). In the table, a row’s Position must be one '
      + 'of its department’s positions (leave the department empty for an exception).'),
    // Session 383 (owner, rehearsal 9 Nov): Excel opens a downloaded file in Protected View, where the dropdowns do not open
    mk('p', 'font-size:12.5px;color:#7a5a10;background:#fdf3e0;border:1px solid #e8d5a0;border-radius:8px;padding:8px 10px;margin:0 0 12px',
      'If the dropdowns don’t open in Excel, click “Enable Editing” at the top of the Excel window (Excel opens downloaded files in Protected View).'));
  const bar = mk('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center');
  // the open positions of the NCISM ladder, in readable names (pre-filled rows)
  const openRows = async () => {
    const rows = await opts.templateRows();
    const out = [];
    rows.forEach(r => {
      if (!lists.positions.some(p => p.key === r.designation)) return;   // powerful / trainee positions: one at a time
      for (let i = 0; i < r.count; i++) out.push({ dept: r.department || '', pos: posLabel(r.designation), role: roleLabel(r.role) });
    });
    return out;
  };
  const xl = mk('button', BTN_OUT, opts.isNcism ? '⬇ Excel template — open positions' : '⬇ Excel template'); xl.type = 'button'; xl.id = 'bulk-xlsx-template';
  xl.addEventListener('click', async () => {
    xl.disabled = true;
    try {
      const pre = opts.isNcism ? await openRows() : [];
      downloadBlob(xlsxBlob(templateSheets(lists, pre)), opts.isNcism ? 'staff_invites_open_positions.xlsx' : 'staff_invites.xlsx');
      toast?.(pre.length ? `Excel template with ${pre.length} open position(s) downloaded` : 'Excel template downloaded');
    } finally { xl.disabled = false; }
  });
  const blank = mk('button', BTN_OUT, '⬇ CSV template'); blank.type = 'button';
  blank.addEventListener('click', () => download('staff_invites_blank.csv', toCsv([COLS,
    [lists.depts[0]?.label || '', posLabel('staff_nurse'), roleLabel('nurse'), 'Example Name', '9876543210', 'name@example.com']])));
  const fileLbl = mk('label', BTN + ';display:inline-flex;align-items:center', '⬆ Upload filled Excel / CSV');
  const file = mk('input'); file.type = 'file'; file.accept = '.xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  file.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0';
  fileLbl.append(file);
  bar.append(xl, blank, fileLbl);
  card.append(bar);
  const fileMsg = mk('div', 'font-size:13px;margin-top:8px'); fileMsg.setAttribute('role', 'status');
  const tableBox = mk('div', 'margin-top:10px');
  card.append(fileMsg, tableBox);
  const result = mk('div', 'margin-top:14px'); result.setAttribute('aria-live', 'polite');
  card.append(result);
  const pendingBox = mk('div');
  box.append(card, pendingBox);
  // Session 383 (owner, rehearsal step 9): any change to the rows clears the old server check -- "Check the rows" again; a check still
  // running when the rows change is thrown away when it answers
  let checkGen = 0;
  const table = mountInviteTable(tableBox, { lists, defaultRole, rows: [], onCheck: rows => check(rows, []),
    onChange: () => { checkGen++; result.replaceChildren(); } });

  file.addEventListener('change', async () => {
    const f = file.files?.[0]; file.value = '';
    if (!f) return;
    fileMsg.style.color = 'var(--text-mid)'; fileMsg.textContent = '';
    if (f.size > 2_000_000) { fileMsg.style.color = RED; fileMsg.textContent = 'The file is too large (at most 300 rows).'; return; }
    let grid;
    try {
      grid = /\.xlsx$/i.test(f.name) ? await readXlsxRows(await f.arrayBuffer()) : parseCsv(await f.text());
    } catch (e) { fileMsg.style.color = RED; fileMsg.textContent = e?.message || 'The file could not be read.'; return; }
    const r = rawRows(grid);
    if (r.problem) { fileMsg.style.color = RED; fileMsg.textContent = r.problem; return; }
    table.clear(); table.addRaw(r.rows); result.replaceChildren();
    fileMsg.textContent = `${r.rows.length} row(s) read from ${f.name} — correct any red cell, then Check the rows.`
      + (r.skipped ? ` ${r.skipped} template row(s) with no name, phone or email were left out (not invited).` : '');
  });

  async function check(rows, extraCols) {
    const gen = ++checkGen;
    result.replaceChildren(mk('div', 'font-size:13px;color:var(--text-muted)', 'Checking…'));
    const { data, error } = await supabase.rpc('preview_position_invites', { p_rows: rows });
    if (gen !== checkGen) return;   // the rows changed while the server was checking: this answer is old
    if (error) { result.replaceChildren(mk('div', `color:${RED};font-size:13px`, safeErrorMessage(error, 'The file could not be checked.'))); return; }
    // the page's own check: a designation key the HMS does not know
    (data.rows || []).forEach(r => { if (r.designation && !DESIG_MAP[r.designation]) r.errors = [...(r.errors || []), `Unknown position "${r.designation}".`]; });
    const bad = (data.rows || []).filter(r => r.errors?.length).length;
    const wrap = mk('div');
    const lim = data.limit || {};
    const sum = mk('div', 'font-size:13px;margin-bottom:8px;color:var(--text-dark)',
      `${data.row_count} row(s) · ${bad ? bad + ' with an error' : 'no errors'}`
      + (lim.unlimited ? '' : ` · staff after this file: ${data.after} of ${lim.max}`));
    wrap.append(sum);
    if (extraCols.length) wrap.append(mk('div', 'font-size:12.5px;color:#7a5a10;margin-bottom:6px', `Columns not used: ${extraCols.join(', ')}.`));
    if (data.limit_error) wrap.append(mk('div', `font-size:13px;color:${RED};font-weight:600;margin-bottom:6px`, data.limit_error));
    else if (data.limit_warning) wrap.append(mk('div', 'font-size:12.5px;color:#7a5a10;margin-bottom:6px', `Warning: the organisation will be at ${Math.round(100 * data.after / lim.max)} % of its staff limit (${lim.max}).`));
    const tw = mk('div', 'overflow-x:auto');
    const tbl = mk('table', 'width:100%;border-collapse:collapse;font-size:12.5px');
    const hr = mk('tr'); ['#', 'Name', 'Position', 'Department', 'Role', 'Phone', 'Email', 'Check'].forEach(h => hr.append(mk('th', 'text-align:left;padding:6px;border-bottom:1.5px solid var(--border)', h)));
    tbl.append(hr);
    const deptName = id => (opts.depts || []).find(d => d.id === id)?.name || '';
    (data.rows || []).forEach(r => {
      const tr = mk('tr', r.errors?.length ? 'background:#fff0f0' : '');
      [String(r.n), r.candidate_name || '—', posLabel(r.designation), r.department_id ? (deptName(r.department_id) || deptLabel(r.department_id)) : '—', roleLabel(r.role) || '—', r.phone || '—', r.email || '—']
        .forEach(v => tr.append(mk('td', 'padding:6px;border-bottom:1px solid var(--border);vertical-align:top', v)));
      const st = mk('td', 'padding:6px;border-bottom:1px solid var(--border);vertical-align:top');
      if (r.errors?.length) r.errors.forEach(e => st.append(mk('div', `color:${RED}`, '✗ ' + e))); else st.append(mk('span', 'color:#2d7a4f;font-weight:600', '✓ OK'));
      tr.append(st); tbl.append(tr);
    });
    tw.append(tbl); wrap.append(tw);
    // Session 383 (owner, rehearsal step 9): with an error the button says what to do, not how many would be created
    const go = mk('button', BTN + ';margin-top:12px', bad ? `Fix ${bad} row(s) first` : `Create ${data.row_count} invite(s)`); go.type = 'button';
    go.disabled = !!bad || !!data.limit_error;
    if (go.disabled) wrap.append(mk('div', 'font-size:12.5px;color:var(--text-muted);margin-top:8px', 'Correct the rows marked ✗ in the table above (or in the spreadsheet) and check again — nothing is saved until every row is OK.'));
    go.addEventListener('click', async () => {
      go.disabled = true;
      const { data: made, error: e } = await supabase.rpc('create_position_invites_bulk', { p_rows: rows });
      if (e) { go.disabled = false; toast?.(safeErrorMessage(e, 'The invites could not be created.'), true); return; }
      toast?.(`✓ ${made.count} invite(s) created`);
      table.clear(); fileMsg.textContent = '';
      showCreated(made, data.rows);
      opts.onChange?.();
      loadPending();
    });
    wrap.append(go);
    result.replaceChildren(wrap);
  }

  function inviteActions(inv, cellWrap) {
    const link = inviteLink(inv.token);
    const copy = mk('button', BTN_OUT, '📋 Copy link'); copy.type = 'button';
    copy.addEventListener('click', () => navigator.clipboard.writeText(link).then(() => toast?.('Link copied!')).catch(() => toast?.('Could not copy — select the link text.', true)));
    cellWrap.append(copy);
    const wa = whatsAppButton(inv.phone, inviteMessage({ orgName: tenantName, name: inv.candidate_name, position: posLabel(inv.designation), link, expiresAt: inv.expires_at }));
    if (wa) cellWrap.append(wa);
    if (inv.email) {
      const em = mk('button', BTN_OUT, '📧 Email'); em.type = 'button';
      em.addEventListener('click', async () => { em.disabled = true; const r = await emailInvites(supabase, [inv.id]); em.disabled = false; toast?.(r.text, !r.ok); loadPending(); });
      cellWrap.append(em);
    }
  }

  function showCreated(made, checkedRows) {
    const byN = new Map((checkedRows || []).map(r => [r.n, r]));
    const list = (made.invites || []).map(i => ({ ...byN.get(i.n), id: i.id, token: i.token, expires_at: made.expires_at }));
    const wrap = mk('div');
    wrap.append(mk('div', 'font-size:13.5px;font-weight:600;color:var(--green-deep);margin-bottom:6px', `✓ ${list.length} invite(s) created — links work until ${fmtDate(made.expires_at)}`));
    const bar = mk('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px');
    const withEmail = list.filter(i => i.email);
    const all = mk('button', BTN, `📧 Email all (${withEmail.length} with an email)`); all.type = 'button'; all.disabled = !withEmail.length;
    all.addEventListener('click', async () => { all.disabled = true; const r = await emailInvites(supabase, withEmail.map(i => i.id)); toast?.(r.text, !r.ok); all.disabled = false; loadPending(); });
    const csv = mk('button', BTN_OUT, '⬇ Download links (CSV)'); csv.type = 'button';
    csv.addEventListener('click', () => download('staff_invite_links.csv', toCsv([['name', 'phone', 'email', 'position', 'link', 'expires'],
      ...list.map(i => [i.candidate_name || '', i.phone || '', i.email || '', posLabel(i.designation), inviteLink(i.token), fmtDate(i.expires_at)])])));
    bar.append(all, csv);
    wrap.append(bar, mk('div', 'font-size:12px;color:#7a5a10;margin-bottom:8px', '⚠️ The links file holds live join links — share it only with the people invited, and delete it after use.'));
    const noEmail = list.filter(i => !i.email);
    if (noEmail.length) wrap.append(mk('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:8px', `${noEmail.length} invite(s) have no email — send them by WhatsApp or copy the link.`));
    list.forEach(i => {
      const row = mk('div', 'border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px');
      row.append(mk('div', 'font-weight:600;font-size:13px', `${i.candidate_name || 'Unnamed'} — ${posLabel(i.designation)}`),
        mk('div', 'font-size:11.5px;color:var(--text-muted);margin-bottom:6px', [i.phone, i.email].filter(Boolean).join(' · ')));
      const acts = mk('div', 'display:flex;gap:6px;flex-wrap:wrap'); inviteActions(i, acts); row.append(acts);
      wrap.append(row);
    });
    result.replaceChildren(wrap);
  }

  async function loadPending() {
    const { data, error } = await supabase.from('position_invites')
      .select('id,token,designation,department_id,candidate_name,phone,email,status,expires_at,last_sent_at,send_count,created_at,batch_id')
      .eq('status', 'pending').order('created_at', { ascending: false }).limit(500);
    pendingBox.replaceChildren();
    const card2 = mk('div', 'background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px 18px');
    card2.append(mk('div', "font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:600;color:var(--green-deep);margin-bottom:8px", '🔗 Pending invites'));
    if (error) { card2.append(mk('div', `color:${RED};font-size:13px`, safeErrorMessage(error, 'Could not load the invites.'))); pendingBox.append(card2); return; }
    if (!data?.length) { card2.append(mk('div', 'font-size:13px;color:var(--text-muted)', 'No pending invites.')); pendingBox.append(card2); return; }
    const now = Date.now();
    data.forEach(inv => {
      const expired = !inv.expires_at || new Date(inv.expires_at).getTime() <= now;
      const row = mk('div', 'border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px' + (expired ? ';background:#fff8e6' : ''));
      row.append(mk('div', 'font-weight:600;font-size:13px', `${inv.candidate_name || 'Unnamed'} — ${posLabel(inv.designation)}`),
        mk('div', 'font-size:11.5px;color:var(--text-muted)', [inv.phone, inv.email].filter(Boolean).join(' · ')),
        mk('div', 'font-size:11.5px;margin:2px 0 6px;color:' + (expired ? '#7a5a10' : 'var(--text-mid)'),
          (expired ? `⏰ Expired ${fmtDate(inv.expires_at)} — re-send makes a new link` : `Pending · works until ${fmtDate(inv.expires_at)}`)
          + (inv.last_sent_at ? ` · e-mailed ${fmtDate(inv.last_sent_at)} (${inv.send_count}×)` : ' · not e-mailed yet')));
      const acts = mk('div', 'display:flex;gap:6px;flex-wrap:wrap');
      if (!expired) inviteActions(inv, acts);
      const rs = mk('button', BTN_OUT, '🔄 Re-send (new link)'); rs.type = 'button';
      rs.addEventListener('click', async () => {
        rs.disabled = true;
        const { data: nd, error: e } = await supabase.rpc('resend_position_invite', { p_invite_id: inv.id });
        if (e) { rs.disabled = false; toast?.(safeErrorMessage(e, 'Could not re-send the invite.'), true); return; }
        toast?.('New link made — the old link no longer works');
        if (inv.email) { const r = await emailInvites(supabase, [inv.id]); toast?.(r.text, !r.ok); }
        void nd; loadPending();
      });
      const cx = mk('button', BTN_OUT + ';color:#c0392b;border-color:#e0b0b0', 'Cancel invite'); cx.type = 'button';
      cx.addEventListener('click', async () => {
        if (cx.dataset.sure !== '1') { cx.dataset.sure = '1'; cx.textContent = 'Click again to cancel'; return; }
        cx.disabled = true;
        const { error: e } = await supabase.rpc('revoke_position_invite', { p_invite_id: inv.id });
        if (e) { cx.disabled = false; toast?.(safeErrorMessage(e, 'Could not cancel the invite.'), true); return; }
        toast?.('Invite cancelled.'); loadPending(); opts.onChange?.();
      });
      acts.append(rs, cx); row.append(acts);
      card2.append(row);
    });
    pendingBox.append(card2);
  }
  loadPending();
}
