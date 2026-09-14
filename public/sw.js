// Kings service worker — the ?v= in the registration URL busts caches.
const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `kings-${VERSION}`;

const CORE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'rules.js',
  'bot.js',
  'cardbacks.js',
  'themes.js',
  'wordcodes.js',
  'version.js',
  'firebase-config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'audio/card-swap.mp3',
  'audio/your-turn.mp3',
  'audio/king-found.mp3',
  'kingart/S.jpg',
  'kingart/H.jpg',
  'kingart/D.jpg',
  'kingart/C.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin (always fresh when online), cache fallback for offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match('index.html')))
  );
});
