// ═══════════════════════════════════════════════════════════
// TODO §250 -- one browser sign-in is shared by every tab (the Supabase token lives in
// localStorage), but each tab keeps the page / role it was opened with. Signing in as
// someone else (or signing out) in another tab used to leave this tab looking unchanged
// while its saves went out under the OTHER person's token (353A OT "Complete" refusal).
//
// Each tab now remembers the user it was opened as (sessionStorage = per tab). When the
// browser's signed-in user no longer matches, the tab is covered by a blocking notice
// and every database / function / storage request from it is refused before it leaves
// the browser (supabaseClient.js) -- so not even a timer-driven autosave goes out as
// the other person. "Reload to continue" forgets this tab's user and reloads, which then
// opens the page as whoever is signed in now (or the sign-in page).
//
// No Supabase import here on purpose: supabaseClient.js imports this module.
// ═══════════════════════════════════════════════════════════

export const TAB_USER_KEY = 'ayurxpert_tab_user';

export function getTabUser() {
  try { return sessionStorage.getItem(TAB_USER_KEY) || null; } catch { return null; }
}

export function setTabUser(userId) {
  try { if (userId) sessionStorage.setItem(TAB_USER_KEY, userId); } catch { /* storage blocked: no pin, no check */ }
}

export function clearTabUser() {
  try { sessionStorage.removeItem(TAB_USER_KEY); } catch { /* ignore */ }
}

// The user id ("sub") and email inside an access token. A non-user key (the anon /
// publishable key) has no "sub" and returns null -- such requests are never refused.
export function jwtClaims(token) {
  if (!token || typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return json && typeof json.sub === 'string' ? { sub: json.sub, email: json.email || '' } : null;
  } catch {
    return null;
  }
}

function _openedAsName() {
  try {
    const p = JSON.parse(sessionStorage.getItem('ayurxpert_profile') || 'null');
    return p?.full_name || p?.email || 'another account';
  } catch {
    return 'another account';
  }
}

let _blocked = false;
const _onBlock = [];
export function isTabBlocked() { return _blocked; }
// auth.js registers its clean-up here (inactivity timers, realtime channels).
export function onTabBlocked(fn) { _onBlock.push(fn); }

// Covers the page and makes everything under it inert (no clicks, no typing).
// nowEmail = the account signed in now; empty / null = signed out.
export function blockTab(nowEmail) {
  if (_blocked) return;
  _blocked = true;
  _onBlock.forEach(fn => { try { fn(); } catch { /* clean-up must never stop the block */ } });

  const openedAs = _openedAsName();
  const show = () => {
    document.documentElement.style.visibility = '';
    if (document.body) document.body.inert = true;

    const cover = document.createElement('div');
    cover.id = 'ax-tab-user-block';
    cover.setAttribute('role', 'alertdialog');
    cover.setAttribute('aria-modal', 'true');
    cover.setAttribute('aria-labelledby', 'ax-tab-user-title');
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;visibility:visible;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(26,74,46,.82);font-family:"DM Sans",sans-serif';

    const card = document.createElement('div');
    card.style.cssText = 'background:#faf8f3;color:#1a1a1a;max-width:460px;width:100%;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.35);border-top:5px solid #c9902a';

    const title = document.createElement('h2');
    title.id = 'ax-tab-user-title';
    title.style.cssText = 'margin:0 0 12px;font:600 24px "Cormorant Garamond",serif;color:#1a4a2e';
    title.textContent = nowEmail ? 'Signed in as someone else' : 'Signed out';

    const p1 = document.createElement('p');
    p1.style.cssText = 'margin:0 0 8px;font-size:15px;line-height:1.5';
    p1.textContent = nowEmail
      ? `You signed in as ${nowEmail} in another tab. This page was opened as ${openedAs}.`
      : `You signed out in another tab. This page was opened as ${openedAs}.`;

    const p2 = document.createElement('p');
    p2.style.cssText = 'margin:0 0 18px;font-size:15px;line-height:1.5';
    p2.textContent = 'Nothing more can be saved from this page. Reload to continue.';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload to continue';
    btn.style.cssText = 'min-height:44px;padding:10px 20px;border:none;border-radius:8px;background:#1a4a2e;color:#fff;font:600 15px "DM Sans",sans-serif;cursor:pointer';
    btn.addEventListener('click', () => {
      // forget everything this tab knew about the old user, then open as whoever is signed in now
      try { sessionStorage.clear(); } catch { /* ignore */ }
      window.location.reload();
    });

    card.append(title, p1, p2, btn);
    cover.appendChild(card);
    document.documentElement.appendChild(cover); // outside <body>, so body.inert does not reach it
    btn.focus();
  };
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show, { once: true });
}
