// gstReturnsExport.js -- the GST returns report (gst_returns_report(), Session 345m) as spreadsheet sheets (GST Stage 7a, G3).
// Pure functions, no DOM: the screen (gstReturns.js) turns the result into an .xlsx (js/utils/xlsxWriter.js) or one CSV per sheet.
// Sheet layout = the GSTR-1 Returns Offline Tool's Excel workbook (sheet names b2b, b2cl, b2cs, cdnr, cdnur, exemp, hsn(b2b),
// hsn(b2c), docs and their column headers), so the CA can copy the rows into the template or check them against the portal.
// Session 345n: b2cl / cdnur rows (platform limit), the code descriptions (never an item name), short codes + filing status in "notes".
// Source checked 15 Oct 2026 (owner decision A1): Table 12 is split into B2B and B2C tabs from the February 2025 return period
// (GSTN advisories of 9 and 22 Jan 2025); the offline-tool template in use is the one shipped with the CA's current Returns Offline
// Tool (V1.8 workbook seen referenced in July 2026) -- [CA: confirm the version; the headers below are checked against it before filing].
// The offline-tool sheets carry no tax-amount column for B2B / B2CL / B2CS (the tool computes it); the extra sheets "summary",
// "gstr3b", "composition" and "notes" carry the amounts, the reconciliation and the warnings.

export const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
}
// "29-Karnataka" (the offline tool's place-of-supply format); an unknown code stays as it is
export const pos = code => code ? (STATES[String(code).padStart(2, '0')] ? `${String(code).padStart(2, '0')}-${STATES[String(code).padStart(2, '0')]}` : String(code)) : ''
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// "03-Oct-2026" (the offline tool's date format)
export const gstDate = d => { const s = String(d || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''; const [y, m, dd] = s.split('-'); return `${dd}-${MON[Number(m) - 1]}-${y}` }
const num = v => (v === null || v === undefined || v === '') ? null : Math.round(Number(v) * 100) / 100

export function exportSheets(r) {
  const g = r?.gstr1 || {}, t = r?.totals || {}, b3 = r?.gstr3b || {}, c = r?.composition || {}, o = r?.organisation || {}
  const sheets = []
  sheets.push({ name: 'summary', rows: [
    ['Item', 'Value'],
    ['Organisation', o.legal_name || ''], ['GSTIN', o.gstin || ''], ['Period from', gstDate(r?.period?.from)], ['Period to', gstDate(r?.period?.to)],
    ['Generated', String(r?.generated_at || '')], ['Figures hash', r?.figures_hash || ''],
    ['Documents (Tax Invoices + Bills of Supply)', num(t.documents)], ['Credit notes', num(t.credit_notes)], ['Cancelled documents (Table 13 only)', num(t.cancelled_documents)],
    ['Documents value', num(t.documents_value)], ['Credit notes value', num(t.credit_notes_value)], ['Net value', num(t.net_value)],
    ['Taxable value', num(t.taxable)], ['CGST', num(t.cgst)], ['SGST', num(t.sgst)], ['IGST', num(t.igst)], ['Total tax', num(t.tax)],
    ['Exempt', num(t.exempt)], ['Nil rated', num(t.nil_rated)], ['Non-GST', num(t.non_gst)], ['Out of scope', num(t.out_of_scope)],
    ['Check: documents - credit notes - lines (must be 0)', num(t.difference_documents_vs_lines)],
    ['Check: lines - return sections (must be 0)', num(t.difference_lines_vs_sections)],
  ] })
  sheets.push({ name: 'b2b', rows: [['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply',
      'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
    ...(g.b2b || []).flatMap(i => (i.items || []).map(it => [i.gstin, i.recipient_name || '', i.number, gstDate(i.date), num(i.value), pos(i.pos),
      i.reverse_charge || 'N', '', i.type || 'Regular B2B', '', num(it.rate), num(it.taxable), num(it.cess)]))] })
  sheets.push({ name: 'b2cl', rows: [['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate',
      'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    ...(g.b2cl || []).flatMap(i => (i.items || []).map(it => [i.number, gstDate(i.date), num(i.value), pos(i.pos), '', num(it.rate), num(it.taxable), num(it.cess), '']))] })   // Session 345n
  sheets.push({ name: 'b2cs', rows: [['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
    ...(g.b2cs || []).filter(x => num(x.taxable) !== 0 || num(x.cgst) !== 0 || num(x.sgst) !== 0 || num(x.igst) !== 0)
      .map(x => [x.type || 'OE', pos(x.pos), '', num(x.rate), num(x.taxable), num(x.cess), ''])] })
  sheets.push({ name: 'cdnr', rows: [['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply',
      'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
    ...(g.cdnr || []).flatMap(n => (n.items || []).map(it => [n.gstin, n.recipient_name || '', n.number, gstDate(n.date), n.note_type || 'C', pos(n.pos),
      n.reverse_charge || 'N', 'Regular B2B', num(n.value), '', num(it.rate), num(it.taxable), num(it.cess)]))] })
  sheets.push({ name: 'cdnur', rows: [['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate',
      'Rate', 'Taxable Value', 'Cess Amount'],
    ...(g.cdnur || []).flatMap(n => (n.items || []).map(it => [n.ur_type || 'B2CL', n.number, gstDate(n.date), n.note_type || 'C', pos(n.pos), num(n.value), '', num(it.rate), num(it.taxable), num(it.cess)]))] })
  sheets.push({ name: 'exemp', rows: [['Description', 'Nil Rated Supplies', 'Exempted(other than nil rated/non GST supply)', 'Non-GST Supplies'],
    ...(g.nil_exempt_non_gst || []).map(x => [x.row, num(x.nil_rated), num(x.exempt), num(x.non_gst)])] })
  const hsnHead = ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount',
    'State/UT Tax Amount', 'Cess Amount']
  const hsnRow = h => [h.code, h.description || '', h.uqc, num(h.quantity), num(h.total_value), num(h.rate), num(h.taxable), num(h.igst), num(h.cgst), num(h.sgst), num(h.cess)]
  sheets.push({ name: 'hsn(b2b)', rows: [hsnHead, ...(g.hsn_b2b || []).map(hsnRow)] })
  sheets.push({ name: 'hsn(b2c)', rows: [hsnHead, ...(g.hsn_b2c || []).map(hsnRow)] })
  sheets.push({ name: 'docs', rows: [['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
    ...(g.docs || []).map(d => [d.nature, d.from, d.to, num(d.total), num(d.cancelled)])] })
  const a = b3['3_1_a'] || {}
  sheets.push({ name: 'gstr3b', rows: [['Table', 'Nature of supplies', 'Total taxable value', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess'],
    ['3.1(a)', a.label || '', num(a.taxable), num(a.igst), num(a.cgst), num(a.sgst), num(a.cess)],
    ['3.1(b)', b3['3_1_b']?.label || '', num(b3['3_1_b']?.taxable), num(b3['3_1_b']?.igst), null, null, num(b3['3_1_b']?.cess)],
    ['3.1(c)', b3['3_1_c']?.label || '', num(b3['3_1_c']?.taxable), null, null, null, null],
    ['3.1(d)', (b3['3_1_d']?.label || '') + ' -- ' + (b3['3_1_d']?.note || ''), null, null, null, null, null],
    ['3.1(e)', b3['3_1_e']?.label || '', num(b3['3_1_e']?.taxable), null, null, null, null],
    ...(b3['3_2'] || []).map(x => ['3.2', 'Supplies to unregistered persons -- ' + pos(x.pos), num(x.taxable), num(x.igst), null, null, null]),
    ['check', 'GSTR-3B 3.1(a) = GSTR-1 taxable sections: ' + (b3.matches_gstr1 ? 'yes' : 'NO -- do not file, report this'), null, null, null, null, null]] })
  if (c.applicable) {
    const rows = [['Item', 'Taxable', 'Exempt', 'Nil rated', 'Non-GST', 'Outward total', 'Base: taxable only', 'Base: taxable + exempt', 'Chosen base value']]
    if (c.blocked) rows.push(['BLOCKED: ' + (c.reason || ''), null, null, null, null, null, null, null, null])
    else {
      for (const q of c.quarters || []) rows.push(['Quarter from ' + gstDate(q.quarter_start), num(q.taxable), num(q.exempt), num(q.nil_rated), num(q.non_gst),
        num(q.outward_total), num(q.base_taxable_only), num(q.base_taxable_and_exempt), num(q.chosen_base_value)])
      const tt = c.totals || {}
      rows.push(['Period total (tax base: ' + (c.tax_base || '') + ')', num(tt.taxable), num(tt.exempt), num(tt.nil_rated), num(tt.non_gst), num(tt.outward_total),
        num(tt.base_taxable_only), num(tt.base_taxable_and_exempt), null])
      rows.push([c.rate_note || '', null, null, null, null, null, null, null, null])
    }
    sheets.push({ name: 'composition', rows })
  }
  sheets.push({ name: 'notes', rows: [['Level', 'Note'],
    ...(r?.warnings || []).map(w => [w.level, w.text]),
    ...(g.hsn_b2b || []).concat(g.hsn_b2c || []).filter(h => h.digits_short).map(h => ['check', `HSN / SAC ${h.code}: ${h.min_digits} digits required (the code on the documents is not changed)`]),
    ...(r?.filing || []).map(f => [f.matches ? 'info' : 'warn', `${f.return_type} marked filed on ${gstDate(f.filed_on)}${f.arn ? ' ARN ' + f.arn : ''}: ${f.matches ? 'figures match' : 'figures DIFFER from what was filed'}`])] })
  return sheets
}

export const exportFileBase = r => `GST-returns_${String(r?.organisation?.gstin || 'org').replace(/[^A-Za-z0-9]/g, '')}_${String(r?.period?.from || '')}_${String(r?.period?.to || '')}`
