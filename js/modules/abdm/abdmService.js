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

// Download ABHA Card as base64 PNG (tToken from enrollment or login)
export async function downloadAbhaCard(tToken) {
  return callABDM('download_abha_card', { tToken });
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

// ── Verification: Mobile Number login — Find ABHA (3-step, official ABDM doc) ─

// Step 1: Search ABHAs by mobile → returns masked list + txnId
export async function searchAbhaByMobile(mobile) {
  const { publicKey } = await callABDM('get_cert');
  const encMobile = await encryptWithABDMCert(mobile, publicKey);
  return callABDM('mobile_abha_search', { encMobile });
}

// Step 2: Request OTP for specific ABHA by index (0-based) → returns { txnId, message }
export async function requestIndexAbhaOtp(searchTxnId, index) {
  const { publicKey } = await callABDM('get_cert');
  const encIndex = await encryptWithABDMCert(String(index), publicKey);
  return callABDM('mobile_index_otp', { encIndex, txnId: searchTxnId });
}

// Step 3: Verify OTP → returns full ABHA profile + tToken
export async function verifyIndexAbhaOtp(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('mobile_index_verify', { txnId, encOtp });
}

// ── Verification: Mobile Number login (2-step fallback) ────────

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

// ── Sandbox: ABHA deletion (§8.3.1) ────────────────────────────
export async function sbxLoginOtp(aadhaar) { return requestAadhaarLoginOtp(aadhaar); }
export async function sbxLoginVerify(txnId, otp) { return verifyAadhaarLogin(txnId, otp); }

export async function sbxDeleteAbhaOtp(abhaNumber, xToken) {
  const { publicKey } = await callABDM('get_cert');
  // Keep dashes — ABDM returned this format from login verify
  const encAbhaNumber = await encryptWithABDMCert(String(abhaNumber), publicKey);
  return callABDM('sbx_delete_abha_otp', { encAbhaNumber, xToken });
}

export async function sbxDeleteAbhaConfirm(txnId, xToken, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('sbx_delete_abha_confirm', { txnId, encOtp, xToken });
}



