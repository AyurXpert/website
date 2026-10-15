// taxSettings.js -- the "🧾 Tax & Invoicing" card (Session 345c2a, GST Stage 5): the GST readiness check (Session 345d), the
// IP-medicines choice, the default tax profiles, the room-rent tax and the document numbering (Session 345e), the Bill of Supply
// declaration and the pharmacy GST go-live date. Reads:
// get_tax_settings_overview and gst_readiness (both: own organisation, active tax makers / approvers only); every change goes
// through its own server function, which re-checks the role:
//   * IP-medicines choice  -> request_ip_medicine_tax      (maker-checker, 'ip_medicine_tax')
//   * default profiles     -> request_tax_defaults_change  (maker-checker, 'tax_defaults_change')
//   * room-rent tax        -> request_room_tax_change      (maker-checker, 'room_tax_change'; effective-dated, never back-dated;
//                                                          the Rs 5,000 threshold + ICU exclusion are platform values, shown only)
//   * document numbering   -> set_document_numbering       (active super_admin only; saving = confirming, also when unchanged)
//   * declaration          -> set_bos_declaration          (active super_admin only)
//   * pharmacy go-live     -> set_pharmacy_gst_go_live     (active super_admin only; the server's refusal reason is shown)
//   * registration type    -> request_gst_scheme_change    (Session 345f: maker-checker, 'gst_scheme_change'; regular / composition from a date)
//   * composition tax base -> request_composition_tax_base (Session 345f, rule R7: maker-checker, 'composition_tax_base'; never affects a bill)
//   * annual return date   -> set_annual_return_date       (Session 345h, rule R3: active super_admin only; the panel itself is
//                                                          get_annual_return_dates -- super_admin / finance manager; the deadline it
//                                                          shows is the server's; a date earlier than an issued credit note is refused, D9)
// No GST rate is written here -- the profiles and their rates come from the server. DOM nodes + textContent only; no native
// confirm() / alert(); every message in-page.
import { safeErrorMessage } from '../../utils/errors.js';
import { el } from '../pharmacy/returnPanel.js';

const MAX_DECL = 300;
const BAD_DECL = /[<>]/;
const CTRL_DECL = /[\u0000-\u001f\u007f]/;
const btn = (label, cls, onClick, attrs = {}) => { const b = el('button', { type: 'button', class: cls, ...attrs }, label); b.addEventListener('click', onClick); return b; };
let _n = 0;
const uid = p => `${p}-${++_n}`;
const fmtD = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const catLabel = p => p.tax_category === 'TAXABLE' ? `${Number(p.gst_rate || 0)} %` : String(p.tax_category || '').toLowerCase().replace('_', '-');
const profLabel = p => `${p.name} — ${catLabel(p)}`;

function select(id, options, value, { none } = {}) {
  const s = el('select', { id, class: 'rp-input' });
  if (none) s.append(el('option', { value: '' }, none));
  for (const o of options) s.append(el('option', { value: o.id }, profLabel(o)));
  s.value = value || '';
  return s;
}
function field(label, control, hint) {
  const lid = control.id || uid('ts-f');
  control.id = lid;
  return el('div', { class: 'rp-field' }, el('label', { for: lid, class: 'rp-lbl' }, label), control, hint ? el('div', { class: 'rp-muted' }, hint) : null);
}
function status(cls) { return el('div', { class: 'rp-status' + (cls ? ' ' + cls : ''), role: 'status', 'aria-live': 'polite' }); }
function say(node, text, err) { node.textContent = text || ''; node.className = 'rp-status' + (err ? ' err' : text ? ' ok' : ''); }

/**
 * Mounts the card into root. Returns { reload }.
 * @param {HTMLElement} root
 * @param {{ supabase: any, onChange?: Function }} opts
 */
export function mountTaxSettings(root, { supabase, onChange } = {}) {
  const hId = uid('ts-h');
  const top = status();
  const body = el('div', { class: 'ts-body' });
  root.replaceChildren(el('section', { class: 'rp-card ts-card', 'aria-labelledby': hId, 'data-tax-settings': '' },
    el('div', { class: 'rp-row rq-head' }, el('h3', { class: 'rp-h', id: hId }, '🧾 Tax & Invoicing'), btn('↻ Refresh', 'rp-btn', () => reload())),
    el('p', { class: 'rp-sub' }, 'Changes to the registration type, the IP-medicines choice, the default tax profiles and the room tax profiles need a second person\'s approval (a Super Admin or Finance Manager — never the person who asked, except an organisation\'s only Super Admin). Bills already issued never change.'),
    top, body));

  // Session 345c2b (TODO §159): while a reload runs, the current forms are disabled (nothing typed into them can be lost
  // when they are replaced), and only the LATEST reload's answer is used (a slower, older reply is ignored)
  let _seq = 0;
  async function reload() {
    const my = ++_seq;
    body.setAttribute('aria-busy', 'true');
    body.querySelectorAll('input, select, textarea, button').forEach(c => { c.disabled = true; });
    say(top, 'Loading…');
    const { data, error } = await supabase.rpc('get_tax_settings_overview');
    if (my !== _seq) return;                                            // a newer reload has started: this reply is stale
    body.removeAttribute('aria-busy');
    if (error || !data) { say(top, safeErrorMessage(error, 'Could not load the tax settings.'), true); body.replaceChildren(); return; }
    say(top, '');
    body.replaceChildren(readinessSection(data), schemeSection(data), ipSection(data), defaultsSection(data), roomSection(data), numberingSection(data),
                         annualReturnSection(data), declarationSection(data), pharmacySection(data));
  }

  // reload FIRST, then show the result (a reload clears the status line -- the 345b "message kept after reload" lesson)
  const after = async (node, okText) => { onChange?.(); await reload(); say(node, okText); };

  // ── 0. Session 345d: the GST readiness check (gst_readiness) -- what would stop GST billing going live on a date. The SAME
  // check refuses set_tax_go_live on the server (only when the date is set or changed); this list is read-only.
  const LEVEL = { block: ['✖', 'Blocks'], warn: ['⚠', 'Warning'], info: ['ℹ', 'Note'], ok: ['✓', 'OK'] };
  function readinessSection(d) {
    const g = d.gst || {};
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'readiness' }, el('h4', { class: 'ts-h4' }, 'GST readiness'));
    const live = g.go_live_date && g.go_live_date <= d.today;
    sec.append(el('p', { class: 'rp-muted' }, live
      ? `GST billing is live since ${fmtD(g.go_live_date)}. This check is for information: it is applied again only when the GST go-live date is set or changed.`
      : 'Setting the GST go-live date is refused while any line under "GST billing" blocks. Pharmacy lines are shown but never block it.'));
    const date = el('input', { type: 'date', class: 'rp-input', id: uid('ts-rd'),
      value: g.go_live_date && g.go_live_date > d.today ? g.go_live_date : d.today });
    const out = el('div', { 'data-readiness': '', 'aria-live': 'polite' });
    const msg = status();
    let seq = 0;
    const check = btn('Check', 'rp-btn rp-btn-go', () => run(), { 'data-readiness-check': '' });
    async function run() {
      const my = ++seq;
      if (!date.value) { say(msg, 'Choose a date.', true); date.focus(); return; }
      check.disabled = true; out.setAttribute('aria-busy', 'true'); say(msg, 'Checking…');
      const { data, error } = await supabase.rpc('gst_readiness', { p_as_of: date.value });
      if (my !== seq) return;                                           // a newer check has started: this reply is stale
      check.disabled = false; out.removeAttribute('aria-busy');
      if (error || !data) { say(msg, safeErrorMessage(error, 'Could not run the readiness check.'), true); out.replaceChildren(); return; }
      say(msg, '');
      out.replaceChildren(...readinessResult(data));
    }
    sec.append(el('div', { class: 'rp-row' }, field('Check as of', date), el('div', { class: 'rp-actions' }, check)), msg, out);
    run();
    return sec;
  }
  function readinessResult(r) {
    const items = r.items || [];
    const nb = Number(r.counts?.block || 0), nw = Number(r.counts?.warn || 0);
    const sum = el('p', { class: 'ts-rd-sum ' + (r.ready ? 'ok' : 'no'), 'data-readiness-summary': '' },
      r.ready ? `✓ Ready for GST billing on ${fmtD(r.as_of)} — nothing blocks.` : `✖ Not ready for GST billing on ${fmtD(r.as_of)} — ${nb} item(s) block go-live.`,
      nw ? ` ${nw} warning(s).` : '');
    const group = (section, heading) => {
      const mine = items.filter(i => i.section === section);
      const shown = mine.filter(i => i.level !== 'ok'), passed = mine.filter(i => i.level === 'ok');
      const box = el('div', { class: 'ts-rd-group', 'data-readiness-group': section }, el('div', { class: 'rp-lbl' }, heading));
      if (shown.length) box.append(el('ul', { class: 'ts-rd-list' }, shown.map(line)));
      if (passed.length) {
        box.append(el('details', { class: 'ts-rd-passed' }, el('summary', null, `${passed.length} check(s) passed`),
          el('ul', { class: 'ts-rd-list' }, passed.map(line))));
      }
      return box;
    };
    return [sum, group('gst', 'GST billing (decides go-live)'), group('pharmacy', 'Pharmacy (shown; never blocks GST go-live)')];
  }
  function line(i) {
    const [icon, word] = LEVEL[i.level] || ['•', i.level];
    const ex = Array.isArray(i.examples) ? i.examples : [];
    const more = Number(i.count || 0) > ex.length ? ` … and ${Number(i.count) - ex.length} more` : '';
    return el('li', { class: 'ts-rd-item', 'data-code': i.code, 'data-level': i.level },
      el('span', { class: 'ts-lvl ts-lvl-' + i.level }, `${icon} ${word}`), ' ', el('span', { class: 'ts-rd-title' }, i.title || ''),
      i.detail ? el('div', { class: 'rp-muted' }, i.detail) : null,
      ex.length ? el('div', { class: 'rp-muted' }, 'e.g. ' + ex.join(', ') + more) : null);
  }

  // ── 0b. Session 345f (TODO §157): the GST registration type -- regular or composition, from a date (F1 / F2 / F3); a second person
  // approves (F13). Composition starts only on 1 April or, for a new registrant, on its GST go-live date (the CMP-02 reference);
  // leaving it is from today or later (the CMP-04 reference). Never back-dated; a date on / before an issued GST document is refused.
  // The composition tax base (R7) is a CA point -- stored, used only by the GST reports, never by a bill. The server decides everything.
  const SCHEME = { regular: 'Regular', composition: 'Composition' };
  const BASE = { unconfirmed: 'Not confirmed yet', taxable_only: 'Taxable supplies only', taxable_and_exempt: 'Taxable + exempt supplies' };
  const SIGNBOARD = 'Display the words "composition taxable person" on your signboards (Rule 5(1)(g)).';
  function schemeSection(d) {
    const g = d.gst_scheme || {};
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'scheme' }, el('h4', { class: 'ts-h4' }, 'Registration type (regular / composition)'));
    if (!d.gst?.registered) {
      sec.append(el('p', { class: 'rp-muted', 'data-scheme-now': '' }, 'Not GST-registered — the registration type is recorded once the organisation is GST-registered.'));
      return sec;
    }
    const cur = g.current;
    const rows = g.rows || [];
    const pend = (d.pending || []).find(p => p.action_type === 'gst_scheme_change');
    const anyComp = cur?.scheme === 'composition' || rows.some(r => r.scheme === 'composition' && r.state === 'future') || pend?.payload?.scheme === 'composition';
    sec.append(el('p', { class: 'ts-now', 'data-scheme-now': cur?.scheme || 'none' }, cur
      ? `Now: ${SCHEME[cur.scheme] || cur.scheme} (from ${cur.source === 'seed' ? 'the start of GST' : fmtD(cur.effective_from)})${cur.reference ? ' · reference ' + cur.reference : ''}`
      : '⚠ Not recorded — GST go-live is blocked until it is (a second person approves).'));
    sec.append(el('p', { class: 'rp-muted' }, 'A composition organisation issues only Bills of Supply and charges no GST on any bill; each bill prints, at the top: "'
      + (g.composition_text || 'Composition taxable person, not eligible to collect tax on supplies') + '". Bills already issued never change.'));
    const help = el('p', { class: 'ts-help', 'data-signboard-help': '' }, '🪧 ' + SIGNBOARD);
    help.hidden = !anyComp;
    sec.append(help);
    if (rows.length) {
      sec.append(el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-scheme-history': '' },
        el('thead', null, el('tr', null, ['From', 'Registration type', 'Reference', 'State', 'Set by'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null, rows.map(r => el('tr', null, el('td', null, r.source === 'seed' ? 'Since GST began' : fmtD(r.effective_from)),
          el('td', null, SCHEME[r.scheme] || r.scheme), el('td', null, r.reference || '—'),
          el('td', null, r.state === 'current' ? 'In force' : r.state === 'future' ? 'From a later date' : 'Earlier'),
          el('td', null, r.source === 'seed' ? 'Set by migration (demo organisation)' : (r.set_by_name ? 'Approved by ' + r.set_by_name : 'Approved request'))))))));
    }
    if (pend) {
      const p = pend.payload || {};
      sec.append(el('p', { class: 'it-pending', 'data-pending': 'scheme' },
        `⏳ Pending approval: ${SCHEME[p.scheme] || p.scheme} from ${fmtD(p.effective_from)}${p.reference ? ' (reference ' + p.reference + ')' : ''} · asked by ${pend.requested_by_name || '—'}`));
    } else if (d.can?.request) {
      const msg = status();
      const sel = el('select', { class: 'rp-input', id: uid('ts-sc') },
        el('option', { value: 'composition' }, 'Composition'), el('option', { value: 'regular' }, 'Regular'));
      sel.value = cur?.scheme === 'composition' ? 'regular' : 'composition';
      const date = el('input', { type: 'date', class: 'rp-input', min: d.today, value: d.today, id: uid('ts-sd') });
      const ref = el('input', { type: 'text', class: 'rp-input', maxlength: '60', autocomplete: 'off', id: uid('ts-sr'),
                                placeholder: 'e.g. the CMP-02 / CMP-04 ARN' });
      const reason = el('textarea', { class: 'rp-input', rows: '2', maxlength: '500', id: uid('ts-ss'), placeholder: 'Why (optional)' });
      const hint = el('div', { class: 'rp-muted', 'data-scheme-hint': '', 'aria-live': 'polite' });
      const sync = () => {
        const comp = sel.value === 'composition';
        hint.textContent = comp
          ? 'Composition can start only on 1 April (the intimation is filed before the financial year) or, for a new registrant with no GST document yet, on its GST go-live date. Your CA confirms that the organisation is eligible.'
          : 'Leaving composition: from today or later (crossing the turnover limit ends it from that day). A date on or before a GST document already issued is refused.';
        help.hidden = !(comp || anyComp);
      };
      sel.addEventListener('change', sync); sync();
      const send = btn('Send for approval', 'rp-btn rp-btn-go', async () => {
        if (!date.value || date.value < d.today) { say(msg, 'The effective date must be today or later (the registration type is never back-dated).', true); date.focus(); return; }
        if ((sel.value === 'composition' || cur?.scheme === 'composition') && ref.value.trim().length < 5) {
          say(msg, 'Enter the reference (the CMP-02 / CMP-04 ARN or order number, at least 5 characters).', true); ref.focus(); return;
        }
        send.disabled = true;
        const { error } = await supabase.rpc('request_gst_scheme_change', {
          p_scheme: sel.value, p_effective_from: date.value, p_reference: ref.value.trim() || null, p_reason: reason.value.trim() || null });
        send.disabled = false;
        if (error) { say(msg, safeErrorMessage(error, 'Could not send the request.'), true); return; }
        await after(top, '✓ Sent for approval — it applies from the chosen date once a Super Admin or Finance Manager (not you) approves it.');
      }, { 'data-send': 'scheme' });
      sec.append(el('div', { class: 'rp-form', 'data-form': 'scheme' }, field('Registration type', sel), hint,
        field('Effective from (today or later)', date), field('Reference (CMP-02 / CMP-04)', ref), field('Reason', reason),
        el('div', { class: 'rp-actions' }, send), msg));
    }
    if (anyComp) sec.append(taxBaseBlock(d, g.tax_base || {}));
    return sec;
  }
  function taxBaseBlock(d, tb) {
    const box = el('div', { class: 'ts-sub', 'data-sec': 'tax-base' }, el('div', { class: 'rp-lbl' }, 'Composition tax base (for the composition return)'),
      el('p', { class: 'rp-muted' }, 'Your CA confirms which supplies the composition tax is worked out on. It never changes a bill or a credit note — it is used only by the GST reports, whose composition summary stays blocked while it is not confirmed.'),
      el('p', { class: 'ts-now', 'data-tax-base-now': tb.current || 'unconfirmed' }, `Now: ${BASE[tb.current] || BASE.unconfirmed}`));
    const pend = (d.pending || []).find(p => p.action_type === 'composition_tax_base');
    if (pend) {
      box.append(el('p', { class: 'it-pending', 'data-pending': 'tax-base' },
        `⏳ Pending approval: ${BASE[pend.payload?.base] || pend.payload?.base} from ${fmtD(pend.payload?.effective_from)} · asked by ${pend.requested_by_name || '—'}`));
      return box;
    }
    if (!d.can?.request) return box;
    const msg = status();
    const sel = el('select', { class: 'rp-input', id: uid('ts-tb') }, Object.entries(BASE).map(([v, l]) => el('option', { value: v }, l)));
    sel.value = tb.current && tb.current !== 'unconfirmed' ? tb.current : 'taxable_only';
    const date = el('input', { type: 'date', class: 'rp-input', min: d.today, value: d.today, id: uid('ts-tbd') });
    const ref = el('input', { type: 'text', class: 'rp-input', maxlength: '120', autocomplete: 'off', id: uid('ts-tbr'), placeholder: 'Your CA\'s confirmation (letter / note reference)' });
    const send = btn('Send for approval', 'rp-btn rp-btn-go', async () => {
      if (!date.value || date.value < d.today) { say(msg, 'The effective date must be today or later.', true); date.focus(); return; }
      if (sel.value !== 'unconfirmed' && ref.value.trim().length < 5) { say(msg, 'Enter your CA\'s confirmation (at least 5 characters).', true); ref.focus(); return; }
      send.disabled = true;
      const { error } = await supabase.rpc('request_composition_tax_base', {
        p_base: sel.value, p_effective_from: date.value, p_reference: ref.value.trim() || null, p_reason: null });
      send.disabled = false;
      if (error) { say(msg, safeErrorMessage(error, 'Could not send the request.'), true); return; }
      await after(top, '✓ Sent for approval.');
    }, { 'data-send': 'tax-base' });
    box.append(el('div', { class: 'rp-form', 'data-form': 'tax-base' }, field('Tax base confirmed by your CA', sel), field('Effective from (today or later)', date),
      field('CA confirmation', ref), el('div', { class: 'rp-actions' }, send), msg));
    return box;
  }

  // ── 1. the IP-medicines choice ──
  function ipSection(d) {
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'ip' }, el('h4', { class: 'ts-h4' }, 'IP medicines (treatment admissions)'));
    const choices = d.ip_choices || [];
    const cur = choices.find(c => c.state === 'current');
    const desc = c => c.treatment === 'EXEMPT'
      ? `EXEMPT — ${c.exempt_profile_name || '—'}`
      : `CHARGEABLE — each medicine's own IP profile${c.fallback_profile_name ? `, else ${c.fallback_profile_name}` : ' (no fallback)'}`;
    sec.append(el('p', { class: 'ts-now', 'data-ip-current': '' }, cur ? `Now: ${desc(cur)} (from ${fmtD(cur.effective_from)})` : 'Now: no choice recorded — IPD bills with medicines are refused on a GST-live organisation.'));
    if (choices.length) {
      sec.append(el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-ip-history': '' },
        el('thead', null, el('tr', null, ['From', 'Choice', 'State', 'Set by'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null, choices.map(c => el('tr', null, el('td', null, fmtD(c.effective_from)), el('td', null, desc(c)),
          el('td', null, c.state === 'current' ? 'In force' : c.state === 'future' ? 'From a later date' : 'Earlier'),
          el('td', null, c.source === 'migration_demo' ? 'Set by migration (demo organisation)' : 'Approved request')))))));
    }
    const pend = (d.pending || []).find(p => p.action_type === 'ip_medicine_tax');
    if (pend) {
      sec.append(el('p', { class: 'it-pending', 'data-pending': 'ip' },
        `⏳ Pending approval: ${pend.payload?.treatment === 'EXEMPT' ? `EXEMPT — ${pend.payload?.exempt_profile_name || '—'}` : `CHARGEABLE${pend.payload?.fallback_profile_name ? ' — fallback ' + pend.payload.fallback_profile_name : ''}`} from ${fmtD(pend.payload?.effective_from)} · asked by ${pend.requested_by_name || '—'}`));
      return sec;
    }
    if (!d.can?.request) return sec;
    const goods = (d.profiles || []).filter(p => p.code_type === 'HSN');
    const exemptGoods = goods.filter(p => p.tax_category !== 'TAXABLE');
    const msg = status();
    const fs = el('fieldset', { class: 'rp-fieldset' }, el('legend', { class: 'rp-lbl' }, 'Medicines on an IP treatment bill are'));
    const r1 = el('input', { type: 'radio', name: uid('ts-tr'), value: 'EXEMPT', id: uid('ts-ex') });
    const r2 = el('input', { type: 'radio', name: r1.name, value: 'CHARGEABLE', id: uid('ts-ch') });
    r1.checked = !cur || cur.treatment === 'EXEMPT'; r2.checked = !r1.checked;
    fs.append(el('label', { class: 'rp-radio', for: r1.id }, r1, ' EXEMPT (part of the treatment)'),
              el('label', { class: 'rp-radio', for: r2.id }, r2, ' CHARGEABLE (each medicine\'s own IP profile)'));
    const exSel = select(uid('ts-exs'), exemptGoods, cur?.exempt_profile_id, { none: '— choose the exempt goods profile —' });
    const fbSel = select(uid('ts-fbs'), goods, cur?.fallback_profile_id, { none: 'No fallback (a medicine without an IP profile is refused at the bill)' });
    const exF = field('Exempt goods profile', exSel), fbF = field('Fallback profile (optional)', fbSel);
    const date = el('input', { type: 'date', class: 'rp-input', min: d.today, value: d.today, id: uid('ts-dt') });
    const reason = el('textarea', { class: 'rp-input', rows: '2', maxlength: '500', id: uid('ts-rs'), placeholder: 'Why (optional)' });
    const sync = () => { exF.hidden = !r1.checked; fbF.hidden = r1.checked; };
    r1.addEventListener('change', sync); r2.addEventListener('change', sync); sync();
    const send = btn('Send for approval', 'rp-btn rp-btn-go', async () => {
      const ex = r1.checked;
      if (ex && !exSel.value) { say(msg, 'Choose the exempt goods profile.', true); exSel.focus(); return; }
      if (!date.value || date.value < d.today) { say(msg, 'The effective date must be today or later (a choice is never back-dated).', true); date.focus(); return; }
      send.disabled = true;
      const { error } = await supabase.rpc('request_ip_medicine_tax', {
        p_treatment: ex ? 'EXEMPT' : 'CHARGEABLE', p_exempt_profile: ex ? exSel.value : null,
        p_fallback_profile: ex ? null : (fbSel.value || null), p_effective_from: date.value, p_reason: reason.value.trim() || null });
      send.disabled = false;
      if (error) { say(msg, safeErrorMessage(error, 'Could not send the request.'), true); return; }
      await after(top, '✓ Sent for approval — it applies once a Super Admin or Finance Manager approves it.');
    }, { 'data-send': 'ip' });
    sec.append(el('div', { class: 'rp-form', 'data-form': 'ip' }, fs, exF, fbF, field('Effective from (today or later)', date), field('Reason', reason),
      el('div', { class: 'rp-actions' }, send), msg));
    return sec;
  }

  // ── 2. the default profiles ──
  function defaultsSection(d) {
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'defaults' }, el('h4', { class: 'ts-h4' }, 'Default tax profiles'));
    const df = d.defaults || {};
    const rows = [['goods_op', 'OP medicines (goods)', 'HSN'], ['treatment', 'Treatment services', 'SAC'], ['wellness', 'Wellness services', 'SAC']];
    sec.append(el('div', { class: 'rp-kv', 'data-defaults-now': '' }, rows.map(([k, label]) => el('div', null, `${label}: ${df[k]?.name || 'not set'}`))));
    const pend = (d.pending || []).find(p => p.action_type === 'tax_defaults_change');
    if (pend) {
      sec.append(el('p', { class: 'it-pending', 'data-pending': 'defaults' }, `⏳ Pending approval (asked by ${pend.requested_by_name || '—'})`));
      return sec;
    }
    if (!d.can?.request) return sec;
    const msg = status();
    const sels = {};
    const fields = rows.map(([k, label, code]) => {
      sels[k] = select(uid('ts-d'), (d.profiles || []).filter(p => p.code_type === code), df[k]?.id, { none: 'Not set' });
      return field(label, sels[k]);
    });
    const preview = el('div', { class: 'rp-muted', 'data-defaults-preview': '' });
    const name = (k, id) => id ? ((d.profiles || []).find(p => p.id === id)?.name || df[k]?.name || '—') : 'not set';
    const changed = () => rows.filter(([k]) => (sels[k].value || null) !== (df[k]?.id || null));
    const send = btn('Send for approval', 'rp-btn rp-btn-go', async () => {
      if (!changed().length) { say(msg, 'Nothing changes: these are already the default tax profiles.', true); return; }
      send.disabled = true;
      const { error } = await supabase.rpc('request_tax_defaults_change', {
        p_goods_op: sels.goods_op.value || null, p_treatment_service: sels.treatment.value || null,
        p_wellness_service: sels.wellness.value || null, p_reason: null });
      send.disabled = false;
      if (error) { say(msg, safeErrorMessage(error, 'Could not send the request.'), true); return; }
      await after(top, '✓ Sent for approval.');
    }, { 'data-send': 'defaults' });
    const upd = () => {
      const c = changed();
      preview.textContent = c.length ? 'Change: ' + c.map(([k, label]) => `${label}: ${name(k, df[k]?.id)} → ${name(k, sels[k].value)}`).join(' · ') : 'No change yet.';
      send.disabled = !c.length;
    };
    Object.values(sels).forEach(s => s.addEventListener('change', upd)); upd();
    sec.append(el('div', { class: 'rp-form', 'data-form': 'defaults' }, fields, preview, el('div', { class: 'rp-actions' }, send), msg));
    return sec;
  }

  // ── 2b. Session 345e: the room-rent tax -- the platform rule (the law: the threshold and the ICU exclusion, shown only) and
  // this organisation's room profiles (effective-dated, a second person approves; never back-dated)
  const inr = n => `₹${Number(n || 0).toLocaleString('en-IN')}`;
  const bedType = t => String(t || '').replace(/_/g, ' ');
  function roomSection(d) {
    const rt = d.room_tax || {}, pl = rt.platform || {};
    const ccTypes = pl.critical_care_bed_types || [];
    const cc = ccTypes.map(x => String(x).toUpperCase()).join(', ') || 'no';
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'room' }, el('h4', { class: 'ts-h4' }, 'Room rent tax (IPD)'),
      el('p', { class: 'rp-muted', 'data-room-rule': '' },
        `Room rent above ${inr(pl.threshold)} per day per patient is taxable; ${cc} beds are always exempt. This is the GST rule itself — set by the platform, not by an organisation, and to be confirmed by your CA before IPD GST goes live.`));
    const rules = rt.rules || [];
    const cur = rules.find(r => r.state === 'current');
    sec.append(el('div', { class: 'rp-kv', 'data-room-now': '' },
      el('div', null, `Taxable rooms (above ${inr(pl.threshold)}): ${cur?.taxable_profile_name || 'not set'}`),
      el('div', null, `Exempt rooms (up to ${inr(pl.threshold)}, and ${cc}): ${cur?.exempt_profile_name || 'not set'}`),
      el('div', null, `Wellness / rejuvenation stays: ${cur?.wellness_profile_name || 'not set — they follow the rule above'}`)));
    if (rules.length) {
      sec.append(el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-room-history': '' },
        el('thead', null, el('tr', null, ['From', 'Taxable rooms', 'Exempt rooms', 'Wellness', 'State', 'Set by'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null, rules.map(r => el('tr', null, el('td', null, r.source === 'seed' ? 'Since GST began' : fmtD(r.effective_from)),
          el('td', null, r.taxable_profile_name || '—'), el('td', null, r.exempt_profile_name || '—'), el('td', null, r.wellness_profile_name || '—'),
          el('td', null, r.state === 'current' ? 'In force' : r.state === 'future' ? 'From a later date' : 'Earlier'),
          el('td', null, r.source === 'seed' ? 'Carried over from the earlier settings' : 'Approved request')))))));
    }
    const beds = rt.bed_rates || [];
    if (beds.length) {
      const taxed = b => Number(b.rates) !== 1 ? (Number(b.rates) === 0 ? '✖ No room rate — the IPD bill is refused' : `✖ ${b.rates} active room rates — keep one`)
        : ccTypes.includes(b.bed_type) ? 'Exempt (critical care)'
        : b.above_threshold ? `Taxable (above ${inr(pl.threshold)})` : 'Exempt';
      sec.append(el('div', { class: 'rp-lbl' }, 'Bed types in use and their room rates (fee-admin → IPD Room Tariff)'),
        el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-room-beds': '' },
          el('thead', null, el('tr', null, ['Bed type', 'Beds', 'Room rate / day', 'Room rent is'].map(h => el('th', { scope: 'col' }, h)))),
          el('tbody', null, beds.map(b => el('tr', { 'data-bed-type': b.bed_type, 'data-ok': Number(b.rates) === 1 ? '1' : '0' },
            el('td', null, bedType(b.bed_type)), el('td', null, String(b.beds)), el('td', null, Number(b.rates) === 1 ? inr(b.amount) : '—'),
            el('td', null, taxed(b))))))));
    }
    const pend = (d.pending || []).find(p => p.action_type === 'room_tax_change');
    if (pend) {
      const p = pend.payload || {};
      sec.append(el('p', { class: 'it-pending', 'data-pending': 'room' },
        `⏳ Pending approval: taxable rooms ${p.taxable_profile_name || '—'} · exempt rooms ${p.exempt_profile_name || '—'}${p.wellness_profile_name ? ' · wellness ' + p.wellness_profile_name : ''} from ${fmtD(p.effective_from)} · asked by ${pend.requested_by_name || '—'}`));
      return sec;
    }
    if (!d.can?.request) return sec;
    const sac = (d.profiles || []).filter(p => p.code_type === 'SAC');
    const msg = status();
    const txSel = select(uid('ts-rt'), sac.filter(p => p.tax_category === 'TAXABLE'), cur?.taxable_profile_id, { none: '— choose —' });
    const exSel = select(uid('ts-re'), sac.filter(p => p.tax_category === 'EXEMPT' || p.tax_category === 'NIL_RATED'), cur?.exempt_profile_id, { none: '— choose —' });
    const wlSel = select(uid('ts-rw'), sac, cur?.wellness_profile_id, { none: 'Not set (wellness stays follow the rule)' });
    const date = el('input', { type: 'date', class: 'rp-input', min: d.today, value: d.today, id: uid('ts-rdt') });
    const reason = el('textarea', { class: 'rp-input', rows: '2', maxlength: '500', id: uid('ts-rr'), placeholder: 'Why (optional)' });
    const send = btn('Send for approval', 'rp-btn rp-btn-go', async () => {
      if (!txSel.value || !exSel.value) { say(msg, 'Choose both room profiles: one for taxable rooms and one for exempt rooms.', true); (txSel.value ? exSel : txSel).focus(); return; }
      if (!date.value || date.value < d.today) { say(msg, 'The effective date must be today or later (a room tax change is never back-dated).', true); date.focus(); return; }
      send.disabled = true;
      const { error } = await supabase.rpc('request_room_tax_change', {
        p_taxable_profile: txSel.value, p_exempt_profile: exSel.value, p_wellness_profile: wlSel.value || null,
        p_effective_from: date.value, p_reason: reason.value.trim() || null });
      send.disabled = false;
      if (error) { say(msg, safeErrorMessage(error, 'Could not send the request.'), true); return; }
      await after(top, '✓ Sent for approval — it applies from the chosen date once a Super Admin or Finance Manager approves it.');
    }, { 'data-send': 'room' });
    sec.append(el('div', { class: 'rp-form', 'data-form': 'room' },
      field('Room profile — taxable rooms (services, taxable)', txSel), field('Room profile — exempt rooms (services, exempt / nil-rated)', exSel),
      field('Wellness room profile (optional)', wlSel),
      field('Effective from (today or later)', date, 'Each room-day is taxed by the profiles in force on that day; bills already issued never change.'),
      field('Reason', reason), el('div', { class: 'rp-actions' }, send), msg));
    return sec;
  }

  // ── 2c. Session 345e: the document numbering -- PREFIX/YEAR/NUMBER, at most 16 characters (GST Rule 46(b)); set and confirmed
  // by the Super Admin; a type that already issued numbers this year keeps its prefix until 31 March (never renumbered).
  // The checks below mirror set_document_numbering's (the server decides; this only explains before sending).
  const NUM_TYPES = [['TAX_INVOICE', 'Tax Invoice'], ['BILL_OF_SUPPLY', 'Bill of Supply'], ['BILL', 'Bill'], ['RECEIPT', 'Receipt'],
                     ['CREDIT_NOTE', 'Credit note'], ['DEBIT_NOTE', 'Debit note']];
  function numberingProblem(vals, w, lim) {
    const reserved = lim.reserved || ['RTN', 'MC', 'IP', 'AYX'], max = lim.prefix_max || 5, total = lim.total_max || 16;
    for (const [k, name] of NUM_TYPES) {
      const v = vals[k];
      if (!v) return `Enter a prefix for the ${name}.`;
      if (!/^[A-Z0-9-]+$/.test(v) || !/[A-Z0-9]/.test(v) || v.length > max) return `The ${name} prefix "${v}" is not allowed: use 1 to ${max} characters — letters A-Z, digits 0-9 and hyphen ("/" is the separator).`;
      if (reserved.includes(v)) return `The prefix "${v}" is already used by another series (${reserved.join(', ')} are fixed).`;
      if (NUM_TYPES.filter(([k2]) => vals[k2] === v).length > 1) return `Each document type needs its own prefix: "${v}" is used more than once.`;
    }
    if (!(w >= (lim.width_min || 5) && w <= (lim.width_max || 8))) return `The number width must be ${lim.width_min || 5} to ${lim.width_max || 8} digits.`;
    const [lname, lval] = NUM_TYPES.map(([k, name]) => [name, vals[k]]).sort((a, b) => b[1].length - a[1].length)[0];
    if (lval.length + w + 6 > total) return `The ${lname} number would be ${lval.length + w + 6} characters (${lval} + "/" + 4-digit year + "/" + ${w} digits) — GST allows at most ${total}. Use a shorter prefix or fewer digits.`;
    return '';
  }
  function numberingSection(d) {
    const n = d.numbering || {}, lim = n.limits || {}, px = n.prefixes || {}, fy = n.fy_code || '';
    const series = new Map((n.series || []).map(s => [s.document_type, s]));
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'numbering' }, el('h4', { class: 'ts-h4' }, 'Document numbering'),
      el('p', { class: 'rp-muted' }, `Numbers look like PREFIX/${fy}/000001 — at most ${lim.total_max || 16} characters in all (GST). A document type that has already issued numbers this financial year keeps its prefix and width until 31 March; a change applies to it from 1 April. Numbers are never changed or reused.`));
    sec.append(el('p', { class: 'ts-now', 'data-num-confirmed': n.confirmed_at ? 'yes' : 'no' }, n.confirmed_at
      ? `✓ Confirmed on ${new Date(n.confirmed_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}${n.confirmed_by_name ? ' by ' + n.confirmed_by_name : ''}.`
      : '⚠ Not confirmed yet — GST go-live is blocked until the Super Admin confirms the numbering (keeping the defaults is fine).'));
    const example = (v, w) => `${v}/${fy}/${'1'.padStart(w, '0')}`;
    const issued = k => { const s = series.get(k); return s && Number(s.issued) > 0 ? `${s.issued} issued this year (${s.prefix}/${fy}/…)` : 'none yet this year'; };
    if (!d.can?.super_admin) {
      sec.append(el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-num-table': '' },
        el('thead', null, el('tr', null, ['Document', 'Prefix', 'First number', 'This year'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null, NUM_TYPES.map(([k, name]) => el('tr', null, el('th', { scope: 'row' }, name), el('td', null, px[k] || '—'),
          el('td', null, example(px[k] || '', n.pad_width || 6)), el('td', null, issued(k))))))));
      return sec;
    }
    const msg = status();
    const inputs = {}, previews = {};
    const width = el('select', { class: 'rp-input', id: uid('ts-nw') });
    for (let w = lim.width_min || 5; w <= (lim.width_max || 8); w++) width.append(el('option', { value: String(w) }, `${w} digits${w === (lim.width_default || 6) ? ' (default)' : ''}`));
    width.value = String(n.pad_width || 6);
    const rows = NUM_TYPES.map(([k, name]) => {
      const i = el('input', { type: 'text', class: 'rp-input ts-num-in', id: uid('ts-np'), value: px[k] || '', maxlength: String(lim.prefix_max || 5),
        autocomplete: 'off', spellcheck: 'false', 'aria-label': `${name} prefix`, 'data-num-prefix': k });
      inputs[k] = i; previews[k] = el('td', { 'data-num-preview': k });
      return el('tr', null, el('th', { scope: 'row' }, name), el('td', null, i), previews[k], el('td', null, issued(k)));
    });
    const warn = el('div', { class: 'rp-muted', 'data-num-warn': '', 'aria-live': 'polite' });
    const err = el('div', { class: 'rp-status err', 'data-num-error': '', role: 'alert' });
    const vals = () => Object.fromEntries(NUM_TYPES.map(([k]) => [k, inputs[k].value.trim().toUpperCase()]));
    const save = btn('Save and confirm numbering', 'rp-btn rp-btn-go', async () => {
      if (!check()) return;
      const v = vals(), w = Number(width.value);
      save.disabled = true;
      const { data, error } = await supabase.rpc('set_document_numbering', {
        p_tax_invoice: v.TAX_INVOICE, p_bill_of_supply: v.BILL_OF_SUPPLY, p_bill: v.BILL, p_receipt: v.RECEIPT,
        p_credit_note: v.CREDIT_NOTE, p_debit_note: v.DEBIT_NOTE, p_pad_width: w });
      save.disabled = false;
      if (error) { say(msg, safeErrorMessage(error, 'Could not save the numbering.'), true); return; }
      const later = (data?.types || []).filter(x => x.applies === 'next_fy');
      const text = (data?.changed ? '✓ Numbering saved and confirmed.' : '✓ Numbering confirmed (no change).')
        + (later.length ? ` ${later.map(x => x.name).join(', ')}: already numbered this year — the new prefix / width applies from ${fmtD(data.next_fy_from)}.` : '')
        + (data?.warning ? ' ' + data.warning : '');
      await after(top, text);
    }, { 'data-save': 'numbering' });
    function check() {
      const v = vals(), w = Number(width.value);
      for (const [k] of NUM_TYPES) previews[k].textContent = v[k] ? `${example(v[k], w)} (${v[k].length + w + 6} characters)` : '—';
      warn.textContent = w === 5 ? 'With 5 digits each document type can issue at most 99,999 numbers in a financial year.' : '';
      const problem = numberingProblem(v, w, lim);
      err.textContent = problem; err.hidden = !problem;
      const changed = NUM_TYPES.some(([k]) => v[k] !== (px[k] || '')) || w !== Number(n.pad_width || 6);
      save.textContent = changed ? 'Save and confirm numbering' : n.confirmed_at ? 'Confirm again' : 'Confirm numbering';
      save.disabled = !!problem;
      return !problem;
    }
    Object.values(inputs).forEach(i => i.addEventListener('input', () => {
      const pos = i.selectionStart; i.value = i.value.toUpperCase(); i.setSelectionRange(pos, pos); check();
    }));
    width.addEventListener('change', check);
    sec.append(el('div', { class: 'rp-form', 'data-form': 'numbering' },
      el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table', 'data-num-table': '' },
        el('thead', null, el('tr', null, ['Document', 'Prefix (1–5)', 'First number', 'This year'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null, rows))),
      field('Number width', width), warn, err, el('div', { class: 'rp-actions' }, save), msg));
    check();
    return sec;
  }

  // ── 2c. Session 345h (rule R3): the GST annual return date per financial year -> the credit-note time limit. Read with its own
  // call (super_admin / finance manager); for any other role the server refuses and the section is simply not shown.
  function annualReturnSection(d) {
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'annual-return' }, el('h4', { class: 'ts-h4' }, 'GST annual return (credit-note time limit)'),
      el('p', { class: 'rp-muted' }, 'A GST credit note for a bill of a financial year can be issued only up to the EARLIER of 30 November after that year and the date this organisation filed its GST annual return for that year. Record the filing date here once it is filed; without it, 30 November applies. A date earlier than a credit note already issued for that year is refused.'));
    const msg = status();
    const box = el('div', { 'data-ar-table': '', 'aria-live': 'polite' }, el('p', { class: 'rp-muted' }, 'Loading…'));
    sec.append(box, msg);
    (async () => {
      const { data, error } = await supabase.rpc('get_annual_return_dates');
      if (error || !data) { sec.remove(); return; }                         // not a role that sees it
      const edit = !!data.can_edit;
      const rows = (data.years || []).map(y => {
        const cells = [el('th', { scope: 'row' }, y.label), el('td', { 'data-ar-deadline': y.fy_code }, fmtD(y.deadline)),
          el('td', null, String(y.gst_documents ?? 0)), el('td', null, String(y.credit_notes ?? 0))];
        if (edit) {
          const yEnd = String(y.year_end || '');
          const minD = yEnd ? new Date(Date.parse(yEnd + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : '';
          const date = el('input', { type: 'date', class: 'rp-input', id: uid('ts-ar'), value: y.filed_on || '', min: minD, max: d.today,
                                     'aria-label': `Annual return for ${y.label} filed on`, 'data-ar-date': y.fy_code });
          const save = btn('Save', 'rp-btn rp-btn-go', async () => {
            save.disabled = true;
            const r = await supabase.rpc('set_annual_return_date', { p_fy_code: y.fy_code, p_filed_on: date.value || null });
            save.disabled = false;
            if (r.error) { say(msg, safeErrorMessage(r.error, 'Could not save the annual return date.'), true); return; }
            await after(top, r.data?.changed === false ? 'No change.'
              : `✓ ${y.label}: annual return ${r.data?.filed_on ? 'filed on ' + fmtD(r.data.filed_on) : 'date cleared'} — credit notes for that year allowed until ${fmtD(r.data?.credit_note_deadline)}.`);
          }, { 'data-save': 'annual-return', 'data-ar-save': y.fy_code });
          cells.splice(1, 0, el('td', null, el('span', { class: 'rp-row', style: 'margin:0' }, date, save)));
        } else {
          cells.splice(1, 0, el('td', null, y.filed_on ? fmtD(y.filed_on) : 'not recorded'));
        }
        return el('tr', null, cells);
      });
      box.replaceChildren(el('div', { class: 'rp-tablewrap' }, el('table', { class: 'rp-table' },
        el('thead', null, el('tr', null, ['Financial year', 'Annual return filed on', 'Credit notes allowed until', 'GST documents', 'Credit notes'].map(h => el('th', { scope: 'col' }, h)))),
        el('tbody', null, rows))),
        edit ? null : el('p', { class: 'rp-muted' }, 'Only the Super Admin records these dates.'));
    })();
    return sec;
  }

  // ── 3. the Bill of Supply declaration ──
  function declarationSection(d) {
    const dc = d.declaration || {};
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'declaration' }, el('h4', { class: 'ts-h4' }, 'Bill of Supply declaration'),
      el('p', { class: 'rp-muted' }, 'Printed at the foot of every Bill of Supply. Fixed on each bill when it is issued — later changes never alter issued bills.'));
    const prev = el('div', { class: 'ts-preview', 'data-decl-preview': '' }, dc.printed || '');
    if (!d.can?.super_admin) {
      sec.append(el('div', { class: 'rp-lbl' }, dc.stored ? 'Printed text:' : 'Printed text (the default):'), prev);
      return sec;
    }
    const msg = status();
    const ta = el('textarea', { class: 'rp-input', rows: '3', maxlength: String(MAX_DECL), id: uid('ts-decl'), placeholder: dc.default_text || '' });
    ta.value = dc.stored || '';
    const count = el('div', { class: 'rp-muted', 'data-decl-count': '', 'aria-live': 'polite' });
    const err = el('div', { class: 'rp-status err', 'data-decl-error': '', role: 'alert' });
    const save = btn('Save declaration', 'rp-btn rp-btn-go', async () => {
      if (!check()) return;
      save.disabled = true;
      const { data, error } = await supabase.rpc('set_bos_declaration', { p_text: ta.value.trim() });
      save.disabled = false;
      if (error) { say(msg, safeErrorMessage(error, 'Could not save the declaration.'), true); return; }
      await after(top, data?.changed === false ? 'No change.' : '✓ Declaration saved — it prints on Bills of Supply issued from now on.');
    }, { 'data-save': 'declaration' });
    const useDefault = btn('Use default', 'rp-btn', () => { ta.value = ''; check(); ta.focus(); }, { 'data-decl-default': '' });
    function check() {
      const v = ta.value, t = v.trim();
      count.textContent = `${t.length} / ${MAX_DECL} characters`;
      prev.textContent = t || dc.default_text || '';
      let problem = '';
      if (t.length > MAX_DECL) problem = `The declaration can be at most ${MAX_DECL} characters (it has ${t.length}).`;
      else if (BAD_DECL.test(v)) problem = 'The declaration cannot contain < or >.';
      else if (CTRL_DECL.test(v)) problem = 'The declaration must be one line, without line breaks or control characters.';
      err.textContent = problem; err.hidden = !problem;
      save.disabled = !!problem;
      return !problem;
    }
    ta.addEventListener('input', check); check();
    sec.append(el('div', { class: 'rp-form', 'data-form': 'declaration' }, field('Declaration text (empty = the default)', ta), count, err,
      el('div', { class: 'rp-lbl' }, 'Preview:'), prev, el('div', { class: 'rp-actions' }, useDefault, save), msg));
    return sec;
  }

  // ── 4. the pharmacy GST go-live date ──
  function pharmacySection(d) {
    const g = d.gst || {};
    const sec = el('section', { class: 'ts-sec', 'data-sec': 'pharmacy' }, el('h4', { class: 'ts-h4' }, 'Pharmacy GST go-live'),
      // Session 345l (TODO §182): only while the platform switch is off (it is ON since 345k, 14 Oct 2026)
      g.pharmacy_platform_on ? null : el('p', { class: 'rp-muted', 'data-pharm-note': '' }, 'Pharmacy GST stays off platform-wide until credit notes (Stage 6) are ready.'),
      el('div', { class: 'rp-kv', 'data-pharm-now': '' },
        el('div', null, `GST go-live (this organisation): ${g.go_live_date ? fmtD(g.go_live_date) : 'not set'}`),
        el('div', null, `Pharmacy GST go-live: ${g.pharmacy_go_live_date ? fmtD(g.pharmacy_go_live_date) : 'not set'}`),
        el('div', null, `Platform pharmacy GST: ${g.pharmacy_platform_on ? 'ready' : 'not ready yet'}`)));
    if (!d.can?.super_admin) return sec;
    const msg = status();
    const date = el('input', { type: 'date', class: 'rp-input', min: d.today, value: g.pharmacy_go_live_date || '', id: uid('ts-pg') });
    const save = btn('Save date', 'rp-btn rp-btn-go', async () => {
      save.disabled = true;
      const { data, error } = await supabase.rpc('set_pharmacy_gst_go_live', { p_date: date.value || null });
      save.disabled = false;
      if (error) { say(msg, safeErrorMessage(error, 'Could not set the pharmacy GST go-live date.'), true); return; }
      await after(top, data?.changed === false ? 'No change.' : '✓ Pharmacy GST go-live date saved.');
    }, { 'data-save': 'pharmacy' });
    sec.append(el('div', { class: 'rp-form', 'data-form': 'pharmacy' }, field('Pharmacy GST go-live date (empty = none)', date), el('div', { class: 'rp-actions' }, save), msg));
    return sec;
  }

  reload();
  return { reload };
}
