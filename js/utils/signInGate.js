// Print pages opened without a sign-in (TODO_LATER §118, Session 336d).
//
// A print page (bill / receipt / slip) used to try to load its document straight away. With no signed-in session
// on this origin -- signed out, the session expired, another browser, or 127.0.0.1 vs ayurxpert.com -- RLS hid the
// row and the page said "Could not load the bill", which looked like a broken bill. Now each print page calls
// ensureSignedIn() BEFORE any document query: a signed-out user sees only "Please sign in to view this document"
// and a Sign in button that comes back to the same URL after login. Nothing about the document is fetched or shown,
// so a signed-out user can't tell whether it exists. "Could not load the bill" stays for real errors only
// (not found / no access while signed in).
//
// The return trip: login.html?next=<this page> -> js/pages/login.js keeps it for this tab -> auth.js sends the user
// there after login. safeReturnPath() only ever allows our own print pages (a bare file name + simple query) --
// never another site, so this can't become an open redirect.

export const RETURN_KEY = 'ax_login_return';

// The only pages login may return to: our print pages + the shift close page, a bare file name and a simple query.
const RETURN_PAGES = new Set(['printPharmacyBill.html', 'printReceipt.html', 'printOpdBill.html', 'printFinalBill.html',
  'printInvoice.html', 'shift-close.html']);
const QUERY_CHARS = /^[A-Za-z0-9_=&%.-]*$/;

export function safeReturnPath(p) {
  if (typeof p !== 'string' || p.length > 300) return null;
  const q = p.indexOf('?');
  const page = q < 0 ? p : p.slice(0, q);
  const query = q < 0 ? '' : p.slice(q + 1);
  return RETURN_PAGES.has(page) && QUERY_CHARS.test(query) ? p : null;
}

// This page as a relative URL ("printReceipt.html?payment=...") -- what login returns to.
export function currentReturnPath() {
  return safeReturnPath(window.location.pathname.split('/').pop() + window.location.search);
}

// An auth answer that means "not signed in" (as opposed to a network failure, which the page reports as a real error)
function _isSignedOutError(err) {
  return err?.name === 'AuthSessionMissingError' || err?.status === 401 || err?.status === 403;
}

// true when there is a live signed-in session. Otherwise shows the sign-in prompt and returns false.
export async function isSignedIn(supabase) {
  let session = null;
  try { session = (await supabase.auth.getSession()).data?.session || null; } catch { session = null; }
  if (!session) return false;
  // the stored session may be stale (expired / signed out elsewhere) -- ask the server
  try {
    const { data, error } = await supabase.auth.getUser();
    if (data?.user) return true;
    return !_isSignedOutError(error);      // a network problem is not "signed out"
  } catch {
    return true;
  }
}

export async function ensureSignedIn(supabase) {
  if (await isSignedIn(supabase)) return true;
  showSignInPrompt();
  return false;
}

// The sign-in link for this page (falls back to plain login.html if this page isn't a returnable one)
export function signInHref(returnPath = currentReturnPath()) {
  return returnPath ? `login.html?next=${encodeURIComponent(returnPath)}` : 'login.html';
}

// A small "please sign in" card -- DOM nodes + textContent only; styled through the CSSOM (CSP-safe on pages whose
// style-src has no 'unsafe-inline').
export function signInCard(returnPath) {
  const card = document.createElement('section');
  card.setAttribute('role', 'alert');
  card.className = 'ax-signin-card';
  Object.assign(card.style, {
    maxWidth: '420px', margin: '64px auto', padding: '28px 24px', background: '#fff', border: '1px solid #d9d4c7',
    borderRadius: '10px', textAlign: 'center', fontFamily: "'DM Sans', system-ui, sans-serif", color: '#1f2a22',
    boxShadow: '0 2px 12px rgba(0,0,0,.08)',
  });
  const h = document.createElement('h1');
  h.textContent = 'Please sign in to view this document';
  Object.assign(h.style, { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: '24px', fontWeight: '700', color: '#1a4a2e', margin: '0 0 8px' });
  const p = document.createElement('p');
  p.textContent = 'You are not signed in, or your session has ended. Sign in and you will come straight back here.';
  Object.assign(p.style, { fontSize: '14px', color: '#4a544c', margin: '0 0 18px', lineHeight: '1.45' });
  const a = document.createElement('a');
  a.href = signInHref(returnPath);
  a.textContent = 'Sign in';
  Object.assign(a.style, {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: '44px', minWidth: '140px', padding: '0 22px',
    background: '#1a4a2e', color: '#fff', borderRadius: '8px', fontWeight: '600', fontSize: '15px', textDecoration: 'none',
  });
  a.addEventListener('focus', () => { a.style.outline = '3px solid #c9902a'; a.style.outlineOffset = '2px'; });
  a.addEventListener('blur', () => { a.style.outline = ''; });
  card.append(h, p, a);
  return card;
}

// Inline prompt for a print started from inside a page (the shift handover slip): message + Sign in button that
// returns to that page. Replaces the contents of `container`.
export function showSignInInline(container) {
  if (!container) return;
  const msg = document.createElement('span');
  msg.textContent = 'Please sign in to view this document. ';
  const a = document.createElement('a');
  a.href = signInHref();
  a.textContent = 'Sign in';
  Object.assign(a.style, {
    display: 'inline-flex', alignItems: 'center', minHeight: '44px', padding: '0 16px', marginLeft: '6px',
    background: '#1a4a2e', color: '#fff', borderRadius: '8px', fontWeight: '600', textDecoration: 'none',
  });
  container.replaceChildren(msg, a);
}

// Whole-page prompt for a dedicated print page: hides everything else (document letterhead included) and shows the card.
export function showSignInPrompt() {
  if (document.querySelector('.ax-signin-card[data-page]')) return;
  for (const child of [...document.body.children]) {
    if (child.tagName !== 'SCRIPT') child.style.setProperty('display', 'none', 'important');
  }
  const card = signInCard();
  card.dataset.page = '1';
  document.body.appendChild(card);
  document.title = 'Sign in — AyurXpert';
  card.querySelector('a').focus();
}
