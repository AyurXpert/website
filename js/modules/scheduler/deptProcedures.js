// Session 391 T1a-2 -- the planning doctor's "Department procedures" planner (Shalya: Anushastra, Kshara sutra, Minor OT; Shalakya;
// Prasuti / Stri Roga). Only the procedures of THIS visit's OPD department are offered (dept_procedure_choices: the server's scope rule).
// The doctor adds items, checks the free slots (dept_procedure_capacity: counts only) and orders them (create_treatment_orders): the server
// holds a slot per sitting, or names why none was free. An intern / PG scholar only drafts (D9): the items travel in the consultation
// draft and the consultant orders them. DOM nodes + textContent only (no HTML strings); handlers on the nodes built here.
import { safeErrorMessage } from '../../utils/errors.js';

const el = (tag, style, text) => {
  const n = document.createElement(tag);
  if (style) n.style.cssText = style;
  if (text != null) n.textContent = text;
  return n;
};
const KIND = { anushastra: 'Anushastra', kshara_sutra: 'Kshara sutra', minor_procedure: 'Minor OT', department_procedure: 'Department procedure' };
const BASIS = [['opd', 'OPD'], ['day_care', 'Day Care'], ['admission', 'Admission']];
const SIDE = [['', '— (no side)'], ['bilateral', 'Both sides'], ['right', 'Right'], ['left', 'Left']];
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function field(label, input) {
  const w = el('label', 'display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--text-mid);min-width:110px');
  w.append(el('span', null, label), input);
  return w;
}
function select(options, value) {
  const s = el('select', 'min-height:36px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px');
  options.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; s.append(o); });
  if (value != null) s.value = value;
  return s;
}
function input(type, value, attrs = {}) {
  const i = el('input', 'min-height:36px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px');
  i.type = type;
  if (value != null) i.value = value;
  Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
  return i;
}
function button(text, primary) {
  const b = el('button', `min-height:44px;padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--green-deep);`
    + (primary ? 'background:var(--green-deep);color:#fff' : 'background:#fff;color:var(--green-deep)'), text);
  b.type = 'button';
  return b;
}

/**
 * Mounts the planner. Returns { items(), setItems(list), pending() } -- doctor.js puts items() into the trainee's draft and refuses
 * Complete while pending() > 0 (a planned procedure is never silently dropped).
 */
export async function mountDeptProcedurePlanner({ supabase, container, visitId, isTrainee, toast, onOrdered }) {
  let items = [];
  let redraw = () => {};   // assigned once the form exists (an early setItems() must not touch nodes not built yet)
  const api = { items: () => items.map(x => ({ ...x })), setItems: list => { items = Array.isArray(list) ? list.map(x => ({ ...x })) : []; redraw(); },
                pending: () => items.length };
  if (!container || !visitId) return api;
  container.replaceChildren();
  container.hidden = true;
  const { data, error } = await supabase.rpc('dept_procedure_choices', { p_visit: visitId });
  if (error) {
    container.hidden = false;
    container.append(el('div', 'font-size:12.5px;color:#8b1a1a', `⚠ The department procedures could not be loaded — ${safeErrorMessage(error, 'error')}.`));
    return api;
  }
  const choices = Array.isArray(data) ? data : [];
  if (!choices.length) return api;   // this visit's OPD orders no department procedure -- nothing to show
  container.hidden = false;

  const box = el('div', 'border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:#fff;margin-top:10px');
  box.append(el('div', 'font-weight:600;font-size:13.5px;color:var(--green-deep);margin-bottom:4px', '🗓 Department procedures (booked sittings)'));
  box.append(el('div', 'font-size:12px;color:var(--text-muted);margin-bottom:8px',
    isTrainee ? 'Add the procedures you plan. They go with your draft — the consultant checks them and orders them.'
              : 'Procedures the department does in booked sittings (with a slot, the consent and its register): add them, check the free slots, then order them. The patient is booked when the consultation is completed (Admission: at the admission).'));

  const keyOf = c => `${c.fee_id}|${c.kind}`;
  const proc = select([['', 'Choose a procedure…'], ...choices.map(c => [keyOf(c), `${c.label} — ${KIND[c.kind] || c.kind} (${c.group_name})`])], '');
  proc.style.minWidth = '260px';
  const sittings = input('number', 1, { min: 1, max: 60 });
  const every = input('number', 7, { min: 1, max: 60 });
  const first = input('date', todayIst(), { min: todayIst() });
  const basis = select(BASIS, 'opd');
  const side = select(SIDE, '');
  const detail = input('text', '', { maxlength: 200, placeholder: 'Site / details (optional)' });
  detail.style.minWidth = '200px';
  proc.addEventListener('change', () => {
    const c = choices.find(x => keyOf(x) === proc.value);
    if (!c) return;
    sittings.value = c.default_sittings || (c.kind === 'kshara_sutra' ? 4 : 1);
    every.value = c.default_interval_days || 7;
  });
  const form = el('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end');
  form.append(field('Procedure', proc), field('Sittings', sittings), field('Every (days)', every), field('First sitting', first),
              field('Basis', basis), field('Side', side), field('Details', detail));
  const add = button('➕ Add', false);
  form.append(add);
  box.append(form);

  const list = el('div', 'margin-top:8px');
  const cap = el('div', 'margin-top:6px');
  const result = el('div', 'margin-top:6px');
  const actions = el('div', 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px');
  const check = button('📅 Check free slots', false);
  const order = button('Order these procedures', true);
  actions.append(check);
  if (!isTrainee) actions.append(order);
  box.append(list, actions, cap, result);
  container.append(box);

  function draw() {
    list.replaceChildren();
    if (!items.length) { list.append(el('div', 'font-size:12.5px;color:var(--text-muted)', 'No department procedure added.')); order.disabled = true; return; }
    order.disabled = false;
    items.forEach((it, i) => {
      const c = choices.find(x => x.fee_id === it.fee_id && x.kind === it.kind);
      const row = el('div', 'display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:12.5px');
      row.append(el('span', 'font-weight:600', c ? c.label : 'Procedure no longer offered'));
      row.append(el('span', 'color:var(--text-mid)',
        `${KIND[it.kind] || it.kind} · ${it.sittings} sitting(s)${it.sittings > 1 ? `, every ${it.interval_days} days` : ''} · from ${it.first_date}`
        + ` · ${(BASIS.find(b => b[0] === it.basis) || [, it.basis])[1]}${it.side ? ' · ' + (SIDE.find(s => s[0] === it.side) || [, it.side])[1] : ''}`));
      if (c && c.consent_required) row.append(el('span', 'padding:2px 8px;border-radius:10px;background:#fdf3e4;color:#8a5a00', 'Consent needed before the sitting'));
      if (c && c.intimate) row.append(el('span', 'padding:2px 8px;border-radius:10px;background:#f6e8f2;color:#8b1a6b', 'Female performer or chaperone'));
      if (it.detail) row.append(el('span', 'color:var(--text-muted)', it.detail));
      const rm = button('✕ Remove', false);
      rm.style.minHeight = '36px';
      rm.addEventListener('click', () => { items.splice(i, 1); draw(); });
      row.append(rm);
      list.append(row);
    });
  }

  add.addEventListener('click', () => {
    const c = choices.find(x => keyOf(x) === proc.value);
    if (!c) { toast?.('Choose a procedure from the list.', 'error'); return; }
    if (items.some(x => x.fee_id === c.fee_id)) { toast?.(`${c.label} is already in the list.`, 'error'); return; }
    items.push({ fee_id: c.fee_id, kind: c.kind, sittings: Number(sittings.value) || 1, interval_days: Number(every.value) || 7,
                 first_date: first.value || todayIst(), basis: basis.value, side: side.value || null, detail: detail.value.trim() || null });
    proc.value = ''; detail.value = '';
    result.replaceChildren();
    draw();
  });

  check.addEventListener('click', async () => {
    cap.replaceChildren(el('div', 'font-size:12.5px;color:var(--text-muted)', 'Checking the free slots…'));
    const { data: days, error: e } = await supabase.rpc('dept_procedure_capacity', { p_visit: visitId, p_from: first.value || todayIst(), p_days: 14 });
    cap.replaceChildren();
    if (e) { cap.append(el('div', 'font-size:12.5px;color:#8b1a1a', safeErrorMessage(e, 'The free slots could not be checked.'))); return; }
    const grid = el('div', 'display:flex;flex-wrap:wrap;gap:4px');
    (days || []).forEach(d => {
      const free = Number(d.free_slots) || 0;
      const cell = el('div', `padding:4px 8px;border-radius:6px;font-size:12px;border:1px solid var(--border);background:${free ? 'var(--green-light)' : '#f4f4f4'}`,
        `${String(d.on_date).slice(5)}: ${free ? free + ' free' : (d.why || 'none free')}`);
      grid.append(cell);
    });
    cap.append(el('div', 'font-size:12px;color:var(--text-mid);margin-bottom:4px', 'Free slots in the department (next 14 days):'), grid);
  });

  order.addEventListener('click', async () => {
    if (!items.length) return;
    order.disabled = true;
    order.textContent = 'Ordering…';
    const { data: res, error: e } = await supabase.rpc('create_treatment_orders', { p_visit: visitId, p_items: items });
    order.textContent = 'Order these procedures';
    if (e) {
      order.disabled = false;
      toast?.(safeErrorMessage(e, 'The procedures could not be ordered.') + ' Nothing was ordered.', 'error');
      return;
    }
    items = [];
    draw();
    result.replaceChildren();
    (res?.orders || []).forEach(o => {
      const r = el('div', 'font-size:12.5px;padding:4px 0;border-top:1px solid var(--border)');
      r.append(el('div', 'font-weight:600', `✓ ${o.procedure}`));
      (o.sittings || []).forEach(s => r.append(el('div', 'color:var(--text-mid)',
        s.time ? `Sitting ${s.sitting}: ${s.date} ${s.time}${s.place ? ' · ' + s.place : ''} (held)`
               : `Sitting ${s.sitting}: ${s.date} — no slot (${s.why || 'none free'}); the department head places it`)));
      result.append(r);
    });
    toast?.('Ordered. The slots are held until the consultation is completed.', 'success');
    onOrdered?.();
  });

  redraw = draw;
  draw();
  return api;
}
