// taxProfiles.js -- the "Tax profiles" panel (Session 345j, TODO §177): list, new profile, edit / submit a draft, a new version (rate
// change), approve / reject, confirm the Accounts review of a migration-made version, retire. Shown under 🧾 Tax & Invoicing on
// admin.html (super_admin / dept_admin) and finance.html (the tax makers and approvers).
// Reads (own organisation, RLS): tax_profiles, tax_profile_versions, tax_approval_history, gst_rate_platform (the platform rate rule:
// the usual GST rates + the maximum). Writes: a MANUAL profile and DRAFT versions by plain INSERT / UPDATE / DELETE under RLS (a tax
// maker: super_admin / dept_admin / finance_manager / accountant, active); every other step through the session-299 functions
// (submit_tax_profile_version, decide_tax_profile_version, confirm_tax_version_accounts_review, retire_tax_profile_version,
// copy_tax_profile_version_to_draft), which re-check everything. WHICH decision buttons a person sees is the server's answer
// (tax_version_decide_check, D8) -- no copy of the rules here.
// Owner decisions (14 Oct 2026, docs/handoff/todo177_tax_profile_editor_plan.md): D2 Taxable / Exempt / Nil-rated only; D3 Goods (HSN)
// or Services (SAC) only; D4 a plain number box, CGST = SGST = half, IGST 0; the server refuses outside 0 .. the platform maximum (40);
// a rate not in the platform's usual list needs a tick ("X% is not one of the usual GST rates -- confirm"); D5 never back-dated; D9 the
// name can change only before the first approval, the description always, no Deactivate button. No GST rate is written in this file.
// DOM nodes + textContent only; no native confirm() / alert(); every message in-page.
import { safeErrorMessage } from '../../utils/errors.js';
import { el } from '../pharmacy/returnPanel.js';
import { isTaxMaker } from '../pharmacy/itemTax.js';

const btn = (label, cls, onClick, attrs = {}) => { const b = el('button', { type: 'button', class: cls, ...attrs }, label); b.addEventListener('click', onClick); return b; };
let _n = 0;
const uid = p => `${p}-${++_n}`;
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const fmtD = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const num = v => Number(Number(v).toFixed(3));                  // 2.50 -> 2.5, 0.125 stays
export const CATEGORY = { TAXABLE: 'Taxable', EXEMPT: 'Exempt', NIL_RATED: 'Nil-rated' };   // D2: the only categories offered
export const CODE = { HSN: 'Goods (HSN)', SAC: 'Services (SAC)' };                          // D3
export function rateText(v) {
  if (!v) return '—';
  if (v.tax_category !== 'TAXABLE') return CATEGORY[v.tax_category] || String(v.tax_category || '').toLowerCase();
  return `${num(v.gst_rate)}% (CGST ${num(v.cgst_rate)}% + SGST ${num(v.sgst_rate)}%)`;
}
// a rate split as the server stores it: CGST = SGST = half (D4); IGST stays 0 (inter-state is not supported yet)
export function split(rate) {
  const r = Number(rate);
  return { gst_rate: r, cgst_rate: r / 2, sgst_rate: r / 2, igst_rate: 0 };
}
// the D4 checks before anything is sent: the number itself, then whether it is a usual rate (the platform list)
export function rateCheck(raw, rule) {
  const s = String(raw ?? '').trim();
  const parts = s.split('.');                                    // whole part 1-2 digits, optional 1-2 decimals
  if (parts.length > 2 || !/^\d{1,2}$/.test(parts[0]) || (parts.length === 2 && !/^\d{1,2}$/.test(parts[1]))) {
    return { ok: false, msg: 'Enter the GST rate as a number, e.g. 5 or 18 (up to 2 decimals).' };
  }
  const r = Number(s), max = Number(rule?.max_rate);
  if (!(r > 0)) return { ok: false, msg: 'A taxable profile needs a rate above 0%. For no tax, choose Exempt or Nil-rated.' };
  if (!max) return { ok: false, msg: 'The platform rate rule could not be read — please reload.' };
  if (r > max) return { ok: false, msg: `A GST rate must be between 0% and ${num(max)}%.` };
  const usual = (rule.standard_rates || []).map(Number);
  return { ok: true, rate: r, usual: usual.includes(r) };
}
const WHY = {
  own_request: 'You made or submitted this version — another Super Admin or Finance Manager decides it.',
  not_authorised: 'Waiting for a Super Admin or Finance Manager.',
  inactive: 'Your account is not active.',
  back_dated: 'It starts on a date that has already passed, so it can only be rejected. Make a new version that starts today or later.',
  not_pending: '',
};
const STATE = { DRAFT: 'Draft', PENDING_APPROVAL: 'Waiting for approval', APPROVED: 'Approved', REJECTED: 'Rejected', RETIRED: 'Retired' };

function field(label, control, hint) {
  const lid = control.id || uid('tp-f');
  control.id = lid;
  return el('div', { class: 'rp-field' }, el('label', { for: lid, class: 'rp-lbl' }, label), control, hint ? el('div', { class: 'rp-muted' }, hint) : null);
}
function status() { return el('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' }); }
function say(node, text, err) { node.textContent = text || ''; node.className = 'rp-status' + (err ? ' err' : text ? ' ok' : ''); }
const badge = (text, kind) => el('span', { class: 'tp-badge tp-' + kind }, text);

/**
 * Mounts the panel into root. Returns { reload }.
 * @param {HTMLElement} root
 * @param {{ supabase: any, onChange?: Function, onCount?: Function }} opts
 */
export function mountTaxProfiles(root, { supabase, onChange, onCount } = {}) {
  const hId = uid('tp-h');
  const top = status();
  const body = el('div', { class: 'tp-body' });
  const maker = isTaxMaker();
  root.replaceChildren(el('section', { class: 'rp-card tp-card', 'aria-labelledby': hId, 'data-tax-profiles': '' },
    el('div', { class: 'rp-row rq-head' }, el('h3', { class: 'rp-h', id: hId }, '🧮 Tax profiles'), btn('↻ Refresh', 'rp-btn', () => reload())),
    el('p', { class: 'rp-sub' }, 'A tax profile is the GST treatment of a group of items (for example "Medicines — Taxable 5%"). A new profile or a rate change is a version: it applies only after a Super Admin or Finance Manager approves it (never the person who made it, except an organisation\'s only Super Admin), and never from a past date. Bills already issued never change.'),
    top, body));

  let _seq = 0, D = null;
  async function reload() {
    const my = ++_seq;
    body.setAttribute('aria-busy', 'true');
    body.querySelectorAll('input, select, textarea, button').forEach(c => { c.disabled = true; });
    say(top, 'Loading…');
    const today = istToday();
    const [pr, vr, rr] = await Promise.all([
      supabase.from('tax_profiles').select('id, name, description, origin, is_active, created_at').order('name'),
      supabase.from('tax_profile_versions').select('id, profile_id, version_no, code_type, tax_category, gst_rate, cgst_rate, sgst_rate, effective_from, effective_to, status, needs_review, approval_role, created_by, submitted_by, submitted_at, approved_at, rejection_reason, retire_reason, created_at').order('version_no', { ascending: false }),
      supabase.from('gst_rate_platform').select('effective_from, standard_rates, max_rate').lte('effective_from', today).order('effective_from', { ascending: false }).limit(1),
    ]);
    if (my !== _seq) return;
    const err = pr.error || vr.error || rr.error;
    if (err) { body.removeAttribute('aria-busy'); say(top, safeErrorMessage(err, 'Could not load the tax profiles.'), true); body.replaceChildren(); return; }
    const versions = vr.data || [];
    // the decisions THIS person may take: the server's answer for every version that is waiting, approved or awaiting review
    const ids = versions.filter(v => v.status === 'PENDING_APPROVAL' || v.status === 'APPROVED').map(v => v.id);
    let checks = [];
    if (ids.length) {
      const ck = await supabase.rpc('tax_version_decide_check', { p_ids: ids });
      if (my !== _seq) return;
      if (ck.error) { body.removeAttribute('aria-busy'); say(top, safeErrorMessage(ck.error, 'Could not load the tax profiles.'), true); body.replaceChildren(); return; }
      checks = ck.data || [];
    }
    const people = [...new Set(versions.flatMap(v => [v.created_by, v.submitted_by]).filter(Boolean))];
    let names = {};
    if (people.length) {
      const pp = await supabase.from('profiles').select('id, full_name').in('id', people);
      if (my !== _seq) return;
      names = Object.fromEntries((pp.data || []).map(p => [p.id, p.full_name]));
    }
    body.removeAttribute('aria-busy');
    D = { today, profiles: pr.data || [], versions, rule: (rr.data || [])[0] || null, check: Object.fromEntries(checks.map(c => [c.id, c])), names };
    say(top, '');
    const waiting = versions.filter(v => v.status === 'PENDING_APPROVAL' || (v.status === 'APPROVED' && v.needs_review));
    onCount?.(waiting.filter(v => { const c = D.check[v.id] || {}; return c.can_approve || c.can_reject || c.can_confirm_review; }).length);
    body.replaceChildren(waitingSection(waiting), listSection(), maker ? newSection() : el('span'));
  }
  const after = async (node, okText) => { onChange?.(); await reload(); say(node, okText); };
  const who = id => (id && D.names[id]) || '—';
  const profileOf = id => D.profiles.find(p => p.id === id);
  const versionsOf = id => D.versions.filter(v => v.profile_id === id);
  const currentOf = id => versionsOf(id).find(v => v.status === 'APPROVED' && v.effective_from <= D.today && (!v.effective_to || v.effective_to >= D.today));
  const everApproved = id => versionsOf(id).some(v => v.status === 'APPROVED' || v.status === 'RETIRED');

  // ── 1. waiting for a decision (pending versions + migration-made ones awaiting the Accounts review) ──
  function waitingSection(waiting) {
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'tp-waiting' }, el('h4', { class: 'ts-h4' }, 'Waiting for a decision'));
    if (!waiting.length) { sec.append(el('p', { class: 'rp-muted' }, 'Nothing is waiting.')); return sec; }
    for (const v of waiting) sec.append(waitingItem(v));
    return sec;
  }
  function waitingItem(v) {
    const p = profileOf(v.profile_id) || {};
    const c = D.check[v.id] || {};
    const cur = currentOf(v.profile_id);
    const review = v.status === 'APPROVED';
    const msg = status();
    const box = el('div', { class: 'tp-item', 'data-waiting': v.id },
      el('div', { class: 'tp-item-h' }, el('strong', null, p.name || '—'), ' ', badge(review ? 'Accounts review' : 'Waiting for approval', review ? 'warn' : 'pend'),
        ' ', el('span', { class: 'rp-muted' }, `version ${v.version_no} · ${CODE[v.code_type] || v.code_type}`)));
    if (review) {
      box.append(el('p', { class: 'rp-muted' }, `Made by a migration and in use since ${fmtD(v.effective_from)}: ${rateText(v)}. An approver confirms that it is right.`));
    } else {
      box.append(el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-change': v.id },
        el('thead', null, el('tr', null, ['', 'Now', 'After approval'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null,
          el('tr', null, el('th', { scope: 'row' }, 'Rate'), el('td', null, cur ? rateText(cur) : 'none (new profile)'), el('td', null, rateText(v))),
          el('tr', null, el('th', { scope: 'row' }, 'From'), el('td', null, cur ? fmtD(cur.effective_from) : '—'), el('td', null, fmtD(v.effective_from)))))),
        el('p', { class: 'rp-muted' }, `Made by ${who(v.created_by)} · submitted by ${who(v.submitted_by)} on ${when(v.submitted_at)}`));
    }
    const acts = el('div', { class: 'rp-actions' });
    if (c.self) box.append(el('p', { class: 'rp-muted', 'data-self': '' }, 'You are this organisation\'s only Super Admin, so you may decide your own version. It is recorded as "self-approved (sole administrator)".'));
    if (c.can_approve) acts.append(btn('Approve', 'rp-btn rp-btn-go', () => decide(true), { 'data-approve': v.id }));
    if (c.can_confirm_review) acts.append(btn('Confirm Accounts review', 'rp-btn rp-btn-go', () => confirmReview(), { 'data-confirm': v.id }));
    const reason = el('textarea', { class: 'rp-input', rows: '2', maxlength: '500', id: uid('tp-rj'), placeholder: 'Reason for rejecting (at least 5 characters)' });
    if (c.can_reject) acts.append(btn('Reject', 'rp-btn rp-btn-no', () => decide(false), { 'data-reject': v.id }));
    if (!c.can_approve && !c.can_reject && !c.can_confirm_review && WHY[c.why]) box.append(el('p', { class: 'rp-muted', 'data-why': c.why }, WHY[c.why]));
    else if (c.why === 'back_dated') box.append(el('p', { class: 'rp-muted', 'data-why': c.why }, WHY.back_dated));
    if (c.can_reject) box.append(field('Reason (needed only to reject)', reason));
    box.append(acts, msg);
    async function decide(ok) {
      if (!ok && reason.value.trim().length < 5) { say(msg, 'Give a reason for rejecting (at least 5 characters).', true); reason.focus(); return; }
      acts.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const { error } = await supabase.rpc('decide_tax_profile_version', { p_version_id: v.id, p_approve: ok, p_notes: ok ? null : reason.value.trim() });
      acts.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (error) { say(msg, safeErrorMessage(error, 'Could not record the decision.'), true); return; }
      await after(top, ok ? `✓ Approved — "${p.name}" uses it from ${fmtD(v.effective_from)}.` : '✓ Rejected.');
    }
    async function confirmReview() {
      acts.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const { error } = await supabase.rpc('confirm_tax_version_accounts_review', { p_version_id: v.id, p_notes: null });
      acts.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (error) { say(msg, safeErrorMessage(error, 'Could not confirm the review.'), true); return; }
      await after(top, '✓ Accounts review confirmed.');
    }
    return box;
  }

  // ── 2. the profiles ──
  function listSection() {
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'tp-list' }, el('h4', { class: 'ts-h4' }, 'Profiles'));
    if (!D.profiles.length) { sec.append(el('p', { class: 'rp-muted' }, 'No tax profiles yet.')); return sec; }
    for (const p of D.profiles) sec.append(profileItem(p));
    return sec;
  }
  function profileItem(p) {
    const vs = versionsOf(p.id);
    const cur = currentOf(p.id);
    const later = vs.filter(v => v.status === 'APPROVED' && v.effective_from > D.today).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
    const draft = vs.find(v => v.status === 'DRAFT');
    const pend = vs.find(v => v.status === 'PENDING_APPROVAL');
    const shown = cur || later || vs[0];
    const c = (cur && D.check[cur.id]) || {};
    const msg = status();
    const head = el('div', { class: 'tp-item-h' }, el('strong', null, p.name), ' ',
      shown ? el('span', { class: 'rp-muted' }, CODE[shown.code_type] || shown.code_type) : null, ' ',
      !p.is_active ? badge('Deactivated', 'off') : null,
      pend ? badge('Waiting for approval', 'pend') : null, draft ? badge('Draft', 'draft') : null,
      cur?.needs_review ? badge('Accounts review', 'warn') : null);
    const now = el('p', { class: 'ts-now', 'data-now': p.id },
      cur ? `Today: ${rateText(cur)} — from ${fmtD(cur.effective_from)}${cur.effective_to ? ' to ' + fmtD(cur.effective_to) : ''}`
          : later ? `Not in force yet — ${rateText(later)} from ${fmtD(later.effective_from)}` : 'No approved version — it cannot be used yet.');
    const box = el('div', { class: 'tp-item', 'data-profile': p.id }, head, now);
    if (later && cur) box.append(el('p', { class: 'rp-muted' }, `Then: ${rateText(later)} from ${fmtD(later.effective_from)}`));
    if (p.description) box.append(el('p', { class: 'rp-muted' }, p.description));
    if (Array.isArray(c.uses) && c.uses.length) box.append(el('p', { class: 'rp-muted', 'data-uses': p.id }, 'In use: ' + c.uses.join(', ')));
    const acts = el('div', { class: 'rp-actions' });
    const work = el('div', { class: 'tp-work' });
    if (maker && draft) acts.append(btn('Edit draft', 'rp-btn', () => work.replaceChildren(draftForm(p, draft, work)), { 'data-edit-draft': draft.id }));
    if (maker && !draft && !pend && cur) acts.append(btn('New version (rate change)', 'rp-btn', () => work.replaceChildren(newVersionForm(p, cur, work)), { 'data-new-version': p.id }));
    if (maker && !draft && !pend && !vs.length) acts.append(btn('Add the first version', 'rp-btn', () => work.replaceChildren(draftForm(p, null, work)), { 'data-first-version': p.id }));
    if (maker) acts.append(btn('Name / description', 'rp-btn', () => work.replaceChildren(namesForm(p, work)), { 'data-names': p.id }));
    if (cur && c.can_retire) acts.append(btn('Retire…', 'rp-btn rp-btn-no', () => work.replaceChildren(retireForm(p, cur, work)), { 'data-retire': cur.id }));
    const hist = el('details', { class: 'tp-hist' }, el('summary', null, `Versions and history (${vs.length})`));
    hist.addEventListener('toggle', () => { if (hist.open && hist.children.length === 1) loadHistory(p, vs, hist); });
    box.append(acts, work, msg, hist);
    return box;
  }
  async function loadHistory(p, vs, hist) {
    hist.append(el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-versions': p.id },
      el('thead', null, el('tr', null, ['Version', 'Rate', 'From', 'To', 'State'].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', null, vs.map(v => el('tr', null, el('td', null, String(v.version_no)), el('td', null, rateText(v)), el('td', null, fmtD(v.effective_from)),
        el('td', null, fmtD(v.effective_to)), el('td', null, STATE[v.status] || v.status, v.rejection_reason ? ` — ${v.rejection_reason}` : '', v.retire_reason ? ` — ${v.retire_reason}` : '')))))));
    const { data, error } = await supabase.from('tax_approval_history').select('action, user_role, notes, created_at, tax_profile_version_id')
      .eq('tax_profile_id', p.id).order('created_at', { ascending: false }).limit(50);
    if (error) { hist.append(el('p', { class: 'rp-muted' }, safeErrorMessage(error, 'Could not load the history.'))); return; }
    const vno = id => vs.find(v => v.id === id)?.version_no;
    hist.append(el('ul', { class: 'ts-rd-list', 'data-history': p.id }, (data || []).map(h => el('li', { class: 'ts-rd-item' },
      `${when(h.created_at)} · ${String(h.action).replace(/_/g, ' ').toLowerCase()}${vno(h.tax_profile_version_id) ? ' (version ' + vno(h.tax_profile_version_id) + ')' : ''} · ${String(h.user_role || '').replace(/_/g, ' ')}${h.notes ? ' — ' + h.notes : ''}`))));
  }

  // the D4 rate controls (shared by the new-profile and draft forms): category, rate, the review line, the "unusual rate" tick
  function rateControls(init = {}) {
    const cat = el('select', { class: 'rp-input', id: uid('tp-cat') });
    for (const [k, label] of Object.entries(CATEGORY)) cat.append(el('option', { value: k }, label));
    cat.value = CATEGORY[init.tax_category] ? init.tax_category : 'TAXABLE';
    const rate = el('input', { type: 'text', inputmode: 'decimal', class: 'rp-input tp-rate', id: uid('tp-rate'), autocomplete: 'off',
      value: init.tax_category === 'TAXABLE' && init.gst_rate != null ? String(num(init.gst_rate)) : '' });
    const rateF = field('GST rate (%)', rate, D.rule ? `Up to ${num(D.rule.max_rate)}%. Split equally: CGST = SGST = half.` : null);
    const review = el('p', { class: 'ts-preview', 'data-rate-review': '' });
    const tick = el('input', { type: 'checkbox', id: uid('tp-tick') });
    const warn = el('label', { class: 'tp-warn', for: tick.id, 'data-unusual': '' }, tick, el('span', null, ''));
    const upd = () => {
      const taxable = cat.value === 'TAXABLE';
      rateF.hidden = !taxable;
      warn.hidden = true;
      if (!taxable) { review.textContent = `${CATEGORY[cat.value]} — no GST is charged (0%).`; return; }
      const r = rateCheck(rate.value, D.rule);
      if (!r.ok) { review.textContent = rate.value.trim() ? r.msg : 'Enter the rate.'; return; }
      review.textContent = `${num(r.rate)}% = CGST ${num(r.rate / 2)}% + SGST ${num(r.rate / 2)}%`;
      if (!r.usual) { warn.hidden = false; warn.lastChild.textContent = ` ${num(r.rate)}% is not one of the usual GST rates — tick to confirm it is right.`; tick.checked = false; }
    };
    cat.addEventListener('change', upd); rate.addEventListener('input', upd); upd();
    // the values to store, or { error, focus }
    const read = () => {
      if (cat.value !== 'TAXABLE') return { tax_category: cat.value, gst_rate: 0, cgst_rate: 0, sgst_rate: 0, igst_rate: 0 };
      const r = rateCheck(rate.value, D.rule);
      if (!r.ok) return { error: r.msg, focus: rate };
      if (!r.usual && !tick.checked) return { error: `${num(r.rate)}% is not one of the usual GST rates — tick the box to confirm it, or correct the rate.`, focus: tick };
      return { tax_category: 'TAXABLE', ...split(r.rate) };
    };
    return { nodes: [field('Category', cat), rateF, review, warn], read };
  }
  function dateInput(value) { return el('input', { type: 'date', class: 'rp-input', min: D.today, value: value && value >= D.today ? value : D.today, id: uid('tp-dt') }); }
  const dateHint = 'Today or later — a tax version is never back-dated.';

  // ── 3. a new profile (a tax maker) ──
  function newSection() {
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'tp-new' }, el('h4', { class: 'ts-h4' }, 'New tax profile'));
    const open = btn('＋ New tax profile', 'rp-btn', () => { open.hidden = true; sec.append(newForm(() => { open.hidden = false; })); }, { 'data-new-profile': '' });
    sec.append(open);
    return sec;
  }
  function newForm(onClose) {
    const name = el('input', { type: 'text', class: 'rp-input', maxlength: '120', id: uid('tp-nm'), placeholder: 'e.g. Medicines — Taxable 5%' });
    const desc = el('textarea', { class: 'rp-input', rows: '2', maxlength: '500', id: uid('tp-ds'), placeholder: 'Optional — what it is for' });
    const fs = el('fieldset', { class: 'rp-fieldset' }, el('legend', { class: 'rp-lbl' }, 'It is for'));
    const g = el('input', { type: 'radio', name: uid('tp-code'), value: 'HSN', id: uid('tp-g') });
    const s = el('input', { type: 'radio', name: g.name, value: 'SAC', id: uid('tp-s') });
    g.checked = true;
    fs.append(el('label', { class: 'rp-radio', for: g.id }, g, ' Goods (HSN) — medicines, products'), el('label', { class: 'rp-radio', for: s.id }, s, ' Services (SAC) — treatment, rooms, wellness'));
    const rc = rateControls();
    const date = dateInput();
    const msg = status();
    const form = el('div', { class: 'rp-form', 'data-form': 'tp-new' });
    const save = submitNow => async () => {
      const nm = name.value.trim();
      if (nm.length < 3) { say(msg, 'Give the profile a name (at least 3 characters).', true); name.focus(); return; }
      if (D.profiles.some(p => p.name.trim().toLowerCase() === nm.toLowerCase())) { say(msg, 'A profile with this name already exists.', true); name.focus(); return; }
      const r = rc.read();
      if (r.error) { say(msg, r.error, true); r.focus?.focus(); return; }
      if (!date.value || date.value < D.today) { say(msg, 'The start date must be today or later.', true); date.focus(); return; }
      form.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const pid = crypto.randomUUID(), vid = crypto.randomUUID();
      const tenant = sessionStorage.getItem('ayurxpert_tenant_id');
      const ins = await supabase.from('tax_profiles').insert({ id: pid, tenant_id: tenant, name: nm, description: desc.value.trim() || null, origin: 'MANUAL' });
      if (ins.error) { form.querySelectorAll('button').forEach(b => { b.disabled = false; }); say(msg, safeErrorMessage(ins.error, 'Could not create the profile.'), true); return; }
      const iv = await supabase.from('tax_profile_versions').insert({ id: vid, tenant_id: tenant, profile_id: pid, code_type: g.checked ? 'HSN' : 'SAC',
        tax_category: r.tax_category, gst_rate: r.gst_rate, cgst_rate: r.cgst_rate, sgst_rate: r.sgst_rate, igst_rate: 0, effective_from: date.value });
      if (iv.error) { await after(top, ''); say(top, `The profile "${nm}" was created, but its first version was not saved: ${safeErrorMessage(iv.error, 'please add it from the list.')}`, true); return; }
      if (submitNow) {
        const sb = await supabase.rpc('submit_tax_profile_version', { p_version_id: vid, p_notes: null });
        if (sb.error) { await after(top, ''); say(top, `Saved as a draft, but not submitted: ${safeErrorMessage(sb.error, 'please submit it from the list.')}`, true); return; }
      }
      await after(top, submitNow ? `✓ "${nm}" sent for approval.` : `✓ "${nm}" saved as a draft.`);
    };
    form.append(field('Name', name, '3 to 120 characters. It can be changed until the first approval.'), field('Description', desc), fs, ...rc.nodes,
      field('Valid from', date, dateHint),
      el('div', { class: 'rp-actions' }, btn('Save and send for approval', 'rp-btn rp-btn-go', save(true), { 'data-save-submit': '' }),
        btn('Save as draft', 'rp-btn', save(false), { 'data-save-draft': '' }),
        btn('Cancel', 'rp-btn', () => { form.remove(); onClose?.(); })), msg);
    return form;
  }

  // ── 4. a draft (edit / submit / delete) or the first version of a profile that has none ──
  function draftForm(p, v, work) {
    const vs = versionsOf(p.id);
    const code = v?.code_type || vs[0]?.code_type || null;
    let codeSel = null;
    if (!code) { codeSel = el('select', { class: 'rp-input', id: uid('tp-cd') }); for (const [k, l] of Object.entries(CODE)) codeSel.append(el('option', { value: k }, l)); }
    const rc = rateControls(v || {});
    const date = dateInput(v?.effective_from);
    const msg = status();
    const form = el('div', { class: 'rp-form', 'data-form': 'tp-draft' });
    if (v && v.effective_from < D.today) form.append(el('p', { class: 'rp-muted' }, `This draft starts on ${fmtD(v.effective_from)}, which has passed. Choose today or a later date before sending it.`));
    const save = async submitNow => {
      const r = rc.read();
      if (r.error) { say(msg, r.error, true); r.focus?.focus(); return; }
      if (!date.value || date.value < D.today) { say(msg, 'The start date must be today or later.', true); date.focus(); return; }
      form.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const row = { tax_category: r.tax_category, gst_rate: r.gst_rate, cgst_rate: r.cgst_rate, sgst_rate: r.sgst_rate, igst_rate: 0, effective_from: date.value };
      let id = v?.id, error;
      if (v) ({ error } = await supabase.from('tax_profile_versions').update(row).eq('id', v.id).eq('status', 'DRAFT'));
      else {
        id = crypto.randomUUID();
        ({ error } = await supabase.from('tax_profile_versions').insert({ id, tenant_id: sessionStorage.getItem('ayurxpert_tenant_id'), profile_id: p.id, code_type: code || codeSel.value, ...row }));
      }
      if (!error && submitNow) ({ error } = await supabase.rpc('submit_tax_profile_version', { p_version_id: id, p_notes: null }));
      form.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (error) { say(msg, safeErrorMessage(error, 'Could not save the draft.'), true); return; }
      await after(top, submitNow ? `✓ "${p.name}" sent for approval.` : '✓ Draft saved.');
    };
    const del = v ? btn('Delete draft', 'rp-btn rp-btn-no', async () => {
      form.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const { error } = await supabase.from('tax_profile_versions').delete().eq('id', v.id).eq('status', 'DRAFT');
      form.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (error) { say(msg, safeErrorMessage(error, 'Could not delete the draft.'), true); return; }
      await after(top, '✓ Draft deleted.');
    }, { 'data-delete-draft': v.id }) : null;
    form.append(el('p', { class: 'rp-muted' }, `${p.name} — ${CODE[code] || 'choose goods or services'}`), codeSel ? field('It is for', codeSel) : el('span'), ...rc.nodes,
      field('Valid from', date, dateHint),
      el('div', { class: 'rp-actions' }, btn('Save and send for approval', 'rp-btn rp-btn-go', () => save(true), { 'data-draft-submit': '' }),
        btn('Save draft', 'rp-btn', () => save(false), { 'data-draft-save': '' }), del, btn('Close', 'rp-btn', () => work.replaceChildren())), msg);
    return form;
  }

  // ── 5. a new version of an approved profile (copy_tax_profile_version_to_draft, then the draft form) ──
  function newVersionForm(p, cur, work) {
    const date = dateInput(D.today);
    const msg = status();
    const form = el('div', { class: 'rp-form', 'data-form': 'tp-newversion' },
      el('p', { class: 'rp-muted' }, `Now: ${rateText(cur)}. A new version starts on the date you choose; the current one then ends the day before (once approved).`),
      field('New version starts on', date, dateHint));
    form.append(el('div', { class: 'rp-actions' }, btn('Continue', 'rp-btn rp-btn-go', async () => {
      if (!date.value || date.value < D.today) { say(msg, 'The start date must be today or later.', true); date.focus(); return; }
      const { error } = await supabase.rpc('copy_tax_profile_version_to_draft', { p_version_id: cur.id, p_effective_from: date.value });
      if (error) { say(msg, safeErrorMessage(error, 'Could not start a new version.'), true); return; }
      await after(top, `A draft of "${p.name}" was made — open "Edit draft" to change the rate, then send it for approval.`);
    }, { 'data-copy': cur.id }), btn('Close', 'rp-btn', () => work.replaceChildren())), msg);
    return form;
  }

  // ── 6. name / description (D9: the name only before the first approval; no deactivation here) ──
  function namesForm(p, work) {
    const locked = everApproved(p.id);
    const name = el('input', { type: 'text', class: 'rp-input', maxlength: '120', id: uid('tp-nm2'), value: p.name });
    name.disabled = locked;
    const desc = el('textarea', { class: 'rp-input', rows: '2', maxlength: '500', id: uid('tp-ds2') });
    desc.value = p.description || '';
    const msg = status();
    const form = el('div', { class: 'rp-form', 'data-form': 'tp-names' },
      field('Name', name, locked ? 'The name is fixed once a version has been approved.' : '3 to 120 characters.'), field('Description', desc));
    form.append(el('div', { class: 'rp-actions' }, btn('Save', 'rp-btn rp-btn-go', async () => {
      const row = { description: desc.value.trim() || null };
      if (!locked) {
        const nm = name.value.trim();
        if (nm.length < 3) { say(msg, 'Give the profile a name (at least 3 characters).', true); name.focus(); return; }
        if (D.profiles.some(x => x.id !== p.id && x.name.trim().toLowerCase() === nm.toLowerCase())) { say(msg, 'A profile with this name already exists.', true); name.focus(); return; }
        row.name = nm;
      }
      const { error } = await supabase.from('tax_profiles').update(row).eq('id', p.id);
      if (error) { say(msg, safeErrorMessage(error, 'Could not save.'), true); return; }
      await after(top, '✓ Saved.');
    }, { 'data-names-save': p.id }), btn('Close', 'rp-btn', () => work.replaceChildren())), msg);
    return form;
  }

  // ── 7. retire (an approver; the server refuses while the profile is in use -- the button shows only when it may) ──
  function retireForm(p, cur, work) {
    const reason = el('textarea', { class: 'rp-input', rows: '2', maxlength: '500', id: uid('tp-rt'), placeholder: 'Why it is retired (at least 5 characters)' });
    const msg = status();
    const form = el('div', { class: 'rp-form', 'data-form': 'tp-retire' },
      el('p', { class: 'rp-muted' }, `Retiring "${p.name}" means it can no longer be used from today. Bills already issued keep it.`), field('Reason', reason));
    form.append(el('div', { class: 'rp-actions' }, btn('Retire this profile', 'rp-btn rp-btn-no', async () => {
      if (reason.value.trim().length < 5) { say(msg, 'Give a reason for retiring (at least 5 characters).', true); reason.focus(); return; }
      const { error } = await supabase.rpc('retire_tax_profile_version', { p_version_id: cur.id, p_reason: reason.value.trim() });
      if (error) { say(msg, safeErrorMessage(error, 'Could not retire it.'), true); return; }
      await after(top, `✓ "${p.name}" retired.`);
    }, { 'data-retire-go': cur.id }), btn('Close', 'rp-btn', () => work.replaceChildren())), msg);
    return form;
  }

  reload();
  return { reload };
}
