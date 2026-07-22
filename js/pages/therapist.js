import { requireAuth, getCurrentTenantId, getCurrentRole, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { renderPromoBanner } from '../components/promoBanner.js';

/*
  SQL to run once in Supabase:

  -- 1. Add therapist to profiles role check
  ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
  ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('super_admin','dept_admin','doctor','receptionist','pharmacist',
                    'nurse','lab_tech','accountant','therapist','student','public'));

  -- 2. Enable RLS on pk_therapy_sessions
  ALTER TABLE pk_therapy_sessions ENABLE ROW LEVEL SECURITY;

  -- 3. §47 PK Therapy Section columns (NCISM §47(xiii) room tracking + Samsarjana Krama)
  ALTER TABLE pk_therapy_sessions ADD COLUMN IF NOT EXISTS therapy_room_number text;
  ALTER TABLE pk_therapy_sessions ADD COLUMN IF NOT EXISTS samsarjana_stage text;
  DROP POLICY IF EXISTS "tenant_pk_sessions" ON pk_therapy_sessions;
  CREATE POLICY "tenant_pk_sessions" ON pk_therapy_sessions FOR ALL TO authenticated
    USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
*/

await requireAuth(['super_admin','dept_admin','doctor','therapist','nurse']);
initNavbar();
wireDelegatedEvents();

window._removeClosest = function(el, sel) { el.closest(sel)?.remove(); };

const tenantId   = getCurrentTenantId();
const role       = getCurrentRole();
const myProfile  = getCurrentProfile();

let _sessions    = [];
let _admissions  = [];
let _therapists  = [];
let _depts       = [];
let _opdPatients = [];
let _viewDate    = new Date().toISOString().slice(0,10);

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadAll() {
  _updateDateDisplay();

  const [sessRes, admRes, thRes, deptRes] = await Promise.all([
    supabase
      .from('pk_therapy_sessions')
      .select(`
        id, therapy_phase, therapy_name, scheduled_date, scheduled_time,
        actual_start, actual_end, status, therapist_notes, doctor_clearance,
        therapy_room_number, samsarjana_stage,
        patients(id, name, phone, age, gender),
        profiles!therapist_id(id, full_name, gender),
        departments(id, name)
      `)
      .eq('tenant_id', tenantId)
      .eq('scheduled_date', _viewDate)
      .order('scheduled_time', { ascending: true, nullsFirst: false }),
    supabase
      .from('ipd_admissions')
      .select('id, patients(id,name,phone,age,gender), beds(bed_number), departments(name)')
      .eq('tenant_id', tenantId)
      .eq('status', 'admitted'),
    supabase
      .from('profiles')
      .select('id,full_name,gender')
      .eq('tenant_id', tenantId)
      .eq('role','therapist')
      .eq('is_active', true)
      .order('full_name'),
    supabase
      .from('departments')
      .select('id,name')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('name'),
  ]);

  if (sessRes.error) {
    _alert('error', safeErrorMessage(sessRes.error, 'Failed to load sessions.')
      + (sessRes.error.code === '42501' ? ' — Run the RLS SQL shown in source comments.' : ''));
    return;
  }

  _sessions   = sessRes.data || [];
  _admissions = admRes.data  || [];
  _therapists = thRes.data   || [];
  _depts      = deptRes.data || [];

  // If logged in as therapist, only show own sessions
  if (role === 'therapist') {
    _sessions = _sessions.filter(s => s.profiles?.id === myProfile?.id);
  }

  _populateFilterSelects();
  _populateSchedSelects();
  renderStats();
  applyFilters();
}

// ── Date nav ──────────────────────────────────────────────────────────────────
window.shiftDate = function(n) {
  const d = new Date(_viewDate);
  d.setDate(d.getDate() + Number(n));
  _viewDate = d.toISOString().slice(0,10);
  document.getElementById('date-picker').value = _viewDate;
  loadAll();
};
window.goToday = function() {
  _viewDate = new Date().toISOString().slice(0,10);
  document.getElementById('date-picker').value = _viewDate;
  loadAll();
};
window.onDatePick = function() {
  _viewDate = document.getElementById('date-picker').value;
  loadAll();
};
function _updateDateDisplay() {
  const d = new Date(_viewDate + 'T00:00:00');
  const today = new Date().toISOString().slice(0,10);
  const label = _viewDate === today ? 'Today · ' : '';
  document.getElementById('date-display').textContent =
    label + d.toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'long', year:'numeric' });
  document.getElementById('date-picker').value = _viewDate;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  const all = _sessions;
  document.getElementById('stat-total').textContent      = all.length;
  document.getElementById('stat-scheduled').textContent  = all.filter(s=>s.status==='scheduled').length;
  document.getElementById('stat-inprogress').textContent = all.filter(s=>s.status==='in_progress').length;
  document.getElementById('stat-completed').textContent  = all.filter(s=>s.status==='completed').length;

  // NCISM §47(vii) compliance banner
  const banner  = document.getElementById('ncism47-banner');
  const detail  = document.getElementById('ncism47-detail');
  const active  = all.filter(s => s.status !== 'skipped');
  if (!active.length) { banner.style.display = 'none'; return; }
  const cleared = active.filter(s => s.doctor_clearance).length;
  const pct     = Math.round(cleared / active.length * 100);
  banner.style.display = '';
  banner.className = `ncism47-banner ${pct === 100 ? 'ok' : pct < 50 ? 'danger' : ''}`;
  detail.innerHTML = `
    <span class="ncism47-pill ${pct===100?'green':pct<50?'red':'amber'}">${cleared}/${active.length} cleared</span>
    <span class="ncism47-meta">${pct===100 ? 'All sessions fitness-cleared ✓' : `${active.length - cleared} session(s) without PK fitness clearance`}</span>
  `;
}

// ── Populate filters + sched selects ─────────────────────────────────────────
function _populateFilterSelects() {
  const ft = document.getElementById('filter-therapist');
  const ft_val = ft.value;
  ft.innerHTML = '<option value="">All Therapists</option>';
  _therapists.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.full_name;
    ft.appendChild(o);
  });
  if (ft_val) ft.value = ft_val;

  const fd = document.getElementById('filter-dept');
  const fd_val = fd.value;
  fd.innerHTML = '<option value="">All Departments</option>';
  _depts.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    fd.appendChild(o);
  });
  if (fd_val) fd.value = fd_val;
}

function _populateSchedSelects() {
  // Admissions
  const sa = document.getElementById('sched-admission');
  sa.innerHTML = '<option value="">— Select admitted patient —</option>';
  _admissions.forEach(a => {
    const pt  = a.patients || {};
    const bed = a.beds || {};
    const o = document.createElement('option');
    o.value = JSON.stringify({ admId: a.id, patientId: pt.id, patientName: pt.name });
    o.textContent = `${pt.name} — Bed ${bed.bed_number || '?'}`;
    sa.appendChild(o);
  });

  // Depts
  const sd = document.getElementById('sched-dept');
  sd.innerHTML = '<option value="">— Select department —</option>';
  _depts.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    sd.appendChild(o);
  });

  // Therapists
  _populateTherapistSelect();
}

function _populateTherapistSelect() {
  const st = document.getElementById('sched-therapist');
  const note = document.getElementById('therapist-note');
  st.innerHTML = '<option value="">— Select therapist —</option>';

  const males   = _therapists.filter(t => t.gender === 'M');
  const females = _therapists.filter(t => t.gender === 'F');
  const unknown = _therapists.filter(t => !t.gender);

  [
    { group: 'Male Therapists', list: males },
    { group: 'Female Therapists', list: females },
    { group: 'Therapists', list: unknown },
  ].forEach(({ group, list }) => {
    if (!list.length) return;
    const og = document.createElement('optgroup');
    og.label = group;
    list.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.full_name;
      og.appendChild(o);
    });
    st.appendChild(og);
  });

  if (!_therapists.length) {
    note.textContent = 'No therapists registered yet. Add staff with role "therapist" via the signup flow.';
    note.style.color = 'var(--gold)';
  } else {
    const m = males.length, f = females.length;
    note.textContent = `${_therapists.length} therapist(s) available — ${m}M / ${f}F (NCISM needs 2M+2F per dept)`;
    note.style.color = (m >= 2 && f >= 2) ? 'var(--green-mid)' : 'var(--gold)';
  }
}

// ── Render table ──────────────────────────────────────────────────────────────
window.applyFilters = function() {
  const ft = document.getElementById('filter-therapist').value;
  const fd = document.getElementById('filter-dept').value;
  const fs = document.getElementById('filter-status').value;

  let rows = _sessions;
  if (ft) rows = rows.filter(s => s.profiles?.id === ft);
  if (fd) rows = rows.filter(s => s.departments?.id === fd);
  if (fs) rows = rows.filter(s => s.status === fs);

  renderTable(rows);
};

function renderTable(rows) {
  const tbody = document.getElementById('sessions-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">No sessions for this date.<br>Use "+ Schedule Session" to add one.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(s => {
    const pt        = s.patients || {};
    const therapist = s.profiles || {};
    const dept      = s.departments || {};
    const timeStr   = s.scheduled_time ? s.scheduled_time.slice(0,5) : '—';
    const canStart  = s.status === 'scheduled';
    const canComplete = s.status === 'scheduled' || s.status === 'in_progress';
    const canSkip   = s.status === 'scheduled';

    const ptMeta = [pt.gender, pt.age ? pt.age+'y' : ''].filter(Boolean).join(' · ');
    const roomLabel = s.therapy_room_number ? `<div class="pt-meta">Room ${s.therapy_room_number}</div>` : '';

    // Fitness badge (NCISM §47(vii))
    const isPurva = s.therapy_phase === 'purvakarma';
    let fitnessBadge;
    if (s.status === 'skipped') {
      fitnessBadge = '—';
    } else if (s.doctor_clearance) {
      fitnessBadge = `<span class="fitness-ok">✓ Cleared</span>`;
    } else if (isPurva && s.status !== 'completed') {
      fitnessBadge = `<span class="fitness-block">✗ Not cleared</span>`;
    } else {
      fitnessBadge = `<span class="fitness-warn">⚠ Pending</span>`;
    }

    // Samsarjana indicator for Paschatkarma
    const samLabel = s.samsarjana_stage
      ? `<div class="pt-meta" style="color:#7a5a00">🍚 ${_samLabel(s.samsarjana_stage)}</div>`
      : '';

    return `<tr>
      <td>
        <div class="time-cell">${timeStr}</div>
        ${s.actual_start ? `<div class="time-end">Started ${s.actual_start.slice(11,16)}</div>` : ''}
      </td>
      <td>
        <div class="pt-name">${_esc(pt.name||'—')}</div>
        ${ptMeta ? `<div class="pt-meta">${ptMeta}</div>` : ''}
      </td>
      <td>
        <div class="therapy-name">${_esc(s.therapy_name||'—')}</div>
        <span class="phase-badge phase-${s.therapy_phase}">${_phaseLabel(s.therapy_phase)}</span>
        ${roomLabel}
        ${samLabel}
      </td>
      <td>
        <div>${_esc(therapist.full_name||'—')}</div>
        ${therapist.gender ? `<div class="pt-meta">${therapist.gender === 'M' ? 'Male' : 'Female'}</div>` : ''}
      </td>
      <td>${_esc(dept.name||'—')}</td>
      <td>${fitnessBadge}</td>
      <td>
        <span class="status-badge status-${s.status}">
          ${_statusLabel(s.status)}
        </span>
      </td>
      <td>
        <div class="row-actions">
          ${canStart ? `<button class="icon-btn start" data-onclick="quickStart" data-onclick-a0="${s.id}" title="Mark In Progress">&#9654;</button>` : ''}
          ${canComplete ? `<button class="icon-btn complete" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@false" title="Complete">&#10003;</button>` : ''}
          ${canSkip ? `<button class="icon-btn skip" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@true" title="Skip">&#10007;</button>` : ''}
          <button class="icon-btn" data-onclick="openCompleteDrawer" data-onclick-a0="${s.id}" data-onclick-a1="@false" data-onclick-a2="@true" title="Notes">&#128203;</button>
          <button class="icon-btn" data-onclick="openRxDrawer" data-onclick-a0="${s.id}" title="Prescribe Therapy Materials" style="color:#1a4a2e">💊</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Schedule drawer ───────────────────────────────────────────────────────────
window.openSchedDrawer = function(prefillAdmId) {
  document.getElementById('sched-source').value    = 'ipd';
  document.getElementById('sched-phase').value     = 'purvakarma';
  document.getElementById('sched-therapy').value   = '';
  document.getElementById('sched-therapist').value = '';
  document.getElementById('sched-clearance').checked = false;
  document.getElementById('sched-room').value      = '';
  document.getElementById('sched-date').value      = _viewDate;
  document.getElementById('sched-time').value      = '';
  document.getElementById('sched-dept').value      = '';
  document.getElementById('sched-admission').value = '';
  onSourceChange();
  if (prefillAdmId) {
    const opts = document.getElementById('sched-admission').options;
    for (const o of opts) {
      try { if (JSON.parse(o.value).admId === prefillAdmId) { o.selected = true; break; } }
      catch {}
    }
  }
  document.getElementById('sched-overlay').classList.add('open');
};
window.closeSchedDrawer = function() {
  document.getElementById('sched-overlay').classList.remove('open');
};

window.onSourceChange = function() {
  const src = document.getElementById('sched-source').value;
  document.getElementById('ipd-patient-field').style.display = src === 'ipd' ? '' : 'none';
  document.getElementById('opd-patient-field').style.display = src === 'opd' ? '' : 'none';
};

window.saveSession = async function() {
  const source    = document.getElementById('sched-source').value;
  const phase     = document.getElementById('sched-phase').value;
  const therapy   = document.getElementById('sched-therapy').value.trim();
  const therapist = document.getElementById('sched-therapist').value;
  const deptId    = document.getElementById('sched-dept').value;
  const date      = document.getElementById('sched-date').value;
  const time      = document.getElementById('sched-time').value;
  const clearance = document.getElementById('sched-clearance').checked;

  if (!therapy)   { _alert('error','Enter therapy name.'); return; }
  if (!therapist) { _alert('error','Select a therapist.'); return; }
  if (!deptId)    { _alert('error','Select a department.'); return; }
  if (!date)      { _alert('error','Enter a date.'); return; }

  // NABH PRE.2 ATWC CORE — Female therapist for female patients
  let patientGender = null;
  if (source === 'ipd') {
    const raw = document.getElementById('sched-admission').value;
    if (raw) {
      try { const obj = JSON.parse(raw); const adm = _admissions.find(a=>a.id===obj.admId); patientGender = adm?.patients?.gender; } catch {}
    }
  } else {
    const patientId = document.getElementById('sched-opd-patient').value;
    if (patientId) {
      const { data: pt } = await supabase.from('patients').select('gender').eq('id',patientId).single();
      patientGender = pt?.gender;
    }
  }
  const therapistData = _therapists.find(t => t.id === therapist);
  if (patientGender === 'F' && therapistData?.gender === 'M') {
    const override = confirm('⚠ NABH PRE.2 ATWC CORE — Gender Mismatch\n\nFemale patients must be treated by female therapists.\n\nThis patient is female and the selected therapist is male.\n\nContinue only with documented medical justification?');
    if (!override) return;
  }

  // NABH PRE.3 ATWC CORE — PK Consent 6-month validity check
  if (source === 'ipd' || source === 'opd') {
    const ptId = source === 'ipd'
      ? (() => { try { return JSON.parse(document.getElementById('sched-admission').value).patientId; } catch { return null; } })()
      : document.getElementById('sched-opd-patient').value;
    if (ptId) {
      const sixMonthsAgo = new Date(Date.now() - 180*86400000).toISOString();
      const { data: consentData } = await supabase.from('consent_records')
        .select('id,consent_datetime,valid_until')
        .eq('patient_id', ptId).eq('tenant_id', tenantId)
        .eq('consent_type','panchakarma')
        .order('consent_datetime',{ascending:false}).limit(1).maybeSingle();
      if (!consentData) {
        const ok = confirm('⚠ NABH PRE.3 ATWC CORE — No PK Consent on Record\n\nNo Panchakarma consent found for this patient. Consent is mandatory before first session.\n\nProceed anyway? (You must record consent separately.)');
        if (!ok) return;
      } else {
        const expiry = consentData.valid_until ? new Date(consentData.valid_until) : new Date(new Date(consentData.consent_datetime).getTime() + 180*86400000);
        if (expiry < new Date()) {
          const renew = confirm(`⚠ NABH — PK Consent Expired\n\nConsent given on ${new Date(consentData.consent_datetime).toLocaleDateString('en-IN')} has expired.\n\nFresh consent is required. Proceed anyway?`);
          if (!renew) return;
        }
      }
    }
  }

  // NCISM §47(a)(xv) — Raktamokshana must be in Anushastra Karma unit, not regular therapy room
  const therapyLower = therapy.toLowerCase();
  if (therapyLower.includes('raktamokshana') || therapyLower.includes('leech')) {
    const proceed = confirm(
      '⚠ NCISM §47(a)(xv) — Aseptic Conditions Required\n\n' +
      'Raktamokshana (leech therapy) must be conducted in the Anushastra Karma unit under aseptic conditions.\n\n' +
      'Confirm this session is scheduled in the designated Anushastra Karma / aseptic procedure room?'
    );
    if (!proceed) return;
  }

  let patientId  = null;
  let admId      = null;

  if (source === 'ipd') {
    const raw = document.getElementById('sched-admission').value;
    if (!raw) { _alert('error','Select an IPD patient.'); return; }
    try {
      const obj = JSON.parse(raw);
      patientId = obj.patientId;
      admId     = obj.admId;
    } catch { _alert('error','Invalid patient selection.'); return; }
  } else {
    patientId = document.getElementById('sched-opd-patient').value;
    if (!patientId) { _alert('error','Select a patient.'); return; }
  }

  const btn = document.getElementById('btn-sched-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  const room = document.getElementById('sched-room').value;

  const { error } = await supabase.from('pk_therapy_sessions').insert({
    tenant_id:           tenantId,
    patient_id:          patientId,
    ipd_admission_id:    admId || null,
    therapist_id:        therapist,
    department_id:       deptId,
    therapy_phase:       phase,
    therapy_name:        therapy,
    scheduled_date:      date,
    scheduled_time:      time || null,
    doctor_clearance:    clearance,
    therapy_room_number: room || null,
    status:              'scheduled',
  });

  btn.disabled = false; btn.textContent = 'Schedule';
  if (error) { _alert('error',safeErrorMessage(error, 'Save failed.')); return; }
  closeSchedDrawer();
  _alert('success','Session scheduled.');
  await loadAll();
};

// ── Quick start ───────────────────────────────────────────────────────────────
window.quickStart = async function(id) {
  const session = _sessions.find(s => s.id === id);

  // NCISM §47(vii) — fitness clearance is mandatory for Purvakarma
  if (session && session.therapy_phase === 'purvakarma' && !session.doctor_clearance) {
    const proceed = confirm(
      '⚠ NCISM §47(vii) Compliance Alert\n\n' +
      'PK Fitness Clearance has NOT been marked for this patient.\n\n' +
      'NCISM mandates that every patient must undergo consultation to confirm fitness BEFORE starting Panchakarma therapy.\n\n' +
      'Proceed without clearance? (Non-compliant — will be flagged in records)'
    );
    if (!proceed) return;
  }

  const now = new Date();
  const { error } = await supabase.from('pk_therapy_sessions')
    .update({ status: 'in_progress', actual_start: now.toISOString() })
    .eq('id', id);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not update session.')); return; }
  _alert('success', 'Session marked in progress.');
  await loadAll();
};

// ── Complete drawer ───────────────────────────────────────────────────────────
window.openCompleteDrawer = function(id, isSkip, viewOnly) {
  const s  = _sessions.find(x => x.id === id);
  if (!s) return;
  const pt        = s.patients || {};
  const therapist = s.profiles || {};

  document.getElementById('comp-session-id').value   = id;
  document.getElementById('comp-start').value         = s.actual_start ? s.actual_start.slice(11,16) : '';
  document.getElementById('comp-end').value           = s.actual_end ? s.actual_end.slice(11,16) : '';
  document.getElementById('comp-notes').value         = s.therapist_notes || '';
  document.getElementById('comp-clearance').checked   = s.doctor_clearance || false;
  document.getElementById('comp-skip-reason').value   = '';

  // Samsarjana Krama — only for Paschatkarma
  const isPaschatkarma = s.therapy_phase === 'paschatkarma';
  const samSec = document.getElementById('samsarjana-section');
  samSec.style.display = (isPaschatkarma && !isSkip) ? '' : 'none';
  if (isPaschatkarma) {
    document.getElementById('comp-samsarjana-stage').value = s.samsarjana_stage || '';
    document.getElementById('comp-samsarjana-tolerating').checked = false;
  }
  document.getElementById('skip-reason-field').style.display = isSkip ? '' : 'none';

  const titleEl = document.getElementById('complete-title');
  const saveBtn = document.getElementById('btn-complete-save');

  if (viewOnly || s.status === 'completed' || s.status === 'skipped') {
    titleEl.textContent = 'Session Notes';
    saveBtn.style.display = 'none';
    document.getElementById('comp-start').disabled = true;
    document.getElementById('comp-end').disabled   = true;
    document.getElementById('comp-notes').disabled = true;
  } else {
    titleEl.textContent = isSkip ? 'Skip Session' : 'Complete Session';
    saveBtn.textContent  = isSkip ? 'Mark Skipped' : 'Mark Completed';
    saveBtn.style.display = '';
    document.getElementById('comp-start').disabled = false;
    document.getElementById('comp-end').disabled   = false;
    document.getElementById('comp-notes').disabled = false;
  }
  saveBtn.dataset.skip = isSkip ? '1' : '0';

  document.getElementById('comp-detail-card').innerHTML = `
    <div class="detail-row"><span>Patient</span><strong>${_esc(pt.name||'—')}</strong></div>
    <div class="detail-row"><span>Therapy</span><strong>${_esc(s.therapy_name)}</strong></div>
    <div class="detail-row"><span>Phase</span><strong>${_phaseLabel(s.therapy_phase)}</strong></div>
    <div class="detail-row"><span>Therapist</span><strong>${_esc(therapist.full_name||'—')}</strong></div>
    <div class="detail-row"><span>Scheduled</span><strong>${s.scheduled_time ? s.scheduled_time.slice(0,5) : '—'}</strong></div>
  `;

  document.getElementById('complete-overlay').classList.add('open');
};
window.closeCompleteDrawer = function() {
  document.getElementById('complete-overlay').classList.remove('open');
};

window.saveCompletion = async function() {
  const id      = document.getElementById('comp-session-id').value;
  const isSkip  = document.getElementById('btn-complete-save').dataset.skip === '1';
  const start   = document.getElementById('comp-start').value;
  const end     = document.getElementById('comp-end').value;
  const notes   = document.getElementById('comp-notes').value.trim();
  const clear   = document.getElementById('comp-clearance').checked;
  const today   = _viewDate;

  const session = _sessions.find(s => s.id === id);
  const isPaschatkarma = session?.therapy_phase === 'paschatkarma';

  const patch = {
    status:           isSkip ? 'skipped' : 'completed',
    therapist_notes:  notes || null,
    doctor_clearance: clear,
  };
  if (!isSkip) {
    if (start) patch.actual_start = `${today}T${start}:00`;
    if (end)   patch.actual_end   = `${today}T${end}:00`;

    // Save Samsarjana Krama stage for Paschatkarma
    if (isPaschatkarma) {
      const stage = document.getElementById('comp-samsarjana-stage').value;
      if (stage) patch.samsarjana_stage = stage;
    }
  }

  const btn = document.getElementById('btn-complete-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await supabase.from('pk_therapy_sessions').update(patch).eq('id', id);
  btn.disabled = false;
  btn.textContent = isSkip ? 'Mark Skipped' : 'Mark Completed';

  if (error) { _alert('error', safeErrorMessage(error, 'Could not update session.')); return; }
  closeCompleteDrawer();

  // NCISM §47(vii) — Post-PK review alert when last Paschatkarma session completes
  if (!isSkip && isPaschatkarma) {
    const patientId  = session?.patients?.id;
    const remaining  = _sessions.filter(s =>
      s.id !== id &&
      s.patients?.id === patientId &&
      s.therapy_phase === 'paschatkarma' &&
      s.status !== 'completed' && s.status !== 'skipped'
    );
    if (remaining.length === 0) {
      // §18m — notify referring doctor via doctor_alerts + close referral
      const { data: ref } = await supabase
        .from('referrals')
        .select('id, referring_doctor_id')
        .eq('patient_id', patientId)
        .eq('tenant_id', tenantId)
        .in('status', ['pending','accepted'])
        .eq('referral_type', 'internal')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ref?.referring_doctor_id) {
        await supabase.from('doctor_alerts').insert({
          tenant_id:    tenantId,
          doctor_id:    ref.referring_doctor_id,
          patient_name: session?.patients?.name || 'Patient',
          message:      `✅ PK Therapy Complete — ${session?.patients?.name || 'Patient'} has completed all Panchakarma sessions (Purvakarma → Pradhanakarma → Paschatkarma). Please schedule a post-therapy follow-up consultation.`,
          is_read:      false,
        });
        await supabase.from('referrals').update({ status: 'seen' }).eq('id', ref.id);
      }
      _alert('success',
        '✓ Paschatkarma complete. ' +
        '⚕ NCISM §47(vii): Post-therapy fitness review required — ' +
        'schedule a follow-up PK OPD consultation for ' + (session?.patients?.name || 'this patient') + '.' +
        (ref?.referring_doctor_id ? ' Referring doctor has been notified.' : '')
      );
      await loadAll();
      return;
    }
  }

  _alert('success', isSkip ? 'Session skipped.' : 'Session completed.');
  await loadAll();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _phaseLabel(p) {
  return { purvakarma:'Purvakarma', pradhanakarma:'Pradhanakarma', paschatkarma:'Paschatkarma' }[p] || p;
}
function _statusLabel(s) {
  return { scheduled:'Scheduled', in_progress:'In Progress', completed:'Completed', skipped:'Skipped' }[s] || s;
}
function _samLabel(s) {
  return {
    peya:'Peya', vilepi:'Vilepi', akrita_yusa:'Akrita Yusa',
    krita_yusa:'Krita Yusa', yusha_mamsa:'Yusha/Mamsa', normal_diet:'Normal diet'
  }[s] || s;
}
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.className = `alert show ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 3500);
  window.scrollTo({ top:0, behavior:'smooth' });
}

// ── Therapy Prescription ─────────────────────────────────────────────────────
let _rxSession = null;

window.openRxDrawer = function(sessionId) {
  const s = _sessions.find(x => x.id === sessionId);
  if (!s) return;
  _rxSession = s;
  const pt   = s.patients || {};
  const dept = s.departments || {};
  const adm  = _admissions.find(a => a.patients?.id === pt.id);
  const bed  = adm?.beds?.bed_number ? ` · Bed ${adm.beds.bed_number}` : '';
  document.getElementById('rx-session-info').innerHTML =
    `<strong>${pt.name || '—'}</strong>${bed}<br>
     Therapy: <strong>${s.therapy_name || '—'}</strong> · ${_phaseLabel(s.therapy_phase)} · ${dept.name || '—'}`;
  const list = document.getElementById('rx-items-list');
  list.innerHTML = '';
  _addRxItem(); _addRxItem();
  document.getElementById('rx-overlay').classList.add('open');
};

window.closeRxDrawer = function() {
  document.getElementById('rx-overlay').classList.remove('open');
  _rxSession = null;
};

window._addRxItem = function() {
  const row = document.createElement('div');
  row.className = 'rx-item-row';
  row.innerHTML = `
    <input type="text" placeholder="e.g. Tila Taila, Dashmoola Kwatha…"/>
    <input type="text" placeholder="e.g. 250 ml"/>
    <button class="rx-btn-rm" data-onclick="_removeClosest" data-onclick-a0="@this" data-onclick-a1=".rx-item-row">✕</button>`;
  document.getElementById('rx-items-list').appendChild(row);
};

window.saveTherapyRx = async function() {
  if (!_rxSession) return;
  const rows  = document.querySelectorAll('#rx-items-list .rx-item-row');
  const items = [];
  rows.forEach(r => {
    const inputs = r.querySelectorAll('input');
    const name   = inputs[0]?.value.trim();
    const dose   = inputs[1]?.value.trim();
    if (name) items.push({ name, dose });
  });
  if (!items.length) { _alert('error', 'Add at least one item.'); return; }

  const { data: presc, error: pErr } = await supabase.from('prescriptions').insert({
    tenant_id:  tenantId,
    patient_id: _rxSession.patients.id,
    visit_id:   null,
    status:     'pending',
  }).select('id').single();
  if (pErr) { _alert('error', 'Error: ' + pErr.message); return; }

  await supabase.from('prescription_items').insert(
    items.map(i => ({
      prescription_id: presc.id,
      medicine_id:     null,
      medicine_name:   i.name,
      dosage:          i.dose || null,
      frequency:       null,
      duration:        null,
      quantity:        1,
    }))
  );

  closeRxDrawer();
  _alert('success', `${items.length} item(s) sent to Dispensary for ${_rxSession.patients?.name}.`);
};

// Close on overlay click
['sched-overlay','complete-overlay','rx-overlay'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) document.getElementById(id).classList.remove('open');
  });
});

// Init date picker
document.getElementById('date-picker').value = _viewDate;

// §21aa — Emergency Kit Audit
const today = new Date();
document.getElementById('ka-date').value     = today.toISOString().slice(0,10);
const nextMo = new Date(today); nextMo.setMonth(nextMo.getMonth()+1);
document.getElementById('ka-next-due').value = nextMo.toISOString().slice(0,10);
(async function checkKitAuditOverdue() {
  const { data } = await supabase.from('emergency_kit_audits')
    .select('audit_date').eq('tenant_id',tenantId).eq('location','pk_section')
    .order('audit_date',{ascending:false}).limit(1).maybeSingle();
  if (!data) { document.getElementById('kit-audit-overdue-banner').style.display = ''; return; }
  const daysSince = Math.floor((Date.now()-new Date(data.audit_date+'T00:00:00'))/86400000);
  document.getElementById('kit-audit-overdue-banner').style.display = daysSince > 30 ? '' : 'none';
  const recent = document.getElementById('ka-recent');
  if (recent) recent.textContent = `Last audit: ${new Date(data.audit_date+'T00:00:00').toLocaleDateString('en-IN')} · ${daysSince} days ago`;
})();

window.saveKitAudit = async function() {
  const d = document.getElementById('ka-date').value;
  if (!d) { alert('Audit date required'); return; }
  const { error } = await supabase.from('emergency_kit_audits').insert({
    tenant_id: tenantId,
    audit_date: d,
    location: document.getElementById('ka-location').value,
    all_items_present: document.getElementById('ka-items-ok').value === 'true',
    replacements_made: document.getElementById('ka-replacements').value.trim() || null,
    next_audit_due: document.getElementById('ka-next-due').value || null,
    audited_by: myProfile.id,
  });
  if (error) {
    if (error.code === '42P01') alert('Run session32_ncism_gaps.sql in Supabase first');
    else alert(safeErrorMessage(error, 'Something went wrong. Please try again.'));
    return;
  }
  const saved = document.getElementById('ka-saved');
  saved.style.display = ''; setTimeout(()=>saved.style.display='none',3000);
  document.getElementById('kit-audit-overdue-banner').style.display = 'none';
};

await loadAll();
renderPromoBanner('promo-banner', { supabase, tenantId });
