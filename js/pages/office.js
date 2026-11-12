// office.html -- Session 362 (TODO §312): the home page of the Office Staff role. Links only; it reads no data (an office-only account
// is refused every table except its own rows and the view-only duty roster -- sql/session362_office_staff_role.sql).
import { requireAuth, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';

// Session 386c (owner 12 Nov 2026, option A): + store_keeper -- the GENERAL store keeper; the general store is not in AyurXpert yet
await requireAuth(['office_staff', 'store_keeper']);
initNavbar();

const _name = getCurrentProfile()?.full_name;
if (_name) document.getElementById('office-welcome').textContent = `Welcome, ${_name}.`;

// the store keeper: its own title and the "no module yet" note; no duty-roster card (the store keeper has no roster page)
if (getCurrentProfile()?.role === 'store_keeper') {
  document.title = 'General Store — AyurXpert';
  document.querySelector('.page-banner h1').textContent = 'General Store';
  document.getElementById('store-note').hidden = false;
  document.getElementById('office-roster-card')?.remove();
  document.getElementById('office-role').textContent = 'Store Keeper';
}
