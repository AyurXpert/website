// feeStructureList.js -- Session 386b-2b (F7 + F6, owner-approved redesign 14 Nov 2026): Fee Structure as ONE grouped list.
//   Top: search over every fee + the status filter; "Needs attention" chips (In no group · Pending approval · Ask-to-add requests;
//        Auto-classify inside "In no group", Super Admin only); ⚙ Fee settings (advance %, follow-up window, approval log) on their own screen.
//   Then collapsible sections, CLOSED by default, each "name · count · pending": OPD charges, IPD charges, Lab tests, Imaging, Major OT,
//        Minor OT, Anushastra / Kshara Sutra, Kriyakalpa, Panchakarma, Physiotherapy, Prasuti Stri Roga, Other, the organisation's own
//        sections, + Add section. Inside a section ONE table: Name · Price · Status · Also in (group chips with ✕, "+ group") · Actions.
//        Section header: + Add · + Add existing fee (the SAME fee joins this group, never a copy) · Import CSV · Export.
//   G9 (owner, 14 Nov evening): a fee is listed in EVERY section it belongs to (each of its groups); its other groups show as "Also in".
//   G5: rejected fees are hidden unless the Status filter asks for them. G7: every control says what it does (title).
// Every rule stays the server's (fee approval decide_fees, the maker / checker, set_fee_groups, add_procedure_fee, import_procedure_fees,
// procedure_group_save / _set_active, the auto-classification, decide_procedure_add); this module only shows and sends. The row actions are
// fee-admin.js's own (Edit / Approve / Reject / Deactivate / Promo / Delete -- the same page actions as before). F6: every action says
// whether it worked; the message stays across the reload and is scrolled into view. DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';
import { canDecideCharge } from '../../utils/chargeRights.js';
import { h, button, rupee, NOTE, BOX, csvCell, download, _addProcedureForm, _importForm, _renameForm, _addSectionBox, _untaggedBox, _autoBox,
         _requestsBox, _printSection } from './procedureGroupsAdmin.js';

const CAT_SECTIONS = [
  { key: 'cat:opd', name: 'OPD charges', cats: ['opd'], groupCode: 'opd_charges' },
  { key: 'cat:ipd', name: 'IPD charges', cats: ['ipd'], groupCode: 'ipd_charges' },
  { key: 'cat:lab', name: 'Lab tests', cats: ['lab'] },
  { key: 'cat:imaging', name: 'Imaging', cats: ['radiology'] },
];
const GROUP_ORDER = ['major_ot', 'minor_ot', 'anushastra', 'kriyakalpa', 'panchakarma', 'physiotherapy', 'prasuti_stri_roga', 'other'];
const STATUS = { pending: 'Pending', dept_approved: 'Dept. Approved', active: 'Active', rejected: 'Rejected' };
const CHIP = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;background:#eef6f0;border:1px solid #cfe3d6;font-size:12px;margin:2px';

let _open = new Set();           // which sections are open (kept across reloads)
let _flash = null;               // F6: the last action's message (kept across the reload)
let _q = '', _status = '', _panel = null;
let _focus = null;               // H4: the list a chip just opened (scrolled to smoothly and outlined; the page does not jump)
let _mountSeq = 0;               // G4: an older, slower load never draws over a newer one

/** Pure: put each fee in every section it belongs to (exported for the page check). */
export function buildSections(fees, groups, links) {
  const byCode = new Map(groups.map(g => [g.code, g]));
  const gOrder = g => { const i = GROUP_ORDER.indexOf(g.code); return i >= 0 ? i : 100 + (g.sort_order || 0); };
  const sortedGroups = [...groups].sort((a, b) => gOrder(a) - gOrder(b) || String(a.display_name).localeCompare(String(b.display_name)));
  const rank = new Map(sortedGroups.map((g, i) => [g.id, i]));
  const groupsOf = new Map();
  for (const l of links) { if (!rank.has(l.group_id)) continue; const a = groupsOf.get(l.fee_id) || []; a.push(l.group_id); groupsOf.set(l.fee_id, a); }
  for (const a of groupsOf.values()) a.sort((x, y) => rank.get(x) - rank.get(y));
  const sections = [];
  for (const c of CAT_SECTIONS) sections.push({ ...c, group: c.groupCode ? byCode.get(c.groupCode) || null : null, rows: [] });
  for (const g of sortedGroups) {
    if (g.code === 'opd_charges' || g.code === 'ipd_charges') continue;   // merged into OPD / IPD charges
    sections.push({ key: 'grp:' + g.id, name: g.code === 'anushastra' && g.display_name === 'Anushastra' ? 'Anushastra / Kshara Sutra' : g.display_name,
                    group: g, rows: [], own: !g.is_standard });
  }
  const sectionOfGroup = new Map();
  for (const s of sections) if (s.group) sectionOfGroup.set(s.group.id, s);
  const noGroup = [];
  for (const f of fees) {
    const gs = groupsOf.get(f.id) || [];
    const into = [];   // the sections this fee belongs to (G9: ALL of them, never just the first)
    if (f.category !== 'procedure') {
      into.push(sections.find(x => (x.cats || []).includes(f.category)) || sections.find(x => x.group?.code === 'other'));
    } else if (!gs.length) { noGroup.push(f); continue; }
    for (const gid of gs) into.push(sectionOfGroup.get(gid));
    const seen = new Set();
    for (const s of into) {
      if (!s || seen.has(s.key)) continue;
      seen.add(s.key);
      s.rows.push({ fee: f, also: gs.filter(id => id !== s.group?.id) });
    }
  }
  return { sections, noGroup, groupsOf };
}

/** mountFeeStructureList(container, { supabase, tenantId, profile, fees, actionsFor, amountText, roomGaps, openAdd, onChanged }) */
export async function mountFeeStructureList(container, ctx) {
  const { supabase, tenantId, profile } = ctx;
  const committee = canDecideCharge(profile);   // page copy of _fee_committee_ok
  const superAdmin = profile?.role === 'super_admin';
  const seq = ++_mountSeq;
  const [g, l, d, rq] = await Promise.all([
    supabase.from('procedure_groups').select('id, code, display_name, is_standard, department_id, used_on, is_active, sort_order, offered_in_opd').eq('tenant_id', tenantId),   // 386d-1: offered_in_opd
    supabase.from('fee_procedure_groups').select('fee_id, group_id').eq('tenant_id', tenantId).range(0, 9999),
    supabase.from('departments').select('id, name').eq('tenant_id', tenantId).order('name'),
    committee ? supabase.rpc('procedure_add_requests') : Promise.resolve({ data: [] }),
  ]);
  if (seq !== _mountSeq) return;   // a newer load has started: it draws the list
  container.replaceChildren();
  const err = g.error || l.error || d.error;
  if (err) { container.style.minHeight = ''; container.appendChild(h('div', { role: 'alert', style: 'color:var(--red, #b03a2e)' }, safeErrorMessage(err, 'Could not load the fee list.'))); return; }
  const groups = g.data || [], links = l.data || [], depts = d.data || [], requests = rq.data || [];
  const groupById = new Map(groups.map(x => [x.id, x]));
  const fees = ctx.fees || [];
  const { sections, noGroup } = buildSections(fees, groups, links);

  // ---- F6: one message line that survives the reload
  const msg = h('div', { role: 'status', 'aria-live': 'polite', style: 'font-size:13px;margin:6px 0;min-height:1em;font-weight:600' });
  const show = () => { if (!_flash) return; msg.textContent = _flash.text; msg.style.color = _flash.bad ? 'var(--red, #b03a2e)' : 'var(--green-deep, #1a4a2e)';
                       msg.setAttribute('role', _flash.bad ? 'alert' : 'status'); };
  // G12: every action's message is shown at the top AND as the page's toast AND inside the section where it was done (after the redraw)
  const say = (text, bad = false, sec = null) => {
    _flash = { text, bad, sec, fresh: true }; show(); ctx.notify?.(text, bad ? 'error' : 'success');
    msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const reload = async () => { await ctx.onChanged(); };   // fee-admin reloads the fees and mounts this list again

  // ---- the top: search, status, Needs attention, settings
  const search = h('input', { type: 'search', placeholder: 'Search all fees…', 'aria-label': 'Search all fees', value: _q, class: 'fee-input',
    title: 'Type part of a fee name, AYUSH code or note — every section with a match opens', style: 'min-height:44px;flex:1;min-width:200px' });
  const status = h('select', { 'aria-label': 'Status', class: 'fee-input', title: 'Show only fees of this status (rejected fees show only when you choose Rejected)', style: 'min-height:44px' },
    h('option', { value: '' }, 'All statuses (not rejected)'),
    Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: k === _status }, v)));
  const settingsBtn = button('⚙ Fee settings', () => {
    const s = document.getElementById('fee-settings'); if (!s) return;
    s.hidden = !s.hidden; settingsBtn.setAttribute('aria-expanded', String(!s.hidden)); if (!s.hidden) s.scrollIntoView({ block: 'start' });
  }, false, { 'aria-expanded': String(!(document.getElementById('fee-settings')?.hidden ?? true)), id: 'fee-settings-toggle',
              title: 'Open or close the fee settings: admission advance %, follow-up window, the fee approval log' });
  const pendingN = fees.filter(f => f.approval_status === 'pending' || f.approval_status === 'dept_approved').length;
  const noGroupActive = noGroup.filter(f => f.is_active || f.approval_status !== 'rejected');
  // H3 / H4 (owner 15 Nov 2026): the number is red and bold when above 0 (and in the text); a chip opens its list right under the chips
  // without the page jumping (the old height is kept while the list redraws), scrolls it smoothly into view and outlines it
  const chip = (label, n, opened, onOpen, title) => {
    const b = button(`${label} · ${n}`, () => {
      onOpen();
      _focus = opened() ? label : null;
      container.style.minHeight = container.offsetHeight + 'px';   // keep the page's height: no jump while it redraws
      mountFeeStructureList(container, ctx);
    }, false, { 'aria-pressed': String(opened()), title, 'aria-label': `${label}: ${n} need${n === 1 ? 's' : ''} attention` });
    b.replaceChildren(document.createTextNode(`${label} · `), h('span', { class: 'attn-n' + (n > 0 ? ' attn-hot' : '') }, String(n)));
    return b;
  };
  const chips = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
    h('span', { style: 'font-weight:600;font-size:13px' }, 'Needs attention:'),
    chip('In no group', noGroupActive.length, () => _panel === 'nogroup', () => { _panel = _panel === 'nogroup' ? null : 'nogroup'; },
      'Procedure fees offered on no register yet — open to put them in a section'),
    chip('Pending approval', pendingN, () => _status === 'pending', () => { _status = _status === 'pending' ? '' : 'pending'; },
      'Show only the fees waiting for approval (pending or department-approved); press again to show all'),
    committee ? chip('Ask-to-add requests', requests.length, () => _panel === 'requests', () => { _panel = _panel === 'requests' ? null : 'requests'; },
      'Procedures staff asked to add to the fee list (with their reason and suggested price) — price and approve, or reject') : null);
  container.append(h('div', { style: BOX },
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, search, status, settingsBtn), h('div', { style: 'margin-top:8px' }, chips), msg));
  show();
  let tmr = null;
  search.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { _q = search.value; draw(); }, 250); });
  status.addEventListener('change', () => { _status = status.value; draw(); });

  // the attention panels (the existing procedure tools)
  const panelOf = el => { el.setAttribute('data-attn-panel', ''); el.setAttribute('tabindex', '-1'); return el; };
  let focusEl = null;
  if (_panel === 'nogroup') {
    focusEl = panelOf(_untaggedBox(supabase, noGroupActive, groups.filter(x => x.is_active), { committee, say, reload }));
    container.appendChild(focusEl);
    if (superAdmin) container.appendChild(_autoBox(supabase, groups, say, reload));
  }
  if (_panel === 'requests' && committee) { focusEl = panelOf(await _requestsBox(supabase, say, reload)); container.appendChild(focusEl); }

  const list = h('div');
  container.appendChild(list);
  if (committee) container.appendChild(_addSectionBox(supabase, depts, say, reload));

  const matches = f => {
    if (!_status && f.approval_status === 'rejected') return false;   // G5: rejected fees only when the Status filter asks for them
    if (_status === 'pending' ? !(f.approval_status === 'pending' || f.approval_status === 'dept_approved') : (_status && f.approval_status !== _status)) return false;
    if (!_q.trim()) return true;
    const q = _q.trim().toLowerCase();
    return [f.label, f.notes, f.ayush_code, f.fee_type].some(x => String(x || '').toLowerCase().includes(q));
  };
  const filtering = () => !!_q.trim() || !!_status;
  const SEC_MSG = new Map();   // G12: the section that holds the last action's message

  function feeRow(r, sec) {
    const f = r.fee;
    const name = h('td', null, h('div', { style: 'font-weight:600' }, f.label || '—'),
      f.notes ? h('div', { style: NOTE }, f.notes) : null, h('div', { style: NOTE }, 'By ' + (f.creator?.full_name || '—')));
    const price = h('td', { style: 'white-space:nowrap' }, ctx.amountText(f));
    // the NCISM benchmark of an AYUSH-coded fee (it was on the old table only; the citation as the tooltip)
    if (f.ayush_code && f.ayush_catalog?.benchmark_rate_2026 != null) price.appendChild(h('div', { style: NOTE, title: ctx.benchmarkCitation || '' },
      `NCISM Benchmark: ${rupee(f.ayush_catalog.benchmark_rate_2026)} (${f.ayush_code})`));
    const st = h('td', null, h('span', { class: 'status-badge status-' + (f.approval_status || 'pending') }, STATUS[f.approval_status] || f.approval_status || 'Pending'));
    const also = h('td');
    if (f.category === 'procedure') {
      for (const gid of r.also) {
        const gg = groupById.get(gid); if (!gg) continue;
        const chip = h('span', { style: CHIP }, gg.display_name);
        chip.title = `${f.label} is also offered in ${gg.display_name}`;
        if (committee) chip.appendChild(button('✕', async () => {
          const { error } = await supabase.rpc('set_fee_groups', { p_fee_ids: [f.id], p_group: gid, p_add: false });
          if (error) { say(safeErrorMessage(error, 'Could not change the groups.'), true, sec.key); return; }
          say(`"${f.label}" removed from ${gg.display_name}.`, false, sec.key); await reload();
        }, false, { 'aria-label': `Remove ${f.label} from ${gg.display_name}`, title: `Take ${f.label} out of ${gg.display_name} only (it stays here)`, style: 'min-height:32px;padding:0 6px' }));
        also.appendChild(chip);
      }
      if (committee) {
        const inG = new Set([...(r.also || []), ...(sec.group ? [sec.group.id] : [])]);
        const sel = h('select', { 'aria-label': `Add ${f.label} to another group`, class: 'fee-input', title: 'Also offer this same fee in another section (the same price, not a copy)',
          style: 'min-height:36px;font-size:12px' }, h('option', { value: '' }, '+ group'),
          groups.filter(x => x.is_active && !inG.has(x.id)).map(x => h('option', { value: x.id }, x.display_name)));
        sel.addEventListener('change', async () => {
          if (!sel.value) return;
          const gname = groupById.get(sel.value)?.display_name || 'the group';
          const { error } = await supabase.rpc('set_fee_groups', { p_fee_ids: [f.id], p_group: sel.value, p_add: true });
          if (error) { say(safeErrorMessage(error, 'Could not change the groups.'), true, sec.key); sel.value = ''; return; }
          say(`"${f.label}" is now also in ${gname}.`, false, sec.key); await reload();
        });
        also.appendChild(sel);
      }
    } else also.appendChild(h('span', { style: NOTE }, '—'));
    const acts = h('td');
    for (const a of ctx.actionsFor(f)) {
      const b = h('button', { type: 'button', class: 'act-btn ' + (a.cls || ''), 'data-onclick': a.act, 'data-onclick-a0': f.id, title: a.title || a.label }, a.label);
      acts.appendChild(b);
    }
    if (committee && f.category === 'procedure' && sec.group) acts.appendChild(button(`Remove from ${sec.name}`, async () => {   // G8: says exactly what it does
      const { error } = await supabase.rpc('set_fee_groups', { p_fee_ids: [f.id], p_group: sec.group.id, p_add: false });
      if (error) { say(safeErrorMessage(error, 'Could not change the groups.'), true, sec.key); return; }
      say(`"${f.label}" removed from ${sec.name}.`, false, sec.key); await reload();
    }, false, { 'aria-label': `Remove ${f.label} from ${sec.name}`, title: `Take this fee out of ${sec.name} only — it stays in its other sections; the fee itself is not deleted`,
                style: 'min-height:32px;font-size:12px' }));
    if (!acts.childNodes.length) acts.appendChild(h('span', { style: NOTE }, '—'));
    return h('tr', { 'data-fee-id': f.id }, name, price, st, also, acts);   // the row the page's own actions find (Reject opens its reason box here)
  }

  function sectionBox(sec) {
    const rows = sec.rows.filter(r => matches(r.fee));
    const gaps = sec.key === 'cat:ipd' && !_status && !_q.trim() ? (ctx.roomGaps() || []) : [];
    if (filtering() && !rows.length) return null;
    const pend = sec.rows.filter(r => r.fee.approval_status === 'pending' || r.fee.approval_status === 'dept_approved').length;
    const live = sec.rows.filter(r => r.fee.approval_status !== 'rejected').length, rej = sec.rows.length - live;   // G5
    const isOpen = filtering() ? true : (_open.has(sec.key) || _flash?.sec === sec.key);
    const body = h('div', { hidden: !isOpen, style: 'margin-top:8px' });
    const head = h('button', { type: 'button', 'aria-expanded': String(isOpen), title: `Open or close ${sec.name}`, style: 'background:none;border:0;padding:0 4px;font:inherit;text-align:left;cursor:pointer;flex:1;min-height:44px;display:flex;align-items:center;gap:8px;font-weight:700;color:var(--green-deep)' },
      (isOpen ? '▾ ' : '▸ ') + sec.name,
      h('span', { style: NOTE }, `· ${live}` + (pend ? ` · ${pend} pending` : '') + (rej && _status !== 'rejected' ? ` · ${rej} rejected hidden` : '') + (gaps.length ? ` · ${gaps.length} room rate(s) needed` : '')
        + (sec.group && !sec.group.is_active ? ' · inactive' : '')));
    head.addEventListener('click', () => {
      const o = body.hidden; body.hidden = !o; head.setAttribute('aria-expanded', String(o));
      head.firstChild.textContent = (o ? '▾ ' : '▸ ') + sec.name;
      if (o) _open.add(sec.key); else _open.delete(sec.key);
    });
    const tools = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
    const extra = h('div');
    const toggleExtra = (node) => { extra.replaceChildren(...(extra.firstChild === node ? [] : [node])); body.hidden = false; head.setAttribute('aria-expanded', 'true'); _open.add(sec.key); };
    const isGroup = !!sec.group && !(sec.cats && sec.cats.length && sec.cats[0] !== 'opd' && sec.cats[0] !== 'ipd');
    const sayHere = (t, bad = false) => say(t, bad, sec.key);   // G12: the message shows in this section after the redraw
    if (sec.cats) tools.appendChild(button('+ Add', () => ctx.openAdd(sec.cats[0]), true, { title: `Add a new fee to ${sec.name} (it starts Pending)` }));
    else if (committee && sec.group) { const f = _addProcedureForm(supabase, sec.group, sayHere, reload); tools.appendChild(button('+ Add', () => toggleExtra(f), true, { title: `Add a new procedure with its price to ${sec.name} (it starts Pending)` })); }
    if (committee && sec.group && isGroup) {
      const inThis = new Set(sec.rows.map(r => r.fee.id));
      const dl = h('datalist', { id: 'dl-' + sec.group.id }, fees.filter(f => f.category === 'procedure' && !inThis.has(f.id) && f.approval_status !== 'rejected').map(f => h('option', { value: f.label })));
      const inp = h('input', { type: 'text', list: 'dl-' + sec.group.id, placeholder: 'Type to find an existing fee', 'aria-label': 'Existing fee to add to ' + sec.name, class: 'fee-input',
        title: 'Type part of a fee name and choose it from the list', style: 'min-height:44px;min-width:240px' });
      const addEx = button('Add to ' + sec.name, async () => {
        const f = fees.find(x => x.category === 'procedure' && x.label === inp.value.trim() && !inThis.has(x.id));
        if (!f) { sayHere('Choose a fee from the list (type part of its name).', true); return; }
        const { error } = await supabase.rpc('set_fee_groups', { p_fee_ids: [f.id], p_group: sec.group.id, p_add: true });
        if (error) { sayHere(safeErrorMessage(error, 'Could not add it to the section.'), true); return; }
        sayHere(`"${f.label}" is now also in ${sec.name} (the same fee and price — not a copy).`); await reload();
      }, true, { title: `Put the chosen fee in ${sec.name} too` });
      const box = h('div', { style: 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center' }, dl, inp, addEx);
      tools.appendChild(button('+ Add existing fee', () => toggleExtra(box), false, { title: `Offer a fee that is already in the list in ${sec.name} too — the same fee and price, never a copy` }));   // G3
      const imp = _importForm(supabase, sec.group, sayHere, reload);
      tools.appendChild(button('Import CSV', () => toggleExtra(imp), false, { title: `Add many new procedures to ${sec.name} from a CSV file (a preview first; nothing is saved until you confirm)` }));
    }
    const exportRows = sec.rows.map(r => r.fee).filter(f => f.approval_status !== 'rejected' || _status === 'rejected');
    tools.appendChild(button('⬇ Export CSV', () => download(`fees_${sec.name.replace(/[^A-Za-z0-9]+/g, '_')}.csv`, 'name,price,status,ayush_code,also_in\n'
      + exportRows.map(f => [f.label, f.amount, STATUS[f.approval_status] || f.approval_status, f.ayush_code || '',
          ((sec.rows.find(r => r.fee.id === f.id)?.also) || []).map(id => groupById.get(id)?.display_name).filter(Boolean).join('; ')].map(csvCell).join(',')).join('\n')),
      false, { title: `Download ${sec.name} as a CSV file (opens in Excel)` }));
    tools.appendChild(button('🖨 Print / PDF', () => _printSection({ display_name: sec.name }, exportRows), false, { title: `Print ${sec.name}, or save it as a PDF` }));
    const tbl = h('table', { style: 'width:100%;border-collapse:collapse;font-size:13px' },
      h('thead', null, h('tr', null, ['Name', 'Price', 'Status', 'Also in', 'Actions'].map(x => h('th', { style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border)' }, x)))));
    const tb = h('tbody');
    for (const r of rows) tb.appendChild(feeRow(r, sec));
    for (const gp of gaps) tb.appendChild(h('tr', null, h('td', null, h('div', { style: 'font-weight:600' }, 'Room rate — ' + gp.label), h('div', { style: NOTE }, 'No room rate for this bed type yet')),
      h('td', null, '—'), h('td', null, h('span', { class: 'status-badge status-pending' }, 'Rate needed')), h('td', null, '—'),
      h('td', null, h('button', { type: 'button', class: 'act-btn act-approve', 'data-onclick': 'openAddRoomRate', 'data-onclick-a0': gp.bedType }, '+ Add rate'))));
    if (!tb.childNodes.length) tb.appendChild(h('tr', null, h('td', { colspan: '5', style: NOTE + ';padding:8px' }, 'No fee in this section yet.')));
    tbl.appendChild(tb);
    const here = _flash && _flash.sec === sec.key ? h('div', { role: _flash.bad ? 'alert' : 'status', 'data-sec-msg': '1',
      style: `font-size:13px;font-weight:600;margin:6px 0;color:${_flash.bad ? 'var(--red, #b03a2e)' : 'var(--green-deep, #1a4a2e)'}` }, _flash.text) : null;
    if (here) SEC_MSG.set(sec.key, here);
    body.append(...(here ? [here] : []), tools, extra, h('div', { style: 'overflow-x:auto;margin-top:8px' }, tbl));
    if (committee && sec.group && !sec.cats) body.appendChild(_renameForm(supabase, sec.group, sayHere, reload));
    return h('div', { style: BOX }, h('div', { style: 'display:flex;align-items:center;gap:8px' }, head), body);
  }

  function draw() {
    list.replaceChildren();
    let shown = 0;
    for (const s of sections) { const b = sectionBox(s); if (b) { list.appendChild(b); shown++; } }
    if (!shown) list.appendChild(h('div', { style: NOTE + ';padding:8px' }, 'No fee matches the search / status.'));
  }
  draw();
  container.style.minHeight = '';   // H4: the kept height is released once the new list is drawn
  // H4: the list a chip just opened (the attention panel, or the filtered list for "Pending approval") comes smoothly into view, outlined
  if (_focus) {
    const target = focusEl || list;
    _focus = null;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
    target.classList.add('attn-flash');
    setTimeout(() => target.classList.remove('attn-flash'), 2000);
    if (focusEl) focusEl.focus({ preventScroll: true });
  }
  // G12: after the redraw, bring the section's message into view once
  if (_flash?.fresh) { const m = _flash.sec && SEC_MSG.get(_flash.sec); _flash.fresh = false; (m || msg).scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
