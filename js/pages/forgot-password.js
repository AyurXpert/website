import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

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

  if (pw.length < 8) {
    showAlert(alertEl, 'error', 'Password must be at least 8 characters.');
    document.getElementById('new-password').focus(); return;
  }
  if (pw !== confirm) {
    showAlert(alertEl, 'error', 'Passwords do not match.');
    document.getElementById('confirm-password').focus(); return;
  }

  btn.disabled = true; btn.textContent = 'Updating…';

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
  let score = 0;
  if (pw.length >= 8)  score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const levels = [
    { w: '0%',   bg: 'transparent', text: '' },
    { w: '25%',  bg: '#ef4444',     text: 'Weak' },
    { w: '50%',  bg: '#f59e0b',     text: 'Fair' },
    { w: '75%',  bg: '#3b82f6',     text: 'Good' },
    { w: '100%', bg: '#22c55e',     text: 'Strong' },
  ];
  const lvl = levels[score];
  fill.style.width      = lvl.w;
  fill.style.background = lvl.bg;
  label.textContent     = lvl.text;
};

// Enter key on email field
document.getElementById('email').addEventListener('keydown', e => {
  if (e.key === 'Enter') window.sendReset();
});
document.getElementById('confirm-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') window.updatePassword();
});
