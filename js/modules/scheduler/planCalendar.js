// Session 388s1 (S1, the treatment scheduler) -- the doctor's side:
//   showPlanCalendar  the free-capacity calendar while planning (read-only server call sched_capacity_calendar; owner decision 1 / S2)
//   holdPlan          the slots held at save (pk_plan_hold; S1 expiry) + the result shown in the page (never a native alert)
//   renderScheduleCard each session's state for the planning doctor / the ward round (pk_plan_schedule_status; decision 5)
// Everything is built from DOM nodes + textContent (no HTML strings). The server decides everything; the page only shows it.
import { safeErrorMessage } from '../../utils/errors.js';

const el = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') n.style.cssText = v; else if (k.startsWith('data-')) n.setAttribute(k, v); else n[k] = v;
  }
  if (text != null) n.textContent = text;
  return n;
};
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
};
const FIT = { fits: { icon: '✅', text: 'fits', bg: 'var(--green-light)', fg: 'var(--green-deep)' },
              partial: { icon: '🟠', text: 'part fits', bg: '#fdf3e4', fg: '#8a5a00' },
              full: { icon: '⛔', text: 'full', bg: '#fbeaea', fg: '#8b1a1a' } };

// items: [{offset, phase, activity, duration, man_power, room, seq}] relative to the course's first day
export async function showPlanCalendar({ supabase, container, patientId, items, from, onPick }) {
  container.replaceChildren(el('div', { style: 'font-size:12.5px;color:var(--text-muted)' }, 'Checking free capacity…'));
  const { data, error } = await supabase.rpc('sched_capacity_calendar', { p_patient: patientId, p_items: items, p_from: from, p_days: 21 });
  container.replaceChildren();
  if (error) {
    container.append(el('div', { role: 'alert', style: 'color:#8b1a1a;font-size:12.5px' }, safeErrorMessage(error, 'Could not read the free capacity.')));
    return;
  }
  container.append(el('div', { style: 'font-size:12px;color:var(--text-mid);margin:4px 0 8px' },
    'Free capacity for this course, by start date (therapists on duty by shift and gender, rooms / Dronis). Click a date to start the course on it.'));
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px' });
  for (const d of (data?.dates || [])) {
    const f = FIT[d.fits] || FIT.full;
    const b = el('button', { type: 'button', style: `min-height:44px;text-align:left;padding:6px 8px;border-radius:7px;border:1.5px solid var(--border);background:${f.bg};color:${f.fg};font-family:'DM Sans',sans-serif;font-size:12px;cursor:pointer` });
    b.append(el('div', { style: 'font-weight:600' }, fmtDate(d.date)), el('div', {}, `${f.icon} ${f.text} · ${d.placed}/${d.of}`));
    const duty = d.duty || {};
    const tip = [`Shift 1: ${duty.shift1_m || 0} M / ${duty.shift1_f || 0} F`, `Shift 2: ${duty.shift2_m || 0} M / ${duty.shift2_f || 0} F`]
      .concat((d.not_placed || []).map(x => `${fmtDate(x.date)} ${x.activity || ''}: ${x.reason || 'no free slot'}`));
    b.title = tip.join('\n');
    b.setAttribute('aria-label', `${fmtDate(d.date)}: ${f.text}, ${d.placed} of ${d.of} sessions fit. ${tip.join('. ')}`);
    b.addEventListener('click', () => onPick && onPick(String(d.date).slice(0, 10)));
    grid.append(b);
  }
  container.append(grid);
}

// after the plan is saved: hold its slots; returns the server result (or null) and shows it in `container`
export async function holdPlan({ supabase, planId, admissionDate, container }) {
  const { data, error } = await supabase.rpc('pk_plan_hold', { p_plan_id: planId, p_planned_admission_date: admissionDate || null });
  if (!container) return error ? null : data;
  container.replaceChildren();
  if (error) {
    container.append(el('div', { role: 'alert', style: 'color:#8b1a1a' }, '⚠ The slots are NOT held: ' + safeErrorMessage(error, 'please try again.')));
    return null;
  }
  const until = data?.expires_at ? new Date(data.expires_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  container.append(el('div', { style: 'font-weight:600;color:var(--green-deep)' }, `📌 Held: ${data?.held || 0} of ${data?.of || 0} sessions, until ${until}.`));
  const list = el('ul', { style: 'margin:6px 0 0 18px;padding:0;font-weight:400;color:var(--text-mid)' });
  for (const d of (data?.days || [])) {
    const t = d.held
      ? `${fmtDate(d.date)} ${d.time} — ${d.activity}: ${(d.therapists || []).join(', ') || 'therapist'}${d.room ? ', ' + d.room : ''}${d.couch ? ' · ' + d.couch : ''}`
      : `${fmtDate(d.date)} — ${d.activity}: not held (${d.reason})`;
    list.append(el('li', { style: d.held ? '' : 'color:#8a5a00' }, t));
  }
  container.append(list);
  return data;
}

const STATE = { scheduled: ['📅', 'scheduled'], unassigned: ['⚠', 'not scheduled'], in_progress: ['▶', 'started'], completed: ['✓', 'completed'],
                skipped: ['✗', 'skipped'], missed: ['⏰', 'missed'], cancelled: ['🚫', 'cancelled'] };

export async function renderScheduleCard({ supabase, container, planId }) {
  container.replaceChildren();
  const { data, error } = await supabase.rpc('pk_plan_schedule_status', { p_plan_id: planId });
  if (error) { container.append(el('div', { role: 'alert', style: 'color:#8b1a1a;font-size:12.5px' }, safeErrorMessage(error, 'Could not read the schedule.'))); return null; }
  const card = el('div', { style: 'border:1.5px solid var(--green-mid);border-radius:8px;padding:10px 12px;background:#fff' });
  card.append(el('div', { style: "font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:600;color:var(--green-deep)" }, '🌸 Panchakarma schedule'));
  if (data?.hold && data.status === 'finalized') {
    const h = data.hold;
    card.append(el('div', { style: 'font-size:12px;color:var(--text-mid)' },
      h.status === 'held' ? `Slots held until ${new Date(h.expires_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} — waiting for activation.`
                          : `Hold ${h.status} — the sessions are searched again when the plan is activated.`));
  }
  if (data?.waiting) card.append(el('div', { role: 'alert', style: 'font-size:12.5px;color:#8a5a00;margin-top:4px' }, '⚠ Not started: ' + data.waiting));
  const rows = data?.sessions || [];
  if (!rows.length) card.append(el('div', { style: 'font-size:12.5px;color:var(--text-muted);margin-top:4px' }, data?.status === 'finalized' ? 'Not activated yet.' : 'No sessions.'));
  const tbl = el('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12.5px;margin-top:6px' });
  for (const s of rows) {
    const [icon, word] = STATE[s.state] || ['•', s.state];
    const slot = s.slot || {};
    const who = [slot.time, (slot.therapists || []).join(', '), slot.room, slot.couch].filter(Boolean).join(' · ');
    tbl.append(el('div', { style: 'color:var(--text-muted);white-space:nowrap' }, fmtDate(s.date)),
      el('div', {}, `${icon} ${s.activity} — ${word}${s.moved ? ' (moved)' : ''}${who ? ' · ' + who : ''}${s.reason && s.state !== 'scheduled' ? ' — ' + s.reason : ''}`));
  }
  card.append(tbl);
  container.append(card);
  return data;
}
