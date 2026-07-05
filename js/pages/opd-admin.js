import { requireAuth, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['dept_admin', 'super_admin']);
initNavbar();
wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const tenantId = getCurrentTenantId();
let _opds        = [];
let _allDoctors  = [];
let _selectedOpd = null;
let _departments = [];

const NCISM_OPDS = [
  { code:'SCREEN', name:'Screening OPD',           desc:'Triage & Screening — NCISM Mandatory' },
  { code:'KAY',    name:'Kayachikitsa OPD',         desc:'Internal Medicine — NCISM Mandatory' },
  { code:'PK',     name:'Panchakarma OPD',          desc:'Panchakarma & Upakarma — NCISM Mandatory' },
  { code:'SHAL',   name:'Shalya Tantra OPD',        desc:'Surgery — NCISM Mandatory' },
  { code:'SHAK',   name:'Shalakya Tantra OPD',      desc:'ENT & Ophthalmology — NCISM Mandatory' },
  { code:'PST',    name:'Prasuti & Stri Roga OPD',  desc:'Obstetrics & Gynaecology — NCISM Mandatory' },
  { code:'KAU',    name:'Kaumarabhritya OPD',       desc:'Paediatrics — NCISM Mandatory' },
  { code:'SW',     name:'Swasthavritta OPD',        desc:'Preventive & Social Medicine — NCISM Mandatory' },
  { code:'AGD',    name:'Agada Tantra OPD',         desc:'Toxicology & Forensic Medicine — NCISM Mandatory' },
  { code:'RNV',    name:'Rog Nidana OPD',           desc:'Pathology & Diagnosis — NCISM Mandatory' },
];

// Optional split codes — not mandatory OPDs, used when institution separates combined OPDs
const NCISM_OPTIONAL_OPDS = [
  { code:'PST2', name:'Prasuti Tantra OPD (Split)',  desc:'Obstetrics — separate from Stri Roga' },
  { code:'STR',  name:'Stri Roga OPD (Split)',       desc:'Gynaecology — separate from Prasuti' },
];

// 8 NCISM Specialty Disease Clinics — sub-OPDs under a parent department
const SPECIALTY_CLINICS = [
  { code:'SPEC-DM',   name:'Madhumeha — Diabetes Clinic',           proforma:'diabetes-clinic',           parent:'KAY'  },
  { code:'SPEC-SKIN', name:'Kushtha — Skin Clinic',                  proforma:'skin-clinic',               parent:'KAY'  },
  { code:'SPEC-SJ',   name:'Sandhivata — Spine & Joint Clinic',     proforma:'spine-joint-clinic',        parent:'KAY'  },
  { code:'SPEC-ARC',  name:'Arshas — Anorectal Clinic',              proforma:'anorectal-clinic',          parent:'SHAL' },
  { code:'SPEC-RESP', name:'Shwasa — Respiratory Clinic',            proforma:'respiratory-clinic',        parent:'KAY'  },
  { code:'SPEC-CA',   name:'Karkatarbhuda — Cancer & Oncology',     proforma:'cancer-clinic',             parent:'KAY'  },
  { code:'SPEC-MIF',  name:'Vandhyatva — Male Infertility Clinic',  proforma:'male-infertility-clinic',   parent:'KAY'  },
  { code:'SPEC-DENT', name:'Danta Chikitsa — Dental & Oral Health', proforma:'dental-clinic',             parent:'SHAK' },
];

// NCISM §7 — dedicated consultant pairs: same doctor cannot rotate between paired OPDs
const DEDICATED_CONSULTANT_PAIRS = [
  { codes:['SHALAKYA_NETRA','SHALAKYA_KNM'], label:'Netra and KNM' },
  { codes:['PRASUTI_TANTRA','STRI_ROGA'],    label:'Prasuti and Streeroga' },
];

// ── Load departments (for specialty clinic parent selector) ──
async function loadDepartments() {
  const { data } = await supabase
    .from('departments')
    .select('id, name, ncism_code')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');
  _departments = data || [];
  const sel = document.getElementById('new-opd-parent-dept');
  _departments.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
    sel.appendChild(opt);
  });
}

window._toggleSpecialtyFields = function() {
  const on = document.getElementById('new-opd-specialty').checked;
  document.getElementById('specialty-fields').style.display = on ? '' : 'none';
};

// ── Populate NCISM select in new-OPD form ──────────
function _populateNcismSelect() {
  const sel = document.getElementById('new-opd-ncism');
  const existingCodes = new Set(_opds.map(o => o.ncism_code).filter(Boolean));

  sel.innerHTML = '<option value="">— None / General OPD —</option>';

  // Group 1: 10 Mandatory NCISM OPDs (grey out already configured)
  const sep1 = document.createElement('option'); sep1.disabled = true;
  sep1.textContent = '── Mandatory NCISM OPDs ──────────────';
  sel.appendChild(sep1);
  NCISM_OPDS.forEach(n => {
    const o = document.createElement('option');
    o.value = n.code;
    const already = existingCodes.has(n.code);
    o.textContent = (already ? '✓ ' : '★ ') + n.name.replace(' OPD','');
    if (already) o.style.color = '#999';
    sel.appendChild(o);
  });

  // Group 2: 8 Specialty Disease Clinics
  const sep2 = document.createElement('option'); sep2.disabled = true;
  sep2.textContent = '── Specialty Disease Clinics ──────────';
  sel.appendChild(sep2);
  SPECIALTY_CLINICS.forEach(n => {
    const o = document.createElement('option');
    o.value = n.code;
    o.textContent = '🏥 ' + n.name;
    sel.appendChild(o);
  });

  // Group 3: Optional split OPDs
  const sep3 = document.createElement('option'); sep3.disabled = true;
  sep3.textContent = '── Optional (split institutions) ──────';
  sel.appendChild(sep3);
  NCISM_OPTIONAL_OPDS.forEach(n => {
    const o = document.createElement('option');
    o.value = n.code;
    o.textContent = '◦ ' + n.name.replace(' OPD','').replace(' (Split)','');
    sel.appendChild(o);
  });

  // When a specialty clinic is selected, auto-fill the form
  sel.onchange = function() {
    const sc = SPECIALTY_CLINICS.find(s => s.code === sel.value);
    if (sc) {
      document.getElementById('new-opd-name').value = sc.name;
      document.getElementById('new-opd-specialty').checked = true;
      window._toggleSpecialtyFields();
      document.getElementById('new-opd-proforma-key').value = sc.proforma;
      // Auto-select parent department
      const parentSel = document.getElementById('new-opd-parent-dept');
      const parentOpt = [...parentSel.options].find(o =>
        _departments.find(d => d.id === o.value && d.ncism_code === sc.parent)
      );
      if (parentOpt) parentSel.value = parentOpt.value;
    } else {
      document.getElementById('new-opd-specialty').checked = false;
      window._toggleSpecialtyFields();
    }
  };
}

// ── NCISM compliance check ─────────────────────────
function checkNcismCompliance() {
  const existingCodes = new Set(_opds.filter(o => o.is_active).map(o => o.ncism_code).filter(Boolean));
  const missing = NCISM_OPDS.filter(n => !existingCodes.has(n.code));
  const banner  = document.getElementById('ncism-banner');
  const text    = document.getElementById('ncism-banner-text');
  if (missing.length) {
    text.innerHTML = `<strong>NCISM Compliance:</strong> ${missing.length} mandatory OPD(s) not configured — `
      + missing.map(m => m.name.replace(' OPD','')).join(', ')
      + '. Click <strong>"Seed NCISM OPDs"</strong> to create them.';
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

// ── Load all OPDs ──────────────────────────────────
async function loadOpds() {
  const { data, error } = await supabase
    .from('opds')
    .select('id, name, description, is_active, ncism_code, is_specialty_clinic, parent_department_id')
    .eq('tenant_id', tenantId)
    .order('name');

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to load OPDs.')); return; }
  _opds = data || [];
  renderOpdList();
  checkNcismCompliance();
}

function renderOpdList() {
  const el = document.getElementById('opd-list');
  if (!_opds.length) {
    el.innerHTML = '<div class="opd-empty">No OPDs yet — create one using the button above.</div>';
    return;
  }
  el.innerHTML = _opds.map(o => `
    <div class="opd-item${_selectedOpd?.id === o.id ? ' selected' : ''}" data-id="${o.id}">
      <div style="flex:1;min-width:0">
        <div class="opd-item-name">${_esc(o.name)}</div>
        ${o.ncism_code ? `<span class="badge badge-ncism" style="margin-top:4px;display:inline-block">NCISM</span>` : ''}
        ${o.is_specialty_clinic ? `<span class="badge badge-specialty" style="margin-top:4px;margin-left:4px;display:inline-block">Specialty Clinic</span>` : ''}
        ${o.description ? `<div class="opd-item-desc" style="margin-top:3px">${_esc(o.description)}</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
        <span class="badge ${o.is_active ? 'badge-active' : 'badge-inactive'}">${o.is_active ? 'Active' : 'Inactive'}</span>
        <button class="btn btn-sm ${o.is_active ? 'btn-danger' : 'btn-secondary'} btn-toggle-opd"
          data-id="${o.id}" data-active="${o.is_active}" style="height:26px;padding:0 8px;font-size:11px">
          ${o.is_active ? 'Deactivate' : 'Activate'}
        </button>
      </div>
    </div>
  `).join('');

  // Click to select
  el.querySelectorAll('.opd-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.btn-toggle-opd')) return;
      const opd = _opds.find(o => o.id === item.dataset.id);
      if (opd) selectOpd(opd);
    });
  });

  // Toggle active/inactive
  el.querySelectorAll('.btn-toggle-opd').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleOpdActive(btn.dataset.id, btn.dataset.active === 'true');
    });
  });
}

// ── Toggle OPD active ──────────────────────────────
async function toggleOpdActive(opdId, currentlyActive) {
  const { error } = await supabase
    .from('opds')
    .update({ is_active: !currentlyActive })
    .eq('id', opdId)
    .eq('tenant_id', tenantId);

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to update OPD.')); return; }

  const o = _opds.find(o => o.id === opdId);
  if (o) o.is_active = !currentlyActive;
  renderOpdList();
  _alert('success', `OPD ${!currentlyActive ? 'activated' : 'deactivated'} successfully.`);
}

// ── New OPD form ───────────────────────────────────
const newOpdForm = document.getElementById('new-opd-form');
document.getElementById('btn-new-opd').addEventListener('click', () => {
  newOpdForm.classList.toggle('open');
  document.getElementById('btn-new-opd').textContent =
    newOpdForm.classList.contains('open') ? '✕ Cancel' : '+ New OPD';
  if (newOpdForm.classList.contains('open')) _populateNcismSelect();
});
document.getElementById('btn-cancel-opd').addEventListener('click', _resetOpdForm);

// Auto-fill name when NCISM code is picked
document.getElementById('new-opd-ncism').addEventListener('change', function() {
  if (!this.value) return;
  const entry = NCISM_OPDS.find(n => n.code === this.value);
  if (entry && !document.getElementById('new-opd-name').value.trim()) {
    document.getElementById('new-opd-name').value = entry.name;
    document.getElementById('new-opd-desc').value = entry.desc;
  }
});

document.getElementById('btn-save-opd').addEventListener('click', async () => {
  const name        = document.getElementById('new-opd-name').value.trim();
  const ncism       = document.getElementById('new-opd-ncism').value;
  const desc        = document.getElementById('new-opd-desc').value.trim();
  const isSpecialty  = document.getElementById('new-opd-specialty').checked;
  const parentDept   = document.getElementById('new-opd-parent-dept').value;
  const proformaKey  = document.getElementById('new-opd-proforma-key').value;

  if (!name) { _alert('error', 'OPD name is required.'); return; }
  if (isSpecialty && !parentDept) { _alert('error', 'Select a parent department for the specialty clinic.'); return; }

  const btn = document.getElementById('btn-save-opd');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await supabase.from('opds').insert({
    tenant_id:             tenantId,
    name,
    ncism_code:            ncism || null,
    description:           desc || null,
    is_active:             true,
    is_specialty_clinic:   isSpecialty,
    parent_department_id:  isSpecialty ? parentDept : null,
    specialty_proforma_key: isSpecialty && proformaKey ? proformaKey : null,
  });

  btn.disabled = false; btn.textContent = 'Save OPD';

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to create OPD.')); return; }

  _resetOpdForm();
  _alert('success', `OPD "${name}" created.`);
  await loadOpds();
});

function _resetOpdForm() {
  document.getElementById('new-opd-name').value         = '';
  document.getElementById('new-opd-ncism').value        = '';
  document.getElementById('new-opd-desc').value         = '';
  document.getElementById('new-opd-specialty').checked  = false;
  document.getElementById('new-opd-parent-dept').value  = '';
  document.getElementById('new-opd-proforma-key').value = '';
  document.getElementById('specialty-fields').style.display = 'none';
  newOpdForm.classList.remove('open');
  document.getElementById('btn-new-opd').textContent = '+ New OPD';
}

// ── Seed NCISM OPDs ────────────────────────────────
document.getElementById('btn-seed-ncism').addEventListener('click', async () => {
  const existingCodes = new Set(_opds.map(o => o.ncism_code).filter(Boolean));
  const toCreate = NCISM_OPDS.filter(n => !existingCodes.has(n.code));

  if (!toCreate.length) {
    _alert('success', 'All 10 NCISM mandatory OPDs are already configured.');
    return;
  }

  if (!confirm(`Create ${toCreate.length} missing NCISM OPD(s)?\n\n` + toCreate.map(n => '• ' + n.name).join('\n'))) return;

  const btn = document.getElementById('btn-seed-ncism');
  btn.disabled = true; btn.textContent = 'Creating…';

  const rows = toCreate.map(n => ({
    tenant_id:  tenantId,
    name:       n.name,
    ncism_code: n.code,
    description: n.desc,
    is_active:  true,
  }));

  const { error } = await supabase.from('opds').insert(rows);
  btn.disabled = false; btn.textContent = '◇ Seed NCISM OPDs';

  if (error) { _alert('error', safeErrorMessage(error, 'Seed failed. Please try again.')); return; }
  _alert('success', `${rows.length} NCISM OPD(s) created.`);
  await loadOpds();
});

// ── Load all active doctors for tenant ────────────
async function loadAllDoctors() {
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('tenant_id', tenantId)
    .eq('role', 'doctor')
    .eq('status', 'active')
    .order('full_name');
  _allDoctors = data || [];
}

// ── Select OPD → load its doctors ─────────────────
async function selectOpd(opd) {
  _selectedOpd = opd;
  renderOpdList();

  document.getElementById('doctors-panel-title').textContent = opd.name;
  document.getElementById('btn-mark-all').style.display = '';
  document.getElementById('btn-clear-all').style.display = '';
  document.getElementById('doctors-content').innerHTML =
    '<div class="doctors-empty"><div class="doctors-empty-sub">Loading…</div></div>';

  const { data: opdDocs, error } = await supabase
    .from('opd_doctors')
    .select('id, doctor_id, is_active_today')
    .eq('opd_id', opd.id)
    .eq('tenant_id', tenantId);

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to load doctors.')); return; }
  renderDoctors(opdDocs || []);
}

function renderDoctors(opdDocs) {
  const assignedIds = opdDocs.map(d => d.doctor_id);

  // Doctors not yet in this OPD (available to add)
  const unassigned = _allDoctors.filter(d => !assignedIds.includes(d.id));

  const content = document.getElementById('doctors-content');

  if (!opdDocs.length) {
    content.innerHTML = `
      <div class="doctors-empty">
        <div class="doctors-empty-icon">👨‍⚕️</div>
        <div class="doctors-empty-title">No doctors assigned</div>
        <div class="doctors-empty-sub">Use the dropdown below to add doctors to this OPD</div>
      </div>
      ${_addDoctorRow(unassigned)}
    `;
  } else {
    const rows = opdDocs.map(od => {
      const doc = _allDoctors.find(d => d.id === od.doctor_id);
      const name = doc?.full_name || 'Unknown Doctor';
      return `
        <div class="doctor-row" data-opd-doc-id="${od.id}">
          <div class="doctor-info">
            <div class="doctor-name">${_esc(name)}</div>
            <div class="doctor-sub">${od.is_active_today ? 'Active today' : 'Not active today'}</div>
          </div>
          <div class="toggle-wrap">
            <span class="toggle-label">Today</span>
            <label class="toggle">
              <input type="checkbox" class="chk-today" data-id="${od.id}"
                ${od.is_active_today ? 'checked' : ''}/>
              <div class="toggle-track"></div>
            </label>
            <button class="btn btn-danger btn-sm btn-remove-doc" data-id="${od.id}" title="Remove from OPD"
              style="height:30px;padding:0 10px;font-size:12px">Remove</button>
          </div>
        </div>
      `;
    }).join('');

    content.innerHTML = `
      <div class="today-bar">
        <div class="today-bar-label">
          <strong>${opdDocs.filter(d => d.is_active_today).length}</strong> of ${opdDocs.length} doctors active today
        </div>
      </div>
      <div class="doctor-list">${rows}</div>
      ${_addDoctorRow(unassigned)}
    `;
  }

  // Toggle is_active_today
  content.querySelectorAll('.chk-today').forEach(chk => {
    chk.addEventListener('change', () => toggleActiveToday(chk.dataset.id, chk.checked));
  });

  // Remove doctor from OPD
  content.querySelectorAll('.btn-remove-doc').forEach(btn => {
    btn.addEventListener('click', () => removeDoctor(btn.dataset.id));
  });

  // Add doctor
  const addBtn = content.querySelector('#btn-add-doctor');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const sel = content.querySelector('#select-add-doctor');
      if (sel?.value) addDoctor(sel.value);
    });
  }
}

function _addDoctorRow(unassigned) {
  if (!unassigned.length) return `<div style="padding:12px 18px;font-size:12px;color:var(--text-muted);border-top:1.5px solid var(--border);background:var(--cream)">All active doctors are assigned to this OPD.</div>`;
  return `
    <div class="add-doctor-row">
      <select id="select-add-doctor">
        <option value="">— Add a doctor —</option>
        ${unassigned.map(d => `<option value="${d.id}">${_esc(d.full_name)}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" id="btn-add-doctor">Add</button>
    </div>
  `;
}

// ── Toggle active today ────────────────────────────
async function toggleActiveToday(opdDocId, active) {
  const { error } = await supabase
    .from('opd_doctors')
    .update({ is_active_today: active })
    .eq('id', opdDocId);

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to update.')); return; }

  // Refresh count display
  if (_selectedOpd) await selectOpd(_selectedOpd);
}

// ── Mark all active today ──────────────────────────
document.getElementById('btn-mark-all').addEventListener('click', async () => {
  if (!_selectedOpd) return;
  const { error } = await supabase
    .from('opd_doctors')
    .update({ is_active_today: true })
    .eq('opd_id', _selectedOpd.id)
    .eq('tenant_id', tenantId);

  if (error) { _alert('error', safeErrorMessage(error, 'Action failed. Please try again.')); return; }
  _alert('success', 'All doctors marked active today.');
  await selectOpd(_selectedOpd);
});

// ── Clear all today ────────────────────────────────
document.getElementById('btn-clear-all').addEventListener('click', async () => {
  if (!_selectedOpd) return;
  const { error } = await supabase
    .from('opd_doctors')
    .update({ is_active_today: false })
    .eq('opd_id', _selectedOpd.id)
    .eq('tenant_id', tenantId);

  if (error) { _alert('error', safeErrorMessage(error, 'Action failed. Please try again.')); return; }
  _alert('success', 'All doctors cleared for today.');
  await selectOpd(_selectedOpd);
});

// ── Add doctor to OPD ─────────────────────────────
async function addDoctor(doctorId) {
  // NCISM §7 — dedicated consultant enforcement: block rotation between paired OPDs
  const currentCode = _selectedOpd?.ncism_code;
  if (currentCode) {
    for (const pair of DEDICATED_CONSULTANT_PAIRS) {
      if (!pair.codes.includes(currentCode)) continue;
      const partnerCodes = pair.codes.filter(c => c !== currentCode);
      const { data: partnerOpds } = await supabase
        .from('opds')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .in('ncism_code', partnerCodes);
      if (!partnerOpds?.length) continue;
      const { data: conflict } = await supabase
        .from('opd_doctors')
        .select('opd_id')
        .eq('doctor_id', doctorId)
        .eq('tenant_id', tenantId)
        .in('opd_id', partnerOpds.map(o => o.id));
      if (conflict?.length) {
        const conflictOpd = partnerOpds.find(o => o.id === conflict[0].opd_id);
        _alert('error', `NCISM §7 mandates dedicated consultants for ${pair.label} OPDs. This doctor is already assigned to "${conflictOpd?.name || 'the paired OPD'}". Please assign a different consultant.`);
        return;
      }
    }
  }

  const { error } = await supabase
    .from('opd_doctors')
    .insert({ opd_id: _selectedOpd.id, doctor_id: doctorId, tenant_id: tenantId, is_active_today: true });

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to add doctor.')); return; }
  _alert('success', 'Doctor added and marked active today.');
  await selectOpd(_selectedOpd);
}

// ── Remove doctor from OPD ────────────────────────
async function removeDoctor(opdDocId) {
  if (!confirm('Remove this doctor from the OPD?')) return;
  const { error } = await supabase
    .from('opd_doctors')
    .delete()
    .eq('id', opdDocId);

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to remove.')); return; }
  _alert('success', 'Doctor removed from OPD.');
  await selectOpd(_selectedOpd);
}

// ── Alert helper ──────────────────────────────────
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.textContent = msg;
  el.className = `alert show ${type}`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => el.className = 'alert', 4000);
}

// ── Boot ──────────────────────────────────────────
_populateNcismSelect();
await Promise.all([loadOpds(), loadAllDoctors(), loadDepartments()]);
