import { requireAuth, getCurrentProfile, getCurrentRole, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { MFA_MANDATORY_ROLES, ROLE_HOME } from '../config/constants.js';
import { notify } from '../components/notify.js';

await requireAuth([]); // any authenticated role can manage their own account
initNavbar();
wireDelegatedEvents();

function _toast(msg, type = 'info') { notify(msg, type); }   // Session 323: shared top-layer notify()

// Reached via requireAuth()'s forced redirect for a mandatory-MFA role with no
// factor yet — this page has no nav link back anywhere, so once enrollment
// completes below, send the user on to where they were actually headed instead
// of stranding them here (confirmed live 14 Jul 2026 — platform_admin had no
// way back from a fresh enrollment).
const _cameFromMfaGate = new URLSearchParams(window.location.search).get('mfa_required') === '1';
if (_cameFromMfaGate) {
  document.getElementById('mfa-required-banner').classList.add('show');
}

function _showState(name) {
  ['state-not-enrolled', 'state-enrolling', 'state-enrolled'].forEach(id =>
    document.getElementById(id).classList.toggle('show', id === name)
  );
}

function _formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

let _pendingFactorId = null;

async function loadFactorState() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) { _toast(safeErrorMessage(error, 'Could not load two-factor status.'), 'error'); return; }

  const verified = data?.totp?.find(f => f.status === 'verified');
  if (verified) {
    document.getElementById('factor-since').textContent = `Enabled ${_formatDate(verified.created_at)}`;
    _showState('state-enrolled');
    document.getElementById('backup-codes-card').style.display = '';
    loadBackupCodesStatus();
  } else {
    _showState('state-not-enrolled');
    document.getElementById('backup-codes-card').style.display = 'none';
  }
}

// ── Backup recovery codes (Session 129) ──
async function loadBackupCodesStatus() {
  const { data: { user } } = await supabase.auth.getUser();
  const { count, error } = await supabase.from('mfa_backup_codes')
    .select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('used_at', null);
  const el = document.getElementById('bc-status');
  if (error) { el.textContent = 'Could not load backup code status.'; return; }
  el.textContent = count > 0
    ? `You have ${count} unused backup code(s).`
    : 'No backup codes set up yet — generate a set so you can recover access if you ever lose your authenticator device.';
}

let _revealedCodes = [];

window.generateBackupCodes = async function () {
  if (document.getElementById('bc-status').textContent.includes('unused') &&
      !confirm('Generating new codes invalidates any existing unused ones. Continue?')) return;

  const btn = document.getElementById('btn-generate-codes');
  btn.disabled = true;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/mfa-backup-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    });
    const result = await res.json();
    if (!res.ok) { _toast(result.error || 'Could not generate backup codes.', 'error'); return; }

    _revealedCodes = result.codes;
    document.getElementById('bc-codes-list').innerHTML = result.codes.map(c => `<div>${c}</div>`).join('');
    document.getElementById('bc-reveal').style.display = 'block';
  } catch (err) {
    _toast(safeErrorMessage(err, 'Could not generate backup codes.'), 'error');
  } finally {
    btn.disabled = false;
  }
};

window.downloadBackupCodes = function () {
  if (!_revealedCodes.length) return;
  const profile = getCurrentProfile();
  const lines = [
    'AyurXpert — Backup Recovery Codes',
    `Account: ${profile?.full_name || '—'}`,
    `Generated: ${new Date().toLocaleString('en-IN')}`,
    'Each code works once. Keep this file somewhere only you can access.',
    '',
    ..._revealedCodes,
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ayurxpert-backup-codes.txt';
  a.click();
  URL.revokeObjectURL(url);
};

window.printBackupCodes = function () {
  if (!_revealedCodes.length) return;
  const profile = getCurrentProfile();
  document.getElementById('bc-print-account').textContent =
    `Account: ${profile?.full_name || '—'} — Generated: ${new Date().toLocaleString('en-IN')}`;
  document.getElementById('bc-print-list').innerHTML = _revealedCodes.map(c => `<div>${c}</div>`).join('');
  window.print();
};

window.dismissBackupCodes = function () {
  document.getElementById('bc-reveal').style.display = 'none';
  document.getElementById('bc-codes-list').innerHTML = '';
  _revealedCodes = [];
  loadBackupCodesStatus();
};

window.startEnroll = async function () {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator App' });
  if (error) { _toast(safeErrorMessage(error, 'Could not start enrollment.'), 'error'); return; }

  _pendingFactorId = data.id;
  document.getElementById('manual-secret').textContent = data.totp.secret;
  document.getElementById('enroll-code').value = '';
  document.getElementById('enroll-alert').classList.remove('show');

  const qrContainer = document.getElementById('qr-canvas');
  qrContainer.innerHTML = '';
  new window.QRCode(qrContainer, {
    text: data.totp.uri,
    width: 200,
    height: 200,
    colorDark: '#1a4a2e',
    colorLight: '#ffffff',
  });

  _showState('state-enrolling');
};

window.cancelEnroll = async function () {
  if (_pendingFactorId) {
    await supabase.auth.mfa.unenroll({ factorId: _pendingFactorId }); // discard the unverified factor
    _pendingFactorId = null;
  }
  await loadFactorState();
};

window.confirmEnroll = async function () {
  const code = document.getElementById('enroll-code').value.trim();
  const alertEl = document.getElementById('enroll-alert');
  alertEl.classList.remove('show');

  if (!/^\d{6}$/.test(code)) {
    alertEl.textContent = 'Please enter the 6-digit code.';
    alertEl.classList.add('show');
    return;
  }

  const btn = document.getElementById('btn-confirm-enroll');
  btn.disabled = true;
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: _pendingFactorId, code });
  btn.disabled = false;

  if (error) {
    alertEl.textContent = safeErrorMessage(error, 'Invalid code. Please try again.');
    alertEl.classList.add('show');
    return;
  }

  _pendingFactorId = null;
  _toast('Two-factor authentication enabled ✓', 'success');
  await loadFactorState();

  if (_cameFromMfaGate) {
    const home = ROLE_HOME[getCurrentRole()] || 'index.html';
    setTimeout(() => { window.location.href = home; }, 1200);
  }
};

window.removeFactor = async function () {
  const profile = getCurrentProfile();
  const isMandatory = MFA_MANDATORY_ROLES.includes(profile?.role);
  const warning = isMandatory
    ? 'Your role requires two-factor authentication. Removing it will lock you out of AyurXpert until you set it up again. Continue?'
    : 'Remove two-factor authentication from your account?';
  if (!confirm(warning)) return;

  const { data } = await supabase.auth.mfa.listFactors();
  const verified = data?.totp?.find(f => f.status === 'verified');
  if (!verified) return;

  const { error } = await supabase.auth.mfa.unenroll({ factorId: verified.id });
  if (error) { _toast(safeErrorMessage(error, 'Could not remove two-factor authentication.'), 'error'); return; }

  _toast('Two-factor authentication removed', 'success');
  await loadFactorState();
};

// ── Session 204: account tab bar ──────────────────────────────────────────
window.switchAccountTab = function (name, btnEl) {
  document.querySelectorAll('.acct-tab').forEach(b => b.classList.toggle('active', b === btnEl));
  document.querySelectorAll('.acct-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
};

// ── My Profile ─────────────────────────────────────────────────────────────
const _uid = getCurrentProfile()?.id;
let _myProfile = null;

function _fmtDateInput(d) { return d ? String(d).slice(0, 10) : ''; }
function _fmtDateDisplay(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// DOB → age auto-calculator, same formula reception.js already uses for patient DOB.
function _ageFromDob(dob) {
  if (!dob) return null;
  const today = new Date(), birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() ||
     (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}
function _renderAgeHint() {
  const age = _ageFromDob(document.getElementById('pf-dob').value);
  document.getElementById('pf-age-hint').textContent = (age !== null && age >= 0) ? `Age: ${age} years` : '';
}
document.getElementById('pf-dob').addEventListener('change', _renderAgeHint);

async function loadProfileTab() {
  const { data, error } = await supabase.from('profiles')
    .select('id, full_name, role, designation, phone, gender, date_of_birth, address, emergency_contact_name, emergency_contact_phone, blood_group, date_of_joining, photo_path')
    .eq('id', _uid).single();
  if (error) { _toast(safeErrorMessage(error, 'Could not load your profile.'), 'error'); return; }
  _myProfile = data;

  document.getElementById('pf-full-name').value = data.full_name || '';
  document.getElementById('pf-role').value = data.designation || data.role || '';
  document.getElementById('pf-phone').value = data.phone || '';
  document.getElementById('pf-gender').value = data.gender || '';
  document.getElementById('pf-dob').value = _fmtDateInput(data.date_of_birth);
  _renderAgeHint();
  document.getElementById('pf-blood-group').value = data.blood_group || '';
  document.getElementById('pf-address').value = data.address || '';
  document.getElementById('pf-ec-name').value = data.emergency_contact_name || '';
  document.getElementById('pf-ec-phone').value = data.emergency_contact_phone || '';
  document.getElementById('pf-doj').value = _fmtDateDisplay(data.date_of_joining);

  if (data.photo_path) {
    const { data: signed } = await supabase.storage.from('staff-documents').createSignedUrl(data.photo_path, 3600);
    if (signed?.signedUrl) {
      // Property assignment (not innerHTML) — the signed URL is Supabase-generated, but
      // building the <img> via the DOM API rather than a template string sidesteps any
      // HTML-injection surface entirely, regardless of what the URL ever contains.
      const preview = document.getElementById('profile-photo-preview');
      preview.replaceChildren();
      const img = document.createElement('img');
      img.src = signed.signedUrl;
      img.alt = 'Profile photo';
      preview.appendChild(img);
    }
  }

  await loadProfessionalRegistration();
  await loadDocuments();
}

window.saveProfile = async function () {
  const updates = {
    phone: document.getElementById('pf-phone').value.trim() || null,
    gender: document.getElementById('pf-gender').value || null,
    date_of_birth: document.getElementById('pf-dob').value || null,
    blood_group: document.getElementById('pf-blood-group').value || null,
    address: document.getElementById('pf-address').value.trim() || null,
    emergency_contact_name: document.getElementById('pf-ec-name').value.trim() || null,
    emergency_contact_phone: document.getElementById('pf-ec-phone').value.trim() || null,
  };
  const { error } = await supabase.from('profiles').update(updates).eq('id', _uid);
  if (error) { _toast(safeErrorMessage(error, 'Could not save changes.'), 'error'); return; }
  _toast('Profile updated ✓', 'success');
};

window.triggerPhotoPicker = function () { document.getElementById('profile-photo-input').click(); };

window.onPhotoSelected = async function (input) {
  const file = input.files?.[0];
  if (!file) return;
  const tenantId = getCurrentTenantId();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${tenantId}/${_uid}/photo.${ext}`;
  const { error: upErr } = await supabase.storage.from('staff-documents').upload(path, file, { upsert: true });
  if (upErr) { _toast(safeErrorMessage(upErr, 'Could not upload photo.'), 'error'); return; }
  const { error: dbErr } = await supabase.from('profiles').update({ photo_path: path }).eq('id', _uid);
  if (dbErr) { _toast(safeErrorMessage(dbErr, 'Photo uploaded but could not be linked. Please try again.'), 'error'); return; }
  _toast('Photo updated ✓', 'success');
  await loadProfileTab();
};

// ── Professional registration (Session 337, TODO §132) ─────────────────────
// Staff submit their Reg. No. / issuing council / qualification; an admin of the organisation
// verifies it in HR → Credentials. Bills and prescriptions print ONLY the verified values on
// the profile — a pending change never prints. Mirrors the server's _is_professional_role().
const PROFESSIONAL_ROLES = ['doctor', 'trainee_doctor', 'pharmacist', 'nurse', 'nurse_manager', 'lab_tech',
  'therapist', 'super_admin', 'dept_admin'];

function _setText(id, value) { document.getElementById(id).textContent = value || '—'; }

async function loadProfessionalRegistration() {
  const card = document.getElementById('pr-card');
  const { data: me, error } = await supabase.from('profiles')
    .select('role, secondary_role, registration_number, registration_council, qualification, credentials_verified_at, credentials_verified_by')
    .eq('id', _uid).single();
  if (error || !me) { card.style.display = 'none'; return; }
  if (!PROFESSIONAL_ROLES.includes(me.role) && !PROFESSIONAL_ROLES.includes(me.secondary_role)) { card.style.display = 'none'; return; }
  card.style.display = '';

  const { data: subs } = await supabase.from('professional_credential_submissions')
    .select('id, status, registration_number, registration_council, qualification, submitted_at, decided_at, rejection_reason')
    .eq('profile_id', _uid).order('submitted_at', { ascending: false }).limit(5);
  const pending = (subs || []).find(s => s.status === 'pending') || null;
  const lastDecided = (subs || []).find(s => s.status === 'verified' || s.status === 'rejected') || null;

  let verifierName = '';
  if (me.credentials_verified_by) {
    const { data: v } = await supabase.from('profiles').select('full_name').eq('id', me.credentials_verified_by).maybeSingle();
    verifierName = v?.full_name || '';
  }

  const hasPrinted = !!(me.registration_number || me.registration_council || me.qualification);
  _setText('pr-v-reg', me.registration_number);
  _setText('pr-v-council', me.registration_council);
  _setText('pr-v-qual', me.qualification);
  document.getElementById('pr-verified-block').style.display = hasPrinted ? '' : 'none';

  document.getElementById('pr-pending-block').style.display = pending ? '' : 'none';
  if (pending) {
    _setText('pr-p-reg', pending.registration_number);
    _setText('pr-p-council', pending.registration_council);
    _setText('pr-p-qual', pending.qualification);
  }

  const statusEl = document.getElementById('pr-status');
  statusEl.className = 'pr-status';
  if (pending) {
    statusEl.classList.add('pending');
    statusEl.textContent = `⏳ Pending verification — submitted ${_fmtDateDisplay(pending.submitted_at)}.` +
      (hasPrinted ? ' Bills keep printing your verified details until this is approved.' : ' Nothing prints on bills until it is approved.');
  } else if (lastDecided?.status === 'rejected' && !(me.credentials_verified_at && new Date(me.credentials_verified_at) > new Date(lastDecided.decided_at))) {
    statusEl.classList.add('rejected');
    statusEl.textContent = `✖ Rejected on ${_fmtDateDisplay(lastDecided.decided_at)} — reason: ${lastDecided.rejection_reason || '—'}. Correct the details and submit again.`;
  } else if (me.credentials_verified_at) {
    statusEl.classList.add('verified');
    statusEl.textContent = `✔ Verified on ${_fmtDateDisplay(me.credentials_verified_at)}${verifierName ? ' by ' + verifierName : ''}.`;
  } else if (hasPrinted) {
    statusEl.textContent = 'On file — recorded before verification existed. Submit your details to have them verified.';
  } else {
    statusEl.textContent = 'Not submitted — your bills and prescriptions print no registration number yet.';
  }

  // pre-fill the form with what's pending, else what's verified, so a correction starts from it
  const src = pending || me;
  document.getElementById('pr-reg').value = src.registration_number || '';
  document.getElementById('pr-council').value = src.registration_council || '';
  document.getElementById('pr-qual').value = src.qualification || '';
  document.getElementById('pr-form-title').textContent = pending ? 'Change the pending submission'
    : (hasPrinted ? 'Submit a change for verification' : 'Submit for verification');
}

window.submitProfessionalCredentials = async function () {
  const alertEl = document.getElementById('pr-alert');
  alertEl.classList.remove('show');
  const reg = document.getElementById('pr-reg').value.trim();
  const council = document.getElementById('pr-council').value.trim();
  const qual = document.getElementById('pr-qual').value.trim();
  if (!reg || !council || !qual) {
    alertEl.textContent = 'Enter the Registration No., the issuing council / board and your qualification.';
    alertEl.classList.add('show');
    return;
  }
  const btn = document.getElementById('pr-submit-btn');
  btn.disabled = true;
  const { error } = await supabase.rpc('submit_my_professional_credentials', {
    p_registration_number: reg, p_registration_council: council, p_qualification: qual,
  });
  btn.disabled = false;
  if (error) {
    alertEl.textContent = safeErrorMessage(error, 'Could not submit your registration details.');
    alertEl.classList.add('show');
    return;
  }
  _toast('Sent for verification ✓', 'success');
  await loadProfessionalRegistration();
};

// ── Official documents ──────────────────────────────────────────────────────
async function loadDocuments() {
  const { data, error } = await supabase.from('staff_documents')
    .select('id, doc_type, file_name, storage_path, uploaded_at')
    .eq('profile_id', _uid).order('uploaded_at', { ascending: false });
  const box = document.getElementById('doc-list');
  if (error) { box.textContent = 'Could not load documents.'; return; }
  if (!data.length) { box.innerHTML = '<div style="font-size:13px;color:var(--text-muted)">No documents uploaded yet.</div>'; return; }

  const labels = { id_proof: 'ID Proof', qualification_certificate: 'Qualification Certificate', registration_certificate: 'Registration Certificate', other: 'Other' };
  box.innerHTML = data.map(d => `
    <div class="doc-row">
      <div>
        <div class="doc-name">${_esc(d.file_name)}</div>
        <div class="doc-type">${_esc(labels[d.doc_type] || d.doc_type)} · ${_fmtDateDisplay(d.uploaded_at)}</div>
      </div>
      <div class="btn-row" style="gap:6px">
        <button class="btn btn-outline" style="width:auto;height:34px;font-size:12px;padding:6px 12px" data-onclick="viewDocument" data-onclick-a0="${_esc(d.storage_path)}">View</button>
        <button class="btn btn-danger" style="width:auto;height:34px;font-size:12px;padding:6px 12px" data-onclick="deleteDocument" data-onclick-a0="${_esc(d.id)}" data-onclick-a1="${_esc(d.storage_path)}">Delete</button>
      </div>
    </div>`).join('');
}

window.triggerDocPicker = function () { document.getElementById('doc-file-input').click(); };

window.onDocumentSelected = async function (input) {
  const file = input.files?.[0];
  if (!file) return;
  const docType = document.getElementById('doc-type-select').value;
  const tenantId = getCurrentTenantId();
  const path = `${tenantId}/${_uid}/documents/${crypto.randomUUID()}-${file.name}`;
  const { error: upErr } = await supabase.storage.from('staff-documents').upload(path, file);
  if (upErr) { _toast(safeErrorMessage(upErr, 'Could not upload document.'), 'error'); return; }
  const { error: dbErr } = await supabase.from('staff_documents').insert({
    tenant_id: tenantId, profile_id: _uid, doc_type: docType, file_name: file.name,
    storage_path: path, uploaded_by: _uid,
  });
  if (dbErr) { _toast(safeErrorMessage(dbErr, 'Document uploaded but could not be recorded. Please try again.'), 'error'); return; }
  _toast('Document uploaded ✓', 'success');
  input.value = '';
  await loadDocuments();
};

window.viewDocument = async function (path) {
  const { data, error } = await supabase.storage.from('staff-documents').createSignedUrl(path, 300);
  if (error) { _toast(safeErrorMessage(error, 'Could not open document.'), 'error'); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
};

window.deleteDocument = async function (id, path) {
  if (!confirm('Delete this document?')) return;
  await supabase.storage.from('staff-documents').remove([path]);
  const { error } = await supabase.from('staff_documents').delete().eq('id', id);
  if (error) { _toast(safeErrorMessage(error, 'Could not delete document.'), 'error'); return; }
  _toast('Document deleted', 'success');
  await loadDocuments();
};

// ── Apply for Leave ─────────────────────────────────────────────────────────
async function loadLeaveTab() {
  const tenantId = getCurrentTenantId();
  const myRole = getCurrentRole();
  // Session 204 fix — was listing every staff member in the org regardless of role,
  // letting a nurse name a doctor as her cover (or vice versa), which makes no sense
  // for actually covering someone's duties. Scoped to same-role colleagues only —
  // matches how covering is handled everywhere else in this codebase (shift-change
  // requests, roster relief matching, etc. are all same-role/same-designation-group).
  const { data: colleagues } = await supabase.from('profiles')
    .select('id, full_name').eq('tenant_id', tenantId).eq('is_active', true)
    .eq('role', myRole).neq('id', _uid).order('full_name');
  const sel = document.getElementById('lv-covering');
  sel.innerHTML = '<option value="">— None —</option>' +
    (colleagues || []).map(c => `<option value="${_esc(c.id)}">${_esc(c.full_name)}</option>`).join('');
  if (!colleagues?.length) {
    sel.innerHTML += '<option value="" disabled>No other staff with your role found</option>';
  }

  await loadMyLeaves();
}

async function loadMyLeaves() {
  const { data, error } = await supabase.from('staff_leaves')
    .select('id, leave_type, from_date, to_date, reason, status, rejection_reason, created_at')
    .eq('profile_id', _uid).order('created_at', { ascending: false });
  const box = document.getElementById('my-leaves-list');
  if (error) { box.textContent = 'Could not load your leave requests.'; return; }
  if (!data.length) { box.innerHTML = '<div style="font-size:13px;color:var(--text-muted)">No leave requests yet.</div>'; return; }

  const typeLabels = { casual: 'Casual Leave', medical: 'Medical Leave', earned: 'Earned Leave', maternity: 'Maternity Leave', paternity: 'Paternity Leave', duty: 'On-Duty Leave', other: 'Other' };
  box.innerHTML = data.map(l => `
    <div class="leave-row">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:10px">
        <div>
          <strong>${_esc(typeLabels[l.leave_type] || l.leave_type)}</strong>
          <div style="color:var(--text-mid);margin-top:2px">${_fmtDateDisplay(l.from_date)} — ${_fmtDateDisplay(l.to_date)}</div>
          ${l.reason ? `<div style="color:var(--text-muted);margin-top:2px">${_esc(l.reason)}</div>` : ''}
          ${l.status === 'rejected' && l.rejection_reason ? `<div style="color:var(--red);margin-top:4px">Reason: ${_esc(l.rejection_reason)}</div>` : ''}
        </div>
        <span class="leave-status ${_esc(l.status)}">${_esc(l.status)}</span>
      </div>
      ${l.status === 'pending' ? `<button class="btn btn-outline" style="width:auto;height:32px;font-size:12px;padding:4px 12px;margin-top:8px" data-onclick="withdrawLeave" data-onclick-a0="${_esc(l.id)}">Withdraw</button>` : ''}
    </div>`).join('');
}

window.submitLeaveRequest = async function () {
  const alertEl = document.getElementById('leave-alert');
  alertEl.classList.remove('show');

  const leaveType = document.getElementById('lv-type').value;
  const from = document.getElementById('lv-from').value;
  const to = document.getElementById('lv-to').value;
  const reason = document.getElementById('lv-reason').value.trim() || null;
  const covering = document.getElementById('lv-covering').value || null;

  if (!from || !to) { alertEl.textContent = 'Please select both From and To dates.'; alertEl.classList.add('show'); return; }
  if (to < from) { alertEl.textContent = 'To date cannot be before From date.'; alertEl.classList.add('show'); return; }

  const { error } = await supabase.rpc('request_leave', {
    p_leave_type: leaveType, p_from_date: from, p_to_date: to, p_reason: reason, p_covering_profile_id: covering,
  });
  if (error) { alertEl.textContent = safeErrorMessage(error, 'Could not submit your leave request.'); alertEl.classList.add('show'); return; }

  _toast('Leave request sent ✓', 'success');
  document.getElementById('lv-from').value = '';
  document.getElementById('lv-to').value = '';
  document.getElementById('lv-reason').value = '';
  document.getElementById('lv-covering').value = '';
  await loadMyLeaves();
};

window.withdrawLeave = async function (id) {
  if (!confirm('Withdraw this leave request?')) return;
  const { error } = await supabase.from('staff_leaves').delete().eq('id', id);
  if (error) { _toast(safeErrorMessage(error, 'Could not withdraw request.'), 'error'); return; }
  _toast('Leave request withdrawn', 'success');
  await loadMyLeaves();
};

await loadFactorState();
await loadProfileTab();
await loadLeaveTab();
