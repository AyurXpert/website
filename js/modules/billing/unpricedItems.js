// unpricedItems.js -- Session 386a (TODO §538, owner decisions Q1-Q9 of 11 Nov 2026; docs/handoff/session386_plan.md).
// The SERVER posts a Panchakarma session's charge when the session is completed (priced from the fee with the same AYUSH code).
// When it cannot price one, it records an "unpriced item" (ipd_unpriced_items) and the lock + the bill wait for it. This module only
// SHOWS that, and lets the people the server allows (Q4) choose the fee or cancel the item with a reason -- every rule and every
// figure is the server's (resolve_ipd_unpriced_item, the admission trigger). Used by nursing.html (Discharge Reconciliation) and
// ipd.html (Generate Bill). DOM nodes + textContent only (therapy names and reasons are entered text); no native confirm() / prompt().
import { safeErrorMessage } from '../../utils/errors.js'
import { el } from './invoiceLayout.js'

const TRAINEE_DESIGS = ['pg_scholar', 'intern', 'nursing_intern']
const TRAINEE_ROLES = ['trainee_doctor', 'student']
const fmtD = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const rupee = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const WARN = 'padding:10px 12px;border:1px solid var(--gold, #c9902a);border-left-width:4px;border-radius:6px;background:#fff8e8;font-size:12.5px;margin:6px 0'
const ERR = 'padding:10px 12px;border:1px solid var(--red, #b03a2e);border-left-width:4px;border-radius:6px;background:#fdf0ee;font-size:12.5px;margin:6px 0'
const todayIst = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)

// Page copy of the server rule (Q4): accountant / finance manager (primary or second role), the Medical Superintendent, the Super Admin;
// active, not a trainee. The server re-checks every call.
export function canResolveUnpriced(p) {
  if (!p || p.status && p.status !== 'active') return false
  if (TRAINEE_DESIGS.includes(p.designation) || TRAINEE_ROLES.includes(p.role) || TRAINEE_ROLES.includes(p.secondary_role)) return false
  return p.role === 'super_admin' || ['accountant', 'finance_manager'].includes(p.role)
    || ['accountant', 'finance_manager'].includes(p.secondary_role) || p.designation === 'medical_superintendent'
}

/** what is still open for an admission: { items: open unpriced items, notDone: PK sessions that block the lock (Q2) } */
export async function loadOpenChargeIssues(supabase, admissionId) {
  const [{ data: items, error: e1 }, { data: sessions, error: e2 }] = await Promise.all([
    supabase.from('ipd_unpriced_items').select('id, source, item_name, item_date, detail, raised_at')
      .eq('ipd_admission_id', admissionId).is('resolved_at', null).order('raised_at'),
    supabase.from('pk_therapy_sessions').select('id, therapy_name, scheduled_date, status')
      .eq('ipd_admission_id', admissionId).in('status', ['in_progress', 'scheduled']).order('scheduled_date'),
  ])
  const today = todayIst()
  return {
    error: e1 || e2 || null,
    items: items || [],
    notDone: (sessions || []).filter(s => s.status === 'in_progress' || (s.scheduled_date && s.scheduled_date <= today)),
  }
}

let _fees = null
async function _procedureFees(supabase, tenantId) {
  if (_fees) return _fees
  const { data, error } = await supabase.from('fee_structures').select('id, label, amount, promo_price, promo_valid_until')
    .eq('tenant_id', tenantId).eq('is_active', true).eq('category', 'procedure').order('label')
  if (error) return []
  _fees = data || []
  return _fees
}

/**
 * renderOpenChargeIssues(container, { supabase, tenantId, profile, issues, onChanged })
 * Shows the sessions to finish / skip and the unpriced items; for an allowed user, each item gets "Choose fee" / "Cancel item".
 * Returns true when nothing is open (the lock / bill may go ahead).
 */
export async function renderOpenChargeIssues(container, { supabase, tenantId, profile, issues, onChanged }) {
  container.replaceChildren()
  const { items, notDone, error } = issues || {}
  if (error) {
    container.appendChild(el('div', { style: ERR, role: 'alert' }, 'Could not check for unpriced items: ' + safeErrorMessage(error, 'please reload.')))
    return false
  }
  if (!items?.length && !notDone?.length) return true

  if (notDone?.length) {
    container.appendChild(el('div', { style: WARN, role: 'status' },
      el('strong', null, 'Mark these Panchakarma sessions completed or skipped before locking charges:'),
      el('ul', { style: 'margin:4px 0 0 18px;padding:0' },
        notDone.map(s => el('li', null, `${s.therapy_name || 'Panchakarma session'} — ${fmtD(s.scheduled_date)}, ${s.status === 'in_progress' ? 'in progress' : 'scheduled, not marked'}`)))))
  }
  if (!items?.length) return false

  const allowed = canResolveUnpriced(profile)
  const fees = allowed ? await _procedureFees(supabase, tenantId) : []
  const box = el('div', { style: ERR, role: 'alert' },
    el('strong', null, 'No price set for these items — the charges cannot be locked and the bill cannot be made until each one is priced or cancelled:'))
  for (const it of items) {
    const row = el('div', { style: 'margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:6px;background:#fff' },
      el('div', { style: 'font-weight:600' }, `${it.item_name} (${it.source === 'pk_session' ? 'Panchakarma session' : it.source}, ${fmtD(it.item_date)})`),
      el('div', { style: 'font-size:11.5px;color:var(--text-muted)' }, it.detail || ''))
    if (!allowed) {
      row.appendChild(el('div', { style: 'font-size:11.5px;margin-top:4px' }, 'The accountant, the finance manager, the Medical Superintendent or the Super Admin chooses its fee or cancels it.'))
    } else {
      const sel = el('select', { 'aria-label': 'Fee for ' + it.item_name, style: 'min-height:36px;max-width:100%' },
        el('option', { value: '' }, 'Choose its fee…'),
        fees.map(f => el('option', { value: f.id }, `${f.label} — ${rupee(f.amount)}`)))
      const reason = el('input', { type: 'text', maxlength: '300', placeholder: 'Reason (required to cancel)', 'aria-label': 'Reason', style: 'min-height:36px;flex:1;min-width:160px' })
      const msg = el('div', { style: 'font-size:11.5px;margin-top:4px', role: 'status' })
      const bPrice = el('button', { type: 'button', class: 'btn btn-primary btn-sm', style: 'min-height:36px' }, 'Price from this fee')
      const bCancel = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:36px' }, 'Cancel item')
      const send = async (feeId) => {
        bPrice.disabled = bCancel.disabled = true
        msg.textContent = 'Saving…'
        const { error: e } = await supabase.rpc('resolve_ipd_unpriced_item', {
          p_item_id: it.id, p_fee_id: feeId, p_reason: reason.value.trim() || null })
        if (e) {
          msg.textContent = safeErrorMessage(e, 'Could not save.')
          bPrice.disabled = bCancel.disabled = false
          return
        }
        msg.textContent = feeId ? 'Priced from the fee.' : 'Cancelled.'
        if (onChanged) await onChanged()
      }
      bPrice.addEventListener('click', () => {
        if (!sel.value) { msg.textContent = 'Choose the fee first.'; return }
        send(sel.value)
      })
      bCancel.addEventListener('click', () => {
        if (reason.value.trim().length < 5) { msg.textContent = 'Give a reason (at least 5 characters) to cancel this item.'; return }
        send(null)
      })
      row.appendChild(el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center' }, sel, reason, bPrice, bCancel))
      row.appendChild(msg)
    }
    box.appendChild(row)
  }
  container.appendChild(box)
  return false
}

/**
 * askInPage(anchor, { title, needReason, okLabel }) -> Promise<string|null>
 * A small in-page panel (no native prompt / confirm): resolves with the reason ('' when no reason is asked) or null when closed.
 */
export function askInPage(anchor, { title, needReason = false, okLabel = 'OK' }) {
  return new Promise(resolve => {
    anchor.replaceChildren()
    const input = needReason ? el('input', { type: 'text', maxlength: '300', 'aria-label': 'Reason', placeholder: 'Reason (at least 5 characters)', style: 'min-height:36px;flex:1;min-width:180px' }) : null
    const msg = el('div', { style: 'font-size:11.5px', role: 'status' })
    const ok = el('button', { type: 'button', class: 'btn btn-primary btn-sm', style: 'min-height:36px' }, okLabel)
    const no = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'min-height:36px' }, 'Back')
    const done = v => { anchor.replaceChildren(); resolve(v) }
    ok.addEventListener('click', () => {
      if (needReason && input.value.trim().length < 5) { msg.textContent = 'Give a reason of at least 5 characters.'; return }
      done(needReason ? input.value.trim() : '')
    })
    no.addEventListener('click', () => done(null))
    anchor.appendChild(el('div', { style: WARN, role: 'dialog', 'aria-label': title },
      el('div', { style: 'font-weight:600;margin-bottom:6px' }, title),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center' }, input, ok, no), msg))
    ;(input || ok).focus()
  })
}
