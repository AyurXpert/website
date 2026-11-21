// opdProcedureBilling.js -- Session 386d-1 (TODO §602, owner answers 17 Nov 2026: Q1-Q14 defaults OK).
// reception.html -> Billing -> 🩹 Procedures: the OPD procedure orders not yet billed, grouped by visit. "Collect" sends only the ORDER
// ids + the payment mode (+ the UPI / card reference); the SERVER prices every line from its fee and makes the bill
// (create_opd_procedure_bill: the consultation path, a Bill of Supply when exempt, a receipt). If any chosen order has no price any more,
// NOTHING is billed and the server raises an unpriced item: the accountant / finance manager / MS / Super Admin chooses its fee or cancels
// it here (the shared unpriced-items panel). The prices shown before Collect are an estimate (the fee list); the bill is the server's.
// A procedure is marked done here too (a doctor / nurse covering reception -- Q3; the server decides), so an order already billed but not
// yet done stays listed (no tick box) until it is done. DOM nodes + textContent only; no confirm() / prompt().
import { safeErrorMessage } from '../../utils/errors.js'
import { el } from './invoiceLayout.js'
import { getEffectivePrice } from './effectivePrice.js'
import { renderOpenChargeIssues } from './unpricedItems.js'
import { orderBadges, say } from '../opd/opdProcedureOrders.js'   // 386d-1 L11 / L4

const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const fmtD = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const CARD = 'margin:8px 12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#fff'
const NOTE = 'font-size:12px;color:var(--text-muted);margin-top:4px'
const BTN = 'min-height:44px;padding:0 14px;border-radius:6px;font-family:inherit;font-size:12.5px;cursor:pointer'
const DONE_ROLES = ['doctor', 'nurse', 'therapist']
/** page copy of mark_opd_procedure_done's rule (active, not a trainee; doctor / nurse / therapist or the Super Admin) -- the server re-checks */
export function canMarkDone(p) {
  if (!p || (p.status && p.status !== 'active')) return false
  if (['pg_scholar', 'intern', 'nursing_intern'].includes(p.designation) || ['trainee_doctor', 'student'].includes(p.role)) return false
  return p.role === 'super_admin' || DONE_ROLES.includes(p.role) || DONE_ROLES.includes(p.secondary_role)
}

/** group the open orders by visit (oldest first), keeping the server's order */
export function groupByVisit(orders) {
  const m = new Map()
  for (const o of orders || []) {
    if (!m.has(o.visit_id)) m.set(o.visit_id, { visit_id: o.visit_id, patient: o.patients || {}, orders: [] })
    m.get(o.visit_id).orders.push(o)
  }
  return [...m.values()]
}

/**
 * loadOpdProcedureBills(container, { supabase, tenantId, profile, onBilled, onCount })
 * onBilled(result) after a bill is made (e.g. open the print); onCount(n) with the number of open orders.
 */
export async function loadOpdProcedureBills(container, { supabase, tenantId, profile, onBilled, onCount }) {
  if (!container) return
  const reload = () => loadOpdProcedureBills(container, { supabase, tenantId, profile, onBilled, onCount })
  const { data: orders, error } = await supabase.from('opd_procedure_orders')
    .select('id, visit_id, procedure_name, procedure_detail, order_date, done_at, bill_id, patients(name, uhid), fee_structures(label, amount, promo_price, promo_valid_until)')
    .eq('tenant_id', tenantId).is('cancelled_at', null).or('bill_id.is.null,done_at.is.null')
    .order('order_date').order('ordered_at')
  container.replaceChildren()
  if (error) {
    container.appendChild(el('div', { class: 'q-empty', role: 'alert' }, safeErrorMessage(error, 'Could not load the OPD procedures. Please reload.')))
    if (onCount) onCount(0)
    return
  }
  if (onCount) onCount((orders || []).filter(o => !o.bill_id).length)
  if (!(orders || []).length) {
    container.appendChild(el('div', { class: 'q-empty' }, el('div', { class: 'q-empty-icon' }, '🩹'),
      el('div', { class: 'q-empty-text' }, 'No OPD procedure is waiting to be billed or done.')))
    return
  }
  const visits = groupByVisit(orders)
  const { data: items } = await supabase.from('ipd_unpriced_items')
    .select('id, source, source_table, item_name, item_date, detail, raised_at, visit_id')
    .in('visit_id', visits.map(v => v.visit_id)).is('resolved_at', null).order('raised_at')

  for (const v of visits) {
    const checks = []
    const card = el('div', { style: CARD },
      el('div', { style: 'font-weight:700;font-size:13px' }, v.patient.name || 'Patient',
        el('span', { style: 'font-weight:400;color:var(--text-muted);margin-left:8px;font-size:12px' }, v.patient.uhid || '')))
    const ul = el('ul', { style: 'list-style:none;margin:6px 0 0;padding:0' })
    for (const o of v.orders) {
      const what = el('span', null, o.procedure_name + (o.procedure_detail ? ` (${o.procedure_detail})` : ''),
        el('span', { style: 'display:block;font-size:11.5px;color:var(--text-muted)' }, fmtD(o.order_date)),
        el('span', { style: 'display:block' }, orderBadges(o)))   // L11 / L7
      let left
      if (o.bill_id) {
        left = el('div', { style: 'display:flex;gap:8px;align-items:center;flex:1' }, what)
      } else {
        const cb = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Bill ' + o.procedure_name, style: 'width:20px;height:20px' })
        cb.dataset.orderId = o.id
        checks.push(cb)
        left = el('label', { style: 'display:flex;gap:8px;align-items:center;flex:1;cursor:pointer' }, cb, what)
      }
      const est = o.bill_id ? 'Billed' : (o.fee_structures ? rupee(getEffectivePrice(o.fee_structures)) : '—')
      const li = el('li', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 0;min-height:44px' }, left,
        el('span', { style: 'font-size:12.5px' }, est))
      if (!o.done_at && canMarkDone(profile)) {
        const rowMsg = el('span', { role: 'status', style: NOTE })
        const bDone = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: BTN }, 'Mark done')
        bDone.addEventListener('click', async () => {
          bDone.disabled = true
          const { error: e } = await supabase.rpc('mark_opd_procedure_done', { p_order: o.id })
          if (e) { say(rowMsg, safeErrorMessage(e, 'Could not mark it done.'), true); bDone.disabled = false; return }
          await reload()
        })
        li.append(bDone, rowMsg)
      }
      ul.appendChild(li)
    }
    card.appendChild(ul)
    const vItems = (items || []).filter(i => i.visit_id === v.visit_id)
    if (vItems.length) {
      const slot = el('div')
      card.appendChild(slot)
      await renderOpenChargeIssues(slot, { supabase, tenantId, profile, issues: { items: vItems, notDone: [] }, onChanged: reload })
    }
    if (!checks.length) { container.appendChild(card); continue }   // all of this visit is billed; only "Mark done" is left
    const mode = el('select', { 'aria-label': 'Payment mode', style: 'min-height:44px' },
      el('option', { value: 'cash' }, 'Cash'), el('option', { value: 'upi' }, 'UPI'), el('option', { value: 'card' }, 'Card'))
    const ref = el('input', { type: 'text', maxlength: '60', 'aria-label': 'UPI / card transaction reference', placeholder: 'UPI / card reference',
      style: 'min-height:44px;flex:1 1 160px' })
    const bCollect = el('button', { type: 'button', class: 'btn btn-primary', style: BTN }, 'Collect & bill')
    const msg = el('div', { role: 'status', style: NOTE })
    bCollect.addEventListener('click', async () => {
      const ids = checks.filter(c => c.checked).map(c => c.dataset.orderId)
      if (!ids.length) { say(msg, 'Tick at least one procedure.', true); return }
      if (mode.value !== 'cash' && !ref.value.trim()) { say(msg, 'Enter the UPI / card transaction reference.', true); return }
      bCollect.disabled = true
      say(msg, 'Billing…')
      const { data, error: e } = await supabase.rpc('create_opd_procedure_bill', {
        p_orders: ids, p_payment_mode: mode.value, p_reference: mode.value === 'cash' ? null : ref.value.trim() })
      if (e) { say(msg, safeErrorMessage(e, 'Could not make the bill.'), true); bCollect.disabled = false; return }
      if (data?.status === 'unpriced') {
        say(msg, data.message || 'No price set for one of these procedures. Nothing was billed.', true)
        await reload()
        return
      }
      if (onBilled) onBilled(data)
      await reload()
    })
    card.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center' }, mode, ref, bCollect))
    card.appendChild(el('div', { style: NOTE }, 'The bill is priced by the server from the fee list; the amounts above are an estimate.'))
    card.appendChild(msg)
    container.appendChild(card)
  }
}

/**
 * Session 386d-1 (owner, 17 Nov 2026, rehearsal L9): the OPD procedures with NO PRICE, for the billing deciders -- the accountant, the
 * finance manager, the MS and the Super Admin can all open finance.html (reception.html is closed to the accountant / finance manager).
 * finance.html -> the panel at the top (#opd-unpriced); the 🔔 alert links here. Choose its fee / cancel with a reason = the shared
 * unpriced-items panel (resolve_ipd_unpriced_item; the server re-checks who). Hidden when nothing is open.
 */
export async function loadOpdUnpricedPanel(container, { supabase, tenantId, profile }) {
  if (!container) return
  const reload = () => loadOpdUnpricedPanel(container, { supabase, tenantId, profile })
  const { data: items, error } = await supabase.from('ipd_unpriced_items')
    .select('id, source, source_table, item_name, item_date, detail, raised_at, visit_id, visits(created_at, patients(name, uhid))')
    .eq('tenant_id', tenantId).in('source', ['opd_procedure', 'opd_imaging']).is('resolved_at', null).order('raised_at')   // Session 387-J1: + OPD imaging
  container.replaceChildren()
  if (error) {
    container.hidden = false
    container.appendChild(el('div', { role: 'alert', style: 'color:var(--red, #b03a2e);font-size:13px;margin:8px 0' },
      safeErrorMessage(error, 'Could not load the OPD procedures with no price. Please reload.')))
    return
  }
  if (!(items || []).length) { container.hidden = true; return }
  container.hidden = false
  container.appendChild(el('h2', { id: 'opd-unpriced-h', style: "font-family:'Cormorant Garamond',serif;font-size:20px;color:var(--green-deep);margin:12px 0 4px" },
    `No price set — OPD procedures and imaging (${items.length})`))
  container.appendChild(el('div', { style: NOTE }, 'Reception cannot bill these until each one gets its fee (the order then goes back to Reception → 🩹 Procedures) or is cancelled with a reason.'))
  const byVisit = new Map()
  for (const it of items) { if (!byVisit.has(it.visit_id)) byVisit.set(it.visit_id, []); byVisit.get(it.visit_id).push(it) }
  for (const [, vItems] of byVisit) {
    const pt = vItems[0].visits?.patients || {}
    const card = el('div', { style: CARD },
      el('div', { style: 'font-weight:700;font-size:13px' }, pt.name || 'Patient',
        el('span', { style: 'font-weight:400;color:var(--text-muted);margin-left:8px;font-size:12px' }, pt.uhid || '')))
    const slot = el('div')
    card.appendChild(slot)
    container.appendChild(card)
    await renderOpenChargeIssues(slot, { supabase, tenantId, profile, issues: { items: vItems, notDone: [] }, onChanged: reload })
  }
}

/** Session 386d-1 (L6): the number of OPD procedure orders waiting to be billed (reception's red counts); null on an error */
export async function countOpdProceduresToBill(supabase, tenantId) {
  const { count, error } = await supabase.from('opd_procedure_orders').select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).is('bill_id', null).is('cancelled_at', null)
  return error ? null : (count || 0)
}

/** Session 386d-1 (L6): reception's 🩹 Procedures count -- on open and every 30 s; the number and the class rx-cnt-red-text when > 0 */
export function watchOpdProcedureCount(node, { supabase, tenantId, everyMs = 30000 }) {
  if (!node) return
  const tick = async () => {
    const n = await countOpdProceduresToBill(supabase, tenantId)
    if (n === null) return
    node.textContent = n ? '(' + n + ')' : ''
    node.classList.toggle('rx-cnt-red-text', n > 0)
  }
  tick()
  setInterval(tick, everyMs)
}
