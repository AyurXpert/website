import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { isNCISMType } from '../config/ncism.js';

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

let _admissions  = [];
let _depts       = [];
let _allBeds     = [];
let _doctors     = [];
let _opdDoctors  = [];   // { doctor_id, opd_id } — for NCISM ward auth
let _selectedPatient = null;

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
        id, tenant_id, admission_date, admitted_at, discharged_at,
        status, diagnosis_primary, diet_type, notes,
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
  const admitted   = _admissions.filter(a => a.status === 'admitted').length;
  const vacant     = _allBeds.filter(b => b.status === 'vacant').length;
  const today      = new Date().toISOString().slice(0, 10);
  const todayDis   = _admissions.filter(a =>
    a.discharged_at && a.discharged_at.slice(0,10) === today
  ).length;

  const currentAdm = _admissions.filter(a => a.status === 'admitted');
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

  let rows = _admissions;
  if (statFilter) rows = rows.filter(a => a.status === statFilter);
  else if (statFilter === '') rows = rows; // all
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
      <td><span class="status-badge status-${a.status}">${_statusLabel(a.status)}</span></td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-onclick="openNotesDrawer" data-onclick-a0="${a.id}" title="View details">&#128203;</button>
          <button class="icon-btn" data-onclick="openCarePlanDrawer" data-onclick-a0="${a.id}" data-onclick-a1="${a.patients?.id||''}" title="Care Plan (NABH CORE)" style="font-size:10px;font-weight:700;color:#7a4a00;border-color:#e8d08a;background:#fffdf0">CP</button>
          <button class="icon-btn" data-onclick="openWardRoundsDrawer" data-onclick-a0="${a.id}" title="Ward Round Notes" style="font-size:10px;font-weight:700;color:#1a4a2e;border-color:#b8ddc6;background:#e8f5ee">WR</button>
          <button class="icon-btn" data-onclick="openDietDrawer" data-onclick-a0="${a.id}" title="Palha-Diet Indent" style="font-size:11px">🍲</button>
          <button class="icon-btn" data-onclick="printDischargeSummary" data-onclick-a0="${a.id}" title="Print Discharge Summary" style="font-size:11px">🖨</button>
          ${canDischarge ? `<button class="icon-btn" data-onclick="openOtDrawer" data-onclick-a0="${a.id}" title="OT Procedures" style="font-size:10px;font-weight:700;color:#1a4080;border-color:#a8c8f0;background:#e3f0ff">OT</button>` : ''}
          ${canDischarge ? `<button class="icon-btn danger" data-onclick="openDischargeDrawer" data-onclick-a0="${a.id}" title="Discharge">&#10006;</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Admit drawer ──────────────────────────────────────────────────────────────
window.openAdmitDrawer = function() {
  _selectedPatient = null;
  document.getElementById('pt-search').value = '';
  document.getElementById('patient-results').innerHTML = '';
  document.getElementById('patient-results').classList.remove('show');
  document.getElementById('spt').classList.remove('show');
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

window.selectPatient = function(p) {
  _selectedPatient = p;
  document.getElementById('spt-name').textContent = p.name;
  const meta = [p.phone, p.gender, p.age ? p.age+'y' : ''].filter(Boolean).join(' · ');
  document.getElementById('spt-meta').textContent = meta;
  document.getElementById('spt').classList.add('show');
  document.getElementById('search-area').style.display = 'none';
  document.getElementById('patient-results').classList.remove('show');
  document.getElementById('btn-step1-next').disabled = false;
};

window.clearPatientSelection = function() {
  _selectedPatient = null;
  document.getElementById('spt').classList.remove('show');
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
window.openDischargeDrawer = async function(admId) {
  const adm = _admissions.find(a => a.id === admId);
  if (!adm) return;

  document.getElementById('dis-adm-id').value    = admId;
  document.getElementById('dis-bed-id').value    = adm.beds?.id || '';
  document.getElementById('dis-patient-id').value = adm.patients?.id || '';
  document.getElementById('dis-bill-id').value   = '';
  document.getElementById('dis-date').value      = new Date().toISOString().slice(0,10);
  document.getElementById('dis-summary').value   = '';
  document.getElementById('dis-condition').value = '';
  document.getElementById('dis-transfer-to').value = '';
  document.getElementById('dis-type').value      = 'discharged';
  document.getElementById('dis-transfer-field').style.display = 'none';
  document.getElementById('dis-ins-section').style.display    = 'none';
  document.getElementById('dis-ins-approved').value           = '';
  document.getElementById('dis-ins-claim-status').value       = 'submitted';

  document.querySelectorAll('.discharge-opt').forEach(o => {
    o.classList.toggle('selected', o.dataset.val === 'discharged');
  });

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

  // Check for an insurance/PMJAY bill and show settlement fields if found
  const patId = adm.patients?.id;
  if (patId) {
    const { data: insBill } = await supabase
      .from('bills')
      .select('id, payer_type, final_amount, insurance_claim_status')
      .eq('patient_id', patId)
      .eq('tenant_id', tenantId)
      .neq('payer_type', 'self_pay')
      .in('status', ['pending', 'partial'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (insBill) {
      document.getElementById('dis-bill-id').value    = insBill.id;
      document.getElementById('dis-bill-total').value = insBill.final_amount || 0;
      document.getElementById('dis-ins-section').style.display = '';
      const labels = { insurance:'Insurance/TPA', pmjay:'PMJAY (Ayushman)', cghs:'CGHS / ECHS', echs:'ECHS', esi:'ESIC', corporate:'Corporate' };
      document.getElementById('dis-ins-heading').textContent =
        `🏥 ${labels[insBill.payer_type] || 'Insurance'} Settlement`;
      if (insBill.insurance_claim_status && insBill.insurance_claim_status !== 'not_applicable') {
        document.getElementById('dis-ins-claim-status').value = insBill.insurance_claim_status;
      }
      _updateDischargeDue();
    }
  }

  document.getElementById('discharge-overlay').classList.add('open');
};
window.closeDischargeDrawer = function() {
  document.getElementById('discharge-overlay').classList.remove('open');
};

window._updateDischargeDue = function() {
  const total    = parseFloat(document.getElementById('dis-bill-total').value) || 0;
  const approved = parseFloat(document.getElementById('dis-ins-approved').value) || 0;
  const due      = Math.max(0, total - approved);
  const dueRow   = document.getElementById('dis-due-row');
  const dueAmt   = document.getElementById('dis-due-amt');
  const collectW = document.getElementById('dis-collect-wrap');
  if (total > 0) {
    dueRow.style.display    = 'flex';
    dueAmt.textContent      = `₹${due.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    collectW.style.display  = due > 0 ? '' : 'none';
    if (due <= 0) {
      document.getElementById('dis-collect-now').checked = false;
      document.getElementById('dis-collect-mode').style.display = 'none';
    }
  }
};

window._toggleCollectNow = function() {
  const checked = document.getElementById('dis-collect-now').checked;
  document.getElementById('dis-collect-mode').style.display = checked ? '' : 'none';
};

window.selectDischargeType = function(el) {
  document.querySelectorAll('.discharge-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('dis-type').value = el.dataset.val;
  document.getElementById('dis-transfer-field').style.display =
    el.dataset.val === 'transferred' ? '' : 'none';
};

window.saveDischarge = async function() {
  const admId   = document.getElementById('dis-adm-id').value;
  const bedId   = document.getElementById('dis-bed-id').value;
  const disType = document.getElementById('dis-type').value;
  const disDate = document.getElementById('dis-date').value;
  const summary = document.getElementById('dis-summary').value.trim();

  if (!disDate) { _alert('error','Enter discharge date.'); return; }

  const btn = document.getElementById('btn-discharge-save');
  btn.disabled = true; btn.textContent = 'Discharging…';

  const { error } = await supabase.from('ipd_admissions').update({
    status:       disType,
    discharged_at: new Date().toISOString(),
    notes: summary || null,
  }).eq('id', admId);

  if (error) {
    btn.disabled = false; btn.textContent = 'Confirm Discharge';
    _alert('error', safeErrorMessage(error, 'Discharge failed. Please try again.')); return;
  }

  // Free the bed
  if (bedId) await supabase.from('beds').update({ status: 'vacant' }).eq('id', bedId);

  // Update insurance bill if present
  const billId     = document.getElementById('dis-bill-id').value;
  const insVisible = document.getElementById('dis-ins-section').style.display !== 'none';
  if (billId && insVisible) {
    const totalBill   = parseFloat(document.getElementById('dis-bill-total').value) || 0;
    const approved    = parseFloat(document.getElementById('dis-ins-approved').value) || 0;
    const claimStatus = document.getElementById('dis-ins-claim-status').value || 'submitted';

    if (approved > totalBill && totalBill > 0) {
      btn.disabled = false; btn.textContent = 'Confirm Discharge';
      _alert('error', `Approved amount (₹${approved.toLocaleString('en-IN')}) cannot exceed total bill (₹${totalBill.toLocaleString('en-IN')}).`);
      return;
    }

    const insUpdate = { insurance_claim_status: claimStatus };
    if (approved > 0) insUpdate.insurance_approved_amount = approved;

    const collectNow  = document.getElementById('dis-collect-now').checked;
    const patientDue  = Math.max(0, totalBill - approved);
    if (collectNow && patientDue > 0) {
      const payMode          = document.querySelector('input[name="dis_pay_mode"]:checked')?.value || 'cash';
      insUpdate.status       = 'partial';   // patient portion settled; TPA portion pending
      insUpdate.payment_mode = payMode;
    }

    await supabase.from('bills').update(insUpdate).eq('id', billId);
  }

  // ABDM M2 — create care context for DischargeSummary FHIR type (fire-and-forget)
  const adm = _admissions.find(a => a.id === admId);
  if (adm?.patients?.abha_number) {
    _abdmCareContextDischarge(adm, admId).catch(() => {});
  }

  btn.disabled = false; btn.textContent = 'Confirm Discharge';
  closeDischargeDrawer();
  _alert('success', 'Patient discharged successfully.');
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
      <div class="adm-detail-row"><span>Status</span><strong>${_statusLabel(adm.status)}</strong></div>
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
  document.getElementById('notes-overlay').classList.add('open');
};
window.closeNotesDrawer = function() { document.getElementById('notes-overlay').classList.remove('open'); };

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
  return {admitted:'Admitted',discharged:'Discharged',lama:'LAMA',transferred:'Transferred',deceased:'Deceased'}[s] || s;
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
    selectPatient(_qPt);
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

window.closeCarePlanDrawer = function() {
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
