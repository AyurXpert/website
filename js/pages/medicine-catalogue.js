// Medicine Catalogue -- medicine-catalogue.html (Session 339, TODO §124). Platform administrator only: the page checks
// profiles.is_platform_admin and every RPC re-checks _is_platform_admin() on the server (tenants never reach it).
// The catalogue is shared by every organisation; edits never touch their documents or stock (bills and prescriptions
// copy the name they print; stock rows are per organisation). Never delete -- deactivate / reactivate only.
// Built with DOM nodes / textContent only.
import { requireAuth, getCurrentProfile } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { notify } from '../components/notify.js';
import { el } from '../modules/billing/invoiceLayout.js';

await requireAuth(['platform_admin', 'super_admin', 'dept_admin'], 'login.html');
initNavbar();
wireDelegatedEvents();

export const FORMS = [
  ['vati_gutika', 'Vati / Gutika'], ['tablet', 'Tablet'], ['capsule', 'Capsule'], ['churna', 'Churna'], ['kashaya', 'Kashaya'],
  ['kwatha_churna', 'Kwatha churna'], ['arishta', 'Arishta'], ['asava', 'Asava'], ['ghrita', 'Ghrita'], ['taila', 'Taila'],
  ['avaleha', 'Avaleha / Lehya'], ['bhasma', 'Bhasma'], ['pishti', 'Pishti'], ['rasaushadhi', 'Rasaushadhi'], ['guggulu', 'Guggulu'],
  ['arka', 'Arka'], ['lepa', 'Lepa'], ['anjana', 'Anjana'], ['syrup', 'Syrup'], ['drops', 'Drops'], ['ointment', 'Ointment'],
  ['granules', 'Granules'], ['other', 'Other'],
];
const FORM_LABEL = Object.fromEntries(FORMS);
const PAGE_SIZE = 50;

const $ = id => document.getElementById(id);
let _page = 0, _total = 0, _rows = [], _editId = null, _deactId = null, _seq = 0;

if (!getCurrentProfile()?.is_platform_admin) {
  $('access-denied').style.display = '';
} else {
  $('main-page').style.display = '';
  fillFormSelects();
  $('q').addEventListener('keydown', e => { if (e.key === 'Enter') { _page = 0; search(); } });
  search();
}

function fillFormSelects() {
  $('flt-form').replaceChildren(el('option', { value: '' }, 'All'), el('option', { value: '__none' }, 'Not set'),
    ...FORMS.map(([v, l]) => el('option', { value: v }, l)));
  $('f-form').replaceChildren(el('option', { value: '' }, '— Choose —'), ...FORMS.map(([v, l]) => el('option', { value: v }, l)));
}

window.runSearch = () => { _page = 0; search(); };
window.pageBy = d => { const n = _page + Number(d); if (n < 0 || n * PAGE_SIZE >= _total) return; _page = n; search(); };

async function search() {
  const mine = ++_seq;
  $('status').textContent = 'Searching…';
  const { data, error } = await supabase.rpc('catalogue_search', {
    p_q: $('q').value.trim() || null, p_form: $('flt-form').value || null, p_category: $('flt-cat').value || null,
    p_hsn: $('flt-hsn').value.trim() || null, p_status: $('flt-status').value, p_page: _page, p_page_size: PAGE_SIZE,
  });
  if (mine !== _seq) return;
  if (error) { $('status').textContent = safeErrorMessage(error, 'Could not load the catalogue.'); $('results').replaceChildren(); return; }
  _rows = data.rows || []; _total = data.total || 0;
  fillCategories(data.categories || []);
  const from = _total ? _page * PAGE_SIZE + 1 : 0, to = Math.min(_total, (_page + 1) * PAGE_SIZE);
  $('status').textContent = _total ? `${_total} medicine${_total === 1 ? '' : 's'} — showing ${from}–${to}.` : 'No medicine matches.';
  $('page-label').textContent = _total ? `Page ${_page + 1} of ${Math.ceil(_total / PAGE_SIZE)}` : '';
  $('prev-btn').disabled = _page === 0;
  $('next-btn').disabled = (_page + 1) * PAGE_SIZE >= _total;
  renderTable();
}

function fillCategories(cats) {
  const sel = $('flt-cat'), cur = sel.value;
  sel.replaceChildren(el('option', { value: '' }, 'All'), ...cats.slice().sort().map(c => el('option', { value: c }, c)));
  sel.value = cats.includes(cur) ? cur : '';
  $('cat-list').replaceChildren(...cats.map(c => el('option', { value: c })));
}

function renderTable() {
  const head = el('tr', null, ...['ID', 'Name', 'Form', 'Strength', 'Pack', 'Manufacturer', 'HSN', 'GST %', 'Flags', 'Stocked by', 'Status', '']
    .map(h => el('th', { scope: 'col' }, h)));
  const rows = _rows.map(m => {
    const flags = [m.is_high_risk ? el('span', { class: 'pill flag' }, 'High-risk') : null, m.is_schedule_e1 ? el('span', { class: 'pill flag' }, 'E1') : null];
    const actions = el('span', { style: 'display:inline-flex;gap:6px;flex-wrap:wrap' },
      el('button', { class: 'btn', type: 'button', 'data-onclick': 'editMedicine', 'data-onclick-a0': m.id }, 'Edit'),
      m.is_active
        ? el('button', { class: 'btn btn-danger', type: 'button', 'data-onclick': 'openDeactivate', 'data-onclick-a0': m.id }, 'Deactivate')
        : el('button', { class: 'btn', type: 'button', 'data-onclick': 'reactivate', 'data-onclick-a0': m.id }, 'Reactivate'));
    return el('tr', { class: m.is_active ? '' : 'inactive' },
      el('td', { style: 'white-space:nowrap' }, m.med_id || '—'),
      el('td', { style: 'font-weight:600' }, m.name || '—'),
      el('td', null, FORM_LABEL[m.dosage_form] || '—'),
      el('td', null, m.strength || '—'),
      el('td', null, m.unit || '—'),
      el('td', null, m.manufacturer || '—'),
      el('td', null, m.hsn_code || '—'),
      el('td', null, m.gst_percent != null ? String(m.gst_percent) : '—'),
      el('td', null, ...flags),
      el('td', null, `${m.stocked_by} org${m.stocked_by === 1 ? '' : 's'}`),
      el('td', null, el('span', { class: 'pill ' + (m.is_active ? 'on' : 'off') }, m.is_active ? 'Active' : 'Inactive')),
      el('td', null, actions));
  });
  $('results').replaceChildren(el('table', null, el('thead', null, head), el('tbody', null, rows)));
}

// ── add / edit ──
function setForm(m) {
  $('f-name').value = m?.name || ''; $('f-form').value = m?.dosage_form || ''; $('f-strength').value = m?.strength || '';
  $('f-unit').value = m?.unit || ''; $('f-mfr').value = m?.manufacturer || ''; $('f-cat').value = m?.category || '';
  $('f-hsn').value = m?.hsn_code || ''; $('f-gst').value = m?.gst_percent ?? '';
  $('f-highrisk').checked = !!m?.is_high_risk; $('f-e1').checked = !!m?.is_schedule_e1;
}
function resetWarnings() {
  $('dup-warn').style.display = 'none'; $('dup-warn').replaceChildren();
  $('save-anyway-btn').style.display = 'none'; $('edit-err').textContent = '';
}
window.openNewMedicine = () => {
  _editId = null; closeDeactivate(); setForm(null); resetWarnings();
  $('edit-title').textContent = 'Add medicine';
  $('edit-panel').style.display = ''; $('f-name').focus();
};
window.editMedicine = id => {
  const m = _rows.find(r => r.id === id); if (!m) return;
  _editId = id; closeDeactivate(); setForm(m); resetWarnings();
  $('edit-title').textContent = `Edit — ${m.name}${m.med_id ? ' (' + m.med_id + ')' : ''}`;
  $('edit-panel').style.display = ''; $('edit-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); $('f-name').focus();
};
window.closeEdit = () => { $('edit-panel').style.display = 'none'; _editId = null; };

function payload() {
  const gst = $('f-gst').value.trim();
  return {
    p_id: _editId, p_name: $('f-name').value, p_form: $('f-form').value || null, p_strength: $('f-strength').value,
    p_unit: $('f-unit').value, p_manufacturer: $('f-mfr').value, p_category: $('f-cat').value, p_hsn: $('f-hsn').value,
    p_gst_percent: gst === '' ? null : Number(gst), p_is_high_risk: $('f-highrisk').checked, p_is_schedule_e1: $('f-e1').checked,
  };
}

// Near-duplicate names are a WARNING (the server refuses only exact duplicates): show them, save on a second click.
window.saveMedicine = async () => {
  resetWarnings();
  const p = payload();
  const original = _editId ? _rows.find(r => r.id === _editId) : null;
  const nameChanged = !original || original.name.trim().toLowerCase() !== p.p_name.trim().toLowerCase();
  if (nameChanged && p.p_name.trim().length >= 3) {
    const { data: near, error } = await supabase.rpc('catalogue_near_duplicates', { p_name: p.p_name, p_form: p.p_form, p_exclude: _editId });
    if (error) { $('edit-err').textContent = safeErrorMessage(error, 'Could not check for similar medicines.'); return; }
    if (Array.isArray(near) && near.length) {
      $('dup-warn').replaceChildren(
        el('strong', null, 'Similar medicines are already in the catalogue — check this is not a duplicate:'),
        el('ul', null, near.map(n => el('li', null,
          `${n.name}${n.dosage_form ? ' · ' + (FORM_LABEL[n.dosage_form] || n.dosage_form) : ''}${n.strength ? ' · ' + n.strength : ''}`
          + `${n.manufacturer ? ' · ' + n.manufacturer : ''}${n.med_id ? ' (' + n.med_id + ')' : ''}${n.is_active ? '' : ' — inactive'}`))));
      $('dup-warn').style.display = '';
      $('save-anyway-btn').style.display = '';
      return;
    }
  }
  await doSave(p);
};
window.saveMedicineAnyway = () => doSave(payload());

async function doSave(p) {
  const btn = $('save-btn'); btn.disabled = true; $('save-anyway-btn').disabled = true;
  const { data, error } = await supabase.rpc('catalogue_save_medicine', p);
  btn.disabled = false; $('save-anyway-btn').disabled = false;
  if (error) { $('edit-err').textContent = safeErrorMessage(error, 'Could not save the medicine.'); return; }
  notify(data.created ? `Added${data.med_id ? ' (' + data.med_id + ')' : ''}` : 'Saved', 'success');
  closeEdit();
  search();
}

// ── deactivate / reactivate (never delete) ──
window.openDeactivate = id => {
  const m = _rows.find(r => r.id === id); if (!m) return;
  _deactId = id; closeEdit();
  $('deact-title').textContent = `Deactivate — ${m.name}`;
  $('deact-reason').value = ''; $('deact-err').textContent = '';
  $('deact-panel').style.display = ''; $('deact-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); $('deact-reason').focus();
};
window.closeDeactivate = () => { $('deact-panel').style.display = 'none'; _deactId = null; };
window.confirmDeactivate = async () => {
  if (!_deactId) return;
  const reason = $('deact-reason').value.trim();
  if (reason.length < 5) { $('deact-err').textContent = 'Give the reason for deactivating (at least 5 characters).'; return; }
  const { error } = await supabase.rpc('catalogue_set_medicine_active', { p_id: _deactId, p_active: false, p_reason: reason });
  if (error) { $('deact-err').textContent = safeErrorMessage(error, 'Could not deactivate.'); return; }
  notify('Deactivated', 'success');
  closeDeactivate();
  search();
};
window.reactivate = async id => {
  const { error } = await supabase.rpc('catalogue_set_medicine_active', { p_id: id, p_active: true, p_reason: null });
  if (error) { notify(safeErrorMessage(error, 'Could not reactivate.'), 'error'); return; }
  notify('Reactivated', 'success');
  search();
};
