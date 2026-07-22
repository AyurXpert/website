import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/constants.js';
import { requireAuth, getCurrentProfile, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

// Session 113 -- receptionist added so front-desk staff can check whether a patient's
// report is ready when they call in (Dr. Venkatesh's ask). Deliberately read-only and
// Pathology-only -- see _isReceptionist gating below, and _applyReceptionistOrderView()
// for what's withheld (actual result values/critical flags, all edit/release actions,
// Imaging/AERB/PCPNDT which are unrelated to front-desk work).
requireAuth(['lab_tech','super_admin','dept_admin','doctor','nurse','receptionist']);
initNavbar();
wireDelegatedEvents();

const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = tenant?.id;
const userId    = profile?.id;
const _isReceptionist = profile?.role === 'receptionist';

let _orders      = [];
let _activeOrder = null;
let _activeItems = [];
let _filter      = 'all';
let _dateOffset  = 0;
let _signatories = [];

async function loadSignatories() {
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .in('role', ['doctor','lab_tech','dept_admin'])
    .order('full_name');
  _signatories = data || [];
  const sel = document.getElementById('lab-signed-by');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select signatory —</option>' +
    _signatories.map(p => `<option value="${p.id}">${_esc(p.full_name)} (${p.role==='doctor'?'Doctor':p.role==='lab_tech'?'Lab Tech':'Admin'})</option>`).join('');
}

// ── Test catalog ──────────────────────────────────────────────────────────────
const CAT_LABELS = {
  haematology:'🩸 Haematology', biochemistry:'🧪 Biochemistry',
  lipid:'💛 Lipid Profile', thyroid:'🦋 Thyroid Function',
  urine:'💧 Urine Analysis', stool:'🟤 Stool Analysis',
  serology:'🛡 Serology & Microbiology', imaging_ecg:'📡 Imaging & ECG', other:'🔬 Other Tests'
};

// critical_low/critical_high cause ⚠ alert when exceeded
const TEST_REF = {
  // Haematology
  'Haemoglobin (Hb)':{cat:'haematology',unit:'g/dL',ref:'M: 13.0–17.0 | F: 11.0–15.0',cl:7,ch:null},
  'Total Leucocyte Count (TLC)':{cat:'haematology',unit:'/mm³',ref:'4000–11000',cl:2000,ch:30000},
  'Differential Leucocyte Count (DLC)':{cat:'haematology',unit:'%',ref:'N:40-70, L:20-40, M:2-8, E:1-6, B:0-1',cl:null,ch:null},
  'Platelet Count':{cat:'haematology',unit:'/mm³',ref:'1.5–4.5 lakhs',cl:50000,ch:null},
  'PCV / Haematocrit':{cat:'haematology',unit:'%',ref:'M: 40–54 | F: 37–47',cl:null,ch:null},
  'ESR (Westergren)':{cat:'haematology',unit:'mm/hr',ref:'M: 0–15 | F: 0–20',cl:null,ch:null},
  'Peripheral Blood Smear':{cat:'haematology',unit:'',ref:'Normal morphology',cl:null,ch:null},
  'Reticulocyte Count':{cat:'haematology',unit:'%',ref:'0.5–2.0',cl:null,ch:null},
  'Blood Group & Rh Type':{cat:'haematology',unit:'',ref:'',cl:null,ch:null},
  // Biochemistry
  'Fasting Blood Sugar (FBS)':{cat:'biochemistry',unit:'mg/dL',ref:'70–100',cl:40,ch:500},
  'Post-Prandial Blood Sugar (PPBS)':{cat:'biochemistry',unit:'mg/dL',ref:'<140',cl:40,ch:500},
  'Random Blood Sugar (RBS)':{cat:'biochemistry',unit:'mg/dL',ref:'80–140',cl:40,ch:500},
  'HbA1c':{cat:'biochemistry',unit:'%',ref:'<5.7 Normal | 5.7–6.4 Pre-DM | ≥6.5 DM',cl:null,ch:null},
  'Serum Creatinine':{cat:'biochemistry',unit:'mg/dL',ref:'M: 0.7–1.2 | F: 0.5–1.1',cl:null,ch:10},
  'Blood Urea':{cat:'biochemistry',unit:'mg/dL',ref:'15–40',cl:null,ch:200},
  'Serum Uric Acid':{cat:'biochemistry',unit:'mg/dL',ref:'M: 3.5–7.2 | F: 2.6–6.0',cl:null,ch:null},
  'SGOT (AST)':{cat:'biochemistry',unit:'U/L',ref:'10–40',cl:null,ch:null},
  'SGPT (ALT)':{cat:'biochemistry',unit:'U/L',ref:'7–45',cl:null,ch:null},
  'Serum Bilirubin Total':{cat:'biochemistry',unit:'mg/dL',ref:'0.2–1.2',cl:null,ch:null},
  'Serum Bilirubin Direct':{cat:'biochemistry',unit:'mg/dL',ref:'0.0–0.3',cl:null,ch:null},
  'Alkaline Phosphatase (ALP)':{cat:'biochemistry',unit:'U/L',ref:'44–147',cl:null,ch:null},
  'Serum Albumin':{cat:'biochemistry',unit:'g/dL',ref:'3.5–5.0',cl:null,ch:null},
  'Total Protein':{cat:'biochemistry',unit:'g/dL',ref:'6.0–8.3',cl:null,ch:null},
  'Serum Sodium':{cat:'biochemistry',unit:'mEq/L',ref:'136–145',cl:120,ch:160},
  'Serum Potassium':{cat:'biochemistry',unit:'mEq/L',ref:'3.5–5.0',cl:2.5,ch:6.5},
  'Serum Calcium':{cat:'biochemistry',unit:'mg/dL',ref:'8.5–10.5',cl:6.5,ch:13},
  'Serum Iron':{cat:'biochemistry',unit:'μg/dL',ref:'M: 60–170 | F: 50–150',cl:null,ch:null},
  'TIBC':{cat:'biochemistry',unit:'μg/dL',ref:'250–370',cl:null,ch:null},
  'Vitamin D (25-OH)':{cat:'biochemistry',unit:'ng/mL',ref:'>30 sufficient | 20–30 insufficient | <20 deficient',cl:null,ch:null},
  'Vitamin B12':{cat:'biochemistry',unit:'pg/mL',ref:'200–900',cl:null,ch:null},
  'CRP (C-Reactive Protein)':{cat:'biochemistry',unit:'mg/L',ref:'<5',cl:null,ch:null},
  // Lipid
  'Total Cholesterol':{cat:'lipid',unit:'mg/dL',ref:'<200 desirable',cl:null,ch:300},
  'Triglycerides (TG)':{cat:'lipid',unit:'mg/dL',ref:'<150',cl:null,ch:500},
  'HDL Cholesterol':{cat:'lipid',unit:'mg/dL',ref:'M: >40 | F: >50',cl:25,ch:null},
  'LDL Cholesterol':{cat:'lipid',unit:'mg/dL',ref:'<100 optimal | <130 near-optimal',cl:null,ch:null},
  'VLDL Cholesterol':{cat:'lipid',unit:'mg/dL',ref:'5–40',cl:null,ch:null},
  // Thyroid
  'TSH':{cat:'thyroid',unit:'μIU/mL',ref:'0.4–4.0',cl:null,ch:100},
  'T3 (Triiodothyronine)':{cat:'thyroid',unit:'ng/dL',ref:'80–200',cl:null,ch:null},
  'T4 (Thyroxine)':{cat:'thyroid',unit:'μg/dL',ref:'5.0–12.0',cl:null,ch:null},
  // Urine
  'Urine Routine & Microscopy':{cat:'urine',unit:'',ref:'See individual parameters',cl:null,ch:null},
  'Urine — Albumin (Protein)':{cat:'urine',unit:'',ref:'Nil / Negative',cl:null,ch:null},
  'Urine — Sugar (Glucose)':{cat:'urine',unit:'',ref:'Nil / Negative',cl:null,ch:null},
  'Urine — Pus Cells (WBCs)':{cat:'urine',unit:'/hpf',ref:'0–5',cl:null,ch:50},
  'Urine — RBCs':{cat:'urine',unit:'/hpf',ref:'0–2',cl:null,ch:null},
  'Urine — pH':{cat:'urine',unit:'',ref:'4.5–8.0',cl:null,ch:null},
  'Urine — Specific Gravity':{cat:'urine',unit:'',ref:'1.005–1.030',cl:null,ch:null},
  'Urine — Ketone Bodies':{cat:'urine',unit:'',ref:'Negative',cl:null,ch:null},
  'Urine — Bile Salts/Pigments':{cat:'urine',unit:'',ref:'Negative',cl:null,ch:null},
  'Urine — Casts':{cat:'urine',unit:'',ref:'Nil',cl:null,ch:null},
  'Urine Culture & Sensitivity':{cat:'urine',unit:'',ref:'No growth (sterile)',cl:null,ch:null},
  'Urine Pregnancy Test (UPT)':{cat:'urine',unit:'',ref:'Negative',cl:null,ch:null},
  // Stool
  'Stool Routine & Microscopy':{cat:'stool',unit:'',ref:'No ova / cysts / parasites',cl:null,ch:null},
  'Stool — Occult Blood':{cat:'stool',unit:'',ref:'Negative',cl:null,ch:null},
  // Serology
  'Widal Test (TO + TH)':{cat:'serology',unit:'',ref:'<1:80 baseline',cl:null,ch:null},
  'RA Factor (Rheumatoid Factor)':{cat:'serology',unit:'IU/mL',ref:'<14',cl:null,ch:null},
  'ASO Titre':{cat:'serology',unit:'IU/mL',ref:'<200',cl:null,ch:null},
  'HIV I & II (Rapid)':{cat:'serology',unit:'',ref:'Non-reactive',cl:null,ch:null},
  'HBsAg (Hepatitis B)':{cat:'serology',unit:'',ref:'Non-reactive',cl:null,ch:null},
  'Anti-HCV (Hepatitis C)':{cat:'serology',unit:'',ref:'Non-reactive',cl:null,ch:null},
  'Malaria (MP / RDT)':{cat:'serology',unit:'',ref:'Negative',cl:null,ch:null},
  'Dengue NS1 Antigen':{cat:'serology',unit:'',ref:'Negative',cl:null,ch:null},
  'Dengue IgM / IgG':{cat:'serology',unit:'',ref:'Negative',cl:null,ch:null},
  'Leptospira IgM':{cat:'serology',unit:'',ref:'Negative',cl:null,ch:null},
  'ANA (Antinuclear Antibody)':{cat:'serology',unit:'',ref:'Negative',cl:null,ch:null},
  'Blood Culture & Sensitivity':{cat:'serology',unit:'',ref:'No growth',cl:null,ch:null},
  'Sputum AFB (ZN Stain)':{cat:'serology',unit:'',ref:'No AFB seen',cl:null,ch:null},
  // Imaging/ECG
  'X-Ray Chest (PA view)':{cat:'imaging_ecg',unit:'',ref:'Report findings',cl:null,ch:null},
  'X-Ray (specify area)':{cat:'imaging_ecg',unit:'',ref:'Report findings',cl:null,ch:null},
  'USG Abdomen & Pelvis':{cat:'imaging_ecg',unit:'',ref:'Report findings',cl:null,ch:null},
  'USG Pelvis (Obstetric)':{cat:'imaging_ecg',unit:'',ref:'Report findings',cl:null,ch:null},
  'ECG (12-lead)':{cat:'imaging_ecg',unit:'',ref:'Report findings',cl:null,ch:null},
  'ECHO (Echocardiography)':{cat:'imaging_ecg',unit:'',ref:'Report findings',cl:null,ch:null},
  // Other
  'Coagulation Profile (PT/INR/aPTT)':{cat:'other',unit:'',ref:'PT: 11-13.5 sec | INR: 0.8-1.2 | aPTT: 25-35 sec',cl:null,ch:null},
  'PAP Smear':{cat:'other',unit:'',ref:'Negative for intraepithelial lesion',cl:null,ch:null},
  'FNAC (specify site)':{cat:'other',unit:'',ref:'Report findings',cl:null,ch:null},
  'Biopsy (specify site)':{cat:'other',unit:'',ref:'Report findings',cl:null,ch:null},
  'Procalcitonin (PCT)':{cat:'other',unit:'ng/mL',ref:'<0.5 low sepsis risk',cl:null,ch:null},
};

// ── Date helpers ──────────────────────────────────────────────────────────────
function getViewDate() {
  const d = new Date();
  d.setDate(d.getDate() + _dateOffset);
  return d.toISOString().slice(0,10);
}
function updateDateLabel() {
  const d = new Date(getViewDate()+'T00:00:00');
  const today = new Date().toISOString().slice(0,10);
  const label = _dateOffset === 0 ? 'Today — ' : '';
  document.getElementById('date-label').textContent = label + d.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short'});
}
window.setDateOffset = function(n) { _dateOffset += Number(n); updateDateLabel(); loadOrders(); };
window.goToday = function() { _dateOffset = 0; updateDateLabel(); loadOrders(); };

// ── Load orders ───────────────────────────────────────────────────────────────
async function loadOrders() {
  const date = getViewDate();
  const { data, error } = await supabase
    .from('lab_orders')
    .select(`*, visits(patients(id,name,age,gender,phone,abha_number)), profiles!ordered_by(full_name), lab_order_items(id,test_name,test_category,panel_label,result_value,is_abnormal,is_critical)`)
    .eq('tenant_id', tenantId)
    .eq('order_date', date)
    // Session 127 -- a trainee doctor's draft order (review_status='pending_review')
    // stays invisible here until the supervising doctor finalizes it; existing/
    // normal orders default to 'finalized' so this is fully backward compatible.
    .eq('review_status', 'finalized')
    .order('priority', { ascending: false }) // stat > urgent > routine
    .order('created_at');

  if (error) { _alert('error', safeErrorMessage(error, 'Could not load lab orders.')); return; }
  // lab_orders has no direct FK to patients -- routes through visits.patient_id.
  // Flatten here so downstream rendering code can keep using o.patients uniformly.
  _orders = (data || []).map(o => ({ ...o, patients: o.visits?.patients || null })).sort((a,b) => {
    const rank = { stat:0, urgent:1, routine:2 };
    return (rank[a.priority]||2) - (rank[b.priority]||2);
  });
  renderQueue();
  updateStats();

  // Deliberately NOT re-rendering the open detail pane here even though _activeOrder
  // may be stale after this reload -- renderOrderDetail() rebuilds test-category HTML
  // straight from _activeItems, which would blow away any result values a tech has
  // typed but not yet saved. The queue-list badge (which this realtime widening exists
  // for) already reflects the change; the detail pane catches up next time they
  // reselect the order.
}

function updateStats() {
  const stat  = _orders.filter(o => o.priority==='stat'||o.priority==='urgent').length;
  const pend  = _orders.filter(o => o.status==='pending').length;
  const coll  = _orders.filter(o => o.status==='sample_collected').length;
  const prog  = _orders.filter(o => o.status==='in_progress').length;
  const done  = _orders.filter(o => o.status==='completed').length;
  document.getElementById('s-stat').textContent     = stat;
  document.getElementById('s-pending').textContent  = pend;
  document.getElementById('s-collected').textContent= coll;
  document.getElementById('s-progress').textContent = prog;
  document.getElementById('s-done').textContent     = done;
  document.getElementById('queue-count').textContent= _orders.length + ' orders';
}

// Session 124 Step 2 -- groups tests ordered via a panel button (doctor.js's
// LAB_PANELS) into one label (e.g. "CBC") instead of listing all 5 test
// names -- display convenience only, not a completeness check (a panel with
// one test later removed still shows grouped here; billing time re-verifies
// completeness independently, see Step 4).
function _summarizeTests(items) {
  const byPanel = {};
  const individual = [];
  (items || []).forEach(t => {
    if (t.panel_label) (byPanel[t.panel_label] = byPanel[t.panel_label] || []).push(t);
    else individual.push(t.test_name);
  });
  return [...Object.keys(byPanel), ...individual].join(', ');
}

// ── Queue rendering ───────────────────────────────────────────────────────────
function renderQueue() {
  const q      = document.getElementById('q-search').value.toLowerCase();
  const filtered = _orders.filter(o =>
    (_filter === 'all' || o.status === _filter) &&
    (!q || (o.patients?.name||'').toLowerCase().includes(q))
  );
  const list = document.getElementById('queue-list');
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-queue">No orders</div>`; return;
  }
  list.innerHTML = filtered.map(o => {
    const tests = _summarizeTests(o.lab_order_items);
    const hasCritical = (o.lab_order_items||[]).some(t => t.is_critical);
    const isActive = _activeOrder?.id === o.id;
    const paymentDue = o.payment_status === 'pending';
    return `<div class="order-item${isActive?' selected':''}" data-onclick="selectOrder" data-onclick-a0="${o.id}">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="order-pt-name">${o.patients?.name||'—'}${hasCritical?'<span style="color:var(--red);margin-left:4px">⚠</span>':''}</span>
        <span class="priority-badge p-${o.priority}">${o.priority.toUpperCase()}</span>
      </div>
      <div class="order-meta">
        <span class="status-dot dot-${o.status}"></span>${{pending:'Awaiting sample',sample_collected:'Sample collected',in_progress:'In progress',completed:'Completed',cancelled:'Cancelled'}[o.status]||o.status}
        · ${o.patients?.age||'—'}${o.patients?.gender?('/'+o.patients.gender.charAt(0).toUpperCase()):''}
        ${paymentDue ? '<span style="color:#7a4a00;font-weight:700;margin-left:4px">⏳ Payment due</span>' : o.payment_status === 'waived' ? '<span style="color:#7a1a1a;font-weight:700;margin-left:4px">🚨 Waived</span>' : ''}
      </div>
      <div class="order-tests">${tests||'No tests listed'}</div>
    </div>`;
  }).join('');
}

window.setFilter = function(el, f) {
  document.querySelectorAll('.qf-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _filter = f;
  renderQueue();
};

// ── Select order → load result entry ─────────────────────────────────────────
window.selectOrder = async function(id) {
  _activeOrder = _orders.find(o => o.id === id);
  if (!_activeOrder) return;

  // Load items fresh
  const { data: items } = await supabase
    .from('lab_order_items')
    .select('*')
    .eq('order_id', id)
    .order('created_at');
  _activeItems = items || [];

  renderOrderDetail();
  renderQueue(); // update selected state
};

function renderOrderDetail() {
  if (!_activeOrder) return;
  const o = _activeOrder;
  const p = o.patients || {};

  document.getElementById('no-order-msg').style.display  = 'none';
  document.getElementById('active-order').style.display  = 'block';
  document.getElementById('r-pt-name').textContent = p.name || '—';
  document.getElementById('r-pt-meta').textContent =
    `Age ${p.age||'—'} · ${(p.gender||'').charAt(0).toUpperCase()||'—'} · ${p.phone||'—'} · Ordered by: Dr. ${o.profiles?.full_name||'—'} · ${_fmtDate(o.order_date)}${o.order_time?' '+o.order_time.slice(0,5):''}`;

  const pb = document.getElementById('r-priority-badge');
  pb.textContent = o.priority.toUpperCase();
  pb.className = `priority-badge p-${o.priority}`;

  // Sample bar
  const sBar = document.getElementById('sample-bar');
  const paymentDue = o.payment_status === 'pending';
  const paymentBar = document.getElementById('payment-due-bar');
  if (paymentBar) paymentBar.style.display = paymentDue ? 'block' : 'none';
  if (o.status === 'pending') {
    sBar.classList.remove('collected');
    document.getElementById('s-collect-time').value= o.collected_at
      ? o.collected_at.slice(0,16) : new Date().toISOString().slice(0,16);
    document.getElementById('collect-btn').style.display = paymentDue ? 'none' : 'inline-flex';
  } else {
    sBar.classList.add('collected');
    document.getElementById('s-collect-time').value= o.collected_at?.slice(0,16)||'';
    document.getElementById('collect-btn').style.display = 'none';
  }

  // Clinical notes
  if (o.clinical_notes) {
    document.getElementById('clinical-notes-bar').style.display = 'block';
    document.getElementById('r-clinical-notes').textContent = o.clinical_notes;
  } else {
    document.getElementById('clinical-notes-bar').style.display = 'none';
  }

  // Group items by category
  const byCat = {};
  _activeItems.forEach(item => {
    const cat = item.test_category || 'other';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(item);
  });

  const catOrder = ['haematology','biochemistry','lipid','thyroid','urine','stool','serology','imaging_ecg','other'];
  const html = catOrder.filter(c => byCat[c]).map(cat => `
    <div class="category-section">
      <div class="cat-title">${CAT_LABELS[cat]||cat}</div>
      ${byCat[cat].map(item => renderTestRow(item)).join('')}
    </div>`).join('');

  document.getElementById('test-categories').innerHTML = html;
  document.getElementById('lab-ayurveda').value   = o.ayurveda_interpretation || '';
  document.getElementById('lab-signed-by').value  = o.signed_by || '';

  // Critical banner
  const criticals = _activeItems.filter(i => i.is_critical);
  if (criticals.length) {
    document.getElementById('critical-list').textContent = criticals.map(i => i.test_name + ' = ' + i.result_value).join(' | ');
    document.getElementById('critical-banner').classList.add('show');
  } else {
    document.getElementById('critical-banner').classList.remove('show');
  }

  // Print header
  document.getElementById('ph-hospital').textContent = o.tenant_name || tenant?.name || '';
  document.getElementById('ph-pt').textContent  = p.name || '—';
  document.getElementById('ph-age').textContent = `${p.age||'—'} / ${(p.gender||'').charAt(0).toUpperCase()}`;
  document.getElementById('ph-doctor').textContent = `Dr. ${o.profiles?.full_name||'—'}`;
  document.getElementById('ph-collect').textContent= o.collected_at ? new Date(o.collected_at).toLocaleString('en-IN') : '—';
  document.getElementById('ph-rdate').textContent  = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});

  if (_isReceptionist) _applyReceptionistOrderView();
}

// Reception's Clinical Lab access is read-only status-checking only ("is the patient's
// report ready, they're calling to ask") -- never editing/releasing results, and never
// seeing actual result values or critical flags, which stay lab_tech/doctor/nurse/admin
// territory. Runs after renderOrderDetail()'s normal (lab_tech-oriented) render, hiding
// every mutation control and replacing the detailed results grid with a plain status line.
function _applyReceptionistOrderView() {
  document.querySelectorAll('[data-onclick="markSampleCollected"],[data-onclick="saveResults"],[data-onclick="printReport"]')
    .forEach(el => { el.style.display = 'none'; });
  document.getElementById('sample-bar').style.display = 'none';
  document.getElementById('critical-banner').classList.remove('show');
  const ayurvedaBlock = document.querySelector('.ayurveda-interp');
  if (ayurvedaBlock) ayurvedaBlock.style.display = 'none';

  const o = _activeOrder;
  const STATUS_TEXT = {
    pending:           '🕓 Awaiting sample collection',
    sample_collected:  '🧪 Sample collected — testing in progress',
    in_progress:       '🧪 Testing in progress',
    completed:         '✅ Report ready — available at the front desk',
    cancelled:         '✗ Order cancelled',
  };
  const testNames = (_activeItems||[]).map(i => i.test_name).join(', ') || 'No tests listed';
  document.getElementById('test-categories').innerHTML =
    `<div style="background:var(--green-light,#f0faf5);border:1px solid #b7dfc8;border-radius:10px;padding:14px 16px">
       <div style="font-weight:700;font-size:14px;margin-bottom:6px">${STATUS_TEXT[o?.status]||o?.status||'—'}</div>
       <div style="font-size:12.5px;color:var(--text-muted)">Tests ordered: ${_esc(testNames)}</div>
       <div style="font-size:11px;color:var(--text-muted);margin-top:8px">Result values and clinical interpretation are only visible to clinical staff.</div>
     </div>`;
}

function renderTestRow(item) {
  const ref  = TEST_REF[item.test_name] || { unit:'', ref:item.reference_range||'' };
  const rowCls = item.is_critical ? 'critical' : item.is_abnormal ? 'abnormal' : '';
  const flag  = item.is_critical ? 'critical' : item.is_abnormal ? 'abnormal' : 'normal';
  const flagLabel = item.is_critical ? '⚠ CRITICAL' : item.is_abnormal ? 'Abnormal' : 'Normal';
  const inputCls  = item.is_critical ? 'critical-val' : item.is_abnormal ? 'abnormal-val' : '';
  const isComplete = _activeOrder?.status === 'completed';
  return `<div class="test-row ${rowCls}" id="tr-${item.id}">
    <div class="test-name">${item.test_name}</div>
    <input class="test-input ${inputCls}" id="val-${item.id}" type="text" value="${_esc(item.result_value||'')}"
      placeholder="Enter result" data-oninput="evalResult" data-oninput-a0="${item.id}" data-oninput-a1="${_esc(item.test_name)}" data-oninput-a2="@value"
      ${isComplete?'readonly style="background:#f5f5f5"':''}/>
    <div class="test-unit">${ref.unit}</div>
    <div class="test-ref">${ref.ref || item.reference_range || ''}</div>
    <span class="flag-badge flag-${flag}" id="flag-${item.id}">${flagLabel}</span>
    <input class="test-remarks" id="rem-${item.id}" type="text" value="${_esc(item.remarks||'')}" placeholder="Remarks"
      ${isComplete?'readonly style="background:#f5f5f5"':''}/>
  </div>`;
}

// ── Auto-evaluate result ──────────────────────────────────────────────────────
window.evalResult = function(id, testName, val) {
  const ref    = TEST_REF[testName];
  const numVal = parseFloat(val);
  let isCrit = false, isAbn = false;

  if (ref && !isNaN(numVal)) {
    if ((ref.cl !== null && numVal <= ref.cl) || (ref.ch !== null && numVal >= ref.ch)) {
      isCrit = true; isAbn = true;
    } else {
      isAbn = false; // could add range check for abnormal (non-critical) here
    }
  }
  // Text result abnormal keywords
  if (!isCrit && typeof val === 'string') {
    const lv = val.toLowerCase();
    if (/positive|reactive|detected|growth|found|abnormal|malignant/i.test(lv)) isAbn = true;
    if (/critical|emergency|urgent/i.test(lv)) isCrit = isAbn = true;
  }

  const flagEl  = document.getElementById(`flag-${id}`);
  const inputEl = document.getElementById(`val-${id}`);
  const rowEl   = document.getElementById(`tr-${id}`);
  if (!flagEl) return;
  flagEl.className   = `flag-badge flag-${isCrit?'critical':isAbn?'abnormal':'normal'}`;
  flagEl.textContent = isCrit?'⚠ CRITICAL':isAbn?'Abnormal':'Normal';
  inputEl.className  = `test-input ${isCrit?'critical-val':isAbn?'abnormal-val':''}`;
  rowEl.className    = `test-row ${isCrit?'critical':isAbn?'abnormal':''}`;

  // Update in-memory
  const item = _activeItems.find(i => i.id === id);
  if (item) { item.is_critical = isCrit; item.is_abnormal = isAbn; item.result_value = val; }

  // Update critical banner
  const criticals = _activeItems.filter(i => i.is_critical && i.result_value);
  document.getElementById('critical-list').textContent = criticals.map(i => i.test_name + ' = ' + i.result_value).join(' | ');
  criticals.length
    ? document.getElementById('critical-banner').classList.add('show')
    : document.getElementById('critical-banner').classList.remove('show');
};

// ── Sample collection ─────────────────────────────────────────────────────────
window.markSampleCollected = async function() {
  if (!_activeOrder) return;
  if (_activeOrder.payment_status === 'pending') {
    _alert('error', 'Payment is still pending for this order — it must be collected or waived at reception first.');
    return;
  }
  const collectTime= document.getElementById('s-collect-time').value;
  const { error } = await supabase.from('lab_orders').update({
    status: 'sample_collected',
    collected_at: collectTime ? new Date(collectTime).toISOString() : new Date().toISOString(),
    collected_by: userId,
  }).eq('id', _activeOrder.id);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not mark sample collected.')); return; }
  _alert('success', 'Sample marked as collected.');
  _activeOrder.status      = 'sample_collected';
  document.getElementById('sample-bar').classList.add('collected');
  document.getElementById('collect-btn').style.display = 'none';
  await loadOrders();
};

// ── Save results ──────────────────────────────────────────────────────────────
window.saveResults = async function(status) {
  if (!_activeOrder) return;
  if (!status) status = _activeOrder.status === 'completed' ? 'completed' : 'in_progress';

  const updates = _activeItems.map(item => ({
    id:            item.id,
    result_value:  document.getElementById(`val-${item.id}`)?.value?.trim() || item.result_value || null,
    remarks:       document.getElementById(`rem-${item.id}`)?.value?.trim() || null,
    is_abnormal:   item.is_abnormal || false,
    is_critical:   item.is_critical || false,
    entered_by:    userId,
    entered_at:    new Date().toISOString(),
  }));

  // Upsert items
  for (const u of updates) {
    await supabase.from('lab_order_items').update(u).eq('id', u.id);
  }

  // Update order status
  // Note: lab_orders has no report_released_at/by columns -- status='completed' below is
  // sufficient for this page's own needs. Deliberately NOT reusing authorised_at/authorised_by
  // (those belong to lab-nabl.html's NABL sign-off workflow, which checks authorised_at IS NULL
  // before setting it -- writing it here would misattribute the NABL authorisation to whoever
  // clicked Release Report on this page, not the actual pathologist who signed off).
  const orderUpdate = {
    status,
    ayurveda_interpretation:  document.getElementById('lab-ayurveda').value.trim() || null,
    signed_by:                document.getElementById('lab-signed-by').value        || null,
  };
  const { error } = await supabase.from('lab_orders').update(orderUpdate).eq('id', _activeOrder.id);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not update lab order.')); return; }

  // Fire critical alerts to ordering doctor
  const criticals = _activeItems.filter(i => i.is_critical && i.result_value);
  if (criticals.length && status === 'completed') {
    await supabase.from('doctor_alerts').insert({
      tenant_id:    tenantId,
      doctor_id:    _activeOrder.ordered_by,
      visit_id:     _activeOrder.visit_id,
      patient_name: _activeOrder.patients?.name || '—',
      message:      `⚠ CRITICAL LAB VALUES — ${criticals.map(c => c.test_name+': '+c.result_value).join('; ')}`,
      is_read:      false,
    });
  }

  // ABDM M2 — create care context for DiagnosticReport FHIR type (fire-and-forget)
  if (status === 'completed' && _activeOrder.patients?.abha_number) {
    _abdmCareContextLabReport(_activeOrder).catch(() => {});
  }

  _alert('success', status === 'completed' ? 'Report released. Doctor notified of critical values.' : 'Results saved as in-progress.');
  await loadOrders();
  if (_activeOrder) selectOrder(_activeOrder.id);
};

// ── ABDM M2 — Care context: DiagnosticReport (fire-and-forget) ───────
// Merges DiagnosticReport into existing VISIT-{id} care context if order is
// linked to a visit. Standalone lab orders (no visit_id) get their own LAB-{id} CC.
async function _abdmCareContextLabReport(order) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';
    const pt      = order.patients;
    const visitId = order.visit_id;
    const ccRef   = visitId ? `VISIT-${visitId}` : `LAB-${order.id}`;
    const dateStr = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    await fetch(ABDM_HIP_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({
        action: 'create_care_context', patient_id: pt.id,
        visit_id: visitId ?? null, care_context_ref: ccRef,
        display: visitId ? `OPD Visit — ${dateStr}` : `Lab Report — ${dateStr}`,
        hi_types: ['DiagnosticReport'], abha_number: pt.abha_number,
      }),
    });
  } catch (e) { console.warn('[ABDM] lab care context failed:', e.message); }
}

// ── Print ─────────────────────────────────────────────────────────────────────
window.printReport = function() {
  const aiText  = document.getElementById('lab-ayurveda').value.trim();
  const sigId   = document.getElementById('lab-signed-by').value;
  const sigName = sigId ? (_signatories.find(p => p.id === sigId)?.full_name || '—') : '—';
  document.getElementById('ph-ayurveda').textContent         = aiText || '(Not entered)';
  document.getElementById('ph-ayurveda-wrap').style.display  = 'block';
  document.getElementById('ph-signatory').textContent        = sigName;
  const hdr = document.getElementById('print-header');
  hdr.style.display = 'block';
  window.print();
  hdr.style.display = 'none';
  document.getElementById('ph-ayurveda-wrap').style.display  = 'none';
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if (!d) return '—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _alert(type, msg) { const el=document.getElementById('alert-box');el.className=`alert ${type} show`;el.textContent=msg;setTimeout(()=>el.classList.remove('show'),4000); }

// ── Module tabs ───────────────────────────────────────────────────────────────
window.switchModule = function(mod, el) {
  document.querySelectorAll('.module-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  ['pathology','imaging','aerb','pcpndt'].forEach(m => {
    const t = document.getElementById('tab-'+m);
    if (t) t.hidden = m !== mod;
  });
  if (mod === 'imaging')  { loadImagingOrders(); }
  if (mod === 'aerb')     { document.getElementById('aerb-month').value = new Date().toISOString().slice(0,7); loadAerbLog(); }
  if (mod === 'pcpndt')   { document.getElementById('pcpndt-month').value = new Date().toISOString().slice(0,7); loadPcpndtLog(); }
};

// ── Imaging catalog ───────────────────────────────────────────────────────────
const IMG_STUDIES = {
  xray:   ['X-Ray Chest (PA view)','X-Ray Chest (AP view)','X-Ray Abdomen (Erect)','X-Ray Abdomen (Supine)','X-Ray Spine (Cervical)','X-Ray Spine (Lumbar)','X-Ray Pelvis','X-Ray Knee (AP/Lateral)','X-Ray Shoulder','X-Ray Wrist / Hand','X-Ray Ankle / Foot','X-Ray Skull','X-Ray (Other — specify)'],
  usg:    ['USG Abdomen & Pelvis','USG Abdomen Only','USG Pelvis Only','USG Obstetric (Dating)','USG Obstetric (Anomaly Scan)','USG Obstetric (Growth Scan)','USG Neck (Thyroid)','USG Breast','USG Scrotum','USG Soft Tissue (specify)','USG Doppler — Carotid','USG Doppler — Venous Limbs','USG Doppler — Arterial Limbs'],
  ecg:    ['ECG 12-Lead (Resting)','ECG 12-Lead (Post-exercise)'],
  echo:   ['2D Echocardiography','Colour Doppler Echo','Stress Echo'],
  doppler:['Doppler — Carotid Arteries','Doppler — Peripheral Arteries','Doppler — Peripheral Veins','Doppler — Renal Arteries'],
  mri:    ['MRI Brain','MRI Spine (Cervical)','MRI Spine (Lumbar)','MRI Knee','MRI Shoulder','MRI Abdomen','MRI Pelvis','MRI Other (specify)'],
  ct:     ['CT Brain (Plain)','CT Brain (Contrast)','CT Chest','CT Abdomen (Plain)','CT Abdomen (Contrast)','CT Pelvis','CT KUB','CT Other (specify)'],
  outside:['Outside — Lab Tests (specify)','Outside — MRI','Outside — CT Scan','Outside — PET Scan','Outside — Nuclear Medicine','Outside — Other (specify)'],
};
const MOD_LABEL = { xray:'X-Ray', usg:'USG', ecg:'ECG', echo:'ECHO', doppler:'Doppler', mri:'MRI', ct:'CT', outside:'Outside' };

// ── Imaging order queue ───────────────────────────────────────────────────────
let _imgOrders     = [];
let _activeImgOrder= null;
let _imgFilter     = 'all';

async function loadImagingOrders() {
  const date = getViewDate();
  const { data, error } = await supabase
    .from('imaging_orders')
    .select('*, patients(name,age,gender,phone,abha_number), profiles!ordered_by(full_name)')
    .eq('tenant_id', tenantId)
    .eq('order_date', date)
    .order('priority', { ascending: false })
    .order('created_at');
  if (error) { _alert('error', safeErrorMessage(error, 'Could not load imaging orders.')); return; }
  _imgOrders = (data || []).sort((a,b)=>({stat:0,urgent:1,routine:2}[a.priority]||2)-({stat:0,urgent:1,routine:2}[b.priority]||2));
  renderImgQueue();
  updateImgStats();
}

function updateImgStats() {
  const stat    = _imgOrders.filter(o=>o.priority==='stat'||o.priority==='urgent').length;
  const ordered = _imgOrders.filter(o=>o.status==='ordered').length;
  const outside = _imgOrders.filter(o=>o.is_outside_referral).length;
  const done    = _imgOrders.filter(o=>o.status==='completed').length;
  const xray    = _imgOrders.filter(o=>o.modality==='xray').length;
  document.getElementById('i-stat').textContent    = stat;
  document.getElementById('i-ordered').textContent = ordered;
  document.getElementById('i-outside').textContent = outside;
  document.getElementById('i-done').textContent    = done;
  document.getElementById('i-xray').textContent    = xray;
  document.getElementById('img-queue-count').textContent = _imgOrders.length + ' orders';
}

function renderImgQueue() {
  const q = document.getElementById('img-q-search').value.toLowerCase();
  const filtered = _imgOrders.filter(o =>
    (_imgFilter==='all'
      || (_imgFilter==='outside' && o.is_outside_referral)
      || o.modality===_imgFilter) &&
    (!q || (o.patients?.name||'').toLowerCase().includes(q))
  );
  const list = document.getElementById('img-queue-list');
  if (!filtered.length) { list.innerHTML='<div class="empty-queue">No imaging orders</div>'; return; }
  list.innerHTML = filtered.map(o => {
    const isActive = _activeImgOrder?.id === o.id;
    return `<div class="order-item${isActive?' selected':''}" data-onclick="selectImgOrder" data-onclick-a0="${o.id}">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="order-pt-name">${o.patients?.name||'—'}</span>
        <span class="priority-badge p-${o.priority}">${o.priority.toUpperCase()}</span>
      </div>
      <div class="order-meta">
        <span class="modality-pill mod-${o.modality}" style="margin-right:4px">${MOD_LABEL[o.modality]||o.modality}</span>
        ${o.is_outside_referral?'<span style="font-size:10px;color:#1a4080">🔗 Outside</span>':''}
        · ${{ordered:'Ordered',performed:'Performed',completed:'Report Ready',referred_outside:'Referred Out'}[o.status]||o.status}
      </div>
      <div class="order-tests">${o.study_name}</div>
    </div>`;
  }).join('');
}

window.setImgFilter = function(el, f) {
  document.querySelectorAll('#tab-imaging .qf-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active'); _imgFilter = f; renderImgQueue();
};

window.selectImgOrder = function(id) {
  _activeImgOrder = _imgOrders.find(o=>o.id===id);
  if (!_activeImgOrder) return;
  renderImgDetail();
  renderImgQueue();
};

// ── Imaging result entry ──────────────────────────────────────────────────────
const FINDINGS_TEMPLATES = {
  xray: `<div class="field-row c3">
    <div class="field"><label>X-Ray View</label><select id="xv-view"><option>PA</option><option>AP</option><option>Lateral</option><option>Oblique</option><option>Erect</option><option>Supine</option></select></div>
    <div class="field"><label>kVp (if recorded)</label><input id="xv-kvp" type="text" placeholder="60 kVp"/></div>
    <div class="field"><label>mAs (if recorded)</label><input id="xv-mas" type="text" placeholder="10 mAs"/></div>
  </div>
  <div class="field"><label>Findings</label><textarea id="img-findings" placeholder="Heart size: normal / enlarged&#10;Lung fields: clear / infiltrates / consolidation (which zone?)&#10;Costophrenic angles: sharp / obliterated&#10;Mediastinum: normal / widened&#10;Bones: intact / fracture&#10;Soft tissue / Diaphragm: normal"></textarea></div>`,

  usg: `<div class="field-row c2">
    <div class="field"><label>Indication</label><input id="usg-indication" type="text" placeholder="Abdominal pain, obstetric dating, follow-up…"/></div>
    <div class="field"><label>Is this Obstetric USG?</label><select id="usg-is-obs" data-onchange="togglePcpndtFields" data-onchange-a0="@value"><option value="no">No — Routine abdominal / other</option><option value="yes">Yes — Obstetric / Pelvic</option></select></div>
  </div>
  <div id="usg-pcpndt-block" style="display:none;background:var(--red-light);border:1.5px solid #f5c6c6;border-radius:8px;padding:12px 14px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:700;color:#8b1a1a;margin-bottom:8px">⚠ PCPNDT ACT 1994 — Mandatory Fields for Obstetric USG</div>
    <div class="field-row c2">
      <div class="field"><label>Patient's Husband / Guardian Name</label><input id="usg-husband" type="text"/></div>
      <div class="field"><label>Patient's Address</label><input id="usg-address" type="text"/></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 12px;background:#fff;border-radius:6px;border:1px solid #f5c6c6">
      <input type="checkbox" id="usg-sex-not-det" checked style="accent-color:#8b1a1a;width:16px;height:16px"/>
      <label for="usg-sex-not-det" style="font-size:12px;font-weight:600;color:#8b1a1a;cursor:pointer">I declare that the sex of the foetus was NOT determined and NOT disclosed during this examination (PCPNDT §6)</label>
    </div>
  </div>
  <div class="field"><label>Findings</label><textarea id="img-findings" placeholder="Liver: normal size and echogenicity&#10;GB: no calculi&#10;CBD: 4mm&#10;Pancreas: normal&#10;Spleen: normal&#10;Kidneys: normal bilateral&#10;Urinary bladder: normal&#10;Uterus / Ovaries (if applicable)…"></textarea></div>`,

  ecg: `<div class="field-row c3">
    <div class="field"><label>Heart Rate (bpm)</label><input id="ecg-hr" type="text" placeholder="72"/></div>
    <div class="field"><label>Rhythm</label><select id="ecg-rhythm"><option>Sinus Rhythm</option><option>Sinus Tachycardia</option><option>Sinus Bradycardia</option><option>AF — Atrial Fibrillation</option><option>Atrial Flutter</option><option>Ventricular Tachycardia</option><option>Other</option></select></div>
    <div class="field"><label>Axis</label><select id="ecg-axis"><option>Normal Axis</option><option>LAD (Left Axis Deviation)</option><option>RAD (Right Axis Deviation)</option></select></div>
  </div>
  <div class="field-row c3">
    <div class="field"><label>PR Interval (ms)</label><input id="ecg-pr" type="text" placeholder="160 ms"/></div>
    <div class="field"><label>QRS Duration (ms)</label><input id="ecg-qrs" type="text" placeholder="80 ms"/></div>
    <div class="field"><label>QTc (ms)</label><input id="ecg-qtc" type="text" placeholder="420 ms"/></div>
  </div>
  <div class="field"><label>ST / T Wave Changes</label><input id="ecg-st" type="text" placeholder="No ST changes / ST elevation in V1-V4 / T-wave inversion…"/></div>
  <div class="field"><label>Findings / Impression</label><textarea id="img-findings" placeholder="Normal sinus rhythm / Sinus tachycardia / LVH / LBBB / RBBB / Ischaemic changes…"></textarea></div>`,

  default: `<div class="field"><label>Findings</label><textarea id="img-findings" placeholder="Describe findings…" style="height:100px"></textarea></div>`,
};

function renderImgDetail() {
  const o = _activeImgOrder;
  if (!o) return;
  document.getElementById('img-no-order-msg').style.display  = 'none';
  document.getElementById('img-active-order').style.display  = 'block';
  document.getElementById('i-pt-name').textContent = o.patients?.name || '—';
  document.getElementById('i-pt-meta').textContent =
    `Age ${o.patients?.age||'—'} · ${(o.patients?.gender||'').charAt(0).toUpperCase()||'—'} · Ordered by: Dr. ${o.profiles?.full_name||'—'} · ${_fmtDate(o.order_date)}`;
  const mb = document.getElementById('i-mod-badge');
  mb.textContent = MOD_LABEL[o.modality]||o.modality;
  mb.className   = `modality-pill mod-${o.modality}`;
  const pb = document.getElementById('i-priority-badge');
  pb.textContent = o.priority.toUpperCase();
  pb.className   = `priority-badge p-${o.priority}`;

  const isOutside  = o.is_outside_referral;
  const isDone     = o.status === 'completed';
  const template   = FINDINGS_TEMPLATES[o.modality] || FINDINGS_TEMPLATES.default;

  let html = '';
  // Performed by section
  html += `<div class="sec-title">Study Performance</div>
  <div class="field-row c3">
    <div class="field"><label>Performed Date</label><input id="ip-date" type="date" value="${o.performed_date||new Date().toISOString().slice(0,10)}" ${isDone?'readonly style="background:#f5f5f5"':''}></div>
    <div class="field"><label>Operator / Radiographer</label><input id="ip-operator" type="text" value="${_esc(o.operator_name||'')}" placeholder="Radiographer / Technician" ${isDone?'readonly style="background:#f5f5f5"':''}></div>
    <div class="field"><label>Radiologist / Sonologist</label><input id="ip-radiologist" type="text" value="${_esc(o.radiologist_name||'')}" placeholder="Reporting doctor" ${isDone?'readonly style="background:#f5f5f5"':''}></div>
  </div>`;

  if (isOutside) {
    html += `<div class="outside-panel show">
      <div style="font-size:11px;font-weight:700;color:#1a4080;margin-bottom:8px">🔗 Outside Referral</div>
      <div class="field-row c2">
        <div class="field"><label>Centre Name</label><input id="ip-centre" type="text" value="${_esc(o.outside_centre_name||'')}" ${isDone?'readonly style="background:#f5f5f5"':''}></div>
        <div class="field"><label>Expected Date</label><input id="ip-exp-date" type="date" value="${o.expected_date||''}" ${isDone?'readonly style="background:#f5f5f5"':''}></div>
      </div>
    </div>`;
  }

  html += `<div class="sec-title">Findings &amp; Report</div>`;
  html += isOutside
    ? `<div class="field"><label>Report / Findings (from outside centre)</label><textarea id="img-findings" style="height:80px" ${isDone?'readonly style="background:#f5f5f5"':''}>${_esc(o.findings||'')}</textarea></div>`
    : template.replace('id="img-findings">', `id="img-findings">${_esc(o.findings||'')}`);

  html += `<div class="field" style="margin-top:10px"><label>Impression / Conclusion</label>
    <textarea id="img-impression" placeholder="Overall impression, clinical correlation…" style="height:60px" ${isDone?'readonly style="background:#f5f5f5"':''}>${_esc(o.impression||'')}</textarea>
  </div>
  <div class="field"><label>Critical / Urgent Finding?</label>
    <select id="img-critical" ${isDone?'disabled':''}>
      <option value="no">No — Routine findings</option>
      <option value="yes" ${o.is_critical?'selected':''}>Yes — Notify treating doctor immediately</option>
    </select>
  </div>`;

  if (!isDone) {
    html += `<div class="no-print" style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" data-onclick="saveImaging" data-onclick-a0="performed">Save as Performed</button>
      <button class="btn btn-sm" style="background:#1a4080;color:#fff" data-onclick="saveImaging" data-onclick-a0="completed">✅ Release Report</button>
    </div>`;
  }

  document.getElementById('img-form-body').innerHTML = html;

  // Pre-fill USG indication if exists
  if (o.modality === 'usg') {
    const usgInd = document.getElementById('usg-indication');
    if (usgInd && o.usg_indication) usgInd.value = o.usg_indication;
  }
}

window.togglePcpndtFields = function(val) {
  const show = val === 'yes';
  const el = document.getElementById('usg-pcpndt-block');
  if (el) el.style.display = show ? 'block' : 'none';
};

window.saveImaging = async function(status) {
  if (!_activeImgOrder) return;
  const findings   = document.getElementById('img-findings')?.value?.trim() || null;
  const impression = document.getElementById('img-impression')?.value?.trim() || null;
  const isCritical = document.getElementById('img-critical')?.value === 'yes';
  const operator   = document.getElementById('ip-operator')?.value?.trim() || null;
  const radiologist= document.getElementById('ip-radiologist')?.value?.trim() || null;
  const perfDate   = document.getElementById('ip-date')?.value || null;

  const payload = {
    status, findings, impression, operator_name:operator,
    radiologist_name:radiologist, performed_date:perfDate,
    is_critical:isCritical,
  };

  // X-ray AERB fields
  if (_activeImgOrder.modality === 'xray') {
    payload.xray_view = document.getElementById('xv-view')?.value || null;
    payload.xray_kv   = [document.getElementById('xv-kvp')?.value, document.getElementById('xv-mas')?.value].filter(Boolean).join(' / ') || null;
  }
  // USG PCPNDT fields
  if (_activeImgOrder.modality === 'usg') {
    payload.usg_indication          = document.getElementById('usg-indication')?.value?.trim() || null;
    payload.pcpndt_sex_not_determined= document.getElementById('usg-sex-not-det')?.checked ?? true;
    payload.pcpndt_husband_name     = document.getElementById('usg-husband')?.value?.trim() || null;
    payload.pcpndt_address          = document.getElementById('usg-address')?.value?.trim() || null;
  }
  if (status === 'completed') {
    payload.report_released_at = new Date().toISOString();
    payload.report_released_by = userId;
  }
  if (document.getElementById('ip-exp-date')?.value) {
    payload.expected_date = document.getElementById('ip-exp-date').value;
  }

  const { error } = await supabase.from('imaging_orders').update(payload).eq('id', _activeImgOrder.id);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not update imaging order.')); return; }

  // Critical alert → doctor
  if (isCritical && status === 'completed') {
    await supabase.from('doctor_alerts').insert({
      tenant_id:    tenantId,
      doctor_id:    _activeImgOrder.ordered_by,
      visit_id:     _activeImgOrder.visit_id,
      patient_name: _activeImgOrder.patients?.name || '—',
      message:      `⚠ CRITICAL IMAGING — ${_activeImgOrder.study_name}: ${impression||findings||'See report'}`,
      is_read:      false,
    });
  }

  _alert('success', status === 'completed' ? 'Imaging report released.' : 'Saved.');
  await loadImagingOrders();
  if (_activeImgOrder) selectImgOrder(_activeImgOrder.id);
};

window.printImagingReport = function() { window.print(); };

// ── New imaging order from lab page ──────────────────────────────────────────
let _imgPtSearch = null, _imgPtTimer = null;

window.openNewImgOrder = function() {
  updateStudyOptions();
  document.getElementById('ni-pt-name').value = '';
  document.getElementById('ni-indication').value = '';
  document.getElementById('ni-priority').value = 'routine';
  document.getElementById('ni-modality').value = 'xray';
  document.getElementById('ni-outside-fields').style.display = 'none';
  updateStudyOptions();
  document.getElementById('new-img-overlay').style.display = 'flex';
};

window.closeNewImgOrder = function() { document.getElementById('new-img-overlay').style.display = 'none'; };
window._closeNewImgOrderIfBackdrop = function(isTarget) { if (isTarget) closeNewImgOrder(); };

window.updateStudyOptions = function() {
  const mod = document.getElementById('ni-modality')?.value || 'xray';
  const sel = document.getElementById('ni-study');
  if (!sel) return;
  sel.innerHTML = (IMG_STUDIES[mod]||[]).map(s=>`<option value="${s}">${s}</option>`).join('');
  document.getElementById('ni-outside-fields').style.display = mod === 'outside' ? 'block' : 'none';
};

let _imgPtResults = [];

window.searchImgPatient = function(val) {
  clearTimeout(_imgPtTimer);
  if (val.length < 2) { document.getElementById('ni-pt-results').innerHTML=''; return; }
  _imgPtTimer = setTimeout(async () => {
    const { data } = await supabase.from('patients')
      .select('id,name,age,gender,phone')
      .eq('tenant_id',tenantId).or(`name.ilike.%${val}%,phone.ilike.%${val}%`).limit(5);
    _imgPtResults = data || [];
    document.getElementById('ni-pt-results').innerHTML = _imgPtResults.map(p=>
      `<div data-onclick="selectImgPt" data-onclick-a0="${p.id}" style="padding:5px 8px;cursor:pointer;border-radius:5px;font-size:12px;border:1px solid var(--border);margin-bottom:3px;background:var(--cream)">
        ${_esc(p.name)} · ${p.age||'?'}/${(p.gender||'').charAt(0).toUpperCase()}
      </div>`).join('');
  }, 280);
};

window.selectImgPt = function(id) {
  const p = _imgPtResults.find(r => r.id === id);
  if (!p) return;
  _imgPtSearch = p;
  document.getElementById('ni-pt-name').value = p.name;
  document.getElementById('ni-pt-results').innerHTML = '';
};

window.submitNewImgOrder = async function() {
  const mod  = document.getElementById('ni-modality').value;
  const study= document.getElementById('ni-study').value;
  if (!_imgPtSearch) { alert('Select a patient first.'); return; }
  const { error } = await supabase.from('imaging_orders').insert({
    tenant_id:           tenantId,
    patient_id:          _imgPtSearch.id,
    ordered_by:          userId,
    order_date:          getViewDate(),
    order_time:          new Date().toTimeString().slice(0,8),
    modality:            mod,
    study_name:          study,
    priority:            document.getElementById('ni-priority').value,
    clinical_indication: document.getElementById('ni-indication').value.trim() || null,
    is_outside_referral: mod === 'outside',
    outside_centre_name: document.getElementById('ni-centre')?.value?.trim() || null,
    outside_centre_contact:document.getElementById('ni-centre-contact')?.value?.trim() || null,
    referred_date:       mod==='outside' ? document.getElementById('ni-ref-date')?.value || null : null,
    expected_date:       mod==='outside' ? document.getElementById('ni-exp-date')?.value || null : null,
    status:              'ordered',
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not create imaging order.')); return; }
  _alert('success', 'Imaging order created.');
  closeNewImgOrder();
  _imgPtSearch = null;
  loadImagingOrders();
};

// ── AERB Log ──────────────────────────────────────────────────────────────────
let _aerbEntries = [];

window.loadAerbLog = async function loadAerbLog() {
  const month = document.getElementById('aerb-month').value;
  if (!month) return;
  const from = month + '-01', to = month + '-31';

  // From imaging_orders (X-ray only)
  const { data: imgXray } = await supabase.from('imaging_orders')
    .select('*, patients(name,age,gender,abha_number), profiles!ordered_by(full_name)')
    .eq('tenant_id', tenantId).eq('modality', 'xray')
    .gte('order_date', from).lte('order_date', to).order('order_date');

  // From manual AERB entries
  const { data: manual } = await supabase.from('aerb_log')
    .select('*').eq('tenant_id', tenantId)
    .gte('xray_date', from).lte('xray_date', to).order('xray_date');

  _aerbEntries = [
    ...(imgXray||[]).map(o => ({
      date: o.order_date, pt_name: o.patients?.name||'—',
      age_sex: `${o.patients?.age||'?'}/${(o.patients?.gender||'').charAt(0).toUpperCase()||'?'}`,
      uhid: o.patients?.abha_number || '—',
      study: o.study_name, view: o.xray_view||'—',
      ordered_by: o.profiles?.full_name||'—',
      operator: o.operator_name||'—',
      kvp: o.xray_kv||'—',
      indication: o.clinical_indication||'—',
      source: 'order',
    })),
    ...(manual||[]).map(m => ({
      date: m.xray_date, pt_name: m.patient_name||'—',
      age_sex: `${m.age||'?'}/${m.sex||'?'}`,
      uhid: m.uhid||'—', study: m.study||'—', view: m.xray_view||'—',
      ordered_by: m.ordered_by||'—', operator: m.operator_name||'—',
      kvp: [m.kvp,m.mas].filter(Boolean).join('/')||'—',
      indication: m.clinical_indication||'—', source: 'manual',
    })),
  ].sort((a,b)=>a.date?.localeCompare(b.date));

  document.getElementById('aerb-count').textContent = _aerbEntries.length + ' entries';
  const tbody = document.getElementById('aerb-tbody');
  tbody.innerHTML = _aerbEntries.length ? _aerbEntries.map((e,i)=>`<tr>
    <td>${i+1}</td><td>${_fmtDate(e.date)}</td><td>${e.pt_name}</td><td>${e.age_sex}</td>
    <td style="font-size:11px">${e.uhid}</td><td>${e.study}${e.view&&e.view!=='—'?' ('+e.view+')':''}</td>
    <td>${e.ordered_by}</td><td>${e.operator}</td><td>${e.kvp}</td>
    <td style="font-size:11px">${e.indication}</td>
  </tr>`).join('') : `<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">No X-ray entries for this month</td></tr>`;
}

window.printAerbLog = function() { window.print(); };

window.openAerbEntry = function() {
  document.getElementById('ae-date').value = new Date().toISOString().slice(0,10);
  ['ae-pt-name','ae-age','ae-uhid','ae-study','ae-view','ae-ordered','ae-operator','ae-kvp','ae-mas','ae-indication'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value='';
  });
  document.getElementById('aerb-overlay').style.display = 'flex';
};
window.closeAerbEntry = function() { document.getElementById('aerb-overlay').style.display = 'none'; };
window._closeAerbEntryIfBackdrop = function(isTarget) { if (isTarget) closeAerbEntry(); };

window.saveAerbEntry = async function() {
  const { error } = await supabase.from('aerb_log').insert({
    tenant_id:         tenantId,
    created_by:        userId,
    xray_date:         document.getElementById('ae-date').value,
    patient_name:      document.getElementById('ae-pt-name').value.trim(),
    age:               document.getElementById('ae-age').value.trim() || null,
    sex:               document.getElementById('ae-sex').value,
    uhid:              document.getElementById('ae-uhid').value.trim() || null,
    study:             document.getElementById('ae-study').value.trim(),
    xray_view:         document.getElementById('ae-view').value.trim() || null,
    ordered_by:        document.getElementById('ae-ordered').value.trim() || null,
    operator_name:     document.getElementById('ae-operator').value.trim() || null,
    kvp:               document.getElementById('ae-kvp').value.trim() || null,
    mas:               document.getElementById('ae-mas').value.trim() || null,
    clinical_indication:document.getElementById('ae-indication').value.trim() || null,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save AERB entry.')); return; }
  _alert('success', 'AERB entry saved.');
  closeAerbEntry();
  loadAerbLog();
};

// ── PCPNDT Register ───────────────────────────────────────────────────────────
window.loadPcpndtLog = async function loadPcpndtLog() {
  const month = document.getElementById('pcpndt-month').value;
  if (!month) return;
  const from = month + '-01', to = month + '-31';
  const { data, error } = await supabase.from('imaging_orders')
    .select('*, patients(name,age,gender), profiles!ordered_by(full_name)')
    .eq('tenant_id', tenantId).eq('modality', 'usg')
    .gte('order_date', from).lte('order_date', to).order('order_date');

  const entries = (data||[]);
  document.getElementById('pcpndt-count').textContent = entries.length + ' entries';
  const tbody = document.getElementById('pcpndt-tbody');
  tbody.innerHTML = entries.length ? entries.map((o,i)=>`<tr>
    <td>${i+1}</td>
    <td>${_fmtDate(o.order_date)}</td>
    <td>${o.patients?.name||'—'}</td>
    <td>${o.patients?.age||'—'}</td>
    <td>${o.pcpndt_husband_name||'—'}</td>
    <td style="font-size:11px">${o.pcpndt_address||'—'}</td>
    <td style="font-size:11px">${o.usg_indication||o.clinical_indication||'—'}</td>
    <td>${o.profiles?.full_name||'—'}</td>
    <td>${o.radiologist_name||'—'}</td>
    <td style="font-weight:700;color:${o.pcpndt_sex_not_determined===false?'var(--red)':'var(--green-deep)'}">
      ${o.pcpndt_sex_not_determined===false?'⚠ YES — VIOLATION':'Not Determined ✓'}
    </td>
    <td style="font-size:11px">${o.impression||'—'}</td>
  </tr>`).join('')
  : `<tr><td colspan="11" style="text-align:center;padding:24px;color:var(--text-muted)">No USG entries for this month</td></tr>`;
}

window.printPcpndtLog = function() { window.print(); };

// ── Init ──────────────────────────────────────────────────────────────────────
updateDateLabel();
await loadOrders();

if (_isReceptionist) {
  // Reception's Clinical Lab access is Pathology-status-checking only -- Imaging/AERB/
  // PCPNDT are unrelated to front-desk work (AERB/PCPNDT are radiation-safety/PCPNDT-Act
  // registers with their own access expectations independent of this app).
  document.querySelectorAll('.module-tab[data-onclick-a0="imaging"],.module-tab[data-onclick-a0="aerb"],.module-tab[data-onclick-a0="pcpndt"]')
    .forEach(btn => { btn.style.display = 'none'; });
} else {
  await loadSignatories();

  // Add imaging order button to tab-imaging header
  document.getElementById('tab-imaging').querySelector('.panel-hdr').insertAdjacentHTML(
    'beforeend',
    `<button class="btn btn-sm no-print" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.4);color:#fff;height:28px;font-size:11px" data-onclick="openNewImgOrder">+ New Order</button>`
  );
}

// Realtime: new orders + status/payment changes from doctor.js or reception.js's
// new Lab Bills panel (Session 126) -- was INSERT-only, so a payment collected at
// reception never cleared the "Payment due" badge here until some unrelated
// action happened to reload the queue.
supabase.channel('lab-orders')
  .on('postgres_changes', { event:'*', schema:'public', table:'lab_orders', filter:`tenant_id=eq.${tenantId}` }, () => loadOrders())
  .subscribe();
supabase.channel('img-orders')
  .on('postgres_changes', { event:'INSERT', schema:'public', table:'imaging_orders', filter:`tenant_id=eq.${tenantId}` }, () => { if(!document.getElementById('tab-imaging').hidden) loadImagingOrders(); })
  .subscribe();
