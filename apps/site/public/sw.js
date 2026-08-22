/**
 * A service worker whose only job is to remove itself.
 *
 * The app used to be served from this origin, and its PWA registered a service
 * worker at scope "/" that caches pages and API responses — including tenant
 * data. Now that the apex serves the marketing site instead, any browser that
 * ever opened the app still has that worker installed and in control of
 * navigations here. Letting /sw.js 404 does NOT remove it: the old worker keeps
 * running and keeps answering from its caches.
 *
 * So this file has to exist, and it has to stay. Registering it replaces the
 * old worker; activating it clears every cache, unregisters, and reloads any
 * open tab so the visitor lands on the real page.
 *
 * Do not delete this until well past the point where any browser could still
 * be holding the old registration.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
