import { login } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';

// ── Watermark popup ───────────────────────────────────────────────────────────
const overlay = document.getElementById('ax-popup-overlay');
document.getElementById('ax-watermark').addEventListener('click', () => overlay.classList.add('show'));
document.getElementById('ax-popup-close').addEventListener('click', () => overlay.classList.remove('show'));
document.getElementById('ax-popup-learn').addEventListener('click', () => window.open('https://ayurxpert.com', '_blank', 'noopener'));
overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.classList.remove('show'); });

// ── Tenant branding ───────────────────────────────────────────────────────────
(async () => {
  const params = new URLSearchParams(window.location.search);
  const code   = (params.get('t') || params.get('org') || sessionStorage.getItem('pending_tenant_code') || '').toUpperCase().trim();
  if (!code) return;

  const { data: tenant } = await supabase
    .from('tenants')
    .select('name, logo_url, tagline, tenant_code')
    .eq('tenant_code', code)
    .eq('is_active', true)
    .maybeSingle();

  if (!tenant) return;

  sessionStorage.setItem('pending_tenant_code', tenant.tenant_code);

  // Show tenant branding block above card
  const logoWrap = document.getElementById('tenant-logo-wrap');
  if (tenant.logo_url) {
    const img = document.createElement('img');
    img.src = tenant.logo_url;
    img.alt = tenant.name;
    img.className = 'tenant-logo-img';
    logoWrap.appendChild(img);
  } else {
    const letter = document.createElement('div');
    letter.className = 'tenant-logo-letter';
    letter.textContent = tenant.name.charAt(0).toUpperCase();
    logoWrap.appendChild(letter);
  }
  document.getElementById('tenant-name-text').textContent = tenant.name;
  if (tenant.tagline) {
    const tEl = document.getElementById('tenant-tagline-text');
    tEl.textContent = tenant.tagline;
    tEl.style.display = '';
  }
  document.getElementById('tenant-block').classList.add('show');

  // Update card text and links
  document.getElementById('card-subtitle').textContent = `Sign in to ${tenant.name}`;
  document.getElementById('action-btns-default').style.display = 'none';
  document.getElementById('action-btns-tenant').style.display  = '';
  document.getElementById('signup-link-tenant').href = `signup.html?t=${tenant.tenant_code}`;
  document.title = `${tenant.name} — Sign In`;
})();

// ── Login form (two-step) ─────────────────────────────────────────────────────
const emailEl    = document.getElementById('email');
const passwordEl = document.getElementById('password');
const btnContinue = document.getElementById('btn-continue');
const btnLogin    = document.getElementById('btn-login');
let _verifiedEmail = '';

// Toggle password visibility
document.getElementById('toggle-pw').addEventListener('click', () => {
  const isText = passwordEl.type === 'text';
  passwordEl.type = isText ? 'password' : 'text';
  document.getElementById('toggle-pw').innerHTML = isText ? '&#128065;' : '&#128584;';
});

function clearAlerts() {
  ['alert-error','alert-warning','alert-info'].forEach(id => document.getElementById(id).classList.remove('show'));
  emailEl.classList.remove('error');
  passwordEl.classList.remove('error');
}

function showAlert(message) {
  clearAlerts();
  if (message.includes('pending') || message.includes('approved') || message.includes('department access')) {
    document.getElementById('alert-warning-text').textContent = message;
    document.getElementById('alert-warning').classList.add('show');
    return;
  }
  if (message.includes('email') && message.includes('confirm')) {
    document.getElementById('alert-info-text').textContent = message;
    document.getElementById('alert-info').classList.add('show');
    return;
  }
  document.getElementById('alert-error-text').textContent = message;
  document.getElementById('alert-error').classList.add('show');
}

function _setLoading(btn, on) {
  btn.classList.toggle('loading', on);
  btn.disabled = on;
}

// ── STEP 1: Email → Continue ──────────────────────────────────────────────────
btnContinue.addEventListener('click', handleContinue);
emailEl.addEventListener('keydown', e => { if (e.key === 'Enter') handleContinue(); });
emailEl.addEventListener('input', clearAlerts);

async function handleContinue() {
  clearAlerts();
  const email = emailEl.value.trim();
  if (!email) { showAlert('Please enter your email address.'); emailEl.focus(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAlert('Please enter a valid email address.'); emailEl.focus(); return;
  }

  _setLoading(btnContinue, true);
  const { data, error } = await supabase.rpc('get_profile_by_email', { p_email: email });
  _setLoading(btnContinue, false);

  // Normalise: RPC can return null / {} / [] / [{...}] depending on Postgres return type
  const profile = Array.isArray(data) ? data[0] : data;
  const registered = !error && profile && profile.role;

  if (!registered) {
    showAlert('This email is not registered with AyurXpert. Please use the "Join as staff" link below to request access.');
    emailEl.focus();
    return;
  }

  _verifiedEmail = email;
  // Sync hidden username field so browser fills the right saved password for this email
  document.getElementById('username-hint').value = email;
  // Clear any stale autofill from a previous user's saved credentials
  passwordEl.value = '';
  // Show email only — role/name not shown to limit data disclosure
  document.getElementById('role-name-display').textContent = email;
  document.getElementById('step-email').style.display    = 'none';
  document.getElementById('step-password').style.display = '';
  passwordEl.focus();
}

// ── STEP 2: Change email ──────────────────────────────────────────────────────
document.getElementById('btn-change-email').addEventListener('click', () => {
  _verifiedEmail = '';
  clearAlerts();
  passwordEl.value = '';
  document.getElementById('username-hint').value = '';
  document.getElementById('step-password').style.display = 'none';
  document.getElementById('step-email').style.display    = '';
  emailEl.focus();
});

// ── STEP 2: Sign In ───────────────────────────────────────────────────────────
btnLogin.addEventListener('click', handleLogin);
passwordEl.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
passwordEl.addEventListener('input', clearAlerts);

async function handleLogin() {
  clearAlerts();
  const password = passwordEl.value;
  if (!password) { showAlert('Please enter your password.'); passwordEl.focus(); return; }
  _setLoading(btnLogin, true);
  const result = await login({ email: _verifiedEmail, password });
  _setLoading(btnLogin, false);
  if (!result.success) {
    const msg = result.error || '';
    if (msg.includes('pending') || msg.includes('approved') || msg.includes('department access') || msg.includes('suspended') || msg.includes('not approved')) {
      showAlert(msg);
    } else if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many') || msg.includes('429')) {
      showAlert('Too many failed attempts. Please wait a few minutes, then try again. If the issue persists, contact your administrator.');
    } else if (msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('failed to') || msg.toLowerCase().includes('connect')) {
      showAlert('Connection error. Please check your internet connection and try again.');
    } else {
      showAlert('Invalid email or password. Please try again.');
    }
    passwordEl.classList.add('error');
  }
}
