import { requireAuth, hasModule, getCurrentProfile, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

const ALLOWED = ['super_admin','dept_admin'];
await requireAuth(ALLOWED);
if (!hasModule('hr')) { window.location.replace('admin.html'); }
wireDelegatedEvents();

const profile   = getCurrentProfile();
const tenant    = getCurrentTenant() || {};
const tenantId  = getCurrentTenantId();
const today     = new Date().toISOString().slice(0,10);

initNavbar();

// ── State ──────────────────────────────────────────────
let _vacancies  = [];
let _apps       = [];
let _departments = [];
let _editingVacId  = null;
let _editingAppId  = null;
let _updatingAppId = null;
let _currentVacId  = null;

// ── Tab switch ─────────────────────────────────────────
window.switchTab = function(id) {
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', ['vacancies','applications','letters'][i] === id));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === 'tab-' + id));
};

// ── Departments ────────────────────────────────────────
async function loadDepartments() {
  const { data } = await supabase.from('departments').select('id,name').eq('tenant_id',tenantId).eq('is_active',true).order('name');
  _departments = data || [];
  const deptOpts = _departments.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  ['vm-dept','vac-dept-filter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = (id==='vac-dept-filter' ? '<option value="">All Departments</option>' : '<option value="">— General / Not specific —</option>') + deptOpts;
  });
}

// ── Vacancies ──────────────────────────────────────────
async function loadVacancies() {
  const { data, error } = await supabase
    .from('job_vacancies')
    .select('*,departments(name)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error && error.code === '42P01') {
    document.getElementById('vacancy-grid').innerHTML =
      '<div class="empty" style="grid-column:span 3">Run the SQL in <code>sql/session28_recruitment.sql</code> to activate this module.</div>';
    return;
  }
  if (error) { _toast('Error: '+error.message,'error'); return; }
  _vacancies = data || [];
  renderVacancies();
  _populateVacSelects();
  await loadAllApps();
}

window.renderVacancies = function() {
  const statusF = document.getElementById('vac-status-filter').value;
  const deptF   = document.getElementById('vac-dept-filter').value;
  const list = _vacancies.filter(v =>
    (!statusF || v.status === statusF) &&
    (!deptF   || v.department_id === deptF)
  );
  const el = document.getElementById('vacancy-grid');
  if (!list.length) { el.innerHTML = '<div class="empty" style="grid-column:span 3">No vacancies found. Click "+ Post Vacancy" to create one.</div>'; return; }
  el.innerHTML = list.map(v => {
    const appCount   = _apps.filter(a => a.vacancy_id === v.id).length;
    const shortCount = _apps.filter(a => a.vacancy_id === v.id && a.status === 'shortlisted').length;
    const selCount   = _apps.filter(a => a.vacancy_id === v.id && ['selected','joined'].includes(a.status)).length;
    const expired    = v.last_date && v.last_date < today;
    return `<div class="vac-card ${v.status==='closed'?'closed':''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div class="vc-title">${v.title}</div>
        <span class="badge b-${v.status}">${v.status}</span>
      </div>
      <div class="vc-meta">
        <span class="vc-tag">${_roleLabel(v.role)}</span>
        ${v.departments?.name ? `<span class="vc-tag">${v.departments.name}</span>` : ''}
        ${v.vacancies_count > 1 ? `<span class="vc-tag">${v.vacancies_count} posts</span>` : ''}
        ${expired ? '<span style="color:var(--red);font-size:11px">Last date passed</span>' : v.last_date ? `<span>Last date: ${_fmtD(v.last_date)}</span>` : ''}
      </div>
      <div class="vc-stats">
        <div><div class="vc-stat-val">${appCount}</div><div style="font-size:10px;color:var(--text-muted)">Applied</div></div>
        <div><div class="vc-stat-val">${shortCount}</div><div style="font-size:10px;color:var(--text-muted)">Shortlisted</div></div>
        <div><div class="vc-stat-val">${selCount}</div><div style="font-size:10px;color:var(--text-muted)">Selected</div></div>
      </div>
      ${v.salary_range ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">💰 ${v.salary_range}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" data-onclick="editVacancy" data-onclick-a0="${v.id}">Edit</button>
        <button class="btn btn-sm" style="background:var(--green-light);color:var(--green-deep);border:1px solid var(--border)" data-onclick="viewApps" data-onclick-a0="${v.id}">View Applications (${appCount})</button>
        ${v.status==='open' ? `<button class="btn btn-sm" style="background:var(--red-light);color:var(--red);border:1px solid #f5b8b8" data-onclick="closeVacancy" data-onclick-a0="${v.id}">Close</button>` : ''}
      </div>
    </div>`;
  }).join('');
};

window.openVacModal = function() {
  _editingVacId = null;
  document.getElementById('vac-modal-title').textContent = 'Post New Vacancy';
  document.getElementById('vm-title').value   = '';
  document.getElementById('vm-role').value    = 'doctor';
  document.getElementById('vm-dept').value    = '';
  document.getElementById('vm-count').value   = '1';
  document.getElementById('vm-exp').value     = '0';
  document.getElementById('vm-qual').value    = '';
  document.getElementById('vm-salary').value  = '';
  document.getElementById('vm-lastdate').value= '';
  document.getElementById('vm-status').value  = 'open';
  document.getElementById('vm-details').value = '';
  document.getElementById('vac-modal').classList.add('show');
};
window.closeVacModal = function() { document.getElementById('vac-modal').classList.remove('show'); };

window.editVacancy = function(id) {
  _editingVacId = id;
  const v = _vacancies.find(x=>x.id===id);
  if (!v) return;
  document.getElementById('vac-modal-title').textContent = 'Edit Vacancy';
  document.getElementById('vm-title').value    = v.title;
  document.getElementById('vm-role').value     = v.role;
  document.getElementById('vm-dept').value     = v.department_id||'';
  document.getElementById('vm-count').value    = v.vacancies_count||1;
  document.getElementById('vm-exp').value      = v.experience_years||0;
  document.getElementById('vm-qual').value     = v.qualifications||'';
  document.getElementById('vm-salary').value   = v.salary_range||'';
  document.getElementById('vm-lastdate').value = v.last_date||'';
  document.getElementById('vm-status').value   = v.status;
  document.getElementById('vm-details').value  = v.details||'';
  document.getElementById('vac-modal').classList.add('show');
};

window.saveVacancy = async function() {
  const title = document.getElementById('vm-title').value.trim();
  if (!title) { _toast('Job title is required','error'); return; }
  const payload = {
    tenant_id: tenantId,
    title,
    role:           document.getElementById('vm-role').value,
    department_id:  document.getElementById('vm-dept').value || null,
    vacancies_count:parseInt(document.getElementById('vm-count').value)||1,
    experience_years:parseInt(document.getElementById('vm-exp').value)||0,
    qualifications: document.getElementById('vm-qual').value.trim()||null,
    salary_range:   document.getElementById('vm-salary').value.trim()||null,
    last_date:      document.getElementById('vm-lastdate').value||null,
    status:         document.getElementById('vm-status').value,
    details:        document.getElementById('vm-details').value.trim()||null,
  };
  let error;
  if (_editingVacId) {
    ({ error } = await supabase.from('job_vacancies').update(payload).eq('id',_editingVacId));
  } else {
    ({ error } = await supabase.from('job_vacancies').insert({...payload, posted_by: profile.id}));
  }
  if (error) { _toast('Error: '+error.message,'error'); return; }
  closeVacModal();
  _toast(_editingVacId ? 'Vacancy updated' : 'Vacancy posted','success');
  await loadVacancies();
};

window.closeVacancy = async function(id) {
  if (!confirm('Close this vacancy? No new applications will be accepted.')) return;
  await supabase.from('job_vacancies').update({ status:'closed' }).eq('id',id);
  await loadVacancies();
  _toast('Vacancy closed','success');
};

// ── Applications ───────────────────────────────────────
async function loadAllApps() {
  const { data } = await supabase
    .from('job_applications')
    .select('*')
    .eq('tenant_id', tenantId);
  _apps = data || [];
  updateKPIs();
  renderVacancies();
  _populateVacSelects();
}

window.loadApplications = async function() {
  const vacId = document.getElementById('app-vac-select').value;
  document.getElementById('app-section').style.display = vacId ? '' : 'none';
  if (!vacId) return;
  _currentVacId = vacId;
  const vac = _vacancies.find(v=>v.id===vacId);
  document.getElementById('app-vac-title').textContent = vac?.title || 'Applications';
  document.getElementById('app-vac-sub').textContent = `${vac?.departments?.name||'General'} · ${_roleLabel(vac?.role)}`;
  const { data, error } = await supabase
    .from('job_applications')
    .select('*')
    .eq('vacancy_id', vacId)
    .order('created_at', { ascending: false });
  if (error) { _toast('Error: '+error.message,'error'); return; }
  _apps.forEach((a,i) => { if (a.vacancy_id === vacId) _apps.splice(i,1,a); }); // update in-place
  const vacApps = data||[];
  // merge into _apps
  vacApps.forEach(a => {
    const idx = _apps.findIndex(x=>x.id===a.id);
    if (idx>=0) _apps[idx]=a; else _apps.push(a);
  });
  filterApplications(vacApps);
  updateKPIs();
};

window.filterApplications = function(list) {
  const statusF = document.getElementById('app-status-filter').value;
  const vacId   = document.getElementById('app-vac-select').value;
  list = list || _apps.filter(a=>a.vacancy_id===vacId);
  const filtered = list.filter(a => !statusF || a.status===statusF);
  const tbody = document.getElementById('app-tbody');
  tbody.innerHTML = filtered.map((a,i) => `<tr>
    <td style="color:var(--text-muted)">${i+1}</td>
    <td style="font-weight:500">${a.applicant_name}</td>
    <td style="font-size:12px">${a.applicant_phone}</td>
    <td style="font-size:12px">${a.qualification||'—'}</td>
    <td style="font-size:12px">${a.experience_years||0} yr${a.experience_years!==1?'s':''}</td>
    <td style="font-size:12px">${_fmtD(a.created_at?.slice(0,10))}</td>
    <td><span class="badge b-${a.status}">${_statusLabel(a.status)}</span></td>
    <td style="font-size:11px">${a.interview_date ? _fmtD(a.interview_date)+(a.interview_time?' · '+a.interview_time.slice(0,5):'') : '—'}</td>
    <td>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" data-onclick="openStatusModal" data-onclick-a0="${a.id}" data-onclick-a1="${_esc(a.applicant_name)}" data-onclick-a2="${a.status}" data-onclick-a3="${a.interview_date||''}" data-onclick-a4="${a.interview_time||''}">Update</button>
      </div>
    </td>
  </tr>`).join('') || `<tr><td colspan="9" class="empty">No ${statusF} applications</td></tr>`;
};

window.viewApps = function(vacId) {
  switchTab('applications');
  setTimeout(() => {
    document.getElementById('app-vac-select').value = vacId;
    loadApplications();
  }, 50);
};

// Add application
window.openAppModal = function() {
  _editingAppId = null;
  const vacId = document.getElementById('app-vac-select').value;
  document.getElementById('app-modal-title').textContent = 'Add Application';
  document.getElementById('am-name').value     = '';
  document.getElementById('am-phone').value    = '';
  document.getElementById('am-email').value    = '';
  document.getElementById('am-qual').value     = '';
  document.getElementById('am-exp').value      = '0';
  document.getElementById('am-employer').value = '';
  document.getElementById('am-cover').value    = '';
  document.getElementById('am-status').value   = 'received';
  _toggleAppIntFields('am', 'received');
  document.getElementById('app-modal').classList.add('show');
};
window.closeAppModal = function() { document.getElementById('app-modal').classList.remove('show'); };

document.getElementById('am-status').addEventListener('change', function() { _toggleAppIntFields('am', this.value); });

function _toggleAppIntFields(prefix, status) {
  const show = status === 'interview_scheduled';
  ['int-date','int-time','int-mode','int-notes'].forEach(s => {
    const el = document.getElementById(`${prefix}-${s}-field`);
    if (el) el.style.display = show ? '' : 'none';
  });
}

window.saveApplication = async function() {
  const vacId = document.getElementById('app-vac-select').value || _currentVacId;
  if (!vacId) { _toast('Select a vacancy first','error'); return; }
  const name  = document.getElementById('am-name').value.trim();
  const phone = document.getElementById('am-phone').value.trim();
  if (!name || !phone) { _toast('Name and phone are required','error'); return; }
  const status = document.getElementById('am-status').value;
  const { error } = await supabase.from('job_applications').insert({
    tenant_id: tenantId, vacancy_id: vacId,
    applicant_name:  name,
    applicant_phone: phone,
    applicant_email: document.getElementById('am-email').value.trim()||null,
    qualification:   document.getElementById('am-qual').value.trim()||null,
    experience_years:parseInt(document.getElementById('am-exp').value)||0,
    current_employer:document.getElementById('am-employer').value.trim()||null,
    cover_note:      document.getElementById('am-cover').value.trim()||null,
    status,
    interview_date: status==='interview_scheduled' ? document.getElementById('am-int-date').value||null : null,
    interview_time: status==='interview_scheduled' ? document.getElementById('am-int-time').value||null : null,
    interview_mode: status==='interview_scheduled' ? document.getElementById('am-int-mode').value : null,
    interview_notes:status==='interview_scheduled' ? document.getElementById('am-int-notes').value.trim()||null : null,
  });
  if (error) { _toast('Error: '+error.message,'error'); return; }
  closeAppModal();
  _toast('Application added','success');
  await loadApplications();
};

// Update status
window.openStatusModal = function(id, name, status, intDate, intTime) {
  _updatingAppId = id;
  document.getElementById('sm-applicant-name').textContent = name;
  document.getElementById('sm-status').value   = status;
  document.getElementById('sm-int-date').value = intDate;
  document.getElementById('sm-int-time').value = intTime;
  document.getElementById('sm-int-mode').value = 'in_person';
  document.getElementById('sm-int-notes').value= '';
  document.getElementById('sm-notes').value    = '';
  toggleInterviewFields();
  document.getElementById('status-modal').classList.add('show');
};
window.closeStatusModal = function() { document.getElementById('status-modal').classList.remove('show'); _updatingAppId=null; };

window.toggleInterviewFields = function() {
  const show = document.getElementById('sm-status').value === 'interview_scheduled';
  ['sm-int-date-wrap','sm-int-time-wrap','sm-int-mode-wrap','sm-int-notes-wrap'].forEach(id => {
    document.getElementById(id).style.display = show ? '' : 'none';
  });
};

window.updateAppStatus = async function() {
  const status = document.getElementById('sm-status').value;
  const payload = {
    status,
    interview_date:  status==='interview_scheduled' ? document.getElementById('sm-int-date').value||null : null,
    interview_time:  status==='interview_scheduled' ? document.getElementById('sm-int-time').value||null : null,
    interview_mode:  status==='interview_scheduled' ? document.getElementById('sm-int-mode').value : null,
    interview_notes: status==='interview_scheduled' ? document.getElementById('sm-int-notes').value.trim()||null : null,
    ...(status==='selected' ? { offer_date: today } : {}),
    ...(status==='joined'   ? {
      join_date:  today,
      join_token: crypto.randomUUID(),
    } : {}),
  };
  const { error } = await supabase.from('job_applications').update(payload).eq('id',_updatingAppId);
  if (error) { _toast('Error: '+error.message,'error'); return; }
  closeStatusModal();
  _toast('Status updated','success');
  await loadApplications();
};

window.exportAppsCSV = function() {
  const vacId = document.getElementById('app-vac-select').value;
  const list  = _apps.filter(a => a.vacancy_id === vacId);
  _csvDownload(list.map(a=>({
    Name:a.applicant_name,Phone:a.applicant_phone,Email:a.applicant_email,
    Qualification:a.qualification,Experience:a.experience_years,
    Employer:a.current_employer,Status:a.status,
    InterviewDate:a.interview_date,AppliedOn:a.created_at?.slice(0,10),
  })),'applications');
};

// ── Letters ────────────────────────────────────────────
function _populateVacSelects() {
  const intOpts  = _vacancies.map(v=>`<option value="${v.id}">${v.title}</option>`).join('');
  const apptOpts = _vacancies.map(v=>`<option value="${v.id}">${v.title}</option>`).join('');
  document.getElementById('app-vac-select').innerHTML = '<option value="">— Select a vacancy —</option>' + intOpts;
  document.getElementById('ltr-vac-int').innerHTML    = '<option value="">— Select vacancy —</option>' + intOpts;
  document.getElementById('ltr-vac-appt').innerHTML   = '<option value="">— Select vacancy —</option>' + apptOpts;
}

window.loadLetterApps = function(type) {
  const vacId = document.getElementById(`ltr-vac-${type==='interview'?'int':'appt'}`).value;
  const selectId = `ltr-app-${type==='interview'?'int':'appt'}`;
  const statusFilter = type === 'interview'
    ? ['shortlisted','interview_scheduled']
    : ['selected','joined'];
  const filtered = _apps.filter(a => a.vacancy_id===vacId && statusFilter.includes(a.status));
  document.getElementById(selectId).innerHTML =
    '<option value="">— Select candidate —</option>' +
    filtered.map(a=>`<option value="${a.id}">${a.applicant_name} (${_statusLabel(a.status)})</option>`).join('');
};

window.previewLetter = function(type) {
  const isInt    = type === 'interview';
  const appId    = document.getElementById(`ltr-app-${isInt?'int':'appt'}`).value;
  const vacId    = document.getElementById(`ltr-vac-${isInt?'int':'appt'}`).value;
  if (!appId || !vacId) { _toast('Select vacancy and candidate','error'); return; }
  const app  = _apps.find(a=>a.id===appId);
  const vac  = _vacancies.find(v=>v.id===vacId);
  if (!app||!vac) return;

  document.getElementById('letter-preview-area').style.display = '';
  document.getElementById('ltr-preview-title').textContent = isInt ? 'Interview Call Letter' : 'Appointment Letter';

  const refNo  = `${tenant.tenant_code||'ORG'}/${isInt?'INT':'APT'}/2026/${Math.floor(Math.random()*9000)+1000}`;
  const dateStr = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});

  if (isInt) {
    const intDate = app.interview_date ? new Date(app.interview_date+'T00:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}) : '________';
    const intTime = app.interview_time ? app.interview_time.slice(0,5) : '________';
    const mode    = { in_person:'in person at our premises', online:'via video call', phone:'via telephone' }[app.interview_mode||'in_person'];

    document.getElementById('letter-content').innerHTML = `
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--green-deep)">${tenant.name||'Organisation Name'}</div>
        <div style="font-size:11px;color:var(--text-muted)">${tenant.city||''} ${tenant.state||''}</div>
        <div style="border-bottom:2px solid var(--green-deep);margin:10px 0"></div>
      </div>
      <div class="ltr-meta">
        Ref: ${refNo} &nbsp;·&nbsp; Date: ${dateStr}
      </div>
      <div class="ltr-body">
        <p>To,<br/><strong>${app.applicant_name}</strong><br/>Phone: ${app.applicant_phone}${app.applicant_email?'<br/>Email: '+app.applicant_email:''}</p>
        <p><strong>Subject: Invitation for Interview — ${vac.title}</strong></p>
        <p>Dear ${app.applicant_name.split(' ')[0]},</p>
        <p>With reference to your application for the position of <strong>${vac.title}</strong> at ${tenant.name||'our organisation'}, we are pleased to inform you that you have been shortlisted for an interview.</p>
        <p>You are requested to appear for the interview as per the following schedule:</p>
        <table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px">
          <tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600;width:160px">Date</td><td style="padding:6px 12px;border:1px solid var(--border)">${intDate}</td></tr>
          <tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600">Time</td><td style="padding:6px 12px;border:1px solid var(--border)">${intTime} IST</td></tr>
          <tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600">Mode</td><td style="padding:6px 12px;border:1px solid var(--border)">${mode.charAt(0).toUpperCase()+mode.slice(1)}</td></tr>
          ${app.interview_notes ? `<tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600">Venue / Link</td><td style="padding:6px 12px;border:1px solid var(--border)">${app.interview_notes}</td></tr>` : ''}
        </table>
        <p>Please bring the following documents:</p>
        <p style="margin-left:16px">• Original and photocopies of all educational certificates<br/>• Proof of experience / previous employment letters<br/>• Government-issued photo ID (Aadhaar / PAN card)<br/>• Passport size photographs (2 copies)<br/>• Updated curriculum vitae</p>
        <p>Please confirm your attendance by calling us or replying to this letter. If you are unable to attend on the scheduled date, please inform us at least 24 hours in advance.</p>
        <p>We look forward to meeting you.</p>
      </div>
      <div class="ltr-sig">
        <p>Yours faithfully,</p>
        <div class="ltr-line"></div>
        <p style="margin-top:6px"><strong>${profile?.full_name||'Authorised Signatory'}</strong><br/>HR Department<br/>${tenant.name||''}</p>
      </div>`;
  } else {
    // Appointment letter
    const joinDate = document.getElementById('ltr-join-date').value;
    const joinDateStr = joinDate ? new Date(joinDate+'T00:00:00').toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}) : '________';

    // Generate or retrieve join token
    let joinToken = app.join_token;
    if (!joinToken) {
      joinToken = crypto.randomUUID();
      supabase.from('job_applications').update({ join_token: joinToken, join_date: joinDate||null, status:'selected' }).eq('id', app.id).then(()=>{});
    }
    const joinLink = `${window.location.origin}/signup.html?token=${joinToken}&org=${tenant.tenant_code||''}&role=${vac.role}`;

    document.getElementById('letter-content').innerHTML = `
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--green-deep)">${tenant.name||'Organisation Name'}</div>
        <div style="font-size:11px;color:var(--text-muted)">${tenant.city||''} ${tenant.state||''}</div>
        <div style="border-bottom:2px solid var(--green-deep);margin:10px 0"></div>
      </div>
      <div class="ltr-meta">
        Ref: ${refNo} &nbsp;·&nbsp; Date: ${dateStr}
      </div>
      <div class="ltr-body">
        <p>To,<br/><strong>${app.applicant_name}</strong><br/>Phone: ${app.applicant_phone}${app.applicant_email?'<br/>Email: '+app.applicant_email:''}</p>
        <p><strong>Subject: Appointment Letter — ${vac.title}</strong></p>
        <p>Dear ${app.applicant_name.split(' ')[0]},</p>
        <p>We are pleased to appoint you as <strong>${vac.title}</strong> at <strong>${tenant.name||'our organisation'}</strong> on the following terms and conditions:</p>
        <table style="border-collapse:collapse;margin:12px 0;width:100%;font-size:13px">
          <tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600;width:160px">Designation</td><td style="padding:6px 12px;border:1px solid var(--border)">${vac.title}</td></tr>
          <tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600">Department</td><td style="padding:6px 12px;border:1px solid var(--border)">${vac.departments?.name||'As assigned'}</td></tr>
          <tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600">Date of Joining</td><td style="padding:6px 12px;border:1px solid var(--border)">${joinDateStr}</td></tr>
          ${vac.salary_range ? `<tr><td style="padding:6px 12px;border:1px solid var(--border);background:var(--green-light);font-weight:600">Remuneration</td><td style="padding:6px 12px;border:1px solid var(--border)">${vac.salary_range} per month</td></tr>` : ''}
        </table>
        <p>This appointment is subject to the following conditions:</p>
        <p style="margin-left:16px">1. This letter must be accepted and the joining formalities completed on or before the date of joining.<br/>2. You will be on probation for a period of six months from the date of joining, subject to satisfactory performance.<br/>3. This appointment is subject to verification of all original documents including educational certificates and previous employment records.<br/>4. You will be governed by the service rules and conduct guidelines of the organisation, as amended from time to time.</p>
        <p>To complete your joining formalities, please use the secure onboarding link below. This link is unique to you and allows you to register your account on our HMS platform:</p>
        <div class="join-link-box no-print">${joinLink}</div>
        <p style="font-size:12px;color:var(--text-muted)">The onboarding link above is valid for one-time use. Please do not share it with others.</p>
        <p>Please report to the HR department on the date of joining with all original documents. We welcome you to our team and look forward to your valuable contribution.</p>
      </div>
      <div class="ltr-sig">
        <p>Yours faithfully,</p>
        <div class="ltr-line"></div>
        <p style="margin-top:6px"><strong>${profile?.full_name||'Authorised Signatory'}</strong><br/>HR Department<br/>${tenant.name||''}</p>
        <div style="margin-top:24px;padding:12px 16px;background:#f8fdf9;border:1px solid var(--border);border-radius:6px;font-size:12px" class="no-print">
          <strong>Join Link (share with candidate):</strong><br/>
          <a href="${joinLink}" style="color:var(--green-mid);word-break:break-all">${joinLink}</a><br/>
          <button class="btn btn-outline btn-sm no-print" style="margin-top:8px" data-onclick="_copyJoinLink" data-onclick-a0="${_esc(joinLink)}">Copy Link</button>
        </div>
      </div>`;
  }

  document.getElementById('letter-preview-area').scrollIntoView({ behavior:'smooth' });
};

window._copyJoinLink = function(link) {
  navigator.clipboard.writeText(link);
  _toast('Join link copied!','success');
};

// ── KPIs ───────────────────────────────────────────────
function updateKPIs() {
  document.getElementById('k-open').textContent   = _vacancies.filter(v=>v.status==='open').length;
  document.getElementById('k-apps').textContent   = _apps.length;
  document.getElementById('k-short').textContent  = _apps.filter(a=>a.status==='shortlisted').length;
  document.getElementById('k-int').textContent    = _apps.filter(a=>a.status==='interview_scheduled').length;
  document.getElementById('k-sel').textContent    = _apps.filter(a=>a.status==='selected').length;
  document.getElementById('k-joined').textContent = _apps.filter(a=>a.status==='joined').length;
}

// ── Helpers ────────────────────────────────────────────
function _roleLabel(r) {
  return {doctor:'Doctor / Vaidya',receptionist:'Receptionist',pharmacist:'Pharmacist',
    nurse:'Nurse',lab_tech:'Lab Tech',therapist:'Therapist',accountant:'Accountant',
    dept_admin:'Dept Admin',student:'PG Student / Intern',other:'Support Staff'}[r]||(r||'—');
}
function _statusLabel(s) {
  return {received:'Received',shortlisted:'Shortlisted',interview_scheduled:'Interview Scheduled',
    selected:'Selected',rejected:'Rejected',waitlisted:'Waitlisted',joined:'Joined'}[s]||(s||'—');
}
function _fmtD(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _toast(msg,type='success') {
  const t=document.getElementById('toast');
  t.textContent=msg; t.className=`toast ${type} show`;
  setTimeout(()=>t.classList.remove('show'),3000);
}
function _csvDownload(rows,name) {
  if(!rows.length){_toast('No data','error');return;}
  const keys=Object.keys(rows[0]);
  const csv=[keys.join(','),...rows.map(r=>keys.map(k=>`"${String(r[k]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`${name}_${new Date().toISOString().slice(0,10)}.csv`;a.click();
}

window._toast = _toast;

// ── Init ───────────────────────────────────────────────
await Promise.all([loadDepartments(), loadVacancies()]);
