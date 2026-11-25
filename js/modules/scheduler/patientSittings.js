// Session 391 T1a-2 (plan §5) -- read-only: a patient's booked department-procedure sittings (Anushastra, Kshara sutra, Minor OT,
// Shalakya, Prasuti), from the server's treatment_order_status(patient). Shown on the reception patient card and the nursing patient view;
// no money, no action. DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';

const DEPT_KINDS = ['anushastra', 'kshara_sutra', 'minor_procedure', 'department_procedure'];
const el = (tag, style, text) => {
  const n = document.createElement(tag);
  if (style) n.style.cssText = style;
  if (text != null) n.textContent = text;
  return n;
};
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/** Fills container with the patient's next booked sittings (today and later); hides it when there are none. */
export async function renderPatientSittings({ supabase, container, patientId }) {
  if (!container) return;
  container.replaceChildren();
  container.hidden = true;
  if (!patientId) return;
  const { data, error } = await supabase.rpc('treatment_order_status', { p_visit: null, p_patient: patientId });
  if (error) {
    container.hidden = false;
    container.append(el('div', 'font-size:12px;color:#8b1a1a', `⚠ The booked procedures could not be loaded — ${safeErrorMessage(error, 'error')}.`));
    return;
  }
  const today = todayIst();
  const rows = [];
  (Array.isArray(data) ? data : []).filter(o => DEPT_KINDS.includes(o.kind) && ['scheduled', 'in_progress'].includes(o.status)).forEach(o => {
    (o.sittings_list || []).filter(s => ['scheduled', 'in_progress'].includes(s.status) && s.date >= today)
      .forEach(s => rows.push({ when: `${s.date} ${s.time || ''}`.trim(), date: s.date, time: s.time, name: o.procedure, no: s.no, of: o.sittings_planned }));
  });
  if (!rows.length) return;
  rows.sort((a, b) => a.when.localeCompare(b.when));
  container.hidden = false;
  const box = el('div', 'border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:#fff;margin-top:8px;font-size:12.5px');
  box.append(el('div', 'font-weight:600;color:var(--green-deep);margin-bottom:4px', '🩹 Booked procedure sittings'));
  rows.slice(0, 6).forEach(r => box.append(el('div', 'padding:2px 0',
    `${r.date === today ? 'Today' : r.date}${r.time ? ' ' + r.time : ' (no slot yet)'} — ${r.name} (sitting ${r.no} of ${r.of || r.no})`)));
  if (rows.length > 6) box.append(el('div', 'color:var(--text-muted)', `… and ${rows.length - 6} more`));
  container.append(box);
}
