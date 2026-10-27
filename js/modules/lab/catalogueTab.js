// Session 363 (TODO §266, owner Q6 / Q7): lab.html -> 📚 Test catalogue. Everyone on the page reads the organisation's catalogue;
// the lab in-charge / pathologist / Super Admin add or change a test (save_lab_test) and import a CSV (import_lab_tests: checked
// first, nothing saved when any row is wrong); ONLY the lab in-charge / pathologist verify reference ranges (verify_lab_test_ranges).
// Excel export now; Excel import after the pilot. The server re-checks every right -- the buttons here only follow it.
// DOM nodes + textContent only (no HTML strings).
import { loadLabCatalogue, SECTION_LABELS, SECTION_ORDER, rangesVerified } from './catalogue.js';
import { bandText } from './ranges.js';
import { catalogueRows, parseCsv, rowsToTests } from './catalogueCsv.js';
import { xlsxBlob, csvText, downloadBlob } from '../../utils/xlsxWriter.js';
import { safeErrorMessage } from '../../utils/errors.js';
import { notify } from '../../components/notify.js';
import { computeLabBillingLines } from '../billing/labBilling.js';

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === null || v === undefined || v === false) return;
    if (k === 'on') Object.entries(v).forEach(([ev, fn]) => e.addEventListener(ev, fn));
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  });
  kids.flat().forEach(c => { if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c)); });
  return e;
}
const btn = (label, onClick, cls = 'btn btn-secondary btn-sm', extra = {}) => el('button', { type: 'button', class: cls, on: { click: onClick }, ...extra }, label);

export function initCatalogueTab({ supabase, tenantId, profile, onChange }) {
  const root = document.getElementById('tab-catalogue');
  if (!root) return;
  const desig = profile?.designation;
  const canEdit = profile?.role === 'super_admin' || ['pathologist', 'lab_incharge'].includes(desig);
  const canVerify = ['pathologist', 'lab_incharge'].includes(desig);   // Q7: not the Super Admin as such
  let cat = { tests: [] };
  const selected = new Set();
  let q = '', sec = '', unpricedOnly = false;
  // owner B1 (27 Oct 2026): the price stays in the fee master, matched by NAME with the same rules as billing (labBilling.js
  // computeLabBillingLines = the server's _lab_order_price); every active test with no matching fee is listed as UNPRICED here, so a
  // renamed / removed fee is noticed before a patient is refused at the counter. null = the fee list could not be read.
  let fees = null;
  const priceOf = t => {
    if (!fees) return undefined;
    const { lines, unmatched } = computeLabBillingLines(new Map([[t.name, null]]), fees);
    return unmatched.length || !lines.length ? null : lines[0].price;
  };
  const unpricedBox = el('div', { class: 'cat-unpriced', role: 'status' });

  const listBox = el('div', { class: 'cat-list' });
  const formBox = el('div', { class: 'cat-form', hidden: true });
  const importBox = el('div', { class: 'cat-import', hidden: true });
  const fileIn = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true, 'aria-label': 'CSV file to import', on: { change: () => readImport(fileIn.files[0]) } });
  const search = el('input', { type: 'search', class: 'cat-search', placeholder: 'Search name / code', 'aria-label': 'Search tests', on: { input: e => { q = e.target.value.trim().toLowerCase(); renderList(); } } });
  const secSel = el('select', { 'aria-label': 'Section', on: { change: e => { sec = e.target.value; renderList(); } } },
    el('option', { value: '' }, 'All sections'), SECTION_ORDER.map(s => el('option', { value: s }, SECTION_LABELS[s])));
  const verifyBtn = btn('✓ Verify ranges of the ticked tests', () => verify(), 'btn btn-primary btn-sm', { hidden: !canVerify, id: 'cat-verify-btn' });

  root.replaceChildren(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-hdr' }, el('span', null, '📚 Lab test catalogue'),
        el('span', { class: 'cat-hint' }, canEdit ? 'You can add / change tests.' : 'View only -- the lab in-charge / pathologist keep this list.')),
      el('div', { class: 'cat-note', role: 'note' },
        'Reference ranges marked "not verified" are standard values seeded for your organisation. Results are still flagged, with "range not verified", until the lab in-charge or pathologist verifies them.'),
      unpricedBox,
      el('div', { class: 'cat-tools' }, search, secSel,
        el('label', { class: 'cat-unpriced-only' }, el('input', { type: 'checkbox', id: 'cat-unpriced-only', on: { change: e => { unpricedOnly = e.target.checked; renderList(); } } }), ' Unpriced only'),
        canEdit ? btn('+ Add investigation', () => openForm(null), 'btn btn-primary btn-sm', { id: 'cat-add-btn' }) : null,
        btn('⬇ Export (Excel)', () => exportXlsx()),
        btn('⬇ CSV template', () => exportCsv()),
        canEdit ? btn('⬆ Import CSV', () => fileIn.click(), 'btn btn-secondary btn-sm', { id: 'cat-import-btn' }) : null,
        fileIn, verifyBtn),
      importBox, formBox, listBox));

  async function reload() {
    const [c, f] = await Promise.all([loadLabCatalogue(supabase, tenantId),
      supabase.from('fee_structures').select('id,label,amount,gst_percent,promo_price,promo_valid_until')
        .eq('tenant_id', tenantId).eq('is_active', true).in('category', ['lab', 'radiology'])]);
    cat = c;
    if (cat.error) { notify(safeErrorMessage(cat.error, 'Could not load the lab test catalogue.'), 'error'); return; }
    fees = f.error ? null : (f.data || []);
    renderList();
    onChange?.();
  }

  function renderList() {
    const unpriced = fees ? cat.tests.filter(t => t.is_active && priceOf(t) === null) : [];
    unpricedBox.replaceChildren(...(fees === null
      ? [el('div', { class: 'cat-unpriced-warn' }, 'The fee list could not be read -- prices are not checked here.')]
      : unpriced.length
        ? [el('div', { class: 'cat-unpriced-warn' }, `⚠ ${unpriced.length} active test${unpriced.length === 1 ? '' : 's'} UNPRICED -- no matching fee in the fee master (a walk-in / collection with ${unpriced.length === 1 ? 'it' : 'them'} is refused): `,
            el('span', { class: 'cat-unpriced-list' }, unpriced.map(t => t.name).join(', ')))]
        : [el('div', { class: 'cat-unpriced-ok' }, '✓ Every active test has a price in the fee master.')]));
    const rows = cat.tests.filter(t => (!sec || t.section === sec) && (!unpricedOnly || (t.is_active && priceOf(t) === null)) && (!q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)
      || (t.aliases || []).some(a => a.toLowerCase().includes(q))));
    const th = t => el('th', { scope: 'col' }, t);
    listBox.replaceChildren(el('div', { class: 'cat-count' }, `${rows.length} of ${cat.tests.length} tests`),
      el('table', { class: 'cat-table' },
        el('thead', null, el('tr', null, canVerify ? th('') : null, th('Code'), th('Test'), th('Section'), th('Unit'), th('Reference'), th('Critical'),
          th('Consent'), th('Self'), th('Price'), th('Status'), canEdit ? th('') : null)),
        el('tbody', null, rows.map(t => {
          const ver = rangesVerified(t);
          const hasRanges = (t.ranges || []).length > 0;
          const ref = t.result_type === 'text' ? (t.normal_values || []).join(' / ')
            : ['any', 'M', 'F'].map(s => { const b = t.ranges.filter(r => r.sex === s); return b.length ? (s === 'any' ? '' : s + ': ') + bandText(b, t) : null; })
                .filter(Boolean).join(' | ');
          return el('tr', { 'data-code': t.code, class: t.is_active ? '' : 'cat-inactive' },
            canVerify ? el('td', null, hasRanges && !ver ? el('input', { type: 'checkbox', 'aria-label': 'Verify ' + t.name, checked: selected.has(t.id),
              on: { change: e => { e.target.checked ? selected.add(t.id) : selected.delete(t.id); } } }) : null) : null,
            el('td', null, t.code), el('td', null, t.name), el('td', null, SECTION_LABELS[t.section] || t.section), el('td', null, t.unit || ''),
            el('td', null, ref || '—'),
            el('td', null, [t.critical_low !== null ? '≤' + Number(t.critical_low) : '', t.critical_high !== null ? '≥' + Number(t.critical_high) : ''].filter(Boolean).join(' / ')),
            el('td', null, t.consent_required ? 'Consent' : ''), el('td', null, t.self_referral_allowed ? 'Yes' : 'No'),
            (p => el('td', { class: p === null ? 'cat-price-none' : '' }, p === undefined ? '' : p === null ? '⚠ Unpriced' : '₹' + Number(p).toFixed(2)))(priceOf(t)),
            el('td', null, !t.is_active ? 'Inactive' : !hasRanges ? (t.result_type === 'text' ? 'Text' : 'No range') : ver ? '✓ Verified' : '⚠ Not verified'),
            canEdit ? el('td', null, btn('Edit', () => openForm(t))) : null);
        }))));
  }

  // ---------------------------------------------------------------- the edit form
  function openForm(t) {
    const v = t || { code: '', name: '', section: 'biochemistry', result_type: 'numeric', ranges: [], aliases: [], normal_values: [], is_active: true, self_referral_allowed: true };
    const f = {};
    const field = (k, label, input) => { f[k] = input; return el('label', { class: 'cat-field' }, el('span', null, label), input); };
    const txt = (k, val, attrs = {}) => el('input', { type: 'text', value: val ?? '', maxlength: '300', ...attrs });
    const chk = (k, val) => el('input', { type: 'checkbox', checked: !!val });
    const bands = el('div', { class: 'cat-bands' });
    const addBand = b => {
      const r = { sex: el('select', { 'aria-label': 'Sex' }, ['any', 'M', 'F'].map(s => el('option', { value: s, selected: (b?.sex || 'any') === s }, s))),
        age_min: el('input', { type: 'number', min: '0', step: 'any', value: b?.age_min ?? 0, 'aria-label': 'Age from' }),
        age_max: el('input', { type: 'number', min: '0', step: 'any', value: b?.age_max ?? '', 'aria-label': 'Age to' }),
        low: el('input', { type: 'number', step: 'any', value: b?.low ?? '', 'aria-label': 'Low' }),
        low_x: el('input', { type: 'checkbox', checked: b?.low_inclusive === false, 'aria-label': 'Low excluded' }),
        high: el('input', { type: 'number', step: 'any', value: b?.high ?? '', 'aria-label': 'High' }),
        high_x: el('input', { type: 'checkbox', checked: b?.high_inclusive === false, 'aria-label': 'High excluded' }),
        kind: el('select', { 'aria-label': 'Kind' }, ['normal', 'abnormal'].map(s => el('option', { value: s, selected: (b?.kind || 'normal') === s }, s))),
        label: el('input', { type: 'text', maxlength: '40', value: b?.label || '', 'aria-label': 'Band label', placeholder: 'e.g. Pre-diabetes' }) };
      const row = el('div', { class: 'cat-band' }, r.sex, 'age', r.age_min, '–', r.age_max, 'low', r.low, el('label', null, r.low_x, 'excl.'),
        'high', r.high, el('label', null, r.high_x, 'excl.'), r.kind, r.label, btn('✕', () => row.remove(), 'btn btn-secondary btn-sm', { 'aria-label': 'Remove band' }));
      row._r = r; bands.append(row);
    };
    (v.ranges || []).forEach(addBand);
    const reason = el('input', { type: 'text', maxlength: '300', placeholder: 'Reason for the change (kept in the change log)', 'aria-label': 'Reason' });
    const err = el('div', { class: 'cat-err', role: 'alert' });
    formBox.hidden = false;
    formBox.replaceChildren(
      el('h3', null, t ? `Edit ${t.name}` : 'Add investigation'),
      el('div', { class: 'cat-grid' },
        field('code', 'Code', txt('code', v.code, { maxlength: '20', readOnly: !!t })), field('name', 'Name', txt('name', v.name, { maxlength: '120' })),
        field('aliases', 'Other names (| between)', txt('aliases', (v.aliases || []).join(' | '))),
        field('section', 'Section', el('select', null, SECTION_ORDER.map(s => el('option', { value: s, selected: v.section === s }, SECTION_LABELS[s])))),
        field('specimen', 'Specimen', txt('specimen', v.specimen)), field('container', 'Container', txt('container', v.container)),
        field('method', 'Method', txt('method', v.method)), field('unit', 'Unit', txt('unit', v.unit, { maxlength: '30' })),
        field('result_type', 'Result type', el('select', null, ['numeric', 'text'].map(s => el('option', { value: s, selected: v.result_type === s }, s)))),
        field('normal_values', 'Expected text results (| between)', txt('normal_values', (v.normal_values || []).join(' | '))),
        field('critical_low', 'Critical low', el('input', { type: 'number', step: 'any', value: v.critical_low ?? '' })),
        field('critical_high', 'Critical high', el('input', { type: 'number', step: 'any', value: v.critical_high ?? '' })),
        field('patient_prep', 'Patient preparation', txt('patient_prep', v.patient_prep)),
        field('tat_hours', 'TAT (hours)', el('input', { type: 'number', min: '0', step: 'any', value: v.tat_hours ?? '' })),
        field('outsourced', 'Outsourced', chk('outsourced', v.outsourced)), field('outsource_lab', 'Outsourced to', txt('outsource_lab', v.outsource_lab)),
        field('nabl_scope', 'In NABL scope', chk('nabl_scope', v.nabl_scope)), field('consent_required', 'Consent required', chk('consent_required', v.consent_required)),
        field('self_referral_allowed', '"Self" allowed (walk-in)', chk('self_referral_allowed', v.self_referral_allowed)),
        field('is_active', 'Active', chk('is_active', v.is_active))),
      el('div', { class: 'cat-sub' }, 'Reference bands', btn('+ Band', () => addBand(null))),
      el('div', { class: 'cat-note' }, 'Changing the bands makes them "not verified" again until the lab in-charge / pathologist verifies them.'),
      bands, reason, err,
      el('div', { class: 'cat-actions' }, btn('💾 Save', () => save(), 'btn btn-primary btn-sm', { id: 'cat-save-btn' }), btn('Cancel', () => { formBox.hidden = true; })));
    const list = s => String(s || '').split('|').map(x => x.trim()).filter(Boolean);
    async function save() {
      err.textContent = '';
      const payload = { code: f.code.value.trim().toUpperCase(), name: f.name.value.trim(), aliases: list(f.aliases.value), section: f.section.value,
        specimen: f.specimen.value, container: f.container.value, method: f.method.value, unit: f.unit.value, result_type: f.result_type.value,
        normal_values: list(f.normal_values.value), critical_low: f.critical_low.value || null, critical_high: f.critical_high.value || null,
        patient_prep: f.patient_prep.value, tat_hours: f.tat_hours.value || null, outsourced: f.outsourced.checked, outsource_lab: f.outsource_lab.value,
        nabl_scope: f.nabl_scope.checked, consent_required: f.consent_required.checked, self_referral_allowed: f.self_referral_allowed.checked,
        is_active: f.is_active.checked, sort_order: t?.sort_order ?? 999,
        ranges: [...bands.children].map(row => { const r = row._r; return { sex: r.sex.value, age_min: r.age_min.value || 0, age_max: r.age_max.value || null,
          low: r.low.value === '' ? null : r.low.value, high: r.high.value === '' ? null : r.high.value,
          low_inclusive: !r.low_x.checked, high_inclusive: !r.high_x.checked, kind: r.kind.value, label: r.label.value.trim() || null }; }) };
      const { data, error } = await supabase.rpc('save_lab_test', { p_test: payload, p_reason: reason.value.trim() || null });
      if (error || !data?.id) { err.textContent = safeErrorMessage(error, 'Could not save the test.'); return; }
      notify(data.changed ? 'Test saved.' : 'Nothing changed.', data.changed ? 'success' : 'info');
      formBox.hidden = true;
      await reload();
    }
  }

  // ---------------------------------------------------------------- verify (Q7)
  async function verify() {
    if (!selected.size) { notify('Tick the tests whose ranges you have checked.', 'info'); return; }
    const { data, error } = await supabase.rpc('verify_lab_test_ranges', { p_test_ids: [...selected] });
    if (error) { notify(safeErrorMessage(error, 'Could not verify the ranges.'), 'error'); return; }
    notify(`${data} reference band(s) verified.`, 'success');
    selected.clear();
    await reload();
  }

  // ---------------------------------------------------------------- export / import (Q6)
  const stamp = () => new Date().toISOString().slice(0, 10);
  function exportXlsx() { downloadBlob(xlsxBlob([{ name: 'lab_tests', rows: catalogueRows(cat.tests) }]), `lab_test_catalogue_${stamp()}.xlsx`); }
  function exportCsv() { downloadBlob(new Blob([csvText(catalogueRows(cat.tests))], { type: 'text/csv' }), `lab_test_catalogue_${stamp()}.csv`); }

  async function readImport(file) {
    fileIn.value = '';
    if (!file) return;
    if (file.size > 2_000_000) { notify('The file is larger than 2 MB.', 'error'); return; }
    const { tests, errors } = rowsToTests(parseCsv(await file.text()));
    importBox.hidden = false;
    const show = (title, errs, extra) => importBox.replaceChildren(el('h3', null, title),
      errs.length ? el('ul', { class: 'cat-errs' }, errs.map(e => el('li', null, `Row ${e.row ?? '?'}${e.code ? ' (' + e.code + ')' : ''}: ${e.message}`))) : null,
      extra || null, btn('Close', () => { importBox.hidden = true; }));
    if (errors.length || !tests.length) { show('The file cannot be imported -- nothing was saved', errors.length ? errors : [{ row: 1, message: 'No tests found.' }]); return; }
    const { data, error } = await supabase.rpc('import_lab_tests', { p_rows: tests, p_dry_run: true });
    if (error) { show('The file cannot be imported -- nothing was saved', [{ message: safeErrorMessage(error, 'The check failed.') }]); return; }
    if (!data.ok) { show('Fix these rows and import again -- nothing was saved', data.errors || []); return; }
    show(`Checked: ${data.created} new, ${data.updated} changed, ${data.unchanged} unchanged.`, [],
      btn('💾 Save import', async () => {
        const r = await supabase.rpc('import_lab_tests', { p_rows: tests, p_dry_run: false });
        if (r.error || !r.data?.saved) { show('The import was not saved', r.data?.errors?.length ? r.data.errors : [{ message: safeErrorMessage(r.error, 'Could not save the import.') }]); return; }
        notify(`Imported: ${r.data.created} new, ${r.data.updated} changed.`, 'success');
        importBox.hidden = true;
        await reload();
      }, 'btn btn-primary btn-sm', { id: 'cat-import-save' }));
  }

  reload();
}
