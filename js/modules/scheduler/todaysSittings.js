// Session 391 T1a-2 -- "Today's sittings" on a department register page (Anushastra, Kshara sutra, Minor OT, Department procedures).
// The ordered sittings of the day (procedure_sittings_list), ▶ Start (start_procedure_sitting: consent, the chaperone rule, the doctor
// booked), ⏭ Skip (+ a new date, one call), ↔ Move, and the department head's entry without an order (open_procedure_without_order,
// a reason, audited). The page records the register row from the started sitting (its own form); the server sets the patient, the fee,
// the date and the doctor from the sitting. DOM nodes + textContent only; handlers on the nodes built here.
import { safeErrorMessage } from '../../utils/errors.js';

const el = (tag, style, text) => {
  const n = document.createElement(tag);
  if (style) n.style.cssText = style;
  if (text != null) n.textContent = text;
  return n;
};
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const STATUS = { scheduled: ['Scheduled', 'var(--green-light)', 'var(--green-deep)'], in_progress: ['In progress', '#e8eef8', '#1a4080'],
                 completed: ['Done', 'var(--green-light)', 'var(--green-deep)'], missed: ['Missed', '#fbeaea', '#8b1a1a'],
                 skipped: ['Skipped', '#f4f4f4', '#555'] };
const KIND_OF = { anushastra: 'anushastra', kshara_sutra: 'kshara_sutra', minor_ot: 'minor_procedure', shalakya: 'department_procedure',
                  psr: 'department_procedure' };
// F10 (owner rehearsal, 25 Nov 2026): the department of each register = the server's _dept_family codes (departments and OPDs share them)
const FAMILY_CODES = { shalya: ['SHAL', 'SHALYA_TANTRA'], psr: ['PST', 'STRI_ROGA_PRASUTI'], shalakya: ['SHAK', 'SHALAKYA_TANTRA', 'SHNT'] };
const FAMILY_OF = { anushastra: 'shalya', kshara_sutra: 'shalya', minor_ot: 'shalya', shalakya: 'shalakya', psr: 'psr' };
const DEPT_NAME = { shalya: 'Shalya', psr: 'Prasuti / Stri Roga', shalakya: 'Shalakya' };
// a search word safe inside a PostgREST or() filter: no , ( ) * % \ or quotes; at least 2 characters, at most 60
const searchWord = q => { const w = String(q || '').replace(/[,()*%\\"'`:]/g, ' ').replace(/\s+/g, ' ').trim(); return w.length >= 2 ? w.slice(0, 60) : ''; };
const patientLabel = p => `${p.name || '—'} · ${p.uhid || 'no UHID'}${p.phone ? ' · ' + p.phone : ''}`;

function btn(text, primary) {
  const b = el('button', `min-height:44px;padding:6px 12px;border-radius:6px;font-size:12.5px;cursor:pointer;border:1px solid var(--green-deep);`
    + (primary ? 'background:var(--green-deep);color:#fff' : 'background:#fff;color:var(--green-deep)'), text);
  b.type = 'button';
  return b;
}
function textInput(placeholder, max) {
  const i = el('input', 'min-height:40px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px;min-width:240px');
  i.type = 'text'; i.placeholder = placeholder; i.maxLength = max;
  return i;
}

// F7 (owner, 24 Nov 2026): the consent fields of one form -- who gave it, the relationship, the witness (required for a relative where the
// server requires it), and the one tick for the three explanations. value() = { consent_by, relationship, witness_name, ...ticks } or an error.
function consentFields(patientName, witnessRequiredForRelative) {
  const by = textInput('Consent given by (name)', 120); by.value = patientName || ''; by.style.minWidth = '200px'; by.setAttribute('aria-label', 'Consent given by');
  const rel = el('select', 'min-height:40px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px');
  rel.setAttribute('aria-label', 'Relationship to the patient');
  [['self', 'Self'], ['parent', 'Parent'], ['spouse', 'Spouse'], ['guardian', 'Guardian'], ['child', 'Child'], ['sibling', 'Sibling'], ['other', 'Other']]
    .forEach(([v, t]) => { const o = el('option', null, t); o.value = v; rel.append(o); });
  const wit = textInput(witnessRequiredForRelative ? 'Witness (required for a relative)' : 'Witness (optional)', 120);
  wit.style.minWidth = '180px'; wit.setAttribute('aria-label', 'Witness');
  const ex = el('label', 'display:inline-flex;align-items:center;gap:6px;font-size:12.5px;min-height:44px');
  const exc = document.createElement('input'); exc.type = 'checkbox'; exc.style.cssText = 'width:20px;height:20px';
  ex.append(exc, document.createTextNode('Risks, alternatives and questions explained'));
  return {
    nodes: [by, rel, wit, ex],
    value() {
      if (!by.value.trim()) return { error: 'Write who gave the consent.' };
      if (witnessRequiredForRelative && rel.value !== 'self' && !wit.value.trim()) return { error: "A relative's consent needs a witness -- write the witness's name." };
      if (!exc.checked) return { error: 'Explain the risks, the alternatives and answer the questions first, then tick the box.' };
      return { consent_by: by.value.trim(), relationship: rel.value, witness_name: wit.value.trim() || null,
               risks_explained: true, alternatives_explained: true, questions_answered: true };
    },
  };
}

/**
 * register: 'anushastra' | 'kshara_sutra' | 'minor_ot' | 'shalakya' | 'psr'
 * onStart(info): the page opens its form for the started sitting -- info = { sitting_id, patient_id, patient_name, uhid, procedure,
 *   fee_id, side, sitting_no, sittings_planned, without_order }
 */
export function mountTodaysSittings({ supabase, container, register, onStart, toast, tenantId }) {
  if (!container) return { reload: () => {} };
  const box = el('div', 'border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:#fff;margin-bottom:12px');
  const head = el('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between');
  head.append(el('div', 'font-weight:600;font-size:14px;color:var(--green-deep)', '📋 Today\'s sittings (from the doctors\' orders)'));
  const date = el('input', 'min-height:40px;padding:4px 8px;border:1px solid var(--border);border-radius:6px');
  date.type = 'date'; date.value = todayIst();
  date.setAttribute('aria-label', 'Date of the sittings');
  head.append(date);
  const list = el('div', 'margin-top:8px');
  const panel = el('div', 'margin-top:8px');
  const emerg = btn('＋ Without an order (department head)', false);
  emerg.style.marginTop = '8px';
  box.append(head, list, panel, emerg);
  container.replaceChildren(box);

  const say = (m, t) => toast?.(m, t);

  async function reload() {
    list.replaceChildren(el('div', 'font-size:12.5px;color:var(--text-muted)', 'Loading the sittings…'));
    panel.replaceChildren();
    const { data, error } = await supabase.rpc('procedure_sittings_list', { p_register: register, p_date: date.value || todayIst() });
    list.replaceChildren();
    if (error) { list.append(el('div', 'font-size:12.5px;color:#8b1a1a', safeErrorMessage(error, 'The sittings could not be loaded.'))); return; }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) { list.append(el('div', 'font-size:12.5px;color:var(--text-muted)', 'No ordered sitting on this day.')); return; }
    rows.forEach(r => list.append(row(r)));
  }

  function row(r) {
    const line = el('div', 'display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:7px 0;border-top:1px solid var(--border);font-size:12.5px');
    // F7 polish (owner, 24 Nov 2026): an entry without a slot shows the time it was done, e.g. "21:58 · no slot"
    line.append(el('span', 'font-weight:600;min-width:46px', r.scheduled_time ? String(r.scheduled_time).slice(0, 5)
      : (r.started_time ? `${r.started_time} · no slot` : 'no slot')));
    line.append(el('span', 'font-weight:600', `${r.patient_name} (${r.uhid})`));
    // owner 24 Nov 2026: a Kshara sutra sitting 2.. is a thread change, not the application (the order carries the application's name)
    const what = register === 'kshara_sutra' && r.sitting_no > 1 ? 'Kshara sutra thread change' : r.procedure_name;
    line.append(el('span', 'color:var(--text-mid)', `${what} · sitting ${r.sitting_no} of ${r.sittings_planned || r.sitting_no}`
      + `${r.place ? ' · ' + r.place : ''}${r.side ? ' · ' + ({ bilateral: 'both sides', right: 'right', left: 'left' }[r.side] || r.side) : ''}`));
    const st = STATUS[r.status] || [r.status, '#eee', '#333'];
    line.append(el('span', `padding:2px 8px;border-radius:10px;background:${st[1]};color:${st[2]};font-weight:600`, st[0]));
    // owner 24 Nov 2026: the consent tag only on a sitting not yet started (held / scheduled); a started / done / missed / cancelled sitting
    // shows none -- except an entry without an order whose consent is to follow (F7) or missing (as the MS list says)
    if (r.consent_to_follow) line.append(el('span', 'padding:2px 8px;border-radius:10px;background:#fbeaea;color:#8b1a1a;font-weight:600', '⚠ Consent to follow'));
    else if (!r.consent_ok && ['held', 'scheduled'].includes(r.status)) line.append(el('span', 'padding:2px 8px;border-radius:10px;background:#fdf3e4;color:#8a5a00', '⚠ Consent not recorded'));
    else if (!r.consent_ok && r.without_order) line.append(el('span', 'padding:2px 8px;border-radius:10px;background:#fbeaea;color:#8b1a1a;font-weight:600', '⚠ Consent missing'));
    if (r.intimate) line.append(el('span', 'padding:2px 8px;border-radius:10px;background:#f6e8f2;color:#8b1a6b', 'Female performer or chaperone'));
    if (r.without_order) line.append(el('span', 'padding:2px 8px;border-radius:10px;background:#fbeaea;color:#8b1a1a', 'Without an order'));
    if (r.performer) line.append(el('span', 'color:var(--text-muted)', `by ${r.performer}`));
    const info = { sitting_id: r.sitting_id, patient_id: r.patient_id, patient_name: r.patient_name, uhid: r.uhid, procedure: r.procedure_name,
                   side: r.side, sitting_no: r.sitting_no, sittings_planned: r.sittings_planned, without_order: r.without_order };
    if (r.status === 'scheduled') {
      const go = btn('▶ Start', true);
      go.addEventListener('click', () => startPanel(r, info));
      const sk = btn('⏭ Skip', false);
      sk.addEventListener('click', () => skipPanel(r));
      const mv = btn('↔ Move', false);
      mv.addEventListener('click', () => movePanel(r));
      line.append(go, sk, mv);
    } else if (r.status === 'in_progress') {
      const rec = btn('✎ Record', true);
      rec.addEventListener('click', () => onStart?.(info));
      line.append(rec);
    } else if (r.status === 'missed') {
      const sk = btn('⏭ Skip with a new date', false);
      sk.addEventListener('click', () => skipPanel(r));
      line.append(sk);
    }
    if (r.consent_to_follow) {   // F7: the emergency entry's consent, recorded later (patient or relative + witness); the server clears the flag
      const rc = btn('Record the consent', false);
      rc.addEventListener('click', () => followConsentPanel(r));
      line.append(rc);
    }
    return line;
  }

  function followConsentPanel(r) {
    panel.replaceChildren();
    const p = el('div', 'border:1px solid #8b1a1a;border-radius:8px;padding:8px 10px;background:#fff7f7;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end');
    p.append(el('div', 'font-size:12.5px;width:100%', `${r.procedure_name} was done in an emergency before consent could be given. Record the consent now (the patient, or a relative with a witness).`));
    const cf = consentFields(r.patient_name, true);
    const save = btn('Record the consent', true); const cancel = btn('Close', false);
    p.append(...cf.nodes, save, cancel);
    cancel.addEventListener('click', () => panel.replaceChildren());
    save.addEventListener('click', async () => {
      const v = cf.value();
      if (v.error) { say(v.error, 'error'); return; }
      save.disabled = true;
      const { error } = await supabase.from('consent_records').insert({ tenant_id: tenantId, patient_id: r.patient_id, treatment_order_id: r.order_id,
        consent_type: register === 'minor_ot' ? 'surgical' : 'invasive_procedure', consent_given: true, procedure_details: r.procedure_name, ...v });
      save.disabled = false;
      if (error) { say(safeErrorMessage(error, 'The consent was not recorded.'), 'error'); return; }
      say('Consent recorded.', 'success');
      await reload();
    });
    panel.append(p);
  }

  async function startPanel(r, info) {
    panel.replaceChildren();
    const p = el('div', 'border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--cream)');
    p.append(el('div', 'font-weight:600;font-size:13px', `Start: ${r.procedure_name} — ${r.patient_name}`));
    // D2-9: the consent is recorded FOR THIS ORDER before the sitting starts (a consultant / PG scholar records it; the server checks at Start)
    if (!r.consent_ok) {
      const cbox = el('div', 'border:1px solid #c9902a;border-radius:6px;padding:6px 8px;margin:6px 0;background:#fdf6e3;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end');
      cbox.append(el('div', 'font-size:12.5px;width:100%', `Consent for ${r.procedure_name} is not recorded yet. Record it here (risks, alternatives and questions explained), then start.`));
      const cf = consentFields(r.patient_name, false);
      const save = btn('Record the consent', false);
      save.addEventListener('click', async () => {
        const v = cf.value();
        if (v.error) { say(v.error, 'error'); return; }
        save.disabled = true;
        const { error } = await supabase.from('consent_records').insert({ tenant_id: tenantId, patient_id: r.patient_id, treatment_order_id: r.order_id,
          consent_type: register === 'minor_ot' ? 'surgical' : 'invasive_procedure', consent_given: true, procedure_details: r.procedure_name, ...v });
        save.disabled = false;
        if (error) { say(safeErrorMessage(error, 'The consent was not recorded.'), 'error'); return; }
        say('Consent recorded.', 'success');
        cbox.replaceChildren(el('div', 'font-size:12.5px;color:var(--green-deep);font-weight:600', '✓ Consent recorded for this order.'));
      });
      cbox.append(...cf.nodes, save);
      p.append(cbox);
    }
    let chap = null;
    if (r.intimate) {
      p.append(el('div', 'font-size:12px;color:var(--text-mid);margin:4px 0',
        'This procedure needs a female performer or a female chaperone. If you are not female, choose the chaperone.'));
      chap = el('select', 'min-height:40px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px');
      chap.setAttribute('aria-label', 'Female chaperone');
      const none = el('option', null, '— no chaperone (I am the female performer)'); none.value = ''; chap.append(none);
      // D2-18: the server's one chaperone rule (active female staff in clinical, nursing or attendant roles) gives the list
      const { data: staff, error: ce } = await supabase.rpc('chaperone_choices');
      if (ce) { say(safeErrorMessage(ce, 'The chaperone list could not be loaded.'), 'error'); }
      (staff || []).forEach(s => { const o = el('option', null, s.full_name); o.value = s.profile_id; chap.append(o); });
      p.append(chap);
    }
    const ok = btn('▶ Start the sitting', true);
    const cancel = btn('Close', false);
    const row2 = el('div', 'display:flex;gap:8px;margin-top:8px'); row2.append(ok, cancel); p.append(row2);
    cancel.addEventListener('click', () => panel.replaceChildren());
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      const { data, error } = await supabase.rpc('start_procedure_sitting', { p_sitting: r.sitting_id, p_assistants: null,
                                                                               p_chaperone: chap && chap.value ? chap.value : null });
      ok.disabled = false;
      if (error) { say(safeErrorMessage(error, 'The sitting could not be started.'), 'error'); return; }
      panel.replaceChildren();
      await reload();
      onStart?.({ ...info, fee_id: data?.fee_id, sitting_no: data?.sitting_no, sittings_planned: data?.sittings_planned });
    });
    panel.append(p);
  }

  function reasonPanel(title, withDate, withTime, onGo) {
    panel.replaceChildren();
    const p = el('div', 'border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--cream);display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end');
    p.append(el('div', 'font-weight:600;font-size:13px;width:100%', title));
    let d = null, t = null;
    if (withDate) { d = el('input', 'min-height:40px;padding:4px 8px;border:1px solid var(--border);border-radius:6px'); d.type = 'date'; d.min = todayIst(); d.setAttribute('aria-label', 'New date'); p.append(d); }
    if (withTime) { t = el('input', 'min-height:40px;padding:4px 8px;border:1px solid var(--border);border-radius:6px'); t.type = 'time'; t.setAttribute('aria-label', 'Time (optional)'); p.append(t); }
    const reason = textInput('Reason (5 to 300 characters)', 300);
    reason.setAttribute('aria-label', 'Reason');
    const ok = btn('Save', true); const cancel = btn('Close', false);
    p.append(reason, ok, cancel);
    cancel.addEventListener('click', () => panel.replaceChildren());
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      const err = await onGo({ date: d?.value || null, time: t?.value || null, reason: reason.value.trim() });
      ok.disabled = false;
      if (err) { say(safeErrorMessage(err, 'Not saved.'), 'error'); return; }
      say('Saved.', 'success');
      await reload();
    });
    panel.append(p);
  }
  const skipPanel = r => reasonPanel(`Skip sitting ${r.sitting_no} of ${r.procedure_name} — a new date is optional`, true, false,
    async v => (await supabase.rpc('skip_procedure_sitting', { p_sitting: r.sitting_id, p_reason: v.reason, p_new_date: v.date })).error);
  const movePanel = r => reasonPanel(`Move sitting ${r.sitting_no} of ${r.procedure_name}`, true, true,
    async v => (await supabase.rpc('move_procedure_sitting', { p_sitting: r.sitting_id, p_date: v.date, p_time: v.time ? v.time + ':00' : null, p_reason: v.reason })).error);

  emerg.addEventListener('click', async () => {
    panel.replaceChildren();
    const p = el('div', 'border:1px solid #8b1a1a;border-radius:8px;padding:8px 10px;background:#fff7f7;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end');
    p.append(el('div', 'font-size:12.5px;width:100%', "Record WITHOUT a doctor's order. Only the department head or the Medical Superintendent may; "
      + 'the reason is kept and the Medical Superintendent sees the entry in the weekly list.'));
    // F10 (owner rehearsal, 25 Nov 2026): in an emergency nobody knows the UHID -- choose from the department's patients today, or search
    // by name, phone or UHID (the server still checks the patient: own organisation, a visit today or an admission)
    const fam = FAMILY_OF[register];
    const todayPick = el('select', 'min-height:40px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px;min-width:260px');
    todayPick.setAttribute('aria-label', "Today's patients of the department");
    const tp0 = el('option', null, `Today's ${DEPT_NAME[fam] || ''} patients (OPD visits today, admitted now)…`); tp0.value = ''; todayPick.append(tp0);
    const q = textInput('Search by name, phone or UHID', 60); q.style.minWidth = '220px'; q.setAttribute('aria-label', 'Search the patient by name, phone or UHID');
    const find = btn('Search', false);
    const results = el('div', 'width:100%;display:flex;flex-wrap:wrap;gap:6px');
    const who = el('span', 'font-size:12.5px;font-weight:600;min-width:160px', '');
    const fee = el('select', 'min-height:40px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px;min-width:220px');
    fee.setAttribute('aria-label', 'Procedure');
    const pick = el('option', null, 'Choose the procedure…'); pick.value = ''; fee.append(pick);
    const { data: fees, error: fe } = await supabase.rpc('register_procedure_fees', { p_register: register });
    if (fe) { say(safeErrorMessage(fe, 'The procedure list could not be loaded.'), 'error'); return; }
    (fees || []).forEach(f => { const o = el('option', null, f.label); o.value = f.fee_id; fee.append(o); });
    const byFee = new Map((fees || []).map(f => [f.fee_id, f]));
    const reason = textInput('Why there is no order (10 to 300 characters)', 300);
    reason.setAttribute('aria-label', 'Reason there is no order');
    // F7 (owner, 24 Nov 2026): a procedure that needs consent -- the consent here (self, or a relative with a witness), or "Emergency — consent
    // to follow" with a reason; an intimate procedure -- a female performer or a female chaperone (no emergency bypass). The server decides.
    const extra = el('div', 'width:100%;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end');
    let cf = null, emg = null, emgWhy = null, chap = null;
    fee.addEventListener('change', async () => {
      extra.replaceChildren(); cf = null; emg = null; emgWhy = null; chap = null;
      const f = byFee.get(fee.value);
      if (!f) return;
      if (f.consent_required) {
        extra.append(el('div', 'font-size:12.5px;width:100%', `${f.label} needs the patient's consent. Record it here, or tick "Emergency — consent to follow".`));
        cf = consentFields(who.dataset.name || '', true);
        extra.append(...cf.nodes);
        const el2 = el('label', 'display:inline-flex;align-items:center;gap:6px;font-size:12.5px;min-height:44px;width:100%');
        emg = document.createElement('input'); emg.type = 'checkbox'; emg.style.cssText = 'width:20px;height:20px';
        el2.append(emg, document.createTextNode('Emergency — consent to follow (neither the patient nor a relative can consent now)'));
        emgWhy = textInput('Why consent will follow (10 to 300 characters)', 300); emgWhy.setAttribute('aria-label', 'Why consent will follow');
        emgWhy.hidden = true;
        emg.addEventListener('change', () => { emgWhy.hidden = !emg.checked; });
        extra.append(el2, emgWhy);
      }
      if (f.intimate) {
        extra.append(el('div', 'font-size:12px;color:var(--text-mid);width:100%',
          'This procedure needs a female performer or a female chaperone. If you are not female, choose the chaperone.'));
        chap = el('select', 'min-height:40px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px');
        chap.setAttribute('aria-label', 'Female chaperone');
        const none = el('option', null, '— no chaperone (I am the female performer)'); none.value = ''; chap.append(none);
        const { data: staff, error: ce } = await supabase.rpc('chaperone_choices');   // D2-18: the one chaperone rule
        if (ce) { say(safeErrorMessage(ce, 'The chaperone list could not be loaded.'), 'error'); }
        (staff || []).forEach(s => { const o = el('option', null, s.full_name); o.value = s.profile_id; chap.append(o); });
        extra.append(chap);
      }
    });
    const ok = btn('Open the entry', true); const cancel = btn('Close', false);
    const orWord = el('span', 'font-size:12.5px;color:var(--text-mid)', 'or');
    p.append(todayPick, orWord, q, find, results, who, fee, reason, extra, ok, cancel);
    let patient = null;
    const choose = pt => {
      patient = pt; results.replaceChildren();
      who.textContent = pt ? `Patient: ${patientLabel(pt)}` : ''; who.dataset.name = pt ? pt.name : '';
    };
    // the department's patients today: OPD visits of today (not cancelled / deleted) and current admissions -- each patient once
    const codes = FAMILY_CODES[fam] || [];
    const pickMap = new Map();
    if (codes.length) {
      const startUtc = new Date(`${todayIst()}T00:00:00+05:30`).toISOString();
      const [{ data: vis, error: ve }, { data: adm, error: ae }] = await Promise.all([
        supabase.from('visits').select('created_at, status, patients(id, name, uhid, phone), opds!inner(ncism_code)')
          .in('opds.ncism_code', codes).gte('created_at', startUtc).not('is_deleted', 'is', true).is('deleted_at', null).neq('status', 'cancelled')   // the server's visit rule
          .order('created_at', { ascending: false }).limit(100),
        supabase.from('ipd_admissions').select('patients(id, name, uhid, phone), departments!inner(ncism_code)')
          .in('departments.ncism_code', codes).eq('status', 'admitted').limit(100)]);
      if (ve || ae) say(safeErrorMessage(ve || ae, "Today's patients could not be loaded -- search instead."), 'error');
      (adm || []).forEach(a => { if (a.patients?.id) pickMap.set(a.patients.id, { pt: a.patients, how: 'admitted' }); });
      (vis || []).forEach(v => { if (v.patients?.id && !pickMap.has(v.patients.id)) pickMap.set(v.patients.id, { pt: v.patients, how: 'OPD today' }); });
      [...pickMap.values()].sort((a, b) => String(a.pt.name).localeCompare(String(b.pt.name))).forEach(x => {
        const o = el('option', null, `${patientLabel(x.pt)} — ${x.how}`); o.value = x.pt.id; todayPick.append(o);
      });
      if (!pickMap.size) tp0.textContent = `No ${DEPT_NAME[fam] || ''} patients today -- search instead`;
    }
    todayPick.addEventListener('change', () => { q.value = ''; choose(todayPick.value ? pickMap.get(todayPick.value).pt : null); });
    const search = async () => {
      todayPick.value = ''; choose(null);
      const w = searchWord(q.value);
      if (!w) { who.textContent = 'Type at least 2 letters or digits of the name, phone or UHID.'; return; }
      const { data, error } = await supabase.from('patients').select('id, name, uhid, phone, gender, age')
        .or(`name.ilike.*${w}*,phone.ilike.*${w}*,uhid.ilike.*${w}*`).order('name').limit(10);
      if (error) { say(safeErrorMessage(error, 'The patient could not be found.'), 'error'); return; }
      if (!data?.length) { who.textContent = 'No patient found -- check the spelling, or search by phone or UHID.'; return; }
      if (data.length === 10) results.append(el('div', 'font-size:12px;color:var(--text-mid);width:100%', 'The first 10 matches -- type more to narrow it down.'));
      data.forEach(pt => {
        const extraBits = [pt.gender, pt.age ? pt.age + ' y' : ''].filter(Boolean).join(' ');
        const b = btn(`${patientLabel(pt)}${extraBits ? ' · ' + extraBits : ''}`, false);
        b.addEventListener('click', () => choose(pt));
        results.append(b);
      });
    };
    find.addEventListener('click', search);
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    cancel.addEventListener('click', () => panel.replaceChildren());
    ok.addEventListener('click', async () => {
      if (!patient) { say("Choose the patient: from today's list, or search by name, phone or UHID.", 'error'); return; }
      if (!fee.value) { say('Choose the procedure from the list.', 'error'); return; }
      let consent = null, emergency = null;
      if (cf) {
        if (emg && emg.checked) emergency = emgWhy.value.trim();
        else { const v = cf.value(); if (v.error) { say(v.error, 'error'); return; } consent = v; }
      }
      ok.disabled = true;
      const { data, error } = await supabase.rpc('open_procedure_without_order', { p_kind: KIND_OF[register], p_patient: patient.id,
        p_fee: fee.value, p_reason: reason.value.trim(), p_consent: consent, p_emergency_reason: emergency,
        p_chaperone: chap && chap.value ? chap.value : null });
      ok.disabled = false;
      if (error) { say(safeErrorMessage(error, 'The entry could not be opened.'), 'error'); return; }
      panel.replaceChildren();
      await reload();
      onStart?.({ sitting_id: data.sitting_id, patient_id: patient.id, patient_name: patient.name, uhid: patient.uhid, procedure: data.procedure,
                  fee_id: data.fee_id, sitting_no: 1, sittings_planned: 1, without_order: true });
    });
    panel.append(p);
  });

  date.addEventListener('change', reload);
  reload();
  return { reload };
}
