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

// Registration/Admission/Billing are the cash-handling counters (per the shared-pool
// research Dr. Venkatesh brought Session 111) -- the drawer field only makes sense there.
const CASH_HANDLING_DUTIES = ['registration', 'admission', 'billing'];

// The 5 real, storable duty values. 'all_duties' is not one of them -- it's a UI-only
// shortcut button that selects/deselects all 5 (Session 113: a clerk needs to pick an
// arbitrary subset, e.g. just Registration + Billing, not just "one" or "literally all"),
// so what actually gets stored is always the concrete list, never a sentinel.
const ALL_DUTY_KEYS = ['registration', 'admission', 'discharge', 'insurance', 'billing'];

document.getElementById('user-name').textContent = profile.full_name || 'Staff';
document.getElementById('user-designation').textContent = DESIGNATION_LABELS[profile.designation] || 'Receptionist';

// Open-redirect guard (Semgrep javascript.browser.security.open-redirect.js-open-redirect,
// caught in CI) -- ?return= is attacker-controlled input from the URL, so it must be
// checked against a fixed allowlist before ever reaching window.location, not passed
// through as-is. Only ever set to 'reception.html' by this app today, but a future page
// might legitimately want to send a gated user back to a different page after they pick
// a duty, hence the (short) list rather than a single hardcoded value.
const RETURN_ALLOWLIST = ['reception.html'];
const _returnParam = new URLSearchParams(window.location.search).get('return');
const returnTo = RETURN_ALLOWLIST.includes(_returnParam) ? _returnParam : 'reception.html';

const _selected = new Set();

function _syncDutyButtons() {
  document.querySelectorAll('.duty-btn[data-onclick-a1]').forEach(b => {
    const key = b.getAttribute('data-onclick-a1');
    const isSelected = key === 'all_duties' ? ALL_DUTY_KEYS.every(k => _selected.has(k)) : _selected.has(key);
    b.classList.toggle('selected', isSelected);
  });
  const anyCash = [..._selected].some(k => CASH_HANDLING_DUTIES.includes(k));
  document.getElementById('drawer-field').classList.toggle('show', anyCash);
  document.getElementById('btn-confirm').disabled = _selected.size === 0;
}

window.selectDuty = function(btn, duty) {
  if (duty === 'all_duties') {
    // Toggle-all shortcut, not a stored value -- if everything is already selected,
    // clicking it again clears the board rather than being a no-op dead click.
    const allSelected = ALL_DUTY_KEYS.every(k => _selected.has(k));
    if (allSelected) _selected.clear();
    else ALL_DUTY_KEYS.forEach(k => _selected.add(k));
  } else if (_selected.has(duty)) {
    _selected.delete(duty);
  } else {
    _selected.add(duty);
  }
  _syncDutyButtons();
};

window.confirmDuty = async function() {
  if (_selected.size === 0) return;
  const btn = document.getElementById('btn-confirm');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  const drawerId = document.getElementById('drawer-id').value.trim() || null;
  const dutyList = [..._selected];

  const { data, error } = await supabase.from('staff_duty_sessions').insert({
    tenant_id:      tenantId,
    profile_id:     profile.id,
    active_duty:    dutyList,
    cash_drawer_id: drawerId,
  }).select('id').single();

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Start Duty';
    alert(safeErrorMessage(error, 'Could not start your duty session. Please try again.'));
    return;
  }

  sessionStorage.setItem('ax_duty_session_id', data.id);
  sessionStorage.setItem('ax_duty_active', JSON.stringify(dutyList));
  // nosemgrep: javascript.browser.security.open-redirect.js-open-redirect -- returnTo is already validated against RETURN_ALLOWLIST above, not passed through raw
  window.location.replace(returnTo);
};
