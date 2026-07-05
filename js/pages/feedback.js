import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

const params  = new URLSearchParams(window.location.search);
const visitId = params.get('visit') || null;

// ── Star ratings state ────────────────────────────────────────────
const RATING_KEYS  = ['overall','doctor','staff','facility','wait_time'];
const RATING_HINTS = {
  1: 'Very poor',
  2: 'Poor',
  3: 'Average',
  4: 'Good',
  5: 'Excellent',
};
const _ratings = { overall:0, doctor:0, staff:0, facility:0, wait_time:0 };
let _recommend = null;

function _buildStars(containerEl, key) {
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('span');
    s.className = 'star';
    s.textContent = '★';
    s.dataset.val = i;
    s.addEventListener('mouseenter', () => _hoverStars(containerEl, key, i));
    s.addEventListener('mouseleave', () => _hoverStars(containerEl, key, _ratings[key]));
    s.addEventListener('click',      () => _selectStar(containerEl, key, i));
    s.addEventListener('touchstart', (e) => { e.preventDefault(); _selectStar(containerEl, key, i); }, { passive:false });
    containerEl.appendChild(s);
  }
}

function _hoverStars(container, key, val) {
  const stars = container.querySelectorAll('.star');
  stars.forEach((s, idx) => {
    s.classList.toggle('hover', idx < val);
    s.classList.toggle('selected', false);
  });
  const hint = document.getElementById(`hint-${key}`);
  if (hint) hint.textContent = val > 0 ? RATING_HINTS[val] : '';
}

function _selectStar(container, key, val) {
  _ratings[key] = val;
  const stars = container.querySelectorAll('.star');
  stars.forEach((s, idx) => {
    s.classList.toggle('selected', idx < val);
    s.classList.toggle('hover', false);
  });
  const hint = document.getElementById(`hint-${key}`);
  if (hint) hint.textContent = RATING_HINTS[val];
}

window.setRecommend = function(val) {
  _recommend = val;
  document.getElementById('rec-yes').className = 'rec-btn' + (val === true  ? ' active-yes' : '');
  document.getElementById('rec-no').className  = 'rec-btn' + (val === false ? ' active-no'  : '');
};

// ── Load visit info ───────────────────────────────────────────────
async function init() {
  if (!visitId) { _showInvalid(); return; }

  // SECURITY DEFINER RPC — visits/patient_feedback RLS requires an authenticated
  // session, but this page is a public, unauthenticated patient feedback form.
  const { data, error } = await supabase.rpc('get_visit_feedback_info', { p_visit_id: visitId });
  const info = data?.[0];

  if (error || !info || !info.tenant_id) { _showInvalid(); return; }

  if (info.already_submitted) { _showAlreadySubmitted(); return; }

  // Show form
  document.getElementById('form-view').style.display = '';

  // Show visit strip
  const strip     = document.getElementById('visit-strip');
  const dateLabel = document.getElementById('visit-date-lbl');
  const docLabel  = document.getElementById('visit-doctor-lbl');
  if (info.visit_date) {
    const d = new Date(info.visit_date);
    dateLabel.textContent = d.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
  }
  if (info.doctor_name) {
    docLabel.textContent = 'Dr. ' + info.doctor_name;
    strip.style.display = '';
  }

  // Build star widgets
  RATING_KEYS.forEach(key => {
    const containerId = `stars-${key === 'wait_time' ? 'wait' : key}`;
    const el = document.getElementById(containerId);
    if (el) _buildStars(el, key);
  });
}

// ── Submit ────────────────────────────────────────────────────────
window.submitFeedback = async function() {
  clearError();
  if (!_ratings.overall) return showError('Please rate your overall experience.');

  const btn = document.getElementById('btn-submit');
  btn.classList.add('loading');
  btn.disabled = true;

  const { error } = await supabase.rpc('submit_patient_feedback', {
    p_visit_id:          visitId,
    p_overall_rating:    _ratings.overall   || null,
    p_doctor_rating:     _ratings.doctor    || null,
    p_staff_rating:      _ratings.staff     || null,
    p_facility_rating:   _ratings.facility  || null,
    p_wait_time_rating:  _ratings.wait_time || null,
    p_comments:          document.getElementById('fb-comments').value.trim() || null,
    p_would_recommend:   _recommend,
  });

  if (error) {
    showError('Could not save feedback. Please try again.');
    btn.classList.remove('loading');
    btn.disabled = false;
    return;
  }

  document.getElementById('form-view').style.display = 'none';
  document.getElementById('success-screen').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ── Helpers ───────────────────────────────────────────────────────
function _showInvalid() {
  document.getElementById('invalid-screen').style.display = 'block';
}

function _showAlreadySubmitted() {
  const el = document.getElementById('invalid-screen');
  el.querySelector('.invalid-title').textContent = 'Already Submitted';
  el.querySelector('.invalid-body').innerHTML =
    'Feedback for this visit has already been recorded.<br/><br/>Thank you for helping us improve patient care!';
  el.style.display = 'block';
}

function showError(msg) {
  document.getElementById('alert-error-text').textContent = msg;
  document.getElementById('alert-error').classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function clearError() {
  document.getElementById('alert-error').classList.remove('show');
}

init();
