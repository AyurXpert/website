// office.html -- Session 362 (TODO §312): the home page of the Office Staff role. Links only; it reads no data (an office-only account
// is refused every table except its own rows and the view-only duty roster -- sql/session362_office_staff_role.sql).
import { requireAuth, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';

await requireAuth(['office_staff']);
initNavbar();

const _name = getCurrentProfile()?.full_name;
if (_name) document.getElementById('office-welcome').textContent = `Welcome, ${_name}.`;
