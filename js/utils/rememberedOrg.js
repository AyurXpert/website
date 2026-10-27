// rememberedOrg.js -- Session 362 (TODO §319): the login page remembers the organisation on THIS browser.
// Stored only after a SUCCESSFUL sign-in (auth.js _finalizeLogin) and only the signed-in account's OWN organisation code -- never
// looked up from an email, never anything about the person -- so the sign-in page never reveals which organisation an email belongs
// to. "Not <organisation>? Use another organisation" on the login page forgets it. Browser storage can be blocked (private window,
// cleared site data): every access is in try / catch and the page works without it.
const KEY = 'ax_org_code';
const CODE_RE = /^[A-Z0-9_-]{2,32}$/;

export function getRememberedOrgCode() {
  try {
    const v = (localStorage.getItem(KEY) || '').toUpperCase().trim();
    return CODE_RE.test(v) ? v : '';
  } catch { return ''; }
}

export function rememberOrgCode(code) {
  const v = String(code || '').toUpperCase().trim();
  if (!CODE_RE.test(v)) return;
  try { localStorage.setItem(KEY, v); } catch { /* storage blocked: nothing remembered */ }
}

export function forgetOrgCode() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
