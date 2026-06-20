// BMA service worker — cache-first + background revalidation (GCU pattern,
// adapted from @gcu/weir). The whole app is one index.html: serve it from
// cache instantly (and offline), re-fetch in the background, and when the
// fresh bytes differ tell the page to show the reload banner. The cache name
// carries the build hash, so every deploy auto-busts old caches — no manual
// version bumps to forget.
//
// This file is a BUILD INPUT: build.js substitutes f9d4691 and writes
// the root sw.js. Don't edit the root copy.

const CACHE = 'bma-shell-f9d4691';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // cache: 'reload' bypasses the HTTP cache so a newly-installing SW always
    // captures fresh bytes — an HTTP-stale index.html here would trap the
    // update and leave the PWA on the old build despite the cache bump.
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // (Google Fonts route removed in C6-1b — fonts are embedded in index.html)
  if (url.origin !== self.location.origin) return;

  event.respondWith(handle(req));
});

async function handle(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) {
    revalidate(req, cache, cached);   // background; banners the page on change
    return cached;
  }
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (e) {
    const navFallback = await cache.match('./index.html') || await cache.match('./');
    if (navFallback) return navFallback;
    throw e;
  }
}

async function revalidate(req, cache, cached) {
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    if (!fresh || !fresh.ok) return;
    const a = await cached.clone().arrayBuffer();
    const b = await fresh.clone().arrayBuffer();
    await cache.put(req, fresh.clone());
    if (!bytesEqual(a, b)) {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'bma:update-available' });
    }
  } catch (e) { /* offline / failed refresh — ignore */ }
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a), vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

// On-demand check from the page (build-hash badge click)
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'bma:check-now') {
    const port = event.ports && event.ports[0];
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const root = new Request(new URL('./', self.location.href).toString());
      const cached = await cache.match(root, { ignoreSearch: true }) ||
        await cache.match('./index.html', { ignoreSearch: true });
      if (cached) await revalidate(root, cache, cached);   // posts bma:update-available if changed
      else { try { const r = await fetch(root); if (r && r.ok) await cache.put(root, r.clone()); } catch (e) { /* offline */ } }
      if (port) port.postMessage({ type: 'bma:check-complete' });
    })());
  }
});
