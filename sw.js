// William's Command Center — minimal service worker
// Caches the app shell so the dashboard opens offline; live data still
// requires connectivity (Supabase + edge functions). Bumps cache version
// on each deploy so stale shells get replaced.

const CACHE_VERSION = 'wcc-v3';
const APP_SHELL = [
  '/dashboard/',
  '/dashboard/index.html',
  '/dashboard/manifest.json',
  '/dashboard/icons/icon-192.png',
  '/dashboard/icons/icon-512.png',
  '/dashboard/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache Supabase / Intuit / Notion API responses or any cross-origin POSTs.
  if (event.request.method !== 'GET') return;
  if (url.host.endsWith('supabase.co') || url.host.endsWith('intuit.com') || url.host.endsWith('notion.com')) {
    return;
  }

  // App shell: cache-first with network fallback that updates the cache.
  if (url.pathname.startsWith('/dashboard/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
              const clone = networkRes.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
            }
            return networkRes;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      }),
    );
  }
});
