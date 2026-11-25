// Session 391 T1a-2 (owner D4 / D2-4 / D2-13, 23 Nov 2026) -- a department's procedure slots and places, set by its head (Rule D), the
// Medical Superintendent or the Super Admin. Slots: the weekdays, the hours, one slot's length and where the sittings are done, from a
// date (never back-dated, a reason, audited; a change is a new row). Places: the department's procedure bays / chairs / tables -- one
// place = one sitting at a time. The server decides who may (set_dept_procedure_slots / set_dept_procedure_place). DOM nodes only.
import { safeErrorMessage } from '../../utils/errors.js';

const el = (tag, style, text) => {
  const n = document.createElement(tag);
  if (style) n.style.cssText = style;
  if (text != null) n.textContent = text;
  return n;
};
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const KINDS = [['bay', 'Procedure bay'], ['chair', 'Procedure chair'], ['ot_table', 'Procedure table']];
const FAMILY_CODES = ['SHAL', 'SHALYA_TANTRA', 'SHAK', 'SHALAKYA_TANTRA', 'SHNT', 'PST', 'STRI_ROGA_PRASUTI'];
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const inputCss = 'min-height:40px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px';

function btn(text, primary) {
  const b = el('button', `min-height:44px;padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--green-deep);`
    + (primary ? 'background:var(--green-deep);color:#fff' : 'background:#fff;color:var(--green-deep)'), text);
  b.type = 'button';
  return b;
}
function labelled(text, node) {
  const w = el('label', 'display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--text-mid)');
  w.append(el('span', null, text), node);
  return w;
}

export async function mountDeptProcedureSlots({ supabase, container, deptId, toast }) {
  if (!container || !deptId) return;
  const { data: dept } = await supabase.from('departments').select('id, name, ncism_code').eq('id', deptId).maybeSingle();
  if (!dept || !FAMILY_CODES.includes(dept.ncism_code)) { container.replaceChildren(); return; }   // only the procedure departments

  const card = el('div', 'background:#fff;border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:16px');
  card.append(el('div', 'font-weight:600;font-size:15px;color:var(--green-deep)', '🩹 Procedure slots and places'));
  card.append(el('div', 'font-size:12.5px;color:var(--text-muted);margin:2px 0 10px',
    'The doctors’ procedure orders are booked into these slots. One place = one sitting at a time. A change starts on a date you choose (never back-dated) and is kept with its reason.'));
  const current = el('div', 'font-size:13px;margin-bottom:10px');
  card.append(current);

  // the new setting
  const days = el('div', 'display:flex;flex-wrap:wrap;gap:6px');
  const dayBoxes = DAYS.map(([n, t]) => {
    const w = el('label', 'display:inline-flex;align-items:center;gap:4px;min-height:44px;padding:0 8px;border:1px solid var(--border);border-radius:6px;font-size:13px');
    const c = document.createElement('input'); c.type = 'checkbox'; c.value = String(n); c.checked = n <= 6;
    w.append(c, document.createTextNode(t)); days.append(w);
    return c;
  });
  const start = el('input', inputCss); start.type = 'time'; start.value = '09:00';
  const end = el('input', inputCss); end.type = 'time'; end.value = '13:00';
  const slot = el('input', inputCss); slot.type = 'number'; slot.min = '10'; slot.max = '240'; slot.value = '30';
  const kind = el('select', inputCss);
  KINDS.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; kind.append(o); });
  const from = el('input', inputCss); from.type = 'date'; from.min = todayIst(); from.value = todayIst();
  const reason = el('input', inputCss + ';min-width:260px'); reason.type = 'text'; reason.maxLength = 300; reason.placeholder = 'Reason (5 to 300 characters)';
  const save = btn('Save the slots', true);
  const row = el('div', 'display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end');
  row.append(labelled('From (start)', start), labelled('To (end)', end), labelled('One slot (minutes)', slot), labelled('Done at', kind),
             labelled('From date', from), labelled('Reason', reason), save);
  card.append(labelled('Days', days), el('div', 'height:8px'), row);

  // the places
  card.append(el('div', 'font-weight:600;font-size:13.5px;margin-top:14px', 'Places'));
  const places = el('div', 'margin-top:6px');
  const pName = el('input', inputCss); pName.type = 'text'; pName.maxLength = 40; pName.placeholder = 'e.g. Procedure bay 1';
  const pKind = el('select', inputCss);
  KINDS.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; pKind.append(o); });
  const pReason = el('input', inputCss + ';min-width:220px'); pReason.type = 'text'; pReason.maxLength = 300; pReason.placeholder = 'Reason (5 to 300 characters)';
  const pAdd = btn('➕ Add place', false);
  const prow = el('div', 'display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:8px');
  prow.append(labelled('Name', pName), labelled('Kind', pKind), labelled('Reason', pReason), pAdd);
  card.append(places, prow);
  container.replaceChildren(card);

  async function load() {
    const { data: rows } = await supabase.from('dept_procedure_slots').select('weekdays, start_time, end_time, slot_minutes, place_kind, effective_from, reason')
      .eq('department_id', deptId).order('effective_from', { ascending: false }).order('set_at', { ascending: false }).limit(5);
    current.replaceChildren();
    const today = todayIst();
    const now = (rows || []).find(r => r.effective_from <= today);
    const next = (rows || []).find(r => r.effective_from > today);
    const fmt = r => !r.weekdays?.length ? 'no slots'
      : `${DAYS.filter(([n]) => r.weekdays.includes(n)).map(([, t]) => t).join(', ')} · ${String(r.start_time).slice(0, 5)}–${String(r.end_time).slice(0, 5)}`
        + ` · ${r.slot_minutes} min · ${(KINDS.find(k => k[0] === r.place_kind) || [, r.place_kind])[1]}`;
    current.append(el('div', null, now ? `Now: ${fmt(now)} (from ${now.effective_from})` : 'Now: no procedure slots set — orders get no slot.'));
    if (next) current.append(el('div', 'color:var(--text-mid)', `From ${next.effective_from}: ${fmt(next)}`));
    const { data: pl } = await supabase.from('sched_places').select('id, name, kind, status').eq('department_id', deptId).neq('kind', 'couch').order('name');
    places.replaceChildren();
    if (!pl?.length) { places.append(el('div', 'font-size:12.5px;color:var(--text-muted)', 'No place yet — add at least one.')); return; }
    pl.forEach(p => {
      const line = el('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:13px');
      line.append(el('span', 'font-weight:600;min-width:140px', p.name), el('span', 'color:var(--text-mid)', (KINDS.find(k => k[0] === p.kind) || [, p.kind])[1]));
      const st = el('select', inputCss);
      st.setAttribute('aria-label', `Status of ${p.name}`);
      [['active', 'Active'], ['maintenance', 'Under maintenance'], ['inactive', 'Inactive']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; st.append(o); });
      st.value = p.status;
      const r = el('input', inputCss); r.type = 'text'; r.maxLength = 300; r.placeholder = 'Reason for the change'; r.setAttribute('aria-label', `Reason for ${p.name}`);
      const ok = btn('Save', false);
      ok.addEventListener('click', async () => {
        const { error } = await supabase.rpc('set_dept_procedure_place', { p_place: p.id, p_dept: deptId, p_kind: p.kind, p_name: p.name, p_status: st.value, p_reason: r.value.trim() });
        if (error) { toast?.(safeErrorMessage(error, 'Not saved.'), true); return; }
        toast?.('Place saved.'); load();
      });
      line.append(st, r, ok);
      places.append(line);
    });
  }

  save.addEventListener('click', async () => {
    save.disabled = true;
    const { error } = await supabase.rpc('set_dept_procedure_slots', { p_dept: deptId, p_weekdays: dayBoxes.filter(c => c.checked).map(c => Number(c.value)),
      p_start: start.value ? start.value + ':00' : null, p_end: end.value ? end.value + ':00' : null, p_slot_minutes: Number(slot.value) || null,
      p_place_kind: kind.value, p_from: from.value || null, p_reason: reason.value.trim() });
    save.disabled = false;
    if (error) { toast?.(safeErrorMessage(error, 'The slots were not saved.'), true); return; }
    toast?.('Procedure slots saved.'); reason.value = ''; load();
  });
  pAdd.addEventListener('click', async () => {
    pAdd.disabled = true;
    const { error } = await supabase.rpc('set_dept_procedure_place', { p_place: null, p_dept: deptId, p_kind: pKind.value, p_name: pName.value.trim(),
      p_status: 'active', p_reason: pReason.value.trim() });
    pAdd.disabled = false;
    if (error) { toast?.(safeErrorMessage(error, 'The place was not added.'), true); return; }
    toast?.('Place added.'); pName.value = ''; pReason.value = ''; load();
  });

  load();
}
