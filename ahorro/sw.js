/* Sube CACHE en cada publicación para que los dispositivos reciban los archivos nuevos. */
const CACHE = 'alcancia-1.0.0';
const FILES = [
  './',
  'index.html',
  'privacidad.html',
  'styles.css',
  'core.js',
  'app.js',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('alcancia-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (error) {
      if (request.mode === 'navigate') return caches.match('index.html');
      throw error;
    }
  })());
});
