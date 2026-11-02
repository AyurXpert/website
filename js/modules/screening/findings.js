// Session 374B (plan docs/handoff/session373_plan.md B1 / B3 / B4 / B10, contract §10): the Screening findings -- pure helpers shared by
// screening.js (the form), doctor.js (the read-only "Screening findings" box + queue order) and reception.js (the queue badge).
// The SERVER (screening_route_visit) is the authority on every limit and calculates BMI itself; the page only checks the same limits
// first so a mistake is named next to its box before anything is sent. No DOM, no network -- unit-tested in scripts/check-373-screening.mjs.
import { DESIG_MAP } from '../../config/designations.js';

// F3 / R3 (owner 2 Nov 2026): a designation in WORDS ("Staff Nurse"), never the code ("staff_nurse"); an unknown code -> its words with
// spaces, never blank. The one lookup for every place a screener is named.
export const desigWords = d => (d ? (DESIG_MAP[d]?.l || String(d).replace(/_/g, ' ')) : '');

export const TRIAGE = [
  { key: 'routine',     label: 'Routine' },
  { key: 'semi_urgent', label: 'Semi-urgent' },
  { key: 'urgent',      label: 'Urgent' },
  { key: 'emergency',   label: 'Emergency' },
];
const TRIAGE_RANK = { emergency: 0, urgent: 1, semi_urgent: 2, routine: 3 };
export const triageLabel = key => TRIAGE.find(t => t.key === key)?.label || '';
// queue order: Emergency → Urgent → Semi-urgent → Routine → not screened; then token
export const triageRank = key => (key in TRIAGE_RANK ? TRIAGE_RANK[key] : 4);

// the same limits and labels as the server (contract §10.2 screening_route_visit). V1 (owner re-check 2 Nov 2026): these are the
// PHYSICALLY IMPOSSIBLE limits only ("please check the number — this value is not possible"); a clinically abnormal value is accepted and
// shown as an amber flag (vitalFlags below), never refused
export const NUM_FIELDS = [
  { key: 'pulse',         id: 'scr-pulse',  label: 'Pulse',            min: 20, max: 250, int: true },
  { key: 'bp_systolic',   id: 'scr-bp-s',   label: 'BP systolic',      min: 50, max: 300, int: true },
  { key: 'bp_diastolic',  id: 'scr-bp-d',   label: 'BP diastolic',     min: 20, max: 200, int: true },
  { key: 'temperature_f', id: 'scr-temp',   label: 'Temperature (°F)', min: 85, max: 113, dec: 1 },
  { key: 'spo2',          id: 'scr-spo2',   label: 'SpO₂',             min: 50, max: 100, int: true },
  { key: 'height_cm',     id: 'scr-height', label: 'Height (cm)',      min: 30, max: 250 },
  { key: 'weight_kg',     id: 'scr-weight', label: 'Weight (kg)',      min: 1,  max: 300, dec: 1 },
];
export const TEXT_FIELDS = [
  { key: 'chief_complaint',          id: 'scr-cc',           label: 'Chief complaint',         max: 1000 },
  { key: 'naadi',                    id: 'scr-naadi',        label: 'Naadi',                   max: 200 },
  { key: 'observations',             id: 'scr-notes',        label: 'Observations',            max: 2000 },
  { key: 'suggested_investigations', id: 'scr-inv',          label: 'Suggested investigations', max: 1000 },
  { key: 'instructions',             id: 'scr-instructions', label: 'Instructions',            max: 1000 },
];

export const notPossible = label => `${label}: please check the number — this value is not possible.`;

// V1 (owner re-check 2 Nov 2026): CLINICAL flags -- a warning only (amber), never a refusal; shown at the field on the Screening page
// and carried into the doctor's "Screening findings" box. v = numbers (findings / a screening_findings row) -> [{ key, id, text, level }]
// Pulse (owner's clinical rule, 2 Nov 2026): 60–100 normal; < 60 Bradycardia / 101–150 Tachycardia = amber; > 150 = RED "⛔ Pulse above
// 150 — consider Emergency triage" (a prompt -- the screener decides, never blocked); < 20 or > 250 = a typing error (NUM_FIELDS).
export function vitalFlags(v = {}) {
  const n = k => (v[k] === null || v[k] === undefined || v[k] === '' ? null : Number(v[k]));
  const pulse = n('pulse'), spo2 = n('spo2'), s = n('bp_systolic'), d = n('bp_diastolic'), t = n('temperature_f');
  const out = [];
  if (pulse !== null && pulse < 60) out.push({ key: 'pulse', id: 'scr-pulse', level: 'amber', text: `Bradycardia (pulse ${pulse})` });
  else if (pulse !== null && pulse > 150) out.push({ key: 'pulse', id: 'scr-pulse', level: 'red', text: `⛔ Pulse above 150 (${pulse}) — consider Emergency triage` });
  else if (pulse !== null && pulse > 100) out.push({ key: 'pulse', id: 'scr-pulse', level: 'amber', text: `Tachycardia (pulse ${pulse})` });
  if (spo2 !== null && spo2 < 94) out.push({ key: 'spo2', id: 'scr-spo2', level: 'amber', text: `Low SpO₂ (${spo2} %)` });
  if (s !== null && d !== null) {
    if (s >= 140 || d >= 90) out.push({ key: 'bp', id: 'scr-bp-d', level: 'amber', text: `High BP (${s}/${d})` });
    else if (s < 90 || d < 60) out.push({ key: 'bp', id: 'scr-bp-d', level: 'amber', text: `Low BP (${s}/${d})` });
  }
  if (t !== null && t >= 100.4) out.push({ key: 'temperature_f', id: 'scr-temp', level: 'amber', text: `Fever (${t} °F)` });
  return out;
}

// BMI preview (the server stores its own, same formula: weight / (height / 100)², one decimal)
export function bmi(heightCm, weightKg) {
  const h = Number(heightCm), w = Number(weightKg);
  if (!(h > 0) || !(w > 0)) return null;
  return Math.round((w / ((h / 100) ** 2)) * 10) / 10;
}

// raw = { triage, pulse: '82', bp_systolic: '130', ..., naadi: 'Vata', observations: '...' } (strings from the boxes)
// -> { findings, errors: [{ key, id, message }] }. Empty = not recorded (never sent).
export function buildFindings(raw = {}) {
  const findings = {}, errors = [];
  if (!TRIAGE_RANK.hasOwnProperty(raw.triage)) errors.push({ key: 'triage', id: 'scr-triage', message: 'Choose the triage level.' });
  else findings.triage = raw.triage;
  for (const f of NUM_FIELDS) {
    const s = String(raw[f.key] ?? '').trim();
    if (!s) continue;
    const n = Number(s);
    if (!Number.isFinite(n)) { errors.push({ key: f.key, id: f.id, message: `${f.label} must be a number.` }); continue; }
    if (n < f.min || n > f.max) { errors.push({ key: f.key, id: f.id, message: notPossible(f.label) }); continue; }
    if (f.int && !Number.isInteger(n)) { errors.push({ key: f.key, id: f.id, message: `${f.label} must be a whole number.` }); continue; }
    findings[f.key] = f.dec ? Math.round(n * 10 ** f.dec) / 10 ** f.dec : n;
  }
  const hasS = 'bp_systolic' in findings, hasD = 'bp_diastolic' in findings;
  const bpBad = errors.some(e => e.key === 'bp_systolic' || e.key === 'bp_diastolic');
  if (!bpBad && (hasS !== hasD || (hasS && findings.bp_systolic <= findings.bp_diastolic))) {
    errors.push({ key: 'bp', id: hasS && !hasD ? 'scr-bp-d' : 'scr-bp-s', message: 'Enter both BP numbers (systolic above diastolic).' });
  }
  for (const f of TEXT_FIELDS) {
    const s = String(raw[f.key] ?? '').trim();
    if (!s) continue;
    if (s.length > f.max) { errors.push({ key: f.key, id: f.id, message: `${f.label} is too long (at most ${f.max} characters).` }); continue; }
    findings[f.key] = s;
  }
  return { findings, errors };
}

const istTime = iso => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '');

// a queue row of screening_queue_today() -> who holds it, or '' when free / mine
export function claimText(row) {
  if (!row?.claim_active || row.claimed_by_me) return '';
  return `With ${row.claim_counter || '—'} — ${row.claimed_by_name || 'another screener'}`;
}

// a screening_findings row -> the lines of the doctor's read-only box: [{ label, value }]
export function findingsLines(f) {
  if (!f) return [];
  const lines = [];
  const add = (label, value) => { if (value !== null && value !== undefined && String(value).trim() !== '') lines.push({ label, value: String(value) }); };
  add('Triage', triageLabel(f.triage) + (f.emergency ? ' — sent as EMERGENCY' : ''));
  const v = [
    f.pulse != null ? `Pulse ${f.pulse}/min` : '',
    f.bp_systolic != null ? `BP ${f.bp_systolic}/${f.bp_diastolic} mmHg` : '',
    f.temperature_f != null ? `Temp ${f.temperature_f} °F` : '',
    f.spo2 != null ? `SpO₂ ${f.spo2} %` : '',
    f.height_cm != null ? `Height ${f.height_cm} cm` : '',
    f.weight_kg != null ? `Weight ${f.weight_kg} kg` : '',
    f.bmi != null ? `BMI ${f.bmi}` : '',
  ].filter(Boolean).join(' · ');
  add('Vitals', v);
  const flags = vitalFlags(f);
  const red = flags.filter(x => x.level === 'red'), amber = flags.filter(x => x.level !== 'red');
  if (red.length) lines.push({ label: 'Clinical alert', value: red.map(x => x.text).join(' · '), flag: 'red' });
  if (amber.length) lines.push({ label: 'Clinical flags', value: '⚠ ' + amber.map(x => x.text).join(' · '), flag: true });
  add('Naadi', f.naadi);
  add('Observations', f.observations);
  add('Suggested investigations', f.suggested_investigations);
  add('Instructions', f.instructions);
  const who = [f.screened_by_name ? `Screened by ${f.screened_by_name}${f.screened_by_designation ? ' (' + desigWords(f.screened_by_designation) + ')' : ''}` : '',
    f.counter_label || '', istTime(f.routed_at || f.created_at), f.supervisor_name ? `supervised by ${f.supervisor_name}` : ''].filter(Boolean).join(' · ');
  add('Screened', who);
  return lines;
}

// findings -> the doctor's vitals boxes (only boxes the doctor's form has; temperature in °F like the form)
export function vitalsPrefill(f) {
  if (!f) return {};
  const out = {};
  if (f.bp_systolic != null) out['v-bp-s'] = f.bp_systolic;
  if (f.bp_diastolic != null) out['v-bp-d'] = f.bp_diastolic;
  if (f.pulse != null) out['v-pulse'] = f.pulse;
  if (f.temperature_f != null) out['v-temp'] = f.temperature_f;
  if (f.weight_kg != null) out['v-weight'] = f.weight_kg;
  if (f.spo2 != null) out['v-spo2'] = f.spo2;
  return out;
}

// queue order for doctor / reception: findings triage (or an emergency visit category) first, then token
export function queueOrder(visits, findingsByVisit) {
  const rank = v => {
    const f = findingsByVisit?.[v.id];
    if (v.visit_category === 'emergency' || f?.emergency) return 0;
    return triageRank(f?.triage);
  };
  return [...(visits || [])].sort((a, b) => rank(a) - rank(b) || (Number(a.token_number) || 0) - (Number(b.token_number) || 0));
}

// PAID / PENDING for a visit: its own bill, else the bill of the Screening visit it was routed from (B5). bills = rows {visit_id, status}
// G3 (owner 2 Nov 2026): a patient routed from Screening with no bill at all is unpaid -> PENDING (never a blank badge)
export function payState(visit, billsByVisit) {
  const own = billsByVisit?.[visit.id], scr = visit.screening_visit_id ? billsByVisit?.[visit.screening_visit_id] : null;
  const b = own || scr;
  if (!b) return visit.screening_visit_id ? 'pending' : null;
  return b.status === 'paid' ? 'paid' : 'pending';
}
