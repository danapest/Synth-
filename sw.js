// Offline support: network-first for the app shell (so updates show up), cache fallback when offline.
const CACHE = 'dys-v2';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/style.css', './icons/icon.svg', './icons/apple-touch-icon.png',
  './js/app.js', './js/audio.js', './js/coords.js', './js/curve.js', './js/drumseq.js', './js/export.js', './js/freedraw.js',
  './js/gestures.js', './js/model.js', './js/ops.js', './js/pianoroll.js', './js/presets.js', './js/scales.js', './js/storage.js',
  './js/store.js', './js/transport.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
