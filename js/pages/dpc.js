import { requireAuth, getCurrentProfile, getCurrentTenantId, getCurrentTenant } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['super_admin','dept_admin','accountant']);
initNavbar();
wireDelegatedEvents();

window._print = () => window.print();
window._closeIfSelf = function(isSelf, fnName) {
  if (isSelf) { const fn = window[fnName]; if (typeof fn === 'function') fn(); }
};

const tenant   = getCurrentTenant();
const profile  = getCurrentProfile();
const tenantId = tenant?.id;
const userId   = profile?.id;

let _meetings  = [];
let _editId    = null;

const TYPE_LABEL = { quarterly:'Quarterly', annual:'Annual', special:'Special', scheduled:'Scheduled' };

// ── Load ──────────────────────────────────────────────────────────────────────
async function load() {
  const { data, error } = await supabase.from('dpc_meetings')
    .select('*').eq('tenant_id', tenantId).order('meeting_date', { ascending: false });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not load meetings.')); return; }
  _meetings = data || [];
  render();
  updateStats();
}

function render() {
  const tbody = document.getElementById('dpc-tbody');
  if (!_meetings.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">No meetings recorded yet</div><div class="empty-sub">Record the first DPC meeting</div></div></td></tr>`;
    return;
  }
  tbody.innerHTML = _meetings.map((m, i) => `
    <tr>
      <td>${_meetings.length - i}</td>
      <td>${_fmtDate(m.meeting_date)}</td>
      <td>${_esc(TYPE_LABEL[m.meeting_type] || m.meeting_type)}</td>
      <td style="font-size:12px">${_esc(m.chairperson) || '—'}</td>
      <td style="font-size:12px;max-width:180px">${_esc(_trunc(m.agenda, 60))}</td>
      <td style="font-size:12px;max-width:180px">${Array.isArray(m.decisions) ? _esc(m.decisions.slice(0,2).join('; ')) + (m.decisions.length > 2 ? '…' : '') : '—'}</td>
      <td style="font-size:12px">${m.next_meeting_date ? _fmtDate(m.next_meeting_date) : '—'}</td>
      <td><span class="status-pill pill-${m.status||'completed'}">${{scheduled:'Scheduled',completed:'Done',cancelled:'Cancelled'}[m.status]||'Done'}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" data-onclick="viewMeeting" data-onclick-a0="${m.id}">View</button>
      </td>
    </tr>`).join('');
}

function updateStats() {
  const year = new Date().getFullYear();
  const thisYear = _meetings.filter(m => m.meeting_date?.startsWith(String(year))).length;
  const upcoming = _meetings.filter(m => m.status === 'scheduled').length;
  const actionItems = _meetings.reduce((n, m) => n + (Array.isArray(m.decisions) ? m.decisions.length : 0), 0);
  document.getElementById('stat-total').textContent   = _meetings.length;
  document.getElementById('stat-year').textContent    = thisYear;
  document.getElementById('stat-upcoming').textContent= upcoming;
  document.getElementById('stat-actions').textContent = actionItems;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
window.openModal = function() {
  _editId = null;
  document.getElementById('modal-title').textContent = 'Record DPC Meeting';
  document.getElementById('m-date').value  = new Date().toISOString().slice(0,10);
  document.getElementById('m-type').value  = 'quarterly';
  document.getElementById('m-status').value= 'completed';
  document.getElementById('m-chair').value = '';
  document.getElementById('m-venue').value = '';
  document.getElementById('m-members').value = '';
  document.getElementById('m-agenda').value = '';
  document.getElementById('m-discussion').value = '';
  document.getElementById('decision-rows').innerHTML = '';
  document.getElementById('m-next').value  = '';
  document.getElementById('m-supplier').value = '';
  document.getElementById('m-remarks').value = '';
  addDecisionRow();
  document.getElementById('modal-overlay').style.display = 'flex';
};

window.closeModal = function() {
  document.getElementById('modal-overlay').style.display = 'none';
};

window.addDecisionRow = function(text = '') {
  const div = document.createElement('div');
  div.className = 'decision-row';
  div.innerHTML = `
    <input type="text" placeholder="Decision / action item…" value="${_esc(text)}"/>
    <button class="decision-rm" data-onclick="removeDecisionRow" data-onclick-a0="@this">✕</button>`;
  document.getElementById('decision-rows').appendChild(div);
};

window.removeDecisionRow = function(btn) {
  btn.parentElement.remove();
};

window.saveMeeting = async function() {
  const decisions = [...document.querySelectorAll('#decision-rows .decision-row input')]
    .map(i => i.value.trim()).filter(Boolean);
  const payload = {
    tenant_id:        tenantId,
    created_by:       userId,
    meeting_date:     document.getElementById('m-date').value,
    meeting_type:     document.getElementById('m-type').value,
    status:           document.getElementById('m-status').value,
    chairperson:      document.getElementById('m-chair').value.trim() || null,
    venue:            document.getElementById('m-venue').value.trim() || null,
    members_present:  document.getElementById('m-members').value.trim() || null,
    agenda:           document.getElementById('m-agenda').value.trim() || null,
    discussion_summary:document.getElementById('m-discussion').value.trim() || null,
    decisions,
    next_meeting_date:document.getElementById('m-next').value || null,
    supplier_reviewed:document.getElementById('m-supplier').value.trim() || null,
    remarks:          document.getElementById('m-remarks').value.trim() || null,
  };
  const { error } = _editId
    ? await supabase.from('dpc_meetings').update(payload).eq('id', _editId)
    : await supabase.from('dpc_meetings').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save meeting.')); return; }
  _alert('success', 'Meeting record saved.');
  closeModal();
  await load();
};

window.viewMeeting = function(id) {
  const m = _meetings.find(x => x.id === id);
  if (!m) return;
  const html = `
    <div style="max-width:660px;margin:0 auto;font-family:'DM Sans',sans-serif;padding:32px;font-size:13px">
      <h2 style="font-family:'Cormorant Garamond',serif;color:#1a4a2e;margin-bottom:4px">Drug Procurement Committee — Meeting Minutes</h2>
      <div style="font-size:11px;color:#7a9485;margin-bottom:20px">NCISM §18at — ${_esc(tenant?.name || '')}</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600;width:35%">Date</td><td style="padding:5px 10px;border:1px solid #ccc">${_fmtDate(m.meeting_date)}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600">Type</td><td style="padding:5px 10px;border:1px solid #ccc">${_esc(TYPE_LABEL[m.meeting_type]||m.meeting_type)}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600">Chairperson</td><td style="padding:5px 10px;border:1px solid #ccc">${_esc(m.chairperson)||'—'}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600">Venue</td><td style="padding:5px 10px;border:1px solid #ccc">${_esc(m.venue)||'—'}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600;vertical-align:top">Members Present</td><td style="padding:5px 10px;border:1px solid #ccc;white-space:pre-line">${_esc(m.members_present)||'—'}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600;vertical-align:top">Agenda</td><td style="padding:5px 10px;border:1px solid #ccc;white-space:pre-line">${_esc(m.agenda)||'—'}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600;vertical-align:top">Discussions</td><td style="padding:5px 10px;border:1px solid #ccc">${_esc(m.discussion_summary)||'—'}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600;vertical-align:top">Decisions</td><td style="padding:5px 10px;border:1px solid #ccc">${Array.isArray(m.decisions) ? m.decisions.map((d,i)=>`${i+1}. ${_esc(d)}`).join('<br>') : '—'}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600">Supplier Reviewed</td><td style="padding:5px 10px;border:1px solid #ccc">${_esc(m.supplier_reviewed)||'—'}</td></tr>
        <tr><td style="padding:5px 10px;border:1px solid #ccc;font-weight:600">Next Meeting</td><td style="padding:5px 10px;border:1px solid #ccc">${m.next_meeting_date?_fmtDate(m.next_meeting_date):'—'}</td></tr>
      </table>
      <div style="display:flex;gap:60px;margin-top:40px">
        <div><div style="width:180px;border-top:1px solid #333;padding-top:5px;font-size:11px">Chairperson Signature</div></div>
        <div><div style="width:180px;border-top:1px solid #333;padding-top:5px;font-size:11px">Medical Superintendent / Principal</div></div>
      </div>
    </div>`;
  const w = window.open('', '_blank');
  w.document.write('<html><head><title>DPC Minutes</title></head><body>' + html + '<\/body><\/html>');
  w.document.close();
  w.print();
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _trunc(s, n) { if (!s) return '—'; return s.length > n ? s.slice(0, n) + '…' : s; }
function _alert(type, msg) { const el = document.getElementById('alert-box'); el.className = `alert ${type} show`; el.textContent = msg; setTimeout(() => el.classList.remove('show'), 4000); }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

await load();
