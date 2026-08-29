// Client-side password hygiene helpers.
//
// Supabase Auth has built-in leaked-password protection (HaveIBeenPwned), but
// it's a Pro-plan feature and this project is on the Free plan (confirmed
// 29 Aug 2026 — the config PATCH is rejected with "available on Pro Plans and
// up"). This module is the partial stand-in, run in the browser before every
// auth.signUp() / auth.updateUser({password}) call:
//
//   * scorePasswordStrength() — shared 0..4 meter scoring (was duplicated
//     inline in forgot-password.js)
//   * isObviouslyWeak()       — offline denylist of the worst-known passwords,
//     so even with HIBP unreachable the truly trivial ones are still caught
//   * checkPasswordPwned()    — HIBP range API, k-anonymity: only the first 5
//     chars of the SHA-1 hash ever leave the browser, never the password. No
//     API key. Fails OPEN (checked:false) when it can't run — callers should
//     warn, not hard-block, on a network/API failure.
//
// CSP: pages calling checkPasswordPwned() need https://api.pwnedpasswords.com
// in their connect-src directive.

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

// The handful that pass the complexity rule in validators.js but are still
// among the most-guessed. Compared after stripping non-alphanumerics and
// lowercasing, so "Password1!" and "P@ssw0rd" collapse onto the same entry.
const WEAK_DENYLIST = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd',
  '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'admin123', 'administrator', 'welcome1', 'welcome123', 'letmein1',
  'iloveyou1', 'abc12345', 'a1b2c3d4', 'changeme1', 'test1234',
  'ayurxpert', 'ayurxpert1', 'srishti123', 'hospital1', 'doctor123',
]);

export function isObviouslyWeak(pw) {
  const s = String(pw ?? '');
  const normalized = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (WEAK_DENYLIST.has(normalized)) return true;
  // all one repeated character ("aaaaaaaa"), or a pure ascending/descending run
  if (/^(.)\1+$/.test(s)) return true;
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(normalized)) return true;
  return false;
}

// 0..4, plus display metadata for the strength bar.
export function scorePasswordStrength(pw) {
  const s = String(pw ?? '');
  let score = 0;
  if (s.length >= 8)  score++;
  if (s.length >= 12) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
  if (/[0-9]/.test(s) && /[^A-Za-z0-9]/.test(s)) score++;
  if (isObviouslyWeak(s)) score = Math.min(score, 1);
  score = Math.min(score, 4);

  const meta = [
    { pct: '0%',   color: 'transparent', label: '' },
    { pct: '25%',  color: '#ef4444',     label: 'Weak' },
    { pct: '50%',  color: '#f59e0b',     label: 'Fair' },
    { pct: '75%',  color: '#3b82f6',     label: 'Good' },
    { pct: '100%', color: '#22c55e',     label: 'Strong' },
  ][s ? Math.max(score, 1) : 0];

  return { score, ...meta };
}

async function sha1HexUpper(str) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

// Returns { checked, pwned, count }.
//   checked:false -> the lookup couldn't run (offline, API down, no
//                    crypto.subtle because the page is on plain http://).
//                    Caller should NOT hard-block on this.
export async function checkPasswordPwned(pw) {
  const fail = { checked: false, pwned: false, count: 0 };
  try {
    if (!pw || !globalThis.crypto?.subtle) return fail;
    const hash   = await sha1HexUpper(pw);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);

    const res = await fetch(HIBP_RANGE_URL + prefix, { method: 'GET' });
    if (!res.ok) return fail;

    const body = await res.text();
    for (const line of body.split('\n')) {
      const [suf, cnt] = line.trim().split(':');
      if (suf === suffix) {
        const count = parseInt(cnt, 10) || 0;
        return { checked: true, pwned: count > 0, count };
      }
    }
    return { checked: true, pwned: false, count: 0 };
  } catch (_) {
    return fail;
  }
}
