import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { validatePassword } from '../utils/validators.js';
import { scorePasswordStrength, checkPasswordPwned, isObviouslyWeak } from '../utils/passwordSecurity.js';

wireDelegatedEvents();

document.getElementById('navbar-logo').addEventListener('error', function() {
  this.style.display = 'none';
});

// ── Detect recovery mode from URL hash ──────────────────────────────────────
function getHashParams() {
  const hash = window.location.hash.substring(1);
  return Object.fromEntries(new URLSearchParams(hash));
}

const params = getHashParams();
if (params.type === 'recovery' && params.access_token) {
  document.getElementById('step-request').style.display = 'none';
  document.getElementById('step-reset').style.display   = 'block';
  // Set the session from the recovery token so updateUser works
  supabase.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token || '' });
}

// ── Step 1: Send reset email ────────────────────────────────────────────────
window.sendReset = async function() {
  const email  = document.getElementById('email').value.trim();
  const btn    = document.getElementById('btn-send');
  const alertEl = document.getElementById('alert-request');

  alertEl.className = 'alert'; alertEl.style.display = 'none'; alertEl.textContent = '';

  if (!email) { showAlert(alertEl, 'error', 'Please enter your email address.'); return; }

  btn.disabled = true; btn.textContent = 'Sending…';

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/forgot-password.html'
  });

  btn.disabled = false; btn.textContent = 'Send Reset Link';

  if (error) {
    showAlert(alertEl, 'error', 'Could not send reset email. Please check the address and try again.');
  } else {
    showAlert(alertEl, 'success',
      '✓ Reset link sent! Check your inbox (and spam folder). The link expires in 1 hour.');
    document.getElementById('email').value = '';
  }
};

// ── Step 2: Update password ─────────────────────────────────────────────────
window.updatePassword = async function() {
  const pw      = document.getElementById('new-password').value;
  const confirm = document.getElementById('confirm-password').value;
  const btn     = document.getElementById('btn-update');
  const alertEl = document.getElementById('alert-reset');

  alertEl.className = 'alert'; alertEl.style.display = 'none'; alertEl.textContent = '';

  const pwCheck = validatePassword(pw);
  if (!pwCheck.valid) {
    showAlert(alertEl, 'error', pwCheck.message);
    document.getElementById('new-password').focus(); return;
  }
  if (pw !== confirm) {
    showAlert(alertEl, 'error', 'Passwords do not match.');
    document.getElementById('confirm-password').focus(); return;
  }
  if (isObviouslyWeak(pw)) {
    showAlert(alertEl, 'error', 'That password is too common or predictable. Please choose another.');
    document.getElementById('new-password').focus(); return;
  }

  btn.disabled = true; btn.textContent = 'Checking…';

  const pwned = await checkPasswordPwned(pw);
  if (pwned.pwned) {
    btn.disabled = false; btn.textContent = 'Update Password';
    showAlert(alertEl, 'error',
      `This password has appeared in ${pwned.count.toLocaleString()} known data breaches. Please choose a different one.`);
    document.getElementById('new-password').focus(); return;
  }

  btn.textContent = 'Updating…';

  const { error } = await supabase.auth.updateUser({ password: pw });

  btn.disabled = false; btn.textContent = 'Update Password';

  if (error) {
    showAlert(alertEl, 'error', 'Could not update password. The reset link may have expired. Please request a new one.');
  } else {
    showAlert(alertEl, 'success', '✓ Password updated successfully! Redirecting to sign in…');
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function showAlert(el, type, msg) {
  el.className = `alert ${type} show`;
  el.textContent = msg;
}

window.togglePw = function(inputId, btn) {
  const inp = document.getElementById(inputId);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
};

window.checkStrength = function(pw) {
  const fill  = document.getElementById('strength-fill');
  const label = document.getElementById('strength-label');
  const lvl = scorePasswordStrength(pw);
  fill.style.width      = lvl.pct;
  fill.style.background  = lvl.color;
  label.textContent     = lvl.label;
};

// Enter key on email field
document.getElementById('email').addEventListener('keydown', e => {
  if (e.key === 'Enter') window.sendReset();
});
document.getElementById('confirm-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') window.updatePassword();
});
