// procedureGroupsAdmin.js -- Session 386b-2b M2 (TODO §596 a / c-h, owner-agreed design 13 Nov 2026; docs/handoff/session386b2b_plan_v3.md §B.3).
// The forms behind fee-admin.html's grouped Fee Structure list (js/modules/billing/feeStructureList.js): the procedure groups (sections).
//   - everyone who opens Fee Structure sees the sections and their procedures;
//   - the Fee committee (the Medical Superintendent, an accountant, the finance manager, the Super Admin -- server: _fee_committee_ok) adds a
//     section, renames, deactivates a custom section (reason), + Add procedure, Import CSV (preview, then all or nothing), sets groups in bulk,
//     decides the "Ask to add a procedure" requests;
//   - the active Super Admin runs the auto-classification (a preview; only the ticked rows are applied).
// Every rule is the server's (procedure_group_save / _set_active, add_procedure_fee, import_procedure_fees, set_fee_groups,
// procedure_group_auto_preview / _apply, procedure_add_requests, decide_procedure_add); this module only shows and sends.
// DOM nodes + textContent only (labels, names and reasons are entered text); no native confirm() / prompt().
import { safeErrorMessage } from '../../utils/errors.js';
import { PROCEDURE_REGISTERS } from './feeSelect.js';

export const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const BOX = 'padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:#fff;margin-bottom:12px';
export const NOTE = 'font-size:12px;color:var(--text-muted)';
const BTN = 'min-height:44px';

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  // 386b-2b (G7): a box / dropdown without its own tooltip says what it is for (its label)
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && e.type !== 'checkbox' && !e.getAttribute('title') && e.getAttribute('aria-label')) e.setAttribute('title', e.getAttribute('aria-label'));
  return e;
}
// 386b-2b (G7): every button says what it does (a caller's own title wins)
const TITLES = {
  '+ Add procedure': 'Add this procedure with its price to the section (it starts Pending until approved)',
  'Preview': 'Check the file first — nothing is saved until you confirm',
  '⬇ Download template': 'Download an empty CSV file with the right columns (name, amount, AYUSH code, SAC)',
  'Rename': 'Rename this section (its fees stay in it)',
  'Deactivate section': 'Hide this section on the registers (a reason is needed); its fees are kept',
  'Reactivate section': 'Show this section on the registers again',
  '+ Add section': 'Make a new section of your own (choose the registers it is shown on)',
  'Set group for the ticked': 'Put every ticked fee into the chosen section',
  'Show the proposals': 'Suggest a section for each procedure in no group (nothing changes until you apply)',
  'Apply the ticked': 'Put only the ticked procedures into the suggested sections',
  'Approve with this price': 'Add the asked procedure to the fee list with this price (it then needs the usual fee approval)',
  'Reject': 'Refuse the request with a reason',
};
export const button = (label, onClick, primary = false, extra = {}) => {
  const title = extra.title || TITLES[label] || (/^Confirm/.test(label) ? 'Save all the new procedures shown in the preview' : /^Show the \d+/.test(label) ? 'Show or hide the list' : label);
  const b = h('button', { type: 'button', class: primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm', style: BTN, ...extra, title }, label);
  b.addEventListener('click', onClick);
  return b;
};

/** a small CSV parser (quotes, commas inside quotes, CRLF); first row = the header */
export function parseCsv(text) {
  text = String(text ?? '').replace(/^\uFEFF/, '');   // 386b-2b (F11): a UTF-8 file saved by Excel starts with a BOM
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(x => String(x).trim() !== ''));
  if (!nonEmpty.length) return [];
  const head = nonEmpty[0].map(x => String(x).trim().toLowerCase());
  return nonEmpty.slice(1).map(r => Object.fromEntries(head.map((k, i) => [k, String(r[i] ?? '').trim()])));
}
export const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function download(name, text, type = 'text/csv;charset=utf-8;') {
  // 386b-2b (F11, owner 14 Nov): a CSV starts with a UTF-8 BOM so Excel shows "—", Kannada and Devanagari names as they are
  const body = /csv/.test(type) && !String(text).startsWith('\uFEFF') ? '\uFEFF' + text : text;
  const a = h('a', { href: URL.createObjectURL(new Blob([body], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

// Session 386b-2b (F7): the old 🧩 Procedures panel (mountProcedureGroupsAdmin) is removed -- these forms are used by the grouped list
// (js/modules/billing/feeStructureList.js), the only fee view.
export function _addProcedureForm(supabase, grp, say, reload) {
  const name = h('input', { type: 'text', maxlength: '120', placeholder: 'Procedure name', 'aria-label': 'Procedure name', style: 'min-height:44px;flex:2;min-width:180px' });
  const amt = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Price ₹', 'aria-label': 'Price', style: 'min-height:44px;width:120px' });
  const code = h('input', { type: 'text', maxlength: '20', placeholder: 'AYUSH code (optional)', 'aria-label': 'AYUSH code', style: 'min-height:44px;width:160px' });
  const sac = h('input', { type: 'text', maxlength: '8', placeholder: 'SAC (optional)', 'aria-label': 'SAC', style: 'min-height:44px;width:120px' });
  const go = button('+ Add procedure', async () => {
    if (name.value.trim().length < 2 || !(Number(amt.value) > 0)) { say('Give the procedure a name and a price above 0.', true); return; }
    go.disabled = true;
    const { error } = await supabase.rpc('add_procedure_fee', { p_group: grp.id, p_label: name.value.trim(), p_amount: Number(amt.value),
      p_ayush_code: code.value.trim() || null, p_sac_code: sac.value.trim() || null });
    go.disabled = false;
    if (error) { say(safeErrorMessage(error, 'Could not add the procedure.'), true); return; }
    say(`"${name.value.trim()}" added to ${grp.display_name} — Pending until its price is approved.`); await reload();
  }, true);
  return h('div', { style: 'margin-top:10px' }, h('div', { style: 'font-weight:600;font-size:13px' }, '+ Add procedure'),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' }, name, amt, code, sac, go));
}

export function _importForm(supabase, grp, say, reload) {
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'CSV file to import', style: 'min-height:44px' });
  const out = h('div');
  let rows = null;
  const preview = button('Preview', async () => {
    const fl = file.files?.[0];
    if (!fl) { say('Choose a CSV file first (Download template for the columns).', true); return; }
    if (fl.size > 1024 * 1024) { say('The file is larger than 1 MB.', true); return; }
    const text = await fl.text();
    if (text.includes('\uFFFD')) { say('This file is not saved as UTF-8 (letters would be lost). In Excel use "Save as → CSV UTF-8 (Comma delimited)", then choose it again.', true); return; }
    const all = parseCsv(text).map(r => ({ name: r.name || '', amount: r.amount || '', ayush_code: r.ayush_code || '', sac: r.sac || '' }));
    rows = all.filter(r => r.name.trim().toLowerCase() !== 'example procedure');   // 386b-2b (F12): the template's example row is never imported
    const skipped = all.length - rows.length;
    const { data, error } = await supabase.rpc('import_procedure_fees', { p_group: grp.id, p_rows: rows, p_confirm: false });
    out.replaceChildren();
    if (error) { say(safeErrorMessage(error, 'Could not read the file.'), true); rows = null; return; }
    out.appendChild(h('div', { style: 'font-size:12.5px;margin:6px 0' }, `${data.new} new · ${data.duplicate} duplicate (skipped) · ${data.error} with an error — nothing is saved until you confirm.`
      + (skipped ? ` The template's "Example procedure" row was left out.` : '')));
    for (const r of data.rows || []) out.appendChild(h('div', { style: 'font-size:12px;padding:3px 0;border-top:1px solid var(--border)' },
      `Row ${r.n}: ${r.name || '—'} ${r.amount != null ? '— ' + rupee(r.amount) : ''} · ${r.status === 'new' ? 'NEW' : r.status === 'duplicate' ? 'DUPLICATE' : 'ERROR'}${r.reason ? ' (' + r.reason + ')' : ''}`));
    if (data.error > 0) { out.appendChild(h('div', { role: 'alert', style: 'color:var(--red, #b03a2e);font-size:12.5px' }, 'Correct the rows with an error in the file, then preview again.')); return; }
    if (!data.new) return;
    out.appendChild(button(`Confirm — add the ${data.new} new procedure(s)`, async () => {
      const { data: r2, error: e2 } = await supabase.rpc('import_procedure_fees', { p_group: grp.id, p_rows: rows, p_confirm: true });
      if (e2) { say(safeErrorMessage(e2, 'Could not import.'), true); return; }
      say(`${r2.created} procedure(s) added to ${grp.display_name} — Pending until their prices are approved.`); await reload();
    }, true));
  });
  return h('div', { style: 'margin-top:10px' }, h('div', { style: 'font-weight:600;font-size:13px' }, 'Import CSV (columns: name, amount, ayush_code, sac)'),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
      button('⬇ Download template', () => download('procedure_import_template.csv', 'name,amount,ayush_code,sac\nExample procedure,500,,\n')), file, preview), out);
}

export function _renameForm(supabase, grp, say, reload, rows = []) {
  const name = h('input', { type: 'text', maxlength: '60', value: grp.display_name, 'aria-label': 'Group name', title: 'The section\'s name as staff see it on the registers and here', style: 'min-height:44px;min-width:200px' });
  const wrap = h('div', { style: 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center' }, name,
    button('Rename', async () => {
      const { error } = await supabase.rpc('procedure_group_save', { p_id: grp.id, p_name: name.value.trim(), p_department: null, p_used_on: null });
      if (error) { say(safeErrorMessage(error, 'Could not rename.'), true); return; }
      say('Renamed.'); await reload();
    }));
  // Session 386d-1 (§602): the Fee committee chooses which groups the doctor can order from in OPD (a reason, audited on the server)
  if (grp.is_active) {
    const why = h('input', { type: 'text', maxlength: '300', placeholder: 'Reason (to change OPD)', 'aria-label': 'Reason to change whether this group is offered in OPD', style: 'min-height:44px;min-width:200px' });
    wrap.append(h('span', { style: NOTE + ';flex-basis:100%' }, grp.offered_in_opd
        ? 'Offered in OPD: doctors can order these procedures for an OPD visit (reception bills them).'
        : 'Not offered in OPD: doctors cannot order these procedures for an OPD visit.'),
      why, button(grp.offered_in_opd ? 'Stop offering in OPD' : 'Offer in OPD', async () => {
        if (why.value.trim().length < 5) { say('Give a reason (at least 5 characters).', true); return; }
        const { error } = await supabase.rpc('set_procedure_group_opd', { p_group: grp.id, p_on: !grp.offered_in_opd, p_reason: why.value.trim() });
        if (error) { say(safeErrorMessage(error, 'Could not change it.'), true); return; }
        say(grp.offered_in_opd ? 'No longer offered in OPD.' : 'Now offered in OPD.'); await reload();
      }));
  }
  // Session 390 T1a-1 (3.4): who may ORDER from this group in the doctor's treatment plan -- every department, or one department family
  // (the Fee committee, a reason, audited on the server)
  if (grp.is_active) {
    const SCOPES = [['common', 'Every department'], ['shalya', 'Shalya only'], ['psr', 'Prasuti Stri Roga only'], ['shalakya', 'Shalakya only']];
    const scopeSel = h('select', { 'aria-label': 'Who may order from this group', style: 'min-height:44px' },
      SCOPES.map(([k, n]) => h('option', { value: k, ...(k === (grp.scope || 'common') ? { selected: 'selected' } : {}) }, n)));
    const scopeWhy = h('input', { type: 'text', maxlength: '300', placeholder: 'Reason (to change who may order)', 'aria-label': 'Reason to change who may order from this group', style: 'min-height:44px;min-width:200px' });
    wrap.append(h('span', { style: NOTE + ';flex-basis:100%' },
      `Ordered by: ${(SCOPES.find(x => x[0] === (grp.scope || 'common')) || SCOPES[0])[1]} (the doctor's treatment plan offers this group's procedures only to these departments).`),
      scopeSel, scopeWhy, button('Change who may order', async () => {
        if (scopeWhy.value.trim().length < 5) { say('Give a reason (at least 5 characters).', true); return; }
        const { error } = await supabase.rpc('set_procedure_group_scope', { p_group: grp.id, p_scope: scopeSel.value, p_reason: scopeWhy.value.trim() });
        if (error) { say(safeErrorMessage(error, 'Could not change it.'), true); return; }
        say('Saved: who may order from this group.'); await reload();
      }));
  }
  // Session 390 T1a-1 (§694 / owner D7): this organisation's own team size for a procedure (else the platform's SOP value); only the
  // maximum is enforced, fewer than the minimum asks for a reason when scheduling
  const procRows = (rows || []).filter(r => r && r.id && r.category === 'procedure');
  if (grp.is_active && procRows.length) {
    // F7 (rehearsal R6, owner 23 Nov 2026): the list is wide enough for a long fee name; the boxes show the chosen fee's own team size, and
    // a line beside them says what applies now ("Now: 1–1–1 (own) · Standard: 1–1–4") -- read from the server, never guessed
    const fee = h('select', { 'aria-label': 'Procedure for the team size', style: 'min-height:44px;min-width:260px;max-width:100%' },
      procRows.map(r => h('option', { value: r.id }, r.label)));
    const num = (lbl) => h('input', { type: 'number', min: '1', max: '8', placeholder: lbl, 'aria-label': `Therapists — ${lbl}`, style: 'min-height:44px;width:84px' });
    const mn = num('min'), us = num('usual'), mx = num('max');
    const nowLine = h('span', { style: NOTE + ';flex-basis:100%', role: 'status', 'aria-live': 'polite' });
    const showTeam = async () => {
      const r = procRows.find(x => x.id === fee.value);
      const own = r && r.man_power_usual != null;
      mn.value = own ? r.man_power_min : ''; us.value = own ? r.man_power_usual : ''; mx.value = own ? r.man_power_max : '';
      nowLine.textContent = '';
      if (!r) return;
      // the standard = the procedure's SOP row (adult), with the server's own fallbacks (_pk_team_limits: min / usual / max, else 1 / 1 / 4)
      const { data: sop, error } = r.ayush_code
        ? await supabase.from('sop_content_templates').select('man_power_min, man_power_staff, man_power_max, age_band').eq('ayush_code', r.ayush_code)
        : { data: [], error: null };
      if (fee.value !== r.id) return;
      const t = (sop || []).sort((a, b) => ((b.age_band || 'adult') === 'adult') - ((a.age_band || 'adult') === 'adult'))[0] || {};
      const std = { min: t.man_power_min ?? t.man_power_staff ?? 1, usual: t.man_power_staff ?? t.man_power_min ?? 1, max: t.man_power_max ?? 4 };
      const stdText = error ? 'Standard: —' : `Standard: ${std.min}–${std.usual}–${std.max}`;
      nowLine.textContent = own ? `Now: ${r.man_power_min}–${r.man_power_usual}–${r.man_power_max} (own) · ${stdText}` : `Now: the standard · ${stdText}`;
    };
    fee.addEventListener('change', showTeam);
    const teamWhy = h('input', { type: 'text', maxlength: '300', placeholder: 'Reason (team size)', 'aria-label': 'Reason to change the team size', style: 'min-height:44px;min-width:200px' });
    const save = async (clear) => {
      if (teamWhy.value.trim().length < 5) { say('Give a reason (at least 5 characters).', true); return; }
      const v = (x) => (clear || x.value === '' ? null : Number(x.value));
      const { error } = await supabase.rpc('set_fee_team_size', { p_fee: fee.value, p_min: v(mn), p_usual: v(us), p_max: v(mx), p_reason: teamWhy.value.trim() });
      if (error) { say(safeErrorMessage(error, 'Could not save the team size.'), true); return; }
      say(clear ? 'Team size: back to the standard.' : 'Team size saved.'); await reload();
    };
    wrap.append(h('span', { style: NOTE + ';flex-basis:100%' }, 'Team size (therapists) for one procedure of this group — empty = the standard (the procedure SOP).'),
      fee, mn, us, mx, teamWhy, button('Save team size', () => save(false)), button('Use the standard', () => save(true)), nowLine);
    showTeam();
  }
  // Session 391 T1a-2 (owner D2-9 / D2-11 / D2-2): a department procedure's consent before the sitting, the female performer / chaperone
  // rule and the usual course -- per fee, by the Fee committee, with a reason, audited (set_fee_procedure_flags; the server decides)
  if (grp.is_active && procRows.length && ['anushastra', 'minor_ot', 'shalakya_procedures', 'prasuti_stri_roga'].includes(grp.code)) {
    const DEFAULT_ON = ['anushastra', 'minor_ot'].includes(grp.code);
    const pfee = h('select', { 'aria-label': 'Procedure for its settings', style: 'min-height:44px;min-width:260px;max-width:100%' },
      procRows.map(r => h('option', { value: r.id }, r.label)));
    const consent = h('select', { 'aria-label': 'Consent before the sitting', style: 'min-height:44px' },
      h('option', { value: '' }, `Consent: the group default (${DEFAULT_ON ? 'needed' : 'not needed'})`), h('option', { value: 'true' }, 'Consent: needed'),
      h('option', { value: 'false' }, 'Consent: not needed'));
    const intimate = h('input', { type: 'checkbox', 'aria-label': 'Intimate procedure: a female performer or a female chaperone', style: 'width:22px;height:22px' });
    const sit = h('input', { type: 'number', min: '1', max: '60', placeholder: 'sittings', 'aria-label': 'Usual number of sittings', style: 'min-height:44px;width:96px' });
    const gap = h('input', { type: 'number', min: '1', max: '60', placeholder: 'days apart', 'aria-label': 'Usual days between sittings', style: 'min-height:44px;width:110px' });
    const pWhy = h('input', { type: 'text', maxlength: '300', placeholder: 'Reason (procedure settings)', 'aria-label': 'Reason to change the procedure settings', style: 'min-height:44px;min-width:200px' });
    const fill = () => {
      const r = procRows.find(x => x.id === pfee.value) || {};
      consent.value = r.consent_required == null ? '' : String(r.consent_required);
      intimate.checked = !!r.intimate_procedure;
      sit.value = r.default_sittings ?? ''; gap.value = r.default_interval_days ?? '';
    };
    pfee.addEventListener('change', fill);
    wrap.append(h('span', { style: NOTE + ';flex-basis:100%' },
      'Procedure settings for one procedure of this group: the consent the doctor records before the sitting, the female performer / female chaperone rule for intimate procedures, and the usual course offered to the doctor.'),
      pfee, consent, h('label', { style: 'display:flex;gap:6px;align-items:center;font-size:12.5px;min-height:44px' }, intimate, 'Intimate (female performer or chaperone)'),
      sit, gap, pWhy, button('Save procedure settings', async () => {
        if (pWhy.value.trim().length < 5) { say('Give a reason (at least 5 characters).', true); return; }
        const n = (x) => (x.value === '' ? null : Number(x.value));
        const { error } = await supabase.rpc('set_fee_procedure_flags', { p_fee: pfee.value, p_consent_required: consent.value === '' ? null : consent.value === 'true',
          p_intimate: intimate.checked, p_default_sittings: n(sit), p_default_interval_days: n(gap), p_reason: pWhy.value.trim() });
        if (error) { say(safeErrorMessage(error, 'Could not save the procedure settings.'), true); return; }
        say('Procedure settings saved.'); await reload();
      }));
    fill();
  }
  if (!grp.is_standard) {
    const reason = h('input', { type: 'text', maxlength: '300', placeholder: 'Reason (to deactivate)', 'aria-label': 'Reason to deactivate', style: 'min-height:44px;min-width:200px' });
    wrap.append(reason, button(grp.is_active ? 'Deactivate section' : 'Reactivate section', async () => {
      const { error } = await supabase.rpc('procedure_group_set_active', { p_id: grp.id, p_on: !grp.is_active, p_reason: reason.value.trim() || null });
      if (error) { say(safeErrorMessage(error, 'Could not change the section.'), true); return; }
      say(grp.is_active ? 'Section deactivated (old records and bills keep their fee).' : 'Section reactivated.'); await reload();
    }));
  }
  return wrap;
}

export function _addSectionBox(supabase, depts, say, reload) {
  const name = h('input', { type: 'text', maxlength: '60', placeholder: 'Section name, e.g. Marma Chikitsa', 'aria-label': 'Section name', title: 'Name of the new section', style: 'min-height:44px;min-width:220px' });
  const dept = h('select', { 'aria-label': 'Department of the section', title: 'The department whose head gives the first approval for this section\'s new fees', style: 'min-height:44px' }, h('option', { value: '' }, 'Department…'),
    depts.map(x => h('option', { value: x.id }, x.name)));
  const regs = h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:6px' }, PROCEDURE_REGISTERS.map(([k, n]) =>
    h('label', { style: 'display:flex;gap:4px;align-items:center;font-size:12.5px;min-height:44px' }, h('input', { type: 'checkbox', value: k, style: 'width:20px;height:20px' }), n)));
  return h('div', { style: BOX }, h('div', { style: 'font-weight:700' }, '+ Add section'),
    h('div', { style: NOTE }, 'Your own group of procedures, linked to its department; its procedures appear on the registers you tick. A section with procedures can be deactivated, never deleted.'),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px' }, name, dept), regs,
    button('+ Add section', async () => {
      const used = [...regs.querySelectorAll('input:checked')].map(c => c.value);
      const { error } = await supabase.rpc('procedure_group_save', { p_id: null, p_name: name.value.trim(), p_department: dept.value || null, p_used_on: used });
      if (error) { say(safeErrorMessage(error, 'Could not add the section.'), true); return; }
      say(`Section "${name.value.trim()}" added.`); await reload();
    }, true));
}

export function _untaggedBox(supabase, list, groups, { committee, say, reload }) {
  const tbl = h('div');
  for (const x of list) {
    tbl.appendChild(h('div', { style: 'display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--border)' },
      committee ? h('input', { type: 'checkbox', value: x.id, 'aria-label': 'Tick ' + x.label, style: 'width:20px;height:20px' }) : null,
      h('div', { style: 'flex:1' }, x.label), h('div', null, rupee(x.amount))));
  }
  const box = h('div', { style: BOX }, h('div', { style: 'font-weight:700' }, `Procedures in no group (${list.length}) — offered on no register`),
    h('div', { style: NOTE }, 'Tick many, choose the group, Set group. (Panchakarma fees are still offered in the therapist schedule by their AYUSH code.)'));
  if (committee && list.length) {
    const all = h('input', { type: 'checkbox', 'aria-label': 'Tick all', style: 'width:20px;height:20px' });
    all.addEventListener('change', () => tbl.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = all.checked; }));
    const sel = h('select', { 'aria-label': 'Group to set', style: 'min-height:44px' }, h('option', { value: '' }, 'Group…'),
      groups.filter(x => x.is_active).map(x => h('option', { value: x.id }, x.display_name)));
    box.appendChild(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px' },
      h('label', { style: 'display:flex;gap:4px;align-items:center;min-height:44px' }, all, 'Tick all'), sel,
      button('Set group for the ticked', async () => {
        const ids = [...tbl.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
        if (!ids.length || !sel.value) { say('Tick the procedures and choose the group.', true); return; }
        if (ids.length > 500) { say('At most 500 at a time.', true); return; }
        const { data, error } = await supabase.rpc('set_fee_groups', { p_fee_ids: ids, p_group: sel.value, p_add: true });
        if (error) { say(safeErrorMessage(error, 'Could not set the group.'), true); return; }
        say(`${data} procedure(s) added to the group.`); await reload();
      }, true)));
  }
  const body = h('div', { hidden: !list.length || list.length > 30, style: 'margin-top:6px' }, tbl);
  if (list.length > 30) box.appendChild(button(`Show the ${list.length}`, () => { body.hidden = !body.hidden; }));
  box.appendChild(body);
  return box;
}

export function _autoBox(supabase, groups, say, reload) {
  const out = h('div');
  const box = h('div', { style: BOX }, h('div', { style: 'font-weight:700' }, '🔎 Auto-classify (Super Admin)'),
    h('div', { style: NOTE }, 'Proposes a group for each procedure in no group, from its catalogue code, service group or department. Nothing changes until you Apply the ticked rows. Shalya procedures without a code get no proposal (use the list below).'),
    button('Show the proposals', async () => {
      const { data, error } = await supabase.rpc('procedure_group_auto_preview');
      out.replaceChildren();
      if (error) { say(safeErrorMessage(error, 'Could not make the proposals.'), true); return; }
      if (!data?.length) { out.appendChild(h('div', { style: NOTE }, 'No proposal — every procedure is in a group, or nothing to go by.')); return; }
      const rows = data.map(p => {
        const c = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Apply ' + p.label, style: 'width:20px;height:20px' });
        out.appendChild(h('div', { style: 'display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--border);font-size:12.5px' },
          c, h('div', { style: 'flex:2' }, p.label), h('div', { style: 'flex:1;font-weight:600' }, '→ ' + p.group_name), h('div', { style: 'flex:2;' + NOTE }, p.reason)));
        return { c, p };
      });
      out.appendChild(button(`Apply the ticked`, async () => {
        const pairs = rows.filter(r => r.c.checked).map(r => ({ fee_id: r.p.fee_id, group_id: r.p.group_id }));
        if (!pairs.length) { say('Tick at least one proposal.', true); return; }
        const { data: n, error: e } = await supabase.rpc('procedure_group_auto_apply', { p_pairs: pairs });
        if (e) { say(safeErrorMessage(e, 'Could not apply.'), true); return; }
        say(`${n} procedure(s) placed in their groups.`); await reload();
      }, true));
    }), out);
  return box;
}

export async function _requestsBox(supabase, say, reload) {
  const box = h('div', { style: BOX }, h('div', { style: 'font-weight:700' }, 'Ask-to-add requests'));
  const { data, error } = await supabase.rpc('procedure_add_requests');
  if (error) { box.appendChild(h('div', { role: 'alert', style: 'color:var(--red, #b03a2e)' }, safeErrorMessage(error, 'Could not load the requests.'))); return box; }
  if (!data?.length) { box.appendChild(h('div', { style: NOTE }, 'No request is waiting.')); return box; }
  box.appendChild(h('div', { style: NOTE }, 'Staff asked for these procedures to be added (nothing was recorded or billed). Approve with a price: a new procedure in that section, Pending until its price is approved; then it can be recorded from the list.'));
  for (const q of data) {
    const amt = h('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Price ₹', 'aria-label': 'Price for ' + q.name, style: 'min-height:44px;width:120px',
                             title: 'The price of the new procedure (filled with the suggested price, if any — change it as needed)' });
    if (q.suggested_price != null && Number(q.suggested_price) > 0) amt.value = String(Number(q.suggested_price));   // 386b-2b M2c (owner item 3)
    const note = h('input', { type: 'text', maxlength: '300', placeholder: 'Note (required to reject)', 'aria-label': 'Decision note', style: 'min-height:44px;flex:1;min-width:160px' });
    const send = async ok => {
      const { error: e } = await supabase.rpc('decide_procedure_add', { p_request_id: q.id, p_approve: ok, p_amount: ok ? Number(amt.value) : null, p_notes: note.value.trim() || null });
      if (e) { say(safeErrorMessage(e, 'Could not save the decision.'), true); return; }
      say(ok ? `"${q.name}" added — Pending until its price is approved.` : 'Request rejected.'); await reload();
    };
    box.appendChild(h('div', { style: 'padding:8px 0;border-top:1px solid var(--border)' },
      h('div', { style: 'font-weight:600' }, `${q.name} → ${q.group_name}`),
      h('div', { style: NOTE }, `Asked by ${q.requester || 'staff'}`),
      h('div', { style: NOTE }, `Reason / details: ${q.details || '—'}`),
      h('div', { style: NOTE }, q.suggested_price != null ? `Suggested price: ${rupee(q.suggested_price)}` : 'Suggested price: none given'),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px' }, amt, note,
        button('Approve with this price', () => send(true), true), button('Reject', () => send(false)))));
  }
  return box;
}

export function _printSection(grp, list) {
  const w = window.open('', '_blank');   // (from the click itself -- not after an await)
  if (!w) return;
  const d = w.document;
  d.title = 'Procedures — ' + grp.display_name;
  const st = d.createElement('style');
  st.textContent = 'body{font-family:"DM Sans",Arial,sans-serif;margin:24px;color:#222}h1{font-family:"Cormorant Garamond",serif;color:#1a4a2e}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;font-size:12px;text-align:left}';
  d.head.appendChild(st);
  const tb = d.createElement('table');
  const hr = tb.insertRow(); ['Procedure', 'Price', 'Status', 'AYUSH code'].forEach(t => { const th = d.createElement('th'); th.textContent = t; hr.appendChild(th); });
  for (const x of list) { const r = tb.insertRow(); [x.label, rupee(x.amount), x.is_active ? 'Active' : x.approval_status, x.ayush_code || ''].forEach(t => { r.insertCell().textContent = t; }); }
  const h1 = d.createElement('h1'); h1.textContent = 'Procedures — ' + grp.display_name;
  d.body.append(h1, tb);
  w.print();
}
