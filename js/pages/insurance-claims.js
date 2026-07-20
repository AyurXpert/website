import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { supabase } from '../core/db/supabaseClient.js';
import { initNavbar } from '../components/navbar.js';
import { logAudit } from '../core/auditLogger.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

wireDelegatedEvents();

// ── Global state ──────────────────────────────────────────────────────────────
let tenantId      = null;
let currentUser   = null;
let currentRole   = null;
let allClaims     = [];    // all non-self-pay open bills loaded once
let agingClaims   = [];    // same data used in aging tab
let writeoffs     = [];
let writeoffTableExists = true;
let selectedPmjayCat = '';

// ── PMJAY hardcoded codes ─────────────────────────────────────────────────────
const PMJAY_CODES = [
  { code:'AB-AYUSH-P01', name:'Vamana (Therapeutic Emesis)',       category:'Panchakarma', rate:5000,  duration:'3-5 days',  notes:'HBP 2.0' },
  { code:'AB-AYUSH-P02', name:'Virechana (Therapeutic Purgation)', category:'Panchakarma', rate:6000,  duration:'5-7 days',  notes:'HBP 2.0' },
  { code:'AB-AYUSH-P03', name:'Basti (Medicated Enema)',           category:'Panchakarma', rate:4500,  duration:'7 days',    notes:'HBP 2.0' },
  { code:'AB-AYUSH-P04', name:'Nasya (Nasal Therapy)',             category:'Panchakarma', rate:2500,  duration:'7 days',    notes:'HBP 2.0' },
  { code:'AB-AYUSH-P05', name:'Raktamokshana',                     category:'Panchakarma', rate:3000,  duration:'1-3 days',  notes:'HBP 2.0' },
  { code:'AB-AYUSH-P06', name:'Shirodhara',                        category:'Panchakarma', rate:2000,  duration:'7-14 days', notes:'HBP 2.0' },
  { code:'AB-AYUSH-P07', name:'Abhyanga (Full Body Massage)',      category:'Panchakarma', rate:1500,  duration:'Per day',   notes:'HBP 2.0' },
  { code:'AB-AYUSH-M01', name:'Osteoarthritis Management',         category:'Medical Mgmt', rate:7500,  duration:'7 days',  notes:'HBP 2.0' },
  { code:'AB-AYUSH-M02', name:'Rheumatoid Arthritis',              category:'Medical Mgmt', rate:12000, duration:'14 days', notes:'HBP 2.0' },
  { code:'AB-AYUSH-M03', name:'Lumbar Spondylosis',                category:'Medical Mgmt', rate:9000,  duration:'10 days', notes:'HBP 2.0' },
  { code:'AB-AYUSH-M04', name:'Cervical Spondylosis',              category:'Medical Mgmt', rate:8500,  duration:'10 days', notes:'HBP 2.0' },
  { code:'AB-AYUSH-M05', name:'Diabetes Management',               category:'Medical Mgmt', rate:5000,  duration:'7 days',  notes:'HBP 2.0' },
  { code:'AB-AYUSH-M06', name:'Hypertension Management',           category:'Medical Mgmt', rate:4500,  duration:'7 days',  notes:'HBP 2.0' },
  { code:'AB-AYUSH-M07', name:'Psoriasis / Skin disorders',        category:'Medical Mgmt', rate:8000,  duration:'14 days', notes:'HBP 2.0' },
  { code:'AB-AYUSH-M08', name:'Piles / Fistula (Ksharasutra)',     category:'Medical Mgmt', rate:10000, duration:'14 days', notes:'HBP 2.0' },
  { code:'CGHS-AYU-01',  name:'CGHS Ayurveda OPD Consultation',   category:'CGHS',          rate:200,   duration:'Per visit',notes:'CGHS Revised 2022' },
  { code:'CGHS-AYU-02',  name:'CGHS Panchakarma (7-day package)', category:'CGHS',          rate:4200,  duration:'7 days',  notes:'CGHS Revised 2022' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = n  => n != null ? `₹${Number(n).toLocaleString('en-IN',{maximumFractionDigits:2})}` : '—';
const fmtD = s  => s ? new Date(s).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—';
const days = s  => Math.floor((Date.now() - new Date(s)) / 86400000);

function ageClass(d) {
  if (d > 90) return 'age-91';
  if (d > 60) return 'age-61';
  if (d > 30) return 'age-31';
  return '';
}

function payerLabel(p) {
  const map = {
    insurance:'Insurance/TPA', pmjay:'PMJAY', cghs:'CGHS',
    echs:'ECHS', esi:'ESI', corporate:'Corporate', self_pay:'Self Pay'
  };
  return map[p] || p;
}

function payerChip(p) {
  const cls = { insurance:'ins', pmjay:'pmjay', cghs:'cghs', echs:'echs', esi:'esi', corporate:'corp', self_pay:'self' };
  return `<span class="payer-chip ${cls[p]||'self'}">${payerLabel(p)}</span>`;
}

function statusBadge(s) {
  const label = {
    pre_auth_pending:'Pre-Auth Pending', pre_auth_approved:'Pre-Auth Approved',
    submitted:'Submitted', partial_settled:'Partial Settled',
    settled:'Settled', rejected:'Rejected', not_applicable:'N/A', write_off:'Write-off'
  };
  return `<span class="cs-badge ${s||'not_applicable'}">${label[s]||s||'—'}</span>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await requireAuth(['accountant','finance_manager','super_admin','dept_admin']);
  currentUser = await getCurrentProfile();
  currentRole = currentUser?.role;
  tenantId    = await getCurrentTenantId();
  await initNavbar();
  await Promise.all([
    loadActiveClaims(),
    loadWriteoffs(),
    checkWriteoffTable()
  ]);
  renderPmjayCodes();
  // show FAB on aging tab - handled by tab switch
})();

// ── Tab switching ─────────────────────────────────────────────────────────────
window.switchTab = function(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');

  const fab = document.getElementById('fab-writeoff');
  fab.style.display = (name === 'aging') ? 'block' : 'none';

  if (name === 'tpa')   renderProviderCards();
  if (name === 'aging') renderAgingTab();
};

// ── Load all non-self-pay bills ───────────────────────────────────────────────
async function loadActiveClaims() {
  const { data, error } = await supabase
    .from('bills')
    .select(`
      id, visit_id, patient_id, created_at, final_amount, patient_due,
      payer_type, insurance_provider, tpa_name, policy_number,
      pre_auth_number, pre_auth_status, pre_auth_amount,
      insurance_approved_amount, insurance_settled_amount,
      insurance_settlement_date, insurance_claim_status,
      pmjay_package_code, pmjay_mo_approved, is_cashless,
      bill_type, status,
      patients(name),
      visits(chief_complaint, created_at)
    `)
    .eq('tenant_id', tenantId)
    .neq('payer_type', 'self_pay')
    .not('insurance_claim_status', 'in', '("settled","rejected","not_applicable")')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('loadActiveClaims:', error);
    document.getElementById('claims-tbody').innerHTML =
      `<tr><td colspan="10" class="no-data">Error loading claims: ${_esc(safeErrorMessage(error, 'Could not load claims.'))}</td></tr>`;
    return;
  }
  allClaims  = data || [];
  agingClaims = [...allClaims];
  renderKpiCards();
  renderClaimsTable(allClaims);
}

// ── KPI cards ─────────────────────────────────────────────────────────────────
function renderKpiCards() {
  const open      = allClaims.length;
  const outstanding = allClaims.reduce((s, b) => s + Number(b.patient_due || 0), 0);
  const overdue   = allClaims.filter(b => days(b.created_at) > 60).length;
  const now       = new Date();
  const submitted = allClaims.filter(b =>
    b.insurance_claim_status === 'submitted' &&
    new Date(b.created_at).getMonth() === now.getMonth() &&
    new Date(b.created_at).getFullYear() === now.getFullYear()
  ).length;

  document.getElementById('kpi-open-count').textContent  = open;
  document.getElementById('kpi-outstanding').textContent = fmt(outstanding);
  document.getElementById('kpi-overdue').textContent     = overdue;
  document.getElementById('kpi-submitted').textContent   = submitted;
}

// ── Render claims table ───────────────────────────────────────────────────────
function renderClaimsTable(list) {
  const tbody = document.getElementById('claims-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="no-data">No insurance claims found.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(b => {
    const d   = days(b.created_at);
    const cls = ageClass(d);
    const vDate = b.visits?.created_at ? fmtD(b.visits.created_at) : fmtD(b.created_at);
    const prov  = [b.insurance_provider, b.tpa_name].filter(Boolean).join(' / ') || '—';
    return `<tr class="${cls}">
      <td><strong>${_esc(b.patients?.name || '—')}</strong></td>
      <td>${vDate}</td>
      <td>${payerChip(b.payer_type)}</td>
      <td style="font-size:.82rem;">${_esc(prov)}</td>
      <td>${fmt(b.final_amount)}</td>
      <td>${fmt(b.insurance_approved_amount)}</td>
      <td>${fmt(b.patient_due)}</td>
      <td><strong style="color:${d>60?'var(--red)':d>30?'#f97316':'inherit'}">${d}d</strong></td>
      <td>${statusBadge(b.insurance_claim_status)}</td>
      <td><button class="btn-sm btn-outline" data-onclick="openEditModal" data-onclick-a0="${b.id}">Edit</button></td>
    </tr>`;
  }).join('');
}

// ── Filter bar ────────────────────────────────────────────────────────────────
window.applyFilters = function() {
  const statusF = document.getElementById('filter-status').value;
  const payerF  = document.getElementById('filter-payer').value;
  let filtered  = [...allClaims];
  if (statusF) filtered = filtered.filter(b => b.insurance_claim_status === statusF);
  if (payerF)  filtered = filtered.filter(b => {
    if (payerF === 'cghs') return b.payer_type === 'cghs' || b.payer_type === 'echs';
    return b.payer_type === payerF;
  });
  renderClaimsTable(filtered);
};

// ── Edit Claim Modal ──────────────────────────────────────────────────────────
window.openEditModal = function(billId) {
  const b = allClaims.find(x => x.id === billId);
  if (!b) return;
  document.getElementById('edit-bill-id').value = billId;
  document.getElementById('edit-info-strip').innerHTML =
    `<strong>${_esc(b.patients?.name || '—')}</strong> — Bill Amt: <span>${fmt(b.final_amount)}</span> | Patient Due: <span>${fmt(b.patient_due)}</span>`;
  document.getElementById('edit-insurance-provider').value        = b.insurance_provider || '';
  document.getElementById('edit-tpa-name').value                  = b.tpa_name || '';
  document.getElementById('edit-policy-number').value             = b.policy_number || '';
  document.getElementById('edit-pre-auth-number').value           = b.pre_auth_number || '';
  document.getElementById('edit-pre-auth-status').value           = b.pre_auth_status || '';
  document.getElementById('edit-pre-auth-amount').value           = b.pre_auth_amount || '';
  document.getElementById('edit-insurance-approved-amount').value = b.insurance_approved_amount || '';
  document.getElementById('edit-claim-status').value              = b.insurance_claim_status || 'not_applicable';
  document.getElementById('edit-settlement-date').value           = b.insurance_settlement_date ? b.insurance_settlement_date.split('T')[0] : '';
  document.getElementById('edit-pmjay-package-code').value        = b.pmjay_package_code || '';
  document.getElementById('edit-pmjay-mo-approved').checked       = !!b.pmjay_mo_approved;
  document.getElementById('edit-is-cashless').checked             = !!b.is_cashless;

  const isPmjay = b.payer_type === 'pmjay';
  document.getElementById('pmjay-code-group').style.display = isPmjay ? '' : 'none';
  document.getElementById('pmjay-mo-row').style.display     = isPmjay ? '' : 'none';

  document.getElementById('modal-edit-bg').classList.add('open');
};

window.saveClaimEdit = async function() {
  const billId = document.getElementById('edit-bill-id').value;
  if (!billId) return;

  const payload = {
    insurance_provider:        document.getElementById('edit-insurance-provider').value.trim() || null,
    tpa_name:                  document.getElementById('edit-tpa-name').value.trim() || null,
    policy_number:             document.getElementById('edit-policy-number').value.trim() || null,
    pre_auth_number:           document.getElementById('edit-pre-auth-number').value.trim() || null,
    pre_auth_status:           document.getElementById('edit-pre-auth-status').value || null,
    pre_auth_amount:           parseFloat(document.getElementById('edit-pre-auth-amount').value) || null,
    insurance_approved_amount: parseFloat(document.getElementById('edit-insurance-approved-amount').value) || null,
    insurance_claim_status:    document.getElementById('edit-claim-status').value,
    insurance_settlement_date: document.getElementById('edit-settlement-date').value || null,
    pmjay_package_code:        document.getElementById('edit-pmjay-package-code').value.trim() || null,
    pmjay_mo_approved:         document.getElementById('edit-pmjay-mo-approved').checked,
    is_cashless:               document.getElementById('edit-is-cashless').checked,
  };

  const { error } = await supabase
    .from('bills')
    .update(payload)
    .eq('id', billId)
    .eq('tenant_id', tenantId);

  if (error) {
    alert(safeErrorMessage(error, 'Failed to save.'));
    return;
  }

  await logAudit('update_insurance_claim', { bill_id: billId, ...payload });
  closeModal('modal-edit-bg');
  await loadActiveClaims();
};

// ── TAB 2: Provider cards ─────────────────────────────────────────────────────
function renderProviderCards() {
  // Build from allClaims + also fetch settled for TPA view
  loadAllInsuranceBills().then(bills => {
    const grid = document.getElementById('provider-grid');
    if (!bills.length) {
      grid.innerHTML = '<div class="spinner">No insurance bills found.</div>';
      return;
    }
    // Group by provider/tpa
    const map = {};
    bills.forEach(b => {
      const key = b.insurance_provider || b.tpa_name || 'Unknown';
      if (!map[key]) map[key] = { name: key, bills: [] };
      map[key].bills.push(b);
    });

    grid.innerHTML = Object.values(map).map(g => {
      const count       = g.bills.length;
      const totalBilled = g.bills.reduce((s,b) => s + Number(b.final_amount || 0), 0);
      const outstanding = g.bills.reduce((s,b) => s + Number(b.patient_due || 0), 0);
      const submitted   = g.bills.filter(b => b.insurance_claim_status === 'submitted');
      const avgDays     = submitted.length
        ? Math.round(submitted.reduce((s,b) => s + days(b.created_at), 0) / submitted.length)
        : '—';
      return `<div class="provider-card" data-onclick="showProviderDetail" data-onclick-a0="${_esc(g.name)}">
        <div class="pv-name">${_esc(g.name)}</div>
        <div class="pv-stat">Claims: <span>${count}</span></div>
        <div class="pv-stat">Total Billed: <span>${fmt(totalBilled)}</span></div>
        <div class="pv-stat">Outstanding: <span>${fmt(outstanding)}</span></div>
        <div class="pv-stat">Avg Days (Submitted): <span>${avgDays}${typeof avgDays==='number'?' d':''}</span></div>
      </div>`;
    }).join('');

    // store for detail view
    window._providerBillsMap = map;
  });
}

let _allInsuranceBills = null;
async function loadAllInsuranceBills() {
  if (_allInsuranceBills) return _allInsuranceBills;
  const { data, error } = await supabase
    .from('bills')
    .select(`
      id, created_at, final_amount, patient_due,
      payer_type, insurance_provider, tpa_name,
      pre_auth_amount, insurance_approved_amount,
      insurance_settled_amount, insurance_settlement_date,
      insurance_claim_status,
      patients(name)
    `)
    .eq('tenant_id', tenantId)
    .neq('payer_type', 'self_pay')
    .order('created_at', { ascending: false });

  if (error) { console.error(error); return []; }
  _allInsuranceBills = data || [];
  return _allInsuranceBills;
}

window.showProviderDetail = function(providerName) {
  document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.provider-card').forEach(c => {
    if (c.querySelector('.pv-name')?.textContent === providerName) c.classList.add('selected');
  });

  const map  = window._providerBillsMap || {};
  const bills = map[providerName]?.bills || [];
  document.getElementById('provider-detail-title').textContent = providerName + ' — Claims';

  const tbody = document.getElementById('provider-detail-tbody');
  tbody.innerHTML = bills.map(b => `<tr>
    <td>${_esc(b.patients?.name || '—')}</td>
    <td>${fmtD(b.created_at)}</td>
    <td>${fmt(b.final_amount)}</td>
    <td>${fmt(b.pre_auth_amount)}</td>
    <td>${fmt(b.insurance_approved_amount)}</td>
    <td>${fmtD(b.insurance_settlement_date)}</td>
    <td>${statusBadge(b.insurance_claim_status)}</td>
  </tr>`).join('') || `<tr><td colspan="7" class="no-data">No claims.</td></tr>`;

  const totalBilled    = bills.reduce((s,b) => s + Number(b.final_amount || 0), 0);
  const totalApproved  = bills.reduce((s,b) => s + Number(b.insurance_approved_amount || 0), 0);
  const totalSettled   = bills.reduce((s,b) => s + Number(b.insurance_settled_amount || 0), 0);
  const outstanding    = bills.reduce((s,b) => s + Number(b.patient_due || 0), 0);

  document.getElementById('settle-summary-row').innerHTML =
    `<div>Total Billed: <strong>${fmt(totalBilled)}</strong></div>
     <div>Total Approved: <strong>${fmt(totalApproved)}</strong></div>
     <div>Total Settled: <strong>${fmt(totalSettled)}</strong></div>
     <div>Outstanding: <strong>${fmt(outstanding)}</strong></div>`;

  document.getElementById('provider-detail').style.display = '';
};

// ── TAB 3: PMJAY codes ────────────────────────────────────────────────────────
window.renderPmjayCodes = function() {
  const q   = (document.getElementById('pmjay-search')?.value || '').toLowerCase();
  const cat = selectedPmjayCat;
  let list  = PMJAY_CODES;
  if (cat)  list = list.filter(c => c.category === cat);
  if (q)    list = list.filter(c =>
    c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
  );
  const tbody = document.getElementById('pmjay-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="no-data">No matching package codes.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(c => `<tr>
    <td><code style="font-size:.8rem;background:#f3f4f6;padding:2px 6px;border-radius:4px;">${c.code}</code></td>
    <td>${c.name}</td>
    <td><span class="payer-chip ${c.category==='CGHS'?'cghs':'pmjay'}">${c.category}</span></td>
    <td style="font-weight:600;">${fmt(c.rate)}</td>
    <td>${c.duration}</td>
    <td style="font-size:.78rem;color:var(--text-mid);">${c.notes}</td>
    <td><button class="btn-sm btn-outline" data-onclick="openAssignModal" data-onclick-a0="${c.code}" data-onclick-a1="${_esc(c.name)}">Assign to Claim</button></td>
  </tr>`).join('');
};

window.selectCat = function(el, cat) {
  document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  selectedPmjayCat = cat;
  renderPmjayCodes();
};

// ── Assign PMJAY code modal ───────────────────────────────────────────────────
window.openAssignModal = function(code, name) {
  document.getElementById('assign-pkg-code').value = code;
  document.getElementById('assign-pkg-name').value = name;
  document.getElementById('assign-pkg-strip').innerHTML =
    `Assigning: <span>${code}</span> — ${name}`;
  document.getElementById('assign-patient-search').value = '';
  document.getElementById('assign-bill-results').innerHTML = '';
  document.getElementById('assign-selected-bill-id').value = '';
  document.getElementById('assign-selected-info').style.display = 'none';
  document.getElementById('modal-assign-bg').classList.add('open');
};

window.searchAssignBills = async function() {
  const q = document.getElementById('assign-patient-search').value.trim();
  if (q.length < 2) { document.getElementById('assign-bill-results').innerHTML = ''; return; }
  const { data } = await supabase
    .from('bills')
    .select('id, final_amount, payer_type, patients(name)')
    .eq('tenant_id', tenantId)
    .ilike('patients.name', `%${q}%`)
    .limit(8);
  const results = (data || []).filter(b => b.patients?.name);
  const div = document.getElementById('assign-bill-results');
  if (!results.length) { div.innerHTML = '<div style="font-size:.85rem;color:var(--text-mid);">No bills found.</div>'; return; }
  div.innerHTML = results.map(b =>
    `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;background:var(--white);"
      data-onclick="selectAssignBill" data-onclick-a0="${b.id}" data-onclick-a1="${_esc(b.patients?.name||'')}" data-onclick-a2="${b.final_amount}" data-onclick-a3="${b.payer_type}">
      <strong>${_esc(b.patients?.name)}</strong> — ${fmt(b.final_amount)} — ${payerLabel(b.payer_type)}
    </div>`
  ).join('');
};

window.selectAssignBill = function(id, patient, amt, payer) {
  document.getElementById('assign-selected-bill-id').value = id;
  const info = document.getElementById('assign-selected-info');
  info.innerHTML = `Selected: <span>${_esc(patient)}</span> — ${fmt(amt)} — ${payerLabel(payer)}`;
  info.style.display = '';
  document.getElementById('assign-bill-results').innerHTML = '';
};

window.saveAssignCode = async function() {
  const billId = document.getElementById('assign-selected-bill-id').value;
  const code   = document.getElementById('assign-pkg-code').value;
  if (!billId) { alert('Please select a bill first.'); return; }
  const { error } = await supabase
    .from('bills')
    .update({ pmjay_package_code: code })
    .eq('id', billId)
    .eq('tenant_id', tenantId);
  if (error) { alert(safeErrorMessage(error, 'Could not assign PMJAY code.')); return; }
  await logAudit('assign_pmjay_code', { bill_id: billId, pmjay_package_code: code });
  closeModal('modal-assign-bg');
  _allInsuranceBills = null;
  await loadActiveClaims();
};

// ── TAB 4: Aging ──────────────────────────────────────────────────────────────
function renderAgingTab() {
  if (!agingClaims.length) { loadActiveClaims().then(renderAgingDetail); return; }
  renderAgingDetail();
}

function renderAgingDetail() {
  // Buckets
  const b0  = agingClaims.filter(b => days(b.created_at) <= 30);
  const b30 = agingClaims.filter(b => { const d=days(b.created_at); return d>30 && d<=60; });
  const b60 = agingClaims.filter(b => { const d=days(b.created_at); return d>60 && d<=90; });
  const b90 = agingClaims.filter(b => days(b.created_at) > 90);

  const sum = arr => arr.reduce((s,b) => s + Number(b.patient_due || 0), 0);

  document.getElementById('ak-0-count').textContent  = b0.length;
  document.getElementById('ak-0-amt').textContent    = fmt(sum(b0));
  document.getElementById('ak-30-count').textContent = b30.length;
  document.getElementById('ak-30-amt').textContent   = fmt(sum(b30));
  document.getElementById('ak-60-count').textContent = b60.length;
  document.getElementById('ak-60-amt').textContent   = fmt(sum(b60));
  document.getElementById('ak-90-count').textContent = b90.length;
  document.getElementById('ak-90-amt').textContent   = fmt(sum(b90));

  // Detail table — sorted by days desc
  const sorted = [...agingClaims].sort((a,b) => days(b.created_at) - days(a.created_at));
  const tbody  = document.getElementById('aging-tbody');
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="no-data">No open claims.</td></tr>`;
    return;
  }
  tbody.innerHTML = sorted.map(b => {
    const d   = days(b.created_at);
    const cls = ageClass(d);
    const prov = b.insurance_provider || b.tpa_name || '—';
    return `<tr class="${cls}">
      <td><strong>${_esc(b.patients?.name || '—')}</strong></td>
      <td>${payerChip(b.payer_type)}</td>
      <td style="font-size:.82rem;">${_esc(prov)}</td>
      <td>${fmt(b.final_amount)}</td>
      <td><strong style="color:${d>60?'var(--red)':d>30?'#f97316':'inherit'}">${d} days</strong></td>
      <td>${statusBadge(b.insurance_claim_status)}</td>
      <td><button class="btn-sm btn-outline" data-onclick="prefillWriteoff" data-onclick-a0="${b.id}">Request Write-off</button></td>
    </tr>`;
  }).join('');
}

window.prefillWriteoff = function(billId) {
  openWriteoffModal(billId);
};

// ── Write-offs ────────────────────────────────────────────────────────────────
async function checkWriteoffTable() {
  const { error } = await supabase.from('insurance_write_offs').select('id').limit(1);
  if (error && error.code === '42P01') {
    writeoffTableExists = false;
    const banner = document.getElementById('migration-banner');
    banner.className = 'banner warning';
    banner.textContent =
      'Write-off register table not yet created. Ask your system administrator to run the Phase 3 SQL migration.';
  }
}

async function loadWriteoffs() {
  if (!writeoffTableExists) return;
  const { data, error } = await supabase
    .from('insurance_write_offs')
    .select(`
      id, bill_id, amount, reason, notes, status,
      requested_by, approved_by, requested_at, approved_at,
      bills(final_amount, payer_type, patients(name))
    `)
    .eq('tenant_id', tenantId)
    .order('requested_at', { ascending: false });

  if (error) {
    if (error.code === '42P01') { writeoffTableExists = false; return; }
    console.error('loadWriteoffs:', error);
    return;
  }
  writeoffs = data || [];
  renderWriteoffTables();
}

function renderWriteoffTables() {
  renderWriteoffTable('pending');
  renderWriteoffTable('approved');
  renderWriteoffTable('rejected');
}

function renderWriteoffTable(status) {
  const list  = writeoffs.filter(w => w.status === status);
  const isSA  = currentRole === 'super_admin' || currentRole === 'finance_manager';

  if (status === 'pending') {
    const tbody = document.getElementById('wo-pending-tbody');
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="no-data">No pending write-off requests.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(w => `<tr>
      <td>${_esc(w.bills?.patients?.name || '—')}</td>
      <td>${fmt(w.bills?.final_amount)}</td>
      <td>${fmt(w.amount)}</td>
      <td>${_esc(w.reason || '—')}</td>
      <td style="font-size:.82rem;">${_esc(w.requested_by || '—')}</td>
      <td>${fmtD(w.requested_at)}</td>
      <td style="white-space:nowrap;">
        ${isSA
          ? `<button class="btn-sm btn-green" style="margin-right:4px;" data-onclick="approveWriteoff" data-onclick-a0="${w.id}" data-onclick-a1="${w.bill_id}">Approve</button>
             <button class="btn-sm btn-red" data-onclick="rejectWriteoff" data-onclick-a0="${w.id}">Reject</button>`
          : '<span style="color:var(--text-mid);font-size:.8rem;">Awaiting approval</span>'}
      </td>
    </tr>`).join('');
  }

  if (status === 'approved') {
    const tbody = document.getElementById('wo-approved-tbody');
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="no-data">No approved write-offs.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(w => `<tr>
      <td>${_esc(w.bills?.patients?.name || '—')}</td>
      <td>${fmt(w.bills?.final_amount)}</td>
      <td>${fmt(w.amount)}</td>
      <td>${_esc(w.reason || '—')}</td>
      <td style="font-size:.82rem;">${_esc(w.approved_by || '—')}</td>
      <td>${fmtD(w.approved_at)}</td>
    </tr>`).join('');
  }

  if (status === 'rejected') {
    const tbody = document.getElementById('wo-rejected-tbody');
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="no-data">No rejected write-offs.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(w => `<tr>
      <td>${_esc(w.bills?.patients?.name || '—')}</td>
      <td>${fmt(w.bills?.final_amount)}</td>
      <td>${fmt(w.amount)}</td>
      <td>${_esc(w.reason || '—')}</td>
      <td style="font-size:.82rem;">${_esc(w.approved_by || '—')}</td>
      <td>${fmtD(w.approved_at)}</td>
    </tr>`).join('');
  }
}

window.switchWriteoffTab = function(name, btn) {
  document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['pending','approved','rejected'].forEach(s => {
    const el = document.getElementById('wo-' + s);
    if (el) el.style.display = s === name ? '' : 'none';
  });
};

window.approveWriteoff = async function(woId, billId) {
  // Session 114 -- fixed a real, confirmed bug found while verifying the
  // discharge-billing insurance path: approved_by/requested_by are `uuid
  // references profiles(id)` columns, but this and rejectWriteoff()/
  // submitWriteoff() below were sending currentUser.full_name (a text
  // name), which Postgres rejects outright (22P02) -- meaning the entire
  // write-off feature (submit, approve, reject) has never worked for any
  // real logged-in user. Confirmed live: the exact same PATCH that fails
  // with "invalid input syntax for type uuid" here succeeds once the value
  // is currentUser.id instead.
  if (!confirm('Approve this write-off request?')) return;
  const { error: e1 } = await supabase
    .from('insurance_write_offs')
    .update({
      status: 'approved',
      approved_by: currentUser?.id,
      approved_at: new Date().toISOString()
    })
    .eq('id', woId);
  if (e1) { alert('Error: ' + e1.message); return; }

  // Session 114 -- removed a second bug found alongside the one above: this
  // used to also set bills.insurance_claim_status='rejected' right after
  // approving, unconditionally overwriting whatever the DB's own
  // trg_write_off_approval trigger (sql/session78_rpc_baseline.sql,
  // generalized in sql/session114_ipd_discharge_workflow.sql) had just
  // correctly set -- an approved, paid-off bill would show as "Rejected"
  // in every claims report. The trigger already sets insurance_claim_status
  // correctly (and, for reason_type != 'insurance_writeoff' -- promissory
  // note/corporate credit -- deliberately leaves it untouched), so nothing
  // needs to happen here at all.
  await logAudit('approve_write_off', 'insurance_write_offs', woId, { bill_id: billId }, { tenantId, userId: currentUser?.id, userName: currentUser?.full_name });
  await loadWriteoffs();
  await loadActiveClaims();
};

window.rejectWriteoff = async function(woId) {
  if (!confirm('Reject this write-off request?')) return;
  const { error } = await supabase
    .from('insurance_write_offs')
    .update({
      status: 'rejected',
      approved_by: currentUser?.id,
      approved_at: new Date().toISOString()
    })
    .eq('id', woId);
  if (error) { alert(safeErrorMessage(error, 'Could not reject write-off.')); return; }
  await logAudit('reject_write_off', 'insurance_write_offs', woId, {}, { tenantId, userId: currentUser?.id, userName: currentUser?.full_name });
  await loadWriteoffs();
};

// ── Request Write-off Modal ───────────────────────────────────────────────────
window.openWriteoffModal = function(prefillBillId) {
  if (!writeoffTableExists) {
    alert('Write-off table not yet created. Run Phase 3 SQL migration first.');
    return;
  }
  document.getElementById('wo-patient-search').value = '';
  document.getElementById('wo-bill-results').innerHTML = '';
  document.getElementById('wo-selected-bill-id').value = '';
  document.getElementById('wo-selected-info').style.display = 'none';
  document.getElementById('wo-amount-row').style.display   = 'none';
  document.getElementById('wo-notes-row').style.display    = 'none';
  document.getElementById('wo-amount').value  = '';
  document.getElementById('wo-reason').value  = '';
  document.getElementById('wo-notes').value   = '';

  if (prefillBillId) {
    const b = agingClaims.find(x => x.id === prefillBillId);
    if (b) {
      document.getElementById('wo-selected-bill-id').value = prefillBillId;
      const info = document.getElementById('wo-selected-info');
      info.innerHTML = `<span>${_esc(b.patients?.name || '—')}</span> — Bill Amt: ${fmt(b.final_amount)} | Outstanding: ${fmt(b.patient_due)} | ${payerLabel(b.payer_type)}`;
      info.style.display = '';
      document.getElementById('wo-amount-row').style.display = '';
      document.getElementById('wo-notes-row').style.display  = '';
      document.getElementById('wo-amount').max = b.final_amount;
    }
  }
  document.getElementById('modal-writeoff-bg').classList.add('open');
};

window.searchWoBills = async function() {
  const q = document.getElementById('wo-patient-search').value.trim();
  if (q.length < 2) { document.getElementById('wo-bill-results').innerHTML = ''; return; }
  const { data } = await supabase
    .from('bills')
    .select('id, final_amount, patient_due, payer_type, patients(name)')
    .eq('tenant_id', tenantId)
    .ilike('patients.name', `%${q}%`)
    .limit(8);
  const results = (data || []).filter(b => b.patients?.name);
  const div = document.getElementById('wo-bill-results');
  if (!results.length) { div.innerHTML = '<div style="font-size:.85rem;color:var(--text-mid);">No bills found.</div>'; return; }
  div.innerHTML = results.map(b =>
    `<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;background:var(--white);"
      data-onclick="selectWoBill" data-onclick-a0="${b.id}" data-onclick-a1="${_esc(b.patients?.name||'')}" data-onclick-a2="${b.final_amount}" data-onclick-a3="${b.patient_due}" data-onclick-a4="${b.payer_type}">
      <strong>${_esc(b.patients?.name)}</strong> — Bill: ${fmt(b.final_amount)} | Due: ${fmt(b.patient_due)} — ${payerLabel(b.payer_type)}
    </div>`
  ).join('');
};

window.selectWoBill = function(id, patient, amt, due, payer) {
  document.getElementById('wo-selected-bill-id').value = id;
  const info = document.getElementById('wo-selected-info');
  info.innerHTML = `<span>${_esc(patient)}</span> — Bill Amt: ${fmt(amt)} | Outstanding: ${fmt(due)} | ${payerLabel(payer)}`;
  info.style.display = '';
  document.getElementById('wo-bill-results').innerHTML = '';
  document.getElementById('wo-amount').max = parseFloat(amt);
  document.getElementById('wo-amount-row').style.display = '';
  document.getElementById('wo-notes-row').style.display  = '';
};

window.submitWriteoff = async function() {
  const billId = document.getElementById('wo-selected-bill-id').value;
  const amount = parseFloat(document.getElementById('wo-amount').value);
  const reason = document.getElementById('wo-reason').value;
  const notes  = document.getElementById('wo-notes').value.trim();

  if (!billId)        { alert('Please select a bill.'); return; }
  if (!amount || amount <= 0) { alert('Please enter a valid write-off amount.'); return; }
  if (!reason)        { alert('Please select a reason.'); return; }

  const { data: woRow, error } = await supabase.from('insurance_write_offs').insert({
    tenant_id:    tenantId,
    bill_id:      billId,
    amount:       amount,
    reason:       reason,
    notes:        notes || null,
    status:       'pending',
    requested_by: currentUser?.id,
    requested_at: new Date().toISOString()
  }).select('id').single();

  if (error) {
    if (error.code === '42P01') {
      alert('Write-off table not yet created. Ask administrator to run Phase 3 SQL migration.');
    } else {
      alert(safeErrorMessage(error, 'Error submitting write-off.'));
    }
    return;
  }

  await logAudit('request_write_off', 'insurance_write_offs', woRow?.id, { bill_id: billId, amount, reason }, { tenantId, userId: currentUser?.id, userName: currentUser?.full_name });
  closeModal('modal-writeoff-bg');
  await loadWriteoffs();
  renderWriteoffTables();
};

// ── Utility ───────────────────────────────────────────────────────────────────
window.closeModal = function(id) {
  document.getElementById(id).classList.remove('open');
};

// Close modals on backdrop click
document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', e => {
    if (e.target === bg) bg.classList.remove('open');
  });
});
