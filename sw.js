const CACHE_NAME = 'bma-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];
const FONT_URLS = [
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap'
];

// Install: cache app shell and font CSS
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(APP_SHELL).catch(() => {
        // Icons may not exist yet — cache what we can
        return Promise.allSettled(APP_SHELL.map(url => cache.add(url)));
      })
    ).then(() => {
      // Cache font CSS separately (cross-origin, may fail offline)
      return caches.open(CACHE_NAME).then(cache =>
        Promise.allSettled(FONT_URLS.map(url => cache.add(url)))
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - App navigations / index.html: NETWORK-FIRST with cache fallback. The app
//   is one file; users should always get the latest deploy when online, and
//   the cached copy keeps it working offline. (Cache-first here once made
//   deploys invisible to installed PWAs — never again.)
// - Fonts: cache-first with background refresh.
// - Everything else same-origin: stale-while-revalidate.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Google Fonts: serve cached, refresh in background
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // The app itself: network-first, fall back to cache when offline
  const isShell = e.request.mode === 'navigate' ||
    url.pathname.endsWith('/index.html') || url.pathname.endsWith('/');
  if (isShell) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Other same-origin assets: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
