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
  const code = errorData?.code ?? errorData?.error?.code;
  if (code && ABDM_ERROR_MAP[String(code)]) return ABDM_ERROR_MAP[String(code)];
  const msg = errorData?.message ?? errorData?.error?.message ?? errorData?.error;
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

// CRT_ABHA_108/109 — verify Aadhaar OTP + check if comm mobile == Aadhaar-linked mobile.
// If different, ABDM sends OTP to comm mobile and returns {txnId, mobileLinked: false}.
// If same, returns {txnId, mobileLinked: true} — skip mobile OTP step.
export async function checkAndGenerateMobileOTP(txnId, otp, mobile) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('check_generate_mobile_otp', { txnId, encOtp, mobile });
}

// Final ABHA creation after checkAndGenerateMobileOTP.
// Pass mobileOtp (string) when mobileLinked was false; pass null when mobileLinked was true.
export async function finalizeAbhaEnrollment(txnId, mobile, mobileOtp) {
  let encMobileOtp = null;
  if (mobileOtp) {
    const { publicKey } = await callABDM('get_cert');
    encMobileOtp = await encryptWithABDMCert(mobileOtp, publicKey);
  }
  return callABDM('finalize_abha_enrollment', { txnId, mobile, encMobileOtp });
}

// Step 3a: Get ABHA Address suggestions (tToken from enrollment)
export async function getAbhaSuggestions(tToken) {
  return callABDM('get_abha_suggestions', { tToken });
}

// Step 3b: Set chosen ABHA Address
export async function setAbhaAddress(tToken, abhaAddress) {
  return callABDM('set_abha_address', { tToken, abhaAddress });
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

// ── Verification: Mobile Number login (3-step) ─────────────────

// Step 1: Search ABHAs linked to mobile → returns { ABHAAddresses[], txnId }
export async function searchAbhaByMobile(mobile) {
  const { publicKey } = await callABDM('get_cert');
  const encMobile = await encryptWithABDMCert(mobile, publicKey);
  return callABDM('mobile_abha_search', { encMobile });
}

// Step 2: Send OTP for selected ABHA index (0-based)
export async function requestMobileAbhaOtp(index, txnId) {
  const { publicKey } = await callABDM('get_cert');
  const encIndex = await encryptWithABDMCert(String(index), publicKey);
  return callABDM('mobile_abha_otp', { encIndex, txnId });
}

// Step 3: Verify OTP → returns profile + tToken
export async function verifyMobileAbhaOtp(txnId, otp) {
  const { publicKey } = await callABDM('get_cert');
  const encOtp = await encryptWithABDMCert(otp, publicKey);
  return callABDM('mobile_abha_verify', { txnId, encOtp });
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
