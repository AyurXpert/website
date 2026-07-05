import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','doctor','receptionist'], 'index.html');
initNavbar();
wireDelegatedEvents();

window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const now      = new Date();
const todayStr = now.toISOString().split('T')[0];

// NCISM §48 mandatory cell members
const CELL_MEMBERS = [
  { key:'rasabhaishajya', label:'Rasashastra & Bhaishajyakalpana', role:'Co-ordinator', required:true },
  { key:'dravyaguna',     label:'Dravyaguna',                       role:'Co-ordinator', required:true },
  { key:'kayachikitsa',   label:'Kayachikitsa',                     role:'Member',       required:true },
  { key:'shalya',         label:'Shalya Tantra',                    role:'Member',       required:true },
  { key:'shalakya',       label:'Shalakya Tantra',                  role:'Member',       required:true },
  { key:'prasuti',        label:'Prasuti & Streeroga',              role:'Member',       required:true },
  { key:'kaumar',         label:'Kaumarabhritya',                   role:'Member',       required:true },
  { key:'panchakarma',    label:'Panchakarma',                      role:'Member',       required:true },
  { key:'swasthavritta',  label:'Swasthavritta & Yoga',             role:'Member',       required:true },
  { key:'agada',          label:'Agada Tantra',                     role:'Member',       required:true },
];

// Build member checklist
const mcWrap = document.getElementById('member-checklist');
mcWrap.innerHTML = CELL_MEMBERS.map(m=>`
  <label class="member-item" id="mi-${m.key}" data-onclick="toggleMember" data-onclick-a0="@this">
    <input type="checkbox" id="mc-${m.key}" value="${m.key}" data-onchange="toggleMemberCb" data-onchange-a0="@this"/>
    <div>
      <div style="font-weight:500">${m.label}</div>
      <div style="font-size:10px;color:var(--text-muted)">${m.role}${m.required?' · NCISM required':''}</div>
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
const nextBi = new Date(now); nextBi.setMonth(nextBi.getMonth() + 2);
document.getElementById('m-next').value = nextBi.toISOString().split('T')[0];

// ─── Load meetings ────────────────────────────────────────
let _allMeetings = [];

window.loadMeetings = async function() {
  const year = yearSel.value;
  const tbody = document.getElementById('meetings-tbody');
  tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div></td></tr>';

  let q = supabase.from('pv_meetings').select('*').eq('tenant_id',tenantId).order('meeting_date',{ascending:false});
  if (year) { q = q.gte('meeting_date',year+'-01-01').lte('meeting_date',year+'-12-31'); }
  const { data, error } = await q;

  if (error) {
    if (error.code === '42P01') {
      tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">🔧</div><div class="empty-ttl">SQL not yet run</div><div class="empty-bod">Run pv_meetings SQL in Supabase to activate this module</div></div></td></tr>';
    } else {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty"><div class="empty-ico">❌</div><div class="empty-ttl">${_esc(safeErrorMessage(error, 'Could not load meetings.'))}</div></div></td></tr>`;
    }
    return;
  }

  _allMeetings = data || [];
  renderStats(_allMeetings);
  renderCompliance(_allMeetings);

  if (!_allMeetings.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-ico">🧪</div><div class="empty-ttl">No meetings recorded yet</div><div class="empty-bod">Record the first PV Cell meeting to start compliance tracking</div></div></td></tr>';
    return;
  }

  tbody.innerHTML = _allMeetings.map(m=>`<tr>
    <td style="font-weight:600;white-space:nowrap">${m.meeting_date}</td>
    <td><span class="pill pill-${m.meeting_type}">${_typeLabel(m.meeting_type)}</span></td>
    <td style="font-size:12px">${_esc(m.chairperson||'—')}</td>
    <td style="font-size:12px">${_esc(m.venue||'—')}</td>
    <td style="font-size:12px">
      ${_membersPresent(m.members_present)}
      ${m.extra_members ? `<div style="color:var(--text-muted);font-size:11px">+${_esc(m.extra_members)}</div>` : ''}
    </td>
    <td style="text-align:center">
      <span style="font-size:16px;font-weight:700;color:${m.adr_count>0?'var(--red)':'var(--text-muted)'}">${m.adr_count||0}</span>
      ${m.adr_severity ? `<div style="font-size:10px;color:var(--text-muted)">${_esc(m.adr_severity)}</div>` : ''}
    </td>
    <td style="font-size:12px">
      ${m.report_to
        ? `<span class="report-yes">✓ ${_esc(_reportLabel(m.report_to))}</span><br><span style="font-size:10px;color:var(--text-muted)">${m.report_date||''} ${m.report_ref?'· '+_esc(m.report_ref):''}</span>`
        : '<span class="report-no">✗ Not submitted</span>'}
    </td>
    <td style="font-size:12px;white-space:nowrap">${m.next_meeting_date ? _daysFrom(m.next_meeting_date) : '—'}</td>
    <td><span class="pill pill-${m.status}">${m.status==='completed'?'Completed':'Scheduled'}</span></td>
  </tr>`).join('');
};

function renderStats(data) {
  const yearData = data.filter(m => m.meeting_date?.startsWith(now.getFullYear()+''));
  const totalADR = data.reduce((s,m)=>s+(Number(m.adr_count)||0),0);
  const reported  = data.filter(m=>m.report_to).length;
  document.getElementById('s-total').textContent    = data.length;
  document.getElementById('s-year').textContent     = yearData.length;
  document.getElementById('s-adr').textContent      = totalADR;
  document.getElementById('s-reported').textContent = reported;
}

function renderCompliance(data) {
  const banner = document.getElementById('compliance-banner');
  const completed = data.filter(m => m.status==='completed').sort((a,b)=>b.meeting_date.localeCompare(a.meeting_date));

  if (!completed.length) {
    banner.className = 'compliance-banner red';
    banner.innerHTML = `<div class="cb-icon">🚨</div><div class="cb-body">
      <div class="cb-title">No PV Cell meetings recorded — NCISM §48 violation</div>
      <div class="cb-sub">The Pharmacovigilance Cell must meet at least once every two months. Record the first meeting immediately.</div>
    </div>`;
    return;
  }

  const lastDate = new Date(completed[0].meeting_date);
  const daysSince = Math.floor((now - lastDate) / 86400000);
  const daysToDue  = 60 - daysSince;
  const pct = Math.min(Math.round(daysSince / 60 * 100), 100);

  let cls, icon, title, sub, barColor;
  if (daysSince <= 45) {
    cls='green'; icon='✅'; barColor='var(--green-mid)';
    title = `PV Cell compliance maintained — last meeting ${daysSince} day${daysSince!==1?'s':''} ago`;
    sub = `Next meeting due in ${daysToDue} days (by ${_addDays(lastDate,60)}). ${completed[0].next_meeting_date ? 'Scheduled: '+completed[0].next_meeting_date : ''}`;
  } else if (daysSince <= 60) {
    cls='amber'; icon='⚠️'; barColor='var(--gold)';
    title = `PV Cell meeting approaching overdue — ${daysSince} days since last meeting`;
    sub = `Must meet within ${daysToDue} day${daysToDue!==1?'s':''} to remain compliant (§48(4)). Schedule immediately.`;
  } else {
    cls='red'; icon='🚨'; barColor='var(--red)';
    title = `PV Cell OVERDUE — ${daysSince} days since last meeting (limit: 60 days)`;
    sub = `§48(4) NCISM violation: Cell has not met in over 2 months. Record the missed meeting and schedule the next one urgently.`;
  }

  banner.className = 'compliance-banner ' + cls;
  banner.innerHTML = `<div class="cb-icon">${icon}</div><div class="cb-body">
    <div class="cb-title">${title}</div>
    <div class="cb-sub">${sub}</div>
    <div class="cb-bar-wrap"><div class="cb-bar" style="width:${pct}%;background:${barColor}"></div></div>
    <div style="font-size:10px;margin-top:4px;opacity:.7">Last meeting: ${completed[0].meeting_date} · ${pct}% of 60-day period elapsed</div>
  </div>`;
}

// ─── Modal ────────────────────────────────────────────────
window.openModal = function() {
  document.getElementById('modal-overlay').classList.add('show');
  document.getElementById('m-date').value = todayStr;
};
window.closeModal = function() {
  document.getElementById('modal-overlay').classList.remove('show');
  document.getElementById('modal-alert').classList.remove('show');
};

// Decision rows
window.addDec = function() {
  const wrap = document.getElementById('decisions-wrap');
  const row = document.createElement('div');
  row.className = 'dec-row';
  row.innerHTML = `<input placeholder="Decision / action item…"/><button class="dec-rm" data-onclick="removeDec" data-onclick-a0="@this">×</button>`;
  wrap.appendChild(row);
};
window.removeDec = function(btn) {
  const rows = document.getElementById('decisions-wrap').querySelectorAll('.dec-row');
  if (rows.length > 1) btn.closest('.dec-row').remove();
};

// ─── Save meeting ─────────────────────────────────────────
window.saveMeeting = async function() {
  const date = document.getElementById('m-date').value;
  if (!date) { showModalAlert('Meeting date is required','error'); return; }

  const btn = document.getElementById('save-btn');
  btn.disabled = true;

  // Collect checked members
  const presentMembers = CELL_MEMBERS.filter(m => document.getElementById('mc-'+m.key)?.checked).map(m=>m.key);

  // §21ad — Validate all 8 required departments are represented
  const missingDepts = CELL_MEMBERS.filter(m => m.required && !presentMembers.includes(m.key));
  const deptWarnEl = document.getElementById('dept-missing-warn');
  if (missingDepts.length > 0) {
    const names = missingDepts.map(m => m.label).join(', ');
    if (deptWarnEl) {
      deptWarnEl.textContent = `⚠ Missing required departments: ${names}. NCISM §48 requires all 8 clinical departments to be represented.`;
      deptWarnEl.style.display = '';
    }
    btn.disabled = false;
    return;
  }
  if (deptWarnEl) deptWarnEl.style.display = 'none';

  // Collect decisions
  const decisions = [...document.getElementById('decisions-wrap').querySelectorAll('.dec-row input')]
    .map(i=>i.value.trim()).filter(Boolean);

  const payload = {
    tenant_id:     tenantId,
    created_by:    profile.id,
    meeting_date:  date,
    meeting_type:  document.getElementById('m-type').value,
    status:        document.getElementById('m-status').value,
    chairperson:   document.getElementById('m-chair').value.trim() || null,
    venue:         document.getElementById('m-venue').value.trim() || null,
    members_present: presentMembers,
    extra_members: document.getElementById('m-extra-members').value.trim() || null,
    agenda:        document.getElementById('m-agenda').value.trim() || null,
    adr_count:     parseInt(document.getElementById('m-adr-count').value) || 0,
    adr_severity:  document.getElementById('m-adr-severity').value.trim() || null,
    adr_causality: document.getElementById('m-adr-causality').value || null,
    adr_summary:   document.getElementById('m-adr-summary').value.trim() || null,
    decisions,
    report_to:     document.getElementById('m-report-to').value || null,
    report_date:   document.getElementById('m-report-date').value || null,
    report_ref:    document.getElementById('m-report-ref').value.trim() || null,
    minutes_by:    document.getElementById('m-minutes-by').value.trim() || null,
    next_meeting_date: document.getElementById('m-next').value || null,
    minutes:       document.getElementById('m-minutes').value.trim() || null,
    remarks:       document.getElementById('m-remarks').value.trim() || null,
  };

  const { error } = await supabase.from('pv_meetings').insert(payload);
  btn.disabled = false;

  if (error) {
    if (error.code === '42P01') {
      showModalAlert('Run pv_meetings SQL in Supabase SQL Editor first', 'error');
    } else {
      showModalAlert(safeErrorMessage(error, 'Could not save meeting.'), 'error');
    }
    return;
  }

  closeModal();
  _toast('Meeting recorded ✓');
  loadMeetings();
  resetModal();
};

function resetModal() {
  document.getElementById('m-date').value = todayStr;
  document.getElementById('m-type').value = 'bimonthly';
  document.getElementById('m-status').value = 'completed';
  ['m-chair','m-venue','m-extra-members','m-agenda','m-adr-count','m-adr-severity',
   'm-adr-summary','m-report-date','m-report-ref','m-minutes-by','m-minutes','m-remarks'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('m-report-to').value = '';
  document.getElementById('m-adr-causality').value = '';
  CELL_MEMBERS.forEach(m => {
    const cb = document.getElementById('mc-'+m.key);
    const lbl= document.getElementById('mi-'+m.key);
    if(cb) cb.checked=false;
    if(lbl) lbl.classList.remove('checked');
  });
  document.getElementById('decisions-wrap').innerHTML =
    '<div class="dec-row"><input placeholder="e.g. Withdraw Arsenic-containing preparation Lot X from dispensary immediately"/><button class="dec-rm" data-onclick="removeDec" data-onclick-a0="@this">×</button></div>';
  const nextBi = new Date(now); nextBi.setMonth(nextBi.getMonth()+2);
  document.getElementById('m-next').value = nextBi.toISOString().split('T')[0];
}

// ─── Export ───────────────────────────────────────────────
window.exportRegister = function() {
  if (!_allMeetings.length) { _toast('No data to export'); return; }
  const rows = [
    ['Date','Type','Status','Chairperson','Venue','Members Present','ADR Count','ADR Severity','Causality','Report To','Report Date','Report Ref','Next Meeting','Decisions','Minutes By','Remarks'],
    ..._allMeetings.map(m=>[
      m.meeting_date, m.meeting_type||'', m.status||'',
      m.chairperson||'', m.venue||'',
      (m.members_present||[]).join('; '),
      m.adr_count||0, m.adr_severity||'', m.adr_causality||'',
      m.report_to||'', m.report_date||'', m.report_ref||'',
      m.next_meeting_date||'',
      (m.decisions||[]).join(' | '),
      m.minutes_by||'', m.remarks||''
    ])
  ];
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='PV_Cell_Meeting_Register.csv'; a.click();
};

// ─── Helpers ─────────────────────────────────────────────
function _membersPresent(arr) {
  if (!arr?.length) return '<span style="color:var(--text-muted);font-size:11px">None recorded</span>';
  const labels = Object.fromEntries(CELL_MEMBERS.map(m=>[m.key,m.label.split(' ')[0]]));
  const present = arr.map(k=>labels[k]||k);
  const cls = arr.length >= CELL_MEMBERS.length ? 'color:var(--green-mid)' : arr.length >= 8 ? 'color:var(--gold)' : 'color:var(--red)';
  return `<span style="${cls};font-weight:600">${arr.length}/${CELL_MEMBERS.length}</span> <span style="font-size:11px;color:var(--text-muted)">${present.slice(0,4).join(', ')}${present.length>4?'…':''}</span>`;
}
function _typeLabel(t) { return {bimonthly:'Bimonthly',special:'Special',annual:'Annual'}[t]||t||'—'; }
function _reportLabel(r) { return {regional:'RPVMC',national:'NPvP/CDSCO',central:'MoA AYUSH',all:'All three'}[r]||r; }
function _daysFrom(d) {
  const diff = Math.floor((new Date(d)-now)/86400000);
  if (diff < 0) return `<span style="color:var(--red);font-size:11px">${Math.abs(diff)}d overdue</span>`;
  if (diff <= 14) return `<span style="color:var(--gold);font-size:11px">In ${diff}d</span>`;
  return `<span style="font-size:11px">${d}</span>`;
}
function _addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate()+n);
  return d.toISOString().split('T')[0];
}
function showModalAlert(msg, type) {
  const el=document.getElementById('modal-alert');
  el.textContent=msg; el.className=`alert ${type} show`;
}
function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg,isErr=false){ const el=document.getElementById('toast'); el.textContent=msg; el.style.background=isErr?'#7f1d1d':'#1c2b1f'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

// Boot
await loadMeetings();
