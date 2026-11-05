/* Sube CACHE en cada publicación para que los dispositivos reciban los archivos nuevos. */
const CACHE = 'av-ahorros-1.1.0';
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
    await Promise.all(FILES.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) throw new Error('No se pudo guardar ' + url);
      /* El alojamiento redirige las rutas .html, y una respuesta redirigida no sirve para navegar. */
      const stored = response.redirected
        ? new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers })
        : response;
      await cache.put(url, stored);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('av-ahorros-') && n !== CACHE).map((n) => caches.delete(n)));
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
