// TODO §424 (owner, 5 Nov 2026): a signed-out visitor must never see a protected page's frame. requireAuth() runs from a module, which starts
// only after the browser may already have painted the page, so this plain script runs first, from the page's <head>, and hides the page.
// requireAuth() shows it again (every way it ends sets visibility back to ''), or redirects.
// Safety (owner, 5 Nov 2026): a page must never stay blank, and slowness is never a reason to send anyone away: only a definite "not signed in"
// answer goes to the sign-in page, and that is requireAuth()'s decision. If the page is still hidden after 8 s (the check is slow, had no answer,
// or its script never loaded) -> a visible message with Retry and Go to sign-in; if the check finishes after all, the message goes.
(function () {
  var root = document.documentElement;
  window.axAuthGate = true;
  root.style.visibility = 'hidden';

  function button(text, css, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = 'min-height:44px;padding:0 20px;border-radius:8px;font:600 15px "DM Sans",sans-serif;cursor:pointer;' + css;
    b.addEventListener('click', onClick);
    return b;
  }

  setTimeout(function () {
    if (root.style.visibility !== 'hidden') return;
    var cover = document.createElement('div');
    cover.id = 'ax-signin-slow';
    cover.setAttribute('role', 'alert');
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;visibility:visible;display:flex;align-items:center;justify-content:center;padding:16px;background:#faf8f3;font-family:"DM Sans",sans-serif';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;max-width:460px;width:100%;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.15);border-top:5px solid #c9902a';
    var title = document.createElement('h1');
    title.style.cssText = 'margin:0 0 18px;font:600 24px "Cormorant Garamond",serif;color:#1a4a2e';
    title.textContent = 'Checking your sign-in is taking longer than usual';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap';
    var retry = button('Retry', 'background:#1a4a2e;color:#fff;border:2px solid #1a4a2e', function () { window.location.reload(); });
    row.appendChild(retry);
    row.appendChild(button('Go to sign-in', 'background:#fff;color:#1a4a2e;border:2px solid #1a4a2e', function () { window.location.replace('login.html'); }));
    card.appendChild(title);
    card.appendChild(row);
    cover.appendChild(card);
    (document.body || root).appendChild(cover);
    retry.focus();
    new MutationObserver(function (changes, observer) {
      if (root.style.visibility === 'hidden') return;
      observer.disconnect();
      cover.remove();
    }).observe(root, { attributes: true, attributeFilter: ['style'] });
  }, 8000);
})();
