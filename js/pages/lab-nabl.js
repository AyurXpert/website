import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/+esm';
import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { ENV } from '../config/env.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

const ALLOWED = ['super_admin','dept_admin','lab_tech','doctor','nurse'];
await requireAuth(ALLOWED);
const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON_KEY);
const sess     = getCurrentProfile() || {};
const tenantId = getCurrentTenantId();
const today    = new Date().toISOString().slice(0,10);

initNavbar();
wireDelegatedEvents();
init();

// ── State ──────────────────────────────────────────────
let _samples = [], _qcRuns = [], _instruments = [], _staff = [];
let _reagents = [], _requisitions = [], _authItems = [], _ncReports = [], _auditEntries = [];
let _rejectingSampleId = null, _calInstrumentId = null, _maintInstrumentId = null;
let _editingEquipId = null, _editingReagentId = null, _updatingReagentId = null;
let _editingNCId = null;
let _updatingReagentStability = 168;

// ── Tab switch ─────────────────────────────────────────
window.switchTab = function(id) {
  const tabs = ['samples','qc','equipment','reagents','requisitions','authorization','nccapa','auditlog'];
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', tabs[i] === id));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === 'tab-' + id));
  if (id === 'qc')            loadQCRuns();
  if (id === 'equipment')     loadInstruments();
  if (id === 'reagents')      loadReagents();
  if (id === 'requisitions')  loadRequisitions();
  if (id === 'authorization') loadAuthorization();
  if (id === 'nccapa')        loadNC();
  if (id === 'auditlog')      initAuditLog();
};

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
async function init() {
  const now = new Date().toISOString().slice(0,10);
  document.getElementById('s-from').value   = now;
  document.getElementById('s-to').value     = now;
  document.getElementById('qc-month').value = now.slice(0,7);
  await Promise.all([loadStaff(), loadInstruments()]);
  await loadSamples();
  await loadQCRuns();
  populateInstrumentSelects();
}

async function loadStaff() {
  const { data } = await supabase.from('profiles').select('id,full_name,role')
    .eq('tenant_id', tenantId).eq('is_active', true).order('full_name');
  _staff = data || [];
  const opts = _staff.map(s => `<option value="${s.id}">${_esc(s.full_name)} (${_esc(s.role)})</option>`).join('');
  ['sm-collected-by','qm-instrument'].forEach(id => {
    // qm-instrument filled by populateInstrumentSelects
    if (id === 'sm-collected-by') {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<option value="">— Select —</option>' + opts;
    }
  });
}

// ══════════════════════════════════════════════════════
// SAMPLE TRACKING
// ══════════════════════════════════════════════════════
window.loadSamples = async function() {
  const from   = document.getElementById('s-from').value;
  const to     = document.getElementById('s-to').value;
  const status = document.getElementById('s-status').value;
  if (!from || !to) return;

  let q = supabase.from('lab_samples')
    .select('*, lab_orders(id, lab_order_items(test_name)), patients(id,name,age,gender)')
    .eq('tenant_id', tenantId)
    .gte('created_at', from + 'T00:00:00')
    .lte('created_at', to   + 'T23:59:59')
    .order('created_at', { ascending: false });

  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _samples = data || [];
  renderSamples();
  updateSampleKPIs();
};

function renderSamples() {
  const tbody = document.getElementById('samples-tbody');
  if (!_samples.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No samples found.</td></tr>'; return; }
  tbody.innerHTML = _samples.map(s => {
    const tests = (s.lab_orders?.lab_order_items || []).map(t => t.test_name).slice(0,3).join(', ') || '—';
    const colStep = s.collected_at  ? 'done'    : 'pending';
    const recStep = s.received_at   ? 'done'    : 'pending';
    const proStep = s.status === 'processing' ? 'done' : (s.status === 'rejected' ? 'rejected' : 'pending');
    return `<tr>
      <td><code style="font-size:12px;font-weight:600;color:var(--green-deep)">${_esc(s.barcode_id)}</code><br>
          <span style="font-size:10px;color:var(--text-muted)">${_esc(s.tube_type||'—')}</span></td>
      <td style="font-weight:500">${_esc(s.patients?.name||'—')}<br>
          <span style="font-size:10px;color:var(--text-muted)">${s.patients?.age||''}y ${_esc(s.patients?.gender||'')}</span></td>
      <td style="font-size:11px;max-width:120px">${_esc(tests)}</td>
      <td style="font-size:11px">${_esc(s.tube_type||'—')}</td>
      <td>
        <div class="custody-strip">
          <div class="custody-step">
            <div class="cs-dot ${colStep}">✓</div>
            <div class="cs-label">Collected</div>
            <div class="cs-time">${s.collected_at ? _fmtDT(s.collected_at) : ''}</div>
          </div>
          <div class="custody-line ${s.received_at ? 'done' : ''}"></div>
          <div class="custody-step">
            <div class="cs-dot ${recStep}">✓</div>
            <div class="cs-label">Received</div>
            <div class="cs-time">${s.received_at ? _fmtDT(s.received_at) : ''}</div>
          </div>
          <div class="custody-line ${s.status === 'processing' ? 'done' : ''}"></div>
          <div class="custody-step">
            <div class="cs-dot ${proStep}">${s.status === 'rejected' ? '✕' : '✓'}</div>
            <div class="cs-label">Processing</div>
          </div>
        </div>
        ${s.rejection_reason ? `<div style="font-size:10px;color:var(--red);margin-top:4px">Rejected: ${_esc(s.rejection_reason.replace(/_/g,' '))}</div>` : ''}
      </td>
      <td><span class="badge b-${s.status}">${_esc(s.status.charAt(0).toUpperCase()+s.status.slice(1))}</span></td>
      <td>
        ${s.status === 'collected'   ? `<button class="btn btn-outline btn-sm" data-onclick="markReceived" data-onclick-a0="${s.id}">Mark Received</button>` : ''}
        ${s.status === 'received'    ? `<button class="btn btn-outline btn-sm" data-onclick="markProcessing" data-onclick-a0="${s.id}">Processing</button>` : ''}
        ${['collected','received'].includes(s.status) ? `<button class="btn btn-danger btn-sm" data-onclick="openRejectModal" data-onclick-a0="${s.id}">Reject</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function updateSampleKPIs() {
  const todayStr = today;
  const tod = _samples.filter(s => s.created_at?.startsWith(todayStr)).length;
  const col = _samples.filter(s => s.status === 'collected').length;
  const rec = _samples.filter(s => s.status === 'received').length;
  const pro = _samples.filter(s => s.status === 'processing').length;
  const rej = _samples.filter(s => s.status === 'rejected').length;
  document.getElementById('sk-today').textContent     = tod;
  document.getElementById('sk-collected').textContent = col;
  document.getElementById('sk-received').textContent  = rec;
  document.getElementById('sk-processing').textContent= pro;
  document.getElementById('sk-rejected').textContent  = rej;
}

window.markReceived = async function(id) {
  const { error } = await supabase.from('lab_samples').update({
    status: 'received', received_at: new Date().toISOString(), received_by: sess.id,
  }).eq('id', id);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Sample marked as received', 'success');
  loadSamples();
};

window.markProcessing = async function(id) {
  const { error } = await supabase.from('lab_samples').update({ status: 'processing' }).eq('id', id);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Sample moved to Processing', 'success');
  loadSamples();
};

window.openRejectModal = function(id) {
  _rejectingSampleId = id;
  document.getElementById('rej-reason').value = '';
  document.getElementById('rej-notes').value  = '';
  document.getElementById('reject-modal').classList.add('show');
};
window.closeRejectModal = function() {
  document.getElementById('reject-modal').classList.remove('show');
  _rejectingSampleId = null;
};
window.confirmReject = async function() {
  const reason = document.getElementById('rej-reason').value;
  if (!reason) { _toast('Please select a rejection reason', 'error'); return; }
  const { error } = await supabase.from('lab_samples').update({
    status: 'rejected', rejection_reason: reason,
    rejected_at: new Date().toISOString(), rejected_by: sess.id,
  }).eq('id', _rejectingSampleId);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Sample rejected', 'warning');
  closeRejectModal();
  loadSamples();
};

// Sample modal
let _orderSearchTimer;
window.openSampleModal = function() {
  document.getElementById('sm-order-id').value       = '';
  document.getElementById('sm-order-label').textContent = '';
  document.getElementById('sm-order-search').value   = '';
  document.getElementById('sm-order-results').style.display = 'none';
  document.getElementById('sm-barcode').value        = _genBarcode();
  document.getElementById('sm-collected-at').value   = new Date().toISOString().slice(0,16);
  document.getElementById('sm-tube').value           = '';
  document.getElementById('sm-volume').value         = '';
  document.getElementById('sm-notes').value          = '';
  document.getElementById('barcode-preview').style.display = 'none';
  document.getElementById('sample-modal').classList.add('show');
};
window.closeSampleModal = function() { document.getElementById('sample-modal').classList.remove('show'); };

function _genBarcode() {
  const d = new Date(); const pad = n => String(n).padStart(2,'0');
  const datePart = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const rand = String(Math.floor(Math.random()*9000)+1000);
  return `SMP-${datePart}-${rand}`;
}

window.searchOrders = function() {
  clearTimeout(_orderSearchTimer);
  _orderSearchTimer = setTimeout(_doOrderSearch, 300);
};

async function _doOrderSearch() {
  const q = document.getElementById('sm-order-search').value.trim();
  const el = document.getElementById('sm-order-results');
  if (q.length < 2) { el.style.display='none'; return; }
  const isPhone = /^\d{7,}$/.test(q);
  const { data: patients } = isPhone
    ? await supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId).eq('phone',q).limit(5)
    : await supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId).ilike('name',`%${q}%`).limit(5);
  if (!patients?.length) { el.innerHTML='<div style="padding:8px;color:var(--text-muted)">No patients found</div>'; el.style.display=''; return; }
  const patIds = patients.map(p => p.id);
  const { data: orders } = await supabase.from('lab_orders')
    .select('id, created_at, patients(name), lab_order_items(test_name)')
    .eq('tenant_id', tenantId).in('patient_id', patIds)
    .in('status', ['ordered','sample_collected']).order('created_at',{ascending:false}).limit(10);
  if (!orders?.length) { el.innerHTML='<div style="padding:8px;color:var(--text-muted)">No pending lab orders</div>'; el.style.display=''; return; }
  el.innerHTML = orders.map(o => {
    const tests = (o.lab_order_items||[]).map(t=>t.test_name).join(', ');
    return `<div data-onclick="selectOrder" data-onclick-a0="${o.id}" data-onclick-a1="${_esc(o.patients?.name||'')}" data-onclick-a2="${_esc(tests)}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12px">
      <strong>${_esc(o.patients?.name||'—')}</strong> · ${_fmtDate(o.created_at.slice(0,10))}<br>
      <span style="color:var(--text-muted)">${_esc(tests)}</span>
    </div>`;
  }).join('');
  el.style.display = '';
}

window.selectOrder = function(id, name, tests) {
  document.getElementById('sm-order-id').value = id;
  document.getElementById('sm-order-label').textContent = `✓ Order: ${name} — ${tests}`;
  document.getElementById('sm-order-results').style.display = 'none';
  document.getElementById('sm-order-search').value = name;
};

window.previewBarcode = function() {
  const bid = document.getElementById('sm-barcode').value.trim();
  const orderLabel = document.getElementById('sm-order-label').textContent;
  if (!bid) { _toast('Enter a barcode ID first', 'error'); return; }
  const card = document.getElementById('barcode-preview');
  document.getElementById('barcode-preview-id').textContent = bid;
  document.getElementById('barcode-preview-sub').textContent = orderLabel || '';
  const qrDiv = document.getElementById('barcode-qr');
  qrDiv.innerHTML = '';
  try { new window.QRCode(qrDiv, { text: bid, width:80, height:80, colorDark:'#1a4a2e' }); } catch(e) {}
  card.style.display = '';
};

window.saveSample = async function() {
  const orderId    = document.getElementById('sm-order-id').value;
  const barcode    = document.getElementById('sm-barcode').value.trim();
  const collectedAt= document.getElementById('sm-collected-at').value;
  const collectedBy= document.getElementById('sm-collected-by').value;
  if (!barcode)    { _toast('Barcode ID is required', 'error'); return; }
  if (!collectedAt){ _toast('Collection time is required', 'error'); return; }

  // Get patient_id from order
  let patientId = null;
  if (orderId) {
    const { data: o } = await supabase.from('lab_orders').select('patient_id').eq('id',orderId).maybeSingle();
    patientId = o?.patient_id || null;
  }

  const { error } = await supabase.from('lab_samples').insert({
    tenant_id: tenantId, lab_order_id: orderId || null, patient_id: patientId,
    barcode_id: barcode, tube_type: document.getElementById('sm-tube').value || null,
    volume_ml: parseFloat(document.getElementById('sm-volume').value) || null,
    collected_at: new Date(collectedAt).toISOString(),
    collected_by: collectedBy || sess.id,
    status: 'collected',
    notes: document.getElementById('sm-notes').value.trim() || null,
  });
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Sample logged', 'success');
  closeSampleModal();
  loadSamples();
};

// ══════════════════════════════════════════════════════
// QC LOG
// ══════════════════════════════════════════════════════
window.loadQCRuns = async function() {
  const month      = document.getElementById('qc-month').value;
  const instrId    = document.getElementById('qc-instrument').value;
  const level      = document.getElementById('qc-level').value;
  const from = month ? month + '-01' : today.slice(0,7) + '-01';
  const toDate = month ? _lastDayOfMonth(month) : today;

  let q = supabase.from('lab_qc_runs')
    .select('*, lab_instruments(name), profiles!tech_id(full_name)')
    .eq('tenant_id', tenantId)
    .gte('run_date', from).lte('run_date', toDate)
    .order('run_date', { ascending: false }).order('created_at', { ascending: false });

  if (instrId) q = q.eq('instrument_id', instrId);
  if (level)   q = q.eq('control_level', level);

  const { data, error } = await q;
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _qcRuns = data || [];
  renderQCTable();
  updateQCKPIs();
  populateLJSelects();
};

function renderQCTable() {
  const tbody = document.getElementById('qc-tbody');
  if (!_qcRuns.length) { tbody.innerHTML = '<tr><td colspan="11" class="empty">No QC runs found.</td></tr>'; return; }
  tbody.innerHTML = _qcRuns.map(r => {
    const z = r.expected_sd > 0 ? ((r.observed_value - r.expected_mean) / r.expected_sd).toFixed(2) : '—';
    const viols = Array.isArray(r.westgard_violations) ? r.westgard_violations : [];
    const violHtml = viols.length
      ? viols.map(v => `<span class="viol-tag">${v}</span>`).join('')
      : '<span style="color:var(--text-muted);font-size:11px">None</span>';
    const zColor = !isNaN(z) && Math.abs(parseFloat(z)) > 3 ? 'var(--red)' :
                   !isNaN(z) && Math.abs(parseFloat(z)) > 2 ? 'var(--gold)' : 'var(--green-mid)';
    return `<tr>
      <td style="font-size:11px;white-space:nowrap">${_fmtDate(r.run_date)}</td>
      <td style="font-size:11px">${_esc(r.lab_instruments?.name||'—')}</td>
      <td style="font-weight:500">${_esc(r.test_name)}</td>
      <td><span class="badge" style="background:#e3f2fd;color:#1565c0;border-color:#90caf9">${_esc(r.control_level)}</span></td>
      <td style="font-size:11px;color:var(--text-muted)">${_esc(r.control_lot||'—')}</td>
      <td style="font-size:11px">${r.expected_mean} ± ${r.expected_sd}</td>
      <td style="font-weight:600">${r.observed_value}</td>
      <td style="font-weight:600;color:${zColor}">${z}</td>
      <td>${violHtml}</td>
      <td><span class="badge b-${r.status}">${_esc(r.status.charAt(0).toUpperCase()+r.status.slice(1))}</span></td>
      <td style="font-size:11px">${_esc(r.profiles?.full_name||'—')}</td>
    </tr>`;
  }).join('');
}

function updateQCKPIs() {
  const todayRuns = _qcRuns.filter(r => r.run_date === today);
  const thisMonth = new Date().toISOString().slice(0,7);
  document.getElementById('qk-today').textContent = todayRuns.length;
  document.getElementById('qk-pass').textContent  = _qcRuns.filter(r => r.status === 'pass').length;
  document.getElementById('qk-warn').textContent  = _qcRuns.filter(r => r.status === 'warning').length;
  document.getElementById('qk-fail').textContent  = _qcRuns.filter(r => r.status === 'fail').length;
  document.getElementById('qk-month').textContent = _qcRuns.filter(r => r.run_date?.startsWith(thisMonth)).length;
}

// QC modal
window.openQCModal = function() {
  document.getElementById('qm-test').value    = '';
  document.getElementById('qm-level').value   = 'L2';
  document.getElementById('qm-lot').value     = '';
  document.getElementById('qm-date').value    = today;
  document.getElementById('qm-mean').value    = '';
  document.getElementById('qm-sd').value      = '';
  document.getElementById('qm-value').value   = '';
  document.getElementById('qm-zscore').value  = '';
  document.getElementById('qm-shift').value   = '';
  document.getElementById('qm-notes').value   = '';
  document.getElementById('westgard-panel').style.display = 'none';
  document.getElementById('westgard-panel').className = 'westgard-panel';
  document.getElementById('qc-modal').classList.add('show');
};
window.closeQCModal = function() { document.getElementById('qc-modal').classList.remove('show'); };

window.calcQCZ = function() {
  const mean  = parseFloat(document.getElementById('qm-mean').value);
  const sd    = parseFloat(document.getElementById('qm-sd').value);
  const val   = parseFloat(document.getElementById('qm-value').value);
  if (!isNaN(mean) && !isNaN(sd) && sd > 0 && !isNaN(val)) {
    document.getElementById('qm-zscore').value = ((val - mean) / sd).toFixed(3);
  } else {
    document.getElementById('qm-zscore').value = '';
  }
};

// ── Westgard Rule Checker ─────────────────────────────
function _checkWestgard(runs, mean, sd, newVal) {
  const allVals = [...runs.map(r => r.observed_value), newVal];
  const n = allVals.length;
  const z = v => (v - mean) / sd;
  const violations = [];
  const newZ = z(newVal);

  if (Math.abs(newZ) > 3)  violations.push('1₃s — REJECT: exceeds ±3SD');
  else if (Math.abs(newZ) > 2) violations.push('1₂s — WARNING: exceeds ±2SD');

  if (n >= 2) {
    const prev = z(allVals[n-2]);
    if (newZ > 2 && prev > 2)   violations.push('2₂s — REJECT: 2 consecutive >+2SD');
    if (newZ < -2 && prev < -2) violations.push('2₂s — REJECT: 2 consecutive <-2SD');
    const ruleRange = Math.abs(newZ - prev);
    if (ruleRange > 4) violations.push('R₄s — REJECT: range >4SD within run');
  }
  if (n >= 4) {
    const last4 = allVals.slice(-4).map(z);
    if (last4.every(v => v > 1))  violations.push('4₁s — REJECT: 4 consecutive >+1SD');
    if (last4.every(v => v < -1)) violations.push('4₁s — REJECT: 4 consecutive <-1SD');
  }
  if (n >= 10) {
    const last10 = allVals.slice(-10).map(z);
    if (last10.every(v => v > 0)) violations.push('10x — REJECT: 10 consecutive above mean');
    if (last10.every(v => v < 0)) violations.push('10x — REJECT: 10 consecutive below mean');
  }
  return violations;
}

window.checkWestgardPreview = function() {
  const mean = parseFloat(document.getElementById('qm-mean').value);
  const sd   = parseFloat(document.getElementById('qm-sd').value);
  const val  = parseFloat(document.getElementById('qm-value').value);
  const instr= document.getElementById('qm-instrument').value;
  const test = document.getElementById('qm-test').value;
  const level= document.getElementById('qm-level').value;
  if (isNaN(mean) || isNaN(sd) || isNaN(val) || sd <= 0) {
    _toast('Enter mean, SD, and observed value first', 'error'); return;
  }
  const prevRuns = _qcRuns.filter(r => r.instrument_id === instr && r.test_name === test && r.control_level === level)
                          .sort((a,b) => a.run_date.localeCompare(b.run_date)).slice(-19);
  const viols = _checkWestgard(prevRuns, mean, sd, val);
  const panel = document.getElementById('westgard-panel');
  const title = document.getElementById('westgard-title');
  const details = document.getElementById('westgard-details');
  const hasReject  = viols.some(v => v.includes('REJECT'));
  const hasWarning = viols.some(v => v.includes('WARNING'));
  panel.style.display = '';
  if (hasReject) {
    panel.className = 'westgard-panel fail';
    title.innerHTML = '🔴 RUN REJECTED — Do not release patient results';
  } else if (hasWarning) {
    panel.className = 'westgard-panel warning';
    title.innerHTML = '🟡 WARNING — Investigate before releasing results';
  } else {
    panel.className = 'westgard-panel pass';
    title.innerHTML = '🟢 QC PASS — Run is within acceptable limits';
  }
  details.innerHTML = viols.length
    ? viols.map(v => `<div>• ${v}</div>`).join('')
    : 'No Westgard violations detected. All rules pass.';
};

window.saveQCRun = async function() {
  const instrId = document.getElementById('qm-instrument').value;
  const test    = document.getElementById('qm-test').value.trim();
  const level   = document.getElementById('qm-level').value;
  const mean    = parseFloat(document.getElementById('qm-mean').value);
  const sd      = parseFloat(document.getElementById('qm-sd').value);
  const val     = parseFloat(document.getElementById('qm-value').value);
  const date    = document.getElementById('qm-date').value;

  if (!instrId) { _toast('Please select an instrument', 'error'); return; }
  if (!test)    { _toast('Test name is required', 'error'); return; }
  if (isNaN(mean) || isNaN(sd) || isNaN(val)) { _toast('Mean, SD, and observed value are required', 'error'); return; }
  if (sd <= 0)  { _toast('SD must be greater than 0', 'error'); return; }
  if (!date)    { _toast('Run date is required', 'error'); return; }

  const prevRuns = _qcRuns.filter(r => r.instrument_id === instrId && r.test_name === test && r.control_level === level)
                          .sort((a,b) => a.run_date.localeCompare(b.run_date)).slice(-19);
  const viols = _checkWestgard(prevRuns, mean, sd, val);
  const hasReject  = viols.some(v => v.includes('REJECT'));
  const hasWarning = viols.some(v => v.includes('WARNING'));
  const status = hasReject ? 'fail' : hasWarning ? 'warning' : 'pass';
  const violCodes = viols.map(v => v.split(' ')[0]);

  const { error } = await supabase.from('lab_qc_runs').insert({
    tenant_id: tenantId, instrument_id: instrId, test_name: test,
    control_level: level, control_lot: document.getElementById('qm-lot').value.trim() || null,
    expected_mean: mean, expected_sd: sd, observed_value: val,
    shift: document.getElementById('qm-shift').value.trim() || null,
    run_date: date, tech_id: sess.id,
    westgard_violations: violCodes, status,
    notes: document.getElementById('qm-notes').value.trim() || null,
  });
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast(`QC run saved — ${status.toUpperCase()}${viols.length ? ': ' + violCodes.join(', ') : ''}`,
         status === 'pass' ? 'success' : status === 'warning' ? 'warning' : 'error');
  closeQCModal();
  loadQCRuns();
};

// ── Levey-Jennings chart ──────────────────────────────
function populateLJSelects() {
  const instrSel = document.getElementById('lj-instrument');
  instrSel.innerHTML = '<option value="">Select Instrument</option>' +
    _instruments.map(i => `<option value="${i.id}">${_esc(i.name)}</option>`).join('');
}

window.renderLJ = function() {
  const instrId = document.getElementById('lj-instrument').value;
  const test    = document.getElementById('lj-test').value;
  const level   = document.getElementById('lj-level').value;

  // Populate test list for selected instrument
  if (instrId) {
    const tests = [...new Set(_qcRuns.filter(r => r.instrument_id === instrId).map(r => r.test_name))];
    const testSel = document.getElementById('lj-test');
    const cur = testSel.value;
    testSel.innerHTML = '<option value="">Select Test</option>' +
      tests.map(t => `<option value="${_esc(t)}">${_esc(t)}</option>`).join('');
    if (cur) testSel.value = cur;
  }

  if (!instrId || !test || !level) { return; }

  const runs = _qcRuns.filter(r =>
    r.instrument_id === instrId && r.test_name === test && r.control_level === level
  ).sort((a,b) => a.run_date.localeCompare(b.run_date) || a.created_at.localeCompare(b.created_at))
   .slice(-20);

  const chartArea = document.getElementById('lj-chart-area');
  if (!runs.length) { chartArea.innerHTML = '<div class="empty" style="padding:16px">No QC runs found for this selection.</div>'; return; }

  const mean = runs[runs.length-1].expected_mean;
  const sd   = runs[runs.length-1].expected_sd;

  // Build SVG
  const W=660, H=280, PL=60, PR=20, PT=20, PB=40;
  const plotW = W-PL-PR, plotH = H-PT-PB;
  const yMin = mean - 3.5*sd, yMax = mean + 3.5*sd;
  const xScale = i => PL + (i/(runs.length-1 || 1)) * plotW;
  const yScale = v => PT + plotH - ((v - yMin)/(yMax - yMin)) * plotH;

  const yLines = [
    { v: mean + 3*sd, color:'#c0392b', dash:'4,4', label:'+3SD' },
    { v: mean + 2*sd, color:'#c9902a', dash:'4,4', label:'+2SD' },
    { v: mean + 1*sd, color:'#8a9e90', dash:'4,4', label:'+1SD' },
    { v: mean,        color:'#2d7a4f', dash:'',    label:'Mean' },
    { v: mean - 1*sd, color:'#8a9e90', dash:'4,4', label:'-1SD' },
    { v: mean - 2*sd, color:'#c9902a', dash:'4,4', label:'-2SD' },
    { v: mean - 3*sd, color:'#c0392b', dash:'4,4', label:'-3SD' },
  ];

  const linesHTML = yLines.map(l => {
    const y = yScale(l.v);
    return `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="${l.color}" stroke-width="${l.label==='Mean'?2:1}" stroke-dasharray="${l.dash}" opacity="0.8"/>
            <text x="${PL-4}" y="${y+4}" font-size="9" fill="${l.color}" text-anchor="end">${l.label}</text>
            <text x="${W-PR+4}" y="${y+4}" font-size="9" fill="${l.color}">${l.v.toFixed(1)}</text>`;
  }).join('');

  const ptColor = r => {
    if (r.status === 'fail') return '#c0392b';
    if (r.status === 'warning') return '#c9902a';
    return '#2d7a4f';
  };

  const pointsHTML = runs.map((r,i) => {
    const x = xScale(i), y = yScale(r.observed_value);
    const col = ptColor(r);
    return `<circle cx="${x}" cy="${y}" r="5" fill="${col}" stroke="#fff" stroke-width="1.5"/>
            <text x="${x}" y="${H-PB+14}" font-size="8" fill="#8a9e90" text-anchor="middle">${i+1}</text>
            <text x="${x}" y="${y-8}" font-size="8" fill="${col}" text-anchor="middle">${r.observed_value}</text>`;
  }).join('');

  const linePathPts = runs.map((r,i) => `${i===0?'M':'L'}${xScale(i)},${yScale(r.observed_value)}`).join(' ');

  chartArea.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;font-family:'DM Sans',sans-serif">
    <rect x="${PL}" y="${PT}" width="${plotW}" height="${plotH}" fill="#fafafa" stroke="${'#d4e6da'}" stroke-width="1" rx="2"/>
    ${linesHTML}
    ${runs.length > 1 ? `<path d="${linePathPts}" fill="none" stroke="#d4e6da" stroke-width="1.5"/>` : ''}
    ${pointsHTML}
    <text x="${W/2}" y="${H-2}" font-size="10" fill="#8a9e90" text-anchor="middle">Run sequence (last ${runs.length})</text>
  </svg>`;
};

// ══════════════════════════════════════════════════════
// EQUIPMENT REGISTER
// ══════════════════════════════════════════════════════
async function loadInstruments() {
  const { data, error } = await supabase.from('lab_instruments')
    .select('*').eq('tenant_id', tenantId).order('name');
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _instruments = data || [];
  renderEquipment();
  updateEquipKPIs();
  checkCalibLock();
  populateInstrumentSelects();
}

function populateInstrumentSelects() {
  const opts = _instruments.map(i => `<option value="${i.id}">${_esc(i.name)}</option>`).join('');
  ['qc-instrument','qm-instrument','lj-instrument'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const prefix = id === 'qm-instrument' ? '<option value="">— Select instrument —</option>' :
                   id === 'qc-instrument' ? '<option value="">All Instruments</option>' :
                   '<option value="">Select Instrument</option>';
    el.innerHTML = prefix + opts;
  });
}

window.renderEquipment = function() {
  const filter = document.getElementById('eq-filter').value;
  const today30 = new Date(); today30.setDate(today30.getDate() + 30);
  const today30Str = today30.toISOString().slice(0,10);

  let list = _instruments.filter(i => {
    if (!filter) return true;
    if (filter === 'active') return i.status === 'active';
    if (filter === 'overdue') return i.calibration_due_date && i.calibration_due_date < today && i.status !== 'decommissioned';
    if (filter === 'due_soon') return i.calibration_due_date && i.calibration_due_date >= today && i.calibration_due_date <= today30Str;
    if (filter === 'under_maintenance') return i.status === 'under_maintenance';
    return true;
  });

  const el = document.getElementById('equip-list');
  if (!list.length) { el.innerHTML = '<div class="empty">No instruments found.</div>'; return; }

  el.innerHTML = list.map(i => {
    const calStatus = _calibStatus(i);
    return `<div class="eq-card">
      <div class="eq-top">
        <div>
          <div class="eq-name">${_esc(i.name)}</div>
          <div class="eq-model">${_esc([i.manufacturer, i.model, i.serial_number].filter(Boolean).join(' · '))}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span class="badge ${calStatus.cls}">${calStatus.label}</span>
          ${i.nabl_ref_number ? `<span class="badge" style="background:#e3f2fd;color:#1565c0;border-color:#90caf9;font-size:10px">${_esc(i.nabl_ref_number)}</span>` : ''}
        </div>
      </div>
      <div class="eq-meta">
        <div class="eq-meta-item">Location: <span>${_esc(i.location||'—')}</span></div>
        <div class="eq-meta-item">Installed: <span>${i.installation_date ? _fmtDate(i.installation_date) : '—'}</span></div>
        <div class="eq-meta-item">Last Calibration: <span>${i.last_calibration_date ? _fmtDate(i.last_calibration_date) : 'Not recorded'}</span></div>
        <div class="eq-meta-item" style="color:${calStatus.cls.includes('overdue')?'var(--red)':calStatus.cls.includes('due-soon')?'var(--orange)':'inherit'}">
          Next Due: <span>${i.calibration_due_date ? _fmtDate(i.calibration_due_date) : 'Not set'}</span></div>
        <div class="eq-meta-item">Last Maintenance: <span>${i.last_maintenance_date ? _fmtDate(i.last_maintenance_date) : '—'}</span></div>
        <div class="eq-meta-item">Cal. Interval: <span>${i.calibration_interval_days||365} days</span></div>
      </div>
      <div class="eq-actions">
        <button class="btn btn-primary btn-sm" data-onclick="openCalModal" data-onclick-a0="${i.id}" data-onclick-a1="${_esc(i.name)}">📅 Log Calibration</button>
        <button class="btn btn-outline btn-sm" data-onclick="openMaintModal" data-onclick-a0="${i.id}" data-onclick-a1="${_esc(i.name)}">🔧 Log Maintenance</button>
        <button class="btn btn-outline btn-sm" data-onclick="openEquipModal" data-onclick-a0="${i.id}">Edit</button>
      </div>
    </div>`;
  }).join('');
};

function _calibStatus(i) {
  if (i.status === 'decommissioned') return { cls:'b-decommissioned', label:'Decommissioned' };
  if (i.status === 'under_maintenance') return { cls:'b-maintenance', label:'Under Maintenance' };
  if (!i.calibration_due_date)       return { cls:'b-active', label:'Active (no cal date)' };
  const today30 = new Date(); today30.setDate(today30.getDate() + 30);
  if (i.calibration_due_date < today)  return { cls:'b-overdue', label:'⚠ Calibration Overdue' };
  if (i.calibration_due_date <= today30.toISOString().slice(0,10)) return { cls:'b-due-soon', label:'Due in 30 Days' };
  return { cls:'b-active', label:'Calibrated ✓' };
}

function updateEquipKPIs() {
  const today30 = new Date(); today30.setDate(today30.getDate()+30);
  const today30Str = today30.toISOString().slice(0,10);
  document.getElementById('ek-total').textContent   = _instruments.length;
  document.getElementById('ek-active').textContent  = _instruments.filter(i => i.status==='active').length;
  document.getElementById('ek-overdue').textContent = _instruments.filter(i => i.calibration_due_date && i.calibration_due_date < today && i.status !== 'decommissioned').length;
  document.getElementById('ek-due-soon').textContent= _instruments.filter(i => i.calibration_due_date >= today && i.calibration_due_date <= today30Str).length;
  document.getElementById('ek-maint').textContent   = _instruments.filter(i => i.status==='under_maintenance').length;
}

function checkCalibLock() {
  const overdue = _instruments.filter(i => i.calibration_due_date && i.calibration_due_date < today && i.status === 'active');
  const banner = document.getElementById('calib-lock-banner');
  if (overdue.length) {
    banner.classList.add('show');
    document.getElementById('calib-lock-text').textContent =
      `${overdue.length} instrument(s) overdue: ${overdue.map(i=>i.name).join(', ')}. Result entry for these instruments should be blocked until recalibrated.`;
  } else {
    banner.classList.remove('show');
  }
}

// Equipment CRUD
window.openEquipModal = async function(id) {
  _editingEquipId = id || null;
  const el = document.getElementById('em-title');
  el.textContent = id ? 'Edit Instrument' : 'Add Instrument';
  if (id) {
    const inst = _instruments.find(i => i.id === id) || {};
    document.getElementById('em-name').value         = inst.name || '';
    document.getElementById('em-model').value        = inst.model || '';
    document.getElementById('em-serial').value       = inst.serial_number || '';
    document.getElementById('em-manufacturer').value = inst.manufacturer || '';
    document.getElementById('em-location').value     = inst.location || '';
    document.getElementById('em-install').value      = inst.installation_date || '';
    document.getElementById('em-cal-interval').value = inst.calibration_interval_days || 365;
    document.getElementById('em-last-cal').value     = inst.last_calibration_date || '';
    document.getElementById('em-next-cal').value     = inst.calibration_due_date || '';
    document.getElementById('em-nabl-ref').value     = inst.nabl_ref_number || '';
    document.getElementById('em-status').value       = inst.status || 'active';
  } else {
    ['em-name','em-model','em-serial','em-manufacturer','em-location','em-install','em-last-cal','em-next-cal','em-nabl-ref'].forEach(f => document.getElementById(f).value = '');
    document.getElementById('em-cal-interval').value = 365;
    document.getElementById('em-status').value       = 'active';
  }
  document.getElementById('equip-modal').classList.add('show');
};
window.closeEquipModal = function() { document.getElementById('equip-modal').classList.remove('show'); _editingEquipId = null; };

window.autoCalcNextCal = function() {
  const lastCal = document.getElementById('em-last-cal').value;
  const interval = parseInt(document.getElementById('em-cal-interval').value) || 365;
  if (lastCal) {
    const next = new Date(lastCal); next.setDate(next.getDate() + interval);
    document.getElementById('em-next-cal').value = next.toISOString().slice(0,10);
  }
};

window.saveEquip = async function() {
  const name = document.getElementById('em-name').value.trim();
  if (!name) { _toast('Instrument name is required', 'error'); return; }
  const payload = {
    tenant_id: tenantId, name,
    model:            document.getElementById('em-model').value.trim() || null,
    serial_number:    document.getElementById('em-serial').value.trim() || null,
    manufacturer:     document.getElementById('em-manufacturer').value.trim() || null,
    location:         document.getElementById('em-location').value.trim() || null,
    installation_date:document.getElementById('em-install').value || null,
    calibration_interval_days: parseInt(document.getElementById('em-cal-interval').value) || 365,
    last_calibration_date: document.getElementById('em-last-cal').value || null,
    calibration_due_date:  document.getElementById('em-next-cal').value || null,
    nabl_ref_number:       document.getElementById('em-nabl-ref').value.trim() || null,
    status:                document.getElementById('em-status').value,
  };
  let error;
  if (_editingEquipId) {
    ({ error } = await supabase.from('lab_instruments').update(payload).eq('id', _editingEquipId));
  } else {
    ({ error } = await supabase.from('lab_instruments').insert(payload));
  }
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast(_editingEquipId ? 'Instrument updated' : 'Instrument added', 'success');
  closeEquipModal();
  loadInstruments();
};

// Calibration log
window.openCalModal = function(instrId, instrName) {
  _calInstrumentId = instrId;
  document.getElementById('cal-modal-title').textContent = `Log Calibration — ${instrName}`;
  document.getElementById('cal-date').value   = today;
  document.getElementById('cal-cert').value   = '';
  document.getElementById('cal-by').value     = '';
  document.getElementById('cal-result').value = 'pass';
  document.getElementById('cal-notes').value  = '';
  // Default next due date: last_cal + interval
  const inst = _instruments.find(i => i.id === instrId);
  if (inst) {
    const interval = inst.calibration_interval_days || 365;
    const next = new Date(today); next.setDate(next.getDate() + interval);
    document.getElementById('cal-next').value = next.toISOString().slice(0,10);
    // Show calibration history
    const hist = (inst.calibration_log || []).slice().reverse().slice(0,5);
    document.getElementById('cal-history').innerHTML = hist.length
      ? `<div style="font-size:12px;font-weight:600;color:var(--green-deep);margin-bottom:6px">Previous calibrations (last 5)</div>` +
        hist.map(c => `<div style="font-size:11px;color:var(--text-muted);padding:4px 0;border-bottom:1px solid var(--border)">${_fmtDate(c.date)} · ${_esc(c.performed_by||'—')} · ${_esc(c.certificate_number||'—')} · <strong style="color:${c.result==='pass'?'var(--green-mid)':'var(--red)'}">${_esc(c.result||'—')}</strong></div>`).join('')
      : '';
  }
  document.getElementById('cal-modal').classList.add('show');
};
window.closeCalModal = function() { document.getElementById('cal-modal').classList.remove('show'); _calInstrumentId = null; };

window.saveCal = async function() {
  const date = document.getElementById('cal-date').value;
  const next = document.getElementById('cal-next').value;
  if (!date || !next) { _toast('Date and next due are required', 'error'); return; }
  const inst = _instruments.find(i => i.id === _calInstrumentId);
  const entry = {
    date, certificate_number: document.getElementById('cal-cert').value.trim() || null,
    performed_by: document.getElementById('cal-by').value.trim() || null,
    result: document.getElementById('cal-result').value,
    notes: document.getElementById('cal-notes').value.trim() || null,
    next_due: next,
  };
  const newLog = [...(inst?.calibration_log || []), entry];
  const { error } = await supabase.from('lab_instruments').update({
    last_calibration_date: date, calibration_due_date: next, calibration_log: newLog,
  }).eq('id', _calInstrumentId);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Calibration logged', 'success');
  closeCalModal();
  loadInstruments();
};

// Maintenance log
window.openMaintModal = function(instrId, instrName) {
  _maintInstrumentId = instrId;
  document.getElementById('maint-modal-title').textContent = `Log Maintenance — ${instrName}`;
  document.getElementById('maint-date').value = today;
  document.getElementById('maint-type').value = 'preventive';
  document.getElementById('maint-by').value   = '';
  document.getElementById('maint-desc').value = '';
  document.getElementById('maint-next').value = '';
  const inst = _instruments.find(i => i.id === instrId);
  const hist = (inst?.maintenance_log || []).slice().reverse().slice(0,4);
  document.getElementById('maint-history').innerHTML = hist.length
    ? `<div style="font-size:12px;font-weight:600;color:var(--green-deep);margin-bottom:6px">Recent maintenance</div>` +
      hist.map(m => `<div style="font-size:11px;color:var(--text-muted);padding:4px 0;border-bottom:1px solid var(--border)">${_fmtDate(m.date)} · ${_esc(m.type||'—')} · ${_esc(m.performed_by||'—')}</div>`).join('')
    : '';
  document.getElementById('maint-modal').classList.add('show');
};
window.closeMaintModal = function() { document.getElementById('maint-modal').classList.remove('show'); _maintInstrumentId = null; };

window.saveMaint = async function() {
  const date = document.getElementById('maint-date').value;
  const desc = document.getElementById('maint-desc').value.trim();
  if (!date || !desc) { _toast('Date and description are required', 'error'); return; }
  const inst = _instruments.find(i => i.id === _maintInstrumentId);
  const entry = {
    date, type: document.getElementById('maint-type').value,
    performed_by: document.getElementById('maint-by').value.trim() || null,
    description: desc,
    next_due: document.getElementById('maint-next').value || null,
  };
  const newLog = [...(inst?.maintenance_log || []), entry];
  const updates = { maintenance_log: newLog, last_maintenance_date: date };
  const { error } = await supabase.from('lab_instruments').update(updates).eq('id', _maintInstrumentId);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Maintenance logged', 'success');
  closeMaintModal();
  loadInstruments();
};

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════
function _fmtDate(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _fmtDT(s) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})} ${d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}`;
}
function _lastDayOfMonth(yearMonth) {
  const [y,m] = yearMonth.split('-').map(Number);
  return new Date(y, m, 0).toISOString().slice(0,10);
}
function _toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ══════════════════════════════════════════════════════
// REAGENT BATCHES (Tab 4)
// ══════════════════════════════════════════════════════
async function loadReagents() {
  const { data, error } = await supabase
    .from('reagent_batches')
    .select('*, lab_instruments(name)')
    .eq('tenant_id', tenantId)
    .order('manufacturer_expiry', { ascending: true });
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _reagents = data || [];
  renderReagents();
  updateReagentKPIs();
}

window.renderReagents = function() {
  const filter = document.getElementById('rg-filter').value;
  const now = new Date();
  const soon7 = new Date(); soon7.setDate(soon7.getDate() + 7);

  let rows = _reagents.filter(r => {
    if (!filter) return true;
    const effExpiry = _effectiveExpiry(r);
    if (filter === 'unopened')  return r.status === 'unopened';
    if (filter === 'in_use')    return r.status === 'in_use';
    if (filter === 'expired')   return effExpiry && new Date(effExpiry) < now;
    if (filter === 'rop')       return r.reorder_point > 0 && r.quantity_remaining <= r.reorder_point;
    return true;
  });

  const tbody = document.getElementById('reagents-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="11" class="empty">No reagent batches found.</td></tr>'; return; }

  tbody.innerHTML = rows.map(r => {
    const effExpiry  = _effectiveExpiry(r);
    const isExpired  = effExpiry && new Date(effExpiry) < now;
    const isSoon     = effExpiry && !isExpired && new Date(effExpiry) <= soon7;
    const isROP      = r.reorder_point > 0 && r.quantity_remaining <= r.reorder_point;
    const vialHtml   = r.opened_at ? _vialClock(r) : '<span style="color:var(--text-muted);font-size:11px">Not opened</span>';
    const expiryColor = isExpired ? 'var(--red)' : isSoon ? 'var(--orange)' : 'var(--green-mid)';
    return `<tr>
      <td style="font-weight:500">${_esc(r.reagent_name)}${r.test_name ? `<br><span style="font-size:10px;color:var(--text-muted)">${_esc(r.test_name)}</span>` : ''}</td>
      <td style="font-size:11px">${_esc(r.manufacturer||'—')}</td>
      <td><code style="font-size:11px">${_esc(r.lot_number)}</code></td>
      <td style="font-size:12px;color:${new Date(r.manufacturer_expiry)<now?'var(--red)':'inherit'}">${_fmtDate(r.manufacturer_expiry)}</td>
      <td>${vialHtml}</td>
      <td style="font-size:12px;font-weight:500;color:${expiryColor}">${effExpiry ? _fmtDate(effExpiry.slice?.(0,10)||effExpiry) : '—'}${isExpired?' ⚠':isSoon?' ⚡':''}</td>
      <td style="text-align:right;font-weight:600">${r.quantity_remaining} <span style="font-size:10px;font-weight:400;color:var(--text-muted)">${_esc(r.quantity_unit)}</span>
        ${isROP ? '<br><span style="font-size:10px;color:var(--orange);font-weight:700">⚡ ROP Alert</span>' : ''}
      </td>
      <td style="text-align:center;font-size:11px;color:var(--text-muted)">${r.reorder_point||'—'}</td>
      <td style="font-size:11px">${_esc(r.lab_instruments?.name||'—')}</td>
      <td><span class="badge b-${r.status}">${_esc(r.status.replace(/_/g,' '))}</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-outline btn-sm" data-onclick="openReagentUpdateModal" data-onclick-a0="${r.id}">Update</button>
        ${isROP ? `<button class="btn btn-gold btn-sm" data-onclick="raisePRFromROP" data-onclick-a0="${r.id}" data-onclick-a1="${_esc(r.reagent_name)}">Raise PR</button>` : ''}
      </td>
    </tr>`;
  }).join('');
};

function _effectiveExpiry(r) {
  if (!r.manufacturer_expiry) return null;
  if (!r.vial_expires_at)     return r.manufacturer_expiry + 'T23:59:59';
  const mfrDate  = new Date(r.manufacturer_expiry + 'T23:59:59');
  const vialDate = new Date(r.vial_expires_at);
  return (vialDate < mfrDate ? r.vial_expires_at : r.manufacturer_expiry + 'T23:59:59');
}

function _vialClock(r) {
  const exp = r.vial_expires_at ? new Date(r.vial_expires_at) : null;
  if (!exp) return '<span style="font-size:11px;color:var(--text-muted)">Open (no expiry set)</span>';
  const diffMs  = exp - new Date();
  const diffHrs = Math.round(diffMs / 3600000);
  if (diffMs < 0) return '<span style="font-size:11px;font-weight:600;color:var(--red)">⚠ VIAL EXPIRED</span>';
  if (diffHrs < 4)  return `<span style="font-size:11px;font-weight:600;color:var(--red)">⏰ ${diffHrs}h left</span>`;
  if (diffHrs < 24) return `<span style="font-size:11px;color:var(--orange)">⏰ ${diffHrs}h left</span>`;
  const days = Math.round(diffHrs/24);
  return `<span style="font-size:11px;color:var(--green-mid)">⏱ ${days}d left</span>`;
}

function updateReagentKPIs() {
  const now = new Date();
  const soon7 = new Date(); soon7.setDate(soon7.getDate() + 7);
  document.getElementById('rk-total').textContent  = _reagents.length;
  document.getElementById('rk-inuse').textContent  = _reagents.filter(r => r.status === 'in_use').length;
  document.getElementById('rk-soon').textContent   = _reagents.filter(r => {
    const e = _effectiveExpiry(r); return e && new Date(e) > now && new Date(e) <= soon7;
  }).length;
  document.getElementById('rk-expired').textContent= _reagents.filter(r => {
    const e = _effectiveExpiry(r); return e && new Date(e) < now;
  }).length;
  document.getElementById('rk-rop').textContent    = _reagents.filter(r =>
    r.reorder_point > 0 && r.quantity_remaining <= r.reorder_point).length;
}

window.exportReagentCSV = function() {
  if (!_reagents.length) { _toast('No data', 'error'); return; }
  const headers = ['Reagent','Manufacturer','Lot#','MfrExpiry','OpenedAt','VialExpiresAt','QtyRemaining','Unit','ROP','Instrument','Test','Status'];
  const rows = _reagents.map(r => [
    r.reagent_name, r.manufacturer||'', r.lot_number, r.manufacturer_expiry,
    r.opened_at||'', r.vial_expires_at||'', r.quantity_remaining, r.quantity_unit,
    r.reorder_point||'', r.lab_instruments?.name||'', r.test_name||'', r.status,
  ]);
  const csv = [headers, ...rows].map(r => r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `reagent_batches_${today}.csv`; a.click();
};

// Reagent modal (add)
window.openReagentModal = function(id) {
  _editingReagentId = id || null;
  document.getElementById('rgm-title').textContent = id ? 'Edit Reagent Batch' : 'Add Reagent Batch';
  const r = id ? _reagents.find(x => x.id === id) : null;
  document.getElementById('rgm-name').value      = r?.reagent_name || '';
  document.getElementById('rgm-mfr').value       = r?.manufacturer || '';
  document.getElementById('rgm-lot').value       = r?.lot_number || '';
  document.getElementById('rgm-mfg-date').value  = r?.manufacturing_date || '';
  document.getElementById('rgm-expiry').value    = r?.manufacturer_expiry || '';
  document.getElementById('rgm-stability').value = r?.open_vial_stability_hours || 168;
  document.getElementById('rgm-storage').value   = r?.storage_temp || '';
  document.getElementById('rgm-qty-recv').value  = r?.quantity_received || '';
  document.getElementById('rgm-qty-rem').value   = r?.quantity_remaining || '';
  document.getElementById('rgm-unit').value      = r?.quantity_unit || 'mL';
  document.getElementById('rgm-rop').value       = r?.reorder_point || '';
  document.getElementById('rgm-instrument').value= r?.instrument_id || '';
  document.getElementById('rgm-test').value      = r?.test_name || '';
  document.getElementById('rgm-notes').value     = r?.notes || '';
  // Populate instrument select
  document.getElementById('rgm-instrument').innerHTML =
    '<option value="">— None —</option>' +
    _instruments.map(i => `<option value="${i.id}"${r?.instrument_id===i.id?' selected':''}>${_esc(i.name)}</option>`).join('');
  document.getElementById('reagent-modal').classList.add('show');
};
window.closeReagentModal = function() { document.getElementById('reagent-modal').classList.remove('show'); };

window.saveReagent = async function() {
  const name   = document.getElementById('rgm-name').value.trim();
  const lot    = document.getElementById('rgm-lot').value.trim();
  const expiry = document.getElementById('rgm-expiry').value;
  const qtyR   = parseFloat(document.getElementById('rgm-qty-recv').value);
  const qtyRem = parseFloat(document.getElementById('rgm-qty-rem').value);
  if (!name)   { _toast('Reagent name is required', 'error'); return; }
  if (!lot)    { _toast('Lot number is required', 'error'); return; }
  if (!expiry) { _toast('Manufacturer expiry is required', 'error'); return; }
  const payload = {
    tenant_id: tenantId, reagent_name: name, lot_number: lot,
    manufacturer: document.getElementById('rgm-mfr').value.trim() || null,
    manufacturing_date: document.getElementById('rgm-mfg-date').value || null,
    manufacturer_expiry: expiry,
    open_vial_stability_hours: parseInt(document.getElementById('rgm-stability').value) || 168,
    storage_temp: document.getElementById('rgm-storage').value || null,
    quantity_received: isNaN(qtyR) ? 0 : qtyR,
    quantity_remaining: isNaN(qtyRem) ? 0 : qtyRem,
    quantity_unit: document.getElementById('rgm-unit').value,
    reorder_point: parseFloat(document.getElementById('rgm-rop').value) || null,
    instrument_id: document.getElementById('rgm-instrument').value || null,
    test_name: document.getElementById('rgm-test').value.trim() || null,
    notes: document.getElementById('rgm-notes').value.trim() || null,
  };
  let error;
  if (_editingReagentId) {
    ({ error } = await supabase.from('reagent_batches').update(payload).eq('id', _editingReagentId));
  } else {
    ({ error } = await supabase.from('reagent_batches').insert(payload));
  }
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast(_editingReagentId ? 'Batch updated' : 'Batch added', 'success');
  closeReagentModal();
  loadReagents();
};

// Update quantity / open vial modal
window.openReagentUpdateModal = function(id) {
  _updatingReagentId = id;
  const r = _reagents.find(x => x.id === id);
  if (!r) return;
  _updatingReagentStability = r.open_vial_stability_hours || 168;
  document.getElementById('rum-title').textContent = `Update — ${r.reagent_name}`;
  document.getElementById('rum-qty').value        = r.quantity_remaining;
  document.getElementById('rum-status').value     = r.status;
  document.getElementById('rum-notes').value      = '';
  const openedAt = r.opened_at
    ? new Date(r.opened_at).toISOString().slice(0,16)
    : new Date().toISOString().slice(0,16);
  document.getElementById('rum-opened-at').value  = openedAt;
  _toggleVialSection();
  _calcVialExpiry();
  document.getElementById('reagent-update-modal').classList.add('show');
};
window.closeReagentUpdateModal = function() { document.getElementById('reagent-update-modal').classList.remove('show'); _updatingReagentId = null; };

window._toggleVialSection = function() {
  const status = document.getElementById('rum-status').value;
  const isOpen = status === 'in_use';
  document.getElementById('rum-opened-field').style.display = isOpen ? '' : 'none';
  document.getElementById('rum-vial-section').style.display = isOpen ? '' : 'none';
};

window._calcVialExpiry = function() {
  const openedAt = document.getElementById('rum-opened-at').value;
  if (!openedAt) return;
  const exp = new Date(openedAt);
  exp.setHours(exp.getHours() + _updatingReagentStability);
  document.getElementById('rum-vial-expires').textContent =
    exp.toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
};

window.saveReagentUpdate = async function() {
  const status  = document.getElementById('rum-status').value;
  const qty     = parseFloat(document.getElementById('rum-qty').value);
  const payload = { status, quantity_remaining: isNaN(qty) ? 0 : qty };
  if (status === 'in_use') {
    const openedAt = document.getElementById('rum-opened-at').value;
    if (!openedAt) { _toast('Set the opened-at time', 'error'); return; }
    const openedDt  = new Date(openedAt);
    const expiresAt = new Date(openedDt.getTime() + _updatingReagentStability * 3600000);
    payload.opened_at      = openedDt.toISOString();
    payload.vial_expires_at= expiresAt.toISOString();
  }
  const { error } = await supabase.from('reagent_batches').update(payload).eq('id', _updatingReagentId);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Reagent updated', 'success');
  closeReagentUpdateModal();
  loadReagents();
};

window.raisePRFromROP = function(reagentId, reagentName) {
  document.getElementById('prm-type').value  = 'reagent';
  document.getElementById('prm-item').value  = reagentName;
  document.getElementById('prm-urgency').value = 'urgent';
  document.getElementById('prm-qty').value   = '';
  document.getElementById('prm-unit').value  = '';
  document.getElementById('prm-spec').value  = '';
  document.getElementById('prm-supplier').value = '';
  document.getElementById('prm-notes').value = `Auto-raised: Reagent "${reagentName}" has reached reorder point.`;
  document.getElementById('pr-modal').classList.add('show');
};

// ══════════════════════════════════════════════════════
// PURCHASE REQUISITIONS (Tab 5)
// ══════════════════════════════════════════════════════
async function loadRequisitions() {
  const { data, error } = await supabase
    .from('purchase_requisitions')
    .select('*, requester:profiles!requested_by(full_name), approver:profiles!approved_by(full_name)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _requisitions = data || [];
  renderPRs();
  updatePRKPIs();
}

window.renderPRs = function() {
  const statusF  = document.getElementById('pr-filter').value;
  const urgencyF = document.getElementById('pr-urgency').value;
  const isAdmin  = ['super_admin','dept_admin'].includes(sess.role);

  let rows = _requisitions.filter(r =>
    (!statusF  || r.status === statusF) &&
    (!urgencyF || r.urgency === urgencyF)
  );

  const urgencyColor = { emergency:'var(--red)', urgent:'var(--orange)', routine:'var(--text-muted)' };
  const statusBadge  = s => `<span class="badge b-${s === 'pending'?'warning':s==='approved'?'received':s==='ordered'?'collected':'active'}">${s.charAt(0).toUpperCase()+s.slice(1)}</span>`;

  const tbody = document.getElementById('pr-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No requisitions found.</td></tr>'; return; }

  tbody.innerHTML = rows.map(r => {
    const canApprove = isAdmin && r.status === 'pending';
    const canOrder   = isAdmin && r.status === 'approved';
    const canReceive = isAdmin && r.status === 'ordered';
    return `<tr>
      <td style="font-size:11px;white-space:nowrap">${_fmtDate(r.created_at?.slice(0,10))}</td>
      <td style="font-weight:500">${_esc(r.item_name)}${r.specification?`<br><span style="font-size:10px;color:var(--text-muted)">${_esc(r.specification)}</span>`:''}</td>
      <td style="font-size:11px">${_esc(r.item_type)}</td>
      <td style="text-align:right">${r.quantity} ${_esc(r.unit||'')}</td>
      <td><span style="font-size:11px;font-weight:600;color:${urgencyColor[r.urgency]}">${_esc(r.urgency)}</span></td>
      <td style="font-size:11px">${_esc(r.requester?.full_name||'—')}</td>
      <td>${statusBadge(r.status)}</td>
      <td style="font-size:11px">${r.approved_by ? _esc(r.approver?.full_name || '—') : '—'}<br>
          ${r.approved_at ? `<span style="font-size:10px;color:var(--text-muted)">${_fmtDate(r.approved_at.slice(0,10))}</span>` : ''}
      </td>
      <td style="white-space:nowrap">
        ${canApprove ? `<button class="btn btn-primary btn-sm" data-onclick="updatePRStatus" data-onclick-a0="${r.id}" data-onclick-a1="approved">Approve</button>
                        <button class="btn btn-danger btn-sm" data-onclick="updatePRStatus" data-onclick-a0="${r.id}" data-onclick-a1="cancelled">Cancel</button>` : ''}
        ${canOrder   ? `<button class="btn btn-outline btn-sm" data-onclick="updatePRStatus" data-onclick-a0="${r.id}" data-onclick-a1="ordered">Mark Ordered</button>` : ''}
        ${canReceive ? `<button class="btn btn-primary btn-sm" data-onclick="updatePRStatus" data-onclick-a0="${r.id}" data-onclick-a1="received">Mark Received</button>` : ''}
        ${r.status === 'pending' && r.requested_by === sess.id ? `<button class="btn btn-danger btn-sm" data-onclick="updatePRStatus" data-onclick-a0="${r.id}" data-onclick-a1="cancelled">Cancel</button>` : ''}
      </td>
    </tr>`;
  }).join('');
};

function updatePRKPIs() {
  const thisMonth = today.slice(0,7);
  document.getElementById('prk-pending').textContent   = _requisitions.filter(r => r.status === 'pending').length;
  document.getElementById('prk-approved').textContent  = _requisitions.filter(r => r.status === 'approved').length;
  document.getElementById('prk-ordered').textContent   = _requisitions.filter(r => r.status === 'ordered').length;
  document.getElementById('prk-received').textContent  = _requisitions.filter(r => r.status === 'received' && r.received_date?.startsWith(thisMonth)).length;
  document.getElementById('prk-emergency').textContent = _requisitions.filter(r => r.urgency === 'emergency' && r.status === 'pending').length;
}

window.openPRModal = function() {
  document.getElementById('prm-title').textContent = 'Raise Purchase Requisition';
  ['prm-item','prm-spec','prm-supplier','prm-notes'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('prm-type').value    = 'reagent';
  document.getElementById('prm-urgency').value = 'routine';
  document.getElementById('prm-qty').value     = '1';
  document.getElementById('prm-unit').value    = '';
  document.getElementById('prm-expected').value= '';
  document.getElementById('pr-modal').classList.add('show');
};
window.closePRModal = function() { document.getElementById('pr-modal').classList.remove('show'); };

window.savePR = async function() {
  const item = document.getElementById('prm-item').value.trim();
  const qty  = parseFloat(document.getElementById('prm-qty').value);
  if (!item)    { _toast('Item name is required', 'error'); return; }
  if (isNaN(qty)||qty<=0){ _toast('Valid quantity is required', 'error'); return; }
  const { error } = await supabase.from('purchase_requisitions').insert({
    tenant_id: tenantId, requested_by: sess.id,
    item_type: document.getElementById('prm-type').value,
    item_name: item, quantity: qty,
    unit: document.getElementById('prm-unit').value.trim() || null,
    urgency: document.getElementById('prm-urgency').value,
    specification: document.getElementById('prm-spec').value.trim() || null,
    supplier: document.getElementById('prm-supplier').value.trim() || null,
    expected_date: document.getElementById('prm-expected').value || null,
    notes: document.getElementById('prm-notes').value.trim() || null,
  });
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('Requisition submitted', 'success');
  closePRModal();
  loadRequisitions();
};

window.updatePRStatus = async function(id, status) {
  const updates = { status };
  if (status === 'approved') {
    updates.approved_by  = sess.id;
    updates.approved_at  = new Date().toISOString();
  }
  if (status === 'ordered')  updates.order_date     = today;
  if (status === 'received') updates.received_date  = today;
  const { error } = await supabase.from('purchase_requisitions').update(updates).eq('id', id);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast(`Requisition marked as ${status}`, 'success');
  loadRequisitions();
};

// ══════════════════════════════════════════════════════
// RESULT AUTHORIZATION (Tab 6)
// ══════════════════════════════════════════════════════
window.loadAuthorization = async function() {
  const authFilter = document.getElementById('auth-filter').value;
  const dateFilter = document.getElementById('auth-date').value;

  let q = supabase.from('lab_order_items')
    .select(`
      id, test_name, result_value, result_unit, is_critical, is_abnormal,
      authorisation_status, previous_result, previous_result_date,
      tech:profiles!entered_by(full_name),
      lab_orders!inner(
        id, created_at, tenant_id,
        visits(patients(id, name, age, gender))
      )
    `)
    .eq('lab_orders.tenant_id', tenantId);

  if (authFilter) q = q.eq('authorisation_status', authFilter);
  if (dateFilter) q = q.gte('lab_orders.created_at', dateFilter + 'T00:00:00')
                       .lte('lab_orders.created_at', dateFilter + 'T23:59:59');

  const { data, error } = await q.order('created_at', { foreignTable: 'lab_orders', ascending: false }).limit(200);
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _authItems = data || [];
  renderAuthTable();
  updateAuthKPIs();
  document.getElementById('auth-info-banner').style.display = '';
};

function renderAuthTable() {
  const tbody = document.getElementById('auth-tbody');
  if (!_authItems.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No results found.</td></tr>'; return; }

  tbody.innerHTML = _authItems.map(item => {
    const order  = item.lab_orders;
    const pat    = order?.visits?.patients;
    const tech   = item.tech;
    const isPending = item.authorisation_status === 'tech_verified';
    const isSigned  = item.authorisation_status === 'pathologist_signed';
    const flagHtml  = item.is_critical
      ? '<span style="color:var(--red);font-weight:700">⚠ CRITICAL</span>'
      : item.is_abnormal
        ? '<span style="color:var(--gold);font-weight:600">Abnormal</span>'
        : '<span style="color:var(--green-mid)">Normal</span>';
    const deltaHtml = item.previous_result
      ? `<span style="font-size:11px">${_esc(item.previous_result)}${item.previous_result_date ? ` (${_fmtDate(item.previous_result_date)})` : ''}</span>`
      : '<span style="color:var(--text-muted);font-size:11px">—</span>';
    const authBadge = isPending
      ? '<span class="badge b-warning">Tech Verified</span>'
      : isSigned
        ? '<span class="badge b-received">Signed ✓</span>'
        : '<span class="badge b-collected">Pending</span>';
    return `<tr style="${item.is_critical ? 'background:#fff8f8' : ''}">
      <td style="font-weight:500">${_esc(pat?.name||'—')}<br>
          <span style="font-size:10px;color:var(--text-muted)">${pat?.age||''}y ${_esc(pat?.gender||'')}</span></td>
      <td style="font-weight:500">${_esc(item.test_name)}</td>
      <td style="font-size:13px;font-weight:600;color:${item.is_critical?'var(--red)':item.is_abnormal?'var(--gold)':'inherit'}">${_esc(item.result_value||'—')}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_esc(item.result_unit||'')}</td>
      <td>${flagHtml}</td>
      <td>${deltaHtml}</td>
      <td style="font-size:11px;color:var(--text-muted)">${_esc(tech?.full_name||'—')}<br>${_fmtDate(order?.created_at?.slice(0,10))}</td>
      <td>${authBadge}</td>
      <td>
        ${isPending ? `<button class="btn btn-primary btn-sm" data-onclick="signOffResult" data-onclick-a0="${item.id}">Sign Off</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function updateAuthKPIs() {
  const todayItems = _authItems.filter(i => i.lab_orders?.created_at?.startsWith(today));
  const thisMonth  = today.slice(0,7);
  document.getElementById('ak-pending').textContent  = _authItems.filter(i => i.authorisation_status === 'tech_verified').length;
  document.getElementById('ak-critical').textContent = _authItems.filter(i => i.is_critical && i.authorisation_status === 'tech_verified').length;
  document.getElementById('ak-signed').textContent   = _authItems.filter(i => i.authorisation_status === 'pathologist_signed' && i.lab_orders?.created_at?.startsWith(today)).length;
  document.getElementById('ak-month').textContent    = _authItems.filter(i => i.lab_orders?.created_at?.startsWith(thisMonth)).length;
}

window.signOffResult = async function(itemId) {
  const { error } = await supabase.from('lab_order_items').update({
    authorisation_status: 'pathologist_signed',
  }).eq('id', itemId);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }

  // Also update the parent order's authorised_at if not already set
  const item = _authItems.find(i => i.id === itemId);
  if (item?.lab_orders?.id) {
    await supabase.from('lab_orders').update({
      authorised_at: new Date().toISOString(), authorised_by: sess.id,
    }).eq('id', item.lab_orders.id).is('authorised_at', null);
  }

  _toast('Result signed off ✓', 'success');
  loadAuthorization();
};

// ══════════════════════════════════════════════════════
// NC/CAPA LOG (Tab 7) — ISO 15189 §8.7
// ══════════════════════════════════════════════════════
async function loadNC() {
  const { data, error } = await supabase
    .from('lab_nc_reports')
    .select('*, profiles!detected_by(full_name), lab_instruments!related_instrument_id(name)')
    .eq('tenant_id', tenantId)
    .order('nc_date', { ascending: false });
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _ncReports = data || [];
  renderNC();
  updateNCKPIs();
}

window.renderNC = function() {
  const statusF = document.getElementById('nc-filter-status').value;
  const sevF    = document.getElementById('nc-filter-sev').value;
  let rows = _ncReports.filter(r =>
    (!statusF || r.status === statusF) &&
    (!sevF    || r.severity === sevF)
  );
  const sevColor = { critical:'var(--red)', major:'var(--orange)', minor:'var(--text-muted)' };
  const ncTypeLabel = {
    qc_failure:'QC Failure', sample_rejection:'Sample Rejection', equipment_fault:'Equipment Fault',
    reagent_issue:'Reagent Issue', result_error:'Result Error',
    external_audit:'External Audit', other:'Other',
  };
  const tbody = document.getElementById('nc-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No NC reports found.</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `<tr>
    <td style="font-size:11px;white-space:nowrap">${_fmtDate(r.nc_date)}</td>
    <td style="font-size:11px">${ncTypeLabel[r.nc_type]||r.nc_type}</td>
    <td><span style="font-size:11px;font-weight:700;color:${sevColor[r.severity]}">${r.severity.toUpperCase()}</span></td>
    <td style="max-width:180px;font-size:11px">${_esc(r.description)}</td>
    <td style="max-width:130px;font-size:11px;color:var(--text-muted)">${_esc(r.immediate_action||'—')}</td>
    <td style="max-width:130px;font-size:11px;color:var(--text-muted)">${_esc(r.root_cause_analysis||'—')}</td>
    <td><span class="badge ${r.status==='open'?'b-rejected':r.status==='under_review'?'b-warning':'b-received'}">${_esc(r.status.replace(/_/g,' '))}</span></td>
    <td style="font-size:11px">${_esc(r.profiles?.full_name||'—')}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-outline btn-sm" data-onclick="openNCModal" data-onclick-a0="${r.id}">Edit</button>
      ${r.status!=='closed'?`<button class="btn btn-primary btn-sm" data-onclick="closeNC" data-onclick-a0="${r.id}">Close</button>`:''}
    </td>
  </tr>`).join('');
};

function updateNCKPIs() {
  const thisMonth = today.slice(0,7);
  document.getElementById('nck-open').textContent    = _ncReports.filter(r => r.status==='open').length;
  document.getElementById('nck-review').textContent  = _ncReports.filter(r => r.status==='under_review').length;
  document.getElementById('nck-closed').textContent  = _ncReports.filter(r => r.status==='closed' && r.closed_at?.startsWith(thisMonth)).length;
  document.getElementById('nck-critical').textContent= _ncReports.filter(r => r.severity==='critical').length;
  document.getElementById('nck-total').textContent   = _ncReports.length;
}

window.openNCModal = function(id) {
  _editingNCId = id || null;
  document.getElementById('ncm-title').textContent = id ? 'Edit NC Report' : 'Raise Non-Conformance Report';
  const r = id ? _ncReports.find(x => x.id===id) : null;
  document.getElementById('ncm-date').value       = r?.nc_date || today;
  document.getElementById('ncm-type').value       = r?.nc_type || 'qc_failure';
  document.getElementById('ncm-severity').value   = r?.severity || 'minor';
  document.getElementById('ncm-status').value     = r?.status || 'open';
  document.getElementById('ncm-desc').value       = r?.description || '';
  document.getElementById('ncm-immediate').value  = r?.immediate_action || '';
  document.getElementById('ncm-root').value       = r?.root_cause_analysis || '';
  document.getElementById('ncm-corrective').value = r?.corrective_action || '';
  document.getElementById('ncm-preventive').value = r?.preventive_action || '';
  document.getElementById('ncm-instrument').innerHTML = '<option value="">— None —</option>' +
    _instruments.map(i=>`<option value="${i.id}"${r?.related_instrument_id===i.id?' selected':''}>${_esc(i.name)}</option>`).join('');
  document.getElementById('ncm-qc-run').innerHTML = '<option value="">— None —</option>' +
    _qcRuns.slice(0,30).map(q=>`<option value="${q.id}"${r?.related_qc_run_id===q.id?' selected':''}>${_fmtDate(q.run_date)} · ${_esc(q.test_name)} · ${_esc(q.control_level)}</option>`).join('');
  document.getElementById('nc-modal').classList.add('show');
};
window.closeNCModal = function() { document.getElementById('nc-modal').classList.remove('show'); _editingNCId=null; };

window.saveNC = async function() {
  const desc = document.getElementById('ncm-desc').value.trim();
  const date = document.getElementById('ncm-date').value;
  if (!desc||!date) { _toast('Date and description are required','error'); return; }
  const status = document.getElementById('ncm-status').value;
  const payload = {
    tenant_id: tenantId, detected_by: sess.id, nc_date: date,
    nc_type:   document.getElementById('ncm-type').value,
    severity:  document.getElementById('ncm-severity').value,
    status, description: desc,
    immediate_action:    document.getElementById('ncm-immediate').value.trim()||null,
    root_cause_analysis: document.getElementById('ncm-root').value.trim()||null,
    corrective_action:   document.getElementById('ncm-corrective').value.trim()||null,
    preventive_action:   document.getElementById('ncm-preventive').value.trim()||null,
    related_qc_run_id:   document.getElementById('ncm-qc-run').value||null,
    related_instrument_id: document.getElementById('ncm-instrument').value||null,
    closed_at: status==='closed' ? new Date().toISOString() : null,
  };
  let error;
  if (_editingNCId) ({ error } = await supabase.from('lab_nc_reports').update(payload).eq('id',_editingNCId));
  else             ({ error } = await supabase.from('lab_nc_reports').insert(payload));
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast(_editingNCId?'NC updated':'NC raised','success');
  closeNCModal(); loadNC();
};

window.closeNC = async function(id) {
  const { error } = await supabase.from('lab_nc_reports').update({
    status:'closed', closed_at: new Date().toISOString(), reviewed_by: sess.id,
  }).eq('id',id);
  if (error) { _toast(safeErrorMessage(error), 'error'); return; }
  _toast('NC closed','success'); loadNC();
};

window.exportNCCSV = function() {
  if (!_ncReports.length) { _toast('No data','error'); return; }
  const rows = _ncReports.map(r => ({
    Date:r.nc_date, Type:r.nc_type, Severity:r.severity, Status:r.status,
    Description:r.description, ImmediateAction:r.immediate_action||'',
    RootCause:r.root_cause_analysis||'', CorrectiveAction:r.corrective_action||'',
    PreventiveAction:r.preventive_action||'', DetectedBy:r.profiles?.full_name||'', ClosedAt:r.closed_at||'',
  }));
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','), ...rows.map(r=>keys.map(k=>`"${String(r[k]).replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `nc_capa_register_${today}.csv`; a.click();
};

// ══════════════════════════════════════════════════════
// AUDIT TRAIL (Tab 8) — ISO 15189 §8.3
// ══════════════════════════════════════════════════════
function initAuditLog() {
  if (!document.getElementById('aul-from').value) {
    document.getElementById('aul-from').value = today;
    document.getElementById('aul-to').value   = today;
  }
  loadAuditLog();
}

window.loadAuditLog = async function() {
  const from  = document.getElementById('aul-from').value;
  const to    = document.getElementById('aul-to').value;
  const table = document.getElementById('aul-table').value;
  if (!from||!to) return;

  let q = supabase.from('nabl_audit_trail')
    .select('*').eq('tenant_id',tenantId)
    .gte('performed_at', from+'T00:00:00')
    .lte('performed_at', to  +'T23:59:59')
    .order('performed_at',{ascending:false}).limit(300);
  if (table) q = q.eq('table_name',table);

  const { data, error } = await q;
  if (error) { _toast(safeErrorMessage(error, 'Load error. Please try again.'), 'error'); return; }
  _auditEntries = data||[];
  renderAuditTable();
  updateAuditKPIs();
};

function renderAuditTable() {
  const tbody = document.getElementById('audit-tbody');
  if (!_auditEntries.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No audit entries found for this period. Entries are created automatically when lab results, QC runs or instruments are edited.</td></tr>'; return; }
  tbody.innerHTML = _auditEntries.map(e => {
    const ts = new Date(e.performed_at).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const changes = _diffJsonKeys(e.old_value, e.new_value);
    const tableColor = {lab_order_items:'var(--gold)',lab_qc_runs:'#1565c0',lab_instruments:'var(--green-mid)'}[e.table_name]||'var(--text-muted)';
    return `<tr>
      <td style="font-size:11px;white-space:nowrap;color:var(--text-muted)">${ts}</td>
      <td><span style="font-size:11px;font-weight:600;color:${tableColor}">${_tableLabel(e.table_name)}</span></td>
      <td style="font-family:monospace;font-size:10px;color:var(--text-muted)">${(e.record_id||'').slice(0,8)}…</td>
      <td><span class="badge b-received" style="font-size:10px">${e.action}</span></td>
      <td style="font-size:11px">${e.actor_id?e.actor_id.slice(0,8)+'…':'<span style="color:var(--text-muted)">System</span>'}</td>
      <td style="font-size:11px;max-width:280px;line-height:1.7">${changes||'<span style="color:var(--text-muted)">—</span>'}</td>
    </tr>`;
  }).join('');
}

function updateAuditKPIs() {
  document.getElementById('auk-total').textContent   = _auditEntries.length;
  document.getElementById('auk-today').textContent   = _auditEntries.filter(e=>e.performed_at?.startsWith(today)).length;
  document.getElementById('auk-results').textContent = _auditEntries.filter(e=>e.table_name==='lab_order_items').length;
  document.getElementById('auk-qc').textContent      = _auditEntries.filter(e=>e.table_name==='lab_qc_runs').length;
  document.getElementById('auk-equip').textContent   = _auditEntries.filter(e=>e.table_name==='lab_instruments').length;
}

function _diffJsonKeys(oldVal, newVal) {
  if (!oldVal||!newVal) return '';
  const keys = ['result_value','result_unit','is_critical','is_abnormal','authorisation_status',
    'observed_value','status','calibration_due_date','last_calibration_date','westgard_violations'];
  return keys.filter(k => JSON.stringify(oldVal[k])!==JSON.stringify(newVal[k]))
    .map(k => `<span style="color:var(--text-mid)">${_esc(k)}:</span> <span style="color:var(--red);text-decoration:line-through">${_esc(oldVal[k]??'—')}</span> → <span style="color:var(--green-mid)">${_esc(newVal[k]??'—')}</span>`)
    .join('<br/>');
}

function _tableLabel(t) {
  return {lab_order_items:'Lab Results',lab_qc_runs:'QC Runs',lab_instruments:'Instruments'}[t]||t;
}
