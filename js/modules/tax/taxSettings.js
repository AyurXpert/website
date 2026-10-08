// taxSettings.js -- the "🧾 Tax & Invoicing" card (Session 345c2a, GST Stage 5): the IP-medicines choice, the default tax
// profiles, the Bill of Supply declaration and the pharmacy GST go-live date. One read (get_tax_settings_overview: own
// organisation, tax makers / approvers only); every change goes through its own server function, which re-checks the role:
//   * IP-medicines choice  -> request_ip_medicine_tax      (maker-checker, 'ip_medicine_tax')
//   * default profiles     -> request_tax_defaults_change  (maker-checker, 'tax_defaults_change')
//   * declaration          -> set_bos_declaration          (active super_admin only)
//   * pharmacy go-live     -> set_pharmacy_gst_go_live     (active super_admin only; the server's refusal reason is shown)
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
    el('p', { class: 'rp-sub' }, 'Changes to the IP-medicines choice and the default tax profiles need a second person\'s approval (a Super Admin or Finance Manager — never the person who asked, except an organisation\'s only Super Admin). Bills already issued never change.'),
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
    body.replaceChildren(ipSection(data), defaultsSection(data), declarationSection(data), pharmacySection(data));
  }

  // reload FIRST, then show the result (a reload clears the status line -- the 345b "message kept after reload" lesson)
  const after = async (node, okText) => { onChange?.(); await reload(); say(node, okText); };

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
      el('p', { class: 'rp-muted', 'data-pharm-note': '' }, 'Pharmacy GST stays off platform-wide until credit notes (Stage 6) are ready.'),
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
