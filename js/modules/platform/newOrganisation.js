// newOrganisation.js -- subscription.html → "➕ New organisation" and the two tools in All Tenants → Edit (Session 379a, owner 7 Nov 2026). Only an ACTIVE platform admin creates an
// organisation (platform_create_organisation re-checks, audits, seeds and makes the first Super Admin's one-time link). The link is shown once, to be copied; the platform never
// sees or sets a password. DOM nodes + textContent only; one click handler per button.
import { safeErrorMessage } from '../../utils/errors.js';
import { inviteLink } from '../staff/staffContacts.js';
import { NCISM_DEPTS } from '../../config/ncism.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const inputCss = "display:block;width:100%;box-sizing:border-box;min-height:44px;margin-top:4px;padding:0 10px;border:1.5px solid var(--border);border-radius:8px;font:14px 'DM Sans',sans-serif";
const labelCss = 'flex:1;min-width:220px;font-size:12.5px;color:var(--text-mid)';
const btnCss = "min-height:44px;padding:0 18px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)";
const outCss = "min-height:44px;padding:0 14px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;background:#fff;color:var(--green-deep);border:1.5px solid var(--green-deep)";
const rowCss = 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px';
const fmt = d => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

const TYPES = [
  ['teaching_hospital', 'Teaching Hospital'], ['college', 'College'], ['hospital', 'Ayurveda Hospital'], ['clinic', 'Clinic'], ['pk_center', 'Panchakarma Center'],
  ['dispensary', 'Dispensary'], ['laboratory', 'Laboratory'], ['pharma', 'Pharma'], ['raw_drug_supplier', 'Raw Drug Supplier'], ['instrument_supplier', 'Instrument Supplier'],
  ['chemical_supplier', 'Chemical Supplier'], ['dealer', 'Dealer'], ['journal', 'Journal / Publication'],
];
const NCISM_TYPES = new Set(['teaching_hospital', 'college']);
const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu & Kashmir', 'Ladakh', 'Puducherry'];

function field(label, input) { const l = mk('label', labelCss, label); l.append(input); return l; }
function textInput(id, max, type = 'text') { const i = mk('input', inputCss); i.id = id; i.type = type; i.maxLength = max; i.autocomplete = 'off'; return i; }
function selectOf(id, first, opts) {
  const s = mk('select', inputCss); s.id = id;
  s.append(new Option(first, ''));
  for (const [v, t] of opts) s.append(new Option(t, v));
  return s;
}

// The link card: shown after a create and after a new link
function linkCard(res, title) {
  const link = inviteLink(res.invite_token);
  const c = mk('div', 'margin-top:16px;padding:14px 16px;border:1.5px solid #a5d6b8;border-radius:8px;background:#f0fff4');
  c.id = 'org-link-card';
  c.append(mk('div', 'font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:8px', title));
  if (res.tenant_code) c.append(mk('div', 'font-size:13px;margin-bottom:4px', `Organisation code: ${res.tenant_code}`));
  if (res.uhid_example) c.append(mk('div', 'font-size:13px;margin-bottom:4px', `First UHID will be: ${res.uhid_example}`));
  if (res.max_users) c.append(mk('div', 'font-size:13px;margin-bottom:4px', `Staff limit: ${res.max_users} (interns and PG scholars not counted)`));
  if (res.screening_opd) c.append(mk('div', 'font-size:13px;margin-bottom:4px', `Screening OPD: ${res.screening_opd}`));
  c.append(mk('div', 'font-size:13px;margin:8px 0 4px', `Send this link to ${res.first_admin_email}. It works once, for that email only, until ${fmt(res.invite_expires_at)}.`));
  const box = mk('input', inputCss); box.id = 'org-link'; box.readOnly = true; box.value = link;
  const copy = mk('button', `${outCss};margin-top:8px`, '📋 Copy link'); copy.type = 'button';
  const note = mk('span', 'font-size:12.5px;margin-left:10px'); note.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    box.select();
    try { await navigator.clipboard.writeText(link); note.textContent = 'Copied.'; }
    catch { note.textContent = 'Press Ctrl+C to copy.'; }
  });
  c.append(box, copy, note);
  return c;
}

/** renderNewOrganisation(box, { supabase, onCreated }) */
export async function renderNewOrganisation(box, { supabase, onCreated }) {
  if (!box) return;
  const intro = mk('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:14px;line-height:1.5',
    'Creates the organisation, seeds its departments and OPDs for its type, and gives you a one-time link for its first Super Admin. ABDM stays off until you open it in 🏛️ ABDM access.');
  const form = mk('div');
  const type = selectOf('org-type', '— Choose the type —', TYPES);
  const name = textInput('org-name', 200);
  const addr = textInput('org-address', 300);
  const city = textInput('org-city', 100);
  const state = selectOf('org-state', '— Choose the state —', STATES.map(s => [s, s]));
  const pin = textInput('org-pin', 6); pin.inputMode = 'numeric';
  const phone = textInput('org-phone', 10); phone.inputMode = 'tel';
  const prefix = textInput('org-prefix', 5); prefix.style.textTransform = 'uppercase';
  const example = mk('div', 'font-size:12px;color:var(--text-muted);margin-top:4px', 'UHID will look like: PREFIX/2627/000001');
  example.id = 'org-prefix-example';
  const adminName = textInput('org-admin-name', 200);
  const adminEmail = textInput('org-admin-email', 200, 'email');
  // Session 383 (D9 / D10): the staff limit is required and set on create; interns and PG scholars are not counted
  const maxUsers = textInput('org-max-users', 3, 'number'); maxUsers.min = '1'; maxUsers.max = '998'; maxUsers.required = true;
  const maxHelp = mk('div', 'font-size:12px;color:var(--text-muted);margin-top:4px', 'Staff only (expected staff + about 20 %). Interns and PG scholars do not count.');

  const r1 = mk('div', rowCss); r1.append(field('Organisation type', type), field('Organisation name', name));
  const r2 = mk('div', rowCss); r2.append(field('Address', addr));
  const r3 = mk('div', rowCss); r3.append(field('City', city), field('State', state), field('PIN code', pin));
  const pf = field('UHID prefix (2 to 5 capital letters or digits)', prefix); pf.append(example);
  const r4 = mk('div', rowCss); r4.append(field('Phone (optional)', phone), pf);

  // NCISM capacity: teaching hospital + college only
  const ncism = mk('div', 'margin-bottom:12px;padding:12px 14px;border:1.5px solid var(--border);border-radius:8px'); ncism.hidden = true; ncism.id = 'org-ncism';
  ncism.append(mk('div', 'font-weight:600;font-size:13px;color:var(--green-deep);margin-bottom:8px', 'NCISM capacity'));
  const ug = selectOf('org-ug', '— Choose the UG intake —', []);
  const r5 = mk('div', rowCss); r5.append(field('UG intake', ug)); ncism.append(r5);
  ncism.append(mk('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:6px', 'PG seats per department (leave empty for none)'));
  const pgGrid = mk('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px');
  const pgInputs = {};
  for (const d of NCISM_DEPTS) {
    const l = mk('label', 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;color:var(--text-mid)', d.name);
    const i = mk('input', 'width:70px;min-height:44px;padding:0 8px;border:1.5px solid var(--border);border-radius:8px;font:14px \'DM Sans\',sans-serif');
    i.type = 'number'; i.min = '0'; i.max = '999'; i.id = `org-pg-${d.ncism_code}`;
    pgInputs[d.ncism_code] = i; l.append(i); pgGrid.append(l);
  }
  ncism.append(pgGrid);

  const r6 = mk('div', rowCss); r6.append(field('First Super Admin: full name', adminName), field('First Super Admin: email', adminEmail));
  const mf = field('Staff limit (required, 1 to 998)', maxUsers); mf.append(maxHelp);
  const r7 = mk('div', rowCss); r7.append(mf);
  const go = mk('button', btnCss, '➕ Create organisation'); go.type = 'button'; go.id = 'org-create';
  const status = mk('div', 'font-size:12.5px;min-height:1em;margin-top:8px'); status.setAttribute('role', 'status'); status.id = 'org-status';
  const result = mk('div');
  form.append(r1, r2, r3, r4, ncism, r6, r7, go, status, result);
  box.replaceChildren(intro, form);

  const { data: tiers } = await supabase.from('ncism_intake_tiers').select('ug_intake').eq('is_active', true).order('sort_order');
  for (const t of tiers || []) ug.append(new Option(`${t.ug_intake} students`, String(t.ug_intake)));

  type.addEventListener('change', () => { ncism.hidden = !NCISM_TYPES.has(type.value); });
  prefix.addEventListener('input', () => {
    const v = prefix.value.toUpperCase();
    example.textContent = `UHID will look like: ${v || 'PREFIX'}/2627/000001`;
  });

  go.addEventListener('click', async () => {
    status.style.color = 'var(--text-mid)'; status.textContent = 'Creating…'; go.disabled = true; result.replaceChildren();
    const isNcism = NCISM_TYPES.has(type.value);
    const pg = isNcism ? Object.entries(pgInputs).filter(([, i]) => Number(i.value) > 0).map(([code, i]) => ({ code, seats: Number(i.value) })) : [];
    const { data, error } = await supabase.rpc('platform_create_organisation', {
      p_name: name.value, p_type: type.value, p_address: addr.value, p_city: city.value, p_state: state.value, p_pin: pin.value, p_phone: phone.value || null,
      p_uhid_prefix: prefix.value, p_admin_name: adminName.value, p_admin_email: adminEmail.value,
      p_max_users: maxUsers.value === '' ? null : Number(maxUsers.value),   // the server refuses empty / out of range
      p_ug_intake: isNcism && ug.value ? Number(ug.value) : null, p_pg: pg,
    });
    go.disabled = false;
    if (error) { status.style.color = 'var(--red,#c0392b)'; status.textContent = safeErrorMessage(error, 'Could not create the organisation.'); return; }
    status.textContent = '';
    result.replaceChildren(linkCard(data, `✅ ${data.name} created`));
    for (const i of [name, addr, city, pin, phone, prefix, adminName, adminEmail, maxUsers, ...Object.values(pgInputs)]) i.value = '';
    type.value = ''; state.value = ''; ug.value = ''; ncism.hidden = true;
    example.textContent = 'UHID will look like: PREFIX/2627/000001';
    onCreated?.();
  });
}

/** renderOrgTools(box, { supabase, tenant, onChanged }): All Tenants → Edit. The UHID prefix (until the first patient) + a new first-admin link (until there is a Super Admin). */
export function renderOrgTools(box, { supabase, tenant, onChanged }) {
  if (!box) return;
  const title = mk('div', 'font-weight:600;font-size:13px;margin-bottom:6px', 'UHID prefix');
  const nowText = () => `Now: ${tenant.uhid_prefix || 'AYX'}. It can change only until the organisation's first patient.`;
  const now = mk('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:6px', nowText());
  const p = textInput('e-uhid-prefix', 5); p.value = tenant.uhid_prefix || ''; p.style.textTransform = 'uppercase';
  const r = textInput('e-uhid-reason', 300);
  const save = mk('button', outCss, 'Save prefix'); save.type = 'button'; save.id = 'e-uhid-save';
  const s1 = mk('div', 'font-size:12.5px;min-height:1em;margin-top:6px'); s1.setAttribute('role', 'status');
  save.addEventListener('click', async () => {
    const { error } = await supabase.rpc('platform_set_uhid_prefix', { p_tenant: tenant.id, p_prefix: p.value, p_reason: r.value });
    s1.style.color = error ? 'var(--red,#c0392b)' : 'var(--green-deep)';
    s1.textContent = error ? safeErrorMessage(error, 'Could not save the prefix.') : '✅ Saved';
    if (!error) { tenant.uhid_prefix = p.value.toUpperCase(); now.textContent = nowText(); onChanged?.(); }
  });
  const rowA = mk('div', rowCss); rowA.append(field('New prefix', p), field('Reason (required)', r));

  const t2 = mk('div', 'font-weight:600;font-size:13px;margin:12px 0 6px', 'First Super Admin link');
  const hint = mk('div', 'font-size:12.5px;color:var(--text-mid);margin-bottom:6px', 'Only for an organisation with no active Super Admin yet. The old link stops working.');
  const en = textInput('e-admin-name', 200), ee = textInput('e-admin-email', 200, 'email');
  const rowB = mk('div', rowCss); rowB.append(field('Name (empty = keep)', en), field('Email (empty = keep)', ee));
  const again = mk('button', outCss, '🔗 New link'); again.type = 'button'; again.id = 'e-new-link';
  const s2 = mk('div', 'font-size:12.5px;min-height:1em;margin-top:6px'); s2.setAttribute('role', 'status');
  const out = mk('div');
  again.addEventListener('click', async () => {
    out.replaceChildren(); s2.textContent = '';
    const { data, error } = await supabase.rpc('platform_first_admin_link', { p_tenant: tenant.id, p_admin_name: en.value || null, p_admin_email: ee.value || null });
    if (error) { s2.style.color = 'var(--red,#c0392b)'; s2.textContent = safeErrorMessage(error, 'Could not make a new link.'); return; }
    out.append(linkCard(data, '🔗 New link'));
  });
  box.replaceChildren(title, now, rowA, save, s1, t2, hint, rowB, again, s2, out);
}
