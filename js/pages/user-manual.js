// user-manual.html -- moved out of the page in Session 384 (TODO §492) so the page can carry a strict Content-Security-Policy
// (no inline script). Still no requireAuth / no database: the manual stays readable signed out. Two parts, as before:
// 1. the role-scoped landing (Session 167); 2. the scroll-spy that highlights the active nav link.

import { ROLE_DUTY_FALLBACK } from '../config/designations.js';

// Which roles have a REAL dedicated section to jump to. Deliberately small -- most roles below
// still have no matching content (see MEMORY.md session167_* notes) and gracefully fall back to
// the full manual rather than a fabricated or misleading match. super_admin/dept_admin are
// deliberately excluded -- confirmed no single "admin" section exists; the setup steps +
// reports + dashboard + purchase sections are ALL written for them, so the existing default
// (land at the top, nothing scoped away) is already correct for those two roles.
const ROLE_SECTION = {
  doctor: 'doctor',
  trainee_doctor: 'role-intern',
  nurse: 'role-screener',
  receptionist: 'reception',
  pharmacist: 'dispensary',
  nurse_manager: 'nursing-admin',
  therapist: 'therapy',
  accountant: 'reports',
  store_keeper: 'role-store',   // Session 386c
};
const ROLE_LABEL = {
  super_admin: 'Super Admin', dept_admin: 'Dept Admin', doctor: 'Doctor',
  trainee_doctor: 'PG Scholar / Intern', receptionist: 'Receptionist', pharmacist: 'Pharmacist',
  nurse: 'Nurse', nurse_manager: 'Nursing Superintendent', lab_tech: 'Lab Technician',
  accountant: 'Accountant', cashier: 'Cashier', finance_manager: 'Finance Manager',
  therapist: 'Therapist', student: 'Student', diet_staff: 'Diet / Pathya Staff', mrd_staff: 'Medical Records Staff', store_keeper: 'Store Keeper (General Store)',   // Session 386c
};

// ?role= (set by navbar.js's Help/User Guide links, which already know the logged-in role) takes
// priority -- it also doubles as the deliberate override anyone can type by hand (?role=doctor).
// sessionStorage is a same-tab-only fallback: navbar.js's links open in a new tab via
// rel="noopener", and per the HTML spec that puts the new tab in a fresh browsing-context group
// with its OWN empty sessionStorage -- it does not inherit the opener's, so ?role= is the signal
// that actually works for the real "open in a new tab" click path; sessionStorage only helps
// someone who bookmarked/typed this URL directly in an already-logged-in tab.
const params = new URLSearchParams(location.search);
const role = params.get('role') || sessionStorage.getItem('ayurxpert_role') || null;

// ?role= is attacker-controllable (anyone can type any string into the URL), so its fallback
// label (ROLE_LABEL[role] || role -- the raw value when it doesn't match a known role) must never
// go into innerHTML unescaped, same house rule as every other page's free-text interpolation.
function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function roleBanner() {
  const el = document.getElementById('role-banner');
  const label = role ? _esc(ROLE_LABEL[role] || role) : null;
  const sectionId = role ? ROLE_SECTION[role] : null; // always one of ROLE_SECTION's own hardcoded values, or undefined -- never raw `role` text

  const pickerOptions = Object.keys(ROLE_DUTY_FALLBACK)
    .sort((a, b) => (ROLE_LABEL[a] || a).localeCompare(ROLE_LABEL[b] || b))
    .map(r => `<option value="${_esc(r)}"${r === role ? ' selected' : ''}>${_esc(ROLE_LABEL[r] || r)}</option>`).join('');
  const picker = `<select id="role-picker" style="margin-left:10px;padding:4px 8px;border-radius:6px;border:1.5px solid var(--border);font-size:12.5px;font-family:'DM Sans',sans-serif;background:#fff">
    <option value="">— Jump to another role's section —</option>${pickerOptions}
  </select>`;

  if (!role || role === 'super_admin' || role === 'dept_admin') {
    el.className = 'note no-print';   // screen-only helper, never printed
    el.innerHTML = `Showing the full manual.${picker}`;
  } else if (sectionId) {
    el.className = 'note no-print';   // screen-only helper, never printed
    el.innerHTML = `👋 Showing the <strong>${label}</strong> guide (your role) — or <a href="#overview" style="color:inherit;font-weight:600">📖 view the full manual</a> from the top.${picker}`;
    requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else {
    el.className = 'warn';
    el.innerHTML = `ℹ️ There's no dedicated guide section for <strong>${label}</strong> yet — showing the full manual instead.${picker}`;
  }
  el.style.display = '';
  document.getElementById('role-picker')?.addEventListener('change', e => {
    location.href = e.target.value ? `user-manual.html?role=${encodeURIComponent(e.target.value)}` : 'user-manual.html';
  });
}
roleBanner();

// Highlight active nav link on scroll
const links = document.querySelectorAll('.nav-link');
const sections = document.querySelectorAll('.section');
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      links.forEach(l => l.classList.remove('active'));
      const active = document.querySelector(`.nav-link[href="#${e.target.id}"]`);
      if (active) active.classList.add('active');
    }
  });
}, { rootMargin: '-20% 0px -60% 0px' });
sections.forEach(s => observer.observe(s));
