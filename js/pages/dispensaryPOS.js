import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { logAudit } from '../core/auditLogger.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

await requireAuth(['pharmacist', 'super_admin', 'dept_admin']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const userId   = profile.id;
const _ctx     = { tenantId, userId, userName: profile.full_name };
const _tenant  = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');

// ── State ─────────────────────────────────────────
let _inventory      = [];
let _activeRxId     = null;
let _activeRx       = null;
let _cartItems      = [];    // {medicine_id, name, price, qty, fromRx}
let _filter         = 'pending';
let _rxPayerMap     = {};    // rxId → payer_type (populated during loadQueue)

// ── Date ──────────────────────────────────────────
document.getElementById('q-date').textContent = new Date().toLocaleDateString('en-IN', {
  weekday:'long', day:'numeric', month:'long'
});

// ── Helpers ───────────────────────────────────────
function _uhid(uuid) {
  return `AYX-${new Date().getFullYear()}-${(uuid||'').replace(/-/g,'').slice(-6).toUpperCase()}`;
}
function _timeAgo(ts) {
  const m = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m/60)}h ${m%60}m ago`;
}

// ── Load inventory ────────────────────────────────
let _formularyNames = new Set();

async function loadInventory() {
  try {
    const [invRes, fRes] = await Promise.all([
      supabase.from('inventory')
        .select('id, medicine_id, stock_quantity, mrp, cost_price, gst_percent, is_student_batch, is_high_risk, is_lasa, lasa_pair, is_schedule_h, medicine:medicines(id,name)')
        .eq('tenant_id', tenantId),
      supabase.from('hospital_formulary')
        .select('medicine_name')
        .eq('tenant_id', tenantId)
        .eq('is_active', true),
    ]);
    _inventory = (invRes.data || []).filter(i => i.medicine?.name && !i.is_student_batch);
    _formularyNames = new Set((fRes.data || []).map(f => f.medicine_name.toLowerCase()));
  } catch { _inventory = []; }
}

// ── Match medicine name to inventory ─────────────
function _matchInventory(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  return _inventory.find(i => i.medicine.name.toLowerCase() === n)
      || _inventory.find(i => i.medicine.name.toLowerCase().includes(n))
      || null;
}

// ── Load prescription queue ───────────────────────
async function loadQueue() {
  const start = new Date(); start.setHours(0,0,0,0);

  const { data, error: qErr } = await supabase
    .from('prescriptions')
    .select(`
      id, created_at, status,
      visit:visits(id, token_number, chief_complaint, doctor_id, bills(payer_type)),
      patient:patients(id, name, phone, abha_number),
      items:prescription_items(id, medicine_name, medicine_id, dosage, frequency, duration)
    `)
    .eq('tenant_id', tenantId)
    .gte('created_at', start.toISOString())
    .order('created_at', { ascending: true });

  if (qErr) console.error('pharmacy loadQueue error:', qErr.message, qErr.details, qErr.hint);
  const rows = data || [];
  const pending = rows.filter(r => r.status !== 'dispensed');
  document.getElementById('q-count').textContent = pending.length;

  const list = document.getElementById('q-list');
  const filtered = _filter === 'pending' ? pending : rows;

  if (!filtered.length) {
    list.innerHTML = `<div class="q-empty"><div class="q-empty-icon"><img src="assets/AyurXpert_Tree_Only.png" alt=""></div>${_filter==='pending' ? 'No pending prescriptions' : 'No prescriptions today'}</div>`;
    return;
  }

  list.innerHTML = filtered.map(rx => {
    const isDone      = rx.status === 'dispensed';
    const isActive    = rx.id === _activeRxId;
    const medCount    = (rx.items || []).length;
    const cardClass   = isDone ? 'rx-card done' : isActive ? 'rx-card active' : 'rx-card';
    const tokClass    = isDone ? 'rx-token done' : 'rx-token';
    const isPkTherapy = !rx.visit;
    const payerType   = rx.visit?.bills?.[0]?.payer_type || 'self_pay';
    const isIns       = payerType !== 'self_pay';
    _rxPayerMap[rx.id] = payerType;
    return `<div class="${cardClass}"${isDone ? '' : ` data-onclick="openRx" data-onclick-a0="${rx.id}"`}>
      <div class="rx-card-top">
        <div class="${tokClass}">${rx.visit?.token_number || '💊'}</div>
        <div class="rx-name">${_esc(rx.patient?.name || '—')}${isIns ? ' <span style="background:#f5f3ff;color:#6d28d9;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600">🏥 Ins</span>' : ''}</div>
        <div class="rx-time">${_timeAgo(rx.created_at)}</div>
      </div>
      <div class="rx-meta">
        ${isDone ? '<span class="badge badge-done">Dispensed</span>' : '<span class="badge badge-pending">Pending</span>'}
        ${isPkTherapy ? '<span class="badge" style="background:#e8f5ee;color:#1a4a2e;border:1px solid #b8ddc6">PK Therapy</span>' : ''}
        ${medCount ? `<span class="badge badge-meds">${medCount} item${medCount>1?'s':''}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Filter ────────────────────────────────────────
window.setFilter = function(f, btn) {
  _filter = f;
  document.querySelectorAll('.q-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (f === 'register') { loadDispensingRegister(); return; }
  document.getElementById('q-list').innerHTML = '<div class="q-empty">Loading…</div>';
  document.getElementById('register-panel').style.display = 'none';
  loadQueue();
};

// ── §21u Dispensing Register (NCISM — separate OPD/IPD registers mandatory) ──
window.loadDispensingRegister = async function() {
  const qList = document.getElementById('q-list');
  const panel = document.getElementById('register-panel');
  qList.innerHTML = '';
  panel.style.display = '';
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('reg-date').value = today;
  await loadRegisterTable();
};

window.loadRegisterTable = async function() {
  const date = document.getElementById('reg-date').value;
  const type = document.getElementById('reg-type').value;
  const tbody = document.getElementById('reg-tbody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">Loading…</td></tr>';
  let q = supabase.from('prescriptions')
    .select('id,created_at,patient_type,patients(name),profiles!doctor_id(full_name),visits(chief_complaint)')
    .eq('tenant_id', tenantId)
    .gte('created_at', date + 'T00:00:00')
    .lte('created_at', date + 'T23:59:59')
    .order('created_at', { ascending: false });
  if (type) q = q.eq('patient_type', type);
  const { data, error } = await q;
  if (error) { tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:16px;color:#c0392b">${_esc(error.message)}</td></tr>`; return; }
  if (!data?.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-muted)">No dispensing records for this date/filter</td></tr>'; return; }
  let serial = 1;
  tbody.innerHTML = data.map(p => `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #f0f4f2;color:var(--text-muted)">${serial++}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #f0f4f2">${new Date(p.created_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #f0f4f2;font-weight:500">${_esc(p.patients?.name||'—')}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #f0f4f2">${_esc(p.profiles?.full_name||'—')}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #f0f4f2">${_esc(p.visits?.chief_complaint||'—')}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #f0f4f2"><span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${(p.patient_type||'opd')==='ipd'?'#dbeafe':'#e8f5ee'};color:${(p.patient_type||'opd')==='ipd'?'#1a4080':'#1a4a2e'}">${(p.patient_type||'OPD').toUpperCase()}</span></td>
  </tr>`).join('');
};

window.exportRegisterCSV = function() { alert('Use browser Print (Ctrl+P) to save as PDF for the NCISM register'); };

// ── Open a prescription ───────────────────────────
window.openRx = async function(rxId) {
  _activeRxId = rxId;
  _cartItems  = [];
  const _payerType = _rxPayerMap[rxId] || 'self_pay';
  const _isIns     = _payerType !== 'self_pay';

  const { data: rx } = await supabase
    .from('prescriptions')
    .select(`
      id, created_at, status,
      visit:visits(id, token_number, chief_complaint, doctor_id,
        notes:consultation_notes(modern_diagnosis, ayurveda_diagnosis)),
      patient:patients(id, name, phone, abha_number),
      items:prescription_items(id, medicine_name, medicine_id, dosage, frequency, duration, anupana, quantity)
    `)
    .eq('id', rxId)
    .single();

  _activeRx = rx;

  // Load doctor name
  let doctorName = '—';
  if (rx.visit?.doctor_id) {
    const { data: doc } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', rx.visit.doctor_id)
      .single();
    doctorName = doc?.full_name || '—';
  }

  // Get diagnosis from consultation_notes
  const notes = rx.visit?.notes?.[0] || rx.visit?.notes || null;
  const diag  = [notes?.modern_diagnosis, notes?.ayurveda_diagnosis].filter(Boolean).join(' / ');

  // Populate header
  document.getElementById('pt-token').textContent  = rx.visit?.token_number || '—';
  document.getElementById('pt-name').textContent   = rx.patient?.name || '—';
  document.getElementById('pt-sub').textContent    = `UHID: ${_uhid(rx.patient?.id)} · Rx #${rx.id.slice(-6).toUpperCase()}`;
  document.getElementById('pt-phone').textContent  = rx.patient?.phone || '—';
  document.getElementById('pt-doctor').textContent = doctorName;

  const diagWrap = document.getElementById('pt-diag-wrap');
  if (diag) {
    document.getElementById('pt-diag').textContent = diag;
    diagWrap.style.display = '';
  } else {
    diagWrap.style.display = 'none';
  }

  // NABH — Check patient allergies and show banner
  const allergyBanner = document.getElementById('allergy-banner');
  allergyBanner.style.display = 'none';
  if (rx.patient?.id) {
    const { data: allergies } = await supabase.from('patient_allergies')
      .select('allergen,severity').eq('patient_id', rx.patient.id)
      .eq('tenant_id', tenantId).eq('status','active');
    if (allergies?.length) {
      allergyBanner.style.display = 'flex';
      document.getElementById('allergy-banner-text').textContent =
        allergies.map(a => `${a.allergen}${a.severity ? ' ('+a.severity+')' : ''}`).join(' · ');
    }
  }

  // Build cart from prescription items
  (rx.items || []).forEach(item => {
    const inv = _matchInventory(item.medicine_name);
    _cartItems.push({
      id:         item.id,
      medicine_id: inv?.medicine_id || item.medicine_id || null,
      name:       item.medicine_name || '—',
      price:      inv?.mrp || 0,
      stock:      inv?.stock_quantity ?? null,
      gst_pct:    inv?.gst_percent || 0,
      cost_price: inv?.cost_price || 0,
      qty:        item.quantity || 1,
      dosage:     item.dosage || '',
      frequency:  item.frequency || '',
      duration:   item.duration || '',
      anupana:    item.anupana || '',
      is_high_risk: inv?.is_high_risk || false,
      fromRx:     true
    });
  });

  // Reset payment — insurance patients go on Credit/Due (cashless; accountant settles)
  const payMethods = document.getElementById('pay-methods');
  if (_isIns) {
    document.querySelector('.pay-btn[data-method="Credit"]').click();
    payMethods.style.opacity       = '0.45';
    payMethods.style.pointerEvents = 'none';
    payMethods.title = 'Insurance patient — payment handled by accounts department';
  } else {
    document.querySelector('.pay-btn[data-method="Cash"]').click();
    payMethods.style.opacity       = '';
    payMethods.style.pointerEvents = '';
    payMethods.title = '';
  }
  document.getElementById('discount').value = '0';

  document.getElementById('welcome').style.display  = 'none';
  document.getElementById('d-active').style.display = 'flex';

  renderRxList();
  loadQueue();
};

// ── Render prescribed medicines list ─────────────
function renderRxList() {
  const container = document.getElementById('rx-list');
  if (!_cartItems.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No medicines in this prescription</div>';
    recalcTotal();
    return;
  }

  container.innerHTML = _cartItems.map((item, i) => {
    const noStock    = item.stock !== null && item.stock <= 0;
    const lowStock   = item.stock !== null && item.stock > 0 && item.stock < 10;
    const stockClass = noStock ? 'stock-out' : lowStock ? 'stock-low' : 'stock-in';
    const stockLabel = item.stock === null ? '—'
      : item.stock <= 0  ? 'Out of stock'
      : item.stock < 10  ? `Low (${item.stock})`
      : `In stock (${item.stock})`;
    const lineTotal = (item.qty * item.price).toFixed(2);
    const detail = [item.dosage, item.frequency, item.duration, item.anupana ? `with ${item.anupana}` : ''].filter(Boolean).join(' · ');
    return `
      <div class="rx-item${noStock ? ' out-of-stock' : ''}" id="rxitem-${i}">
        <div>
          <div class="rx-item-name">${_esc(item.name)}</div>
          ${detail ? `<div class="rx-item-detail">${_esc(detail)}</div>` : ''}
          ${item.price ? `<div class="rx-item-detail" style="margin-top:2px">₹${item.price} / unit</div>` : '<div class="rx-item-detail" style="color:var(--gold)">Not in inventory — enter price manually</div>'}
        </div>
        <div class="rx-item-stock"><span class="stock-badge ${stockClass}">${stockLabel}</span></div>
        <div class="rx-item-qty">
          <input type="number" min="0" value="${item.qty}" data-onchange="updateQty" data-onchange-a0="${i}" data-onchange-a1="@value" placeholder="Qty"/>
        </div>
        <div class="rx-item-price">₹${lineTotal}</div>
        <div style="display:flex;flex-direction:column;gap:3px;padding-left:4px">
          <button data-onclick="printMedLabel" data-onclick-a0="${i}" title="Print Label (NABH MOM.6)" style="font-size:9px;padding:2px 6px;background:#e8f5ee;color:#1a4a2e;border:1px solid #b8ddc6;border-radius:4px;cursor:pointer;font-family:inherit">🏷 Label</button>
        </div>
      </div>`;
  }).join('');

  recalcTotal();
}

window.updateQty = function(i, val) {
  _cartItems[Number(i)].qty = Math.max(0, parseInt(val) || 0);
  renderRxList();
};

// ── Totals ────────────────────────────────────────
window.recalcTotal = function() {
  const subtotal = _cartItems.reduce((s, c) => s + c.qty * c.price, 0);
  const discount = parseFloat(document.getElementById('discount').value) || 0;
  const total    = Math.max(0, subtotal - discount);
  document.getElementById('subtotal').textContent    = `₹${subtotal.toFixed(2)}`;
  document.getElementById('total-payable').textContent = `₹${total.toFixed(2)}`;
};

// ── Payment method ────────────────────────────────
window.selectPay = function(btn) {
  document.querySelectorAll('.pay-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
};

// ── Manual medicine search ────────────────────────
const medSearch = document.getElementById('med-search');
const medTa     = document.getElementById('med-ta');

medSearch.addEventListener('input', function() {
  const q = this.value.toLowerCase().trim();
  if (q.length < 2) { medTa.classList.remove('show'); return; }
  const results = _inventory.filter(i => i.medicine.name.toLowerCase().includes(q) && !i.is_student_batch).slice(0, 8);
  if (!results.length) { medTa.classList.remove('show'); return; }
  medTa.innerHTML = results.map(i => {
    const cls = i.stock_quantity <= 0 ? 'stock-out' : i.stock_quantity < 10 ? 'stock-low' : 'stock-in';
    const lbl = i.stock_quantity <= 0 ? 'Out' : `${i.stock_quantity} in stock`;
    const inFormulary = _formularyNames.has(i.medicine.name.toLowerCase());
    return `<div class="ta-item" data-mid="${i.medicine_id}" data-name="${_esc(i.medicine.name)}" data-price="${i.mrp||0}" data-stock="${i.stock_quantity}" data-gst="${i.gst_percent||0}" data-cost="${i.cost_price||0}" data-highrisk="${i.is_high_risk?'1':''}">
      <span class="ta-name">${_esc(i.medicine.name)}${inFormulary ? ' <span style="font-size:10px;font-weight:700;background:#e8f5ee;color:#1a4a2e;border-radius:4px;padding:1px 5px;vertical-align:middle">📋 Formulary</span>' : ''}</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:var(--text-muted)">₹${i.mrp||0}</span>
        <span class="stock-badge ${cls}">${lbl}</span>
      </div>
    </div>`;
  }).join('');
  medTa.classList.add('show');
});

medTa.addEventListener('click', e => {
  const item = e.target.closest('.ta-item');
  if (!item) return;
  _cartItems.push({
    medicine_id: item.dataset.mid,
    name:        item.dataset.name,
    price:       parseFloat(item.dataset.price) || 0,
    stock:       parseInt(item.dataset.stock) ?? null,
    gst_pct:     parseFloat(item.dataset.gst) || 0,
    cost_price:  parseFloat(item.dataset.cost) || 0,
    qty:         1,
    dosage:'', frequency:'', duration:'', anupana:'',
    is_high_risk: item.dataset.highrisk === '1',
    fromRx: false
  });
  medSearch.value = '';
  medTa.classList.remove('show');
  renderRxList();
});
medSearch.addEventListener('blur', () => setTimeout(() => medTa.classList.remove('show'), 200));

// ── Dispense ──────────────────────────────────────
document.getElementById('btn-dispense').addEventListener('click', dispense);

async function dispense() {
  if (!_activeRxId || !_activeRx) return;

  const payable = _cartItems.filter(c => c.qty > 0);
  if (!payable.length) { _toast('Add at least one medicine to dispense', 'error'); return; }

  // NABH MOM.3 CORE — High-risk double verification
  const highRiskItems = payable.filter(c => {
    const inv = _inventory.find(i => i.id === c.id || i.medicine_id === c.medicine_id);
    return inv?.is_high_risk || inv?.is_schedule_h;
  });
  if (highRiskItems.length) {
    const names = highRiskItems.map(c => c.name).join(', ');
    const ok = confirm(`⚠ HIGH-RISK MEDICATION — NABH Double Verification Required\n\nThe following require a second check before dispensing:\n${names}\n\nConfirm:\n✅ Prescription verified against original order\n✅ Patient identity confirmed (2 identifiers)\n✅ Dose and route are correct\n\nProceed with dispensing?`);
    if (!ok) return;
  }

  const payMethod = document.querySelector('.pay-btn.active')?.dataset.method || 'Cash';
  const discount  = parseFloat(document.getElementById('discount').value) || 0;
  const subtotal  = payable.reduce((s, c) => s + c.qty * c.price, 0);
  const total     = Math.max(0, subtotal - discount);

  const btn = document.getElementById('btn-dispense');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    // 1. Create bill
    const { data: bill, error: bErr } = await supabase
      .from('bills')
      .insert({
        tenant_id:      tenantId,
        patient_id:     _activeRx.patient.id,
        visit_id:       _activeRx.visit.id,
        total_amount:   subtotal,
        final_amount:   total,
        status:         payMethod === 'Credit' ? 'partial' : 'paid',
        bill_type:      'pharmacy',
        payment_method: payMethod,
        updated_by:     userId,
        update_reason:  'pharmacy_dispense'
      })
      .select('id').single();
    if (bErr) throw bErr;

    // 2. Bill items
    const billItems = payable.map(c => ({
      bill_id:     bill.id,
      medicine_id: c.medicine_id || null,
      quantity:    c.qty,
      price:       c.price,
      total:       c.qty * c.price,
      tenant_id:   tenantId
    }));
    await supabase.from('bill_items').insert(billItems);

    // 3. Deduct stock
    for (const c of payable) {
      if (!c.medicine_id) continue;
      const { data: invList } = await supabase
        .from('inventory')
        .select('id, stock_quantity')
        .eq('medicine_id', c.medicine_id)
        .eq('tenant_id', tenantId);

      let remaining = c.qty;
      for (const inv of (invList || [])) {
        if (remaining <= 0) break;
        const deduct   = Math.min(inv.stock_quantity, remaining);
        await supabase.from('inventory')
          .update({ stock_quantity: inv.stock_quantity - deduct })
          .eq('id', inv.id);
        remaining -= deduct;
      }
    }

    // 4. Mark prescription dispensed
    await supabase.from('prescriptions')
      .update({ status: 'dispensed' })
      .eq('id', _activeRxId);

    // 5. Audit
    await logAudit('dispense_prescription', 'prescriptions', _activeRxId, {
      patient_name:   _activeRx.patient?.name,
      medicines_count: payable.length,
      total_amount:   total,
      payment_method: payMethod
    }, _ctx);

    // 6. ABDM M2 — create care context for Prescription FHIR type (fire-and-forget)
    if (_activeRx.patient?.abha_number) {
      _abdmCareContextPrescription(_activeRx, _activeRxId);
    }

    // 7. Print invoice
    _printInvoice(bill.id, payable, subtotal, discount, total, payMethod);

    _toast(`${_esc(_activeRx.patient?.name)} — dispensed, bill generated`, 'info');
    _closeRx();
    loadQueue();

  } catch (err) {
    console.error(err);
    _toast('Error: ' + (err.message || 'Please try again'), 'error');
    btn.disabled = false;
    btn.textContent = '✓ Dispense & Generate Bill';
  }
}

// ── ABDM M2 — Care context: Prescription (fire-and-forget) ───────
// Merges Prescription into existing VISIT-{id} care context (no new link token —
// reception already sent one notification when patient's ABHA was verified).
async function _abdmCareContextPrescription(rx, rxId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';
    const visitId = rx.visit?.id;
    const ccRef   = visitId ? `VISIT-${visitId}` : `DISP-${rxId ?? crypto.randomUUID()}`;
    const dateStr = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    await fetch(ABDM_HIP_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({
        action: 'create_care_context', patient_id: rx.patient.id,
        visit_id: visitId ?? null, care_context_ref: ccRef,
        display: visitId ? `OPD Visit — ${dateStr}` : `Prescription — ${dateStr}`,
        hi_types: ['Prescription'], abha_number: rx.patient.abha_number,
      }),
    });
  } catch (e) { console.warn('[ABDM] prescription care context failed:', e.message); }
}

// ── Print invoice ─────────────────────────────────
function _printInvoice(billId, items, subtotal, discount, total, payMethod) {
  const tenant = _tenant;
  const date   = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
  const time   = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });

  document.getElementById('print-header').innerHTML = `
    <div style="text-align:center;margin-bottom:12px;border-bottom:2px solid #1a4a2e;padding-bottom:10px">
      <h2 style="font-family:'Cormorant Garamond',serif;font-size:22px;color:#1a4a2e;margin:0">${_esc(tenant.name||'AyurXpert Dispensary')}</h2>
      <p style="font-size:11px;color:#8a9e90;margin-top:2px">${_esc(tenant.city||'')} ${_esc(tenant.state||'')}</p>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;margin-bottom:10px">
      <div>Patient: <strong>${_esc(_activeRx.patient?.name)}</strong></div>
      <div style="text-align:right">Date: <strong>${date} ${time}</strong></div>
      <div>Phone: <strong>${_esc(_activeRx.patient?.phone||'—')}</strong></div>
      <div style="text-align:right">Bill #: <strong>${billId.slice(-8).toUpperCase()}</strong></div>
      <div>Token: <strong>#${_activeRx.visit?.token_number||'—'}</strong></div>
      <div style="text-align:right">Payment: <strong>${payMethod}</strong></div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px">
      <thead>
        <tr style="border-bottom:1px solid #1a4a2e">
          <th style="text-align:left;padding:4px 0;color:#1a4a2e">#</th>
          <th style="text-align:left;padding:4px 0;color:#1a4a2e">Medicine</th>
          <th style="text-align:right;padding:4px 0;color:#1a4a2e">Qty</th>
          <th style="text-align:right;padding:4px 0;color:#1a4a2e">Rate</th>
          <th style="text-align:right;padding:4px 0;color:#1a4a2e">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((c,i) => `
          <tr style="border-bottom:1px dashed #d4e6da">
            <td style="padding:4px 0">${i+1}</td>
            <td style="padding:4px 0">${_esc(c.name)}</td>
            <td style="padding:4px 0;text-align:right">${c.qty}</td>
            <td style="padding:4px 0;text-align:right">₹${c.price.toFixed(2)}</td>
            <td style="padding:4px 0;text-align:right">₹${(c.qty*c.price).toFixed(2)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div style="text-align:right;font-size:11px">
      <div>Subtotal: ₹${subtotal.toFixed(2)}</div>
      ${discount > 0 ? `<div>Discount: ₹${discount.toFixed(2)}</div>` : ''}
      <div style="font-size:13px;font-weight:600;color:#1a4a2e;border-top:1px solid #1a4a2e;margin-top:4px;padding-top:4px">Total: ₹${total.toFixed(2)}</div>
    </div>
    <div style="margin-top:16px;font-size:10px;color:#8a9e90;text-align:center">Dispensed by: ${_esc(profile.full_name)} · AyurXpert HMS</div>
  `;
  window.print();
}

// ── Close ─────────────────────────────────────────
document.getElementById('btn-close').addEventListener('click', _closeRx);

function _closeRx() {
  _activeRxId = null;
  _activeRx   = null;
  _cartItems  = [];
  document.getElementById('d-active').style.display = 'none';
  document.getElementById('welcome').style.display  = '';
  document.getElementById('discount').value = '0';
  loadQueue();
}

// ── Realtime ──────────────────────────────────────
function subscribeRealtime() {
  supabase.channel('pharmacy-live')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'prescriptions',
      filter: `tenant_id=eq.${tenantId}`
    }, payload => {
      loadQueue();
      _toast('New prescription received', 'info');
    })
    .subscribe();
}

// ── Toast ─────────────────────────────────────────
function _toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.innerHTML = `<span class="toast-icon">${type==='error'?'⚠':'✓'}</span><span>${msg}</span>`;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Boot ──────────────────────────────────────────
await Promise.all([loadInventory(), loadQueue()]);
subscribeRealtime();

// ── NABH MOM.6 CORE — Medication Label Printing ──────────────────────────────
window.printMedLabel = function(i) {
  const item = _cartItems[Number(i)];
  if (!item) return;
  const pt    = _activeRx?.patient;
  const uhid  = pt?.id ? `AYX-${pt.id.replace(/-/g,'').slice(0,8).toUpperCase()}` : '—';
  const today = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const w = window.open('','_blank','width=350,height=500');
  w.document.write(`<!DOCTYPE html><html><head>
    <style>
      body{font-family:'DM Sans',Arial,sans-serif;font-size:11px;margin:0;padding:10px;width:300px;color:#000}
      .lbl-org{font-size:10px;font-weight:600;text-align:center;border-bottom:1px solid #000;padding-bottom:4px;margin-bottom:6px}
      .lbl-patient{font-size:13px;font-weight:700;margin-bottom:2px}
      .lbl-uhid{font-size:10px;color:#333;margin-bottom:6px}
      .lbl-med{font-size:12px;font-weight:700;color:#1a4a2e;margin-bottom:2px}
      .lbl-row{display:flex;gap:6px;margin-bottom:2px}
      .lbl-key{font-weight:600;min-width:60px}
      .lbl-divider{border-top:1px dashed #aaa;margin:6px 0}
      .lbl-warn{font-size:9px;font-weight:700;color:#8b1a1a;text-align:center;border:1px solid #f5b8b8;padding:2px;margin-top:4px}
      @media print{body{margin:0}}
    <\/style><\/head><body onload="window.print();window.close()">
    <div class="lbl-org">${_esc(_tenant?.name||'Ayurveda Hospital')}</div>
    <div class="lbl-patient">${_esc(pt?.name||'—')}</div>
    <div class="lbl-uhid">UHID: ${uhid} | Date: ${today}</div>
    <div class="lbl-divider"></div>
    <div class="lbl-med">${_esc(item.name)}</div>
    ${item.dosage?`<div class="lbl-row"><span class="lbl-key">Dose:</span><span>${_esc(item.dosage)}</span></div>`:''}
    ${item.frequency?`<div class="lbl-row"><span class="lbl-key">Frequency:</span><span>${_esc(item.frequency)}</span></div>`:''}
    ${item.anupana?`<div class="lbl-row"><span class="lbl-key">Anupana:</span><span>${_esc(item.anupana)}</span></div>`:''}
    <div class="lbl-row"><span class="lbl-key">Qty:</span><span>${item.qty}</span></div>
    ${item.is_high_risk?'<div class="lbl-warn">⚠ HIGH-RISK MEDICATION — DOUBLE CHECK</div>':''}
  <\/body><\/html>`);
  w.document.close();
};

// ── NABH MOM.3 CORE — NDPS / Schedule H Register ─────────────────────────────
let _ndpsMeds = [];

window.openNDPSTab = async function() {
  document.getElementById('ndps-panel').style.display = '';
  document.getElementById('main-panel').style.display = 'none';
  await loadNDPSMeds();
  await loadNDPSRegister();
};

window.closeNDPSTab = function() {
  document.getElementById('ndps-panel').style.display = 'none';
  document.getElementById('main-panel').style.display = '';
};

async function loadNDPSMeds() {
  const { data } = await supabase.from('inventory')
    .select('id,medicine_id,stock_quantity,medicine:medicines(name)')
    .eq('tenant_id',tenantId).eq('is_schedule_h',true);
  _ndpsMeds = data || [];
  const sel = document.getElementById('ndps-med-sel');
  sel.innerHTML = '<option value="">— Select Schedule H drug —</option>' +
    _ndpsMeds.map(m => `<option value="${m.id}">${_esc(m.medicine?.name||'—')} (Stock: ${m.stock_quantity||0})</option>`).join('');
}

async function loadNDPSRegister() {
  const { data } = await supabase.from('ndps_register')
    .select('*,profiles!created_by(full_name)')
    .eq('tenant_id',tenantId)
    .order('transaction_date',{ascending:false})
    .limit(50);
  const el = document.getElementById('ndps-list');
  if (!data?.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">No entries yet.</div>'; return; }
  const typeColor = {received:'#27ae60',dispensed:'#e74c3c',returned:'#f39c12',written_off:'#888'};
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f5faf7"><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Date</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Drug</th><th style="padding:6px 10px;text-align:center;border-bottom:1.5px solid var(--border)">Type</th><th style="padding:6px 10px;text-align:right;border-bottom:1.5px solid var(--border)">Qty</th><th style="padding:6px 10px;text-align:right;border-bottom:1.5px solid var(--border)">Balance</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">By</th></tr></thead>
    <tbody>${data.map(r=>`<tr><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${r.transaction_date}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;font-weight:600">${_esc(r.medicine_name)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:center"><span style="font-size:10px;font-weight:700;color:${typeColor[r.transaction_type]||'#888'};background:${typeColor[r.transaction_type]||'#888'}18;padding:2px 7px;border-radius:10px;text-transform:uppercase">${r.transaction_type}</span></td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:right">${r.quantity} ${_esc(r.unit||'')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:right;font-weight:700">${r.balance}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;color:var(--text-muted)">${_esc(r.profiles?.full_name||'—')}</td></tr>`).join('')}
    </tbody></table>`;
}

window._ndpsUpdateBalance = async function() {
  const invId = document.getElementById('ndps-med-sel').value;
  if (!invId) return;
  const { data } = await supabase.from('ndps_register')
    .select('balance').eq('tenant_id',tenantId)
    .eq('medicine_id', _ndpsMeds.find(m=>m.id===invId)?.medicine_id)
    .order('created_at',{ascending:false}).limit(1).maybeSingle();
  const inv = _ndpsMeds.find(m=>m.id===invId);
  const bal = data?.balance ?? inv?.stock_quantity ?? 0;
  document.getElementById('ndps-current-balance').textContent = bal;
};

window.saveNDPSEntry = async function() {
  const invId  = document.getElementById('ndps-med-sel').value;
  const type   = document.getElementById('ndps-type').value;
  const qty    = parseFloat(document.getElementById('ndps-qty').value);
  const notes  = document.getElementById('ndps-notes').value.trim();
  if (!invId || !qty) { _toast('Select drug and enter quantity','error'); return; }
  const inv = _ndpsMeds.find(m => m.id === invId);
  if (!inv) return;
  const currentBalance = parseFloat(document.getElementById('ndps-current-balance').textContent) || inv.stock_quantity || 0;
  const newBalance = type === 'received' ? currentBalance + qty : currentBalance - qty;
  if (newBalance < 0) { _toast('Insufficient balance in register','error'); return; }
  const { error } = await supabase.from('ndps_register').insert({
    tenant_id: tenantId, medicine_id: inv.medicine_id, medicine_name: inv.medicine?.name,
    transaction_type: type, quantity: qty, unit: 'units', balance: newBalance,
    notes: notes || null, created_by: userId, transaction_date: new Date().toISOString().slice(0,10),
  });
  if (error) { _toast(error.message,'error'); return; }
  _toast('NDPS entry saved','success');
  document.getElementById('ndps-qty').value = '';
  document.getElementById('ndps-notes').value = '';
  await loadNDPSRegister();
};
