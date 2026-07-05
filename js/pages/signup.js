import { registerStaff } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { isValidEmail, isValidPhone, validatePassword } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Pre-fill from URL params
// Supports: ?t=CODE (legacy), ?org=CODE&role=ROLE&token=UUID (recruitment join link)
const _urlParams   = new URLSearchParams(window.location.search);
const _joinToken   = _urlParams.get('token') || null;
const _prefillCode = (_urlParams.get('org') || _urlParams.get('t') || sessionStorage.getItem('pending_tenant_code') || '').toUpperCase();
const _prefillRole = _urlParams.get('role') || '';

window.upperizeInput = function(el) {
  el.value = el.value.toUpperCase();
};

(function _prefill() {
  const codeEl = document.getElementById('tenant-code');
  const roleEl = document.getElementById('staff-role');
  if (_prefillCode && codeEl) {
    codeEl.value = _prefillCode;
    if (_joinToken) {
      // Lock org code so candidate can't change it
      codeEl.readOnly = true;
      codeEl.style.cssText += ';background:#f8fdf9;cursor:not-allowed;color:var(--text-mid)';
    }
  }
  if (_prefillRole && roleEl) {
    roleEl.value = _prefillRole;
    if (_joinToken) {
      roleEl.disabled = true;
      roleEl.style.cssText += ';background:#f8fdf9;cursor:not-allowed';
    }
    // Trigger role-dependent field visibility
    window.onRoleChange && window.onRoleChange(_prefillRole);
  }
  if (_prefillCode && _prefillRole) {
    // Auto-load departments for dept-requiring roles
    window._loadDepts && window._loadDepts();
  }
})();

// Show welcome banner and look up org name for join-link arrivals
if (_joinToken && _prefillCode) {
  (async function _showInviteBanner() {
    const banner   = document.getElementById('invite-banner');
    const bannerTx = document.getElementById('invite-banner-text');
    banner.style.display = '';
    // Get org name from tenant code
    const { data } = await supabase.rpc('get_tenant_by_code', { p_code: _prefillCode });
    const orgName  = data?.[0]?.name || _prefillCode;
    const roleLabel = {
      doctor:'Doctor / Vaidya', receptionist:'Receptionist', pharmacist:'Pharmacist',
      nurse:'Nurse', lab_tech:'Lab Technician', therapist:'Therapist',
      accountant:'Accountant', student:'PG Student / Intern',
    }[_prefillRole] || _prefillRole;
    bannerTx.innerHTML = `Your appointment letter from <strong>${_esc(orgName)}</strong> has pre-filled your organisation code and role (<strong>${_esc(roleLabel)}</strong>).<br/>
      Complete the form below to set up your account — your admin will be notified for final approval.`;
  })();
}

window.togglePw = function(inputId, btn) {
  const input = document.getElementById(inputId);
  const isText = input.type === 'text';
  input.type = isText ? 'password' : 'text';
  btn.innerHTML = isText ? '&#128065;' : '&#128584;';
};

const HPR_ROLES  = ['doctor','nurse','pharmacist','lab_tech','therapist'];
const DEPT_ROLES = ['doctor','nurse','therapist','lab_tech','student','diet_staff','mrd_staff'];
let _depts = [];

window._loadDepts = async function _loadDepts() {
  const code = document.getElementById('tenant-code').value.trim();
  const role = document.getElementById('staff-role').value;
  const field = document.getElementById('dept-field');
  if (!code || !DEPT_ROLES.includes(role)) return;
  const sel = document.getElementById('staff-dept');
  sel.innerHTML = '<option value="">— Loading… —</option>';
  field.style.display = '';
  const { data } = await supabase.rpc('get_departments_for_signup', { p_tenant_code: code });
  _depts = data || [];
  if (!_depts.length) {
    field.style.display = 'none';
    return;
  }
  sel.innerHTML = '<option value="">— Select your department —</option>' +
    _depts.map(d => `<option value="${_esc(d.id)}">${_esc(d.name)}${d.ncism_code ? ' ('+_esc(d.ncism_code)+')' : ''}</option>`).join('');
};

window.onCodeBlur = function() {
  if (DEPT_ROLES.includes(document.getElementById('staff-role').value)) window._loadDepts();
};

window.onRoleChange = function(role) {
  const showHpr = HPR_ROLES.includes(role) ? '' : 'none';
  document.getElementById('hpr-field').style.display       = showHpr;
  document.getElementById('state-reg-field').style.display = showHpr;
  if (DEPT_ROLES.includes(role)) {
    _loadDepts();
  } else {
    document.getElementById('dept-field').style.display = 'none';
  }
};

window.handleSignup = async function() {
  clearError();

  const code     = document.getElementById('tenant-code').value.trim();
  const role     = document.getElementById('staff-role').value;
  const name     = document.getElementById('staff-name').value.trim();
  const email    = document.getElementById('staff-email').value.trim();
  const phone    = document.getElementById('staff-phone').value.trim();
  const pw       = document.getElementById('staff-password').value;
  const confirm  = document.getElementById('staff-confirm').value;
  const hprId    = document.getElementById('staff-hpr').value.trim();
  const stateReg = document.getElementById('staff-state-reg').value.trim();
  const deptId   = DEPT_ROLES.includes(role) ? document.getElementById('staff-dept').value : null;

  if (!code)          return showError('Please enter your organisation code.');
  if (!role)          return showError('Please select your role.');
  if (DEPT_ROLES.includes(role) && _depts.length && !deptId)
                      return showError('Please select your department.');
  if (!name)          return showError('Please enter your full name.');
  if (!email)         return showError('Please enter your email address.');
  if (!isValidEmail(email)) return showError('Please enter a valid email address.');
  if (!phone)         return showError('Please enter your phone number.');
  if (!isValidPhone(phone)) return showError('Please enter a valid 10-digit mobile number.');
  const pwCheck = validatePassword(pw);
  if (!pwCheck.valid) return showError(pwCheck.message);
  if (pw !== confirm) return showError('Passwords do not match. Please re-enter.');

  const btn = document.getElementById('btn-submit');
  setLoading(btn, true);

  const result = await registerStaff({
    fullName:     name,
    email,
    password:     pw,
    phone,
    role,
    tenantCode:   code,
    hprId:        hprId    || null,
    stateRegId:   stateReg || null,
    departmentId: deptId   || null,
  });

  if (!result.success) {
    showError(result.error || 'Signup failed. Please check your details and try again.');
    setLoading(btn, false);
    return;
  }

  // If arrived via recruitment join link, mark application as joined
  if (_joinToken) {
    try {
      await supabase.from('job_applications')
        .update({ status: 'joined', join_date: new Date().toISOString().slice(0,10) })
        .eq('join_token', _joinToken);
    } catch (_) { /* non-critical — silent fail */ }
  }

  document.getElementById('form-view').style.display = 'none';
  document.getElementById('success-screen').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function showError(msg) {
  document.getElementById('alert-error-text').textContent = msg;
  document.getElementById('alert-error').classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function clearError() {
  document.getElementById('alert-error').classList.remove('show');
}
function setLoading(btn, on) {
  btn.classList.toggle('loading', on);
  btn.disabled = on;
}
