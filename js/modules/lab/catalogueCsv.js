// Session 363 (TODO §266, owner Q6): the lab test catalogue as a file -- Excel export (.xlsx), CSV template / import.
// One row per reference BAND; the test's own columns repeat on each band row (a test with no band = one row, band columns empty).
// band_low ">40" = exclusive, band_high "<140" = exclusive; lists (aliases, normal_values) separated by "|"; yes / no for switches.
// The server (import_lab_tests) checks every row again and saves nothing when any row is wrong.

export const CSV_COLUMNS = ['code', 'name', 'aliases', 'section', 'specimen', 'container', 'method', 'unit', 'result_type', 'normal_values',
  'critical_low', 'critical_high', 'patient_prep', 'tat_hours', 'outsourced', 'outsource_lab', 'nabl_scope', 'consent_required',
  'self_referral_allowed', 'is_active', 'band_sex', 'band_age_from', 'band_age_to', 'band_low', 'band_high', 'band_kind', 'band_label'];

const yn = v => (v ? 'yes' : 'no');
const n = v => (v === null || v === undefined ? '' : String(Number(v)));

export function catalogueRows(tests) {
  const rows = [CSV_COLUMNS];
  for (const t of tests) {
    const base = [t.code, t.name, (t.aliases || []).join('|'), t.section, t.specimen || '', t.container || '', t.method || '', t.unit || '',
      t.result_type, (t.normal_values || []).join('|'), n(t.critical_low), n(t.critical_high), t.patient_prep || '', n(t.tat_hours),
      yn(t.outsourced), t.outsource_lab || '', yn(t.nabl_scope), yn(t.consent_required), yn(t.self_referral_allowed), yn(t.is_active)];
    const bands = t.ranges || [];
    if (!bands.length) { rows.push([...base, '', '', '', '', '', '', '']); continue; }
    for (const b of bands) {
      rows.push([...base, b.sex || 'any', n(b.age_min), n(b.age_max),
        b.low === null || b.low === undefined ? '' : (b.low_inclusive === false ? '>' : '') + n(b.low),
        b.high === null || b.high === undefined ? '' : (b.high_inclusive === false ? '<' : '') + n(b.high),
        b.kind || 'normal', b.label || '']);
    }
  }
  return rows;
}

// RFC 4180 reader (quotes, "" inside quotes, CRLF / LF); a leading apostrophe (written to stop formula injection) is removed
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false, i = 0;
  const s = String(text || '').replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(v => v.replace(/^'(?=[=+\-@])/, '').trim()));
}

const bool = (v, def) => {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return def;
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return s;   // the server refuses it with a plain message
};
const numOrNull = v => (String(v || '').trim() === '' ? null : String(v).trim());
const list = v => String(v || '').split('|').map(x => x.trim()).filter(Boolean);

// rows (with the header) -> { tests: [... with "row" = the first file line of the test], errors: [{row, message}] }
export function rowsToTests(rows) {
  const errors = [];
  if (!rows.length) return { tests: [], errors: [{ row: 1, message: 'The file is empty.' }] };
  const head = rows[0].map(h => h.trim().toLowerCase());
  const missing = ['code', 'name', 'section'].filter(c => !head.includes(c));
  if (missing.length) return { tests: [], errors: [{ row: 1, message: 'Missing column(s): ' + missing.join(', ') + ' -- use the template.' }] };
  const at = (r, c) => { const k = head.indexOf(c); return k < 0 ? '' : (r[k] ?? ''); };
  const byCode = new Map();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    if (r.every(v => !String(v).trim())) return;
    const code = String(at(r, 'code')).trim().toUpperCase();
    if (!code) { errors.push({ row: line, message: 'The code is empty.' }); return; }
    let t = byCode.get(code);
    if (!t) {
      t = { row: line, code, name: at(r, 'name'), aliases: list(at(r, 'aliases')), section: at(r, 'section'), specimen: at(r, 'specimen'),
        container: at(r, 'container'), method: at(r, 'method'), unit: at(r, 'unit'), result_type: at(r, 'result_type') || 'numeric',
        normal_values: list(at(r, 'normal_values')), critical_low: numOrNull(at(r, 'critical_low')), critical_high: numOrNull(at(r, 'critical_high')),
        patient_prep: at(r, 'patient_prep'), tat_hours: numOrNull(at(r, 'tat_hours')), outsourced: bool(at(r, 'outsourced'), false),
        outsource_lab: at(r, 'outsource_lab'), nabl_scope: bool(at(r, 'nabl_scope'), false), consent_required: bool(at(r, 'consent_required'), false),
        self_referral_allowed: bool(at(r, 'self_referral_allowed'), true), is_active: bool(at(r, 'is_active'), true), ranges: [] };
      byCode.set(code, t);
    } else if (String(at(r, 'name')).trim() && String(at(r, 'name')).trim() !== String(t.name).trim()) {
      errors.push({ row: line, message: `Code ${code} has two different names in the file.` });
    }
    const lo = String(at(r, 'band_low')).trim(), hi = String(at(r, 'band_high')).trim();
    if (lo || hi) {
      t.ranges.push({ sex: at(r, 'band_sex') || 'any', age_min: numOrNull(at(r, 'band_age_from')) ?? '0', age_max: numOrNull(at(r, 'band_age_to')),
        low: lo ? lo.replace(/^>/, '') : null, low_inclusive: !lo.startsWith('>'),
        high: hi ? hi.replace(/^</, '') : null, high_inclusive: !hi.startsWith('<'),
        kind: at(r, 'band_kind') || 'normal', label: at(r, 'band_label') || null });
    }
  });
  return { tests: [...byCode.values()], errors };
}
