// Session 167: this page used to create its OWN separate Supabase client here
// (createClient(SUPABASE_URL, SUPABASE_ANON_KEY), a pre-existing pattern in this specific
// file) instead of the shared singleton every other page imports. Adding the roster-changed
// check first tried fixing that check's own race condition by ALSO importing the shared
// singleton alongside this file's existing client -- which was the wrong shape of fix: it left
// TWO GoTrueClient instances alive on the same page sharing the same localStorage auth key,
// confirmed live (Dr. Venkatesh's real console) as "Multiple GoTrueClient instances detected...
// may produce undefined behavior" -- and very likely also the cause of the CSP connect-src
// blocks seen alongside it, both a direct regression from that first attempt. Fixed properly
// this time: nursing.js now uses the ONE shared singleton for everything, same as roster.js and
// every other page already does -- eliminating the second client, not adding a third fix on top
// of the wrong one. Confirmed safe first: nursing.js's own client had zero .auth.* listeners or
// realtime channel usage of its own to lose -- every use throughout this file is a plain
// .from(...) query, a mechanical, behavior-preserving substitution.
import { supabase } from '../core/db/supabaseClient.js';
import { requireAuth, getCurrentProfile, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { logAudit } from '../core/auditLogger.js';
import { getEffectivePrice } from '../modules/billing/effectivePrice.js';
import { renderPromoBanner } from '../components/promoBanner.js';
import { checkRosterChanged } from '../modules/roster/scheduleChangeIndicator.js';
import { fetchMyDuty, renderMyDutyHtml, renderTodayHtml } from '../modules/roster/myDutyWidget.js';
import { shiftTimes, shiftNames } from '../config/ncism.js';
import { IPD_MEDICAL_BED_CODES, IPD_SURGICAL_BED_CODES } from '../config/ncismStaffCompliance.js';
import { computeNurseBedSlice } from '../modules/roster/realBedSlicing.js';

requireAuth(['nurse','nurse_manager','super_admin','dept_admin','doctor']);
initNavbar();
wireDelegatedEvents();

const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = tenant?.id;
const userId    = profile?.id;
const _ctx      = { tenantId, userId, userName: profile?.full_name };
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

let _admissions = [];
let _activeAdm  = null;
let _activeTab  = 'vitals';
let _shift      = 'morning';
// Session 179: the logged-in nurse's own real per-nurse bed-number slice (realBedSlicing.js),
// set by _autoSelectFromDuty() when a "myslice" ward-select option is generated for her --
// null for any other role/viewer, or a nurse with no real beds configured yet for her ward.
let _mySliceDeptIds = null;
let _mySliceNumbers = null;
let _mySliceLabel   = '';

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('nursing-date').value = new Date().toISOString().slice(0,10);
document.getElementById('io-date-label').textContent = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
renderPromoBanner('promo-banner', { supabase, tenantId });

// Session 167: "your schedule changed" indicator -- plain `nurse` role only (nurse_manager/
// admins already know when they just published something, and Generate Roster only ever
// schedules staff_nurse/ward_sister/anm designations, never nursing_superintendent/deputy, so a
// nurse_manager has no "own shifts" for this to even apply to). Fire-and-forget, non-blocking --
// never awaited by anything else on this page, purely additive to the existing boot sequence.
if (profile?.role === 'nurse') {
  checkRosterChanged(supabase, tenantId, userId).then(({ changed, count }) => {
    if (!changed) return;
    // count crosses a module boundary -- always a real integer by construction
    // (scheduleChangeIndicator.js's `count || 0`), but coerced explicitly here anyway so it can
    // only ever render as digits, matching the house rule of never trusting a value's origin
    // when it lands in innerHTML.
    const n = Number(count) || 0;
    const el = document.getElementById('roster-change-banner');
    el.innerHTML = `🔔 <strong>Your duty roster has changed</strong> — ${n} new or updated shift${n === 1 ? '' : 's'} published. <a href="roster.html">View my roster →</a>`;
    // Real bug found live (Session 167, Dr. Venkatesh testing as nursingip1@sdm.com): this file's
    // own .alert{display:none} class rule (line ~34) still applies even after clearing the
    // inline style -- `el.style.display=''` only removes an inline override, it doesn't beat a
    // class-level CSS rule. This file already has an established .alert.show{display:block}
    // convention for exactly this (see _alert(), used by #alert-box) -- this banner just never
    // used it. The check/data/DOM-write were all correct the whole time; the banner was silently
    // rendering with content, just invisible -- explains why zero console errors ever appeared.
    el.classList.add('show');
  }).catch(err => console.error('[roster-change-banner]', err)); // was silently swallowed before -- now at least visible in devtools if this isn't the whole fix
}

// Session 168: permanent "My Duty" card -- this cycle's + next cycle's duty postings for the
// logged-in nurse, shown every time this page loads (not just when something recently changed,
// unlike the banner above). Same `role === 'nurse'` scoping as that banner and for the same
// reason -- nurse_manager/admin viewers aren't personally scheduled by the roster solver, so
// there'd be nothing real to show them. Fire-and-forget, non-blocking.
//
// Session 168 follow-up (Dr. Venkatesh, same day, after seeing it live): only today's duty (or
// "Day Off") stays permanently visible; the full This/Next period grid starts collapsed and
// expands on click -- see toggleMyDuty() below and #my-duty-full/.show in nursing.html's CSS.
window.toggleMyDuty = function(headerEl) {
  const full = document.getElementById('my-duty-full');
  const chevron = document.getElementById('my-duty-chevron');
  const open = full.classList.toggle('show');
  headerEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (chevron) chevron.textContent = open ? '▴' : '▾';
};

// Session 179 real bug fix: this page used to list EVERY active org-wide department in the ward
// selector (32 on SDM -- Administration/Pharmacy/etc alongside the nursing-roster's own pooled
// STAFFING zone abstractions like "Medical In-Patients"/"Surgical In-Patients", which own ZERO
// real beds themselves -- see IPD_MEDICAL_BED_CODES/IPD_SURGICAL_BED_CODES import above). None
// of those are ever a place a nurse actually charts a real patient. The true charting wards are
// exactly whichever departments own rows in `beds` -- querying that directly (rather than hand-
// listing NCISM codes here) means this list stays correct automatically if a tenant's bed
// layout ever changes, and can never drift from what admin.html/roster.html already treat as
// the real wards.
const { data: bedRows } = await supabase.from('beds').select('department_id').eq('tenant_id', tenantId);
const wardDeptIds = [...new Set((bedRows||[]).map(b => b.department_id).filter(Boolean))];
const { data: depts } = await supabase.from('departments')
  .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true)
  .in('id', wardDeptIds.length ? wardDeptIds : ['00000000-0000-0000-0000-000000000000'])
  .order('name');
const wardSel = document.getElementById('ward-select');
const deptNameById = {};
(depts||[]).forEach(d => { deptNameById[d.id] = d.name; });

// Session 179 real design correction (Dr. Venkatesh, live testing): a nurse is never actually
// posted to one specific real ward here -- her duty_roster row posts her to a POOLED zone
// ("Medical In-Patients" = Kayachikitsa + Kaumarabhritya + Agada Tantra combined, per NCISM's
// 1-nurse-per-N-beds ratio spanning all of them together), and she's responsible for admitted
// patients across every real ward in that zone at once. Listing each real ward as its own
// separate dropdown option (the previous fix) was still wrong -- picking just "Kayachikitsa"
// would silently hide her patients admitted to Kaumarabhritya/Agada Tantra. Confirmed which
// real wards are ACTUALLY pooled vs individually rostered by reading duty_roster itself (not
// guessed): Panchakarma has its own dedicated 350 duty_roster rows tagged directly to its own
// department id, its nurses are never rostered through a zone -- but Kayachikitsa/
// Kaumarabhritya/Agada Tantra/Shalya Tantra/Shalakya Tantra/Prasuti & Stri Roga have ZERO
// standalone rows, every one of their nurses is rostered through "Medical/Surgical In-Patients"
// instead. Queried fresh here (not hardcoded) so this keeps working if a tenant's rostering
// pattern ever differs.
// Session 179 real bug fix (Dr. Venkatesh, live correction): this used to treat ANY duty_roster
// presence as "already separately ward-staffed" -- which wrongly excluded Panchakarma from the
// Medical In-Patients zone. Panchakarma's own duty_roster rows are ALL shift_type='general'
// (confirmed live: 100% of them) -- that's this codebase's existing category for day-only
// procedure-room/OPD-type duty (Abhyanga/Vamana/Virechana treatments, 1pm-5pm), never 24x7 ward
// nursing (see js/config/ncism.js's NURSING_24X7_NAMES vs NURSING_GENERAL_DUTY_CODES split).
// Panchakarma's real IPD-admitted ward patients (25 beds: Male/Female General, Twin Sharing,
// Private, Deluxe, Dormitory) had NO round-the-clock roster coverage at all as a result -- a
// real gap, not a display bug. Fixed by only counting a department as separately ward-rostered
// if it has actual round-the-clock (morning/afternoon/night) duty_roster rows -- 'general'-only
// presence no longer excludes it from zone-pooling. Panchakarma now correctly pools into
// Medical In-Patients (60 real beds total: KAY+KAU+AGD+PK), matching the staffing formula's own
// 60-bed count (IPD_MEDICAL_BED_CODES) exactly -- the two numbers can no longer disagree.
const { data: rosterDeptRows } = await supabase.from('duty_roster').select('department_id,shift_type').eq('tenant_id', tenantId);
const rosterDeptIdSet = new Set((rosterDeptRows||[]).filter(r => r.shift_type !== 'general').map(r => r.department_id));
const { data: zoneDepts } = await supabase.from('departments')
  .select('id,name,category').eq('tenant_id', tenantId).in('category', ['IPD_MEDICAL','IPD_SURGICAL']);
const zoneMemberIds = {}; // zoneDeptId -> [real bed-owning ward dept ids pooled under it]
(zoneDepts||[]).forEach(z => {
  const memberCodes = z.category === 'IPD_MEDICAL' ? IPD_MEDICAL_BED_CODES : IPD_SURGICAL_BED_CODES;
  const members = (depts||[]).filter(d => memberCodes.includes(d.ncism_code) && !rosterDeptIdSet.has(d.id));
  if (members.length) zoneMemberIds[z.id] = members.map(d => d.id);
});
(zoneDepts||[]).forEach(z => {
  const members = zoneMemberIds[z.id];
  if (!members || !members.length) return;
  const memberNames = members.map(id => deptNameById[id]).filter(Boolean);
  const opt = document.createElement('option');
  opt.value = 'zone:' + z.id;
  opt.textContent = `${z.name} (${memberNames.join(', ')})`;
  wardSel.appendChild(opt);
});
(depts||[]).forEach(d => {
  const pooledIntoAZone = Object.values(zoneMemberIds).some(ids => ids.includes(d.id));
  if (pooledIntoAZone) return; // already represented via its zone option above, not on its own
  const opt = document.createElement('option');
  opt.value = d.id; opt.textContent = d.name + (d.ncism_code ? ' ('+d.ncism_code+')' : '');
  wardSel.appendChild(opt);
});

// Session 179 real bug fix: the shift pills below were static HTML hard-coded to the OLD
// equal_8x3 pattern's names/times (6am-2pm etc, internal value "evening") -- a tenant's actual
// configured pattern (nursing-roster-template.html's Shift Pattern card) can be six_six_twelve
// instead (8-2 / 2-8 / 8-8, Dr. Venkatesh's real reported times), and this page never looked it
// up at all. Rendered dynamically from the exact same shiftNames()/shiftTimes() every other
// roster page already uses, so this page can never disagree with the real published schedule.
// Internal value "afternoon" (not the old "evening") matches the shift_type value duty_roster
// and every other roster page already use.
const { data: shiftSettings } = await supabase.from('nursing_roster_settings')
  .select('shift_pattern').eq('tenant_id', tenantId).maybeSingle();
const _shiftPattern = shiftSettings?.shift_pattern || 'six_six_twelve';
const _shiftLabels = shiftNames(_shiftPattern);
const _shiftTimesMap = shiftTimes(_shiftPattern);
const _shiftIcons = { morning: '🌅', afternoon: '🌆', night: '🌙' };
(function renderShiftPills() {
  const wrap = document.getElementById('shift-pills-wrap');
  if (!wrap) return;
  wrap.innerHTML = ['morning','afternoon','night'].map((s, i) => {
    const label = _esc(_shiftLabels[s] || s);
    const time = _esc(_shiftTimesMap[s] || '');
    return `<button class="shift-pill${i===0?' active':''}" title="${time}" data-onclick="setShift" data-onclick-a0="@this" data-onclick-a1="${s}">${_shiftIcons[s]||''} ${label}</button>`;
  }).join('');
})();

// Session 168: permanent "My Duty" card -- this cycle's + next cycle's duty postings for the
// logged-in nurse, shown every time this page loads (not just when something recently changed,
// unlike the banner above). Same `role === 'nurse'` scoping as that banner and for the same
// reason -- nurse_manager/admin viewers aren't personally scheduled by the roster solver, so
// there'd be nothing real to show them. Fire-and-forget, non-blocking.
//
// Session 168 follow-up (Dr. Venkatesh, same day, after seeing it live): only today's duty (or
// "Day Off") stays permanently visible; the full This/Next period grid starts collapsed and
// expands on click -- see toggleMyDuty() below and #my-duty-full/.show in nursing.html's CSS.
//
// Session 179: Dr. Venkatesh's explicit ask -- "as the nurse is posted through duty roster
// these things [ward + shift] should be auto selected by the HMS as per the respective nurse
// login." Reuses this SAME fetchMyDuty() call (no second duty_roster query) -- see
// _autoSelectFromDuty() below for how a pooled zone posting ("Medical In-Patients") auto-selects
// its own "zone:<id>" option, showing patients across all of that zone's real member wards.
if (profile?.role === 'nurse') {
  fetchMyDuty(supabase, tenantId, userId).then(async data => {
    if (!data) return; // fetchMyDuty() already logged the specific error; nothing to render
    document.getElementById('my-duty-today').innerHTML = renderTodayHtml(data);
    document.getElementById('my-duty-body').innerHTML = renderMyDutyHtml(data);
    document.getElementById('my-duty-card').style.display = '';
    await _autoSelectFromDuty(data);
  }).catch(err => console.error('[my-duty-card]', err));
}

// Session 179: auto-selects ward + shift from the nurse's OWN today's duty_roster row(s) --
// prefers her "home" posting over a relief/extra-duty one if she has both today (matches
// Nursing IP 1's real SDM data: a home slot + a same-dept/shift relief slot on the same day).
// Shift is always unambiguous and gets auto-selected outright. Ward selection just picks
// whichever real <option> the ward-select above already built for her posted department --
// a standalone real ward (e.g. Panchakarma) selects directly; a pooled zone (Medical/Surgical
// In-Patients) selects its "zone:<id>" option directly too, which loadWardPatients() expands
// into all of that zone's real member wards' patients at once (see its own comment). No
// separate ncism_code/category lookup needed here anymore -- the dropdown's own <option> set is
// the single source of truth for what she can be posted to, built from the exact same real
// duty_roster data this function reads.
async function _autoSelectFromDuty(data) {
  const todays = (data.currentRows||[]).filter(r => r.shift_date === data.periods.today);
  if (!todays.length) return; // Day Off -- nothing to auto-select, leave the manual controls as-is
  const primary = todays.find(r => !r.is_relief_assignment) || todays[0];
  const note = document.getElementById('auto-posting-note');
  const shiftLabel = _shiftLabels[primary.shift_type] || primary.shift_type;
  const deptName = data.deptNames[primary.department_id] || '—';

  // Shift: always unambiguous.
  const shiftBtn = document.querySelector(`#shift-pills-wrap [data-onclick-a1="${primary.shift_type}"]`);
  if (shiftBtn) window.setShift(shiftBtn, primary.shift_type);

  const zoneOptValue = 'zone:' + primary.department_id;
  const hasDirectOption = [...wardSel.options].some(o => o.value === primary.department_id);
  const hasZoneOption = [...wardSel.options].some(o => o.value === zoneOptValue);

  if (!hasDirectOption && !hasZoneOption) {
    // Neither a real standalone ward nor one of the pooled IPD zones -- genuinely one of this
    // HMS's other nursing-duty places (OPD/Screening/Diagnostics/Operation Theatre/Labour Room/
    // Panchakarma Treatment Room), each with its own dedicated page. Telling her to "pick a
    // ward below" here would be actively misleading -- there isn't one on THIS page for a
    // posting like that.
    if (note) {
      note.style.display = '';
      note.textContent = `📍 Your duty roster posts you to ${deptName} (${shiftLabel} shift) today. This page covers IPD ward nursing — if today's posting is OPD/Screening/Diagnostics/OT/Labour Room/Panchakarma Treatment Room duty, use that module's own page instead.`;
    }
    return;
  }

  const deptIdsForSlice = hasDirectOption ? [primary.department_id] : (zoneMemberIds[primary.department_id] || []);

  // Session 179 (Dr. Venkatesh's explicit ask): a real per-nurse bed-number slice, tied to
  // actual `beds.bed_number` values -- see realBedSlicing.js's own module comment for the full
  // design reasoning (pure numeric slicing, no ward-type-awareness, generic across any tenant's
  // configuration). Needs her real slot_index (now selected by fetchMyDuty()) and how many
  // total slots exist for this exact department+shift+date -- queried fresh since fetchMyDuty()
  // only returns HER OWN rows, not her colleagues' (a real, small, one-off query -- deliberately
  // not folded into the shared module, which stays DB-shape-agnostic about slot counting).
  let mySlice = null;
  if (primary.slot_index != null && deptIdsForSlice.length) {
    const { data: slotRows } = await supabase.from('duty_roster').select('slot_index')
      .eq('tenant_id', tenantId).eq('department_id', primary.department_id)
      .eq('shift_type', primary.shift_type).eq('shift_date', data.periods.today);
    const totalSlots = Math.max(0, ...(slotRows||[]).map(r => r.slot_index || 0));
    if (totalSlots > 0) {
      mySlice = await computeNurseBedSlice(supabase, tenantId, deptIdsForSlice, primary.slot_index, totalSlots);
    }
  }

  if (mySlice) {
    // Real per-nurse option, inserted as the first real choice (right after the placeholder) --
    // this is HER specific assignment, the most relevant option for her to land on by default.
    const label = `🩺 ${deptName}${hasZoneOption ? ' zone' : ''} · Beds ${mySlice.rangeText}`;
    let opt = wardSel.querySelector('option[value="myslice"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.value = 'myslice';
      wardSel.insertBefore(opt, wardSel.options[1] || null);
    }
    opt.textContent = label;
    _mySliceDeptIds = deptIdsForSlice;
    _mySliceNumbers = new Set(mySlice.numbers);
    _mySliceLabel = `Beds ${mySlice.rangeText}`;
    wardSel.value = 'myslice';
    await window.loadWardPatients();
    if (note) {
      note.style.display = '';
      note.textContent = `📍 Auto-selected from your duty roster: ${deptName}${hasZoneOption ? ' zone' : ''} · 🛏️ Beds ${mySlice.rangeText} (of ${mySlice.zoneTotal} real beds in ${hasZoneOption ? 'this zone' : 'this ward'}) · ${shiftLabel} shift. Real bed numbers, not a staffing estimate. You can change this manually if you're covering elsewhere today.`;
    }
    return;
  }

  // Fallback -- no real beds configured yet for this ward/zone (e.g. Quick Setup never run),
  // so there's nothing to slice. Same behaviour as before this feature existed: select the
  // whole ward/zone option, and say so honestly rather than pretending a slice exists.
  if (hasDirectOption) {
    wardSel.value = primary.department_id;
    await window.loadWardPatients();
    if (note) {
      note.style.display = '';
      note.textContent = `📍 Auto-selected from your duty roster: ${deptName} · ${shiftLabel} shift. No real bed numbers are configured for this ward yet (Quick Setup), so this shows the whole ward. You can change this manually if you're covering elsewhere today.`;
    }
    return;
  }
  wardSel.value = zoneOptValue;
  await window.loadWardPatients();
  if (note) {
    note.style.display = '';
    note.textContent = `📍 Auto-selected from your duty roster: ${deptName} zone · ${shiftLabel} shift. No real bed numbers are configured for this zone yet (Quick Setup), so this shows everyone admitted across the whole zone. You can switch manually if you're covering elsewhere today.`;
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
window.switchTab = function(tab, el) {
  document.querySelectorAll('.module-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _activeTab = tab;
  ['vitals','mar','io','notes','handover','ward-proc','risk','discharge'].forEach(t => {
    const el = document.getElementById('tab-'+t);
    if (el) el.hidden = t !== tab;
  });
  if (tab === 'ward-proc') {
    document.getElementById('wp-date').value = new Date().toISOString().slice(0,10);
    loadWardProcedures();
  }
  if (tab === 'risk') loadRiskHistory();
  if (_activeAdm) loadTabData(tab);
};

window.setShift = function(el, shift) {
  document.querySelectorAll('.shift-pill').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _shift = shift;
  // Session 178 real bug fix: switching shifts used to do nothing but flip which value
  // saveIo()/saveVitals()/saveNote() would tag onto their NEXT write -- whatever the
  // currently-open tab was already showing (e.g. Morning's Intake-Output form) stayed on
  // screen unchanged, so a nurse switching to Evening mid-tab could end up looking at
  // (and potentially resaving) the wrong shift's data. Re-running the active tab's own
  // loader now matches switchTab()'s existing pattern exactly.
  if (_activeAdm) loadTabData(_activeTab);
};

// ── Load patients in ward ─────────────────────────────────────────────────────
// Session 179 follow-up: Dr. Venkatesh, testing live: "the dropdown is not showing zone wise
// bed range." The abstract duty_roster.bed_range_start/end note (added earlier this session)
// was never tied to a real bed -- it's a staffing-ratio split of a zone's pooled bed COUNT, not
// an actual bed lookup. Now that bed-admin.html's Piece 1-3 work created REAL physically
// zone-pure bed ranges, this computes them straight from the `beds` table for whichever
// department(s) the current ward/zone selection covers -- one min-max range per bed_type
// (Medical Ward's real beds are scattered across 7 different type-ranges, not one contiguous
// block, so there's no single number to show, same honest reasoning as _qs1CellSequence()'s
// own per-cell ranges in bed-admin.js). Deliberately scoped to the SAME department set already
// shown in the patient list (zone members only, e.g. excludes Panchakarma from "Medical
// In-Patients" even though it physically shares Medical Ward) -- so this note can never disagree
// with what's actually on screen below it.
const BED_TYPE_LABELS_SHORT = {male_general:'Male General',female_general:'Female General',general:'General',twin_sharing:'Twin Sharing',semi_private:'Shared Private',private:'Private',deluxe:'Deluxe',dormitory:'Dormitory',icu:'ICU',day_care:'Day Care',pk_treatment:'PK Treatment',observation:'Observation'};
const BED_TYPE_ORDER = Object.keys(BED_TYPE_LABELS_SHORT);
async function _realBedRangeText(deptIds) {
  if (!deptIds || !deptIds.length) return '';
  const { data } = await supabase.from('beds').select('bed_type,bed_number')
    .eq('tenant_id', tenantId).in('department_id', deptIds);
  if (!data || !data.length) return '';
  const byType = {};
  data.forEach(b => {
    const n = parseInt((b.bed_number || '').split('-').pop());
    if (isNaN(n)) return;
    if (!byType[b.bed_type]) byType[b.bed_type] = { min: n, max: n };
    else { byType[b.bed_type].min = Math.min(byType[b.bed_type].min, n); byType[b.bed_type].max = Math.max(byType[b.bed_type].max, n); }
  });
  return BED_TYPE_ORDER.filter(t => byType[t]).map(t => {
    const r = byType[t];
    return `${BED_TYPE_LABELS_SHORT[t]}: ${r.min === r.max ? r.min : r.min + '–' + r.max}`;
  }).join(' · ');
}

window.loadWardPatients = async function() {
  const deptId = document.getElementById('ward-select').value;
  if (!deptId) return;
  // Session 179: a "zone:<id>" selection (Medical/Surgical In-Patients) means the nurse is
  // pooled-responsible for admitted patients across ALL of that zone's real member wards at
  // once -- see the ward-select population code above for why. Expands into an `.in(...)`
  // across the real member department ids instead of a single `.eq(...)`.
  const isZone = deptId.startsWith('zone:');
  const zoneMembers = isZone ? (zoneMemberIds[deptId.slice(5)] || []) : null;
  // Session 179: her own real per-nurse bed-number slice (realBedSlicing.js), set by
  // _autoSelectFromDuty(). Reuses the SAME department-set expansion as a zone selection below
  // (her slice can span several real wards too), then narrows further to her specific numbers.
  const isMySlice = deptId === 'myslice';

  const bedRangeNoteEl = document.getElementById('pt-list-bed-range-note');
  if (bedRangeNoteEl) {
    if (isMySlice && _mySliceLabel) {
      bedRangeNoteEl.textContent = `🩺 Your real assigned range: ${_mySliceLabel}`;
      bedRangeNoteEl.style.display = '';
    } else {
      const rangeDeptIds = isZone ? zoneMembers : [deptId];
      const rangeText = await _realBedRangeText(rangeDeptIds);
      if (rangeText) {
        bedRangeNoteEl.textContent = `🛏️ Real bed ranges: ${rangeText}`;
        bedRangeNoteEl.style.display = '';
      } else {
        bedRangeNoteEl.style.display = 'none';
      }
    }
  }

  // Session 178 real bug fix: the date picker next to the ward selector was wired to
  // trigger this exact reload on change, but this function never actually read the date
  // at all -- picking any date reran the identical "currently admitted" query. Now a
  // past date shows a real historical view: who was actually on this ward that day
  // (admitted by then, and not yet discharged as of then). Today keeps the original,
  // unchanged "currently admitted" query exactly as before -- the common case is
  // untouched, both in behaviour and in which columns get selected.
  const selectedDate = document.getElementById('nursing-date').value || new Date().toISOString().slice(0,10);
  const todayStr = new Date().toISOString().slice(0,10);
  const isHistorical = selectedDate !== todayStr;

  // Session 114 -- a patient stays chartable/selectable through the
  // reconciliation window (clinically_discharged): they're still physically
  // on the ward until the nurse locks charges, per the confirmed policy
  // decision. beds(id,...) needed here (not just bed_number) so
  // lockChargesAndFreeBed() can free the actual bed row. department_id kept in the select
  // (Session 179) so a zone selection can show which specific real ward each patient is in.
  let query = supabase.from('ipd_admissions')
    .select('id,department_id,admission_date,diagnosis_primary,status,disposition,discharged_at,patients(id,name,age,gender,phone),beds(id,bed_number,ward_name)')
    .eq('tenant_id', tenantId);
  if (isMySlice) {
    query = query.in('department_id', (_mySliceDeptIds && _mySliceDeptIds.length) ? _mySliceDeptIds : ['00000000-0000-0000-0000-000000000000']);
  } else {
    query = isZone
      ? query.in('department_id', zoneMembers.length ? zoneMembers : ['00000000-0000-0000-0000-000000000000'])
      : query.eq('department_id', deptId);
  }
  query = isHistorical
    ? query.lte('admission_date', selectedDate).or(`discharged_at.is.null,discharged_at.gte.${selectedDate}`)
    : query.in('status', ['admitted','clinically_discharged']);
  let { data } = await query.order('admission_date');

  // Session 179: narrow to her REAL assigned bed numbers specifically -- the department-level
  // fetch above (same as a zone selection) is deliberately broad first so this filter has real
  // bed_number values to check against, then this cuts it down to exactly her slice. A patient
  // whose bed_number doesn't parse (shouldn't happen for a real Quick-Setup-created bed, but
  // defensive) is excluded rather than guessed into her list.
  if (isMySlice && _mySliceNumbers) {
    data = (data || []).filter(a => {
      const n = parseInt((a.beds?.bed_number || '').split('-').pop());
      return !isNaN(n) && _mySliceNumbers.has(n);
    });
  }

  const noteEl = document.getElementById('pt-list-historical-note');
  if (noteEl) {
    if (isHistorical) {
      noteEl.textContent = `📅 Showing who was on this ward on ${_fmtDate(selectedDate)} — a historical view, not live. New entries are always recorded with today's real date/time regardless of this selection.`;
      noteEl.style.display = '';
    } else {
      noteEl.style.display = 'none';
    }
  }

  _admissions = data || [];
  document.getElementById('pt-list-count').textContent = _admissions.length;
  const list = document.getElementById('patient-list');
  if (!_admissions.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;font-size:13px;color:var(--text-muted)">No admitted patients in this ward</div>';
    return;
  }
  list.innerHTML = _admissions.map(a => {
    // Session 179: a zone (or her own real slice, which can also span several real wards) view
    // pools several real wards into one list -- each row needs to say which one this particular
    // patient is actually in, or a nurse has no way to tell.
    const wardTag = (isZone || isMySlice) ? ` · <strong>${_esc(deptNameById[a.department_id]||'—')}</strong>` : '';
    return `
    <div class="pt-list-item${_activeAdm?.id===a.id?' active':''}" data-onclick="selectPatient" data-onclick-a0="${a.id}">
      <div class="pt-li-name">${_esc(a.patients?.name)||'—'}${a.status==='clinically_discharged' ? ' <span style="font-size:9px;font-weight:700;color:#8a5000;background:#fff3e0;border-radius:6px;padding:1px 6px">DISCHARGE ORDERED</span>' : ''}</div>
      <div class="pt-li-meta">
        Bed ${_esc(a.beds?.bed_number)||'?'} · ${_esc(a.patients?.age)||'?'}/${_esc((a.patients?.gender||'').charAt(0).toUpperCase())||'?'} · Day ${_daysSince(a.admission_date)}${wardTag}
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-style:italic">${_esc(a.diagnosis_primary)||'—'}</div>
    </div>`;
  }).join('');
};

window.selectPatient = function(id) {
  _activeAdm = _admissions.find(a => a.id === id);
  if (!_activeAdm) return;
  document.getElementById('no-patient-msg').style.display = 'none';
  document.getElementById('patient-content').style.display = 'block';
  document.getElementById('rp-pt-name').textContent = _activeAdm.patients?.name || '—';
  document.getElementById('rp-pt-meta').textContent =
    `Age ${_activeAdm.patients?.age||'?'} · ${(_activeAdm.patients?.gender||'').charAt(0).toUpperCase()||'?'} · ${_activeAdm.diagnosis_primary||'—'} · Admitted ${_fmtDate(_activeAdm.admission_date)}`;
  document.getElementById('rp-bed-badge').textContent = 'Bed ' + (_activeAdm.beds?.bed_number||'—');
  loadWardPatients(); // refresh active state
  loadTabData(_activeTab);
};

function loadTabData(tab) {
  if (tab === 'vitals')    loadVitals();
  if (tab === 'mar')       loadMar();
  if (tab === 'io')        loadIo();
  if (tab === 'notes')     loadNotes();
  if (tab === 'handover')  loadHandovers();
  if (tab === 'discharge') loadDischargeReconciliation();
}

// ── Vitals Chart ──────────────────────────────────────────────────────────────
const VITAL_LIMITS = {
  pulse:  { low:40, high:130, msg:'Pulse abnormal' },
  rr:     { low:8,  high:30,  msg:'Respiratory rate abnormal' },
  spo2:   { low:90, high:null,msg:'SpO₂ low — check oxygen' },
  sugar:  { low:60, high:400, msg:'Blood sugar critical' },
};
const BP_SYSTOLIC_LIMIT  = { low:80, high:180 };
// Session 178 real bug fix: diastolic never had any live check at all -- only the
// systolic field (v-bps) was wired to checkVital('bp', ...); the diastolic field
// (v-bpd) had no data-oninput handler whatsoever, so an abnormal diastolic reading
// (e.g. a hypertensive-crisis or dangerously-low value) went completely unflagged,
// live and in the vitals-history table. checkBP() now evaluates both fields together
// on either one changing, sharing the single w-bp warning div that already sits under
// the BP row (was only ever fed by systolic before).
const BP_DIASTOLIC_LIMIT = { low:50, high:120 };

window.checkVital = function(name, val) {
  const v = parseFloat(val);
  const lim = VITAL_LIMITS[name];
  const el = document.getElementById('w-'+name);
  if (!el || !lim || isNaN(v)) { if(el) el.textContent=''; return; }
  if ((lim.low !== null && v < lim.low) || (lim.high !== null && v > lim.high))
    el.textContent = '⚠ ' + lim.msg;
  else el.textContent = '';
};

window.checkBP = function() {
  const el = document.getElementById('w-bp');
  if (!el) return;
  const sys = parseFloat(document.getElementById('v-bps').value);
  const dia = parseFloat(document.getElementById('v-bpd').value);
  const sysAbnormal = !isNaN(sys) && (sys < BP_SYSTOLIC_LIMIT.low || sys > BP_SYSTOLIC_LIMIT.high);
  const diaAbnormal = !isNaN(dia) && (dia < BP_DIASTOLIC_LIMIT.low || dia > BP_DIASTOLIC_LIMIT.high);
  if (sysAbnormal && diaAbnormal)      el.textContent = '⚠ BP abnormal (systolic & diastolic)';
  else if (sysAbnormal)                el.textContent = '⚠ Systolic BP abnormal';
  else if (diaAbnormal)                el.textContent = '⚠ Diastolic BP abnormal';
  else                                  el.textContent = '';
};

window._updatePainDisplay = function(val) {
  document.getElementById('v-pain-display').textContent = val;
};

window.saveVitals = async function() {
  if (!_activeAdm) return;
  const payload = {
    tenant_id:      tenantId,
    admission_id:   _activeAdm.id,
    patient_id:     _activeAdm.patients?.id,
    recorded_by:    userId,
    recorded_at:    new Date().toISOString(),
    shift:          _shift,
    temperature:    parseFloat(document.getElementById('v-temp').value) || null,
    pulse:          parseInt(document.getElementById('v-pulse').value) || null,
    respiratory_rate:parseInt(document.getElementById('v-rr').value) || null,
    spo2:           parseInt(document.getElementById('v-spo2').value) || null,
    bp_systolic:    parseInt(document.getElementById('v-bps').value) || null,
    bp_diastolic:   parseInt(document.getElementById('v-bpd').value) || null,
    blood_sugar:    parseFloat(document.getElementById('v-sugar').value) || null,
    weight:         parseFloat(document.getElementById('v-weight').value) || null,
    observation:    document.getElementById('v-obs').value.trim() || null,
    pain_score:     document.getElementById('v-pain-score').value !== '' ? parseInt(document.getElementById('v-pain-score').value) : null,
  };
  const { error } = await supabase.from('nursing_vitals').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not record vitals.')); return; }
  _alert('success', 'Vitals recorded.');
  ['v-temp','v-pulse','v-rr','v-spo2','v-bps','v-bpd','v-sugar','v-weight','v-obs'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value='';
  });
  // Session 178 real bug fix: every other field above was reset after a save except this
  // one -- the pain-score slider silently kept showing whatever value was last set,
  // which could easily look like a fresh reading to the next entry. type="range" needs
  // its min (0), not '', or the browser just leaves it wherever it was.
  const painEl = document.getElementById('v-pain-score');
  if (painEl) painEl.value = '0';
  const painDisplay = document.getElementById('v-pain-display');
  if (painDisplay) painDisplay.textContent = '';
  ['w-pulse','w-rr','w-spo2','w-bp','w-sugar'].forEach(id => {
    const el = document.getElementById(id); if(el) el.textContent='';
  });
  loadVitals();
};

async function loadVitals() {
  const since = new Date(Date.now() - 7*24*3600*1000).toISOString();
  const { data } = await supabase.from('nursing_vitals')
    .select('*').eq('admission_id', _activeAdm.id)
    .gte('recorded_at', since).order('recorded_at', { ascending:false });
  const tbody = document.getElementById('vitals-tbody');
  if (!data?.length) { tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--text-muted)">No vitals recorded yet</td></tr>'; return; }
  tbody.innerHTML = data.map(v => `<tr>
    <td>${new Date(v.recorded_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})} ${new Date(v.recorded_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</td>
    <td>${v.temperature||'—'}</td>
    <td class="${v.pulse&&(v.pulse<40||v.pulse>130)?'alert-val':''}">${v.pulse||'—'}</td>
    <td class="${v.respiratory_rate&&(v.respiratory_rate<8||v.respiratory_rate>30)?'alert-val':''}">${v.respiratory_rate||'—'}</td>
    <td class="${v.spo2&&v.spo2<90?'alert-val':''}">${v.spo2||'—'}</td>
    <td class="${(v.bp_systolic&&(v.bp_systolic<80||v.bp_systolic>180))||(v.bp_diastolic&&(v.bp_diastolic<50||v.bp_diastolic>120))?'alert-val':''}">${v.bp_systolic&&v.bp_diastolic?v.bp_systolic+'/'+v.bp_diastolic:'—'}</td>
    <td class="${v.blood_sugar&&(v.blood_sugar<60||v.blood_sugar>400)?'alert-val':''}">${v.blood_sugar||'—'}</td>
    <td style="font-size:11px">${v.observation||'—'}</td>
  </tr>`).join('');
}

// ── MAR ───────────────────────────────────────────────────────────────────────
async function loadMar() {
  const today = new Date().toISOString().slice(0,10);
  const { data: meds } = await supabase.from('nursing_mar')
    .select('*').eq('admission_id', _activeAdm.id).eq('is_active', true).order('created_at');
  const { data: given } = await supabase.from('nursing_mar_given')
    .select('*').eq('admission_id', _activeAdm.id).gte('given_at', today+'T00:00').order('given_at', {ascending:false});

  const FREQ_TIMES = {
    once_daily:['08:00'], twice_daily:['08:00','20:00'], thrice_daily:['08:00','14:00','20:00'],
    four_times:['08:00','12:00','16:00','20:00'], sos:['SOS'], stat:['STAT'], other:['As ordered']
  };

  if (!meds?.length) {
    document.getElementById('mar-content').innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)">No medicines in MAR yet. Click "+ Add Medicine" to add.</div>`;
    return;
  }

  const rows = meds.map(m => {
    const times = FREQ_TIMES[m.frequency] || ['—'];
    const timeCols = times.map(t => {
      const rec = (given||[]).find(g => g.mar_id === m.id && g.scheduled_time === t);
      const status = rec?.status || 'due';
      return `<td><span class="mar-status ms-${status}">${{given:'Given',held:'Held',refused:'Refused',due:'Due'}[status]||status}</span>
        ${status==='due' && t!=='SOS'&&t!=='STAT' ? `<br><button data-onclick="markGiven" data-onclick-a0="${m.id}" data-onclick-a1="${t}" style="font-size:10px;padding:2px 6px;border-radius:4px;background:#1a4a2e;color:#fff;border:none;cursor:pointer;margin-top:3px">✓ Give</button>` : ''}</td>`;
    }).join('');
    return `<tr>
      <td><div style="font-weight:600">${m.medicine_name}</div><div style="font-size:10px;color:var(--text-muted)">${m.dose} · ${m.route} · ${m.frequency?.replace(/_/g,' ')}</div>${m.instructions?`<div style="font-size:10px;color:var(--text-mid)">${m.instructions}</div>`:''}</td>
      ${timeCols}
    </tr>`;
  }).join('');

  const allTimes = [...new Set(meds.flatMap(m => (FREQ_TIMES[m.frequency]||['—'])))];
  document.getElementById('mar-content').innerHTML = `<div style="overflow-x:auto"><table class="mar-table">
    <thead><tr><th>Medicine</th>${allTimes.map(t=>`<th>${t}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

window.markGiven = async function(marId, time) {
  if (!_activeAdm) return;
  const { error } = await supabase.from('nursing_mar_given').insert({
    tenant_id:      tenantId,
    admission_id:   _activeAdm.id,
    mar_id:         marId,
    given_by:       userId,
    given_at:       new Date().toISOString(),
    scheduled_time: time,
    status:         'given',
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not update MAR.')); return; }
  loadMar();
};

window.openAddMar = function() {
  document.getElementById('mar-start').value = new Date().toISOString().slice(0,10);
  document.getElementById('mar-modal-overlay').style.display = 'flex';
};
window.closeAddMar = function() { document.getElementById('mar-modal-overlay').style.display = 'none'; };
window._closeAddMarIfBackdrop = function(isTarget) { if (isTarget) closeAddMar(); };

window.saveMarMed = async function() {
  if (!_activeAdm) return;
  const { error } = await supabase.from('nursing_mar').insert({
    tenant_id:     tenantId,
    admission_id:  _activeAdm.id,
    medicine_name: document.getElementById('mar-med-name').value.trim(),
    dose:          document.getElementById('mar-dose').value.trim(),
    route:         document.getElementById('mar-route').value,
    frequency:     document.getElementById('mar-freq').value,
    start_date:    document.getElementById('mar-start').value || null,
    end_date:      document.getElementById('mar-end').value || null,
    instructions:  document.getElementById('mar-instructions').value.trim() || null,
    added_by:      userId,
    is_active:     true,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not add medicine to MAR.')); return; }
  _alert('success', 'Medicine added to MAR.');
  closeAddMar();
  loadMar();
};

// ── Intake-Output ─────────────────────────────────────────────────────────────
let _ioRows = { intake:[], output:[] };

function addIoRowHtml(type, label='', vol='') {
  const id = Date.now() + Math.random();
  const row = document.createElement('div');
  row.className = 'io-row';
  row.id = 'io-row-'+id;
  const sources = type==='intake'
    ? ['Oral Fluids','IV Fluids','NG Feeds','Blood Transfusion','Other']
    : ['Urine','Vomitus','Stool','Drain','Blood Loss','Other'];
  row.innerHTML = `
    <select style="height:32px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:11px;font-family:'DM Sans',sans-serif;width:100%">
      ${sources.map(s=>`<option${s===label?' selected':''}>${s}</option>`).join('')}
    </select>
    <input type="number" placeholder="Volume (mL)" value="${vol}" data-oninput="calcIoTotals" style="height:32px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:12px;font-family:'DM Sans',sans-serif;width:100%"/>
    <span style="font-size:11px;color:var(--text-muted)">mL</span>
    <button data-onclick="_removeIoRow" data-onclick-a0="io-row-${id}" style="height:30px;width:28px;background:var(--red-light);border:1px solid #f5c6c6;border-radius:6px;cursor:pointer;font-size:12px;color:var(--red)">✕</button>`;
  document.getElementById(type+'-rows').appendChild(row);
  calcIoTotals();
}

window.addIoRow = addIoRowHtml;

window._removeIoRow = function(rowId) {
  document.getElementById(rowId)?.remove();
  calcIoTotals();
};

window.calcIoTotals = function() {
  const sum = id => [...document.querySelectorAll(`#${id}-rows input[type=number]`)].reduce((s,i)=>s+(parseFloat(i.value)||0),0);
  const tin = sum('intake'), tout = sum('output'), net = tin - tout;
  document.getElementById('total-intake').textContent = tin + ' mL';
  document.getElementById('total-output').textContent = tout + ' mL';
  const nb = document.getElementById('net-balance');
  nb.textContent = (net>=0?'+':'')+net + ' mL';
  nb.style.color = net < -500 ? 'var(--red)' : net > 500 ? 'var(--blue)' : 'var(--text-dark)';
};

async function loadIo() {
  const today = new Date().toISOString().slice(0,10);
  // Session 178 real bug fix: this never filtered by shift at all -- it just grabbed
  // whichever of today's records (Morning/Evening/Night, one row each per saveIo()'s own
  // onConflict key) happened to have the latest created_at, regardless of which shift
  // pill was currently selected. Combined with setShift() previously never triggering a
  // reload, a nurse could switch shifts and still be looking at (and about to resave) a
  // completely different shift's fluid totals. Now scoped to the actual selected shift,
  // matching the real per-shift record this page already saves.
  const { data } = await supabase.from('nursing_io')
    .select('*').eq('admission_id', _activeAdm.id).eq('record_date', today).eq('shift', _shift)
    .maybeSingle();

  document.getElementById('intake-rows').innerHTML = '';
  document.getElementById('output-rows').innerHTML = '';
  if (data?.intake_items) data.intake_items.forEach(r => addIoRowHtml('intake', r.source, r.volume));
  else addIoRowHtml('intake');
  if (data?.output_items) data.output_items.forEach(r => addIoRowHtml('output', r.source, r.volume));
  else addIoRowHtml('output');
  calcIoTotals();
}

window.saveIo = async function() {
  if (!_activeAdm) return;
  const gatherRows = type => [...document.querySelectorAll(`#${type}-rows .io-row`)].map(row => ({
    source: row.querySelector('select').value,
    volume: parseFloat(row.querySelector('input').value) || 0,
  })).filter(r => r.volume > 0);

  const intake = gatherRows('intake'), output = gatherRows('output');
  const tin = intake.reduce((s,r)=>s+r.volume,0), tout = output.reduce((s,r)=>s+r.volume,0);
  const today = new Date().toISOString().slice(0,10);

  await supabase.from('nursing_io').upsert({
    tenant_id:      tenantId,
    admission_id:   _activeAdm.id,
    patient_id:     _activeAdm.patients?.id,
    record_date:    today,
    shift:          _shift,
    recorded_by:    userId,
    intake_items:   intake,
    output_items:   output,
    total_intake_ml:tin,
    total_output_ml:tout,
    net_balance_ml: tin - tout,
  }, { onConflict: 'admission_id,record_date,shift' });
  _alert('success', 'I/O chart saved.');
};

// ── Nursing Notes ─────────────────────────────────────────────────────────────
window.saveNote = async function() {
  if (!_activeAdm) return;
  const note = document.getElementById('note-text').value.trim();
  if (!note) { alert('Enter a note.'); return; }
  const time = document.getElementById('note-time').value || new Date().toTimeString().slice(0,5);
  const { error } = await supabase.from('nursing_notes').insert({
    tenant_id:    tenantId,
    admission_id: _activeAdm.id,
    patient_id:   _activeAdm.patients?.id,
    recorded_by:  userId,
    note_type:    document.getElementById('note-type').value,
    note_text:    note,
    note_time:    time,
    shift:        _shift,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save note.')); return; }
  document.getElementById('note-text').value = '';
  _alert('success', 'Note saved.');
  loadNotes();
};

async function loadNotes() {
  const { data } = await supabase.from('nursing_notes')
    .select('*, profiles!recorded_by(full_name)')
    .eq('admission_id', _activeAdm.id).order('created_at', {ascending:false}).limit(30);
  const NOTE_TYPES = { general:'General', procedure:'Procedure', medication:'Medication', patient_education:'Pt Education', family_communication:'Family', incident:'⚠ Incident', doctor_call:'Doctor Call' };
  document.getElementById('notes-list').innerHTML = (data||[]).length ? (data||[]).map(n => `
    <div style="padding:10px 14px;background:var(--white);border:1.5px solid var(--border);border-radius:8px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:var(--cream);border:1px solid var(--border);color:var(--text-mid)">${NOTE_TYPES[n.note_type]||n.note_type}</span>
        <span style="font-size:11px;color:var(--text-muted)">${n.note_time||''} · ${n.shift} shift · ${n.profiles?.full_name||'Nurse'}</span>
      </div>
      <div style="font-size:13px;color:var(--text-dark)">${n.note_text}</div>
    </div>`) .join('') : '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">No notes yet</div>';
}

// ── Shift Handover ────────────────────────────────────────────────────────────
window.saveHandover = async function() {
  if (!_activeAdm) return;
  const outNurse = document.getElementById('ho-out-nurse').value.trim();
  const inNurse  = document.getElementById('ho-in-nurse').value.trim();
  if (!outNurse || !inNurse) { _alert('error','Enter outgoing and incoming nurse names'); return; }
  const { error } = await supabase.from('nursing_handovers').insert({
    tenant_id:        tenantId,
    admission_id:     _activeAdm.id,
    patient_id:       _activeAdm.patients?.id,
    outgoing_nurse:   outNurse,
    incoming_nurse:   inNurse,
    shift:            _shift,
    condition:        document.getElementById('ho-condition').value,
    vitals_summary:   document.getElementById('ho-vitals').value.trim() || null,
    // SBAR fields
    situation:        document.getElementById('ho-situation')?.value.trim() || null,
    background:       document.getElementById('ho-background')?.value.trim() || null,
    key_events:       document.getElementById('ho-events').value.trim() || null,
    pending_meds:     document.getElementById('ho-pending-meds').value.trim() || null,
    instructions:     document.getElementById('ho-instructions').value.trim() || null,
    handover_at:      new Date().toISOString(),
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save handover.')); return; }
  _alert('success', 'Handover saved.');
  loadHandovers();
};

async function loadHandovers() {
  const { data } = await supabase.from('nursing_handovers')
    .select('*').eq('admission_id', _activeAdm.id).order('handover_at', {ascending:false}).limit(10);
  const COND = { stable:'Stable', improving:'Improving', deteriorating:'⚠ Deteriorating', critical:'🔴 Critical' };
  document.getElementById('handover-list').innerHTML = (data||[]).length ? (data||[]).map(h=>`
    <div style="padding:12px 14px;background:var(--white);border:1.5px solid ${h.condition==='critical'?'#f5c6c6':h.condition==='deteriorating'?'#e8c060':'var(--border)'};border-radius:8px;margin-bottom:8px;font-size:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-weight:600">${h.outgoing_nurse||'—'} → ${h.incoming_nurse||'—'} <span style="font-weight:400;color:var(--text-muted)">(${h.shift} shift)</span></div>
        <span style="font-size:11px;font-weight:700;color:${h.condition==='critical'?'var(--red)':h.condition==='deteriorating'?'var(--gold)':'var(--green-mid)'}">${COND[h.condition]||h.condition}</span>
      </div>
      ${h.vitals_summary?`<div style="color:var(--text-mid)">Vitals: ${h.vitals_summary}</div>`:''}
      ${h.key_events?`<div style="margin-top:4px">Events: ${h.key_events}</div>`:''}
      ${h.instructions?`<div style="margin-top:4px;color:#1a4080">Next shift: ${h.instructions}</div>`:''}
    </div>`).join('') : '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">No handovers recorded</div>';
}

window.printHandover = function() { window.print(); };
window.printNursingChart = function() { window.print(); };

// ── §21k Ward Procedures ─────────────────────────────────────────────────────
window.saveWardProcedure = async function() {
  if (!_activeAdm) { _alert('error','Select a patient first'); return; }
  const proc = document.getElementById('wp-procedure').value.trim();
  if (!proc) { _alert('error','Procedure name is required'); return; }
  const payload = {
    tenant_id:         tenantId,
    ipd_admission_id:  _activeAdm.id,
    patient_id:        _activeAdm.patients?.id || null,
    procedure_date:    document.getElementById('wp-date').value || new Date().toISOString().slice(0,10),
    procedure_time:    document.getElementById('wp-time').value || null,
    procedure_name:    proc,
    done_by_designation: document.getElementById('wp-designation').value,
    outcome:           document.getElementById('wp-outcome').value,
    notes:             document.getElementById('wp-notes').value.trim() || null,
    done_by:           userId,
  };
  const { error } = await supabase.from('ward_procedures').insert(payload);
  if (error) {
    if (error.code === '42P01') _alert('error','Run session32_ncism_gaps.sql in Supabase first');
    else _alert('error', safeErrorMessage(error, 'Something went wrong. Please try again.'));
    return;
  }
  document.getElementById('wp-procedure').value = '';
  document.getElementById('wp-notes').value = '';
  document.getElementById('wp-outcome').value = 'successful';
  _alert('success', 'Procedure logged');
  loadWardProcedures();
};

window.loadWardProcedures = async function() {
  const el = document.getElementById('ward-proc-list');
  if (!_activeAdm) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">Select a patient to view procedures.</div>'; return; }
  const { data, error } = await supabase
    .from('ward_procedures')
    .select('*')
    .eq('ipd_admission_id', _activeAdm.id)
    .order('procedure_date', { ascending: false });
  if (error || !data?.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">No procedures logged yet.</div>'; return; }
  el.innerHTML = data.map(p => `
    <div style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:#fafff7">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:13px">${p.procedure_name}</strong>
        <span style="font-size:11px;color:var(--text-muted)">${p.procedure_date} ${p.procedure_time ? p.procedure_time.slice(0,5) : ''}</span>
      </div>
      <div style="font-size:11px;color:var(--text-mid);margin-top:3px">${p.done_by_designation?.replace('_',' ')} · ${p.outcome?.replace('_',' ')} ${p.notes ? '· '+p.notes : ''}</div>
    </div>`).join('');
};

// ── Discharge Reconciliation (Session 114) ──────────────────────────────────────
// Shared staging table (ipd_stay_charges) for both this normal-path nurse
// screen and the billing clerk's fast-path manual-add pass (ipd.js) -- see
// sql/session114_ipd_discharge_workflow.sql for why a staging table exists
// instead of writing straight into bill_items.
const DISCHARGE_STATUS_LABELS = {
  pending:'Pending confirmation', confirmed:'Confirmed', billed:'Billed', voided:'Voided',
};

window.loadDischargeReconciliation = async function() {
  const readyWrap = document.getElementById('disc-recon-body');
  const notReady  = document.getElementById('disc-not-ready');
  if (!_activeAdm || _activeAdm.status !== 'clinically_discharged') {
    readyWrap.style.display = 'none';
    notReady.style.display  = '';
    notReady.textContent = _activeAdm
      ? "This patient's discharge hasn't been ordered by a doctor yet."
      : 'Select a patient whose discharge has been ordered by a doctor to begin reconciliation.';
    return;
  }
  notReady.style.display  = 'none';
  readyWrap.style.display = '';

  const admId = _activeAdm.id;
  const { data: staged } = await supabase.from('ipd_stay_charges')
    .select('*').eq('ipd_admission_id', admId).order('added_at');
  let rows = staged || [];

  // Pull PK therapy sessions linked to this admission that aren't staged
  // yet, price-matching by therapy_name against fee_structures (Panchakarma
  // procedure fees, category='procedure', label e.g. "Panchakarma —
  // Abhyanga"). pk_therapy_sessions has no stored price -- it's a pure
  // clinical scheduling record -- so this is a real lookup, not a stored-
  // amount read, and free-text therapy_name vs free-text fee label may not
  // always match. Unmatched sessions still get staged (status 'pending',
  // unit_price 0) with a "price not found" note rather than silently
  // skipped, so the nurse always sees every session and can fill in the
  // price manually instead of it vanishing from the reconciliation list.
  const stagedRefIds = new Set(rows.filter(r => r.source_ref_id).map(r => r.source_ref_id));
  const { data: sessions } = await supabase.from('pk_therapy_sessions')
    .select('id, therapy_name, scheduled_date')
    .eq('ipd_admission_id', admId);
  const newSessionRows = (sessions || []).filter(s => !stagedRefIds.has(s.id));
  if (newSessionRows.length) {
    const { data: feeRows } = await supabase.from('fee_structures')
      .select('label, amount, gst_percent, promo_price, promo_valid_until')
      .eq('tenant_id', tenantId).eq('category', 'procedure').eq('is_active', true);
    const inserts = newSessionRows.map(s => {
      const match = (feeRows || []).find(f => (f.label||'').toLowerCase().includes((s.therapy_name||'').toLowerCase().trim()) && s.therapy_name?.trim());
      const price = match ? getEffectivePrice(match) : 0;
      return {
        tenant_id: tenantId, ipd_admission_id: admId, source: 'pk_session', source_ref_id: s.id,
        description: match ? s.therapy_name : `${s.therapy_name || 'PK Session'} (price not found — verify)`,
        quantity: 1, unit_price: price, gst_percent: match?.gst_percent ?? null,
        amount: price, status: 'pending', added_by: userId,
      };
    });
    const { data: inserted } = await supabase.from('ipd_stay_charges').insert(inserts).select('*');
    rows = rows.concat(inserted || []);
  }

  renderReconciliationList(rows);
};

function renderReconciliationList(rows) {
  const el = document.getElementById('recon-list');
  if (!rows.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">No charges yet.</div>';
    return;
  }
  const total = rows.filter(r => r.status !== 'voided').reduce((s,r) => s + (Number(r.amount)||0), 0);
  el.innerHTML = rows.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:${r.status==='voided'?'#f5f5f5':'#fafff7'}">
      <div>
        <div style="font-size:13px;font-weight:600;${r.status==='voided'?'text-decoration:line-through;color:var(--text-muted)':''}">${_esc(r.description)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${r.quantity} × ₹${Number(r.unit_price).toLocaleString('en-IN')} = ₹${Number(r.amount).toLocaleString('en-IN')} · ${DISCHARGE_STATUS_LABELS[r.status]||r.status}</div>
      </div>
      ${r.status==='pending' || r.status==='confirmed' ? `<button class="btn btn-secondary btn-sm" data-onclick="voidStayCharge" data-onclick-a0="${r.id}">Remove</button>` : ''}
    </div>`).join('') +
    `<div style="text-align:right;font-weight:700;font-size:13px;margin-top:8px;color:var(--green-deep)">Total so far: ₹${total.toLocaleString('en-IN')}</div>`;
}

window.addManualCharge = async function() {
  if (!_activeAdm) return;
  const description = document.getElementById('rc-desc').value.trim();
  const qty   = parseFloat(document.getElementById('rc-qty').value) || 1;
  const price = parseFloat(document.getElementById('rc-price').value) || 0;
  if (!description || price <= 0) { _alert('error','Enter a description and amount.'); return; }
  const { error } = await supabase.from('ipd_stay_charges').insert({
    tenant_id: tenantId, ipd_admission_id: _activeAdm.id, source: 'manual',
    description, quantity: qty, unit_price: price, amount: qty * price,
    status: 'confirmed', added_by: userId,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not add charge.')); return; }
  document.getElementById('rc-desc').value  = '';
  document.getElementById('rc-qty').value   = '1';
  document.getElementById('rc-price').value = '';
  loadDischargeReconciliation();
};

window.voidStayCharge = async function(chargeId) {
  const { error } = await supabase.from('ipd_stay_charges').update({ status: 'voided' }).eq('id', chargeId);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not remove charge.')); return; }
  loadDischargeReconciliation();
};

window.lockChargesAndFreeBed = async function() {
  if (!_activeAdm) return;
  if (!confirm('Lock charges and free the bed? Once locked, only the billing clerk can adjust charges.')) return;
  const admId = _activeAdm.id;
  const bedId = _activeAdm.beds?.id;

  await supabase.from('ipd_stay_charges').update({ status: 'confirmed' })
    .eq('ipd_admission_id', admId).eq('status', 'pending');

  const { error } = await supabase.from('ipd_admissions').update({
    status: 'charges_locked', charges_locked_at: new Date().toISOString(),
  }).eq('id', admId);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not lock charges.')); return; }

  if (bedId) await supabase.from('beds').update({ status: 'vacant' }).eq('id', bedId);

  await logAudit('ipd_charges_locked', 'ipd_admissions', admId, { by: profile?.full_name }, _ctx);
  _alert('success', 'Charges locked and bed freed. Billing clerk can now generate the final bill.');
  loadWardPatients();
  document.getElementById('patient-content').style.display = 'none';
  document.getElementById('no-patient-msg').style.display  = '';
  _activeAdm = null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if(!d)return'—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _daysSince(d) { if(!d)return'?'; return Math.floor((Date.now()-new Date(d+'T00:00'))/86400000)+1; }
function _alert(type,msg) { const el=document.getElementById('alert-box');el.className=`alert ${type} show`;el.textContent=msg;setTimeout(()=>el.classList.remove('show'),4000); }

// ── NABH Risk Assessments ──────────────────────────────────────────────────────
window.calcMorse = function() {
  const score = ['morse-fall-hist','morse-sec-dx','morse-aid','morse-iv','morse-gait','morse-mental']
    .reduce((s,id) => s + parseInt(document.getElementById(id).value||0), 0);
  document.getElementById('morse-score').textContent = score;
  const lbl = document.getElementById('morse-risk-label');
  if (score < 25)       { lbl.textContent='Low Risk';    lbl.style.background='#e8f5ee'; lbl.style.color='#1a4a2e'; }
  else if (score <= 44) { lbl.textContent='Medium Risk'; lbl.style.background='#fff3cd'; lbl.style.color='#7a4a00'; }
  else                  { lbl.textContent='High Risk';   lbl.style.background='#fdecea'; lbl.style.color='#8b1a1a'; }
};

window.calcBraden = function() {
  const score = ['braden-sensory','braden-moisture','braden-activity','braden-mobility','braden-nutrition','braden-friction']
    .reduce((s,id) => s + parseInt(document.getElementById(id).value||0), 0);
  document.getElementById('braden-score').textContent = score;
  const lbl = document.getElementById('braden-risk-label');
  if (score <= 9)       { lbl.textContent='High Risk';   lbl.style.background='#fdecea'; lbl.style.color='#8b1a1a'; }
  else if (score <= 12) { lbl.textContent='Medium Risk'; lbl.style.background='#fff3cd'; lbl.style.color='#7a4a00'; }
  else if (score <= 14) { lbl.textContent='Low Risk';    lbl.style.background='#fff3cd'; lbl.style.color='#7a4a00'; }
  else                  { lbl.textContent='No Risk';     lbl.style.background='#e8f5ee'; lbl.style.color='#1a4a2e'; }
};

window.saveRiskAssessment = async function(type) {
  if (!_activeAdm) { _alert('error','Select a patient first'); return; }
  const interventions = document.getElementById('risk-interventions').value.trim();
  let payload = {
    tenant_id: tenantId,
    patient_id: _activeAdm.patients?.id,
    ipd_admission_id: _activeAdm.id,
    assessment_type: type,
    assessed_by: userId,
    interventions: interventions || null,
  };
  if (type === 'morse_fall') {
    const total = parseInt(document.getElementById('morse-score').textContent);
    const risk  = total < 25 ? 'low' : total <= 44 ? 'medium' : 'high';
    payload = { ...payload,
      morse_fall_history: parseInt(document.getElementById('morse-fall-hist').value),
      morse_secondary_dx: parseInt(document.getElementById('morse-sec-dx').value),
      morse_ambulatory_aid: parseInt(document.getElementById('morse-aid').value),
      morse_iv_heplock: parseInt(document.getElementById('morse-iv').value),
      morse_gait: parseInt(document.getElementById('morse-gait').value),
      morse_mental_status: parseInt(document.getElementById('morse-mental').value),
      morse_total: total, risk_level: risk,
    };
  } else {
    const total = parseInt(document.getElementById('braden-score').textContent);
    // Session 178 real bug fix: this used to fall through to 'low' for BOTH the 13-14
    // range AND the >14 range, silently losing the "No Risk" distinction calcBraden()'s
    // own UI clearly shows (High <=9 / Medium 10-12 / Low 13-14 / No Risk >=15). Needed
    // a real 5th value on risk_assessments.risk_level's CHECK constraint first
    // (sql/session178_nursing_html_fixes.sql) since 'none' wasn't previously allowed.
    const risk  = total <= 9 ? 'high' : total <= 12 ? 'medium' : total <= 14 ? 'low' : 'none';
    payload = { ...payload,
      braden_sensory_perception: parseInt(document.getElementById('braden-sensory').value),
      braden_moisture: parseInt(document.getElementById('braden-moisture').value),
      braden_activity: parseInt(document.getElementById('braden-activity').value),
      braden_mobility: parseInt(document.getElementById('braden-mobility').value),
      braden_nutrition: parseInt(document.getElementById('braden-nutrition').value),
      braden_friction_shear: parseInt(document.getElementById('braden-friction').value),
      braden_total: total, risk_level: risk,
    };
  }
  const { error } = await supabase.from('risk_assessments').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save risk assessment.')); return; }
  document.getElementById('risk-saved-msg').style.display = '';
  setTimeout(() => { document.getElementById('risk-saved-msg').style.display = 'none'; }, 3000);
  loadRiskHistory();
};

async function loadRiskHistory() {
  if (!_activeAdm) return;
  const el = document.getElementById('risk-history');
  const { data } = await supabase.from('risk_assessments')
    .select('assessment_type,risk_level,morse_total,braden_total,assessment_datetime,profiles!assessed_by(full_name)')
    .eq('ipd_admission_id', _activeAdm.id)
    .order('assessment_datetime', { ascending: false }).limit(10);
  if (!data?.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">No assessments recorded yet.</div>'; return; }
  const typeLabel = { morse_fall:'Morse Fall', braden:'Braden (Pressure Ulcer)', dvt:'DVT', nutritional:'Nutritional' };
  // Session 178: 'none' added alongside the fix to saveRiskAssessment() so a Braden score
  // >=15 ("No Risk" on the live calculator) shows the same way here instead of the old
  // silent fallback to 'low'. riskLabel replaces the old bare text-transform:capitalize on
  // the raw enum value, which also rendered 'very_high' as the awkward "Very_high".
  const riskColor = { none:'#1a4a2e', low:'#2d7a4f', medium:'#7a4a00', high:'#8b1a1a', very_high:'#8b1a1a' };
  const riskLabel = { none:'No Risk', low:'Low', medium:'Medium', high:'High', very_high:'Very High' };
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f5faf7"><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Assessment</th><th style="padding:6px 10px;text-align:center;border-bottom:1.5px solid var(--border)">Score</th><th style="padding:6px 10px;text-align:center;border-bottom:1.5px solid var(--border)">Risk</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Assessed By</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Date/Time</th></tr></thead>
    <tbody>${data.map(r => `<tr><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${typeLabel[r.assessment_type]||r.assessment_type}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:center;font-weight:600">${r.morse_total ?? r.braden_total ?? '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:center"><span style="font-size:11px;font-weight:600;color:${riskColor[r.risk_level]||'#333'};background:${riskColor[r.risk_level]||'#333'}15;padding:2px 8px;border-radius:10px">${riskLabel[r.risk_level] || r.risk_level || '—'}</span></td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${r.profiles?.full_name||'—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;color:var(--text-muted)">${new Date(r.assessment_datetime).toLocaleString('en-IN',{dateStyle:'short',timeStyle:'short'})}</td></tr>`).join('')}
    </tbody></table>`;
}
