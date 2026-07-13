import { requireAuth, getCurrentProfile } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { logAudit } from '../core/auditLogger.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { NCISM_DEPTS } from '../config/ncism.js';

await requireAuth(['platform_admin','super_admin','dept_admin'], 'login.html');
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();

// Gate: is_platform_admin
if (!profile?.is_platform_admin) {
  document.getElementById('access-denied').style.display = '';
} else {
  document.getElementById('main-page').style.display = '';
  init();
}

window.showSubtab = function(tab) {
  document.querySelectorAll('.subtab').forEach(b => b.classList.remove('active'));
  document.getElementById(`subtab-${tab}`)?.classList.add('active');
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`pane-${tab}`)?.classList.add('active');
  if (tab === 'ncism')   loadNcismRequests();
  if (tab === 'pricing') loadPricing();
};

const PLAN_LABEL   = { trial:'Free Trial', starter:'Starter', growth:'Growth', enterprise:'Enterprise' };
const STATUS_LABEL = { trial:'Trial', active:'Active', expiring:'Expiring', expired:'Expired', suspended:'Suspended', grace:'Grace' };

let _tenants = [];

async function init() {
  const { data } = await supabase
    .from('tenants')
    .select('id, name, type, tenant_code, is_active, plan_type, subscription_status, max_users, subscription_expiry, trial_ends_at')
    .order('name');

  _tenants = (data || []).map(t => {
    const today    = new Date();
    const endDate  = t.subscription_expiry ? new Date(t.subscription_expiry) : (t.trial_ends_at ? new Date(t.trial_ends_at) : null);
    const daysLeft = endDate ? Math.ceil((endDate - today) / 86400000) : null;
    const effStatus = t.subscription_status || 'trial';
    const status = (effStatus === 'active' || effStatus === 'trial') && daysLeft !== null && daysLeft <= 30 && daysLeft > 0
      ? 'expiring' : effStatus;
    return { ...t, plan_type: t.plan_type||'trial', subscription_status: status, daysLeft, endDate };
  });

  renderStats();
  renderTable();
}

function renderStats() {
  document.getElementById('ps-total').textContent    = _tenants.length;
  document.getElementById('ps-trial').textContent    = _tenants.filter(t=>t.subscription_status==='trial').length;
  document.getElementById('ps-active').textContent   = _tenants.filter(t=>t.subscription_status==='active').length;
  document.getElementById('ps-expiring').textContent = _tenants.filter(t=>t.subscription_status==='expiring').length;
  document.getElementById('ps-expired').textContent  = _tenants.filter(t=>t.subscription_status==='expired').length;
}

window.renderTable = function() {
  const name   = document.getElementById('f-name').value.toLowerCase();
  const status = document.getElementById('f-status').value;
  const plan   = document.getElementById('f-plan').value;

  const filtered = _tenants.filter(t =>
    (!name   || t.name.toLowerCase().includes(name)) &&
    (!status || t.subscription_status === status) &&
    (!plan   || t.plan_type === plan)
  );

  const tbody = document.getElementById('tenants-body');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><div class="empty-ico">🏥</div>No tenants match filters</div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(t => {
    const pCls = `chip plan-${t.plan_type}`;
    const sCls = `chip status-${t.subscription_status}`;
    const max  = t.max_users || 5;
    return `<tr>
      <td><strong>${_esc(t.name)}</strong>${!t.is_active?'<br><span style="font-size:11px;color:var(--text-muted)">Inactive</span>':''}</td>
      <td style="font-family:monospace;font-size:12px;color:var(--text-muted)">${_esc(t.tenant_code||'—')}</td>
      <td style="font-size:12px;color:var(--text-muted)">${_esc((t.type||'').replace(/_/g,' '))}</td>
      <td><span class="${pCls}">${_esc(PLAN_LABEL[t.plan_type]||t.plan_type)}</span></td>
      <td><span class="${sCls}">${_esc(STATUS_LABEL[t.subscription_status]||t.subscription_status)}${t.daysLeft!==null&&t.daysLeft<=30&&t.daysLeft>0?` · ${t.daysLeft}d`:''}</span></td>
      <td style="font-size:12px">${t.endDate?t.endDate.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})+'<br><span style="color:var(--text-muted)">'+(t.subscription_expiry?'Paid expiry':'Trial end')+'</span>':'<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="min-width:120px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:3px">— / ${max===999?'∞':max}</div>
        <div class="progress-wrap"><div class="progress-bar" style="width:0%"></div></div>
      </td>
      <td>
        <button class="btn btn-outline" data-onclick="openEdit" data-onclick-a0="${t.id}">✏ Edit</button>
      </td>
    </tr>`;
  }).join('');
};

window.openEdit = function(tenantId) {
  const t = _tenants.find(t => t.id === tenantId);
  if (!t) return;
  document.getElementById('e-tenant-id').value         = t.id;
  document.getElementById('e-tenant-name').textContent = t.name + (t.tenant_code ? ` · ${t.tenant_code}` : '');
  document.getElementById('e-plan').value               = t.plan_type || 'trial';
  document.getElementById('e-status').value             = t.subscription_status === 'expiring' ? 'active' : (t.subscription_status || 'trial');
  document.getElementById('e-max-users').value          = t.max_users || 5;
  document.getElementById('e-expiry').value             = t.subscription_expiry || '';
  document.getElementById('e-trial-ends').value         = t.trial_ends_at || '';
  document.getElementById('edit-modal').classList.add('open');
};

window.closeModal = function() {
  document.getElementById('edit-modal').classList.remove('open');
};

window.saveSubscription = async function() {
  const tenantId  = document.getElementById('e-tenant-id').value;
  const planType  = document.getElementById('e-plan').value;
  const status    = document.getElementById('e-status').value;
  const maxUsers  = parseInt(document.getElementById('e-max-users').value) || 5;
  const expiry    = document.getElementById('e-expiry').value    || null;
  const trialEnds = document.getElementById('e-trial-ends').value || null;

  const { error } = await supabase.rpc('platform_update_subscription', {
    p_tenant_id:   tenantId,
    p_plan_type:   planType,
    p_status:      status,
    p_max_users:   maxUsers,
    p_expiry:      expiry,
    p_trial_ends:  trialEnds,
  });

  if (error) { _toast('❌ ' + safeErrorMessage(error, 'Could not update subscription.')); return; }
  _toast('✅ Subscription updated');
  closeModal();
  await init();
};

// ════════════════════════════════════════════════
// NCISM CAPACITY REQUESTS
// ════════════════════════════════════════════════
let _ncismRequestsById = {};

async function loadNcismRequests() {
  const body = document.getElementById('ncism-requests-body');
  body.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading…</td></tr>`;

  const { data, error } = await supabase
    .from('ncism_subscription_requests')
    .select('id, tenant_id, requested_ug_intake, requested_pg, computed_fee, requested_at, tenants(name, tenant_code, ug_intake, pg_student_strength)')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });

  if (error) { body.innerHTML = `<tr><td colspan="6" style="color:var(--red)">${_esc(safeErrorMessage(error, 'Could not load requests.'))}</td></tr>`; return; }

  _ncismRequestsById = {};
  (data || []).forEach(r => { _ncismRequestsById[r.id] = r; });

  if (!data?.length) {
    body.innerHTML = `<tr><td colspan="6"><div class="empty"><div class="empty-ico">🎓</div>No pending NCISM capacity requests</div></td></tr>`;
    return;
  }

  body.innerHTML = data.map(r => {
    const t = r.tenants || {};
    const pgLines = (r.requested_pg || []).map(p => {
      const name = NCISM_DEPTS.find(d => d.ncism_code === p.code)?.name || p.code;
      return `${_esc(name)} (+${p.seats})`;
    }).join(', ') || '—';
    return `<tr>
      <td><strong>${_esc(t.name)}</strong><br><span style="font-size:11px;color:var(--text-muted);font-family:monospace">${_esc(t.tenant_code||'')}</span></td>
      <td>${t.ug_intake ?? '—'} → <strong>${r.requested_ug_intake}</strong></td>
      <td style="max-width:220px">${pgLines}</td>
      <td>₹${Number(r.computed_fee).toLocaleString('en-IN')}</td>
      <td style="font-size:12px">${new Date(r.requested_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</td>
      <td>
        <button class="btn btn-primary" data-onclick="approveNcismRequest" data-onclick-a0="${r.id}">✓ Approve</button>
        <button class="btn btn-danger" data-onclick="rejectNcismRequest" data-onclick-a0="${r.id}">✗ Reject</button>
      </td>
    </tr>`;
  }).join('');
}

// audit_logs' RLS only allows inserting rows scoped to the caller's OWN tenant_id
// (confirmed against the live policy — platform_update_subscription's caller has
// the same constraint and doesn't even attempt to log cross-tenant). Logging under
// the platform_admin's own tenant with the target tenant_id recorded in the
// payload is the closest thing to a real audit trail this schema currently allows.
window.approveNcismRequest = async function(requestId) {
  if (!confirm('Approve this capacity request? This will seed/upgrade the tenant’s OPDs, departments and beds immediately.')) return;
  const req = _ncismRequestsById[requestId];
  const { error } = await supabase.rpc('platform_approve_ncism_request', {
    p_request_id: requestId, p_approve: true, p_notes: null,
  });
  if (error) { _toast('❌ ' + safeErrorMessage(error, 'Could not approve request.')); return; }
  await logAudit('ncism_subscription_approved', 'tenants', req?.tenant_id || null,
    { target_tenant_id: req?.tenant_id, requested_ug_intake: req?.requested_ug_intake, requested_pg: req?.requested_pg },
    { tenantId: profile.tenant_id, userId: profile.id, userName: profile.full_name });
  _toast('✅ Request approved and applied');
  loadNcismRequests();
};

window.rejectNcismRequest = async function(requestId) {
  const notes = prompt('Reason for rejection (optional):') || null;
  const req = _ncismRequestsById[requestId];
  const { error } = await supabase.rpc('platform_approve_ncism_request', {
    p_request_id: requestId, p_approve: false, p_notes: notes,
  });
  if (error) { _toast('❌ ' + safeErrorMessage(error, 'Could not reject request.')); return; }
  await logAudit('ncism_subscription_rejected', 'tenants', req?.tenant_id || null,
    { target_tenant_id: req?.tenant_id, notes }, { tenantId: profile.tenant_id, userId: profile.id, userName: profile.full_name });
  _toast('Request rejected');
  loadNcismRequests();
};

// ════════════════════════════════════════════════
// NCISM PRICING (intake tiers + PG seat fee)
// ════════════════════════════════════════════════
let _tiers = [];

async function loadPricing() {
  const [{ data: tiers, error: tiersErr }, { data: pgFee }] = await Promise.all([
    supabase.from('ncism_intake_tiers').select('*').order('sort_order'),
    supabase.from('ncism_pg_seat_fee').select('fee').eq('id', 1).single(),
  ]);

  document.getElementById('pg-seat-fee').value = pgFee?.fee ?? 0;

  const body = document.getElementById('tiers-body');
  if (tiersErr) { body.innerHTML = `<tr><td colspan="4" style="color:var(--red)">${_esc(safeErrorMessage(tiersErr, 'Could not load tiers.'))}</td></tr>`; return; }

  _tiers = tiers || [];
  if (!_tiers.length) {
    body.innerHTML = `<tr><td colspan="4"><div class="empty"><div class="empty-ico">💰</div>No intake tiers configured yet</div></td></tr>`;
    return;
  }

  body.innerHTML = _tiers.map(t => `<tr>
    <td>${t.ug_intake}</td>
    <td>₹${Number(t.fee).toLocaleString('en-IN')}</td>
    <td>${t.is_active ? '<span class="chip status-active">Active</span>' : '<span class="chip status-suspended">Inactive</span>'}</td>
    <td>
      <button class="btn btn-outline" data-onclick="openTierForm" data-onclick-a0="${t.id}">✏ Edit</button>
      <button class="btn btn-outline" data-onclick="toggleTierActive" data-onclick-a0="${t.id}" data-onclick-a1="${!t.is_active}">${t.is_active ? 'Deactivate' : 'Activate'}</button>
    </td>
  </tr>`).join('');
}

window.openTierForm = function(tierId) {
  const t = tierId ? _tiers.find(x => x.id === tierId) : null;
  document.getElementById('tier-id').value        = t?.id || '';
  document.getElementById('tier-ug-intake').value  = t?.ug_intake ?? '';
  document.getElementById('tier-fee').value        = t?.fee ?? '';
  document.getElementById('tier-form-wrap').style.display = 'block';
};

window.closeTierForm = function() {
  document.getElementById('tier-form-wrap').style.display = 'none';
};

window.saveTier = async function() {
  const id       = document.getElementById('tier-id').value || null;
  const ugIntake = parseInt(document.getElementById('tier-ug-intake').value);
  const fee      = parseFloat(document.getElementById('tier-fee').value);
  if (!ugIntake || Number.isNaN(fee)) { _toast('Enter a valid UG intake and fee.'); return; }

  const { error } = id
    ? await supabase.from('ncism_intake_tiers').update({ ug_intake: ugIntake, fee, updated_at: new Date().toISOString() }).eq('id', id)
    : await supabase.from('ncism_intake_tiers').insert({ ug_intake: ugIntake, fee, sort_order: _tiers.length });

  if (error) { _toast('❌ ' + safeErrorMessage(error, 'Could not save tier.')); return; }
  _toast('✅ Tier saved');
  closeTierForm();
  loadPricing();
};

window.toggleTierActive = async function(tierId, nextActive) {
  const { error } = await supabase.from('ncism_intake_tiers')
    .update({ is_active: nextActive === 'true' || nextActive === true, updated_at: new Date().toISOString() })
    .eq('id', tierId);
  if (error) { _toast('❌ ' + safeErrorMessage(error, 'Could not update tier.')); return; }
  loadPricing();
};

window.savePgSeatFee = async function() {
  const fee = parseFloat(document.getElementById('pg-seat-fee').value);
  if (Number.isNaN(fee) || fee < 0) { _toast('Enter a valid fee.'); return; }
  const { error } = await supabase.from('ncism_pg_seat_fee').update({ fee, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) { _toast('❌ ' + safeErrorMessage(error, 'Could not save fee.')); return; }
  _toast('✅ PG seat fee updated');
};

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3000); }
