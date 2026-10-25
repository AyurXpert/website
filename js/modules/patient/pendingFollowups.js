// pendingFollowups.js -- Session 358 (TODO §265-D / §274): reception's "🔬 Reports & Registrations" tab.
//  (1) Visits waiting for reports: when the patient comes back, "Back with reports" (mark_returned_with_reports) tells the visit's
//      doctor -- no new visit, token or fee (owner Q6). The SERVER checks every step; this page only lists and asks.
//  (2) Casualty registrations to complete (patients.registration_incomplete, set by quick_register_emergency_patient): reception fills
//      the BLANK fields (complete_patient_registration). An unidentified patient's identity is entered only by MRD / the Super Admin
//      through Correct patient details (never here). Autofill off on every field (§285).
import { safeErrorMessage } from '../../utils/errors.js';
import { notify } from '../../components/notify.js';

const _fmtDay = iso => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
const _el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
const _btnCss = 'min-height:44px;padding:0 14px;background:var(--green-deep);color:#fff;border:none;border-radius:6px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer';

export async function loadPendingFollowups({ supabase, tenantId, container, countEl }) {
  container.replaceChildren(_el('div', 'padding:14px;font-size:12px;color:var(--text-muted)', 'Loading…'));
  const [aw, inc] = await Promise.all([
    supabase.from('visits').select('id, created_at, awaiting_reports_since, returned_with_reports_at, doctor_id, patients(name, uhid), doctor:profiles!visits_doctor_id_fkey(full_name)')
      .eq('tenant_id', tenantId).eq('status', 'awaiting_reports').eq('is_deleted', false).order('awaiting_reports_since'),
    supabase.from('patients').select('id, name, uhid, phone, address, date_of_birth, blood_group, is_unidentified, created_at')
      .eq('tenant_id', tenantId).eq('registration_incomplete', true).order('created_at', { ascending: false }).limit(100),
  ]);
  const awRows = aw.error ? [] : (aw.data || []);
  const incRows = inc.error ? [] : (inc.data || []);
  if (countEl) countEl.textContent = (awRows.length + incRows.length) ? `(${awRows.length + incRows.length})` : '';
  const out = [];

  out.push(_el('div', 'padding:10px 12px 4px;font-size:12.5px;font-weight:700;color:var(--blue,#1a4080)', `🔬 Waiting for reports (${awRows.length})`));
  if (aw.error) out.push(_el('div', 'padding:4px 12px;font-size:12px;color:var(--red,#a01a1a)', safeErrorMessage(aw.error, 'Could not load the visits waiting for reports.')));
  else if (!awRows.length) out.push(_el('div', 'padding:4px 12px 10px;font-size:12px;color:var(--text-muted)', 'No visit is waiting for reports.'));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  awRows.forEach(v => {
    const row = _el('div', 'padding:8px 12px;border-top:1px solid var(--border);font-size:12px;line-height:1.45');
    row.append(_el('div', 'font-weight:600', `${v.patients?.name || '—'} · ${v.patients?.uhid || '—'}`));
    row.append(_el('div', 'color:var(--text-mid)', `Dr ${v.doctor?.full_name || '—'} · waiting since ${_fmtDay(v.awaiting_reports_since)} · closed after 7 days if not back`));
    const backToday = v.returned_with_reports_at && new Date(v.returned_with_reports_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === today;
    if (backToday) row.append(_el('div', 'color:var(--green-deep);font-weight:600', '✓ Marked back today — the doctor has been told'));
    const b = _el('button', _btnCss + ';margin-top:6px', backToday ? 'Back again (tell the doctor)' : 'Back with reports');
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      const { error } = await supabase.rpc('mark_returned_with_reports', { p_visit_id: v.id });
      if (error) { notify(safeErrorMessage(error, 'The return could not be recorded.'), 'error'); b.disabled = false; return; }
      notify(`${v.patients?.name || 'Patient'}: the doctor has been told the patient is back with the reports. No new visit or fee.`, 'success');
      loadPendingFollowups({ supabase, tenantId, container, countEl });
    });
    row.append(b);
    out.push(row);
  });

  out.push(_el('div', 'padding:14px 12px 4px;font-size:12.5px;font-weight:700;color:#7a3a00', `⚠ Registration incomplete (${incRows.length})`));
  if (inc.error) out.push(_el('div', 'padding:4px 12px;font-size:12px;color:var(--red,#a01a1a)', safeErrorMessage(inc.error, 'Could not load the incomplete registrations.')));
  else if (!incRows.length) out.push(_el('div', 'padding:4px 12px 10px;font-size:12px;color:var(--text-muted)', 'Every casualty registration is complete.'));
  incRows.forEach(p => out.push(_incompleteRow(p, { supabase, tenantId, container, countEl })));
  container.replaceChildren(...out);
}

function _incompleteRow(p, ctx) {
  const row = _el('div', 'padding:8px 12px;border-top:1px solid var(--border);font-size:12px;line-height:1.45');
  row.append(_el('div', 'font-weight:600', `${p.name} · ${p.uhid || '—'}`));
  const tags = _el('div', 'color:var(--text-mid)', `Registered in casualty ${_fmtDay(p.created_at)}`);
  row.append(tags);
  if (p.is_unidentified) {
    row.append(_el('div', 'color:#a01a1a;font-weight:600',
      'Unidentified patient — the real name / age is entered by MRD or the Super Admin (Correct patient details), with a reason.'));
  }
  const form = _el('div', 'display:none;margin-top:6px;gap:6px');
  const field = (key, label, type, current) => {
    const wrap = _el('div', 'margin-bottom:6px');
    const id = `pr358-${key.slice(0, 2)}-${p.id.slice(0, 8)}`;
    const lab = _el('label', 'display:block;font-size:11.5px;font-weight:600', label);
    lab.htmlFor = id;
    const inp = document.createElement(type === 'select' ? 'select' : 'input');
    inp.id = id;
    inp.dataset.key = key;
    inp.setAttribute('autocomplete', `ax-pr358-${key.slice(0, 2)}`);   // §285: no browser autofill of another patient's details
    inp.style.cssText = 'width:100%;box-sizing:border-box;min-height:40px';
    if (type === 'select') {
      ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v || '— Select —'; inp.append(o); });
    } else { inp.type = type; }
    if (current) { inp.value = current; inp.disabled = true; lab.textContent = `${label} (recorded)`; }
    wrap.append(lab, inp);
    return wrap;
  };
  form.append(field('phone', 'Phone', 'text', p.phone), field('address', 'Address', 'text', p.address),
              field('date_of_birth', 'Date of birth', 'date', p.date_of_birth), field('blood_group', 'Blood group', 'select', p.blood_group));
  const save = _el('button', _btnCss, 'Save — registration complete');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const fields = {};
    form.querySelectorAll('[data-key]').forEach(i => { if (!i.disabled && i.value.trim()) fields[i.dataset.key] = i.value.trim(); });
    save.disabled = true;
    const { error } = await ctx.supabase.rpc('complete_patient_registration', { p_patient_id: p.id, p_fields: fields });
    if (error) { notify(safeErrorMessage(error, 'The registration could not be completed.'), 'error'); save.disabled = false; return; }
    notify(`${p.name}: registration completed.`, 'success');
    loadPendingFollowups(ctx);
  });
  form.append(save);
  const open = _el('button', _btnCss + ';margin-top:6px;background:#fff;color:var(--green-deep);border:1.5px solid var(--green-deep)', 'Complete registration');
  open.type = 'button';
  open.setAttribute('aria-expanded', 'false');
  open.addEventListener('click', () => {
    const show = form.style.display === 'none';
    form.style.display = show ? 'block' : 'none';
    open.setAttribute('aria-expanded', String(show));
  });
  row.append(open, form);
  return row;
}
