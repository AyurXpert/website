import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { UG_BED_RATIOS as SF_RATIOS, NCISM_OPDS as SF_OPDS, NCISM_DEPTS as SF_DEPTS } from '../config/ncism.js';
// Session 179 Piece 3: reused (not reinvented) for the new zone-restricted-block feature below
// -- Dr. Venkatesh's own real-hospital insight (2 general wards per gender, split Medical/
// Surgical) needs exactly this same Medical={KAY,PK,KAU,AGD}/Surgical={SHAL,SHAK,PST} grouping
// ncismStaffCompliance.js already uses for bed-count summing purposes.
import { IPD_MEDICAL_BED_CODES, IPD_SURGICAL_BED_CODES } from '../config/ncismStaffCompliance.js';

wireDelegatedEvents();

await requireAuth(['super_admin', 'dept_admin']);
initNavbar();
const tenantId = getCurrentTenantId();

// Session 122 (Phase 4) -- Medical Director/Principal/Medical Superintendent
// can't create a department directly (blocked server-side by a trigger on
// departments too) -- they submit a request instead. Deleting a department
// is a hard delete (not a soft deactivate) and has deliberately been left
// with NO request path -- too destructive to queue; only a non-gated
// dept_admin/super_admin can do it, same as today.
const GATED_APPROVAL_DESIGS = ['medical_director','principal','medical_superintendent'];
const _profile = getCurrentProfile();
function _isGatedForApproval(){ return GATED_APPROVAL_DESIGS.includes(_profile?.designation); }

// This file's original long-form codes (KAYACHIKITSA, ...) — still the real convention
// for WASA1631/Srishti's existing department data. SDM (and any future tenant, since
// this is what platform_approve_ncism_request() actually writes) uses the canonical
// short-form codes (KAY, ...) from js/config/ncism.js instead — a tenant is never
// mixed, so loadAll() detects which one is in play once per page load and swaps the
// mutable bindings below (NCISM_CODES/UG_BED_RATIOS/DEPT_PREFIX/NCISM_BED_PRIORITY),
// leaving every existing lookup site elsewhere in this file unchanged.
const LF_NCISM_CODES = [
  { code:'KAYACHIKITSA',      label:'Kayachikitsa (Internal Medicine)',     mandatory:true  },
  { code:'PANCHAKARMA',       label:'Panchakarma & Upakarma',               mandatory:true  },
  { code:'SHALYA_TANTRA',     label:'Shalya Tantra (Surgery)',              mandatory:true  },
  { code:'SHALAKYA_NETRA',    label:'Shalakya – Netra Roga (Ophthalmology)',mandatory:true  },
  { code:'SHALAKYA_KNM',      label:'Shalakya – KNM (ENT & Oral)',          mandatory:true  },
  { code:'STRI_ROGA_PRASUTI', label:'Stri Roga & Prasuti Tantra (OBG)',     mandatory:true  },
  { code:'KAUMARABHRITYA',    label:'Kaumarabhritya (Paediatrics)',          mandatory:true  },
  { code:'SWASTHAVRITTA_YOGA',label:'Swasthavritta & Yoga (Lifestyle)',      mandatory:true  },
  { code:'SCREENING_OPD',     label:'Screening / Triage OPD',               mandatory:true  },
  { code:'AGADA_TANTRA',      label:'Agada Tantra (Toxicology)',             mandatory:true  },
  { code:'RASAYANA_VAJIKARANA',label:'Rasayana & Vajikarana',               mandatory:false },
  { code:'MANASAROGA',        label:'Manasaroga & Manovijnana (Psychiatry)', mandatory:false },
  { code:'ROGANIDANA',        label:'Roganidana & Vikritivijnana',           mandatory:false },
  { code:'DRAVYAGUNA',        label:'Dravyaguna Vijnana',                   mandatory:false },
  { code:'RASASHASTRA_BK',    label:'Rasashastra & Bhaishajya Kalpana',     mandatory:false },
  { code:'GENERAL',           label:'General / Administrative',              mandatory:false },
];

// NCISM Table-8 bed ratios per dept code (fraction of UG intake)
const LF_UG_BED_RATIOS = {
  'KAYACHIKITSA':       0.20,
  'PANCHAKARMA':        0.25,
  'SHALYA_TANTRA':      0.20,
  'SHALAKYA_KNM':       0.05,  // combined Shalakya = 10% split equally between Netra & KNM
  'SHALAKYA_NETRA':     0.05,
  'KAUMARABHRITYA':     0.10,
  'AGADA_TANTRA':       0.05,
  'STRI_ROGA_PRASUTI':  0.10,
};

// Standard NCISM bed prefix per department code
const LF_DEPT_PREFIX = {
  'KAYACHIKITSA':        'KC',
  'PANCHAKARMA':         'PK',
  'SHALYA_TANTRA':       'SHAL',
  'SHALAKYA_NETRA':      'SNT',
  'SHALAKYA_KNM':        'SHAK',
  'STRI_ROGA_PRASUTI':   'PST',
  'KAUMARABHRITYA':      'KAU',
  'SWASTHAVRITTA_YOGA':  'SW',
  'SCREENING_OPD':       'SCR',
  'AGADA_TANTRA':        'AGT',
  'RASAYANA_VAJIKARANA': 'RAS',
  'MANASAROGA':          'MAN',
  'ROGANIDANA':          'RNV',
  'DRAVYAGUNA':          'DRV',
  'RASASHASTRA_BK':      'RSH',
};

const LF_NCISM_BED_PRIORITY = [
  'PANCHAKARMA','KAYACHIKITSA','SHALYA_TANTRA',
  'STRI_ROGA_PRASUTI','KAUMARABHRITYA',
  'SHALAKYA_NETRA','SHALAKYA_KNM','AGADA_TANTRA',
];

// Short-form equivalents, sourced from the canonical js/config/ncism.js so this page can't
// independently drift again. NCISM_CODES here covers the real mandatory-10 OPD list (Session
// 94: Screening/Swasthavritta/Shalakya-Netra genuinely have zero Table-8 bed ratio, same as
// the long-form list above — "mandatory" here means "should be set up", not "has beds").
// Excludes SHNT (Shalakya-Netra) — that split only exists at the opds/patient-routing
// level (Schedule XVIII); departments/beds stay one combined 'SHAK' row (Table-8), so a
// department with ncism_code='SHNT' will never legitimately exist and would otherwise
// show as permanently "missing" here.
// Session 96: label was o.description||o.name (NCISM_OPDS.description, e.g. "Internal
// Medicine" for KAY) — that field describes the OPD's clinical specialty for patient-facing
// context, not the department's name, so Table 2 (Department Allocation) on a short-form
// tenant showed bare specialty names instead of real department names ("Internal Medicine"
// instead of "Kayachikitsa") — found live on SDM. Real department names come from
// NCISM_DEPTS instead; SCREEN has no NCISM_DEPTS entry (it's OPD-only, no academic
// department) so it falls back to the OPD's own name.
const SF_DEPT_NAMES = Object.fromEntries(SF_DEPTS.map(d => [d.ncism_code, d.name]));
const SF_NCISM_CODES = SF_OPDS
  .filter(o => o.ncism_code !== 'SHNT')
  .map(o => ({ code:o.ncism_code, label:SF_DEPT_NAMES[o.ncism_code]||o.name, mandatory:true }));
const SF_DEPT_PREFIX = Object.fromEntries(Object.keys(SF_RATIOS).map(c => [c, c]));
const SF_NCISM_BED_PRIORITY = ['PK','KAY','SHAL','PST','KAU','SHAK','AGD'];

// Session 95: hospital/pk_center tenants now ALSO use short-form codes (seed_default_org_
// structure()), but need a smaller mandatory list than teaching_hospital/college's full
// NCISM set — Screening/Swasthavritta are NCISM-teaching-specific, not part of a plain
// hospital's or PK center's default structure, and would otherwise show as permanently
// "missing" for them. Same short-form codes/labels either way, just a narrower list.
const HOSPITAL_NCISM_CODES = SF_NCISM_CODES.filter(n => ['KAY','PK','SHAL','SHAK','KAU','PST','AGD'].includes(n.code));
const PK_CENTER_NCISM_CODES = SF_NCISM_CODES.filter(n => ['PK','KAY'].includes(n.code));

let NCISM_CODES         = LF_NCISM_CODES;
let UG_BED_RATIOS       = LF_UG_BED_RATIOS;
let DEPT_PREFIX         = LF_DEPT_PREFIX;
let NCISM_BED_PRIORITY  = LF_NCISM_BED_PRIORITY;

const BED_TYPE_SHORT = {
  male_general:'M-Gen', female_general:'F-Gen', general:'Gen',
  twin_sharing:'Twin', semi_private:'Semi-Pvt',
  private:'Pvt', deluxe:'Deluxe', dormitory:'Dorm',
  icu:'ICU', day_care:'Day Care', pk_treatment:'PK Tx', observation:'Obs',
};

// Session 100 — Room/Ward "unit" numbering. Types listed here are room-based (fixed
// beds/room, e.g. Twin Sharing = 2, Deluxe = 1); room count/numbers are fully automatic
// from bed count, no admin input needed. Types NOT listed are open-ward style (General,
// Dormitory, Observation, Day Care) — a "ward instance" there is however many beds share
// the same ward_name text, keyed off the ward_name field admins already type into Quick
// Setup/Bulk Add, not a fixed capacity. See TECHNICAL_REFERENCE.md for the full design.
const ROOM_CAPACITY = { twin_sharing:2, semi_private:2, private:1, deluxe:1, icu:1, pk_treatment:1 };

// Assigns unit_number/unit_name to a batch of not-yet-inserted bed row objects (mutates
// in place), continuing the existing global-per-(tenant,bed_type) sequence already in
// _beds. Room-based types fill any partially-full last room before starting a new one;
// ward_name is left exactly as typed for them (a plain optional building/location note
// shown alongside "Room N" -- Session 101 wiped stale seed values but a genuinely admin-
// typed one is still real location info and shouldn't be discarded). It's just never part
// of a room's GROUPING/numbering, unlike open-ward types below. Open-ward types are
// grouped by DEPARTMENT, not by matching ward_name text -- each department's open-ward
// beds are their own numbered ward instance by default, so two unrelated departments
// never get silently merged just because an admin (or old seed data) happened to type the
// same generic label for both; ward_name there is carried into unit_name as the group's
// cosmetic label.
function _assignUnitNumbers(rows) {
  const byType = {};
  rows.forEach(r => { (byType[r.bed_type] ||= []).push(r); });

  Object.entries(byType).forEach(([type, typeRows]) => {
    const capacity = ROOM_CAPACITY[type];
    const existing = _beds.filter(b => b.bed_type === type && b.unit_number != null);

    if (capacity) {
      const maxRoom    = existing.length ? Math.max(...existing.map(b => b.unit_number)) : 0;
      let roomNum      = maxRoom || 1;
      let countInRoom  = maxRoom ? existing.filter(b => b.unit_number === maxRoom).length : 0;
      typeRows.forEach(r => {
        if (countInRoom >= capacity) { roomNum++; countInRoom = 0; }
        r.unit_number = roomNum;
        countInRoom++;
      });
    } else {
      let nextNum = existing.length ? Math.max(...existing.map(b => b.unit_number)) + 1 : 1;
      const deptNums = {};
      existing.forEach(b => { if (!(b.department_id in deptNums)) deptNums[b.department_id] = b.unit_number; });
      typeRows.forEach(r => {
        if (!(r.department_id in deptNums)) deptNums[r.department_id] = nextNum++;
        r.unit_number = deptNums[r.department_id];
        r.unit_name   = r.ward_name || null;
      });
    }
  });
  return rows;
}

// "Room 5" / "Room 5 — Sunrise Suite" / "Ward 2" / "Ward 2 — Surgical Ward"
function _unitLabel(b) {
  if (b.unit_number == null) return '';
  const word = ROOM_CAPACITY[b.bed_type] ? 'Room' : 'Ward';
  return `${word} ${b.unit_number}` + (b.unit_name ? ` — ${b.unit_name}` : '');
}

// Shared "existing bed" chip used on both the Departments tab card and the dept-info
// side panel (Add/Bulk Add drawers) -- kept as one function so the two never drift again
// (Session 101: the two inline copies had already drifted, both showing raw ward_name
// with no room/ward number at all).
function _bedTagHtml(b) {
  const unitLbl = _unitLabel(b);
  const sub = [
    BED_TYPE_SHORT[b.bed_type] || b.bed_type,
    unitLbl ? _esc(unitLbl) : '',
    b.ward_name && b.unit_name !== b.ward_name ? _esc(b.ward_name) : '',
  ].filter(Boolean).join(' · ');
  return `<span class="dept-bed-tag ${b.status !== 'vacant' ? b.status : ''}"
    data-onclick="openBedDrawer" data-onclick-a0="${_esc(b.id)}" title="Edit ${_esc(b.bed_number)}" style="cursor:pointer">
    <span>${_esc(b.bed_number)} <em>F${b.floor_number ?? 0}</em></span>
    ${sub ? `<span class="dbt-sub">${sub}</span>` : ''}
  </span>`;
}

// Returns the global reserved start number for a dept based on NCISM allocation rank.
// Depts are sorted descending by required beds; ties broken by NCISM_BED_PRIORITY.
// PK (15 beds) → 1, KC (12) → 16, SHAL (12) → 28, PST (6) → 40 … etc.
function _deptReservedStart(ncismCode) {
  if (!ncismCode || !_ugIntake) return 1;
  const sorted = Object.entries(UG_BED_RATIOS)
    .map(([code, ratio]) => ({ code, required: Math.floor(_ugIntake * ratio) }))
    .filter(d => d.required > 0)
    .sort((a, b) => b.required - a.required ||
      NCISM_BED_PRIORITY.indexOf(a.code) - NCISM_BED_PRIORITY.indexOf(b.code));
  let start = 1;
  for (const d of sorted) {
    if (d.code === ncismCode) return start;
    start += d.required;
  }
  return start; // non-NCISM dept starts after all reserved slots
}

// Returns next available start number for bulk/single bed add:
// - No beds yet        → dept's reserved range start (e.g. PK→1, KC→16)
// - Still filling NCISM quota → max existing + 1
// - NCISM quota met   → first number after ALL reserved ranges (e.g. 61 for 60-intake)
//                        so extra beds never bleed into another dept's reserved range
function _nextBedStart(deptBeds, prefix, ncismCode) {
  const reservedStart = _deptReservedStart(ncismCode);
  if (!prefix || !deptBeds.length) return reservedStart;

  const nums = deptBeds
    .filter(b => b.bed_number.startsWith(prefix + '-'))
    .map(b => parseInt(b.bed_number.split('-').pop()))
    .filter(n => !isNaN(n));

  if (!nums.length) return reservedStart;

  const required = Math.floor((UG_BED_RATIOS[ncismCode] || 0) * _ugIntake);
  if (required > 0 && deptBeds.length >= required) {
    // Quota met — extra beds go after all NCISM reserved ranges
    const totalNcism = Object.values(UG_BED_RATIOS)
      .reduce((s, r) => s + Math.floor(_ugIntake * r), 0);
    const extraNums = nums.filter(n => n > totalNcism);
    return extraNums.length ? Math.max(...extraNums) + 1 : totalNcism + 1;
  }

  return Math.max(...nums) + 1;
}

let _depts    = [];
let _beds     = [];
let _opds     = [];
let _ugIntake = 0;
// Session 179 Piece 2: bed_id -> the admitting department of whoever currently occupies it.
// Wards are physically SHARED (see Piece 1) -- ipd.js's admission picker allows admitting a
// patient into a bed "planned" for a different department (an overflow admission, allowed with
// a warning). This map is what lets renderBeds() flag that on the Bed Matrix card, comparing
// against the bed's own (planned) department_id.
let _bedOccupantDept = {};

// ── Populate NCISM select ─────────────────────────────────────────────────────
function _populateNcismSelect() {
  const sel = document.getElementById('dept-ncism');
  sel.innerHTML = '<option value="">— None / Custom —</option>';
  NCISM_CODES.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n.code;
    opt.textContent = (n.mandatory ? '★ ' : '◇ ') + n.label;
    sel.appendChild(opt);
  });
}

// ── Populate dept selects (bed + bulk) ───────────────────────────────────────
// Only departments with a real Table-8 bed ratio can ever have beds — Security,
// Administration, Screening, the pre-clinical teaching departments etc. are excluded
// so they never show up as bed-setup targets.
function populateDeptSelects() {
  ['bed-dept','bulk-dept','filter-dept'].forEach(id => {
    const sel = document.getElementById(id);
    const current = sel.value;
    const isFilter = id === 'filter-dept';
    sel.innerHTML = isFilter
      ? '<option value="">All Departments</option>'
      : '<option value="">— Select department —</option>';
    _depts.filter(d => d.is_active && UG_BED_RATIOS[d.ncism_code]).forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  });
}

// ── Load all data ─────────────────────────────────────────────────────────────
async function loadAll() {
  const [dRes, bRes, oRes, tRes, admRes] = await Promise.all([
    supabase.from('departments').select('*').eq('tenant_id', tenantId).order('name'),
    supabase.from('beds').select('*').eq('tenant_id', tenantId).order('bed_number'),
    supabase.from('opds').select('id,name').eq('tenant_id', tenantId).eq('is_active', true).order('name'),
    supabase.from('tenants').select('ug_intake,type').eq('id', tenantId).single(),
    // Session 179 Piece 2 -- who's actually admitted where right now, so renderBeds() can flag
    // a bed whose current occupant's admitting department differs from the bed's own planned
    // one (a real overflow admission, allowed by ipd.js's picker with a warning). Non-fatal if
    // this fails (admRes.error checked below, not treated as a hard load failure) -- the Bed
    // Matrix still works, it just can't show the cross-department flag for that load.
    supabase.from('ipd_admissions').select('bed_id,department_id').eq('tenant_id', tenantId).in('status', ['admitted', 'clinically_discharged']),
  ]);

  if (dRes.error) { _alert('error', safeErrorMessage(dRes.error, 'Failed to load departments.')); return; }
  if (bRes.error) { _alert('error', safeErrorMessage(bRes.error, 'Failed to load beds.')); return; }
  if (admRes.error) console.error('[bed-admin] admissions load failed (cross-dept flag unavailable):', admRes.error);

  _depts    = dRes.data || [];
  _beds     = bRes.data || [];
  _opds     = oRes.data || [];
  _ugIntake = tRes.data?.ug_intake || 0;
  const tenantType = tRes.data?.type;
  _bedOccupantDept = {};
  (admRes.data || []).forEach(a => { if (a.bed_id) _bedOccupantDept[a.bed_id] = a.department_id; });

  // Session 94 — pick the code convention this tenant's real departments actually use.
  // Session 95 — short-form is no longer teaching_hospital/college-exclusive
  // (seed_default_org_structure() also gives hospital/pk_center tenants short-form
  // codes), so the MANDATORY-LIST scope must follow tenant type, not just code
  // format — a plain hospital was never meant to have Screening/Swasthavritta.
  // Bed ratios/prefixes/priority stay the same either way (identical Table-8 codes).
  if (_depts.some(d => SF_RATIOS[d.ncism_code])) {
    UG_BED_RATIOS       = SF_RATIOS;
    DEPT_PREFIX         = SF_DEPT_PREFIX;
    NCISM_BED_PRIORITY  = SF_NCISM_BED_PRIORITY;
    NCISM_CODES         = tenantType === 'pk_center' ? PK_CENTER_NCISM_CODES
                         : tenantType === 'hospital'  ? HOSPITAL_NCISM_CODES
                         : SF_NCISM_CODES; // teaching_hospital/college (or unknown) — full NCISM list
  } else {
    NCISM_CODES        = LF_NCISM_CODES;
    UG_BED_RATIOS       = LF_UG_BED_RATIOS;
    DEPT_PREFIX         = LF_DEPT_PREFIX;
    NCISM_BED_PRIORITY  = LF_NCISM_BED_PRIORITY;
  }

  // Sort every department once, by NCISM bed-share descending (PK→...→AGD), ties broken
  // by NCISM_BED_PRIORITY — the same order _deptReservedStart() already uses to hand out
  // global bed-number ranges. Every downstream listing (cards, dropdowns, Building & Floor
  // Breakdown, Beds tab) reads from this same array, so they all inherit the order for free
  // instead of each needing (and risking drifting from) its own independent sort.
  _depts.sort((a, b) => {
    const ra = UG_BED_RATIOS[a.ncism_code] ? Math.floor(_ugIntake * UG_BED_RATIOS[a.ncism_code]) : -1;
    const rb = UG_BED_RATIOS[b.ncism_code] ? Math.floor(_ugIntake * UG_BED_RATIOS[b.ncism_code]) : -1;
    if (ra !== rb) return rb - ra;
    const pa = NCISM_BED_PRIORITY.indexOf(a.ncism_code);
    const pb = NCISM_BED_PRIORITY.indexOf(b.ncism_code);
    if (pa !== pb) {
      if (pa === -1) return 1;
      if (pb === -1) return -1;
      return pa - pb;
    }
    return (a.name || '').localeCompare(b.name || '');
  });

  _populateOpdSelect();
  populateDeptSelects();
  renderStats();
  renderDepts();
  renderBeds();
  checkNcismCompliance();
  await renderQuickSetup();
}

// ── Quick Setup tab ───────────────────────────────────────────────────────────
const BED_TYPE_OPTIONS = [
  ['male_general','Male General Ward'],['female_general','Female General Ward'],
  ['general','General Ward (mixed)'],['twin_sharing','Twin Sharing'],
  ['semi_private','Shared Private'],['private','Private Room'],
  ['deluxe','Deluxe Private'],['dormitory','Dormitory'],['icu','ICU'],
  ['day_care','Day Care'],['pk_treatment','PK Treatment'],['observation','Observation'],
];

// ── Table 1 state (Physical Inventory) ────────────────────────────────────────
// Rooms per unit: how many beds share one room / ward / bay
const QS1_ROOM_UNIT = {
  male_general:   { per: Infinity, label:'ward' },
  female_general: { per: Infinity, label:'ward' },
  general:        { per: Infinity, label:'ward' },
  dormitory:      { per: Infinity, label:'hall' },
  twin_sharing:   { per: 2,        label:'room' },
  semi_private:   { per: 2,        label:'room' },
  private:        { per: 1,        label:'room' },
  deluxe:         { per: 1,        label:'room' },
  icu:            { per: 1,        label:'bay'  },
  day_care:       { per: 1,        label:'space'},
  pk_treatment:   { per: 1,        label:'bay'  },
  observation:    { per: 1,        label:'bay'  },
};

// Capacity tooltip text per bed type (shown on hover in Table 1)
const QS1_CAPACITY = {
  male_general:   '4–8 patients per ward (male)',
  female_general: '4–8 patients per ward (female)',
  general:        '4–8 patients per ward (mixed)',
  twin_sharing:   '2 patients per room',
  semi_private:   '2 patients per room (shared)',
  private:        '1 patient per room',
  deluxe:         '1 patient per suite',
  dormitory:      '6–12 patients per hall',
  icu:            '1 patient per bay (critical care)',
  day_care:       '1 patient (day use, no overnight)',
  pk_treatment:   '1 patient per treatment bay',
  observation:    '1–2 patients per observation bay',
};

const QS1_DEFAULT_TYPES = [
  { key:'male_general',   label:'Male General Ward' },
  { key:'female_general', label:'Female General Ward' },
  { key:'general',        label:'General Ward (Mixed)' },
  { key:'twin_sharing',   label:'Twin Sharing' },
  { key:'semi_private',   label:'Shared Private' },
  { key:'private',        label:'Private Room' },
  { key:'deluxe',         label:'Deluxe Private' },
  { key:'dormitory',      label:'Dormitory' },
  { key:'icu',            label:'ICU' },
  { key:'day_care',       label:'Day Care' },
  { key:'pk_treatment',   label:'PK Treatment Room' },
  { key:'observation',    label:'Observation' },
];

let _qs1Types  = null; // [{key, label}]
let _qs1Blocks = null; // [{id, label, zone}] -- zone: 'any'|'medical'|'surgical' (Session 179 Piece 3, optional/defaults to 'any')
// Session 187: per-cell bed counts, DB-backed (building_block_cells) -- {typeKey}|{blockId}
// -> beds count, {typeKey}|{blockId}|fl -> floor. Same shape _qs1LoadValues() always
// returned (was localStorage before), kept identical on purpose so every existing reader
// of "saved[...]" needs zero changes -- only how this cache gets populated/persisted changed.
let _qs1CellData = null;
let _qsActiveCols = []; // type keys active in current Table 2
let _blkRemOffset = 0;  // rotates per dept so remainder beds don't always go to the same block

function _qs1Key(s) { return `qs1-${tenantId}-${s}`; }

const QS1_TYPES_VERSION = 'v2'; // bump when default types change to reset stale localStorage

async function _qs1Init() {
  if (_qs1Types && _qs1Blocks) return;
  try {
    // Reset if saved version is older than current defaults
    const ver = localStorage.getItem(_qs1Key('ver'));
    if (ver !== QS1_TYPES_VERSION) {
      localStorage.removeItem(_qs1Key('types'));
      localStorage.setItem(_qs1Key('ver'), QS1_TYPES_VERSION);
    }
    const t = localStorage.getItem(_qs1Key('types'));
    _qs1Types = t ? JSON.parse(t) : JSON.parse(JSON.stringify(QS1_DEFAULT_TYPES));
  } catch(_) {
    _qs1Types = JSON.parse(JSON.stringify(QS1_DEFAULT_TYPES));
  }

  // Session 186: blocks are now real DB rows (building_blocks), not browser localStorage --
  // closes a real drift bug found live on SDM where a block's identity had zero relationship
  // to already-created beds after creation time (see sql/session186_building_blocks.sql --
  // beds.ward_name/unit_name are now derived from block_id by a DB trigger, so this is the
  // single place that config actually lives). Falls back to 2 in-memory-only starter blocks
  // only if the fetch itself errors, so the page still renders something on a network hiccup.
  try {
    const { data, error } = await supabase.from('building_blocks')
      .select('id,name,zone').eq('tenant_id', tenantId).order('created_at');
    if (error) throw error;
    if (data && data.length) {
      _qs1Blocks = data.map(b => ({ id: b.id, label: b.name, zone: b.zone }));
    } else {
      _qs1Blocks = [
        { id: crypto.randomUUID(), label: 'Main Building F1', zone: 'any' },
        { id: crypto.randomUUID(), label: 'Main Building F2', zone: 'any' },
      ];
      await supabase.from('building_blocks').insert(
        _qs1Blocks.map(b => ({ id: b.id, tenant_id: tenantId, name: b.label, zone: b.zone }))
      );
    }
  } catch (_) {
    _qs1Blocks = [
      { id: crypto.randomUUID(), label:'Main Building F1', zone:'any' },
      { id: crypto.randomUUID(), label:'Main Building F2', zone:'any' },
    ];
  }

  // Session 187: per-cell counts, also DB-backed now (building_block_cells) -- closes the
  // regression the blocks-to-DB move above caused (found live on SDM): counts used to be
  // localStorage, keyed by block id; once blocks got real server-generated ids, any
  // existing localStorage count-data was orphaned (Table 1 rendered the right blocks, but
  // every cell showed 0). Loaded once here into the same flat shape _qs1LoadValues()
  // already returned, so every existing reader needs no changes.
  try {
    const { data: cells, error: cellErr } = await supabase.from('building_block_cells')
      .select('block_id,bed_type,beds,floor_number').eq('tenant_id', tenantId);
    if (cellErr) throw cellErr;
    _qs1CellData = {};
    (cells || []).forEach(c => {
      if (c.beds) _qs1CellData[`${c.bed_type}|${c.block_id}`] = c.beds;
      if (c.floor_number !== null) _qs1CellData[`${c.bed_type}|${c.block_id}|fl`] = c.floor_number;
    });
  } catch (_) {
    _qs1CellData = {};
  }
}

async function _qs1PersistMeta() {
  _qs1Types.forEach(t => {
    const el = document.getElementById(`qs1-lbl-${t.key}`);
    if (el) t.label = el.value || t.label;
  });
  _qs1Blocks.forEach(b => {
    const el = document.getElementById(`qs1-blk-${b.id}`);
    if (el) b.label = el.value || b.label;
    // Session 179 Piece 3: zone-select is a separate control from the label input, read here
    // too so a single _qs1PersistMeta() call (already wired to every other Table 1 field's
    // blur/change) keeps everything in sync in one place.
    const zEl = document.getElementById(`qs1-zone-${b.id}`);
    if (zEl) b.zone = zEl.value;
  });
  localStorage.setItem(_qs1Key('types'), JSON.stringify(_qs1Types));

  // Session 186: blocks persist to building_blocks, not localStorage -- upsert current
  // state, then delete any of this tenant's rows no longer present (removed via
  // _qs1RemoveBlock). beds.block_id is ON DELETE SET NULL, so removing a block never
  // destroys bed data -- affected beds just stop tracking a block going forward.
  try {
    if (_qs1Blocks.length) {
      await supabase.from('building_blocks').upsert(
        _qs1Blocks.map(b => ({ id: b.id, tenant_id: tenantId, name: b.label, zone: b.zone || 'any' }))
      );
    }
    const { data: existing } = await supabase.from('building_blocks').select('id').eq('tenant_id', tenantId);
    const keepIds = new Set(_qs1Blocks.map(b => b.id));
    const removedIds = (existing || []).map(r => r.id).filter(id => !keepIds.has(id));
    if (removedIds.length) {
      await supabase.from('building_blocks').delete().in('id', removedIds);
    }
  } catch (e) {
    console.error('Failed to persist building blocks', e);
  }
}
window._qs1PersistMeta = _qs1PersistMeta;

// Session 179 Piece 3: saving the new zone tag also re-populates Table 2 if it's already open --
// a zone change can change which blocks a department's beds are even allowed to draw from, so
// the previewed per-block split needs to reflect that immediately, not just on next page load.
window._qs1ZoneChanged = function() {
  _qs1PersistMeta();
  const pool = _qs1Pool();
  if (Object.keys(pool).length > 0 && document.querySelector('#qs2-table-container tr[data-code]')) {
    renderQs2Table(pool);
  }
};

function _qs1SaveValues() {
  const data = {};
  const rows = [];
  _qs1Types.forEach(t => {
    _qs1Blocks.forEach(b => {
      const v = parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value) || 0;
      const flEl = document.getElementById(`qs1-fl-${t.key}-${b.id}`);
      const fl = flEl && flEl.value !== '' ? parseInt(flEl.value) || 0 : null;
      if (v) data[`${t.key}|${b.id}`] = v;
      if (fl !== null) data[`${t.key}|${b.id}|fl`] = fl;
      // Session 187: DB-backed now (building_block_cells) -- only rows with a real bed
      // count are worth persisting; a 0-count cell is just "not entered yet".
      if (v) rows.push({ tenant_id: tenantId, block_id: b.id, bed_type: t.key, beds: v, floor_number: fl });
    });
  });
  _qs1CellData = data; // in-memory cache stays synchronous, same as before -- only backing store moved

  // Fire-and-forget persist to the DB, mirroring _qs1PersistMeta()'s pattern: upsert every
  // currently-nonzero cell, then delete this tenant's DB rows that dropped to 0 or no
  // longer exist (a cell cleared back to blank, or its block removed).
  (async () => {
    try {
      // A block created via _qs1AddBlock() only exists in memory until the next
      // _qs1PersistMeta() call (its label blur / zone change) -- if a cell in that new
      // block gets saved first (e.g. typing straight into its floor field, which
      // auto-saves on every keystroke), this upsert's block_id FK would reference a row
      // that doesn't exist yet. Ensure every current block's row exists before any cell
      // ever tries to reference it, regardless of which trigger fired this particular save.
      if (rows.length) {
        await supabase.from('building_blocks').upsert(
          _qs1Blocks.map(b => ({ id: b.id, tenant_id: tenantId, name: b.label, zone: b.zone || 'any' }))
        );
        await supabase.from('building_block_cells').upsert(rows, { onConflict: 'block_id,bed_type' });
      }
      const { data: existing } = await supabase.from('building_block_cells')
        .select('id,block_id,bed_type').eq('tenant_id', tenantId);
      const keep = new Set(rows.map(r => `${r.block_id}|${r.bed_type}`));
      const staleIds = (existing || [])
        .filter(r => !keep.has(`${r.block_id}|${r.bed_type}`))
        .map(r => r.id);
      if (staleIds.length) await supabase.from('building_block_cells').delete().in('id', staleIds);
    } catch (e) {
      console.error('Failed to persist building block cells', e);
    }
  })();
}

function _qs1LoadValues() {
  return _qs1CellData || {};
}

// Session 179: real global bed numbering, ward-type-first. Dr. Venkatesh's finding, working
// through it live from bed-admin.html's own Physical Bed Inventory + Department Allocation
// screens: a hospital's real physical wards (Male General Ward, Female General Ward, ...) are
// SHARED rooms holding patients from several departments at once, with each department's "bed
// share" being a planning/NCISM-compliance ratio, not a physical partition. The pre-existing
// _deptReservedStart() already reserves one continuous global number range across departments
// (that's why SDM's real beds are KAY-26..45 right after PK-01..25) -- but it reserves that
// range DEPARTMENT-first (one dept's whole contiguous block spans several mixed ward types),
// which is the wrong axis: Panchakarma's cards showed "PK-01..PK-25" as one contiguous block,
// with no way to tell that e.g. PK-03 and a same-room KAY bed physically share Male General
// Ward. Real fix: number WARD-TYPE-first instead (Male General Ward gets one contiguous global
// range, sub-divided across whichever departments have a share of it), so a department's own
// beds are correctly SCATTERED across the hospital-wide range, one sub-range per ward type it
// participates in -- exactly Dr. Venkatesh's own worked example (Male General Ward beds 1-5 to
// one department, 6-12 to another, ...).
//
// Returns every non-empty (bed-type, block) cell from Table 1, in the same row-major order the
// user described building the numbering in ("1st row/1st column ward, then successive rows and
// wards") -- type rows top-to-bottom (_qs1Types' own order), blocks left-to-right within each
// row (_qs1Blocks' own order) -- with each cell's real global bed-number range. This is the
// SINGLE source of truth for both the new "Bed #" preview column in Table 1 (informational,
// before any beds exist) and the real bed_number assigned when beds are actually created
// (quickSetupCreateRow) -- the two can never disagree since they read the exact same function.
function _qs1CellSequence() {
  const cells = [];
  let running = 1;
  _qs1Types.forEach(t => {
    _qs1Blocks.forEach(b => {
      const count = parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value || 0) || 0;
      if (!count) return;
      const blockLabel = document.getElementById(`qs1-blk-${b.id}`)?.value || '';
      cells.push({ typeKey: t.key, blockId: b.id, blockLabel, count, start: running, end: running + count - 1 });
      running += count;
    });
  });
  return cells;
}

// Get {typeKey: totalCount} from Table 1 inputs
function _qs1Pool() {
  const pool = {};
  _qs1Types.forEach(t => {
    let sum = 0;
    _qs1Blocks.forEach(b => {
      sum += parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value || 0) || 0;
    });
    if (sum > 0) pool[t.key] = sum;
  });
  return pool;
}

function _qs1GrandTotal() {
  return Object.values(_qs1Pool()).reduce((s, v) => s + v, 0);
}

// Total NCISM beds needed: UG (from ratios) + PG (pg_seats_sanctioned per PG dept)
function _qsNcismTotal() {
  let total = 0;
  Object.entries(UG_BED_RATIOS).forEach(([code, ratio]) => {
    total += Math.floor(_ugIntake * ratio);
    const dept = _depts.find(d => d.ncism_code === code);
    if (dept?.is_pg_dept) total += (dept.pg_seats_sanctioned || 0);
  });
  return total;
}

window._qs1UpdateTotals = function() {
  // Session 179: live "Bed #" preview per cell -- the exact same row-major sequence
  // _qs1CellSequence() hands to the real bed-creation write path, shown here before any beds
  // exist so Dr. Venkatesh can see the real physical numbering while still planning the
  // inventory. Cleared to "—" for any cell whose bed count is currently 0.
  _qs1Types.forEach(t => {
    _qs1Blocks.forEach(b => {
      const el = document.getElementById(`qs1-bedno-${t.key}-${b.id}`);
      if (el) el.textContent = '—';
    });
  });
  _qs1CellSequence().forEach(c => {
    const el = document.getElementById(`qs1-bedno-${c.typeKey}-${c.blockId}`);
    if (el) el.textContent = c.count === 1 ? `#${c.start}` : `#${c.start}–${c.end}`;
  });

  _qs1Types.forEach(t => {
    // Row bed total
    let bedTotal = 0;
    _qs1Blocks.forEach(b => { bedTotal += parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value || 0) || 0; });
    const totEl = document.getElementById(`qs1-rtot-${t.key}`);
    if (totEl) { totEl.textContent = bedTotal || '—'; totEl.style.color = bedTotal > 0 ? 'var(--green-deep)' : '#ccc'; }

    // Rooms / wards calculation with per-block floor breakdown
    const unit = QS1_ROOM_UNIT[t.key] || { per: 1, label:'room' };
    let totalRooms = 0;
    const breakdown = [];
    _qs1Blocks.forEach((b, idx) => {
      const beds = parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value || 0) || 0;
      if (!beds) return;
      const rooms = !isFinite(unit.per) ? 1 : Math.ceil(beds / unit.per);
      totalRooms += rooms;
      const flRaw  = document.getElementById(`qs1-fl-${t.key}-${b.id}`)?.value ?? '';
      const flNum  = flRaw !== '' ? parseInt(flRaw) : 0;
      const flStr  = flNum === 0 ? 'GF' : `Fl.${flNum}`;
      const blkFull = document.getElementById(`qs1-blk-${b.id}`)?.value || `Blk ${idx+1}`;
      const shortBlk = blkFull.split(/\s+/).filter(Boolean).pop() || `B${idx+1}`;
      const rUnit  = rooms === 1 ? unit.label : unit.label + 's';
      breakdown.push(`${shortBlk}: ${rooms} ${rUnit}${flStr ? ' · ' + flStr : ''}`);
    });
    const roomEl = document.getElementById(`qs1-rooms-${t.key}`);
    if (roomEl) {
      if (!totalRooms) {
        roomEl.innerHTML = `<span style="color:#ccc;font-size:11px">—</span>`;
      } else {
        const totUnit = totalRooms === 1 ? unit.label : unit.label + 's';
        const bdHtml  = (breakdown.length > 0 && _qs1Blocks.length > 1)
          ? `<div style="font-size:10px;color:#555;margin-top:3px;line-height:1.7">${breakdown.join('<br>')}</div>`
          : '';
        roomEl.innerHTML = `<span style="font-weight:700;color:var(--green-deep)">${totalRooms}</span>
          <span style="font-size:10px;color:var(--text-muted);display:block">${totUnit}</span>
          ${bdHtml}`;
      }
    }
  });

  // Column totals
  _qs1Blocks.forEach(b => {
    let s = 0;
    _qs1Types.forEach(t => { s += parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value || 0) || 0; });
    const el = document.getElementById(`qs1-ctot-${b.id}`);
    if (el) { el.textContent = s || '—'; }
  });

  // Grand total
  const gt  = _qs1GrandTotal();
  const req = _qsNcismTotal();
  const el  = document.getElementById('qs1-grand');
  if (el) {
    const ok = gt >= req;
    el.innerHTML = `<strong style="font-size:14px">${gt}</strong> beds &nbsp;
      <span style="font-size:11px;color:${ok ? 'var(--green-mid)' : '#c02020'}">
        ${ok ? `✓ meets NCISM min (${req} needed)` : `⚠ need ${req - gt} more to reach NCISM min (${req})`}
      </span>`;
  }
};

window._qs1SaveAndUpdateTotals = function() {
  _qs1SaveValues();
  window._qs1UpdateTotals();
};

window._qs1SaveInventory = function() {
  _qs1SaveValues();
  _qs1PersistMeta();
  _alert('success', 'Inventory saved');
};

window._qs1AddBlock = function() {
  _qs1PersistMeta(); _qs1SaveValues();
  // Session 186: real uuid, not a client-side string -- building_blocks.id is a genuine
  // FK target now, so a new block needs an id that's valid to insert as-is.
  _qs1Blocks.push({ id: crypto.randomUUID(), label:'New Block', zone:'any' });
  renderQs1Table();
};

window._qs1RemoveBlock = function(id) {
  if (_qs1Blocks.length <= 1) { _alert('info','Keep at least one building block.'); return; }
  _qs1PersistMeta(); _qs1SaveValues();
  _qs1Blocks = _qs1Blocks.filter(b => b.id !== id);
  renderQs1Table();
};

window._qs1AddType = function() {
  _qs1PersistMeta(); _qs1SaveValues();
  _qs1Types.push({ key: 'custom-' + Date.now(), label: 'New Bed Type' });
  renderQs1Table();
};

window._qs1RemoveType = function(key) {
  if (_qs1Types.length <= 1) { _alert('info','Keep at least one bed type.'); return; }
  _qs1PersistMeta(); _qs1SaveValues();
  _qs1Types = _qs1Types.filter(t => t.key !== key);
  renderQs1Table();
};

window._qs1OnFocus = function(el, typeKey, blockId, fieldType) {
  const typeLabel  = document.getElementById(`qs1-lbl-${typeKey}`)?.value || typeKey;
  const blockLabel = document.getElementById(`qs1-blk-${blockId}`)?.value || blockId;
  const bar = document.getElementById('qs1-focus-bar');
  if (bar) {
    bar.textContent = fieldType === 'floor'
      ? `📍 Floor for ${typeLabel} — ${blockLabel}  (0 = Ground, 1 = First, 2 = Second …)`
      : `✏ Entering: ${typeLabel} beds — ${blockLabel}`;
    bar.style.display = 'block';
  }
  el.placeholder = fieldType === 'floor' ? 'Floor #' : 'Count';
};
window._qs1OnBlur = function(el, fieldType) {
  const bar = document.getElementById('qs1-focus-bar');
  if (bar) bar.style.display = 'none';
  if (el) el.placeholder = fieldType === 'floor' ? 'GF' : '0';
};

function renderQs1Table() {
  const container = document.getElementById('qs1-table-container');
  if (!container) return;
  const saved = _qs1LoadValues();

  // Two-row header: row 1 = block name spanning Beds+Floor cols; row 2 = sub-labels
  // Session 179 Piece 3: Dr. Venkatesh's own real-hospital insight -- a shared ward like "Male
  // General Ward" spans multiple NCISM zones (Medical IPD, Surgical IPD) at once, which has no
  // clean regulatory ratio of its own. Real hospitals resolve this by running 2 SEPARATE
  // general wards per gender, one Medical (Panchakarma/Kayachikitsa/Kaumarabhritya/Agada
  // Tantra) and one Surgical (Shalya Tantra/Shalakya Tantra/Prasuti & Stri Roga) -- each then
  // maps cleanly to one zone's own regulated ratio, no invented cross-zone number needed. This
  // "block" (already just a free-text physical-location label, e.g. "Block A") is the natural
  // place to carry that -- a block can now optionally be restricted to one zone, and
  // _computeBlockAllocation() (below) honors it when auto-splitting a department's beds.
  const ZONE_LABELS = { any: 'Any department', medical: 'Medical (Panchakarma/Kayachikitsa/Kaumarabhritya/Agada Tantra)', surgical: 'Surgical (Shalya/Shalakya/Prasuti & Stri Roga)' };
  const blkHeadersRow1 = _qs1Blocks.map(b => `
    <th colspan="3" style="min-width:220px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.3)">
      <div style="display:flex;align-items:center;gap:4px;justify-content:center">
        <input class="qs1-hdr-input" id="qs1-blk-${b.id}" value="${b.label}" data-onblur="_qs1PersistMeta" placeholder="Building / Floor"/>
        ${_qs1Blocks.length > 1 ? `<button class="qs1-del-btn" style="color:rgba(255,255,255,0.7)" data-onclick="_qs1RemoveBlock" data-onclick-a0="${_esc(b.id)}" title="Remove block">✕</button>` : ''}
      </div>
      <select id="qs1-zone-${b.id}" class="qs1-zone-select" data-onchange="_qs1ZoneChanged" title="Restrict which departments this block's beds can be auto-allocated to -- e.g. a dedicated Medical or Surgical general ward">
        ${Object.entries(ZONE_LABELS).map(([k, lbl]) => `<option value="${k}"${(b.zone || 'any') === k ? ' selected' : ''}>${_esc(lbl)}</option>`).join('')}
      </select>
    </th>`).join('');

  const blkSubRow = _qs1Blocks.map(() =>
    `<th style="text-align:center;font-size:10px;font-weight:500;padding:3px 6px;min-width:65px">Beds</th>
     <th style="text-align:center;font-size:10px;font-weight:500;padding:3px 6px;min-width:60px;opacity:.85">Floor</th>
     <th style="text-align:center;font-size:10px;font-weight:500;padding:3px 6px;min-width:70px;opacity:.85">Bed #</th>`
  ).join('');

  const bodyRows = _qs1Types.map(t => {
    const cells = _qs1Blocks.map(b => {
      const v   = saved[`${t.key}|${b.id}`] || '';
      const fl  = saved[`${t.key}|${b.id}|fl`] ?? '';
      return `<td style="text-align:center;padding:5px 6px">
        <input class="qs-cell-input" type="number" min="0" style="width:58px"
          id="qs1-${t.key}-${b.id}" value="${v}" placeholder="0"
          data-onfocus="_qs1OnFocus" data-onfocus-a0="@this" data-onfocus-a1="${_esc(t.key)}" data-onfocus-a2="${_esc(b.id)}" data-onfocus-a3="beds"
          data-onblur="_qs1OnBlur" data-onblur-a0="@this" data-onblur-a1="beds"
          data-oninput="_qs1UpdateTotals"/>
      </td>
      <td style="text-align:center;padding:5px 4px">
        <input class="qs1-floor-input" type="number" min="0" max="20"
          id="qs1-fl-${t.key}-${b.id}" value="${fl}" placeholder="GF"
          data-onfocus="_qs1OnFocus" data-onfocus-a0="@this" data-onfocus-a1="${_esc(t.key)}" data-onfocus-a2="${_esc(b.id)}" data-onfocus-a3="floor"
          data-onblur="_qs1OnBlur" data-onblur-a0="@this" data-onblur-a1="floor"
          data-oninput="_qs1SaveAndUpdateTotals"/>
      </td>
      <td style="text-align:center;padding:5px 4px;font-size:10.5px;font-weight:600;color:var(--green-deep)" id="qs1-bedno-${t.key}-${b.id}">—</td>`;
    }).join('');
    const cap = QS1_CAPACITY[t.key] || '';
    return `<tr>
      <td style="padding:6px 8px">
        <div style="display:flex;align-items:center;gap:5px">
          <input class="qs1-type-input" id="qs1-lbl-${t.key}" value="${t.label}" data-onblur="_qs1PersistMeta" placeholder="Bed type name"/>
          ${cap ? `<span class="qs1-cap-tip" data-cap="${cap}">i</span>` : ''}
          <button class="qs1-del-btn" data-onclick="_qs1RemoveType" data-onclick-a0="${_esc(t.key)}" title="Remove type">✕</button>
        </div>
      </td>
      ${cells}
      <td style="text-align:center;font-weight:700;padding:6px 8px;min-width:60px" id="qs1-rtot-${t.key}">—</td>
      <td style="text-align:center;padding:6px 8px;min-width:80px" id="qs1-rooms-${t.key}">
        <span style="color:#ccc;font-size:11px">—</span>
      </td>
    </tr>`;
  }).join('');

  // Footer: beds total + blank floor cell per block
  const colTotals = _qs1Blocks.map(b =>
    `<td style="text-align:center;font-weight:700;color:var(--green-deep);padding:6px 8px" id="qs1-ctot-${b.id}">—</td>
     <td style="padding:6px 4px;font-size:10px;color:#aaa;text-align:center">floor</td>
     <td style="padding:6px 4px"></td>`
  ).join('');

  container.innerHTML = `
    <div class="qs1-focus-bar" id="qs1-focus-bar" style="display:none"></div>
    <div style="overflow-x:auto">
    <table class="qs-table" style="font-size:12px">
      <thead>
        <tr>
          <th rowspan="2" style="min-width:165px;vertical-align:middle">Bed Type</th>
          ${blkHeadersRow1}
          <th rowspan="2" style="text-align:center;min-width:60px;vertical-align:middle">Total<br>Beds</th>
          <th rowspan="2" style="text-align:center;min-width:80px;vertical-align:middle">Rooms /<br>Wards</th>
        </tr>
        <tr style="background:var(--green-mid)">${blkSubRow}</tr>
      </thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr style="background:var(--green-light)">
          <td style="font-weight:600;font-size:11px;padding:6px 8px;color:var(--green-deep)">Beds per block →</td>
          ${colTotals}
          <td id="qs1-grand" style="padding:6px 8px;font-size:11px"></td>
          <td style="padding:6px 8px"></td>
        </tr>
      </tfoot>
    </table>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-secondary btn-sm" data-onclick="_qs1AddType">+ Add Bed Type</button>
      <button class="btn btn-secondary btn-sm" data-onclick="_qs1AddBlock">+ Add Building / Floor</button>
      <button class="btn btn-secondary btn-sm" data-onclick="_qs1SaveInventory">💾 Save Inventory</button>
    </div>`;

  setTimeout(_qs1UpdateTotals, 0);
}

// ── Proportional distribution (pure function) ─────────────────────────────────
function _distributeProportionally(required, pool) {
  const keys = Object.keys(pool).filter(k => pool[k] > 0);
  if (!keys.length || !required) return {};
  const poolTotal = keys.reduce((s, k) => s + pool[k], 0);
  const raw = {};
  keys.forEach(k => { raw[k] = (pool[k] / poolTotal) * required; });

  const result = {};
  keys.forEach(k => { result[k] = Math.floor(raw[k]); });

  let rem = required - keys.reduce((s, k) => s + result[k], 0);
  const sorted = [...keys].sort((a, b) =>
    (raw[b] - Math.floor(raw[b])) - (raw[a] - Math.floor(raw[a]))
  );
  for (let i = 0; i < rem; i++) result[sorted[i % sorted.length]]++;
  keys.forEach(k => { if (!result[k]) delete result[k]; });
  return result;
}

// ── Auto-distribute Table 1 → Table 2 ────────────────────────────────────────
window.autoDistribute = function() {
  _qs1SaveValues(); _qs1PersistMeta();
  const pool = _qs1Pool();
  const gt   = Object.values(pool).reduce((s, v) => s + v, 0);
  const req  = _qsNcismTotal();
  if (!gt) { _alert('error', 'Enter your bed inventory in Table 1 first.'); return; }
  if (gt < req) {
    if (!confirm(`Your inventory (${gt} beds) is less than NCISM minimum (${req} beds). Distribute anyway?`)) return;
  }
  renderQs2Table(pool);
};

// ── Table 2: NCISM Department Allocation ─────────────────────────────────────
window._qsUpdateTotal = function(code, needed) {
  let sum = 0;
  _qsActiveCols.forEach(k => {
    sum += parseInt(document.getElementById(`qs-cell-${code}-${k}`)?.value || 0) || 0;
  });
  const el = document.getElementById(`qs-total-${code}`);
  if (!el) return;
  const diff = sum - needed;
  if (diff === 0)       { el.textContent = `${sum} ✓`;       el.className = 'qs-total ok'; }
  else if (diff > 0)    { el.textContent = `${sum} (+${diff})`; el.className = 'qs-total over'; }
  else                  { el.textContent = `${sum} (${diff})`; el.className = 'qs-total under'; }
};

// Returns floor number (int) that has the most beds for the given dist from Table 1
function _qs1DominantFloor(dist) {
  const w = new Map();
  Object.entries(dist).forEach(([k, cnt]) => {
    if (!cnt) return;
    const total = _qs1Blocks.reduce((s, b) => s + (parseInt(document.getElementById(`qs1-${k}-${b.id}`)?.value) || 0), 0);
    if (!total) return;
    _qs1Blocks.forEach(b => {
      const beds = parseInt(document.getElementById(`qs1-${k}-${b.id}`)?.value) || 0;
      if (!beds) return;
      const flv = document.getElementById(`qs1-fl-${k}-${b.id}`)?.value;
      const fl  = (flv !== undefined && flv !== '') ? parseInt(flv) || 0 : 0;
      w.set(fl, (w.get(fl) || 0) + (beds / total) * cnt);
    });
  });
  if (!w.size) return 0;
  return [...w.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Returns [{full, floorMap, total}] — which blocks (with per-floor bed counts) contribute to a dept's allocation
function _qs1Sources(dist) {
  return _qs1Blocks.map((b, idx) => {
    const floorMap = {};
    Object.entries(dist).forEach(([k, cnt]) => {
      if (!cnt) return;
      const beds = parseInt(document.getElementById(`qs1-${k}-${b.id}`)?.value) || 0;
      if (!beds) return;
      const flv = document.getElementById(`qs1-fl-${k}-${b.id}`)?.value;
      const fl  = (flv !== undefined && flv !== '') ? parseInt(flv) || 0 : 0;
      floorMap[fl] = (floorMap[fl] || 0) + beds;
    });
    const total = Object.values(floorMap).reduce((s, v) => s + v, 0);
    if (!total) return null;
    const full = document.getElementById(`qs1-blk-${b.id}`)?.value || `Block ${idx+1}`;
    return { full, floorMap, total };
  }).filter(Boolean);
}

// Returns {typeKey: [{short, beds, flStr}]} — per-type per-block hints for Table 2 column sub-headers
function _qs1TypeBlockHints(activeCols, pool) {
  const hints = {};
  activeCols.forEach(t => {
    hints[t.key] = _qs1Blocks.map((b, idx) => {
      const beds = parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value) || 0;
      if (!beds) return null;
      const flv   = document.getElementById(`qs1-fl-${t.key}-${b.id}`)?.value;
      const fl    = (flv !== undefined && flv !== '') ? parseInt(flv) || 0 : 0;
      const full  = document.getElementById(`qs1-blk-${b.id}`)?.value || `Block ${idx+1}`;
      const short = full.split(/\s+/).filter(Boolean).pop() || `B${idx+1}`;
      return { short, beds, flStr: fl === 0 ? 'GF' : `Fl.${fl}` };
    }).filter(Boolean);
  });
  return hints;
}

// Returns sorted unique floor numbers present in Table 1 (only blocks with beds)
function _qs1UniqueFloors() {
  const floors = new Set([0]);
  _qs1Types.forEach(t => {
    _qs1Blocks.forEach(b => {
      const beds = parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value) || 0;
      if (!beds) return;
      const flv = document.getElementById(`qs1-fl-${t.key}-${b.id}`)?.value;
      if (flv !== undefined && flv !== '') {
        const fl = parseInt(flv);
        if (!isNaN(fl)) floors.add(fl);
      }
    });
  });
  return [...floors].sort((a, b) => a - b);
}

// Session 179 Piece 3: a block can now optionally be restricted to Medical or Surgical
// departments (see blkHeadersRow1's own comment for the real-hospital reasoning). Returns
// which zone a department belongs to for this purpose, reusing the exact same grouping
// ncismStaffCompliance.js already uses for bed-count summing -- never a second, hand-copied list.
function _deptZone(ncismCode) {
  if (IPD_MEDICAL_BED_CODES.includes(ncismCode))  return 'medical';
  if (IPD_SURGICAL_BED_CODES.includes(ncismCode)) return 'surgical';
  return null; // a department with no zone membership (e.g. Panchakarma's own separate NCISM
               // line still counts as 'medical' via IPD_MEDICAL_BED_CODES above, matching
               // Dr. Venkatesh's own description of it being physically co-located there) is
               // never zone-restricted -- can draw from any block, including a zoned one.
}

// Proportionally split a bed-type distribution across building blocks from Table 1
// Block-first approach: allocate beds to blocks by pool size ratio, then distribute types within each block
//
// Session 179 Piece 3: `ncismCode` (new param, optional -- every existing caller keeps working
// unchanged if omitted) narrows the eligible block set to ones NOT restricted to the OTHER
// zone. A block tagged 'any' (the default) or matching this department's own zone is eligible;
// a block tagged for the opposite zone is excluded entirely, same as if it didn't exist for
// this department's purposes -- this is what makes a "Surgical Ward" block genuinely
// unreachable by a Medical department's auto-allocation, not just unlikely.
function _computeBlockAllocation(distribution, ncismCode) {
  const blockAlloc = {};
  _qs1Blocks.forEach(b => { blockAlloc[b.id] = {}; });

  const totalNeeded = Object.values(distribution).reduce((s, v) => s + v, 0);
  if (!totalNeeded) return blockAlloc;

  const deptZone = ncismCode ? _deptZone(ncismCode) : null;
  const eligibleBlocks = _qs1Blocks.filter(b => !b.zone || b.zone === 'any' || !deptZone || b.zone === deptZone);
  if (!eligibleBlocks.length) return blockAlloc; // every block is restricted to the other zone -- nothing to allocate

  // Step 1: measure total pool size per block
  const blockPoolSize = {};
  let grandPool = 0;
  eligibleBlocks.forEach(b => {
    let sz = 0;
    _qs1Types.forEach(t => { sz += parseInt(document.getElementById(`qs1-${t.key}-${b.id}`)?.value) || 0; });
    blockPoolSize[b.id] = sz;
    grandPool += sz;
  });
  if (!grandPool) return blockAlloc;

  // Step 2: split totalNeeded across blocks proportional to pool size (largest-remainder)
  const blockTarget = {};
  let blkAssigned = 0;
  const blkFracs = {};
  eligibleBlocks.forEach(b => {
    const exact = (blockPoolSize[b.id] / grandPool) * totalNeeded;
    blockTarget[b.id] = Math.floor(exact);
    blkAssigned += Math.floor(exact);
    blkFracs[b.id] = exact - Math.floor(exact);
  });
  let blkRem = totalNeeded - blkAssigned;
  // Tie-breaker rotates per call so remainders alternate across depts (prevents F1 always winning)
  const blkSorted = [...eligibleBlocks].sort((a, b) => {
    const diff = blkFracs[b.id] - blkFracs[a.id];
    if (Math.abs(diff) > 1e-9) return diff;
    const ai = eligibleBlocks.findIndex(x => x.id === a.id);
    const bi = eligibleBlocks.findIndex(x => x.id === b.id);
    return ((ai + _blkRemOffset) % eligibleBlocks.length) - ((bi + _blkRemOffset) % eligibleBlocks.length);
  });
  _blkRemOffset = (_blkRemOffset + 1) % Math.max(eligibleBlocks.length, 1);
  for (let i = 0; i < blkRem; i++) blockTarget[blkSorted[i % blkSorted.length].id]++;

  // Step 3: within each block, distribute its target across types proportional to that block's pool
  eligibleBlocks.forEach(b => {
    const target = blockTarget[b.id];
    if (!target) return;
    const typeKeys = Object.keys(distribution);
    const blockPool = {};
    let blockPoolTotal = 0;
    typeKeys.forEach(k => {
      const c = parseInt(document.getElementById(`qs1-${k}-${b.id}`)?.value) || 0;
      blockPool[k] = c;
      blockPoolTotal += c;
    });
    if (!blockPoolTotal) return;
    let tAssigned = 0;
    const tFracs = {};
    typeKeys.forEach(k => {
      const exact = (blockPool[k] / blockPoolTotal) * target;
      blockAlloc[b.id][k] = Math.floor(exact);
      tAssigned += Math.floor(exact);
      tFracs[k] = exact - Math.floor(exact);
    });
    let tRem = target - tAssigned;
    const tSorted = [...typeKeys].sort((a, bk) => tFracs[bk] - tFracs[a]);
    for (let i = 0; i < tRem; i++) blockAlloc[b.id][tSorted[i % tSorted.length]]++;
  });

  return blockAlloc;
}

function renderQs2Table(pool) {
  const container = document.getElementById('qs2-table-container');
  if (!container) return;

  const activeCols = _qs1Types.filter(t => !pool || pool[t.key] > 0 || Object.keys(pool).length === 0);
  _qsActiveCols = activeCols.map(t => t.key);

  // Build NCISM rows with UG + PG required
  const ncismRows = Object.entries(UG_BED_RATIOS)
    .map(([code, ratio]) => {
      const dept  = _depts.find(d => d.ncism_code === code);
      const ug    = Math.floor(_ugIntake * ratio);
      const pg    = dept?.is_pg_dept ? (dept.pg_seats_sanctioned || 0) : 0;
      return { code, dept, ug, pg, required: ug + pg,
        prefix: DEPT_PREFIX[code] || '', reservedStart: _deptReservedStart(code) };
    })
    .filter(r => r.required > 0)
    .sort((a, b) => b.required - a.required ||
      NCISM_BED_PRIORITY.indexOf(a.code) - NCISM_BED_PRIORITY.indexOf(b.code));

  window._qsNcismRows2 = ncismRows;

  const totalRequired   = ncismRows.reduce((s, r) => s + r.required, 0);
  const totalConfigured = ncismRows.reduce((s, r) => {
    const db = r.dept ? _beds.filter(b => b.department_id === r.dept.id).length : 0;
    return s + Math.min(db, r.required);
  }, 0);

  const poolIsEmpty  = Object.keys(pool).length === 0;
  const typeHints    = poolIsEmpty ? {} : _qs1TypeBlockHints(activeCols, pool);
  const uniqueFloors = _qs1UniqueFloors();

  // Two-row header: row 1 = main headers (rowspan 2 for non-type cols), row 2 = per-block hints per type
  const colHeadersRow1 = activeCols.map(t =>
    `<th style="text-align:center;min-width:60px;font-size:10px;line-height:1.3;border-bottom:1px solid rgba(255,255,255,0.3)">${t.label.replace(' ','\n')}</th>`
  ).join('');

  const colSubHdr = activeCols.map(t => {
    const hints = typeHints[t.key] || [];
    const txt   = hints.map(h => `${h.short}(${h.flStr}):${h.beds}`).join(' · ');
    return `<th style="text-align:center;font-size:9px;font-weight:400;padding:2px 4px;opacity:.85;white-space:nowrap">${txt || '—'}</th>`;
  }).join('');

  // Session 96: pre-compute each not-yet-done department's type distribution against a shared,
  // depleting pool (not the static full pool) so bed TYPE totals across all departments exactly
  // match the real Table 1 inventory instead of drifting — each department previously computed
  // its distribution independently against the full pool, so per-department roundings could
  // each be individually correct while still summing to more (or fewer) beds of a given type
  // than physically exist. Found live on SDM: Table 1 had 6 twin-sharing beds, but summing the
  // 7 departments' independently-rounded distributions produced 7 — two departments' roundings
  // both rounded up. Processed in the same required-desc/priority order rows render in, matching
  // quickSetupCreateAll()'s own processing order, so the pre-filled inputs an admin sees are
  // exactly what "Create All Beds" would produce.
  const distByCode = {};
  if (!poolIsEmpty) {
    const runningPool = { ...pool };
    ncismRows.forEach(r => {
      const deptBeds = r.dept ? _beds.filter(b => b.department_id === r.dept.id) : [];
      if (!r.dept || deptBeds.length >= r.required) return; // done/no-dept rows don't consume pool
      const dist = _distributeProportionally(r.required - deptBeds.length, runningPool);
      distByCode[r.code] = dist;
      Object.entries(dist).forEach(([k, v]) => { runningPool[k] = (runningPool[k] || 0) - v; });
    });
  }

  const tableRows = ncismRows.map(r => {
    const deptBeds   = r.dept ? _beds.filter(b => b.department_id === r.dept.id) : [];
    const configured  = deptBeds.length;
    const noDept      = !r.dept;
    const ncismLabel  = NCISM_CODES.find(n => n.code === r.code)?.label || r.code;
    const done        = configured >= r.required;

    if (noDept) return `<tr class="qs-no-dept">
      <td style="font-size:12px;position:sticky;left:0;background:#fff;z-index:1">${ncismLabel}</td>
      <td style="text-align:center">${r.ug}${r.pg > 0 ? `+${r.pg}` : ''}</td>
      <td colspan="${activeCols.length + 5}" style="font-size:11px;color:#bbb">Department not seeded — click "Seed NCISM Depts" first</td>
    </tr>`;

    if (done) {
      const typeSummary = activeCols.map(t => {
        const cnt = deptBeds.filter(b => b.bed_type === t.key).length;
        return `<td style="text-align:center;color:var(--text-muted);font-size:12px">${cnt || '—'}</td>`;
      }).join('');
      // Group done beds by ward_name → floor → count
      const doneBldgMap = {};
      deptBeds.forEach(b => {
        const w  = b.ward_name || '\x00';
        const fl = b.floor_number ?? 0;
        if (!doneBldgMap[w]) doneBldgMap[w] = {};
        doneBldgMap[w][fl] = (doneBldgMap[w][fl] || 0) + 1;
      });
      const doneFloorStr = [...new Set(deptBeds.map(b => b.floor_number ?? 0))].sort((a,b) => a-b)
        .map(f => f === 0 ? 'GF' : `Fl.${f}`).join(', ') || 'GF';
      const doneBldgHtml = Object.keys(doneBldgMap).length
        ? Object.entries(doneBldgMap)
            .sort(([a],[b]) => a === '\x00' ? 1 : b === '\x00' ? -1 : a.localeCompare(b))
            .map(([w, floors]) => {
              const name = w === '\x00' ? '<em style="color:#aaa">No building</em>' : _esc(w);
              const flParts = Object.entries(floors)
                .sort(([a],[b]) => parseInt(a) - parseInt(b))
                .map(([fl, cnt]) => {
                  const lbl = parseInt(fl) === 0 ? 'GF' : `Fl.${fl}`;
                  return `<span style="color:var(--gold);font-weight:600">${lbl}</span>`
                       + `<span style="color:var(--text-muted)">&thinsp;(${cnt})</span>`;
                }).join('<span style="color:#ccc">&thinsp;·&thinsp;</span>');
              return `<div style="font-size:10px;line-height:1.8">${name}&ensp;${flParts}</div>`;
            }).join('')
        : '<span style="color:#ccc;font-size:10px">—</span>';
      return `<tr class="qs-done">
        <td style="position:sticky;left:0;background:#f0faf5;z-index:1"><span style="font-size:12px;font-weight:600">${ncismLabel}</span><span class="qs-dept-badge">${r.prefix}</span></td>
        <td style="text-align:center;font-weight:600">${r.required}${r.pg > 0 ? `<span style="font-size:9px;color:var(--gold);display:block">+${r.pg} PG</span>` : ''}</td>
        ${typeSummary}
        <td><span class="qs-done-badge">✓ ${configured}</span></td>
        <td style="font-size:10px;color:var(--text-muted)">${Object.keys(doneBldgMap).filter(k => k !== '\x00')[0] ? _esc(Object.keys(doneBldgMap).filter(k => k !== '\x00')[0]) : '—'}</td>
        <td style="vertical-align:top;padding:4px 8px">${doneBldgHtml}</td>
        <td style="text-align:center;font-size:10px;color:var(--text-dark)">${doneFloorStr}</td>
        <td><button class="btn btn-secondary btn-sm" data-onclick="switchTab" data-onclick-a0="dept" style="font-size:11px">Manage →</button></td>
      </tr>`;
    }

    const remaining  = r.required - configured;
    const dist       = distByCode[r.code] || {};
    const autoFloor   = poolIsEmpty ? 0 : _qs1DominantFloor(dist);
    const sources     = poolIsEmpty ? [] : _qs1Sources(dist);
    const floorOptHtml = uniqueFloors.map(f =>
      `<option value="${f}" ${f === autoFloor ? 'selected' : ''}>${f === 0 ? 'GF' : `Floor ${f}`}</option>`
    ).join('');

    const typeCells = activeCols.map(t => {
      const defVal = dist[t.key] || 0;
      return `<td style="text-align:center;padding:5px 4px">
        <input class="qs-cell-input" type="number" min="0"
          id="qs-cell-${r.code}-${t.key}" value="${defVal}"
          data-oninput="_qsUpdateTotal" data-oninput-a0="${_esc(r.code)}" data-oninput-a1="${remaining}"/>
      </td>`;
    }).join('');

    const initTotal  = Object.values(dist).reduce((s, v) => s + v, 0);
    const totalClass = initTotal === remaining ? 'ok' : (poolIsEmpty ? 'under' : 'under');
    const totalText  = poolIsEmpty ? '—' : (initTotal === remaining ? `${initTotal} ✓` : `${initTotal} (${initTotal - remaining})`);

    const sourcesHtml = sources.length
      ? sources.map(s => {
          const flParts = Object.entries(s.floorMap)
            .sort(([a],[b]) => parseInt(a) - parseInt(b))
            .map(([fl, cnt]) => {
              const lbl = parseInt(fl) === 0 ? 'GF' : `Fl.${fl}`;
              return `<span style="color:var(--gold);font-weight:600">${lbl}</span>`
                   + `<span style="color:var(--text-muted)">&thinsp;(${cnt})</span>`;
            }).join('<span style="color:#ccc">&thinsp;·&thinsp;</span>');
          return `<div style="font-size:10px;line-height:1.8">${_esc(s.full)}&ensp;${flParts}</div>`;
        }).join('')
      : '<span style="color:#ccc;font-size:10px">—</span>';

    return `<tr data-code="${r.code}" data-dept-id="${r.dept.id}" data-required="${r.required}" data-prefix="${r.prefix}">
      <td style="position:sticky;left:0;background:#fff;z-index:1">
        <span style="font-size:12px;font-weight:600">${ncismLabel}</span>
        <span class="qs-dept-badge">${r.prefix}</span>
        ${r.pg > 0 ? `<span style="display:block;font-size:9px;color:var(--gold);margin-top:1px">+${r.pg} PG beds</span>` : ''}
        ${configured > 0 ? `<span style="display:block;font-size:10px;color:var(--text-muted);margin-top:1px">${configured} already added</span>` : ''}
      </td>
      <td style="text-align:center;font-weight:600;color:var(--green-deep);font-size:12px">
        ${r.required}
        ${r.pg > 0 ? `<div style="font-size:9px;color:var(--gold);font-weight:400">${r.ug} UG + ${r.pg} PG</div>` : ''}
      </td>
      ${typeCells}
      <td style="text-align:center;min-width:72px">
        <span class="qs-total ${totalClass}" id="qs-total-${r.code}">${totalText}</span>
        <div style="font-size:9px;color:var(--text-muted);margin-top:2px">of ${remaining} needed</div>
      </td>
      <td style="min-width:110px"><input class="qs-input wide" type="text" id="qs-ward-${r.code}" placeholder="e.g. Main Building — Block A" title="Optional building/location note. For General/Dormitory-type beds in this batch, also groups them into a numbered Ward."/></td>
      <td style="min-width:140px;vertical-align:top;padding:6px 8px">${sourcesHtml}</td>
      <td>
        <select class="qs-input" id="qs-floor-${r.code}" style="width:90px;padding:4px 6px">
          ${floorOptHtml}
        </select>
      </td>
      <td><button class="btn btn-primary btn-sm" data-onclick="quickSetupCreateRow" data-onclick-a0="${_esc(r.code)}" id="qs-btn-${r.code}">Create</button></td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div style="overflow-x:auto">
    <table class="qs-table">
      <thead>
        <tr>
          <th rowspan="2" style="min-width:160px;vertical-align:middle;position:sticky;left:0;z-index:3;background:var(--green-deep)">Department</th>
          <th rowspan="2" style="text-align:center;min-width:65px;vertical-align:middle">NCISM<br>Required</th>
          ${colHeadersRow1}
          <th rowspan="2" style="text-align:center;min-width:72px;vertical-align:middle">Total<br>(of needed)</th>
          <th rowspan="2" style="min-width:115px;vertical-align:middle">Ward Name<br><span style="font-weight:400;opacity:.7;font-size:9px">optional; groups General/Dormitory beds</span></th>
          <th rowspan="2" style="min-width:140px;vertical-align:middle">Building Sources<br><span style="font-weight:400;opacity:.7;font-size:9px">(from Table 1)</span></th>
          <th rowspan="2" style="vertical-align:middle">Floor<br><span style="font-weight:400;opacity:.7;font-size:9px">(auto from pool)</span></th>
          <th rowspan="2"></th>
        </tr>
        <tr style="background:var(--green-mid)">${colSubHdr}</tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    </div>`;

  // Show footer
  const footer = document.getElementById('qs2-footer');
  if (footer) {
    footer.style.display = 'flex';
    const prog = document.getElementById('qs2-progress');
    if (prog) prog.innerHTML =
      `NCISM Beds: <strong>${totalConfigured}</strong> / ${totalRequired} configured
       ${totalConfigured >= totalRequired ? '<span style="color:var(--green-mid);font-weight:600;margin-left:8px">✓ All NCISM beds met</span>' : ''}`;
  }
}

async function renderQuickSetup() {
  const wrap = document.getElementById('quick-setup-wrap');
  if (!wrap) return;

  if (!_ugIntake || _ugIntake < 1) {
    wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">
      UG intake not configured. Quick Setup is only for NCISM teaching hospitals.<br>
      <span style="font-size:12px">Set <strong>ug_intake</strong> in the tenants table to enable.</span>
    </div>`;
    return;
  }

  await _qs1Init();

  wrap.innerHTML = `
    <div id="qs0-real-mapping-container"></div>

    <div class="qs-step-header"><span class="qs-step-num">1</span>
      Physical Bed Inventory
      <span class="qs-step-desc">Enter total beds you have by type across each building block / floor</span>
    </div>
    <div id="qs1-table-container"></div>

    <div class="qs-distribute-bar">
      <div>
        <div style="font-weight:600;color:var(--green-deep);font-size:13px">After entering your inventory →</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
          The system will distribute beds to each department proportionally based on your inventory mix.
          PG department beds are added on top of UG allocations.
        </div>
      </div>
      <button class="btn btn-primary" data-onclick="autoDistribute">↓ Auto-Distribute to Departments</button>
    </div>

    <div class="qs-step-header"><span class="qs-step-num">2</span>
      Department Allocation
      <span class="qs-step-desc">Review proportional distribution — adjust if needed. Each row total must match "NCISM Required".</span>
    </div>
    <div id="qs2-table-container">
      <div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;border:1.5px dashed var(--border);border-radius:8px;margin-top:4px">
        Complete Table 1 and click "Auto-Distribute to Departments" to populate this table.
      </div>
    </div>

    <div class="qs-footer" id="qs2-footer" style="display:none">
      <div id="qs2-progress" class="qs-progress"></div>
      <button class="btn btn-primary" data-onclick="quickSetupCreateAll" id="qs-btn-all">⚡ Create All Beds</button>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:10px">
      ✏️ Bed numbers are auto-assigned within each department's NCISM reserved range, grouped by bed type in the order shown.
    </div>`;

  renderQs1RealMapping();
  renderQs1Table();

  // If saved inventory exists, auto-populate Table 2 immediately
  const pool = _qs1Pool();
  if (Object.keys(pool).length > 0) renderQs2Table(pool);
}

// Session 179 follow-up (Dr. Venkatesh, live): Table 1's draft boxes are browser-localStorage-
// only and can never be relied on to reflect reality -- confirmed live when a second origin
// (local dev server vs. the live site) showed a completely empty draft despite 100 real beds
// existing. Rather than repurpose the draft/create boxes to show real counts (real risk: Table 2
// would then read a "draft" that already equals reality, and clicking through to create beds
// could add a duplicate set on top of what exists), this renders a separate, fully READ-ONLY
// table computed straight from _beds -- same bed-type x block shape as Table 1 for easy visual
// comparison, but with zero inputs and zero connection to bed creation.
function renderQs1RealMapping() {
  const container = document.getElementById('qs0-real-mapping-container');
  if (!container) return;

  if (!_beds.length) {
    container.innerHTML = `<div style="padding:14px 16px;background:var(--cream);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;font-size:12px;color:var(--text-muted)">
      📋 No real beds exist yet for this hospital — once you create beds (via Table 1 below), they'll show here as your actual current mapping.
    </div>`;
    return;
  }

  // Real blocks = distinct ward_name values actually present in the database (NOT Table 1's
  // possibly-unrelated draft block labels) -- this is what makes it a true, origin-independent
  // mapping rather than another copy of the draft's own local state.
  const blockCounts = {}; // label -> { [typeKey]: count }
  _beds.forEach(bd => {
    const label = bd.ward_name || '(No ward name)';
    (blockCounts[label] ||= {});
    blockCounts[label][bd.bed_type] = (blockCounts[label][bd.bed_type] || 0) + 1;
  });
  const labels = Object.keys(blockCounts).sort();

  // Only show bed-type rows that actually have at least one real bed somewhere, keeping this
  // compact rather than repeating Table 1's full 12-row template with mostly empty rows.
  const typesPresent = _qs1Types.filter(t => labels.some(l => blockCounts[l][t.key] > 0));

  const headerCells = labels.map(l => `<th style="text-align:center;padding:5px 8px;min-width:70px">${_esc(l)}</th>`).join('');
  const bodyRows = typesPresent.map(t => {
    const cells = labels.map(l => {
      const n = blockCounts[l][t.key] || 0;
      return `<td style="text-align:center;padding:5px 8px;font-weight:${n ? 600 : 400};color:${n ? 'var(--green-deep)' : '#ccc'}">${n || '—'}</td>`;
    }).join('');
    const rowTotal = labels.reduce((s, l) => s + (blockCounts[l][t.key] || 0), 0);
    return `<tr><td style="padding:5px 8px;font-weight:500">${_esc(t.label)}</td>${cells}<td style="text-align:center;padding:5px 8px;font-weight:700;color:var(--blue)">${rowTotal}</td></tr>`;
  }).join('');
  const colTotals = labels.map(l => {
    const n = Object.values(blockCounts[l]).reduce((s, v) => s + v, 0);
    return `<td style="text-align:center;padding:5px 8px;font-weight:700;color:var(--blue)">${n}</td>`;
  }).join('');

  container.innerHTML = `
    <div class="qs-step-header"><span class="qs-step-num" style="background:var(--blue)">👁</span>
      Current Real Bed Mapping <span style="font-size:10px;font-weight:400;color:var(--blue);background:rgba(26,64,128,0.1);padding:2px 7px;border-radius:10px;margin-left:6px">read-only · live from database</span>
      <span class="qs-step-desc">Your hospital's actual bed inventory right now, by type and building block — not editable here, not connected to bed creation.</span>
    </div>
    <div style="overflow-x:auto;margin-bottom:16px">
      <table class="qs-table" style="font-size:12px">
        <thead><tr style="background:var(--blue)"><th style="text-align:left;padding:5px 8px">Bed Type</th>${headerCells}<th style="text-align:center;padding:5px 8px">Total</th></tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr style="background:rgba(26,64,128,0.08)"><td style="padding:5px 8px;font-weight:600">Total →</td>${colTotals}<td style="text-align:center;padding:5px 8px;font-weight:700;color:var(--blue)">${_beds.length}</td></tr></tfoot>
      </table>
    </div>`;
}

window.quickSetupCreateRow = async function(code, silent) {
  const row      = document.querySelector(`#qs2-table-container tr[data-code="${code}"]`);
  if (!row) return { skipped: true };
  const deptId   = row.dataset.deptId;
  const required = parseInt(row.dataset.required);
  const prefix   = row.dataset.prefix || DEPT_PREFIX[code] || code;
  const ward     = document.getElementById(`qs-ward-${code}`)?.value.trim() || null;
  const floor    = parseInt(document.getElementById(`qs-floor-${code}`)?.value) || 0;

  const deptBeds = _beds.filter(b => b.department_id === deptId);
  const needed   = required - deptBeds.length;

  const distribution = {};
  let totalEntered = 0;
  _qsActiveCols.forEach(k => {
    const v = parseInt(document.getElementById(`qs-cell-${code}-${k}`)?.value || 0) || 0;
    if (v > 0) distribution[k] = v;
    totalEntered += v;
  });

  if (totalEntered !== needed) {
    if (!silent) _alert('error',
      `${prefix}: entered ${totalEntered} but need ${needed} beds. Adjust the row first.`);
    return { error: true };
  }
  if (!totalEntered) {
    if (!silent) _alert('info', `No beds to add for ${prefix}.`);
    return { skipped: true };
  }

  const reservedStart = _deptReservedStart(code);
  const existingNums  = new Set(
    deptBeds.filter(b => b.bed_number.startsWith(prefix + '-'))
            .map(b => parseInt(b.bed_number.split('-').pop()))
            .filter(n => !isNaN(n))
  );
  let nextNum = reservedStart;
  while (existingNums.has(nextNum)) nextNum++;

  // Insert beds grouped by building block (when no explicit ward name)
  const rows = [];
  const typeOrder = (_qs1Types || []).map(t => t.key);

  if (!ward && _qs1Blocks && _qs1Blocks.length) {
    // Per-block: each building block gets its own ward_name + floor.
    //
    // Session 179 real design fix (Dr. Venkatesh, working through bed-admin.html's own
    // screens live): bed numbers used to be assigned from _deptReservedStart()'s DEPARTMENT-
    // first global range -- Panchakarma's whole allocation (mixing several real ward types)
    // sat in one contiguous block (PK-01..PK-25), giving no way to tell that e.g. PK-03 and a
    // same-room Kayachikitsa bed physically share Male General Ward. Real hospital wards are
    // shared rooms -- a department's "bed share" is a planning/NCISM ratio, not a physical
    // partition. Fixed by numbering WARD-TYPE-first instead: _qs1CellSequence() reserves one
    // continuous global range per (bed-type, block) cell (the same one shown live in Table
    // 1's new "Bed #" column); this department's own beds for a given cell simply continue
    // from however many of THAT SAME cell's beds already exist (from any department, not just
    // this one) -- so a department's cards now correctly show a SCATTERED set of real hospital-
    // wide numbers, one sub-range per ward type it actually participates in, instead of one
    // fake-contiguous block. No existingNums/nextNum collision tracking needed here anymore --
    // each cell's own running count is the only thing that can ever collide, and it's shared.
    const cellSeq     = _qs1CellSequence();
    const blockAlloc = _computeBlockAllocation(distribution, code);
    _qs1Blocks.forEach(b => {
      const bDist = blockAlloc[b.id] || {};
      if (!Object.values(bDist).some(v => v > 0)) return;
      const blockLabel = document.getElementById(`qs1-blk-${b.id}`)?.value || null;
      const sortedKeys = Object.keys(bDist).filter(k => bDist[k] > 0)
        .sort((a, bk) => typeOrder.indexOf(a) - typeOrder.indexOf(bk));
      for (const k of sortedKeys) {
        // Use the floor configured for this specific bed type in this block (Table 1)
        const flv = document.getElementById(`qs1-fl-${k}-${b.id}`)?.value;
        const typeFloor = (flv !== undefined && flv !== '') ? parseInt(flv) || 0 : floor;

        const cell = cellSeq.find(c => c.typeKey === k && c.blockId === b.id);
        const alreadyInCell = _beds.filter(bd => bd.bed_type === k && bd.ward_name === blockLabel).length;
        let cellNum = cell ? cell.start + alreadyInCell : nextNum; // reservedStart fallback if Table 1 wasn't filled for this exact cell
        for (let i = 0; i < bDist[k]; i++) {
          rows.push({
            tenant_id: tenantId, department_id: deptId,
            bed_number: `${prefix}-${String(cellNum).padStart(2, '0')}`,
            floor_number: typeFloor, ward_name: blockLabel, block_id: b.id, bed_type: k,
            status: 'vacant', is_pg_allocated: false,
          });
          cellNum++;
        }
      }
    });
  } else {
    // Explicit ward name entered — single ward/floor for all beds
    const sortedKeys = Object.keys(distribution).sort(
      (a, b) => typeOrder.indexOf(a) - typeOrder.indexOf(b)
    );
    for (const k of sortedKeys) {
      for (let i = 0; i < distribution[k]; i++) {
        while (existingNums.has(nextNum)) nextNum++;
        rows.push({
          tenant_id: tenantId, department_id: deptId,
          bed_number: `${prefix}-${String(nextNum).padStart(2, '0')}`,
          floor_number: floor, ward_name: ward, bed_type: k, status: 'vacant',
          is_pg_allocated: false,
        });
        existingNums.add(nextNum); nextNum++;
      }
    }
  }

  // Session 179 Piece 3: a zone-restricted block can leave a department with less eligible
  // pool than it needs (e.g. a misconfigured "Surgical Ward" block with no beds left for a
  // Medical department) -- _computeBlockAllocation() would just silently distribute whatever
  // pool IS eligible rather than erroring, so `rows.length` can end up short of `needed`
  // without the earlier totalEntered/needed check (which only validates the TYPE-level total,
  // not whether the block split can actually satisfy it) ever catching it. Surfaced here
  // instead of silently under-creating beds.
  if (!ward && rows.length < needed) {
    if (!silent) _alert('error',
      `${prefix}: only ${rows.length} of ${needed} beds could be placed -- one or more bed types don't have enough eligible pool in this department's allowed blocks (check block zone restrictions in Table 1). No beds were created; adjust the block zones or Table 2's split and try again.`);
    return { error: true };
  }

  const btn = document.getElementById(`qs-btn-${code}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  _assignUnitNumbers(rows);
  const { error } = await supabase.from('beds').insert(rows);
  if (error) {
    if (!silent) _alert('error', safeErrorMessage(error, `Failed to add ${prefix} beds.`));
    if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    return { error };
  }
  // quickSetupCreateAll() loops this per department without reloading _beds in between --
  // push the newly-created rows in immediately so the next department's own bed types
  // (deluxe etc. commonly span every department) see these rooms/wards as taken and
  // continue the sequence instead of colliding on the same unit_number.
  _beds.push(...rows);
  return { added: rows.length };
};

window.quickSetupCreateAll = async function() {
  _blkRemOffset = 0; // reset so distribution is reproducible each run
  const btn = document.getElementById('qs-btn-all');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  const activeRows = [...document.querySelectorAll('#qs2-table-container tr[data-code]')];

  // Validate all rows first
  const invalid = [];
  for (const row of activeRows) {
    const code      = row.dataset.code;
    const deptId    = row.dataset.deptId;
    const required  = parseInt(row.dataset.required);
    const configured = _beds.filter(b => b.department_id === deptId).length;
    const needed    = required - configured;
    if (needed <= 0) continue;
    let total = 0;
    _qsActiveCols.forEach(k => {
      total += parseInt(document.getElementById(`qs-cell-${code}-${k}`)?.value || 0) || 0;
    });
    if (total !== needed) invalid.push(`${row.dataset.prefix} (need ${needed}, entered ${total})`);
  }
  if (invalid.length) {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Create All Beds'; }
    _alert('error', 'Fix totals before creating: ' + invalid.join(' · '));
    return;
  }

  let totalAdded = 0, errors = 0;
  for (const row of activeRows) {
    const code    = row.dataset.code;
    const deptId  = row.dataset.deptId;
    const required = parseInt(row.dataset.required);
    if (_beds.filter(b => b.department_id === deptId).length >= required) continue;
    const result = await quickSetupCreateRow(code, true);
    if (result.added) totalAdded += result.added;
    if (result.error) errors++;
  }

  await loadAll();
  if (btn) { btn.disabled = false; btn.textContent = '⚡ Create All Beds'; }
  if (errors)
    _alert('error', `${totalAdded} beds created, ${errors} dept(s) had errors.`);
  else
    _alert('success', `${totalAdded} bed${totalAdded !== 1 ? 's' : ''} created successfully.`);
};

// Refresh dept-info-panel in whichever bed/bulk drawer is currently open
function _refreshOpenDrawerDeptInfo() {
  if (document.getElementById('bed-overlay').classList.contains('open')) {
    const v = document.getElementById('bed-dept').value;
    if (v) updateDeptInfo('bed');
  }
  if (document.getElementById('bulk-overlay').classList.contains('open')) {
    const v = document.getElementById('bulk-dept').value;
    if (v) updateDeptInfo('bulk');
  }
}

// ── Populate OPD select in dept drawer ───────────────────────────────────────
function _populateOpdSelect() {
  const sel = document.getElementById('dept-opd');
  sel.innerHTML = '<option value="">— None / IPD-only dept —</option>';
  _opds.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    sel.appendChild(opt);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  const total    = _beds.length;
  const occupied = _beds.filter(b => b.status === 'occupied').length;
  const pct      = total ? Math.round(occupied / total * 100) : 0;

  document.getElementById('stat-depts').textContent      = _depts.filter(d => d.is_active && UG_BED_RATIOS[d.ncism_code]).length;
  document.getElementById('stat-total-beds').textContent = total;
  document.getElementById('stat-occupied').textContent   = occupied;
  document.getElementById('stat-occupancy').textContent  = pct + '%';

  const occCard = document.getElementById('stat-occupancy').closest('.stat-card');
  occCard.className = 'stat-card' + (pct >= 80 ? ' ' : pct >= 60 ? ' warn' : ' danger');

  renderBuildingSummary();
}

function renderBuildingSummary() {
  const el = document.getElementById('building-summary');
  if (!el) return;
  if (!_beds.length) { el.innerHTML = ''; return; }

  // Group: ward_name (building) → floor → {vacant, occupied, maintenance, reserved}
  const buildings = {};
  _beds.forEach(b => {
    const key = b.ward_name || '\x00';
    const fl  = b.floor_number ?? 0;
    if (!buildings[key]) buildings[key] = { name: b.ward_name, floors: {} };
    if (!buildings[key].floors[fl]) buildings[key].floors[fl] = { vacant:0, occupied:0, maintenance:0, reserved:0 };
    const s = b.status || 'vacant';
    if (buildings[key].floors[fl][s] !== undefined) buildings[key].floors[fl][s]++;
    else buildings[key].floors[fl].vacant++;
  });

  const flLabel = f => parseInt(f) === 0 ? 'Ground Floor' : `Floor ${f}`;
  const STATUSES = [
    ['vacant',      '🟢', 'vacant'],
    ['occupied',    '🔴', 'occupied'],
    ['maintenance', '🟡', 'maintenance'],
    ['reserved',    '🟠', 'reserved'],
  ];
  const bldgKeys = Object.keys(buildings);
  const noInfo   = bldgKeys.length === 1 && bldgKeys[0] === '\x00';

  const cards = Object.entries(buildings)
    .sort(([a],[b]) => a === '\x00' ? 1 : b === '\x00' ? -1 : a.localeCompare(b))
    .map(([key, { name, floors }]) => {
      const total = Object.values(floors)
        .reduce((s, f) => s + f.vacant + f.occupied + f.maintenance + f.reserved, 0);

      const flBlocks = Object.entries(floors)
        .sort(([a],[b]) => parseInt(a) - parseInt(b))
        .map(([fl, counts]) => {
          const chips = STATUSES
            .filter(([s]) => counts[s] > 0)
            .map(([s, icon, cls]) =>
              `<span class="bsm-chip ${cls}">${icon} ${counts[s]} ${s}</span>`
            ).join('');
          return `<div class="bsm-floor-block">
            <div class="bsm-floor-label">${flLabel(fl)}</div>
            <div class="bsm-chips">${chips || '<span class="bsm-chip vacant">🟢 0 vacant</span>'}</div>
          </div>`;
        }).join('');

      const hdr = name
        ? `${_esc(name)}<span class="bsm-total">${total} beds</span>`
        : `<span style="font-style:italic;color:var(--text-muted)">No building assigned</span>
           <span class="bsm-total">${total} beds</span>`;

      return `<div class="bsm-card">
        <div class="bsm-card-name">${hdr}</div>
        ${flBlocks}
        ${noInfo ? `<div class="bsm-no-info">Use ⚡ Quick Setup to assign buildings.</div>` : ''}
      </div>`;
    }).join('');

  el.innerHTML = `<div style="font-size:11px;font-weight:600;color:var(--text-muted);
      text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px">
      Building &amp; Floor Breakdown
    </div>
    <div class="bsm-row">${cards}</div>`;
}

// ── NCISM compliance check ────────────────────────────────────────────────────
function checkNcismCompliance() {
  const existingCodes = new Set(_depts.filter(d => d.is_active).map(d => d.ncism_code).filter(Boolean));
  const missing = NCISM_CODES.filter(n => n.mandatory && !existingCodes.has(n.code));
  const banner = document.getElementById('ncism-banner');

  if (missing.length) {
    banner.textContent = `NCISM Compliance: ${missing.length} mandatory department(s) not configured — `
      + missing.map(m => m.label.split(' ')[0]).join(', ')
      + '. These are created automatically once your NCISM capacity request is approved (Subscription tab), or add manually via "+ New Department".';
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

// ── Render departments ────────────────────────────────────────────────────────
function renderDepts() {
  const grid = document.getElementById('dept-grid');
  // This page is specifically IPD bed setup — only the 7 departments with a real Table-8
  // bed ratio ever have beds. Security/Administration/Screening/the pre-clinical teaching
  // departments etc. never appear here (see "New Department" if a genuinely custom bedded
  // department is needed instead).
  const beddedDepts = _depts.filter(d => UG_BED_RATIOS[d.ncism_code]);
  document.getElementById('dept-count-label').textContent = `Departments (${beddedDepts.length})`;

  if (!beddedDepts.length) {
    grid.innerHTML = `<div class="dept-empty">No bedded NCISM departments configured yet.<br>These are created automatically once your organisation's NCISM capacity is approved (Subscription tab), or add one manually via "+ New Department".</div>`;
    return;
  }

  const sortedDepts = beddedDepts; // _depts is already globally sorted by bed-share in loadAll()

  grid.innerHTML = sortedDepts.map(d => {
    const deptBeds   = _beds.filter(b => b.department_id === d.id);
    const occupied   = deptBeds.filter(b => b.status === 'occupied').length;
    const pct        = deptBeds.length ? Math.round(occupied / deptBeds.length * 100) : 0;
    const pgBeds     = deptBeds.filter(b => b.is_pg_allocated).length;
    const pgRequired = d.is_pg_dept ? d.pg_seats_sanctioned * 4 : 0;
    const ncismInfo  = d.ncism_code ? NCISM_CODES.find(n => n.code === d.ncism_code) : null;

    const violates   = d.is_pg_dept && pgRequired > 0 && (pgBeds < pgRequired || pct < 80);

    // NCISM required beds (Table-8 ratio × UG intake)
    const ratio         = UG_BED_RATIOS[d.ncism_code] || 0;
    const exactRequired = ratio > 0 && _ugIntake > 0 ? _ugIntake * ratio : 0;
    const requiredBeds  = Math.floor(exactRequired);
    const isRounded     = exactRequired > 0 && exactRequired !== requiredBeds;
    const gap           = requiredBeds > 0 ? Math.max(0, requiredBeds - deptBeds.length) : 0;

    const ncismBedRow = requiredBeds > 0 ? `
      <div class="ncism-bed-row">
        <span>NCISM Required: <strong>${requiredBeds}${isRounded ? '*' : ''}</strong></span>
        <span>Configured: <strong>${deptBeds.length}</strong></span>
        ${gap > 0
          ? `<span class="ncism-gap-warn">⚠ Need ${gap} more</span>`
          : `<span class="ncism-gap-ok">✓ Beds met</span>`}
      </div>
      ${isRounded ? `<div class="rounding-note">* ${_ugIntake} × ${ratio * 100}% = ${exactRequired} beds — rounded down to ${requiredBeds}. Collectively all departments meet the NCISM Table-8 minimum of ${_ugIntake} beds.</div>` : ''}` : '';

    const bedListHtml = deptBeds.length > 0
      ? `<div class="dept-bed-list">${deptBeds.map(_bedTagHtml).join('')}</div>`
      : `<div class="dept-no-beds">No beds added yet</div>`;

    return `<div class="dept-card">
      <div class="dept-card-head">
        <div>
          <div class="dept-name">${_esc(d.name)}</div>
          ${ncismInfo ? `<div class="dept-code">${d.ncism_code}</div>` : ''}
        </div>
        <div class="dept-badges">
          ${d.is_mandatory ? `<span class="badge badge-mandatory">NCISM</span>` : ''}
          ${d.is_pg_dept   ? `<span class="badge badge-pg">PG</span>` : ''}
          ${violates       ? `<span class="badge badge-violation">⚠ Ratio</span>` : ''}
          <span class="badge ${d.is_active ? 'badge-active' : 'badge-inactive'}">${d.is_active ? 'Active' : 'Inactive'}</span>
        </div>
      </div>
      ${ncismBedRow}
      <div class="dept-stats" style="margin-top:8px">
        <span>Beds: <strong>${deptBeds.length}</strong></span>
        <span>Occupied: <strong>${occupied}</strong></span>
        <span>Occ%: <strong>${deptBeds.length ? pct + '%' : '—'}</strong></span>
        ${d.is_pg_dept ? `<span>PG beds: <strong>${pgBeds}/${pgRequired}</strong></span>` : ''}
      </div>
      ${bedListHtml}
      <div class="dept-actions">
        <button class="btn btn-secondary btn-sm" data-onclick="openBedDrawer" data-onclick-a0="@null" data-onclick-a1="${_esc(d.id)}">+ Bed</button>
        ${deptBeds.length > 0 ? `<button class="btn btn-sm" style="color:#c02020;border:1.5px solid #c02020;background:transparent;padding:4px 10px" data-onclick="deleteAllDeptBeds" data-onclick-a0="${_esc(d.id)}" title="Delete all beds in this department">🗑 All Beds</button>` : ''}
        <button class="icon-btn" data-onclick="openDeptDrawer" data-onclick-a0="${_esc(d.id)}" title="Edit">&#9998;</button>
        <button class="icon-btn del" data-onclick="deleteDept" data-onclick-a0="${_esc(d.id)}" title="Delete">&#128465;</button>
      </div>
    </div>`;
  }).join('');
}

// ── Render bed matrix ─────────────────────────────────────────────────────────
function renderBeds() {
  const grid       = document.getElementById('bed-grid');
  const deptFilter = document.getElementById('filter-dept').value;
  const statFilter = document.getElementById('filter-status').value;
  const typeFilter = document.getElementById('filter-type').value;

  let beds = _beds;
  if (deptFilter) beds = beds.filter(b => b.department_id === deptFilter);
  if (statFilter) beds = beds.filter(b => b.status === statFilter);
  if (typeFilter) beds = beds.filter(b => b.bed_type === typeFilter);

  if (!beds.length) {
    grid.innerHTML = `<div class="bed-empty">No beds match the current filter.<br>Use "+ Add Bed" or "Bulk Add Beds" to configure the ward.</div>`;
    return;
  }

  // Group by department bed-share rank (same order as everywhere else on this page),
  // then by bed number within each department, so an unfiltered grid reads PK→...→AGD
  // instead of scattering beds by their prefix's raw alphabetical order.
  const deptRank = Object.fromEntries(_depts.map((d, i) => [d.id, i]));
  beds = [...beds].sort((a, b) =>
    (deptRank[a.department_id] ?? 999) - (deptRank[b.department_id] ?? 999) ||
    a.bed_number.localeCompare(b.bed_number, undefined, {numeric:true, sensitivity:'base'}));

  const deptMap = Object.fromEntries(_depts.map(d => [d.id, d.name]));

  const STATUS_LABELS = {vacant:'Vacant',occupied:'Occupied',maintenance:'Maintenance',reserved:'Reserved'};
  const BED_LABELS    = {male_general:'Male General Ward',female_general:'Female General Ward',general:'General Ward',twin_sharing:'Twin Sharing',semi_private:'Shared Private',private:'Private Room',deluxe:'Deluxe Private',dormitory:'Dormitory',icu:'ICU',day_care:'Day Care',pk_treatment:'PK Treatment',observation:'Observation'};
  grid.innerHTML = beds.map(b => {
    const st        = b.status || 'vacant';
    const typeLabel = BED_LABELS[b.bed_type] || b.bed_type.replace(/_/g,' ');
    const unitLbl = _unitLabel(b);
    // Session 179 Piece 2: wards are physically shared across departments (Piece 1) --
    // ipd.js's admission picker allows admitting into a bed "planned" for a different
    // department (overflow, allowed with a warning there). This flag is the standing visual
    // record of that on the Bed Matrix -- only shown for a currently-occupied bed whose real
    // admitting department differs from the bed's own planned department_id; never inferred
    // for a vacant bed (nothing to compare against yet).
    const occupantDept  = st === 'occupied' ? _bedOccupantDept[b.id] : null;
    const isCrossDept   = occupantDept && occupantDept !== b.department_id;
    const crossDeptFlag = isCrossDept
      ? `<div class="bed-cross-dept" title="Planned for ${_esc(deptMap[b.department_id] || '—')}, currently occupied by a ${_esc(deptMap[occupantDept] || '—')} patient">🔶 ${_esc(deptMap[occupantDept] || '—')} patient</div>`
      : '';
    return `<div class="bed-card ${st}" data-onclick="openBedDrawer" data-onclick-a0="${_esc(b.id)}" title="${_esc(b.bed_number)}${unitLbl ? ' — ' + _esc(unitLbl) : ''} — ${deptMap[b.department_id] || ''} — ${st}${isCrossDept ? ' — cross-department occupancy' : ''}">
      ${b.is_pg_allocated ? '<div class="bed-pg-dot" title="PG-allocated"></div>' : ''}
      <div class="bed-num">${_esc(b.bed_number)}</div>
      <div class="bed-dept-name">${_esc(deptMap[b.department_id] || '—')}</div>
      ${b.unit_number != null ? `<div class="bed-unit">${_esc(_unitLabel(b))}</div>` : ''}
      ${b.ward_name && b.unit_name !== b.ward_name ? `<div class="bed-ward">${_esc(b.ward_name)}</div>` : ''}
      <div class="bed-floor">${b.floor_number === 0 ? 'Ground Floor' : `Floor ${b.floor_number ?? 0}`}</div>
      <div class="bed-type-badge ${b.bed_type}">${typeLabel}</div>
      ${crossDeptFlag}
      <div class="bed-card-status ${st}">${STATUS_LABELS[st] || st}</div>
    </div>`;
  }).join('');
}
window.renderBeds = renderBeds;

// ── Tabs ──────────────────────────────────────────────────────────────────────
window.switchTab = function(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
};

// ── Dept drawer ───────────────────────────────────────────────────────────────
window.openDeptDrawer = function(id) {
  _populateNcismSelect();
  const dept = id ? _depts.find(d => d.id === id) : null;
  document.getElementById('dept-drawer-title').textContent = dept ? 'Edit Department' : 'New Department';
  document.getElementById('dept-id').value        = dept ? dept.id : '';
  document.getElementById('dept-name').value      = dept ? dept.name : '';
  document.getElementById('dept-ncism').value     = dept?.ncism_code || '';
  document.getElementById('dept-opd').value       = dept?.opd_id || '';
  document.getElementById('dept-is-pg').checked   = dept?.is_pg_dept || false;
  document.getElementById('dept-pg-seats').value  = dept?.pg_seats_sanctioned || '';
  document.getElementById('dept-mandatory').checked = dept?.is_mandatory || false;
  document.getElementById('dept-active').checked  = dept ? dept.is_active : true;

  // Populate parent dropdown — exclude self and current dept's own children
  const parentSel = document.getElementById('dept-parent');
  const eligible  = (_depts || []).filter(d => d.id !== id && !d.parent_department_id);
  parentSel.innerHTML = '<option value="">— Top-level department —</option>' +
    eligible.map(d => `<option value="${d.id}"${dept?.parent_department_id===d.id?' selected':''}>${_esc(d.name)}</option>`).join('');

  _togglePgFields();
  document.getElementById('dept-overlay').classList.add('open');
};
window.closeDeptDrawer = function() {
  document.getElementById('dept-overlay').classList.remove('open');
};

window._togglePgFields = function() {
  const show = document.getElementById('dept-is-pg').checked;
  document.getElementById('pg-fields').classList.toggle('show', show);
  _updateBedsRequired();
};

window._updateBedsRequired = function() {
  const seats = parseInt(document.getElementById('dept-pg-seats').value) || 0;
  const note  = document.getElementById('beds-required-note');
  if (seats > 0) {
    note.textContent = `NCISM requires ${seats * 4} beds (4 per PG seat) with ≥80% occupancy for PG departments.`;
    note.classList.add('show');
  } else {
    note.classList.remove('show');
  }
};

window.saveDept = async function() {
  const id       = document.getElementById('dept-id').value;
  const name     = document.getElementById('dept-name').value.trim();
  const ncism    = document.getElementById('dept-ncism').value;
  const opdId    = document.getElementById('dept-opd').value;
  const isPg     = document.getElementById('dept-is-pg').checked;
  const pgSeats  = parseInt(document.getElementById('dept-pg-seats').value) || 0;
  const mandatory= document.getElementById('dept-mandatory').checked;
  const isActive = document.getElementById('dept-active').checked;

  if (!name) { _alert('error', 'Department name is required.'); return; }
  if (isPg && pgSeats < 1) { _alert('error', 'Enter PG seats sanctioned.'); return; }

  const btn = document.getElementById('btn-save-dept');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const parentId = document.getElementById('dept-parent').value || null;
  const payload = {
    tenant_id:             tenantId,
    name,
    ncism_code:            ncism || null,
    opd_id:                opdId || null,
    parent_department_id:  parentId,
    is_pg_dept:            isPg,
    pg_seats_sanctioned:   isPg ? pgSeats : 0,
    is_mandatory:          mandatory,
    is_active:             isActive,
  };

  if (!id && _isGatedForApproval()) {
    const { tenant_id, ...requestPayload } = payload; // tenant is derived server-side, not trusted from the client
    const { error } = await supabase.rpc('request_approval', {
      p_action_type: 'department_create', p_payload: requestPayload, p_reason: `Create department "${name}"`,
    });
    btn.disabled = false; btn.textContent = 'Save Department';
    if (error) { _alert('error', safeErrorMessage(error, 'Could not submit request.')); return; }
    closeDeptDrawer();
    _alert('success', 'Submitted for approval — a Super Admin will review this.');
    return;
  }

  let error;
  if (id) {
    ({ error } = await supabase.from('departments').update(payload).eq('id', id));
  } else {
    ({ error } = await supabase.from('departments').insert(payload));
  }

  btn.disabled = false;
  btn.textContent = 'Save Department';

  if (error) { _alert('error', safeErrorMessage(error, 'Save failed. Please try again.')); return; }
  closeDeptDrawer();
  _alert('success', id ? 'Department updated.' : 'Department created.');
  await loadAll();
};

window.deleteDept = async function(id) {
  // Deliberately no approval-request path for department deletion (too
  // destructive to queue) -- a gated designation simply can't do this at
  // all, same as e.g. "Promote to Admin" being super_admin-only with no
  // request alternative. Ask a non-gated dept_admin/super_admin instead.
  if (_isGatedForApproval()) {
    _alert('error', 'Deleting a department isn\'t available to your role — please ask a Super Admin.');
    return;
  }
  const dept = _depts.find(d => d.id === id);
  const bedCount = _beds.filter(b => b.department_id === id).length;
  let msg = `Delete department "${dept?.name}"?`;
  if (bedCount) msg += ` This will also remove its ${bedCount} bed(s).`;
  if (!confirm(msg)) return;

  const { error } = await supabase.from('departments').delete().eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Delete failed. Please try again.')); return; }
  _alert('success', 'Department deleted.');
  await loadAll();
};

// ── NCISM compliance panel for department selects ─────────────────────────────
window.updateDeptInfo = function(prefix) {
  const deptId = document.getElementById(`${prefix}-dept`).value;
  const panel  = document.getElementById(`${prefix}-dept-info`);

  if (!deptId) { panel.innerHTML = ''; panel.style.display = 'none'; return; }

  const dept          = _depts.find(d => d.id === deptId);
  const deptBeds      = _beds.filter(b => b.department_id === deptId);
  const ratio         = UG_BED_RATIOS[dept?.ncism_code] || 0;
  const exactRequired = ratio > 0 && _ugIntake > 0 ? _ugIntake * ratio : 0;
  const required      = Math.floor(exactRequired);
  const isRounded     = exactRequired > 0 && exactRequired !== required;
  const gap           = required > 0 ? Math.max(0, required - deptBeds.length) : 0;

  const complianceHtml = required > 0 ? `
    <div class="dept-info-compliance">
      <span>NCISM Required: <strong>${required}${isRounded ? '*' : ''}</strong></span>
      <span>Current: <strong>${deptBeds.length}</strong></span>
      ${gap > 0
        ? `<span class="ncism-gap-warn">⚠ Need ${gap} more</span>`
        : `<span class="ncism-gap-ok">✓ Beds met</span>`}
    </div>
    ${isRounded ? `<div class="rounding-note">* ${_ugIntake} × ${ratio * 100}% = ${exactRequired} beds — rounded down to ${required}. Collectively all departments meet the NCISM Table-8 minimum of ${_ugIntake} beds.</div>` : ''}` : '';

  const bedListHtml = deptBeds.length > 0
    ? `<div class="dept-info-beds">
        <div class="dept-info-beds-label">Beds in this department <span style="font-size:10px;color:var(--text-muted);font-weight:400">(click to edit)</span></div>
        <div class="dept-bed-list">${deptBeds.map(_bedTagHtml).join('')}</div>
       </div>`
    : `<div style="font-size:12px;color:var(--text-muted)">No beds in this department yet.</div>`;

  panel.innerHTML = complianceHtml + bedListHtml;
  panel.style.display = 'block';

  // ── Auto-fill form fields based on selected department ──
  const autoPrefix = DEPT_PREFIX[dept?.ncism_code] || '';
  const nextStart  = _nextBedStart(deptBeds, autoPrefix, dept?.ncism_code);

  if (prefix === 'bulk') {
    document.getElementById('bulk-prefix').value = autoPrefix;
    document.getElementById('bulk-count').value  = String(Math.max(1, required > 0 ? Math.max(0, required - deptBeds.length) : 1));
    document.getElementById('bulk-start').value  = String(nextStart);
    renderBulkSelectGrid(dept, deptBeds, autoPrefix, required);
  }

  if (prefix === 'bed') {
    const isEdit = !!document.getElementById('bed-id').value;
    if (isEdit) {
      document.getElementById('bed-select-field').style.display  = 'none';
      document.getElementById('bed-select-prompt').style.display = 'none';
    } else {
      renderBedSelectGrid(dept, deptBeds, autoPrefix, required);
    }
  }
};

// ── Bed drawer ────────────────────────────────────────────────────────────────
window.openBedDrawer = function(id, preDeptId) {
  const bed = id ? _beds.find(b => b.id === id) : null;
  document.getElementById('bed-drawer-title').textContent = bed ? 'Edit Bed' : 'New Bed';
  document.getElementById('bed-id').value     = bed ? bed.id : '';
  document.getElementById('bed-num').value    = bed ? bed.bed_number : '';
  document.getElementById('bed-floor').value  = bed?.floor_number ?? '';
  document.getElementById('bed-ward').value   = bed?.ward_name || '';
  document.getElementById('bed-dept').value   = bed?.department_id || preDeptId || '';
  document.getElementById('bed-type').value   = bed?.bed_type || 'male_general';
  document.getElementById('bed-status').value = bed?.status || 'vacant';
  document.getElementById('bed-pg').checked   = bed?.is_pg_allocated || false;
  // Reset chip grid for new beds; hide for edits
  document.getElementById('bed-select-field').style.display  = 'none';
  document.getElementById('bed-select-prompt').style.display = bed ? 'none' : '';
  document.getElementById('bed-select-grid').innerHTML = '';
  document.getElementById('bed-sel-badge').textContent = '';

  // Lock bed number for NCISM reserved range beds; keep editable for extras
  const numEl  = document.getElementById('bed-num');
  const noteEl = document.getElementById('bed-num-note');
  if (bed) {
    const dept          = _depts.find(d => d.id === bed.department_id);
    const ncismCode     = dept?.ncism_code;
    const reservedStart = _deptReservedStart(ncismCode);
    const required      = Math.floor((UG_BED_RATIOS[ncismCode] || 0) * _ugIntake);
    const bedN          = parseInt(bed.bed_number.split('-').pop());
    const isReserved    = required > 0 && !isNaN(bedN) &&
                          bedN >= reservedStart && bedN < reservedStart + required;
    numEl.readOnly          = isReserved;
    numEl.style.background  = isReserved ? '#f5f5f5' : '';
    numEl.style.color       = isReserved ? 'var(--text-mid)' : '';
    noteEl.style.display    = '';
    noteEl.innerHTML        = isReserved
      ? '🔒 NCISM reserved bed — number cannot be changed'
      : '✏️ Extra bed — you can renumber if needed';
  } else {
    numEl.readOnly         = false;
    numEl.style.background = '';
    numEl.style.color      = '';
    noteEl.style.display   = 'none';
    noteEl.textContent     = '';
  }

  updateDeptInfo('bed');
  document.getElementById('btn-delete-bed').style.display = bed ? '' : 'none';
  document.getElementById('bed-overlay').classList.add('open');
};
window.closeBedDrawer = function() {
  document.getElementById('bed-overlay').classList.remove('open');
};

function renderBedSelectGrid(dept, deptBeds, prefix, required) {
  const grid   = document.getElementById('bed-select-grid');
  const field  = document.getElementById('bed-select-field');
  const prompt = document.getElementById('bed-select-prompt');
  const badge  = document.getElementById('bed-sel-badge');

  if (!dept || !prefix) {
    field.style.display  = 'none';
    prompt.style.display = '';
    return;
  }
  field.style.display  = '';
  prompt.style.display = 'none';

  const existingNums = new Set(
    deptBeds.filter(b => b.bed_number.startsWith(prefix + '-'))
            .map(b => parseInt(b.bed_number.split('-').pop()))
            .filter(n => !isNaN(n))
  );

  const reservedStart = _deptReservedStart(dept.ncism_code);
  const totalNcism    = Object.values(UG_BED_RATIOS).reduce((s, r) => s + Math.floor(_ugIntake * r), 0);

  // NCISM depts: reserved range + a few extra slots
  // Non-NCISM depts: start from global extra pool (totalNcism+1); show existing + 5 available slots
  const extraUsed       = [...existingNums].filter(n => n > totalNcism).length;
  const existingInRange = [...existingNums].filter(n => n >= reservedStart).length;
  const showCount = required > 0
    ? required + Math.min(3, extraUsed + 3)
    : existingInRange + 5;

  const chips = [];
  for (let i = 0; i < showCount; i++) {
    const num    = reservedStart + i;  // correct for both NCISM and non-NCISM depts
    const label  = `${prefix}-${String(num).padStart(2, '0')}`;
    const exists = existingNums.has(num);
    chips.push({ num, label, exists });
  }

  grid.innerHTML = chips.map(c =>
    `<span class="bsel-chip${c.exists ? ' exists' : ''}" data-label="${c.label}"
      data-onclick="selectBedChip" data-onclick-a0="@this">
      ${c.label}
      <span class="bsel-sub">${c.exists ? '✓ added' : ''}</span>
    </span>`
  ).join('');

  badge.textContent = '';
}

window.selectBedChip = function(el) {
  if (el.classList.contains('exists')) return;
  const wasSelected = el.classList.contains('selected');
  // Single-select: deselect all
  document.querySelectorAll('#bed-select-grid .bsel-chip.selected').forEach(c => {
    c.classList.remove('selected');
    c.querySelector('.bsel-sub').textContent = '';
  });
  if (!wasSelected) {
    el.classList.add('selected');
    el.querySelector('.bsel-sub').textContent = '✓';
    document.getElementById('bed-num').value = el.dataset.label;
    document.getElementById('bed-sel-badge').textContent = el.dataset.label + ' selected';
  } else {
    document.getElementById('bed-num').value = '';
    document.getElementById('bed-sel-badge').textContent = '';
  }
};

window.clearBedChipSelection = function() {
  document.querySelectorAll('#bed-select-grid .bsel-chip.selected').forEach(c => {
    c.classList.remove('selected');
    c.querySelector('.bsel-sub').textContent = '';
  });
  document.getElementById('bed-sel-badge').textContent = '';
};

window.saveBed = async function() {
  const id      = document.getElementById('bed-id').value;
  const num     = document.getElementById('bed-num').value.trim().toUpperCase();
  const floor   = document.getElementById('bed-floor').value;
  const ward    = document.getElementById('bed-ward').value.trim();
  const deptId  = document.getElementById('bed-dept').value;
  const type    = document.getElementById('bed-type').value;
  const status  = document.getElementById('bed-status').value;
  const isPg    = document.getElementById('bed-pg').checked;

  if (!num)    { _alert('error', 'Bed number is required.'); return; }
  if (!deptId) { _alert('error', 'Department is required.'); return; }

  const btn = document.getElementById('btn-save-bed');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const payload = {
    tenant_id:       tenantId,
    department_id:   deptId,
    bed_number:      document.getElementById('bed-num').readOnly ? undefined : num,
    floor_number:    floor !== '' ? parseInt(floor) : null,
    ward_name:       ward || null,
    bed_type:        type,
    status,
    is_pg_allocated: isPg,
  };

  let error;
  if (id) {
    // Editing an existing bed leaves unit_number/unit_name untouched -- recomputing here
    // risks colliding with the bed's own prior room/ward if type/ward_name didn't
    // actually change. If they DID change, that's a manual admin correction for now,
    // same as how "extra" bed numbers already work.
    ({ error } = await supabase.from('beds').update(payload).eq('id', id));
  } else {
    _assignUnitNumbers([payload]);
    ({ error } = await supabase.from('beds').insert(payload));
  }

  btn.disabled = false;
  btn.textContent = 'Save Bed';

  if (error) {
    const msg = error.code === '23505'
      ? `Bed number "${num}" already exists in this facility.`
      : safeErrorMessage(error, 'Save failed. Please try again.');
    _alert('error', msg);
    return;
  }
  closeBedDrawer();
  _alert('success', id ? 'Bed updated.' : 'Bed added.');
  await loadAll();
  _refreshOpenDrawerDeptInfo();
};

window.deleteBed = async function() {
  const id  = document.getElementById('bed-id').value;
  if (!id) return;
  const bed = _beds.find(b => b.id === id);
  if (bed?.status === 'occupied') {
    _alert('error', 'Cannot delete an occupied bed. Set status to Vacant first.');
    return;
  }
  if (!confirm(`Delete bed "${bed?.bed_number}"? This cannot be undone.`)) return;
  const { error } = await supabase.from('beds').delete().eq('id', id).eq('tenant_id', tenantId);
  if (error) { _alert('error', safeErrorMessage(error, 'Delete failed. Please try again.')); return; }
  closeBedDrawer();
  _alert('success', `Bed "${bed?.bed_number}" deleted.`);
  await loadAll();
  _refreshOpenDrawerDeptInfo();
};

window.deleteAllDeptBeds = async function(deptId) {
  const dept      = _depts.find(d => d.id === deptId);
  const deptBeds  = _beds.filter(b => b.department_id === deptId);
  const occupied  = deptBeds.filter(b => b.status === 'occupied');
  const deletable = deptBeds.filter(b => b.status !== 'occupied');

  if (!deletable.length) {
    _alert('error', occupied.length
      ? 'All beds are occupied — discharge patients before deleting.'
      : 'No beds in this department.');
    return;
  }

  let msg = `Remove all ${deletable.length} bed(s) from "${dept?.name}"?\n\nThe department itself is kept — only its bed records are removed. This cannot be undone.`;
  if (occupied.length) msg += `\n\n${occupied.length} occupied bed(s) will NOT be deleted.`;
  if (!confirm(msg)) return;

  const { error } = await supabase
    .from('beds')
    .delete()
    .eq('department_id', deptId)
    .eq('tenant_id', tenantId)
    .neq('status', 'occupied');

  if (error) { _alert('error', safeErrorMessage(error, 'Delete failed. Please try again.')); return; }
  _alert('success', `${deletable.length} bed(s) removed from "${dept?.name}".`);
  await loadAll();
};

// ── Bed Map PDF ────────────────────────────────────────────────────────────────
window.downloadBedMapPDF = function() {
  if (!_beds.length) { _alert('error', 'No beds configured yet. Add beds first.'); return; }

  const BED_LABELS = {
    male_general:'Male General Ward', female_general:'Female General Ward',
    general:'General Ward (Mixed)', twin_sharing:'Twin Sharing',
    semi_private:'Shared Private', private:'Private Room',
    deluxe:'Deluxe Private', dormitory:'Dormitory',
    icu:'ICU', day_care:'Day Care', pk_treatment:'PK Treatment Room',
    observation:'Observation'
  };
  const typeLabel = k => BED_LABELS[k] || k.replace(/_/g,' ');
  const flLabel   = fl => fl === 0 ? 'Ground Floor (GF)' : `Floor ${fl}`;
  const flShort   = fl => fl === 0 ? 'GF' : `Fl.${fl}`;

  const _tenantCache = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
  const orgName = document.querySelector('.ax-name')?.textContent?.trim() || _tenantCache.name || 'Hospital';
  const now     = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });

  const sortBeds = arr => [...arr].sort((a,b) =>
    a.bed_number.localeCompare(b.bed_number, undefined, {numeric:true, sensitivity:'base'}));

  const allFloors  = [...new Set(_beds.map(b => b.floor_number ?? 0))].sort((a,b) => a-b);
  const deptsWithBeds = _depts.filter(d => _beds.some(b => b.department_id === d.id));

  // ── Helper: chip list ──────────────────────────────────────────
  const chips = beds => sortBeds(beds).map(b => {
    const dot = b.status === 'occupied' ? ' 🔴' : b.status === 'maintenance' ? ' 🟡' : '';
    return `<span class="chip">${b.bed_number}${dot}</span>`;
  }).join('');

  // ── Section 1: Department-wise ─────────────────────────────────
  const sec1 = deptsWithBeds.map(d => {
    const dBeds  = _beds.filter(b => b.department_id === d.id);
    const floors = [...new Set(dBeds.map(b => b.floor_number ?? 0))].sort((a,b) => a-b);

    const floorBlocks = floors.map(fl => {
      const flBeds = dBeds.filter(b => (b.floor_number ?? 0) === fl);
      const wards  = [...new Set(flBeds.map(b => b.ward_name || '(No ward name)'))].sort();

      const wardRows = wards.map(w => {
        const wBeds = flBeds.filter(b => (b.ward_name || '(No ward name)') === w);
        const types = [...new Set(wBeds.map(b => b.bed_type))].sort();
        const typeRows = types.map(t => {
          const tBeds = wBeds.filter(b => b.bed_type === t);
          // Room-based types: group the chips by which room they share (a single type row
          // can span several rooms). Open-ward types: all beds here already share one
          // ward_name/unit_number by construction, so just label the type once instead.
          let typeCell = typeLabel(t);
          let chipsCell;
          if (ROOM_CAPACITY[t]) {
            const byUnit = {};
            tBeds.forEach(b => { (byUnit[b.unit_number ?? '—'] ||= []).push(b); });
            chipsCell = Object.entries(byUnit)
              .sort(([a],[b]) => (Number(a)||0) - (Number(b)||0))
              .map(([num, bs]) => `<strong>R${num}:</strong> ${chips(bs)}`)
              .join('&nbsp;&nbsp;');
          } else {
            const unitLbl = tBeds[0] ? _unitLabel(tBeds[0]) : '';
            if (unitLbl) typeCell += ` <span class="muted">(${unitLbl})</span>`;
            chipsCell = chips(tBeds);
          }
          return `<tr>
            <td class="indent2">${typeCell}</td>
            <td>${chipsCell}</td>
            <td class="ctr">${tBeds.length}</td>
          </tr>`;
        }).join('');
        return `<tr class="ward-row">
          <td class="indent1">📋 ${w}</td>
          <td></td>
          <td class="ctr bold">${wBeds.length}</td>
        </tr>${typeRows}`;
      }).join('');

      return `<tr class="floor-row">
        <td class="indent0">🏢 ${flLabel(fl)}</td>
        <td></td>
        <td class="ctr bold">${flBeds.length}</td>
      </tr>${wardRows}`;
    }).join('');

    return `<h2>${d.name}${d.ncism_code ? ` <span class="muted">(${d.ncism_code})</span>` : ''} <span class="badge">${dBeds.length} beds</span></h2>
    <table>
      <thead><tr><th style="width:200px">Floor → Ward → Type</th><th>Bed Numbers</th><th class="ctr" style="width:55px">Count</th></tr></thead>
      <tbody>${floorBlocks}</tbody>
    </table>`;
  }).join('');

  // ── Section 2: Floor-wise ──────────────────────────────────────
  const sec2 = allFloors.map(fl => {
    const flBeds = _beds.filter(b => (b.floor_number ?? 0) === fl);
    const deptIds = [...new Set(flBeds.map(b => b.department_id))]
      .sort((x, y) => _depts.findIndex(d => d.id === x) - _depts.findIndex(d => d.id === y));

    const rows = deptIds.map(dId => {
      const dept  = _depts.find(d => d.id === dId);
      const dBeds = flBeds.filter(b => b.department_id === dId);
      const wards = [...new Set(dBeds.map(b => b.ward_name).filter(Boolean))].join(', ') || '—';
      return `<tr>
        <td>${dept?.name || '—'}</td>
        <td>${wards}</td>
        <td>${chips(dBeds)}</td>
        <td class="ctr">${dBeds.length}</td>
      </tr>`;
    }).join('');

    return `<h3>🏢 ${flLabel(fl)} — <span class="muted">${flBeds.length} beds</span></h3>
    <table>
      <thead><tr><th style="width:180px">Department</th><th style="width:140px">Ward / Room</th><th>Bed Numbers</th><th class="ctr" style="width:55px">Count</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).join('');

  // ── Section 3: Complete bed index ─────────────────────────────
  const idxRows = sortBeds(_beds).map((b, i) => {
    const dept   = _depts.find(d => d.id === b.department_id);
    const sIcon  = b.status === 'occupied' ? '🔴' : b.status === 'maintenance' ? '🟡' : b.status === 'reserved' ? '🟠' : '🟢';
    return `<tr class="${i%2===0?'':'alt'}">
      <td class="bold">${b.bed_number}</td>
      <td>${dept?.name || '—'}</td>
      <td>${typeLabel(b.bed_type)}</td>
      <td>${flShort(b.floor_number ?? 0)}</td>
      <td>${b.ward_name || '—'}</td>
      <td>${_unitLabel(b) || '—'}</td>
      <td class="ctr">${sIcon} ${b.status}</td>
    </tr>`;
  }).join('');

  // ── Summary stats ──────────────────────────────────────────────
  const vacant      = _beds.filter(b => b.status === 'vacant').length;
  const occupied    = _beds.filter(b => b.status === 'occupied').length;
  const maintenance = _beds.filter(b => b.status === 'maintenance').length;
  const occupancyPct = _beds.length ? Math.round(occupied / _beds.length * 100) : 0;

  // ── Building × Floor breakdown for PDF cover ──────────────────────────────
  const pdfBldg = {};
  _beds.forEach(b => {
    const bldg = b.ward_name || '(No building assigned)';
    const fl   = b.floor_number ?? 0;
    if (!pdfBldg[bldg]) pdfBldg[bldg] = {};
    if (!pdfBldg[bldg][fl]) pdfBldg[bldg][fl] = { count: 0, depts: new Set() };
    pdfBldg[bldg][fl].count++;
    const pd = _depts.find(dd => dd.id === b.department_id);
    if (pd) pdfBldg[bldg][fl].depts.add(pd.name);
  });
  const pdfBldgRows = Object.entries(pdfBldg)
    .sort(([a],[b]) => a.localeCompare(b))
    .flatMap(([bldg, floors]) =>
      Object.entries(floors).sort(([a],[b]) => parseInt(a)-parseInt(b)).map(([fl,{count,depts}]) =>
        '<tr><td>' + bldg + '</td>' +
        '<td>' + (parseInt(fl)===0 ? 'Ground Floor' : 'Floor '+fl) + '</td>' +
        '<td style="text-align:center;font-weight:700">' + count + '</td>' +
        '<td style="font-size:7.5pt">' + [...depts].sort().join(', ') + '</td></tr>'
      )
    ).join('');
  const pdfBldgTable =
    '<div style="margin:12px 0 10px;text-align:left;display:inline-block;min-width:460px">' +
    '<div style="font-size:9pt;font-weight:700;color:#1a4a2e;margin-bottom:5px;' +
    'border-bottom:1.5px solid #1a4a2e;padding-bottom:4px">Building &amp; Floor Allocation' +
    '</div><table style="width:100%;border-collapse:collapse;font-size:8.5pt">' +
    '<thead><tr>' +
    '<th style="background:#1a4a2e;color:#fff;padding:4px 10px;width:150px">Building</th>' +
    '<th style="background:#1a4a2e;color:#fff;padding:4px 10px;width:110px">Floor</th>' +
    '<th style="background:#1a4a2e;color:#fff;padding:4px 10px;width:50px;text-align:center">Beds</th>' +
    '<th style="background:#1a4a2e;color:#fff;padding:4px 10px">Departments</th>' +
    '</tr></thead><tbody>' + pdfBldgRows + '</tbody></table></div>';

  // ── Assemble ───────────────────────────────────────────────────
  // _x: safe close-tag builder — \x3C = < avoids literal </ in <script> source
  const _x = (t) => '\x3C/' + t + '>';
  const html = [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charset="UTF-8">',
    '<title>Bed Map — ' + orgName + _x('title'),
    '<style>',
    '  @page{size:A4;margin:14mm 12mm 12mm}',
    '  *{box-sizing:border-box;margin:0;padding:0}',
    '  body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#1a2e22}',
    '  .cover{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:260px;padding:20mm 0 16mm;text-align:center}',
    '  .cover h1{font-size:20pt;color:#1a4a2e;margin-bottom:6px}',
    '  .cover .org{font-size:14pt;color:#2d7a4f;margin-bottom:18px;font-weight:600}',
    '  .stats-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:14px}',
    '  .stat{border:1.5px solid #2d7a4f;border-radius:8px;padding:8px 18px;min-width:80px}',
    '  .stat .n{font-size:20pt;font-weight:700;color:#1a4a2e;line-height:1.1}',
    '  .stat .l{font-size:7.5pt;color:#6b7280;margin-top:2px}',
    '  .gen-meta{font-size:8.5pt;color:#6b7280;margin-bottom:14px}',
    '  .legend{font-size:8pt;color:#374151;border:1px solid #e5e7eb;border-radius:6px;padding:5px 12px;display:inline-block}',
    '  .pg-break{page-break-before:always;padding-top:4mm}',
    '  .sec-title{font-size:13pt;font-weight:700;color:#1a4a2e;border-bottom:2px solid #1a4a2e;padding-bottom:5px;margin-bottom:4px}',
    '  .sec-sub{font-size:8.5pt;color:#6b7280;margin-bottom:14px}',
    '  h2{font-size:10.5pt;color:#1a4a2e;border-left:4px solid #c9902a;padding-left:8px;margin:14px 0 4px}',
    '  h3{font-size:9.5pt;color:#2d7a4f;margin:10px 0 3px}',
    '  table{width:100%;border-collapse:collapse;margin-bottom:6px;font-size:9pt}',
    '  th{background:#1a4a2e;color:#fff;padding:5px 8px;text-align:left;font-size:8.5pt}',
    '  td{border:1px solid #e2e8f0;padding:3px 8px;vertical-align:top}',
    '  .alt td{background:#f9fafb}',
    '  .floor-row td{background:#d4edde;font-weight:700;font-size:9pt}',
    '  .ward-row td{background:#f0faf5;font-weight:600;font-size:8.5pt}',
    '  .indent0{padding-left:8px !important}',
    '  .indent1{padding-left:22px !important}',
    '  .indent2{padding-left:38px !important;color:#4b5563;font-size:8.5pt}',
    '  .ctr{text-align:center}.bold{font-weight:700}',
    '  .muted{font-size:8pt;color:#6b7280;font-weight:400}',
    '  .badge{font-size:8pt;font-weight:600;background:#e8f5ee;color:#1a4a2e;border-radius:20px;padding:1px 8px;vertical-align:middle}',
    '  .chip{display:inline-block;border:1px solid #2d7a4f;border-radius:3px;padding:1px 5px;margin:1px;font-size:7.5pt;color:#1a4a2e;font-weight:600}',
    '  .toc{border:1px solid #e5e7eb;border-radius:8px;padding:10px 18px;display:inline-block;text-align:left;min-width:280px;margin-top:10px}',
    '  .toc-title{font-size:9pt;font-weight:700;color:#1a4a2e;margin-bottom:6px}',
    '  .toc div{font-size:8.5pt;color:#374151;padding:2px 0}',
    '  .toc .pg{float:right;color:#9ca3af}',
    '  @media print{a{text-decoration:none;color:inherit}}',
    _x('style'),
    _x('head'),
    '<body>',
    '<div class="cover">',
    '  <h1>🏥 IPD Bed Map' + _x('h1'),
    '  <div class="org">' + orgName + _x('div'),
    '  <div class="stats-row">',
    '    <div class="stat"><div class="n">' + _beds.length + _x('div') + '<div class="l">Total Beds' + _x('div') + _x('div'),
    '    <div class="stat"><div class="n">' + deptsWithBeds.length + _x('div') + '<div class="l">Departments' + _x('div') + _x('div'),
    '    <div class="stat"><div class="n">' + allFloors.length + _x('div') + '<div class="l">Floor(s)' + _x('div') + _x('div'),
    '    <div class="stat"><div class="n">' + vacant + _x('div') + '<div class="l">Vacant 🟢' + _x('div') + _x('div'),
    '    <div class="stat"><div class="n">' + occupied + _x('div') + '<div class="l">Occupied 🔴' + _x('div') + _x('div'),
    '    <div class="stat"><div class="n">' + occupancyPct + '%' + _x('div') + '<div class="l">Occupancy' + _x('div') + _x('div'),
    '  ' + _x('div'),
    '  <div class="gen-meta">Generated: ' + now + _x('div'),
    pdfBldgTable,
    '  <div class="legend">🟢 Vacant &nbsp;&nbsp; 🔴 Occupied &nbsp;&nbsp; 🟡 Maintenance &nbsp;&nbsp; 🟠 Reserved' + _x('div'),
    '  <div class="toc"><div class="toc-title">Contents' + _x('div'),
    '    <div>Section 1 — Department-wise Bed Allocation<span class="pg">pg 2' + _x('span') + _x('div'),
    '    <div>Section 2 — Floor-wise Bed Index<span class="pg">pg ' + (deptsWithBeds.length > 4 ? '3+' : '3') + _x('span') + _x('div'),
    '    <div>Section 3 — Complete Bed Number Index<span class="pg">last' + _x('span') + _x('div'),
    '  ' + _x('div'),
    _x('div'),
    '<div class="pg-break">',
    '  <div class="sec-title">Section 1 — Department-wise Bed Allocation' + _x('div'),
    '  <div class="sec-sub">Organised by department → floor → ward/room → bed type.' + _x('div'),
    sec1,
    _x('div'),
    '<div class="pg-break">',
    '  <div class="sec-title">Section 2 — Floor-wise Bed Index' + _x('div'),
    '  <div class="sec-sub">Organised by floor → department. Use this to locate all beds on a specific floor.' + _x('div'),
    sec2,
    _x('div'),
    '<div class="pg-break">',
    '  <div class="sec-title">Section 3 — Complete Bed Number Index' + _x('div'),
    '  <div class="sec-sub">All ' + _beds.length + ' beds sorted by bed number. Full location reference.' + _x('div'),
    '<table><thead><tr>',
    '<th style="width:75px">Bed No.' + _x('th'),
    '<th style="width:175px">Department' + _x('th'),
    '<th style="width:130px">Bed Type' + _x('th'),
    '<th style="width:55px">Floor' + _x('th'),
    '<th style="width:110px">Ward / Room Name' + _x('th'),
    '<th style="width:110px">Room / Ward #' + _x('th'),
    '<th style="width:90px;text-align:center">Status' + _x('th'),
    _x('tr') + _x('thead'),
    '<tbody>' + idxRows + _x('tbody'),
    _x('table') + _x('div'),
    _x('body') + _x('html')
  ].join('\n');

  const w = window.open('', '_blank');
  if (!w) { _alert('error', 'Pop-up blocked. Please allow pop-ups for this site and try again.'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => { try { w.print(); } catch(e) {} }, 350);
};

// ── Bulk add ──────────────────────────────────────────────────────────────────
window.openBulkDrawer = function() {
  document.getElementById('bulk-dept').value  = '';
  document.getElementById('bulk-floor').value = '';
  document.getElementById('bulk-ward').value  = '';
  document.getElementById('bulk-type').value  = 'male_general';
  document.getElementById('bulk-pg').checked  = false;
  const panel = document.getElementById('bulk-dept-info');
  panel.innerHTML = ''; panel.style.display = 'none';
  document.getElementById('bulk-select-field').style.display = 'none';
  document.getElementById('bulk-select-prompt').style.display = '';
  document.getElementById('bulk-select-grid').innerHTML = '';
  document.getElementById('bulk-sel-badge').textContent = '';
  document.getElementById('bulk-overlay').classList.add('open');
};
window.closeBulkDrawer = function() {
  document.getElementById('bulk-overlay').classList.remove('open');
};

/* Render the selectable bed grid for bulk add */
function renderBulkSelectGrid(dept, deptBeds, prefix, required) {
  const grid    = document.getElementById('bulk-select-grid');
  const field   = document.getElementById('bulk-select-field');
  const prompt  = document.getElementById('bulk-select-prompt');
  const badge   = document.getElementById('bulk-sel-badge');
  const extraRow = document.getElementById('bulk-extra-row');

  if (!dept || !prefix) {
    field.style.display  = 'none';
    prompt.style.display = '';
    return;
  }
  field.style.display  = '';
  prompt.style.display = 'none';

  const existingNums = new Set(
    deptBeds.filter(b => b.bed_number.startsWith(prefix + '-'))
            .map(b => parseInt(b.bed_number.split('-').pop()))
            .filter(n => !isNaN(n))
  );

  const reservedStart = _deptReservedStart(dept.ncism_code);
  const totalNcism    = Object.values(UG_BED_RATIOS).reduce((s, r) => s + Math.floor(_ugIntake * r), 0);

  // Non-NCISM depts (required=0): show existing beds + 5 available slots from global extra pool
  const existingInRange = [...existingNums].filter(n => n >= reservedStart).length;
  const chipCount = required > 0 ? required : existingInRange + 5;

  const chips = [];
  for (let i = 0; i < chipCount; i++) {
    const num    = reservedStart + i;
    const label  = `${prefix}-${String(num).padStart(2, '0')}`;
    const exists = existingNums.has(num);
    chips.push({ num, label, exists });
  }

  grid.innerHTML = chips.map(c =>
    `<span class="bsel-chip${c.exists ? ' exists' : ''}" data-num="${c.num}" data-label="${c.label}"
      data-onclick="toggleBselChip" data-onclick-a0="@this">
      ${c.label}
      <span class="bsel-sub">${c.exists ? '✓ added' : ''}</span>
    </span>`
  ).join('');

  // Extra beds row
  const quotaMet = deptBeds.length >= required && required > 0;
  const extraStart = totalNcism + 1 +
    deptBeds.filter(b => {
      const n = parseInt(b.bed_number.split('-').pop());
      return !isNaN(n) && n > totalNcism;
    }).length;

  if (required > 0) {
    extraRow.style.display = '';
    document.getElementById('bulk-extra-next').textContent = `${prefix}-${String(extraStart).padStart(2, '0')}`;
    document.getElementById('bulk-extra-count').value = '0';
    document.getElementById('bulk-extra-count').dataset.extraStart = String(extraStart);
    document.getElementById('bulk-extra-count').dataset.prefix = prefix;
  } else {
    extraRow.style.display = 'none';
  }

  _updateBulkBadge();
}

function toggleBselChip(el) {
  if (el.classList.contains('exists')) return;
  el.classList.toggle('selected');
  el.querySelector('.bsel-sub').textContent = el.classList.contains('selected') ? '✓' : '';
  _updateBulkBadge();
}
window.toggleBselChip = toggleBselChip;

function _updateBulkBadge() {
  const selected = document.querySelectorAll('.bsel-chip.selected').length;
  const extra    = parseInt(document.getElementById('bulk-extra-count')?.value || 0) || 0;
  const total    = selected + extra;
  const badge    = document.getElementById('bulk-sel-badge');
  badge.textContent = total > 0 ? `${total} selected` : '';
}
window._updateBulkBadge = _updateBulkBadge;

document.addEventListener('input', e => {
  if (e.target.id === 'bulk-extra-count') _updateBulkBadge();
});

window.bulkSelAll = function() {
  document.querySelectorAll('.bsel-chip:not(.exists)').forEach(c => {
    c.classList.add('selected');
    c.querySelector('.bsel-sub').textContent = '✓';
  });
  _updateBulkBadge();
};
window.bulkSelNone = function() {
  document.querySelectorAll('.bsel-chip.selected').forEach(c => {
    c.classList.remove('selected');
    c.querySelector('.bsel-sub').textContent = '';
  });
  _updateBulkBadge();
};

window.bulkAddBeds = async function() {
  const deptId = document.getElementById('bulk-dept').value;
  const prefix = document.getElementById('bulk-prefix').value.toUpperCase();
  const floor  = document.getElementById('bulk-floor').value;
  const ward   = document.getElementById('bulk-ward').value.trim();
  const type   = document.getElementById('bulk-type').value;
  const isPg   = document.getElementById('bulk-pg').checked;

  if (!deptId) { _alert('error', 'Select a department.'); return; }

  const selectedChips = [...document.querySelectorAll('.bsel-chip.selected:not(.exists)')];
  const extraEl       = document.getElementById('bulk-extra-count');
  const extraCount    = parseInt(extraEl?.value || 0) || 0;
  const extraStart    = parseInt(extraEl?.dataset.extraStart || 0);
  const extraPrefix   = extraEl?.dataset.prefix || prefix;

  if (!selectedChips.length && extraCount < 1) {
    _alert('error', 'Select at least one bed to add.');
    return;
  }

  const rows = [];
  const floorVal = floor !== '' ? parseInt(floor) : null;

  selectedChips.forEach(chip => {
    rows.push({
      tenant_id:       tenantId,
      department_id:   deptId,
      bed_number:      chip.dataset.label,
      floor_number:    floorVal,
      ward_name:       ward || null,
      bed_type:        type,
      status:          'vacant',
      is_pg_allocated: isPg,
    });
  });

  for (let i = 0; i < extraCount; i++) {
    const num = extraStart + i;
    rows.push({
      tenant_id:       tenantId,
      department_id:   deptId,
      bed_number:      `${extraPrefix}-${String(num).padStart(2, '0')}`,
      floor_number:    floorVal,
      ward_name:       ward || null,
      bed_type:        type,
      status:          'vacant',
      is_pg_allocated: isPg,
    });
  }

  const btn = document.getElementById('btn-bulk-save');
  btn.disabled = true;
  btn.textContent = `Adding ${rows.length} beds…`;

  _assignUnitNumbers(rows);
  const { error } = await supabase.from('beds').insert(rows);
  btn.disabled = false;
  btn.textContent = 'Add Selected Beds';

  if (error) {
    const msg = error.code === '23505'
      ? 'Some bed numbers already exist. Refresh the page and try again.'
      : safeErrorMessage(error, 'Bulk insert failed. Please try again.');
    _alert('error', msg);
    return;
  }
  closeBulkDrawer();
  _alert('success', `${rows.length} bed${rows.length > 1 ? 's' : ''} added successfully.`);
  await loadAll();
};

// ── Alert helper ──────────────────────────────────────────────────────────────
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.className = `alert show ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 3500);
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Close drawers on overlay click ───────────────────────────────────────────
['dept-overlay','bed-overlay','bulk-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) {
      if (id === 'dept-overlay')  closeDeptDrawer();
      if (id === 'bed-overlay')   closeBedDrawer();
      if (id === 'bulk-overlay')  closeBulkDrawer();
    }
  });
});

await loadAll();

// Deep-link support (?tab=dept|beds|quick) -- lets other pages (e.g. admin.html's NCISM
// Setup Compliance checklist) send the admin to the specific tab their action is actually
// about, instead of every link landing on the default Departments tab regardless of which
// checklist item was clicked (Session 103: "All departments configured" and "Minimum beds
// = UG intake" both pointed at plain bed-admin.html with no tab hint, so both opened on
// the same tab and neither one deep-linked to Bed Matrix/Quick Setup where beds actually
// get reviewed or added).
const _requestedTab = new URLSearchParams(window.location.search).get('tab');
if (_requestedTab && ['dept','beds','quick'].includes(_requestedTab)) {
  window.switchTab(_requestedTab);
}
