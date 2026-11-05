/* La app se mudó de dirección. Este service worker reemplaza al anterior para que quien
   ya la había abierto deje de ver la copia guardada y llegue a la página de mudanza. */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('alcancia-') || n.startsWith('av-ahorros-'))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    await self.registration.unregister();
    await Promise.all(clients.map((client) => client.navigate(client.url).catch(() => {})));
  })());
});
