// xlsxReader.js -- reads the FIRST sheet of an .xlsx file as rows of text, no library (Session 383, staff bulk invite).
// Why not SheetJS: the staff page handles names, phones and emails; no third-party script (owner D7, 9 Nov 2026). An .xlsx is a ZIP: the
// entries are read from its central directory; a deflated entry is opened with the browser's own DecompressionStream('deflate-raw').
// Cells: shared strings, inline strings, numbers, booleans and formula results are returned as text ('' for an empty cell). Formulas are
// never run. Limits: at most 2 MB, at most 1000 rows x 40 columns read.
//   readXlsxRows(arrayBuffer) -> Promise<string[][]>   (throws Error with a plain message when the file cannot be read)

const dec = new TextDecoder('utf-8')
const MAX_ROWS = 1000, MAX_COLS = 40

function u16(b, o) { return b[o] | (b[o + 1] << 8) }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open .xlsx files -- save the sheet as CSV and upload that.')
  const ds = new DecompressionStream('deflate-raw')
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds))
  return new Uint8Array(await out.arrayBuffer())
}

// name -> Uint8Array (only the entries asked for)
async function unzip(buf, wanted) {
  const b = new Uint8Array(buf)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) { if (u32(b, i) === 0x06054B50) { eocd = i; break } }
  if (eocd < 0) throw new Error('This is not an Excel (.xlsx) file.')
  const count = u16(b, eocd + 10)
  let p = u32(b, eocd + 16)
  const found = new Map()
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (u32(b, p) !== 0x02014B50) throw new Error('The Excel file is damaged.')
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), lho = u32(b, p + 42)
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen))
    p += 46 + nlen + xlen + clen
    if (!wanted(name)) continue
    if (u32(b, lho) !== 0x04034B50) throw new Error('The Excel file is damaged.')
    const start = lho + 30 + u16(b, lho + 26) + u16(b, lho + 28)
    const raw = b.subarray(start, start + csize)
    if (method === 0) found.set(name, raw)
    else if (method === 8) found.set(name, await inflateRaw(raw))
    else throw new Error('The Excel file uses a format this page cannot read -- save it as CSV and upload that.')
  }
  return found
}

const colIndex = ref => { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1 }
const xml = bytes => new DOMParser().parseFromString(dec.decode(bytes), 'application/xml')
const textOf = el => [...el.getElementsByTagName('t')].map(t => t.textContent).join('')

export async function readXlsxRows(buf) {
  if (!buf || buf.byteLength > 2_000_000) throw new Error('The file is too large (at most 300 rows).')
  const files = await unzip(buf, n => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  // the first sheet in the workbook's own order (its relationship target)
  let target = 'xl/worksheets/sheet1.xml'
  if (files.has('xl/workbook.xml') && files.has('xl/_rels/workbook.xml.rels')) {
    const first = xml(files.get('xl/workbook.xml')).getElementsByTagName('sheet')[0]
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'))
    const rel = [...xml(files.get('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid)
    if (rel) target = 'xl/' + rel.getAttribute('Target').replace(/^\/?xl\//, '').replace(/^\//, '')
  }
  const sheet = files.get(target)
  if (!sheet) throw new Error('The Excel file has no sheet to read.')
  const shared = files.has('xl/sharedStrings.xml') ? [...xml(files.get('xl/sharedStrings.xml')).getElementsByTagName('si')].map(textOf) : []
  const rows = []
  for (const row of [...xml(sheet).getElementsByTagName('row')].slice(0, MAX_ROWS)) {
    const r = Number(row.getAttribute('r')) - 1
    const out = []
    for (const c of row.getElementsByTagName('c')) {
      const ci = colIndex(c.getAttribute('r'))
      if (ci < 0 || ci >= MAX_COLS) continue
      const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]?.textContent ?? ''
      out[ci] = t === 's' ? (shared[Number(v)] ?? '') : t === 'inlineStr' ? textOf(c) : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v
    }
    rows[Number.isFinite(r) && r >= 0 ? r : rows.length] = Array.from(out, x => x ?? '')
  }
  return Array.from(rows, x => x || []).filter(r => r.some(v => String(v).trim() !== ''))
}
