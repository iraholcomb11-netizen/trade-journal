'use strict';

/* App-shell cache so the journal opens with no network after the first visit.
   Bump CACHE when shipped assets change. Scope is the service worker's own
   directory, which is /trade-journal/ on GitHub Pages. */

const CACHE = 'trade-journal-shell-v1';

const ASSET_PATHS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

const ASSETS = ASSET_PATHS.map((path) => new URL(path, self.location).href);
const INDEX = new URL('./index.html', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function cached(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.endsWith('/')) {
    return cache.match(INDEX);
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const hit = await cached(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      if (hit) return hit;
      const fresh = await network;
      if (fresh) return fresh;
      if (request.mode === 'navigate') {
        const index = await cached(new Request(INDEX));
        if (index) return index;
      }
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    })()
  );
});
