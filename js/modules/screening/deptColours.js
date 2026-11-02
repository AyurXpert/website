// F1 (owner 2 Nov 2026, TODO §402): ONE colour per clinical department, used the same everywhere a department is shown (the Screening
// strip bars, the date-range table, the department day-by-day chart, the screener log's OPDs) -- ALWAYS next to the department's name
// (never colour alone). Keyed by the NCISM code; a department without a known code gets a colour from the spare list by its position.
// Every colour is dark enough for white text and for a bar on white / the strip's light purple (contrast >= 4.5:1 on white).
// The one source: no page may define its own department colours.
export const DEPT_COLOURS = {
  KAY:  '#1a4080',   // Kayachikitsa -- the semantic blue
  PK:   '#8b1a6b',   // Panchakarma -- the semantic purple
  SHAL: '#9c4a00',   // Shalya
  SHAK: '#0e6b66',   // Shalakya -- the semantic teal
  KAU:  '#5b3f99',   // Kaumarabhritya
  PST:  '#a3245e',   // Prasuti Tantra & Stri Roga
  SW:   '#2d6a2f',   // Swasthavritta & Yoga
  AGD:  '#5c5a12',   // Agada Tantra
};
const SPARE = ['#4a3b2a', '#2f4f6f', '#6b2f2f', '#3d5a1e', '#5a2f6b', '#1f5a5a'];

// { code, index } -> '#rrggbb'
export function deptColour(code, index = 0) {
  const c = String(code || '').toUpperCase();
  if (DEPT_COLOURS[c]) return DEPT_COLOURS[c];
  return SPARE[Math.abs(Number(index) || 0) % SPARE.length];
}

// a small colour dot + the name, for tables and lists (the name is always there; the dot is aria-hidden)
export function deptLabel(name, code, index = 0) {
  const wrap = document.createElement('span');
  wrap.className = 'dept-label';
  const dot = document.createElement('span');
  dot.className = 'dept-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.style.background = deptColour(code, index);
  wrap.append(dot, document.createTextNode(name || '—'));
  return wrap;
}
