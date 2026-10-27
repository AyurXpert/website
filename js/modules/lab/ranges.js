// Session 363 (TODO §263 a, owner Q4 / Q5): ONE place for how a lab result's flag and reference range are shown.
// The flag itself is decided by the SERVER (sql/session363_lab_catalogue_walkin.sql, _lab_flag_for -- the saved lab_order_items.flag /
// range_used); flagFor() below is its twin, used only for the live preview while a technician types (the saved row is what counts).
// Never a silent "Normal": no result / no range = no flag, and the reason is shown ("range not set", "not a number" ...).
// Results saved before 363 (flag + range_used empty) keep their saved is_abnormal / is_critical (owner Q5).

export const FLAG_TEXT = {
  normal: 'Normal', low: '▼ Low', high: '▲ High', abnormal: 'Abnormal',
  critical_low: '⚠ CRITICAL LOW', critical_high: '⚠ CRITICAL HIGH',
};
export const NOTE_TEXT = {
  'range not verified': 'range not verified',
  'range not set': 'range not set',
  'not a number': 'not a number — not flagged',
  'not interpreted': 'not interpreted',
  'no result': '',
};

export function labSex(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s === 'm' || s === 'male' ? 'M' : s === 'f' || s === 'female' ? 'F' : null;
}

const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
const fmt = v => String(Number(v));

// the bands of a test that apply to this patient: the patient's sex when the test has any for it, else 'any'; age in [min, max)
export function applicableBands(ranges, sex, age) {
  const s = labSex(sex);
  const a = num(age);
  const ageOk = r => (a === null ? num(r.age_max) === null : a >= (num(r.age_min) || 0) && (num(r.age_max) === null || a < num(r.age_max)));
  const pool = (ranges || []).filter(ageOk);
  const want = s && pool.some(r => r.sex === s) ? s : 'any';
  return pool.filter(r => r.sex === want).sort((x, y) => (x.sort_order || 0) - (y.sort_order || 0));
}

export function bandText(bands, test) {
  if (test?.result_type === 'text') return (test.normal_values || []).join(' / ');
  return bands.slice().sort((x, y) => (num(x.low) ?? -1e15) - (num(y.low) ?? -1e15) || (num(x.high) ?? 1e15) - (num(y.high) ?? 1e15))
    .map(b => {
      const lo = num(b.low), hi = num(b.high);
      const t = lo === null ? (b.high_inclusive === false ? '<' : '≤') + fmt(hi)
        : hi === null ? (b.low_inclusive === false ? '>' : '≥') + fmt(lo)
        : (b.low_inclusive === false ? '>' : '') + fmt(lo) + ' – ' + (b.high_inclusive === false ? '<' : '') + fmt(hi);
      return t + (b.label ? ' ' + b.label : b.kind === 'abnormal' ? ' (abnormal)' : '');
    }).join(' · ');
}

// (Session 363 review, owner 27 Oct 2026) eslint flags the two patterns below as "unsafe regex": they are not. Both are anchored and
// have no nested or overlapping quantifiers (digits / '.' / spaces / '-' are disjoint), so matching is linear -- measured on crafted
// inputs of 80,000+ characters: < 1 ms. The SAVED flag is the server's anyway (_lab_flag_for, PostgreSQL's non-backtracking engine).
function parseNumber(txt) {
  const t = String(txt).trim();
  const r = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(t);   // "2-4" (/hpf): the upper value
  if (r) return Number(r[2]);
  const s = t.replace(/,/g, '').replace(/^[<>]=?\s*/, '');
  return /^[-+]?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

// the twin of the server's _lab_flag_for (preview only)
export function flagFor(test, value, sex, age) {
  if (!test) return { flag: null, note: 'range not set' };
  const bands = applicableBands(test.ranges, sex, age);
  const range_text = bandText(bands, test) || null;
  const verified = bands.length ? bands.every(b => !!b.verified_at) : false;
  const out = (flag, note = null, band_label = null) => ({
    flag, band_label, verified, range_text, unit: test.unit || null,
    note: note || (flag && !verified ? 'range not verified' : null),
  });
  const txt = String(value ?? '').trim();
  if (!txt) return out(null, 'no result');
  if (test.result_type !== 'text') {
    const v = parseNumber(txt);
    if (v === null) return out(null, 'not a number');
    if (test.critical_low !== null && test.critical_low !== undefined && v <= Number(test.critical_low)) return out('critical_low');
    if (test.critical_high !== null && test.critical_high !== undefined && v >= Number(test.critical_high)) return out('critical_high');
    if (!bands.length) return out(null, 'range not set');
    const inBand = b => (num(b.low) === null || v > num(b.low) || (b.low_inclusive !== false && v === num(b.low)))
                     && (num(b.high) === null || v < num(b.high) || (b.high_inclusive !== false && v === num(b.high)));
    const hit = bands.filter(inBand).sort((x, y) => (y.kind === 'normal') - (x.kind === 'normal'))[0];
    const normals = bands.filter(b => b.kind !== 'abnormal');
    if (hit && hit.kind !== 'abnormal') return out('normal', null, hit.label || null);
    if (normals.length) {
      const above = normals.every(b => num(b.high) !== null && (v > num(b.high) || (v === num(b.high) && b.high_inclusive === false)));
      const below = normals.every(b => num(b.low) !== null && (v < num(b.low) || (v === num(b.low) && b.low_inclusive === false)));
      return out(above ? 'high' : below ? 'low' : 'abnormal', null, hit?.label || null);
    }
    return hit ? out('abnormal', null, hit.label || null) : out(null, 'range not set');
  }
  const lv = txt.toLowerCase();
  const normalsT = test.normal_values || [];
  if (normalsT.some(n => String(n).trim().toLowerCase() === lv)) return out('normal');
  if (/^(non[- ]?reactive|not detected|negative|nil|absent|no growth|not seen|none seen|sterile)/.test(lv)) return normalsT.length ? out('normal') : out(null, 'range not set');
  if (/(^|[^a-z])(positive|reactive|detected|present|growth|seen|isolated)([^a-z]|$)/.test(lv)) return out('abnormal');
  return out(null, normalsT.length ? 'not interpreted' : 'range not set');
}

// how a SAVED line is shown: the server's flag when it has one (363), else the pre-363 saved flag (Q5)
export function itemFlag(item) {
  if (!item) return { flag: null, text: '—', cls: 'none', note: '' };
  const ru = item.range_used;
  if (ru || item.flag) {
    const f = item.flag || null;
    return { flag: f, text: f ? FLAG_TEXT[f] + (item.range_used?.band_label && f !== 'normal' ? ' · ' + item.range_used.band_label : '') : '—',
             cls: !f ? 'none' : f.startsWith('critical') ? 'critical' : f === 'normal' ? 'normal' : 'abnormal',
             note: NOTE_TEXT[ru?.note] ?? (ru?.note || '') };
  }
  if (item.is_critical) return { flag: 'critical', text: FLAG_TEXT.critical_high.replace(' HIGH', ''), cls: 'critical', note: '' };
  if (item.is_abnormal) return { flag: 'abnormal', text: 'Abnormal', cls: 'abnormal', note: '' };
  const has = String(item.result_value ?? '').trim() !== '';
  return { flag: has ? 'normal' : null, text: has ? 'Normal' : '—', cls: has ? 'normal' : 'none', note: '' };
}

// the reference text of a saved line (the frozen band, else the stored text)
export function itemRangeText(item) {
  return item?.range_used?.range_text || item?.reference_range || '';
}
