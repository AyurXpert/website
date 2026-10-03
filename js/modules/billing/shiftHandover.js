// shiftHandover.js -- Shift Close & Cash Handover (Session 329, TODO_LATER.md §104).
// Two screens, one module:
//   mountMyShift(root, { supabase })        -- anyone who received receipts: see my open receipts, count the cash, close the shift,
//                                              print the handover slip, see my past handovers.
//   mountHandoverReview(root, { supabase, canActOnBehalf }) -- accountant / cashier / finance_manager / dept_admin / super_admin:
//                                              acknowledge or dispute handovers, see who has unclosed receipts from earlier days
//                                              (dept_admin / super_admin can close those on the person's behalf).
// Every number shown comes from the server (shift_preview / list_handovers / handover_detail); the server recomputes the
// system cash, the shortage / excess and the lock when a shift is closed -- nothing typed here is trusted. Whether a slip is
// the Original or a Duplicate copy is decided by record_document_print() when the slip is printed (fail closed).
// Built with createElement / textContent only (no innerHTML): names and remarks are user-entered text.
import { el } from './invoiceLayout.js'
import { safeErrorMessage } from '../../utils/errors.js'
import { printDocument } from '../../utils/printDocument.js'
import { istDateStr, istDayStartUTC } from '../../utils/dateUtils.js'
import { isDemoTenant, demoBannerEl } from './demoBanner.js'

const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' }
const KIND_LABEL = { payment: 'Payment', advance: 'Advance', deposit: 'Deposit', refund: 'Refund' }
const STATUS_LABEL = { submitted: 'Awaiting acknowledgement', acknowledged: 'Acknowledged', disputed: 'Disputed' }
const STATUS_STYLE = {
  submitted: 'background:#fff8e1;color:#92400e;border:1px solid #f59e0b',
  acknowledged: 'background:#f0f7f2;color:#1a4a2e;border:1px solid #4a8c62',
  disputed: 'background:#fdf3f3;color:#c0392b;border:1px solid #c0392b'
}
const DENOMS = ['500', '200', '100', '50', '20', '10']
const BTN = 'min-height:44px;min-width:44px;padding:0 14px;font-size:13px;font-weight:600;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:#fff;color:var(--green-deep)'
const BTN_PRIMARY = BTN.replace('background:#fff;color:var(--green-deep)', 'background:var(--green-deep);color:#fff;border-color:var(--green-deep)')
const BTN_DANGER = BTN.replace('color:var(--green-deep)', 'color:#c0392b;border-color:#c0392b')
const INPUT = 'min-height:44px;font-size:14px;border:1px solid var(--border);border-radius:6px;padding:0 10px;background:#fff;box-sizing:border-box'
const CARD = 'background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px'

const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = n => (Number(n) > 0 ? '+' : Number(n) < 0 ? '−' : '') + inr(Math.abs(Number(n || 0)))
const when = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const num = v => Number(v) || 0

function badge(status) {
  return el('span', { style: `${STATUS_STYLE[status] || ''};border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600;white-space:nowrap` },
    status === 'acknowledged' ? '✔ ' : status === 'disputed' ? '⚠ ' : '', STATUS_LABEL[status] || status)
}

function diffText(d) {
  const v = num(d)
  return v === 0 ? 'Exact — no difference' : v < 0 ? `Shortage ${inr(-v)}` : `Excess ${inr(v)}`
}

// ---------------------------------------------------------------------------------------------------------------------
// Shift window: when the shift started / ended and which receipts it covers (display only -- nothing here is a rule)
//   start = the LATER of the person's first successful login on the IST day of their first receipt and their previous
//           handover's closed_at ("first login" / "previous handover"); with no login record that day: the first
//           receipt's time ("first receipt").
//   end   = closed_at.   receipts = first live receipt -> last live receipt (all of them when every one is void).
// Reads cash_handover_items / cash_handovers / audit_logs (action 'login') through the normal row-level rules; if a read is
// refused or empty the line simply degrades to "first receipt". One batch of three queries per screen, not one per card.
// ---------------------------------------------------------------------------------------------------------------------
export async function loadShiftInfo(supabase, handovers) {
  const hs = (handovers || []).filter(h => h && h.id && h.user_id && h.closed_at)
  const out = {}
  if (!hs.length) return out
  const ids = hs.map(h => h.id)
  const users = [...new Set(hs.map(h => h.user_id))]
  const firstDay = istDateStr(new Date(Math.min(...hs.map(h => new Date(h.period_from || h.closed_at).getTime()))))
  const lastClose = new Date(Math.max(...hs.map(h => new Date(h.closed_at).getTime()))).toISOString()
  const [itemsQ, prevQ, loginQ] = await Promise.all([
    supabase.from('cash_handover_items').select('handover_id, receipt_no, received_at, is_void').in('handover_id', ids).limit(5000),
    supabase.from('cash_handovers').select('id, user_id, closed_at').in('user_id', users).lte('closed_at', lastClose).order('closed_at', { ascending: false }).limit(2000),
    supabase.from('audit_logs').select('user_id, created_at').eq('action', 'login').in('user_id', users)
      .gte('created_at', istDayStartUTC(firstDay)).lte('created_at', lastClose).order('created_at', { ascending: true }).limit(5000)
  ])
  const items = itemsQ.data || [], closes = prevQ.data || [], logins = loginQ.data || []
  for (const h of hs) {
    const mine = items.filter(i => i.handover_id === h.id).sort((a, b) => new Date(a.received_at) - new Date(b.received_at))
    const live = mine.filter(i => !i.is_void)
    const span = live.length ? live : mine
    const first = span[0] || null, last = span[span.length - 1] || null
    const firstAt = first ? new Date(first.received_at) : new Date(h.period_from || h.closed_at)
    const dayStart = new Date(istDayStartUTC(istDateStr(firstAt)))
    const closedAt = new Date(h.closed_at)
    const login = logins.find(l => l.user_id === h.user_id && new Date(l.created_at) >= dayStart && new Date(l.created_at) <= closedAt)
    const prev = closes.filter(c => c.user_id === h.user_id && c.id !== h.id && new Date(c.closed_at) < closedAt)
      .map(c => new Date(c.closed_at)).sort((a, b) => b - a)[0] || null
    let start, basis
    if (login) {
      const l = new Date(login.created_at)
      if (prev && prev > l) { start = prev; basis = 'previous handover' } else { start = l; basis = 'first login' }
    } else { start = firstAt; basis = 'first receipt' }
    out[h.id] = { start: start.toISOString(), basis, end: h.closed_at,
      first: first && { no: first.receipt_no, at: first.received_at }, last: last && { no: last.receipt_no, at: last.received_at } }
  }
  return out
}

const timeOnly = iso => iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—'
const startText = i => `${when(i.start)} (${i.basis})`
const receiptsText = i => i.first ? `${i.first.no} · ${timeOnly(i.first.at)}  →  ${i.last.no} · ${timeOnly(i.last.at)}` : '—'

// ---------------------------------------------------------------------------------------------------------------------
// The slip (printed through the print audit)
// ---------------------------------------------------------------------------------------------------------------------
function buildSlip(d, copy, info, demo = false) {
  let tenant = {}
  try { tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}') || {} } catch { /* none */ }
  const isDup = copy.copy !== 'ORIGINAL'
  const th = 'text-align:left;border-bottom:1px solid #999;padding:3px 6px;font-size:12px'
  const td = 'padding:3px 6px;font-size:12px;border-bottom:1px solid #ddd'
  const tdr = td + ';text-align:right'
  const row = (a, b, bold) => el('tr', null, el('td', { style: td + (bold ? ';font-weight:700' : '') }, a), el('td', { style: tdr + (bold ? ';font-weight:700' : '') }, b))
  const nonCash = Object.entries(d.non_cash || {}).filter(([, v]) => num(v) !== 0)
  const dens = d.denominations ? Object.entries(d.denominations) : []
  const sigLine = (label, name) => el('div', { style: 'flex:1;min-width:200px' },
    el('div', { style: 'height:46px;border-bottom:1px solid #000' }),
    el('div', { style: 'font-size:12px;margin-top:4px' }, label), name ? el('div', { style: 'font-size:11px;color:#555' }, name) : null)

  return el('div', { style: 'font-family:\'DM Sans\',Arial,sans-serif;color:#000;padding:4px;position:relative' },
    // a demo organisation's slip is a test document -- same banner as its bills (flag read from the server, not the cache)
    demo ? demoBannerEl() : null,
    el('div', { style: 'text-align:center;border-bottom:2px solid #1a4a2e;padding-bottom:8px;margin-bottom:10px' },
      el('div', { style: 'font-family:\'Cormorant Garamond\',Georgia,serif;font-size:22px;font-weight:600;color:#1a4a2e' }, tenant.name || ''),
      el('div', { style: 'font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-top:2px' }, 'Shift Handover'),
      el('div', { style: 'font-size:12px;font-weight:700;margin-top:2px' }, isDup ? `DUPLICATE COPY · No. ${copy.print_no}` : 'Original'),
      el('div', { style: 'font-size:16px;font-weight:700;margin-top:6px' }, d.user_name || '—'),
      el('div', { style: 'font-size:11px;color:#555' }, d.user_role ? `Cash handed over by (${d.user_role})` : 'Cash handed over by')),
    el('table', { style: 'width:100%;border-collapse:collapse;margin-bottom:8px' },
      el('tbody', null,
        row('Handover no.', d.handover_no, true),
        info ? row('Shift start', startText(info)) : row('Period (oldest receipt)', when(d.period_from)),
        row('Shift end', when(d.closed_at)),
        info ? row('Receipts', receiptsText(info)) : null,
        d.on_behalf ? row('Closed on their behalf by', d.closed_by_name || '—') : null,
        row('Live receipts / voided (excluded)', `${d.receipt_count} / ${d.void_count}`))),
    el('div', { style: 'font-weight:700;font-size:13px;margin:8px 0 2px' }, 'Cash'),
    el('table', { style: 'width:100%;border-collapse:collapse' },
      el('tbody', null,
        row('Cash received', inr(d.cash_received)),
        row('Less: cash refunded', inr(d.cash_refunded)),
        row('Cash to be handed over (system)', inr(d.system_cash), true),
        row('Cash counted', inr(d.counted_cash), true),
        row('Difference', `${diffText(d.difference)}`, true))),
    dens.length ? el('div', null,
      el('div', { style: 'font-weight:700;font-size:13px;margin:8px 0 2px' }, 'Denomination count'),
      el('table', { style: 'width:100%;border-collapse:collapse' }, el('tbody', null,
        dens.map(([k, v]) => row(k === 'coins' ? 'Coins' : `₹${k} × ${v}`, k === 'coins' ? inr(v) : inr(num(k) * num(v))))))) : null,
    nonCash.length ? el('div', null,
      el('div', { style: 'font-weight:700;font-size:13px;margin:8px 0 2px' }, 'Other modes (listed — not cash, not handed over)'),
      el('table', { style: 'width:100%;border-collapse:collapse' }, el('tbody', null, nonCash.map(([k, v]) => row(MODE_LABEL[k] || k, inr(v)))))) : null,
    d.remark ? el('div', { style: 'font-size:12px;margin-top:8px' }, el('strong', null, 'Remark: '), d.remark) : null,
    d.items && d.items.length ? el('div', null,
      el('div', { style: 'font-weight:700;font-size:13px;margin:10px 0 2px' }, 'Receipts in this handover'),
      el('table', { style: 'width:100%;border-collapse:collapse' },
        el('thead', null, el('tr', null, ['Receipt', 'Time', 'Type', 'Mode', 'Amount'].map((h, i) => el('th', { style: th + (i === 4 ? ';text-align:right' : '') }, h)))),
        el('tbody', null, d.items.map(i => el('tr', { style: i.is_void ? 'text-decoration:line-through;color:#777' : '' },
          el('td', { style: td }, i.receipt_no), el('td', { style: td }, when(i.received_at)),
          el('td', { style: td }, (KIND_LABEL[i.kind] || i.kind) + (i.is_void ? ' — void, excluded' : '')),
          el('td', { style: td }, MODE_LABEL[i.mode] || i.mode),
          el('td', { style: tdr }, (i.kind === 'refund' ? '−' : '') + inr(i.amount))))))) : null,
    el('div', { style: 'display:flex;gap:28px;flex-wrap:wrap;margin-top:34px' },
      sigLine('Handed over by (signature)', d.user_name), sigLine('Received by — Accounts (signature)', d.decided_by_name || '')),
    el('div', { style: 'font-size:10px;color:#555;margin-top:12px' },
      isDup ? `Duplicate copy no. ${copy.print_no}. The original was first printed ${when(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}. ` : '',
      'Computer-generated handover slip · Powered by AyurXpert'))
}

// Records the print on the server (Original / Duplicate decided there) and only then prints. Fails closed.
async function printSlip(supabase, handoverId, statusEl) {
  const detail = await supabase.rpc('handover_detail', { p_id: handoverId })
  if (detail.error || !detail.data) { statusEl.textContent = safeErrorMessage(detail.error, 'Could not load this handover. Please try again.'); return }
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'handover', p_doc_id: handoverId })
  if (rec.error || !rec.data) { statusEl.textContent = safeErrorMessage(rec.error, 'Could not record this print. Please try again.'); return }
  statusEl.textContent = ''
  let info = null
  try {
    const { data: row } = await supabase.from('cash_handovers').select('id, user_id, closed_at, period_from').eq('id', handoverId).single()
    if (row) info = (await loadShiftInfo(supabase, [row]))[handoverId] || null
  } catch { /* the slip still prints, with the period line */ }
  const demo = await isDemoTenant(supabase, sessionStorage.getItem('ayurxpert_tenant_id'))
  printDocument(buildSlip(detail.data, rec.data, info, demo), { title: `Shift Handover ${detail.data.handover_no}` })
}

// ---------------------------------------------------------------------------------------------------------------------
// The close form (my shift, or someone else's shift when closing on their behalf)
// ---------------------------------------------------------------------------------------------------------------------
function totalsTable(p) {
  const nonCash = Object.entries(p.non_cash || {}).filter(([, v]) => num(v) !== 0)
  const line = (a, b, bold) => el('tr', null, el('td', { style: `padding:6px 8px;border-bottom:1px solid var(--border)${bold ? ';font-weight:700' : ''}` }, a),
    el('td', { style: `padding:6px 8px;border-bottom:1px solid var(--border);text-align:right${bold ? ';font-weight:700' : ''}` }, b))
  return el('table', { style: 'width:100%;border-collapse:collapse;font-size:14px' }, el('tbody', null,
    line('Cash received', inr(p.cash_received)),
    line('Less: cash refunded', inr(p.cash_refunded)),
    line('Cash to hand over (system)', inr(p.system_cash), true),
    nonCash.map(([k, v]) => line(`${MODE_LABEL[k] || k} (not cash — listed only)`, inr(v))),
    line('Live receipts', String(p.receipt_count)),
    p.void_count ? line('Voided receipts (shown, excluded from every total)', `${p.void_count} · ${inr(p.void_amount)}`) : null))
}

function receiptList(p) {
  const th = 'text-align:left;padding:4px 8px;font-size:12px;border-bottom:1px solid var(--border);color:var(--text-mid)'
  const td = 'padding:4px 8px;font-size:13px;border-bottom:1px solid var(--border)'
  return el('div', { style: 'overflow-x:auto' }, el('table', { style: 'width:100%;border-collapse:collapse' },
    el('thead', null, el('tr', null, ['Receipt', 'Time', 'Patient', 'Type', 'Mode', 'Amount'].map((h, i) => el('th', { style: th + (i === 5 ? ';text-align:right' : '') }, h)))),
    el('tbody', null, (p.receipts || []).map(r => el('tr', { style: r.voided ? 'text-decoration:line-through;color:#777' : '' },
      el('td', { style: td }, r.receipt_no), el('td', { style: td }, when(r.received_at)), el('td', { style: td }, r.patient || '—'),
      el('td', { style: td }, (KIND_LABEL[r.kind] || r.kind) + (r.voided ? ' — void, excluded' : '')), el('td', { style: td }, MODE_LABEL[r.mode] || r.mode),
      el('td', { style: td + ';text-align:right' }, (r.kind === 'refund' ? '−' : '') + inr(r.amount)))))))
}

function closeForm(supabase, preview, { onBehalfOf = null, onDone }) {
  const counted = el('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', id: 'sh-counted', style: INPUT + ';width:180px', 'aria-label': 'Cash counted in rupees' })
  const denomBox = el('div', { style: 'display:none;margin:8px 0' })
  const denomInputs = {}
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px' })
  for (const d of DENOMS) {
    const inp = el('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', style: INPUT + ';width:100%', 'aria-label': `Number of ₹${d} notes` })
    denomInputs[d] = inp
    grid.appendChild(el('label', { style: 'font-size:12px;display:flex;flex-direction:column;gap:2px' }, `₹${d} notes`, inp))
  }
  const coins = el('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', style: INPUT + ';width:100%', 'aria-label': 'Coins total in rupees' })
  grid.appendChild(el('label', { style: 'font-size:12px;display:flex;flex-direction:column;gap:2px' }, 'Coins (₹ total)', coins))
  const denomTotal = el('div', { style: 'font-size:13px;margin-top:6px;font-weight:600' })
  denomBox.append(grid, denomTotal)
  const useDenoms = el('input', { type: 'checkbox', id: 'sh-denoms', style: 'width:18px;height:18px;margin:0' })
  const useLabel = el('label', { for: 'sh-denoms', style: 'display:inline-flex;align-items:center;gap:8px;min-height:44px;font-size:13px;cursor:pointer' }, useDenoms, 'Count by denomination (optional)')
  const remark = el('textarea', { id: 'sh-remark', rows: '2', maxlength: '300', style: INPUT + ';width:100%;padding:8px 10px', 'aria-label': 'Remark' })
  const remarkLbl = el('label', { for: 'sh-remark', style: 'font-size:13px;font-weight:600;display:block;margin-bottom:4px' })
  const diff = el('div', { role: 'status', 'aria-live': 'polite', style: 'font-size:14px;font-weight:700;margin:8px 0' })
  const msg = el('div', { role: 'alert', style: 'font-size:13px;color:#c0392b;margin:6px 0;min-height:18px' })
  const submit = el('button', { type: 'button', style: BTN_PRIMARY }, onBehalfOf ? 'Close this shift on their behalf' : 'Close shift & hand over')
  const system = num(preview.system_cash)

  function denomSum() {
    let s = 0
    for (const d of DENOMS) s += (Math.floor(num(denomInputs[d].value)) || 0) * Number(d)
    return s + num(coins.value)
  }
  function refresh() {
    if (useDenoms.checked) { const s = denomSum(); counted.value = s ? String(Math.round(s * 100) / 100) : ''; denomTotal.textContent = `Denomination total: ${inr(s)}` }
    const has = counted.value !== ''
    const d = Math.round((num(counted.value) - system) * 100) / 100
    diff.textContent = has ? `${diffText(d)} (the server recomputes this when you close)` : ''
    diff.style.color = !has || d === 0 ? 'var(--green-deep)' : '#c0392b'
    const needRemark = onBehalfOf || (has && d !== 0)
    remarkLbl.textContent = needRemark ? (onBehalfOf ? 'Remark — why this shift is closed on their behalf (required)' : 'Remark — explain the difference (required)') : 'Remark (optional)'
  }
  useDenoms.addEventListener('change', () => { denomBox.style.display = useDenoms.checked ? 'block' : 'none'; counted.readOnly = useDenoms.checked; refresh() })
  for (const i of [counted, coins, remark, ...Object.values(denomInputs)]) i.addEventListener('input', () => { msg.textContent = ''; refresh() })

  submit.addEventListener('click', async () => {
    msg.textContent = ''
    if (counted.value === '') { msg.textContent = 'Enter the cash you counted (0 if none).'; counted.focus(); return }
    submit.disabled = true
    const args = { p_counted: num(counted.value), p_remark: remark.value.trim() || null, p_expected_cash: system, p_on_behalf_of: onBehalfOf }
    if (useDenoms.checked) {
      const dn = {}
      for (const d of DENOMS) { const n = Math.floor(num(denomInputs[d].value)); if (n > 0) dn[d] = n }
      if (num(coins.value) > 0) dn.coins = num(coins.value)
      args.p_denominations = dn
    }
    const { data, error } = await supabase.rpc('close_shift', args)
    submit.disabled = false
    if (error) { msg.textContent = safeErrorMessage(error, 'Could not close the shift. Please try again.'); return }
    onDone(data)
  })

  refresh()
  return el('div', { style: 'margin-top:12px' },
    el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end' },
      el('label', { for: 'sh-counted', style: 'font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px' }, 'Cash counted (₹)', counted), useLabel),
    denomBox, diff, remarkLbl, remark, msg, submit)
}

// ---------------------------------------------------------------------------------------------------------------------
// My shift
// ---------------------------------------------------------------------------------------------------------------------
export function mountMyShift(root, { supabase }) {
  const status = el('div', { role: 'status', 'aria-live': 'polite', style: 'font-size:13px;color:var(--text-mid);margin:6px 0' })
  const current = el('div')
  const history = el('div')
  root.replaceChildren(el('div', { style: 'padding:4px' }, status, current,
    el('h2', { style: 'font-family:\'Cormorant Garamond\',serif;font-size:1.3rem;color:var(--green-deep);margin:18px 0 8px' }, 'My past handovers'), history))

  async function loadHistory() {
    const { data, error } = await supabase.rpc('list_handovers', { p_scope: 'mine' })
    if (error) { history.replaceChildren(el('div', { style: 'font-size:13px;color:#c0392b' }, safeErrorMessage(error, 'Could not load your handovers.'))); return }
    const rows = data?.rows || []
    if (!rows.length) { history.replaceChildren(el('div', { style: 'font-size:13px;color:var(--text-mid)' }, 'No handovers yet.')); return }
    const info = await loadShiftInfo(supabase, rows)
    history.replaceChildren(...rows.map(h => handoverCard(h, { supabase, status, actions: [], info: info[h.id] })))
  }

  async function load() {
    status.textContent = 'Loading…'
    const { data, error } = await supabase.rpc('shift_preview')
    if (error) { status.textContent = safeErrorMessage(error, 'Could not load your shift. Please try again.'); return }
    status.textContent = ''
    if (!data.receipts || !data.receipts.length) {
      current.replaceChildren(el('div', { style: CARD }, el('strong', null, 'Nothing to close. '),
        'You have no receipts since your last handover.' + (data.last_closed_at ? ` Last closed ${when(data.last_closed_at)}.` : '')))
      return
    }
    const card = el('div', { style: CARD })
    card.appendChild(el('h2', { style: 'font-family:\'Cormorant Garamond\',serif;font-size:1.3rem;color:var(--green-deep);margin-bottom:4px' }, 'Close my shift'))
    card.appendChild(el('div', { style: 'font-size:13px;color:var(--text-mid);margin-bottom:8px' },
      `${data.user?.name || ''} · receipts since ${when(data.period_from)}`))
    if (data.from_earlier_days) card.appendChild(el('div', { style: 'background:#fff8e1;border-left:4px solid #f59e0b;color:#92400e;padding:8px 12px;font-size:13px;margin-bottom:8px' },
      'These receipts include earlier days — a shift should be closed at the end of each day.'))
    card.append(totalsTable(data), el('details', { style: 'margin-top:8px' }, el('summary', { style: 'cursor:pointer;font-size:13px;font-weight:600;min-height:32px' }, 'Receipts in this shift'), receiptList(data)),
      closeForm(supabase, data, {
        onDone: async res => {
          current.replaceChildren(el('div', { style: CARD },
            el('h2', { style: 'font-family:\'Cormorant Garamond\',serif;font-size:1.3rem;color:var(--green-deep)' }, `Shift closed — ${res.handover_no}`),
            el('div', { style: 'font-size:14px;margin:6px 0' }, `System cash ${inr(res.system_cash)} · counted ${inr(res.counted_cash)} · ${diffText(res.difference)}`),
            el('div', { style: 'font-size:13px;color:var(--text-mid);margin-bottom:8px' }, 'Hand the cash and this slip to Accounts, who will acknowledge it. These receipts are now locked.'),
            printButton(supabase, res.id, status)))
          await loadHistory()
        }
      }))
    current.replaceChildren(card)
  }
  load(); loadHistory()
}

function printButton(supabase, id, statusEl) {
  const b = el('button', { type: 'button', style: BTN }, '🖨 Print handover slip')
  b.addEventListener('click', () => printSlip(supabase, id, statusEl))
  return b
}

// One handover as a card. `actions` = extra buttons (acknowledge / dispute) supplied by the review screen.
function handoverCard(h, { supabase, status, actions, info }) {
  const money = (label, v) => el('div', { style: 'min-width:130px' }, el('div', { style: 'font-size:11px;color:var(--text-mid)' }, label), el('div', { style: 'font-weight:700;font-size:14px' }, v))
  const d = num(h.difference)
  return el('div', { style: CARD },
    el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between' },
      el('div', null, el('strong', { style: 'font-size:15px' }, h.user_name || '—'), el('span', { style: 'font-size:13px' }, `  ${h.handover_no}`),
        el('span', { style: 'font-size:12px;color:var(--text-mid)' }, ` · closed ${when(h.closed_at)}`),
        h.on_behalf ? el('div', { style: 'font-size:12px;color:#92400e' }, `Closed on their behalf by ${h.closed_by_name || '—'}`) : null),
      badge(h.status)),
    info ? el('div', { style: 'font-size:12px;color:var(--text-dark);margin-top:6px;line-height:1.5' },
      el('div', null, el('strong', null, 'Shift: '), `${startText(info)}  →  ${when(info.end)}`),
      el('div', null, el('strong', null, 'Receipts: '), receiptsText(info))) : null,
    el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;margin:8px 0' },
      money('System cash', inr(h.system_cash)), money('Counted', inr(h.counted_cash)),
      el('div', { style: 'min-width:130px' }, el('div', { style: 'font-size:11px;color:var(--text-mid)' }, 'Difference'),
        el('div', { style: `font-weight:700;font-size:14px;color:${d === 0 ? 'var(--green-deep)' : '#c0392b'}` }, d === 0 ? 'Exact' : (d < 0 ? 'Shortage ' : 'Excess ') + inr(Math.abs(d)))),
      money('Receipts', `${h.receipt_count}${h.void_count ? ` (+${h.void_count} void)` : ''}`)),
    h.remark ? el('div', { style: 'font-size:13px' }, el('strong', null, 'Remark: '), h.remark) : null,
    h.status !== 'submitted' ? el('div', { style: 'font-size:12px;color:var(--text-mid);margin-top:4px' },
      `${h.status === 'acknowledged' ? 'Acknowledged' : 'Disputed'} by ${h.decided_by_name || '—'} · ${when(h.decided_at)}${h.decision_remark ? ' — ' + h.decision_remark : ''}`) : null,
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' }, printButton(supabase, h.id, status), actions))
}

// ---------------------------------------------------------------------------------------------------------------------
// Review (checker roles)
// ---------------------------------------------------------------------------------------------------------------------
export function mountHandoverReview(root, { supabase, canActOnBehalf }) {
  const status = el('div', { role: 'status', 'aria-live': 'polite', style: 'font-size:13px;color:var(--text-mid);margin:6px 0' })
  const unclosed = el('div')
  const list = el('div')
  const filter = el('select', { style: INPUT, 'aria-label': 'Filter by status' },
    el('option', { value: '' }, 'All statuses'), el('option', { value: 'submitted' }, STATUS_LABEL.submitted),
    el('option', { value: 'disputed' }, STATUS_LABEL.disputed), el('option', { value: 'acknowledged' }, STATUS_LABEL.acknowledged))
  root.replaceChildren(el('div', { style: 'padding:4px' }, status, unclosed,
    el('div', { style: 'display:flex;gap:10px;align-items:center;margin:14px 0 8px;flex-wrap:wrap' },
      el('h2', { style: 'font-family:\'Cormorant Garamond\',serif;font-size:1.3rem;color:var(--green-deep);margin:0' }, 'Handovers'), filter), list))

  async function loadUnclosed() {
    const { data, error } = await supabase.rpc('unclosed_shifts')
    if (error) { unclosed.replaceChildren(el('div', { style: 'font-size:13px;color:#c0392b' }, safeErrorMessage(error, 'Could not load the unclosed shifts.'))); return }
    const rows = data?.rows || []
    if (!rows.length) { unclosed.replaceChildren(el('div', { style: CARD + ';border-left:4px solid #4a8c62' }, '✔ Every shift from earlier days has been closed.')); return }
    const card = el('div', { style: CARD + ';border-left:4px solid #f59e0b' },
      el('h2', { style: 'font-family:\'Cormorant Garamond\',serif;font-size:1.3rem;color:#92400e;margin-bottom:6px' }, '⚠ Unclosed shifts from earlier days'))
    for (const r of rows) {
      const slot = el('div')
      const open = el('button', { type: 'button', style: BTN }, 'Close on their behalf')
      open.addEventListener('click', async () => {
        const { data: p, error: e } = await supabase.rpc('shift_preview', { p_user: r.user_id })
        if (e) { status.textContent = safeErrorMessage(e, 'Could not load that shift.'); return }
        slot.replaceChildren(el('div', { style: 'border-top:1px solid var(--border);margin-top:8px;padding-top:8px' }, totalsTable(p),
          closeForm(supabase, p, { onBehalfOf: r.user_id, onDone: async () => { status.textContent = `Closed ${r.name || 'the'} shift on their behalf.`; await Promise.all([loadUnclosed(), loadList()]) } })))
      })
      card.appendChild(el('div', { style: 'border-top:1px solid var(--border);padding:8px 0' },
        el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between' },
          el('div', null, el('strong', null, r.name || 'Unknown user'), el('span', { style: 'font-size:12px;color:var(--text-mid)' }, ` · ${r.designation || r.role || ''}`),
            el('div', { style: 'font-size:12px' }, `${r.receipts} receipt(s)${r.voids ? ` + ${r.voids} void` : ''} · cash ${inr(r.cash)} · oldest ${when(r.oldest)}`)),
          canActOnBehalf ? open : el('span', { style: 'font-size:12px;color:var(--text-mid)' }, 'A dept_admin / super_admin can close it')), slot))
    }
    unclosed.replaceChildren(card)
  }

  function decisionActions(h) {
    if (h.status === 'acknowledged') return []
    const box = el('div', { style: 'flex-basis:100%;display:none;margin-top:6px' })
    const note = el('textarea', { rows: '2', maxlength: '300', style: INPUT + ';width:100%;padding:8px 10px', 'aria-label': 'Remark for this decision' })
    const err = el('div', { role: 'alert', style: 'font-size:13px;color:#c0392b;min-height:16px' })
    let decision = 'acknowledge'
    const go = el('button', { type: 'button', style: BTN_PRIMARY }, 'Confirm')
    go.addEventListener('click', async () => {
      err.textContent = ''
      go.disabled = true
      const { error } = await supabase.rpc('acknowledge_handover', { p_id: h.id, p_decision: decision, p_remark: note.value.trim() || null })
      go.disabled = false
      if (error) { err.textContent = safeErrorMessage(error, 'Could not save the decision. Please try again.'); return }
      await loadList()
    })
    box.append(el('label', { style: 'font-size:12px;font-weight:600;display:block;margin-bottom:2px' }, 'Remark (required to dispute' + (h.status === 'disputed' ? ' / to resolve a dispute' : '') + ')'), note, err, go)
    const ack = el('button', { type: 'button', style: BTN_PRIMARY }, h.status === 'disputed' ? '✔ Resolve & acknowledge' : '✔ Acknowledge')
    ack.addEventListener('click', () => { decision = 'acknowledge'; box.style.display = 'block'; note.focus() })
    const dis = el('button', { type: 'button', style: BTN_DANGER }, '⚠ Dispute')
    dis.addEventListener('click', () => { decision = 'dispute'; box.style.display = 'block'; note.focus() })
    return [ack, h.status === 'disputed' ? null : dis, box]
  }

  async function loadList() {
    const { data, error } = await supabase.rpc('list_handovers', { p_scope: 'review', p_status: filter.value || null })
    if (error) { list.replaceChildren(el('div', { style: 'font-size:13px;color:#c0392b' }, safeErrorMessage(error, 'Could not load the handovers.'))); return }
    const rows = data?.rows || []
    if (!rows.length) { list.replaceChildren(el('div', { style: 'font-size:13px;color:var(--text-mid)' }, 'No handovers match.')); return }
    const info = await loadShiftInfo(supabase, rows)
    list.replaceChildren(...rows.map(h => handoverCard(h, { supabase, status, actions: decisionActions(h), info: info[h.id] })))
  }
  filter.addEventListener('change', loadList)
  loadUnclosed(); loadList()
}
