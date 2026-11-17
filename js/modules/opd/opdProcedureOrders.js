// opdProcedureOrders.js -- Session 386d-1 (TODO §602, owner answers 17 Nov 2026: Q1-Q14 defaults OK).
// doctor.html -> Investigations: the doctor orders an OPD procedure for TODAY's visit from the procedures offered in OPD (the fee list
// IS the procedure list: procedure_choices('opd_procedure'), never free text; a Details box for side / site / size). Reception bills it
// (create_opd_procedure_bill); a doctor / nurse / therapist marks it done (never needs the payment); the orderer cancels an open order
// with a reason. Every rule and every price is the SERVER's (order_opd_procedure, mark_opd_procedure_done, cancel_opd_procedure_order);
// this module only shows them. DOM nodes + textContent only (procedure names and reasons are entered text); no confirm() / prompt().
import { safeErrorMessage } from '../../utils/errors.js'
import { el } from '../billing/invoiceLayout.js'
import { getEffectivePrice } from '../billing/effectivePrice.js'

const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const BOX = 'margin-top:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#fff'
const NOTE = 'font-size:12px;color:var(--text-muted);margin-top:4px'
const ERR = 'font-size:12px;color:var(--red, #b03a2e);margin-top:4px'
const BTN = 'min-height:44px;padding:0 14px;border-radius:6px;font-family:inherit;font-size:12.5px;cursor:pointer'

// Session 386d-1 (owner, 17 Nov 2026, L4): 386d-1's own error messages are RED (role alert); progress / notes stay grey
export function say(node, text, isError = false) {
  if (!node) return
  node.textContent = text || ''
  node.setAttribute('role', isError ? 'alert' : 'status')
  node.style.color = isError ? 'var(--red, #a01a1a)' : 'var(--text-muted)'
  node.style.fontWeight = isError ? '600' : ''
}

// L11 / L7 (owner, 17 Nov 2026): clear badges -- Ordered → Paid → Done (or Not billed / Not done yet / Cancelled). Text on every badge
// (never colour alone); filled badges in the existing tokens (white text, WCAG AA), the open steps outlined in orange with dark text.
const BADGE = 'display:inline-flex;align-items:center;min-height:24px;padding:2px 9px;border-radius:12px;font-size:11.5px;font-weight:700;margin:2px 4px 2px 0'
const FILL = { ordered: 'var(--blue, #1a4080)', paid: 'var(--green-deep, #1a4a2e)', done: 'var(--teal, #0e6b66)', cancelled: 'var(--red, #a01a1a)' }
function _badge(text, kind) {
  const fill = FILL[kind]
  return el('span', { 'data-badge': kind, style: BADGE + (fill ? `;background:${fill};color:#fff;border:2px solid ${fill}`
    : ';background:#fff;color:var(--text-dark, #222);border:2px solid var(--orange, #d35400)') }, text)
}
/** the badges of one order: Cancelled; or Ordered → Paid / Not billed → Done / Not done yet (server columns only) */
export function orderBadges(o) {
  const wrap = el('span', { 'aria-label': 'Status: ' + orderStatusText(o) })
  if (o.cancelled_at) { wrap.append(_badge('✕ Cancelled', 'cancelled')); return wrap }
  wrap.append(_badge('Ordered', 'ordered'), el('span', { 'aria-hidden': 'true', style: 'margin:0 2px' }, '→'),
    o.bill_id ? _badge('✓ Paid', 'paid') : _badge('⏳ Not billed', 'notbilled'), el('span', { 'aria-hidden': 'true', style: 'margin:0 2px' }, '→'),
    o.done_at ? _badge('✓ Done', 'done') : _badge('⏳ Not done yet', 'notdone'))
  return wrap
}

/** the state of one order, in words (server columns only) */
export function orderStatusText(o) {
  if (o.cancelled_at) return 'Cancelled' + (o.cancel_reason ? ' — ' + o.cancel_reason : '')
  const pay = o.bill_id ? 'Billed' : 'Not billed yet — pay at Reception'
  return (o.done_at ? 'Done · ' : 'Not done yet · ') + pay
}

/**
 * renderOpdProcedures(container, { supabase, visitId, isTrainee })
 * Shows today's OPD procedure orders of the visit and (for a doctor who is not a trainee) the order form. Re-renders itself after
 * every change. Returns nothing; errors are shown in the box.
 */
export async function renderOpdProcedures(container, { supabase, visitId, isTrainee = false }) {
  if (!container) return
  container.replaceChildren()
  if (!visitId) return
  const box = el('div', { style: BOX, 'aria-labelledby': 'opdproc-h' },
    el('div', { id: 'opdproc-h', style: 'font-size:12.5px;font-weight:700;color:var(--green-deep)' }, '🩹 OPD procedures'))
  container.appendChild(box)
  const msg = el('div', { role: 'status', style: NOTE })
  const rerender = () => renderOpdProcedures(container, { supabase, visitId, isTrainee })

  const [{ data: choices, error: e1 }, { data: orders, error: e2 }] = await Promise.all([
    isTrainee ? Promise.resolve({ data: [], error: null }) : supabase.rpc('procedure_choices', { p_register: 'opd_procedure' }),
    supabase.from('opd_procedure_orders')
      .select('id, procedure_name, procedure_detail, ordered_at, done_at, bill_id, cancelled_at, cancel_reason')
      .eq('visit_id', visitId).order('ordered_at'),
  ])
  if (e1 || e2) {
    box.appendChild(el('div', { style: ERR, role: 'alert' }, safeErrorMessage(e1 || e2, 'Could not load the OPD procedures. Please reload.')))
    return
  }

  if (isTrainee) {
    box.appendChild(el('div', { style: NOTE }, 'A consultant orders OPD procedures.'))
  } else if (!(choices || []).length) {
    box.appendChild(el('div', { style: NOTE },
      'No procedure is offered in OPD yet. The Fee committee places procedures in a group offered in OPD (Fee Structure → Procedures).'))
  } else {
    const sel = el('select', { id: 'opdproc-fee', 'aria-label': 'Procedure', style: 'min-height:44px;max-width:100%;flex:1 1 220px' },
      el('option', { value: '' }, 'Choose the procedure…'),
      choices.map(f => el('option', { value: f.id }, `${f.label} — ${rupee(getEffectivePrice(f))}`)))
    const det = el('input', { id: 'opdproc-detail', type: 'text', maxlength: '200', 'aria-label': 'Details (side / site / size)',
      placeholder: 'Details: side / site / size (optional)', style: 'min-height:44px;flex:1 1 180px' })
    const bOrder = el('button', { type: 'button', class: 'btn btn-primary', style: BTN }, 'Order')
    bOrder.addEventListener('click', async () => {
      if (!sel.value) { say(msg, 'Choose the procedure first.', true); return }
      if (/[<>]/.test(det.value)) { say(msg, 'Details cannot contain < or >.', true); return }
      bOrder.disabled = true
      say(msg, 'Ordering…')
      const { error } = await supabase.rpc('order_opd_procedure', { p_visit: visitId, p_fee: sel.value, p_detail: det.value.trim() || null })
      if (error) { say(msg, safeErrorMessage(error, 'Could not order the procedure.'), true); bOrder.disabled = false; return }
      await rerender()
    })
    box.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center' }, sel, det, bOrder))
    box.appendChild(el('div', { style: NOTE }, 'Reception collects the payment; the procedure can be done and marked done before that.'))
  }
  box.appendChild(msg)

  if (!(orders || []).length) {
    box.appendChild(el('div', { style: NOTE }, 'No OPD procedure ordered on this visit.'))
    return
  }
  const list = el('ul', { style: 'list-style:none;margin:8px 0 0;padding:0' })
  for (const o of orders) {
    const line = el('li', { style: 'padding:8px 0;border-top:1px solid var(--border)' },
      el('div', { style: 'font-weight:600;font-size:12.5px' + (o.cancelled_at ? ';text-decoration:line-through;color:var(--text-muted)' : '') },
        o.procedure_name + (o.procedure_detail ? ` (${o.procedure_detail})` : '')),
      el('div', { style: 'margin-top:2px' }, orderBadges(o)))   // L11 / L7
    const rowMsg = el('div', { role: 'status', style: NOTE })
    const acts = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px' })
    if (!o.cancelled_at && !o.done_at && !isTrainee) {
      const bDone = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: BTN }, 'Mark done')
      bDone.addEventListener('click', async () => {
        bDone.disabled = true
        const { error } = await supabase.rpc('mark_opd_procedure_done', { p_order: o.id })
        if (error) { say(rowMsg, safeErrorMessage(error, 'Could not mark it done.'), true); bDone.disabled = false; return }
        await rerender()
      })
      acts.appendChild(bDone)
    }
    if (!o.cancelled_at && !o.bill_id && !o.done_at && !isTrainee) {
      const bCancel = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: BTN }, 'Cancel order')
      bCancel.addEventListener('click', () => {
        if (line.querySelector('.opdproc-cancel')) return
        const reason = el('input', { type: 'text', maxlength: '300', 'aria-label': 'Reason for cancelling', placeholder: 'Reason (at least 5 characters)',
          style: 'min-height:44px;flex:1 1 200px' })
        const bOk = el('button', { type: 'button', class: 'btn btn-primary btn-sm', style: BTN }, 'Cancel this order')
        const bBack = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: BTN }, 'Keep it')
        const panel = el('div', { class: 'opdproc-cancel', style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' }, reason, bOk, bBack)
        bBack.addEventListener('click', () => panel.remove())
        bOk.addEventListener('click', async () => {
          const r = reason.value.trim()
          if (r.length < 5) { say(rowMsg, 'Give a reason (at least 5 characters).', true); return }
          if (/[<>]/.test(r)) { say(rowMsg, 'The reason cannot contain < or >.', true); return }
          bOk.disabled = true
          const { error } = await supabase.rpc('cancel_opd_procedure_order', { p_order: o.id, p_reason: r })
          if (error) { say(rowMsg, safeErrorMessage(error, 'Could not cancel the order.'), true); bOk.disabled = false; return }
          await rerender()
        })
        line.appendChild(panel)
        reason.focus()
      })
      acts.appendChild(bCancel)
    }
    if (acts.childElementCount) line.appendChild(acts)
    line.appendChild(rowMsg)
    list.appendChild(line)
  }
  box.appendChild(list)
}

/**
 * mountOpdProceduresToday(container, { supabase, tenantId, profile, canDone })
 * Session 386d-1 (owner, 17 Nov 2026, L12): nursing.html / therapist.html -- today's OPD procedure orders of the organisation (not
 * cancelled), with their badges and "Mark done" for the people the server allows (a doctor / nurse / therapist; a receptionist never).
 * canDone(profile) = the page copy of the server rule (opdProcedureBilling.js canMarkDone); the server re-checks every press.
 */
export async function mountOpdProceduresToday(container, { supabase, tenantId, profile, canDone }) {
  if (!container) return
  const reload = () => mountOpdProceduresToday(container, { supabase, tenantId, profile, canDone })
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)   // IST date
  const { data: orders, error } = await supabase.from('opd_procedure_orders')
    .select('id, procedure_name, procedure_detail, ordered_at, done_at, bill_id, cancelled_at, cancel_reason, patients(name, uhid)')
    .eq('tenant_id', tenantId).eq('order_date', today).is('cancelled_at', null).order('ordered_at')
  container.replaceChildren()
  const open = (orders || []).filter(o => !o.done_at).length
  const det = el('details', { style: BOX + ';margin:10px 0' })
  if (open) det.open = true
  det.append(el('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:700;color:var(--green-deep)' },
    `🩹 OPD procedures — today (${open} not done yet)`))
  container.append(det)
  if (error) { det.append(el('div', { role: 'alert', style: ERR }, safeErrorMessage(error, 'Could not load the OPD procedures. Please reload.'))); return }
  if (!(orders || []).length) { det.append(el('div', { style: NOTE }, 'No OPD procedure ordered today.')); return }
  const allowed = !!(canDone && canDone(profile))
  const ul = el('ul', { style: 'list-style:none;margin:6px 0 0;padding:0' })
  for (const o of orders) {
    const rowMsg = el('div', { role: 'status', style: NOTE })
    const li = el('li', { style: 'padding:8px 0;border-top:1px solid var(--border)' },
      el('div', { style: 'font-weight:600;font-size:12.5px' }, `${o.patients?.name || 'Patient'} ${o.patients?.uhid ? '(' + o.patients.uhid + ')' : ''} — `
        + o.procedure_name + (o.procedure_detail ? ` (${o.procedure_detail})` : '')),
      el('div', { style: 'margin-top:2px' }, orderBadges(o)))
    if (!o.done_at && allowed) {
      const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: BTN }, 'Mark done')
      b.addEventListener('click', async () => {
        b.disabled = true
        const { error: e } = await supabase.rpc('mark_opd_procedure_done', { p_order: o.id })
        if (e) { say(rowMsg, safeErrorMessage(e, 'Could not mark it done.'), true); b.disabled = false; return }
        await reload()
      })
      li.append(b)
    }
    li.append(rowMsg)
    ul.append(li)
  }
  det.append(ul)
  if (!allowed) det.append(el('div', { style: NOTE }, 'A doctor, a nurse or a therapist marks a procedure done.'))
}
