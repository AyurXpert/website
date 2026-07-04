import { requireAuth, getCurrentProfile, getCurrentTenantId } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { createPatient } from '../modules/patient/patientService.js';
import { logAudit } from '../core/auditLogger.js';
import { escapeHtml as _esc } from '../utils/validators.js';
import { safeErrorMessage } from '../utils/errors.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import {
  requestABHAOtp, enrollABHA,
  checkAndGenerateMobileOTP, verifyCommMobileOtp, finalizeAbhaEnrollment,
  getAbhaSuggestions, setAbhaAddress, downloadAbhaCard,
  requestABHALoginOtp, verifyABHALogin,
  requestAadhaarLoginOtp, verifyAadhaarLogin,
  sendMobileLoginOtp, verifyMobileLoginOtp,
  requestUpdateMobileOtp, verifyUpdateMobileOtp,
  searchAbhaAddress, initAbhaAddressLogin, verifyAbhaAddressOtp,
  sbxLoginOtp, sbxLoginVerify, sbxDeleteAbhaOtp, sbxDeleteAbhaConfirm,
  deactivateAbhaOtp, deactivateAbhaConfirm,
  reactivateAbhaOtp, reactivateAbhaVerify,
  reKycAbhaOtp, reKycAbhaVerify,
  getAbhaProfileFull, loginVerifyUser, getAbhaQrCode,
} from '../modules/abdm/abdmService.js';
window._sbxLoginOtp = sbxLoginOtp; window._sbxLoginVerify = sbxLoginVerify;
window._sbxDeleteAbhaOtp = sbxDeleteAbhaOtp; window._sbxDeleteAbhaConfirm = sbxDeleteAbhaConfirm;
window._deactivateAbhaOtp = deactivateAbhaOtp; window._deactivateAbhaConfirm = deactivateAbhaConfirm;
window._reactivateAbhaOtp = reactivateAbhaOtp; window._reactivateAbhaVerify = reactivateAbhaVerify;
window._reKycAbhaOtp = reKycAbhaOtp; window._reKycAbhaVerify = reKycAbhaVerify;
window._getAbhaProfileFull = getAbhaProfileFull;
window._loginVerifyUser = loginVerifyUser;
window._getAbhaQrCode = getAbhaQrCode;

await requireAuth(['receptionist', 'nurse', 'super_admin', 'dept_admin', 'doctor']);
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenantId = getCurrentTenantId();
const _ctx     = { tenantId, userId: profile.id, userName: profile.full_name };

// ── Date label ────────────────────────────────────
document.getElementById('queue-date').textContent = new Date().toLocaleDateString('en-IN', {
  weekday: 'long', day: 'numeric', month: 'long'
});

// ── Prevent default submit on the ABHA enroll/verify forms (no server-side form action) ─
document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => e.preventDefault()));

// ── Fee state ─────────────────────────────────────
let _surchargeDefault = 0;
let _patient = null;
let _currentVisitId = null;  // last visit created in this session (for ABDM link token)
let _activePackage = null;
let _screeningOpdId = null;
let _prevOpdId      = null;  // last specialty OPD of returning patient
let _prevDoctorId   = null;  // last doctor of returning patient
let _kaumarOpdId    = null;
const _doctorMap = {};

// ── Verhoeff checksum validation for Aadhaar ─────
function _verhoeff(num) {
  const d=[[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const p=[[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  const n=String(num).split('').reverse().map(Number);
  let c=0;
  for(let i=0;i<n.length;i++) c=d[c][p[i%8][n[i]]];
  return c===0;
}

// ── Jaro similarity for name matching ────────────
function _jaro(s1, s2) {
  if(s1===s2) return 1;
  const l1=s1.length, l2=s2.length;
  if(!l1||!l2) return 0;
  const m=Math.floor(Math.max(l1,l2)/2)-1;
  const f=new Array(l1).fill(false), g=new Array(l2).fill(false);
  let matches=0;
  for(let i=0;i<l1;i++){
    const lo=Math.max(0,i-m), hi=Math.min(l2-1,i+m);
    for(let j=lo;j<=hi;j++) if(!g[j]&&s1[i]===s2[j]){f[i]=g[j]=true;matches++;break;}
  }
  if(!matches) return 0;
  let t=0,k=0;
  for(let i=0;i<l1;i++){if(!f[i])continue;while(!g[k])k++;if(s1[i]!==s2[k++])t++;}
  return(matches/l1+matches/l2+(matches-t/2)/matches)/3;
}

// ── Demographic helpers ────────────────────────────
function _normGender(g) {
  if (!g) return null;
  const map = { M:'male', F:'female', O:'other', m:'male', f:'female', o:'other',
                male:'male', female:'female', other:'other' };
  return map[String(g)] ?? map[String(g).toLowerCase()] ?? null;
}
function _parseDobStr(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{4}$/.test(s)) return new Date(parseInt(s), 0, 1);
  const p = s.split('-');
  if (p.length !== 3) return null;
  return p[0].length === 4 ? new Date(s) : new Date(`${p[2]}-${p[1]}-${p[0]}`);
}
function _ageYears(d) {
  if (!d || isNaN(d)) return null;
  const t = new Date(); let a = t.getFullYear() - d.getFullYear();
  if (t.getMonth() < d.getMonth() || (t.getMonth() === d.getMonth() && t.getDate() < d.getDate())) a--;
  return a;
}

// ── Demographic match check for returning patients (ABDM M1 mandatory) ─
function _checkDemographicMatch(abhaProf) {
  _demogMatchResult = null;
  const warn = document.getElementById('demog-warn');
  if (!_patient?.id) { warn.className = 'demog-warn'; return; }

  // Mobile (exact last-10-digit match)
  const abhaPhone = String(abhaProf?.mobile ?? abhaProf?.mobileNumber ?? '').replace(/\D/g,'').slice(-10);
  const patPhone  = String(_patient.phone ?? '').replace(/\D/g,'').slice(-10);
  const mSt = (!abhaPhone || !patPhone) ? 'unknown' : (abhaPhone === patPhone ? 'pass' : 'fail');

  // Name (Jaro ≥ 0.80 = pass, 0.65–0.79 = warn, <0.65 = fail)
  const abhaName = [abhaProf?.firstName, abhaProf?.middleName, abhaProf?.lastName]
    .filter(Boolean).join(' ').trim().toLowerCase();
  const patName = (_patient.name || '').trim().toLowerCase();
  const jr = (abhaName && patName) ? _jaro(abhaName, patName) : -1;
  const nSt = jr < 0 ? 'unknown' : jr >= 0.80 ? 'pass' : jr >= 0.65 ? 'warn' : 'fail';

  // Gender (exact after normalise)
  const abhaG = _normGender(abhaProf?.gender);
  const patG  = _normGender(_patient.gender);
  const gSt = (!abhaG || !patG) ? 'unknown' : (abhaG === patG ? 'pass' : 'fail');

  // Age (±2 years)
  const _abhadobCombined = (abhaProf?.dayOfBirth && abhaProf?.monthOfBirth && abhaProf?.yearOfBirth)
    ? `${abhaProf.dayOfBirth}-${abhaProf.monthOfBirth}-${abhaProf.yearOfBirth}` : null;
  const abhaAge = _ageYears(_parseDobStr(_abhadobCombined ?? abhaProf?.dob ?? abhaProf?.dateOfBirth ?? abhaProf?.yearOfBirth));
  const patAge  = _ageYears(_parseDobStr(_patient.date_of_birth)) ?? (_patient.age != null ? Number(_patient.age) : null);
  const aSt = (abhaAge === null || patAge === null) ? 'unknown'
    : (Math.abs(abhaAge - patAge) <= 2 ? 'pass' : 'fail');

  const hasFail = [mSt, nSt, gSt, aSt].includes('fail');
  _demogMatchResult = { pass: !hasFail, mobileMismatch: mSt === 'fail' };

  const ico = s => ({ pass:'✅', warn:'⚠️', fail:'❌', unknown:'➖' }[s] ?? '➖');
  const rows = [
    ['Mobile', mSt,  abhaPhone ? `ABHA: ${abhaPhone} · Patient: ${patPhone || '?'}` : 'ABHA mobile not returned'],
    ['Name',   nSt,  abhaName  ? `${abhaName} (${jr >= 0 ? Math.round(jr*100) + '%' : '?'} match)` : '—'],
    ['Gender', gSt,  abhaG     ? `ABHA: ${abhaG} · Patient: ${patG || '?'}` : '—'],
    ['Age',    aSt,  abhaAge !== null ? `ABHA: ${abhaAge} yrs · Patient: ${patAge ?? '?'} yrs` : '—'],
  ].map(([f, s, d]) => `<span class="dm-row">${ico(s)} <b>${f}:</b> ${d}</span>`).join('');

  warn.innerHTML = hasFail
    ? `<strong>⚠ Demographic Mismatch</strong> — Verify patient identity before linking ABHA.<div class="dm-rows">${rows}</div>`
    : `<strong>✅ Demographics Verified</strong><div class="dm-rows">${rows}</div>`;
  warn.className = `demog-warn show${hasFail ? '' : ' pass'}`;
}

// ── Link ABHA to existing patient with demographic gate ────────
async function _linkAbha(prof, fmt, visitId = null, skipGate = false) {
  if (!_patient?.id) return;
  if (!skipGate && _demogMatchResult && !_demogMatchResult.pass) {
    const msg = _demogMatchResult.mobileMismatch
      ? `Mobile number mismatch: the ABHA's registered mobile does not match this patient's record.\n\nOnly link if you have verified identity with a government photo ID.\n\nLink ABHA ${fmt} to ${_patient.name}?`
      : `Demographic mismatch detected for ABHA ${fmt}.\n\nSome fields (name, gender, or age) do not fully match.\n\nVerify patient identity and confirm to proceed.\n\nLink ABHA ${fmt} to ${_patient.name}?`;
    if (!confirm(msg)) return;
  }
  await supabase.from('patients').update({ abha_number: fmt }).eq('id', _patient.id);
  // Backfill missing demographics from ABHA profile
  const gMap = { M:'male', F:'female', O:'other', male:'male', female:'female', other:'other' };
  const upd = {};
  const abhaG = gMap[prof?.gender] ?? null;
  if (abhaG && !_patient.gender) upd.gender = abhaG;
  const rawDob = prof?.dob ?? prof?.dateOfBirth;
  if (rawDob && !_patient.date_of_birth) {
    const p = String(rawDob).split('-');
    upd.date_of_birth = p[0].length === 4 ? rawDob : `${p[2]}-${p[1]}-${p[0]}`;
  }
  if (Object.keys(upd).length > 0)
    await supabase.from('patients').update(upd).eq('id', _patient.id);
  if (visitId) _abdmLinkTokenAfterVerify(_patient.id, fmt, visitId).catch(() => {});
}

// ── Last tToken (for ABHA card download) + txnId (for suggestions / address) ─────────
let _lastTToken      = null;
let _lastEnrollTxnId = null;
let _updMobTxnId     = null;
let _demogMatchResult = null; // { pass, mobileMismatch } — set by _checkDemographicMatch

// ── Consent Modal ─────────────────────────────────
let _consentPendingOtp = false; // resolved once consent agreed

function _showConsentModal() {
  return new Promise((resolve, reject) => {
    const overlay = document.getElementById('consent-overlay');
    const agree   = document.getElementById('btn-consent-agree');
    const cancel  = document.getElementById('btn-consent-cancel');

    // Fill dynamic names
    const patName   = document.getElementById('name').value.trim() || 'the patient';
    const staffName = profile.full_name || 'the healthcare worker';
    document.getElementById('cc6-staff').textContent   = staffName;
    document.getElementById('cc7-patient').textContent = patName;

    // Reset required checkboxes
    document.getElementById('cc6').checked = false;
    document.getElementById('cc7').checked = false;
    agree.disabled = true;
    overlay.style.display = 'flex';

    function updateAgree() {
      agree.disabled = !(document.getElementById('cc6').checked && document.getElementById('cc7').checked);
    }
    document.getElementById('cc6').addEventListener('change', updateAgree);
    document.getElementById('cc7').addEventListener('change', updateAgree);
    document.getElementById('cc6-wrap').addEventListener('click', updateAgree);
    document.getElementById('cc7-wrap').addEventListener('click', updateAgree);

    agree.onclick = () => {
      overlay.style.display = 'none';
      resolve(true);
    };
    cancel.onclick = () => {
      overlay.style.display = 'none';
      reject(new Error('Consent declined'));
    };
  });
}

// ── UHID formatter ────────────────────────────────
function _uhid(uuid) {
  const suffix = (uuid || '').replace(/-/g, '').slice(-6).toUpperCase();
  return `AYX-${new Date().getFullYear()}-${suffix}`;
}

// ── Wait time formatter ───────────────────────────
function _waitTime(createdAt) {
  const mins = Math.floor((Date.now() - new Date(createdAt)) / 60000);
  if (mins < 1) return 'Just arrived';
  if (mins < 60) return `${mins} min wait`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m wait`;
}

// ── Load OPDs ─────────────────────────────────────
async function loadOPDs() {
  const { data } = await supabase
    .from('opds')
    .select('id, name, ncism_code')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('name');

  const sel = document.getElementById('opd');
  _screeningOpdId = null;
  _kaumarOpdId    = null;

  (data || []).forEach(o => {
    if (!_screeningOpdId && (
      o.ncism_code?.toUpperCase() === 'SCR' ||
      o.name?.toLowerCase().includes('screening')
    )) {
      _screeningOpdId = o.id;
    }
    if (!_kaumarOpdId && (
      o.ncism_code?.toUpperCase() === 'KAU' ||
      o.name?.toLowerCase().includes('kaumar')
    )) {
      _kaumarOpdId = o.id;
    }
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    sel.appendChild(opt);
  });

  _applyOpdRule();
}

// ── Load doctors (OPD-filtered) ───────────────────
async function loadDoctors(opdId) {
  const sel = document.getElementById('doctor');
  sel.innerHTML = '<option value="">— No preference —</option>';

  let doctorIds = null;
  if (opdId) {
    const { data: opdDocs } = await supabase
      .from('opd_doctors')
      .select('doctor_id')
      .eq('opd_id', opdId)
      .eq('tenant_id', tenantId)
      .eq('is_active_today', true);

    doctorIds = (opdDocs || []).map(d => d.doctor_id);
    if (doctorIds.length === 0) {
      sel.innerHTML = '<option value="">— No doctors active today —</option>';
      return;
    }
  }

  let query = supabase
    .from('profiles')
    .select('id, full_name')
    .eq('tenant_id', tenantId)
    .eq('role', 'doctor')
    .eq('status', 'active')
    .order('full_name');

  if (doctorIds) query = query.in('id', doctorIds);

  const { data } = await query;
  (data || []).forEach(d => {
    _doctorMap[d.id] = d.full_name || 'Doctor';
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.full_name || 'Doctor';
    sel.appendChild(o);
  });
  if (data && data.length === 1) sel.value = data[0].id;
}

// ── Load fee structures ───────────────────────────
async function loadFees(opdId) {
  document.getElementById('reg-fee').value = '';
  document.getElementById('fee').value = '';
  _surchargeDefault = 0;

  if (opdId) {
    const { data } = await supabase
      .from('fee_structures')
      .select('category, amount')
      .eq('tenant_id', tenantId)
      .eq('opd_id', opdId)
      .eq('approval_status', 'active')
      .eq('is_active', true);

    (data || []).forEach(f => {
      if (f.category === 'registration') document.getElementById('reg-fee').value = f.amount;
      if (f.category === 'consultation')  document.getElementById('fee').value = f.amount;
      if (f.category === 'on_request') {
        _surchargeDefault = parseFloat(f.amount) || 0;
        document.getElementById('surcharge').value = _surchargeDefault;
      }
    });
  }

  if (_patient) document.getElementById('reg-fee').value = '0';
  _updateTotal();
}

// ── OPD routing rule ──────────────────────────────
// Walk-in OPD patients must go to Screening OPD first (NCISM Section 40)
function _applyOpdRule() {
  const sel    = document.getElementById('opd');
  const docSel = document.getElementById('doctor');
  const cat    = document.getElementById('visit-category').value;
  const hint   = document.getElementById('opd-routing-hint');

  // OPD/Department is ALWAYS locked at reception.
  // Specialty OPD is assigned only at Screening OPD (screening.html).
  // Reception only shows what was determined:
  //   followup + returning patient → previous specialty OPD + doctor (locked)
  //   all other categories         → Screening OPD (locked), doctor selectable

  sel.disabled = true;

  if (cat === 'followup' && _prevOpdId) {
    // Returning patient follow-up — lock to previous specialty OPD + doctor
    sel.value       = _prevOpdId;
    docSel.disabled = true;
    if (_prevDoctorId) docSel.value = _prevDoctorId;
    if (hint) hint.style.display = ''; // hint set by _selectPatient
  } else {
    // New visit / new complaint / emergency / any other category → Screening OPD
    docSel.disabled = false;
    if (_screeningOpdId) {
      sel.value = _screeningOpdId;
      loadDoctors(_screeningOpdId);
      loadFees(_screeningOpdId);
      if (hint) {
        hint.textContent = '🔒 OPD assigned at Screening OPD — not selectable here';
        hint.style.color   = 'var(--text-muted)';
        hint.style.display = '';
      }
    } else {
      if (hint) {
        hint.textContent = '⚠ Screening OPD not configured — contact admin';
        hint.style.color   = 'var(--gold)';
        hint.style.display = '';
      }
    }
  }
}

// ── Visit category change ─────────────────────────
document.getElementById('visit-category').addEventListener('change', _applyOpdRule);

// ── OPD change ────────────────────────────────────
document.getElementById('opd').addEventListener('change', async function() {
  await Promise.all([loadDoctors(this.value), loadFees(this.value)]);
});

// ── On-request toggle ─────────────────────────────
const onRequestChk  = document.getElementById('on-request');
const onRequestWrap = document.getElementById('on-request-wrap');
const surchargeRow  = document.getElementById('surcharge-row');

onRequestWrap.addEventListener('click', function(e) {
  if (e.target !== onRequestChk) onRequestChk.checked = !onRequestChk.checked;
  const on = onRequestChk.checked;
  onRequestWrap.classList.toggle('active', on);
  surchargeRow.style.display = on ? '' : 'none';
  document.getElementById('surcharge').value = on ? (_surchargeDefault || '') : '';
  _updateTotal();
  _applyOpdRule();
});

// ── Total ─────────────────────────────────────────
function _updateTotal() {
  const reg   = parseFloat(document.getElementById('reg-fee').value)  || 0;
  const cons  = parseFloat(document.getElementById('fee').value)       || 0;
  const sur   = onRequestChk.checked ? (parseFloat(document.getElementById('surcharge').value) || 0) : 0;
  const total = reg + cons + sur;
  document.getElementById('fee-total').textContent =
    '₹' + total.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
['reg-fee', 'fee', 'surcharge'].forEach(id =>
  document.getElementById(id).addEventListener('input', () => { _updateTotal(); })
);

// ── Payer type toggle ──────────────────────────────
window.onPayerTypeChange = function() {
  const pt = document.querySelector('input[name="payer_type"]:checked')?.value || 'self_pay';
  const isIns = pt !== 'self_pay';
  document.getElementById('ins-note').style.display = isIns ? '' : 'none';
  if (isIns) {
    document.getElementById('payment-mode').value = 'credit';
    document.getElementById('pay-pending').checked = true;
  }
};

// ── DOB → Age auto-calculator ─────────────────────
document.getElementById('f-dob').addEventListener('change', function() {
  _calcAgeFromDob(this.value);
});

function _ageFromDob(dob) {
  if (!dob) return null;
  const today = new Date(), birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() ||
     (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age--;
  return age;
}

// ── Patient search (phone / name / UHID) ──────────
let _phoneTimer = null;
let _newFamilyMember = false;
document.getElementById('phone').addEventListener('input', function() {
  clearTimeout(_phoneTimer);
  const val = this.value.trim();
  if (!val) { _clearTag(); return; }
  const isUhid  = val.toUpperCase().startsWith('AYX-');
  const isPhone = /^[+\d\s\-]{6,}$/.test(val) && !isUhid;
  const isName  = !isPhone && !isUhid && val.length >= 3;
  if (isPhone)     _phoneTimer = setTimeout(() => _searchPhone(val), 350);
  else if (isUhid && val.length >= 10) _phoneTimer = setTimeout(() => _searchUhid(val), 350);
  else if (isName) _phoneTimer = setTimeout(() => _searchName(val), 350);
  else _clearTag();
});

async function _searchPhone(phone) {
  _newFamilyMember = false;
  const { data } = await supabase
    .from('patients')
    .select('id, name, abha_number, age, gender, date_of_birth, blood_group, phone, prakriti_data, prakriti_assessed_at')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .limit(6);

  if (!data || data.length === 0) {
    _clearTag();
    const opdId = document.getElementById('opd').value;
    if (opdId) await loadFees(opdId);
    return;
  }
  if (data.length === 1) await _selectPatient(data[0]);
  else _showPicker(data, phone);
}

async function _searchName(query) {
  _newFamilyMember = false;
  const { data } = await supabase
    .from('patients')
    .select('id, name, abha_number, age, gender, date_of_birth, blood_group, phone, prakriti_data, prakriti_assessed_at')
    .eq('tenant_id', tenantId)
    .ilike('name', `%${query}%`)
    .limit(8);

  if (!data || data.length === 0) { _clearTag(); return; }
  if (data.length === 1) await _selectPatient(data[0]);
  else _showPicker(data, query);
}

async function _searchUhid(uhid) {
  _newFamilyMember = false;
  const suffix = uhid.replace(/-/g,'').slice(-6).toLowerCase();
  const { data } = await supabase
    .rpc('search_patient_by_uhid', { p_tenant_id: tenantId, p_uhid_suffix: suffix });

  if (!data || data.length === 0) { _clearTag(); return; }
  if (data.length === 1) await _selectPatient(data[0]);
  else _showPicker(data, uhid);
}

async function _selectPatient(patient) {
  _patient = patient;
  _newFamilyMember = false;
  document.getElementById('name').value = patient.name;
  document.getElementById('patient-picker').classList.remove('show');

  // Populate demographics fields from saved record
  document.getElementById('f-age').value    = patient.age    || '';
  document.getElementById('f-gender').value = patient.gender || '';
  document.getElementById('f-dob').value    = patient.date_of_birth || '';
  document.getElementById('f-blood').value  = patient.blood_group   || '';

  // NABH — Load patient allergies
  _loadReceptionAllergies(patient.id);

  const [r1, r2, r3] = await Promise.all([
    supabase.from('visits').select('id', { count: 'exact', head: true }).eq('patient_id', patient.id),
    supabase.from('visits').select('created_at').eq('patient_id', patient.id).order('created_at', { ascending: false }).limit(1),
    supabase.from('bills').select('final_amount').eq('patient_id', patient.id).eq('tenant_id', tenantId).eq('status', 'pending')
  ]);
  if (r1.error) console.error('[selectPatient] visits count error:', r1.error);
  if (r2.error) console.error('[selectPatient] last visit error:', r2.error);
  if (r3.error) console.error('[selectPatient] bills error:', r3.error);
  const count = r1.count;
  const lastVisitRows = r2.data;
  const pendingBills  = r3.data;

  const lastVisit = lastVisitRows?.[0]?.created_at
    ? new Date(lastVisitRows[0].created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
  const balance = (pendingBills || []).reduce((s, b) => s + (parseFloat(b.final_amount) || 0), 0);

  document.getElementById('pt-name').textContent = patient.name;
  document.getElementById('pt-uhid').textContent = _uhid(patient.id);
  document.getElementById('pt-visits').textContent = count || 0;
  document.getElementById('pt-lastvisit').textContent = lastVisit;
  document.getElementById('pt-balance').textContent = balance > 0 ? `₹${balance.toLocaleString('en-IN')}` : '₹0';
  const gLabel = { M: 'Male', F: 'Female', other: 'Other' }[patient.gender] || '—';
  document.getElementById('pt-demog').textContent =
    patient.age ? `${patient.age} yrs · ${gLabel}` : (patient.gender ? gLabel : '—');
  document.getElementById('patient-tag').classList.add('show');

  // §12a — Prakriti badge
  const pkEl = document.getElementById('pt-prakriti');
  const pkResult = patient.prakriti_data?.result;
  if (pkResult) {
    pkEl.textContent = '🌿 ' + pkResult;
    pkEl.className = 'pt-prakriti';
  } else {
    pkEl.textContent = 'Prakriti not assessed';
    pkEl.className = 'pt-prakriti none';
  }
  pkEl.style.display = 'inline-flex';

  if (patient.abha_number) {
    document.getElementById('abha').value = patient.abha_number;
    _setAbhaNote('verified', `ABHA on record: ${patient.abha_number}`);
  }

  document.getElementById('reg-fee').value = '0';
  _updateTotal();

  // ── OPD Auto-routing ─────────────────────────────────────────────────────
  // New patient (count=0)      → Screening OPD locked via _applyOpdRule
  // Returning patient (count>0) → last specialty OPD + doctor auto-filled + locked
  {
    const opdSel = document.getElementById('opd');
    const catSel = document.getElementById('visit-category');
    const hint   = document.getElementById('opd-routing-hint');

    _prevOpdId    = null;
    _prevDoctorId = null;

    if (count === 0) {
      // New patient → Screening OPD (locked)
      catSel.value = 'opd';
      _applyOpdRule();
      if (hint) {
        hint.textContent = '🔵 New patient — routed to Screening OPD';
        hint.style.cssText = 'display:block;color:#1a6080;font-size:11px;margin-top:4px;font-weight:500';
      }
    } else {
      // Returning patient — fetch last specialty (non-screening) visit
      let qry = supabase
        .from('visits')
        .select('opd_id, doctor_id, opds(name)')
        .eq('patient_id', patient.id)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (_screeningOpdId) qry = qry.neq('opd_id', _screeningOpdId);
      const { data: prevVisits } = await qry.limit(1);
      const prev = prevVisits?.[0];

      if (prev?.opd_id) {
        // Store for _applyOpdRule to use when category = followup
        _prevOpdId    = prev.opd_id;
        _prevDoctorId = prev.doctor_id || null;
        catSel.value  = 'followup';
        await loadDoctors(prev.opd_id);
        await loadFees(prev.opd_id);
        _applyOpdRule(); // locks OPD + doctor to previous values
        const opdName = prev.opds?.name || Array.from(opdSel.options).find(o => o.value === prev.opd_id)?.text || 'Previous OPD';
        const docText = document.getElementById('doctor').options[document.getElementById('doctor').selectedIndex]?.text || '';
        if (hint) {
          hint.textContent = `↩ Follow-up · ${opdName}${docText ? ' · ' + docText : ''}`;
          hint.style.cssText = 'display:block;color:var(--green-mid);font-size:11px;margin-top:4px;font-weight:500';
        }
      } else {
        // All previous visits were Screening OPD → re-route to screening
        catSel.value = 'opd';
        _applyOpdRule();
        if (hint) {
          hint.textContent = '🔵 Returning patient — routed to Screening OPD';
          hint.style.cssText = 'display:block;color:#1a6080;font-size:11px;margin-top:4px;font-weight:500';
        }
      }
    }
  }

  // Check for active package
  _activePackage = null;
  document.getElementById('pkg-card').classList.remove('show');
  document.getElementById('pkg-use-chk').checked = false;
  const today = new Date().toISOString().slice(0,10);
  const { data: pkgs } = await supabase
    .from('patient_packages')
    .select('*, packages(name,package_type,sessions_total)')
    .eq('patient_id', patient.id)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .lte('start_date', today)
    .gte('end_date', today)
    .order('end_date', { ascending: true })
    .limit(1);

  if (pkgs?.length) {
    _activePackage = pkgs[0];
    const pp = _activePackage;
    const remaining = pp.sessions_total - pp.sessions_used;
    const pct = Math.round(pp.sessions_used / pp.sessions_total * 100);
    const typeLabel = {panchakarma:'Panchakarma',consultation:'Consultation',wellness:'Wellness',combined:'Combined'}[pp.packages?.package_type] || '';
    document.getElementById('pkg-card-name').textContent = `📦 ${pp.packages?.name || 'Package'} · ${remaining} session${remaining!==1?'s':''} remaining`;
    document.getElementById('pkg-card-meta').textContent = `${typeLabel} · Expires ${pp.end_date} · ${pp.sessions_used}/${pp.sessions_total} used`;
    document.getElementById('pkg-sessions-fill').style.width = pct + '%';
    document.getElementById('pkg-card').classList.add('show');
  }
}

function _showPicker(patients, phone) {
  _clearTag();
  const picker = document.getElementById('patient-picker');
  picker.innerHTML = patients.map(p => `
    <div class="picker-item" data-id="${p.id}">
      <div class="picker-avatar">${_esc(p.name.charAt(0).toUpperCase())}</div>
      <div>
        <div class="picker-name">${_esc(p.name)}</div>
        <div class="picker-sub">UHID: ${_uhid(p.id)}</div>
      </div>
    </div>
  `).join('') + `
    <div class="picker-new" id="picker-new-btn">
      <span style="font-size:16px">➕</span>
      <span class="picker-new-label">New family member with same number</span>
    </div>
  `;
  picker.classList.add('show');

  picker.querySelectorAll('.picker-item').forEach(item => {
    item.addEventListener('click', () => {
      const p = patients.find(x => x.id === item.dataset.id);
      if (p) _selectPatient(p);
    });
  });

  document.getElementById('picker-new-btn').addEventListener('click', _startNewFamilyMember);
}

function _startNewFamilyMember() {
  _newFamilyMember = true;
  _patient = null;
  document.getElementById('patient-picker').classList.remove('show');
  document.getElementById('patient-tag').classList.remove('show');
  document.getElementById('name').value = '';
  document.getElementById('name').focus();
  const opdId = document.getElementById('opd').value;
  if (opdId) loadFees(opdId);
}

document.getElementById('btn-diff-family').addEventListener('click', _startNewFamilyMember);

window.togglePkgUse = function() {
  const checked = document.getElementById('pkg-use-chk').checked;
  if (checked) {
    document.getElementById('reg-fee').value = '0';
    document.getElementById('fee').value = '0';
    _updateTotal();
  }
};

window._copyToClipboard = function(el, text) {
  navigator.clipboard.writeText(text).then(() => { el.textContent = '✓ Copied!'; });
};

function _clearTag() {
  _patient = null;
  _activePackage = null;
  _newFamilyMember = false;
  document.getElementById('patient-tag').classList.remove('show');
  document.getElementById('pkg-card').classList.remove('show');
  document.getElementById('pkg-use-chk').checked = false;
  document.getElementById('patient-picker').classList.remove('show');
  document.getElementById('pt-prakriti').style.display = 'none';
  document.getElementById('abha').value = '';
  document.getElementById('f-age').value    = '';
  document.getElementById('f-gender').value = '';
  document.getElementById('f-dob').value    = '';
  document.getElementById('f-blood').value  = '';
  _prevOpdId    = null;
  _prevDoctorId = null;
  document.getElementById('opd-routing-hint').style.display = 'none';
  document.getElementById('doctor').disabled = false;
  _applyOpdRule(); // resets OPD to Screening OPD (locked)
  _clearAbhaNote();
}

// ── Submit ────────────────────────────────────────
document.getElementById('btn-submit').addEventListener('click', () => {
  if (_mode === 'appointment') bookAppointment();
  else handleSubmit();
});

async function handleSubmit() {
  _hideAlert();
  document.getElementById('receipt-card').classList.remove('show');
  document.getElementById('receipt-feedback-block').style.display = 'none';

  const phone       = document.getElementById('phone').value.trim();
  const name        = document.getElementById('name').value.trim();
  const complaint   = document.getElementById('complaint').value.trim();
  const abha        = document.getElementById('abha').value.replace(/\D/g, '').trim() || null;
  const visitCat    = document.getElementById('visit-category').value;
  const opdId       = document.getElementById('opd').value;
  const doctorId    = document.getElementById('doctor').value;
  const demographics = {
    age:           parseInt(document.getElementById('f-age').value)    || null,
    gender:        document.getElementById('f-gender').value           || null,
    date_of_birth: document.getElementById('f-dob').value             || null,
    blood_group:   document.getElementById('f-blood').value           || null
  };
  const isOnReq     = onRequestChk.checked;
  const regFee      = parseFloat(document.getElementById('reg-fee').value)  || 0;
  const consFee     = parseFloat(document.getElementById('fee').value)      || 0;
  const surcharge   = isOnReq ? (parseFloat(document.getElementById('surcharge').value) || 0) : 0;
  const total       = regFee + consFee + surcharge;
  const payMode     = document.getElementById('payment-mode').value;
  const payStatus   = document.querySelector('input[name="payment"]:checked').value;

  const payerType      = document.querySelector('input[name="payer_type"]:checked')?.value || 'self_pay';
  const isInsurance    = payerType !== 'self_pay';
  const insClaimStatus = isInsurance ? 'pre_auth_pending' : 'not_applicable';

  if (!phone)     return _alert('error', 'Please enter the patient\'s phone number.');
  if (!name)      return _alert('error', 'Please enter the patient\'s name.');
  if (!complaint) return _alert('error', 'Please enter the chief complaint.');

  // §18aa — NCISM: Kaumarabhritya OPD is for patients up to 18 years
  if (_kaumarOpdId && opdId === _kaumarOpdId) {
    const age = demographics.age || _patient?.age || _ageFromDob(demographics.date_of_birth || _patient?.date_of_birth);
    if (age && age >= 18) {
      const ok = confirm(`Kaumarabhritya OPD is for patients up to 18 years.\nPatient age: ${age} years.\n\nConfirm routing to Kaumarabhritya OPD?`);
      if (!ok) return;
    }
  }

  const btn = document.getElementById('btn-submit');
  _loading(btn, true);

  try {
    // 1. Find or create patient
    let patient = _patient;
    if (!patient) {
      if (_newFamilyMember) {
        // Receptionist explicitly chose "new family member" — always create fresh
        patient = await createPatient(name, phone, tenantId, abha, demographics);
      } else {
        // ABHA-first: scan/verify flows provide an ABHA number — use it as primary key
        let found = null;
        if (abha) {
          const abhaHyph = abha.length === 14
            ? abha.replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4')
            : abha;
          const { data: byAbha } = await supabase
            .from('patients')
            .select('id, name, age, gender, date_of_birth, blood_group, abha_number')
            .eq('tenant_id', tenantId)
            .or(`abha_number.eq.${abha},abha_number.eq.${abhaHyph}`)
            .limit(1);
          found = byAbha?.[0] ?? null;
        }
        if (!found && phone) {
          const { data: byPhone } = await supabase
            .from('patients')
            .select('id, name, age, gender, date_of_birth, blood_group, abha_number')
            .eq('phone', phone).eq('tenant_id', tenantId).limit(1);
          const candidate = byPhone?.[0] ?? null;
          if (candidate) {
            // Skip phone match if it belongs to a different patient (ABHA conflict)
            const stored   = String(candidate.abha_number ?? '').replace(/\D/g, '');
            const incoming = abha ?? '';
            found = (!incoming || !stored || stored === incoming) ? candidate : null;
          }
        }
        patient = found ?? await createPatient(name, phone, tenantId, abha, demographics);
      }

      // Backfill demographics on existing patient if fields were blank
      if (patient && (demographics.age || demographics.gender || demographics.date_of_birth || demographics.blood_group)) {
        const upd = {};
        if (demographics.age           && !patient.age)           upd.age           = demographics.age;
        if (demographics.gender        && !patient.gender)        upd.gender        = demographics.gender;
        if (demographics.date_of_birth && !patient.date_of_birth) upd.date_of_birth = demographics.date_of_birth;
        if (demographics.blood_group   && !patient.blood_group)   upd.blood_group   = demographics.blood_group;
        if (Object.keys(upd).length > 0)
          await supabase.from('patients').update(upd).eq('id', patient.id);
      }
    }

    // 2. Duplicate check — today only (yesterday's incomplete visits must not block)
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { data: existing } = await supabase
      .from('visits').select('id, token_number')
      .eq('patient_id', patient.id)
      .in('status', ['waiting', 'in_progress'])
      .gte('created_at', todayStart.toISOString())
      .limit(1);

    if (existing && existing.length > 0) {
      _alert('error', `${patient.name} is already in today's queue (Token #${existing[0].token_number}). Use the ✎ button on their queue card to edit doctor / complaint.`);
      _loading(btn, false);
      return;
    }

    // 3. Save ABHA if provided and not already stored
    if (abha && !_patient?.abha_number) {
      await supabase.from('patients').update({ abha_number: abha }).eq('id', patient.id);
    }

    // 4. Next token (resets daily) — reuse todayStart from duplicate check above
    const { data: lastToken } = await supabase
      .from('visits').select('token_number')
      .eq('tenant_id', tenantId)
      .gte('created_at', todayStart.toISOString())
      .not('token_number', 'is', null)
      .order('token_number', { ascending: false }).limit(1);

    const nextToken = (lastToken && lastToken.length > 0) ? lastToken[0].token_number + 1 : 1;

    // 5. Create visit
    const isTele = visitCat === 'teleconsultation';
    const { data: visit, error: vErr } = await supabase
      .from('visits').insert({
        patient_id:           patient.id,
        tenant_id:            tenantId,
        doctor_id:            doctorId || null,
        opd_id:               opdId    || null,
        status:               'waiting',
        chief_complaint:      complaint,
        token_number:         nextToken,
        is_on_request:        isOnReq,
        visit_category:       visitCat,
        is_teleconsultation:  isTele,
      }).select().single();

    if (vErr) throw vErr;

    // Generate meeting URL for tele visits
    let meetingUrl = null;
    if (isTele) {
      meetingUrl = `https://meet.jit.si/AyurXpert-${tenant?.tenant_code||tenantId.slice(0,6)}-${visit.id.slice(0,8)}`;
      await supabase.from('visits').update({ meeting_url: meetingUrl }).eq('id', visit.id);
    }

    await logAudit('create_visit', 'visits', visit.id, {
      patient_name: patient.name, token_number: nextToken,
      complaint, visit_category: visitCat, opd_id: opdId || null, is_on_request: isOnReq
    }, _ctx);

    // 6. Create bill
    const billPayload = {
      tenant_id:            tenantId,
      patient_id:           patient.id,
      visit_id:             visit.id,
      registration_fee:     regFee,
      consultation_fee:     consFee,
      on_request_surcharge: surcharge,
      total_amount:         total,
      final_amount:         total,
      payment_mode:         payMode,
      status:               payStatus,
      bill_type:            'consultation'
    };
    billPayload.payer_type             = payerType;
    billPayload.insurance_claim_status = insClaimStatus;
    const { data: bill, error: bErr } = await supabase
      .from('bills').insert(billPayload).select('id').single();

    if (bErr) throw bErr;

    await logAudit('create_bill', 'bills', bill.id, {
      patient_name: patient.name, total_amount: total,
      reg_fee: regFee, cons_fee: consFee, surcharge,
      payment_mode: payMode, status: payStatus,
      ...(isInsurance && { payer_type: payerType })
    }, _ctx);

    // 7a. Doctor alert for on-request
    if (isOnReq && doctorId) {
      await supabase.from('doctor_alerts').insert({
        tenant_id: tenantId, doctor_id: doctorId, visit_id: visit.id,
        patient_name: patient.name,
        message: `On-request visit — Token #${nextToken}. ${complaint}`,
        is_read: false
      });
    }

    // 7b. Doctor alert for tele visit with meeting link
    if (isTele && doctorId && meetingUrl) {
      await supabase.from('doctor_alerts').insert({
        tenant_id: tenantId, doctor_id: doctorId, visit_id: visit.id,
        patient_name: patient.name,
        message: `🎥 Tele visit — Token #${nextToken}. Join: ${meetingUrl}`,
        is_read: false
      });
    }

    // 8. Receipt
    const doctorName = document.getElementById('doctor').selectedOptions[0]?.text || '—';
    const opdName    = document.getElementById('opd').selectedOptions[0]?.text    || 'General';
    const catLabel   = document.getElementById('visit-category').selectedOptions[0]?.text || visitCat;
    _showReceipt({
      token: nextToken, name: patient.name, phone,
      uhid: _uhid(patient.id), abha: abha || patient.abha_number || null,
      opd: opdName, doctor: doctorName,
      category: catLabel, complaint, regFee, consFee, surcharge,
      total, payMode, payStatus, meetingUrl, visitId: visit.id,
      isInsurance, payerType,
      date: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    });

    const payMsg = payStatus === 'paid'
      ? ` · ₹${total.toLocaleString('en-IN')} received via ${payMode}`
      : ` · Payment pending`;
    _currentVisitId = visit.id;  // track for ABDM link token if ABHA verified later

    // ABDM M2: care context — Scenario 1 (has ABHA) or Scenario 2 (no ABHA → SMS)
    const _abhaForCC = abha || patient.abha_number || null;
    if (_abhaForCC) {
      _abdmLinkTokenAfterVerify(patient.id, _abhaForCC, visit.id).catch(() => {});
    } else if (patient.phone) {
      _abdmSmsNotifyNoAbha(patient.id, patient.phone, patient.name, visit.id).catch(() => {});
    }

    _alert('success', `Token #${nextToken} — ${patient.name} added to queue${payMsg}.`);
    _resetForm();
    loadQueue();

  } catch (err) {
    console.error(err);
    _alert('error', safeErrorMessage(err, 'Something went wrong. Please try again.'));
  }

  _loading(btn, false);
}

// ── Receipt ───────────────────────────────────────
async function _showReceipt(d) {
  const fmt  = n => n > 0 ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—';
  const rows = [
    { l: 'Token',          v: `<strong>#${d.token}</strong>` },
    { l: 'UHID',           v: d.uhid },
    d.abha ? { l: 'ABHA No.',  v: d.abha } : null,
    { l: 'Patient',        v: d.name },
    { l: 'Phone',          v: d.phone },
    { l: 'Visit Category', v: d.category },
    { l: 'OPD',            v: d.opd },
    { l: 'Doctor',         v: d.doctor },
    { l: 'Complaint',      v: d.complaint },
    d.regFee   > 0 ? { l: 'Registration Fee',      v: fmt(d.regFee) }   : null,
    { l: 'Consultation Fee', v: fmt(d.consFee) },
    d.surcharge > 0 ? { l: 'On-Request Surcharge', v: fmt(d.surcharge) } : null,
    { l: 'Total',          v: `<strong>₹${d.total.toLocaleString('en-IN')}</strong>` },
    { l: 'Payment Mode', v: d.isInsurance
        ? ({insurance:'Insurance / TPA', pmjay:'PMJAY (Ayushman)', cghs:'CGHS / ECHS', echs:'ECHS', esi:'ESIC', corporate:'Corporate'}[d.payerType] || 'Insurance')
        : (d.payMode.charAt(0).toUpperCase() + d.payMode.slice(1)) },
    d.isInsurance ? { l: 'Billing', v: 'Accounts dept will fill TPA / policy details' } : null,
    { l: 'Payment Status', v: d.payStatus === 'paid' ? '✓ Paid' : '⏳ Pending' },
    { l: 'Date & Time',    v: d.date },
  ].filter(Boolean);

  document.getElementById('receipt-rows').innerHTML = rows.map(r =>
    `<div class="receipt-row"><span class="receipt-lbl">${r.l}</span><span class="receipt-val">${r.v}</span></div>`
  ).join('');

  // Tele meeting link block
  const meetBlock = document.getElementById('receipt-tele-block');
  if (d.meetingUrl) {
    meetBlock.style.display = '';
    meetBlock.innerHTML = `
      <div style="background:#dbeafe;border:1.5px solid #93c5fd;border-radius:10px;padding:12px 14px;margin-top:12px">
        <div style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🎥 Teleconsultation Video Link</div>
        <div style="font-size:12px;color:#1e40af;word-break:break-all;margin-bottom:8px">${d.meetingUrl}</div>
        <button data-onclick="_copyToClipboard" data-onclick-a0="@this" data-onclick-a1="${_esc(d.meetingUrl)}" style="background:#2563eb;color:#fff;border:none;border-radius:7px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">📋 Copy Link for Patient</button>
        <div style="font-size:11px;color:#3b82f6;margin-top:6px">Share this link with the patient via WhatsApp / SMS before the appointment.</div>
      </div>`;
  } else {
    meetBlock.style.display = 'none';
  }

  // Feedback link block
  if (d.visitId) {
    const feedbackUrl = `${window.location.origin}/feedback.html?visit=${d.visitId}`;
    const feedBlock = document.getElementById('receipt-feedback-block');
    if (feedBlock) {
      feedBlock.style.display = '';
      feedBlock.innerHTML = `
        <div style="background:#fdf8f0;border:1.5px solid var(--gold);border-radius:10px;padding:12px 14px;margin-top:12px">
          <div style="font-size:11px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">⭐ Patient Feedback</div>
          <div style="font-size:12px;color:var(--text-mid);margin-bottom:8px">Share this link with the patient to collect feedback after their visit.</div>
          <button data-onclick="_copyToClipboard" data-onclick-a0="@this" data-onclick-a1="${_esc(feedbackUrl)}" style="background:var(--gold);color:#fff;border:none;border-radius:7px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif">📋 Copy Feedback Link</button>
        </div>`;
    }
  }

  const payBadge = d.payStatus === 'paid'
    ? `<span class="pay-confirm">₹${d.total.toLocaleString('en-IN')} Paid · ${d.payMode.charAt(0).toUpperCase() + d.payMode.slice(1)}</span>`
    : `<span class="pay-pending">₹${d.total.toLocaleString('en-IN')} Pending</span>`;
  document.getElementById('receipt-title').innerHTML = `✓ Visit Registered ${payBadge}`;
  document.getElementById('receipt-card').classList.add('show');

  // Deduct package session if used
  if (_activePackage && document.getElementById('pkg-use-chk').checked) {
    const newUsed = (_activePackage.sessions_used || 0) + 1;
    const newStatus = newUsed >= _activePackage.sessions_total ? 'completed' : 'active';
    await supabase.from('patient_packages')
      .update({ sessions_used: newUsed, status: newStatus })
      .eq('id', _activePackage.id);
    _activePackage = null;
    document.getElementById('pkg-card').classList.remove('show');
    document.getElementById('pkg-use-chk').checked = false;
  }
}

document.getElementById('btn-print').addEventListener('click', () => window.print());

// ── Queue ─────────────────────────────────────────
async function loadQueue() {
  const start = new Date(); start.setHours(0, 0, 0, 0);

  const { data: visits } = await supabase
    .from('visits')
    .select('id, token_number, status, chief_complaint, created_at, is_on_request, visit_category, doctor_id, patients(name)')
    .eq('tenant_id', tenantId)
    .in('status', ['waiting', 'in_progress'])
    .gte('created_at', start.toISOString())
    .order('token_number', { ascending: true });

  // Fetch payment status for these visits
  const visitIds = (visits || []).map(v => v.id);
  let billMap = {};
  if (visitIds.length > 0) {
    const { data: bills } = await supabase
      .from('bills').select('visit_id, status, payment_mode')
      .in('visit_id', visitIds);
    (bills || []).forEach(b => { billMap[b.visit_id] = b; });
  }

  const count = visits ? visits.length : 0;
  document.getElementById('queue-count').textContent = count;

  const list = document.getElementById('queue-list');
  if (!count) {
    list.innerHTML = `<div class="q-empty"><div class="q-empty-icon"><img src="assets/AyurXpert_Tree_Only.png" alt=""></div><div class="q-empty-text">No patients in queue yet</div></div>`;
    return;
  }

  list.innerHTML = visits.map(v => {
    const isActive    = v.status === 'in_progress';
    const isEmergency = v.visit_category === 'emergency';
    const bill        = billMap[v.id];

    const tokenClass  = isEmergency ? 'emergency' : isActive ? 'active' : 'waiting';
    const itemClass   = isEmergency ? 'q-item emergency' : 'q-item';

    const t     = new Date(v.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const wait  = _waitTime(v.created_at);
    const doc   = _doctorMap[v.doctor_id] || '—';

    const catLabel = {
      opd: 'OPD', followup: 'Follow-up', panchakarma: 'Panchakarma',
      emergency: 'Emergency', teleconsultation: 'Teleconsult', camp: 'Camp'
    }[v.visit_category] || v.visit_category || 'OPD';

    const payBadge = bill?.status === 'paid'
      ? `<span class="badge badge-paid">PAID</span>`
      : `<span class="badge badge-pending">PENDING</span>`;

    const onReqBadge = v.is_on_request ? `<span class="badge badge-onreq">ON REQ</span>` : '';
    const emergBadge = isEmergency ? `<span class="badge badge-emerg">EMERGENCY</span>` : '';

    const statusDot = isActive ? 'var(--green-mid)' : isEmergency ? 'var(--red)' : 'var(--gold)';
    const statusLabel = isActive ? 'With doctor' : 'Waiting';

    return `<div class="${itemClass}">
      <div class="q-token ${tokenClass}">${v.token_number}</div>
      <div class="q-info">
        <div class="q-name">${_esc(v.patients?.name || '—')} ${emergBadge}${onReqBadge}</div>
        <div class="q-row2">
          <span style="color:var(--text-mid)">${_esc(doc)}</span>
          <span class="badge badge-cat">${_esc(catLabel)}</span>
          ${payBadge}
        </div>
        <div class="q-row3">
          <span class="dot" style="background:${statusDot}"></span>
          ${statusLabel} · ${_esc(v.chief_complaint || '—')}
        </div>
      </div>
      <div class="q-right">
        <span class="q-time">${t}</span>
        <span class="q-wait">${wait}</span>
        <button class="q-edit-btn" data-visit-id="${v.id}" data-doctor-id="${v.doctor_id || ''}" data-complaint="${_esc(v.chief_complaint || '')}" data-category="${v.visit_category || 'opd'}" title="Edit this queue entry" type="button">✎</button>
      </div>
    </div>`;
  }).join('');

  // Attach edit button listeners
  list.querySelectorAll('.q-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _openQueueEdit(btn.dataset.visitId, btn.dataset.doctorId, btn.dataset.complaint, btn.dataset.category);
    });
  });
}

// ── Queue Edit ────────────────────────────────────
async function _openQueueEdit(visitId, doctorId, complaint, category) {
  document.getElementById('qe-visit-id').value   = visitId;
  document.getElementById('qe-complaint').value  = complaint || '';
  document.getElementById('qe-category').value   = category  || 'opd';

  // Load all active doctors for this tenant
  const sel = document.getElementById('qe-doctor');
  sel.innerHTML = '<option value="">— No preference —</option>';
  const { data: docs } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('tenant_id', tenantId)
    .eq('role', 'doctor')
    .eq('status', 'active')
    .order('full_name');
  (docs || []).forEach(d => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.full_name || 'Doctor';
    if (d.id === doctorId) o.selected = true;
    sel.appendChild(o);
  });

  document.getElementById('queue-edit-modal').classList.add('open');
}

function _closeQueueEdit() {
  document.getElementById('queue-edit-modal').classList.remove('open');
}

async function _saveQueueEdit() {
  const visitId   = document.getElementById('qe-visit-id').value;
  const doctorId  = document.getElementById('qe-doctor').value   || null;
  const complaint = document.getElementById('qe-complaint').value.trim();
  const category  = document.getElementById('qe-category').value;
  const btn       = document.getElementById('qe-save-btn');

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await supabase.from('visits').update({
    doctor_id:      doctorId,
    chief_complaint: complaint || null,
    visit_category: category,
  }).eq('id', visitId);

  btn.disabled = false;
  btn.textContent = 'Save Changes';

  if (error) { _alert('error', safeErrorMessage(error, 'Save failed. Please try again.')); return; }

  // Update _doctorMap in case new doctor not yet loaded
  if (doctorId && !_doctorMap[doctorId]) {
    const sel = document.getElementById('qe-doctor');
    _doctorMap[doctorId] = sel.options[sel.selectedIndex]?.textContent || 'Doctor';
  }

  _closeQueueEdit();
  _alert('success', 'Queue entry updated.');
  loadQueue();
}

document.getElementById('qe-close-btn').addEventListener('click', _closeQueueEdit);
document.getElementById('qe-cancel-btn').addEventListener('click', _closeQueueEdit);
document.getElementById('qe-save-btn').addEventListener('click', _saveQueueEdit);
document.getElementById('queue-edit-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('queue-edit-modal')) _closeQueueEdit();
});

// ── Helpers ───────────────────────────────────────
function _resetForm() {
  ['phone', 'name', 'complaint', 'abha', 'reg-fee', 'fee', 'surcharge'].forEach(id =>
    document.getElementById(id).value = '');
  _clearAbhaNote();
  _lastTToken = null;
  document.getElementById('demog-warn').classList.remove('show');
  document.getElementById('enroll-step-1').style.display = '';
  document.getElementById('enroll-step-2').style.display = 'none';
  document.getElementById('enroll-step-3').style.display = 'none';
  enrollPanel.style.display = 'none';
  btnEnroll.textContent = '+ Enroll';
  btnEnroll.classList.remove('open');
  verifyPanel.style.display = 'none';
  btnVerifyAbha.textContent = 'Verify';
  btnVerifyAbha.classList.remove('open');
  _closeScanPanel();
  document.getElementById('visit-category').value = 'opd';
  document.getElementById('payment-mode').value = 'cash';
  document.getElementById('pay-paid').checked = true;
  onRequestChk.checked = false;
  onRequestWrap.classList.remove('active');
  surchargeRow.style.display = 'none';
  document.getElementById('ins-note').style.display = 'none';
  const selfPayRadio = document.querySelector('input[name="payer_type"][value="self_pay"]');
  if (selfPayRadio) selfPayRadio.checked = true;
  document.getElementById('opd').value = '';
  document.getElementById('opd').disabled = false;
  _clearTag();
  _updateTotal();
  _applyOpdRule();
}

function _alert(type, msg) {
  const el = document.getElementById('alert');
  document.getElementById('alert-icon').textContent = type === 'error' ? '⚠' : '✓';
  document.getElementById('alert-text').textContent = msg;
  el.className = `alert show ${type}`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _hideAlert() { document.getElementById('alert').className = 'alert'; }
function _loading(btn, on) { btn.classList.toggle('loading', on); btn.disabled = on; }

function _setAbhaNote(type, msg) {
  const el = document.getElementById('abha-note');
  document.getElementById('abha-note-text').textContent = msg;
  el.className = `abha-note show ${type}`;
}
function _clearAbhaNote() {
  document.getElementById('abha-note').className = 'abha-note';
  document.getElementById('abha-profile-card').classList.remove('show');
}

function _showAbhaProfile(prof, abhaNumber, tToken) {
  const name   = [prof?.firstName, prof?.middleName, prof?.lastName].filter(Boolean).join(' ') || prof?.name || '';
  const _dobCombined = (prof?.dayOfBirth && prof?.monthOfBirth && prof?.yearOfBirth)
    ? `${prof.dayOfBirth}-${prof.monthOfBirth}-${prof.yearOfBirth}` : null;
  const dob    = _formatDob(_dobCombined ?? prof?.dob ?? prof?.dateOfBirth ?? prof?.yearOfBirth);
  const gender = { M: 'Male', F: 'Female', O: 'Other' }[prof?.gender] ?? (prof?.gender || '—');
  const addr   = prof?.preferredAbhaAddress ?? prof?.phrAddress?.[0] ?? prof?.abhaAddress ?? prof?.healthId ?? '—';
  const mobile = prof?.mobile ?? prof?.mobileNumber ?? prof?.phoneNumber ?? prof?.ABHAProfile?.mobile ?? '';

  document.getElementById('abha-prof-name').textContent    = name    || '—';
  document.getElementById('abha-prof-number').textContent  = abhaNumber;
  document.getElementById('abha-prof-dob').textContent     = dob;
  document.getElementById('abha-prof-gender').textContent  = gender;
  document.getElementById('abha-prof-mobile').textContent  = mobile ? `+91 ${mobile}` : '—';
  document.getElementById('abha-prof-address').textContent = addr;

  // Photo
  const rawPhoto = prof?.profilePhoto ?? prof?.photo ?? '';
  const photoEl  = document.getElementById('abha-prof-photo');
  const iconEl   = document.getElementById('abha-prof-icon');
  if (rawPhoto) {
    photoEl.src = rawPhoto.startsWith('data:') ? rawPhoto : `data:image/jpeg;base64,${rawPhoto}`;
    photoEl.style.display = '';
    if (iconEl) iconEl.style.display = 'none';
  } else {
    photoEl.style.display = 'none';
    if (iconEl) iconEl.style.display = '';
  }

  document.getElementById('abha-profile-card').classList.add('show');

  // Show / hide action buttons based on tToken availability
  if (tToken) _lastTToken = tToken;
  document.getElementById('btn-download-abha-card').style.display = _lastTToken ? '' : 'none';
  document.getElementById('btn-update-mobile-open').style.display = _lastTToken ? '' : 'none';

  // Auto-fill demographics from ABHA profile
  if (prof?.gender) {
    const gMap = { M:'male', F:'female', O:'other', male:'male', female:'female', other:'other' };
    document.getElementById('f-gender').value = gMap[prof.gender] || 'other';
  }
  const rawDob = prof?.dob ?? prof?.dateOfBirth;
  if (rawDob) {
    const parts = String(rawDob).split('-');
    // Convert DD-MM-YYYY → YYYY-MM-DD for date input
    const iso = parts[0].length === 4 ? rawDob : `${parts[2]}-${parts[1]}-${parts[0]}`;
    document.getElementById('f-dob').value = iso;
    _calcAgeFromDob(iso);
  }

  // Run demographic match check for returning patients
  _checkDemographicMatch(prof);
}

function _calcAgeFromDob(isoDate) {
  if (!isoDate) return;
  const dob   = new Date(isoDate);
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  if (today.getMonth() < dob.getMonth() ||
     (today.getMonth() === dob.getMonth() && today.getDate() < dob.getDate())) age--;
  if (age >= 0) document.getElementById('f-age').value = age;
}

// ── Download ABHA Card ────────────────────────────
document.getElementById('btn-download-abha-card').addEventListener('click', async () => {
  if (!_lastTToken) return;
  const btn = document.getElementById('btn-download-abha-card');
  btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const res = await downloadAbhaCard(_lastTToken);
    const a   = document.createElement('a');
    a.href     = `data:${res.mimeType};base64,${res.base64}`;
    a.download = `ABHA_Card_${document.getElementById('abha').value.replace(/-/g,'')}.png`;
    a.click();
  } catch (err) {
    alert(safeErrorMessage(err, 'Download failed. Please try again.'));
  }
  btn.disabled = false; btn.textContent = '⬇ Download ABHA Card';
});

// ── Update Mobile (ABDM §8.1) ─────────────────────
document.getElementById('btn-update-mobile-open').addEventListener('click', () => {
  const panel = document.getElementById('update-mobile-panel');
  const open  = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : '';
  if (!open) {
    document.getElementById('upd-mob-step-1').style.display = '';
    document.getElementById('upd-mob-step-2').style.display = 'none';
    document.getElementById('upd-mob-input').value = '';
    _clearOtpBoxes('upd-mob-otp-boxes');
    document.getElementById('upd-mob-msg').textContent = '';
    _updMobTxnId = null;
  }
});

document.getElementById('btn-upd-mob-send').addEventListener('click', async () => {
  if (!_lastTToken) return;
  const mobile = (document.getElementById('upd-mob-input').value || '').trim();
  if (!/^\d{10}$/.test(mobile)) {
    document.getElementById('upd-mob-msg').textContent = 'Enter a valid 10-digit mobile number.';
    return;
  }
  const btn = document.getElementById('btn-upd-mob-send');
  btn.disabled = true; btn.textContent = 'Sending…';
  document.getElementById('upd-mob-msg').textContent = '';
  try {
    const res = await requestUpdateMobileOtp(_lastTToken, mobile);
    _updMobTxnId = res.txnId;
    document.getElementById('upd-mob-otp-label').textContent =
      res.message ?? `OTP sent to ${mobile}`;
    document.getElementById('upd-mob-step-1').style.display = 'none';
    document.getElementById('upd-mob-step-2').style.display = '';
    _clearOtpBoxes('upd-mob-otp-boxes');
    document.querySelector('#upd-mob-otp-boxes .otp-box')?.focus();
  } catch (err) {
    document.getElementById('upd-mob-msg').textContent = safeErrorMessage(err, 'Could not update mobile number.');
  }
  btn.disabled = false; btn.textContent = 'Send OTP';
});

document.getElementById('btn-upd-mob-verify').addEventListener('click', async () => {
  if (!_lastTToken || !_updMobTxnId) return;
  const otp = _getOtpValue('upd-mob-otp-boxes');
  if (otp.length < 6) { document.getElementById('upd-mob-msg').textContent = 'Please enter the complete 6-digit OTP.'; return; }
  const btn = document.getElementById('btn-upd-mob-verify');
  btn.disabled = true; btn.textContent = 'Verifying…';
  document.getElementById('upd-mob-msg').textContent = '';
  try {
    await verifyUpdateMobileOtp(_lastTToken, _updMobTxnId, otp);
    document.getElementById('upd-mob-msg').textContent = '✓ Mobile updated successfully.';
    document.getElementById('upd-mob-msg').style.color = 'var(--green-deep)';
    setTimeout(() => {
      document.getElementById('update-mobile-panel').style.display = 'none';
      document.getElementById('upd-mob-msg').style.color = '';
    }, 2000);
  } catch (err) {
    document.getElementById('upd-mob-msg').textContent = safeErrorMessage(err, 'Could not update mobile number.');
  }
  btn.disabled = false; btn.textContent = 'Verify & Update';
});

document.getElementById('btn-upd-mob-back').addEventListener('click', () => {
  document.getElementById('upd-mob-step-1').style.display = '';
  document.getElementById('upd-mob-step-2').style.display = 'none';
  _clearOtpBoxes('upd-mob-otp-boxes');
  document.getElementById('upd-mob-msg').textContent = '';
  _updMobTxnId = null;
});

function _formatDob(dob) {
  if (!dob) return '—';
  const parts = String(dob).split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`; // YYYY-MM-DD → DD/MM/YYYY
  }
  if (parts.length === 3 && parts[2].length === 4) {
    return `${parts[0]}/${parts[1]}/${parts[2]}`; // DD-MM-YYYY → DD/MM/YYYY
  }
  return dob;
}

// ── ABHA Enrollment ───────────────────────────────
let _enrollTxnId       = null;
let _enrollMobile      = null;
let _pendingAbhaResponse = null; // stores byAadhaar response when needsMobileOtp=true
let _existingAbhaAadhaar  = null; // saved when ABDM-1008 (already enrolled)
let _existingAadhaarTxnId = null;

const btnEnroll  = document.getElementById('btn-enroll-abha');
const enrollPanel = document.getElementById('abha-enroll-panel');

btnEnroll.addEventListener('click', () => {
  const isOpen = enrollPanel.style.display !== 'none';
  _closeAllAbhaPanels();
  if (!isOpen) {
    enrollPanel.style.display = '';
    btnEnroll.textContent = '✕ Cancel';
    btnEnroll.classList.add('open');
    document.getElementById('enroll-aadhaar').value = '';
    document.getElementById('enroll-aadhaar').type = 'password';
    document.getElementById('btn-toggle-aadhaar').textContent = '👁';
    _clearOtpBoxes('enroll-otp-boxes');
    document.getElementById('enroll-comm-mobile').value = '';
    document.getElementById('enroll-step-1').style.display = '';
    document.getElementById('enroll-step-2').style.display = 'none';
    _setEnrollMsg('', '');
  }
});

function _switchToEnroll() {
  _closeAllAbhaPanels();
  enrollPanel.style.display = '';
  btnEnroll.textContent = '✕ Cancel';
  btnEnroll.classList.add('open');
  document.getElementById('enroll-aadhaar').value = '';
  document.getElementById('enroll-aadhaar').type = 'password';
  document.getElementById('btn-toggle-aadhaar').textContent = '👁';
  _clearOtpBoxes('enroll-otp-boxes');
  document.getElementById('enroll-comm-mobile').value = '';
  document.getElementById('enroll-step-1').style.display = '';
  document.getElementById('enroll-step-2').style.display = 'none';
  _setEnrollMsg('info', 'Enter your Aadhaar number to create ABHA.');
}
window._switchToEnroll = _switchToEnroll;

// ── OTP Resend rate-limiter (60s cooldown, max 2 resends) ─────
function _makeResendLimiter(btnId) {
  const btn = document.getElementById(btnId);
  let count = 0, timerId = null;
  function _startCountdown() {
    clearInterval(timerId);
    btn.disabled = true;
    let secs = 60;
    btn.textContent = `Resend in ${secs}s`;
    timerId = setInterval(() => {
      secs--;
      if (secs > 0) { btn.textContent = `Resend in ${secs}s`; return; }
      clearInterval(timerId); timerId = null;
      btn.disabled = count >= 2;
      btn.textContent = count >= 2 ? 'Max attempts — wait 30 min' : 'Resend OTP';
    }, 1000);
  }
  return {
    arm()      { _startCountdown(); },
    onResend() { count++; },
    reset()    { clearInterval(timerId); timerId = null; count = 0; btn.disabled = false; btn.textContent = 'Resend OTP'; },
  };
}
const _verifyResendLim = _makeResendLimiter('btn-verify-resend');
const _aadResendLim    = _makeResendLimiter('btn-aad-resend');
const _mobResendLim    = _makeResendLimiter('btn-mob-resend');
const _addrResendLim   = _makeResendLimiter('btn-addr-resend');
const _enrollResendLim = _makeResendLimiter('btn-resend-otp');

// ── 6-box OTP helpers ──────────────────────────────
function _setupOtpBoxes(containerId) {
  const boxes = [...document.querySelectorAll(`#${containerId} .otp-box`)];
  boxes.forEach((box, i) => {
    box.addEventListener('input', e => {
      const v = e.target.value.replace(/\D/g, '');
      e.target.value = v ? v[v.length - 1] : '';
      if (v && i < 5) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      const txt = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      boxes.forEach((b, idx) => { b.value = txt[idx] || ''; });
      boxes[Math.min(txt.length, 5)].focus();
    });
  });
}
function _getOtpValue(containerId) {
  return [...document.querySelectorAll(`#${containerId} .otp-box`)].map(b => b.value).join('');
}
function _clearOtpBoxes(containerId) {
  document.querySelectorAll(`#${containerId} .otp-box`).forEach(b => { b.value = ''; });
}
// Initialise all OTP box groups
_setupOtpBoxes('enroll-otp-boxes');
_setupOtpBoxes('enroll-mob-otp-boxes');
_setupOtpBoxes('enroll-existing-otp-boxes');
_setupOtpBoxes('upd-mob-otp-boxes');

// ── Aadhaar show/hide toggle ──────────────────────
document.getElementById('btn-toggle-aadhaar').addEventListener('click', () => {
  const inp = document.getElementById('enroll-aadhaar');
  const btn = document.getElementById('btn-toggle-aadhaar');
  if (inp.type === 'password') { inp.type = 'text';     btn.textContent = '🙈'; }
  else                         { inp.type = 'password'; btn.textContent = '👁'; }
});

// ── ABHA Account Exists modal ─────────────────────
let _abhaExistsPendingAction = null;
function _maskAbha(fmt) {
  const p = fmt.split('-');
  return p.length === 4 ? `xx-xxxx-xxxx-${p[3]}` : fmt.replace(/\d(?=\d{4})/g, 'x');
}
function _showAbhaExistsModal(maskedAbha, onViewProfile, subMsg) {
  const base = maskedAbha
    ? `We have found ABHA <strong>${maskedAbha}</strong> linked to the Aadhaar provided.`
    : 'We have found an existing ABHA account linked to the Aadhaar provided.';
  document.getElementById('abha-exists-msg').innerHTML = subMsg
    ? `${base}<br><span style="display:block;margin-top:6px;font-size:12px;color:#c17f24">${subMsg}</span>`
    : base;
  document.getElementById('abha-exists-overlay').style.display = '';
  _abhaExistsPendingAction = onViewProfile;
}
document.getElementById('btn-abha-exists-cancel').addEventListener('click', () => {
  document.getElementById('abha-exists-overlay').style.display = 'none';
  _abhaExistsPendingAction = null;
  _setEnrollMsg('', '');
});
document.getElementById('btn-abha-exists-view').addEventListener('click', async () => {
  document.getElementById('abha-exists-overlay').style.display = 'none';
  if (typeof _abhaExistsPendingAction === 'function') {
    await _abhaExistsPendingAction();
    _abhaExistsPendingAction = null;
  }
});

// ── Existing ABHA: fetch profile via Aadhaar login when ABDM-1008 ─────────────
async function _fetchExistingAbhaProfile() {
  const aadhaar = _existingAbhaAadhaar;
  if (!aadhaar) return _setEnrollMsg('error', 'Aadhaar not available. Please re-enter.');
  const btn = document.getElementById('btn-view-existing-profile');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending OTP…'; }
  _setEnrollMsg('info', 'Sending OTP to Aadhaar-linked mobile…');
  try {
    const res = await requestAadhaarLoginOtp(aadhaar);
    _existingAadhaarTxnId = res.txnId;
    document.getElementById('enroll-aadhaar').value = '';
    document.getElementById('enroll-step-1').style.display    = 'none';
    document.getElementById('enroll-step-existing').style.display = '';
    _setEnrollMsg('info', 'OTP sent. Enter it below to view the ABHA profile.');
  } catch (err) {
    _setEnrollMsg('error', safeErrorMessage(err, 'Failed to send OTP. Please try again.'));
    if (btn) { btn.disabled = false; btn.textContent = 'View Profile →'; }
  }
}

document.getElementById('btn-existing-verify-otp').addEventListener('click', async () => {
  const otp = _getOtpValue('enroll-existing-otp-boxes');
  if (otp.length < 6)         return _setEnrollMsg('error', 'Please enter the complete 6-digit OTP.');
  if (!_existingAadhaarTxnId) return _setEnrollMsg('error', 'Session expired — please try again.');
  const btn = document.getElementById('btn-existing-verify-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setEnrollMsg('info', 'Fetching ABHA profile…');
  try {
    const prof = await verifyAadhaarLogin(_existingAadhaarTxnId, otp);
    const abha = prof?.ABHANumber ?? prof?.abhaNumber;
    if (!abha) {
      _setEnrollMsg('error', 'No ABHA found for this Aadhaar.');
      btn.disabled = false; btn.textContent = 'View ABHA Profile';
      return;
    }
    const fmt = _fmtAbha(abha);
    document.getElementById('abha').value = fmt;
    _setAbhaNote('verified', `✓ ABHA found: ${fmt}`);
    if (!document.getElementById('name').value.trim()) {
      const n = [prof.firstName, prof.middleName, prof.lastName].filter(Boolean).join(' ');
      if (n) document.getElementById('name').value = n;
    }
    _showAbhaProfile(prof, fmt, prof.tToken ?? null);
    _setEnrollMsg('success', `ABHA ${fmt} loaded successfully.`);
    await _linkAbha(prof, fmt, null, true);
    setTimeout(() => {
      enrollPanel.style.display = 'none';
      btnEnroll.textContent = '+ Enroll';
      btnEnroll.classList.remove('open');
      document.getElementById('enroll-step-existing').style.display = 'none';
      document.getElementById('enroll-step-1').style.display = '';
      _clearOtpBoxes('enroll-existing-otp-boxes');
      _existingAbhaAadhaar = null; _existingAadhaarTxnId = null;
    }, 2000);
  } catch (err) {
    _setEnrollMsg('error', safeErrorMessage(err, 'Verification failed. Please try again.'));
    btn.disabled = false; btn.textContent = 'View ABHA Profile';
  }
});

document.getElementById('btn-send-otp').addEventListener('click', async () => {
  const aadhaar = document.getElementById('enroll-aadhaar').value.trim();
  if (!/^\d{12}$/.test(aadhaar)) return _setEnrollMsg('error', 'Aadhaar must be 12 digits.');
  if (!_verhoeff(aadhaar))       return _setEnrollMsg('error', 'Invalid Aadhaar number (checksum failed). Please re-enter.');

  try { await _showConsentModal(); } catch { return; }

  const btn = document.getElementById('btn-send-otp');
  btn.disabled = true; btn.textContent = 'Sending…';
  _setEnrollMsg('info', 'Sending OTP to Aadhaar-linked mobile…');

  try {
    const res = await requestABHAOtp(aadhaar);
    _enrollTxnId         = res.txnId;
    _existingAbhaAadhaar = aadhaar;
    document.getElementById('enroll-aadhaar').value = ''; // clear Aadhaar from DOM
    document.getElementById('enroll-aadhaar').type  = 'password';
    document.getElementById('btn-toggle-aadhaar').textContent = '👁';

    // Pre-fill comm mobile from patient phone if available
    const phone = document.getElementById('phone').value.trim();
    if (phone.length === 10) document.getElementById('enroll-comm-mobile').value = phone;

    const maskedHint = res.message || 'Check your Aadhaar-linked mobile.';
    document.getElementById('enroll-otp-label').textContent = `OTP — ${maskedHint}`;
    document.getElementById('enroll-step-1').style.display  = 'none';
    document.getElementById('enroll-step-2').style.display  = '';
    document.getElementById('enroll-step-2b').style.display = 'none';
    document.getElementById('enroll-step-3').style.display  = 'none';
    _clearOtpBoxes('enroll-otp-boxes');
    document.querySelector('#enroll-otp-boxes .otp-box')?.focus();
    _setEnrollMsg('info', `✓ ${maskedHint}`);
    _enrollResendLim.arm();
  } catch (err) {
    const alreadyExists = err.message?.includes('ABHA already exists');
    if (alreadyExists) {
      _existingAbhaAadhaar = document.getElementById('enroll-aadhaar').value.trim();
      _showAbhaExistsModal(null, _fetchExistingAbhaProfile);
    } else {
      _setEnrollMsg('error', safeErrorMessage(err, 'Failed to send OTP. Please try again.'));
    }
  }
  btn.disabled = false; btn.textContent = 'Send OTP';
});

document.getElementById('btn-resend-otp').addEventListener('click', () => {
  _enrollResendLim.onResend();
  document.getElementById('enroll-step-2').style.display  = 'none';
  document.getElementById('enroll-step-2b').style.display = 'none';
  document.getElementById('enroll-step-3').style.display  = 'none';
  document.getElementById('enroll-step-1').style.display  = '';
  _clearOtpBoxes('enroll-otp-boxes');
  _clearOtpBoxes('enroll-mob-otp-boxes');
  document.getElementById('enroll-comm-mobile').value = '';
  _setEnrollMsg('', '');
  _enrollTxnId = null;
});

// Shared helper: handle ABHAProfile from finalize step (used in both CRT_ABHA_108 and 109)
async function _handleAbhaProfileCreated(res) {
  const prof = res.ABHAProfile || res.abhaProfile;
  const abha = prof?.ABHANumber || prof?.abhaNumber;
  const name = prof ? `${prof.firstName || ''} ${prof.lastName || ''}`.trim() : '';
  if (!abha) throw new Error('ABHA number not returned. Please try again.');
  const digits = abha.replace(/\D/g, '');
  const fmt = digits.length === 14
    ? digits.replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4')
    : abha;
  document.getElementById('abha').value = fmt;
  _setAbhaNote('verified', `✓ ABHA created: ${fmt}${name ? ' · ' + name : ''}`);
  _lastTToken      = res.tToken ?? null;
  _lastEnrollTxnId = res.txnId ?? null;
  _showAbhaProfile(prof, fmt, _lastTToken);
  await _linkAbha(prof, fmt, null, true); // enrollment — Aadhaar-verified, skip demographic gate
  if (_lastEnrollTxnId) {
    document.getElementById('enroll-step-2').style.display  = 'none';
    document.getElementById('enroll-step-2b').style.display = 'none';
    document.getElementById('enroll-step-3').style.display  = '';
    _setEnrollMsg('info', 'ABHA created! Now choose your ABHA Address.');
    await _loadAbhaSuggestions(_lastEnrollTxnId);
  } else {
    _setEnrollMsg('success', `ABHA ${fmt} created successfully.`);
    setTimeout(() => {
      enrollPanel.style.display = 'none';
      btnEnroll.textContent = '+ Enroll';
      btnEnroll.classList.remove('open');
    }, 2000);
  }
}

// Step 2 verify: calls enrollABHA (byAadhaar first call).
// If ABDM returns ABHAProfile → done (CRT_ABHA_108: mobiles matched).
// If ABDM returns needsMobileOtp → show Step 2.5 (CRT_ABHA_109: mobiles differ, OTP sent to comm mobile).
document.getElementById('btn-verify-otp').addEventListener('click', async () => {
  const otp    = _getOtpValue('enroll-otp-boxes');
  const mobile = document.getElementById('enroll-comm-mobile').value.trim();
  if (otp.length < 6)             return _setEnrollMsg('error', 'Please enter the complete 6-digit OTP.');
  if (!/^\d{10}$/.test(mobile))   return _setEnrollMsg('error', 'Please enter a valid 10-digit communication mobile number.');
  if (!_enrollTxnId)              return _setEnrollMsg('error', 'Session expired — please send OTP again.');
  _enrollMobile = mobile; // save for subsequent steps

  const btn = document.getElementById('btn-verify-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setEnrollMsg('info', 'Verifying OTP with ABDM…');

  try {
    const res = await enrollABHA(_enrollTxnId, otp, _enrollMobile);
    console.log('[ABDM] enrollABHA response:', JSON.stringify(res));

    // M1 spec: isNew:false — existing ABHA returned directly in response, no second OTP
    if (res.isExisting) {
      const prof = res.ABHAProfile || res.abhaProfile;
      const abha = prof?.ABHANumber ?? prof?.abhaNumber;
      document.getElementById('enroll-step-2').style.display = 'none';
      _clearOtpBoxes('enroll-otp-boxes');
      if (!abha) {
        _showAbhaExistsModal(null, _fetchExistingAbhaProfile);
        btn.disabled = false; btn.textContent = 'Verify OTP';
        return;
      }
      const fmt = _fmtAbha(abha);
      document.getElementById('abha').value = fmt;
      _setAbhaNote('verified', `✓ Existing ABHA: ${fmt}`);
      if (!document.getElementById('name').value.trim()) {
        const n = [prof.firstName, prof.middleName, prof.lastName].filter(Boolean).join(' ');
        if (n) document.getElementById('name').value = n;
      }
      await _linkAbha(prof, fmt, null, true);

      // Detect mobile mismatch between entered comm mobile and profile's registered mobile
      const profMobileClean    = (prof?.mobile ?? prof?.mobileNumber ?? '').replace(/\D/g, '').slice(-10);
      const enteredMobileClean = (_enrollMobile ?? '').replace(/\D/g, '').slice(-10);
      const mobileMismatch     = enteredMobileClean && profMobileClean && enteredMobileClean !== profMobileClean;
      const existingTToken     = res.tToken ?? null;

      _showAbhaExistsModal(
        _maskAbha(fmt),
        mobileMismatch && existingTToken
          ? async () => {
              // Show profile card
              _showAbhaProfile(prof, fmt, existingTToken);
              // Close enroll panel
              enrollPanel.style.display = 'none';
              btnEnroll.textContent = '+ Enroll';
              btnEnroll.classList.remove('open');
              // Auto-open Update Mobile panel at OTP step — no need to re-enter mobile
              const upPanel = document.getElementById('update-mobile-panel');
              upPanel.style.display = '';
              document.getElementById('upd-mob-step-1').style.display = 'none';
              document.getElementById('upd-mob-step-2').style.display = '';
              _clearOtpBoxes('upd-mob-otp-boxes');
              _updMobTxnId = null;
              document.getElementById('upd-mob-otp-label').textContent = `Sending OTP to ${_enrollMobile}…`;
              document.getElementById('upd-mob-msg').textContent = '';
              try {
                const mRes = await requestUpdateMobileOtp(existingTToken, _enrollMobile);
                _updMobTxnId = mRes.txnId;
                document.getElementById('upd-mob-otp-label').textContent =
                  mRes.message ?? `OTP sent to ${_enrollMobile} — enter below to update`;
                document.querySelector('#upd-mob-otp-boxes .otp-box')?.focus();
              } catch (mErr) {
                // OTP send failed — fall back to manual step with mobile pre-filled
                document.getElementById('upd-mob-step-1').style.display = '';
                document.getElementById('upd-mob-step-2').style.display = 'none';
                document.getElementById('upd-mob-input').value = _enrollMobile;
                document.getElementById('upd-mob-msg').textContent =
                  'Could not auto-send OTP: ' + (mErr.message || 'Enter mobile and click Send OTP.');
              }
            }
          : () => {
              _showAbhaProfile(prof, fmt, existingTToken);
              setTimeout(() => {
                enrollPanel.style.display = 'none';
                btnEnroll.textContent = '+ Enroll';
                btnEnroll.classList.remove('open');
              }, 1500);
            },
        mobileMismatch && existingTToken
          ? 'Your entered mobile differs from the registered one — click View Profile to update it.'
          : null
      );
      btn.disabled = false; btn.textContent = 'Verify OTP';
      return;
    }

    if (res.needsMobileOtp) {
      // CRT_ABHA_109: entered mobile ≠ Aadhaar-linked mobile — send OTP to comm mobile
      _pendingAbhaResponse = res;
      _lastTToken          = res.tToken;
      _setEnrollMsg('info', `Sending OTP to ${_enrollMobile}…`);
      try {
        const mobRes = await checkAndGenerateMobileOTP(res.txnId, _enrollMobile);
        _enrollTxnId = mobRes.txnId ?? res.txnId;
      } catch (mobErr) {
        _setEnrollMsg('error', 'Could not send OTP to communication mobile: ' + (mobErr.message || 'Please try again.'));
        btn.disabled = false; btn.textContent = 'Verify OTP';
        return;
      }
      document.getElementById('enroll-step-2').style.display  = 'none';
      document.getElementById('enroll-step-2b').style.display = '';
      document.getElementById('enroll-mob-otp-label').textContent = `Mobile OTP — sent to ${_enrollMobile}`;
      _setEnrollMsg('info', `OTP sent to ${_enrollMobile}. Enter it to complete ABHA setup.`);
    } else {
      // CRT_ABHA_108: mobiles matched — ABHAProfile returned directly
      await _handleAbhaProfileCreated(res);
    }

  } catch (err) {
    const alreadyExists = err.message?.includes('ABHA already exists');
    if (alreadyExists) {
      document.getElementById('enroll-step-2').style.display = 'none';
      _clearOtpBoxes('enroll-otp-boxes');
      _showAbhaExistsModal(null, _fetchExistingAbhaProfile);
    } else {
      _setEnrollMsg('error', safeErrorMessage(err, 'Enrollment failed. Please try again.'));
    }
  }

  btn.disabled = false; btn.textContent = 'Verify OTP';
});

// Step 2.5: verify comm mobile OTP (CRT_ABHA_109 — mobile ≠ Aadhaar-linked)
document.getElementById('btn-verify-mobile-otp').addEventListener('click', async () => {
  const mobileOtp = _getOtpValue('enroll-mob-otp-boxes');
  if (mobileOtp.length < 6) return _setEnrollMsg('error', 'Please enter the complete 6-digit OTP.');
  if (!_enrollTxnId)         return _setEnrollMsg('error', 'Session expired — please restart enrollment.');

  const btn = document.getElementById('btn-verify-mobile-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setEnrollMsg('info', 'Verifying communication mobile OTP…');

  try {
    await verifyCommMobileOtp(_enrollTxnId, mobileOtp);
    await _handleAbhaProfileCreated(_pendingAbhaResponse);
    _pendingAbhaResponse = null;
  } catch (err) {
    _setEnrollMsg('error', safeErrorMessage(err, 'Verification failed. Please try again.'));
  }

  btn.disabled = false; btn.textContent = 'Verify & Complete ABHA';
});

// ── Enrollment Step 3: ABHA Address ───────────────
async function _loadAbhaSuggestions(txnId) {
  const list = document.getElementById('abha-suggestions-list');
  list.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Loading suggestions…</div>';
  try {
    const res   = await getAbhaSuggestions(txnId);
    const addrs = res.abhaAddressList ?? res.ABHAAddressList ?? [];
    if (!addrs.length) { list.innerHTML = ''; return; }
    list.innerHTML = addrs.map((a, i) =>
      `<div class="abha-sug-item${i===0?' selected':''}" data-addr="${a}" data-onclick="_selectSuggestedAddr" data-onclick-a0="@this">
        <input type="radio" name="abha-sug" value="${a}"${i===0?' checked':''}/>
        <span class="abha-sug-text">${a}</span>
      </div>`
    ).join('');
  } catch {
    list.innerHTML = '';
  }
}

window._selectSuggestedAddr = (el) => {
  document.querySelectorAll('.abha-sug-item').forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
  el.querySelector('input').checked = true;
  document.getElementById('enroll-custom-addr').value = '';
};

document.getElementById('btn-set-abha-addr').addEventListener('click', async () => {
  const selected = document.querySelector('.abha-sug-item.selected input');
  const custom   = document.getElementById('enroll-custom-addr').value.trim();
  const chosen   = custom || selected?.value;
  if (!chosen)       return _setEnrollMsg('error', 'Please select or enter an ABHA address.');
  if (!_lastEnrollTxnId) return _setEnrollMsg('error', 'Session expired. Please restart enrollment.');

  const btn = document.getElementById('btn-set-abha-addr');
  btn.disabled = true; btn.textContent = 'Setting…';

  try {
    const addrResult = await setAbhaAddress(_lastEnrollTxnId, chosen);
    const savedAddr = addrResult?.preferredAbhaAddress ?? (chosen + '@sbx');
    document.getElementById('abha-prof-address').textContent = savedAddr;
    _setEnrollMsg('success', `✓ ABHA Address set: ${savedAddr}`);
    if (_patient?.id) {
      await supabase.from('patients').update({ abha_address: savedAddr }).eq('id', _patient.id);
    }
    setTimeout(() => {
      enrollPanel.style.display = 'none';
      btnEnroll.textContent = '+ Enroll';
      btnEnroll.classList.remove('open');
    }, 2000);
  } catch (err) {
    _setEnrollMsg('error', safeErrorMessage(err, 'Failed to set address. Please try again.'));
  }

  btn.disabled = false; btn.textContent = 'Set ABHA Address';
});

function _setEnrollMsg(type, msg) {
  const el = document.getElementById('enroll-msg');
  el.textContent = msg;
  el.className = `enroll-msg${type ? ' show ' + type : ''}`;
}

// ── ABHA Verify (existing ABHA holder) ────────────
let _verifyTxnId = null;

const btnVerifyAbha = document.getElementById('btn-verify-abha');
const verifyPanel   = document.getElementById('abha-verify-panel');

function _closeAllAbhaPanels() {
  enrollPanel.style.display = 'none';
  btnEnroll.textContent = '+ Enroll';
  btnEnroll.classList.remove('open');
  verifyPanel.style.display = 'none';
  btnVerifyAbha.textContent = 'Verify';
  btnVerifyAbha.classList.remove('open');
  document.getElementById('abha-find-panel').style.display = 'none';
  document.getElementById('btn-find-abha').textContent = '🔍 Patient has ABHA but no card? Fetch by mobile →';
  document.getElementById('btn-find-abha').classList.remove('open');
  _verifyResendLim.reset(); _aadResendLim.reset(); _mobResendLim.reset(); _addrResendLim.reset(); _enrollResendLim.reset();
  _closeScanPanel();
}

btnVerifyAbha.addEventListener('click', () => {
  const isOpen = verifyPanel.style.display !== 'none';
  _closeAllAbhaPanels();
  if (!isOpen) {
    verifyPanel.style.display = '';
    btnVerifyAbha.textContent = '✕ Cancel';
    btnVerifyAbha.classList.add('open');
    document.getElementById('verify-abha-input').value = '';
    document.getElementById('verify-otp').value = '';
    document.getElementById('verify-step-1').style.display = '';
    document.getElementById('verify-step-2').style.display = 'none';
    _setVerifyMsg('', '');
    _verifyTxnId = null;
  }
});

// ── Find ABHA panel (standalone — separate from Verify) ──────────────────────
const btnFindAbha = document.getElementById('btn-find-abha');
const findPanel   = document.getElementById('abha-find-panel');

btnFindAbha.addEventListener('click', () => {
  const isOpen = findPanel.style.display !== 'none';
  _closeAllAbhaPanels();
  if (!isOpen) {
    findPanel.style.display = '';
    btnFindAbha.textContent = '✕ Cancel fetch';
    btnFindAbha.classList.add('open');
    document.getElementById('find-mobile-input').value = '';
    document.getElementById('find-step-1').style.display = '';
    document.getElementById('find-step-2').style.display = 'none';
    document.getElementById('find-step-3').style.display = 'none';
    document.getElementById('find-no-abha-hint').style.display = 'none';
    _setFindMsg('', '');
    _findMobileTxnId = null; _findTToken = null; _findVerifyTxnId = null;
    _findSelectedAbha = null; _findAccounts = [];
  }
});

function _setFindMsg(type, msg) {
  const el = document.getElementById('find-msg');
  el.textContent = msg;
  el.className = `enroll-msg${type ? ' show ' + type : ''}`;
}

// Find ABHA panel — official private-integrator VRFY_ABHA_301 flow:
// Step 1: Mobile → sendMobileLoginOtp → OTP sent to ABHA-linked mobile
// Step 2: OTP → verifyMobileLoginOtp → accounts[] + T-token from /login/verify
//   If 1 account: auto-call loginVerifyUser → full profile → auto-fill
//   If multiple:  show account picker → user confirms → loginVerifyUser → auto-fill
let _findMobileTxnId  = null;   // txnId from sendMobileLoginOtp
let _findTToken        = null;   // T-token from verifyMobileLoginOtp (valid 5 min)
let _findVerifyTxnId  = null;   // txnId from verifyMobileLoginOtp (for loginVerifyUser)
let _findSelectedAbha = null;   // ABHA account object selected by user
let _findAccounts     = [];     // accounts[] from verifyMobileLoginOtp

// Step 1: Enter mobile → send OTP via /profile/login/request/otp (VRFY_ABHA_301)
document.getElementById('btn-find-search').addEventListener('click', async () => {
  const mobile = document.getElementById('find-mobile-input').value.trim();
  if (!/^\d{10}$/.test(mobile)) return _setFindMsg('error', 'Mobile must be 10 digits.');
  const btn = document.getElementById('btn-find-search');
  btn.disabled = true; btn.textContent = 'Sending OTP…';
  document.getElementById('find-no-abha-hint').style.display = 'none';
  _setFindMsg('info', 'Sending OTP to registered mobile…');
  try {
    const res = await sendMobileLoginOtp(mobile);
    _findMobileTxnId = res.txnId;
    document.getElementById('find-otp').value = '';
    document.getElementById('find-otp-label').textContent = res.message || 'OTP sent to ABHA-linked mobile';
    document.getElementById('find-step-1').style.display = 'none';
    document.getElementById('find-step-3').style.display = '';
    _setFindMsg('info', '✓ OTP sent. Enter the OTP the patient received.');
  } catch (err) {
    _setFindMsg('error', safeErrorMessage(err, 'Could not send OTP.'));
    document.getElementById('find-no-abha-hint').style.display = '';
  }
  btn.disabled = false; btn.textContent = 'Send OTP';
});

window._selectFindAbha = (el, idx) => {
  document.querySelectorAll('#find-accounts-list .abha-acc-item').forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
  _findSelectedAbha = _findAccounts[idx];
};

// "Change Mobile" in account picker → back to step 1
document.getElementById('btn-find-change-mobile').addEventListener('click', () => {
  document.getElementById('find-step-2').style.display = 'none';
  document.getElementById('find-step-1').style.display = '';
  document.getElementById('find-mobile-input').value = '';
  _findMobileTxnId = null; _findTToken = null; _findVerifyTxnId = null;
  _findSelectedAbha = null; _findAccounts = [];
  _setFindMsg('', '');
});

// "Resend OTP" in OTP step → back to step 1 to re-enter mobile
document.getElementById('btn-find-resend').addEventListener('click', () => {
  document.getElementById('find-step-3').style.display = 'none';
  document.getElementById('find-step-1').style.display = '';
  document.getElementById('find-mobile-input').value = '';
  _findMobileTxnId = null; _findTToken = null; _findVerifyTxnId = null;
  _findSelectedAbha = null; _findAccounts = [];
  _setFindMsg('info', 'Enter the patient\'s mobile number.');
});

// Step 2: Verify OTP → /login/verify returns accounts[] + T-token
document.getElementById('btn-find-verify-otp').addEventListener('click', async () => {
  const otp = document.getElementById('find-otp').value.trim();
  if (!otp || !_findMobileTxnId)
    return _setFindMsg('error', !otp ? 'Enter OTP.' : 'Session expired. Enter mobile again.');
  const btn = document.getElementById('btn-find-verify-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setFindMsg('info', 'Verifying OTP with ABDM…');
  try {
    const res = await verifyMobileLoginOtp(_findMobileTxnId, otp);
    const accounts = res.accounts ?? [];
    if (!accounts.length) throw new Error('No ABHA linked to this mobile number.');
    _findTToken      = res.token ?? null;
    _findVerifyTxnId = res.txnId ?? _findMobileTxnId;
    _findAccounts    = accounts;
    if (accounts.length === 1) {
      _setFindMsg('info', 'ABHA found — auto-filling details…');
      await _applyFindAccount(accounts[0]);
    } else {
      _findSelectedAbha = accounts[0];
      document.getElementById('find-accounts-list').innerHTML = accounts.map((a, i) =>
        `<div class="abha-acc-item${i===0?' selected':''}" data-abha="${a.ABHANumber}"
              data-onclick="_selectFindAbha" data-onclick-a0="@this" data-onclick-a1="${i}">
          <div class="abha-acc-num">${a.ABHANumber ?? '—'}</div>
          <div class="abha-acc-info">${a.name ?? ''} · ${{ M:'Male', F:'Female', O:'Other' }[a.gender] ?? (a.gender ?? '')}</div>
        </div>`
      ).join('');
      document.getElementById('find-step-3').style.display = 'none';
      document.getElementById('find-step-2').style.display = '';
      _setFindMsg('info', `${accounts.length} ABHAs found — select the patient's account.`);
    }
  } catch (err) { _setFindMsg('error', safeErrorMessage(err, 'Verification failed. Please try again.')); }
  btn.disabled = false; btn.textContent = 'Fetch ABHA Details';
});

// Step 3 (multi-ABHA only): Confirm account selection → auto-fill from accounts[] data
document.getElementById('btn-find-confirm').addEventListener('click', async () => {
  if (!_findSelectedAbha)
    return _setFindMsg('error', 'Session expired. Enter mobile again.');
  const btn = document.getElementById('btn-find-confirm');
  btn.disabled = true; btn.textContent = 'Confirming…';
  try {
    await _applyFindAccount(_findSelectedAbha);
  } catch (err) { _setFindMsg('error', safeErrorMessage(err, 'Could not apply profile.')); }
  btn.disabled = false; btn.textContent = 'Confirm Selection';
});

async function _applyFindAccount(account) {
  const abha = account.ABHANumber ?? account.abhaNumber;
  if (!abha) { _setFindMsg('error', 'ABHA number not returned.'); return; }
  const fmt = _fmtAbha(abha);
  // Auto-fill ABHA number field
  document.getElementById('abha').value = fmt;
  _setAbhaNote('verified', `✓ ABHA fetched via mobile: ${fmt}`);
  // Auto-fill demographic fields if blank
  const fullName = account.name ?? [account.firstName, account.middleName, account.lastName].filter(Boolean).join(' ');
  if (fullName && !document.getElementById('name').value.trim())
    document.getElementById('name').value = fullName;
  // Map to profile format for _showAbhaProfile
  const nameParts = (fullName ?? '').trim().split(/\s+/);
  const prof = {
    firstName:  nameParts[0] ?? '',
    middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
    lastName:   nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
    dob: account.dob, gender: account.gender,
    ABHANumber: abha, healthIdNumber: abha,
    profilePhoto: account.profilePhoto,
    preferredAbhaAddress: account.preferredAbhaAddress,
  };
  _showAbhaProfile(prof, fmt, account.tToken ?? null);
  _setFindMsg('success', `✓ ABHA ${fmt} — demographics auto-filled.`);
  await _linkAbha(prof, fmt);
  setTimeout(() => {
    findPanel.style.display = 'none';
    btnFindAbha.textContent = '🔍 Patient has ABHA but no card? Fetch by mobile →';
    btnFindAbha.classList.remove('open');
  }, 2500);
}

document.getElementById('btn-verify-send-otp').addEventListener('click', async () => {
  const raw    = document.getElementById('verify-abha-input').value.trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 14) return _setVerifyMsg('error', 'Please enter a valid 14-digit ABHA number.');

  const btn = document.getElementById('btn-verify-send-otp');
  btn.disabled = true; btn.textContent = 'Sending…';
  _setVerifyMsg('info', 'Sending OTP to ABDM-linked mobile…');

  try {
    const res    = await requestABHALoginOtp(digits);
    _verifyTxnId = res.txnId;
    document.getElementById('verify-step-2').style.display = '';
    _setVerifyMsg('info', `✓ OTP sent. ${res.message || 'Check ABDM-linked mobile.'}`);
    _verifyResendLim.arm();
  } catch (err) {
    _setVerifyMsg('error', safeErrorMessage(err, 'Failed to send OTP. Please try again.'));
  }

  btn.disabled = false; btn.textContent = 'Send OTP';
});

document.getElementById('btn-verify-resend').addEventListener('click', () => {
  _verifyResendLim.onResend();
  document.getElementById('verify-step-2').style.display = 'none';
  document.getElementById('verify-step-1').style.display = '';
  _setVerifyMsg('', '');
  _verifyTxnId = null;
});

document.getElementById('btn-verify-confirm-otp').addEventListener('click', async () => {
  const otp = document.getElementById('verify-otp').value.trim();
  if (!otp)          return _setVerifyMsg('error', 'Please enter the OTP.');
  if (!_verifyTxnId) return _setVerifyMsg('error', 'Session expired — please send OTP again.');

  const btn = document.getElementById('btn-verify-confirm-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setVerifyMsg('info', 'Verifying OTP with ABDM…');

  try {
    const prof = await verifyABHALogin(_verifyTxnId, otp);
    const abha = prof?.ABHANumber ?? prof?.abhaNumber ?? prof?.healthIdNumber;
    const name = [prof?.firstName, prof?.middleName, prof?.lastName].filter(Boolean).join(' ') || prof?.name;

    if (!abha) throw new Error('ABHA number not returned. Please try again.');

    const digits2 = String(abha).replace(/\D/g, '');
    const fmt = digits2.length === 14
      ? digits2.replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4')
      : abha;

    document.getElementById('abha').value = fmt;
    _setAbhaNote('verified', `✓ ABHA verified: ${fmt}${name ? ' · ' + name : ''}`);

    if (name && !document.getElementById('name').value.trim()) {
      document.getElementById('name').value = name;
    }
    _showAbhaProfile(prof, fmt, prof.tToken);
    _setVerifyMsg('success', `ABHA ${fmt} verified.`);
    await _linkAbha(prof, fmt);
    setTimeout(() => { verifyPanel.style.display='none'; btnVerifyAbha.textContent='Verify'; btnVerifyAbha.classList.remove('open'); }, 2000);

  } catch (err) {
    _setVerifyMsg('error', safeErrorMessage(err, 'Verification failed. Please try again.'));
  }

  btn.disabled = false; btn.textContent = 'Verify ABHA';
});

function _setVerifyMsg(type, msg) {
  const el = document.getElementById('verify-msg');
  el.textContent = msg;
  el.className = `enroll-msg${type ? ' show ' + type : ''}`;
}

// ── Verify tabs: method switching ─────────────────
document.querySelectorAll('.verify-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.verify-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.verify-method').forEach(m => m.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.vm).classList.add('active');
    _setVerifyMsg('', '');
  });
});

// ── Verify: Aadhaar Number flow ───────────────────
let _aadTxnId = null;
document.getElementById('btn-aad-send-otp').addEventListener('click', async () => {
  const aadhaar = document.getElementById('verify-aadhaar-input').value.trim();
  if (!/^\d{12}$/.test(aadhaar))  return _setVerifyMsg('error', 'Aadhaar must be 12 digits.');
  if (!_verhoeff(aadhaar))        return _setVerifyMsg('error', 'Invalid Aadhaar number (checksum failed).');
  const btn = document.getElementById('btn-aad-send-otp');
  btn.disabled = true; btn.textContent = 'Sending…';
  _setVerifyMsg('info', 'Sending OTP to Aadhaar-linked mobile…');
  try {
    const res = await requestAadhaarLoginOtp(aadhaar);
    _aadTxnId = res.txnId;
    document.getElementById('verify-aadhaar-input').value = ''; // clear Aadhaar
    document.getElementById('aad-step-1').style.display = 'none';
    document.getElementById('aad-step-2').style.display = '';
    document.getElementById('aad-no-abha-hint').style.display = 'none';
    _setVerifyMsg('info', `✓ OTP sent. ${res.message || 'Check Aadhaar-linked mobile.'}`);
    _aadResendLim.arm();
  } catch (err) { _setVerifyMsg('error', safeErrorMessage(err)); }
  btn.disabled = false; btn.textContent = 'Send OTP';
});
document.getElementById('btn-aad-resend').addEventListener('click', () => {
  _aadResendLim.onResend();
  document.getElementById('aad-step-2').style.display = 'none';
  document.getElementById('aad-step-1').style.display = '';
  _setVerifyMsg('', ''); _aadTxnId = null;
});
document.getElementById('btn-aad-verify-otp').addEventListener('click', async () => {
  const otp = document.getElementById('aad-otp').value.trim();
  if (!otp || !_aadTxnId) return _setVerifyMsg('error', !otp ? 'Enter OTP.' : 'Session expired.');
  const btn = document.getElementById('btn-aad-verify-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setVerifyMsg('info', 'Verifying with ABDM…');
  try {
    const prof = await verifyAadhaarLogin(_aadTxnId, otp);
    const abha = prof?.ABHANumber ?? prof?.abhaNumber;
    if (!abha) {
      _setVerifyMsg('error', 'No ABHA registered for this Aadhaar.');
      document.getElementById('aad-no-abha-hint').style.display = '';
      btn.disabled = false; btn.textContent = 'Verify Aadhaar';
      return;
    }
    const fmt  = _fmtAbha(abha);
    document.getElementById('abha').value = fmt;
    _setAbhaNote('verified', `✓ ABHA verified via Aadhaar: ${fmt}`);
    if (document.getElementById('name').value.trim() === '') {
      const n = [prof.firstName, prof.middleName, prof.lastName].filter(Boolean).join(' ');
      if (n) document.getElementById('name').value = n;
    }
    _showAbhaProfile(prof, fmt, prof.tToken);
    _setVerifyMsg('success', `ABHA ${fmt} verified.`);
    await _linkAbha(prof, fmt, null, true); // Aadhaar-verified — skip demographic gate
    setTimeout(() => { verifyPanel.style.display='none'; btnVerifyAbha.textContent='Verify'; btnVerifyAbha.classList.remove('open'); }, 2000);
  } catch (err) { _setVerifyMsg('error', safeErrorMessage(err, 'Verification failed. Please try again.')); }
  btn.disabled = false; btn.textContent = 'Verify Aadhaar';
});

// ── Verify: Mobile Number flow (Send OTP → verify → link) ────────────────────
// Step 1: Enter mobile → Send OTP → mob-step-3 (OTP input)
// Step 2: Verify OTP → accounts list; if multiple → mob-step-2 picker
let _mobOtpTxn       = null;
let _mobAccounts     = [];
let _mobVerifyTToken = null;   // T-token from verifyMobileLoginOtp (used by loginVerifyUser)
let _mobVerifyTxnId  = null;   // txnId for loginVerifyUser step

document.getElementById('btn-mob-search').addEventListener('click', async () => {
  const mobile = document.getElementById('verify-mobile-input').value.trim();
  if (!/^\d{10}$/.test(mobile)) return _setVerifyMsg('error', 'Mobile must be 10 digits.');
  const btn = document.getElementById('btn-mob-search');
  btn.disabled = true; btn.textContent = 'Sending OTP…';
  document.getElementById('mob-no-abha-hint').style.display = 'none';
  _setVerifyMsg('info', 'Sending OTP to mobile…');
  try {
    const res = await sendMobileLoginOtp(mobile);
    _mobOtpTxn = res.txnId;
    document.getElementById('mob-step-1').style.display = 'none';
    document.getElementById('mob-step-3').style.display = '';
    _setVerifyMsg('info', res.message || '✓ OTP sent to your registered mobile.');
    _mobResendLim.arm();
  } catch (err) {
    _setVerifyMsg('error', safeErrorMessage(err, 'Failed to send OTP.'));
    document.getElementById('mob-no-abha-hint').style.display = '';
  }
  btn.disabled = false; btn.textContent = 'Send OTP';
});

// Account picker (mob-step-2): shown after verify when multiple accounts returned
window._selectMobAccount = (el, idx) => {
  document.querySelectorAll('.abha-acc-item').forEach(x => x.style.borderColor='');
  el.style.borderColor = 'var(--green-mid)';
  document.getElementById('mob-step-2').style.display = 'none';
  _handleMobileAccount(_mobAccounts[idx]);
};

async function _handleMobileAccount(account) {
  const abha = account.ABHANumber ?? account.abhaNumber;
  if (!abha) { _setVerifyMsg('error', 'ABHA number not returned.'); return; }
  const fmt = _fmtAbha(abha);
  document.getElementById('abha').value = fmt;
  _setAbhaNote('verified', `✓ ABHA verified via Mobile: ${fmt}`);
  const nameParts = (account.name ?? '').trim().split(/\s+/);
  const prof = {
    firstName:  nameParts[0] ?? '',
    middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
    lastName:   nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
    dob: account.dob, gender: account.gender,
    ABHANumber: abha, healthIdNumber: abha,
    profilePhoto: account.profilePhoto,
    preferredAbhaAddress: account.preferredAbhaAddress,
  };
  if (document.getElementById('name').value.trim() === '' && account.name)
    document.getElementById('name').value = account.name;
  _showAbhaProfile(prof, fmt, null);
  _setVerifyMsg('success', `ABHA ${fmt} verified.`);
  await _linkAbha(prof, fmt);
  setTimeout(() => { verifyPanel.style.display='none'; btnVerifyAbha.textContent='Verify'; btnVerifyAbha.classList.remove('open'); }, 2000);
}

document.getElementById('btn-mob-resend').addEventListener('click', () => {
  _mobResendLim.onResend();
  document.getElementById('mob-step-3').style.display = 'none';
  document.getElementById('mob-step-2').style.display = 'none';
  document.getElementById('mob-step-1').style.display = '';
  _setVerifyMsg('', ''); _mobOtpTxn = null; _mobAccounts = []; _mobVerifyTToken = null; _mobVerifyTxnId = null;
});

document.getElementById('btn-mob-verify-otp').addEventListener('click', async () => {
  const otp = document.getElementById('mob-otp').value.trim();
  if (!otp || !_mobOtpTxn) return _setVerifyMsg('error', !otp ? 'Enter OTP.' : 'Session expired.');
  const btn = document.getElementById('btn-mob-verify-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setVerifyMsg('info', 'Verifying with ABDM…');
  try {
    const res = await verifyMobileLoginOtp(_mobOtpTxn, otp);
    const accounts = res.accounts ?? [];
    if (!accounts.length) throw new Error('No ABHA accounts found for this mobile.');
    _mobVerifyTToken = res.token ?? res.tokens?.token ?? null;
    _mobVerifyTxnId  = res.txnId ?? _mobOtpTxn;
    if (accounts.length === 1) {
      await _handleMobileAccount(accounts[0]);
    } else {
      _mobAccounts = accounts;
      document.getElementById('mob-step-3').style.display = 'none';
      document.getElementById('mob-step-2').style.display = '';
      document.getElementById('mob-accounts-list').innerHTML = accounts.map((a, i) =>
        `<div class="abha-acc-item" data-index="${i}" data-onclick="_selectMobAccount" data-onclick-a0="@this" data-onclick-a1="${i}">
          <div class="abha-acc-num">${a.ABHANumber ?? a.abhaNumber ?? '—'}</div>
          <div class="abha-acc-info">${a.name ?? ''} · ${a.gender ?? ''}</div>
        </div>`
      ).join('');
      _setVerifyMsg('info', `${accounts.length} ABHAs linked to this mobile. Select yours.`);
    }
  } catch (err) { _setVerifyMsg('error', safeErrorMessage(err, 'Verification failed. Please try again.')); }
  btn.disabled = false; btn.textContent = 'Verify & Get Profile';
});

// ── Verify: ABHA Address flow (PHR login) ─────────
let _addrTxnId    = null;
let _addrAccToken = null;
document.getElementById('btn-addr-search').addEventListener('click', async () => {
  const addr = document.getElementById('verify-addr-input').value.trim();
  if (!addr.includes('@')) return _setVerifyMsg('error', 'Enter a valid ABHA address (e.g. name@abdm).');
  const btn = document.getElementById('btn-addr-search');
  btn.disabled = true; btn.textContent = 'Searching…';
  _setVerifyMsg('info', 'Searching ABHA address…');
  try {
    const searchRes = await searchAbhaAddress(addr);
    if (!searchRes.abhaAddress && !searchRes.status) throw new Error('ABHA address not found in ABDM records.');
    // Search only confirms address exists — send OTP using the ABHA address itself as loginId
    const initRes = await initAbhaAddressLogin(addr);
    _addrTxnId = initRes.txnId ?? initRes.transactionId;
    if (!_addrTxnId) throw new Error('Could not send OTP. Please try again.');
    document.getElementById('addr-step-1').style.display = 'none';
    document.getElementById('addr-step-2').style.display = '';
    _setVerifyMsg('info', `✓ OTP sent to registered mobile for ${addr}.`);
    _addrResendLim.arm();
  } catch (err) { _setVerifyMsg('error', safeErrorMessage(err)); }
  btn.disabled = false; btn.textContent = 'Search & Send OTP';
});
document.getElementById('btn-addr-resend').addEventListener('click', () => {
  _addrResendLim.onResend();
  document.getElementById('addr-step-2').style.display = 'none';
  document.getElementById('addr-step-1').style.display = '';
  _setVerifyMsg('', ''); _addrTxnId = null;
});
document.getElementById('btn-addr-verify-otp').addEventListener('click', async () => {
  const otp = document.getElementById('addr-otp').value.trim();
  if (!otp || !_addrTxnId) return _setVerifyMsg('error', !otp ? 'Enter OTP.' : 'Session expired.');
  const btn = document.getElementById('btn-addr-verify-otp');
  btn.disabled = true; btn.textContent = 'Verifying…';
  _setVerifyMsg('info', 'Verifying with ABDM…');
  try {
    const res  = await verifyAbhaAddressOtp(_addrTxnId, otp);
    const prof = res.patient ?? res.profile ?? res;
    _addrAccToken = res.accessToken ?? null;
    const abha = prof?.healthIdNumber ?? prof?.ABHANumber ?? prof?.abhaNumber;
    const fmt  = abha ? _fmtAbha(abha) : document.getElementById('abha').value;
    if (fmt) { document.getElementById('abha').value = fmt; _setAbhaNote('verified', `✓ ABHA Address verified: ${fmt}`); }
    if (document.getElementById('name').value.trim() === '') {
      const n = [prof?.firstName, prof?.middleName, prof?.lastName].filter(Boolean).join(' ') || prof?.name;
      if (n) document.getElementById('name').value = n;
    }
    _showAbhaProfile(prof, fmt || '—', null);
    _setVerifyMsg('success', 'ABHA Address verified successfully.');
    if (fmt) await _linkAbha(prof, fmt, _currentVisitId);
    setTimeout(() => { verifyPanel.style.display='none'; btnVerifyAbha.textContent='Verify'; btnVerifyAbha.classList.remove('open'); }, 2000);
  } catch (err) { _setVerifyMsg('error', safeErrorMessage(err, 'Verification failed. Please try again.')); }
  btn.disabled = false; btn.textContent = 'Verify & Get Profile';
});

// ── M2: ABDM care context helpers ────────────────────────────
const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';
const _abdmLinkedVisits = new Set(); // dedup — one notification per visit

// Scenario 1: patient has ABHA — HIP initiated linking
async function _abdmLinkTokenAfterVerify(patientId, abhaNumber, visitId) {
  if (!visitId || _abdmLinkedVisits.has(visitId)) return;
  _abdmLinkedVisits.add(visitId);
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` };
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const careContextRef = `VISIT-${visitId}`;
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        action: 'create_care_context', patient_id: patientId, visit_id: visitId,
        care_context_ref: careContextRef, display: `OPD Visit - ${dateStr}`,
        hi_types: ['OPConsultation', 'Prescription', 'DiagnosticReport'], abha_number: abhaNumber,
      }),
    });
    const ltRes = await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        action: 'generate_link_token', patient_id: patientId, abha_number: abhaNumber,
        visit_id: visitId,
        care_contexts: [{ referenceNumber: careContextRef, display: `OPD Visit - ${dateStr}`, hiType: 'OPConsultation' }],
      }),
    });
    if (ltRes.ok) _alert('info', 'Health record link notification sent to patient\'s ABHA app.');
  } catch (e) { console.warn('ABDM link token (reception):', e?.message); }
}

// Scenario 2: no ABHA — send SMS deep-link for patient-initiated discovery.
// V3 spec: sms/notify2 only needs { notification: { hip, phoneNo } }.
// ABDM sends SMS; PHR app guides patient to create ABHA + discover records.
async function _abdmSmsNotifyNoAbha(patientId, phone, patientName, visitId) {
  if (!visitId || !phone) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    const h = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` };
    const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const ccRef   = `VISIT-${visitId}`;

    // Step 1: store care context in DB so it's ready when patient discovers via PHR app
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        action: 'create_care_context', patient_id: patientId, visit_id: visitId,
        care_context_ref: ccRef, display: `OPD Visit - ${dateStr}`,
        hi_types: ['OPConsultation', 'Prescription', 'DiagnosticReport'],
      }),
    });

    // Step 2: send SMS via ABDM — only phone + hip needed per V3 spec
    await fetch(ABDM_HIP_FN, {
      method: 'POST', headers: h,
      body: JSON.stringify({ action: 'sms_notify', phone }),
    });
  } catch (e) { console.warn('ABDM SMS notify (reception):', e?.message); }
}

// ── Helper: format ABHA number ────────────────────
function _fmtAbha(raw) {
  const d = String(raw).replace(/\D/g, '');
  return d.length === 14 ? d.replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4') : raw;
}

// ── Scan & Share ──────────────────────────────────
let _scanSubscription = null;
let _scanRequestId    = null;

const btnScanAbha = document.getElementById('btn-scan-abha');
const scanPanel   = document.getElementById('abha-scan-panel');

btnScanAbha.addEventListener('click', async () => {
  const isOpen = scanPanel.style.display !== 'none';
  _closeAllAbhaPanels();
  if (!isOpen) {
    scanPanel.style.display = '';
    btnScanAbha.textContent = '✕ Close';
    btnScanAbha.classList.add('open');
    const counterId = (document.getElementById('scan-counter-id').value || 'OPD1').trim().toUpperCase();
    await _startScanSession(counterId);
  }
});

document.getElementById('btn-scan-refresh').addEventListener('click', async () => {
  if (_scanSubscription) { supabase.removeChannel(_scanSubscription); _scanSubscription = null; }
  const counterId = (document.getElementById('scan-counter-id').value || 'OPD1').trim().toUpperCase();
  document.getElementById('scan-counter-id').value = counterId;
  await _startScanSession(counterId);
});

async function _startScanSession(counterId) {
  const { data: tenant } = await supabase
    .from('tenants').select('hfr_id')
    .eq('id', tenantId).single();
  const hipId     = tenant?.hfr_id || 'IN2910002132';
  // Use NHPR counter ID (e.g. OPD1, IPD1) — must match counterid in NHPR-generated QR
  const requestId = counterId || 'OPD1';
  const expiry    = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Upsert — handles both first-time create and refresh of stale session
  await supabase.from('abdm_scan_sessions').upsert({
    tenant_id:       tenantId,
    request_id:      requestId,
    hip_id:          hipId,
    status:          'pending',
    expires_at:      expiry,
    patient_profile: null,
  }, { onConflict: 'request_id' });

  _scanRequestId = requestId;

  // QR URL per ABDM PHR v3 — /phr/v3/share-profile with hyphenated params
  const phrBase  = 'https://phrsbx.abdm.gov.in'; // → phr.abdm.gov.in in production
  const qrPayload = `${phrBase}/phr/v3/share-profile?hip-id=${encodeURIComponent(hipId)}&counter-id=${encodeURIComponent(requestId)}`;
  const qrContainer  = document.getElementById('scan-qr-canvas');
  qrContainer.innerHTML = '';
  try {
    new window.QRCode(qrContainer, {
      text:       qrPayload,
      width:      180,
      height:     180,
      colorDark:  '#1a4a2e',
      colorLight: '#ffffff',
    });
  } catch (e) {
    console.error('QR generation failed:', e);
    qrContainer.innerHTML = '<div style="color:#c00;font-size:11px;padding:8px">QR failed — refresh and try again.</div>';
  }

  document.getElementById('scan-status').className = 'scan-status waiting';
  document.getElementById('scan-status-text').textContent = 'Waiting for patient to scan…';

  _scanSubscription = supabase
    .channel(`scan-${requestId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'abdm_scan_sessions',
      filter: `request_id=eq.${requestId}`,
    }, (payload) => {
      if (payload.new?.status === 'received') {
        _onScanReceived(payload.new.patient_profile);
      }
    })
    .subscribe();

  // Expire after 10 min
  setTimeout(() => {
    if (_scanRequestId === requestId && scanPanel.style.display !== 'none') {
      document.getElementById('scan-status').className = 'scan-status';
      document.getElementById('scan-status-text').textContent = 'QR expired. Click Scan QR to try again.';
    }
  }, 10 * 60 * 1000);
}

function _onScanReceived(profile) {
  if (!profile) return;

  // §7.3.1: abhaNumber may be a number; fallback to older field names
  const rawAbha = profile?.healthIdNumber ?? profile?.ABHANumber ?? profile?.abhaNumber;
  const name    = [profile?.firstName, profile?.middleName, profile?.lastName]
    .filter(Boolean).join(' ') || profile?.name;

  // §7.3.1 sends dayOfBirth/monthOfBirth/yearOfBirth separately; construct ISO string
  const dobStr = (profile?.dayOfBirth && profile?.monthOfBirth && profile?.yearOfBirth)
    ? `${String(profile.yearOfBirth).padStart(4, '0')}-${String(profile.monthOfBirth).padStart(2, '0')}-${String(profile.dayOfBirth).padStart(2, '0')}`
    : (profile?.dateOfBirth ?? profile?.dob ?? profile?.yearOfBirth ?? null);

  // §7.3.1 uses abhaAddress; older flows used healthId/phrAddress
  const abhaAddr = profile?.abhaAddress ?? profile?.healthId ?? profile?.phrAddress?.[0] ?? null;

  if (rawAbha) {
    const digits = String(rawAbha).replace(/\D/g, '');
    const fmt = digits.length === 14
      ? digits.replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4')
      : rawAbha;
    document.getElementById('abha').value = fmt;
    _setAbhaNote('verified', `✓ Scanned: ${fmt}${name ? ' · ' + name : ''}`);
    _showAbhaProfile({
      firstName:  profile?.firstName, middleName: profile?.middleName, lastName: profile?.lastName,
      name:       name,
      dob:        dobStr,
      gender:     profile?.gender,
      mobile:     profile?.mobile ?? profile?.mobileNumber ?? profile?.phoneNumber ?? '',
      abhaAddress: abhaAddr,
      phrAddress: abhaAddr ? [abhaAddr] : (profile?.phrAddress ?? null),
    }, fmt, null);
  }

  if (name && !document.getElementById('name').value.trim()) {
    document.getElementById('name').value = name;
  }
  // §7.3.1 phoneNumber — pre-fill phone field if empty
  if (profile?.phoneNumber && !document.getElementById('phone').value.trim()) {
    document.getElementById('phone').value = String(profile.phoneNumber).replace(/^\+?91/, '').replace(/\D/g, '');
  }

  document.getElementById('scan-status').className = 'scan-status received';
  document.getElementById('scan-status-text').textContent = '✓ Patient profile received!';

  setTimeout(_closeScanPanel, 2500);
}

function _closeScanPanel() {
  if (scanPanel) {
    scanPanel.style.display = 'none';
    btnScanAbha.textContent = 'Scan QR';
    btnScanAbha.classList.remove('open');
  }
  if (_scanSubscription) {
    supabase.removeChannel(_scanSubscription);
    _scanSubscription = null;
  }
  _scanRequestId = null;
}

// ── End-of-Day: stale visit check + close-out ──────
let _staleVisits = [];

document.getElementById('btn-eod').addEventListener('click', _openEodModal);

async function _checkStaleVisits() {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const { data } = await supabase
    .from('visits')
    .select('id, token_number, created_at, chief_complaint, doctor_id, patients(name)')
    .eq('tenant_id', tenantId)
    .in('status', ['waiting', 'in_progress'])
    .lt('created_at', todayStart.toISOString())
    .order('created_at', { ascending: true });

  _staleVisits = data || [];
  const banner = document.getElementById('stale-banner');
  if (_staleVisits.length === 0) { banner.classList.remove('show'); return; }

  const n = _staleVisits.length;
  document.getElementById('stale-banner-text').textContent =
    `⚠ ${n} visit${n > 1 ? 's' : ''} from previous day${n > 1 ? 's' : ''} still active in queue — please close out.`;
  banner.classList.add('show');
}

function _openEodModal() {
  if (!_staleVisits.length) return;
  const list = document.getElementById('eod-visit-list');
  list.innerHTML = _staleVisits.map(v => {
    const patName = v.patients?.name || '—';
    const doc     = _doctorMap?.[v.doctor_id] || '—';
    const dt      = new Date(v.created_at);
    const dateStr = dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    return `<div class="eod-visit-row">
      <input type="checkbox" class="eod-chk" value="${v.id}" checked>
      <div style="flex:1">
        <div class="eod-visit-name">Token #${v.token_number || '—'} — ${patName}</div>
        <div class="eod-visit-meta">${doc} · ${v.chief_complaint || '—'}</div>
      </div>
      <div class="eod-visit-date">${dateStr} ${timeStr}</div>
    </div>`;
  }).join('');
  document.getElementById('eod-modal').classList.add('open');
  document.getElementById('eod-reason').addEventListener('change', function() {
    document.getElementById('eod-other-row').style.display = this.value === 'Other' ? '' : 'none';
  }, { once: false });
}

function _closeEodModal() {
  document.getElementById('eod-modal').classList.remove('open');
}
document.getElementById('btn-eod-cancel').addEventListener('click', _closeEodModal);
document.getElementById('btn-eod-submit').addEventListener('click', _submitEod);

async function _submitEod() {
  const reasonSel = document.getElementById('eod-reason').value;
  const reasonText = reasonSel === 'Other'
    ? (document.getElementById('eod-other-text').value.trim() || 'Other')
    : reasonSel;
  if (!reasonText) { alert('Please enter a reason.'); return; }

  const selected = [...document.querySelectorAll('.eod-chk:checked')].map(c => c.value);
  if (!selected.length) { alert('Select at least one visit to close.'); return; }

  const btn = document.getElementById('btn-eod-submit');
  btn.disabled = true; btn.textContent = 'Closing…';

  const now = new Date().toISOString();
  const { error } = await supabase.from('visits')
    .update({ status: 'incomplete', incomplete_reason: reasonText, incomplete_at: now })
    .in('id', selected);

  btn.disabled = false; btn.textContent = 'Mark Selected as Incomplete';

  if (error) { alert(safeErrorMessage(error)); return; }

  _closeEodModal();
  _staleVisits = _staleVisits.filter(v => !selected.includes(v.id));
  if (_staleVisits.length === 0) document.getElementById('stale-banner').classList.remove('show');
  else document.getElementById('stale-banner-text').textContent =
    `⚠ ${_staleVisits.length} visit(s) from previous day(s) still active — please close out.`;

  await loadQueue();
}

// ── Walk-in / Appointment mode ─────────────────────
let _mode = 'walkin';

document.getElementById('btn-walkin').addEventListener('click', () => _setMode('walkin'));
document.getElementById('btn-appt').addEventListener('click',   () => _setMode('appointment'));

function _setMode(mode) {
  _mode = mode;
  const isAppt = mode === 'appointment';
  document.getElementById('btn-walkin').classList.toggle('active', !isAppt);
  document.getElementById('btn-appt').classList.toggle('active',    isAppt);
  document.getElementById('appt-when-row').style.display = isAppt ? '' : 'none';
  document.getElementById('panel-title').textContent = isAppt ? 'Book Appointment' : 'New Patient Visit';
  document.getElementById('panel-sub').textContent   = isAppt
    ? 'Schedule a future appointment for a patient'
    : 'Register a patient and add them to today\'s queue';
  const btn = document.getElementById('btn-submit');
  btn.querySelector('.btn-text').textContent = isAppt ? '📅 Book Appointment' : 'Register & Create Visit';
  if (isAppt && !document.getElementById('appt-date').value) {
    document.getElementById('appt-date').value = new Date().toISOString().slice(0,10);
  }
}

// ── Queue / Appointments tabs ──────────────────────
document.getElementById('tab-queue').addEventListener('click', () => {
  document.getElementById('tab-queue').classList.add('active');
  document.getElementById('tab-appts').classList.remove('active');
  document.getElementById('queue-list').style.display = '';
  document.getElementById('appt-list').style.display  = 'none';
});
document.getElementById('tab-appts').addEventListener('click', () => {
  document.getElementById('tab-appts').classList.add('active');
  document.getElementById('tab-queue').classList.remove('active');
  document.getElementById('queue-list').style.display  = 'none';
  document.getElementById('appt-list').style.display   = '';
  loadTodaysAppointments();
});

// ── Book Appointment ───────────────────────────────
async function bookAppointment() {
  _hideAlert();
  const apptDate = document.getElementById('appt-date').value;
  const apptTime = document.getElementById('appt-time').value;
  const name     = document.getElementById('name').value.trim();
  const phone    = document.getElementById('phone').value.trim();
  const complaint= document.getElementById('complaint').value.trim();
  const opdId    = document.getElementById('opd').value    || null;
  const doctorId = document.getElementById('doctor').value || null;

  if (!apptDate) return _alert('error', 'Please select an appointment date.');
  if (!apptTime) return _alert('error', 'Please select an appointment time.');
  if (!opdId)    return _alert('error', 'Please select an OPD / Department for the appointment.');
  if (!name)     return _alert('error', 'Please enter the patient\'s name.');
  if (!phone)    return _alert('error', 'Please enter the patient\'s phone number.');

  const btn = document.getElementById('btn-submit');
  _loading(btn, true);
  try {
    // Find or create patient
    let patient = _patient;
    if (!patient) {
      const { data: found } = await supabase
        .from('patients').select('id,name')
        .eq('phone', phone).eq('tenant_id', tenantId).limit(1);
      patient = found?.length ? found[0]
        : await createPatient(name, phone, tenantId, null, {});
    }

    const { data: appt, error } = await supabase
      .from('appointments')
      .insert({
        tenant_id: tenantId,
        patient_id: patient.id,
        doctor_id: doctorId,
        opd_id: opdId,
        appointment_date: apptDate,
        appointment_time: apptTime,
        status: 'scheduled',
        chief_complaint: complaint || null,
        created_by: profile.id
      })
      .select('id')
      .single();

    if (error) throw error;

    const opdSel  = document.getElementById('opd');
    const opdName = opdSel.options[opdSel.selectedIndex]?.text || '';

    document.getElementById('receipt-card').classList.add('show');
    document.getElementById('receipt-title').textContent = '✓ Appointment Booked';
    document.getElementById('receipt-rows').innerHTML = `
      <div style="font-size:13px;color:var(--text-mid);line-height:1.8">
        <strong>${_esc(patient.name)}</strong><br>
        🏥 ${_esc(opdName)}<br>
        📅 ${new Date(apptDate).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}
        &nbsp;·&nbsp; 🕐 ${_fmt12(apptTime)}<br>
        ${doctorId ? `👨‍⚕️ ${_esc(_doctorMap[doctorId] || '')}` : '⚕ No doctor preference'}
      </div>`;
    document.getElementById('receipt-tele-block').style.display = 'none';
    _resetForm();
  } catch(err) {
    _alert('error', safeErrorMessage(err, 'Could not book appointment. Please try again.'));
  } finally {
    _loading(btn, false);
  }
}

function _fmt12(t) {
  if (!t) return '';
  const [h,m] = t.split(':').map(Number);
  return `${h%12||12}:${String(m).padStart(2,'0')} ${h<12?'AM':'PM'}`;
}

// ── Today's Appointments ───────────────────────────
async function loadTodaysAppointments() {
  const today = new Date().toISOString().slice(0,10);
  const { data, error } = await supabase
    .from('appointments')
    .select('id, appointment_time, status, chief_complaint, patients(name), profiles!doctor_id(full_name), opds(name)')
    .eq('tenant_id', tenantId)
    .eq('appointment_date', today)
    .order('appointment_time', { ascending: true });

  const list = document.getElementById('appt-list');
  const badge = document.getElementById('appt-count');

  if (error || !data || !data.length) {
    badge.textContent = '';
    list.innerHTML = `<div class="q-empty"><div class="q-empty-icon">📅</div><div class="q-empty-text">No appointments scheduled for today</div></div>`;
    return;
  }

  const pending = data.filter(a => ['scheduled','confirmed'].includes(a.status)).length;
  badge.textContent = pending ? `(${pending})` : '';

  list.innerHTML = data.map(a => {
    const statusClass = `appt-s-${a.status}`;
    const statusLabel = {scheduled:'Scheduled',confirmed:'Confirmed',arrived:'Arrived',completed:'Done',cancelled:'Cancelled',no_show:'No Show'}[a.status] || a.status;
    const canCheckin  = ['scheduled','confirmed'].includes(a.status);
    return `<div class="appt-item">
      <div class="appt-time-badge">${_fmt12(a.appointment_time)}</div>
      <div style="flex:1;min-width:0">
        <div class="appt-pt-name">${_esc(a.patients?.name || '—')}</div>
        <div class="appt-pt-meta">
          ${a.profiles?.full_name ? `👨‍⚕️ ${_esc(a.profiles.full_name)}` : ''}
          ${a.opds?.name ? ` · ${_esc(a.opds.name)}` : ''}
          ${a.chief_complaint ? ` · ${_esc(a.chief_complaint)}` : ''}
        </div>
      </div>
      <span class="appt-s-badge ${statusClass}">${statusLabel}</span>
      ${canCheckin ? `<button class="btn-checkin" data-onclick="checkIn" data-onclick-a0="${a.id}">Check In</button>` : ''}
    </div>`;
  }).join('');
}

async function checkIn(apptId) {
  const { data: appt } = await supabase
    .from('appointments')
    .select('patient_id, doctor_id, opd_id, chief_complaint')
    .eq('id', apptId).single();
  if (!appt) return;

  // Mark appointment arrived
  await supabase.from('appointments').update({ status: 'arrived' }).eq('id', apptId);

  // Pre-fill the walk-in form and switch to walk-in mode
  _setMode('walkin');

  const { data: patient } = await supabase
    .from('patients')
    .select('id, name, abha_number, age, gender, date_of_birth, blood_group, phone, prakriti_data, prakriti_assessed_at')
    .eq('id', appt.patient_id).single();

  if (patient) {
    document.getElementById('phone').value = patient.phone || '';
    await _selectPatient(patient);
  }
  if (appt.chief_complaint) document.getElementById('complaint').value = appt.chief_complaint;
  if (appt.opd_id)   document.getElementById('opd').value    = appt.opd_id;
  if (appt.doctor_id) document.getElementById('doctor').value = appt.doctor_id;

  // Switch view back to queue tab and scroll form into view
  document.getElementById('tab-queue').click();
  document.querySelector('.panel').scrollIntoView({ behavior: 'smooth' });
  _alert('info', `✓ Patient pre-filled from appointment. Complete registration to add to queue.`);
  loadTodaysAppointments();
}
window.checkIn = checkIn;

// ── Boot ──────────────────────────────────────────
await loadOPDs();
await loadDoctors('');
await loadQueue();
await loadTodaysAppointments();
await _checkStaleVisits();
setInterval(loadQueue, 30_000);
setInterval(loadTodaysAppointments, 30_000);
setInterval(_checkStaleVisits, 5 * 60_000);

// ── NABH Allergy System (Reception) ──────────────────────────
let _receptionPatientId = null;
let _receptionAllergies = [];

async function _loadReceptionAllergies(patientId) {
  _receptionPatientId = patientId;
  const panel   = document.getElementById('allergy-panel');
  const display = document.getElementById('reception-allergy-display');
  panel.style.display = '';
  const { data } = await supabase.from('patient_allergies')
    .select('id,allergen,allergen_type,severity,status')
    .eq('patient_id', patientId).eq('tenant_id', tenantId).eq('status','active')
    .order('created_at', { ascending: false });
  _receptionAllergies = data || [];
  if (!_receptionAllergies.length) {
    display.innerHTML = '<span style="color:var(--text-muted)">No allergies on record — add if known</span>';
    return;
  }
  const sevColor = { mild:'#f39c12', moderate:'#e67e22', severe:'#e74c3c', anaphylaxis:'#c0392b' };
  display.innerHTML = _receptionAllergies.map(a =>
    `<span style="display:inline-flex;align-items:center;gap:3px;background:${sevColor[a.severity]||'#e74c3c'}18;border:1px solid ${sevColor[a.severity]||'#e74c3c'};border-radius:12px;padding:2px 8px;margin:2px;font-size:11px">
      <strong>${a.allergen}</strong>${a.severity ? ` <span style="color:${sevColor[a.severity]}"> [${a.severity}]</span>` : ''}
    </span>`
  ).join('');
}

window.openReceptionAllergyModal = function() {
  if (!_receptionPatientId) return;
  document.getElementById('rx-allergy-modal').style.display = 'flex';
  renderReceptionAllergyList();
};
window.closeReceptionAllergyModal = function() {
  document.getElementById('rx-allergy-modal').style.display = 'none';
};
function renderReceptionAllergyList() {
  const el = document.getElementById('rx-allergy-list');
  if (!_receptionAllergies.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">None recorded</div>'; return; }
  const sevColor = { mild:'#f39c12', moderate:'#e67e22', severe:'#e74c3c', anaphylaxis:'#c0392b' };
  el.innerHTML = _receptionAllergies.map(a =>
    `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">
      <span style="flex:1;font-size:13px"><strong>${a.allergen}</strong> <span style="color:var(--text-muted)">(${a.allergen_type})</span></span>
      ${a.severity ? `<span style="font-size:11px;font-weight:600;color:${sevColor[a.severity]||'#e74c3c'}">${a.severity}</span>` : ''}
    </div>`
  ).join('');
}
window.saveReceptionAllergy = async function() {
  const allergen = document.getElementById('rx-new-allergen').value.trim();
  if (!allergen || !_receptionPatientId) return;
  await supabase.from('patient_allergies').insert({
    tenant_id: tenantId, patient_id: _receptionPatientId,
    allergen, allergen_type: document.getElementById('rx-new-type').value,
    severity: document.getElementById('rx-new-severity').value || null,
  });
  await supabase.from('patients').update({ has_allergies: true }).eq('id', _receptionPatientId);
  document.getElementById('rx-new-allergen').value = '';
  await _loadReceptionAllergies(_receptionPatientId);
  renderReceptionAllergyList();
};
