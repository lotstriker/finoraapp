// ==========================================================================
// Finora — sw.js (service worker)
//   * Precaches the whole app shell so Finora opens offline (even the very first
//     time after installing).
//   * Same-origin files: NETWORK-FIRST (you always get the newest code when online;
//     the cache is the offline fallback). Fonts: stale-while-revalidate.
//   * Never touches Google sign-in / Drive requests.
//   * Shows notifications (Android Chrome only allows these via a service worker).
// ==========================================================================
importScripts('./precache.js');

const CACHE = `finora-${self.__PRECACHE_VERSION}`;
const FONT_CACHE = 'finora-fonts-v1';
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is all-or-nothing; do it per file so one missing icon can't break offline support
    await Promise.all(self.__PRECACHE_FILES.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE, FONT_CACHE]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

const GOOGLE_API_HOSTS = ['accounts.google.com', 'www.googleapis.com', 'oauth2.googleapis.com'];

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('./index.html')) || (await cache.match('./'));
    throw new Error('offline and not cached');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()); return res; }).catch(() => null);
  return cached || (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (GOOGLE_API_HOSTS.includes(url.hostname)) return;                 // never intercept sign-in / Drive
  if (url.origin === self.location.origin) { event.respondWith(networkFirst(request)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => 'focus' in c);
    if (existing) return existing.focus();
    return self.clients.openWindow('./');
  })());
});
