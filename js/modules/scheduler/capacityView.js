// Session 388s1 (S1) -- the PK in-charge's side on therapist.html (owner decisions 4, 8, 9; S8, S9, S11):
//   renderCapacityView   tomorrow and the week per therapist (shift, booked / free minutes) and per room / couch; the unassigned list with
//                        Move (sched_move_session: free-checked by the server, a reason, the doctor told); the overflow days
//   renderScheduleSettings working day, step, the three phase windows, shifts, move policy, OPD hold hours (set_pk_schedule_settings, a reason)
//   renderCouches        couches per room (male-only / female-only rooms, S8) and the Kaumara (pediatric) room tick
// DOM nodes + textContent only. Every rule is the server's; the page shows its answer (safeErrorMessage).
import { safeErrorMessage } from '../../utils/errors.js';

const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') n.style.cssText = v; else if (k.startsWith('data-') || k.startsWith('aria-')) n.setAttribute(k, v); else n[k] = v;
  }
  if (text != null) n.textContent = text;
  return n;
};
const fmtDate = (iso) => new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
const btnCss = "min-height:36px;padding:0 12px;border-radius:7px;border:1.5px solid var(--green-deep);background:#fff;color:var(--green-deep);font-family:'DM Sans',sans-serif;font-size:12.5px;font-weight:600;cursor:pointer";
const say = (box, ok, text) => { box.style.color = ok ? 'var(--green-deep)' : '#8b1a1a'; box.textContent = text; };

export async function renderCapacityView({ supabase, container }) {
  container.replaceChildren(el('div', { style: 'font-size:12.5px;color:var(--text-muted)' }, 'Loading capacity…'));
  const { data, error } = await supabase.rpc('pk_capacity_view', { p_from: null, p_days: 8 });
  container.replaceChildren();
  if (error) { container.append(el('div', { role: 'alert', style: 'color:#8b1a1a;font-size:12.5px' }, safeErrorMessage(error, 'Could not read the capacity.'))); return; }

  // unassigned first: this is what needs the in-charge
  const un = data?.unassigned || [];
  container.append(el('h4', { style: "font-family:'Cormorant Garamond',serif;font-size:17px;color:var(--green-deep);margin:4px 0" },
    `⚠ Not scheduled (${un.length})`));
  if (!un.length) container.append(el('div', { style: 'font-size:12.5px;color:var(--text-muted)' }, 'Every session up to the end of the week has a time, a therapist and a room.'));
  const unList = el('div', { className: 'sched-zebra-list' });   // owner, 21 Nov 2026: alternate row colours + the row under the mouse
  container.append(unList);
  for (const u of un) {
    const row = el('div', { className: 'sched-zebra-row', style: 'border:1px solid var(--border);border-radius:7px;padding:8px 10px;margin:4px 0;font-size:12.5px' });
    row.append(el('div', { style: 'font-weight:600' }, `${fmtDate(u.date)} · ${u.activity} · ${u.patient || '—'}`),
               el('div', { style: 'color:var(--text-mid)' }, u.reason || 'no free slot'));
    const form = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px' });
    const d = el('input', { type: 'date', value: String(u.date).slice(0, 10), 'aria-label': 'New date' });
    const t = el('input', { type: 'time', value: '09:00', 'aria-label': 'New time' });
    const thSel = el('select', { 'aria-label': 'Therapist' }); thSel.append(el('option', { value: '' }, 'Therapist…'));
    const seen = new Set();
    // S1-F23: only therapists / rooms that match the patient's gender (the server refuses any other)
    const pg = u.patient_gender || null;
    const roomOk = (g) => !pg || g === 'any' || (pg === 'M' && g === 'male') || (pg === 'F' && g === 'female');
    for (const x of (data?.therapists || [])) { if (seen.has(x.profile_id) || (pg && x.gender && x.gender !== pg)) continue; seen.add(x.profile_id); thSel.append(el('option', { value: x.profile_id }, `${x.name} (${x.gender || '?'})`)); }
    const plSel = el('select', { 'aria-label': 'Room / Droni' }); plSel.append(el('option', { value: '' }, 'Room / Droni…'));
    const seenP = new Set();
    // S1-F34 (page-only, owner 22 Nov 2026): the Kaumara (children's) room is labelled and listed last (the server rule = TODO §694)
    const places = [...(data?.places || [])].sort((a, b) => Number(!!a.kaumara) - Number(!!b.kaumara));
    for (const p of places) { if (seenP.has(p.place_id) || !roomOk(p.gender)) continue; seenP.add(p.place_id);
      plSel.append(el('option', { value: p.place_id }, `${p.couch ? `${p.room} · ${p.couch}` : p.room}${p.kaumara ? " — ⚠ Children's room — use only if no adult room is free" : ''}`)); }
    const reason = el('input', { type: 'text', placeholder: 'Reason (5–300 characters)', maxLength: 300, 'aria-label': 'Reason', style: 'min-width:180px' });
    const go = el('button', { type: 'button', style: btnCss }, 'Move here');
    const msg = el('div', { role: 'status', style: 'font-size:12px;width:100%' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      const { error: e } = await supabase.rpc('sched_move_session', { p_session: u.session_id, p_date: d.value, p_time: t.value,
        p_therapists: thSel.value ? [thSel.value] : null, p_place: plSel.value || null, p_reason: reason.value });
      go.disabled = false;
      if (e) { say(msg, false, '⚠ ' + safeErrorMessage(e, 'Not moved.')); return; }
      say(msg, true, '✓ Moved — the planning doctor has been told.');
      setTimeout(() => renderCapacityView({ supabase, container }), 800);
    });
    form.append(d, t, thSel, plSel, reason, go, msg);
    row.append(form);
    unList.append(row);
  }

  const over = data?.overflow || [];
  if (over.length) container.append(el('div', { style: 'font-size:12.5px;margin:6px 0;color:#8a5a00' },
    'Overflow days: ' + over.map(o => `${fmtDate(o.date)} (${o.unassigned})`).join(', ')));

  // therapists per day
  container.append(el('h4', { style: "font-family:'Cormorant Garamond',serif;font-size:17px;color:var(--green-deep);margin:12px 0 4px" }, 'Therapists — tomorrow and the week'));
  const tT = el('table', { className: 'sched-zebra', style: 'width:100%;border-collapse:collapse;font-size:12px' });
  const hd = el('tr'); ['Date', 'Therapist', 'Shift', 'Booked', 'Held', 'Free'].forEach(h => hd.append(el('th', { style: 'text-align:left;border-bottom:1px solid var(--border);padding:3px 6px' }, h)));
  tT.append(hd);
  for (const x of (data?.therapists || [])) {
    const tr = el('tr');
    // S1-F9: held (not yet activated) minutes are taken too
    const free = Math.max(0, (x.shift_minutes || 0) - (x.booked_minutes || 0) - (x.held_minutes || 0));
    [fmtDate(x.date), `${x.name} (${x.gender || '?'})`, x.shift, `${x.booked_minutes} min`, `${x.held_minutes || 0} min`, `${free} min`].forEach(v => tr.append(el('td', { style: 'padding:3px 6px;border-bottom:1px solid #f0ece2' }, v)));
    tT.append(tr);
  }
  if (!(data?.therapists || []).length) container.append(el('div', { style: 'font-size:12.5px;color:#8a5a00' }, 'No therapist on the duty roster for these days — publish the roster first.'));
  else container.append(tT);

  // rooms / couches per day
  container.append(el('h4', { style: "font-family:'Cormorant Garamond',serif;font-size:17px;color:var(--green-deep);margin:12px 0 4px" }, 'Rooms and Dronis'));
  const tP = el('table', { className: 'sched-zebra', style: 'width:100%;border-collapse:collapse;font-size:12px' });
  const hp = el('tr'); ['Date', 'Room / Droni', 'For', 'Booked', 'Held'].forEach(h => hp.append(el('th', { style: 'text-align:left;border-bottom:1px solid var(--border);padding:3px 6px' }, h)));
  tP.append(hp);
  for (const p of (data?.places || [])) {
    const tr = el('tr');
    [fmtDate(p.date), p.couch ? `${p.room} · ${p.couch}` : p.room, `${p.gender}${p.kaumara ? ' · Kaumara' : ''}`, `${p.booked_minutes} min`, `${p.held_minutes || 0} min`]
      .forEach(v => tr.append(el('td', { style: 'padding:3px 6px;border-bottom:1px solid #f0ece2' }, v)));
    tP.append(tr);
  }
  container.append(tP);
}

// S1-F11 (owner, 21 Nov 2026): shift times are shown here read-only -- they change only through PK Roster -> Shift Times (MS / Deputy MS
// approval, Session 216); the shift length is the fixed value it was before S1
const SHIFT_FIELDS = [['shift1_start', 'Shift 1 starts', 'time'], ['shift2_start', 'Shift 2 starts', 'time'], ['shift_duration_hours', 'Shift length (hours)', 'number']];
const SETTING_FIELDS = [
  ['day_start', 'Working day starts', 'time'], ['day_end', 'Working day ends', 'time'], ['slot_step_minutes', 'Slot step (minutes: 5, 10, 15, 30)', 'number'],
  ['purvakarma_from', 'Purvakarma window from', 'time'], ['purvakarma_to', 'Purvakarma window to', 'time'],
  ['pradhanakarma_from', 'Pradhana karma window from', 'time'], ['pradhanakarma_to', 'Pradhana karma window to', 'time'],
  ['paschatkarma_from', 'Paschat karma window from', 'time'], ['paschatkarma_to', 'Paschat karma window to', 'time'],
  ['hold_hours_opd', 'OPD / Day Care hold (hours, 2–72)', 'number']];

export async function renderScheduleSettings({ supabase, container, tenantId }) {
  container.replaceChildren();
  const { data: row } = await supabase.from('pk_roster_settings').select('*').eq('tenant_id', tenantId).maybeSingle();
  const r = row || {};
  const shifts = el('div', { style: 'border:1px solid var(--border);border-radius:7px;padding:8px 10px;margin-bottom:10px;font-size:12.5px;background:var(--cream)' });
  shifts.append(el('div', { style: 'font-weight:600;margin-bottom:4px' }, 'Shift times (read-only here)'));
  const sg = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px' });
  for (const [k, label, type] of SHIFT_FIELDS) {
    const f = el('label', { style: 'display:flex;flex-direction:column;font-size:12px;gap:3px' });
    f.append(el('span', {}, label), el('input', { type, value: r[k] != null ? String(r[k]).slice(0, type === 'time' ? 5 : 10) : '', disabled: true, 'aria-readonly': 'true' }));
    sg.append(f);
  }
  shifts.append(sg, el('div', { style: 'margin-top:6px;color:var(--text-mid)' },
    'To change the shift times: 🗓️ Therapist Duty Roster → ⏰ Shift Times → Request Change. The Medical Superintendent / Deputy MS approves it. Then run the shift-time setup check (pilot checklist item 8).'));
  container.append(shifts);
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px' });
  const inputs = {};
  for (const [k, label, type] of SETTING_FIELDS) {
    const f = el('label', { style: 'display:flex;flex-direction:column;font-size:12px;gap:3px' });
    const i = el('input', { type, value: r[k] != null ? String(r[k]).slice(0, type === 'time' ? 5 : 10) : '' });
    inputs[k] = i; f.append(el('span', {}, label), i); grid.append(f);
  }
  const mp = el('label', { style: 'display:flex;flex-direction:column;font-size:12px;gap:3px' });
  const mpSel = el('select');
  [['shift_course', 'Shift the rest of the course by the same days (order kept)'], ['alert_only', 'Leave it unscheduled and alert the PK in-charge']]
    .forEach(([v, t]) => { const o = el('option', { value: v }, t); if ((r.move_policy || 'shift_course') === v) o.selected = true; mpSel.append(o); });
  mp.append(el('span', {}, 'When a session no longer fits its day'), mpSel); grid.append(mp);
  const reason = el('input', { type: 'text', placeholder: 'Reason for the change (5–300 characters)', maxLength: 300, style: 'min-width:280px' });
  const save = el('button', { type: 'button', style: btnCss }, 'Save schedule settings');
  const msg = el('div', { role: 'status', style: 'font-size:12.5px;margin-top:6px' });
  save.addEventListener('click', async () => {
    const changes = {};
    for (const [k, , type] of SETTING_FIELDS) {
      const v = inputs[k].value; if (v === '') continue;
      const old = r[k] != null ? String(r[k]).slice(0, type === 'time' ? 5 : 10) : '';
      if (v !== old) changes[k] = type === 'number' ? Number(v) : v;
    }
    if (mpSel.value !== (r.move_policy || 'shift_course')) changes.move_policy = mpSel.value;
    if (!Object.keys(changes).length) { say(msg, false, 'Nothing to change.'); return; }
    save.disabled = true;
    const { error } = await supabase.rpc('set_pk_schedule_settings', { p_settings: changes, p_reason: reason.value });
    save.disabled = false;
    if (error) { say(msg, false, '⚠ ' + safeErrorMessage(error, 'Not saved.')); return; }
    say(msg, true, '✓ Saved. Run the shift-time setup check (pilot checklist item 8) after changing shifts or windows.');
    renderScheduleSettings({ supabase, container, tenantId });
  });
  container.append(grid, el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' }, null));
  container.lastChild.append(reason, save);
  container.append(msg);
}

export async function renderCouches({ supabase, container, tenantId }) {
  container.replaceChildren();
  // owner, 21 Nov 2026: "Droni" (the Panchakarma treatment table) is the word on screen; the database keeps couch_id / kind 'couch'
  container.append(el('div', { style: 'font-size:12.5px;color:var(--text-mid);margin:0 0 8px' },
    'Most rooms have one Droni and need nothing here — the room is booked as one place. Add Dronis only for a room with two or more.'));
  const [{ data: rooms }, { data: couches }] = await Promise.all([
    supabase.from('pk_treatment_rooms').select('id, room_name, gender_restriction, status, is_pediatric').eq('tenant_id', tenantId).order('room_name'),
    supabase.from('sched_places').select('id, pk_room_id, name, status').eq('tenant_id', tenantId).eq('kind', 'couch').order('name')]);
  for (const rm of (rooms || [])) {
    const box = el('div', { style: 'border:1px solid var(--border);border-radius:7px;padding:8px 10px;margin:4px 0;font-size:12.5px' });
    box.append(el('div', { style: 'font-weight:600' }, `${rm.room_name} · ${rm.gender_restriction} · ${rm.status}`));
    const kl = el('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin:4px 0' });
    const kb = el('input', { type: 'checkbox', checked: !!rm.is_pediatric });
    kl.append(kb, el('span', {}, 'Kaumara (pediatric) room — children are placed here first'));
    const msg = el('div', { role: 'status', style: 'font-size:12px' });
    kb.addEventListener('change', async () => {
      const { data, error } = await supabase.from('pk_treatment_rooms').update({ is_pediatric: kb.checked }).eq('id', rm.id).select('id');
      if (error || !(data || []).length) { kb.checked = !kb.checked; say(msg, false, '⚠ ' + safeErrorMessage(error, 'Not saved (only a room admin changes rooms).')); return; }
      say(msg, true, '✓ Saved.');
    });
    box.append(kl);
    const mine = (couches || []).filter(c => c.pk_room_id === rm.id);
    const list = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:4px 0' });
    for (const c of mine) {
      const chip = el('span', { style: 'border:1px solid var(--border);border-radius:12px;padding:2px 8px' }, `🛏 ${c.name} · ${c.status}`);
      const tog = el('button', { type: 'button', style: 'margin-left:6px;min-height:28px;border:none;background:none;color:var(--green-deep);cursor:pointer;font-size:12px' },
        c.status === 'active' ? 'Set inactive' : 'Set active');
      tog.addEventListener('click', async () => {
        const { data, error } = await supabase.from('sched_places').update({ status: c.status === 'active' ? 'inactive' : 'active' }).eq('id', c.id).select('id');
        if (error || !(data || []).length) { say(msg, false, '⚠ ' + safeErrorMessage(error, 'Not saved.')); return; }
        renderCouches({ supabase, container, tenantId });
      });
      chip.append(tog); list.append(chip);
    }
    if (!mine.length) list.append(el('span', { style: 'color:var(--text-muted)' }, 'No Dronis set — the room is booked as one place (one patient at a time).'));
    const name = el('input', { type: 'text', placeholder: 'New Droni name (e.g. Droni 1)', maxLength: 40 });
    const add = el('button', { type: 'button', style: btnCss }, 'Add Droni');
    add.addEventListener('click', async () => {
      const { data, error } = await supabase.from('sched_places').insert({ tenant_id: tenantId, kind: 'couch', pk_room_id: rm.id, name: name.value.trim() }).select('id');
      if (error || !(data || []).length) { say(msg, false, '⚠ ' + safeErrorMessage(error, 'Not added.')); return; }
      renderCouches({ supabase, container, tenantId });
    });
    box.append(list, el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, null), msg);
    box.children[box.children.length - 2].append(name, add);
    container.append(box);
  }
  if (!(rooms || []).length) container.append(el('div', { style: 'font-size:12.5px;color:var(--text-muted)' }, 'No treatment rooms yet.'));
}
