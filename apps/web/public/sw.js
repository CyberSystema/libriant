/* Libriant service worker — installable PWA shell + conservative offline reads.
 *
 * Strategy:
 *   - Immutable static assets (/_next/static, /_assets, fonts, images):
 *     cache-first. Safe — not tenant-specific.
 *   - API reads through the /lbr-api proxy (GET only): stale-while-revalidate
 *     into a runtime DATA cache, so an online user always gets fresh data and an
 *     offline user sees the last-known response.
 *   - Full-page navigations: network-first, falling back to the cached copy of
 *     that page and finally the offline page.
 *
 * Security:
 *   - Only same-origin GET is ever cached (writes never touch the cache).
 *   - Sensitive paths (auth, billing, admin, stripe) are NEVER cached.
 *   - The runtime caches (pages + data) hold tenant data, so they're wiped on
 *     logout via the LBR_CLEAR_OFFLINE message — see lib/offline.ts.
 *   - Non-200 / opaque responses are not cached.
 */
const VERSION = 'v1';
const STATIC_CACHE = `lbr-static-${VERSION}`;
const PAGES_CACHE = `lbr-pages-${VERSION}`;
const DATA_CACHE = `lbr-data-${VERSION}`;
const OFFLINE_URL = '/offline.html';

/** Runtime caches that may hold tenant data — cleared on logout. */
const RUNTIME_CACHES = [PAGES_CACHE, DATA_CACHE];
const ALL_CACHES = [STATIC_CACHE, ...RUNTIME_CACHES];

/** Never cache anything under these paths — sessions, payments, admin plane,
 *  and print routes (a cached receipt could be served stale across librarians). */
const SENSITIVE = [
  /\/auth(\/|$)/,
  /\/billing(\/|$)/,
  /\/admin(\/|$)/,
  /\/stripe(\/|$)/,
  /\/print(\/|$)/,
];
function isSensitive(pathname) {
  return SENSITIVE.some((re) => re.test(pathname));
}

const STATIC_RE = /\.(?:css|js|mjs|woff2?|ttf|otf|svg|png|jpg|jpeg|gif|webp|avif|ico)$/i;
/** Content-hashed/immutable → cache-first. */
function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/') || STATIC_RE.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Precache the offline fallback so it's available on the very first
      // network failure.
      await cache.add(OFFLINE_URL).catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set(ALL_CACHES);
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('lbr-') && !keep.has(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'LBR_CLEAR_OFFLINE') {
    // Wipe tenant data on logout. Keep STATIC_CACHE (no tenant data in it).
    event.waitUntil(Promise.all(RUNTIME_CACHES.map((c) => caches.delete(c))));
  } else if (data.type === 'LBR_SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.status === 200 && response.type === 'basic') {
    cache.put(request, response.clone()).catch(() => undefined);
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => undefined);
      }
      return response;
    })
    .catch(() => undefined);
  // Serve cache immediately when present; otherwise wait for the network.
  return cached || (await network) || Response.error();
}

async function networkFirstPage(request) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // never cache writes

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // same-origin only

  // Global brand assets are hot-swappable (no rebuild) → revalidate so a swap
  // shows up on the next load, while staying available offline. Not tenant data.
  if (url.pathname.startsWith('/_assets/')) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (url.pathname.startsWith('/lbr-api/')) {
    if (isSensitive(url.pathname)) return; // auth/billing/admin — straight to network
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    if (isSensitive(url.pathname)) return; // don't cache login/admin/billing HTML
    event.respondWith(networkFirstPage(request));
    return;
  }
});
