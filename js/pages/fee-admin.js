import { requireAuth, getCurrentProfile, getCurrentTenant, getCurrentTenantId, getCurrentRole, getCurrentSecondaryRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['dept_admin','super_admin']);
initNavbar();
wireDelegatedEvents();

const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = getCurrentTenantId();
const role      = getCurrentRole();
// Session 123 -- a secondary_role='dept_admin' caller (e.g. Medical Director/
// MS whose primary role is doctor) counts as dept_admin-tier here too --
// buildActions() below used to check the raw primary role only, so they
// could reach this page but never saw a single action button.
const isDeptAdminTier = role === 'dept_admin' || getCurrentSecondaryRole() === 'dept_admin';
const userId    = profile.id;
const facType   = tenant?.type || 'clinic';

// ── State ─────────────────────────────────────────
let _allFees        = [];
let _opds           = [];
let _allDepts       = [];   // {id, name, ncism_code} -- tenant's real departments (Session 107)
let _bedMultipliers = [];   // {tenant_id, bed_type, multiplier, is_active} -- Session 109
let _editId         = null;
let _activeGroup      = 'all'; // 'all' | 'general' | a GROUP_CONFIG key | a real department id
let _activeSub        = 'all'; // 'all' | a sub-item key within the active group
let _activeGroupLabel = 'All Departments';
let _activeSubLabel    = null;

// ── Facility profile ──────────────────────────────
const FAC_PROFILE = {
  clinic:            { label:'Clinic',              icon:'🏥', cats:['opd','lab','procedure','custom'],                       color:'#1a4a2e' },
  hospital:          { label:'Hospital',            icon:'🏨', cats:['opd','ipd','lab','procedure','radiology','custom'],     color:'#1e40af' },
  teaching_hospital: { label:'Teaching Hospital',   icon:'🏨', cats:['opd','ipd','lab','procedure','radiology','custom'],     color:'#1e40af' },
  pk_center:         { label:'Panchakarma Centre',  icon:'🌿', cats:['opd','procedure','custom'],                            color:'#6d28d9' },
  dispensary:        { label:'Dispensary',          icon:'💊', cats:['opd','custom'],                                        color:'#b45309' },
  college:           { label:'Ayurveda College',    icon:'🎓', cats:['opd','lab','procedure','radiology','custom'],          color:'#0f766e' },
  pharma:            { label:'Pharma',              icon:'🔬', cats:['custom'],                                              color:'#374151' },
  supplier:          { label:'Supplier',            icon:'📦', cats:['custom'],                                              color:'#374151' },
  dealer:            { label:'Dealer',              icon:'🏪', cats:['custom'],                                              color:'#374151' },
};
const fac = FAC_PROFILE[facType] || FAC_PROFILE.clinic;

// Show facility banner
document.getElementById('fac-type').textContent  = `${fac.icon} ${fac.label}`;
document.getElementById('fac-cats').textContent  =
  fac.cats.map(c => ({ opd:'OPD', ipd:'IPD', lab:'Lab & Diagnostics',
    procedure:'Procedures', radiology:'Radiology', custom:'Custom Services' })[c]).join(' · ');

// ── Role UI setup ─────────────────────────────────
const roleBadge = document.getElementById('role-badge');
const roleLabels = {
  accountant:  { text: 'Accountant — Can create fees', cls: 'accountant' },
  dept_admin:  { text: 'Dept. Admin — Can approve fees', cls: 'dept_admin' },
  super_admin: { text: 'Super Admin — Full control', cls: 'super_admin' }
};
const rl = roleLabels[role] || { text: role, cls: '' };
roleBadge.textContent = rl.text;
roleBadge.classList.add(rl.cls);

if (role === 'super_admin') {
  document.getElementById('bypass-banner').style.display = 'flex';
}

// ── Category helpers ──────────────────────────────
const CAT_LABELS = { opd:'OPD', ipd:'IPD', lab:'Lab', procedure:'Procedure', radiology:'Radiology', custom:'Custom' };
const CAT_TYPES = {
  opd: [
    { value:'registration',       label:'Registration Fee' },
    { value:'consultation',       label:'Consultation Fee' },
    { value:'on_request_surcharge',label:'On-Request Surcharge' }
  ],
  ipd: [
    { value:'admission',          label:'Admission Charge' },
    { value:'room_general',       label:'Room — General Ward' },
    { value:'room_semi_private',  label:'Room — Semi-Private' },
    { value:'room_private',       label:'Room — Private' },
    { value:'room_icu',           label:'Room — ICU / HDU' },
    { value:'nursing',            label:'Nursing Care (per day)' },
    { value:'attendant_bed',      label:'Attendant Bed (per night)' }
  ],
  lab: [
    { value:'blood_cbc',          label:'Blood — CBC' },
    { value:'blood_lft',          label:'Blood — LFT' },
    { value:'blood_rft',          label:'Blood — RFT' },
    { value:'blood_lipid',        label:'Blood — Lipid Profile' },
    { value:'blood_thyroid',      label:'Blood — Thyroid (T3/T4/TSH)' },
    { value:'blood_sugar_fasting',label:'Blood Sugar — Fasting' },
    { value:'blood_sugar_pp',     label:'Blood Sugar — PP' },
    { value:'urine_routine',      label:'Urine — Routine' },
    { value:'stool_routine',      label:'Stool — Routine' },
    { value:'culture_sensitivity',label:'Culture & Sensitivity' },
    { value:'biopsy',             label:'Biopsy' },
    { value:'other_lab',          label:'Other Lab Test' }
  ],
  procedure: [
    // ── General / Nursing ──
    { value:'physiotherapy',      label:'Physiotherapy Session' },
    { value:'wound_dressing',     label:'Wound Dressing' },
    { value:'injection',          label:'Injection (IM/SC)' },
    { value:'iv_cannula',         label:'IV Cannula / Fluid' },
    { value:'nebulization',       label:'Nebulization' },
    // ── Kayachikitsa (Internal Medicine) ──
    { value:'kay_snehapana',      label:'Kayachikitsa — Snehapana (Internal Oleation)' },
    { value:'kay_virechana',      label:'Kayachikitsa — Virechana Karma' },
    // ── Panchakarma ──
    { value:'pk_abhyanga',        label:'Panchakarma — Abhyanga' },
    { value:'pk_shirodhara',      label:'Panchakarma — Shirodhara' },
    { value:'pk_vasti',           label:'Panchakarma — Vasti (generic)' },
    { value:'pk_vasti_anuvasana', label:'Panchakarma — Vasti (Anuvasana)' },
    { value:'pk_vasti_niruha',    label:'Panchakarma — Vasti (Niruha)' },
    { value:'pk_kizhi',           label:'Panchakarma — Kizhi (Pinda Sweda)' },
    { value:'pk_nasya',           label:'Panchakarma — Nasya' },
    { value:'pk_pizhichil',       label:'Panchakarma — Pizhichil' },
    { value:'pk_udvartana',       label:'Panchakarma — Udvartana (Powder Massage)' },
    { value:'pk_shirovasti',      label:'Panchakarma — Shirovasti' },
    { value:'pk_raktamokshana',   label:'Panchakarma — Raktamokshana' },
    { value:'pk_kati_vasti',      label:'Panchakarma — Kati Vasti' },
    { value:'pk_janu_vasti',      label:'Panchakarma — Janu Vasti' },
    { value:'pk_greeva_vasti',    label:'Panchakarma — Greeva Vasti' },
    { value:'pk_matra_basti',     label:'Panchakarma — Matra Basti' },
    // ── Shalya Tantra (Surgery) ──
    { value:'shal_minor_ot',      label:'Shalya Tantra — Minor OT Procedure' },
    { value:'shal_ksharasutra',   label:'Shalya Tantra — Kshara Sutra Application' },
    { value:'shal_kshara_karma',  label:'Shalya Tantra — Kshara Karma' },
    { value:'shal_agnikarma',     label:'Shalya Tantra — Agnikarma' },
    { value:'shal_incision_drainage', label:'Shalya Tantra — Abscess Incision & Drainage' },
    { value:'shal_fistula',       label:'Shalya Tantra — Fistula/Fissure Procedure' },
    { value:'shal_suture_removal',label:'Shalya Tantra — Suture Removal' },
    // ── Shalakya Tantra (Ophthalmology / ENT) ──
    { value:'shak_netra_tarpana', label:'Shalakya — Netra Tarpana' },
    { value:'shak_netra_anjana',  label:'Shalakya — Netra Anjana' },
    { value:'shak_aschyotana',    label:'Shalakya — Aschyotana' },
    { value:'shak_karna_purana',  label:'Shalakya — Karna Purana (Ear Oil Therapy)' },
    { value:'shak_kavala_gandusha', label:'Shalakya — Kavala/Gandusha (Oral)' },
    { value:'shak_pratimarsha_nasya', label:'Shalakya — Pratimarsha Nasya' },
    { value:'shak_fb_removal',    label:'Shalakya — Foreign Body Removal (Eye/Ear/Nose)' },
    // ── Stri Roga & Prasuti Tantra (OBG) ──
    { value:'pst_anc_checkup',    label:'Stri Roga — ANC Checkup' },
    { value:'pst_normal_delivery',label:'Stri Roga & Prasuti — Normal Delivery' },
    { value:'pst_uttar_basti',    label:'Stri Roga — Uttar Basti' },
    { value:'pst_pnc_checkup',    label:'Stri Roga — PNC Checkup' },
    { value:'pst_yoni_prakshalana', label:'Stri Roga — Yoni Prakshalana' },
    // ── Kaumarabhritya (Paediatrics) ──
    { value:'kau_consultation',   label:'Kaumarabhritya — Paediatric Consultation' },
    { value:'kau_swarna_prashan', label:'Kaumarabhritya — Swarna Prashan' },
    { value:'kau_vaccination',    label:'Kaumarabhritya — Vaccination' },
    { value:'kau_growth_monitoring', label:'Kaumarabhritya — Growth Monitoring' },
    // ── Agada Tantra (Toxicology / Medical Jurisprudence) ──
    { value:'agd_poison_mgmt',    label:'Agada Tantra — Poison Management / Emergency' },
    { value:'agd_deaddiction',    label:'Agada Tantra — De-addiction Consultation' },
    { value:'agd_mlc',            label:'Agada Tantra — Medico-Legal Case Charges' },
    // ── Swasthavritta & Yoga ──
    { value:'sw_health_checkup',  label:'Swasthavritta — Health Checkup Package' },
    { value:'sw_yoga_session',    label:'Swasthavritta — Yoga Session' },
    // ── Operation Theatre / Labour Room / Kriyakalpa / Diet / Laundry ──
    { value:'ot_major_package',   label:'Operation Theatre — Major OT Package' },
    { value:'ot_minor_package',   label:'Operation Theatre — Minor OT Package' },
    { value:'ot_cssd_charge',     label:'Operation Theatre — CSSD Sterilisation Charge' },
    { value:'labour_room_delivery', label:'Labour Room — Delivery Charge' },
    { value:'kriya_netra',        label:'Kriyakalpa — Netra Procedure' },
    { value:'kriya_ent',          label:'Kriyakalpa — ENT Procedure' },
    { value:'diet_indent',        label:'Diet / Pathya — Special Diet Charge' },
    { value:'laundry_charge',     label:'Laundry Charge' },
    { value:'other_procedure',    label:'Other Procedure' }
  ],
  radiology: [
    { value:'xray',               label:'X-Ray' },
    { value:'ultrasound',         label:'Ultrasound (USG)' },
    { value:'ct_scan',            label:'CT Scan' },
    { value:'mri',                label:'MRI' },
    { value:'ecg',                label:'ECG' },
    { value:'echo',               label:'Echo (2D Echo)' },
    { value:'other_radiology',    label:'Other Radiology' }
  ],
  custom: []
};

function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ── Group navigation config (Session 109) ─────────────────────────────────
// Dr. Venkatesh's ask: click "Administration" and see its counters drop down, click a
// counter to see its services -- same for OPD/IPD/OT etc. Of these named groups, only
// Panchakarma and (inconsistently, across tenant types) Swasthavritta & Yoga overlap with
// a real `departments` row -- Administration, MRD, OT, Labour Room, Kriyakalpa, Diet/
// Pathya, Physiotherapy, Laundry, Pharmacy have NO department row, ever (confirmed via
// repo search) so they're tagged with the free-text `service_group` column instead (no
// CHECK constraint -- Session 106 already found a CHECK on a free-growing vocabulary
// silently blocks every save of a new value, platform-wide). Real departments NOT listed
// here (Kayachikitsa, Shalya Tantra, Shalakya Tantra, Prasuti & Stri Roga, Kaumarabhritya,
// Agada Tantra, and Panchakarma itself) keep working exactly as Session 107 built them --
// an automatic tab once the department has >=1 linked fee -- via the generic fallback in
// renderGroupTabs(), not through this config at all.
const SERVICE_GROUPS = {
  admin_reception:    'Administration — Reception',
  admin_registration: 'Administration — Registration Counter',
  admin_admission:    'Administration — Admission Counter',
  admin_insurance:    'Administration — Insurance Counter',
  admin_discharge:    'Administration — Discharge Counter',
  admin_billing:      'Administration — Billing Counter',
  admin_mrd:          'Administration — MRD',
  ot_major:           'Operation Theatre — Major OT',
  ot_minor:           'Operation Theatre — Minor OT',
  ot_cssd:            'Operation Theatre — CSSD',
  labour_room:        'Labour Room',
  kriyakalpa:         'Kriyakalpa',
  swasthavritta_yoga: 'Swasthavritta & Yoga',
  diet_pathya:        'Diet / Pathya',
  physiotherapy:      'Physiotherapy',
  pharmacy:           'Pharmacy Services',
  laundry:            'Laundry',
};

// Same 12-value vocabulary as beds.bed_type (user-guide/bed-admin.html's documented
// CHECK constraint, mirrored in js/pages/bed-admin.js's BED_LABELS) -- duplicated here
// rather than imported, matching this codebase's per-page self-containment convention.
const BED_TYPE_LABELS = {
  male_general:'Male General Ward', female_general:'Female General Ward', general:'General Ward',
  twin_sharing:'Twin Sharing', semi_private:'Shared Private', private:'Private Room',
  deluxe:'Deluxe Private', dormitory:'Dormitory', icu:'ICU', day_care:'Day Care',
  pk_treatment:'PK Treatment', observation:'Observation',
};

const IPD_SUBITEMS = [
  ['admission', 'Admission Charge'],
  ['room',      'Room Tariff'],
  ['nursing',   'Nursing Care'],
  ['attendant_bed', 'Attendant Bed'],
];

// GROUP_CONFIG resolvers match purely on service_group / category / opd_id / department_id
// (Panchakarma only), per the approved plan -- Administration/OT/Labour Room/etc never on
// department_id (see CLAIMED_DEPT_NAMES below for why). Some real hospital/teaching_hospital
// tenants (confirmed on both WASA1631 and SDM) also happen to carry real `departments` rows
// with the same names (Administration, OPD, IPD, Operation Theatre, Labour Room, Kriyakalpa,
// Diet/Pathya, Physiotherapy, Diagnostics, Pharmacy, Laundry) from a broader org-tree
// seeding -- rather than merging that path into these resolvers (which risks two
// different-looking "sources of truth" for the same tab), those department names are
// excluded from the "+Add Service" Department picker entirely (see loadDepartments() /
// CLAIMED_DEPT_NAMES below) so a fee can only ever reach one of these groups the one
// intended way: via service_group (or category/opd_id for OPD/IPD/Diagnostics).
//
// `alwaysShow: true` groups (Session 110, per Dr. Venkatesh's explicit ask) render as a
// tab in this fixed order regardless of whether they have any fees yet -- so there's
// somewhere to click "+ Add Service" into a brand-new department before its first fee
// exists (the dynamic "only show tabs with real data" principle, while right for the
// *other* real clinical departments below, was actively blocking that for these 11).
// Session 110 correction #6: Dr. Venkatesh's real complaint was that a service added
// under, say, "Shalya Tantra OPD" (an `opds` row, opd_id-linked) silently didn't count as
// belonging to the SEPARATE "Shalya Tantra (Surgery)" tab shown further down the nav (a
// real `departments` row, department_id-linked) -- two different fields, two different
// tabs, for what he sees as one department. His fix: fold each clinical department's
// fees into its matching OPD's dropdown entry and remove the standalone duplicate tab
// entirely -- except Panchakarma, which he explicitly wants kept as its own separate
// pinned tab (#4) since it has enough distinct treatments to deserve one. `opds.ncism_code`
// reliably matches `departments.ncism_code` for every real OPD except Screening OPD
// (confirmed live) -- the stable join key, not a name string.
function _deptIdForOpd(opd) {
  if (!opd?.ncism_code || opd.ncism_code === 'PK') return null; // Panchakarma stays out of the fold-in
  return _allDepts.find(d => d.ncism_code === opd.ncism_code)?.id || null;
}

function _opdFoldedDeptIds() {
  return new Set(_opds.map(o => _deptIdForOpd(o)).filter(Boolean));
}

const GROUP_CONFIG = [
  {
    key:'administration', label:'Administration', alwaysShow: true,
    subItems: [
      ['admin_reception','Reception'], ['admin_registration','Registration Counter'],
      ['admin_admission','Admission Counter'], ['admin_discharge','Discharge Counter'],
      ['admin_insurance','Insurance Counter'], ['admin_billing','Billing Counter'],
      ['admin_mrd','MRD'],
    ],
    match:    f => !!f.service_group && f.service_group.startsWith('admin_'),
    matchSub: (f, sub) => f.service_group === sub,
  },
  {
    key:'opd', label:'OPD', alwaysShow: true,
    // Matches: plain OPD-category fees (registration/consultation, opd_id or not), ANY
    // fee directly linked to a real OPD via opd_id (regardless of category -- a Shalya
    // Tantra procedure charge is still "Shalya Tantra OPD"'s business), and any fee
    // linked via department_id to one of the folded-in clinical departments above.
    match: f => f.category === 'opd' || !!f.opd_id || (!!f.department_id && _opdFoldedDeptIds().has(f.department_id)),
    matchSub: (f, sub) => {
      if (sub === '__general_opd__') return !f.opd_id && !_opdFoldedDeptIds().has(f.department_id);
      if (f.opd_id === sub) return true;
      const deptId = _deptIdForOpd(_opds.find(o => o.id === sub));
      return !!deptId && f.department_id === deptId;
    },
  },
  {
    key:'ipd', label:'IPD', alwaysShow: true,
    match: f => f.category === 'ipd',
    matchSub: (f, sub) => sub === 'room' ? (f.fee_type || '').startsWith('room_') : f.fee_type === sub,
  },
  {
    // Panchakarma is a real clinical department (unlike the service_group-tagged groups
    // around it) -- resolved by ncism_code, the stable key already used everywhere else
    // in this app for NCISM departments, not a name string prone to drift/typos.
    key:'panchakarma', label:'Panchakarma', alwaysShow: true,
    match: f => {
      const pk = _allDepts.find(d => d.ncism_code === 'PK');
      return !!pk && f.department_id === pk.id;
    },
  },
  { key:'kriyakalpa', label:'Kriyakalpa', alwaysShow: true, soloTag:'kriyakalpa', match: f => f.service_group === 'kriyakalpa' },
  { key:'labour_room', label:'Labour Room', alwaysShow: true, soloTag:'labour_room', match: f => f.service_group === 'labour_room' },
  { key:'diet_pathya', label:'Diet / Pathya', alwaysShow: true, soloTag:'diet_pathya', match: f => f.service_group === 'diet_pathya' },
  { key:'physiotherapy', label:'Physiotherapy', alwaysShow: true, soloTag:'physiotherapy', match: f => f.service_group === 'physiotherapy' },
  { key:'laundry', label:'Laundry', alwaysShow: true, soloTag:'laundry', match: f => f.service_group === 'laundry' },
  { key:'pharmacy', label:'Pharmacy', alwaysShow: true, soloTag:'pharmacy', match: f => f.service_group === 'pharmacy' },
  {
    key:'diagnostics', label:'Diagnostics', alwaysShow: true,
    subItems: [['lab','Lab'], ['radiology','Radiology']],
    match:    f => f.category === 'lab' || f.category === 'radiology',
    matchSub: (f, sub) => f.category === sub,
  },
  // Not pinned -- only shown once they actually have a fee, same as any other real
  // department (Dr. Venkatesh's latest numbered list didn't call these out as pinned).
  {
    key:'ot', label:'Operation Theatre',
    subItems: [['ot_major','Major OT'], ['ot_minor','Minor OT'], ['ot_cssd','CSSD']],
    match:    f => ['ot_major','ot_minor','ot_cssd'].includes(f.service_group),
    matchSub: (f, sub) => f.service_group === sub,
  },
  { key:'swasthavritta_yoga', label:'Swasthavritta & Yoga', soloTag:'swasthavritta_yoga', match: f => f.service_group === 'swasthavritta_yoga' },
];

// Real department names that collide with a GROUP_CONFIG group above -- excluded from
// the "+Add Service" Department dropdown (loadDepartments()) so there's no way to
// accidentally link a fee to one of these via department_id, and kept as a defensive
// exclusion in renderGroupTabs()'s generic per-department fallback too (belt-and-braces
// in case any pre-existing row already has department_id set to one of these).
const CLAIMED_DEPT_NAMES = new Set([
  'administration', 'opd', 'ipd', 'operation theatre (major + minor + cssd)', 'diagnostics',
  'labour room', 'kriyakalpa', 'swasthavritta & yoga', 'diet / pathya', 'physiotherapy',
  'pharmacy', 'laundry',
]);

// ── Approval text per role ────────────────────────
const APPROVAL_TEXT = {
  accountant:  'Your submission will be sent to the Department Admin for approval before it becomes active.',
  dept_admin:  'Your submission will go to you for approval. You can approve it immediately after saving.',
  super_admin: 'As Super Admin, you can activate this fee immediately or save it as active directly.'
};

// ── Load OPDs ─────────────────────────────────────
async function loadOPDs() {
  const { data } = await supabase
    .from('opds')
    .select('id, name, ncism_code')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');
  _opds = data || [];
  const sel = document.getElementById('m-opd');
  sel.innerHTML = '<option value="">— All OPDs / General —</option>';
  _opds.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.id; opt.textContent = o.name;
    sel.appendChild(opt);
  });
}

// ── Load departments (Session 107) ─────────────────
// Real tenant departments, used for: the manual "+Add Service" department picker, Quick
// Setup's dept-code -> department_id resolution, and the department-tabs display names.
async function loadDepartments() {
  const { data } = await supabase
    .from('departments')
    .select('id, name, ncism_code')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');
  _allDepts = data || [];
  const sel = document.getElementById('m-department');
  if (sel) {
    sel.innerHTML = '<option value="">— General / Hospital-wide —</option>';
    // Departments already covered by a GROUP_CONFIG group (Administration, OPD, IPD, OT,
    // Labour Room, Kriyakalpa, Diet/Pathya, Physiotherapy, Diagnostics, Pharmacy, Laundry)
    // are deliberately left out of this picker -- those fees belong via Service Group (or
    // category/opd_id) instead, so there's exactly one way to reach each of those tabs,
    // not two competing ones.
    _allDepts
      .filter(d => !CLAIMED_DEPT_NAMES.has(d.name.trim().toLowerCase()))
      .forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id; opt.textContent = d.name;
        sel.appendChild(opt);
      });
  }
}

// ── Load fees ─────────────────────────────────────
async function loadFees() {
  const { data, error } = await supabase
    .from('fee_structures')
    .select('*, opds(name), creator:created_by(full_name)')
    .eq('tenant_id', tenantId)
    .order('category')
    .order('label');

  if (error) { console.error(error); return; }
  _allFees = data || [];
  updateStats();
  renderGroupTabs();
  renderTable();
}

function updateStats() {
  const active  = _allFees.filter(f => f.approval_status === 'active').length;
  const pending = _allFees.filter(f => f.approval_status === 'pending').length;
  const dept    = _allFees.filter(f => f.approval_status === 'dept_approved').length;
  document.getElementById('stat-active').textContent  = active;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-dept').textContent    = dept;
  document.getElementById('stat-total').textContent   = _allFees.length;
}

window.filterFees = function() { renderTable(); };

// ── Group tabs (Session 109/110) ───────────────────
// Two-level nav. The 11 `alwaysShow` groups in GROUP_CONFIG (Administration, OPD, IPD,
// Panchakarma, Kriyakalpa, Labour Room, Diet/Pathya, Physiotherapy, Laundry, Pharmacy,
// Diagnostics) render in that fixed order every time, whether or not they have a fee yet
// -- Dr. Venkatesh needs somewhere to click "+ Add Service" into before a department's
// first fee exists. Every other real department (Kayachikitsa, Shalya Tantra, Shalakya
// Tantra, Prasuti & Stri Roga, Kaumarabhritya, Agada Tantra, plus non-pinned GROUP_CONFIG
// groups like Operation Theatre/Swasthavritta & Yoga) still only gets a tab once it
// genuinely has >=1 linked fee -- same dynamic principle Session 107 built, just no
// longer applied to the 11 pinned ones. A General fallback covers anything left over
// (uncategorised custom/procedure fees).
function _isGeneralFee(f) {
  return !f.department_id && !f.service_group && !['opd','ipd','lab','radiology'].includes(f.category);
}

function renderGroupTabs() {
  const wrap = document.getElementById('group-tabs');
  if (!wrap) return;

  const deptIdsPresent = new Set(_allFees.filter(f => f.department_id).map(f => f.department_id));
  const pkDept = _allDepts.find(d => d.ncism_code === 'PK');
  const foldedDeptIds = _opdFoldedDeptIds();
  const deptsPresent = _allDepts.filter(d =>
    deptIdsPresent.has(d.id) &&
    !CLAIMED_DEPT_NAMES.has(d.name.trim().toLowerCase()) &&
    d.id !== pkDept?.id &&        // Panchakarma is its own pinned GROUP_CONFIG entry above
    !foldedDeptIds.has(d.id)      // every other clinical dept with a matching OPD lives under OPD's dropdown now, not its own tab
  );
  const hasGeneral = _allFees.some(_isGeneralFee);

  const tabs = [{ key:'all', label:'All Departments' }];

  GROUP_CONFIG.forEach(g => {
    if (g.alwaysShow || _allFees.some(g.match)) tabs.push({ key:g.key, label:g.label });
  });

  deptsPresent.forEach(d => tabs.push({ key:d.id, label:d.name }));

  if (hasGeneral) tabs.push({ key:'general', label:'General / Hospital-wide' });

  wrap.innerHTML = tabs.map(t =>
    `<button class="dept-tab${_activeGroup === t.key ? ' active' : ''}" data-onclick="setGroupTab" data-onclick-a0="@this" data-onclick-a1="${_esc(t.key)}">${_esc(t.label)}</button>`
  ).join('');

  renderSubTabs();
}

function renderSubTabs() {
  const wrap = document.getElementById('subgroup-tabs');
  if (!wrap) return;

  const grp = GROUP_CONFIG.find(g => g.key === _activeGroup);
  if (!grp) { wrap.innerHTML = ''; return; }

  let subItems;
  if (grp.key === 'opd') {
    subItems = [['__general_opd__', 'General OPD'], ..._opds.map(o => [o.id, o.name])];
  } else if (grp.key === 'ipd') {
    subItems = IPD_SUBITEMS;
  } else {
    subItems = grp.subItems || [];
  }

  // Pinned (alwaysShow) groups show every sub-item unconditionally, same reasoning as the
  // group tabs themselves -- Dr. Venkatesh needs to click into an empty OPD/counter/sub-
  // category to add its first fee, not wait for one to already exist. Non-pinned groups
  // (Operation Theatre) keep the original "only show sub-items that already have a fee"
  // behaviour.
  if (!grp.alwaysShow) {
    subItems = subItems.filter(([key]) => _allFees.some(f => grp.match(f) && grp.matchSub(f, key)));
  }

  if (subItems.length <= 1) { wrap.innerHTML = ''; return; } // solo-tag groups need no second level

  wrap.innerHTML =
    `<button class="sub-tab${_activeSub === 'all' ? ' active' : ''}" data-onclick="setSubTab" data-onclick-a0="@this" data-onclick-a1="all">All</button>` +
    subItems.map(([key, label]) =>
      `<button class="sub-tab${_activeSub === key ? ' active' : ''}" data-onclick="setSubTab" data-onclick-a0="@this" data-onclick-a1="${_esc(key)}">${_esc(label)}</button>`
    ).join('');
}

window.setGroupTab = function(btn, key) {
  document.querySelectorAll('#group-tabs .dept-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _activeGroup      = key;
  _activeGroupLabel = btn.textContent;
  _activeSub        = 'all';
  _activeSubLabel   = null;
  renderSubTabs();
  renderTable();
};

window.setSubTab = function(btn, key) {
  document.querySelectorAll('#subgroup-tabs .sub-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _activeSub      = key;
  _activeSubLabel = key === 'all' ? null : btn.textContent;
  renderTable();
};

// Computed client-side from the row's General-Ward baseline (`amount`) x each active
// bed_category_multipliers row -- never a second query per row, never stored redundantly.
function _tieredAmountDisplay(f) {
  const base   = parseFloat(f.amount) || 0;
  const active = _bedMultipliers.filter(m => m.is_active);

  if (!active.length) {
    return `₹${base.toLocaleString('en-IN')} <span class="tier-tag">base — no bed categories configured</span>`;
  }

  const amounts = active.map(m => base * parseFloat(m.multiplier));
  const min = Math.min(...amounts), max = Math.max(...amounts);
  const rowId = 'tier-' + f.id;

  return `<span class="tier-range">₹${min.toLocaleString('en-IN', { maximumFractionDigits: 0 })}–₹${max.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>` +
    `<button type="button" class="tier-expand" data-onclick="toggleTierExpand" data-onclick-a0="${rowId}">▾ tiers</button>` +
    `<div class="tier-detail" id="${rowId}" style="display:none">` +
    active.map(m => `<div>${_esc(BED_TYPE_LABELS[m.bed_type] || m.bed_type)}: ₹${(base * parseFloat(m.multiplier)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>`).join('') +
    `</div>`;
}

window.toggleTierExpand = function(rowId) {
  const el = document.getElementById(rowId);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

function renderTable() {
  const rows = _currentFilteredFees();

  const tbody = document.getElementById('fee-tbody');
  if (!rows.length) {
    // A specific group/sub-item with zero fees still needs a direct way to add its
    // first one -- the global "+Add Service" button up top does the same thing, but
    // Dr. Venkatesh asked for an option to add services from inside every department,
    // not just from a button he has to scroll back up to.
    const scoped = _activeGroup !== 'all';
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty">
      <div class="empty-icon">📋</div>
      <div class="empty-text">No fees found${scoped ? ` in ${_esc(_currentScopeLabel())}` : ''}</div>
      ${scoped ? `<button class="btn-add" style="margin-top:14px" data-onclick="openModal">+ Add Service to ${_esc(_currentScopeLabel())}</button>` : ''}
      </div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(f => {
    const catCls   = 'cat-' + (f.category || 'custom');
    const catLabel = CAT_LABELS[f.category] || f.category;
    const opdDeptLabel = _deptOrOpdLabel(f);
    const amount   = f.pricing_mode === 'tiered'
      ? _tieredAmountDisplay(f)
      : `₹${parseFloat(f.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
        + (_hasActivePromo(f)
            ? `<div class="fee-notes" style="color:#8a5a00">🎁 ₹${parseFloat(f.promo_price).toLocaleString('en-IN')} until ${new Date(f.promo_valid_until).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}</div>`
            : '');
    const status   = f.approval_status || 'pending';
    const statusLabel = { pending:'Pending', dept_approved:'Dept. Approved', active:'Active', rejected:'Rejected' }[status] || status;
    const creator  = f.creator?.full_name || '—';

    const actions = buildActions(f);

    return `<tr data-id="${_esc(f.id)}">
      <td>
        <div class="fee-label">${_esc(f.label) || '—'}</div>
        ${f.notes ? `<div class="fee-notes">${_esc(f.notes)}</div>` : ''}
        <div class="fee-notes" style="margin-top:2px;color:var(--text-muted)">By ${_esc(creator)}</div>
      </td>
      <td><span class="cat-badge ${catCls}">${catLabel}</span></td>
      <td style="color:var(--text-mid);font-size:13px">${_esc(opdDeptLabel)}</td>
      <td><span class="fee-amount">${amount}</span></td>
      <td><span class="status-badge status-${status}">${statusLabel}</span></td>
      <td><div class="actions">${actions}</div></td>
    </tr>`;
  }).join('');
}

function buildActions(f) {
  const s   = f.approval_status;
  const own = f.created_by === userId;
  let btns  = '';

  if (role === 'accountant') {
    if (own && s === 'pending') {
      btns += `<button class="act-btn act-edit" data-onclick="openEdit" data-onclick-a0="${f.id}">Edit</button>`;
      btns += `<button class="act-btn act-delete" data-onclick="deleteFee" data-onclick-a0="${f.id}">Delete</button>`;
    }
  }

  if (isDeptAdminTier) {
    if (s === 'pending') {
      btns += `<button class="act-btn act-approve" data-onclick="approveFee" data-onclick-a0="${f.id}">✓ Approve</button>`;
      btns += `<button class="act-btn act-reject"  data-onclick="rejectFee" data-onclick-a0="${f.id}">✗ Reject</button>`;
    }
    if (s === 'dept_approved') {
      btns += `<button class="act-btn act-reject" data-onclick="rejectFee" data-onclick-a0="${f.id}">✗ Reject</button>`;
    }
    if (own && s === 'pending') {
      btns += `<button class="act-btn act-edit" data-onclick="openEdit" data-onclick-a0="${f.id}">Edit</button>`;
    }
  }

  if (role === 'super_admin') {
    btns += `<button class="act-btn act-edit" data-onclick="openEdit" data-onclick-a0="${f.id}">Edit</button>`;
    if (s !== 'active') {
      if (s === 'dept_approved') {
        btns += `<button class="act-btn act-activate" data-onclick="activateFee" data-onclick-a0="${f.id}" data-onclick-a1="@false">⚡ Activate</button>`;
      }
      if (s === 'pending') {
        btns += `<button class="act-btn act-bypass" data-onclick="activateFee" data-onclick-a0="${f.id}" data-onclick-a1="@true">⚡ Bypass &amp; Activate</button>`;
      }
    }
    if (s === 'active') {
      btns += `<button class="act-btn act-reject" data-onclick="deactivateFee" data-onclick-a0="${f.id}">Deactivate</button>`;
      // Session 125 -- promo pricing deliberately not offered on tiered
      // (bed-category multiplier) fees for this first pass.
      if (f.pricing_mode !== 'tiered') {
        btns += _hasActivePromo(f)
          ? `<button class="act-btn act-reject" data-onclick="clearPromo" data-onclick-a0="${f.id}">🎁 Clear Promo</button>`
          : `<button class="act-btn act-edit" data-onclick="openPromoModal" data-onclick-a0="${f.id}">🎁 Set Promo</button>`;
      }
    }
    if (s !== 'rejected' && s !== 'active') {
      btns += `<button class="act-btn act-reject" data-onclick="rejectFee" data-onclick-a0="${f.id}">✗ Reject</button>`;
    }
    btns += `<button class="act-btn act-delete" data-onclick="deleteFee" data-onclick-a0="${f.id}">Delete</button>`;
  }

  return btns || '<span style="font-size:12px;color:var(--text-muted)">—</span>';
}

// ── Approval actions ──────────────────────────────
window.approveFee = async function(id) {
  await supabase.from('fee_structures').update({
    approval_status: 'dept_approved',
    approved_by_dept: userId
  }).eq('id', id);
  toast('Fee approved by department.', 'success');
  loadFees();
};

window.activateFee = async function(id, bypass) {
  await supabase.from('fee_structures').update({
    approval_status: 'active',
    is_active: true,
    approved_by_super: userId
  }).eq('id', id);
  toast(bypass ? 'Fee bypassed and activated.' : 'Fee activated.', 'success');
  loadFees();
};

window.deactivateFee = async function(id) {
  await supabase.from('fee_structures').update({
    approval_status: 'pending',
    is_active: false,
    approved_by_super: null
  }).eq('id', id);
  toast('Fee deactivated.', 'success');
  loadFees();
};

// ── Promo pricing (Session 125) ───────────────────
// A promo is "active" purely by comparing dates client-side -- the real
// auto-revert guarantee lives in js/modules/billing/effectivePrice.js,
// which every billing consumer calls; this badge is just a display echo
// of the same rule so fee-admin.html shows the truth.
function _hasActivePromo(f) {
  return !!(f.promo_valid_until && f.promo_price != null && new Date() < new Date(f.promo_valid_until));
}

window.openPromoModal = function(id) {
  const f = _allFees.find(x => x.id === id);
  if (!f) return;
  document.getElementById('promo-fee-id').value = id;
  document.getElementById('promo-fee-label').textContent = f.label + ' (currently ₹' + parseFloat(f.amount||0).toLocaleString('en-IN') + ')';
  document.getElementById('promo-price').value = '';
  document.getElementById('promo-until').value = '';
  document.getElementById('promo-reason').value = '';
  document.getElementById('promo-modal-overlay').classList.add('open');
};

window.closePromoModal = function() {
  document.getElementById('promo-modal-overlay').classList.remove('open');
};

window.savePromo = async function() {
  const id     = document.getElementById('promo-fee-id').value;
  const price  = document.getElementById('promo-price').value;
  const until  = document.getElementById('promo-until').value;
  const reason = document.getElementById('promo-reason').value.trim();

  if (price === '' || Number(price) < 0) { toast('Enter a valid promo price (0 or more).', 'error'); return; }
  if (!until) { toast('Set an expiry date for the promo.', 'error'); return; }

  const { error } = await supabase.from('fee_structures').update({
    promo_price: Number(price),
    promo_valid_until: new Date(until + 'T23:59:59').toISOString(),
    promo_reason: reason || null,
  }).eq('id', id);

  if (error) { toast(safeErrorMessage(error, 'Could not set promo.'), 'error'); return; }
  toast('Promo price set.', 'success');
  closePromoModal();
  loadFees();
};

window.clearPromo = async function(id) {
  if (!confirm('Clear this promo? The fee will immediately go back to its normal price.')) return;
  const { error } = await supabase.from('fee_structures').update({
    promo_price: null, promo_valid_until: null, promo_reason: null,
  }).eq('id', id);
  if (error) { toast(safeErrorMessage(error, 'Could not clear promo.'), 'error'); return; }
  toast('Promo cleared.', 'success');
  loadFees();
};

window.rejectFee = async function(id) {
  if (!confirm('Reject this fee? It will be marked as rejected.')) return;
  await supabase.from('fee_structures').update({
    approval_status: 'rejected',
    is_active: false
  }).eq('id', id);
  toast('Fee rejected.', 'success');
  loadFees();
};

window.deleteFee = async function(id) {
  if (!confirm('Delete this fee permanently?')) return;
  await supabase.from('fee_structures').delete().eq('id', id);
  toast('Fee deleted.', 'success');
  loadFees();
};

// ── Modal ─────────────────────────────────────────
function populateGroupSelect() {
  const sel = document.getElementById('m-group');
  if (!sel) return;
  sel.innerHTML = '<option value="">— None —</option>' +
    Object.entries(SERVICE_GROUPS).map(([k, label]) => `<option value="${k}">${_esc(label)}</option>`).join('');
}

// Pre-fill whichever location field the active group/sub-item actually uses, so the
// admin doesn't need to know service_group vs opd_id vs department_id vs category --
// they just see the field for what they were already looking at pre-filled for them
// (same convenience Session 107 built for the Department field alone).
function _prefillFromActiveGroup() {
  const catSel   = document.getElementById('m-category');
  const opdSel   = document.getElementById('m-opd');
  const deptSel  = document.getElementById('m-department');
  const groupSel = document.getElementById('m-group');

  opdSel.value = ''; deptSel.value = ''; groupSel.value = '';

  const grp = GROUP_CONFIG.find(g => g.key === _activeGroup);
  if (grp) {
    if (grp.key === 'opd') {
      catSel.value = 'opd';
      if (_activeSub !== 'all' && _activeSub !== '__general_opd__') {
        opdSel.value = _activeSub;
        // Also pre-fill the matching clinical department (if any) so a service saved
        // here shows up correctly whichever category the admin ends up picking -- a
        // Shalya Tantra procedure charge (category=procedure) still needs to land under
        // "Shalya Tantra OPD", not just opd_id-linked category=opd fees.
        const deptId = _deptIdForOpd(_opds.find(o => o.id === _activeSub));
        if (deptId) deptSel.value = deptId;
      }
    } else if (grp.key === 'ipd') {
      catSel.value = 'ipd';
    } else if (grp.key === 'panchakarma') {
      const pk = _allDepts.find(d => d.ncism_code === 'PK');
      if (pk) deptSel.value = pk.id;
    } else if (grp.key === 'diagnostics') {
      if (_activeSub === 'lab' || _activeSub === 'radiology') catSel.value = _activeSub;
    } else if (grp.soloTag) {
      groupSel.value = grp.soloTag;
    } else if (grp.key === 'administration' || grp.key === 'ot') {
      if (_activeSub !== 'all') groupSel.value = _activeSub; // a specific counter / OT sub-type
    }
  } else if (_activeGroup !== 'all' && _activeGroup !== 'general') {
    deptSel.value = _activeGroup; // real department id (Session 107 fallback)
  }
}

window.openModal = function() {
  _editId = null;
  document.getElementById('modal-title').textContent = 'Add New Service';
  document.getElementById('m-label').value   = '';
  document.getElementById('m-category').value = '';
  document.getElementById('m-amount').value  = '';
  document.getElementById('m-notes').value   = '';
  document.getElementById('m-opd-wrap').style.display = 'none';
  document.getElementById('m-type-wrap').style.display = 'none';
  document.getElementById('m-tiered').checked = false;
  document.getElementById('m-approval-note').style.display = 'block';
  document.getElementById('m-approval-text').textContent = APPROVAL_TEXT[role] || '';

  _prefillFromActiveGroup();
  onCategoryChange();
  updateTierPreview();

  const btnTxt = document.getElementById('btn-save-text');
  btnTxt.textContent = role === 'super_admin' ? 'Save & Activate' : 'Submit for Approval';

  document.getElementById('modal-overlay').classList.add('open');
};

window.openEdit = function(id) {
  const f = _allFees.find(x => x.id === id);
  if (!f) return;
  _editId = id;
  document.getElementById('modal-title').textContent = 'Edit Service';
  document.getElementById('m-label').value    = f.label || '';
  document.getElementById('m-category').value = f.category || '';
  document.getElementById('m-amount').value   = f.amount || '';
  document.getElementById('m-notes').value    = f.notes || '';
  document.getElementById('m-opd').value      = f.opd_id || '';
  const deptSel = document.getElementById('m-department');
  if (deptSel) deptSel.value = f.department_id || '';
  const groupSel = document.getElementById('m-group');
  if (groupSel) groupSel.value = f.service_group || '';
  onCategoryChange();
  document.getElementById('m-opd').value      = f.opd_id || '';
  document.getElementById('m-tiered').checked = f.pricing_mode === 'tiered';
  updateTierPreview();
  // Set fee_type
  const sel = document.getElementById('m-type-select');
  const inp = document.getElementById('m-type-input');
  if (sel.style.display !== 'none') sel.value = f.fee_type || '';
  if (inp.style.display !== 'none') inp.value = f.fee_type || '';

  document.getElementById('m-approval-note').style.display = 'none';
  document.getElementById('btn-save-text').textContent = 'Save Changes';
  document.getElementById('modal-overlay').classList.add('open');
};

window.closeModal = function() {
  document.getElementById('modal-overlay').classList.remove('open');
};

// Tiered pricing (Tier A/B per the RCM article Dr. Venkatesh shared) only makes sense
// for IPD room/nursing charges and clinical procedures (Panchakarma etc.) -- labs,
// radiology, and custom one-off charges (Tier C: materials/diagnostics) stay always flat.
const TIERABLE_CATEGORIES = ['ipd', 'procedure'];

window.onCategoryChange = function() {
  const cat     = document.getElementById('m-category').value;
  const typeWrap = document.getElementById('m-type-wrap');
  const opdWrap  = document.getElementById('m-opd-wrap');
  const tierWrap = document.getElementById('m-tiered-wrap');
  const sel      = document.getElementById('m-type-select');
  const inp      = document.getElementById('m-type-input');

  if (!cat) { typeWrap.style.display = 'none'; opdWrap.style.display = 'none'; tierWrap.style.display = 'none'; return; }

  typeWrap.style.display = 'block';
  // Shown for procedure too, not just opd -- a Shalya Tantra procedure charge still
  // benefits from being linked to "Shalya Tantra OPD" (Session 110's OPD fold-in fix).
  opdWrap.style.display  = (cat === 'opd' || cat === 'procedure') ? 'block' : 'none';

  if (!TIERABLE_CATEGORIES.includes(cat)) {
    document.getElementById('m-tiered').checked = false;
    tierWrap.style.display = 'none';
    updateTierPreview();
  } else {
    tierWrap.style.display = 'block';
  }

  const types = CAT_TYPES[cat];
  if (cat === 'custom' || !types || types.length === 0) {
    sel.style.display = 'none';
    inp.style.display = 'block';
    inp.placeholder   = 'Enter service type / name';
  } else {
    inp.style.display = 'none';
    sel.style.display = 'block';
    sel.innerHTML = '<option value="">— Select fee type —</option>' +
      types.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
    sel.onchange = function() {
      const found = types.find(t => t.value === sel.value);
      if (found && !document.getElementById('m-label').value) {
        document.getElementById('m-label').value = found.label;
      }
    };
  }
};

// Live preview of what every bed category will actually bill, computed as
// baseline x multiplier -- so the admin sees the real numbers before saving instead of
// typing in one amount per tier.
window.updateTierPreview = function() {
  const wrap    = document.getElementById('m-tier-preview');
  const checked = document.getElementById('m-tiered').checked;
  if (!checked) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  const base = parseFloat(document.getElementById('m-amount').value) || 0;
  const active = _bedMultipliers.filter(m => m.is_active);

  wrap.innerHTML = active.length
    ? active.map(m => `<div class="tier-row"><span>${_esc(BED_TYPE_LABELS[m.bed_type] || m.bed_type)}</span><span>₹${(base * parseFloat(m.multiplier)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span></div>`).join('')
    : '<div class="tier-row-empty">No bed categories configured yet — set them up via "Bed Category Pricing".</div>';
};

// ── Save fee ──────────────────────────────────────
window.saveFee = async function() {
  const label    = document.getElementById('m-label').value.trim();
  const category = document.getElementById('m-category').value;
  const amount   = parseFloat(document.getElementById('m-amount').value);
  const notes    = document.getElementById('m-notes').value.trim();
  const opdId    = document.getElementById('m-opd').value || null;
  const deptId   = document.getElementById('m-department')?.value || null;
  const groupTag = document.getElementById('m-group')?.value || null;
  const tiered   = TIERABLE_CATEGORIES.includes(category) && document.getElementById('m-tiered').checked;

  const sel  = document.getElementById('m-type-select');
  const inp  = document.getElementById('m-type-input');
  const feeType = sel.style.display !== 'none' ? sel.value : inp.value.trim();

  if (!label)    { toast('Please enter a service label.', 'error'); return; }
  if (!category) { toast('Please select a category.', 'error'); return; }
  if (isNaN(amount) || amount < 0) { toast('Please enter a valid amount.', 'error'); return; }

  const btn = document.getElementById('btn-save');
  btn.classList.add('loading'); btn.disabled = true;

  const isSuperAdmin = role === 'super_admin';
  const payload = {
    tenant_id:       tenantId,
    label,
    category,
    fee_type:        feeType || category,
    amount,
    notes:           notes || null,
    opd_id:          opdId,
    department_id:   deptId,
    service_group:   groupTag,
    pricing_mode:    tiered ? 'tiered' : 'flat',
    approval_status: isSuperAdmin ? 'active' : 'pending',
    is_active:       isSuperAdmin,
    created_by:      userId,
    ...(isSuperAdmin ? { approved_by_super: userId } : {})
  };

  let error;
  if (_editId) {
    ({ error } = await supabase.from('fee_structures').update(payload).eq('id', _editId));
  } else {
    ({ error } = await supabase.from('fee_structures').insert(payload));
  }

  btn.classList.remove('loading'); btn.disabled = false;

  if (error) { toast(safeErrorMessage(error, 'Could not save fee.'), 'error'); return; }

  toast(_editId ? 'Fee updated.' : (isSuperAdmin ? 'Fee saved and activated.' : 'Fee submitted for approval.'), 'success');
  closeModal();
  loadFees();
};

// ── Quick Setup ───────────────────────────────────
const QS_TEMPLATES = {
  clinic: [
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:100,  notes:'One-time new patient registration' },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:300  },
    { label:'On-Request Surcharge',      category:'opd', fee_type:'on_request_surcharge', amount:150,  notes:'Extra charge when non-scheduled doctor consulted' },
    { label:'Blood — CBC',               category:'lab', fee_type:'blood_cbc',            amount:250  },
    { label:'Urine — Routine',           category:'lab', fee_type:'urine_routine',        amount:150  },
    { label:'Wound Dressing',            category:'procedure', fee_type:'wound_dressing', amount:200  },
    { label:'Injection (IM/SC)',         category:'procedure', fee_type:'injection',       amount:100  },
  ],
  pk_center: [
    { label:'Initial Assessment',        category:'opd', fee_type:'registration',        amount:500,  notes:'Prakriti assessment and treatment planning' },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:400  },
    { label:'Panchakarma — Abhyanga',    category:'procedure', fee_type:'pk_abhyanga',    amount:1200 },
    { label:'Panchakarma — Shirodhara', category:'procedure', fee_type:'pk_shirodhara',  amount:1500 },
    { label:'Panchakarma — Vasti',       category:'procedure', fee_type:'pk_vasti',       amount:2000 },
    { label:'Panchakarma — Kizhi',       category:'procedure', fee_type:'pk_kizhi',       amount:1800 },
    { label:'Panchakarma — Nasya',       category:'procedure', fee_type:'pk_nasya',       amount:1000 },
    { label:'Panchakarma — Pizhichil',   category:'procedure', fee_type:'pk_pizhichil',   amount:3500 },
  ],
  // Comprehensive NCISM department-wise catalog (Session 106) -- covers all 7 mandatory
  // clinical departments (Kayachikitsa, Panchakarma, Shalya Tantra, Shalakya Tantra, Stri
  // Roga & Prasuti Tantra, Kaumarabhritya, Agada Tantra) plus Swasthavritta/Yoga and the
  // department-agnostic OPD/IPD/Lab/Radiology basics. Amounts are a reasonable STARTING
  // baseline, not SDM's real confirmed pricing -- every item is editable after Quick Setup
  // runs (amount, label, or delete), same as any other fee.
  hospital: [
    // ── Administration (Session 110) ── Registration Fee/OPD Consultation here are the
    // SAME conceptual charge as their OPD-section counterparts below (deliberately -- the
    // front desk that actually collects them is Reception/Registration Counter, so they
    // show under Administration too, per Dr. Venkatesh's ask); the rest are genuinely new
    // administrative processing charges with no other home.
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:200,  group:'admin_registration' },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:500,  group:'admin_reception' },
    { label:'New Patient Case File / Record Charge', category:'custom', fee_type:'reception_case_file', amount:50,  group:'admin_reception' },
    { label:'Health Card / OP Card Re-issue (Duplicate)', category:'custom', fee_type:'reception_card_reissue', amount:50, group:'admin_reception' },
    { label:'Hospital Registration / UHID Generation Fee', category:'custom', fee_type:'registration_uhid', amount:100, group:'admin_registration' },
    { label:'Registration Record Correction Fee', category:'custom', fee_type:'registration_correction', amount:50, group:'admin_registration' },
    { label:'Admission Paperwork / Processing Fee', category:'custom', fee_type:'admission_paperwork', amount:100, group:'admin_admission' },
    { label:'Bed Reservation / Advance Booking Fee', category:'custom', fee_type:'admission_bed_reservation', amount:200, group:'admin_admission' },
    { label:'Discharge Summary Preparation Fee', category:'custom', fee_type:'discharge_summary_prep', amount:100, group:'admin_discharge' },
    { label:'Duplicate Discharge Summary', category:'custom', fee_type:'discharge_summary_duplicate', amount:100, group:'admin_discharge' },
    { label:'Insurance / TPA Pre-Authorization Processing', category:'custom', fee_type:'insurance_preauth', amount:200, group:'admin_insurance' },
    { label:'Insurance Claim Documentation Fee', category:'custom', fee_type:'insurance_documentation', amount:150, group:'admin_insurance' },
    { label:'Cashless Claim Processing Fee', category:'custom', fee_type:'insurance_cashless_processing', amount:200, group:'admin_insurance' },
    { label:'Duplicate Bill / Invoice Reprint', category:'custom', fee_type:'billing_duplicate_invoice', amount:50, group:'admin_billing' },
    { label:'Itemized Bill Preparation (Insurance/Reimbursement)', category:'custom', fee_type:'billing_itemized_prep', amount:100, group:'admin_billing' },
    { label:'Corporate / Credit Billing Processing Fee', category:'custom', fee_type:'billing_corporate_processing', amount:150, group:'admin_billing' },
    { label:'Medical Records Photocopy (per set)', category:'custom', fee_type:'mrd_photocopy', amount:100, group:'admin_mrd' },
    { label:'Duplicate Medical Certificate', category:'custom', fee_type:'mrd_duplicate_certificate', amount:150, group:'admin_mrd' },
    { label:'Fitness Certificate', category:'custom', fee_type:'mrd_fitness_certificate', amount:150, group:'admin_mrd' },
    { label:'Medico-Legal Certificate', category:'custom', fee_type:'mrd_mlc_certificate', amount:300, group:'admin_mrd' },
    { label:'Old Record Retrieval Fee', category:'custom', fee_type:'mrd_record_retrieval', amount:100, group:'admin_mrd' },

    // ── OPD (general) ──
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:200  },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:500  },
    { label:'Follow-up Consultation',    category:'opd', fee_type:'consultation',         amount:200,  notes:'Within 7 days of previous visit' },
    { label:'Senior / Specialist Consultation', category:'opd', fee_type:'consultation',  amount:700  },
    { label:'On-Request Surcharge',      category:'opd', fee_type:'on_request_surcharge', amount:200  },
    { label:'Teleconsultation',          category:'opd', fee_type:'consultation',         amount:300  },

    // ── IPD (facility / room) ──
    { label:'Admission Charge',          category:'ipd', fee_type:'admission',            amount:1000 },
    { label:'Room — General Ward',       category:'ipd', fee_type:'room_general',         amount:800,  notes:'Per day' },
    { label:'Room — Semi-Private',       category:'ipd', fee_type:'room_semi_private',    amount:1500, notes:'Per day' },
    { label:'Room — Private',            category:'ipd', fee_type:'room_private',         amount:2500, notes:'Per day' },
    { label:'Room — ICU / HDU',          category:'ipd', fee_type:'room_icu',             amount:4000, notes:'Per day' },
    { label:'Nursing Care',              category:'ipd', fee_type:'nursing',              amount:500,  notes:'Per day' },
    { label:'Attendant Bed',             category:'ipd', fee_type:'attendant_bed',        amount:200,  notes:'Per night' },

    // ── Lab ──
    { label:'Blood — CBC',               category:'lab', fee_type:'blood_cbc',            amount:300  },
    { label:'Blood — LFT',               category:'lab', fee_type:'blood_lft',            amount:600  },
    { label:'Blood — RFT',               category:'lab', fee_type:'blood_rft',            amount:500  },
    { label:'Blood — Lipid Profile',     category:'lab', fee_type:'blood_lipid',          amount:600  },
    { label:'Blood — Thyroid (T3/T4/TSH)', category:'lab', fee_type:'blood_thyroid',      amount:700  },
    { label:'Blood Sugar — Fasting',     category:'lab', fee_type:'blood_sugar_fasting',  amount:150  },
    { label:'Blood Sugar — PP',          category:'lab', fee_type:'blood_sugar_pp',       amount:150  },
    // Session 124 Step 4 -- doctor.js's "Blood Sugar" panel bundles FBS+PPBS+HbA1c,
    // but unlike the other 6 panels there's no single bundle fee for it (real-world
    // labs don't bundle HbA1c with same-day sugar tests) -- it always decomposes to
    // 3 individual charges. HbA1c itself had no fee entry at all until now.
    { label:'HbA1c',                     category:'lab', fee_type:'hba1c',                amount:500  },
    { label:'Urine — Routine',           category:'lab', fee_type:'urine_routine',        amount:200  },
    { label:'Stool — Routine',           category:'lab', fee_type:'stool_routine',        amount:150  },
    { label:'Culture & Sensitivity',     category:'lab', fee_type:'culture_sensitivity',  amount:800  },
    { label:'Biopsy',                    category:'lab', fee_type:'biopsy',               amount:1500 },
    // Session 124 -- individually-orderable tests from doctor.js's LAB_CATALOG
    // with no panel of their own (see LAB_PANELS' 7 named panels above) --
    // label text matches doctor.js's test names exactly, needed for the
    // billing-time match in Step 4. Amounts are a structural placeholder
    // baseline only, NOT confirmed real pricing -- same convention as the
    // rest of this catalog (Session 106) -- edit these to your real rates.
    { label:'ESR (Westergren)',              category:'lab', fee_type:'esr',                  amount:100  },
    { label:'Peripheral Blood Smear',        category:'lab', fee_type:'peripheral_smear',      amount:150  },
    { label:'Reticulocyte Count',            category:'lab', fee_type:'reticulocyte_count',    amount:150  },
    { label:'Blood Group & Rh Type',         category:'lab', fee_type:'blood_group_rh',        amount:100  },
    { label:'Random Blood Sugar (RBS)',      category:'lab', fee_type:'blood_sugar_random',    amount:100  },
    { label:'Serum Calcium',                 category:'lab', fee_type:'serum_calcium',         amount:200  },
    { label:'Serum Iron',                    category:'lab', fee_type:'serum_iron',            amount:300  },
    { label:'TIBC',                          category:'lab', fee_type:'tibc',                  amount:300  },
    { label:'Vitamin D (25-OH)',             category:'lab', fee_type:'vitamin_d',             amount:1200 },
    { label:'Vitamin B12',                   category:'lab', fee_type:'vitamin_b12',           amount:900  },
    { label:'CRP (C-Reactive Protein)',      category:'lab', fee_type:'crp',                   amount:400  },
    { label:'Urine — Ketone Bodies',         category:'lab', fee_type:'urine_ketone',          amount:100  },
    { label:'Urine — Bile Salts/Pigments',   category:'lab', fee_type:'urine_bile',            amount:100  },
    { label:'Urine — Casts',                 category:'lab', fee_type:'urine_casts',           amount:100  },
    { label:'Urine Pregnancy Test (UPT)',    category:'lab', fee_type:'urine_pregnancy_test',  amount:150  },
    { label:'Stool — Occult Blood',          category:'lab', fee_type:'stool_occult_blood',    amount:150  },
    { label:'Widal Test (TO + TH)',          category:'lab', fee_type:'widal_test',            amount:250  },
    { label:'RA Factor (Rheumatoid Factor)', category:'lab', fee_type:'ra_factor',             amount:350  },
    { label:'ASO Titre',                     category:'lab', fee_type:'aso_titre',             amount:350  },
    { label:'HIV I & II (Rapid)',            category:'lab', fee_type:'hiv_rapid',             amount:300  },
    { label:'HBsAg (Hepatitis B)',           category:'lab', fee_type:'hbsag',                 amount:300  },
    { label:'Anti-HCV (Hepatitis C)',        category:'lab', fee_type:'anti_hcv',              amount:500  },
    { label:'Malaria (MP / RDT)',            category:'lab', fee_type:'malaria_mp_rdt',        amount:200  },
    { label:'Dengue NS1 Antigen',            category:'lab', fee_type:'dengue_ns1',            amount:500  },
    { label:'Dengue IgM / IgG',              category:'lab', fee_type:'dengue_igm_igg',        amount:600  },
    { label:'Leptospira IgM',                category:'lab', fee_type:'leptospira_igm',        amount:700  },
    { label:'ANA (Antinuclear Antibody)',    category:'lab', fee_type:'ana',                   amount:900  },
    { label:'Sputum AFB (ZN Stain)',         category:'lab', fee_type:'sputum_afb',            amount:200  },
    // ECG (12-lead) / ECHO (Echocardiography) deliberately NOT added here --
    // the radiology block below already has 'ECG'/'Echo (2D Echo)' (Session
    // 89/109); doctor.js's TEST_LABEL_OVERRIDES resolves those two lab-
    // ordered test names to these existing radiology entries instead of
    // creating priced duplicates.
    { label:'Coagulation Profile (PT/INR/aPTT)', category:'lab', fee_type:'coagulation_profile', amount:400 },
    { label:'PAP Smear',                     category:'lab', fee_type:'pap_smear',             amount:500  },
    { label:'FNAC (specify site)',           category:'lab', fee_type:'fnac',                  amount:800  },
    { label:'Procalcitonin (PCT)',           category:'lab', fee_type:'procalcitonin',         amount:1500 },

    // ── Radiology ──
    { label:'X-Ray',                     category:'radiology', fee_type:'xray',           amount:400  },
    { label:'Ultrasound (USG)',          category:'radiology', fee_type:'ultrasound',      amount:800  },
    { label:'CT Scan',                   category:'radiology', fee_type:'ct_scan',         amount:3500 },
    { label:'MRI',                       category:'radiology', fee_type:'mri',             amount:6000 },
    { label:'ECG',                       category:'radiology', fee_type:'ecg',             amount:300  },
    { label:'Echo (2D Echo)',            category:'radiology', fee_type:'echo',            amount:1200 },

    // ── Procedures — General / Nursing ──
    { label:'Wound Dressing',            category:'procedure', fee_type:'wound_dressing', amount:200  },
    { label:'Injection (IM/SC)',         category:'procedure', fee_type:'injection',       amount:100  },
    { label:'IV Cannula / Fluid',        category:'procedure', fee_type:'iv_cannula',      amount:300  },
    { label:'Nebulization',              category:'procedure', fee_type:'nebulization',    amount:150  },
    { label:'Physiotherapy Session',     category:'procedure', fee_type:'physiotherapy',   amount:300,  group:'physiotherapy' },

    // ── Kayachikitsa (Internal Medicine) ──
    { label:'Kayachikitsa — Snehapana (Internal Oleation)', category:'procedure', fee_type:'kay_snehapana', amount:600, dept:'KAY' },
    { label:'Kayachikitsa — Virechana Karma', category:'procedure', fee_type:'kay_virechana', amount:2000, dept:'KAY' },

    // ── Panchakarma ──
    { label:'Panchakarma — Abhyanga',        category:'procedure', fee_type:'pk_abhyanga',    amount:1200, dept:'PK' },
    { label:'Panchakarma — Shirodhara',      category:'procedure', fee_type:'pk_shirodhara',  amount:1500, dept:'PK' },
    { label:'Panchakarma — Vasti (Anuvasana)', category:'procedure', fee_type:'pk_vasti_anuvasana', amount:1500, dept:'PK' },
    { label:'Panchakarma — Vasti (Niruha)',  category:'procedure', fee_type:'pk_vasti_niruha', amount:1800, dept:'PK' },
    { label:'Panchakarma — Kizhi (Pinda Sweda)', category:'procedure', fee_type:'pk_kizhi',   amount:1800, dept:'PK' },
    { label:'Panchakarma — Nasya',           category:'procedure', fee_type:'pk_nasya',       amount:1000, dept:'PK' },
    { label:'Panchakarma — Pizhichil',       category:'procedure', fee_type:'pk_pizhichil',   amount:3500, dept:'PK' },
    { label:'Panchakarma — Udvartana (Powder Massage)', category:'procedure', fee_type:'pk_udvartana', amount:1000, dept:'PK' },
    { label:'Panchakarma — Shirovasti',      category:'procedure', fee_type:'pk_shirovasti',  amount:2000, dept:'PK' },
    { label:'Panchakarma — Raktamokshana',   category:'procedure', fee_type:'pk_raktamokshana', amount:1500, dept:'PK' },
    { label:'Panchakarma — Kati Vasti',      category:'procedure', fee_type:'pk_kati_vasti',  amount:800, dept:'PK'  },
    { label:'Panchakarma — Janu Vasti',      category:'procedure', fee_type:'pk_janu_vasti',  amount:800, dept:'PK'  },
    { label:'Panchakarma — Greeva Vasti',    category:'procedure', fee_type:'pk_greeva_vasti', amount:800, dept:'PK' },
    { label:'Panchakarma — Matra Basti',     category:'procedure', fee_type:'pk_matra_basti', amount:800, dept:'PK'  },

    // ── Shalya Tantra (Surgery) ──
    { label:'Shalya Tantra — Minor OT Procedure', category:'procedure', fee_type:'shal_minor_ot', amount:3000, dept:'SHAL' },
    { label:'Shalya Tantra — Kshara Sutra Application', category:'procedure', fee_type:'shal_ksharasutra', amount:1500, dept:'SHAL' },
    { label:'Shalya Tantra — Kshara Karma',  category:'procedure', fee_type:'shal_kshara_karma', amount:1200, dept:'SHAL' },
    { label:'Shalya Tantra — Agnikarma',     category:'procedure', fee_type:'shal_agnikarma', amount:800, dept:'SHAL'  },
    { label:'Shalya Tantra — Abscess Incision & Drainage', category:'procedure', fee_type:'shal_incision_drainage', amount:1000, dept:'SHAL' },
    { label:'Shalya Tantra — Fistula/Fissure Procedure', category:'procedure', fee_type:'shal_fistula', amount:5000, dept:'SHAL' },
    { label:'Shalya Tantra — Suture Removal', category:'procedure', fee_type:'shal_suture_removal', amount:200, dept:'SHAL' },

    // ── Shalakya Tantra (Ophthalmology / ENT) ──
    { label:'Shalakya — Netra Tarpana',      category:'procedure', fee_type:'shak_netra_tarpana', amount:1200, dept:'SHAK' },
    { label:'Shalakya — Netra Anjana',       category:'procedure', fee_type:'shak_netra_anjana', amount:500, dept:'SHAK'  },
    { label:'Shalakya — Aschyotana',         category:'procedure', fee_type:'shak_aschyotana', amount:400, dept:'SHAK'  },
    { label:'Shalakya — Karna Purana (Ear Oil Therapy)', category:'procedure', fee_type:'shak_karna_purana', amount:500, dept:'SHAK' },
    { label:'Shalakya — Kavala/Gandusha (Oral)', category:'procedure', fee_type:'shak_kavala_gandusha', amount:400, dept:'SHAK' },
    { label:'Shalakya — Pratimarsha Nasya',  category:'procedure', fee_type:'shak_pratimarsha_nasya', amount:300, dept:'SHAK' },
    { label:'Shalakya — Foreign Body Removal (Eye/Ear/Nose)', category:'procedure', fee_type:'shak_fb_removal', amount:500, dept:'SHAK' },

    // ── Stri Roga & Prasuti Tantra (OBG) ──
    { label:'Stri Roga — ANC Checkup',       category:'procedure', fee_type:'pst_anc_checkup', amount:300, dept:'PST'  },
    { label:'Stri Roga & Prasuti — Normal Delivery', category:'procedure', fee_type:'pst_normal_delivery', amount:8000, dept:'PST' },
    { label:'Stri Roga — Uttar Basti',       category:'procedure', fee_type:'pst_uttar_basti', amount:1500, dept:'PST' },
    { label:'Stri Roga — PNC Checkup',       category:'procedure', fee_type:'pst_pnc_checkup', amount:300, dept:'PST'  },
    { label:'Stri Roga — Yoni Prakshalana',  category:'procedure', fee_type:'pst_yoni_prakshalana', amount:500, dept:'PST' },

    // ── Kaumarabhritya (Paediatrics) ──
    { label:'Kaumarabhritya — Paediatric Consultation', category:'procedure', fee_type:'kau_consultation', amount:400, dept:'KAU' },
    { label:'Kaumarabhritya — Swarna Prashan', category:'procedure', fee_type:'kau_swarna_prashan', amount:200, dept:'KAU' },
    { label:'Kaumarabhritya — Vaccination',  category:'procedure', fee_type:'kau_vaccination', amount:500, dept:'KAU'  },
    { label:'Kaumarabhritya — Growth Monitoring', category:'procedure', fee_type:'kau_growth_monitoring', amount:200, dept:'KAU' },

    // ── Agada Tantra (Toxicology / Medical Jurisprudence) ──
    { label:'Agada Tantra — Poison Management / Emergency', category:'procedure', fee_type:'agd_poison_mgmt', amount:1500, dept:'AGD' },
    { label:'Agada Tantra — De-addiction Consultation', category:'procedure', fee_type:'agd_deaddiction', amount:500, dept:'AGD' },
    { label:'Agada Tantra — Medico-Legal Case Charges', category:'procedure', fee_type:'agd_mlc', amount:1000, dept:'AGD' },

    // ── Swasthavritta & Yoga ──
    { label:'Swasthavritta — Health Checkup Package', category:'procedure', fee_type:'sw_health_checkup', amount:2000, dept:'SW' },
    { label:'Swasthavritta — Yoga Session',  category:'procedure', fee_type:'sw_yoga_session', amount:200, dept:'SW'  },
  ],
  dispensary: [
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:50   },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:150  },
  ],
  college: [
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:100  },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:200,  notes:'Student OPD consultation' },
    { label:'Blood — CBC',               category:'lab', fee_type:'blood_cbc',            amount:200  },
    { label:'Urine — Routine',           category:'lab', fee_type:'urine_routine',        amount:100  },
    { label:'X-Ray',                     category:'radiology', fee_type:'xray',           amount:300  },
    { label:'Panchakarma — Abhyanga',    category:'procedure', fee_type:'pk_abhyanga',    amount:800  },
    { label:'Panchakarma — Shirodhara', category:'procedure', fee_type:'pk_shirodhara',  amount:1000 },
  ],
};
// teaching_hospital runs a full IPD Setup exactly like a plain hospital (SDM: 100 real
// beds) -- not the smaller college template, which has no IPD charges at all. Reuses the
// same array reference deliberately (Session 105: both dictionaries here were missing a
// teaching_hospital key entirely, so Quick Setup silently did nothing for SDM -- see
// openQuickSetup()'s "No quick-setup template for this facility type" early return).
QS_TEMPLATES.teaching_hospital = QS_TEMPLATES.hospital;
QS_TEMPLATES.pharma     = [];
QS_TEMPLATES.supplier   = [];
QS_TEMPLATES.dealer     = [];

const CAT_LABEL_MAP = { opd:'OPD', ipd:'IPD', lab:'Lab', procedure:'Procedure', radiology:'Radiology', custom:'Custom' };

window.openQuickSetup = function() {
  const tpl = QS_TEMPLATES[facType] || [];
  if (!tpl.length) { toast('No quick-setup template for this facility type.', 'error'); return; }

  document.getElementById('qs-title').textContent = `Quick Setup — ${fac.icon} ${fac.label}`;
  document.getElementById('qs-note').textContent  =
    `Select the services you offer. Suggested default fees are shown — you can edit amounts after saving.`;

  // Items already present (same category + fee_type) start unchecked and marked, so
  // re-opening Quick Setup after it's already been run doesn't look like a blank slate
  // inviting a second full run -- runQuickSetup() also re-checks fresh at click time as
  // the real guard (see there for why "already unchecked here" alone isn't enough).
  const existing = new Set(_allFees.map(f => `${f.category}::${f.fee_type}`));

  const grid = document.getElementById('qs-grid');
  grid.innerHTML = tpl.map((t, i) => {
    const already = existing.has(`${t.category}::${t.fee_type}`);
    return `
    <label class="qs-item${already ? ' qs-item-existing' : ''}" for="qs-${i}">
      <input type="checkbox" id="qs-${i}" value="${i}" ${already ? '' : 'checked'}/>
      <div class="qs-item-info">
        <div class="qs-item-name">${t.label}${already ? ' <span class="qs-existing-tag">Already added</span>' : ''}</div>
        <div class="qs-item-cat">${CAT_LABEL_MAP[t.category] || t.category}</div>
      </div>
      <div class="qs-item-amt">₹${t.amount}</div>
    </label>`;
  }).join('');

  document.getElementById('qs-overlay').classList.add('open');
};

window.closeQuickSetup = function() {
  document.getElementById('qs-overlay').classList.remove('open');
};

window.runQuickSetup = async function() {
  const tpl      = QS_TEMPLATES[facType] || [];
  const checked  = [...document.querySelectorAll('#qs-grid input[type=checkbox]:checked')];
  let   selected = checked.map(cb => tpl[parseInt(cb.value)]).filter(Boolean);

  if (!selected.length) { toast('Select at least one service.', 'error'); return; }

  const btn = document.getElementById('btn-qs-save');
  btn.classList.add('loading'); btn.disabled = true;

  // Re-check against the DB fresh, right before inserting -- not just the in-memory
  // `_allFees` snapshot from page load, and not just openQuickSetup()'s pre-unchecking
  // (a checkbox can always be re-checked). Found live on SDM: Quick Setup was run twice
  // with nothing stopping it, silently duplicating the entire 79-item catalog (158 rows,
  // 2 exact copies of everything, created hours apart) -- same bug class as Session 92's
  // opd-admin.html seeding race, same fix: query fresh at the moment of the actual write.
  const { data: existingRows } = await supabase
    .from('fee_structures')
    .select('category, fee_type')
    .eq('tenant_id', tenantId);
  const existing = new Set((existingRows || []).map(f => `${f.category}::${f.fee_type}`));
  const skippedCount = selected.filter(t => existing.has(`${t.category}::${t.fee_type}`)).length;
  selected = selected.filter(t => !existing.has(`${t.category}::${t.fee_type}`));

  if (!selected.length) {
    btn.classList.remove('loading'); btn.disabled = false;
    toast('All selected services already exist -- nothing new to add.', 'error');
    return;
  }

  const isSA = role === 'super_admin';
  // Resolve each item's dept code (e.g. 'PK') to this tenant's real department row by
  // ncism_code -- items with no dept code (general OPD/IPD/Lab/Radiology charges) stay
  // department_id null, landing in the "General / Hospital-wide" bucket. `group:` (Session
  // 109) is the equivalent tag for groups with no real department row (Administration,
  // OT, Physiotherapy, etc.) -- passed straight through to service_group.
  const deptByCode = Object.fromEntries(_allDepts.map(d => [d.ncism_code, d.id]));
  const rows = selected.map(t => ({
    tenant_id:       tenantId,
    label:           t.label,
    category:        t.category,
    fee_type:        t.fee_type,
    amount:          t.amount,
    notes:           t.notes || null,
    opd_id:          null,
    department_id:   t.dept ? (deptByCode[t.dept] || null) : null,
    service_group:   t.group || null,
    pricing_mode:    'flat',
    approval_status: isSA ? 'active' : 'pending',
    is_active:       isSA,
    created_by:      userId,
    ...(isSA ? { approved_by_super: userId } : {})
  }));

  const { error } = await supabase.from('fee_structures').insert(rows);

  btn.classList.remove('loading'); btn.disabled = false;

  if (error) { toast(safeErrorMessage(error, 'Could not add services.'), 'error'); return; }

  if (skippedCount) {
    toast(`${selected.length} service${selected.length > 1 ? 's' : ''} added, ${skippedCount} already existed and were skipped.`, 'success');
    closeQuickSetup();
    loadFees();
    return;
  }

  toast(`${selected.length} service${selected.length > 1 ? 's' : ''} added successfully.`, 'success');
  closeQuickSetup();
  loadFees();
};

// ── Toast ─────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Export (Session 107/109) ───────────────────────
function _matchesActiveGroup(f) {
  if (_activeGroup === 'all') return true;
  if (_activeGroup === 'general') return _isGeneralFee(f);

  const grp = GROUP_CONFIG.find(g => g.key === _activeGroup);
  if (!grp) return f.department_id === _activeGroup; // real department (Session 107 fallback)

  if (!grp.match(f)) return false;
  if (_activeSub !== 'all') return grp.matchSub(f, _activeSub);
  return true;
}

function _currentFilteredFees() {
  const q = document.getElementById('search-input').value.toLowerCase();
  return _allFees.filter(f => {
    if (!_matchesActiveGroup(f)) return false;
    if (q && !f.label?.toLowerCase().includes(q) &&
             !f.fee_type?.toLowerCase().includes(q) &&
             !f.notes?.toLowerCase().includes(q)) return false;
    return true;
  });
}

function _deptOrOpdLabel(f) {
  if (f.service_group) return SERVICE_GROUPS[f.service_group] || f.service_group;
  const deptName = f.department_id ? (_allDepts.find(d => d.id === f.department_id)?.name || '—') : null;
  return deptName || f.opds?.name || '—';
}

function _currentScopeLabel() {
  return _activeSubLabel ? `${_activeGroupLabel} — ${_activeSubLabel}` : _activeGroupLabel;
}

// Plain-text (no HTML/buttons) amount string for CSV/PDF exports -- the interactive
// range+expand widget in _tieredAmountDisplay() only makes sense on-screen.
function _exportAmountText(f) {
  if (f.pricing_mode !== 'tiered') return `₹${parseFloat(f.amount || 0).toLocaleString('en-IN')}`;
  const base   = parseFloat(f.amount) || 0;
  const active = _bedMultipliers.filter(m => m.is_active);
  if (!active.length) return `₹${base.toLocaleString('en-IN')} (base, no tiers configured)`;
  const amounts = active.map(m => base * parseFloat(m.multiplier));
  const min = Math.min(...amounts), max = Math.max(...amounts);
  return `₹${min.toLocaleString('en-IN', { maximumFractionDigits: 0 })}–₹${max.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (tiered by bed category)`;
}

window.exportCsv = function(scope) {
  const rows = scope === 'all' ? _allFees : _currentFilteredFees();
  if (!rows.length) { toast('No fees to export.', 'error'); return; }

  const header = ['Service', 'Category', 'OPD / Department', 'Amount (INR)', 'Status'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const statusLabels = { pending:'Pending', dept_approved:'Dept. Approved', active:'Active', rejected:'Rejected' };
  const lines = [header, ...rows.map(f => [
    f.label || '',
    CAT_LABELS[f.category] || f.category || '',
    _deptOrOpdLabel(f),
    _exportAmountText(f),
    statusLabels[f.approval_status] || f.approval_status || '',
  ])].map(r => r.map(esc).join(',')).join('\r\n');

  const blob = new Blob([lines], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `Fee_Structure_${(scope === 'all' ? 'All' : _currentScopeLabel()).replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

window.exportPdf = function(scope) {
  const rows = scope === 'all' ? _allFees : _currentFilteredFees();
  if (!rows.length) { toast('No fees to export.', 'error'); return; }

  const scopeLabel = scope === 'all' ? 'All Departments' : _currentScopeLabel();
  const _tenantCache = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
  const orgName = document.querySelector('.ax-name')?.textContent?.trim() || _tenantCache.name || 'Hospital';
  const now = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
  const statusLabels = { pending:'Pending', dept_approved:'Dept. Approved', active:'Active', rejected:'Rejected' };

  const bodyRows = rows.map((f, i) => `<tr class="${i % 2 === 0 ? '' : 'alt'}">
    <td>${_esc(f.label)}</td>
    <td>${_esc(CAT_LABELS[f.category] || f.category)}</td>
    <td>${_esc(_deptOrOpdLabel(f))}</td>
    <td class="ctr">${_esc(_exportAmountText(f))}</td>
    <td class="ctr">${_esc(statusLabels[f.approval_status] || f.approval_status)}</td>
  </tr>`).join('');

  // _x: safe close-tag builder -- \x3C = < avoids literal </ inside this <script> source,
  // same convention already used by bed-admin.js's downloadBedMapPDF().
  const _x = t => '\x3C/' + t + '>';
  const html = [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charset="UTF-8">',
    '<title>Fee Structure — ' + _esc(orgName) + _x('title'),
    '<style>',
    '  @page{size:A4;margin:14mm 12mm 12mm}',
    '  *{box-sizing:border-box;margin:0;padding:0}',
    '  body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#1a2e22}',
    '  .hdr{text-align:center;padding:8mm 0 6mm}',
    '  .hdr h1{font-size:18pt;color:#1a4a2e;margin-bottom:4px}',
    '  .hdr .org{font-size:12pt;color:#2d7a4f;font-weight:600;margin-bottom:6px}',
    '  .hdr .meta{font-size:9pt;color:#6b7280}',
    '  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:9pt}',
    '  th{background:#1a4a2e;color:#fff;padding:6px 8px;text-align:left;font-size:8.5pt}',
    '  td{border:1px solid #e2e8f0;padding:5px 8px}',
    '  .alt td{background:#f9fafb}',
    '  .ctr{text-align:center}',
    '</style>',
    _x('head'),
    '<body>',
    '<div class="hdr">',
    '  <h1>Fee Structure' + _x('h1'),
    '  <div class="org">' + _esc(orgName) + _x('div'),
    '  <div class="meta">' + _esc(scopeLabel) + ' &middot; Generated ' + now + ' &middot; ' + rows.length + ' service' + (rows.length !== 1 ? 's' : '') + _x('div'),
    _x('div'),
    '<table><thead><tr>',
    '<th>Service</th><th style="width:110px">Category</th><th style="width:170px">OPD / Department</th><th class="ctr" style="width:90px">Amount</th><th class="ctr" style="width:100px">Status</th>',
    _x('tr') + _x('thead'),
    '<tbody>' + bodyRows + _x('tbody'),
    _x('table'),
    _x('body') + _x('html')
  ].join('\n');

  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked. Please allow pop-ups for this site and try again.', 'error'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
};

// ── Bed Category Multipliers (Session 109) ────────
async function loadBedMultipliers() {
  const { data } = await supabase
    .from('bed_category_multipliers')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('multiplier');
  _bedMultipliers = data || [];
}

window.openBedMultipliers = function() {
  const wrap = document.getElementById('bcm-grid');
  const readOnly = role === 'accountant';

  wrap.innerHTML = _bedMultipliers.length
    ? _bedMultipliers.map(m => `
      <div class="bcm-row">
        <span class="bcm-label">${_esc(BED_TYPE_LABELS[m.bed_type] || m.bed_type)}</span>
        <input type="number" min="0" step="0.05" class="bcm-mult" data-bed="${_esc(m.bed_type)}" value="${m.multiplier}" ${readOnly ? 'disabled' : ''}/>
        <label class="bcm-active"><input type="checkbox" data-bed-active="${_esc(m.bed_type)}" ${m.is_active ? 'checked' : ''} ${readOnly ? 'disabled' : ''}/> Active</label>
      </div>`).join('')
    : '<div class="empty-text">No bed categories configured for this tenant yet.</div>';

  document.getElementById('btn-bcm-save').style.display = readOnly ? 'none' : 'block';
  document.getElementById('bcm-overlay').classList.add('open');
};

window.closeBedMultipliers = function() {
  document.getElementById('bcm-overlay').classList.remove('open');
};

window.saveBedMultipliers = async function() {
  const rows = _bedMultipliers.map(m => {
    const multInput   = document.querySelector(`.bcm-mult[data-bed="${m.bed_type}"]`);
    const activeInput = document.querySelector(`[data-bed-active="${m.bed_type}"]`);
    return {
      tenant_id:  tenantId,
      bed_type:   m.bed_type,
      multiplier: parseFloat(multInput?.value) || 1.0,
      is_active:  activeInput?.checked ?? m.is_active,
    };
  });

  const btn = document.getElementById('btn-bcm-save');
  btn.classList.add('loading'); btn.disabled = true;

  const { error } = await supabase
    .from('bed_category_multipliers')
    .upsert(rows, { onConflict: 'tenant_id,bed_type' });

  btn.classList.remove('loading'); btn.disabled = false;

  if (error) { toast(safeErrorMessage(error, 'Could not save bed category pricing.'), 'error'); return; }

  toast('Bed category pricing updated.', 'success');
  closeBedMultipliers();
  await loadBedMultipliers();
  renderTable();
};

// ── Boot ──────────────────────────────────────────
window.toast = toast;
populateGroupSelect();
// Seeds default bed-category multipliers for this tenant on first-ever visit here (Session
// 99's tenant_migrations registry). supabase-js's query builder is a thenable, not a real
// Promise -- .catch() on it throws (documented gotcha, TECHNICAL_REFERENCE.md) -- so this
// must be try/await, not .then()/.catch() chaining. Harmless no-op for accountant role
// (the RPC checks super_admin/dept_admin internally) and once already applied.
try { await supabase.rpc('apply_silent_pending_migrations'); } catch (e) { /* non-fatal */ }
await loadOPDs();
await loadDepartments();
await loadBedMultipliers();
await loadFees();
