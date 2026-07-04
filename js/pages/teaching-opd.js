import { supabase } from '../core/db/supabaseClient.js';
import { requireAuth, getCurrentProfile, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['doctor','super_admin','dept_admin','nurse']);
initNavbar();
wireDelegatedEvents();

const tenant   = getCurrentTenant();
const profile  = getCurrentProfile();
const tenantId = tenant?.id;
const userId   = profile?.id;

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

let _cases  = [];
let _allCases = [];
let _date   = new Date().toISOString().slice(0,10);
let _rating = 0;

function _today() { return new Date().toISOString().slice(0,10); }

// ── Date navigation ───────────────────────────────────────────────────────────
function setDisplayDate() {
  const d = new Date(_date + 'T00:00:00');
  const today = _today();
  document.getElementById('date-display').textContent =
    d.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
  document.getElementById('date-picker').value = _date;
  document.getElementById('card-title-date').textContent = _date === today ? 'Today\'s Cases' : 'Cases for ' + _fmtDate(_date);
}
window.changeDate = function(n) { const d = new Date(_date+'T00:00:00'); d.setDate(d.getDate()+Number(n)); _date = d.toISOString().slice(0,10); setDisplayDate(); renderTable(); };
window.setDate   = function(v) { _date = v; setDisplayDate(); renderTable(); };
window.setToday  = function()  { _date = _today(); setDisplayDate(); renderTable(); };

// ── Load ──────────────────────────────────────────────────────────────────────
async function load() {
  const { data, error } = await supabase.from('teaching_cases')
    .select('*').eq('tenant_id', tenantId).order('presentation_date', { ascending: false });
  if (error) { _alert('error', error.message); return; }
  _allCases = data || [];
  renderTable();
  updateStats();
}

window.renderTable = function() {
  const pgFilter = document.getElementById('search-pg').value.toLowerCase();
  _cases = _allCases.filter(c => c.presentation_date === _date &&
    (!pgFilter || (c.pg_presenter||'').toLowerCase().includes(pgFilter)));

  const tbody = document.getElementById('tc-tbody');
  if (!_cases.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><div class="empty-icon">📚</div><div class="empty-title">No cases recorded for this date</div><div class="empty-sub">Record a case presentation</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = _cases.map((c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td style="white-space:nowrap">${_fmtDate(c.presentation_date)}</td>
      <td style="font-size:11px">${_esc(c.patient_anon || '—')}</td>
      <td style="font-size:12px">${_esc(c.diagnosis_ayurveda || c.diagnosis_modern || '—')}</td>
      <td><span class="case-type-pill pill-${c.case_type}">${{new:'New',follow_up:'Follow-up',interesting:'Interesting',emergency:'Emergency'}[c.case_type]||_esc(c.case_type)}</span></td>
      <td style="font-size:12px;font-weight:600;color:var(--purple)">${_esc(c.pg_presenter || '—')}</td>
      <td style="font-size:12px">${_esc(c.supervising_faculty || '—')}</td>
      <td style="font-size:12px">${_esc(c.department || '—')}</td>
      <td style="font-size:11px;max-width:160px">${_esc(_trunc(c.teaching_points, 60))}</td>
      <td style="color:#e0c060">${'★'.repeat(c.faculty_rating || 0)}${'☆'.repeat(5 - (c.faculty_rating || 0))}</td>
      <td><button class="btn btn-secondary btn-sm" data-onclick="viewCase" data-onclick-a0="${c.id}">View</button></td>
    </tr>`).join('');
};

function updateStats() {
  const today = _today();
  const month = today.slice(0,7);
  const todayCount   = _allCases.filter(c => c.presentation_date === today).length;
  const monthCount   = _allCases.filter(c => c.presentation_date?.startsWith(month)).length;
  const interestCount= _allCases.filter(c => c.case_type === 'interesting').length;

  const pgCounts = {};
  _allCases.forEach(c => { if (c.pg_presenter) pgCounts[c.pg_presenter] = (pgCounts[c.pg_presenter]||0)+1; });
  const topPg = Object.entries(pgCounts).sort((a,b)=>b[1]-a[1])[0];

  document.getElementById('stat-today').textContent      = todayCount;
  document.getElementById('stat-month').textContent      = monthCount;
  document.getElementById('stat-interesting').textContent= interestCount;
  document.getElementById('stat-pg').textContent         = topPg ? topPg[0].split(' ')[1] || topPg[0] : '—';
}

// ── Modal ─────────────────────────────────────────────────────────────────────
window.openModal = function() {
  _rating = 0;
  document.getElementById('m-date').value   = _date;
  document.getElementById('m-case-type').value = 'new';
  document.getElementById('m-dept').value   = '';
  document.getElementById('m-patient').value= '';
  document.getElementById('m-complaint').value = '';
  document.getElementById('m-diag-ay').value= '';
  document.getElementById('m-diag-md').value= '';
  document.getElementById('m-pg').value     = '';
  document.getElementById('m-faculty').value= '';
  document.getElementById('m-points').value = '';
  document.getElementById('m-performance').value = '';
  document.getElementById('m-feedback').value= '';
  document.getElementById('m-action').value = '';
  setRating(0);
  document.getElementById('modal-overlay').style.display = 'flex';
};

window.closeModal = function() {
  document.getElementById('modal-overlay').style.display = 'none';
};

window.setRating = function(v) {
  v = Number(v);
  _rating = v;
  document.querySelectorAll('.rating-btn').forEach((btn, i) => {
    btn.classList.toggle('sel', i < v);
  });
  document.getElementById('rating-label').textContent =
    ['','Poor','Fair','Good','Very Good','Excellent'][v] || 'Not rated';
};

window.saveCase = async function() {
  const { error } = await supabase.from('teaching_cases').insert({
    tenant_id:         tenantId,
    recorded_by:       userId,
    presentation_date: document.getElementById('m-date').value,
    case_type:         document.getElementById('m-case-type').value,
    department:        document.getElementById('m-dept').value.trim() || null,
    patient_anon:      document.getElementById('m-patient').value.trim() || null,
    chief_complaint:   document.getElementById('m-complaint').value.trim() || null,
    diagnosis_ayurveda:document.getElementById('m-diag-ay').value.trim() || null,
    diagnosis_modern:  document.getElementById('m-diag-md').value.trim() || null,
    pg_presenter:      document.getElementById('m-pg').value.trim() || null,
    supervising_faculty:document.getElementById('m-faculty').value.trim() || null,
    teaching_points:   document.getElementById('m-points').value.trim() || null,
    pg_performance:    document.getElementById('m-performance').value.trim() || null,
    faculty_rating:    _rating || null,
    faculty_feedback:  document.getElementById('m-feedback').value.trim() || null,
    action_for_pg:     document.getElementById('m-action').value.trim() || null,
  });
  if (error) { _alert('error', error.message); return; }
  _alert('success', 'Case presentation recorded.');
  closeModal();
  await load();
};

window.viewCase = function(id) {
  const c = _allCases.find(x => x.id === id);
  if (!c) return;
  alert(`Case: ${c.patient_anon||'—'}\nDiagnosis: ${c.diagnosis_ayurveda||'—'}\nPG: ${c.pg_presenter||'—'}\nFaculty: ${c.supervising_faculty||'—'}\nPoints: ${c.teaching_points||'—'}\nRating: ${'★'.repeat(c.faculty_rating||0)}\nFeedback: ${c.faculty_feedback||'—'}`);
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _trunc(s,n) { if (!s) return '—'; return s.length>n?s.slice(0,n)+'…':s; }
function _alert(type,msg) { const el=document.getElementById('alert-box');el.className=`alert ${type} show`;el.textContent=msg;setTimeout(()=>el.classList.remove('show'),4000); }

// ── §21l Bedside Clinics ──────────────────────────────────────────────────────
let _depts = [];
(async function loadDepts() {
  const { data } = await supabase.from('departments').select('id,name,ncism_code').eq('tenant_id',tenantId).eq('is_active',true).order('name');
  _depts = data || [];
  const sel = document.getElementById('bed-dept');
  if (sel) sel.innerHTML = '<option value="">— Select dept —</option>' + _depts.map(d=>`<option value="${d.id}">${_esc(d.name)}</option>`).join('');
})();

window.loadBedsideClinics = async function() {
  const el = document.getElementById('bedside-list');
  if (!el) return;
  const { data, error } = await supabase.from('bedside_clinics').select('*,departments(name),profiles!faculty_id(full_name)')
    .eq('tenant_id',tenantId).order('clinic_date',{ascending:false}).limit(20);
  if (error) { el.innerHTML = error.code==='42P01'?'<em>Run session32_ncism_gaps.sql to activate</em>':_esc(error.message); return; }
  if (!data?.length) { el.innerHTML = '<em>No bedside clinic sessions logged yet.</em>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f5faf7"><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Date</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Dept</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Topic</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Faculty</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Students</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Batch</th></tr></thead><tbody>
    ${data.map(s=>`<tr><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${s.clinic_date}</td><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${_esc(s.departments?.name||'—')}</td><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;font-weight:500">${_esc(s.topic||'—')}</td><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${_esc(s.profiles?.full_name||'—')}</td><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${s.student_count||0}</td><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${_esc((s.clinical_batch||'').replace(/_/g,' '))}</td></tr>`).join('')}
    </tbody></table>`;
};
window.openBedModal = function() { document.getElementById('bed-modal').style.display='flex'; document.getElementById('bed-date').value=_today(); };
window.closeBedModal = function() { document.getElementById('bed-modal').style.display='none'; };
window.saveBedside = async function() {
  const topic = document.getElementById('bed-topic').value.trim();
  const dept  = document.getElementById('bed-dept').value;
  if (!topic || !dept) { alert('Department and topic are required'); return; }
  const { error } = await supabase.from('bedside_clinics').insert({
    tenant_id: tenantId,
    department_id: dept,
    clinic_date: document.getElementById('bed-date').value || _today(),
    ward_name: document.getElementById('bed-ward').value.trim()||null,
    topic,
    faculty_id: profile.id,
    student_count: parseInt(document.getElementById('bed-students').value)||0,
    clinical_batch: document.getElementById('bed-batch').value||null,
    assessment_conducted: document.getElementById('bed-assess').checked,
    notes: document.getElementById('bed-notes').value.trim()||null,
  });
  if (error) { alert(error.message); return; }
  closeBedModal();
  loadBedsideClinics();
};

// ── Boot ─────────────────────────────────────────────────────────────────────
setDisplayDate();
await load();
await loadBedsideClinics();
