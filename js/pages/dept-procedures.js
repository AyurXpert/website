// Session 391 T1a-2 (owner D2-1, 23 Nov 2026): Department Procedures -- the Shalakya and Prasuti / Stri Roga procedure record.
// Every entry is recorded from a started sitting of a doctor's treatment order (Today's sittings → ▶ Start), or by the department head
// without an order (a reason, audited). The server writes the record (save_dept_procedure_record) and sets the patient, the procedure,
// the date and the doctor from the sitting; a correction is a new entry (correct_dept_procedure_record). DOM nodes + textContent only.
import { requireAuth, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { safeErrorMessage } from '../utils/errors.js';
import { notify } from '../components/notify.js';
import { mountTodaysSittings } from '../modules/scheduler/todaysSittings.js';
import { mountDeptProcedureSlots } from '../modules/scheduler/deptProcedureSlots.js';

await requireAuth(['super_admin', 'dept_admin', 'doctor', 'nurse', 'therapist']);
initNavbar();

const tenantId = getCurrentTenantId();
let _register = 'shalakya';
let _sitting = null;
let _sittings = null;
const $ = id => document.getElementById(id);
const say = (m, t) => notify(m, t || 'info');
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

function setTab(reg) {
  _register = reg;
  $('tab-shalakya').setAttribute('aria-selected', String(reg === 'shalakya'));
  $('tab-psr').setAttribute('aria-selected', String(reg === 'psr'));
  closeRecord();
  _sittings = mountTodaysSittings({ supabase, container: $('todays-sittings'), register: reg, toast: say, onStart: openRecord, tenantId });
  loadRecords();
}

function openRecord(info) {
  _sitting = info;
  $('record-title').textContent = `Record: ${info.procedure}`;
  $('record-sub').textContent = `${info.patient_name}${info.uhid ? ' (' + info.uhid + ')' : ''} · sitting ${info.sitting_no} of ${info.sittings_planned || 1}`
    + (info.side ? ` · ${{ bilateral: 'both sides', right: 'right', left: 'left' }[info.side] || info.side}` : '')
    + (info.without_order ? ' · without an order' : '');
  ['r-site', 'r-pre', 'r-notes', 'r-findings', 'r-complications', 'r-post', 'r-followup'].forEach(id => { $(id).value = ''; });
  $('record-card').hidden = false;
  $('r-notes').focus();
}
function closeRecord() { _sitting = null; $('record-card').hidden = true; }

$('r-cancel').addEventListener('click', closeRecord);
$('r-save').addEventListener('click', async () => {
  if (!_sitting) { say("Start the patient's sitting first (Today's sittings → ▶ Start).", 'error'); return; }
  const btn = $('r-save');
  btn.disabled = true;
  const { data, error } = await supabase.rpc('save_dept_procedure_record', { p_sitting: _sitting.sitting_id, p_payload: {
    site: $('r-site').value.trim(), pre_findings: $('r-pre').value.trim(), procedure_notes: $('r-notes').value.trim(),
    findings: $('r-findings').value.trim(), complications: $('r-complications').value.trim(), post_instructions: $('r-post').value.trim(),
    follow_up_date: $('r-followup').value || null } });
  btn.disabled = false;
  if (error) { say(safeErrorMessage(error, 'The record could not be saved.') + ' Nothing was saved.', 'error'); return; }
  if (!data) { say('Not saved: the server did not confirm the record. Reload the page and check.', 'error'); return; }   // no false "saved" (353A)
  say('Procedure recorded ✓', 'success');
  closeRecord();
  _sittings?.reload();
  loadRecords();
});

async function loadRecords() {
  const box = $('records');
  box.replaceChildren(el('div', 'muted', 'Loading…'));
  const since = new Date(Date.now() + 330 * 60000 - 30 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('dept_procedure_records')
    .select('id, procedure_name, procedure_date, side, site, procedure_notes, status, corrects_id, correction_reason, entered_without_order, department_id, patient_id')
    .eq('tenant_id', tenantId).gte('procedure_date', since).order('procedure_date', { ascending: false }).order('created_at', { ascending: false }).limit(200);
  box.replaceChildren();
  if (error) { box.append(el('div', 'muted', safeErrorMessage(error, 'The records could not be loaded.'))); return; }
  const ids = [...new Set((data || []).map(r => r.patient_id))];
  const names = new Map();
  if (ids.length) {
    const { data: pts } = await supabase.from('patients').select('id, name, uhid').in('id', ids);
    (pts || []).forEach(p => names.set(p.id, `${p.name} (${p.uhid})`));
  }
  const { data: depts } = await supabase.from('departments').select('id, ncism_code');
  const fam = new Map((depts || []).map(d => [d.id, ['SHAK', 'SHALAKYA_TANTRA', 'SHNT'].includes(d.ncism_code) ? 'shalakya'
                                                     : ['PST', 'STRI_ROGA_PRASUTI'].includes(d.ncism_code) ? 'psr' : '']));
  const rows = (data || []).filter(r => fam.get(r.department_id) === _register);
  if (!rows.length) { box.append(el('div', 'muted', 'No procedure recorded in the last 30 days.')); return; }
  const t = el('table');
  const head = el('tr');
  ['Date', 'Patient', 'Procedure', 'What was done', ''].forEach(h => head.append(el('th', null, h)));
  t.append(head);
  rows.forEach(r => {
    const tr = el('tr');
    const struck = r.status === 'corrected';
    tr.append(el('td', struck ? 'struck' : null, r.procedure_date));
    tr.append(el('td', struck ? 'struck' : null, names.get(r.patient_id) || '—'));
    const pc = el('td', struck ? 'struck' : null, r.procedure_name + (r.site ? ` · ${r.site}` : ''));
    if (r.entered_without_order) { pc.append(' '); pc.append(el('span', 'tag red', 'Without an order')); }
    if (r.corrects_id) pc.append(el('div', 'muted', `Correction: ${r.correction_reason}`));
    tr.append(pc);
    tr.append(el('td', struck ? 'struck' : null, r.procedure_notes));
    const act = el('td');
    if (!struck) {
      const b = el('button', 'btn secondary', '✎ Correct');
      b.type = 'button';
      b.addEventListener('click', () => correctRow(r, tr));
      act.append(b);
    }
    tr.append(act);
    t.append(tr);
  });
  box.append(t);
}

function correctRow(r, tr) {
  const row = el('tr');
  const td = el('td'); td.colSpan = 5;
  const notes = document.createElement('textarea'); notes.maxLength = 4000; notes.value = r.procedure_notes || '';
  notes.setAttribute('aria-label', 'Corrected procedure notes'); notes.style.cssText = 'width:100%;min-height:70px;font-family:inherit';
  const reason = document.createElement('input'); reason.type = 'text'; reason.maxLength = 300; reason.placeholder = 'Reason for the correction (5 to 300 characters)';
  reason.setAttribute('aria-label', 'Reason for the correction'); reason.style.cssText = 'min-height:40px;width:100%;margin-top:6px';
  const ok = el('button', 'btn', 'Save the correction'); ok.type = 'button'; ok.style.marginTop = '6px';
  const cancel = el('button', 'btn secondary', 'Close'); cancel.type = 'button'; cancel.style.margin = '6px 0 0 8px';
  td.append(notes, reason, ok, cancel); row.append(td);
  tr.after(row);
  cancel.addEventListener('click', () => row.remove());
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    const { error } = await supabase.rpc('correct_dept_procedure_record', { p_record: r.id, p_payload: { procedure_notes: notes.value.trim(), site: r.site },
                                                                             p_reason: reason.value.trim() });
    ok.disabled = false;
    if (error) { say(safeErrorMessage(error, 'The correction could not be saved.'), 'error'); return; }
    say('Correction saved ✓', 'success');
    loadRecords();
  });
}

// the slots and places of any Shalya / Shalakya / Prasuti department (the server decides who may change them: the HOD, the MS, the Super Admin)
async function initSlots() {
  const sel = $('slots-dept');
  const { data } = await supabase.from('departments').select('id, name, ncism_code').eq('tenant_id', tenantId).order('name');
  const fam = ['SHAL', 'SHALYA_TANTRA', 'SHAK', 'SHALAKYA_TANTRA', 'SHNT', 'PST', 'STRI_ROGA_PRASUTI'];
  sel.replaceChildren(el('option', null, 'Choose the department…'));
  sel.firstChild.value = '';
  (data || []).filter(d => fam.includes(d.ncism_code)).forEach(d => { const o = el('option', null, d.name); o.value = d.id; sel.append(o); });
  sel.addEventListener('change', () => {
    if (!sel.value) { $('slots-wrap').replaceChildren(); return; }
    mountDeptProcedureSlots({ supabase, container: $('slots-wrap'), deptId: sel.value, toast: (m, isErr) => say(m, isErr ? 'error' : 'success') });
  });
}
initSlots();

// D2-10: the Medical Superintendent's list of entries without an order (procedures_without_order: the MS or the Super Admin; the server refuses others)
{
  const ist = d => new Date(Date.now() + 330 * 60000 - d * 86400000).toISOString().slice(0, 10);
  $('wo-from').value = ist(6); $('wo-to').value = ist(0);
  $('wo-show').addEventListener('click', async () => {
    const box = $('wo-list');
    box.replaceChildren(el('div', 'muted', 'Loading…'));
    const { data, error } = await supabase.rpc('procedures_without_order', { p_from: $('wo-from').value || null, p_to: $('wo-to').value || null });
    box.replaceChildren();
    if (error) { box.append(el('div', 'muted', safeErrorMessage(error, 'The list could not be loaded.'))); return; }
    if (!data?.length) { box.append(el('div', 'muted', 'No entry without an order in this period.')); return; }
    const t = el('table');
    const head = el('tr');
    ['When', 'Patient', 'Procedure', 'Recorded by', 'Reason', 'Consent'].forEach(h => head.append(el('th', null, h)));   // F7: + the consent
    t.append(head);
    data.forEach(r => {
      const tr = el('tr');
      tr.append(el('td', null, new Date(r.ordered_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })));
      tr.append(el('td', null, `${r.patient_name} (${r.uhid})`), el('td', null, r.procedure_name), el('td', null, r.recorded_by || '—'), el('td', null, r.reason || '—'),
        el('td', null, r.consent || '—'));
      t.append(tr);
    });
    box.append(t);
  });
}

$('tab-shalakya').addEventListener('click', () => setTab('shalakya'));
$('tab-psr').addEventListener('click', () => setTab('psr'));
// F8 (owner, 24 Nov 2026): only the departments the server says this account reads (my_dept_procedure_registers); the server's row rules
// are the protection, the hidden tab only follows them. None = a plain message, no tab.
{
  const { data: regs, error: re } = await supabase.rpc('my_dept_procedure_registers');
  const mine = Array.isArray(regs) ? regs : [];
  if (re) say(safeErrorMessage(re, 'Your departments could not be loaded.'), 'error');
  $('tab-shalakya').hidden = !mine.includes('shalakya');
  $('tab-psr').hidden = !mine.includes('psr');
  if (mine.length) setTab(mine[0]);
  else $('todays-sittings').replaceChildren(Object.assign(document.createElement('div'),
    { className: 'muted', textContent: 'No department procedures for your account.' }));
}
