import { requireAuth, getCurrentTenantId, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['super_admin','dept_admin','doctor','nurse','receptionist','diet_staff']);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const myProfile = getCurrentProfile();
let _indents = [];
let _filter  = 'active';

// ── Load ─────────────────────────────────────────
async function loadIndents() {
  const today = new Date().toISOString().slice(0,10);
  const { data } = await supabase
    .from('palha_diet_indents')
    .select(`
      id, preparation_name, preparation_type, quantity, supply_date, supply_time,
      special_instructions, status, created_at,
      patients(name),
      ipd:ipd_admissions(beds(bed_number,ward_name)),
      prescribed:profiles!prescribed_by(full_name)
    `)
    .eq('tenant_id', tenantId)
    .eq('supply_date', today)
    .order('supply_time', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });

  _indents = data || [];
  updateStats();
  renderIndents();
}

function updateStats() {
  document.getElementById('stat-pending').textContent    = _indents.filter(i=>i.status==='pending').length;
  document.getElementById('stat-inprep').textContent     = _indents.filter(i=>i.status==='in_preparation').length;
  document.getElementById('stat-dispatched').textContent = _indents.filter(i=>i.status==='dispatched').length;
  document.getElementById('stat-served').textContent     = _indents.filter(i=>i.status==='served').length;
}

function renderIndents() {
  const filtered = _filter === 'all'    ? _indents
                 : _filter === 'active' ? _indents.filter(i=>['pending','in_preparation','dispatched'].includes(i.status))
                 : _indents.filter(i=>i.status===_filter);

  const list = document.getElementById('indent-list');
  if (!filtered.length) {
    list.innerHTML = `<div class="indent-empty">No indents for this filter.<br><span style="font-size:11px">Indents are created from the IPD ward page.</span></div>`;
    return;
  }

  const TYPE_LABEL = { kashaya:'Kashaya', swarasa:'Swarasa', ksheerapaka:'Ksheerapaka', kalka:'Kalka', pathya_diet:'Pathya Diet', special:'Special' };
  const STATUS_NEXT = { pending:'in_preparation', in_preparation:'dispatched', dispatched:'served' };
  const STATUS_BTN  = { pending:'▶ Start Preparation', in_preparation:'📦 Mark Dispatched', dispatched:'✓ Mark Served' };
  const STATUS_CLASS = { pending:'btn-start', in_preparation:'btn-dispatch', dispatched:'btn-served' };

  list.innerHTML = filtered.map(i => {
    const pt   = i.patients?.name || '—';
    const bed  = i.ipd?.beds?.bed_number ? `Bed ${i.ipd.beds.bed_number}` : '';
    const ward = i.ipd?.beds?.ward_name  || '';
    const timeStr = i.supply_time ? i.supply_time.slice(0,5) : '—';
    const doctor  = i.prescribed?.full_name || '—';
    const typeLabel = TYPE_LABEL[i.preparation_type] || i.preparation_type;
    const nextStatus = STATUS_NEXT[i.status];
    const canCancel  = ['pending','in_preparation'].includes(i.status);

    return `<div class="indent-card ${i.status}">
      <div class="indent-card-top">
        <div>
          <span class="type-badge type-${i.preparation_type}">${typeLabel}</span>
          <div class="indent-prep-name">${_esc(i.preparation_name)}</div>
        </div>
        <div class="indent-time">${timeStr}</div>
      </div>
      <div class="indent-patient">
        👤 <strong>${_esc(pt)}</strong>${bed ? ` · ${_esc(bed)}` : ''}${ward ? ` · ${_esc(ward)}` : ''}
        ${i.quantity ? ` · <strong>${_esc(i.quantity)}</strong>` : ''}
      </div>
      ${i.special_instructions ? `<div class="indent-instructions">📌 ${_esc(i.special_instructions)}</div>` : ''}
      <div class="indent-meta">Prescribed by: ${_esc(doctor)} · Created: ${new Date(i.created_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</div>
      ${nextStatus ? `<div class="indent-actions">
        <button class="btn-action ${STATUS_CLASS[i.status]}" data-onclick="updateStatus" data-onclick-a0="${i.id}" data-onclick-a1="${nextStatus}">${STATUS_BTN[i.status]}</button>
        ${canCancel ? `<button class="btn-action btn-cancel" data-onclick="updateStatus" data-onclick-a0="${i.id}" data-onclick-a1="cancelled">Cancel</button>` : ''}
      </div>` : (i.status==='served' ? `<div style="font-size:11px;color:var(--success-text);margin-top:8px;font-weight:600">✓ Served</div>` : (i.status==='cancelled' ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px">Cancelled</div>` : ''))}
    </div>`;
  }).join('');
}

window.updateStatus = async function(id, newStatus) {
  const patch = { status: newStatus };
  if (newStatus === 'served') {
    patch.fulfilled_by = myProfile?.id;
    patch.fulfilled_at = new Date().toISOString();
  }
  const { error } = await supabase.from('palha_diet_indents').update(patch).eq('id', id);
  if (error) { _toast('Error: ' + error.message, true); return; }
  const label = { in_preparation:'In preparation', dispatched:'Dispatched', served:'Served ✓', cancelled:'Cancelled' }[newStatus] || newStatus;
  _toast(`Status updated: ${label}`);
  await loadIndents();
};

window.setFilter = function(f, el) {
  _filter = f;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderIndents();
};

window.toggleSop = function(btn) {
  const body = btn.nextElementSibling;
  const isOpen = body.classList.toggle('open');
  btn.querySelector('span:last-child').textContent = isOpen ? '▲' : '▼';
};

function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = isErr ? '#8b1a1a' : '#1a4a2e';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Realtime ─────────────────────────────────────
supabase.channel('palha-diet-live')
  .on('postgres_changes', {
    event: '*', schema: 'public', table: 'palha_diet_indents',
    filter: `tenant_id=eq.${tenantId}`
  }, loadIndents)
  .subscribe();

// ── Boot ─────────────────────────────────────────
await loadIndents();
