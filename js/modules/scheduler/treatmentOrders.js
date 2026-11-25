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
const DEPT_KINDS = ['anushastra', 'kshara_sutra', 'minor_procedure', 'department_procedure'];   // Session 391 T1a-2

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
    box.append(el('div', 'font-size:12.5px;color:var(--text-muted)', 'No procedure is ordered yet. Department procedures are ordered under 🗓 Department procedures (🔬 Investigations); Panchakarma procedures by saving a care plan.'));
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
    // Session 391 T1a-2: a department order's own sittings (procedure_sittings), from the server
    const sl = Array.isArray(o.sittings_list) ? o.sittings_list : [];
    if (sl.length) {
      const live = sl.filter(x => ['held', 'scheduled', 'in_progress', 'completed'].includes(x.status));
      parts.push(`${sl.filter(x => x.status === 'completed').length} of ${o.sittings_planned || live.length} sitting(s) done`);
      const noSlot = live.filter(x => ['held', 'scheduled'].includes(x.status) && !x.time).length;
      if (noSlot) parts.push(`${noSlot} without a slot yet`);
      const held = sl.filter(x => x.status === 'held').length;
      if (held) parts.push(`${held} held until the consultation is completed`);
      const missed = sl.filter(x => x.status === 'missed').length;
      if (missed) parts.push(`${missed} missed`);
      const nx = live.filter(x => ['held', 'scheduled'].includes(x.status) && x.time).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];
      if (nx) parts.push(`next ${nx.date} ${nx.time}`);
    }
    if (o.without_order) parts.push('recorded without an order (department head)');
    if (o.cancel_reason) parts.push(o.cancel_reason);
    if (parts.length) line.append(el('span', 'color:var(--text-muted)', parts.join(' · ')));
    box.append(line);
    // Session 391 T1a-2: a department order is cancelled here with a reason -- the ordering doctor or the department head (the server
    // decides: cancel_treatment_order); its open sittings are cancelled and their slots released. A Panchakarma order changes in its plan.
    if (DEPT_KINDS.includes(o.kind) && ['planned', 'scheduled', 'in_progress'].includes(o.status) && o.order_id) {
      const cx = el('button', 'min-height:36px;padding:4px 12px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid #8b1a1a;background:#fff;color:#8b1a1a', '✕ Cancel order');
      cx.type = 'button';
      line.append(cx);
      cx.addEventListener('click', () => {
        if (line.nextSibling && line.nextSibling.dataset && line.nextSibling.dataset.cancelFor === o.order_id) return;
        const p = el('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 8px;margin:2px 0 6px;border:1px solid #8b1a1a;border-radius:6px;background:#fff7f7;font-size:12.5px');
        p.dataset.cancelFor = o.order_id;
        p.append(el('span', null, `Cancel ${o.procedure || 'this order'}? Its open sittings are cancelled and their slots released.`));
        const reason = el('input', 'min-height:36px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;min-width:240px');
        reason.type = 'text'; reason.maxLength = 300; reason.placeholder = 'Reason (5 to 300 characters)';
        reason.setAttribute('aria-label', 'Reason for cancelling the order');
        const ok = el('button', 'min-height:36px;padding:4px 12px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid #8b1a1a;background:#8b1a1a;color:#fff', 'Cancel the order');
        ok.type = 'button';
        const keep = el('button', 'min-height:36px;padding:4px 12px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:#fff', 'Keep it');
        keep.type = 'button';
        const msg = el('span', 'color:#8b1a1a');
        p.append(reason, ok, keep, msg);
        line.after(p);
        keep.addEventListener('click', () => p.remove());
        ok.addEventListener('click', async () => {
          ok.disabled = true; msg.textContent = '';
          const { error: ce } = await supabase.rpc('cancel_treatment_order', { p_order: o.order_id, p_reason: reason.value.trim() });
          ok.disabled = false;
          if (ce) { msg.textContent = safeErrorMessage(ce, 'The order was not cancelled.'); return; }
          await renderTreatmentOrders({ supabase, container, visitId });
        });
      });
    }
  });
  container.append(box);
}
