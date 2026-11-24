// Session 390 T1a-1 -- the planning doctor's "Treatment orders" card: every procedure planned in this consultation (one server order per
// Panchakarma / Kriya Kalpa / Jaloukavacharana protocol), its basis, its state and its sessions (treatment_order_status). The server
// decides everything; the page only shows it. DOM nodes + textContent only (no HTML strings).
import { safeErrorMessage } from '../../utils/errors.js';

const el = (tag, style, text) => {
  const n = document.createElement(tag);
  if (style) n.style.cssText = style;
  if (text != null) n.textContent = text;
  return n;
};
const KIND = { panchakarma: '🌸 Panchakarma', kriya_kalpa: '👁 Kriya Kalpa', jaloukavacharana: '🩸 Jaloukavacharana',
               anushastra: 'Anushastra', kshara_sutra: 'Kshara sutra', minor_procedure: 'Minor procedure', department_procedure: 'Department procedure' };
const BASIS = { opd: 'OPD', day_care: 'Day Care', admission: 'Admission' };
const STATE = { planned: ['Planned', '#fdf3e4', '#8a5a00'], scheduled: ['Scheduled', 'var(--green-light)', 'var(--green-deep)'],
                in_progress: ['In progress', '#e8eef8', '#1a4080'], completed: ['Completed', 'var(--green-light)', 'var(--green-deep)'],
                cancelled: ['Cancelled', '#fbeaea', '#8b1a1a'], expired: ['Expired', '#fbeaea', '#8b1a1a'] };
const SIDE = { bilateral: 'both sides', right: 'right', left: 'left' };

export async function renderTreatmentOrders({ supabase, container, visitId }) {
  if (!container || !visitId) return;
  container.replaceChildren(el('div', 'font-size:12.5px;color:var(--text-muted)', 'Loading the treatment orders…'));
  const { data, error } = await supabase.rpc('treatment_order_status', { p_visit: visitId });
  container.replaceChildren();
  if (error) {
    container.append(el('div', 'font-size:12.5px;color:#8b1a1a', `⚠ The treatment orders could not be loaded — ${safeErrorMessage(error, 'error')}.`));
    return;
  }
  const rows = Array.isArray(data) ? data : [];
  const box = el('div', 'border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:#fff');
  box.append(el('div', 'font-weight:600;font-size:13.5px;color:var(--green-deep);margin-bottom:6px', '🩺 Treatment orders of this consultation'));
  if (!rows.length) {
    box.append(el('div', 'font-size:12.5px;color:var(--text-muted)', 'No procedure is ordered yet. Save a care plan to order its procedures.'));
    container.append(box);
    return;
  }
  rows.forEach(o => {
    const line = el('div', 'display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:12.5px');
    line.append(el('span', 'font-weight:600', o.procedure || '—'));
    line.append(el('span', 'color:var(--text-mid)', `${KIND[o.kind] || o.kind} · ${BASIS[o.basis] || o.basis}${o.side ? ' · ' + (SIDE[o.side] || o.side) : ''}`));
    const st = STATE[o.status] || [o.status, '#eee', '#333'];
    line.append(el('span', `padding:2px 8px;border-radius:10px;background:${st[1]};color:${st[2]};font-weight:600`, st[0]));
    const s = o.sessions || {};
    const parts = [];
    if (s.total) parts.push(`${s.done || 0} of ${s.total} done`);
    if (s.unassigned) parts.push(`${s.unassigned} not placed yet`);
    if (s.missed) parts.push(`${s.missed} missed`);
    if (s.skipped) parts.push(`${s.skipped} skipped`);
    if (!s.total && o.held) parts.push(`${o.held} slot(s) held`);
    if (s.next) parts.push(`next ${String(s.next).replace('T', ' ').slice(0, 16)}`);
    if (o.cancel_reason) parts.push(o.cancel_reason);
    if (parts.length) line.append(el('span', 'color:var(--text-muted)', parts.join(' · ')));
    box.append(line);
  });
  container.append(box);
}
