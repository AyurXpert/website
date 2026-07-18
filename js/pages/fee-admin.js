import { requireAuth, getCurrentProfile, getCurrentTenant, getCurrentTenantId, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

await requireAuth(['dept_admin','super_admin']);
initNavbar();
wireDelegatedEvents();

const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = getCurrentTenantId();
const role      = getCurrentRole();
const userId    = profile.id;
const facType   = tenant?.type || 'clinic';

// ── State ─────────────────────────────────────────
let _allFees   = [];
let _opds      = [];
let _editId    = null;
let _activeTab = 'all';

// ── Facility profile ──────────────────────────────
const FAC_PROFILE = {
  clinic:            { label:'Clinic',              icon:'🏥', cats:['opd','lab','procedure','custom'],                       color:'#1a4a2e' },
  hospital:          { label:'Hospital',            icon:'🏨', cats:['opd','ipd','lab','procedure','radiology','custom'],     color:'#1e40af' },
  teaching_hospital: { label:'Teaching Hospital',   icon:'🏨', cats:['opd','ipd','lab','procedure','radiology','custom'],     color:'#1e40af' },
  pk_center:         { label:'Panchakarma Centre',  icon:'🌿', cats:['opd','procedure','custom'],                            color:'#6d28d9' },
  dispensary:        { label:'Dispensary',          icon:'💊', cats:['opd','custom'],                                        color:'#b45309' },
  college:           { label:'Ayurveda College',    icon:'🎓', cats:['opd','lab','procedure','radiology','custom'],          color:'#0f766e' },
  pharma:            { label:'Pharma',              icon:'🔬', cats:['custom'],                                              color:'#374151' },
  supplier:          { label:'Supplier',            icon:'📦', cats:['custom'],                                              color:'#374151' },
  dealer:            { label:'Dealer',              icon:'🏪', cats:['custom'],                                              color:'#374151' },
};
const fac = FAC_PROFILE[facType] || FAC_PROFILE.clinic;

// Show facility banner
document.getElementById('fac-type').textContent  = `${fac.icon} ${fac.label}`;
document.getElementById('fac-cats').textContent  =
  fac.cats.map(c => ({ opd:'OPD', ipd:'IPD', lab:'Lab & Diagnostics',
    procedure:'Procedures', radiology:'Radiology', custom:'Custom Services' })[c]).join(' · ');

// Show/dim category tabs based on facility type
document.querySelectorAll('.cat-tab[data-cat]').forEach(btn => {
  const cat = btn.dataset.cat;
  if (cat === 'all') return;
  if (!fac.cats.includes(cat)) {
    btn.style.opacity = '0.4';
    btn.title = `Not typical for ${fac.label}`;
  }
});

// ── Role UI setup ─────────────────────────────────
const roleBadge = document.getElementById('role-badge');
const roleLabels = {
  accountant:  { text: 'Accountant — Can create fees', cls: 'accountant' },
  dept_admin:  { text: 'Dept. Admin — Can approve fees', cls: 'dept_admin' },
  super_admin: { text: 'Super Admin — Full control', cls: 'super_admin' }
};
const rl = roleLabels[role] || { text: role, cls: '' };
roleBadge.textContent = rl.text;
roleBadge.classList.add(rl.cls);

if (role === 'super_admin') {
  document.getElementById('bypass-banner').style.display = 'flex';
}

// ── Category helpers ──────────────────────────────
const CAT_LABELS = { opd:'OPD', ipd:'IPD', lab:'Lab', procedure:'Procedure', radiology:'Radiology', custom:'Custom' };
const CAT_TYPES = {
  opd: [
    { value:'registration',       label:'Registration Fee' },
    { value:'consultation',       label:'Consultation Fee' },
    { value:'on_request_surcharge',label:'On-Request Surcharge' }
  ],
  ipd: [
    { value:'admission',          label:'Admission Charge' },
    { value:'room_general',       label:'Room — General Ward' },
    { value:'room_semi_private',  label:'Room — Semi-Private' },
    { value:'room_private',       label:'Room — Private' },
    { value:'room_icu',           label:'Room — ICU / HDU' },
    { value:'nursing',            label:'Nursing Care (per day)' },
    { value:'attendant_bed',      label:'Attendant Bed (per night)' }
  ],
  lab: [
    { value:'blood_cbc',          label:'Blood — CBC' },
    { value:'blood_lft',          label:'Blood — LFT' },
    { value:'blood_rft',          label:'Blood — RFT' },
    { value:'blood_lipid',        label:'Blood — Lipid Profile' },
    { value:'blood_thyroid',      label:'Blood — Thyroid (T3/T4/TSH)' },
    { value:'blood_sugar_fasting',label:'Blood Sugar — Fasting' },
    { value:'blood_sugar_pp',     label:'Blood Sugar — PP' },
    { value:'urine_routine',      label:'Urine — Routine' },
    { value:'stool_routine',      label:'Stool — Routine' },
    { value:'culture_sensitivity',label:'Culture & Sensitivity' },
    { value:'biopsy',             label:'Biopsy' },
    { value:'other_lab',          label:'Other Lab Test' }
  ],
  procedure: [
    // ── General / Nursing ──
    { value:'physiotherapy',      label:'Physiotherapy Session' },
    { value:'wound_dressing',     label:'Wound Dressing' },
    { value:'injection',          label:'Injection (IM/SC)' },
    { value:'iv_cannula',         label:'IV Cannula / Fluid' },
    { value:'nebulization',       label:'Nebulization' },
    // ── Kayachikitsa (Internal Medicine) ──
    { value:'kay_snehapana',      label:'Kayachikitsa — Snehapana (Internal Oleation)' },
    { value:'kay_virechana',      label:'Kayachikitsa — Virechana Karma' },
    // ── Panchakarma ──
    { value:'pk_abhyanga',        label:'Panchakarma — Abhyanga' },
    { value:'pk_shirodhara',      label:'Panchakarma — Shirodhara' },
    { value:'pk_vasti',           label:'Panchakarma — Vasti (generic)' },
    { value:'pk_vasti_anuvasana', label:'Panchakarma — Vasti (Anuvasana)' },
    { value:'pk_vasti_niruha',    label:'Panchakarma — Vasti (Niruha)' },
    { value:'pk_kizhi',           label:'Panchakarma — Kizhi (Pinda Sweda)' },
    { value:'pk_nasya',           label:'Panchakarma — Nasya' },
    { value:'pk_pizhichil',       label:'Panchakarma — Pizhichil' },
    { value:'pk_udvartana',       label:'Panchakarma — Udvartana (Powder Massage)' },
    { value:'pk_shirovasti',      label:'Panchakarma — Shirovasti' },
    { value:'pk_raktamokshana',   label:'Panchakarma — Raktamokshana' },
    { value:'pk_kati_vasti',      label:'Panchakarma — Kati Vasti' },
    { value:'pk_janu_vasti',      label:'Panchakarma — Janu Vasti' },
    { value:'pk_greeva_vasti',    label:'Panchakarma — Greeva Vasti' },
    { value:'pk_matra_basti',     label:'Panchakarma — Matra Basti' },
    // ── Shalya Tantra (Surgery) ──
    { value:'shal_minor_ot',      label:'Shalya Tantra — Minor OT Procedure' },
    { value:'shal_ksharasutra',   label:'Shalya Tantra — Kshara Sutra Application' },
    { value:'shal_kshara_karma',  label:'Shalya Tantra — Kshara Karma' },
    { value:'shal_agnikarma',     label:'Shalya Tantra — Agnikarma' },
    { value:'shal_incision_drainage', label:'Shalya Tantra — Abscess Incision & Drainage' },
    { value:'shal_fistula',       label:'Shalya Tantra — Fistula/Fissure Procedure' },
    { value:'shal_suture_removal',label:'Shalya Tantra — Suture Removal' },
    // ── Shalakya Tantra (Ophthalmology / ENT) ──
    { value:'shak_netra_tarpana', label:'Shalakya — Netra Tarpana' },
    { value:'shak_netra_anjana',  label:'Shalakya — Netra Anjana' },
    { value:'shak_aschyotana',    label:'Shalakya — Aschyotana' },
    { value:'shak_karna_purana',  label:'Shalakya — Karna Purana (Ear Oil Therapy)' },
    { value:'shak_kavala_gandusha', label:'Shalakya — Kavala/Gandusha (Oral)' },
    { value:'shak_pratimarsha_nasya', label:'Shalakya — Pratimarsha Nasya' },
    { value:'shak_fb_removal',    label:'Shalakya — Foreign Body Removal (Eye/Ear/Nose)' },
    // ── Stri Roga & Prasuti Tantra (OBG) ──
    { value:'pst_anc_checkup',    label:'Stri Roga — ANC Checkup' },
    { value:'pst_normal_delivery',label:'Stri Roga & Prasuti — Normal Delivery' },
    { value:'pst_uttar_basti',    label:'Stri Roga — Uttar Basti' },
    { value:'pst_pnc_checkup',    label:'Stri Roga — PNC Checkup' },
    { value:'pst_yoni_prakshalana', label:'Stri Roga — Yoni Prakshalana' },
    // ── Kaumarabhritya (Paediatrics) ──
    { value:'kau_consultation',   label:'Kaumarabhritya — Paediatric Consultation' },
    { value:'kau_swarna_prashan', label:'Kaumarabhritya — Swarna Prashan' },
    { value:'kau_vaccination',    label:'Kaumarabhritya — Vaccination' },
    { value:'kau_growth_monitoring', label:'Kaumarabhritya — Growth Monitoring' },
    // ── Agada Tantra (Toxicology / Medical Jurisprudence) ──
    { value:'agd_poison_mgmt',    label:'Agada Tantra — Poison Management / Emergency' },
    { value:'agd_deaddiction',    label:'Agada Tantra — De-addiction Consultation' },
    { value:'agd_mlc',            label:'Agada Tantra — Medico-Legal Case Charges' },
    // ── Swasthavritta & Yoga ──
    { value:'sw_health_checkup',  label:'Swasthavritta — Health Checkup Package' },
    { value:'sw_yoga_session',    label:'Swasthavritta — Yoga Session' },
    { value:'other_procedure',    label:'Other Procedure' }
  ],
  radiology: [
    { value:'xray',               label:'X-Ray' },
    { value:'ultrasound',         label:'Ultrasound (USG)' },
    { value:'ct_scan',            label:'CT Scan' },
    { value:'mri',                label:'MRI' },
    { value:'ecg',                label:'ECG' },
    { value:'echo',               label:'Echo (2D Echo)' },
    { value:'other_radiology',    label:'Other Radiology' }
  ],
  custom: []
};

// ── Approval text per role ────────────────────────
const APPROVAL_TEXT = {
  accountant:  'Your submission will be sent to the Department Admin for approval before it becomes active.',
  dept_admin:  'Your submission will go to you for approval. You can approve it immediately after saving.',
  super_admin: 'As Super Admin, you can activate this fee immediately or save it as active directly.'
};

// ── Load OPDs ─────────────────────────────────────
async function loadOPDs() {
  const { data } = await supabase
    .from('opds')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');
  _opds = data || [];
  const sel = document.getElementById('m-opd');
  sel.innerHTML = '<option value="">— All OPDs / General —</option>';
  _opds.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.id; opt.textContent = o.name;
    sel.appendChild(opt);
  });
}

// ── Load fees ─────────────────────────────────────
async function loadFees() {
  const { data, error } = await supabase
    .from('fee_structures')
    .select('*, opds(name), creator:created_by(full_name)')
    .eq('tenant_id', tenantId)
    .order('category')
    .order('label');

  if (error) { console.error(error); return; }
  _allFees = data || [];
  updateStats();
  renderTable();
}

function updateStats() {
  const active  = _allFees.filter(f => f.approval_status === 'active').length;
  const pending = _allFees.filter(f => f.approval_status === 'pending').length;
  const dept    = _allFees.filter(f => f.approval_status === 'dept_approved').length;
  document.getElementById('stat-active').textContent  = active;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-dept').textContent    = dept;
  document.getElementById('stat-total').textContent   = _allFees.length;
}

// ── Tab filter ─────────────────────────────────────
window.setTab = function(btn, cat) {
  document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _activeTab = cat;
  renderTable();
};

window.filterFees = function() { renderTable(); };

function renderTable() {
  const q   = document.getElementById('search-input').value.toLowerCase();
  const rows = _allFees.filter(f => {
    if (_activeTab !== 'all' && f.category !== _activeTab) return false;
    if (q && !f.label?.toLowerCase().includes(q) &&
             !f.fee_type?.toLowerCase().includes(q) &&
             !f.notes?.toLowerCase().includes(q)) return false;
    return true;
  });

  const tbody = document.getElementById('fee-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty">
      <div class="empty-icon">📋</div>
      <div class="empty-text">No fees found</div></div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(f => {
    const catCls   = 'cat-' + (f.category || 'custom');
    const catLabel = CAT_LABELS[f.category] || f.category;
    const opdName  = f.opds?.name || '—';
    const amount   = `₹${parseFloat(f.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
    const status   = f.approval_status || 'pending';
    const statusLabel = { pending:'Pending', dept_approved:'Dept. Approved', active:'Active', rejected:'Rejected' }[status] || status;
    const creator  = f.creator?.full_name || '—';

    const actions = buildActions(f);

    return `<tr data-id="${f.id}">
      <td>
        <div class="fee-label">${f.label || '—'}</div>
        ${f.notes ? `<div class="fee-notes">${f.notes}</div>` : ''}
        <div class="fee-notes" style="margin-top:2px;color:var(--text-muted)">By ${creator}</div>
      </td>
      <td><span class="cat-badge ${catCls}">${catLabel}</span></td>
      <td style="color:var(--text-mid);font-size:13px">${opdName}</td>
      <td><span class="fee-amount">${amount}</span></td>
      <td><span class="status-badge status-${status}">${statusLabel}</span></td>
      <td><div class="actions">${actions}</div></td>
    </tr>`;
  }).join('');
}

function buildActions(f) {
  const s   = f.approval_status;
  const own = f.created_by === userId;
  let btns  = '';

  if (role === 'accountant') {
    if (own && s === 'pending') {
      btns += `<button class="act-btn act-edit" data-onclick="openEdit" data-onclick-a0="${f.id}">Edit</button>`;
      btns += `<button class="act-btn act-delete" data-onclick="deleteFee" data-onclick-a0="${f.id}">Delete</button>`;
    }
  }

  if (role === 'dept_admin') {
    if (s === 'pending') {
      btns += `<button class="act-btn act-approve" data-onclick="approveFee" data-onclick-a0="${f.id}">✓ Approve</button>`;
      btns += `<button class="act-btn act-reject"  data-onclick="rejectFee" data-onclick-a0="${f.id}">✗ Reject</button>`;
    }
    if (s === 'dept_approved') {
      btns += `<button class="act-btn act-reject" data-onclick="rejectFee" data-onclick-a0="${f.id}">✗ Reject</button>`;
    }
    if (own && s === 'pending') {
      btns += `<button class="act-btn act-edit" data-onclick="openEdit" data-onclick-a0="${f.id}">Edit</button>`;
    }
  }

  if (role === 'super_admin') {
    btns += `<button class="act-btn act-edit" data-onclick="openEdit" data-onclick-a0="${f.id}">Edit</button>`;
    if (s !== 'active') {
      if (s === 'dept_approved') {
        btns += `<button class="act-btn act-activate" data-onclick="activateFee" data-onclick-a0="${f.id}" data-onclick-a1="@false">⚡ Activate</button>`;
      }
      if (s === 'pending') {
        btns += `<button class="act-btn act-bypass" data-onclick="activateFee" data-onclick-a0="${f.id}" data-onclick-a1="@true">⚡ Bypass &amp; Activate</button>`;
      }
    }
    if (s === 'active') {
      btns += `<button class="act-btn act-reject" data-onclick="deactivateFee" data-onclick-a0="${f.id}">Deactivate</button>`;
    }
    if (s !== 'rejected' && s !== 'active') {
      btns += `<button class="act-btn act-reject" data-onclick="rejectFee" data-onclick-a0="${f.id}">✗ Reject</button>`;
    }
    btns += `<button class="act-btn act-delete" data-onclick="deleteFee" data-onclick-a0="${f.id}">Delete</button>`;
  }

  return btns || '<span style="font-size:12px;color:var(--text-muted)">—</span>';
}

// ── Approval actions ──────────────────────────────
window.approveFee = async function(id) {
  await supabase.from('fee_structures').update({
    approval_status: 'dept_approved',
    approved_by_dept: userId
  }).eq('id', id);
  toast('Fee approved by department.', 'success');
  loadFees();
};

window.activateFee = async function(id, bypass) {
  await supabase.from('fee_structures').update({
    approval_status: 'active',
    is_active: true,
    approved_by_super: userId
  }).eq('id', id);
  toast(bypass ? 'Fee bypassed and activated.' : 'Fee activated.', 'success');
  loadFees();
};

window.deactivateFee = async function(id) {
  await supabase.from('fee_structures').update({
    approval_status: 'pending',
    is_active: false,
    approved_by_super: null
  }).eq('id', id);
  toast('Fee deactivated.', 'success');
  loadFees();
};

window.rejectFee = async function(id) {
  if (!confirm('Reject this fee? It will be marked as rejected.')) return;
  await supabase.from('fee_structures').update({
    approval_status: 'rejected',
    is_active: false
  }).eq('id', id);
  toast('Fee rejected.', 'success');
  loadFees();
};

window.deleteFee = async function(id) {
  if (!confirm('Delete this fee permanently?')) return;
  await supabase.from('fee_structures').delete().eq('id', id);
  toast('Fee deleted.', 'success');
  loadFees();
};

// ── Modal ─────────────────────────────────────────
window.openModal = function() {
  _editId = null;
  document.getElementById('modal-title').textContent = 'Add New Service';
  document.getElementById('m-label').value   = '';
  document.getElementById('m-category').value = '';
  document.getElementById('m-amount').value  = '';
  document.getElementById('m-notes').value   = '';
  document.getElementById('m-opd-wrap').style.display = 'none';
  document.getElementById('m-type-wrap').style.display = 'none';
  document.getElementById('m-approval-note').style.display = 'block';
  document.getElementById('m-approval-text').textContent = APPROVAL_TEXT[role] || '';

  const btnTxt = document.getElementById('btn-save-text');
  btnTxt.textContent = role === 'super_admin' ? 'Save & Activate' : 'Submit for Approval';

  document.getElementById('modal-overlay').classList.add('open');
};

window.openEdit = function(id) {
  const f = _allFees.find(x => x.id === id);
  if (!f) return;
  _editId = id;
  document.getElementById('modal-title').textContent = 'Edit Service';
  document.getElementById('m-label').value    = f.label || '';
  document.getElementById('m-category').value = f.category || '';
  document.getElementById('m-amount').value   = f.amount || '';
  document.getElementById('m-notes').value    = f.notes || '';
  document.getElementById('m-opd').value      = f.opd_id || '';
  onCategoryChange();
  document.getElementById('m-opd').value      = f.opd_id || '';
  // Set fee_type
  const sel = document.getElementById('m-type-select');
  const inp = document.getElementById('m-type-input');
  if (sel.style.display !== 'none') sel.value = f.fee_type || '';
  if (inp.style.display !== 'none') inp.value = f.fee_type || '';

  document.getElementById('m-approval-note').style.display = 'none';
  document.getElementById('btn-save-text').textContent = 'Save Changes';
  document.getElementById('modal-overlay').classList.add('open');
};

window.closeModal = function() {
  document.getElementById('modal-overlay').classList.remove('open');
};

window.onCategoryChange = function() {
  const cat     = document.getElementById('m-category').value;
  const typeWrap = document.getElementById('m-type-wrap');
  const opdWrap  = document.getElementById('m-opd-wrap');
  const sel      = document.getElementById('m-type-select');
  const inp      = document.getElementById('m-type-input');

  if (!cat) { typeWrap.style.display = 'none'; opdWrap.style.display = 'none'; return; }

  typeWrap.style.display = 'block';
  opdWrap.style.display  = cat === 'opd' ? 'block' : 'none';

  const types = CAT_TYPES[cat];
  if (cat === 'custom' || !types || types.length === 0) {
    sel.style.display = 'none';
    inp.style.display = 'block';
    inp.placeholder   = 'Enter service type / name';
  } else {
    inp.style.display = 'none';
    sel.style.display = 'block';
    sel.innerHTML = '<option value="">— Select fee type —</option>' +
      types.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
    sel.onchange = function() {
      const found = types.find(t => t.value === sel.value);
      if (found && !document.getElementById('m-label').value) {
        document.getElementById('m-label').value = found.label;
      }
    };
  }
};

// ── Save fee ──────────────────────────────────────
window.saveFee = async function() {
  const label    = document.getElementById('m-label').value.trim();
  const category = document.getElementById('m-category').value;
  const amount   = parseFloat(document.getElementById('m-amount').value);
  const notes    = document.getElementById('m-notes').value.trim();
  const opdId    = document.getElementById('m-opd').value || null;

  const sel  = document.getElementById('m-type-select');
  const inp  = document.getElementById('m-type-input');
  const feeType = sel.style.display !== 'none' ? sel.value : inp.value.trim();

  if (!label)    { toast('Please enter a service label.', 'error'); return; }
  if (!category) { toast('Please select a category.', 'error'); return; }
  if (isNaN(amount) || amount < 0) { toast('Please enter a valid amount.', 'error'); return; }

  const btn = document.getElementById('btn-save');
  btn.classList.add('loading'); btn.disabled = true;

  const isSuperAdmin = role === 'super_admin';
  const payload = {
    tenant_id:       tenantId,
    label,
    category,
    fee_type:        feeType || category,
    amount,
    notes:           notes || null,
    opd_id:          opdId,
    approval_status: isSuperAdmin ? 'active' : 'pending',
    is_active:       isSuperAdmin,
    created_by:      userId,
    ...(isSuperAdmin ? { approved_by_super: userId } : {})
  };

  let error;
  if (_editId) {
    ({ error } = await supabase.from('fee_structures').update(payload).eq('id', _editId));
  } else {
    ({ error } = await supabase.from('fee_structures').insert(payload));
  }

  btn.classList.remove('loading'); btn.disabled = false;

  if (error) { toast(safeErrorMessage(error, 'Could not save fee.'), 'error'); return; }

  toast(_editId ? 'Fee updated.' : (isSuperAdmin ? 'Fee saved and activated.' : 'Fee submitted for approval.'), 'success');
  closeModal();
  loadFees();
};

// ── Quick Setup ───────────────────────────────────
const QS_TEMPLATES = {
  clinic: [
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:100,  notes:'One-time new patient registration' },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:300  },
    { label:'On-Request Surcharge',      category:'opd', fee_type:'on_request_surcharge', amount:150,  notes:'Extra charge when non-scheduled doctor consulted' },
    { label:'Blood — CBC',               category:'lab', fee_type:'blood_cbc',            amount:250  },
    { label:'Urine — Routine',           category:'lab', fee_type:'urine_routine',        amount:150  },
    { label:'Wound Dressing',            category:'procedure', fee_type:'wound_dressing', amount:200  },
    { label:'Injection (IM/SC)',         category:'procedure', fee_type:'injection',       amount:100  },
  ],
  pk_center: [
    { label:'Initial Assessment',        category:'opd', fee_type:'registration',        amount:500,  notes:'Prakriti assessment and treatment planning' },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:400  },
    { label:'Panchakarma — Abhyanga',    category:'procedure', fee_type:'pk_abhyanga',    amount:1200 },
    { label:'Panchakarma — Shirodhara', category:'procedure', fee_type:'pk_shirodhara',  amount:1500 },
    { label:'Panchakarma — Vasti',       category:'procedure', fee_type:'pk_vasti',       amount:2000 },
    { label:'Panchakarma — Kizhi',       category:'procedure', fee_type:'pk_kizhi',       amount:1800 },
    { label:'Panchakarma — Nasya',       category:'procedure', fee_type:'pk_nasya',       amount:1000 },
    { label:'Panchakarma — Pizhichil',   category:'procedure', fee_type:'pk_pizhichil',   amount:3500 },
  ],
  // Comprehensive NCISM department-wise catalog (Session 106) -- covers all 7 mandatory
  // clinical departments (Kayachikitsa, Panchakarma, Shalya Tantra, Shalakya Tantra, Stri
  // Roga & Prasuti Tantra, Kaumarabhritya, Agada Tantra) plus Swasthavritta/Yoga and the
  // department-agnostic OPD/IPD/Lab/Radiology basics. Amounts are a reasonable STARTING
  // baseline, not SDM's real confirmed pricing -- every item is editable after Quick Setup
  // runs (amount, label, or delete), same as any other fee.
  hospital: [
    // ── OPD (general) ──
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:200  },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:500  },
    { label:'Follow-up Consultation',    category:'opd', fee_type:'consultation',         amount:200,  notes:'Within 7 days of previous visit' },
    { label:'Senior / Specialist Consultation', category:'opd', fee_type:'consultation',  amount:700  },
    { label:'On-Request Surcharge',      category:'opd', fee_type:'on_request_surcharge', amount:200  },
    { label:'Teleconsultation',          category:'opd', fee_type:'consultation',         amount:300  },

    // ── IPD (facility / room) ──
    { label:'Admission Charge',          category:'ipd', fee_type:'admission',            amount:1000 },
    { label:'Room — General Ward',       category:'ipd', fee_type:'room_general',         amount:800,  notes:'Per day' },
    { label:'Room — Semi-Private',       category:'ipd', fee_type:'room_semi_private',    amount:1500, notes:'Per day' },
    { label:'Room — Private',            category:'ipd', fee_type:'room_private',         amount:2500, notes:'Per day' },
    { label:'Room — ICU / HDU',          category:'ipd', fee_type:'room_icu',             amount:4000, notes:'Per day' },
    { label:'Nursing Care',              category:'ipd', fee_type:'nursing',              amount:500,  notes:'Per day' },
    { label:'Attendant Bed',             category:'ipd', fee_type:'attendant_bed',        amount:200,  notes:'Per night' },

    // ── Lab ──
    { label:'Blood — CBC',               category:'lab', fee_type:'blood_cbc',            amount:300  },
    { label:'Blood — LFT',               category:'lab', fee_type:'blood_lft',            amount:600  },
    { label:'Blood — RFT',               category:'lab', fee_type:'blood_rft',            amount:500  },
    { label:'Blood — Lipid Profile',     category:'lab', fee_type:'blood_lipid',          amount:600  },
    { label:'Blood — Thyroid (T3/T4/TSH)', category:'lab', fee_type:'blood_thyroid',      amount:700  },
    { label:'Blood Sugar — Fasting',     category:'lab', fee_type:'blood_sugar_fasting',  amount:150  },
    { label:'Blood Sugar — PP',          category:'lab', fee_type:'blood_sugar_pp',       amount:150  },
    { label:'Urine — Routine',           category:'lab', fee_type:'urine_routine',        amount:200  },
    { label:'Stool — Routine',           category:'lab', fee_type:'stool_routine',        amount:150  },
    { label:'Culture & Sensitivity',     category:'lab', fee_type:'culture_sensitivity',  amount:800  },
    { label:'Biopsy',                    category:'lab', fee_type:'biopsy',               amount:1500 },

    // ── Radiology ──
    { label:'X-Ray',                     category:'radiology', fee_type:'xray',           amount:400  },
    { label:'Ultrasound (USG)',          category:'radiology', fee_type:'ultrasound',      amount:800  },
    { label:'CT Scan',                   category:'radiology', fee_type:'ct_scan',         amount:3500 },
    { label:'MRI',                       category:'radiology', fee_type:'mri',             amount:6000 },
    { label:'ECG',                       category:'radiology', fee_type:'ecg',             amount:300  },
    { label:'Echo (2D Echo)',            category:'radiology', fee_type:'echo',            amount:1200 },

    // ── Procedures — General / Nursing ──
    { label:'Wound Dressing',            category:'procedure', fee_type:'wound_dressing', amount:200  },
    { label:'Injection (IM/SC)',         category:'procedure', fee_type:'injection',       amount:100  },
    { label:'IV Cannula / Fluid',        category:'procedure', fee_type:'iv_cannula',      amount:300  },
    { label:'Nebulization',              category:'procedure', fee_type:'nebulization',    amount:150  },
    { label:'Physiotherapy Session',     category:'procedure', fee_type:'physiotherapy',   amount:300  },

    // ── Kayachikitsa (Internal Medicine) ──
    { label:'Kayachikitsa — Snehapana (Internal Oleation)', category:'procedure', fee_type:'kay_snehapana', amount:600 },
    { label:'Kayachikitsa — Virechana Karma', category:'procedure', fee_type:'kay_virechana', amount:2000 },

    // ── Panchakarma ──
    { label:'Panchakarma — Abhyanga',        category:'procedure', fee_type:'pk_abhyanga',    amount:1200 },
    { label:'Panchakarma — Shirodhara',      category:'procedure', fee_type:'pk_shirodhara',  amount:1500 },
    { label:'Panchakarma — Vasti (Anuvasana)', category:'procedure', fee_type:'pk_vasti_anuvasana', amount:1500 },
    { label:'Panchakarma — Vasti (Niruha)',  category:'procedure', fee_type:'pk_vasti_niruha', amount:1800 },
    { label:'Panchakarma — Kizhi (Pinda Sweda)', category:'procedure', fee_type:'pk_kizhi',   amount:1800 },
    { label:'Panchakarma — Nasya',           category:'procedure', fee_type:'pk_nasya',       amount:1000 },
    { label:'Panchakarma — Pizhichil',       category:'procedure', fee_type:'pk_pizhichil',   amount:3500 },
    { label:'Panchakarma — Udvartana (Powder Massage)', category:'procedure', fee_type:'pk_udvartana', amount:1000 },
    { label:'Panchakarma — Shirovasti',      category:'procedure', fee_type:'pk_shirovasti',  amount:2000 },
    { label:'Panchakarma — Raktamokshana',   category:'procedure', fee_type:'pk_raktamokshana', amount:1500 },
    { label:'Panchakarma — Kati Vasti',      category:'procedure', fee_type:'pk_kati_vasti',  amount:800  },
    { label:'Panchakarma — Janu Vasti',      category:'procedure', fee_type:'pk_janu_vasti',  amount:800  },
    { label:'Panchakarma — Greeva Vasti',    category:'procedure', fee_type:'pk_greeva_vasti', amount:800 },
    { label:'Panchakarma — Matra Basti',     category:'procedure', fee_type:'pk_matra_basti', amount:800  },

    // ── Shalya Tantra (Surgery) ──
    { label:'Shalya Tantra — Minor OT Procedure', category:'procedure', fee_type:'shal_minor_ot', amount:3000 },
    { label:'Shalya Tantra — Kshara Sutra Application', category:'procedure', fee_type:'shal_ksharasutra', amount:1500 },
    { label:'Shalya Tantra — Kshara Karma',  category:'procedure', fee_type:'shal_kshara_karma', amount:1200 },
    { label:'Shalya Tantra — Agnikarma',     category:'procedure', fee_type:'shal_agnikarma', amount:800  },
    { label:'Shalya Tantra — Abscess Incision & Drainage', category:'procedure', fee_type:'shal_incision_drainage', amount:1000 },
    { label:'Shalya Tantra — Fistula/Fissure Procedure', category:'procedure', fee_type:'shal_fistula', amount:5000 },
    { label:'Shalya Tantra — Suture Removal', category:'procedure', fee_type:'shal_suture_removal', amount:200 },

    // ── Shalakya Tantra (Ophthalmology / ENT) ──
    { label:'Shalakya — Netra Tarpana',      category:'procedure', fee_type:'shak_netra_tarpana', amount:1200 },
    { label:'Shalakya — Netra Anjana',       category:'procedure', fee_type:'shak_netra_anjana', amount:500  },
    { label:'Shalakya — Aschyotana',         category:'procedure', fee_type:'shak_aschyotana', amount:400  },
    { label:'Shalakya — Karna Purana (Ear Oil Therapy)', category:'procedure', fee_type:'shak_karna_purana', amount:500 },
    { label:'Shalakya — Kavala/Gandusha (Oral)', category:'procedure', fee_type:'shak_kavala_gandusha', amount:400 },
    { label:'Shalakya — Pratimarsha Nasya',  category:'procedure', fee_type:'shak_pratimarsha_nasya', amount:300 },
    { label:'Shalakya — Foreign Body Removal (Eye/Ear/Nose)', category:'procedure', fee_type:'shak_fb_removal', amount:500 },

    // ── Stri Roga & Prasuti Tantra (OBG) ──
    { label:'Stri Roga — ANC Checkup',       category:'procedure', fee_type:'pst_anc_checkup', amount:300  },
    { label:'Stri Roga & Prasuti — Normal Delivery', category:'procedure', fee_type:'pst_normal_delivery', amount:8000 },
    { label:'Stri Roga — Uttar Basti',       category:'procedure', fee_type:'pst_uttar_basti', amount:1500 },
    { label:'Stri Roga — PNC Checkup',       category:'procedure', fee_type:'pst_pnc_checkup', amount:300  },
    { label:'Stri Roga — Yoni Prakshalana',  category:'procedure', fee_type:'pst_yoni_prakshalana', amount:500 },

    // ── Kaumarabhritya (Paediatrics) ──
    { label:'Kaumarabhritya — Paediatric Consultation', category:'procedure', fee_type:'kau_consultation', amount:400 },
    { label:'Kaumarabhritya — Swarna Prashan', category:'procedure', fee_type:'kau_swarna_prashan', amount:200 },
    { label:'Kaumarabhritya — Vaccination',  category:'procedure', fee_type:'kau_vaccination', amount:500  },
    { label:'Kaumarabhritya — Growth Monitoring', category:'procedure', fee_type:'kau_growth_monitoring', amount:200 },

    // ── Agada Tantra (Toxicology / Medical Jurisprudence) ──
    { label:'Agada Tantra — Poison Management / Emergency', category:'procedure', fee_type:'agd_poison_mgmt', amount:1500 },
    { label:'Agada Tantra — De-addiction Consultation', category:'procedure', fee_type:'agd_deaddiction', amount:500 },
    { label:'Agada Tantra — Medico-Legal Case Charges', category:'procedure', fee_type:'agd_mlc', amount:1000 },

    // ── Swasthavritta & Yoga ──
    { label:'Swasthavritta — Health Checkup Package', category:'procedure', fee_type:'sw_health_checkup', amount:2000 },
    { label:'Swasthavritta — Yoga Session',  category:'procedure', fee_type:'sw_yoga_session', amount:200  },
  ],
  dispensary: [
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:50   },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:150  },
  ],
  college: [
    { label:'Registration Fee',          category:'opd', fee_type:'registration',        amount:100  },
    { label:'OPD Consultation',          category:'opd', fee_type:'consultation',         amount:200,  notes:'Student OPD consultation' },
    { label:'Blood — CBC',               category:'lab', fee_type:'blood_cbc',            amount:200  },
    { label:'Urine — Routine',           category:'lab', fee_type:'urine_routine',        amount:100  },
    { label:'X-Ray',                     category:'radiology', fee_type:'xray',           amount:300  },
    { label:'Panchakarma — Abhyanga',    category:'procedure', fee_type:'pk_abhyanga',    amount:800  },
    { label:'Panchakarma — Shirodhara', category:'procedure', fee_type:'pk_shirodhara',  amount:1000 },
  ],
};
// teaching_hospital runs a full IPD Setup exactly like a plain hospital (SDM: 100 real
// beds) -- not the smaller college template, which has no IPD charges at all. Reuses the
// same array reference deliberately (Session 105: both dictionaries here were missing a
// teaching_hospital key entirely, so Quick Setup silently did nothing for SDM -- see
// openQuickSetup()'s "No quick-setup template for this facility type" early return).
QS_TEMPLATES.teaching_hospital = QS_TEMPLATES.hospital;
QS_TEMPLATES.pharma     = [];
QS_TEMPLATES.supplier   = [];
QS_TEMPLATES.dealer     = [];

const CAT_LABEL_MAP = { opd:'OPD', ipd:'IPD', lab:'Lab', procedure:'Procedure', radiology:'Radiology', custom:'Custom' };

window.openQuickSetup = function() {
  const tpl = QS_TEMPLATES[facType] || [];
  if (!tpl.length) { toast('No quick-setup template for this facility type.', 'error'); return; }

  document.getElementById('qs-title').textContent = `Quick Setup — ${fac.icon} ${fac.label}`;
  document.getElementById('qs-note').textContent  =
    `Select the services you offer. Suggested default fees are shown — you can edit amounts after saving.`;

  const grid = document.getElementById('qs-grid');
  grid.innerHTML = tpl.map((t, i) => `
    <label class="qs-item" for="qs-${i}">
      <input type="checkbox" id="qs-${i}" value="${i}" checked/>
      <div class="qs-item-info">
        <div class="qs-item-name">${t.label}</div>
        <div class="qs-item-cat">${CAT_LABEL_MAP[t.category] || t.category}</div>
      </div>
      <div class="qs-item-amt">₹${t.amount}</div>
    </label>`).join('');

  document.getElementById('qs-overlay').classList.add('open');
};

window.closeQuickSetup = function() {
  document.getElementById('qs-overlay').classList.remove('open');
};

window.runQuickSetup = async function() {
  const tpl      = QS_TEMPLATES[facType] || [];
  const checked  = [...document.querySelectorAll('#qs-grid input[type=checkbox]:checked')];
  const selected = checked.map(cb => tpl[parseInt(cb.value)]).filter(Boolean);

  if (!selected.length) { toast('Select at least one service.', 'error'); return; }

  const btn = document.getElementById('btn-qs-save');
  btn.classList.add('loading'); btn.disabled = true;

  const isSA = role === 'super_admin';
  const rows = selected.map(t => ({
    tenant_id:       tenantId,
    label:           t.label,
    category:        t.category,
    fee_type:        t.fee_type,
    amount:          t.amount,
    notes:           t.notes || null,
    opd_id:          null,
    approval_status: isSA ? 'active' : 'pending',
    is_active:       isSA,
    created_by:      userId,
    ...(isSA ? { approved_by_super: userId } : {})
  }));

  const { error } = await supabase.from('fee_structures').insert(rows);

  btn.classList.remove('loading'); btn.disabled = false;

  if (error) { toast(safeErrorMessage(error, 'Could not add services.'), 'error'); return; }

  toast(`${selected.length} service${selected.length > 1 ? 's' : ''} added successfully.`, 'success');
  closeQuickSetup();
  loadFees();
};

// ── Toast ─────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Boot ──────────────────────────────────────────
window.toast = toast;
await loadOPDs();
await loadFees();
