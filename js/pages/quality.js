import { requireAuth, hasModule, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { safeErrorMessage } from '../utils/errors.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

const ALLOWED = ['super_admin','dept_admin'];
await requireAuth(ALLOWED);
if (!hasModule('quality')) { window.location.replace('admin.html'); }
wireDelegatedEvents();

const profile   = getCurrentProfile();
const tenantId  = getCurrentTenantId();
const today     = new Date().toISOString().slice(0,10);
const thisMonth = today.slice(0,7);

initNavbar();

// ── State ─────────────────────────────────────────────────
let _incidents = [], _feedback = [];
let _editingIncId = null;
let _fbRatings = { overall:0, doctor:0, staff:0, facility:0, wait_time:0 };
let _fbPatientId = null;
let _fbSearchTimer;

// ── Feedback ratings grid (built once — was a broken raw-HTML template literal before) ──
const FB_RATING_LABELS = { overall:'Overall Experience', doctor:'Doctor / Vaidya', staff:'Support Staff', facility:'Facility & Cleanliness', wait_time:'Wait Time' };
function _buildFbRatingsGrid() {
  const stars = ['overall','doctor','staff','facility','wait_time'].map(k => `
    <div class="field">
      <label>${FB_RATING_LABELS[k]}</label>
      <div class="star-rating" id="stars-${k}" data-key="${k}">
        ${[1,2,3,4,5].map(i=>`<span data-val="${i}" data-onclick="setRating" data-onclick-a0="${k}" data-onclick-a1="${i}">★</span>`).join('')}
      </div>
    </div>`).join('');
  const recommend = `
    <div class="field">
      <label>Would Recommend?</label>
      <select id="fb-recommend">
        <option value="">— Select —</option>
        <option value="true">Yes, definitely</option>
        <option value="false">No</option>
      </select>
    </div>`;
  document.getElementById('fb-ratings-grid').innerHTML = stars + recommend;
}
_buildFbRatingsGrid();

// ── Tab switch ────────────────────────────────────────────
window.switchTab = function(id) {
  document.querySelectorAll('.tab-btn').forEach((b,i) =>
    b.classList.toggle('active', ['incidents','feedback','grievances','overview'][i] === id));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === 'tab-' + id));
  if (id === 'grievances') loadGrievances();
};

// ── §21z Patient Grievances ────────────────────────────────────────────────
let _grievances = [];
window.loadGrievances = async function() {
  const el = document.getElementById('griev-tbody');
  let q = supabase.from('patient_grievances').select('*,profiles!received_by(full_name)')
    .eq('tenant_id',tenantId).order('received_date',{ascending:false});
  const st = document.getElementById('griev-status').value;
  const tp = document.getElementById('griev-type').value;
  if (st) q = q.eq('status',st);
  if (tp) q = q.eq('complaint_type',tp);
  const { data, error } = await q;
  if (error) {
    el.innerHTML = `<div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${error.code==='42P01'?'Run session32_ncism_gaps.sql first':safeErrorMessage(error, 'Could not load data.')}</div></div>`;
    return;
  }
  _grievances = data || [];
  if (!_grievances.length) { el.innerHTML = '<div class="empty"><div class="empty-ico">✅</div><div class="empty-ttl">No grievances on record</div></div>'; return; }
  const statusColors = { received:'#e8f5ee', under_review:'#fff8e1', resolved:'#e8f5ee', escalated:'#fdecea', closed:'#f5f5f5' };
  const statusText   = { received:'Received', under_review:'Under Review', resolved:'Resolved', escalated:'Escalated', closed:'Closed' };
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f5faf7"><th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1.5px solid var(--border)">Date</th>
    <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1.5px solid var(--border)">Patient</th>
    <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1.5px solid var(--border)">Type</th>
    <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1.5px solid var(--border)">Description</th>
    <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1.5px solid var(--border)">Status</th>
    <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--text-muted);border-bottom:1.5px solid var(--border)">Action</th>
    </tr></thead><tbody>
    ${_grievances.map(g=>`<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${g.received_date}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;font-weight:500">${g.patient_name||'—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${(g.complaint_type||'').replace(/_/g,' ')}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${g.description}">${g.description||'—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2"><span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;background:${statusColors[g.status]||'#f5f5f5'}">${statusText[g.status]||g.status}</span></td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">
        <select data-onchange="updateGrievanceStatus" data-onchange-a0="${g.id}" data-onchange-a1="@value" style="height:28px;border:1px solid var(--border);border-radius:5px;font-size:11px;padding:0 6px;font-family:inherit">
          <option value="">Change status…</option>
          <option value="under_review">Under Review</option>
          <option value="resolved">Resolved</option>
          <option value="escalated">Escalated</option>
          <option value="closed">Closed</option>
        </select>
      </td>
    </tr>`).join('')}
    </tbody></table>`;
};

window.updateGrievanceStatus = async function(id, status) {
  if (!status) return;
  const updates = { status };
  if (status === 'resolved') updates.resolved_date = new Date().toISOString().slice(0,10);
  await supabase.from('patient_grievances').update(updates).eq('id',id).eq('tenant_id',tenantId);
  loadGrievances();
};

window.openGrievanceModal = function() {
  document.getElementById('griev-modal').style.display = 'flex';
  document.getElementById('griev-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('griev-pt-name').value = '';
  document.getElementById('griev-desc').value = '';
};
window.closeGrievanceModal = function() { document.getElementById('griev-modal').style.display = 'none'; };
window.saveGrievance = async function() {
  const desc = document.getElementById('griev-desc').value.trim();
  const type = document.getElementById('griev-ctype').value;
  if (!desc || !type) { alert('Complaint type and description are required'); return; }
  const { error } = await supabase.from('patient_grievances').insert({
    tenant_id:      tenantId,
    received_date:  document.getElementById('griev-date').value,
    patient_name:   document.getElementById('griev-pt-name').value.trim() || null,
    complaint_type: type,
    description:    desc,
    received_by:    profile.id,
    status:         'received',
  });
  if (error) { alert(safeErrorMessage(error)); return; }
  closeGrievanceModal();
  loadGrievances();
};

// ── KPIs ──────────────────────────────────────────────────
function updateKPIs() {
  const open      = _incidents.filter(i => i.status === 'open').length;
  const sentinel  = _incidents.filter(i => ['sentinel','major'].includes(i.severity) && i.incident_date?.startsWith(thisMonth)).length;
  const closedMth = _incidents.filter(i => i.status === 'closed' && i.incident_date?.startsWith(thisMonth)).length;
  const fbMth     = _feedback.filter(f => f.submitted_at?.startsWith(thisMonth)).length;
  const ratings   = _feedback.filter(f => f.overall_rating).map(f => f.overall_rating);
  const avgRating = ratings.length ? (ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(1) : '—';
  const recCount  = _feedback.filter(f => f.would_recommend !== null);
  const recPct    = recCount.length ? Math.round(recCount.filter(f=>f.would_recommend).length/recCount.length*100) : '—';

  document.getElementById('k-open').textContent     = open;
  document.getElementById('k-sentinel').textContent = sentinel;
  document.getElementById('k-rating').textContent   = avgRating;
  document.getElementById('k-rating-sub').textContent = ratings.length ? `/ 5 · ${ratings.length} responses` : 'No feedback yet';
  document.getElementById('k-feedback').textContent = fbMth;
  document.getElementById('k-recommend').textContent= recPct + (recPct !== '—' ? '%' : '');
  document.getElementById('k-closed').textContent   = closedMth;
}

// ── Incidents ─────────────────────────────────────────────
async function loadIncidents() {
  const { data, error } = await supabase
    .from('incident_reports')
    .select('*,profiles!reported_by(full_name)')
    .eq('tenant_id', tenantId)
    .order('incident_date', { ascending: false });
  if (error && error.code === '42P01') {
    document.getElementById('inc-list').innerHTML =
      '<div class="empty">Incident table not set up yet — run the SQL from the session notes.</div>';
    return;
  }
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  _incidents = data || [];
  filterIncidents();
  renderIncCharts();
  renderIncTrend();
}

window.filterIncidents = function() {
  const type   = document.getElementById('inc-type').value;
  const sev    = document.getElementById('inc-severity').value;
  const status = document.getElementById('inc-status').value;
  const month  = document.getElementById('inc-month').value;
  const list   = _incidents.filter(i =>
    (!type   || i.incident_type === type) &&
    (!sev    || i.severity === status || i.severity === sev) &&
    (!status || i.status === status) &&
    (!month  || i.incident_date?.startsWith(month))
  );
  const el = document.getElementById('inc-list');
  el.innerHTML = list.map(i => `
    <div class="inc-card ${i.severity}">
      <div class="ic-top">
        <div>
          <div class="ic-title">${_typeLabel(i.incident_type)}</div>
          <div class="ic-meta">${_fmtD(i.incident_date)} ${i.incident_time ? '· '+i.incident_time.slice(0,5) : ''} · Reported by ${i.profiles?.full_name||'—'}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <span class="badge b-${i.severity}">${i.severity}</span>
          <span class="badge b-${i.status}">${i.status.replace('_',' ')}</span>
        </div>
      </div>
      <div class="ic-desc">"${i.description?.slice(0,200)}${(i.description?.length||0)>200?'…':''}"</div>
      ${i.immediate_action ? `<div style="font-size:12px;color:var(--text-mid);margin-bottom:6px"><strong>Action:</strong> ${i.immediate_action}</div>` : ''}
      ${i.root_cause ? `<div style="font-size:12px;color:var(--text-mid);margin-bottom:6px"><strong>Root cause:</strong> ${i.root_cause}</div>` : ''}
      ${i.corrective_action ? `<div style="font-size:12px;color:var(--green-mid);margin-bottom:6px"><strong>Corrective action:</strong> ${i.corrective_action}</div>` : ''}
      <div class="ic-actions">
        ${i.status !== 'closed' ? `<button class="btn btn-outline btn-sm" data-onclick="openIncUpdate" data-onclick-a0="${i.id}">Update Status</button>` : ''}
      </div>
    </div>`).join('') || '<div class="empty">No incidents found for selected filters</div>';
};

function renderIncCharts() {
  const sevMap = { minor:0, moderate:0, major:0, sentinel:0 };
  const typeMap = {};
  _incidents.forEach(i => {
    sevMap[i.severity] = (sevMap[i.severity]||0)+1;
    typeMap[i.incident_type] = (typeMap[i.incident_type]||0)+1;
  });
  const maxS = Math.max(...Object.values(sevMap)) || 1;
  const colors = { minor:'green', moderate:'gold', major:'orange', sentinel:'red' };
  document.getElementById('inc-sev-chart').innerHTML =
    Object.entries(sevMap).map(([k,v]) =>
      `<div class="bar-row"><div class="bar-label">${k.charAt(0).toUpperCase()+k.slice(1)}</div>
      <div class="bar-track"><div class="bar-fill ${colors[k]}" style="width:${Math.round(v/maxS*100)}%"></div></div>
      <div class="bar-count">${v}</div></div>`).join('');
  const typeArr = Object.entries(typeMap).sort((a,b)=>b[1]-a[1]);
  const maxT = typeArr[0]?.[1] || 1;
  document.getElementById('inc-type-chart').innerHTML =
    typeArr.map(([k,v]) =>
      `<div class="bar-row"><div class="bar-label">${_typeLabel(k)}</div>
      <div class="bar-track"><div class="bar-fill green" style="width:${Math.round(v/maxT*100)}%"></div></div>
      <div class="bar-count">${v}</div></div>`).join('') || '<div class="empty">No data</div>';
}

function renderIncTrend() {
  const monthMap = {};
  _incidents.forEach(i => {
    const m = i.incident_date?.slice(0,7);
    if (m) monthMap[m] = (monthMap[m]||0)+1;
  });
  const months = Object.keys(monthMap).sort().slice(-6);
  const maxM = Math.max(...months.map(m=>monthMap[m])) || 1;
  document.getElementById('inc-trend-chart').innerHTML =
    months.map(m => `<div class="bar-row">
      <div class="bar-label">${new Date(m+'-01').toLocaleDateString('en-IN',{month:'short',year:'numeric'})}</div>
      <div class="bar-track"><div class="bar-fill red" style="width:${Math.round(monthMap[m]/maxM*100)}%"></div></div>
      <div class="bar-count">${monthMap[m]}</div></div>`).join('') ||
    '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No incidents recorded yet</div>';
}

// Incident modal
window.openIncModal = function() {
  _editingIncId = null;
  document.getElementById('inc-modal-title').textContent = 'Report Incident';
  document.getElementById('im-date').value    = today;
  document.getElementById('im-time').value    = new Date().toTimeString().slice(0,5);
  document.getElementById('im-type').value    = 'adverse_event';
  document.getElementById('im-severity').value= 'minor';
  document.getElementById('im-desc').value    = '';
  document.getElementById('im-action').value  = '';
  document.getElementById('im-status').value  = 'open';
  document.getElementById('im-root').value    = '';
  document.getElementById('im-corrective').value = '';
  document.getElementById('inc-modal').classList.add('show');
};
window.closeIncModal = function() { document.getElementById('inc-modal').classList.remove('show'); };

window.saveIncident = async function() {
  const desc = document.getElementById('im-desc').value.trim();
  const date = document.getElementById('im-date').value;
  if (!desc || !date) { _toast('Date and description are required','error'); return; }
  const payload = {
    tenant_id: tenantId, incident_date: date,
    incident_time: document.getElementById('im-time').value || null,
    incident_type: document.getElementById('im-type').value,
    severity:      document.getElementById('im-severity').value,
    description:   desc,
    immediate_action:  document.getElementById('im-action').value.trim()||null,
    status:            document.getElementById('im-status').value,
    root_cause:        document.getElementById('im-root').value.trim()||null,
    corrective_action: document.getElementById('im-corrective').value.trim()||null,
    reported_by:       profile.id,
  };
  const { error } = await supabase.from('incident_reports').insert(payload);
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeIncModal();
  _toast('Incident reported','success');
  await loadIncidents();
  updateKPIs();
};

window.openIncUpdate = function(id) {
  _editingIncId = id;
  const inc = _incidents.find(i=>i.id===id);
  document.getElementById('iu-status').value    = inc?.status || 'open';
  document.getElementById('iu-root').value      = inc?.root_cause || '';
  document.getElementById('iu-corrective').value= inc?.corrective_action || '';
  document.getElementById('inc-update-modal').classList.add('show');
};
window.closeIncUpdateModal = function() { document.getElementById('inc-update-modal').classList.remove('show'); _editingIncId=null; };

window.updateIncident = async function() {
  const { error } = await supabase.from('incident_reports').update({
    status:            document.getElementById('iu-status').value,
    root_cause:        document.getElementById('iu-root').value.trim()||null,
    corrective_action: document.getElementById('iu-corrective').value.trim()||null,
    reviewed_by:       profile.id,
    ...(document.getElementById('iu-status').value==='closed' ? { closed_at: new Date().toISOString() } : {}),
  }).eq('id', _editingIncId);
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeIncUpdateModal();
  _toast('Incident updated','success');
  await loadIncidents();
  updateKPIs();
};

window.exportIncCSV = function() {
  _csvDownload(_incidents.map(i=>({
    Date:i.incident_date, Type:i.incident_type, Severity:i.severity,
    Description:i.description, ImmediateAction:i.immediate_action,
    RootCause:i.root_cause, CorrectiveAction:i.corrective_action, Status:i.status,
  })), 'incident_reports');
};

// ── Feedback ──────────────────────────────────────────────
async function loadFeedback() {
  const { data, error } = await supabase
    .from('patient_feedback')
    .select('*,patients(name)')
    .eq('tenant_id', tenantId)
    .order('submitted_at', { ascending: false });
  if (error && error.code === '42P01') {
    document.getElementById('fb-list').innerHTML =
      '<div class="empty">Feedback table not set up yet — run the SQL to activate.</div>';
    return;
  }
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  _feedback = data || [];
  renderFbSummary();
  renderFbList();
  renderFbTrend();
  _populateFbMonthFilter();
}

function renderFbSummary() {
  const cats = ['overall','doctor','staff','facility','wait_time'];
  const labels = { overall:'Overall', doctor:'Doctor', staff:'Staff', facility:'Facility', wait_time:'Wait Time' };
  const avgs = {};
  cats.forEach(c => {
    const vals = _feedback.filter(f=>f[c+'_rating']).map(f=>f[c+'_rating']);
    avgs[c] = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
  });
  document.getElementById('fb-avg-ratings').innerHTML = cats.map(c => {
    const avg = avgs[c];
    const stars = avg ? '★'.repeat(Math.round(avg)) + '☆'.repeat(5-Math.round(avg)) : '—';
    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;font-size:13px">
      <div style="width:90px;color:var(--text-mid)">${labels[c]}</div>
      <div style="color:#f5a623;font-size:16px;letter-spacing:1px">${avg ? stars : '—'}</div>
      <div style="font-weight:600;color:var(--green-deep)">${avg ? avg.toFixed(1) : '—'}</div>
    </div>`;
  }).join('');

  const distMap = {5:0,4:0,3:0,2:0,1:0};
  _feedback.forEach(f => { if(f.overall_rating) distMap[f.overall_rating]++; });
  const maxD = Math.max(...Object.values(distMap)) || 1;
  document.getElementById('fb-dist-chart').innerHTML = [5,4,3,2,1].map(s => {
    const cls = s>=4?'green':s===3?'gold':'red';
    return `<div class="bar-row">
      <div class="bar-label">${'★'.repeat(s)} ${s} star</div>
      <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.round(distMap[s]/maxD*100)}%"></div></div>
      <div class="bar-count">${distMap[s]}</div>
    </div>`;
  }).join('');
}

function _populateFbMonthFilter() {
  const months = [...new Set(_feedback.map(f=>f.submitted_at?.slice(0,7)).filter(Boolean))].sort().reverse();
  document.getElementById('fb-filter-month').innerHTML =
    '<option value="">All Time</option>' +
    months.map(m => `<option value="${m}">${new Date(m+'-01').toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</option>`).join('');
}

window.filterFeedback = function() {
  const month = document.getElementById('fb-filter-month').value;
  const list = _feedback.filter(f => !month || f.submitted_at?.startsWith(month));
  renderFbList(list);
};

function renderFbList(list) {
  list = list || _feedback;
  const el = document.getElementById('fb-list');
  if (!list.length) { el.innerHTML = '<div class="empty">No feedback recorded yet</div>'; return; }
  el.innerHTML = list.map(f => {
    const cats = ['overall','doctor','staff','facility','wait_time'];
    const labels = { overall:'Overall', doctor:'Doctor', staff:'Staff', facility:'Facility', wait_time:'Wait Time' };
    return `<div class="fb-card">
      <div class="fb-top">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--green-deep)">${f.patients?.name || 'Anonymous'}</div>
          <div style="font-size:11px;color:var(--text-muted)">${_fmtD(f.submitted_at?.slice(0,10))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:18px;color:#f5a623">${f.overall_rating ? '★'.repeat(f.overall_rating)+'☆'.repeat(5-f.overall_rating) : '—'}</div>
          ${f.would_recommend !== null ? `<div style="font-size:11px;color:${f.would_recommend?'var(--green-mid)':'var(--red)'}">${f.would_recommend?'✓ Would recommend':'✗ Would not recommend'}</div>` : ''}
        </div>
      </div>
      <div class="fb-ratings">
        ${cats.filter(c=>f[c+'_rating']).map(c =>
          `<div class="fb-rating-item">${labels[c]}<span style="color:#f5a623">${'★'.repeat(f[c+'_rating'])}</span></div>`
        ).join('')}
      </div>
      ${f.comments ? `<div style="font-size:12px;color:var(--text-mid);font-style:italic;margin-top:4px">"${f.comments}"</div>` : ''}
    </div>`;
  }).join('');
}

function renderFbTrend() {
  const monthMap = {};
  _feedback.forEach(f => {
    const m = f.submitted_at?.slice(0,7);
    if (!m) return;
    if (!monthMap[m]) monthMap[m] = { sum:0, cnt:0 };
    if (f.overall_rating) { monthMap[m].sum += f.overall_rating; monthMap[m].cnt++; }
  });
  const months = Object.keys(monthMap).sort().slice(-6);
  const maxM = 5;
  document.getElementById('fb-trend-chart').innerHTML =
    months.map(m => {
      const avg = monthMap[m].cnt ? (monthMap[m].sum/monthMap[m].cnt).toFixed(1) : 0;
      return `<div class="bar-row">
        <div class="bar-label">${new Date(m+'-01').toLocaleDateString('en-IN',{month:'short',year:'numeric'})}</div>
        <div class="bar-track"><div class="bar-fill gold" style="width:${Math.round(avg/maxM*100)}%"></div></div>
        <div class="bar-count">${avg||'—'}</div>
      </div>`;
    }).join('') || '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No feedback recorded yet</div>';
}

// Feedback modal
window.openFbModal = function() {
  _fbRatings = { overall:0, doctor:0, staff:0, facility:0, wait_time:0 };
  _fbPatientId = null;
  document.getElementById('fb-patient').value   = '';
  document.getElementById('fb-patient-results').innerHTML = '';
  document.getElementById('fb-comments').value  = '';
  document.getElementById('fb-recommend').value = '';
  ['overall','doctor','staff','facility','wait_time'].forEach(k => _renderStars(k, 0));
  document.getElementById('fb-modal').classList.add('show');
};
window.closeFbModal = function() { document.getElementById('fb-modal').classList.remove('show'); };

window.setRating = function(key, val) {
  _fbRatings[key] = Number(val);
  _renderStars(key, Number(val));
};
function _renderStars(key, val) {
  document.querySelectorAll(`#stars-${key} span`).forEach(s => {
    s.classList.toggle('filled', parseInt(s.dataset.val) <= val);
  });
}

window.searchFbPatient = function() {
  clearTimeout(_fbSearchTimer);
  _fbSearchTimer = setTimeout(async () => {
    const q = document.getElementById('fb-patient').value.trim();
    const el = document.getElementById('fb-patient-results');
    if (q.length < 3) { el.innerHTML=''; return; }
    const isPhone = /^\d{7,}$/.test(q);
    const { data } = isPhone
      ? await supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId).eq('phone',q).limit(5)
      : await supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId).ilike('name',`%${q}%`).limit(5);
    el.innerHTML = (data||[]).map(p =>
      `<div style="padding:6px 10px;cursor:pointer;background:var(--white);border:1px solid var(--border);border-top:none;font-size:12px"
        data-onclick="_selectFbPatient" data-onclick-a0="${p.id}" data-onclick-a1="${_esc(p.name)}">
        ${p.name} · ${p.phone||''}
      </div>`).join('');
  }, 300);
};
window._selectFbPatient = function(id, name) {
  _fbPatientId = id;
  document.getElementById('fb-patient').value = name;
  document.getElementById('fb-patient-results').innerHTML = '';
};

window.saveFeedback = async function() {
  if (!_fbRatings.overall) { _toast('Please rate the overall experience','error'); return; }
  const payload = {
    tenant_id: tenantId,
    patient_id: _fbPatientId || null,
    overall_rating:  _fbRatings.overall || null,
    doctor_rating:   _fbRatings.doctor  || null,
    staff_rating:    _fbRatings.staff   || null,
    facility_rating: _fbRatings.facility|| null,
    wait_time_rating:_fbRatings.wait_time||null,
    comments:        document.getElementById('fb-comments').value.trim()||null,
    would_recommend: document.getElementById('fb-recommend').value === '' ? null
                   : document.getElementById('fb-recommend').value === 'true',
    submitted_at:    new Date().toISOString(),
  };
  const { error } = await supabase.from('patient_feedback').insert(payload);
  if (error) { _toast(safeErrorMessage(error, 'Error. Please try again.'), 'error'); return; }
  closeFbModal();
  _toast('Feedback saved','success');
  await loadFeedback();
  updateKPIs();
};

window.exportFbCSV = function() {
  _csvDownload(_feedback.map(f=>({
    Date:f.submitted_at?.slice(0,10), Patient:f.patients?.name,
    Overall:f.overall_rating, Doctor:f.doctor_rating, Staff:f.staff_rating,
    Facility:f.facility_rating, WaitTime:f.wait_time_rating,
    WouldRecommend:f.would_recommend, Comments:f.comments,
  })), 'patient_feedback');
};

// ── Helpers ───────────────────────────────────────────────
function _typeLabel(t) {
  return {adverse_event:'Adverse Event',near_miss:'Near Miss',complaint:'Patient Complaint',
    medication_error:'Medication Error',fall:'Patient Fall',infection:'Hospital Infection',other:'Other'}[t] || t;
}
function _fmtD(s) {
  if (!s) return '—';
  return new Date(s+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}
function _toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}
function _csvDownload(rows, name) {
  if (!rows.length) { _toast('No data','error'); return; }
  const keys = Object.keys(rows[0]);
  const csv = [keys.join(','),...rows.map(r=>keys.map(k=>`"${String(r[k]||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`${name}_${new Date().toISOString().slice(0,10)}.csv`; a.click();
}

// ── Init ──────────────────────────────────────────────────
await Promise.all([loadIncidents(), loadFeedback()]);
updateKPIs();
