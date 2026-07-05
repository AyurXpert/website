import { requireAuth, getCurrentProfile } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

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

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3000); }
