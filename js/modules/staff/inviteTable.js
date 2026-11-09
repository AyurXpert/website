// inviteTable.js -- Admin → HR → 📨 Bulk invite: the on-screen invite TABLE (Session 383, TODO §372 + owner item 3, decisions D6-D8).
// One row per person: Department, Position and Role are dropdowns of THIS organisation's own lists (readable names); name / phone /
// email typed. Rows come from an uploaded .xlsx / .csv, from pasted Excel rows, or from "+ Add row". A typed value is accepted only when
// it matches a list entry EXACTLY (capital letters and extra spaces ignored; the readable name or the internal key) -- anything else is
// shown in red and must be picked; nothing is ever guessed. Powerful roles / positions (_is_powerful_position, D6) and interns / PG
// scholars (invited one at a time) are not offered here. A blank Role takes the position's default role (D8), shown and changeable.
// The server re-checks every row (preview_position_invites / create_position_invites_bulk). DOM nodes + textContent only.
import { DESIGS, DESIG_MAP, isPowerfulPosition } from '../../config/designations.js';
import { designationRoleProblem } from '../../utils/staffPowers.js';
import { BTN, BTN_OUT } from './staffContacts.js';
import { positionsForDept } from '../../config/deptPositions.js';   // Session 383 (owner, rehearsal 9 Nov)

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const norm = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const RED = 'var(--red,#c0392b)';
export const TRAINEE_DESIGS = ['pg_scholar', 'intern', 'nursing_intern'];
export const TRAINEE_ROLES = ['trainee_doctor', 'student'];
export const COLS = ['Department', 'Position', 'Role', 'Full name', 'Phone', 'Email'];

// the lists offered in this organisation's template / table
export function inviteLists({ depts = [], roles = [] }) {
  return {
    depts: depts.map(d => ({ id: d.id, label: d.name, code: d.ncism_code || '', category: d.category || null })).sort((a, b) => a.label.localeCompare(b.label)),
    positions: DESIGS.filter(d => !isPowerfulPosition(null, d.v) && !TRAINEE_DESIGS.includes(d.v)).map(d => ({ key: d.v, label: d.l })),
    roles: roles.filter(r => !isPowerfulPosition(r.key, null) && !TRAINEE_ROLES.includes(r.key)),
  };
}

// one typed value -> { value, ok, note }   (value = department id / position key / role key; '' = not chosen)
export function matchCell(kind, raw, lists) {
  const v = norm(raw);
  if (kind === 'dept') {
    if (!v) return { value: '', ok: true };
    const hits = lists.depts.filter(d => norm(d.label) === v || (d.code && norm(d.code) === v) || d.id === String(raw).trim());
    if (hits.length === 1) return { value: hits[0].id, ok: true };
    return { value: '', ok: false, note: hits.length > 1 ? 'matches more than one department — choose' : 'not a department of this organisation — choose' };
  }
  if (kind === 'pos') {
    if (!v) return { value: '', ok: false, note: 'choose the position' };
    const hit = lists.positions.find(p => norm(p.label) === v || norm(p.key) === v);
    if (hit) return { value: hit.key, ok: true };
    const any = DESIGS.find(d => norm(d.l) === v || norm(d.v) === v);
    if (any && isPowerfulPosition(null, any.v)) return { value: '', ok: false, note: `${any.l}: a powerful position — invite this person one at a time` };
    if (any && TRAINEE_DESIGS.includes(any.v)) return { value: '', ok: false, note: `${any.l}: interns / PG scholars are invited one at a time` };
    return { value: '', ok: false, note: 'not a known position — choose' };
  }
  // role
  if (!v) return { value: '', ok: true, blank: true };
  const hit = lists.roles.find(r => norm(r.label) === v || norm(r.key) === v);
  if (hit) return { value: hit.key, ok: true };
  if (isPowerfulPosition(v.replace(/ /g, '_'), null) || ['dept. admin', 'dept admin', 'super admin', 'finance manager', 'nurse manager'].includes(v)) {
    return { value: '', ok: false, note: 'a powerful role — invite this person one at a time' };
  }
  return { value: '', ok: false, note: 'not a role that can be invited here — choose' };
}

// header text -> column kind (accepts the readable headers and the old CSV keys)
function headKind(h) {
  const v = norm(h).replace(/_/g, ' ');
  if (v === 'department') return 'dept';
  if (v === 'position' || v === 'designation') return 'pos';
  if (v === 'role' || v === 'hms login role') return 'role';
  if (v === 'full name' || v === 'name') return 'name';
  if (v === 'phone' || v === 'mobile') return 'phone';
  if (v === 'email' || v === 'e-mail') return 'email';
  return null;
}
// table rows (array of arrays, first = header or not) -> raw row objects { dept, pos, role, name, phone, email }
export function rawRows(grid) {
  if (!grid.length) return { rows: [], problem: 'The file is empty.' };
  let kinds = grid[0].map(headKind);
  let body = grid.slice(1);
  if (!kinds.includes('pos')) { kinds = ['dept', 'pos', 'role', 'name', 'phone', 'email']; body = grid; }   // pasted rows without a header
  else {
    // a column this table does not use (e.g. secondary_role) refuses the file -- never silently dropped (session 366 Q10)
    const extra = grid[0].filter((h, i) => String(h ?? '').trim() && !kinds[i]);
    if (extra.length) return { rows: [], problem: `Column(s) not used: ${extra.join(', ')}. A second role, monitoring access or a department scope is given one at a time (＋ Invite one person); remove the column and upload again.` };
  }
  const all = body.map(r => {
    const o = { dept: '', pos: '', role: '', name: '', phone: '', email: '' };
    kinds.forEach((k, i) => { if (k) o[k] = String(r[i] ?? '').trim(); });
    return o;
  }).filter(o => Object.values(o).some(Boolean));
  // Session 383 (owner, rehearsal 9 Nov): a template row nobody filled in (only department / position / role -- no name, phone or email)
  // is left out and counted, never invited and never blocking the others
  const rows = all.filter(o => o.name || o.phone || o.email);
  if (rows.length > 300) return { rows: [], problem: 'At most 300 rows at a time.' };
  return { rows, skipped: all.length - rows.length };
}

// a raw row -> the table's row state
export function rowState(raw, lists, defaultRole) {
  const dept = matchCell('dept', raw.dept, lists), pos = matchCell('pos', raw.pos, lists);
  let role = matchCell('role', raw.role, lists);
  if (role.blank) {
    const d = pos.ok ? defaultRole(pos.value) : '';
    role = d && lists.roles.some(r => r.key === d) ? { value: d, ok: true, auto: true } : { value: '', ok: false, note: 'choose the role' };
  }
  return { raw, dept, pos, role, name: raw.name || '', phone: raw.phone || '', email: raw.email || '' };
}
// Session 383 (owner, rehearsal 9 Nov): a row's position must be one of its department's positions (js/config/deptPositions.js);
// no department = every position. The server still decides; this only stops an obvious mistake before the check.
export function deptPositionsOf(st, lists) {
  if (!lists || !st.dept.ok || !st.dept.value) return null;
  const d = lists.depts.find(x => x.id === st.dept.value);
  return d ? positionsForDept({ ncism_code: d.code || null, category: d.category || null }) : null;
}
export function rowProblems(st, lists) {
  const p = [];
  if (!st.dept.ok) p.push('Department: ' + st.dept.note);
  if (!st.pos.ok) p.push('Position: ' + st.pos.note);
  const allowed = deptPositionsOf(st, lists);
  if (st.pos.ok && allowed && !allowed.has(st.pos.value)) {
    const dn = lists.depts.find(x => x.id === st.dept.value)?.label || 'this department';
    p.push(`Position: ${positionLabel(st.pos.value)} is not a position of ${dn} — choose another position, or another department (or none)`);
  }
  if (!st.role.ok) p.push('Role: ' + st.role.note);
  if (st.pos.ok && st.role.ok) { const r3 = designationRoleProblem(st.role.value, null, st.pos.value); if (r3) p.push('Role: ' + r3); }
  if (!st.phone.trim() && !st.email.trim()) p.push('Enter a phone number or an email.');
  return p;
}
// the row the server checks (department = its id; the server also accepts the id)
export const serverRow = st => ({ department: st.dept.value || '', designation: st.pos.value, role: st.role.value,
  full_name: st.name.trim(), phone: st.phone.trim(), email: st.email.trim() });

// the Excel template: sheet "Invites" with dropdowns, a hidden sheet "Lists" (D7)
export function templateSheets(lists, prefill = []) {
  const n = 301;
  const lrows = [['Departments', 'Positions', 'Roles']];
  const max = Math.max(lists.depts.length, lists.positions.length, lists.roles.length);
  for (let i = 0; i < max; i++) lrows.push([lists.depts[i]?.label ?? null, lists.positions[i]?.label ?? null, lists.roles[i]?.label ?? null]);
  const end = k => Math.max(2, k + 1);
  return [
    { name: 'Invites', widths: [30, 34, 24, 28, 16, 32],
      rows: [COLS, ...prefill.map(r => [r.dept || null, r.pos || null, r.role || null, r.name || null, r.phone || null, r.email || null])],
      validations: [
        { sqref: `A2:A${n}`, list: `Lists!$A$2:$A$${end(lists.depts.length)}`, prompt: 'Choose the department (or leave empty).' },
        { sqref: `B2:B${n}`, list: `Lists!$B$2:$B$${end(lists.positions.length)}`, prompt: 'Choose the position.' },
        { sqref: `C2:C${n}`, list: `Lists!$C$2:$C$${end(lists.roles.length)}`, prompt: 'Optional: empty = the position\'s usual role.' },
      ] },
    { name: 'Lists', hidden: true, rows: lrows },
  ];
}

/** mountInviteTable(box, { lists, defaultRole, rows (raw), onCheck(serverRows), onChange() }) -> { addRaw(rawRows), clear() }
 *  onChange runs after EVERY change to the rows (Session 383, owner, rehearsal step 9): the page clears an old server check then. */
export function mountInviteTable(box, { lists, defaultRole, rows = [], onCheck, onChange }) {
  let state = rows.map(r => rowState(r, lists, defaultRole));
  box.replaceChildren();
  const head = mk('div', 'font-size:13px;color:var(--text-mid);margin:6px 0 8px');
  const tw = mk('div', 'overflow-x:auto');
  const tbl = mk('table', 'width:100%;border-collapse:collapse;font-size:12.5px');
  tw.append(tbl);
  const bar = mk('div', 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center');
  const add = mk('button', BTN_OUT, '+ Add row'); add.type = 'button';
  const pasteBtn = mk('button', BTN_OUT, '📋 Paste rows from Excel'); pasteBtn.type = 'button';
  const check = mk('button', BTN, 'Check the rows'); check.type = 'button'; check.id = 'inv-table-check';
  bar.append(add, pasteBtn, check);
  const pasteBox = mk('div', 'margin-top:10px'); pasteBox.hidden = true;
  const ta = mk('textarea', 'width:100%;min-height:110px;border:1.5px solid var(--border);border-radius:8px;padding:8px;font:13px \'DM Sans\',sans-serif');
  ta.setAttribute('aria-label', 'Paste rows copied from Excel (Department, Position, Role, Full name, Phone, Email)');
  ta.placeholder = 'Copy the rows in Excel (Department, Position, Role, Full name, Phone, Email) and paste them here.';
  const pasteGo = mk('button', BTN, 'Add the pasted rows'); pasteGo.type = 'button';
  pasteBox.append(ta, pasteGo);
  const msg = mk('div', 'font-size:12.5px;margin-top:6px'); msg.setAttribute('role', 'status');
  box.append(head, tw, bar, pasteBox, msg);

  const select = (opts, cur, cellState, label) => {
    const s = mk('select', 'min-height:40px;max-width:230px;border-radius:6px;padding:0 6px;font:13px \'DM Sans\',sans-serif;border:1.5px solid '
      + (cellState.ok ? 'var(--border)' : RED) + (cellState.ok ? '' : ';background:#fff0f0'));
    s.setAttribute('aria-label', label);
    if (!cellState.ok) s.append(new Option(`⚠ ${cellState.raw ? '“' + cellState.raw + '” — ' : ''}${cellState.note}`, ''));
    else if (label.startsWith('Department')) s.append(new Option('No specific department', ''));
    opts.forEach(o => s.append(new Option(o.label, o.value)));
    s.value = cellState.ok ? cur : '';
    if (!cellState.ok) s.setAttribute('aria-invalid', 'true');
    return s;
  };
  const input = (v, label, type) => { const i = mk('input', 'min-height:40px;width:100%;min-width:120px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font:13px \'DM Sans\',sans-serif'); i.type = type; i.value = v; i.setAttribute('aria-label', label); return i; };

  let drawn = false;
  function render() {
    if (drawn) onChange?.();   // every redraw after the first follows a change to the rows
    drawn = true;
    tbl.replaceChildren();
    const hr = mk('tr'); ['#', ...COLS, 'Check', ''].forEach(h => hr.append(mk('th', 'text-align:left;padding:6px;border-bottom:1.5px solid var(--border);white-space:nowrap', h)));
    tbl.append(hr);
    let bad = 0;
    state.forEach((st, i) => {
      const probs = rowProblems(st, lists);
      if (probs.length) bad++;
      const tr = mk('tr', probs.length ? 'background:#fffafa' : '');
      const td = () => mk('td', 'padding:4px 6px;border-bottom:1px solid var(--border);vertical-align:top');
      const n = td(); n.textContent = String(i + 1);
      const c1 = td(), c2 = td(), c3 = td(), c4 = td(), c5 = td(), c6 = td(), c7 = td(), c8 = td();
      const ds = select(lists.depts.map(d => ({ label: d.label, value: d.id })), st.dept.value, { ...st.dept, raw: st.dept.ok ? '' : st.raw.dept }, `Department, row ${i + 1}`);
      ds.addEventListener('change', () => { st.dept = { value: ds.value, ok: true }; render(); });
      // the Position list follows the row's department; a position outside it is shown red with the reason (it must be changed)
      const allowed = deptPositionsOf(st, lists);
      const posOpts = lists.positions.filter(p => !allowed || allowed.has(p.key)).map(p => ({ label: p.label, value: p.key }));
      const misfit = st.pos.ok && allowed && !allowed.has(st.pos.value);
      const posState = misfit ? { ok: false, raw: positionLabel(st.pos.value), note: 'not a position of this department — choose' } : { ...st.pos, raw: st.pos.ok ? '' : st.raw.pos };
      const ps = select(posOpts, st.pos.value, posState, `Position, row ${i + 1}`);
      ps.addEventListener('change', () => {
        st.pos = ps.value ? { value: ps.value, ok: true } : { value: '', ok: false, note: 'choose the position' };
        if (st.role.auto || !st.role.ok) { const d = st.pos.ok ? defaultRole(st.pos.value) : ''; st.role = d && lists.roles.some(r => r.key === d) ? { value: d, ok: true, auto: true } : { value: '', ok: false, note: 'choose the role' }; }
        render();
      });
      const rs = select(lists.roles.map(r => ({ label: r.label, value: r.key })), st.role.value, { ...st.role, raw: st.role.ok ? '' : st.raw.role }, `Role, row ${i + 1}`);
      rs.addEventListener('change', () => { st.role = rs.value ? { value: rs.value, ok: true } : { value: '', ok: false, note: 'choose the role' }; render(); });
      c1.append(ds); c2.append(ps); c3.append(rs);
      if (st.role.auto) c3.append(mk('div', 'font-size:11px;color:var(--text-muted)', 'the position\'s usual role'));
      const ni = input(st.name, `Full name, row ${i + 1}`, 'text'); ni.addEventListener('change', () => { st.name = ni.value; render(); });
      const pi = input(st.phone, `Phone, row ${i + 1}`, 'tel'); pi.addEventListener('change', () => { st.phone = pi.value; render(); });
      const ei = input(st.email, `Email, row ${i + 1}`, 'email'); ei.addEventListener('change', () => { st.email = ei.value; render(); });
      c4.append(ni); c5.append(pi); c6.append(ei);
      if (probs.length) probs.forEach(p => c7.append(mk('div', `color:${RED}`, '✗ ' + p))); else c7.append(mk('span', 'color:#2d7a4f;font-weight:600', '✓'));
      const rm = mk('button', BTN_OUT + ';min-height:36px;padding:0 10px', 'Remove'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove row ${i + 1}`);
      rm.addEventListener('click', () => { state.splice(i, 1); render(); });
      c8.append(rm);
      tr.append(n, c1, c2, c3, c4, c5, c6, c7, c8);
      tbl.append(tr);
    });
    head.textContent = state.length ? `${state.length} row(s)` + (bad ? ` · ${bad} to correct (marked ✗ / red)` : ' · all filled in') : 'No rows yet — upload a file, paste rows or add a row.';
    check.disabled = !state.length || bad > 0;
    check.setAttribute('aria-disabled', String(check.disabled));
  }
  add.addEventListener('click', () => { if (state.length >= 300) return; state.push(rowState({ dept: '', pos: '', role: '', name: '', phone: '', email: '' }, lists, defaultRole)); render(); });
  pasteBtn.addEventListener('click', () => { pasteBox.hidden = !pasteBox.hidden; if (!pasteBox.hidden) ta.focus(); });
  pasteGo.addEventListener('click', () => {
    const grid = ta.value.split(/\r?\n/).filter(l => l.trim()).map(l => l.split('\t'));
    const r = rawRows(grid);
    if (r.problem) { msg.style.color = RED; msg.textContent = r.problem; return; }
    if (state.length + r.rows.length > 300) { msg.style.color = RED; msg.textContent = 'At most 300 rows at a time.'; return; }
    state.push(...r.rows.map(x => rowState(x, lists, defaultRole)));
    ta.value = ''; pasteBox.hidden = true; msg.style.color = 'var(--text-mid)';
    msg.textContent = `${r.rows.length} row(s) added.` + (r.skipped ? ` ${r.skipped} row(s) with no name, phone or email left out.` : '');
    render();
  });
  check.addEventListener('click', () => { if (!check.disabled) onCheck(state.map(serverRow)); });
  render();
  return { addRaw(raws) { state.push(...raws.map(x => rowState(x, lists, defaultRole))); render(); }, clear() { state = []; render(); } };
}
export const positionLabel = k => DESIG_MAP[k]?.l || k || '';
