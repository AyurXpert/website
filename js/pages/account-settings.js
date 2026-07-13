import { requireAuth, getCurrentProfile, getCurrentRole } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { MFA_MANDATORY_ROLES, ROLE_HOME } from '../config/constants.js';

await requireAuth([]); // any authenticated role can manage their own account
initNavbar();
wireDelegatedEvents();

function _toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); }

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
  if (error) { _toast(safeErrorMessage(error, 'Could not load two-factor status.')); return; }

  const verified = data?.totp?.find(f => f.status === 'verified');
  if (verified) {
    document.getElementById('factor-since').textContent = `Enabled ${_formatDate(verified.created_at)}`;
    _showState('state-enrolled');
  } else {
    _showState('state-not-enrolled');
  }
}

window.startEnroll = async function () {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator App' });
  if (error) { _toast(safeErrorMessage(error, 'Could not start enrollment.')); return; }

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
  _toast('Two-factor authentication enabled ✓');
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
  if (error) { _toast(safeErrorMessage(error, 'Could not remove two-factor authentication.')); return; }

  _toast('Two-factor authentication removed');
  await loadFactorState();
};

await loadFactorState();
