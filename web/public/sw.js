/*
 * Service worker for Task Tracking & Productivity.
 * Caches ONLY the public app shell: hashed /assets/ bundles, icons and the offline fallback page.
 * /api/ traffic is never intercepted or cached, so no personal data is stored by this worker.
 * The page registers /sw.js?v=<build>; a new build installs a new worker and drops older caches.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `tt-shell-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const CORE = [OFFLINE_URL, '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(CORE);
  // Best effort: the entry bundle and every lazily loaded route chunk it references, so pages open while offline.
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const entry = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const found = new Set(entry);
    for (const url of entry.filter((u) => u.endsWith('.js'))) {
      const js = await (await fetch(url)).text();
      for (const m of js.matchAll(/assets\/[\w.-]+\.(?:js|css|woff2?)/g)) found.add(`/${m[0]}`);
    }
    await cache.addAll([...found]);
  } catch { /* runtime caching fills in as pages are visited */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('tt-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'sw-activated', version: VERSION });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'precache') event.waitUntil(precache());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // never touch API traffic
  if (req.mode === 'navigate') {
    // Network first; the HTML is never cached. Offline, show the fallback page.
    event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Hashed, immutable build output: cache first.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // The server answers unknown paths with the SPA page (200 text/html): never store that under an asset URL.
      if (res.ok && res.type === 'basic' && !(res.headers.get('content-type') || '').includes('text/html')) { const copy = res.clone(); event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy))); }
      return res;
    })));
  }
});
