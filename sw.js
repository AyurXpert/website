// AyurXpert Service Worker
// Strategy:
//   - Navigation (HTML)  → Network first → cached copy → offline.html
//   - Local assets (JS/CSS/images) → Cache first → network → cache update
//   - External APIs (Supabase, Google Fonts, CDN) → Network only, no caching

const CACHE      = 'ayurxpert-v5';
const OFFLINE    = './offline.html';

// Security headers injected on every navigation response
const SEC_HEADERS = [
  ['X-Frame-Options',            'DENY'],
  ['X-Content-Type-Options',     'nosniff'],
  ['Referrer-Policy',            'strict-origin-when-cross-origin'],
  ['Cache-Control',              'no-store, no-cache, must-revalidate, private'],
  ['Content-Security-Policy',    "frame-ancestors 'none'; default-src 'self' https://*.supabase.co https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com https://fonts.gstatic.com https://static.cloudflareinsights.com data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'; base-uri 'self';"],
];

function withSecHeaders(res) {
  const h = new Headers(res.headers);
  SEC_HEADERS.forEach(([k, v]) => h.set(k, v));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const PRECACHE = [
  './offline.html',
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
];

// ── External origins that should never be cached ────────────────────────────
function isExternal(url) {
  return (
    url.includes('supabase.co')       ||
    url.includes('googleapis.com')    ||
    url.includes('gstatic.com')       ||
    url.includes('jsdelivr.net')      ||
    url.includes('fonts.gstatic.com') ||
    url.includes('chrome-extension')
  );
}

// ── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
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

  // Navigation requests → network first + security headers
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (!res.ok) return caches.match(req).then(c => c || caches.match(OFFLINE));
          // Clone BEFORE withSecHeaders consumes res.body — fixes "body already used" error
          const isPublic = PRECACHE.some(p => req.url.includes(p.replace('./', '')));
          const cacheRes = isPublic ? res.clone() : null;
          if (cacheRes) {
            caches.open(CACHE).then(c => c.put(req, cacheRes));
          }
          return withSecHeaders(res);
        })
        .catch(() =>
          caches.match(req)
            .then(cached => cached ? withSecHeaders(cached) : caches.match(OFFLINE))
        )
    );
    return;
  }

  // JS / CSS → network first (always get latest code)
  if (req.url.match(/\.(js|css)(\?|$)/)) {
    event.respondWith(
      fetch(req)
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
