// chargeRequests.js -- Session 386b-1 (TODO §547, owner Q10 / Q11, 11 Nov 2026; docs/handoff/session386b_plan.md §0a).
// After the charges are locked nobody changes a charge directly: billing staff / the MS / the Super Admin ASK (cancel a line, or add a line),
// and the accountant / finance manager / MS / Super Admin decide -- never the person who asked (the organisation's only active Super Admin
// excepted, audited). The bill waits while a request is open. Every rule is the server's (request_ipd_charge_cancel / _add,
// decide_ipd_charge_request, the admission trigger); this module only shows the requests and sends the clicks.
// DOM nodes + textContent only (descriptions and reasons are entered text); no native confirm() / prompt().
import { safeErrorMessage } from '../../utils/errors.js'
import { canDecideCharge, chargeReasonTypes, REASON_TYPE_LABEL } from '../../utils/chargeRights.js'
import { el } from './invoiceLayout.js'
import { personLabel } from '../../config/roleLabels.js'   // 386b-2b (F1 / F9)

const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const WARN = 'padding:10px 12px;border:1px solid var(--gold, #c9902a);border-left-width:4px;border-radius:6px;background:#fff8e8;font-size:12.5px;margin:6px 0'
const ERR = 'padding:10px 12px;border:1px solid var(--red, #b03a2e);border-left-width:4px;border-radius:6px;background:#fdf0ee;font-size:12.5px;margin:6px 0'

/** the open (pending) charge requests of an admission, oldest first */
export async function loadChargeRequests(supabase, admissionId) {
  const { data, error } = await supabase.from('pending_approvals')
    .select('id, action_type, payload, reason, requested_by, requested_at, status')
    .in('action_type', ['ipd_charge_cancel', 'ipd_charge_add']).eq('status', 'pending')
    .eq('payload->>admission_id', admissionId).order('requested_at')
  // 386b-2b (F1): "Asked by NAME (Role)" -- the requesters' names, never just "staff"
  const ids = [...new Set((data || []).map(q => q.requested_by).filter(Boolean))]
  if (ids.length) {
    const { data: ps } = await supabase.from('profiles').select('id, full_name, role, designation').in('id', ids)
    const byId = new Map((ps || []).map(x => [x.id, personLabel(x.full_name, x.role, x.designation)]))
    for (const q of data || []) q._who = byId.get(q.requested_by) || null
  }
  return { error: error || null, requests: data || [] }
}

/**
 * renderChargeRequests(container, { supabase, profile, requests, error, names, onChanged })
 * Lists the open requests; a decider (not the requester) gets Approve / Reject. Returns true when none is open (the bill may go ahead).
 * names: optional Map(profileId -> name) for "asked by".
 */
export function renderChargeRequests(container, { supabase, profile, requests, error, names, onChanged }) {
  container.replaceChildren()
  if (error) {
    container.appendChild(el('div', { style: ERR, role: 'alert' }, 'Could not check for charge requests: ' + safeErrorMessage(error, 'please reload.')))
    return false
  }
  if (!requests?.length) return true
  const decider = canDecideCharge(profile)
  const box = el('div', { style: WARN, role: 'status' },
    el('strong', null, 'Waiting for a decision — the bill cannot be made until each request is approved or rejected:'))
  for (const q of requests) {
    const p = q.payload || {}
    const what = q.action_type === 'ipd_charge_cancel'
      ? `Cancel: ${p.description || '—'} (${rupee(p.amount)})`
      : `Add a line: ${p.description || '—'} — ${p.quantity} × ${rupee(p.unit_price)} = ${rupee(p.amount)}`
    const who = names?.get?.(q.requested_by) || q._who || 'staff'
    const row = el('div', { style: 'margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:6px;background:#fff' },
      el('div', { style: 'font-weight:600' }, what),
      el('div', { style: 'font-size:11.5px;color:var(--text-muted)' },
        `Asked by ${who} · Reason${p.reason_type ? ' (' + (REASON_TYPE_LABEL[p.reason_type] || p.reason_type) + ')' : ''}: ${q.reason || '—'}`))
    const own = q.requested_by === profile?.id
    if (!decider || own) {
      row.appendChild(el('div', { style: 'font-size:11.5px;margin-top:4px' }, own
        ? 'Your request — another authorised person (accountant, finance manager, Medical Superintendent or Super Admin) decides it.'
        : 'The accountant, the finance manager, the Medical Superintendent or the Super Admin decides this request.'))
    }
    if (decider && (!own || profile?.role === 'super_admin')) {
      const note = el('input', { type: 'text', maxlength: '300', placeholder: 'Note (required to reject)', 'aria-label': 'Decision note', style: 'min-height:36px;flex:1;min-width:160px' })
      const msg = el('div', { style: 'font-size:11.5px;margin-top:4px', role: 'status' })
      const bOk = el('button', { type: 'button', class: 'btn btn-primary btn-sm', style: 'min-height:36px' }, 'Approve')
      const bNo = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:36px' }, 'Reject')
      const send = async approve => {
        if (!approve && note.value.trim().length < 5) { msg.textContent = 'Give the reason for rejecting (at least 5 characters).'; return }
        bOk.disabled = bNo.disabled = true
        msg.textContent = 'Saving…'
        const { error: e } = await supabase.rpc('decide_ipd_charge_request', { p_request_id: q.id, p_approve: approve, p_notes: note.value.trim() || null })
        if (e) { msg.textContent = safeErrorMessage(e, 'Could not save the decision.'); bOk.disabled = bNo.disabled = false; return }
        msg.textContent = approve ? 'Approved.' : 'Rejected.'
        if (onChanged) await onChanged()
      }
      bOk.addEventListener('click', () => send(true))
      bNo.addEventListener('click', () => send(false))
      row.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center' }, note, bOk, bNo))
      row.appendChild(msg)
    }
    box.appendChild(row)
  }
  container.appendChild(box)
  return false
}

/**
 * askChargeReason(anchor, profile, { title, okLabel }) -> Promise<{ type, reason } | null>
 * Session 386b-2b (§564, D1): an in-page panel for an after-lock request -- the reason type this person may give (the ward in-charge:
 * Clinical; the accountant / finance manager: Billing error; the MS / Super Admin choose) + the reason (5-300). null = closed.
 * The server checks the type again (_ipd_charge_reason_type_ok).
 */
export function askChargeReason(anchor, profile, { title, okLabel = 'Send the request' }) {
  return new Promise(resolve => {
    anchor.replaceChildren()
    const types = chargeReasonTypes(profile)
    const msg = el('div', { style: 'font-size:11.5px', role: 'status' })
    if (!types.length) {
      anchor.appendChild(el('div', { style: ERR, role: 'alert' }, 'You cannot ask for this change.'))
      resolve(null)
      return
    }
    const sel = el('select', { 'aria-label': 'Reason type', style: 'min-height:36px' },
      types.map(t => el('option', { value: t }, REASON_TYPE_LABEL[t] || t)))
    if (types.length === 1) sel.disabled = true
    const input = el('input', { type: 'text', maxlength: '300', 'aria-label': 'Reason', placeholder: 'Reason (at least 5 characters)', style: 'min-height:36px;flex:1;min-width:180px' })
    const ok = el('button', { type: 'button', class: 'btn btn-primary btn-sm', style: 'min-height:36px' }, okLabel)
    const no = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:36px' }, 'Back')
    const done = v => { anchor.replaceChildren(); resolve(v) }
    ok.addEventListener('click', () => {
      const r = input.value.trim()
      if (r.length < 5) { msg.textContent = 'Give a reason of at least 5 characters.'; return }
      if (/[<>]/.test(r)) { msg.textContent = 'The reason cannot contain < or >.'; return }
      done({ type: sel.value, reason: r })
    })
    no.addEventListener('click', () => done(null))
    anchor.appendChild(el('div', { style: WARN, role: 'dialog', 'aria-label': title },
      el('div', { style: 'font-weight:600;margin-bottom:6px' }, title),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center' },
        el('label', { style: 'font-size:12px' }, 'Reason type '), sel, input, ok, no), msg))
    input.focus()
  })
}

/**
 * askChargeQuery(anchor, { supabase, admissionId, chargeId, label }) -> Promise<boolean>
 * Session 386b-2b (§564, N2): reception / the cashier ask every ward in-charge to check a locked admission's charges (5-300 characters).
 * The server decides who may send it (send_ipd_charge_query) and who is alerted. Resolves true when sent.
 */
export function askChargeQuery(anchor, { supabase, admissionId, chargeId = null, label = '' }) {
  return new Promise(resolve => {
    anchor.replaceChildren()
    const input = el('input', { type: 'text', maxlength: '300', 'aria-label': 'Your query', placeholder: 'What should the ward in-charge check? (5 to 300 characters)', style: 'min-height:36px;flex:1;min-width:200px' })
    const msg = el('div', { style: 'font-size:11.5px', role: 'status' })
    const ok = el('button', { type: 'button', class: 'btn btn-primary btn-sm', style: 'min-height:36px' }, 'Send to the ward in-charge')
    const no = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:36px' }, 'Back')
    const done = v => { anchor.replaceChildren(); resolve(v) }
    ok.addEventListener('click', async () => {
      const t = input.value.trim()
      if (t.length < 5) { msg.textContent = 'Write at least 5 characters.'; return }
      if (/[<>]/.test(t)) { msg.textContent = 'The query cannot contain < or >.'; return }
      ok.disabled = no.disabled = true
      msg.textContent = 'Sending…'
      const { data, error } = await supabase.rpc('send_ipd_charge_query', { p_admission_id: admissionId, p_charge_id: chargeId, p_text: t })
      if (error) { msg.textContent = safeErrorMessage(error, 'Could not send the query.'); ok.disabled = no.disabled = false; return }
      anchor.replaceChildren(el('div', { style: WARN, role: 'status' },
        `Query sent to ${Number(data) || 0} ward in-charge${Number(data) === 1 ? '' : 's'}. They ask for the change if one is needed.`))
      resolve(true)
    })
    no.addEventListener('click', () => done(false))
    anchor.appendChild(el('div', { style: WARN, role: 'dialog', 'aria-label': 'Ask the ward in-charge' },
      el('div', { style: 'font-weight:600;margin-bottom:6px' }, 'Ask the ward in-charge' + (label ? ' — ' + label : '')),
      el('div', { style: 'font-size:11.5px;margin-bottom:6px' }, 'After the lock only the ward in-charge, the accountant, the finance manager, the Medical Superintendent or the Super Admin can ask to cancel or add a line. Your query alerts every ward in-charge.'),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center' }, input, ok, no), msg))
    input.focus()
  })
}
