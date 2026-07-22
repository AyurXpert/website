import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['doctor','nurse','super_admin','dept_admin']);
initNavbar();
wireDelegatedEvents();
const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();

// ── State ─────────────────────────────────────────────────────────────────────
let _screeningOpdId = null;
let _departments    = [];    // { id, name, ncism_code, opd_id }
let _queue          = [];    // visits with patients
let _activeVisit    = null;
let _triage         = 'Routine';

// ── Init ──────────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0,10);
document.getElementById('q-date').textContent = new Date(today + 'T00:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short'});
document.getElementById('ss-date').textContent = new Date(today + 'T00:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});

// Get Screening OPD id for this tenant. Two ncism_code conventions exist side by side:
// 'SCREEN' (short-form, current default seeding) and 'SCREENING_OPD' (long-form, legacy
// tenants like Srishti Ayurveda) — check both rather than assuming one.
const { data: screenOpds } = await supabase
  .from('opds')
  .select('id')
  .eq('tenant_id', tenantId)
  .in('ncism_code', ['SCREEN', 'SCREENING_OPD']);
const screenOpd = screenOpds?.[0];

if (!screenOpd) {
  document.getElementById('queue-list').innerHTML = `
    <div class="queue-empty">
      <strong>Screening OPD not configured.</strong><br><br>
      Go to OPD Admin and ensure the Screening OPD (NCISM code: SCREEN) is active for your organisation.
    </div>`;
} else {
  _screeningOpdId = screenOpd.id;
  await loadDepartments();
  await loadQueue();
}

// ── Load departments for routing ──────────────────────────────────────────────
async function loadDepartments() {
  const { data } = await supabase
    .from('departments')
    .select('id,name,ncism_code,opd_id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');

  _departments = (data || []).filter(d => d.opd_id);  // only depts with an OPD

  const sel = document.getElementById('scr-dept');
  _departments.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name + (d.ncism_code ? ` (${d.ncism_code})` : '');
    sel.appendChild(o);
  });
}

// ── Load today's screening queue ──────────────────────────────────────────────
window.loadQueue = async function() {
  if (!_screeningOpdId) return;
  document.getElementById('queue-list').innerHTML = '<div class="queue-empty">Loading…</div>';

  const { data, error } = await supabase
    .from('visits')
    .select('id,status,chief_complaint,token_number,created_at,patients(id,name,phone,age,gender,abha_number)')
    .eq('tenant_id', tenantId)
    .eq('opd_id', _screeningOpdId)
    .in('status', ['waiting','in_progress'])
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59')
    .order('token_number');

  if (error) {
    document.getElementById('queue-list').innerHTML = `<div class="queue-empty">Error: ${safeErrorMessage(error, 'Could not load queue.')}</div>`;
    return;
  }

  _queue = data || [];
  _renderQueue();
  _updateStats();
};

function _renderQueue() {
  const list = document.getElementById('queue-list');
  document.getElementById('q-count').textContent = _queue.length;

  if (!_queue.length) {
    list.innerHTML = '<div class="queue-empty">No patients waiting for screening.<br><br>When Reception registers a patient and selects the Screening OPD, they will appear here.</div>';
    return;
  }

  list.innerHTML = _queue.map(v => {
    const pt   = v.patients || {};
    const meta = [pt.phone, pt.gender, pt.age ? pt.age + 'y' : ''].filter(Boolean).join(' · ');
    const isActive = _activeVisit?.id === v.id;
    return `
      <div class="queue-item${isActive ? ' active' : ''}" data-onclick="selectVisit" data-onclick-a0="${v.id}">
        <div class="qi-top">
          <span class="qi-token">#${v.token_number || '?'}</span>
          <span class="qi-name">${_esc(pt.name || 'Unknown')}</span>
        </div>
        <div class="qi-meta">${_esc(meta)}</div>
        ${v.chief_complaint ? `<div class="qi-cc">${_esc(v.chief_complaint)}</div>` : ''}
      </div>`;
  }).join('');
}

async function _updateStats() {
  // Count screened today (completed visits from screening OPD today)
  const { count: screened } = await supabase
    .from('visits')
    .select('id', { count:'exact', head:true })
    .eq('tenant_id', tenantId)
    .eq('opd_id', _screeningOpdId)
    .eq('status', 'completed')
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59');

  document.getElementById('ss-waiting').textContent  = _queue.length + ' ';
  document.getElementById('ss-screened').textContent = (screened || 0) + ' ';
  document.getElementById('ss-emergency').textContent = '0 ';  // tracked after triage added
}

// ── Select patient from queue ─────────────────────────────────────────────────
window.selectVisit = function(visitId) {
  _activeVisit = _queue.find(v => v.id === visitId);
  if (!_activeVisit) return;

  const pt   = _activeVisit.patients || {};
  const meta = [pt.phone, pt.gender, pt.age ? pt.age + 'y' : ''].filter(Boolean).join(' · ');

  document.getElementById('pt-avatar').textContent = (pt.name || '?').charAt(0).toUpperCase();
  document.getElementById('pt-name').textContent   = pt.name || '—';
  document.getElementById('pt-meta').textContent   = meta || '—';
  document.getElementById('pt-token').textContent  = '#' + (_activeVisit.token_number || '?');
  document.getElementById('scr-cc').value          = _activeVisit.chief_complaint || '';

  // Reset form
  _triage = 'Routine';
  document.querySelectorAll('.triage-opt').forEach(el => el.className = 'triage-opt');
  document.querySelector('[data-triage="Routine"]').classList.add('active-routine');
  document.getElementById('scr-pulse').value        = '';
  document.getElementById('scr-bp').value           = '';
  document.getElementById('scr-temp').value         = '';
  document.getElementById('scr-spo2').value         = '';
  document.getElementById('scr-height').value       = '';
  document.getElementById('scr-weight').value       = '';
  document.getElementById('scr-bmi').value          = '';
  document.getElementById('scr-naadi').value        = '';
  document.getElementById('scr-notes').value        = '';
  document.getElementById('scr-dept').value         = '';
  document.getElementById('scr-instructions').value = '';
  document.getElementById('btn-route').disabled     = true;

  // Show form
  document.getElementById('form-empty').style.display    = 'none';
  document.getElementById('screening-form').style.display = 'flex';
  document.getElementById('alert').classList.remove('show');

  _renderQueue();  // re-render to highlight active
};

window.clearSelection = function() {
  _activeVisit = null;
  _triage      = 'Routine';
  document.getElementById('form-empty').style.display     = 'flex';
  document.getElementById('screening-form').style.display = 'none';
  _renderQueue();
};

// ── BMI auto-calculation ──────────────────────────────────────────────────────
window.calcBMI = function() {
  const h = parseFloat(document.getElementById('scr-height').value);
  const w = parseFloat(document.getElementById('scr-weight').value);
  const el = document.getElementById('scr-bmi');
  if (h > 0 && w > 0) {
    const bmi = (w / Math.pow(h / 100, 2)).toFixed(1);
    el.value = bmi;
  } else {
    el.value = '';
  }
};

// ── Triage selection ──────────────────────────────────────────────────────────
window.selectTriage = function(el) {
  _triage = el.dataset.triage;
  document.querySelectorAll('.triage-opt').forEach(t => t.className = 'triage-opt');
  const clsMap = { Emergency:'active-emergency', Urgent:'active-urgent', 'Semi-urgent':'active-semi', Routine:'active-routine' };
  el.classList.add(clsMap[_triage] || 'active-routine');
};

// ── Enable route button when dept is selected ─────────────────────────────────
window.onDeptChange = function() {
  const dept = document.getElementById('scr-dept').value;
  const btn  = document.getElementById('btn-route');
  btn.disabled = !dept;
  if (dept) {
    const d = _departments.find(d => d.id === dept);
    btn.textContent = '▙ Route to ' + (d ? d.name : 'OPD');
  } else {
    btn.textContent = '▙ Route to OPD';
  }
};

// ── Route patient ─────────────────────────────────────────────────────────────
window.routePatient = async function() {
  if (!_activeVisit) return;

  const deptId = document.getElementById('scr-dept').value;
  if (!deptId) { _alert('error', 'Select a target department first.'); return; }

  const dept         = _departments.find(d => d.id === deptId);
  const cc           = document.getElementById('scr-cc').value.trim()          || _activeVisit.chief_complaint || '';
  const pulse        = document.getElementById('scr-pulse').value.trim();
  const bp           = document.getElementById('scr-bp').value.trim();
  const temp         = document.getElementById('scr-temp').value.trim();
  const spo2         = document.getElementById('scr-spo2').value.trim();
  const height       = document.getElementById('scr-height').value.trim();
  const weight       = document.getElementById('scr-weight').value.trim();
  const bmi          = document.getElementById('scr-bmi').value.trim();
  const naadi        = document.getElementById('scr-naadi').value.trim();
  const notes        = document.getElementById('scr-notes').value.trim();
  const instructions = document.getElementById('scr-instructions').value.trim();

  // Build screening summary to pass to specialty OPD
  const vitals = [
    pulse  && `PR: ${pulse}`,
    bp     && `BP: ${bp}`,
    temp   && `Temp: ${temp}`,
    spo2   && `SpO₂: ${spo2}`,
    height && `Ht: ${height}cm`,
    weight && `Wt: ${weight}kg`,
    bmi    && `BMI: ${bmi}`,
    naadi  && `Naadi: ${naadi}`,
  ].filter(Boolean).join(', ');
  let screeningSummary = `[Triage: ${_triage}]`;
  if (vitals)   screeningSummary += ` | Vitals: ${vitals}`;
  if (notes)    screeningSummary += ` | Screening note: ${notes}`;
  if (instructions) screeningSummary += ` | Instructions: ${instructions}`;

  const btn = document.getElementById('btn-route');
  btn.disabled = true; btn.textContent = 'Routing…';

  // Get next token number for target OPD today
  const { data: lastToken } = await supabase
    .from('visits')
    .select('token_number')
    .eq('tenant_id', tenantId)
    .eq('opd_id', dept.opd_id)
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59')
    .order('token_number', { ascending: false })
    .limit(1);

  const nextToken = lastToken?.[0]?.token_number ? lastToken[0].token_number + 1 : 1;

  // 1. Mark screening visit as completed
  const { error: errComplete } = await supabase
    .from('visits')
    .update({ status: 'completed', chief_complaint: cc })
    .eq('id', _activeVisit.id);

  if (errComplete) {
    _alert('error', 'Failed to complete screening visit: ' + errComplete.message);
    btn.disabled = false; btn.textContent = '↗ Route to OPD'; return;
  }

  // 2. Create new visit in target OPD queue
  const newVisit = {
    tenant_id:        tenantId,
    patient_id:       _activeVisit.patients.id,
    opd_id:           dept.opd_id,
    status:           'waiting',
    chief_complaint:  cc ? cc + '\n' + screeningSummary : screeningSummary,
    token_number:     nextToken,
    is_on_request:    false,
  };

  // Assign doctor if logged-in user is a doctor
  if (profile?.role === 'doctor') newVisit.doctor_id = profile.id;

  const { error: errNew } = await supabase.from('visits').insert(newVisit);

  if (errNew) {
    // Rollback — revert screening visit to waiting
    await supabase.from('visits').update({ status: 'waiting' }).eq('id', _activeVisit.id);
    _alert('error', 'Failed to create specialty OPD visit: ' + errNew.message);
    btn.disabled = false; btn.textContent = '↗ Route to OPD'; return;
  }

  _alert('success', `${_activeVisit.patients?.name} routed to ${dept.name}. Token #${nextToken} created.`);
  _activeVisit = null;
  document.getElementById('form-empty').style.display     = 'flex';
  document.getElementById('screening-form').style.display = 'none';
  await loadQueue();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.className = `alert show ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 4000);
}
