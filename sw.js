// AyurXpert Service Worker
// Strategy:
//   - Navigation (HTML)  → Network first: whatever the server answers goes to the browser (a 404 / 5xx is the real page, a redirect is
//                          followed); only when the server cannot be reached at all: one retry → cached copy → offline.html
//   - Local assets (JS/CSS/images) → Cache first → network → cache update
//   - External APIs (Supabase, Google Fonts, CDN) → Network only, no caching

// Session 357c (TODO §108 (c)): the cache is named after the build (sw-build.js, written by scripts/sync-website.ps1 on every website
// sync), so each deploy installs a new worker and clears the old cache. A missing sw-build.js never stops the worker installing.
try { importScripts('./sw-build.js'); } catch (_) { /* no build stamp: the fixed name below */ }
const CACHE      = 'ayurxpert-' + (self.AX_BUILD || 'v12');
const OFFLINE    = './offline.html';

// Security headers on every navigation response. Session 384 (TODO §492 / §489, owner D9): the service worker NO LONGER sets a
// Content-Security-Policy -- it used to REPLACE the server's (Cloudflare) policy with a weaker one ('unsafe-eval', 127.0.0.1 /
// localhost, no base-uri / form-action). The server's policy and each page's own meta policy now pass through untouched. The first three
// headers below are added only when the server sent none; Cache-Control stays forced to no-store (stricter than the server's no-cache,
// unchanged behaviour).
const SEC_HEADERS = [
  ['X-Frame-Options',            'DENY'],
  ['X-Content-Type-Options',     'nosniff'],
  ['Referrer-Policy',            'strict-origin-when-cross-origin'],
  ['Cache-Control',              'no-store, no-cache, must-revalidate, private'],
];

// TODO §423: a redirect reaches a navigation as an opaque response (status 0): Response() cannot rebuild it, it goes to the browser as it is
function withSecHeaders(res) {
  if (res.type === 'opaqueredirect' || res.status === 0) return res;
  const h = new Headers(res.headers);
  SEC_HEADERS.forEach(([k, v]) => { if (k === 'Cache-Control' || !h.has(k)) h.set(k, v); });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const PRECACHE = [
  './offline.html',
  './js/pages/offline.js',
  './login.html',
  './register.html',
  './signup.html',
  './manifest.json',
  './assets/icon.svg',
  './js/config/env.js',
  './js/config/constants.js',
  './js/core/auth.js',
  './js/core/db/supabaseClient.js',
  './js/components/navbar.js',
  './js/utils/dateUtils.js',
  './js/utils/validators.js',
  './js/utils/passwordSecurity.js',
];

// ── External origins that should never be cached ────────────────────────────
function isExternal(url) {
  return (
    url.includes('supabase.co')            ||
    url.includes('googleapis.com')         ||
    url.includes('gstatic.com')            ||
    url.includes('jsdelivr.net')           ||
    url.includes('cdnjs.cloudflare.com')   ||
    url.includes('cloudflareinsights.com') ||
    url.includes('fonts.gstatic.com')      ||
    url.includes('chrome-extension')
  );
}

// TODO §423 (owner, 4 Nov 2026): the server answered -> the browser shows that answer. "Could not reach" is decided only when the
// connection itself fails, and one dropped connection on hospital Wi-Fi is retried once first.
const NAV_RETRY_MS = 500;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function fetchNavigation(req) {
  try { return await fetch(req, { cache: 'no-store' }); }
  catch (_) { await pause(NAV_RETRY_MS); }
  return fetch(req, { cache: 'no-store' });
}
async function offlineAnswer(req) {
  const cached = await caches.match(req);
  return cached ? withSecHeaders(cached) : caches.match(OFFLINE);
}

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // Session 357c: 'reload' -- the app shell is fetched fresh from the network, never from the browser's HTTP cache
      .then(cache => cache.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove outdated caches ────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route requests ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (isExternal(req.url))  return;
  // Session 357c: the build stamp is never answered from a cache (the "updated -- Reload" check reads it; cache-first below would
  // freeze it and store one copy per check)
  if (new URL(req.url).pathname.endsWith('/version.json')) return;

  // Navigation requests → network first + security headers. `cache:'no-store'` is
  // required here for the exact same reason the JS/CSS handler below needs it: without
  // it, fetch() still honors the browser's own HTTP cache (navigations to pages like
  // fee-admin.html serve Cache-Control: max-age=600), so a returning visitor within that
  // window gets a stale pre-deploy page even though this handler's intent is "always hit
  // the network." Found live (Session 109/110): a real deploy wasn't visible on a real
  // user's browser despite the origin serving fresh content, confirmed via curl -- the
  // exact same symptom already fixed for JS/CSS in Session 94, just never extended here.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetchNavigation(req)
        .then(res => {
          // Clone BEFORE withSecHeaders consumes res.body — fixes "body already used" error
          const isPublic = res.ok && PRECACHE.some(p => req.url.includes(p.replace('./', '')));
          const cacheRes = isPublic ? res.clone() : null;
          if (cacheRes) {
            caches.open(CACHE).then(c => c.put(req, cacheRes));
          }
          return withSecHeaders(res);
        })
        .catch(() => offlineAnswer(req))
    );
    return;
  }

  // JS / CSS → network first (always get latest code). `cache:'no-store'` is required
  // here — without it, fetch() still honors the browser's own HTTP cache (these files
  // serve Cache-Control: max-age=14400), so a returning visitor within that 4-hour
  // window would silently get a stale response before this handler's "network first"
  // intent ever reaches the network at all. Found live: a real deploy (Session 94)
  // wasn't visible on a real user's browser despite the origin serving fresh content.
  if (req.url.match(/\.(js|css)(\?|$)/)) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Images / fonts / other assets → cache first
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(OFFLINE));
    })
  );
});
