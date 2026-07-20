import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { isNCISMType } from '../config/ncism.js';
import { logAudit } from '../core/auditLogger.js';
import { computeRoomTariff } from '../modules/billing/roomTariff.js';

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

await requireAuth(['super_admin','dept_admin','doctor','receptionist','nurse']);
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
        status, disposition, diagnosis_primary, diet_type, notes,
        patients(id, name, phone, abha_number, age, gender),
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
  const today      = new Date().toISOString().slice(0, 10);
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
    const required = Math.floor(ugIntake * ratio);
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
  ['filter-dept','adm-dept'].forEach(id => {
    const sel = document.getElementById(id);
    const saved = sel.value;
    const isFilter = id === 'filter-dept';
    sel.innerHTML = isFilter ? '<option value="">All Departments</option>' : '<option value="">— Select department —</option>';
    _depts.forEach(d => {
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
          ${canOrderDischarge ? `<button class="icon-btn danger" data-onclick="openDischargeDrawer" data-onclick-a0="${a.id}" title="Order Discharge / Exit">&#10006;</button>` : ''}
          ${canGenerateBill ? `<button class="icon-btn" data-onclick="openGenerateBillDrawer" data-onclick-a0="${a.id}" title="Generate IPD Bill" style="font-size:10px;font-weight:700;color:#1a4a2e;border-color:#b8ddc6;background:#e8f5ee">💰</button>` : ''}
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
  document.getElementById('adm-date').value    = new Date().toISOString().slice(0,10);
  document.getElementById('bed-picker').innerHTML = '<span class="bed-picker-empty">Select a department first</span>';
  _populateDoctorSelect(); // reset to "select department first" state
  goStep(1);
  document.getElementById('admit-overlay').classList.add('open');
};

window.closeAdmitDrawer = function() {
  document.getElementById('admit-overlay').classList.remove('open');
};

window.goStep = function(n) {
  n = Number(n);
  if (n === 2 && !_selectedPatient) return;

  [1,2].forEach(i => {
    document.getElementById(`step-${i}`).classList.toggle('active', i === n);
    document.getElementById(`step-lbl-${i}`).className = 'step' + (i === n ? ' active' : i < n ? ' done' : '');
  });

  document.getElementById('btn-admit-back').style.display  = n === 2 ? '' : 'none';
  document.getElementById('btn-admit-save').style.display  = n === 2 ? '' : 'none';

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

  const vacant = _allBeds.filter(b => b.department_id === deptId && b.status === 'vacant');
  if (!vacant.length) {
    picker.innerHTML = '<span class="bed-picker-empty">No vacant beds in this department</span>';
    return;
  }

  picker.innerHTML = vacant.map(b => {
    const isPk = b.bed_type === 'pk_treatment';
    return `<div class="bed-option${isPk ? ' pk' : ''}" data-id="${b.id}" data-onclick="pickBed" data-onclick-a0="@this" data-onclick-a1="${b.id}">
      ${_esc(b.bed_number)}${b.ward_name ? '<br><span style="font-size:9px;font-weight:400">'+_esc(b.ward_name)+'</span>' : ''}
    </div>`;
  }).join('');
};

window.pickBed = function(el, bedId) {
  document.querySelectorAll('.bed-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('adm-bed-id').value = bedId;
};

// ── Save admission ─────────────────────────────────────────────────────────────
window.toggleMlcFields = function(show) {
  const el = document.getElementById('mlc-fields');
  if (el) el.style.display = show ? 'grid' : 'none';
};

window.saveAdmission = async function() {
  if (!_selectedPatient) { _alert('error','Select a patient first.'); return; }
  const deptId    = document.getElementById('adm-dept').value;
  const bedId     = document.getElementById('adm-bed-id').value;
  const doctorId  = document.getElementById('adm-doctor').value;
  const diagnosis = document.getElementById('adm-diagnosis').value.trim();
  const admDate   = document.getElementById('adm-date').value;
  const diet      = document.getElementById('adm-diet').value;
  const notes     = document.getElementById('adm-notes').value.trim();
  const isMlc     = document.getElementById('adm-is-mlc').checked;

  if (!deptId)   { _alert('error','Select a department.'); return; }
  if (!bedId)    { _alert('error','Select a bed.'); return; }
  if (!doctorId) { _alert('error','Select an admitting doctor.'); return; }
  if (!admDate)  { _alert('error','Enter admission date.'); return; }

  // Guard against admitting the same patient into a second bed while an earlier
  // admission is still open (not yet fully discharged) -- queried fresh against
  // the DB rather than the in-memory list, since that can be stale by save time.
  const { data: openAdms } = await supabase.from('ipd_admissions')
    .select('id, beds(bed_number)')
    .eq('tenant_id', tenantId).eq('patient_id', _selectedPatient.id)
    .neq('status', 'discharged');
  if (openAdms && openAdms.length) {
    const bedLabel = openAdms[0].beds?.bed_number || 'a bed';
    _alert('error', `${_selectedPatient.name} already has an open IPD admission (${bedLabel}). Discharge that admission before creating a new one.`);
    return;
  }

  const btn = document.getElementById('btn-admit-save');
  btn.disabled = true; btn.textContent = 'Admitting…';

  const mlcData = isMlc ? {
    is_mlc:              true,
    mlc_number:          document.getElementById('adm-mlc-no').value.trim() || null,
    mlc_police_station:  document.getElementById('adm-mlc-ps').value.trim() || null,
    mlc_nature:          document.getElementById('adm-mlc-nature').value.trim() || null,
    mlc_police_intimation: document.getElementById('adm-mlc-police').value,
    mlc_intimation_at:   document.getElementById('adm-mlc-time').value ? new Date(document.getElementById('adm-mlc-time').value).toISOString() : null,
  } : { is_mlc: false };

  const { error: admErr } = await supabase.from('ipd_admissions').insert({
    tenant_id:           tenantId,
    patient_id:          _selectedPatient.id,
    bed_id:              bedId,
    department_id:       deptId,
    admitting_doctor_id: doctorId,
    admission_date:      admDate,
    admitted_at:         new Date().toISOString(),
    status:              'admitted',
    diagnosis_primary:   diagnosis || null,
    diet_type:           diet || null,
    notes:               notes || null,
    ...mlcData,
  });

  // Being admitted resolves any OPD visit this patient still has open at Reception's
  // queue level -- otherwise it lingers forever and trips reception.html's "stale visit
  // from a previous day" end-of-day banner even though the patient has since moved to
  // IPD. Closes every still-open visit for this patient, not just the one that
  // triggered this admission (if any) -- once admitted, none of them are still "waiting".
  if (!admErr) {
    await supabase.from('visits')
      .update({ status: 'completed' })
      .eq('tenant_id', tenantId).eq('patient_id', _selectedPatient.id)
      .in('status', ['waiting', 'in_progress']);
  }

  if (admErr) {
    btn.disabled = false; btn.textContent = 'Admit Patient';
    _alert('error', 'Admission failed: ' + admErr.message); return;
  }

  // Mark bed occupied
  await supabase.from('beds').update({ status: 'occupied' }).eq('id', bedId);

  // NABH — Save admission consent record
  const consentBy = document.getElementById('adm-consent-by').value.trim();
  if (consentBy) {
    const { data: newAdm } = await supabase.from('ipd_admissions')
      .select('id').eq('patient_id', _selectedPatient.id).order('admitted_at', { ascending: false }).limit(1).single();
    if (newAdm?.id) {
      await supabase.from('consent_records').insert({
        tenant_id:              tenantId,
        patient_id:             _selectedPatient.id,
        ipd_admission_id:       newAdm.id,
        consent_type:           'general_treatment',
        consent_given:          true,
        consent_by:             consentBy,
        relationship:           document.getElementById('adm-consent-rel').value,
        risks_explained:        document.getElementById('adm-consent-risks').checked,
        alternatives_explained: document.getElementById('adm-consent-alts').checked,
        questions_answered:     document.getElementById('adm-consent-questions').checked,
      });
    }
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
  document.getElementById('dis-date').value      = new Date().toISOString().slice(0,10);
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
  const adm = _admissions.find(a => a.id === admId);
  if (adm?.patients?.abha_number) {
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

  document.getElementById('bill-overlay').classList.add('open');
  await _refreshBillPreview(adm);
};

window.closeGenerateBillDrawer = function() {
  document.getElementById('bill-overlay').classList.remove('open');
};

async function _refreshBillPreview(adm) {
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
        <button class="icon-btn" data-onclick="voidBillCharge" data-onclick-a0="${r.id}" title="Remove" style="font-size:11px">&#10005;</button>
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
  await _loadBillCharges(admId);
};

window.voidBillCharge = async function(chargeId) {
  const admId = document.getElementById('bill-adm-id').value;
  const { error } = await supabase.from('ipd_stay_charges').update({ status: 'voided' }).eq('id', chargeId);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not remove charge.')); return; }
  await _loadBillCharges(admId);
};

window.confirmGenerateBill = async function() {
  const admId = document.getElementById('bill-adm-id').value;
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;
  if (!_billTariff) { _alert('error','Fix the room tariff issue above before generating the bill.'); return; }

  const payerType = document.getElementById('bill-payer-type').value;
  const btn = document.getElementById('btn-generate-bill');
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

  const { data: bill, error: billErr } = await supabase.from('bills').insert({
    tenant_id: tenantId, patient_id: adm.patients?.id,
    bill_type: 'ipd', total_amount: finalAmount, final_amount: finalAmount,
    payer_type: payerType, insurance_claim_status: insuranceClaimStatus,
    status: 'pending', payment_mode: null,
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

  btn.disabled = false; btn.textContent = 'Generate Bill';
  closeGenerateBillDrawer();
  _alert('success', `IPD bill generated — ₹${finalAmount.toLocaleString('en-IN')}.`);
  await loadAll();
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
    const pt      = adm.patients;
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers,
      body: JSON.stringify({
        action: 'create_care_context', patient_id: pt.id,
        ipd_id: admId, care_context_ref: ccRef,
        display: `IPD Discharge — ${dateStr}`, hi_types: ['DischargeSummary'],
        abha_number: pt.abha_number,
      }),
    });
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers,
      body: JSON.stringify({
        action: 'generate_link_token', patient_id: pt.id,
        abha_number: pt.abha_number, ipd_id: admId,
        care_contexts: [{ referenceNumber: ccRef, display: `IPD Discharge — ${dateStr}`, hiType: 'DischargeSummary' }],
      }),
    });
  } catch (e) { console.warn('[ABDM] discharge care context failed:', e.message); }
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
  document.getElementById('ot-date').value = new Date().toISOString().slice(0,10);
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
['admit-overlay','discharge-overlay','notes-overlay','ot-overlay'].forEach(id => {
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
  await supabase.from('ipd_admissions').update({
    discharge_diagnosis_ayurveda: document.getElementById('ds-modal-dx-ay').value.trim()||null,
    discharge_diagnosis_icd10:    document.getElementById('ds-modal-dx-icd').value.trim()||null,
    discharge_medications:        document.getElementById('ds-modal-meds').value.trim()||null,
    discharge_pathya_apathya:     document.getElementById('ds-modal-pathya').value.trim()||null,
    discharge_pk_procedures:      document.getElementById('ds-modal-pk').value.trim()||null,
    discharge_followup_date:      document.getElementById('ds-modal-fu-date').value||null,
    discharge_condition:          document.getElementById('ds-modal-condition').value||null,
  }).eq('id', admId);
  document.getElementById('ds-fields-modal').style.display = 'none';
  _printDischargeSummaryNow(admId);
};

window.closeDsModal = function() { document.getElementById('ds-fields-modal').style.display = 'none'; };

function _printDischargeSummaryNow(admId) {
  const adm  = _admissions.find(a => a.id === admId);
  if (!adm) return;
  const pt   = adm.patients || {};
  const bed  = adm.beds || {};
  const dept = adm.departments || {};
  const doc  = adm.profiles || {};
  const tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');

  const admDate = adm.admission_date
    ? new Date(adm.admission_date+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})
    : '—';
  const disDate = adm.discharged_at
    ? new Date(adm.discharged_at).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})
    : new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});
  const los = _daysSince(adm.admitted_at) || '—';
  const statusLabel = { discharged:'Discharged', lama:'LAMA (Left Against Medical Advice)', transferred:'Transferred', deceased:'Deceased' }[adm.status] || adm.status;

  document.getElementById('ds-print').innerHTML = `
<div style="font-family:'DM Sans',sans-serif;max-width:680px;margin:0 auto;color:#1c2b1f">
  <div style="text-align:center;padding:14px 0 10px;border-bottom:3px double #1a4a2e">
    <div style="font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600;color:#1a4a2e">${_esc(tenant.name||'Ayurveda Hospital')}</div>
    <div style="font-size:11px;color:#6a8070;margin-top:2px">${_esc(tenant.city||'')} ${_esc(tenant.state||'')}</div>
  </div>
  <div style="text-align:center;padding:10px;background:#f5fbf8;border-bottom:1px solid #c8ddd0">
    <div style="font-size:16px;font-weight:700;letter-spacing:2px;color:#1a4a2e;text-transform:uppercase">DISCHARGE SUMMARY</div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #c8ddd0;border-top:none">
    <div style="padding:12px 16px;border-right:1px solid #c8ddd0">
      <div style="font-size:18px;font-weight:600;color:#1a4a2e">${_esc(pt.name||'—')}</div>
      <div style="font-size:12px;color:#4a6352;margin-top:3px;display:flex;flex-wrap:wrap;gap:10px">
        ${pt.age||pt.gender ? `<span>${[pt.age?pt.age+'y':'',pt.gender].filter(Boolean).join(' · ')}</span>` : ''}
        ${pt.phone ? `<span>Ph: ${_esc(pt.phone)}</span>` : ''}
        ${pt.abha_number ? `<span>ABHA: ${_esc(pt.abha_number)}</span>` : ''}
      </div>
    </div>
    <div style="padding:12px 16px;font-size:12px;color:#4a6352">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px">
        <span style="font-weight:600">IPD No:</span><span>${admId.slice(0,8).toUpperCase()}</span>
        <span style="font-weight:600">Ward / Bed:</span><span>${_esc(bed.ward_name||dept.name||'—')} / Bed ${_esc(bed.bed_number||'—')}</span>
        <span style="font-weight:600">Doctor:</span><span>${_esc(doc.full_name||'—')}</span>
        <span style="font-weight:600">Department:</span><span>${_esc(dept.name||'—')}</span>
      </div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #c8ddd0;border-top:none;font-size:12px">
    <div style="padding:8px 14px;border-right:1px solid #c8ddd0"><span style="font-weight:600">Admitted:</span> ${admDate}</div>
    <div style="padding:8px 14px;border-right:1px solid #c8ddd0"><span style="font-weight:600">Discharged:</span> ${disDate}</div>
    <div style="padding:8px 14px"><span style="font-weight:600">LOS:</span> ${los} day(s) · <strong>${statusLabel}</strong></div>
  </div>
  ${adm.diagnosis_primary ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:10px 16px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#4a6352;margin-bottom:4px">Diagnosis</div>
    <div style="font-size:13px;font-weight:600">${_esc(adm.diagnosis_primary)}</div>
  </div>` : ''}
  ${adm.discharge_diagnosis_ayurveda || adm.discharge_diagnosis_icd10 ? `
  <div style="display:grid;grid-template-columns:1fr 1fr;border:1px solid #c8ddd0;border-top:none;font-size:12px">
    ${adm.discharge_diagnosis_ayurveda ? `<div style="padding:8px 14px;border-right:1px solid #c8ddd0"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:2px">Final Ayurvedic Diagnosis</div><div style="font-weight:600">${_esc(adm.discharge_diagnosis_ayurveda)}</div></div>` : '<div></div>'}
    ${adm.discharge_diagnosis_icd10 ? `<div style="padding:8px 14px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:2px">ICD-10 Code</div><div>${_esc(adm.discharge_diagnosis_icd10)}</div></div>` : '<div></div>'}
  </div>` : ''}
  ${adm.discharge_pk_procedures ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:8px 14px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:3px">Panchakarma / Procedures Performed</div>
    <div style="font-size:12px;white-space:pre-wrap">${_esc(adm.discharge_pk_procedures)}</div>
  </div>` : ''}
  ${adm.discharge_medications ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:8px 14px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:3px">Medications on Discharge (with Anupana)</div>
    <div style="font-size:12px;white-space:pre-wrap">${_esc(adm.discharge_medications)}</div>
  </div>` : ''}
  ${adm.discharge_pathya_apathya ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:8px 14px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:3px">Pathya (Do's) &amp; Apathya (Don'ts)</div>
    <div style="font-size:12px;white-space:pre-wrap">${_esc(adm.discharge_pathya_apathya)}</div>
  </div>` : ''}
  <div style="border:1px solid #c8ddd0;border-top:none;padding:10px 16px;min-height:60px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#4a6352;margin-bottom:6px">Clinical Notes / Discharge Advice</div>
    <div style="font-size:12px;line-height:1.8;white-space:pre-wrap">${_esc(adm.notes||'—')}</div>
  </div>
  ${adm.discharge_followup_date ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:8px 14px;background:#f5fbf8">
    <span style="font-size:12px;font-weight:600;color:#1a4a2e">📅 Follow-up OPD: </span>
    <span style="font-size:12px">${new Date(adm.discharge_followup_date+'T00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</span>
  </div>` : ''}
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border:1px solid #c8ddd0;border-top:none;padding:12px 16px;background:#fafbf9">
    <div style="font-size:11px;color:#6a8070">Printed: ${new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</div>
    <div style="text-align:center">
      <div style="width:160px;border-top:1px solid #aaa;padding-top:5px;font-size:11px;color:#6a8070">
        ${_esc(doc.full_name||myProfile?.full_name||'—')}<br>
        <span style="font-size:10px">${_esc(dept.name||'')}</span>
      </div>
    </div>
  </div>
  <div style="text-align:center;margin-top:8px;font-size:10px;color:#aaa">Powered by AyurXpert Technologies™</div>
</div>`;

  document.body.classList.add('ds-print');
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('ds-print');
    document.getElementById('ds-print').style.display = 'none';
  }, { once: true });
  document.getElementById('ds-print').style.display = 'block';
  window.print();
};

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
  document.getElementById('diet-date').value        = new Date().toISOString().slice(0,10);
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
    note_date:    new Date().toISOString().slice(0,10),
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
    review_date:     new Date().toISOString().slice(0,10),
    patient_progress: progress||null,
    plan_changes:    changes||null,
  });
  if (error) { _alert('error', safeErrorMessage(error)); return; }
  _alert('success','Review entry saved.');
  if (document.getElementById('cp-review-progress')) document.getElementById('cp-review-progress').value = '';
  if (document.getElementById('cp-review-changes'))  document.getElementById('cp-review-changes').value  = '';
};
