import { registerStaff } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { isValidEmail, isValidPhone, validatePassword } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Pre-fill from URL params
// Supports: ?t=CODE (legacy), ?org=CODE&role=ROLE&token=UUID (recruitment join link),
// ?pinv=UUID (NCISM position invite — pre-scoped department + designation, see below)
const _urlParams   = new URLSearchParams(window.location.search);
const _joinToken   = _urlParams.get('token') || null;
const _pinvToken   = _urlParams.get('pinv') || null;
let _prefillCode   = (_urlParams.get('org') || _urlParams.get('t') || sessionStorage.getItem('pending_tenant_code') || '').toUpperCase();
let _prefillRole   = _urlParams.get('role') || '';

// Position-invite state, populated by _loadPositionInvite() below when ?pinv= is present
let _pinvDeptId = null;
let _pinvDesignation = null;
let _pinvSecondaryRole = null;

window.upperizeInput = function(el) {
  el.value = el.value.toUpperCase();
};

function _prefill() {
  const codeEl = document.getElementById('tenant-code');
  const roleEl = document.getElementById('staff-role');
  if (_prefillCode && codeEl) {
    codeEl.value = _prefillCode;
    if (_joinToken || _pinvToken) {
      // Lock org code so candidate can't change it
      codeEl.readOnly = true;
      codeEl.style.cssText += ';background:#f8fdf9;cursor:not-allowed;color:var(--text-mid)';
    }
  }
  if (_prefillRole && roleEl && !_pinvToken) {
    roleEl.value = _prefillRole;
    if (_joinToken) {
      roleEl.disabled = true;
      roleEl.style.cssText += ';background:#f8fdf9;cursor:not-allowed';
    }
    // Trigger role-dependent field visibility (position invites hide this
    // dropdown entirely in _loadPositionInvite() — must not re-trigger
    // onRoleChange()'s own _loadDepts() call, which would re-show dept-field)
    window.onRoleChange && window.onRoleChange(_prefillRole);
  }
  if (_prefillCode && _prefillRole && !_pinvToken) {
    // Auto-load departments for dept-requiring roles (position invites set their
    // own department directly — see _loadPositionInvite() — no dropdown needed)
    window._loadDepts && window._loadDepts();
  }
}

// Show welcome banner and look up org name for recruitment join-link arrivals
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

// NCISM position-invite arrivals (?pinv=TOKEN) — the department, designation and
// HMS role are all pre-scoped by whoever generated the invite (admin.html's NCISM
// Staffing Compliance panel), so the role/department dropdowns are hidden entirely
// rather than just locked, and a small position summary is shown instead.
const DESIG_LABELS = {
  professor:'Professor', hod:'Head of Department', associate_professor:'Associate Professor',
  assistant_professor:'Assistant Professor', senior_resident:'Senior Resident', junior_resident:'Junior Resident',
  medical_director:'Medical Director', medical_superintendent:'Medical Superintendent',
  deputy_medical_superintendent:'Deputy Medical Superintendent', administrative_officer:'Administrative Officer',
  opd_incharge:'Office Superintendent', resident_medical_officer:'Resident Medical Officer',
  emergency_medical_officer:'Emergency Medical Officer', general_duty_medical_officer:'General Duty Medical Officer',
  nursing_superintendent:'Nursing Superintendent (Matron)', deputy_nursing_superintendent:'Assistant Matron',
  staff_nurse:'Staff Nurse', ward_sister:'Ward Sister', anm:'Auxiliary Nurse Midwife',
  accountant:'Accountant', receptionist:'Receptionist', registration_clerk:'Registration Clerk',
  billing_clerk:'Billing Clerk', medical_record_officer:'Medical Record Officer',
  medical_record_technician:'Medical Record Technician', pharmacist:'Pharmacist', chief_pharmacist:'Dispensary In-charge',
  pharmacy_assistant:'Pharmacy Assistant', lab_technician:'Lab Technician', lab_attendant:'Lab Attendant',
  radiographer:'Radiographer', microbiologist:'Microbiologist', ot_technician:'OT Technician',
  cssd_technician:'CSSD Technician', cssd_incharge:'CSSD In-charge', pk_incharge:'Panchakarma In-charge',
  senior_therapist:'Senior Therapist', therapist:'Therapist', yoga_instructor:'Yoga Instructor',
  palha_diet_incharge:'Palha-diet In-charge', dietitian:'Dietitian', diet_cook:'Ayurvedic Diet Cook', attender:'Attender',
};

let _positionInviteValid = false;

async function _loadPositionInvite() {
  const errBox = document.getElementById('position-invite-error');
  const { data, error } = await supabase.rpc('get_position_invite', { p_token: _pinvToken });
  const row = data?.[0];

  if (error || !row) {
    errBox.textContent = 'This invite link is invalid. Please ask your admin to send a new one.';
    errBox.style.display = 'flex';
    document.getElementById('btn-submit').disabled = true;
    return;
  }
  if (row.status !== 'pending') {
    errBox.textContent = row.status === 'joined'
      ? 'This invite link has already been used. Please ask your admin to send a new one if this is a mistake.'
      : 'This invite link is no longer valid. Please ask your admin to send a new one.';
    errBox.style.display = 'flex';
    document.getElementById('btn-submit').disabled = true;
    return;
  }

  _prefillCode      = row.tenant_code || _prefillCode;
  _prefillRole      = row.role || '';
  _pinvDeptId       = row.department_id || null;
  _pinvDesignation  = row.designation || null;
  _pinvSecondaryRole = row.secondary_role || null;
  _positionInviteValid = true;

  // Hide the generic role/department pickers entirely — this join is pre-scoped
  document.getElementById('staff-role').closest('.field').style.display = 'none';
  document.getElementById('dept-field').style.display = 'none';

  const banner = document.getElementById('position-invite-banner');
  const bannerTx = document.getElementById('position-invite-banner-text');
  const desigLabel = DESIG_LABELS[_pinvDesignation] || _pinvDesignation;
  banner.style.display = '';
  // nosemgrep: javascript.browser.security.raw-html-concat.raw-html-concat -- every interpolated value (tenant_name/tenant_code, desigLabel, department_name) is passed through _esc() before concatenation
  bannerTx.innerHTML = `You're joining <strong>${_esc(row.tenant_name || row.tenant_code)}</strong> as <strong>${_esc(desigLabel)}</strong>`
    + (row.department_name ? ` in the <strong>${_esc(row.department_name)}</strong> department` : '')
    + `.<br/>Fill in your details below to set up your account — your admin will be notified for final approval.`;
}

(async function _boot() {
  if (_pinvToken) await _loadPositionInvite();
  _prefill();
})();

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
  const role     = _positionInviteValid ? _prefillRole : document.getElementById('staff-role').value;
  const name     = document.getElementById('staff-name').value.trim();
  const email    = document.getElementById('staff-email').value.trim();
  const phone    = document.getElementById('staff-phone').value.trim();
  const pw       = document.getElementById('staff-password').value;
  const confirm  = document.getElementById('staff-confirm').value;
  const hprId    = document.getElementById('staff-hpr').value.trim();
  const stateReg = document.getElementById('staff-state-reg').value.trim();
  const deptId   = _positionInviteValid ? _pinvDeptId
                    : (DEPT_ROLES.includes(role) ? document.getElementById('staff-dept').value : null);

  if (!code)          return showError('Please enter your organisation code.');
  if (!role)          return showError('Please select your role.');
  if (!_positionInviteValid && DEPT_ROLES.includes(role) && _depts.length && !deptId)
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
    designation:  _positionInviteValid ? _pinvDesignation : null,
    secondaryRole: _positionInviteValid ? _pinvSecondaryRole : null,
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

  // If arrived via NCISM position invite, mark it joined so the admin's ladder
  // stops showing this slot as "pending" and it can't be reused
  if (_pinvToken && _positionInviteValid) {
    try {
      await supabase.from('position_invites')
        .update({ status: 'joined', joined_at: new Date().toISOString(), joined_profile_id: result.userId })
        .eq('token', _pinvToken);
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
