import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const DAYS      = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const TYPE_LABEL = {
  clinic:'Ayurveda Clinic', hospital:'Hospital', pk_center:'Panchakarma Centre',
  dispensary:'Dispensary', college:'Ayurveda College & Hospital',
  teaching_hospital:'Teaching Hospital', platform:'Platform'
};

const todayDow = new Date().getDay();

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2,'0')} ${ampm}`;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

document.getElementById('btn-copy-link').addEventListener('click', () => {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast('Link copied to clipboard!'))
    .catch(() => showToast('Could not copy — please copy the URL manually'));
});

function showError(title, msg) {
  document.getElementById('org-name').textContent = 'AyurXpert';
  document.getElementById('org-type').textContent = '';
  document.getElementById('today-banner').style.display = 'none';
  document.getElementById('err-title').textContent = title;
  document.getElementById('err-msg').textContent = msg;
  document.getElementById('error-state').style.display = '';
}

function renderDoctors(slots) {
  const grid = document.getElementById('doctors-grid');

  if (!slots || slots.length === 0) {
    grid.innerHTML = `
      <div class="empty-grid">
        <div class="empty-ico">📡</div>
        <div class="empty-title">No schedules configured yet</div>
        <div class="empty-sub">Please contact the reception for teleconsultation availability</div>
      </div>`;
    return;
  }

  // Group slots by doctor name
  const doctors = {};
  for (const s of slots) {
    if (!doctors[s.doctor_name]) doctors[s.doctor_name] = [];
    doctors[s.doctor_name].push(s);
  }

  grid.innerHTML = '';

  for (const [name, dslots] of Object.entries(doctors)) {
    dslots.sort((a, b) => a.day_of_week - b.day_of_week);
    const hasToday = dslots.some(s => s.day_of_week === todayDow);

    const slotsHtml = dslots.map(s => `
      <div class="slot-row">
        <span class="day-chip ${s.day_of_week === todayDow ? 'is-today' : 'not-today'}">${DAYS[s.day_of_week]}</span>
        <span class="slot-time">${fmtTime(s.start_time)} – ${fmtTime(s.end_time)}</span>
        <span class="slot-max">${s.max_patients} slot${s.max_patients !== 1 ? 's' : ''}</span>
      </div>`).join('');

    const card = document.createElement('div');
    card.className = `doc-card${hasToday ? ' available-today' : ''}`;
    card.innerHTML = `
      <div class="doc-card-head">
        <div class="doc-avatar">👨‍⚕️</div>
        <div>
          <div class="doc-name">${_esc(name)}</div>
          <div class="doc-avail ${hasToday ? 'today-yes' : ''}">
            ${hasToday ? '✓ Available today' : `${dslots.length} day${dslots.length !== 1 ? 's' : ''} per week`}
          </div>
        </div>
      </div>
      <div class="doc-slots">${slotsHtml}</div>`;
    grid.appendChild(card);
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('tenant') || '').trim().toUpperCase();

  if (!code) {
    showError('No Organisation Specified',
      'Please use a link in the format:\nconsultant-availability.html?tenant=YOUR_CODE\n\nContact AyurXpert support if you need help.');
    return;
  }

  // Load tenant (anon access already granted on tenants table)
  const { data: tenant } = await supabase
    .from('tenants')
    .select('name, type, tagline, is_active')
    .eq('tenant_code', code)
    .single();

  if (!tenant || !tenant.is_active) {
    showError('Organisation Not Found',
      `No active organisation found with code "${code}". Please check the link or contact AyurXpert support.`);
    return;
  }

  document.getElementById('org-name').textContent = tenant.name;
  document.getElementById('org-type').textContent = TYPE_LABEL[tenant.type] || tenant.type;
  document.getElementById('footer-org').textContent = tenant.name;
  document.title = `Teleconsultation — ${tenant.name}`;

  if (tenant.tagline) {
    const el = document.getElementById('org-tagline');
    el.textContent = `"${tenant.tagline}"`;
    el.style.display = '';
  }

  document.getElementById('today-banner').textContent =
    `📅 Today is ${DAYS_FULL[todayDow]} — slots available today are highlighted in green`;

  // Load availability via RPC (SECURITY DEFINER — safe for anon)
  const { data: slots, error } = await supabase
    .rpc('get_consultant_availability', { p_tenant_code: code });

  if (error) {
    showError('Unable to Load Schedule',
      'Could not retrieve the consultation schedule at this time. Please try again later or contact the reception.');
    console.error('get_consultant_availability:', error.message);
    return;
  }

  document.getElementById('main-page').style.display = '';
  renderDoctors(slots);
}

init();
