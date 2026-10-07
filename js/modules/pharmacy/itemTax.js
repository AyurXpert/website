// itemTax.js -- a medicine's HSN + OP / IP tax profile, bulk assign and the item-tax approvals (Session 345b, GST Stage 5).
// The tax master (tenant_item_tax) is the single source; every change is a maker-checker request (request_item_tax_change ->
// pending_approvals 'item_tax_change' -> decide_approval). The selectable profiles come from the server
// (list_item_tax_profiles: this organisation's own goods profiles with an approved version valid today) -- no GST rate is
// written in this file. Who may DECIDE is the server's answer (approval_decide_check); the maker controls are shown to the
// tax-maker roles, and the server re-checks every request. DOM nodes + textContent only; no native confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js';
import { getCurrentRole, getCurrentSecondaryRole } from '../../core/auth.js';
import { el } from './returnPanel.js';

// the roles _tax_maker_ok() accepts (display only -- the server decides)
const MAKER_ROLES = ['super_admin', 'dept_admin', 'finance_manager', 'accountant'];
export function isTaxMaker() {
  const r = getCurrentRole(), s = getCurrentSecondaryRole();
  return MAKER_ROLES.includes(r) || ['dept_admin', 'finance_manager', 'accountant'].includes(s);
}
const HSN_RE = /^[0-9]{4}([0-9]{2}){0,2}$/;
const cleanHsn = v => String(v || '').replace(/\s/g, '');
const btn = (label, cls, onClick, attrs = {}) => { const b = el('button', { type: 'button', class: cls, ...attrs }, label); b.addEventListener('click', onClick); return b; };
let _n = 0;
const uid = p => `${p}-${++_n}`;
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

function profileLabel(p) {
  const rate = Number(p.gst_rate || 0);
  return `${p.name} — ${p.tax_category === 'TAXABLE' ? rate + ' %' : (p.tax_category || '').toLowerCase().replace('_', '-')}`;
}

// Everything a screen needs, read once: selectable profiles + default HSN, the tax master, the medicines, the names of the
// profiles items point at now, and which medicines are already waiting in a pending request.
export async function loadItemTaxContext(supabase) {
  const [lp, master, meds, names, pend] = await Promise.all([
    supabase.rpc('list_item_tax_profiles'),
    supabase.from('tenant_item_tax').select('medicine_id, hsn_code, op_tax_profile_id, ip_tax_profile_id'),
    supabase.from('medicines').select('id, name, strength, unit, is_active').order('name'),
    supabase.from('tax_profiles').select('id, name'),
    supabase.from('pending_approvals').select('id, payload').eq('action_type', 'item_tax_change').eq('status', 'pending'),
  ]);
  const err = lp.error || master.error || meds.error;
  if (err) return { error: err };
  const pending = new Map();
  for (const a of pend.data || []) for (const l of a.payload?.lines || []) pending.set(l.medicine_id, a.id);
  return {
    defaultHsn: lp.data?.default_hsn || '30049011',
    profiles: lp.data?.profiles || [],
    master: new Map((master.data || []).map(m => [m.medicine_id, m])),
    medicines: meds.data || [],
    profileName: new Map((names.data || []).map(p => [p.id, p.name])),
    pending,
  };
}

function profileSelect(ctx, value, label, { keep = false } = {}) {
  const id = uid('it-sel');
  const s = el('select', { id, class: 'rp-sel', 'aria-label': label });
  if (keep) s.append(el('option', { value: '__keep' }, '— keep as it is —'));
  s.append(el('option', { value: '' }, '— organisation default —'));
  for (const p of ctx.profiles) s.append(el('option', { value: p.id }, profileLabel(p)));
  // an item already on a profile that is no longer selectable still shows it (it cannot be chosen again)
  if (value && !ctx.profiles.some(p => p.id === value)) s.append(el('option', { value, disabled: true }, `${ctx.profileName.get(value) || 'Unknown profile'} (not selectable now)`));
  s.value = keep ? '__keep' : (value || '');
  return { id, s };
}

/**
 * The tax section of one medicine (the medicine screen): current HSN / OP / IP, "Pending approval" while a request waits,
 * and -- for a tax maker -- the HSN field (4 / 6 / 8 digits) + the two dropdowns + "Save tax details" (sends a request).
 */
export async function mountMedicineTaxPanel(container, { supabase, medicineId, medicineName, onChanged } = {}) {
  container.replaceChildren(el('div', { class: 'rp-muted' }, 'Loading tax details…'));
  const ctx = await loadItemTaxContext(supabase);
  if (ctx.error) { container.replaceChildren(el('div', { class: 'rp-err' }, safeErrorMessage(ctx.error, 'Could not load the tax details.'))); return; }
  const cur = ctx.master.get(medicineId) || {};
  const pend = ctx.pending.get(medicineId);
  const maker = isTaxMaker();
  const msg = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const head = el('div', { class: 'it-head' },
    el('strong', null, 'Tax details'),
    pend ? el('span', { class: 'it-pending', 'data-pending': '1' }, '⏳ Pending approval') : null);
  const now = el('div', { class: 'rp-muted' },
    `HSN ${cur.hsn_code || '— (not set)'} · OP (sale) profile: ${ctx.profileName.get(cur.op_tax_profile_id) || 'organisation default'} · `
    + `IP (treatment) profile: ${ctx.profileName.get(cur.ip_tax_profile_id) || 'organisation default'}`);
  if (!maker || pend) {
    container.replaceChildren(el('div', { class: 'it-panel' }, head, now,
      pend ? el('div', { class: 'rp-note' }, 'A change for this medicine is waiting for approval; it can be changed again once it is decided.')
           : el('div', { class: 'rp-muted' }, 'Only an administrator or the accounts team can request a change.')));
    return;
  }
  const hsnId = uid('it-hsn');
  const hsn = el('input', { id: hsnId, class: 'rp-input', type: 'text', inputmode: 'numeric', maxlength: '9', autocomplete: 'off', value: cur.hsn_code || ctx.defaultHsn,
    'aria-describedby': hsnId + '-h' });
  const op = profileSelect(ctx, cur.op_tax_profile_id, 'OP (sale) tax profile');
  const ip = profileSelect(ctx, cur.ip_tax_profile_id, 'IP (treatment) tax profile');
  const save = btn('Save tax details', 'rp-btn rp-btn-go', async () => {
    const h = cleanHsn(hsn.value);
    if (!HSN_RE.test(h)) { msg.textContent = 'The HSN must be 4, 6 or 8 digits.'; msg.className = 'rp-status err'; hsn.focus(); return; }
    const line = { medicine_id: medicineId, hsn: h, op_profile_id: op.s.value || null, ip_profile_id: ip.s.value || null };
    save.disabled = true; save.textContent = 'Sending…';
    const { data, error } = await supabase.rpc('request_item_tax_change', { p_lines: [line], p_reason: null });
    if (error || !data) {
      msg.textContent = safeErrorMessage(error, 'Could not send the request.'); msg.className = 'rp-status err';
      save.disabled = false; save.textContent = 'Save tax details';
      return;
    }
    onChanged?.(data);
    mountMedicineTaxPanel(container, { supabase, medicineId, medicineName, onChanged });   // re-read: shows "Pending approval"
  });
  container.replaceChildren(el('div', { class: 'it-panel' }, head, now,
    el('div', { class: 'rp-grid2' },
      el('div', { class: 'rp-field' }, el('label', { for: hsnId, class: 'rp-lbl' }, 'HSN (4, 6 or 8 digits)'), hsn,
        el('span', { id: hsnId + '-h', class: 'rp-muted' }, `Organisation default: ${ctx.defaultHsn}`)),
      el('div', { class: 'rp-field' }, el('label', { for: op.id, class: 'rp-lbl' }, 'OP (sale) tax profile'), op.s),
      el('div', { class: 'rp-field' }, el('label', { for: ip.id, class: 'rp-lbl' }, 'IP (treatment) tax profile'), ip.s)),
    el('div', { class: 'rp-note' }, 'A change is sent for approval (Super Admin or Finance Manager, never the person who asks); nothing changes until it is approved.'),
    el('div', { class: 'rp-actions' }, save), msg));
}

/**
 * Bulk assign: filter / select medicines, choose a new HSN and/or OP / IP profile ("keep as it is" leaves a field), preview
 * old -> new per medicine, then ONE request (at most 500 medicines; the server checks every line again).
 */
export async function mountBulkItemTax(root, { supabase, onSubmitted } = {}) {
  root.replaceChildren(el('div', { class: 'rp-muted' }, 'Loading medicines…'));
  const ctx = await loadItemTaxContext(supabase);
  if (ctx.error) { root.replaceChildren(el('div', { class: 'rp-err' }, safeErrorMessage(ctx.error, 'Could not load the medicines.'))); return; }
  const hId = uid('bk-h');
  const titleId = uid('bk-t');
  const filter = el('input', { class: 'rp-input', type: 'search', placeholder: 'Filter by name', 'aria-label': 'Filter medicines by name' });
  const hsn = el('input', { id: hId, class: 'rp-input', type: 'text', inputmode: 'numeric', maxlength: '9', placeholder: 'leave empty to keep' });
  const op = profileSelect(ctx, null, 'New OP (sale) profile', { keep: true });
  const ip = profileSelect(ctx, null, 'New IP (treatment) profile', { keep: true });
  const selected = new Set();
  const listBox = el('div', { class: 'rp-tablewrap bk-list' });
  const count = el('div', { class: 'rp-muted', role: 'status', 'aria-live': 'polite' });
  const preview = el('div', { class: 'bk-preview' });
  const msg = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  let lines = [];

  const cur = id => ctx.master.get(id) || {};
  const pname = id => id ? (ctx.profileName.get(id) || ctx.profiles.find(p => p.id === id)?.name || 'Unknown') : 'organisation default';
  function drawList() {
    const q = filter.value.trim().toLowerCase();
    const shown = ctx.medicines.filter(m => !q || (m.name || '').toLowerCase().includes(q));
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select every medicine shown' });
    const selectable = shown.filter(m => !ctx.pending.has(m.id));
    all.checked = selectable.length > 0 && selectable.every(m => selected.has(m.id));
    all.addEventListener('change', () => { for (const m of selectable) all.checked ? selected.add(m.id) : selected.delete(m.id); drawList(); });
    const rows = shown.slice(0, 600).map(m => {
      const c = cur(m.id), busy = ctx.pending.has(m.id);
      const cb = el('input', { type: 'checkbox', 'aria-label': `Select ${m.name}`, disabled: busy ? true : null, 'data-med': m.id });
      cb.checked = selected.has(m.id);
      cb.addEventListener('change', () => { cb.checked ? selected.add(m.id) : selected.delete(m.id); count.textContent = `${selected.size} selected`; });
      return el('tr', null, el('td', null, cb),
        el('td', null, m.name || '—', m.strength ? ` · ${m.strength}` : '', busy ? el('span', { class: 'it-pending' }, ' ⏳ pending') : null),
        el('td', null, c.hsn_code || '—'), el('td', null, pname(c.op_tax_profile_id)), el('td', null, pname(c.ip_tax_profile_id)));
    });
    listBox.replaceChildren(el('table', { class: 'rp-table' },
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, all), ...['Medicine', 'HSN', 'OP profile', 'IP profile'].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', null, rows)));
    count.textContent = `${selected.size} selected${shown.length > 600 ? ' · showing the first 600 — narrow the filter' : ''}`;
  }
  filter.addEventListener('input', drawList);

  const doPreview = btn('Preview', 'rp-btn', () => {
    msg.textContent = ''; msg.className = 'rp-status';
    const h = cleanHsn(hsn.value);
    if (h && !HSN_RE.test(h)) { msg.textContent = 'The HSN must be 4, 6 or 8 digits (or empty to keep).'; msg.className = 'rp-status err'; return; }
    if (!h && op.s.value === '__keep' && ip.s.value === '__keep') { msg.textContent = 'Choose a new HSN and/or a profile.'; msg.className = 'rp-status err'; return; }
    if (!selected.size) { msg.textContent = 'Select at least one medicine.'; msg.className = 'rp-status err'; return; }
    lines = [];
    const rows = [];
    let unchanged = 0;
    for (const m of ctx.medicines.filter(x => selected.has(x.id))) {
      const c = cur(m.id);
      const nw = { hsn: h || c.hsn_code || ctx.defaultHsn,
        op: op.s.value === '__keep' ? (c.op_tax_profile_id || null) : (op.s.value || null),
        ip: ip.s.value === '__keep' ? (c.ip_tax_profile_id || null) : (ip.s.value || null) };
      if (nw.hsn === (c.hsn_code || null) && nw.op === (c.op_tax_profile_id || null) && nw.ip === (c.ip_tax_profile_id || null)) { unchanged++; continue; }
      lines.push({ medicine_id: m.id, hsn: nw.hsn, op_profile_id: nw.op, ip_profile_id: nw.ip });
      rows.push(el('tr', null, el('td', null, m.name || '—'),
        el('td', null, `${c.hsn_code || '—'} → ${nw.hsn}`), el('td', null, `${pname(c.op_tax_profile_id)} → ${pname(nw.op)}`),
        el('td', null, `${pname(c.ip_tax_profile_id)} → ${pname(nw.ip)}`)));
    }
    if (lines.length > 500) { msg.textContent = `At most 500 medicines in one request (${lines.length} would change) — select fewer.`; msg.className = 'rp-status err'; preview.replaceChildren(); return; }
    const submit = btn(`Send ${lines.length} for approval`, 'rp-btn rp-btn-go', async () => {
      submit.disabled = true; submit.textContent = 'Sending…';
      const { data, error } = await supabase.rpc('request_item_tax_change', { p_lines: lines, p_reason: null });
      if (error || !data) {
        msg.textContent = safeErrorMessage(error, 'Could not send the request.'); msg.className = 'rp-status err';
        submit.disabled = false; submit.textContent = `Send ${lines.length} for approval`;
        return;
      }
      preview.replaceChildren(el('div', { class: 'rp-note', 'data-sent': '1' }, `⏳ Sent for approval: ${data.count} medicine(s) in one request. Nothing changes until it is approved.`));
      onSubmitted?.(data);
      setTimeout(() => mountBulkItemTax(root, { supabase, onSubmitted }), 1500);
    });
    preview.replaceChildren(
      el('div', { class: 'rp-kind' }, `Preview — ${lines.length} medicine(s) change${unchanged ? ` · ${unchanged} already as chosen (left out)` : ''}`),
      lines.length ? el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-preview': '1' },
        el('thead', null, el('tr', null, ['Medicine', 'HSN', 'OP profile', 'IP profile'].map(h2 => el('th', { scope: 'col' }, h2)))), el('tbody', null, rows))) : null,
      lines.length ? el('div', { class: 'rp-actions' }, submit) : el('div', { class: 'rp-muted' }, 'Nothing would change.'));
  });

  root.replaceChildren(el('section', { class: 'rp-card', 'aria-labelledby': titleId },
    el('h3', { class: 'rp-h', id: titleId }, '🏷 Tax & HSN — assign to many medicines'),
    el('p', { class: 'rp-sub' }, 'Select medicines, choose a new HSN and/or tax profiles, check the preview, then send ONE request for approval (at most 500 medicines). Medicines already waiting in a request cannot be selected.'),
    el('div', { class: 'rp-grid2' },
      el('div', { class: 'rp-field' }, el('label', { for: hId, class: 'rp-lbl' }, 'New HSN (4, 6 or 8 digits)'), hsn),
      el('div', { class: 'rp-field' }, el('label', { for: op.id, class: 'rp-lbl' }, 'New OP (sale) profile'), op.s),
      el('div', { class: 'rp-field' }, el('label', { for: ip.id, class: 'rp-lbl' }, 'New IP (treatment) profile'), ip.s)),
    el('div', { class: 'rp-row' }, filter, doPreview), count, listBox, preview, msg));
  drawList();
}

/**
 * The item-tax change requests waiting for approval: each shows who asked, why, and the old -> new table per medicine.
 * Approve / Reject (reason required) only where the server says this person may decide (approval_decide_check).
 */
export function mountItemTaxApprovals(root, { supabase, onCount, onDecided } = {}) {
  const hId = uid('ita-h');
  const status = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'rq-list' });
  root.replaceChildren(el('section', { class: 'rp-card', 'aria-labelledby': hId },
    el('div', { class: 'rp-row rq-head' }, el('h3', { class: 'rp-h', id: hId }, '⚖️ Medicine tax changes waiting for approval'), btn('↻ Refresh', 'rp-btn', () => reload())),
    el('p', { class: 'rp-sub' }, 'Approving applies every line at once (re-checked now); nothing changes on bills already made. The person who asked can never approve their own request (except an organisation’s only Super Admin).'),
    status, list));
  const REASON = { own_request: 'You asked for this change — another authorised person decides it.', inactive: 'Your account is not active.',
    not_authorised: 'Waiting for the Super Admin or Finance Manager.' };

  async function reload() {
    status.textContent = 'Loading…'; status.className = 'rp-status';
    const { data, error } = await supabase.from('pending_approvals').select('id, payload, reason, requested_by, requested_at')
      .eq('action_type', 'item_tax_change').eq('status', 'pending').order('requested_at', { ascending: true });
    if (error) { status.textContent = safeErrorMessage(error, 'Could not load the requests.'); status.className = 'rp-status err'; onCount?.(0); return; }
    if (!data?.length) { status.textContent = 'No medicine tax change is waiting for approval.'; list.replaceChildren(); onCount?.(0); return; }
    const [chk, who] = await Promise.all([
      supabase.rpc('approval_decide_check', { p_ids: data.map(a => a.id) }),
      supabase.from('profiles').select('id, full_name').in('id', [...new Set(data.map(a => a.requested_by))]),
    ]);
    const can = new Map(chk.error ? [] : (chk.data || []).map(c => [c.id, c]));
    const names = new Map((who.data || []).map(p => [p.id, p.full_name]));
    let mine = 0;
    list.replaceChildren(...data.map(a => {
      const c = can.get(a.id);
      if (c?.can_decide) mine++;
      const lines = a.payload?.lines || [];
      const rows = lines.map(l => el('tr', null, el('td', null, l.name || '—'),
        el('td', null, `${l.old?.hsn || '—'} → ${l.new?.hsn || '—'}`),
        el('td', null, `${l.old?.op_name || 'organisation default'} → ${l.new?.op_name || 'organisation default'}`),
        el('td', null, `${l.old?.ip_name || 'organisation default'} → ${l.new?.ip_name || 'organisation default'}`)));
      const msg = el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
      const actions = el('div', { class: 'rp-actions' });
      if (c?.can_decide) {
        actions.append(btn('✕ Reject', 'rp-btn rp-btn-no', () => panel(a, false, actions, msg), { 'data-decide': 'reject' }),
                       btn('✅ Approve', 'rp-btn rp-btn-go', () => panel(a, true, actions, msg), { 'data-decide': 'approve' }));
      } else {
        actions.append(el('span', { class: 'rp-muted', 'data-decide': 'none' }, REASON[c?.reason] || 'Waiting for another authorised person.'));
      }
      return el('article', { class: 'rq-card', 'data-request': a.id },
        el('div', { class: 'rq-top' }, el('strong', null, `${lines.length} medicine(s)`), ` · asked by ${names.get(a.requested_by) || '—'} · ${when(a.requested_at)}`),
        a.reason ? el('div', { class: 'rq-meta' }, `Reason: “${a.reason}”`) : null,
        el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table' },
          el('thead', null, el('tr', null, ['Medicine', 'HSN', 'OP profile', 'IP profile'].map(h => el('th', { scope: 'col' }, h)))),
          el('tbody', null, rows))),
        actions, msg);
    }));
    status.textContent = `${data.length} request(s) waiting · ${mine} you can decide` + (chk.error ? ' — could not check who may decide; try Refresh.' : '.');
    status.className = 'rp-status' + (chk.error ? ' err' : '');
    onCount?.(mine);
  }

  function panel(a, approve, actions, msg) {
    const nId = uid('ita-n');
    const note = el('textarea', { id: nId, class: 'rp-input', rows: '2', maxlength: '500', placeholder: approve ? 'Note (optional)' : 'Why it is rejected (at least 5 characters)' });
    const back = btn('Back', 'rp-btn', () => reload());
    const go = btn(approve ? 'Confirm approval' : 'Confirm rejection', approve ? 'rp-btn rp-btn-go' : 'rp-btn rp-btn-no', async () => {
      const n = note.value.trim();
      if (!approve && n.length < 5) { msg.textContent = 'Give the reason for rejecting (at least 5 characters).'; msg.className = 'rp-status err'; note.focus(); return; }
      go.disabled = true; back.disabled = true; go.textContent = 'Saving…';
      const { error } = await supabase.rpc('decide_approval', { p_request_id: a.id, p_approve: approve, p_notes: n || null });
      if (error) {
        msg.textContent = safeErrorMessage(error, 'Could not decide this request.'); msg.className = 'rp-status err';
        go.disabled = false; back.disabled = false; go.textContent = approve ? 'Confirm approval' : 'Confirm rejection';
        return;
      }
      const done = approve ? '✓ Approved — the tax details are applied.' : '✕ Rejected — nothing was changed.';
      actions.replaceChildren(el('span', { class: approve ? 'rp-ok' : 'rp-muted', 'data-decided': approve ? 'approved' : 'rejected' }, done));
      msg.textContent = '';
      // the host page may reload and re-mount this list -- it gets the text so it can keep the result on screen
      onDecided?.(approve, done);
    }, { 'data-confirm': approve ? 'approve' : 'reject' });
    actions.replaceChildren(el('div', { class: 'rq-decide', role: 'group', 'aria-label': approve ? 'Approve this request' : 'Reject this request' },
      el('label', { for: nId, class: 'rp-lbl' }, approve ? 'Approve — note (optional)' : 'Reject — reason (required)'), note,
      el('div', { class: 'rp-actions' }, back, go)));
    note.focus();
  }

  reload();
  return { reload };
}
