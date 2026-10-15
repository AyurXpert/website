// gstFilings.js -- Finance -> 📑 GST returns: "mark as filed", the filing history with corrections, and the filing frequency
// (Session 345n, GST Stage 7b; owner decisions G11-G13). The server decides everything (mark_gst_return_filed / correct_gst_return_filing
// -- active finance_manager / super_admin; set_gst_filing_frequency -- the organisation's super_admin; gst_return_filings -- the report
// roles); these panels only collect the input and show the answer. A filing record is never changed or deleted: a correction is a new
// entry naming the one it corrects, with a reason (the statutory-register rule; the old entry is shown struck through).
// The shared "Correct entry" UI (js/modules/registers/corrections.js) writes the correcting row straight into its table; these records
// are written only through the RPCs above (the table is select-only), so the same conventions are followed here instead.
// DOM nodes + textContent only; no native confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js'
import { todayISTStr } from '../../utils/dateUtils.js'
import { el } from '../billing/invoiceLayout.js'
import { gstDate } from './gstReturnsExport.js'

export const RETURN_LABEL = { GSTR1: 'GSTR-1', GSTR3B: 'GSTR-3B', CMP08: 'CMP-08', GSTR4: 'GSTR-4' }
const FREQ_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly (QRMP)' }

function btn(label, onClick, { go = false, title = null } = {}) {
  const b = el('button', { type: 'button', class: go ? 'cn-btn cn-btn-go' : 'cn-btn', title }, label)
  b.addEventListener('click', onClick)
  return b
}
const lbl = (text, input) => el('label', { class: 'gr-lbl' }, el('span', null, text), input)

// the returns that fit the period on screen (the server checks the period again)
function returnChoices(report) {
  const comp = report?.organisation?.scheme_on_to === 'composition' || report?.organisation?.scheme_on_from === 'composition'
  return comp ? ['CMP08', 'GSTR4'] : ['GSTR1', 'GSTR3B']
}

/** The "Filing" block for the period on screen: the returns marked filed (matches / DIFFERS) and, for those who may, "Mark as filed". */
export function filingPanel({ supabase, report, canMark, onChange }) {
  const p = report?.period || {}, today = todayISTStr()
  const box = el('section', { class: 'gr-sec gr-filing' }, el('h4', { class: 'gr-h' }, 'Filing'),
    el('p', { class: 'cn-sub' }, `Filing frequency: ${FREQ_LABEL[report?.filing_frequency] || 'Monthly'}. Record here that a return was filed on the GST portal (the figures shown now are kept with it).`))
  const list = report?.filing || []
  if (list.length) {
    box.appendChild(el('ul', { class: 'gr-filed' }, list.map(f => el('li', { class: f.matches ? 'gr-ok' : 'gr-bad' },
      `${RETURN_LABEL[f.return_type] || f.return_type} filed on ${gstDate(f.filed_on)}${f.arn ? ' · ARN ' + f.arn : ''} (entry ${f.entry_no}) — `,
      f.matches ? '✔ the figures match what was filed.' : '✖ the figures now DIFFER from what was filed — do not refile; report this to support.'))))
  } else {
    box.appendChild(el('p', { class: 'cn-sub' }, 'No return is marked filed for exactly this period.'))
  }
  if (!canMark) return box
  if (!(p.to && p.to < today)) {
    box.appendChild(el('p', { class: 'cn-sub' }, 'A period can be marked filed once it has ended.'))
    return box
  }
  const ret = el('select', { class: 'cn-sel', 'aria-label': 'Return' }, returnChoices(report).map(r => el('option', { value: r }, RETURN_LABEL[r])))
  const on = el('input', { type: 'date', class: 'cn-input', value: today, max: today, 'aria-label': 'Filed on' })
  const arn = el('input', { type: 'text', class: 'cn-input', maxlength: '20', placeholder: 'ARN (optional)', 'aria-label': 'ARN', autocomplete: 'off' })
  const st = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
  const go = btn('✔ Mark as filed', async () => {
    go.disabled = true; st.textContent = 'Saving…'; st.className = 'cn-status'
    const { error } = await supabase.rpc('mark_gst_return_filed', { p_return: ret.value, p_from: p.from, p_to: p.to, p_filed_on: on.value || null,
      p_arn: arn.value.trim() || null })
    go.disabled = false
    if (error) { st.textContent = safeErrorMessage(error, 'Could not mark it filed.'); st.className = 'cn-status err'; return }
    st.textContent = 'Marked filed.'; st.className = 'cn-status ok'
    onChange?.()
  }, { go: true })
  box.appendChild(el('div', { class: 'cn-row' }, lbl('Return', ret), lbl('Filed on', on), lbl('ARN', arn), go))
  box.appendChild(st)
  return box
}

/** The filing history (every entry, corrections struck through) + "Correct", and the filing frequency setting. */
export function mountFilingHistory(root, { supabase, canMark, canFreq, onChange }) {
  const st = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
  const list = el('div'), freq = el('div')
  root.replaceChildren(el('details', { class: 'gr-history' }, el('summary', null, 'Filing history and filing frequency'), freq, st, list))

  if (canFreq) {
    const today = todayISTStr(), y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))
    const q0 = new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1))
    const starts = [0, 1, 2, 3].map(k => { const d = new Date(q0); d.setUTCMonth(d.getUTCMonth() + 3 * k); return d.toISOString().slice(0, 10) })
    const f = el('select', { class: 'cn-sel', 'aria-label': 'Filing frequency' }, el('option', { value: 'monthly' }, 'Monthly'), el('option', { value: 'quarterly' }, 'Quarterly (QRMP)'))
    const from = el('select', { class: 'cn-sel', 'aria-label': 'From' }, starts.map(s => el('option', { value: s }, 'from ' + gstDate(s))))
    const why = el('input', { type: 'text', class: 'cn-input', maxlength: '300', placeholder: 'Reason / reference (optional)', 'aria-label': 'Reason' })
    const fst = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
    const save = btn('Save filing frequency', async () => {
      save.disabled = true
      const { error } = await supabase.rpc('set_gst_filing_frequency', { p_frequency: f.value, p_effective_from: from.value, p_reason: why.value.trim() || null })
      save.disabled = false
      if (error) { fst.textContent = safeErrorMessage(error, 'Could not save the filing frequency.'); fst.className = 'cn-status err'; return }
      fst.textContent = 'Saved.'; fst.className = 'cn-status ok'; onChange?.()
    }, { go: true })
    freq.replaceChildren(el('div', { class: 'gr-sec' }, el('h4', { class: 'gr-h' }, 'Filing frequency (Super Admin)'),
      el('p', { class: 'cn-sub' }, 'GSTR-1 / GSTR-3B monthly, or quarterly under QRMP (aggregate turnover up to ₹5 crore) — from the first day of a quarter, never back-dated. Your CA confirms which.'),
      el('div', { class: 'cn-row' }, f, from, why, save), fst))
  }

  async function load() {
    const { data, error } = await supabase.rpc('gst_return_filings')
    if (error) { st.textContent = safeErrorMessage(error, 'Could not load the filing history.'); st.className = 'cn-status err'; return }
    const rows = data || []
    if (!rows.length) { list.replaceChildren(el('p', { class: 'cn-sub' }, 'Nothing is marked filed yet.')); return }
    list.replaceChildren(el('div', { class: 'cn-tablewrap' }, el('table', { class: 'cn-table' },
      el('thead', null, el('tr', null, ['No.', 'Return', 'Period', 'Status', 'Filed on', 'ARN', 'By', ''].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', null, rows.map(r => {
        const tr = el('tr', { class: r.in_force ? null : 'reg-superseded' },
          el('td', null, String(r.entry_no), r.corrects_no ? el('div', { class: 'reg-meta reg-fix' }, `corrects No. ${r.corrects_no}`) : null,
            r.corrected_by_no ? el('div', { class: 'reg-meta reg-by' }, `corrected by No. ${r.corrected_by_no}`) : null),
          el('td', null, RETURN_LABEL[r.return_type] || r.return_type),
          el('td', null, `${gstDate(r.period_from)} – ${gstDate(r.period_to)}`),
          el('td', null, r.status === 'withdrawn' ? 'Withdrawn' : 'Filed', r.correction_reason ? el('div', { class: 'cn-sub', style: 'margin:0' }, r.correction_reason) : null),
          el('td', null, gstDate(r.filed_on) || '—'), el('td', null, r.arn || '—'), el('td', null, r.marked_by_name || '—'), el('td'))
        if (canMark && r.in_force) tr.lastChild.appendChild(btn('Correct entry', () => correctForm(tr, r)))
        return tr
      })))))
  }

  function correctForm(tr, r) {
    const reason = el('input', { type: 'text', class: 'cn-input', maxlength: '300', placeholder: 'Reason (required)', 'aria-label': 'Reason for the correction' })
    const wd = el('input', { type: 'checkbox', 'aria-label': 'Withdraw: it was not filed' })
    const on = el('input', { type: 'date', class: 'cn-input', value: r.filed_on || '', max: todayISTStr(), 'aria-label': 'Corrected filing date' })
    const arn = el('input', { type: 'text', class: 'cn-input', maxlength: '20', value: r.arn || '', 'aria-label': 'Corrected ARN' })
    const fst = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
    // owner condition (c) for deviation 5 (15 Oct 2026): before a GSTR-1 / CMP-08 mark is withdrawn, say that bill cancellation reopens
    // for that period (the cancel lock follows the filings in force); the reason stays required and the old entry stays, struck through
    const locks = r.return_type === 'GSTR1' || r.return_type === 'CMP08'
    const warn = el('div', { class: 'cn-note gr-withdraw-warn', role: 'alert', hidden: true },
      locks ? `⚠ Withdrawing this ${RETURN_LABEL[r.return_type]} mark REOPENS the cancellation of bills dated ${gstDate(r.period_from)} – ${gstDate(r.period_to)} `
              + '(the lock comes back when the period is marked filed again). The entry is kept, struck through, with your reason — nothing is deleted.'
            : `Withdrawing this ${RETURN_LABEL[r.return_type] || r.return_type} mark keeps the entry, struck through, with your reason — nothing is deleted.`)
    wd.addEventListener('change', () => { warn.hidden = !wd.checked; save.textContent = wd.checked ? 'Withdraw the mark' : 'Save correction' })
    const save = btn('Save correction', async () => {
      if (reason.value.trim().length < 5) { fst.textContent = 'Give the reason (at least 5 characters).'; fst.className = 'cn-status err'; reason.focus(); return }
      save.disabled = true
      const { error } = await supabase.rpc('correct_gst_return_filing', { p_id: r.id, p_reason: reason.value.trim(), p_withdraw: wd.checked,
        p_filed_on: wd.checked ? null : (on.value || null), p_arn: wd.checked ? null : (arn.value.trim() || null) })
      save.disabled = false
      if (error) { fst.textContent = safeErrorMessage(error, 'Could not save the correction.'); fst.className = 'cn-status err'; return }
      load(); onChange?.()
    }, { go: true })
    const row = el('tr', { class: 'gr-correct' }, el('td', { colspan: '8' },
      el('div', { class: 'cn-row' }, reason, el('label', { class: 'cn-radio' }, wd, 'Withdraw (it was not filed)'), lbl('Filed on', on), lbl('ARN', arn), save,
        btn('Cancel', () => row.remove())), warn, fst))
    tr.after(row)
    reason.focus()
  }

  load()
  return { reload: load }
}
