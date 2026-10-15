// xlsxWriter.js -- a minimal .xlsx (Office Open XML) writer, no library (Session 345m, GST Stage 7a).
// Why not SheetJS: a finance page should not load a third-party script for one export, and the file only needs plain sheets
// (text + numbers, a bold header row). The workbook is a ZIP with the files STORED (no compression), which every spreadsheet
// program reads. Text cells are inline strings; numbers are numbers (so the CA can sum them); null / undefined = an empty cell.
//   buildXlsx([{ name: 'b2cs', rows: [['Type', 'Place Of Supply', ...], ['OE', '29-Karnataka', ...]] }, ...]) -> Uint8Array
//   xlsxBlob(sheets) -> Blob;  csvText(rows) -> text (RFC 4180, CRLF, a leading apostrophe for cells a spreadsheet would run as a formula)

const enc = new TextEncoder()
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // characters XML 1.0 does not allow
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

let _crcTable = null
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      _crcTable[n] = c >>> 0
    }
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// a ZIP archive with every entry STORED (method 0)
function zipStored(files) {
  const parts = [], central = []
  let offset = 0
  const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF]
  const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data)
    const local = new Uint8Array([0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)])
    parts.push(local, name, data)
    central.push(new Uint8Array([0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset)]), name)
    offset += local.length + name.length + data.length
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0)
  const end = new Uint8Array([0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(cdSize), ...u32(offset), ...u16(0)])
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0))
  let p = 0
  for (const a of all) { out.set(a, p); p += a.length }
  return out
}

const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26) } return s }

function sheetXml(rows) {
  const body = rows.map((row, r) => `<row r="${r + 1}">` + row.map((v, c) => {
    if (v === null || v === undefined || v === '') return ''
    const ref = colName(c) + (r + 1), st = r === 0 ? ' s="1"' : ''
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`
    return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`
  }).join('') + '</row>').join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

// sheet names: at most 31 characters, none of : \ / ? * [ ], unique
function safeName(n, used) {
  let s = String(n || 'Sheet').replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Sheet'
  let k = 2
  while (used.has(s.toLowerCase())) s = String(n).slice(0, 28) + '-' + k++
  used.add(s.toLowerCase())
  return s
}

export function buildXlsx(sheets) {
  const used = new Set()
  const list = sheets.map((s, i) => ({ id: i + 1, name: safeName(s.name, used), rows: s.rows || [] }))
  const files = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + list.map(s => `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + list.map(s => `<sheet name="${xmlEsc(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join('') + '</sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + list.map(s => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`).join('')
      + `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>') },
    ...list.map(s => ({ name: `xl/worksheets/sheet${s.id}.xml`, data: enc.encode(sheetXml(s.rows)) })),
  ]
  return zipStored(files)
}

export const xlsxBlob = sheets => new Blob([buildXlsx(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

// CSV: a cell starting with = + - @ (or a tab / CR) is prefixed with an apostrophe so a spreadsheet never runs it as a formula;
// numbers are written as numbers (a negative credit-note value stays a number)
export function csvText(rows) {
  const cell = v => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
    let s = String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
