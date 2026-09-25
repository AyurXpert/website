import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { isNCISMType, ncismRequiredBeds } from '../config/ncism.js';
import { logAudit } from '../core/auditLogger.js';
import { computeRoomTariff } from '../modules/billing/roomTariff.js';
import { computeIpdChargesToDate } from '../modules/billing/ipdChargesToDate.js';
import { todayLocalStr, localDateStr } from '../utils/dateUtils.js';
import { fetchSamsarjanaHomeChart, buildDischargeSummaryHtml, printDischargeHtml } from '../modules/ipd/dischargePrint.js';

/*
  SQL to run in Supabase (one time) before using this page:

  ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE beds ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ipd_admissions ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "tenant_departments" ON departments FOR ALL TO authenticated
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
  CREATE POLICY "tenant_beds" ON beds FOR ALL TO authenticated
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
  CREATE POLICY "tenant_ipd" ON ipd_admissions FOR ALL TO authenticated
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));

  -- OT Procedures table (NCISM §47(b))
  CREATE TABLE IF NOT EXISTS ot_procedures (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    patient_id uuid NOT NULL REFERENCES patients(id),
    ipd_admission_id uuid REFERENCES ipd_admissions(id),
    procedure_name text NOT NULL,
    procedure_date date NOT NULL,
    procedure_time time,
    surgeon_id uuid REFERENCES profiles(id),
    anaesthesia_type text,
    aseptic_confirmed boolean DEFAULT false,
    ncism_safety_checklist boolean DEFAULT false,
    pre_op_notes text,
    post_op_notes text,
    status text DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed','cancelled')),
    created_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES profiles(id)
  );
  ALTER TABLE ot_procedures ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "tenant_ot_procedures" ON ot_procedures FOR ALL TO authenticated
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
  GRANT SELECT, INSERT, UPDATE ON ot_procedures TO authenticated;
*/

// Session 302 fix -- cashier/accountant/finance_manager are in BILLING_ROLES (Generate
// Bill since Session 114, the Account drawer now) but were never let onto this page at
// all, redirected straight to their ROLE_HOME by this allowlist -- found live testing
// the Account drawer as cashier.
await requireAuth(['super_admin','dept_admin','doctor','receptionist','nurse','cashier','accountant','finance_manager']);
initNavbar();
wireDelegatedEvents();
const tenantId = getCurrentTenantId();
const myProfile = getCurrentProfile();
const myRole    = getCurrentRole();
const _ctx      = { tenantId, userId: myProfile.id, userName: myProfile.full_name };
// Session 114 -- who may actually trigger a discharge/exit. The page itself
// still allows receptionist (billing-clerk designation needs page access for
// the later billing step), but the discharge TRIGGER is doctor/nurse/admin
// only -- closes the "any receptionist can discharge with zero checks" gap.
const DISCHARGE_ROLES = ['doctor','nurse','super_admin','dept_admin'];
// Session 114 -- who may generate the final IPD bill. Matches finance.js's
// own ALLOWED list (billing-clerk designation is a receptionist role) --
// not doctor/nurse, whose job ends once charges are locked.
const BILLING_ROLES = ['receptionist','cashier','accountant','finance_manager','super_admin','dept_admin'];
// Session 205 (cont.) -- who may actually CREATE an admission. Real hospital process:
// a doctor advises admission (doctor.html), reception collects the advance and admits
// -- never a doctor/nurse directly. Matches _ipd_admissions_insert_ok() server-side.
const ADMIT_ROLES = ['receptionist','super_admin','dept_admin'];

let _admissions  = [];
let _depts       = [];
let _allBeds     = [];
let _doctors     = [];
let _opdDoctors  = [];   // { doctor_id, opd_id } — for NCISM ward auth
let _selectedPatient = null;
let _selectedVisitId = null;

// NABH Care Plan (AAC.3 CORE) — declared here (not near its own section further down) because
// renderTable() reads _carePlanAdmIds, and renderTable() runs as part of loadAll()'s continuation
// before the script's top-level execution ever reaches a later `const` for it (TDZ ReferenceError
// once a real admission exists to render -- silent before that since .map() never ran the callback).
const _carePlanAdmIds = new Set();
async function _loadCarePlanIds() {
  const { data } = await supabase.from('ipd_care_plans')
    .select('ipd_admission_id').eq('tenant_id', tenantId);
  _carePlanAdmIds.clear();
  (data||[]).forEach(r => _carePlanAdmIds.add(r.ipd_admission_id));
}

// Session 294 -- PKTT (Panchakarma Treatment Tracker): admission_id -> {planId, labels}
// for every admission with a linked pk_care_plans row, so the 🌸 icon only renders for
// a real Panchakarma admission (never a dead-end click for every other department).
const _pkCarePlanByAdmId = new Map();
async function _loadPkCarePlanIds() {
  const { data } = await supabase.from('pk_care_plans')
    .select('id, ipd_admission_id, status, pk_care_plan_protocols(protocol_label)')
    .eq('tenant_id', tenantId).not('ipd_admission_id', 'is', null);
  _pkCarePlanByAdmId.clear();
  (data||[]).forEach(r => _pkCarePlanByAdmId.set(r.ipd_admission_id, {
    planId: r.id, status: r.status,
    labels: (r.pk_care_plan_protocols||[]).map(p => p.protocol_label).join(', '),
  }));
}

// NCISM §7 ward authorisation: ward ncism_code → authorised dept ncism_codes
const WARD_AUTH = {
  KAY:  ['KAY'],
  PK:   ['PK', 'SW'],   // Swasthavritta also authorised for PK ward (ritusodhana)
  SHAL: ['SHAL'],
  SHAK: ['SHAK'],
  PST:  ['PST'],
  KAU:  ['KAU'],
  AGD:  ['AGD'],
};
let _searchTimer     = null;

// ── Load all ──────────────────────────────────────────────────────────────────
window.loadAll = async function loadAll() {
  const [admRes, deptRes, bedRes, docRes, opdDocRes] = await Promise.all([
    supabase
      .from('ipd_admissions')
      .select(`
        id, tenant_id, admission_date, admitted_at, discharged_at, charges_locked_at,
        status, disposition, diagnosis_primary, diet_type, notes, advance_amount_collected,
        discharge_diagnosis_ayurveda, discharge_diagnosis_icd10, discharge_medications,
        discharge_pathya_apathya, discharge_pk_procedures, discharge_followup_date, discharge_condition,
        discharge_course, discharge_treatment_given, discharge_investigations, discharge_advice,
        patients(id, name, phone, abha_number, abha_address, age, gender),
        beds(id, bed_number, ward_name, bed_type, department_id),
        departments(id, name, ncism_code),
        profiles!admitting_doctor_id(id, full_name)
      `)
      .eq('tenant_id', tenantId)
      .order('admitted_at', { ascending: false }),
    supabase.from('departments').select('id,name,ncism_code,opd_id').eq('tenant_id', tenantId).eq('is_active', true).order('name'),
    supabase.from('beds').select('id,bed_number,ward_name,bed_type,department_id,is_pg_allocated,status').eq('tenant_id', tenantId).order('bed_number'),
    supabase.from('profiles').select('id,full_name').eq('tenant_id', tenantId).eq('role','doctor').eq('is_active', true).order('full_name'),
    supabase.from('opd_doctors').select('doctor_id,opd_id').eq('tenant_id', tenantId),
  ]);

  if (admRes.error) {
    _alert('error', safeErrorMessage(admRes.error, 'Failed to load admissions.')
      + (admRes.error.code === '42501' ? ' — Run the RLS SQL in the browser console comments.' : ''));
    return;
  }

  _admissions = admRes.data || [];
  _depts      = deptRes.data || [];
  _allBeds    = bedRes.data || [];
  _doctors    = docRes.data || [];
  _opdDoctors = opdDocRes.data || [];

  // Session 294 -- refreshed on every loadAll(), not just at page init, so a
  // just-admitted PK Care Plan patient shows the 🌸 icon without a full page reload.
  await _loadPkCarePlanIds();

  _populateDeptFilters();
  _populateDoctorSelect();
  renderStats();
  _renderBedComplianceAlert();
  applyFilters();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  // Session 114 -- "admitted" now covers clinically_discharged too (patient
  // hasn't physically left the ward yet at that stage); "today discharged"
  // uses charges_locked_at (the real bed-vacate moment), not discharged_at
  // (now stamped at MRD's final release, which can trail actual departure).
  const admitted   = _admissions.filter(a => ['admitted','clinically_discharged'].includes(a.status)).length;
  const vacant     = _allBeds.filter(b => b.status === 'vacant').length;
  const today      = todayLocalStr();
  const todayDis   = _admissions.filter(a =>
    a.charges_locked_at && a.charges_locked_at.slice(0,10) === today
  ).length;

  const currentAdm = _admissions.filter(a => ['admitted','clinically_discharged'].includes(a.status));
  let avgLos = '—';
  if (currentAdm.length) {
    const now = Date.now();
    const totalDays = currentAdm.reduce((sum, a) => {
      const ms = now - new Date(a.admitted_at).getTime();
      return sum + ms / 86400000;
    }, 0);
    avgLos = (totalDays / currentAdm.length).toFixed(1);
  }

  document.getElementById('stat-admitted').textContent   = admitted;
  document.getElementById('stat-vacant').textContent     = vacant;
  document.getElementById('stat-avg-los').textContent    = avgLos;
  document.getElementById('stat-today-dis').textContent  = todayDis;
}

// ── NCISM bed compliance alert (doctor-facing) ────────────────────────────────
async function _renderBedComplianceAlert() {
  const wrap = document.getElementById('ipd-bed-alert');
  if (!wrap) return;

  // NCISM bed ratios (Table-8) only bind teaching institutions — a plain hospital
  // tenant has no UG intake to size the ratio against (Session 96, matches the same
  // fix already applied to admin.js/opd-admin.js).
  const { data: tenant } = await supabase
    .from('tenants').select('ug_intake,type').eq('id', tenantId).single();
  if (!tenant || !isNCISMType(tenant.type) || !tenant.ug_intake) {
    wrap.innerHTML = ''; return;
  }

  const ugIntake = tenant.ug_intake;
  const UG_BED_RATIOS = {KAY:.20,PK:.25,SHAL:.20,SHAK:.10,KAU:.10,AGD:.05,PST:.10};

  // Use already-loaded _depts and _allBeds
  const bedCountByDept = {};
  const occCountByDept = {};
  _allBeds.forEach(b => {
    bedCountByDept[b.department_id] = (bedCountByDept[b.department_id] || 0) + 1;
    if (b.status === 'occupied') occCountByDept[b.department_id] = (occCountByDept[b.department_id] || 0) + 1;
  });

  const issues = [];
  _depts.forEach(d => {
    const ratio = UG_BED_RATIOS[d.ncism_code];
    if (!ratio) return;
    const required = ncismRequiredBeds(ratio, ugIntake).ug;
    const actual   = bedCountByDept[d.id] || 0;
    const occupied = occCountByDept[d.id] || 0;
    const occPct   = actual > 0 ? Math.round(occupied / actual * 100) : null;

    if (actual < required) {
      issues.push({ severity:'critical', dept:d.name,
        msg:`${actual}/${required} beds configured — add ${required - actual} more` });
    } else if (occPct !== null && occPct < 60) {
      const sev = occPct < 45 ? 'critical' : 'warning';
      issues.push({ severity: sev, dept: d.name,
        msg:`Occupancy ${occPct}% — NCISM minimum is 60%` });
    }
  });

  if (!issues.length) {
    wrap.innerHTML = `<div class="bed-alert green">
      <div class="bed-alert-icon">✅</div>
      <div class="bed-alert-body">
        <div class="bed-alert-title">All IPD departments meeting NCISM bed requirements</div>
      </div>
    </div>`;
    return;
  }

  const hasCritical = issues.some(i => i.severity === 'critical');
  const cls  = hasCritical ? 'red' : 'amber';
  const icon = hasCritical ? '🚨' : '⚠️';
  const title = hasCritical
    ? `NCISM IPD Alert — ${issues.length} critical issue${issues.length > 1 ? 's' : ''} need attention`
    : `NCISM IPD Warning — ${issues.length} department${issues.length > 1 ? 's' : ''} below occupancy threshold`;

  wrap.innerHTML = `<div class="bed-alert ${cls}">
    <div class="bed-alert-icon">${icon}</div>
    <div class="bed-alert-body">
      <div class="bed-alert-title">${title}</div>
      <div class="bed-alert-rows">
        ${issues.map(i => `<div class="bed-alert-row">
          <span class="bed-alert-dept">${_esc(i.dept)}</span>
          <span>${_esc(i.msg)}</span>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}

// ── Populate selects ──────────────────────────────────────────────────────────
function _populateDeptFilters() {
  // Session 294 -- real gap found live (matches doctor.js's Admission-Advice tab, fixed
  // the same session): both selects used to list every active department in the org
  // (Accounts, Security, Laundry, Diagnostics, House Keeping, Finance...). "adm-dept" is
  // the Admit Patient modal's Department picker (drives loadVacantBeds()) -- none of
  // those can actually receive an admission. "filter-dept" browses EXISTING admissions
  // by department -- initially left unfiltered on the assumption it was a harmless
  // display filter, but Dr. Venkatesh correctly pointed out an admission can only ever
  // be tagged to a bedded department in the first place (enforced by the adm-dept fix
  // itself), so a non-bedded option there is dead weight, never matching a single real
  // row -- filtered the same way now. Ground-truth filter is "does this department own
  // any real row in `beds`" -- `_allBeds` is already loaded in full by loadAll(), so no
  // extra query is needed here, unlike doctor.js's equivalent fix.
  const beddedDeptIds = new Set(_allBeds.map(b => b.department_id).filter(Boolean));
  ['filter-dept','adm-dept'].forEach(id => {
    const sel = document.getElementById(id);
    const saved = sel.value;
    const isFilter = id === 'filter-dept';
    sel.innerHTML = isFilter ? '<option value="">All Departments</option>' : '<option value="">— Select department —</option>';
    _depts.filter(d => beddedDeptIds.has(d.id)).forEach(d => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name;
      sel.appendChild(o);
    });
    if (saved) sel.value = saved;
  });
}

function _populateDoctorSelect() {
  // Initial state — no dept selected yet
  const sel = document.getElementById('adm-doctor');
  sel.innerHTML = '<option value="">— Select department first —</option>';
  const note = document.getElementById('adm-doctor-note');
  if (note) note.innerHTML = '';
}

function _getAuthorisedDoctors(deptId) {
  const dept = _depts.find(d => d.id === deptId);
  if (!dept) return { list: _doctors, filtered: false };

  const authCodes = WARD_AUTH[dept.ncism_code];
  if (!authCodes) return { list: _doctors, filtered: false }; // non-clinical — show all

  // Find opd_ids for all authorised ncism_codes
  const authOpdIds = new Set(
    _depts.filter(d => authCodes.includes(d.ncism_code) && d.opd_id).map(d => d.opd_id)
  );
  if (!authOpdIds.size) return { list: _doctors, filtered: false }; // no OPD mappings — fallback

  // Get doctor IDs assigned to those OPDs
  const authDocIds = new Set(
    _opdDoctors.filter(od => authOpdIds.has(od.opd_id)).map(od => od.doctor_id)
  );
  if (!authDocIds.size) return { list: _doctors, filtered: false }; // no assignments — fallback

  const list = _doctors.filter(d => authDocIds.has(d.id));
  return { list, filtered: true, deptName: dept.name, authCodes };
}

function _filterDoctorsByDept(deptId) {
  const sel  = document.getElementById('adm-doctor');
  const note = document.getElementById('adm-doctor-note');
  sel.value  = '';

  if (!deptId) {
    sel.innerHTML = '<option value="">— Select department first —</option>';
    if (note) note.innerHTML = '';
    return;
  }

  const { list, filtered, deptName, authCodes } = _getAuthorisedDoctors(deptId);

  sel.innerHTML = '<option value="">— Select doctor —</option>';
  list.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.full_name;
    sel.appendChild(o);
  });

  if (!note) return;
  if (filtered && list.length) {
    const extra = authCodes.length > 1 ? ` (incl. ${authCodes.slice(1).join(', ')} for this ward)` : '';
    note.innerHTML = `<span style="color:#1a4a2e;font-size:11px;font-weight:600">
      ✓ ${list.length} authorised consultant${list.length > 1 ? 's' : ''} for ${_esc(deptName)}${extra} — NCISM §7
    </span>`;
  } else if (filtered && !list.length) {
    note.innerHTML = `<span style="color:#c9902a;font-size:11px;font-weight:600">
      ⚠ No OPD assignments found for this ward — showing all doctors. Assign doctors in OPD Admin first.
    </span>`;
  } else {
    note.innerHTML = `<span style="color:var(--text-muted);font-size:11px">Showing all doctors (non-clinical ward)</span>`;
  }
}

// ── Filter + render table ─────────────────────────────────────────────────────
window.applyFilters = function() {
  const search     = document.getElementById('filter-search').value.toLowerCase();
  const deptFilter = document.getElementById('filter-dept').value;
  const statFilter = document.getElementById('filter-status').value;

  // Session 114 -- status (lifecycle) and disposition (reason) are split.
  // 'admitted' spans both admitted and clinically_discharged; 'discharged'
  // means the terminal status with a normal-discharge disposition; LAMA/
  // Transferred/Deceased now live in disposition, never status.
  let rows = _admissions;
  if (statFilter === 'admitted')        rows = rows.filter(a => ['admitted','clinically_discharged'].includes(a.status));
  else if (statFilter === 'discharged') rows = rows.filter(a => a.status === 'discharged' && (a.disposition||'discharged') === 'discharged');
  else if (statFilter)                  rows = rows.filter(a => a.disposition === statFilter);
  if (deptFilter) rows = rows.filter(a => a.departments?.id === deptFilter);
  if (search) rows = rows.filter(a => (a.patients?.name || '').toLowerCase().includes(search));

  renderTable(rows);
};

function renderTable(rows) {
  const tbody = document.getElementById('adm-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty">No admissions found.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(a => {
    const pt      = a.patients || {};
    const bed     = a.beds || {};
    const dept    = a.departments || {};
    const doctor  = a.profiles || {};
    const days    = _daysSince(a.admitted_at);
    const canDischarge = a.status === 'admitted';
    const canOrderDischarge = canDischarge && DISCHARGE_ROLES.includes(myRole);
    const canGenerateBill = a.status === 'charges_locked' && BILLING_ROLES.includes(myRole);
    const admittedHrsAgo = a.admitted_at ? (Date.now() - new Date(a.admitted_at)) / 3600000 : 999;
    const needsCarePlan  = canDischarge && !_carePlanAdmIds.has(a.id) && admittedHrsAgo < 48;
    const pkPlan          = _pkCarePlanByAdmId.get(a.id);

    const genderAge = [pt.gender, pt.age ? pt.age+'y' : ''].filter(Boolean).join(' · ');

    return `<tr>
      <td>
        <div class="pt-name">${_esc(pt.name || '—')}</div>
        <div class="pt-meta">${_esc(pt.phone || '')}${genderAge ? ' · ' + genderAge : ''}</div>
      </td>
      <td>
        <span class="bed-chip">${_esc(bed.bed_number || '—')}</span>
        ${bed.ward_name ? `<div class="pt-meta" style="margin-top:4px">${_esc(bed.ward_name)}</div>` : ''}
      </td>
      <td>${_esc(dept.name || '—')}</td>
      <td>${_esc(doctor.full_name || '—')}</td>
      <td>
        <div>${_fmt(a.admission_date)}</div>
        <span class="days-chip">${days}d</span>
        ${needsCarePlan ? `<div style="font-size:9px;color:#c0392b;font-weight:700;margin-top:3px">⚠ No Care Plan</div>` : ''}
      </td>
      <td>${_statusBadgeHtml(a)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-onclick="openNotesDrawer" data-onclick-a0="${a.id}" title="View details">&#128203;</button>
          <button class="icon-btn" data-onclick="openCarePlanDrawer" data-onclick-a0="${a.id}" data-onclick-a1="${a.patients?.id||''}" title="Care Plan (NABH CORE)" style="font-size:10px;font-weight:700;color:#7a4a00;border-color:#e8d08a;background:#fffdf0">CP</button>
          <button class="icon-btn" data-onclick="openWardRoundsDrawer" data-onclick-a0="${a.id}" title="Ward Round Notes" style="font-size:10px;font-weight:700;color:#1a4a2e;border-color:#b8ddc6;background:#e8f5ee">WR</button>
          <button class="icon-btn" data-onclick="openDietDrawer" data-onclick-a0="${a.id}" title="Palha-Diet Indent" style="font-size:11px">🍲</button>
          <button class="icon-btn" data-onclick="printDischargeSummary" data-onclick-a0="${a.id}" title="Print Discharge Summary" style="font-size:11px">🖨</button>
          ${canDischarge ? `<button class="icon-btn" data-onclick="openOtDrawer" data-onclick-a0="${a.id}" title="OT Procedures" style="font-size:10px;font-weight:700;color:#1a4080;border-color:#a8c8f0;background:#e3f0ff">OT</button>` : ''}
          ${pkPlan ? `<button class="icon-btn" data-onclick="openPkTrackerDrawer" data-onclick-a0="${a.id}" title="Panchakarma Treatment Tracker — ${_esc(pkPlan.labels)}" style="font-size:11px;font-weight:700;color:#1a6b3a;border-color:#a8d8b8;background:#e8f5ee">🌸</button>` : ''}
          ${canOrderDischarge ? `<button class="icon-btn danger" data-onclick="openDischargeDrawer" data-onclick-a0="${a.id}" title="Order Discharge / Exit">&#10006;</button>` : ''}
          ${canGenerateBill ? `<button class="icon-btn" data-onclick="openGenerateBillDrawer" data-onclick-a0="${a.id}" title="Generate IPD Bill" style="font-size:10px;font-weight:700;color:#1a4a2e;border-color:#b8ddc6;background:#e8f5ee">💰</button>` : ''}
          ${BILLING_ROLES.includes(myRole) ? `<button class="icon-btn" data-onclick="openAccountDrawer" data-onclick-a0="${a.id}" title="Account — deposits, payments, receipts" style="font-size:11px">💳</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Admit drawer ──────────────────────────────────────────────────────────────
window.openAdmitDrawer = function() {
  _selectedPatient = null;
  _selectedVisitId = null;
  document.getElementById('pt-search').value = '';
  document.getElementById('patient-results').innerHTML = '';
  document.getElementById('patient-results').classList.remove('show');
  document.getElementById('spt').classList.remove('show');
  document.getElementById('spt-open-adm-warn').style.display = 'none';
  document.getElementById('search-area').style.display = '';
  document.getElementById('btn-step1-next').disabled = true;
  document.getElementById('adm-dept').value    = '';
  document.getElementById('adm-doctor').value  = '';
  document.getElementById('adm-diagnosis').value = '';
  document.getElementById('adm-notes').value   = '';
  document.getElementById('adm-diet').value    = '';
  document.getElementById('adm-bed-id').value  = '';
  document.getElementById('adm-is-mlc').checked = false;
  document.getElementById('mlc-fields').style.display = 'none';
  document.getElementById('adm-date').value    = todayLocalStr();
  document.getElementById('bed-picker').innerHTML = '<span class="bed-picker-empty">Select a department first</span>';
  // Session 205 (cont.) -- advance payment + advice-reference reset. _currentAdvice
  // is only ever set again by the ?advice_id= boot block, AFTER this function returns.
  _currentAdvice = null;
  document.getElementById('adm-advance-amount').value = '';
  document.getElementById('adm-advance-mode').value   = '';
  document.getElementById('adm-advance-reference').value = '';
  document.getElementById('adm-advance-ref-field').style.display = 'none';
  document.getElementById('adm-advice-banner').style.display = 'none';
  _populateDoctorSelect(); // reset to "select department first" state
  goStep(1);
  document.getElementById('admit-overlay').classList.add('open');
};

window.closeAdmitDrawer = function() {
  document.getElementById('admit-overlay').classList.remove('open');
};

// Session 303 -- the reference field only means anything for a non-cash mode
// (it's what the advance's ledger receipt is matched against later).
window.onAdvanceModeChange = function(mode) {
  const field = document.getElementById('adm-advance-ref-field');
  field.style.display = mode && mode !== 'cash' ? '' : 'none';
  if (!mode || mode === 'cash') document.getElementById('adm-advance-reference').value = '';
};

window.goStep = function(n) {
  n = Number(n);
  if (n === 2 && !_selectedPatient) return;

  [1,2].forEach(i => {
    document.getElementById(`step-${i}`).classList.toggle('active', i === n);
    document.getElementById(`step-lbl-${i}`).className = 'step' + (i === n ? ' active' : i < n ? ' done' : '');
  });

  document.getElementById('btn-admit-back').style.display  = n === 2 ? '' : 'none';
  // Session 205 (cont.): the drawer itself stays open to doctor/nurse for viewing
  // context (bed availability, etc.), but the actual save action is now reception/
  // admin only -- matches the RLS INSERT gate (_ipd_admissions_insert_ok()) and the
  // create_ipd_admission() RPC's own server-side check. A clear note, not a silent
  // disable.
  const canAdmit = n === 2 && ADMIT_ROLES.includes(myRole);
  document.getElementById('btn-admit-save').style.display  = canAdmit ? '' : 'none';
  document.getElementById('admit-role-note').style.display = (n === 2 && !canAdmit) ? '' : 'none';

  if (n === 2 && _selectedPatient) {
    document.getElementById('spt2-name').textContent = _selectedPatient.name;
    const meta = [_selectedPatient.phone, _selectedPatient.gender, _selectedPatient.age ? _selectedPatient.age+'y' : ''].filter(Boolean).join(' · ');
    document.getElementById('spt2-meta').textContent = meta;
  }
};

// ── Patient search ─────────────────────────────────────────────────────────────
window.onPatientSearch = function(val) {
  clearTimeout(_searchTimer);
  if (val.length < 2) {
    document.getElementById('patient-results').classList.remove('show');
    return;
  }
  document.getElementById('search-spinner').classList.add('show');
  _searchTimer = setTimeout(() => _doSearch(val), 350);
};

let _ptSearchResults = [];

async function _doSearch(val) {
  const isPhone = /^\d+$/.test(val.trim());
  let query = supabase.from('patients').select('id,name,phone,abha_number,age,gender').eq('tenant_id', tenantId).limit(8);
  if (isPhone) query = query.ilike('phone', val + '%');
  else         query = query.ilike('name', '%' + val + '%');

  const { data } = await query;
  document.getElementById('search-spinner').classList.remove('show');
  const res = document.getElementById('patient-results');

  if (!data || !data.length) {
    res.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:6px 0">No patients found. Register at Reception first.</div>`;
    res.classList.add('show');
    return;
  }

  _ptSearchResults = data;
  res.innerHTML = data.map(p => {
    const meta = [p.phone, p.gender, p.age ? p.age+'y' : '', p.abha_number ? 'ABHA' : ''].filter(Boolean).join(' · ');
    return `<div class="patient-result-item" data-onclick="selectPatientById" data-onclick-a0="${p.id}">
      <div class="pr-name">${_esc(p.name)}</div>
      <div class="pr-meta">${_esc(meta)}</div>
    </div>`;
  }).join('');
  res.classList.add('show');
}

window.selectPatientById = function(id) {
  const p = _ptSearchResults.find(r => r.id === id);
  if (p) selectPatient(p);
};

window.selectPatient = function(p, visitId) {
  _selectedPatient = p;
  _selectedVisitId = visitId || null; // only the explicit doctor.html handoff visit -- never a guessed one
  document.getElementById('spt-name').textContent = p.name;
  const meta = [p.phone, p.gender, p.age ? p.age+'y' : ''].filter(Boolean).join(' · ');
  document.getElementById('spt-meta').textContent = meta;
  document.getElementById('spt').classList.add('show');
  document.getElementById('search-area').style.display = 'none';
  document.getElementById('patient-results').classList.remove('show');
  document.getElementById('btn-step1-next').disabled = false;
  _prefillAdmissionDiagnosis(p.id, visitId);
  _checkOpenAdmissionWarning(p.id);
};

// Surfaces the same open-admission check saveAdmission() enforces, but at patient-selection
// time -- so front-desk staff learn a patient is already admitted before filling in the whole
// form, not only after clicking Admit. saveAdmission()'s own fresh DB check is the real gate;
// this is just earlier, friendlier feedback.
async function _checkOpenAdmissionWarning(patientId) {
  const warn = document.getElementById('spt-open-adm-warn');
  warn.style.display = 'none';
  const { data: openAdms } = await supabase.from('ipd_admissions')
    .select('id, beds(bed_number)')
    .eq('tenant_id', tenantId).eq('patient_id', patientId)
    .neq('status', 'discharged');
  if (_selectedPatient?.id !== patientId) return; // selection changed while this was in flight
  if (openAdms && openAdms.length) {
    const bedLabel = openAdms[0].beds?.bed_number || 'a bed';
    warn.textContent = `⚠ This patient already has an open IPD admission (${bedLabel}). Discharge that admission first — a new one can't be created until then.`;
    warn.style.display = 'block';
    document.getElementById('btn-step1-next').disabled = true;
  }
}

// Pre-fills the Admission Order's diagnosis field from the patient's consultation record --
// editable afterward, never forced -- so a diagnosis the doctor already documented doesn't
// have to be retyped from scratch by whoever runs the Admit Patient flow. Prefers the exact
// visit that triggered admission (doctor.html's "Open IPD Admission" link passes ?visit_id=);
// falls back to the patient's most recent visit for a plain manual search-and-admit.
async function _prefillAdmissionDiagnosis(patientId, visitId) {
  document.getElementById('adm-diagnosis').value = '';
  let targetVisitId = visitId || null;
  if (!targetVisitId) {
    const { data: recentVisit } = await supabase.from('visits')
      .select('id').eq('tenant_id', tenantId).eq('patient_id', patientId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    targetVisitId = recentVisit?.id || null;
  }
  if (!targetVisitId) return;
  const { data: notes } = await supabase.from('consultation_notes')
    .select('ayurveda_diagnosis, modern_diagnosis, diagnosis_namc_label, diagnosis_icd10_label')
    .eq('visit_id', targetVisitId).maybeSingle();
  const dx = notes?.ayurveda_diagnosis || notes?.diagnosis_namc_label || notes?.modern_diagnosis || notes?.diagnosis_icd10_label || '';
  // Only fill if the field is still empty -- a user who already started typing (or a second,
  // slower-resolving call) should never have their own entry silently clobbered.
  if (dx && !document.getElementById('adm-diagnosis').value.trim()) {
    document.getElementById('adm-diagnosis').value = dx;
  }
}

window.clearPatientSelection = function() {
  _selectedPatient = null;
  _selectedVisitId = null;
  document.getElementById('spt').classList.remove('show');
  document.getElementById('spt-open-adm-warn').style.display = 'none';
  document.getElementById('search-area').style.display = '';
  document.getElementById('pt-search').value = '';
  document.getElementById('patient-results').classList.remove('show');
  document.getElementById('btn-step1-next').disabled = true;
};

// ── Bed picker ────────────────────────────────────────────────────────────────
window.loadVacantBeds = function() {
  const deptId  = document.getElementById('adm-dept').value;
  const picker  = document.getElementById('bed-picker');
  document.getElementById('adm-bed-id').value = '';

  // Filter doctors by department (NCISM §7 authorised consultants)
  _filterDoctorsByDept(deptId);

  if (!deptId) {
    picker.innerHTML = '<span class="bed-picker-empty">Select a department first</span>';
    return;
  }

  // Session 179 Piece 2 real design fix: hospital wards are physically SHARED across
  // departments (see bed-admin.js's Session 179 Piece 1 -- a department's "bed share" is a
  // planning/NCISM ratio, not a physical partition). This picker used to only ever show a
  // department its OWN tagged beds (`b.department_id === deptId`), silently hiding real vacant
  // beds in the very same physical room just because Quick Setup happened to allocate them to
  // a different department. Now shows every vacant bed in any (bed_type, ward_name) cell this
  // department actually participates in -- confirmed via Piece 1's SAME cell-identity
  // definition, so the two features agree on what "the same physical ward" means. Own beds
  // sort first/primary; another department's beds in the same shared ward are still pickable
  // (real overflow admission) but visually flagged and confirmed via pickBed()'s warning --
  // never silently blocked, per Dr. Venkatesh's explicit "allow with a clear warning" call.
  const ownCells = new Set(
    _allBeds.filter(b => b.department_id === deptId).map(b => `${b.bed_type}|${b.ward_name || ''}`)
  );
  let vacant = _allBeds.filter(b => b.status === 'vacant' &&
    (b.department_id === deptId || ownCells.has(`${b.bed_type}|${b.ward_name || ''}`)));

  // TODO_LATER §54 real fix, done alongside Piece 2 since both touch this exact function:
  // hard-block a clear gender mismatch -- male_general/female_general wards are physically
  // gender-segregated; every other bed_type (twin_sharing/private/deluxe/dormitory/etc.) has
  // no gender implication and is unaffected. A patient with gender 'other' or no gender on
  // file is never blocked here -- there's no defensible hard rule for either case, left to
  // staff judgement instead, matching the confirmed design (never rely on hiding alone without
  // a visible reason -- the empty/note states below always say why a bed is missing).
  // Real finding checking this live: patients.gender isn't stored consistently across the
  // platform -- reception.html's own form writes 'male'/'female', but ABDM-verified patients
  // (Scan & Share / ABHA enrollment) can arrive as single-letter 'M'/'F' instead. Normalizing
  // both to 'male'/'female' here so neither source silently skips the check.
  const genderRaw = (_selectedPatient?.gender || '').trim().toLowerCase();
  const patGender = genderRaw === 'm' ? 'male' : genderRaw === 'f' ? 'female' : genderRaw;
  let hiddenForGender = 0;
  if (patGender === 'male' || patGender === 'female') {
    const before = vacant.length;
    vacant = vacant.filter(b => {
      if (b.bed_type === 'male_general')   return patGender === 'male';
      if (b.bed_type === 'female_general') return patGender === 'female';
      return true;
    });
    hiddenForGender = before - vacant.length;
  }
  const genderNote = hiddenForGender
    ? `${hiddenForGender} bed${hiddenForGender === 1 ? '' : 's'} hidden — gender-segregated ward`
    : '';

  // Zone-exhaustion fallback (real SDM finding, live with Dr. Venkatesh): the same-zone `vacant`
  // list above already excludes anything not literally status='vacant' -- occupied, maintenance,
  // reserved all fall out the same way, so "own zone exhausted" naturally covers maintenance too,
  // no separate check needed. Only engages when the own-zone list above is TRULY empty (never as
  // a general free-for-all) -- offers every OTHER vacant bed tenant-wide as a last-resort, more
  // strongly flagged (🔷 purple, not 🔶 orange) than the existing same-zone overflow above, since
  // this crosses a real physical zone boundary, not just a department line within one ward.
  let crossZone = false;
  if (!vacant.length) {
    const ownWardNames = new Set(
      _allBeds.filter(b => b.department_id === deptId).map(b => b.ward_name || '')
    );
    vacant = _allBeds.filter(b => b.status === 'vacant' && !ownWardNames.has(b.ward_name || ''));
    if (patGender === 'male' || patGender === 'female') {
      vacant = vacant.filter(b => {
        if (b.bed_type === 'male_general')   return patGender === 'male';
        if (b.bed_type === 'female_general') return patGender === 'female';
        return true;
      });
    }
    crossZone = true;
  }

  if (!vacant.length) {
    picker.innerHTML = `<span class="bed-picker-empty">No vacant beds anywhere in this hospital${genderNote ? ` (${genderNote})` : ''}</span>`;
    return;
  }

  vacant = [...vacant].sort((a, b) =>
    (a.department_id === deptId ? 0 : 1) - (b.department_id === deptId ? 0 : 1) ||
    a.bed_number.localeCompare(b.bed_number, undefined, { numeric: true, sensitivity: 'base' }));

  const deptNameById = Object.fromEntries(_depts.map(d => [d.id, d.name]));
  const BED_TYPE_LABELS = {male_general:'Male General',female_general:'Female General',general:'General',twin_sharing:'Twin Sharing',semi_private:'Shared Private',private:'Private',deluxe:'Deluxe',dormitory:'Dormitory',icu:'ICU',day_care:'Day Care',pk_treatment:'PK Treatment',observation:'Observation'};

  const crossZoneNote = crossZone
    ? `<div class="bed-picker-note">No vacant beds remain in this department's usual ward(s) — showing vacant beds from elsewhere in the hospital as last-resort overflow.</div>`
    : '';

  picker.innerHTML = crossZoneNote + (genderNote ? `<div class="bed-picker-note">${_esc(genderNote)}</div>` : '') +
    vacant.map(b => {
    const isPk       = b.bed_type === 'pk_treatment';
    const isOverflow = b.department_id !== deptId;
    const typeLabel  = BED_TYPE_LABELS[b.bed_type] || b.bed_type.replace(/_/g, ' ');
    const ownerName  = isOverflow ? (deptNameById[b.department_id] || 'another department') : '';
    const flagClass  = crossZone ? ' crosszone' : (isOverflow ? ' overflow' : '');
    return `<div class="bed-option${isPk ? ' pk' : ''}${flagClass}" data-id="${b.id}"
      data-onclick="pickBed" data-onclick-a0="@this" data-onclick-a1="${b.id}" data-onclick-a2="${isOverflow ? '1' : '0'}" data-onclick-a3="${_esc(ownerName)}" data-onclick-a4="${crossZone ? '1' : '0'}"
      title="${_esc(b.bed_number)}${b.ward_name ? ' — ' + _esc(b.ward_name) : ''} — ${_esc(typeLabel)}${isOverflow ? ' — allocated to ' + _esc(ownerName) : ''}${crossZone ? ' — cross-zone overflow' : ''}">
      ${b.ward_name ? '<span style="font-size:9px;font-weight:400;display:block">'+_esc(b.ward_name)+'</span>' : ''}
      ${_esc(b.bed_number)}
      <span style="font-size:8.5px;font-weight:500;display:block;opacity:.8">${_esc(typeLabel)}</span>
      ${crossZone ? `<span style="font-size:8.5px;font-weight:700;display:block;color:var(--purple)">🔷 ${_esc(ownerName)}'s bed — other zone</span>`
        : isOverflow ? `<span style="font-size:8.5px;font-weight:700;display:block;color:var(--orange)">🔶 ${_esc(ownerName)}'s bed</span>` : ''}
    </div>`;
  }).join('');
};

window.pickBed = function(el, bedId, isOverflow, ownerName, crossZone) {
  // Session 179 Piece 2: overflow (a bed allocated to a different department, in the same
  // physically shared ward) is allowed, never silently blocked -- but confirmed once, clearly,
  // so it's a deliberate choice and not an accidental click. Bed Matrix separately shows the
  // resulting cross-department occupancy as a standing visual flag (bed-admin.js's renderBeds()).
  //
  // Zone-exhaustion fallback: a cross-zone pick (own zone had zero vacant beds) gets its own,
  // stronger warning -- this isn't two departments quietly sharing one physical ward anymore,
  // it's genuinely crossing the Medical/Surgical zone boundary because the home zone ran out.
  if (crossZone === '1') {
    const deptSelName = document.getElementById('adm-dept').selectedOptions?.[0]?.textContent || 'this department';
    const ok = confirm(`No vacant beds remain in ${deptSelName}'s usual ward(s).\n\nThis bed belongs to ${ownerName} elsewhere in the hospital -- admitting here is allowed as a last-resort overflow, and will show as a cross-zone occupancy on the Bed Matrix. Continue?`);
    if (!ok) return;
  } else if (isOverflow === '1') {
    const deptSelName = document.getElementById('adm-dept').selectedOptions?.[0]?.textContent || 'this department';
    const ok = confirm(`This bed is allocated to ${ownerName}, not ${deptSelName}.\n\nWards are physically shared -- admitting here is allowed, and will show as a cross-department occupancy on the Bed Matrix. Continue?`);
    if (!ok) return;
  }
  document.querySelectorAll('.bed-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('adm-bed-id').value = bedId;
};

// ── Save admission ─────────────────────────────────────────────────────────────
window.toggleMlcFields = function(show) {
  const el = document.getElementById('mlc-fields');
  if (el) el.style.display = show ? 'grid' : 'none';
};

// Session 205 (cont.): rewritten to call the create_ipd_admission() RPC instead of
// raw multi-step inserts -- the open-admission guard, bed-occupied update, visit
// completion, consent-record insert, and (new) advice-conversion all now happen
// atomically server-side, with a real role check (receptionist/super_admin/
// dept_admin only) as defense-in-depth alongside the RLS INSERT policy. See
// sql/session205_admission_advice.sql.
window.saveAdmission = async function() {
  if (!_selectedPatient) { _alert('error','Select a patient first.'); return; }
  if (!ADMIT_ROLES.includes(myRole)) { _alert('error','Only reception or admin can complete an admission.'); return; }
  const deptId    = document.getElementById('adm-dept').value;
  const bedId     = document.getElementById('adm-bed-id').value;
  const doctorId  = document.getElementById('adm-doctor').value;
  const diagnosis = document.getElementById('adm-diagnosis').value.trim();
  const admDate   = document.getElementById('adm-date').value;
  const diet      = document.getElementById('adm-diet').value;
  const notes     = document.getElementById('adm-notes').value.trim();
  const isMlc     = document.getElementById('adm-is-mlc').checked;
  const advanceAmount = document.getElementById('adm-advance-amount').value;
  const advanceMode   = document.getElementById('adm-advance-mode').value;
  const advanceRef    = document.getElementById('adm-advance-reference').value.trim();

  if (!deptId)   { _alert('error','Select a department.'); return; }
  if (!bedId)    { _alert('error','Select a bed.'); return; }
  if (!doctorId) { _alert('error','Select an admitting doctor.'); return; }
  if (!admDate)  { _alert('error','Enter admission date.'); return; }
  if (advanceAmount === '' || Number(advanceAmount) < 0) { _alert('error','Enter the advance amount collected.'); return; }
  if (!advanceMode) { _alert('error','Select the advance payment mode.'); return; }
  if (advanceMode !== 'cash' && Number(advanceAmount) > 0 && !advanceRef) {
    _alert('error','Enter the payment reference (UPI ref / card auth / cheque no. / NEFT UTR).'); return;
  }

  const btn = document.getElementById('btn-admit-save');
  btn.disabled = true; btn.textContent = 'Admitting…';

  const { data: newAdmissionId, error: admErr } = await supabase.rpc('create_ipd_admission', {
    p_patient_id:            _selectedPatient.id,
    p_department_id:         deptId,
    p_bed_id:                bedId,
    p_admitting_doctor_id:   doctorId,
    p_admission_date:        admDate,
    p_advance_amount:        Number(advanceAmount),
    p_advance_payment_mode:  advanceMode,
    p_advance_reference:     advanceRef || null,
    p_diagnosis_primary:     diagnosis || null,
    p_diet_type:             diet || null,
    p_notes:                 notes || null,
    // 24 Sep 2026 (TODO_LATER #59): the sole real caller today is the Admission
    // Advice -> Reception flow (?advice_id=), so _currentAdvice.visit_id (set by
    // doctor.js's saveAdmissionAdvice() from the live consultation) is now the
    // primary source -- the ?visit_id= URL param (Session 182, for a since-removed
    // "Open IPD Admission" link) is dead in practice but kept as a harmless fallback.
    // Without this, ipd_admissions.visit_id was null on every real admission, which
    // silently breaks dispensaryPOS.js's IPD medicine-dispense lookup (it resolves
    // the admission via ipd_admissions.visit_id = prescriptions.visit_id).
    p_visit_id:              _currentAdvice?.visit_id || _qp.get('visit_id') || null,
    p_advice_id:             _currentAdvice?.id || null,
    p_is_mlc:                isMlc,
    p_mlc_number:            isMlc ? (document.getElementById('adm-mlc-no').value.trim() || null) : null,
    p_mlc_police_station:    isMlc ? (document.getElementById('adm-mlc-ps').value.trim() || null) : null,
    p_mlc_nature:            isMlc ? (document.getElementById('adm-mlc-nature').value.trim() || null) : null,
    p_mlc_police_intimation: isMlc ? document.getElementById('adm-mlc-police').value : null,
    p_mlc_intimation_at:     isMlc && document.getElementById('adm-mlc-time').value ? new Date(document.getElementById('adm-mlc-time').value).toISOString() : null,
    p_consent_by:            document.getElementById('adm-consent-by').value.trim() || null,
    p_consent_relationship:  document.getElementById('adm-consent-rel').value,
    p_consent_risks:         document.getElementById('adm-consent-risks').checked,
    p_consent_alternatives:  document.getElementById('adm-consent-alts').checked,
    p_consent_questions:     document.getElementById('adm-consent-questions').checked,
  });

  if (admErr) {
    btn.disabled = false; btn.textContent = 'Admit Patient';
    _alert('error', safeErrorMessage(admErr, 'Admission failed.')); return;
  }

  btn.disabled = false; btn.textContent = 'Admit Patient';
  closeAdmitDrawer();
  _alert('success', `${_selectedPatient.name} admitted successfully.`);
  await loadAll();
};

// ── Discharge drawer ──────────────────────────────────────────────────────────
// Session 114 -- this drawer now only ORDERS a discharge (normal path,
// status -> clinically_discharged) or records a fast-track EXIT (LAMA/
// transferred/deceased, status -> charges_locked, bed freed immediately).
// It no longer completes a discharge in one step and no longer touches any
// insurance bill -- billing (room tariff + reconciled stay charges + GST)
// happens later, in the billing clerk's Generate IPD Bill step, from
// whatever charges the nurse (or, for fast-path exits, the billing clerk
// directly) has confirmed by then.
window.openDischargeDrawer = function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;

  document.getElementById('dis-adm-id').value    = admId;
  document.getElementById('dis-bed-id').value    = adm.beds?.id || '';
  document.getElementById('dis-patient-id').value = adm.patients?.id || '';
  document.getElementById('dis-date').value      = todayLocalStr();
  document.getElementById('dis-summary').value   = '';
  document.getElementById('dis-condition').value = '';
  document.getElementById('dis-transfer-to').value = '';
  document.getElementById('dis-type').value      = 'discharged';
  document.getElementById('dis-transfer-field').style.display = 'none';

  document.querySelectorAll('.discharge-opt').forEach(o => {
    o.classList.toggle('selected', o.dataset.val === 'discharged');
  });
  _updateDischargeSaveLabel('discharged');

  const pt   = adm.patients || {};
  const bed  = adm.beds || {};
  const dept = adm.departments || {};
  const days = _daysSince(adm.admitted_at);
  document.getElementById('dis-detail-card').innerHTML = `
    <div class="adm-detail-row"><span>Patient</span><strong>${_esc(pt.name||'—')}</strong></div>
    <div class="adm-detail-row"><span>Bed</span><strong>${_esc(bed.bed_number||'—')}</strong></div>
    <div class="adm-detail-row"><span>Department</span><strong>${_esc(dept.name||'—')}</strong></div>
    <div class="adm-detail-row"><span>Admitted</span><strong>${_fmt(adm.admission_date)} (${days} days)</strong></div>
    ${adm.diagnosis_primary ? `<div class="adm-detail-row"><span>Diagnosis</span><strong>${_esc(adm.diagnosis_primary)}</strong></div>` : ''}
  `;

  document.getElementById('discharge-overlay').classList.add('open');
};
window.closeDischargeDrawer = function() {
  document.getElementById('discharge-overlay').classList.remove('open');
};

const DISCHARGE_TYPE_NOTES = {
  discharged: "Orders discharge — the nurse reconciles stay charges and the bed is freed once that's locked.",
  lama: 'Fast-track exit — bed is freed immediately. Billing clerk will get a chance to add any charges before the bill is generated.',
  transferred: 'Fast-track exit — bed is freed immediately. Billing clerk will get a chance to add any charges before the bill is generated.',
  deceased: 'Fast-track exit — bed is freed immediately. Billing clerk will get a chance to add any charges before the bill is generated.',
};
function _updateDischargeSaveLabel(disType) {
  const note = document.getElementById('dis-type-note');
  if (note) note.textContent = DISCHARGE_TYPE_NOTES[disType] || '';
  const btn = document.getElementById('btn-discharge-save');
  if (btn) btn.textContent = disType === 'discharged' ? 'Order Discharge' : 'Confirm Exit';
}

window.selectDischargeType = function(el) {
  document.querySelectorAll('.discharge-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('dis-type').value = el.dataset.val;
  document.getElementById('dis-transfer-field').style.display =
    el.dataset.val === 'transferred' ? '' : 'none';
  _updateDischargeSaveLabel(el.dataset.val);
};

window.saveDischarge = async function() {
  const admId   = document.getElementById('dis-adm-id').value;
  const bedId   = document.getElementById('dis-bed-id').value;
  const disType = document.getElementById('dis-type').value; // 'discharged' | 'lama' | 'transferred' | 'deceased'
  const disDate = document.getElementById('dis-date').value;
  const summary = document.getElementById('dis-summary').value.trim();

  if (!disDate) { _alert('error','Enter discharge date.'); return; }

  const btn = document.getElementById('btn-discharge-save');
  btn.disabled = true; btn.textContent = disType === 'discharged' ? 'Ordering…' : 'Processing…';

  if (disType === 'discharged') {
    const { error } = await supabase.from('ipd_admissions').update({
      status: 'clinically_discharged', disposition: 'discharged',
      clinically_discharged_at: new Date().toISOString(),
      discharge_ordered_by: myProfile.id, discharge_order_notes: summary || null,
    }).eq('id', admId);
    if (error) {
      btn.disabled = false; _updateDischargeSaveLabel(disType);
      _alert('error', safeErrorMessage(error, 'Could not order discharge. Please try again.')); return;
    }
    await logAudit('ipd_order_discharge', 'ipd_admissions', admId, { by: myProfile.full_name }, _ctx);
    closeDischargeDrawer();
    _alert('success', 'Discharge ordered — nurse will reconcile stay charges next.');
    await loadAll();
    return;
  }

  // Fast path -- LAMA / transferred / deceased. Urgent/exceptional exits
  // shouldn't wait on the full gate sequence: jump straight to
  // charges_locked and free the bed now (same immediate-bed-free behavior
  // as before), but the billing clerk still gets a manual-add-charge pass
  // before a bill is generated (plan decision #6).
  const { error } = await supabase.from('ipd_admissions').update({
    status: 'charges_locked', disposition: disType,
    clinically_discharged_at: new Date().toISOString(),
    charges_locked_at: new Date().toISOString(),
    discharge_ordered_by: myProfile.id, discharge_order_notes: summary || null,
    notes: summary || null,
  }).eq('id', admId);

  if (error) {
    btn.disabled = false; _updateDischargeSaveLabel(disType);
    _alert('error', safeErrorMessage(error, 'Could not record exit. Please try again.')); return;
  }

  if (bedId) await supabase.from('beds').update({ status: 'vacant' }).eq('id', bedId);

  // ABDM M2 — create care context for DischargeSummary FHIR type (fire-and-forget)
  // 7 Sep 2026 (Session 199) — this used to require abha_number/abha_address before
  // even attempting create_care_context, the same stale gate Session 197 already
  // removed from _abdmCareContextInvoice's call site just below (create_care_context
  // itself needs no ABHA — only generate_link_token genuinely does, and it's given
  // whatever identifier the patient has, possibly neither). A demographic-only
  // patient's DischargeSummary care context was silently never created — found live
  // testing a fresh demographic-only IPD discharge (Uma K R). Now matches Invoice's
  // pattern: create unconditionally, guarded only on having a patient id.
  const adm = _admissions.find(a => a.id === admId);
  if (adm?.patients?.id) {
    _abdmCareContextDischarge(adm, admId).catch(() => {});
  }

  await logAudit('ipd_fast_track_exit', 'ipd_admissions', admId, { disposition: disType, by: myProfile.full_name }, _ctx);
  closeDischargeDrawer();
  _alert('success', 'Patient exit recorded and bed freed.');
  await loadAll();
};

// ── Generate IPD Bill (Session 114 — billing clerk) ─────────────────────────
// Shared by both the normal path (nurse already locked confirmed charges)
// and the fast path (billing clerk gets this same add/remove UI as a
// one-shot reconciliation pass, since fast-track exits skip the nurse step
// entirely -- see confirmed plan decision #6).
let _billTariff  = null;
let _billCharges = [];

// GST Phase 2b -- gst_billing_paths.ipd is the only path turned on so far;
// nothing here fires for any tenant until tenant_tax_settings.gst_go_live_date
// is set AND the admission started on/after it (both true only for a tenant
// that has been deliberately taken live on all 4 billing paths, none today).
// Legacy admissions never call the GST RPCs at all -- the regime is decided
// client-side from a plain read of tenant_tax_settings, matching the DB's own
// _billing_regime() logic (see sql/session300_gst_phase2a_billing_calc.sql).
let _taxSettings   = undefined; // undefined = not fetched yet; null = no row (not GST-registered)
let _billRegime    = 'legacy';
let _billGstPreview = null;
let _billBillingNote = null;

async function _loadTenantTaxSettings() {
  if (_taxSettings !== undefined) return _taxSettings;
  const { data } = await supabase.from('tenant_tax_settings')
    .select('gst_go_live_date').eq('tenant_id', tenantId).maybeSingle();
  _taxSettings = data || null;
  return _taxSettings;
}

function _admIsGstRegime(adm) {
  if (!_taxSettings?.gst_go_live_date) return false;
  return localDateStr(new Date(adm.admitted_at)) >= _taxSettings.gst_go_live_date;
}

window.openGenerateBillDrawer = async function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;

  document.getElementById('bill-adm-id').value = admId;
  const pt   = adm.patients || {};
  const bed  = adm.beds || {};
  const dept = adm.departments || {};
  const days = _daysSince(adm.admitted_at);
  document.getElementById('bill-detail-card').innerHTML = `
    <div class="adm-detail-row"><span>Patient</span><strong>${_esc(pt.name||'—')}</strong></div>
    <div class="adm-detail-row"><span>Bed</span><strong>${_esc(bed.bed_number||'—')} (${_esc(bed.bed_type||'—')})</strong></div>
    <div class="adm-detail-row"><span>Department</span><strong>${_esc(dept.name||'—')}</strong></div>
    <div class="adm-detail-row"><span>Admitted</span><strong>${_fmt(adm.admission_date)} (${days} days)</strong></div>
  `;

  // Informational prefill only -- no payer/insurance field exists on
  // ipd_admissions or patients (confirmed), so this just checks the
  // patient's most recent non-self-pay bill as a hint; billing clerk
  // confirms or changes it before generating.
  let payerHint = 'self_pay';
  if (pt.id) {
    const { data: recentBill } = await supabase.from('bills')
      .select('payer_type').eq('patient_id', pt.id).eq('tenant_id', tenantId)
      .neq('payer_type', 'self_pay').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (recentBill) payerHint = recentBill.payer_type;
  }
  document.getElementById('bill-payer-type').value = payerHint;

  await _loadTenantTaxSettings();
  document.getElementById('bill-overlay').classList.add('open');
  await _refreshBillPreview(adm);
};

window.closeGenerateBillDrawer = function() {
  document.getElementById('bill-overlay').classList.remove('open');
};

async function _refreshBillPreview(adm) {
  _billRegime = _admIsGstRegime(adm) ? 'gst_v1' : 'legacy';
  const notice = document.getElementById('bill-gst-notice');

  if (_billRegime === 'gst_v1') {
    if (notice) notice.style.display = '';
    await _refreshBillPreviewGst(adm);
    return;
  }

  if (notice) notice.style.display = 'none';
  document.getElementById('btn-generate-bill').disabled = false;
  // Tenant has a go-live date set, but this admission started before it --
  // matches _billing_regime()'s own definition of "legacy" exactly.
  _billBillingNote = _taxSettings?.gst_go_live_date
    ? 'Admitted before GST billing go-live — tax not calculated by system.' : null;

  const bed        = adm.beds || {};
  const admittedAt = new Date(adm.admitted_at);
  const throughAt  = adm.charges_locked_at ? new Date(adm.charges_locked_at) : new Date();
  const tariff = await computeRoomTariff({ supabase, tenantId, bed, admissionDate: admittedAt, throughDate: throughAt });

  const tariffEl = document.getElementById('bill-room-tariff');
  if (tariff.error) {
    tariffEl.innerHTML = `<span style="color:#c0392b">⚠ ${_esc(tariff.error)}</span>`;
    _billTariff = null;
  } else {
    tariffEl.innerHTML = `${tariff.days} day${tariff.days>1?'s':''} × ₹${tariff.dailyRate.toLocaleString('en-IN')} (${_esc(bed.bed_type||'—')}) = <strong>₹${tariff.total.toLocaleString('en-IN')}</strong>${tariff.gstPercent!=null ? ' + GST '+tariff.gstPercent+'%' : ''}`;
    _billTariff = tariff;
  }

  await _loadBillCharges(adm.id);
}

// GST Phase 2b -- admission is on/after the tenant's gst_go_live_date. The DB
// is the only calculator (per session300's own stated rule); this just renders
// what preview_ipd_bill returns.
async function _refreshBillPreviewGst(adm) {
  const payerType = document.getElementById('bill-payer-type').value;
  const { data, error } = await supabase.rpc('preview_ipd_bill', {
    p_adm: adm.id, p_payer: payerType, p_bill_discount: 0,
  });
  if (error) {
    _alert('error', safeErrorMessage(error, 'Could not preview the GST bill.'));
    return;
  }
  _billGstPreview = data;
  _renderGstPreview(data);
}

const DOC_TYPE_LABEL = { TAX_INVOICE: 'Tax Invoice', BILL_OF_SUPPLY: 'Bill of Supply', BILL: 'Bill' };
const TAX_CAT_LABEL  = { TAXABLE: 'Taxable', EXEMPT: 'Exempt', NIL_RATED: 'Nil-rated', NON_GST: 'Non-GST', OUT_OF_SCOPE: 'Out of scope' };

function _gstLineTaxNote(l) {
  return l.tax_category === 'TAXABLE'
    ? `CGST ${l.cgst_rate}% + SGST ${l.sgst_rate}%`
    : (TAX_CAT_LABEL[l.tax_category] || l.tax_category || '—');
}

function _renderGstPreview(data) {
  const notice = document.getElementById('bill-gst-notice');
  const warnings = (data.warnings || []).map(w => `<div style="color:#8a6d00;font-size:11.5px">⚠ ${_esc(w)}</div>`).join('');
  const issues = data.issues || [];
  notice.innerHTML = `
    <div style="font-size:11.5px;font-weight:700;color:var(--green-deep)">GST BILL — ${_esc(DOC_TYPE_LABEL[data.document_type] || data.document_type || '—')}</div>
    ${warnings}
    ${issues.length ? `<div style="color:#c0392b;font-size:12px;margin-top:4px">${issues.map(i => '⛔ ' + _esc(i)).join('<br>')}</div>` : ''}
  `;

  const lines = data.lines || [];
  const roomLines  = lines.filter(l => l.source_type === 'room_day');
  const otherLines = lines.filter(l => l.source_type !== 'room_day');

  const tariffEl = document.getElementById('bill-room-tariff');
  tariffEl.innerHTML = roomLines.length
    ? roomLines.map(l => `${_esc(l.description)} — ₹${Number(l.line_total||0).toLocaleString('en-IN')} <span style="color:var(--text-muted)">(${_gstLineTaxNote(l)})</span>`).join('<br>')
    : '<span style="color:var(--text-muted)">No room charge.</span>';

  const el = document.getElementById('bill-charges-list');
  el.innerHTML = otherLines.length
    ? otherLines.map(l => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:5px;background:#fafff7">
        <div>
          <div style="font-size:12.5px;font-weight:600">${_esc(l.description)}</div>
          <div style="font-size:10.5px;color:var(--text-muted)">${l.quantity} × ₹${Number(l.price||0).toLocaleString('en-IN')} · ${_gstLineTaxNote(l)} = ₹${Number(l.line_total||0).toLocaleString('en-IN')}</div>
        </div>
      </div>`).join('')
    : '<div style="text-align:center;color:var(--text-muted);padding:12px;font-size:12.5px">No stay charges recorded.</div>';

  const grand = data.bill?.final_amount != null ? Number(data.bill.final_amount) : 0;
  document.getElementById('bill-grand-total').textContent = '₹' + grand.toLocaleString('en-IN', { maximumFractionDigits: 2 });

  document.getElementById('btn-generate-bill').disabled = issues.length > 0;
}

async function _loadBillCharges(admId) {
  const { data } = await supabase.from('ipd_stay_charges')
    .select('*').eq('ipd_admission_id', admId).not('status','in','(voided,billed)')
    .order('added_at');
  _billCharges = data || [];
  _renderBillCharges();
}

function _renderBillCharges() {
  const el = document.getElementById('bill-charges-list');
  el.innerHTML = _billCharges.length
    ? _billCharges.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:5px;background:#fafff7">
        <div>
          <div style="font-size:12.5px;font-weight:600">${_esc(r.description)}</div>
          <div style="font-size:10.5px;color:var(--text-muted)">${r.quantity} × ₹${Number(r.unit_price).toLocaleString('en-IN')} = ₹${Number(r.amount).toLocaleString('en-IN')}</div>
        </div>
        <button class="icon-btn" data-onclick="voidBillCharge" data-onclick-a0="${r.id}" title="Cancel charge (reason required)" style="font-size:11px">&#10005;</button>
      </div>`).join('')
    : '<div style="text-align:center;color:var(--text-muted);padding:12px;font-size:12.5px">No stay charges recorded.</div>';
  _updateBillGrandTotal();
}

function _updateBillGrandTotal() {
  const tariffTotal  = _billTariff ? _billTariff.total : 0;
  const tariffGst    = _billTariff?.gstPercent ? tariffTotal * _billTariff.gstPercent / 100 : 0;
  const chargesTotal = _billCharges.reduce((s,r) => s + (Number(r.amount)||0), 0);
  const chargesGst   = _billCharges.reduce((s,r) => s + (Number(r.amount)||0) * (Number(r.gst_percent)||0) / 100, 0);
  const grand = tariffTotal + tariffGst + chargesTotal + chargesGst;
  document.getElementById('bill-grand-total').textContent = '₹' + grand.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

window.addBillCharge = async function() {
  const admId = document.getElementById('bill-adm-id').value;
  const description = document.getElementById('bc-desc').value.trim();
  const qty   = parseFloat(document.getElementById('bc-qty').value) || 1;
  const price = parseFloat(document.getElementById('bc-price').value) || 0;
  if (!description || price <= 0) { _alert('error','Enter a description and amount.'); return; }
  const { error } = await supabase.from('ipd_stay_charges').insert({
    tenant_id: tenantId, ipd_admission_id: admId, source: 'manual',
    description, quantity: qty, unit_price: price, amount: qty * price,
    status: 'confirmed', added_by: myProfile.id,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not add charge.')); return; }
  document.getElementById('bc-desc').value  = '';
  document.getElementById('bc-qty').value   = '1';
  document.getElementById('bc-price').value = '';
  // GST Phase 2b -- a staged charge just changed. Under gst_v1 that changes the
  // tax preview (new preview_ipd_bill call); under legacy, keep the original,
  // narrower refresh (stay charges only, no tariff recompute, no RPC).
  if (_billRegime === 'gst_v1') {
    const adm = _admissions.find(a => a.id === admId);
    if (adm) { await _refreshBillPreviewGst(adm); return; }
  }
  await _loadBillCharges(admId);
};

window.voidBillCharge = async function(chargeId) {
  const admId = document.getElementById('bill-adm-id').value;
  // Session 305: cancel with a reason (who/when/why recorded), never a silent void/delete.
  const reason = (prompt('Reason for cancelling this charge (required):') || '').trim();
  if (!reason) return;
  const { error } = await supabase.rpc('cancel_ipd_stay_charge', { p_charge_id: chargeId, p_reason: reason });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not cancel the charge.')); return; }
  if (_billRegime === 'gst_v1') {
    const adm = _admissions.find(a => a.id === admId);
    if (adm) { await _refreshBillPreviewGst(adm); return; }
  }
  await _loadBillCharges(admId);
};

window.confirmGenerateBill = async function() {
  const admId = document.getElementById('bill-adm-id').value;
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;

  const payerType = document.getElementById('bill-payer-type').value;
  const btn = document.getElementById('btn-generate-bill');

  // GST Phase 2b -- gst_v1 admissions go through the DB's own atomic RPC
  // (build draft + calculate + finalize + stay-charge status + admission
  // status + audit log, all in one transaction) instead of the manual
  // inserts below, which stay exactly as they were for legacy admissions.
  if (_billRegime === 'gst_v1') {
    btn.disabled = true; btn.textContent = 'Generating…';
    const { data, error } = await supabase.rpc('generate_ipd_bill', {
      p_adm: admId, p_payer: payerType, p_bill_discount: 0,
    });
    if (error) {
      btn.disabled = false; btn.textContent = 'Generate Bill';
      _alert('error', safeErrorMessage(error, 'Could not generate bill.')); return;
    }
    if (adm.patients?.id) {
      _abdmCareContextInvoice(data.bill_id, adm.patients.id, admId, {
        abhaNumber:  adm.patients.abha_number,
        abhaAddress: adm.patients.abha_address,
      });
    }
    btn.disabled = false; btn.textContent = 'Generate Bill';
    closeGenerateBillDrawer();
    _alert('success', `IPD bill generated — ${data.document_number || ''} ₹${Number(data.final_amount||0).toLocaleString('en-IN')}.`);
    await loadAll();
    await openAccountDrawer(admId); // Session 302 -- straight into collection
    return;
  }

  if (!_billTariff) { _alert('error','Fix the room tariff issue above before generating the bill.'); return; }
  btn.disabled = true; btn.textContent = 'Generating…';

  const tariffGst    = _billTariff.gstPercent ? _billTariff.total * _billTariff.gstPercent / 100 : 0;
  const chargesTotal = _billCharges.reduce((s,r) => s + (Number(r.amount)||0), 0);
  const chargesGst   = _billCharges.reduce((s,r) => s + (Number(r.amount)||0) * (Number(r.gst_percent)||0) / 100, 0);
  const finalAmount  = _billTariff.total + tariffGst + chargesTotal + chargesGst;

  // chk_insurance_workflow_sync requires self_pay <-> not_applicable,
  // anything else <-> a real (non not_applicable) claim status. Insurance
  // provider/TPA/policy details aren't captured here (no such field exists
  // on ipd_admissions/patients to copy from) -- Insurance Counter fills
  // those in via the existing finance.html / insurance-claims.html flow,
  // which this bill surfaces in automatically once payer_type != self_pay.
  const insuranceClaimStatus = payerType === 'self_pay' ? 'not_applicable' : 'pre_auth_pending';

  // Session 302: advance_credited is no longer set here -- the payments ledger's
  // sync trigger (_ipd_ledger_sync, fired on ipd_admissions.discharge_bill_id being
  // set below) fills it in from the real ledger total the moment this bill is
  // linked to the admission, and keeps it correct from then on as deposits/
  // payments/refunds are recorded. patient_due (GENERATED STORED) is
  // final_amount - insurance_approved_amount - advance_credited.
  const { data: bill, error: billErr } = await supabase.from('bills').insert({
    tenant_id: tenantId, patient_id: adm.patients?.id,
    bill_type: 'ipd', total_amount: finalAmount, final_amount: finalAmount,
    payer_type: payerType, insurance_claim_status: insuranceClaimStatus,
    status: 'pending', payment_mode: null,
    // Session 302 -- same field the GST path's _ipd_build_draft() already sets; finance.js's
    // Outstanding list uses it to link straight back into this admission's Account drawer.
    ipd_admission_id: admId,
    billing_note: _billBillingNote,
  }).select('id').single();

  if (billErr) {
    btn.disabled = false; btn.textContent = 'Generate Bill';
    _alert('error', safeErrorMessage(billErr, 'Could not generate bill.')); return;
  }

  const billItems = [{
    bill_id: bill.id, tenant_id: tenantId, item_type: 'room_tariff',
    description: `Room Tariff — ${_billTariff.days} day${_billTariff.days>1?'s':''} × ${adm.beds?.bed_type||''}`,
    quantity: _billTariff.days, price: _billTariff.dailyRate, total: _billTariff.total,
    gst_percent: _billTariff.gstPercent, gst_amount: tariffGst,
  }].concat(_billCharges.map(r => ({
    bill_id: bill.id, tenant_id: tenantId, item_type: r.source,
    description: r.description, quantity: Math.round(r.quantity), price: r.unit_price, total: r.amount,
    gst_percent: r.gst_percent, gst_amount: (Number(r.amount)||0) * (Number(r.gst_percent)||0) / 100,
  })));

  const { error: itemsErr } = await supabase.from('bill_items').insert(billItems);
  if (itemsErr) {
    btn.disabled = false; btn.textContent = 'Generate Bill';
    _alert('error', safeErrorMessage(itemsErr, 'Bill created but items failed — contact support.')); return;
  }

  if (_billCharges.length) {
    await supabase.from('ipd_stay_charges').update({ status: 'billed', billed_bill_id: bill.id })
      .in('id', _billCharges.map(r => r.id));
  }

  const { error: admErr } = await supabase.from('ipd_admissions').update({
    status: 'bill_generated', bill_generated_at: new Date().toISOString(), discharge_bill_id: bill.id,
  }).eq('id', admId);
  if (admErr) _alert('error', safeErrorMessage(admErr, 'Bill created but admission status update failed.'));

  await logAudit('ipd_bill_generated', 'bills', bill.id, { admission_id: admId, final_amount: finalAmount }, _ctx);

  // Session 183: separate Invoice care context for this discharge bill (own
  // BILL-<id> ref — doesn't collide with the admission's DischargeSummary-tagged
  // IPD-<id> context)
  // 5 Sep 2026 (Session 197) — widened to also fire on abha_address alone, and to
  // still create the care context even with neither identifier yet (matching
  // dispensaryPOS.js's already-shipped fix) -- see _abdmCareContextInvoice below.
  if (adm.patients?.id) {
    _abdmCareContextInvoice(bill.id, adm.patients.id, admId, {
      abhaNumber:  adm.patients.abha_number,
      abhaAddress: adm.patients.abha_address,
    });
  }

  btn.disabled = false; btn.textContent = 'Generate Bill';
  closeGenerateBillDrawer();
  _alert('success', `IPD bill generated — ₹${finalAmount.toLocaleString('en-IN')}.`);
  await loadAll();
  await openAccountDrawer(admId); // Session 302 -- straight into collection
};

// ── IPD Account Drawer (Session 302/303 — patient_payments ledger) ──────────
// One drawer covers the whole payment lifecycle: deposits before a bill exists,
// split collection + refunds against a generated bill, receipt printing and
// same-day void. The database (record_ipd_payments/void_ipd_payment/
// get_ipd_account) is the only source of truth for what's allowed — this UI
// just renders its answers and shows its errors back verbatim.
const PAYMENT_MODES = ['cash', 'upi', 'card', 'cheque', 'neft'];
const MODE_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' };
const KIND_LABEL = { advance: 'Advance', deposit: 'Deposit', payment: 'Payment', refund: 'Refund' };
const VOID_ROLES = ['accountant', 'finance_manager', 'super_admin'];

let _acctAdmId      = null;
let _lastAcct        = null;
let _lastReceipts    = [];
let _lastCharges     = null;
let _lastNewReceipts = null;
let _voidingId       = null;

window.openAccountDrawer = async function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;
  _acctAdmId = admId;
  _lastNewReceipts = null;
  _voidingId = null;
  document.getElementById('acct-adm-id').value = admId;

  const pt = adm.patients || {}, bed = adm.beds || {}, dept = adm.departments || {};
  document.getElementById('acct-detail-card').innerHTML = `
    <div class="adm-detail-row"><span>Patient</span><strong>${_esc(pt.name || '—')}</strong></div>
    <div class="adm-detail-row"><span>Bed</span><strong>${_esc(bed.bed_number || '—')} (${_esc(bed.bed_type || '—')})</strong></div>
    <div class="adm-detail-row"><span>Department</span><strong>${_esc(dept.name || '—')}</strong></div>
    <div class="adm-detail-row"><span>Status</span><strong>${_esc(_statusLabel(adm.status))}</strong></div>
  `;

  document.getElementById('acct-overlay').classList.add('open');
  await _refreshAccountDrawer();
};

window.closeAccountDrawer = function() {
  document.getElementById('acct-overlay').classList.remove('open');
  _acctAdmId = null;
};

async function _refreshAccountDrawer() {
  const admId = _acctAdmId;
  if (!admId) return;
  const body = document.getElementById('acct-body');
  body.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12.5px">Loading…</div>';

  const adm = _admissions.find(a => a.id === admId);
  const [{ data: acc, error: accErr }, { data: receipts, error: rcErr }] = await Promise.all([
    supabase.rpc('get_ipd_account', { p_adm: admId }),
    supabase.from('patient_payments').select('*').eq('ipd_admission_id', admId).order('received_at', { ascending: false }),
  ]);
  if (accErr || !acc) {
    body.innerHTML = `<div style="color:var(--red);padding:10px;font-size:12.5px">${_esc(safeErrorMessage(accErr, 'Could not load the account.'))}</div>`;
    return;
  }
  if (rcErr) _alert('error', safeErrorMessage(rcErr, 'Could not load receipts.'));

  let chargesToDate = null;
  if (!acc.bill_id && adm) chargesToDate = await computeIpdChargesToDate({ supabase, tenantId, admission: adm });

  _renderAccountDrawer(acc, receipts || [], chargesToDate);
}

function _fmtMoney(v) {
  return '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// One row per payment mode (a mode can only appear once per record_ipd_payments
// call anyway — the DB rejects a duplicate — so a fixed 5-row grid instead of a
// dynamic add-row list keeps this simple and matches that rule exactly).
function _modeRowsHtml(prefix) {
  return `<div style="margin-bottom:6px">` + PAYMENT_MODES.map(m => `
    <div style="display:grid;grid-template-columns:64px 1fr 1.3fr;gap:6px;align-items:center;margin-bottom:6px">
      <span style="font-size:12px;font-weight:600;color:var(--text-mid)">${MODE_LABEL[m]}</span>
      <input type="number" min="0" step="0.01" placeholder="₹ amount" id="${prefix}-amt-${m}"
        style="height:32px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:12.5px"/>
      <input type="text" placeholder="${m === 'cash' ? '(no reference needed)' : 'reference — required'}" id="${prefix}-ref-${m}" ${m === 'cash' ? 'disabled' : ''}
        style="height:32px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:12.5px${m === 'cash' ? ';background:var(--cream)' : ''}"/>
    </div>`).join('') + `</div>`;
}

function _readModeRows(prefix) {
  const lines = [];
  for (const m of PAYMENT_MODES) {
    const amt = Number(document.getElementById(`${prefix}-amt-${m}`)?.value);
    if (amt > 0) {
      lines.push({ mode: m, amount: amt, reference: document.getElementById(`${prefix}-ref-${m}`)?.value?.trim() || null });
    }
  }
  return lines;
}

function _receiptRowHtml(r, isClosed) {
  const voided  = !!r.voided_at;
  const sameDay = localDateStr(new Date(r.received_at)) === todayLocalStr();
  const canVoid = !voided && !isClosed && sameDay && VOID_ROLES.includes(myRole);
  const rowStyle = voided ? 'text-decoration:line-through;color:var(--text-muted)' : '';

  let actionCell;
  if (_voidingId === r.id) {
    actionCell = `<div style="display:flex;gap:4px;align-items:center;white-space:nowrap">
      <input type="text" id="void-reason-${r.id}" placeholder="reason" style="height:26px;font-size:11px;width:90px;border:1.5px solid var(--border);border-radius:5px;padding:0 6px"/>
      <button class="icon-btn" data-onclick="confirmVoidReceipt" data-onclick-a0="${r.id}" title="Confirm void" style="font-size:11px;color:var(--red)">&#10003;</button>
      <button class="icon-btn" data-onclick="toggleVoidRow" data-onclick-a0="${r.id}" title="Cancel">&#10005;</button>
    </div>`;
  } else {
    actionCell = `<button class="icon-btn" data-onclick="printAccountReceipt" data-onclick-a0="${r.id}" title="Print receipt" style="font-size:11px">&#128424;</button>` +
      (canVoid ? `<button class="icon-btn" data-onclick="toggleVoidRow" data-onclick-a0="${r.id}" title="Void (same day only)" style="font-size:11px;color:var(--red)">&#8856;</button>` : '');
  }

  return `<tr style="${rowStyle}">
      <td style="padding:5px 4px">${new Date(r.received_at).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}</td>
      <td style="padding:5px 4px">${_esc(r.receipt_no)}</td>
      <td style="padding:5px 4px">${KIND_LABEL[r.kind] || r.kind}</td>
      <td style="padding:5px 4px">${MODE_LABEL[r.mode] || r.mode}${r.reference ? ' · ' + _esc(r.reference) : ''}</td>
      <td style="padding:5px 4px;text-align:right;font-weight:600">${_fmtMoney(r.amount)}</td>
      <td style="padding:5px 4px;white-space:nowrap">${actionCell}</td>
    </tr>${voided ? `<tr style="${rowStyle}"><td colspan="6" style="padding:0 4px 8px;font-size:10.5px">VOID — ${_esc(r.void_reason || '')}</td></tr>` : ''}`;
}

function _renderAccountDrawer(acc, receipts, chargesToDate) {
  _lastAcct = acc; _lastReceipts = receipts; _lastCharges = chargesToDate;

  const isClosed = ['paid_cleared', 'discharged'].includes(acc.admission_status);
  const hasBill  = !!acc.bill_id;
  const isDraft  = hasBill && acc.document_status && acc.document_status !== 'finalized';
  const balance  = Number(acc.balance) || 0;

  let html = '';

  if (_lastNewReceipts && _lastNewReceipts.length) {
    html += `<div style="background:var(--green-light);border:1px solid #b8ddc6;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px">
      <strong>Recorded.</strong> Print:
      ${_lastNewReceipts.map(r => `<button class="btn btn-secondary btn-sm" style="height:26px;padding:0 8px;font-size:11px;margin-left:6px" data-onclick="printAccountReceipt" data-onclick-a0="${r.id}">&#128424; ${_esc(r.receipt_no)}</button>`).join('')}
    </div>`;
  }

  // ── Summary ──
  html += `<div class="sec" style="margin-top:0">Summary</div>`;
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
    <div style="background:var(--cream);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.3px">Money Held</div>
      <div style="font-size:17px;font-weight:700;color:var(--green-deep)">${_fmtMoney(acc.held)}</div>
    </div>`;
  if (!hasBill) {
    html += `<div style="background:var(--cream);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.3px">Charges So Far (est.)</div>
      <div style="font-size:17px;font-weight:700;color:var(--text-dark)">${_fmtMoney(chargesToDate?.total || 0)}</div>
    </div>`;
  } else {
    html += `<div style="background:var(--cream);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.3px">${balance < 0 ? 'Refund Due' : 'Balance Due'}</div>
      <div style="font-size:17px;font-weight:700;color:${balance > 0 ? 'var(--red)' : 'var(--green-deep)'}">${_fmtMoney(Math.abs(balance))}</div>
    </div>`;
  }
  html += `</div>`;

  if (!hasBill) {
    html += `<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px">
      ${chargesToDate?.tariff?.error ? `⚠ ${_esc(chargesToDate.tariff.error)}` : `${chargesToDate?.tariff?.days || 0} day(s) room${chargesToDate?.charges?.length ? ' + ' + chargesToDate.charges.length + ' stay charge(s)' : ''} — estimate only, excludes tax.`}
    </div>`;
    html += `<button class="btn btn-secondary btn-sm" data-onclick="printInterimBillBtn" style="margin-bottom:16px">&#128424; Print Interim Bill</button>`;
  }

  // ── Bill block ──
  if (hasBill) {
    // Paid and refunded shown as separate lines, not netted into one figure -- a
    // refund-only bill used to show "Paid So Far: ₹-2,500.00" here, which reads as an
    // error rather than a refund even though the underlying paid_net math is correct.
    // Computed from the same receipts already loaded for the list below (matches
    // _ipd_account()'s own paid_net definition: payments minus post-bill refunds,
    // voided rows excluded) rather than a second round trip.
    const paidTotal = receipts
      .filter(r => r.kind === 'payment' && !r.voided_at)
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const refundedTotal = receipts
      .filter(r => r.kind === 'refund' && r.bill_id && !r.voided_at)
      .reduce((s, r) => s + (Number(r.amount) || 0), 0);

    html += `<div class="sec">Bill</div>`;
    html += `<div class="adm-detail-card" style="margin-bottom:14px">
      <div class="adm-detail-row"><span>Document</span><strong>${_esc(acc.document_number || 'Legacy bill')}</strong></div>
      <div class="adm-detail-row"><span>Bill Total</span><strong>${_fmtMoney(acc.final_amount)}</strong></div>
      ${Number(acc.insurance_approved) > 0 ? `<div class="adm-detail-row"><span>Insurance Approved</span><strong>${_fmtMoney(acc.insurance_approved)}</strong></div>` : ''}
      <div class="adm-detail-row"><span>Advance / Deposits Credited</span><strong>${_fmtMoney(acc.held)}</strong></div>
      <div class="adm-detail-row"><span>Paid</span><strong>${_fmtMoney(paidTotal)}</strong></div>
      ${refundedTotal > 0 ? `<div class="adm-detail-row"><span>Refunded</span><strong>${_fmtMoney(refundedTotal)}</strong></div>` : ''}
      <div class="adm-detail-row"><span>Status</span><strong>${_esc((acc.bill_status || '').toUpperCase())}</strong></div>
    </div>`;
  }

  // ── Actions ──
  if (isClosed) {
    html += `<div style="background:var(--green-light);border:1px solid #b8ddc6;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:12.5px;font-weight:600;color:var(--green-deep)">
      ✅ ${acc.payer_type === 'self_pay' ? 'Paid — admission released.' : 'Account closed.'}
    </div>`;
  } else if (isDraft) {
    html += `<div style="background:#fffbea;border:1px solid #f0d878;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:12.5px;color:#7a5a00">
      This GST bill is still a draft — finalise it (open 💰 Generate Bill again) before collecting.
    </div>`;
  } else if (!hasBill) {
    html += `<div class="sec">Add Deposit</div>${_modeRowsHtml('dep')}
      <div style="display:flex;justify-content:flex-end;margin-bottom:16px"><button class="btn btn-primary btn-sm" data-onclick="submitAccountDeposit">+ Add Deposit</button></div>`;
    if (Number(acc.held) > 0) {
      html += `<div class="sec">Refund</div>${_modeRowsHtml('rfd')}
        <div class="field" style="margin-top:2px"><label>Reason <span class="req">*</span></label><input type="text" id="rfd-reason" placeholder="e.g. patient request"/></div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:16px"><button class="btn btn-secondary btn-sm" data-onclick="submitAccountRefund">Refund</button></div>`;
    }
  } else {
    if (balance > 0) {
      html += `<div class="sec">Collect</div>${_modeRowsHtml('pay')}
        <div style="display:flex;justify-content:flex-end;margin-bottom:16px"><button class="btn btn-primary btn-sm" data-onclick="submitAccountPayment">Collect</button></div>`;
    }
    if (balance < 0) {
      html += `<div class="sec">Refund Excess</div>${_modeRowsHtml('rfd')}
        <div class="field" style="margin-top:2px"><label>Reason <span class="req">*</span></label><input type="text" id="rfd-reason" placeholder="e.g. excess advance"/></div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:16px"><button class="btn btn-secondary btn-sm" data-onclick="submitAccountRefund">Refund</button></div>`;
    }
    if (balance === 0 && acc.payer_type !== 'self_pay') {
      html += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">Patient share settled. Awaiting insurance final approval (next update).</div>`;
    }
  }

  // ── Receipts list ──
  html += `<div class="sec">Receipts</div>`;
  html += receipts.length
    ? `<div style="overflow-x:auto"><table style="width:100%;font-size:11.5px;border-collapse:collapse">
        <thead><tr style="text-align:left;color:var(--text-muted)"><th style="padding:5px 4px">Date</th><th style="padding:5px 4px">Receipt</th><th style="padding:5px 4px">Kind</th><th style="padding:5px 4px">Mode</th><th style="padding:5px 4px;text-align:right">Amount</th><th></th></tr></thead>
        <tbody>${receipts.map(r => _receiptRowHtml(r, isClosed)).join('')}</tbody>
      </table></div>`
    : `<div style="text-align:center;color:var(--text-muted);padding:12px;font-size:12.5px">No receipts yet.</div>`;

  document.getElementById('acct-body').innerHTML = html;
}

window.submitAccountDeposit = async function() {
  const lines = _readModeRows('dep');
  if (!lines.length) { _alert('error', 'Enter at least one amount.'); return; }
  await _submitAccountLedger('deposit', lines, null);
};

window.submitAccountPayment = async function() {
  const lines = _readModeRows('pay');
  if (!lines.length) { _alert('error', 'Enter at least one amount.'); return; }
  await _submitAccountLedger('payment', lines, null);
};

window.submitAccountRefund = async function() {
  const lines = _readModeRows('rfd');
  const reason = document.getElementById('rfd-reason')?.value?.trim() || '';
  if (!lines.length) { _alert('error', 'Enter at least one amount.'); return; }
  if (!reason) { _alert('error', 'Give a reason for the refund.'); return; }
  await _submitAccountLedger('refund', lines, reason);
};

async function _submitAccountLedger(kind, lines, notes) {
  const admId = _acctAdmId;
  if (!admId) return;
  const { data, error } = await supabase.rpc('record_ipd_payments', {
    p_adm: admId, p_kind: kind, p_lines: lines, p_notes: notes,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not record this.')); return; }
  await logAudit('ipd_' + kind + '_recorded_ui', 'ipd_admissions', admId, { lines, notes }, _ctx);
  _alert('success', `${KIND_LABEL[kind]} recorded.`);
  _lastNewReceipts = data?.receipts || [];
  await loadAll();
  await _refreshAccountDrawer();
}

window.toggleVoidRow = function(id) {
  _voidingId = _voidingId === id ? null : id;
  if (_lastAcct) _renderAccountDrawer(_lastAcct, _lastReceipts, _lastCharges);
};

window.confirmVoidReceipt = async function(id) {
  const reason = document.getElementById('void-reason-' + id)?.value?.trim() || '';
  if (reason.length < 5) { _alert('error', 'Give a reason of at least 5 characters.'); return; }
  const { error } = await supabase.rpc('void_ipd_payment', { p_id: id, p_reason: reason });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not void this receipt.')); return; }
  await logAudit('ipd_receipt_voided_ui', 'patient_payments', id, { reason }, _ctx);
  _voidingId = null;
  _alert('success', 'Receipt voided.');
  await loadAll();
  await _refreshAccountDrawer();
};

window.printAccountReceipt = function(id) {
  window.open(`printReceipt.html?payment=${id}`, '_blank');
};

window.printInterimBillBtn = function() {
  if (_acctAdmId) window.open(`printReceipt.html?interim=${_acctAdmId}`, '_blank');
};

// ── ABDM M2 — Care context: DischargeSummary (fire-and-forget) ───────
async function _abdmCareContextDischarge(adm, admId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` };
    const ccRef   = `IPD-${admId}`;
    const dateStr = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    // Plain hyphen, not an em-dash — Session 183 found ABDM's real careContexts[].display
    // field rejects an em-dash ("ABDM-9999: Invalid display"), discovered while wiring
    // Invoice care contexts. This means DischargeSummary linking here has likely been
    // silently failing (the failure lands inside the catch below, never surfaced) on
    // every IPD discharge until now.
    const display = `IPD Discharge - ${dateStr}`;
    const pt      = adm.patients;
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers,
      body: JSON.stringify({
        action: 'create_care_context', patient_id: pt.id,
        ipd_id: admId, care_context_ref: ccRef,
        display, hi_types: ['DischargeSummary'],
        abha_number: pt.abha_number, abha_address: pt.abha_address,
      }),
    });
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers,
      body: JSON.stringify({
        action: 'generate_link_token', patient_id: pt.id,
        abha_number: pt.abha_number, abha_address: pt.abha_address, ipd_id: admId,
        care_contexts: [{ referenceNumber: ccRef, display, hiType: 'DischargeSummary' }],
      }),
    });
  } catch (e) { console.warn('[ABDM] discharge care context failed:', e.message); }
}

// Session 183: Invoice care context (fire-and-forget). Own ref (BILL-<id>) —
// deliberately not the admission's IPD-<id> ref, since abdm-hip's push loop only
// ever builds hi_types[0] per care context row; reusing that ref would silently
// bury Invoice behind DischargeSummary. Being a genuinely NEW ref (unlike merging
// into an already-linked context), it needs its own generate_link_token call too,
// or it sits linked=false forever and abdm-hip's push loop (.eq('linked', true))
// never sees it — the common case reuses a cached 6-month token, so this is a
// cheap direct link/carecontext call, not a fresh demographic-auth round trip.
//
// 5 Sep 2026 (Session 197) — this used to hard-require abhaNumber to do
// ANYTHING at all (not even create_care_context), the same gap dispensaryPOS.js
// already had fixed on 27 Aug: a demographic-only patient's IPD invoice never
// got created at all. Now takes { abhaNumber, abhaAddress } distinctly (same as
// reception.js's _abdmLinkTokenAfterVerify — sending an address string into
// abdm-hip's number-typed field would silently break Number()/abhaNumToAddr()
// parsing there) and always creates the care context; generate_link_token only
// needs EITHER identifier now, not specifically a number — live-proven against
// real ABDM sandbox the same session (memory
// session197_hip_initiated_linking_resolved.md).
async function _abdmCareContextInvoice(billId, patientId, admId, { abhaNumber, abhaAddress } = {}) {
  if (!billId) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';
    const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` };
    const dateStr = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const ccRef   = `BILL-${billId}`;
    // Plain hyphen, not an em-dash — Session 183 found ABDM's real careContexts[].display
    // field rejects it ("ABDM-9999: Invalid display") — see the same bug in
    // _abdmCareContextDischarge just above, which has apparently been hitting this
    // same failure silently.
    const display = `Invoice - ${dateStr}`;
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        action: 'create_care_context', patient_id: patientId,
        ipd_id: admId ?? null, bill_id: billId,
        care_context_ref: ccRef, display, hi_types: ['Invoice'],
        abha_number: abhaNumber, abha_address: abhaAddress,
      }),
    });
    if (abhaNumber || abhaAddress) {
      await fetch(ABDM_HIP_FN, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          action: 'generate_link_token', patient_id: patientId,
          abha_number: abhaNumber, abha_address: abhaAddress,
          ipd_id: admId ?? null,
          care_contexts: [{ referenceNumber: ccRef, display, hiType: 'Invoice' }],
        }),
      });
    }
  } catch (e) { console.warn('[ABDM] invoice care context failed:', e.message); }
}

// ── Notes drawer ──────────────────────────────────────────────────────────────
window.openNotesDrawer = function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;
  const pt   = adm.patients || {};
  const bed  = adm.beds || {};
  const dept = adm.departments || {};
  const doc  = adm.profiles || {};
  const days = _daysSince(adm.admitted_at);

  document.getElementById('notes-body').innerHTML = `
    <div class="adm-detail-card" style="margin-bottom:14px">
      <div class="adm-detail-row"><span>Patient</span><strong>${_esc(pt.name||'—')}</strong></div>
      <div class="adm-detail-row"><span>Phone</span><strong>${_esc(pt.phone||'—')}</strong></div>
      ${pt.age||pt.gender ? `<div class="adm-detail-row"><span>Age / Gender</span><strong>${[pt.age?pt.age+'y':'',pt.gender].filter(Boolean).join(' · ')}</strong></div>` : ''}
      ${pt.abha_number ? `<div class="adm-detail-row"><span>ABHA</span><strong>${_esc(pt.abha_number)}</strong></div>` : ''}
    </div>
    <div class="adm-detail-card" style="margin-bottom:14px">
      <div class="adm-detail-row"><span>Bed</span><strong>${_esc(bed.bed_number||'—')}</strong></div>
      ${bed.ward_name ? `<div class="adm-detail-row"><span>Ward</span><strong>${_esc(bed.ward_name)}</strong></div>` : ''}
      <div class="adm-detail-row"><span>Department</span><strong>${_esc(dept.name||'—')}</strong></div>
      <div class="adm-detail-row"><span>Doctor</span><strong>${_esc(doc.full_name||'—')}</strong></div>
      <div class="adm-detail-row"><span>Admitted</span><strong>${_fmt(adm.admission_date)} (${days} days)</strong></div>
      <div class="adm-detail-row"><span>Status</span><strong>${_statusLabel(adm.status==='discharged' ? (adm.disposition||'discharged') : adm.status)}</strong></div>
    </div>
    ${adm.diagnosis_primary || adm.diet_type || adm.notes ? `
    <div class="adm-detail-card">
      ${adm.diagnosis_primary ? `<div class="adm-detail-row"><span>Diagnosis</span><strong>${_esc(adm.diagnosis_primary)}</strong></div>` : ''}
      ${adm.diet_type ? `<div class="adm-detail-row"><span>Diet</span><strong>${_esc(adm.diet_type)}</strong></div>` : ''}
      ${adm.notes ? `<div style="margin-top:8px;font-size:12px;color:var(--text-mid)"><strong>Notes:</strong><br>${_esc(adm.notes)}</div>` : ''}
    </div>` : ''}
    ${adm.discharged_at ? `<div class="adm-detail-card" style="margin-top:14px">
      <div class="adm-detail-row"><span>Discharged</span><strong>${new Date(adm.discharged_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</strong></div>
    </div>` : ''}
  `;

  // Session 114 -- super_admin-only bypass/override, not dept_admin (per
  // confirmed plan decision). Mandatory reason, button stays disabled until
  // one is entered (matching duty-select.html's disabled-until-valid pattern).
  const bypassSection = document.getElementById('bypass-section');
  if (myRole === 'super_admin') {
    document.getElementById('bypass-adm-id').value = admId;
    document.getElementById('bypass-target-status').value = adm.status;
    document.getElementById('bypass-reason').value = '';
    document.getElementById('btn-bypass-confirm').disabled = true;
    bypassSection.style.display = '';
  } else {
    bypassSection.style.display = 'none';
  }

  document.getElementById('notes-overlay').classList.add('open');
};
window.closeNotesDrawer = function() { document.getElementById('notes-overlay').classList.remove('open'); };

window._toggleBypassBtn = function() {
  document.getElementById('btn-bypass-confirm').disabled = !document.getElementById('bypass-reason').value.trim();
};

window.confirmForceStatus = async function() {
  const admId  = document.getElementById('bypass-adm-id').value;
  const target = document.getElementById('bypass-target-status').value;
  const reason = document.getElementById('bypass-reason').value.trim();
  if (!reason) return;
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;
  if (!confirm(`Force this admission's status to "${_statusLabel(target)}"? This bypasses the normal discharge/billing gates and is logged to the audit trail.`)) return;

  const update = { status: target };
  const stampCol = {
    clinically_discharged: 'clinically_discharged_at', charges_locked: 'charges_locked_at',
    bill_generated: 'bill_generated_at', paid_cleared: 'paid_cleared_at', discharged: 'discharged_at',
  }[target];
  if (stampCol) update[stampCol] = new Date().toISOString();

  const { error } = await supabase.from('ipd_admissions').update(update).eq('id', admId);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not force status change.')); return; }

  if (['charges_locked','bill_generated','paid_cleared','discharged'].includes(target) && adm.beds?.id) {
    await supabase.from('beds').update({ status: 'vacant' }).eq('id', adm.beds.id);
  }

  await logAudit('ipd_status_override', 'ipd_admissions', admId, {
    from_status: adm.status, to_status: target, reason, patient_name: adm.patients?.name,
  }, _ctx);

  closeNotesDrawer();
  _alert('success', `Status forced to "${_statusLabel(target)}".`);
  await loadAll();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _daysSince(isoTs) {
  if (!isoTs) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(isoTs).getTime()) / 86400000));
}
function _fmt(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function _statusLabel(s) {
  return {admitted:'Admitted', clinically_discharged:'Discharge Ordered', charges_locked:'Charges Locked',
    bill_generated:'Bill Generated', paid_cleared:'Paid — Awaiting Release',
    discharged:'Discharged', lama:'LAMA', transferred:'Transferred', deceased:'Deceased'}[s] || s;
}
// Session 114 -- status (lifecycle) and disposition (reason) are split. A
// closed admission's status is always 'discharged' regardless of why -- the
// real reason lives in disposition. In-progress billing stages (charges_
// locked/bill_generated/paid_cleared) share one visual style since they're
// all "bed vacated, financial process still running."
function _statusBadgeHtml(a) {
  if (['admitted','clinically_discharged'].includes(a.status)) {
    return `<span class="status-badge status-${a.status==='admitted'?'admitted':'inprogress'}">${_esc(_statusLabel(a.status))}</span>`;
  }
  if (a.status !== 'discharged') {
    return `<span class="status-badge status-inprogress">${_esc(_statusLabel(a.status))}</span>`;
  }
  const key = a.disposition || 'discharged';
  return `<span class="status-badge status-${key}">${_esc(_statusLabel(key))}</span>`;
}
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.className = `alert show ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 3500);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── OT Procedures drawer ──────────────────────────────────────────────────────
let _otAdmId     = null;
let _otPatientId = null;

window.openOtDrawer = async function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;
  _otAdmId     = admId;
  _otPatientId = adm.patients?.id;
  const pt   = adm.patients || {};
  const bed  = adm.beds || {};
  const dept = adm.departments || {};

  document.getElementById('ot-patient-card').innerHTML = `
    <div class="adm-detail-row"><span>Patient</span><strong>${_esc(pt.name||'—')}</strong></div>
    <div class="adm-detail-row"><span>Bed</span><strong>${_esc(bed.bed_number||'—')}${bed.ward_name?' · '+_esc(bed.ward_name):''}</strong></div>
    <div class="adm-detail-row"><span>Department</span><strong>${_esc(dept.name||'—')}</strong></div>
  `;

  // Reset form
  ['ot-proc-name','ot-time','ot-preop-notes','ot-postop-notes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ot-date').value = todayLocalStr();
  document.getElementById('ot-anaesthesia').value = '';
  document.getElementById('ot-status').value = 'planned';
  document.getElementById('ot-safety-checklist').checked = false;
  document.getElementById('ot-aseptic-confirmed').checked = false;
  document.getElementById('ot-uttarabasti-note').style.display = 'none';

  // Load doctors
  const { data: docs } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('tenant_id', tenantId)
    .in('role', ['doctor', 'super_admin', 'dept_admin'])
    .eq('is_active', true)
    .order('full_name');
  const sel = document.getElementById('ot-surgeon');
  sel.innerHTML = '<option value="">— Select doctor —</option>';
  (docs || []).forEach(d => {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.full_name;
    sel.appendChild(o);
  });

  await _loadOtProcedures();
  document.getElementById('ot-overlay').classList.add('open');
};

window.closeOtDrawer = function() {
  document.getElementById('ot-overlay').classList.remove('open');
  _otAdmId = null; _otPatientId = null;
};

async function _loadOtProcedures() {
  if (!_otAdmId) return;
  const { data } = await supabase
    .from('ot_procedures')
    .select('id, procedure_name, procedure_date, procedure_time, status, anaesthesia_type, profiles!surgeon_id(full_name)')
    .eq('ipd_admission_id', _otAdmId)
    .order('procedure_date', { ascending: false });

  const list = document.getElementById('ot-proc-list');
  if (!data || !data.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No OT procedures recorded yet.</div>';
    return;
  }
  list.innerHTML = data.map(p => `
    <div class="ot-proc-item">
      <div class="ot-proc-name">
        ${_esc(p.procedure_name)}
        <span class="ot-proc-status ${p.status}">${p.status.replace('_',' ')}</span>
      </div>
      <div class="ot-proc-meta">
        <span>${_fmt(p.procedure_date)}${p.procedure_time ? ' · ' + p.procedure_time.slice(0,5) : ''}</span>
        ${p.profiles?.full_name ? `<span>Dr. ${_esc(p.profiles.full_name)}</span>` : ''}
        ${p.anaesthesia_type ? `<span>${p.anaesthesia_type}</span>` : ''}
      </div>
    </div>
  `).join('');
}

window.onOtProcChange = function() {
  const isUttarabasti = document.getElementById('ot-proc-name').value.toLowerCase().includes('uttarabasti');
  document.getElementById('ot-uttarabasti-note').style.display = isUttarabasti ? 'block' : 'none';
};

window.saveOtProcedure = async function() {
  const name    = document.getElementById('ot-proc-name').value.trim();
  const date    = document.getElementById('ot-date').value;
  const time    = document.getElementById('ot-time').value;
  const surgeon = document.getElementById('ot-surgeon').value;
  const anaes   = document.getElementById('ot-anaesthesia').value;
  const status  = document.getElementById('ot-status').value;
  const aseptic = document.getElementById('ot-aseptic-confirmed').checked;
  const safety  = document.getElementById('ot-safety-checklist').checked;
  const preop   = document.getElementById('ot-preop-notes').value.trim();
  const postop  = document.getElementById('ot-postop-notes').value.trim();

  if (!name)    { _alert('error', 'Enter procedure name.'); return; }
  if (!date)    { _alert('error', 'Enter procedure date.'); return; }
  if (!surgeon) { _alert('error', 'Select the performing doctor.'); return; }

  // NCISM §47(b)(vii) — Uttarabasti requires explicit aseptic OT confirmation
  if (name.toLowerCase().includes('uttarabasti') && !aseptic) {
    _alert('error', 'NCISM §47(b)(vii): Confirm that Uttarabasti is scheduled in an OT / aseptic theatre before saving.');
    return;
  }

  const btn = document.getElementById('btn-ot-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await supabase.from('ot_procedures').insert({
    tenant_id:              tenantId,
    patient_id:             _otPatientId,
    ipd_admission_id:       _otAdmId,
    procedure_name:         name,
    procedure_date:         date,
    procedure_time:         time || null,
    surgeon_id:             surgeon,
    anaesthesia_type:       anaes || null,
    status,
    ncism_safety_checklist: safety,
    aseptic_confirmed:      aseptic,
    pre_op_notes:           preop || null,
    post_op_notes:          postop || null,
  });

  btn.disabled = false; btn.textContent = 'Save Procedure';
  if (error) { _alert('error', safeErrorMessage(error, 'Save failed. Please try again.')); return; }

  // Clear form fields but keep drawer open for multiple procedures
  ['ot-proc-name','ot-time','ot-preop-notes','ot-postop-notes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ot-surgeon').value = '';
  document.getElementById('ot-anaesthesia').value = '';
  document.getElementById('ot-status').value = 'planned';
  document.getElementById('ot-safety-checklist').checked = false;
  document.getElementById('ot-aseptic-confirmed').checked = false;
  document.getElementById('ot-uttarabasti-note').style.display = 'none';

  _alert('success', 'OT procedure saved.');
  await _loadOtProcedures();
};

// Close on overlay click
['admit-overlay','discharge-overlay','notes-overlay','ot-overlay','pktt-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) document.getElementById(id).classList.remove('open');
  });
});

_loadCarePlanIds();
await loadAll();

// Auto-open admit drawer when arriving from doctor.html via "Open IPD Admission"
const _qp        = new URLSearchParams(window.location.search);
const _qPatientId = _qp.get('patient_id');
if (_qPatientId) {
  const { data: _qPt } = await supabase
    .from('patients')
    .select('id,name,phone,gender,age,abha_number')
    .eq('id', _qPatientId)
    .single();
  if (_qPt) {
    openAdmitDrawer();
    selectPatient(_qPt, _qp.get('visit_id') || null);
  }
}

// Session 205 (cont.) -- arriving from reception's Admission Requests tab
// (ipd.html?advice_id=...). Pre-fills patient/department/diagnosis/diet/notes from
// the doctor's advice and shows its cost estimate as reference; the actual bed and
// admitting doctor are still picked fresh here (a real bed may not match the
// preference by the time reception acts). See sql/session205_admission_advice.sql.
let _currentAdvice = null;
const _qAdviceId = _qp.get('advice_id');
if (_qAdviceId) {
  const { data: advice } = await supabase
    .from('admission_advice')
    .select('id, patient_id, visit_id, department_id, clinical_indication, diet_type, nursing_care_notes, room_type_preference, payer_type, estimated_total, advance_amount_suggested, status, patients(id,name,phone,gender,age,abha_number)')
    .eq('id', _qAdviceId).eq('tenant_id', tenantId).maybeSingle();
  if (advice && advice.status === 'pending' && advice.patients) {
    openAdmitDrawer();  // resets _currentAdvice to null first -- set it AFTER, not before
    _currentAdvice = advice;
    selectPatient(advice.patients, null);
    document.getElementById('adm-dept').value = advice.department_id || '';
    loadVacantBeds();
    document.getElementById('adm-diagnosis').value = advice.clinical_indication || '';
    if (advice.diet_type) document.getElementById('adm-diet').value = advice.diet_type;
    document.getElementById('adm-notes').value = advice.nursing_care_notes || '';
    document.getElementById('adm-advance-amount').value = advice.advance_amount_suggested || '';
    const banner = document.getElementById('adm-advice-banner');
    banner.style.display = '';
    banner.innerHTML = `<strong>From doctor's admission advice</strong> — ` +
      `${advice.payer_type === 'insurance' ? 'Insurance' : 'Self-pay'} · ` +
      `Estimated total: ₹${Number(advice.estimated_total||0).toLocaleString('en-IN')} · ` +
      `Suggested advance: ₹${Number(advice.advance_amount_suggested||0).toLocaleString('en-IN')}`;
  } else if (advice) {
    alert(`This admission advice has already been ${advice.status} — it cannot be used again.`);
  }
}

// Session 302 -- arriving from finance.html's "Open in IPD" link (ipd.html?account=<admission id>).
const _qAccountAdmId = _qp.get('account');
if (_qAccountAdmId && _admissions.some(a => a.id === _qAccountAdmId)) {
  await openAccountDrawer(_qAccountAdmId);
}


// ── §15d — Print Discharge Summary ───────────────────────────────────────────
window.printDischargeSummary = async function(admId) {
  const adm  = _admissions.find(a => a.id === admId);
  if (!adm) return;
  // Show Ayurvedic discharge fields modal before printing
  document.getElementById('ds-modal-adm-id').value = admId;
  document.getElementById('ds-modal-dx-ay').value     = adm.discharge_diagnosis_ayurveda || adm.diagnosis_primary || '';
  document.getElementById('ds-modal-dx-icd').value    = adm.discharge_diagnosis_icd10 || '';
  document.getElementById('ds-modal-meds').value      = adm.discharge_medications || '';
  document.getElementById('ds-modal-pathya').value    = adm.discharge_pathya_apathya || '';
  document.getElementById('ds-modal-pk').value        = adm.discharge_pk_procedures || '';
  document.getElementById('ds-modal-fu-date').value   = adm.discharge_followup_date || '';
  document.getElementById('ds-modal-condition').value = adm.discharge_condition || 'improved';
  document.getElementById('ds-fields-modal').style.display = 'flex';
};

window.saveAndPrintDischarge = async function() {
  const admId = document.getElementById('ds-modal-adm-id').value;
  const adm   = _admissions.find(a => a.id === admId);
  if (!adm) return;
  // Save Ayurvedic fields back to ipd_admissions
  const dsFields = {
    discharge_diagnosis_ayurveda: document.getElementById('ds-modal-dx-ay').value.trim()||null,
    discharge_diagnosis_icd10:    document.getElementById('ds-modal-dx-icd').value.trim()||null,
    discharge_medications:        document.getElementById('ds-modal-meds').value.trim()||null,
    discharge_pathya_apathya:     document.getElementById('ds-modal-pathya').value.trim()||null,
    discharge_pk_procedures:      document.getElementById('ds-modal-pk').value.trim()||null,
    discharge_followup_date:      document.getElementById('ds-modal-fu-date').value||null,
    discharge_condition:          document.getElementById('ds-modal-condition').value||null,
  };
  const { error: dsErr } = await supabase.from('ipd_admissions').update(dsFields).eq('id', admId);
  if (dsErr) { _alert('error', safeErrorMessage(dsErr, 'Could not save discharge details.')); return; }
  // Session 298 -- the print reads the in-memory row; it used to print the stale copy
  // (and loadAll() never even selected these columns), so none of the fields just typed
  // above ever appeared on the printed summary.
  Object.assign(adm, dsFields);
  document.getElementById('ds-fields-modal').style.display = 'none';
  const homeChart = await fetchSamsarjanaHomeChart(supabase, admId);
  _printDischargeSummaryNow(admId, homeChart);
};

window.closeDsModal = function() { document.getElementById('ds-fields-modal').style.display = 'none'; };

function _printDischargeSummaryNow(admId, homeChart) {
  const adm  = _admissions.find(a => a.id === admId);
  if (!adm) return;
  const tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
  // Session 298 -- layout moved to js/modules/ipd/dischargePrint.js, shared with
  // doctor.html's discharge summary so both print the same document.
  printDischargeHtml(buildDischargeSummaryHtml({ adm, admId, tenant, homeChart, esc: _esc, signerName: adm.profiles?.full_name || myProfile?.full_name }));
}

// ── §18bb — Palha-Diet Indent ─────────────────────────────────────────────────
const DIET_HINTS = {
  kashaya:     'Decoction of dried herbs in water (16→4 reduction). Serve warm.',
  swarasa:     'Fresh herb juice — prepare immediately before serving.',
  ksheerapaka: 'Herb paste simmered in milk until water evaporates. Serve warm.',
  kalka:       'Fine herb paste with prescribed vehicle (honey / ghee / milk).',
  pathya_diet: 'Peya (thin gruel) / Vilepi (thick) / Yusha (soup) — specify type.',
  special:     'Enter full preparation name and instructions.',
};

window.onDietTypeChange = function() {
  const t = document.getElementById('diet-type').value;
  document.getElementById('diet-name-hint').textContent = DIET_HINTS[t] || '';
};

window.openDietDrawer = function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;
  const pt  = adm.patients || {};
  const bed = adm.beds || {};
  const dept = adm.departments || {};
  document.getElementById('diet-adm-id').value = admId;
  document.getElementById('diet-pt-id').value  = pt.id || '';
  document.getElementById('diet-pt-info').innerHTML =
    `<strong>${_esc(pt.name||'—')}</strong> · Bed ${_esc(bed.bed_number||'—')} · ${_esc(bed.ward_name||dept.name||'—')}`;
  document.getElementById('diet-name').value        = '';
  document.getElementById('diet-qty').value         = '';
  document.getElementById('diet-instructions').value= '';
  document.getElementById('diet-time').value        = '';
  document.getElementById('diet-date').value        = todayLocalStr();
  document.getElementById('diet-type').value        = 'kashaya';
  document.getElementById('diet-name-hint').textContent = DIET_HINTS.kashaya;
  document.getElementById('diet-overlay').classList.add('open');
};

window.closeDietDrawer = function() {
  document.getElementById('diet-overlay').classList.remove('open');
};

window.saveDietIndent = async function() {
  const admId = document.getElementById('diet-adm-id').value;
  const ptId  = document.getElementById('diet-pt-id').value;
  const name  = document.getElementById('diet-name').value.trim();
  if (!name) { _alert('error', 'Enter preparation name.'); return; }
  const { error } = await supabase.from('palha_diet_indents').insert({
    tenant_id:          tenantId,
    ipd_admission_id:   admId || null,
    patient_id:         ptId,
    preparation_name:   name,
    preparation_type:   document.getElementById('diet-type').value,
    quantity:           document.getElementById('diet-qty').value.trim() || null,
    supply_date:        document.getElementById('diet-date').value,
    supply_time:        document.getElementById('diet-time').value || null,
    special_instructions: document.getElementById('diet-instructions').value.trim() || null,
    prescribed_by:      myProfile?.id,
    status:             'pending',
  });
  if (error) { _alert('error', safeErrorMessage(error)); return; }
  closeDietDrawer();
  _alert('success', `Diet indent sent to kitchen: ${name}`);
};

// ── Ward Round Notes ──────────────────────────────────────────────────────────
let _wrdAdmId = null;

window.openWardRoundsDrawer = async function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;
  _wrdAdmId = admId;
  const pt  = adm.patients || {};
  const dept = adm.departments || {};
  document.getElementById('wrd-pt-info').innerHTML =
    `<strong>${_esc(pt.name||'—')}</strong> · ${_esc(dept.name||'—')} · Bed ${_esc(adm.beds?.bed_number||'—')} · ${_daysSince(adm.admitted_at)} day(s)`;
  ['wrd-subjective','wrd-objective','wrd-assessment','wrd-plan'].forEach(id => {
    document.getElementById(id).value = '';
  });
  await _loadWrdNotes(admId);
  document.getElementById('wrd-overlay').classList.add('open');
};

window.closeWrdDrawer = function() {
  document.getElementById('wrd-overlay').classList.remove('open');
  _wrdAdmId = null;
};

async function _loadWrdNotes(admId) {
  const list = document.getElementById('wrd-notes-list');
  list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px">Loading…</div>';
  const { data } = await supabase.from('ward_round_notes')
    .select('id, note_date, subjective, objective, assessment, plan, profiles(full_name)')
    .eq('admission_id', admId)
    .order('note_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (!data?.length) {
    list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;font-style:italic">No ward round notes yet.</div>';
    return;
  }
  list.innerHTML = data.map(n => `
    <div class="wrd-entry">
      <div class="wrd-entry-hdr">
        <span>${new Date(n.note_date+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</span>
        <span>${_esc(n.profiles?.full_name||'—')}</span>
      </div>
      <div class="wrd-soap">
        ${n.subjective ? `<span class="wrd-soap-lbl" style="color:var(--green-deep)">S</span><span>${_esc(n.subjective)}</span>` : ''}
        ${n.objective  ? `<span class="wrd-soap-lbl" style="color:#1a4080">O</span><span>${_esc(n.objective)}</span>` : ''}
        ${n.assessment ? `<span class="wrd-soap-lbl" style="color:#7a4f00">A</span><span>${_esc(n.assessment)}</span>` : ''}
        ${n.plan       ? `<span class="wrd-soap-lbl" style="color:#7a0000">P</span><span>${_esc(n.plan)}</span>` : ''}
      </div>
    </div>`).join('');
}

window.saveWrdNote = async function() {
  if (!_wrdAdmId) return;
  const subj = document.getElementById('wrd-subjective').value.trim();
  const obj  = document.getElementById('wrd-objective').value.trim();
  const asmt = document.getElementById('wrd-assessment').value.trim();
  const plan = document.getElementById('wrd-plan').value.trim();
  if (!subj && !obj && !asmt && !plan) { _alert('error','Enter at least one SOAP field.'); return; }
  const { error } = await supabase.from('ward_round_notes').insert({
    tenant_id:    tenantId,
    admission_id: _wrdAdmId,
    doctor_id:    myProfile?.id,
    note_date:    todayLocalStr(),
    subjective:   subj||null, objective: obj||null,
    assessment:   asmt||null, plan:      plan||null,
  });
  if (error) { _alert('error', safeErrorMessage(error)); return; }
  ['wrd-subjective','wrd-objective','wrd-assessment','wrd-plan'].forEach(id => {
    document.getElementById(id).value = '';
  });
  await _loadWrdNotes(_wrdAdmId);
  _alert('success','Ward round note saved.');
};

// ── PKTT — Panchakarma Treatment Tracker (Session 294) ─────────────────────────
// Read-only, real-time oversight of an admission's PK Care Plan sessions, reachable
// directly from IPD's admission row (mirrors nursing.html's existing PK Care Plan tab
// content, which is bedside/ward-scoped; this is the admin/reception-facing view,
// same underlying data, plus room/therapist assignment which nursing's tab omits since
// it's a therapist.html concern there).
let _pkttAdmId = null;

window.openPkTrackerDrawer = async function(admId) {
  _pkttAdmId = admId;
  const adm = _admissions.find(a => a.id === admId);
  const pt  = adm?.patients || {};
  document.getElementById('pktt-pt-info').innerHTML =
    `<strong>${_esc(pt.name||'—')}</strong> · Bed ${_esc(adm?.beds?.bed_number||'—')} · ${_esc(adm?.departments?.name||'—')}`;
  document.getElementById('pktt-overlay').classList.add('open');
  await _loadPkTrackerContent(admId);
};

window.closePkTrackerDrawer = function() {
  document.getElementById('pktt-overlay').classList.remove('open');
  _pkttAdmId = null;
};

const PK_PHASE_LABEL = { purvakarma: 'Purvakarma', pradhanakarma: 'Pradhanakarma', paschatkarma: 'Paschatkarma' };
const PK_PHASE_COLOR = { purvakarma: '#7a5a00', pradhanakarma: '#1a4080', paschatkarma: '#1a4a2e' };
const PK_SESSION_STATUS_LABEL = { scheduled: 'Scheduled', in_progress: 'In Progress', completed: '✓ Done', skipped: 'Skipped' };
const PK_SESSION_STATUS_COLOR = { scheduled: '#555', in_progress: '#1a4080', completed: '#1a6b3a', skipped: '#8b1a1a' };

async function _loadPkTrackerContent(admId) {
  const el = document.getElementById('pktt-sessions-list');
  el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px">Loading…</div>';

  const { data: plans, error } = await supabase.from('pk_care_plans')
    .select(`
      id, status, created_at,
      pk_care_plan_protocols(
        id, protocol_label,
        pk_care_plan_days(id, phase, activity_label, planned_date, sequence_order, location_mode,
          pk_therapy_sessions(status, scheduled_time, room_id, therapist_id,
            pk_treatment_rooms(room_name),
            profiles!therapist_id(full_name)
          )
        )
      )
    `)
    .eq('tenant_id', tenantId).eq('ipd_admission_id', admId)
    .order('created_at', { ascending: false });

  if (error) { el.innerHTML = `<div style="color:#c0392b;font-size:12px">Could not load: ${_esc(error.message)}</div>`; return; }
  if (!plans?.length) { el.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:20px;font-size:12px">No Panchakarma Care Plan for this admission.</div>`; return; }

  const today = todayLocalStr();
  el.innerHTML = plans.map(p => {
    const rows = (p.pk_care_plan_protocols || [])
      .flatMap(pr => (pr.pk_care_plan_days || []).map(d => ({ ...d, protocol_label: pr.protocol_label })))
      .sort((a, b) => (a.planned_date||'').localeCompare(b.planned_date||'') || a.sequence_order - b.sequence_order);
    const total = rows.length;
    const done  = rows.filter(d => d.pk_therapy_sessions?.status === 'completed').length;

    return `<div style="border:1.5px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:700;font-size:13px;color:var(--green-deep)">Plan — ${_esc(p.status)} <span style="font-weight:500;color:var(--text-muted)">(${done}/${total} sessions done)</span></div>
        <div style="font-size:11px;color:var(--text-muted)">Created ${_fmt((p.created_at||'').slice(0,10))}</div>
      </div>
      <div style="overflow-x:auto">
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr style="background:#f5faf7">
          <th style="padding:5px 8px;text-align:left;border-bottom:1.5px solid var(--border)">Date</th>
          <th style="padding:5px 8px;text-align:left;border-bottom:1.5px solid var(--border)">Protocol / Activity</th>
          <th style="padding:5px 8px;text-align:left;border-bottom:1.5px solid var(--border)">Phase</th>
          <th style="padding:5px 8px;text-align:left;border-bottom:1.5px solid var(--border)">Time</th>
          <th style="padding:5px 8px;text-align:left;border-bottom:1.5px solid var(--border)">Room / Therapist</th>
          <th style="padding:5px 8px;text-align:left;border-bottom:1.5px solid var(--border)">Status</th>
        </tr></thead>
        <tbody>
          ${rows.map(d => {
            const s = d.pk_therapy_sessions;
            const sessStatus = s?.status || 'scheduled';
            const isToday = d.planned_date === today;
            return `<tr style="border-bottom:1px solid #f0f4f2;${isToday ? 'background:#fff8e1' : ''}">
              <td style="padding:5px 8px">${_esc(d.planned_date || '—')}${isToday ? ' <strong>(Today)</strong>' : ''}</td>
              <td style="padding:5px 8px"><div>${_esc(d.protocol_label)}</div><div style="font-size:10.5px;color:var(--text-muted)">${_esc(d.activity_label)}</div></td>
              <td style="padding:5px 8px"><span style="font-size:10px;font-weight:600;color:${PK_PHASE_COLOR[d.phase]||'#333'};background:${PK_PHASE_COLOR[d.phase]||'#333'}15;padding:2px 7px;border-radius:8px">${PK_PHASE_LABEL[d.phase]||d.phase}</span></td>
              <td style="padding:5px 8px">${s?.scheduled_time ? s.scheduled_time.slice(0,5) : '—'}</td>
              <td style="padding:5px 8px">${d.location_mode === 'home' ? '🏠 Home' : `${_esc(s?.pk_treatment_rooms?.room_name || '—')} / ${_esc(s?.profiles?.full_name || '—')}`}</td>
              <td style="padding:5px 8px">${d.location_mode === 'home'
                ? `<span style="font-size:11px;font-weight:600;color:var(--gold)">🏠 Advised at home</span>`
                : `<span style="font-size:11px;font-weight:600;color:${PK_SESSION_STATUS_COLOR[sessStatus]||'#333'}">${PK_SESSION_STATUS_LABEL[sessStatus]||sessStatus}</span>`}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
    </div>`;
  }).join('');
}

// One page-wide channel (not re-subscribed per drawer open), same "any event -> reload
// if relevant" convention nursing.js's own pk_therapy_sessions channel already uses.
supabase.channel('ipd-pk-tracker')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'pk_therapy_sessions' }, () => {
    if (_pkttAdmId) _loadPkTrackerContent(_pkttAdmId);
  })
  .subscribe();

// ── NABH Care Plan (AAC.3 CORE) ───────────────────────────────────────────────
let _cpAdmId = null, _cpPatientId = null;

window.openCarePlanDrawer = async function(admId, patientId) {
  _cpAdmId = admId; _cpPatientId = patientId;
  const drawer = document.getElementById('cp-drawer');
  drawer.style.display = 'flex';
  document.getElementById('cp-form-area').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Loading…</div>';

  const { data: existing } = await supabase.from('ipd_care_plans')
    .select('*,creator:profiles!created_by(full_name),countersigner:profiles!countersigned_by(full_name)')
    .eq('ipd_admission_id', admId).maybeSingle();

  const { data: adm } = await supabase.from('ipd_admissions')
    .select('admitted_at,diagnosis_primary,patients(name)')
    .eq('id', admId).single();

  const hoursAgo = adm?.admitted_at ? ((Date.now()-new Date(adm.admitted_at))/3600000).toFixed(0) : null;
  const deadlineWarn = hoursAgo !== null && hoursAgo < 24 && !existing
    ? `<div style="background:#fff3cd;border:1.5px solid #e8d08a;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#7a4a00">⏰ <strong>NABH CORE:</strong> Care plan must be documented within 24 hours of admission. ${24-hoursAgo} hours remaining.</div>`
    : hoursAgo >= 24 && !existing
    ? `<div style="background:#fdecea;border:1.5px solid #f5b8b8;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#8b1a1a">🔴 <strong>OVERDUE:</strong> Care plan not documented — ${hoursAgo} hours since admission. NABH CORE requirement missed.</div>`
    : '';

  if (existing) {
    // Show existing care plan with edit and review options
    const cs = existing.countersigned_by ? `<span style="color:var(--green-mid);font-weight:600">✅ Countersigned by ${_esc(existing.countersigner?.full_name||'—')} at ${new Date(existing.countersigned_at).toLocaleString('en-IN',{dateStyle:'short',timeStyle:'short'})}</span>` : `<span style="color:#e67e22;font-weight:600">⏳ Awaiting countersignature</span>`;
    document.getElementById('cp-form-area').innerHTML = `
      ${deadlineWarn}
      <div style="background:var(--green-light);border:1.5px solid #b8ddc6;border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:600;color:var(--green-deep);margin-bottom:6px">Current Care Plan — ${_esc(adm?.patients?.name||'—')}</div>
        <div style="display:grid;gap:6px;font-size:12px">
          <div><strong>Diagnosis:</strong> ${_esc(existing.diagnosis_ayurveda||'—')} ${existing.diagnosis_icd10?'/ '+_esc(existing.diagnosis_icd10):''}</div>
          <div><strong>Goals:</strong> ${_esc(existing.treatment_goals||'—')}</div>
          <div><strong>Interventions:</strong> ${_esc(existing.planned_interventions||'—')}</div>
          ${existing.diet_plan?`<div><strong>Diet:</strong> ${_esc(existing.diet_plan)}</div>`:''}
          ${existing.expected_outcomes?`<div><strong>Expected Outcomes:</strong> ${_esc(existing.expected_outcomes)}</div>`:''}
          ${existing.estimated_los_days?`<div><strong>Estimated LOS:</strong> ${existing.estimated_los_days} days</div>`:''}
          <div style="margin-top:4px">${cs}</div>
          <div style="color:var(--text-muted);font-size:11px">Created by ${_esc(existing.creator?.full_name||'—')} on ${new Date(existing.created_at).toLocaleString('en-IN',{dateStyle:'short',timeStyle:'short'})}</div>
        </div>
      </div>
      ${!existing.countersigned_by ? `
      <div style="background:#fff8e1;border:1.5px solid #f4d03f;border-radius:8px;padding:12px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:600;color:#7a4a00;margin-bottom:6px">Countersign Care Plan (NABH — required within 24h)</div>
        <button data-onclick="countersignCarePlan" data-onclick-a0="${existing.id}" style="height:36px;padding:0 20px;background:#7a4a00;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">✅ Countersign as Clinician-in-Charge</button>
      </div>` : ''}
      <div style="font-size:12px;font-weight:600;color:var(--green-deep);margin-bottom:8px">Add Review Entry</div>
      <div style="display:grid;gap:8px">
        <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Patient Progress</label><textarea id="cp-review-progress" style="width:100%;height:52px;border:1.5px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;resize:none" placeholder="How is the patient responding to treatment…"></textarea></div>
        <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Plan Changes</label><textarea id="cp-review-changes" style="width:100%;height:40px;border:1.5px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;resize:none" placeholder="Modifications to treatment plan…"></textarea></div>
        <button data-onclick="saveCarePlanReview" data-onclick-a0="${existing.id}" style="height:36px;background:var(--green-deep);color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">Save Review Entry</button>
      </div>`;
  } else {
    // New care plan form
    document.getElementById('cp-form-area').innerHTML = `
      ${deadlineWarn}
      <div style="display:grid;gap:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Ayurvedic Diagnosis</label><input id="cp-dx-ay" type="text" value="${_esc(adm?.diagnosis_primary||'')}" placeholder="e.g. Vata-Kaphaja Amavata" style="width:100%;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 10px;font-size:12px;font-family:inherit"/></div>
          <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">ICD-10 Code</label><input id="cp-dx-icd" type="text" placeholder="e.g. M05 — Rheumatoid Arthritis" style="width:100%;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 10px;font-size:12px;font-family:inherit"/></div>
        </div>
        <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Dosha Involvement</label><input id="cp-dosha" type="text" placeholder="e.g. Vata-Pitta predominant, Rasa-Rakta dhatu affected" style="width:100%;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 10px;font-size:12px;font-family:inherit"/></div>
        <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Treatment Goals *</label><textarea id="cp-goals" placeholder="Short-term: pain relief within 3 days. Long-term: improve mobility and reduce inflammation…" style="width:100%;height:60px;border:1.5px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;resize:none"></textarea></div>
        <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Planned Interventions *</label><textarea id="cp-interventions" placeholder="Medications: Dashamula Kashaya 60ml BD, Rasna Saptak Kwatha OD. PK: Abhyanga + Swedana daily × 7 days. Nursing: vitals 4-hourly…" style="width:100%;height:64px;border:1.5px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;resize:none"></textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Diet Plan (Pathya-Apathya)</label><textarea id="cp-diet" placeholder="Pathya: warm, light, easily digestible food. Apathya: cold, heavy, spicy foods…" style="width:100%;height:52px;border:1.5px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;resize:none"></textarea></div>
          <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Expected Outcomes</label><textarea id="cp-outcomes" placeholder="Reduction of joint pain by 50% in 7 days. Improved ROM…" style="width:100%;height:52px;border:1.5px solid var(--border);border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;resize:none"></textarea></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Estimated LOS (days)</label><input id="cp-los" type="number" min="1" placeholder="e.g. 14" style="width:100%;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 10px;font-size:12px;font-family:inherit"/></div>
          <div><label style="font-size:11px;font-weight:600;color:var(--text-mid);display:block;margin-bottom:3px;text-transform:uppercase">Discharge Criteria</label><input id="cp-discharge-criteria" type="text" placeholder="e.g. Pain score <3, able to walk independently" style="width:100%;height:34px;border:1.5px solid var(--border);border-radius:7px;padding:0 10px;font-size:12px;font-family:inherit"/></div>
        </div>
        <button data-onclick="saveCarePlan" style="height:40px;background:var(--green-deep);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">📋 Save Care Plan</button>
      </div>`;
  }
};

window.closeCarePlanDrawer = function(isBackdropClick) {
  if (isBackdropClick === false) return; // click landed inside the drawer panel, not the backdrop itself
  document.getElementById('cp-drawer').style.display = 'none';
};

window.saveCarePlan = async function() {
  const goals         = document.getElementById('cp-goals').value.trim();
  const interventions = document.getElementById('cp-interventions').value.trim();
  if (!goals || !interventions) { _alert('error','Treatment goals and interventions are required'); return; }

  const { error } = await supabase.from('ipd_care_plans').insert({
    tenant_id:             tenantId,
    patient_id:            _cpPatientId,
    ipd_admission_id:      _cpAdmId,
    diagnosis_ayurveda:    document.getElementById('cp-dx-ay').value.trim()||null,
    diagnosis_icd10:       document.getElementById('cp-dx-icd').value.trim()||null,
    dosha_involvement:     document.getElementById('cp-dosha').value.trim()||null,
    treatment_goals:       goals,
    planned_interventions: interventions,
    diet_plan:             document.getElementById('cp-diet').value.trim()||null,
    expected_outcomes:     document.getElementById('cp-outcomes').value.trim()||null,
    estimated_los_days:    parseInt(document.getElementById('cp-los').value)||null,
    discharge_criteria:    document.getElementById('cp-discharge-criteria').value.trim()||null,
    created_by:            myProfile?.id,
  });
  if (error) { _alert('error', safeErrorMessage(error)); return; }
  await supabase.from('ipd_admissions').update({ care_plan_initiated_at: new Date().toISOString() }).eq('id', _cpAdmId);
  _carePlanAdmIds.add(_cpAdmId);
  _alert('success','Care plan saved. Please arrange countersignature within 24 hours.');
  openCarePlanDrawer(_cpAdmId, _cpPatientId);
  loadAll();
};

window.countersignCarePlan = async function(cpId) {
  const { error } = await supabase.from('ipd_care_plans').update({
    countersigned_by: myProfile?.id,
    countersigned_at: new Date().toISOString(),
  }).eq('id', cpId);
  if (error) { _alert('error', safeErrorMessage(error)); return; }
  _alert('success','Care plan countersigned.');
  openCarePlanDrawer(_cpAdmId, _cpPatientId);
};

window.saveCarePlanReview = async function(cpId) {
  const progress = document.getElementById('cp-review-progress')?.value.trim();
  const changes  = document.getElementById('cp-review-changes')?.value.trim();
  if (!progress && !changes) { _alert('error','Enter progress or plan changes'); return; }
  const { error } = await supabase.from('care_plan_reviews').insert({
    tenant_id:       tenantId,
    care_plan_id:    cpId,
    reviewed_by:     myProfile?.id,
    review_date:     todayLocalStr(),
    patient_progress: progress||null,
    plan_changes:    changes||null,
  });
  if (error) { _alert('error', safeErrorMessage(error)); return; }
  _alert('success','Review entry saved.');
  if (document.getElementById('cp-review-progress')) document.getElementById('cp-review-progress').value = '';
  if (document.getElementById('cp-review-changes'))  document.getElementById('cp-review-changes').value  = '';
};
