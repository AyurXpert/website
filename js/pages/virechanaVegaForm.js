// Session 258 (Part A, real-world workflow correction) — Virechana Vega Assessment
// printable form. A nurse cannot realistically sit with a patient for every one of
// ~30 bouts through an 8-hour purgation window (Dr. Venkatesh, confirmed live). The
// real workflow: this sheet is handed to the patient at the time of administration,
// explained once, and the patient fills one row per motion through the day — handed
// back to whichever nurse/PG/doctor is available at day's end for transcription into
// the digital record (bulk-entry grid, not built yet — this is the printable artifact
// only). Deliberately has NO Supabase dependency: pure static print page, optionally
// pre-filled via flat URL query params a caller (e.g. nursing.js, not yet wired) can
// pass without needing its own DB round trip.

import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

const params = new URLSearchParams(window.location.search);

// Hospital branding — read from sessionStorage (set by auth.js on login), same as
// every other print page in this codebase. Degrades gracefully if opened logged-out
// (e.g. a pre-printed blank-stock run) — falls back to the generic AyurXpert name.
const tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
if (tenant.name) document.getElementById('clinic-name').textContent = tenant.name;
if (tenant.logo_url) {
  const logo = document.getElementById('clinic-logo');
  logo.src = tenant.logo_url;
  logo.style.display = '';
}

function _fill(id, value) {
  const el = document.getElementById(id);
  if (el && value) el.textContent = value;
}

_fill('f-name', params.get('name'));
_fill('f-age', params.get('age'));
_fill('f-bed', params.get('bed'));
_fill('f-date', params.get('date') || new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }));
_fill('f-drug', params.get('drug'));
_fill('f-time', params.get('time'));
_fill('f-doctor', params.get('doctor'));
_fill('f-uhid', params.get('uhid'));

// ── The 30-row table — printed options the patient circles by hand, not digital
// controls (a <input type=radio> doesn't print as something a pen can circle). ────
const ROW_COUNT = 30;
const body = document.getElementById('vega-table-body');
let rows = '';
for (let i = 1; i <= ROW_COUNT; i++) {
  rows += `<tr>
    <td class="num-col">${i}</td>
    <td class="time-col"></td>
    <td class="opt-row">S&nbsp;&nbsp;&nbsp;M&nbsp;&nbsp;&nbsp;L</td>
    <td class="opt-row">1&nbsp;&nbsp;2&nbsp;&nbsp;3&nbsp;&nbsp;4&nbsp;&nbsp;5&nbsp;&nbsp;6&nbsp;&nbsp;7</td>
    <td class="opt-row">Stool&nbsp;&nbsp;Bile&nbsp;&nbsp;Mucus&nbsp;&nbsp;Clear</td>
    <td class="opt-row">Yes&nbsp;&nbsp;/&nbsp;&nbsp;No</td>
  </tr>`;
}
body.innerHTML = rows;
