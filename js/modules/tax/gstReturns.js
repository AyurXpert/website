// gstReturns.js -- Finance -> 🧾 GST returns (Session 345m, GST Stage 7a; plan docs/handoff/stage7_gst_reports_plan.md).
// Read-only: gst_returns_report() (GSTR-1 sections, GSTR-3B 3.1 / 3.2, the composition summary -- blocked while the R7 tax base is
// unconfirmed), gst_sales_register(), gst_credit_note_register(), credit_note_refunds_due() (TODO §174). The organisation and the
// role checks are the server's (super_admin / finance_manager / accountant, active accounts). Exports: .xlsx in the Returns Offline
// Tool's sheet layout (gstReturnsExport.js + js/utils/xlsxWriter.js) or one CSV per sheet; every export is written to the audit log
// with the period and the figures hash (G19 -- a return summary is not a copy-numbered document). Nothing here files anything.
// Session 345n (GST Stage 7b): B2CL / CDNUR (platform limit), the code descriptions (never an item name; the organisation may set its
// own -- set_gst_code_description), the HSN-digit warning, the composition turnover (§189), the filing panel + history + filing frequency
// (gstFilings.js). Who may mark filed / set the frequency is passed in for the buttons only -- the server checks again.
// DOM nodes + textContent only (names come from documents).
import { filingPanel, mountFilingHistory } from './gstFilings.js'
import { safeErrorMessage } from '../../utils/errors.js'
import { todayISTStr } from '../../utils/dateUtils.js'
import { el } from '../billing/invoiceLayout.js'
import { exportSheets, exportFileBase, pos, gstDate } from './gstReturnsExport.js'
import { xlsxBlob, csvText, downloadBlob } from '../../utils/xlsxWriter.js'

const rupee = n => (n === null || n === undefined) ? '—' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const qty = n => Number(n || 0).toLocaleString('en-IN')
const LEVEL = { warn: '⚠️', info: 'ℹ️' }

function btn(label, onClick, { go = false, title = null } = {}) {
  const b = el('button', { type: 'button', class: go ? 'cn-btn cn-btn-go' : 'cn-btn', title }, label)
  b.addEventListener('click', onClick)
  return b
}
// a table from header labels + rows of cells; numeric columns (by index) are right-aligned
function table(head, rows, numCols = [], empty = 'Nothing in this period.') {
  if (!rows.length) return el('p', { class: 'cn-sub gr-empty' }, empty)
  return el('div', { class: 'cn-tablewrap' }, el('table', { class: 'cn-table' },
    el('thead', null, el('tr', null, head.map((h, i) => el('th', { scope: 'col', class: numCols.includes(i) ? 'num' : null }, h)))),
    el('tbody', null, rows.map(r => el('tr', null, r.map((c, i) => el('td', { class: numCols.includes(i) ? 'num' : null }, c ?? '—')))))))
}
const section = (title, sub, ...body) => el('section', { class: 'gr-sec' }, el('h4', { class: 'gr-h' }, title), sub ? el('p', { class: 'cn-sub' }, sub) : null, ...body)

// the period picker: month / quarter (Apr-Jun ...) / financial year / custom range
function periodOf(kind, month, quarter, fy, from, to) {
  if (kind === 'month' && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }
  }
  if ((kind === 'quarter' || kind === 'fy') && /^\d{4}$/.test(fy)) {
    const y = Number(fy)
    if (kind === 'fy') return { from: `${y}-04-01`, to: `${y + 1}-03-31` }
    const q = Number(quarter)   // 1 = Apr-Jun ... 4 = Jan-Mar
    const sm = [4, 7, 10, 1][q - 1], sy = q === 4 ? y + 1 : y
    return { from: `${sy}-${String(sm).padStart(2, '0')}-01`, to: new Date(Date.UTC(sy, sm + 2, 0)).toISOString().slice(0, 10) }
  }
  return { from, to }
}

export function mountGstReturns(root, { supabase, audit = null, role = null, secondary = null }) {
  const has = list => list.includes(role) || list.includes(secondary)
  const canMark = has(['super_admin', 'finance_manager']), canFreq = has(['super_admin']), canDesc = has(['super_admin', 'finance_manager'])   // Session 345o (F2): not the accountant
  const today = todayISTStr()
  const fyStart = Number(today.slice(5, 7)) >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1
  const kind = el('select', { class: 'cn-sel', 'aria-label': 'Period type' },
    el('option', { value: 'month' }, 'Month (GSTR-1 / GSTR-3B)'), el('option', { value: 'quarter' }, 'Quarter (QRMP / CMP-08)'),
    el('option', { value: 'fy' }, 'Financial year (GSTR-4 / annual)'), el('option', { value: 'custom' }, 'Custom dates'))
  const month = el('input', { type: 'month', class: 'cn-input', value: today.slice(0, 7), 'aria-label': 'Month' })
  const quarter = el('select', { class: 'cn-sel', 'aria-label': 'Quarter' },
    el('option', { value: '1' }, 'Apr–Jun'), el('option', { value: '2' }, 'Jul–Sep'), el('option', { value: '3' }, 'Oct–Dec'), el('option', { value: '4' }, 'Jan–Mar'))
  quarter.value = String([4, 4, 4, 1, 1, 1, 2, 2, 2, 3, 3, 3][Number(today.slice(5, 7)) - 1])
  const fy = el('select', { class: 'cn-sel', 'aria-label': 'Financial year' },
    [0, 1, 2, 3].map(k => el('option', { value: String(fyStart - k) }, `FY ${fyStart - k}-${String((fyStart - k + 1) % 100).padStart(2, '0')}`)))
  const from = el('input', { type: 'date', class: 'cn-input', value: today.slice(0, 8) + '01', 'aria-label': 'From date' })
  const to = el('input', { type: 'date', class: 'cn-input', value: today, 'aria-label': 'To date' })
  const showPick = () => {
    month.hidden = kind.value !== 'month'; quarter.hidden = kind.value !== 'quarter'
    fy.hidden = !(kind.value === 'quarter' || kind.value === 'fy'); from.hidden = to.hidden = kind.value !== 'custom'
  }
  kind.addEventListener('change', showPick); showPick()
  const status = el('div', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
  const refunds = el('div')
  const out = el('div')
  const sheetSel = el('select', { class: 'cn-sel', 'aria-label': 'Sheet for CSV' })
  const exportRow = el('div', { class: 'cn-row gr-export', hidden: true },
    btn('⬇ Excel (.xlsx)', () => doExport('xlsx'), { title: 'Every sheet in one workbook (Returns Offline Tool layout + summary / GSTR-3B / notes)' }),
    sheetSel, btn('⬇ CSV of this sheet', () => doExport('csv')),
    btn('🖨 Print summary', () => { log('print'); printSummary() }))
  const regs = el('div')
  const history = el('div')
  root.replaceChildren(el('div', { class: 'cn-card gr-card' },
    el('h3', { class: 'cn-h' }, 'GST returns'),
    el('p', { class: 'cn-sub' }, 'Figures for GSTR-1, GSTR-3B and (for a composition organisation) CMP-08 / GSTR-4, read from the issued Tax Invoices, Bills of Supply and credit notes. A document counts on its own date; a credit note on ITS date. Cancelled documents only count in "Documents issued". These are summaries for your CA to file on the GST portal — nothing is filed from here.'),
    refunds,
    el('div', { class: 'cn-row' }, kind, month, quarter, fy, from, to, btn('Show', run, { go: true })),
    status, exportRow, out,
    el('div', { class: 'cn-row gr-regbtns' },
      btn('📒 Sales register', () => register('sales')), btn('🧾 Credit-note register', () => register('cn'))),
    regs, history))
  const hist = mountFilingHistory(history, { supabase, canMark, canFreq, onChange: () => { if (current) run() } })

  let current = null, seq = 0
  // prints only this card (css/gst-returns.css hides the rest of the page while body has gr-printing)
  function printSummary() {
    document.body.classList.add('gr-printing')
    const done = () => { document.body.classList.remove('gr-printing'); window.removeEventListener('afterprint', done) }
    window.addEventListener('afterprint', done)
    window.print()
  }
  function period() { return periodOf(kind.value, month.value, quarter.value, fy.value, from.value, to.value) }
  function log(what) {
    if (!audit || !current) return
    try { audit('gst_report_export', { kind: what, from: current.period?.from, to: current.period?.to, figures_hash: current.figures_hash }) } catch { /* never block */ }
  }
  function doExport(type) {
    if (!current) return
    const sheets = exportSheets(current), base = exportFileBase(current)
    if (type === 'xlsx') downloadBlob(xlsxBlob(sheets), base + '.xlsx')
    else {
      const s = sheets.find(x => x.name === sheetSel.value) || sheets[0]
      downloadBlob(new Blob([csvText(s.rows)], { type: 'text/csv;charset=utf-8' }), `${base}_${s.name.replace(/[()]/g, '')}.csv`)
    }
    log(type === 'xlsx' ? 'xlsx' : 'csv:' + sheetSel.value)
  }

  async function loadRefunds() {
    const { data, error } = await supabase.rpc('credit_note_refunds_due')
    if (error || !data || !Number(data.count)) { refunds.replaceChildren(); return }
    refunds.replaceChildren(el('div', { class: Number(data.overdue) ? 'cn-note gr-overdue' : 'cn-sum' },
      `Cash refunds due: ${data.count} (${rupee(data.amount)})`,
      Number(data.overdue) ? ` — ${data.overdue} waiting ${data.alert_days} days or more (${rupee(data.overdue_amount)}). Pay them out from Finance → 🧾 Credit notes → "Cash refunds due".` : '.'))
  }

  async function run() {
    const p = period(), mine = ++seq
    if (!p.from || !p.to) { status.textContent = 'Choose a period.'; status.className = 'cn-status err'; return }
    status.textContent = 'Reading the documents…'; status.className = 'cn-status'
    const { data, error } = await supabase.rpc('gst_returns_report', { p_from: p.from, p_to: p.to })
    if (mine !== seq) return
    if (error) { status.textContent = safeErrorMessage(error, 'Could not read the GST returns.'); status.className = 'cn-status err'; out.replaceChildren(); exportRow.hidden = true; current = null; return }
    current = data
    status.textContent = `${data.organisation?.legal_name || ''} · GSTIN ${data.organisation?.gstin || '—'} · ${gstDate(p.from)} to ${gstDate(p.to)}`
    status.className = 'cn-status ok'
    sheetSel.replaceChildren(...exportSheets(data).map(s => el('option', { value: s.name }, s.name)))
    exportRow.hidden = false
    render(data)
  }

  function render(r) {
    const g = r.gstr1 || {}, t = r.totals || {}, b3 = r.gstr3b || {}, c = r.composition || {}
    const ok = Number(t.difference_documents_vs_lines) === 0 && Number(t.difference_lines_vs_sections) === 0 && b3.matches_gstr1
    const parts = []
    parts.push(el('ul', { class: 'gr-warn' }, (r.warnings || []).map(w => el('li', { class: 'gr-w-' + (w.level || 'info') }, (LEVEL[w.level] || 'ℹ️') + ' ' + w.text))))
    parts.push(section('Totals and checks', null,
      el('div', { class: 'cn-sum' },
        el('div', null, 'Documents: ', el('strong', null, String(t.documents ?? 0)), ` (${rupee(t.documents_value)}) · Credit notes: `, el('strong', null, String(t.credit_notes ?? 0)),
          ` (${rupee(t.credit_notes_value)}) · Net: `, el('strong', null, rupee(t.net_value)), ` · Cancelled (Table 13 only): ${t.cancelled_documents ?? 0}`),
        el('div', null, `Taxable ${rupee(t.taxable)} · CGST ${rupee(t.cgst)} · SGST ${rupee(t.sgst)} · IGST ${rupee(t.igst)} · Exempt ${rupee(t.exempt)} · Nil rated ${rupee(t.nil_rated)} · Non-GST ${rupee(t.non_gst)}`
          + (Number(t.out_of_scope) ? ` · Out of scope ${rupee(t.out_of_scope)}` : '')),
        el('div', { class: ok ? 'gr-ok' : 'gr-bad' }, ok ? '✔ Reconciled: documents − credit notes = the lines = the return sections; GSTR-3B 3.1(a) = GSTR-1.'
          : '✖ The figures do not reconcile — do not file; report this to support.'))))
    parts.push(filingPanel({ supabase, report: r, canMark, onChange: () => { run(); hist.reload() } }))
    // GSTR-1
    parts.push(el('h3', { class: 'gr-h3' }, 'GSTR-1'))
    parts.push(section('4A — B2B (buyers with a GSTIN)', null, table(['GSTIN', 'Buyer', 'Invoice', 'Date', 'Value', 'Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST'],
      (g.b2b || []).flatMap(i => (i.items || []).map(it => [i.gstin, i.recipient_name || '—', i.number, gstDate(i.date), rupee(i.value), pos(i.pos), it.rate + ' %', rupee(it.taxable), rupee(it.cgst), rupee(it.sgst), rupee(it.igst)])),
      [4, 7, 8, 9, 10], 'No buyer GSTIN on any document of this period.')))
    parts.push(section('7 — B2C small (net of the credit notes of the period)', 'By place of supply and rate.', table(['Type', 'Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST'],
      (g.b2cs || []).map(x => [x.type, pos(x.pos) + (x.interstate ? ' (inter-state)' : ''), x.rate + ' %', rupee(x.taxable), rupee(x.cgst), rupee(x.sgst), rupee(x.igst)]), [3, 4, 5, 6])))
    parts.push(section('5 — B2C large (B2CL)', 'Inter-state Tax Invoices to unregistered buyers above the invoice-value limit (a platform value, ₹1 lakh from 1 Aug 2024 — confirm with your CA).',
      table(['Invoice', 'Date', 'Value', 'Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST'],
        (g.b2cl || []).flatMap(i => (i.items || []).map(it => [i.number, gstDate(i.date), rupee(i.value), pos(i.pos), it.rate + ' %', rupee(it.taxable), rupee(it.cgst), rupee(it.sgst), rupee(it.igst)])),
        [2, 5, 6, 7, 8], 'None in this period.')))
    parts.push(section('9B — Credit notes to registered buyers (CDNR)', 'Credit notes on B2C supplies are netted in B2C small above.', table(['GSTIN', 'Note', 'Date', 'Against', 'Value', 'Rate', 'Taxable', 'CGST', 'SGST'],
      (g.cdnr || []).flatMap(n => (n.items || []).map(it => [n.gstin, n.number, gstDate(n.date), `${n.original_number || '—'} (${gstDate(n.original_date)})`, rupee(n.value), it.rate + ' %', rupee(it.taxable), rupee(it.cgst), rupee(it.sgst)])),
      [4, 6, 7, 8])))
    if ((g.cdnur || []).length) parts.push(section('9B — Credit notes to unregistered buyers (CDNUR)', 'Against B2C large invoices.', table(['Type', 'Note', 'Date', 'Against', 'Value', 'Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST'],
      g.cdnur.flatMap(n => (n.items || []).map(it => [n.ur_type, n.number, gstDate(n.date), `${n.original_number || '—'} (${gstDate(n.original_date)})`, rupee(n.value), pos(n.pos), it.rate + ' %', rupee(it.taxable), rupee(it.cgst), rupee(it.sgst)])),
      [4, 7, 8, 9])))
    parts.push(section('8 — Nil rated, exempt and non-GST supplies', 'Healthcare services are exempt. Net of the credit notes of the period.', table(['', 'Nil rated', 'Exempt', 'Non-GST'],
      (g.nil_exempt_non_gst || []).map(x => [x.row, rupee(x.nil_rated), rupee(x.exempt), rupee(x.non_gst)]), [1, 2, 3])))
    const hsnRows = list => list.map(h => [
      el('span', null, h.code + (h.digits ? ` (${h.digits} digits)` : ''), h.digits_short ? el('div', { class: 'gr-short' }, `⚠ ${h.min_digits} digits required`) : null),
      descCell(h), h.uqc, h.code_kind === 'HSN' ? qty(h.quantity) : '0', rupee(h.total_value), h.rate + ' %', rupee(h.taxable), rupee(h.cgst), rupee(h.sgst), rupee(h.igst)])
    const hsnHead = ['HSN / SAC', 'Description', 'UQC', 'Quantity', 'Total value', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST']
    parts.push(section('12 — HSN / SAC summary: B2B', null, table(hsnHead, hsnRows(g.hsn_b2b || []), [3, 4, 6, 7, 8, 9])))
    parts.push(section('12 — HSN / SAC summary: B2C', 'Goods in NOS, services NA with quantity 0. The codes are printed in full, as on the documents; the description is the code\'s (a platform list, or your own), never an item name.', table(hsnHead, hsnRows(g.hsn_b2c || []), [3, 4, 6, 7, 8, 9])))
    parts.push(section('13 — Documents issued', 'Tax Invoices and Bills of Supply are reported as invoices for outward supply, one line per series.', table(['Nature', 'From', 'To', 'Total', 'Cancelled', 'Net issued'],
      (g.docs || []).map(d => [d.nature, d.from, d.to, String(d.total), String(d.cancelled), String(d.net_issued) + (Number(d.gaps) ? ` (⚠ ${d.gaps} number(s) missing in the range)` : '')]), [3, 4, 5])))
    // GSTR-3B
    const a = b3['3_1_a'] || {}
    parts.push(el('h3', { class: 'gr-h3' }, 'GSTR-3B'))
    parts.push(section('3.1 Outward supplies and 3.2 inter-state supplies to unregistered persons', null, table(['Table', 'Nature of supplies', 'Taxable', 'IGST', 'CGST', 'SGST'], [
      ['3.1(a)', a.label, rupee(a.taxable), rupee(a.igst), rupee(a.cgst), rupee(a.sgst)],
      ['3.1(b)', b3['3_1_b']?.label, rupee(b3['3_1_b']?.taxable), rupee(b3['3_1_b']?.igst), '—', '—'],
      ['3.1(c)', b3['3_1_c']?.label, rupee(b3['3_1_c']?.taxable), '—', '—', '—'],
      ['3.1(d)', b3['3_1_d']?.label, b3['3_1_d']?.note, '—', '—', '—'],
      ['3.1(e)', b3['3_1_e']?.label, rupee(b3['3_1_e']?.taxable), '—', '—', '—'],
      ...(b3['3_2'] || []).map(x => ['3.2', 'Unregistered persons — ' + pos(x.pos), rupee(x.taxable), rupee(x.igst), '—', '—']),
    ], [2, 3, 4, 5]), el('p', { class: 'cn-sub' }, b3.itc?.note || '')))
    // composition
    if (c.applicable) {
      parts.push(el('h3', { class: 'gr-h3' }, 'Composition (CMP-08 / GSTR-4)'))
      if (c.turnover) parts.push(turnoverBox(c.turnover))
      if (c.blocked) parts.push(el('div', { class: 'cn-note' }, `${c.documents} composition document(s) in this period. ${c.reason}`))
      else {
        const q = c.quarters || [], tt = c.totals || {}
        parts.push(section(`Turnover (tax base: ${c.tax_base === 'taxable_only' ? 'taxable supplies only' : 'taxable + exempt supplies'})`, c.rate_note,
          table(['Quarter from', 'Taxable', 'Exempt', 'Nil rated', 'Non-GST', 'Outward total', 'Base: taxable only', 'Base: taxable + exempt', 'Chosen base'],
            [...q.map(x => [gstDate(x.quarter_start), rupee(x.taxable), rupee(x.exempt), rupee(x.nil_rated), rupee(x.non_gst), rupee(x.outward_total), rupee(x.base_taxable_only), rupee(x.base_taxable_and_exempt), rupee(x.chosen_base_value)]),
             ['Period', rupee(tt.taxable), rupee(tt.exempt), rupee(tt.nil_rated), rupee(tt.non_gst), rupee(tt.outward_total), rupee(tt.base_taxable_only), rupee(tt.base_taxable_and_exempt), '']],
            [1, 2, 3, 4, 5, 6, 7, 8])))
      }
    }
    parts.push(el('p', { class: 'cn-sub gr-foot' }, `Generated ${new Date(r.generated_at).toLocaleString('en-IN')} · figures check ${r.figures_hash}`))
    out.replaceChildren(...parts)
  }

  // the code's description (platform list or the organisation's own) + "Edit" for the report roles
  function descCell(h) {
    const cell = el('span', null, h.description || '', h.description_source === 'organisation' ? el('span', { class: 'gr-tag' }, 'your own') : null)
    if (!canDesc || !h.code) return cell
    const edit = btn('Edit', () => {
      const inp = el('input', { type: 'text', class: 'cn-input', maxlength: '120', value: h.description_source === 'organisation' ? h.description : '',
        placeholder: 'Your description (empty = the platform text)', 'aria-label': `Description of ${h.code}` })
      const st = el('span', { class: 'cn-status', role: 'status', 'aria-live': 'polite' })
      const save = btn('Save', async () => {
        save.disabled = true
        const { error } = await supabase.rpc('set_gst_code_description', { p_code: h.code, p_kind: h.code_kind, p_description: inp.value.trim() || null })
        save.disabled = false
        if (error) { st.textContent = safeErrorMessage(error, 'Could not save the description.'); st.className = 'cn-status err'; return }
        run()
      }, { go: true })
      cell.replaceChildren(el('div', { class: 'cn-row' }, inp, save, btn('Cancel', () => run())), st)
      inp.focus()
    }, { title: 'Set your own description of this code' })
    cell.appendChild(edit)
    return cell
  }
  function turnoverBox(tv) {
    const lv = tv.level || 'ok'
    const mark = { ok: '', approaching: '(80 % or more)', near: '(90 % or more)', crossed: '(ABOVE the limit)' }
    return el('div', { class: lv === 'ok' ? 'cn-sum' : 'cn-note' },
      el('div', null, `Composition turnover this financial year (${gstDate(tv.fy_from)} to ${gstDate(tv.as_of)}): `, el('strong', null, rupee(tv.turnover))),
      el('ul', { class: 'gr-warn' }, (tv.limits || []).map(l => el('li', null,
        `${l.label}: limit ${rupee(l.limit)} — ${l.percent ?? 0} % ${mark[l.level] || ''}`))),
      tv.title ? el('div', { class: 'gr-bad' }, tv.title) : null,
      el('p', { class: 'cn-sub', style: 'margin:4px 0 0' }, tv.detail || ''))
  }

  async function register(which) {
    const p = period()
    if (!p.from || !p.to) return
    regs.replaceChildren(el('p', { class: 'cn-status' }, 'Loading…'))
    const fn = which === 'sales' ? 'gst_sales_register' : 'gst_credit_note_register'
    const { data, error } = await supabase.rpc(fn, { p_from: p.from, p_to: p.to })
    if (error) { regs.replaceChildren(el('p', { class: 'cn-status err' }, safeErrorMessage(error, 'Could not load the register.'))); return }
    const rows = data?.rows || []
    let head, body, sheet
    if (which === 'sales') {
      head = ['Date', 'Number', 'Document', 'Status', 'Type', 'Name', 'Buyer GSTIN', 'Taxable', 'Exempt', 'CGST', 'SGST', 'IGST', 'Total', 'Credited by']
      sheet = rows.map(x => [gstDate(x.date), x.number || '', x.gst_document ? x.document_type : `${x.document_type} (${x.regime === 'gst_v1' ? 'not a GST document' : 'pre-GST'})`, x.status, x.bill_type, x.name || '',
        x.buyer_gstin || '', Number(x.taxable), Number(x.exempt), Number(x.cgst), Number(x.sgst), Number(x.igst), Number(x.total), (x.credited_by || []).join(' ')])
      body = sheet.map(s => s.map((v, i) => i >= 7 && i <= 12 ? rupee(v) : v))
    } else {
      head = ['Date', 'Credit note', 'Against', 'With tax', 'GST credit note', 'Name', 'Taxable', 'Exempt', 'CGST', 'SGST', 'Total', 'Refund', 'Refund status', 'Receipt']
      sheet = rows.map(x => [gstDate(x.date), x.number, `${x.original_number || ''} ${gstDate(x.original_date)}`, x.with_tax ? 'yes' : 'no', x.gst_credit_note ? 'yes' : 'no (excluded from GST figures)',
        x.name || '', Number(x.taxable), Number(x.exempt), Number(x.cgst), Number(x.sgst), Number(x.total), x.refund_mode || '', x.refund_status, x.refund_receipt || ''])
      body = sheet.map(s => s.map((v, i) => i >= 6 && i <= 10 ? rupee(v) : v))
    }
    const name = which === 'sales' ? 'sales-register' : 'credit-note-register'
    const fileBase = `${name}_${p.from}_${p.to}`
    regs.replaceChildren(section(which === 'sales' ? 'Sales register' : 'Credit-note register',
      (which === 'sales' && data.truncated) ? `Showing the first ${data.cap} of ${data.count} — choose a shorter period.` : `${rows.length} row(s), ${gstDate(p.from)} to ${gstDate(p.to)}.`,
      el('div', { class: 'cn-row' },
        btn('⬇ Excel (.xlsx)', () => { downloadBlob(xlsxBlob([{ name, rows: [head, ...sheet] }]), fileBase + '.xlsx'); audit?.('gst_report_export', { kind: name + ':xlsx', from: p.from, to: p.to }) }),
        btn('⬇ CSV', () => { downloadBlob(new Blob([csvText([head, ...sheet])], { type: 'text/csv;charset=utf-8' }), fileBase + '.csv'); audit?.('gst_report_export', { kind: name + ':csv', from: p.from, to: p.to }) })),
      table(head, body, which === 'sales' ? [7, 8, 9, 10, 11, 12] : [6, 7, 8, 9, 10])))
  }

  loadRefunds()
  return { reload: () => { loadRefunds(); hist.reload(); if (current) run() } }
}
