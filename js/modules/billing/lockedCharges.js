// lockedCharges.js -- Session 386b-2b (TODO §564, owner D2 / D3, 13 Nov 2026; docs/handoff/session386b2b_plan_v2.md §1.1).
// nursing.html → Discharge Reconciliation → "Charges locked — waiting for the bill": the ward in-charge (Ward Sister, Deputy Nursing
// Superintendent, Nursing Superintendent) sees every admission of the organisation whose charges are locked and whose bill is not made yet
// (D2: the whole organisation), opens its lines, and asks to cancel a line or to add one -- reason type "clinical" (D1). Another person
// (the accountant, finance manager, MS or Super Admin) decides in IPD → 💰. Every rule is the server's (request_ipd_charge_cancel / _add);
// this module only lists and sends. DOM nodes + textContent only (names, descriptions and reasons are entered text).
import { safeErrorMessage } from '../../utils/errors.js'
import { isWardIncharge } from '../../utils/chargeRights.js'
import { askChargeReason, loadChargeRequests, renderChargeRequests } from './chargeRequests.js'
import { el } from './invoiceLayout.js'
let _lcFlash = null   // 386b-2b (F2): the last request message, shown again after the re-render

const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const ROW = 'margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:6px;background:#fff'
const BOX = 'padding:10px 12px;border:1px solid var(--border);border-left:4px solid var(--gold, #c9902a);border-radius:6px;background:#fffdf5;margin-bottom:14px'

/** renderLockedCharges(container, { supabase, tenantId, profile }) -- shown only to a ward in-charge; nothing for anyone else */
export async function renderLockedCharges(container, { supabase, tenantId, profile }) {
  if (!container) return
  container.replaceChildren()
  if (!isWardIncharge(profile)) { container.hidden = true; return }
  container.hidden = false
  const box = el('div', { style: BOX, role: 'region', 'aria-label': 'Charges locked — waiting for the bill' },
    el('div', { style: 'font-weight:700;color:var(--green-deep);margin-bottom:4px' }, 'Charges locked — waiting for the bill'),
    el('div', { style: 'font-size:11.5px;color:var(--text-muted)' },
      'After the lock a line is cancelled or added only by a request (clinical reason). The accountant, the finance manager, the Medical Superintendent or the Super Admin decides it; the bill waits.'))
  container.appendChild(box)
  const { data, error } = await supabase.from('ipd_admissions')
    .select('id, charges_locked_at, patients(name, uhid), beds(bed_number)')
    .eq('tenant_id', tenantId).eq('status', 'charges_locked').order('charges_locked_at', { ascending: true })
  if (error) {
    box.appendChild(el('div', { style: 'color:var(--red, #b03a2e);font-size:12px;margin-top:6px', role: 'alert' }, safeErrorMessage(error, 'Could not load the locked admissions.')))
    return
  }
  if (!data?.length) {
    box.appendChild(el('div', { style: 'font-size:12px;margin-top:6px' }, 'No admission is waiting for its bill.'))
    return
  }
  for (const a of data) box.appendChild(_admRow(a, { supabase, profile }))
}

function _admRow(a, ctx) {
  const lines = el('div', { style: 'margin-top:6px' })
  const btn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:44px', 'aria-expanded': 'false' }, 'Show lines')
  const row = el('div', { style: ROW },
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap' },
      el('div', null,
        el('div', { style: 'font-weight:600' }, a.patients?.name || '—'),
        el('div', { style: 'font-size:11.5px;color:var(--text-muted)' },
          [a.patients?.uhid, a.beds?.bed_number ? 'Bed ' + a.beds.bed_number : null].filter(Boolean).join(' · '))),
      btn),
    lines)
  let open = false
  btn.addEventListener('click', async () => {
    open = !open
    btn.textContent = open ? 'Hide lines' : 'Show lines'
    btn.setAttribute('aria-expanded', String(open))
    if (open) await _renderLines(lines, a.id, ctx)
    else lines.replaceChildren()
  })
  return row
}

async function _renderLines(target, admId, ctx) {
  const { supabase, profile } = ctx
  target.replaceChildren(el('div', { style: 'font-size:12px' }, 'Loading…'))
  const [{ data, error }, req] = await Promise.all([
    supabase.from('ipd_stay_charges').select('id, description, quantity, unit_price, amount, status, source')
      .eq('ipd_admission_id', admId).in('status', ['pending', 'confirmed']).order('added_at'),
    loadChargeRequests(supabase, admId),
  ])
  target.replaceChildren()
  if (error) {
    target.appendChild(el('div', { style: 'color:var(--red, #b03a2e);font-size:12px', role: 'alert' }, safeErrorMessage(error, 'Could not load the lines.')))
    return
  }
  const ask = el('div', { class: 'no-print' })
  const msg = el('div', { style: 'font-size:12px;margin-top:4px', role: 'status' })
  // 386b-2b (F2): an error is red (role alert); the last message survives the re-render after a request
  const setMsg = (text, bad) => { _lcFlash = { text, bad }; msg.textContent = text; msg.style.color = bad ? 'var(--red, #b03a2e)' : 'var(--green-deep, #1a4a2e)'; msg.setAttribute('role', bad ? 'alert' : 'status') }
  if (_lcFlash) { setMsg(_lcFlash.text, _lcFlash.bad); _lcFlash = null }
  const reqBox = el('div')
  renderChargeRequests(reqBox, { supabase, profile, requests: req.requests, error: req.error, onChanged: () => _renderLines(target, admId, ctx) })
  target.appendChild(reqBox)
  if (!data?.length) target.appendChild(el('div', { style: 'font-size:12px' }, 'No open lines.'))
  for (const c of data || []) {
    const b = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:44px' }, 'Ask to cancel')
    b.addEventListener('click', async () => {
      const r = await askChargeReason(ask, profile, { title: 'Reason for cancelling: ' + (c.description || 'this line') })
      if (!r) return
      const { error: e } = await supabase.rpc('request_ipd_charge_cancel', { p_charge_id: c.id, p_reason_type: r.type, p_reason: r.reason })
      setMsg(e ? safeErrorMessage(e, 'Could not send the request.') : 'Request sent — another person decides it; the bill waits.', !!e)
      if (!e) await _renderLines(target, admId, ctx)
    })
    target.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-top:5px;background:#fafff7' },
      el('div', null,
        el('div', { style: 'font-size:12.5px;font-weight:600' }, c.description || '—'),
        el('div', { style: 'font-size:11px;color:var(--text-muted)' }, `${c.quantity} × ${rupee(c.unit_price)} = ${rupee(c.amount)}`)),
      b))
  }
  // + Ask to add a line (description, quantity, price)
  const d = el('input', { type: 'text', maxlength: '200', placeholder: 'Description (not just a number)', 'aria-label': 'Description', style: 'min-height:44px;flex:2;min-width:160px' })
  const q = el('input', { type: 'number', min: '1', step: '1', value: '1', 'aria-label': 'Quantity', style: 'min-height:44px;width:80px' })
  const p = el('input', { type: 'number', min: '0', step: '0.01', placeholder: 'Unit price ₹', 'aria-label': 'Unit price', style: 'min-height:44px;width:120px' })
  const addBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:44px' }, '+ Ask to add')
  addBtn.addEventListener('click', async () => {
    const desc = d.value.trim(); const qty = Number(q.value) || 0; const price = Number(p.value) || 0
    if (desc.length < 2 || /^[0-9.,]+$/.test(desc)) { setMsg('Enter a description (not just a number).', true); return }
    if (qty <= 0 || price <= 0) { setMsg('Enter a quantity and a price above 0.', true); return }
    const r = await askChargeReason(ask, profile, { title: 'Reason for adding: ' + desc })
    if (!r) return
    const { error: e } = await supabase.rpc('request_ipd_charge_add', {
      p_admission_id: admId, p_description: desc, p_quantity: qty, p_unit_price: price, p_reason_type: r.type, p_reason: r.reason })
    setMsg(e ? safeErrorMessage(e, 'Could not send the request.') : 'Request sent — the line is added when another person approves it.', !!e)
    if (!e) await _renderLines(target, admId, ctx)
  })
  target.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px', class: 'no-print' }, d, q, p, addBtn))
  target.appendChild(ask)
  target.appendChild(msg)
}
