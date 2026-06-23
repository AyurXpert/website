import { supabase } from '../../core/db/supabaseClient.js';

const EDGE_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-auth';

// ── ABDM error code → friendly message ────────────────────────
const ABDM_ERROR_MAP = {
  'ABDM-1001': 'Aadhaar number not found. Please check and try again.',
  'ABDM-1002': 'Aadhaar service is temporarily unavailable. Please try after some time.',
  'ABDM-1003': 'OTP has expired. Please request a new OTP.',
  'ABDM-1004': 'Session expired. Please start the enrollment again.',
  'ABDM-1005': 'Invalid OTP. Please check and enter the correct OTP.',
  'ABDM-1006': 'Invalid request. Please check the Aadhaar number and try again.',
  'ABDM-1007': 'Maximum OTP attempts exceeded. Please try again after some time.',
  'ABDM-1008': 'ABHA already exists for this Aadhaar number.',
  'ABDM-1009': 'Mobile number does not match with Aadhaar records.',
  'ABDM-1100': 'Too many OTP attempts for this transaction. Please wait 30 minutes and try again.',
  '900900':    'ABDM authentication service is unavailable. Please try again shortly.',
  '900901':    'Invalid credentials. Please contact support.',
  '900902':    'Access token missing or expired. Please refresh and try again.',
  '900906':    'Resource not found on ABDM server.',
  '900907':    'Method not supported by ABDM API.',
  '900908':    'ABDM API subscription issue. Please contact support.',
  'RATE_LIMITED': 'Too many attempts. Please wait 15 minutes and try again.',
};

function normalizeAbdmError(errorData) {
  if (typeof errorData === 'string') return errorData;
  // Unwrap nested error structures (our EF wraps ABDM's error body, creating error.error)
  const inner = errorData?.error ?? errorData;
  const code = inner?.code ?? inner?.error?.code ?? errorData?.code;
  if (code && ABDM_ERROR_MAP[String(code)]) return ABDM_ERROR_MAP[String(code)];
  const msg = inner?.message ?? inner?.error?.message ?? errorData?.message;
  if (msg && typeof msg === 'string') return msg;
  return 'An unexpected error occurred. Please try again.';
}

async function callABDM(action, params = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const res = await fetch(EDGE_FN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...params }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('[ABDM] raw error response:', JSON.stringify(data));
    const friendly = normalizeAbdmError(data.error ?? data);
    throw new Error(friendly);
  }
  return data;
}

async function encryptWithABDMCert(plaintext, publicKeyBase64) {
  const derBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'spki',
    derBytes.buffer,
    { name: 'RSA-OAEP', hash: 'SHA-1' },
    false,
    ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    new TextEncoder().encode(plaintext)
  );
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// ── Enrollment ─────────────────────────────────────────────────

// Step 1: Send OTP to Aadhaar-linked mobile for enrollment
export async function requestABHAOtp(aadhaar) {
  const { publicKey } = await callABDM('get_cert');
  const encAadhaar = await encryptWithABDMCert(aadhaar, publicKey);
  return callABDM('send_otp', { encAadhaar });
}

// Step 2: Verify OTP and create ABHA — returns ABHAProfile + tToken
export async function enrollABHA(txnId, otp, mobile) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('enroll_abha', { txnId, encOtp, mobile });
}

// CRT_ABHA_109 — after byAadhaar returns needsMobileOtp=true, send OTP to comm mobile.
// Uses POST /v3/enrollment/request/otp with scope ["abha-enrol","mobile-verify"] per ABDM V3 doc p.23.
export async function checkAndGenerateMobileOTP(txnId, mobile) {
  const { publicKey } = await callABDM('get_cert');
  const encMobile = await encryptWithABDMCert(mobile, publicKey);
  return callABDM('check_generate_mobile_otp', { txnId, encMobile });
}

// CRT_ABHA_109 — verify the OTP sent to comm mobile. Links mobile to ABHA.
// Uses POST /v3/enrollment/auth/byAbdm with scope ["abha-enrol","mobile-verify"] per ABDM V3 doc p.24.
export async function verifyCommMobileOtp(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('verify_comm_mobile_otp', { txnId, encOtp });
}

// Legacy — kept for any old callers; use verifyCommMobileOtp for CRT_ABHA_109.
export async function finalizeAbhaEnrollment(txnId, mobile, mobileOtp) {
  let encMobileOtp = null;
  if (mobileOtp) {
    const { publicKey } = await callABDM('get_cert');
    encMobileOtp = await encryptWithABDMCert(mobileOtp, publicKey);
  }
  return callABDM('finalize_abha_enrollment', { txnId, mobile, encMobileOtp });
}

// Step 6a: Get ABHA Address suggestions — txnId UUID from enrollment response per ABDM V3 doc Step 6a.
export async function getAbhaSuggestions(txnId) {
  return callABDM('get_abha_suggestions', { txnId });
}

// Step 6b: Set chosen ABHA Address — txnId UUID in body per ABDM V3 doc Step 6b.
export async function setAbhaAddress(txnId, abhaAddress) {
  return callABDM('set_abha_address', { txnId, abhaAddress });
}

// Download ABHA Card as base64 PNG — Mandatory for Private (CRT_ABHA_114)
export async function downloadAbhaCard(tToken) {
  return callABDM('download_abha_card', { tToken });
}

// Generate ABHA QR Code as base64 image — Optional (VRFY_ABHA_501)
export async function getAbhaQrCode(tToken) {
  return callABDM('get_abha_qr', { tToken });
}

// ── Verification: ABHA Number login ───────────────────────────

export async function requestABHALoginOtp(abhaNumber) {
  const { publicKey } = await callABDM('get_cert');
  const digits = String(abhaNumber).replace(/\D/g, '');
  // ABDM expects hyphenated format: XX-XXXX-XXXX-XXXX
  const formatted = digits.length === 14
    ? digits.replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4')
    : digits;
  const encAbhaNumber = await encryptWithABDMCert(formatted, publicKey);
  return callABDM('abha_login_otp', { encAbhaNumber });
}

// Returns profile + tToken (V3 endpoint /profile/login/verify)
export async function verifyABHALogin(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('abha_login_verify', { txnId, encOtp });
}

// ── Verification: Aadhaar Number login ────────────────────────

export async function requestAadhaarLoginOtp(aadhaar) {
  const { publicKey } = await callABDM('get_cert');
  const encAadhaar = await encryptWithABDMCert(aadhaar, publicKey);
  return callABDM('aadhaar_login_otp', { encAadhaar });
}

export async function verifyAadhaarLogin(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('aadhaar_login_verify', { txnId, encOtp });
}

// ── Verification: Mobile Number login — Find ABHA (VRFY_ABHA_301 private flow) ─
// sendMobileLoginOtp → OTP to mobile → verifyMobileLoginOtp → accounts[] + T-token
// → loginVerifyUser (account selection) → full profile.
// (§13.6 govt-only search-abha endpoint not used — requires BENEFIT-NAME header.)

// Step 1: Send OTP to mobile directly → returns { txnId, message }
export async function sendMobileLoginOtp(mobile) {
  const { publicKey } = await callABDM('get_cert');
  const encMobile = await encryptWithABDMCert(mobile, publicKey);
  return callABDM('mobile_otp_send', { encMobile });
}

// Step 2: Verify OTP → returns { accounts: [{ABHANumber, name, dob, gender, ...}], authResult }
export async function verifyMobileLoginOtp(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('mobile_otp_verify', { txnId, encOtp });
}

// ── Verification: ABHA Address login (PHR flow) ────────────────

// Step 1: Search ABHA address → returns profile preview
export async function searchAbhaAddress(abhaAddress) {
  return callABDM('abha_addr_search', { abhaAddress });
}

// Step 2: Send OTP for ABHA address login — encrypts abhaAddress as loginId
export async function initAbhaAddressLogin(abhaAddress) {
  const { publicKey } = await callABDM('get_cert');
  const encAbhaAddress = await encryptWithABDMCert(abhaAddress, publicKey);
  return callABDM('abha_addr_init', { encAbhaAddress });
}

// Step 3: Verify OTP → returns profile + accessToken
export async function verifyAbhaAddressOtp(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('abha_addr_verify', { txnId, encOtp });
}

// Download PHR Card (ABHA Address login)
export async function downloadPhrCard(accessToken) {
  return callABDM('download_phr_card', { accessToken });
}

// ── Re-activate ABHA (§8.5) ──────────────────────────────────
// Per XLSX PROF_ABHA_605: Step 1 = login/request/otp; Step 2 = login/verify/user.

// Step 1: No X-Token. Uses /profile/LOGIN/request/otp (not account/request/otp).
export async function reactivateAbhaOtp(abhaNumber) {
  const { publicKey } = await callABDM('get_cert');
  const encAbhaNumber = await encryptWithABDMCert(String(abhaNumber), publicKey);
  return callABDM('reactivate_abha_otp', { encAbhaNumber });
}

// Step 2: Verify OTP via /profile/login/verify/user → returns full profile + tToken (status ACTIVE).
export async function reactivateAbhaVerify(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('reactivate_abha_verify', { txnId, encOtp });
}

// ── Login Verify User — account selection (VRFY_ABHA_301 step 3) ─────────
// tToken: T-token from login/verify response (valid 5 min).
// abhaNumber: plain 14-digit ABHA number — encrypted here with RSA-OAEP.
export async function loginVerifyUser(tToken, txnId, abhaNumber) {
  const { publicKey } = await callABDM('get_cert');
  const encAbhaNumber = await encryptWithABDMCert(String(abhaNumber).replace(/-/g, ''), publicKey);
  return callABDM('login_verify_user', { tToken, txnId, encAbhaNumber });
}

// ── Re-KYC (§8.6) ────────────────────────────────────────────

// Step 1: Send Aadhaar OTP. tToken from current ABHA login required.
export async function reKycAbhaOtp(tToken, abhaNumber) {
  const { publicKey } = await callABDM('get_cert');
  const encAbhaNumber = await encryptWithABDMCert(String(abhaNumber), publicKey);
  return callABDM('rekyc_abha_otp', { xToken: tToken, encAbhaNumber });
}

// Step 2: Verify OTP → returns authResult + accounts.
export async function reKycAbhaVerify(tToken, txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('rekyc_abha_verify', { xToken: tToken, txnId, encOtp });
}

// ── Get ABHA Profile (§9.0) ───────────────────────────────────

// Fetch full ABHA profile using tToken (includes authMethods, kycVerified, address, etc.)
export async function getAbhaProfileFull(tToken) {
  return callABDM('get_abha_profile', { tToken });
}

// ── Update Mobile (ABDM 8.1) ──────────────────────────────────

// Step 1: Send OTP to new mobile number. Requires tToken from patient's current ABHA login.
export async function requestUpdateMobileOtp(tToken, mobile) {
  const { publicKey } = await callABDM('get_cert');
  const encMobile = await encryptWithABDMCert(mobile, publicKey);
  return callABDM('update_mobile_otp', { tToken, encMobile });
}

// Step 2: Verify OTP and link new mobile to ABHA.
export async function verifyUpdateMobileOtp(tToken, txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('update_mobile_verify', { tToken, txnId, encOtp });
}

// ── Sandbox: ABHA deletion (§8.3.1 Aadhaar OTP / §8.3.2 ABDM OTP) ──────────
export async function sbxLoginOtp(aadhaar) { return requestAadhaarLoginOtp(aadhaar); }
export async function sbxLoginVerify(txnId, otp) { return verifyAadhaarLogin(txnId, otp); }

// otpSystem: 'aadhaar' (default, §8.3.1) or 'abdm' (§8.3.2)
export async function sbxDeleteAbhaOtp(abhaNumber, xToken, otpSystem = 'aadhaar') {
  const { publicKey } = await callABDM('get_cert');
  const encAbhaNumber = await encryptWithABDMCert(String(abhaNumber), publicKey);
  return callABDM('sbx_delete_abha_otp', { encAbhaNumber, xToken, otpSystem });
}

export async function sbxDeleteAbhaConfirm(txnId, xToken, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('sbx_delete_abha_confirm', { txnId, encOtp, xToken });
}

// ── ABHA Deactivation (§8.4.1 Aadhaar OTP / §8.4.2 ABDM OTP) ───────────────

// Step 1: Send OTP. otpSystem: 'aadhaar' (§8.4.1) or 'abdm' (§8.4.2)
export async function deactivateAbhaOtp(abhaNumber, xToken, otpSystem = 'aadhaar') {
  const { publicKey } = await callABDM('get_cert');
  const encAbhaNumber = await encryptWithABDMCert(String(abhaNumber), publicKey);
  return callABDM('deactivate_abha_otp', { encAbhaNumber, xToken, otpSystem });
}

// Step 2: Verify OTP. reasons array required by ABDM spec for de-activate.
export async function deactivateAbhaConfirm(txnId, xToken, otp, reasons = ['User requested deactivation']) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('deactivate_abha_confirm', { txnId, encOtp, xToken, reasons });
}

// §3.2.5 — Register/update facility HIP+HIU services on ABDM bridge.
// facilityId: 12-char HFR ID starting with IN (e.g. IN2910002132)
// facilityName: full facility name (max 100 chars)
// hipName: max 15 chars, alphanumeric+space only — appears on ABHA app patient search
// types: ['HIP','HIU'] (default) — can pass ['HIP'] or ['HIU'] alone
export async function registerHipService(facilityId, facilityName, hipName, types = ['HIP', 'HIU']) {
  return callABDM('register_hip_service', { facilityId, facilityName, hipName, types });
}

// §4.3.8 — Send ABDM SMS deep-link to patient mobile (M2 mandatory: HIP_INIT_NOTIFY_HIECM)
// Patient receives SMS with a link to open their ABHA app and view the new health record.
// phoneNo: 10-digit Indian mobile (auto-normalised — strips +91/91 prefix)
// hipId / hipName: optional — auto-resolved from tenant hfr_id / name if not supplied
// IMPORTANT: This API has NO X-HIP-ID header — hipId goes in request body.
export async function smsNotify(phoneNo, hipId = null, hipName = null) {
  return callABDM('sms_notify', {
    phoneNo,
    ...(hipId   ? { hipId }   : {}),
    ...(hipName ? { hipName } : {}),
  });
}

// §4.3.6 — Notify care context update to all subscribed HIUs (fire-and-forget)
// Call after health record update: prescription dispensed, lab results added, note finalised.
// patientReference:    same ref used in addCareContexts (e.g. "PATIENT-<uuid>")
// careContextReference: specific care context ref (e.g. "VISIT-<uuid>")
// hiTypes: array — same 7 values as addCareContexts (auto-uppercased)
// date: ISO timestamp of update (defaults to now)
export async function notifyCareContext(abhaAddress, patientReference, careContextReference, hiTypes, date = null, hipId = null) {
  return callABDM('notify_care_context', {
    abhaAddress, patientReference, careContextReference, hiTypes,
    ...(date   ? { date }  : {}),
    ...(hipId  ? { hipId } : {}),
  });
}

// §4.3.5 — Get all linked care contexts for a patient (PHR verification/diagnostic)
// Use after addCareContexts() + §4.3.4 callback to confirm linking worked.
// xAuthToken: patient's tToken from their ABHA login session (expires in ~30 min)
// Returns: { patient: { id, links: [{ hip: {id,name}, referenceNumber, display, hiType, careContexts[], dateCreated }] } }
export async function getPatientLinks(xAuthToken, limit = 100) {
  return callABDM('get_patient_links', { xAuthToken, limit });
}

// §4.3.3 — Add Care Contexts (HIP-Initiated Linking, step 2 of 2)
// Call after getLinkToken() once the link token has arrived in link_tokens table.
// linkToken: the JWT from link_tokens.token (read from DB after the webhook callback)
// patient: array of patient entries — each with referenceNumber, display, careContexts[], hiType, count
// Valid hiType: PRESCRIPTION, DIAGNOSTICREPORT, OPCONSULTATION, DISCHARGESUMMARY,
//              IMMUNIZATIONRECORD, HEALTHDOCUMENTRECORD, WELLNESSRECORD
// Edge function auto-uppercases hiType and validates count === careContexts.length
export async function addCareContexts(abhaAddress, abhaNumber, linkToken, patient, hipId = null) {
  return callABDM('add_care_contexts', {
    abhaAddress,
    abhaNumber:  abhaNumber || null,
    linkToken,
    patient,
    ...(hipId ? { hipId } : {}),
  });
}

// §4.3.1 — HIP-Initiated Link Token Generation.
// Submits patient demographics to ABDM for verification.
// Returns 202 immediately; actual link token arrives via abdm-webhook callback (~5s).
// After token arrives, call addCareContexts() with the token from link_tokens table.
//
// abhaAddress: patient's ABHA address (e.g. "name@sbx") — recommended
// abhaNumber:  patient's 14-digit ABHA number — alternative if address unknown
// name:        patient's full name as in ABHA profile
// gender:      'M' / 'F' / 'O' / 'D' (Diverse)
// yearOfBirth: 4-digit year (ABDM allows ±2 year tolerance)
// hipId:       optional — overrides tenant's hfr_id (use for multi-facility setups)
export async function getLinkToken(abhaAddress, abhaNumber, name, gender, yearOfBirth, hipId = null) {
  return callABDM('get_link_token', {
    abhaAddress: abhaAddress || null,
    abhaNumber:  abhaNumber  || null,
    name, gender, yearOfBirth,
    ...(hipId ? { hipId } : {}),
  });
}



