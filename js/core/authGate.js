// TODO §424 (owner, 5 Nov 2026): a signed-out visitor must never see a protected page's frame. requireAuth() runs from a module, which starts
// only after the browser may already have painted the page, so this plain script runs first, from the page's <head>, and hides the page.
// requireAuth() shows it again (every way it ends sets visibility back to ''), or redirects.
// Safety (owner, 5 Nov 2026): a page must never stay blank, and slowness is never a reason to send anyone away: only a definite "not signed in"
// answer goes to the sign-in page, and that is requireAuth()'s decision. §443 (owner, 6 Nov 2026): the 8 s start when the page's files have loaded, so they measure the check
// and not the connection (a slow connection took 13-33 s to load a page). If the page is still hidden after them -> a visible message with Retry and Go to sign-in; if the
// check finishes after all, the message goes. A file that never finishes loading fires no load event, so a separate limit covers that: 45 s from the start.
// Owner, 6 Nov 2026: during the wait a plain "Loading AyurXpert…" shows instead of a blank screen. It is a CSS line on the hidden root, not an element: no frame and no data
// can come with it, it needs no code to remove (it is tied to the hidden state), and it waits 0.4 s so a fast page never flickers.
// No connection (owner, 6 Nov 2026) is not "signed out": the message says so, Go to sign-in is hidden, and the page opens by itself when the connection
// returns (it is still hidden here, so nothing typed can be lost).
(function () {
  var root = document.documentElement;
  window.axAuthGate = true;
  root.style.visibility = 'hidden';
  var wait = document.createElement('style');
  wait.textContent = 'html[style*="visibility: hidden"]::before{content:"Loading AyurXpert…";position:fixed;inset:0;z-index:2147483646;visibility:visible;display:flex;'
    + 'align-items:center;justify-content:center;background:#faf8f3;color:#1a4a2e;font:500 18px "DM Sans",sans-serif;opacity:0;animation:ax-wait 0s .4s forwards}'
    + '@keyframes ax-wait{to{opacity:1}}';
  (document.head || root).appendChild(wait);

  function button(text, css, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = 'min-height:44px;padding:0 20px;border-radius:8px;font:600 15px "DM Sans",sans-serif;cursor:pointer;' + css;
    b.addEventListener('click', onClick);
    return b;
  }

  var AFTER_FILES_MS = 8000, NEVER_LOADED_MS = 45000, timer, shown = false;
  function waitFor(ms) { clearTimeout(timer); timer = setTimeout(showCard, ms); }
  function filesDone() { if (!shown) waitFor(AFTER_FILES_MS); }

  function showCard() {
    if (root.style.visibility !== 'hidden') return;
    shown = true;
    var cover = document.createElement('div');
    cover.id = 'ax-signin-slow';
    cover.setAttribute('role', 'alert');
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;visibility:visible;display:flex;align-items:center;justify-content:center;padding:16px;background:#faf8f3;font-family:"DM Sans",sans-serif';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;max-width:460px;width:100%;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.15);border-top:5px solid #c9902a';
    var title = document.createElement('h1');
    title.style.cssText = 'margin:0 0 18px;font:600 24px "Cormorant Garamond",serif;color:#1a4a2e';
    var note = document.createElement('p');
    note.style.cssText = 'margin:0 0 18px;font-size:15px;line-height:1.5;color:#1a1a1a';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap';
    var retry = button('Retry', 'background:#1a4a2e;color:#fff;border:2px solid #1a4a2e', function () { window.location.reload(); });
    row.appendChild(retry);
    var signIn = button('Go to sign-in', 'background:#fff;color:#1a4a2e;border:2px solid #1a4a2e', function () { window.location.replace('login.html'); });
    row.appendChild(signIn);
    function show() {
      var off = navigator.onLine === false;
      title.textContent = off ? 'No internet connection' : 'This page is taking longer than usual to load';
      note.textContent = off ? 'You are still signed in. This page will open by itself when the connection returns.' : 'Your internet connection may be slow.';
      signIn.hidden = off;
    }
    show();
    window.addEventListener('offline', show);
    window.addEventListener('online', function () { window.location.reload(); });
    card.appendChild(title);
    card.appendChild(note);
    card.appendChild(row);
    cover.appendChild(card);
    (document.body || root).appendChild(cover);
    retry.focus();
    new MutationObserver(function (changes, observer) {
      if (root.style.visibility === 'hidden') return;
      observer.disconnect();
      cover.remove();
    }).observe(root, { attributes: true, attributeFilter: ['style'] });
  }

  waitFor(NEVER_LOADED_MS);
  window.addEventListener('load', filesDone);
  // no connection: a file may never answer, and the offline message does not wait for the long limit
  window.addEventListener('offline', filesDone);
  if (navigator.onLine === false) filesDone();
})();
