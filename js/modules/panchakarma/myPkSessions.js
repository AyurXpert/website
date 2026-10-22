// Session 353B B17 (TODO §248, owner 21 / 22 Oct 2026): doctor.html "🌸 PK" queue tab -- the Panchakarma sessions of the doctor's OWN
// patients: the doctor ordered the session, or the care plan is theirs, or the patient's OPD visit / admission is theirs (owner decision
// 6, 22 Oct 2026; the department-wide view comes with §249). Display only, plus "🩺 Give clearance" for a non-trainee doctor (the server
// decides -- B5). Reads are organisation-wide today (every doctor can already see PK sessions on therapist.html); the "my patients"
// filter is this page's, until §249 makes reads care-team based on the server.
// Built from DOM nodes + textContent (no data in HTML strings).
import { todayISTStr } from '../../utils/dateUtils.js';
import { notify } from '../../components/notify.js';
import { givePkClearance } from './pkClearance.js';

let _ctx = null;
let _range = 'today';
let _token = 0;

const STATUS = { scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled' };
const PHASE = { purvakarma: 'Purvakarma', pradhanakarma: 'Pradhana karma', paschatkarma: 'Paschat karma' };

function _addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function _fmtDate(ymd) {
  return ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
}
function _fmtTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function resetMyPkSessions() { _token++; }

export function loadMyPkSessions({ supabase, tenantId, userId, canClear }) {
  _ctx = { supabase, tenantId, userId, canClear: !!canClear };
  _range = 'today';
  return _render();
}

window.myPkRange = (r) => { _range = r === 'week' ? 'week' : 'today'; _render(); };
window.myPkGiveClearance = async (id) => {
  if (!_ctx?.canClear) return;
  const r = await givePkClearance(_ctx.supabase, id);
  notify(r.message, r.ok ? 'success' : 'error');
  if (r.ok) _render();
};

function _filterBar() {
  const bar = _el('div', 'pk-tab-bar');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Which days');
  [['today', 'Today'], ['week', 'Next 7 days']].forEach(([k, label]) => {
    const b = _el('button', 'pk-tab-range' + (_range === k ? ' active' : ''), label);
    b.type = 'button';
    b.dataset.onclick = 'myPkRange'; b.dataset.onclickA0 = k;
    b.setAttribute('aria-pressed', String(_range === k));
    bar.appendChild(b);
  });
  return bar;
}

function _card(s) {
  const p = s.patients || {};
  const card = _el('div', 'q-card pk-tab-card');
  const top = _el('div', 'q-card-top');
  top.appendChild(_el('div', 'q-token pk-tab-time', _fmtTime(s.scheduled_time) || '—'));
  top.appendChild(_el('div', 'q-name', p.name || '—'));
  top.appendChild(_el('div', 'q-wait', _fmtDate(s.scheduled_date)));
  card.appendChild(top);
  const ageGender = [p.age ? `${p.age}y` : null, p.gender ? String(p.gender)[0].toUpperCase() : null].filter(Boolean).join('/');
  card.appendChild(_el('div', 'q-meta pk-tab-meta', [p.uhid, ageGender].filter(Boolean).join(' · ') || '—'));
  card.appendChild(_el('div', 'q-complaint', [s.therapy_name || 'PK session', PHASE[s.therapy_phase] || s.therapy_phase].filter(Boolean).join(' — ')));
  const extra = (s.pk_therapy_session_therapists || []).length;
  const who = [s.therapist?.full_name ? 'Therapist: ' + s.therapist.full_name + (extra ? ` +${extra}` : '') : 'Therapist: not assigned',
    s.pk_treatment_rooms?.room_name ? 'Room: ' + s.pk_treatment_rooms.room_name : (s.therapy_room_number ? 'Room: ' + s.therapy_room_number : null)].filter(Boolean).join(' · ');
  card.appendChild(_el('div', 'pk-tab-line', who));
  const st = _el('div', 'pk-tab-line');
  st.appendChild(_el('span', 'pk-tab-status pk-st-' + (s.status || 'scheduled'), STATUS[s.status] || s.status || '—'));
  card.appendChild(st);
  const cl = _el('div', 'pk-tab-line pk-tab-clear');
  if (s.doctor_clearance) {
    cl.appendChild(_el('span', 'pk-tab-cleared', '✓ Cleared' + (s.cleared_by?.full_name ? ' by ' + s.cleared_by.full_name : '')));
  } else {
    cl.appendChild(_el('span', 'pk-tab-notcleared', 'Clearance: not yet given'));
    if (_ctx.canClear && !['completed', 'skipped', 'cancelled'].includes(s.status)) {
      const b = _el('button', 'pk-tab-clear-btn', '🩺 Give clearance');
      b.type = 'button';
      b.title = 'Give the PK fitness clearance (doctor, NCISM §47(vii))';
      b.dataset.onclick = 'myPkGiveClearance'; b.dataset.onclickA0 = s.id;
      cl.appendChild(b);
    }
  }
  card.appendChild(cl);
  return card;
}

async function _render() {
  const list = document.getElementById('q-list');
  if (!list || !_ctx) return;
  const token = ++_token;
  const { supabase, tenantId, userId } = _ctx;
  list.replaceChildren(_filterBar(), Object.assign(_el('div', 'q-empty'), { textContent: 'Loading…' }));
  const from = todayISTStr();
  const to = _range === 'week' ? _addDays(from, 6) : from;
  const [plansR, sessR] = await Promise.all([
    supabase.from('pk_care_plans').select('visit_id, ipd_admission_id').eq('tenant_id', tenantId).eq('doctor_id', userId),
    supabase.from('pk_therapy_sessions').select(`id, therapy_name, therapy_phase, scheduled_date, scheduled_time, status, doctor_clearance,
        visit_id, ipd_admission_id, ordering_doctor_id, therapy_room_number,
        patients(id, name, uhid, age, gender), therapist:profiles!therapist_id(full_name), cleared_by:profiles!clearance_by(full_name),
        visits!visit_id(doctor_id), ipd_admissions!ipd_admission_id(admitting_doctor_id), pk_treatment_rooms(room_name), pk_therapy_session_therapists(id)`)
      .eq('tenant_id', tenantId).gte('scheduled_date', from).lte('scheduled_date', to)
      .order('scheduled_date').order('scheduled_time', { nullsFirst: false }),
  ]);
  if (token !== _token) return;
  const err = plansR.error || sessR.error;
  if (err) {
    list.replaceChildren(_filterBar(), Object.assign(_el('div', 'q-empty'), { textContent: "Couldn't load the PK sessions. Refresh and try again." }));
    console.warn('[pk tab]', err.message);
    return;
  }
  const planVisits = new Set((plansR.data || []).map(r => r.visit_id).filter(Boolean));
  const planAdms = new Set((plansR.data || []).map(r => r.ipd_admission_id).filter(Boolean));
  const mine = (sessR.data || []).filter(s => s.ordering_doctor_id === userId || s.visits?.doctor_id === userId
    || s.ipd_admissions?.admitting_doctor_id === userId || (s.visit_id && planVisits.has(s.visit_id)) || (s.ipd_admission_id && planAdms.has(s.ipd_admission_id)));
  const nodes = [_filterBar()];
  if (!mine.length) {
    nodes.push(Object.assign(_el('div', 'q-empty'), { textContent: _range === 'week' ? 'No PK sessions for your patients in the next 7 days.' : 'No PK sessions for your patients today.' }));
  } else {
    const pending = mine.filter(s => !s.doctor_clearance && !['completed', 'skipped', 'cancelled'].includes(s.status)).length;
    nodes.push(_el('div', 'pk-tab-summary', `${mine.length} session${mine.length === 1 ? '' : 's'}` + (pending ? ` · ${pending} awaiting clearance` : '')));
    mine.forEach(s => nodes.push(_card(s)));
  }
  list.replaceChildren(...nodes);
}
