import { supabase } from '../core/db/supabaseClient.js';
import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';
import { notify } from '../components/notify.js';
import { loadFees, fillFeeSelect, feeIdOf } from '../modules/billing/feeSelect.js';   // Session 386b-2a
import { mountTodaysSittings } from '../modules/scheduler/todaysSittings.js';   // Session 391 T1a-2

await requireAuth(['super_admin','dept_admin','doctor','nurse']);
initNavbar();
wireDelegatedEvents();

const tenantId  = getCurrentTenantId();
const profile   = getCurrentProfile();
const userId    = profile?.id;

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

let _cases      = [];
let _activeFilter = 'active';
let _activeSessionId = null;
let _foundPatient    = null;
let _sitting = null;   // Session 391 T1a-2: the started sitting being recorded (1 = the application / course, 2.. = a thread change)

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadCases() {
  const { data, error } = await supabase
    .from('ks_sessions')
    .select(`
      id, condition, thread_type, start_date, status, notes, planned_sittings, created_at, procedure_sitting_id,
      patients(id, name, phone),
      profiles!doctor_id(full_name),
      ks_thread_changes(id, sitting_no, change_date, thread_length_cm, findings, next_date)
    `)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to load cases.')); return; }
  _cases = (data || []).map(c => ({
    ...c,
    changes: (c.ks_thread_changes || []).sort((a,b) => a.sitting_no - b.sitting_no)
  }));
  // Session 391 T1a-2 F6 (owner rehearsal, 24 Nov 2026): a case registered from a doctor's order follows the ORDER's sittings -- the
  // application is sitting 1, the next date is the next booked sitting, the course completes when all are done (the server marks it)
  const first = _cases.map(c => c.procedure_sitting_id).filter(Boolean);
  if (first.length) {
    const { data: s1 } = await supabase.from('procedure_sittings').select('id, treatment_order_id').in('id', first);
    const orderOf = new Map((s1 || []).map(x => [x.id, x.treatment_order_id]));
    const orders = [...new Set([...orderOf.values()])];
    const { data: all } = orders.length
      ? await supabase.from('procedure_sittings').select('treatment_order_id, sitting_no, status, scheduled_date, scheduled_time').in('treatment_order_id', orders)
      : { data: [] };
    for (const c of _cases) {
      const oid = orderOf.get(c.procedure_sitting_id);
      if (!oid) continue;
      const mine = (all || []).filter(x => x.treatment_order_id === oid);
      const live = mine.filter(x => ['held', 'scheduled', 'in_progress', 'completed', 'missed'].includes(x.status));
      const next = mine.filter(x => ['held', 'scheduled'].includes(x.status) && x.scheduled_date)
        .sort((a, b) => `${a.scheduled_date} ${a.scheduled_time || ''}`.localeCompare(`${b.scheduled_date} ${b.scheduled_time || ''}`))[0];
      c.fromOrder = { done: mine.filter(x => x.status === 'completed').length, planned: live.length, next: next ? next.scheduled_date : null };
    }
  }
  renderStats();
  renderCards();
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats() {
  const today = _today();
  const active    = _cases.filter(c => c.status === 'active').length;
  const dueToday  = _cases.filter(c => c.status === 'active' && _nextDate(c) === today).length;
  const overdue   = _cases.filter(c => c.status === 'active' && _nextDate(c) && _nextDate(c) < today).length;
  const completed = _cases.filter(c => c.status === 'completed').length;
  document.getElementById('st-active').textContent    = active;
  document.getElementById('st-today').textContent     = dueToday;
  document.getElementById('st-overdue').textContent   = overdue;
  document.getElementById('st-completed').textContent = completed;
}

// ── Filter ────────────────────────────────────────────────────────────────────
window.setFilter = function(f, btn) {
  _activeFilter = f;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderCards();
};

// ── Render cards ──────────────────────────────────────────────────────────────
window.renderCards = function() {
  const today  = _today();
  const search = document.getElementById('ks-search').value.trim().toLowerCase();
  let list = _cases;

  if (search) list = list.filter(c => c.patients?.name?.toLowerCase().includes(search));

  if (_activeFilter === 'active')    list = list.filter(c => c.status === 'active');
  if (_activeFilter === 'completed') list = list.filter(c => c.status === 'completed');
  if (_activeFilter === 'due_today') list = list.filter(c => c.status === 'active' && _nextDate(c) === today);
  if (_activeFilter === 'overdue')   list = list.filter(c => c.status === 'active' && _nextDate(c) && _nextDate(c) < today);

  const grid = document.getElementById('ks-grid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">🔪</div>
      <div class="empty-title">No cases found</div>
      <div class="empty-desc">Register a new Kshara Sutra case to begin tracking.</div>
    </div>`;
    return;
  }

  grid.innerHTML = list.map(c => _buildCard(c, today)).join('');
};

function _buildCard(c, today) {
  const nd       = _nextDate(c);
  const sittings = c.fromOrder ? c.fromOrder.done : c.changes.length;   // F6: the order's sittings (the application = sitting 1)
  const planned  = c.fromOrder ? c.fromOrder.planned : (c.planned_sittings || 0);
  const pct      = planned ? Math.min(100, Math.round((sittings / planned) * 100)) : 0;
  const lastChange = c.changes.length ? c.changes[c.changes.length - 1] : null;

  let urgency = 'upcoming', chipText = 'No next date set', chipCls = 'none';
  if (c.status === 'completed') { urgency = 'completed'; chipText = 'Completed'; chipCls = 'none'; }
  else if (nd) {
    if (nd < today)      { urgency = 'overdue';   chipText = `Overdue — ${_daysAgo(nd)}d ago`;  chipCls = 'overdue'; }
    else if (nd === today){ urgency = 'due-today'; chipText = 'Due Today';                      chipCls = 'today'; }
    else                 { urgency = 'upcoming';   chipText = `Next: ${_fmtDate(nd)}`;           chipCls = 'upcoming'; }
  }

  const condLabel = { fistula_in_ano:'Fistula-in-Ano', haemorrhoids:'Haemorrhoids', fissure:'Fissure', pilonidal_sinus:'Pilonidal Sinus', sentinel_tag:'Sentinel Tag', other:'Other' };

  return `<div class="ks-card ${urgency}">
    <div class="ks-card-hdr">
      <div>
        <div class="ks-pt-name">${_esc(c.patients?.name || '—')}</div>
        <div class="ks-pt-uhid">${_esc(c.patients?.phone || '')} · Started ${_fmtDate(c.start_date)}</div>
      </div>
      <span class="ks-condition">${condLabel[c.condition] || _esc(c.condition || '—')}</span>
    </div>
    <div class="ks-meta">
      <div class="ks-meta-item"><span class="ks-meta-label">Thread</span><span class="ks-meta-value">${_threadLabel(c.thread_type)}</span></div>
      <div class="ks-meta-item"><span class="ks-meta-label">Last Change</span><span class="ks-meta-value">${lastChange ? _fmtDate(lastChange.change_date) : 'Not yet'}</span></div>
      <div class="ks-meta-item"><span class="ks-meta-label">Thread Remaining</span><span class="ks-meta-value">${lastChange?.thread_length_cm != null ? lastChange.thread_length_cm + ' cm' : '—'}</span></div>
      <div class="ks-meta-item"><span class="ks-meta-label">Doctor</span><span class="ks-meta-value">${_esc(c.profiles?.full_name || '—')}</span></div>
    </div>
    ${planned ? `<div class="ks-progress">
      <div class="ks-progress-bar"><div class="ks-progress-fill" style="width:${pct}%"></div></div>
      <div class="ks-progress-label">${sittings} / ${planned} sittings completed (${pct}%)</div>
    </div>` : `<div style="font-size:12px;color:var(--text-muted);margin:8px 0">${sittings} sittings recorded</div>`}
    <span class="next-date-chip ${chipCls}">${chipText}</span>
    <div class="ks-card-actions">
      ${c.status === 'active' ? `<span style="font-size:12px;color:var(--text-muted)">Thread changes: from Today's sittings</span>` : ''}
      <button class="btn btn-secondary btn-sm" data-onclick="openHistModal" data-onclick-a0="${c.id}">History</button>
      ${c.status === 'active' ? `<button class="btn-ghost btn-sm" data-onclick="markCompleted" data-onclick-a0="${c.id}">✓ Complete</button>` : ''}
    </div>
  </div>`;
}

// ── Register modal ────────────────────────────────────────────────────────────
window.openRegisterModal = function() {
  _foundPatient = null;
  _sitting = null;   // Session 391 T1a-2: a modal opened by hand is not a sitting (onStart sets it after)
  document.getElementById('reg-search').value   = '';
  document.getElementById('reg-condition').value = '';
  document.getElementById('reg-thread-type').value = 'apamarga';
  document.getElementById('reg-start-date').value  = _today();
  document.getElementById('reg-planned').value      = '';
  document.getElementById('reg-notes').value         = '';
  document.getElementById('reg-pt-result').classList.remove('show');
  // Session 386b-2a (§540, Q18): the application fee and the thread-change fee (used for every change), chosen once here --
  // own active procedure fees; both are fixed once the case is registered
  const rf = document.getElementById('reg-fee');
  rf.disabled = false; rf.removeAttribute('title');   // F4: a modal opened by hand is never left locked
  const rfLabel = document.querySelector('label[for="reg-fee"]'), rfNote = document.getElementById('reg-fee-note');
  if (rfLabel) rfLabel.textContent = 'Application fee (optional)';
  if (rfNote) rfNote.hidden = true;
  loadFees(supabase, tenantId, ['procedure'], { register: 'kshara_sutra' }).then(({ fees, error }) => {
    fillFeeSelect(rf, error ? [] : fees, { keep: false });
    fillFeeSelect(document.getElementById('reg-thread-fee'), error ? [] : fees, { keep: false });
    // F4 (owner rehearsal, 24 Nov 2026): sitting 1 of an order -- the application fee is the order's, filled in and locked
    if (_sitting && _sitting.sitting_no === 1 && _sitting.fee_id) {
      if (![...rf.options].some(o => o.value === _sitting.fee_id)) rf.appendChild(new Option(_sitting.procedure || '', _sitting.fee_id));
      rf.value = _sitting.fee_id; rf.disabled = true; rf.title = "The procedure comes from the doctor's order";
      if (rfLabel) rfLabel.textContent = "Application fee (from the doctor's order)";   // visible on a tablet too (no hover there)
      if (rfNote) rfNote.hidden = false;
    }
  });
  document.getElementById('reg-overlay').style.display = 'flex';
};
window.closeRegModal = () => { document.getElementById('reg-overlay').style.display = 'none'; };

let _searchTimer = null;
window.searchPatient = function() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(async () => {
    const q = document.getElementById('reg-search').value.trim();
    if (q.length < 3) { document.getElementById('reg-pt-result').classList.remove('show'); return; }
    const isPhone = /^\d+$/.test(q);
    let query = supabase.from('patients').select('id,name,phone,age,gender').eq('tenant_id', tenantId).limit(1);
    query = isPhone ? query.ilike('phone', `%${q}%`) : query.ilike('name', `%${q}%`);
    const { data } = await query;
    const pt = data?.[0];
    if (pt) {
      _foundPatient = pt;
      document.getElementById('reg-pt-name').textContent = pt.name;
      document.getElementById('reg-pt-sub').textContent  = `${pt.phone || '—'} · ${pt.gender || ''} ${pt.age ? pt.age + 'y' : ''}`;
      document.getElementById('reg-pt-result').classList.add('show');
    } else {
      _foundPatient = null;
      document.getElementById('reg-pt-result').classList.remove('show');
    }
  }, 350);
};

window.saveKsCase = async function() {
  if (!_foundPatient) { alert('Please search and select a patient first.'); return; }
  // Session 391 T1a-2 (D6): a case is registered from sitting 1 of the doctor's Kshara sutra order (Today's sittings → ▶ Start)
  if (!_sitting || _sitting.sitting_no !== 1) { _alert('error', "Start the patient's first sitting (Today's sittings → ▶ Start). Without an order only the department head records it, with a reason."); return; }
  const condition = document.getElementById('reg-condition').value;
  if (!condition)   { alert('Please select the condition.'); return; }

  const { error } = await supabase.from('ks_sessions').insert({
    tenant_id:        tenantId,
    patient_id:       _foundPatient.id,
    doctor_id:        userId,
    condition,
    thread_type:      document.getElementById('reg-thread-type').value,
    start_date:       document.getElementById('reg-start-date').value || _today(),
    planned_sittings: parseInt(document.getElementById('reg-planned').value) || null,
    notes:            document.getElementById('reg-notes').value.trim(),
    fee_structure_id:        feeIdOf('reg-fee'),          // Session 386b-2a: charged at the application
    thread_fee_structure_id: feeIdOf('reg-thread-fee'),   // charged at every thread change
    status:           'active',
    procedure_sitting_id: _sitting.sitting_id   // Session 391 T1a-2: the server sets patient, fee, date and sittings from it
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save case.')); return; }
  _sitting = null; _ksSittings?.reload();
  closeRegModal();
  _alert('success', 'Kshara Sutra case registered successfully.');
  loadCases();
};

// ── Log thread change modal ───────────────────────────────────────────────────
window.openLogModal = function(sessionId) {
  _activeSessionId = sessionId;
  _sitting = null;   // Session 391 T1a-2 (onStart sets it after)
  const c = _cases.find(x => x.id === sessionId);
  if (!c) return;
  const nextSitting = (c.changes.length || 0) + 1;
  const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 7);

  document.getElementById('log-modal-title').textContent = `Log Thread Change — ${c.patients?.name || ''}`;
  document.getElementById('log-modal-sub').textContent   = `Sitting #${nextSitting}`;
  document.getElementById('log-sitting-no').value  = nextSitting;
  document.getElementById('log-date').value         = _today();
  document.getElementById('log-next-date').value    = localDateStr(nextWeek);
  document.getElementById('log-thread-len').value   = '';
  document.getElementById('log-findings').value     = '';
  document.getElementById('log-overlay').style.display = 'flex';
};
window.closeLogModal = () => { document.getElementById('log-overlay').style.display = 'none'; };

window.saveThreadChange = async function() {
  const findings = document.getElementById('log-findings').value.trim();
  if (!findings) { alert('Please enter findings / observations.'); return; }
  if (!_sitting || _sitting.sitting_no < 2) { _alert('error', "Start the patient's sitting first (Today's sittings → ▶ Start)."); return; }

  const { error } = await supabase.from('ks_thread_changes').insert({
    tenant_id:        tenantId,
    session_id:       _activeSessionId,
    sitting_no:       parseInt(document.getElementById('log-sitting-no').value),
    change_date:      document.getElementById('log-date').value,
    thread_length_cm: parseFloat(document.getElementById('log-thread-len').value) || null,
    next_date:        document.getElementById('log-next-date').value || null,
    findings,
    done_by:          userId,
    procedure_sitting_id: _sitting.sitting_id   // Session 391 T1a-2: the server sets the course, sitting no., dates
  });
  if (error) { alert(safeErrorMessage(error, 'Could not save thread change.')); return; }
  _sitting = null; _ksSittings?.reload();
  closeLogModal();
  _alert('success', 'Thread change logged successfully.');
  loadCases();
};

// ── History modal ─────────────────────────────────────────────────────────────
window.openHistModal = function(sessionId) {
  const c = _cases.find(x => x.id === sessionId);
  if (!c) return;
  document.getElementById('hist-modal-title').textContent = `Session History — ${c.patients?.name || '—'}`;
  document.getElementById('hist-modal-sub').textContent   =
    `${_condLabel(c.condition)} · ${c.changes.length} sittings · Started ${_fmtDate(c.start_date)}`;

  const rows = c.changes.length
    ? c.changes.map(r => `<tr>
        <td style="font-weight:600">#${r.sitting_no}</td>
        <td>${_fmtDate(r.change_date)}</td>
        <td>${r.thread_length_cm != null ? r.thread_length_cm + ' cm' : '—'}</td>
        <td>${_esc(r.findings || '—')}</td>
        <td>${r.next_date ? _fmtDate(r.next_date) : '—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px">No thread changes recorded yet.</td></tr>`;

  document.getElementById('hist-table-wrap').innerHTML = `
    <table class="hist-table">
      <thead><tr><th>#</th><th>Date</th><th>Thread Left</th><th>Findings</th><th>Next Date</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  document.getElementById('hist-overlay').style.display = 'flex';
};
window.closeHistModal = () => { document.getElementById('hist-overlay').style.display = 'none'; };

// ── Mark completed ────────────────────────────────────────────────────────────
window.markCompleted = async function(sessionId) {
  if (!confirm('Mark this Kshara Sutra case as completed?')) return;
  const { error } = await supabase.from('ks_sessions').update({ status: 'completed' }).eq('id', sessionId);
  if (error) { alert(safeErrorMessage(error, 'Could not mark case as completed.')); return; }
  _alert('success', 'Case marked as completed.');
  loadCases();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _today() { return todayLocalStr(); }
function _nextDate(c) { if (c.fromOrder) return c.fromOrder.next; const last = c.changes[c.changes.length - 1]; return last?.next_date || null; }   // F6
function _fmtDate(d) { if (!d) return '—'; return new Date(d + 'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _daysAgo(d) { return Math.floor((new Date(_today()) - new Date(d)) / 86400000); }
function _threadLabel(t) { return {apamarga:'Apamarga Kshara',snuhi:'Snuhi Kshara',combination:'Combination',other:'Other'}[t] || _esc(t || '—'); }
function _condLabel(c) { return {fistula_in_ano:'Fistula-in-Ano',haemorrhoids:'Haemorrhoids',fissure:'Fissure',pilonidal_sinus:'Pilonidal Sinus',sentinel_tag:'Sentinel Tag',other:'Other'}[c] || _esc(c || '—'); }

function _alert(type, msg) { notify(msg, type); }   // Session 323: shared top-layer notify()

// Session 391 T1a-2: the ordered sittings of the day; ▶ Start opens the case (sitting 1) or the thread change (2..) for that patient
const _ksSittings = mountTodaysSittings({ supabase, container: document.getElementById('todays-sittings'), register: 'kshara_sutra', tenantId,
  toast: (m, t) => _alert(t || 'info', m),
  onStart: info => {
    if (info.sitting_no === 1) {
      window.openRegisterModal();
      _sitting = info;   // after openRegisterModal (it clears the patient and the sitting)
      _foundPatient = { id: info.patient_id, name: info.patient_name };
      document.getElementById('reg-search').value = info.patient_name;
      document.getElementById('reg-pt-name').textContent = info.patient_name;
      document.getElementById('reg-pt-sub').textContent = `${info.uhid || ''} · sitting 1 of ${info.sittings_planned || 1}: ${info.procedure}`;
      document.getElementById('reg-pt-result').classList.add('show');
      document.getElementById('reg-planned').value = info.sittings_planned || '';
    } else {
      const c = _cases.find(x => x.patients?.id === info.patient_id && x.status === 'active');
      if (!c) { _alert('error', 'This patient has no active Kshara sutra case on this page — record sitting 1 first.'); return; }
      window.openLogModal(c.id);
      _sitting = info;
      document.getElementById('log-sitting-no').value = info.sitting_no;
      document.getElementById('log-modal-sub').textContent = `Sitting #${info.sitting_no} of ${info.sittings_planned || info.sitting_no}`;
    }
  } });

loadCases();
