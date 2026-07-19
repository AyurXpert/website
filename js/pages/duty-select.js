import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['receptionist']);
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();

const DESIGNATION_LABELS = {
  receptionist:       'Receptionist',
  registration_clerk: 'Registration Clerk',
  billing_clerk:      'Billing Clerk',
};

const DUTY_LABELS = {
  registration: 'Registration Counter',
  admission:    'Admission Counter',
  discharge:    'Discharge Counter',
  insurance:    'Insurance Counter',
  billing:      'Billing Counter',
  all_duties:   'All Duties',
};

// Registration/Admission/Billing are the cash-handling counters (per the shared-pool
// research Dr. Venkatesh brought Session 111) -- the drawer field only makes sense there.
const CASH_HANDLING_DUTIES = ['registration', 'admission', 'billing', 'all_duties'];

document.getElementById('user-name').textContent = profile.full_name || 'Staff';
document.getElementById('user-designation').textContent = DESIGNATION_LABELS[profile.designation] || 'Receptionist';

const returnTo = new URLSearchParams(window.location.search).get('return') || 'reception.html';

let _selected = null;

window.selectDuty = function(btn, duty) {
  document.querySelectorAll('.duty-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  _selected = duty;
  document.getElementById('drawer-field').classList.toggle('show', CASH_HANDLING_DUTIES.includes(duty));
  document.getElementById('btn-confirm').disabled = false;
};

window.confirmDuty = async function() {
  if (!_selected) return;
  const btn = document.getElementById('btn-confirm');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  const drawerId = document.getElementById('drawer-id').value.trim() || null;

  const { data, error } = await supabase.from('staff_duty_sessions').insert({
    tenant_id:      tenantId,
    profile_id:     profile.id,
    active_duty:    _selected,
    cash_drawer_id: drawerId,
  }).select('id').single();

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Start Duty';
    alert(safeErrorMessage(error, 'Could not start your duty session. Please try again.'));
    return;
  }

  sessionStorage.setItem('ax_duty_session_id', data.id);
  sessionStorage.setItem('ax_duty_active', _selected);
  window.location.replace(returnTo);
};
