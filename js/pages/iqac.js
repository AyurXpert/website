import { requireAuth, getCurrentProfile, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','doctor','receptionist'], 'index.html');
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const profile  = getCurrentProfile();
const tenant   = getCurrentTenant();
const tenantId = getCurrentTenantId();
const now      = new Date();
const todayStr = now.toISOString().split('T')[0];

// NCISM IQAC composition §12.1
const MEMBERS = [
  { key:'principal',   label:'Principal / Dean',             role:'Chairperson',   required:true  },
  { key:'ms',          label:'Medical Superintendent',       role:'Co-chair',      required:true  },
  { key:'kay_hod',     label:'HOD — Kayachikitsa',           role:'Member',        required:true  },
  { key:'pk_hod',      label:'HOD — Panchakarma',            role:'Member',        required:true  },
  { key:'shal_hod',    label:'HOD — Shalya Tantra',          role:'Member',        required:true  },
  { key:'shalak_hod',  label:'HOD — Shalakya Tantra',        role:'Member',        required:true  },
  { key:'pst_hod',     label:'HOD — Prasuti & Streeroga',    role:'Member',        required:true  },
  { key:'kau_hod',     label:'HOD — Kaumarabhritya',         role:'Member',        required:true  },
  { key:'agd_hod',     label:'HOD — Agada Tantra',           role:'Member',        required:true  },
  { key:'sw_hod',      label:'HOD — Swasthavritta & Yoga',   role:'Member',        required:true  },
  { key:'nursing',     label:'Nursing Superintendent',       role:'Member',        required:false },
  { key:'pharmacist',  label:'Chief Pharmacist',             role:'Member',        required:false },
  { key:'lab',         label:'Lab In-charge',                role:'Member',        required:false },
  { key:'admin',       label:'Administrative Officer',       role:'Member',        required:false },
];

// Build member checklist
const mcWrap = document.getElementById('member-checklist');
mcWrap.innerHTML = MEMBERS.map(m=>`
  <label class="member-item" id="mi-${m.key}" data-onclick="toggleMember" data-onclick-a0="@this">
    <input type="checkbox" id="mc-${m.key}" value="${m.key}" data-onchange="toggleMemberCb" data-onchange-a0="@this"/>
    <div>
      <div style="font-weight:500">${m.label}</div>
      <div style="font-size:10px;color:var(--text-muted)">${m.role}${m.required?' · Required':' · Optional'}</div>
    </div>
  </label>`).join('');

window.toggleMember = function(label) {
  const cb = label.querySelector('input[type=checkbox]');
  label.classList.toggle('checked', cb.checked);
};
window.toggleMemberCb = function(cb) {
  toggleMember(cb.closest('label'));
};

// Year filter
const yearSel = document.getElementById('year-filter');
for (let y = now.getFullYear(); y >= 2024; y--) {
  const o = document.createElement('option'); o.value = y; o.textContent = y; yearSel.appendChild(o);
}
yearSel.value = now.getFullYear();

// Defaults
document.getElementById('m-date').value = todayStr;
const nextQ = new Date(now); nextQ.setMonth(nextQ.getMonth() + 3);
document.getElementById('m-next').value = nextQ.toISOString().split('T')[0];

// ─── Live QI pull ─────────────────────────────────────────
async function loadLiveQI() {
  const todayStart = todayStr + 'T00:00:00';
  const todayEnd   = todayStr + 'T23:59:59';
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [visRes, bedRes, tRow, complRes] = await Promise.all([
    supabase.from('visits').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('created_at',todayStart).lte('created_at',todayEnd),
    supabase.from('beds').select('id,status').eq('tenant_id',tenantId),
    supabase.from('tenants').select('opd_daily_target,ug_intake').eq('id',tenantId).single(),
    supabase.from('visits').select('id',{count:'exact',head:true}).eq('tenant_id',tenantId).gte('created_at',monthStart),
  ]);

  const todayVisits = visRes.count || 0;
  const beds        = bedRes.data  || [];
  const totalBeds   = beds.length;
  const occupiedBeds= beds.filter(b=>b.status==='occupied').length;
  const dailyTgt    = tRow.data?.opd_daily_target || (tRow.data?.ug_intake * 2) || 0;
  const opdPct      = dailyTgt > 0 ? Math.round(todayVisits / dailyTgt * 100) : null;
  const ipdPct      = totalBeds > 0 ? Math.round(occupiedBeds / totalBeds * 100) : null;
  const monthVisits = complRes.count || 0;

  const opdCls  = opdPct === null ? '' : opdPct >= 80 ? '' : opdPct >= 50 ? 'warn' : 'bad';
  const ipdCls  = ipdPct === null ? '' : ipdPct >= 60 ? '' : ipdPct >= 40 ? 'warn' : 'bad';

  document.getElementById('qi-grid').innerHTML = [
    { val: todayVisits, lbl:'OPD Today', sub: dailyTgt ? `target: ${dailyTgt}` : '', cls:opdCls },
    { val: opdPct !== null ? opdPct+'%' : '—', lbl:'OPD Attendance %', sub:'vs NCISM target', cls:opdCls },
    { val: ipdPct !== null ? ipdPct+'%' : '—', lbl:'IPD Occupancy', sub:`${occupiedBeds}/${totalBeds} beds`, cls:ipdCls },
    { val: monthVisits, lbl:'OPD This Month', sub:'all visits', cls:'' },
    { val: totalBeds, lbl:'Total Beds', sub:'configured', cls:'' },
  ].map(c=>`<div class="qi-card ${c.cls}">
    <div class="qi-val">${c.val??'—'}</div>
    <div class="qi-lbl">${c.lbl}</div>
    ${c.sub ? `<div style="font-size:10px;color:var(--text-muted);margin-top:1px">${c.sub}</div>` : ''}
  </div>`).join('');

  // Pre-fill form fields with live values for convenience
  if (opdPct !== null) document.getElementById('m-opd-pct').placeholder = `Live: ${opdPct}%`;
  if (ipdPct !== null) document.getElementById('m-ipd-pct').placeholder = `Live: ${ipdPct}%`;
}

// ─── Dept selector for action items ──────────────────────
async function loadDepts() {
  const { data } = await supabase.from('departments').select('id,name').eq('tenant_id',tenantId).eq('is_active',true).order('name');
  const opts = '<option value="">— Dept —</option>' + (data||[]).map(d=>`<option value="${d.id}">${_esc(d.name)}</option>`).join('');
  document.querySelectorAll('.dept-sel').forEach(sel => { sel.innerHTML = opts; });
  window._deptOpts = opts;
}

window.addActionRow = function() {
  const tbody = document.getElementById('action-tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="dept-sel" style="width:100%;height:30px;border:1px solid var(--border);border-radius:5px;padding:0 6px;font-size:12px;font-family:'DM Sans',sans-serif">${window._deptOpts||'<option value="">— Dept —</option>'}</select></td>
    <td><input type="text" placeholder="Action required…"/></td>
    <td><input type="text" placeholder="Responsible person"/></td>
    <td><input type="date"/></td>
    <td><button class="action-rm" data-onclick="removeActionRow" data-onclick-a0="@this">×</button></td>`;
  tbody.appendChild(tr);
};
window.removeActionRow = function(btn) {
  const rows = document.getElementById('action-tbody').querySelectorAll('tr');
  if (rows.length > 1) btn.closest('tr').remove();
};

function collectActionItems() {
  return [...document.getElementById('action-tbody').querySelectorAll('tr')].map(tr => {
    const inputs = tr.querySelectorAll('input,select');
    const dept   = inputs[0].value;
    const action = inputs[1].value.trim();
    const resp   = inputs[2].value.trim();
    const deadline = inputs[3].value;
    if (!action) return null;
    return { dept, action, responsible:resp, deadline, status:'open' };
  }).filter(Boolean);
}

// ─── Load meetings ────────────────────────────────────────
let _allMeetings = [];

window.loadMeetings = async function() {
  const year  = yearSel.value;
  const tbody = document.getElementById('meetings-tbody');
  tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div></td></tr>';

  let q = supabase.from('iqac_meetings').select('*').eq('tenant_id',tenantId).order('meeting_date',{ascending:false});
  if (year) q = q.gte('meeting_date',year+'-01-01').lte('meeting_date',year+'-12-31');
  const { data, error } = await q;

  if (error) {
    if (error.code === '42P01') {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run iqac_meetings SQL in Supabase to activate this module</div></div></td></tr>';
    } else {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(error.message)}</div></div></td></tr>`;
    }
    return;
  }

  _allMeetings = data || [];
  renderStats(_allMeetings);
  renderCompliance(_allMeetings);

  if (!_allMeetings.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">📋</div><div class="empty-ttl">No IQAC meetings recorded yet</div><div class="empty-bod">Record the first meeting to start quarterly compliance tracking</div></div></td></tr>';
    return;
  }

  let html = '';
  _allMeetings.forEach((m, i) => {
    const actions     = m.action_items || [];
    const openActions = actions.filter(a => a.status === 'open').length;
    const present     = (m.members_present || []).length;
    const total       = MEMBERS.length;
    const membersCls  = present >= 10 ? 'color:var(--green-mid)' : present >= 7 ? 'color:var(--gold)' : 'color:var(--red)';
    const opdCls      = m.opd_pct == null ? '' : m.opd_pct >= 80 ? 'color:var(--green-mid)' : m.opd_pct >= 50 ? 'color:var(--gold)' : 'color:var(--red)';
    const ipdCls      = m.ipd_pct == null ? '' : m.ipd_pct >= 60 ? 'color:var(--green-mid)' : m.ipd_pct >= 40 ? 'color:var(--gold)' : 'color:var(--red)';

    html += `<tr style="cursor:pointer" data-onclick="toggleDetail" data-onclick-a0="${i}">
      <td style="font-size:16px;text-align:center;color:var(--text-muted)" id="expand-${i}">▶</td>
      <td style="font-weight:600;white-space:nowrap">${m.meeting_date}</td>
      <td><span class="pill pill-${m.meeting_type}">${_typeLabel(m.meeting_type)}</span></td>
      <td style="font-size:12px">${_esc(m.chairperson||'—')}</td>
      <td style="font-size:12px"><span style="${membersCls};font-weight:600">${present}/${total}</span></td>
      <td style="${opdCls};font-weight:600">${m.opd_pct != null ? m.opd_pct+'%' : '—'}</td>
      <td style="${ipdCls};font-weight:600">${m.ipd_pct != null ? m.ipd_pct+'%' : '—'}</td>
      <td>
        ${actions.length > 0 ? `<span style="font-size:13px;font-weight:600">${actions.length}</span>` : '—'}
        ${openActions > 0 ? `<span class="open-action-chip">${openActions} open</span>` : ''}
      </td>
      <td><span class="pill pill-${m.status}">${m.status==='completed'?'Completed':'Scheduled'}</span></td>
    </tr>
    <tr class="detail-row" id="detail-${i}">
      <td class="detail-cell" colspan="9">${renderDetailCell(m)}</td>
    </tr>`;
  });
  tbody.innerHTML = html;
};

function renderDetailCell(m) {
  const actions = m.action_items || [];
  const actionRows = actions.length
    ? actions.map(a=>`<tr>
        <td style="font-size:12px">${_esc(a.dept||'—')}</td>
        <td style="font-size:12px">${_esc(a.action)}</td>
        <td style="font-size:12px">${_esc(a.responsible||'—')}</td>
        <td style="font-size:12px">${a.deadline||'—'}</td>
        <td><span style="background:${a.status==='open'?'var(--red-light)':'var(--green-light)'};color:${a.status==='open'?'var(--red)':'var(--green-deep)'};padding:1px 8px;border-radius:8px;font-size:10px;font-weight:700">${a.status||'open'}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);font-size:12px;padding:10px">No action items recorded</td></tr>';

  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:12px">
    <div>
      ${m.agenda ? `<div style="margin-bottom:8px"><strong>Agenda:</strong><div style="color:var(--text-mid);white-space:pre-line;margin-top:2px">${_esc(m.agenda)}</div></div>` : ''}
      ${m.atr ? `<div style="margin-bottom:8px"><strong>ATR (prev. meeting):</strong><div style="color:var(--text-mid);margin-top:2px">${_esc(m.atr)}</div></div>` : ''}
      ${m.minutes ? `<div><strong>Minutes:</strong><div style="color:var(--text-mid);margin-top:2px">${_esc(m.minutes)}</div></div>` : ''}
    </div>
    <div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${m.satisfaction_score ? `<div><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Patient Satisfaction</div><div style="font-weight:700;font-size:16px">${m.satisfaction_score}/10</div></div>` : ''}
        ${m.complaint_count != null ? `<div><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Complaints</div><div style="font-weight:700;font-size:16px">${m.complaint_count} <small style="font-size:11px;font-weight:400">(${m.complaint_resolved||0} resolved)</small></div></div>` : ''}
        ${m.infection_count != null ? `<div><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">HAI</div><div style="font-weight:700;font-size:16px;color:${m.infection_count>0?'var(--red)':'var(--green-mid)'}">${m.infection_count}</div></div>` : ''}
        ${m.mortality_count != null ? `<div><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Mortality</div><div style="font-weight:700;font-size:16px;color:${m.mortality_count>0?'var(--red)':'var(--green-mid)'}">${m.mortality_count}</div></div>` : ''}
      </div>
      ${m.teaching_quality ? `<div style="margin-bottom:8px"><strong>Teaching Quality:</strong><div style="color:var(--text-mid);margin-top:2px">${_esc(m.teaching_quality)}</div></div>` : ''}
      ${m.accreditation_status ? `<div><strong>Accreditation:</strong> <span style="background:var(--purple-light);color:var(--purple);padding:1px 8px;border-radius:8px;font-size:11px;font-weight:600">${_esc(m.accreditation_status)}</span></div>` : ''}
      ${m.next_meeting_date ? `<div style="margin-top:8px"><strong>Next meeting:</strong> ${m.next_meeting_date}</div>` : ''}
    </div>
  </div>
  <div style="margin-top:12px">
    <strong style="font-size:12px">Action Items:</strong>
    <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:12px">
      <thead><tr style="background:#e8f5ee"><th style="padding:5px 8px;text-align:left">Department</th><th style="padding:5px 8px;text-align:left">Action</th><th style="padding:5px 8px;text-align:left">Responsible</th><th style="padding:5px 8px;text-align:left">Deadline</th><th style="padding:5px 8px;text-align:left">Status</th></tr></thead>
      <tbody>${actionRows}</tbody>
    </table>
  </div>`;
}

window.toggleDetail = function(i) {
  const row = document.getElementById('detail-'+i);
  const exp = document.getElementById('expand-'+i);
  const isOpen = row.classList.toggle('show');
  exp.textContent = isOpen ? '▼' : '▶';
};

function renderStats(data) {
  const yearData = data.filter(m => m.meeting_date?.startsWith(now.getFullYear()+''));
  const allActions  = data.flatMap(m => m.action_items || []);
  const openActions = allActions.filter(a => a.status === 'open').length;
  const avgOPD = data.filter(m=>m.opd_pct!=null).length
    ? Math.round(data.filter(m=>m.opd_pct!=null).reduce((s,m)=>s+(m.opd_pct||0),0) / data.filter(m=>m.opd_pct!=null).length)
    : null;
  document.getElementById('s-total').textContent   = data.length;
  document.getElementById('s-year').textContent    = yearData.length;
  document.getElementById('s-actions').textContent = allActions.length;
  document.getElementById('s-open').textContent    = openActions;
  document.getElementById('s-qi').textContent      = avgOPD !== null ? avgOPD+'%' : '—';
}

function renderCompliance(data) {
  const banner = document.getElementById('compliance-banner');
  const completed = data.filter(m=>m.status==='completed').sort((a,b)=>b.meeting_date.localeCompare(a.meeting_date));
  if (!completed.length) {
    banner.className = 'compliance-banner red';
    banner.innerHTML = `<div class="cb-icon">🚨</div><div class="cb-body">
      <div class="cb-title">No IQAC meetings recorded — §12.1 NCISM violation</div>
      <div class="cb-sub">IQAC must meet at least once per quarter (every 90 days). Record the inaugural meeting immediately.</div>
    </div>`;
    return;
  }
  const lastDate  = new Date(completed[0].meeting_date);
  const daysSince = Math.floor((now - lastDate) / 86400000);
  const daysLeft  = 90 - daysSince;
  const pct       = Math.min(Math.round(daysSince / 90 * 100), 100);
  const metThisYear = data.filter(m => m.status==='completed' && m.meeting_date?.startsWith(now.getFullYear()+'')).length;

  let cls, icon, title, sub, barColor;
  if (daysSince <= 70) {
    cls='green'; icon='✅'; barColor='var(--green-mid)';
    title = `IQAC compliance maintained — last meeting ${daysSince} day${daysSince!==1?'s':''} ago`;
    sub = `Next meeting due in ${daysLeft} days. ${metThisYear} meeting${metThisYear!==1?'s':''} held this year (NCISM requires ≥4). ${completed[0].next_meeting_date ? 'Scheduled: '+completed[0].next_meeting_date:''}`;
  } else if (daysSince <= 90) {
    cls='amber'; icon='⚠️'; barColor='var(--gold)';
    title = `IQAC meeting approaching overdue — ${daysSince} days since last meeting`;
    sub = `Must meet within ${daysLeft} day${daysLeft!==1?'s':''} to remain quarterly-compliant (§12.1). Schedule immediately.`;
  } else {
    cls='red'; icon='🚨'; barColor='var(--red)';
    title = `IQAC OVERDUE — ${daysSince} days since last meeting (90-day limit exceeded)`;
    sub = `§12.1 NCISM violation: IQAC has not met this quarter. Record the missed meeting and schedule the next one urgently.`;
  }

  const reqMeetings = 4;
  const yearWarning = metThisYear < 4 && now.getMonth() >= 9
    ? ` <span style="color:var(--red);font-weight:600"> · ⚠ Only ${metThisYear}/4 required meetings this year</span>` : '';

  banner.className = 'compliance-banner ' + cls;
  banner.innerHTML = `<div class="cb-icon">${icon}</div><div class="cb-body">
    <div class="cb-title">${title}</div>
    <div class="cb-sub">${sub}${yearWarning}</div>
    <div class="cb-bar-wrap"><div class="cb-bar" style="width:${pct}%;background:${barColor}"></div></div>
    <div style="font-size:10px;margin-top:4px;opacity:.7">Last meeting: ${completed[0].meeting_date} · ${pct}% of 90-day period elapsed · ${metThisYear}/${reqMeetings} meetings this year</div>
  </div>`;
}

// ─── Save meeting ─────────────────────────────────────────
window.saveMeeting = async function() {
  const date = document.getElementById('m-date').value;
  if (!date) { showModalAlert('Meeting date is required','error'); return; }
  const btn = document.getElementById('save-btn');
  btn.disabled = true;

  const presentMembers = MEMBERS.filter(m => document.getElementById('mc-'+m.key)?.checked).map(m=>m.key);
  const actionItems    = collectActionItems();

  const payload = {
    tenant_id:     tenantId,
    created_by:    profile.id,
    meeting_date:  date,
    meeting_type:  document.getElementById('m-type').value,
    status:        document.getElementById('m-status').value,
    chairperson:   document.getElementById('m-chair').value.trim()||null,
    venue:         document.getElementById('m-venue').value.trim()||null,
    members_present: presentMembers,
    extra_members: document.getElementById('m-extra-members').value.trim()||null,
    opd_pct:       parseFloat(document.getElementById('m-opd-pct').value)||null,
    ipd_pct:       parseFloat(document.getElementById('m-ipd-pct').value)||null,
    satisfaction_score: parseFloat(document.getElementById('m-satisfaction').value)||null,
    complaint_count:    parseInt(document.getElementById('m-complaints').value)||0,
    complaint_resolved: parseInt(document.getElementById('m-resolved').value)||0,
    infection_count:    parseInt(document.getElementById('m-infections').value)||0,
    mortality_count:    parseInt(document.getElementById('m-mortality').value)||0,
    staff_attendance_pct: parseFloat(document.getElementById('m-staff-att').value)||null,
    agenda:        document.getElementById('m-agenda').value.trim()||null,
    atr:           document.getElementById('m-atr').value.trim()||null,
    teaching_quality: document.getElementById('m-teaching').value.trim()||null,
    accreditation_status: document.getElementById('m-accred').value||null,
    action_items:  actionItems,
    next_meeting_date: document.getElementById('m-next').value||null,
    minutes:       document.getElementById('m-minutes').value.trim()||null,
    minutes_by:    document.getElementById('m-minutes-by').value.trim()||null,
    remarks:       document.getElementById('m-remarks').value.trim()||null,
  };

  const { error } = await supabase.from('iqac_meetings').insert(payload);
  btn.disabled = false;
  if (error) {
    if (error.code === '42P01') {
      showModalAlert('Run iqac_meetings SQL in Supabase SQL Editor first','error');
    } else {
      showModalAlert(error.message,'error');
    }
    return;
  }
  closeModal(); _toast('IQAC meeting recorded ✓'); loadMeetings(); resetModal();
};

function resetModal() {
  document.getElementById('m-date').value = todayStr;
  ['m-chair','m-venue','m-extra-members','m-opd-pct','m-ipd-pct','m-satisfaction',
   'm-complaints','m-resolved','m-infections','m-mortality','m-staff-att',
   'm-agenda','m-atr','m-teaching','m-minutes-by','m-minutes','m-remarks'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('m-accred').value = '';
  document.getElementById('m-type').value = 'quarterly';
  document.getElementById('m-status').value = 'completed';
  MEMBERS.forEach(m=>{ const cb=document.getElementById('mc-'+m.key); const lbl=document.getElementById('mi-'+m.key); if(cb)cb.checked=false; if(lbl)lbl.classList.remove('checked'); });
  document.getElementById('action-tbody').innerHTML = `<tr>
    <td><select class="dept-sel" style="width:100%;height:30px;border:1px solid var(--border);border-radius:5px;padding:0 6px;font-size:12px;font-family:'DM Sans',sans-serif">${window._deptOpts||'<option value="">— Dept —</option>'}</select></td>
    <td><input type="text" placeholder="Action required…"/></td>
    <td><input type="text" placeholder="Responsible person"/></td>
    <td><input type="date"/></td>
    <td><button class="action-rm" data-onclick="removeActionRow" data-onclick-a0="@this">×</button></td>
  </tr>`;
  const nextQ = new Date(now); nextQ.setMonth(nextQ.getMonth()+3);
  document.getElementById('m-next').value = nextQ.toISOString().split('T')[0];
}

// ─── Modal ────────────────────────────────────────────────
window.openModal = function() { document.getElementById('modal-overlay').classList.add('show'); };
window.closeModal = function() { document.getElementById('modal-overlay').classList.remove('show'); document.getElementById('modal-alert').classList.remove('show'); };

// ─── Export ───────────────────────────────────────────────
window.exportRegister = function() {
  if (!_allMeetings.length) { _toast('No data to export'); return; }
  const rows = [
    ['Date','Type','Status','Chairperson','Venue','Members Present','OPD%','IPD%','Satisfaction','Complaints','Resolved','HAI','Mortality','Staff%','Action Items','Next Meeting','Accreditation'],
    ..._allMeetings.map(m=>[
      m.meeting_date, m.meeting_type||'', m.status||'', m.chairperson||'', m.venue||'',
      (m.members_present||[]).length, m.opd_pct||'', m.ipd_pct||'',
      m.satisfaction_score||'', m.complaint_count||0, m.complaint_resolved||0,
      m.infection_count||0, m.mortality_count||0, m.staff_attendance_pct||'',
      (m.action_items||[]).length, m.next_meeting_date||'', m.accreditation_status||''
    ])
  ];
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='IQAC_Meeting_Register.csv'; a.click();
};

// ─── Helpers ─────────────────────────────────────────────
function _typeLabel(t){ return {quarterly:'Quarterly',special:'Special',annual:'Annual'}[t]||t||'—'; }
function showModalAlert(msg,type){ const el=document.getElementById('modal-alert'); el.textContent=msg; el.className=`alert ${type} show`; }
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg,isErr=false){ const el=document.getElementById('toast'); el.textContent=msg; el.style.background=isErr?'#7f1d1d':'#1c2b1f'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

// Boot
await Promise.all([loadLiveQI(), loadDepts(), loadMeetings()]);
