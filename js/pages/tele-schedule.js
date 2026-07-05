import { requireAuth, getCurrentProfile, getCurrentTenant } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['doctor','super_admin','dept_admin'], 'login.html');
initNavbar();
wireDelegatedEvents();

const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = tenant?.id;
const tenantCode= tenant?.tenant_code || '';
const userId    = profile?.id;

document.getElementById('doc-name-chip').textContent = profile?.full_name || 'Doctor';

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const TODAY = new Date().getDay();

let _existing = {}; // day_of_week → row

// ── Build schedule grid ───────────────────────────────────────────────────────
async function loadSchedule() {
  const { data } = await supabase
    .from('tele_schedules')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('doctor_id', userId);

  _existing = {};
  (data || []).forEach(r => { _existing[r.day_of_week] = r; });

  const tbody = document.getElementById('sched-body');
  tbody.innerHTML = DAYS.map((day, dow) => {
    const r = _existing[dow] || {};
    const isToday = dow === TODAY;
    return `<tr id="row-${dow}" class="${r.is_active===false ? 'inactive' : ''}">
      <td><span class="day-label${isToday?' today':''}">${day}${isToday?' ★':''}</span></td>
      <td><input type="checkbox" class="day-toggle" id="active-${dow}" ${r.is_active!==false?'checked':''} data-onchange="toggleRow" data-onchange-a0="${dow}"/></td>
      <td><input class="fi" type="time" id="start-${dow}" value="${r.start_time||'09:00'}"/></td>
      <td><input class="fi" type="time" id="end-${dow}"   value="${r.end_time||'13:00'}"/></td>
      <td><input class="fi" type="number" id="max-${dow}" value="${r.max_patients||10}" min="1" max="50"/></td>
      <td>
        <input class="fi fi-url" type="url" id="url-${dow}" value="${_esc(r.platform_url||'')}" placeholder="https://meet.jit.si/your-room"/>
        ${!r.platform_url ? '<span class="jitsi-badge">Auto Jitsi</span>' : ''}
      </td>
    </tr>`;
  }).join('');
}

window.toggleRow = function(dow) {
  const active = document.getElementById(`active-${dow}`).checked;
  document.getElementById(`row-${dow}`).className = active ? '' : 'inactive';
};

// ── Save schedule ─────────────────────────────────────────────────────────────
window.saveSchedule = async function() {
  const rows = DAYS.map((_, dow) => {
    const active = document.getElementById(`active-${dow}`).checked;
    const start  = document.getElementById(`start-${dow}`).value;
    const end    = document.getElementById(`end-${dow}`).value;
    const max    = parseInt(document.getElementById(`max-${dow}`).value) || 10;
    const url    = document.getElementById(`url-${dow}`).value.trim() || null;
    return { tenant_id: tenantId, doctor_id: userId, day_of_week: dow,
             start_time: start, end_time: end, max_patients: max,
             platform_url: url, is_active: active };
  });

  const { error } = await supabase.from('tele_schedules').upsert(rows, { onConflict: 'tenant_id,doctor_id,day_of_week' });
  if (error) { _toast('❌ ' + error.message); return; }
  _toast('✅ Schedule saved');
  await loadSchedule();
};

// ── Today's tele queue ────────────────────────────────────────────────────────
async function loadTeleToday() {
  const start = new Date(); start.setHours(0,0,0,0);
  document.getElementById('tele-today-date').textContent =
    new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long'});

  const { data } = await supabase
    .from('visits')
    .select('id, token_number, status, chief_complaint, meeting_url, patients(name, phone)')
    .eq('tenant_id', tenantId)
    .eq('doctor_id', userId)
    .eq('is_teleconsultation', true)
    .in('status', ['waiting','in_progress','completed'])
    .gte('created_at', start.toISOString())
    .order('token_number');

  const list = document.getElementById('tele-today-list');
  if (!data?.length) {
    list.innerHTML = '<div class="empty"><div class="empty-ico">📡</div><div>No teleconsultation appointments today</div></div>';
    return;
  }

  list.innerHTML = data.map(v => {
    const meetUrl = v.meeting_url || _genRoom(v.id);
    return `<div class="tele-card">
      <div>
        <div class="tele-pt-name">${_esc(v.patients?.name||'—')} <span class="badge-tele">TELE</span></div>
        <div class="tele-pt-meta">Token #${v.token_number} · ${_esc(v.patients?.phone||'—')} · Status: ${_esc(v.status)}</div>
        <div class="tele-complaint">${_esc(v.chief_complaint||'—')}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn-copy" data-onclick="copyLink" data-onclick-a0="${_esc(meetUrl)}">📋 Copy Link</button>
        <a class="btn-join" href="${_esc(meetUrl)}" target="_blank" rel="noopener">🎥 Join Call</a>
      </div>
    </div>`;
  }).join('');
}

function _genRoom(visitId) {
  return `https://meet.jit.si/AyurXpert-${tenantCode}-${visitId.slice(0,8)}`;
}

window.copyLink = function(url) {
  navigator.clipboard.writeText(url).then(() => _toast('📋 Link copied!'));
};

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2800); }

// §21j — Teleconsultation Register
document.getElementById('tele-reg-month').value = new Date().toISOString().slice(0,7);

let _teleRegData = [];
window.loadTeleRegister = async function() {
  const month = document.getElementById('tele-reg-month').value;
  if (!month) return;
  const from = month + '-01';
  const to   = month + '-31';
  const tbody = document.getElementById('tele-register-body');
  tbody.innerHTML = '<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-muted)">Loading…</td></tr>';
  const { data, error } = await supabase.from('visits')
    .select('id,token_number,created_at,chief_complaint,status,patients(name),opds(name),profiles!doctor_id(full_name)')
    .eq('tenant_id', tenantId)
    .eq('is_teleconsultation', true)
    .gte('created_at', from + 'T00:00:00')
    .lte('created_at', to + 'T23:59:59')
    .order('created_at', { ascending: false });
  if (error) { tbody.innerHTML = `<tr><td colspan="7" style="padding:20px;text-align:center;color:#c0392b">${_esc(error.message)}</td></tr>`; return; }
  _teleRegData = data || [];
  if (!_teleRegData.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-muted)">No teleconsultation visits for this month</td></tr>';
    document.getElementById('tele-register-summary').textContent = '';
    return;
  }
  tbody.innerHTML = _teleRegData.map((v, i) => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;color:var(--text-muted)">${i+1}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${new Date(v.created_at).toLocaleDateString('en-IN')}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2;font-weight:500">${_esc(v.patients?.name||'—')}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${_esc(v.profiles?.full_name||'—')}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${_esc(v.opds?.name||'—')}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2">${_esc(v.chief_complaint||'—')}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f4f2"><span style="font-size:11px;padding:2px 7px;border-radius:4px;background:${v.status==='completed'?'#e8f5ee':'#fff8e1'};color:${v.status==='completed'?'#1a4a2e':'#6b4c00'};font-weight:600">${_esc(v.status)}</span></td>
  </tr>`).join('');
  document.getElementById('tele-register-summary').textContent =
    `Total: ${_teleRegData.length} teleconsultations · These are NOT included in the NCISM mandatory OPD patient count.`;
};

window.exportTeleRegisterCSV = function() {
  if (!_teleRegData.length) { _toast('Load data first'); return; }
  const rows = [['#','Date','Patient','Doctor','OPD','Chief Complaint','Status']];
  _teleRegData.forEach((v, i) => rows.push([
    i+1, new Date(v.created_at).toLocaleDateString('en-IN'),
    v.patients?.name||'', v.profiles?.full_name||'', v.opds?.name||'',
    v.chief_complaint||'', v.status||''
  ]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `tele-register-${document.getElementById('tele-reg-month').value}.csv`;
  a.click();
};

await loadSchedule();
await loadTeleToday();
