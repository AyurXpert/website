// opdImagingBilling.js -- Session 387-J1 (§4, owner decisions D9 / D10 / D11, 20 Nov 2026).
// reception.html -> Billing -> 💰 Lab & Imaging Bills: the doctor's in-house OPD imaging orders still to be paid, grouped by visit.
// "Collect & bill" sends only the ORDER ids + the payment mode (+ the UPI / card reference); the SERVER prices every study from its fee and
// makes the bill with a receipt (create_imaging_bill). A study with no billable fee is billed by NOTHING: the server raises an unpriced item
// on the visit and the accountant / finance manager / MS / Super Admin chooses its fee or cancels it (the shared panel). "🚨 Urgent — unpaid"
// (reason) lets radiology proceed while the charge stays owed (mark_imaging_order_urgent); the waiver (waive_imaging_order) is for the
// finance manager / MS / Super Admin. Studies ordered before imaging billing began are "not billed" and never listed (D11).
// DOM nodes + textContent only; no confirm() / prompt().
import { safeErrorMessage } from '../../utils/errors.js'
import { el } from './invoiceLayout.js'
import { getEffectivePrice } from './effectivePrice.js'
import { renderOpenChargeIssues } from './unpricedItems.js'

const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const fmtD = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const CARD = 'margin:8px 12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#fff'
const NOTE = 'font-size:12px;color:var(--text-muted);margin-top:4px'
const BTN = 'min-height:44px;padding:0 14px;border-radius:6px;font-family:inherit;font-size:12.5px;cursor:pointer'
const say = (node, text, bad) => { node.textContent = text; node.style.color = bad ? 'var(--red, #b03a2e)' : 'var(--text-muted)' }

/** page copy of the urgent rule (mark_imaging_order_urgent: an active receptionist / cashier, or the Super Admin) -- the server re-checks */
export function canMarkUrgent(p) {
  if (!p || (p.status && p.status !== 'active')) return false
  return p.role === 'super_admin' || ['receptionist', 'cashier'].includes(p.role) || ['receptionist', 'cashier'].includes(p.secondary_role)
}
/** page copy of the waiver rule (waive_imaging_order = _deposit_waiver_ok: finance manager, Medical Superintendent, Super Admin) */
export function canWaive(p) {
  if (!p || (p.status && p.status !== 'active')) return false
  return p.role === 'super_admin' || p.role === 'finance_manager' || p.secondary_role === 'finance_manager' || p.designation === 'medical_superintendent'
}

export function groupByVisit(orders) {
  const m = new Map()
  for (const o of orders || []) {
    if (!m.has(o.visit_id)) m.set(o.visit_id, { visit_id: o.visit_id, patient: o.patients || {}, orders: [] })
    m.get(o.visit_id).orders.push(o)
  }
  return [...m.values()]
}

/** loadOpdImagingBills(container, { supabase, tenantId, profile, onBilled, onCount }) */
export async function loadOpdImagingBills(container, { supabase, tenantId, profile, onBilled, onCount }) {
  if (!container) return
  const reload = () => loadOpdImagingBills(container, { supabase, tenantId, profile, onBilled, onCount })
  const { data: orders, error } = await supabase.from('imaging_orders')
    .select('id, visit_id, modality, study_name, order_date, due_timing, status, payment_status, bill_id, patients(name, uhid), fee_structures(label, amount, promo_price, promo_valid_until)')
    .eq('tenant_id', tenantId).in('payment_status', ['pending', 'waived']).is('bill_id', null).neq('status', 'cancelled')
    .order('order_date').order('created_at')
  container.replaceChildren()
  if (error) {
    container.appendChild(el('div', { class: 'q-empty', role: 'alert' }, safeErrorMessage(error, 'Could not load the imaging studies to bill. Please reload.')))
    if (onCount) onCount(0)
    return
  }
  if (onCount) onCount((orders || []).length)
  if (!(orders || []).length) return   // nothing to show: the lab list below speaks for itself
  container.appendChild(el('div', { style: 'padding:6px 12px 0;font-weight:700;font-size:13px;color:var(--green-deep)' }, `🩻 Imaging to bill (${orders.length})`))
  const visits = groupByVisit(orders)
  const { data: items } = await supabase.from('ipd_unpriced_items')
    .select('id, source, source_table, item_name, item_date, detail, raised_at, visit_id')
    .in('visit_id', visits.map(v => v.visit_id)).eq('source', 'opd_imaging').is('resolved_at', null).order('raised_at')

  for (const v of visits) {
    const checks = []
    const card = el('div', { style: CARD },
      el('div', { style: 'font-weight:700;font-size:13px' }, v.patient.name || 'Patient',
        el('span', { style: 'font-weight:400;color:var(--text-muted);margin-left:8px;font-size:12px' }, v.patient.uhid || '')))
    const ul = el('ul', { style: 'list-style:none;margin:6px 0 0;padding:0' })
    for (const o of v.orders) {
      const cb = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Bill ' + o.study_name, style: 'width:20px;height:20px' })
      cb.dataset.orderId = o.id
      checks.push(cb)
      const badge = o.payment_status === 'waived'
        ? el('span', { class: 'badge', style: 'background:#fdecea;color:#a01a1a;margin-left:6px' }, '🚨 Urgent — unpaid')
        : el('span', { class: 'badge', style: 'background:#fff4e5;color:#7a4a00;margin-left:6px' }, '⏳ Payment due')
      const what = el('span', null, `${o.study_name} (${String(o.modality || '').toUpperCase()})`, badge,
        el('span', { style: 'display:block;font-size:11.5px;color:var(--text-muted)' },
          fmtD(o.order_date) + (o.due_timing === 'next_visit' ? ' · advised for the next visit' : '')))
      const li = el('li', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 0;min-height:44px' },
        el('label', { style: 'display:flex;gap:8px;align-items:center;flex:1;cursor:pointer' }, cb, what),
        el('span', { style: 'font-size:12.5px' }, o.fee_structures ? rupee(getEffectivePrice(o.fee_structures)) : 'No price set'))
      const rowMsg = el('div', { role: 'status', style: NOTE + ';flex-basis:100%' })
      if (o.payment_status === 'pending' && canMarkUrgent(profile)) {
        const reason = el('input', { type: 'text', maxlength: '500', 'aria-label': 'Reason for sending this study unpaid', placeholder: 'Reason (urgent)', hidden: true,
          style: 'min-height:44px;flex:1 1 180px' })
        const bUrg = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: BTN }, '🚨 Urgent — unpaid')
        bUrg.addEventListener('click', async () => {
          if (reason.hidden) { reason.hidden = false; reason.focus(); say(rowMsg, 'Give the reason (5 to 500 characters), then press Urgent again.'); return }
          bUrg.disabled = true
          const { error: e } = await supabase.rpc('mark_imaging_order_urgent', { p_order: o.id, p_reason: reason.value.trim() })
          if (e) { say(rowMsg, safeErrorMessage(e, 'Could not send it as urgent.'), true); bUrg.disabled = false; return }
          await reload()
        })
        li.append(reason, bUrg)
      }
      if (canWaive(profile) && o.fee_structures) {
        const wReason = el('input', { type: 'text', maxlength: '500', 'aria-label': 'Reason for waiving the imaging charge', placeholder: 'Reason (waiver)', hidden: true,
          style: 'min-height:44px;flex:1 1 180px' })
        const bW = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: BTN }, 'Waive charge')
        bW.addEventListener('click', async () => {
          if (wReason.hidden) { wReason.hidden = false; wReason.focus(); say(rowMsg, 'Give the reason for the waiver (5 to 500 characters), then press Waive again.'); return }
          bW.disabled = true
          const { error: e } = await supabase.rpc('waive_imaging_order', { p_order: o.id, p_reason: wReason.value.trim() })
          if (e) { say(rowMsg, safeErrorMessage(e, 'Could not waive the charge.'), true); bW.disabled = false; return }
          await reload()
        })
        li.append(wReason, bW)
      }
      li.append(rowMsg)
      ul.appendChild(li)
    }
    card.appendChild(ul)
    const vItems = (items || []).filter(i => i.visit_id === v.visit_id)
    if (vItems.length) {
      const slot = el('div')
      card.appendChild(slot)
      await renderOpenChargeIssues(slot, { supabase, tenantId, profile, issues: { items: vItems, notDone: [] }, onChanged: reload })
    }
    const mode = el('select', { 'aria-label': 'Payment mode', style: 'min-height:44px' },
      el('option', { value: 'cash' }, 'Cash'), el('option', { value: 'upi' }, 'UPI'), el('option', { value: 'card' }, 'Card'))
    const ref = el('input', { type: 'text', maxlength: '60', 'aria-label': 'UPI / card transaction reference', placeholder: 'UPI / card reference',
      style: 'min-height:44px;flex:1 1 160px' })
    const bCollect = el('button', { type: 'button', class: 'btn btn-primary', style: BTN }, 'Collect & bill')
    const msg = el('div', { role: 'status', style: NOTE })
    bCollect.addEventListener('click', async () => {
      const ids = checks.filter(c => c.checked).map(c => c.dataset.orderId)
      if (!ids.length) { say(msg, 'Tick at least one study.', true); return }
      if (mode.value !== 'cash' && !ref.value.trim()) { say(msg, 'Enter the UPI / card transaction reference.', true); return }
      bCollect.disabled = true
      say(msg, 'Billing…')
      const { data, error: e } = await supabase.rpc('create_imaging_bill', {
        p_orders: ids, p_payment_mode: mode.value, p_reference: mode.value === 'cash' ? null : ref.value.trim() })
      if (e) { say(msg, safeErrorMessage(e, 'Could not make the bill.'), true); bCollect.disabled = false; return }
      if (data?.status === 'unpriced') {
        say(msg, data.message || 'No price set for one of these studies. Nothing was billed.', true)
        await reload()
        return
      }
      if (onBilled) onBilled(data)
      await reload()
    })
    card.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center' }, mode, ref, bCollect))
    card.appendChild(el('div', { style: NOTE }, 'Radiology does the study once it is paid (or sent as Urgent). The bill is priced by the server from the fee list; the amounts above are an estimate.'))
    card.appendChild(msg)
    container.appendChild(card)
  }
}
