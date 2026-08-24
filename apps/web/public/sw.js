/* Libriant service worker — installable PWA shell + conservative offline reads.
 *
 * Strategy:
 *   - Immutable static assets (/_next/static, /_assets, fonts, images):
 *     cache-first. Safe — not tenant-specific.
 *   - API reads through the /lbr-api proxy (GET only): network-first into a
 *     runtime DATA cache. An online client always gets the server's answer; the
 *     cache is only ever read when the network fails.
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
/**
 * frontend-27: the cache names used to end in a hand-maintained `'v1'`, so no
 * deploy ever evicted anything — every release added a fresh set of hashed
 * `/_next/static` chunks on top of the last one, forever. Worse, this file is
 * a static asset that is byte-identical between deploys, so the browser saw no
 * change, never re-installed the worker, and a corrected `offline.html` could
 * not reach an install that already had the old one.
 *
 * The registration URL now carries the build id (`/sw.js?v=<buildId>`, see
 * lib/offline.ts), which both changes the script URL on every deploy — forcing
 * the install/activate cycle — and gives us a version to name the caches with,
 * so `activate` drops the previous build's set. `dev` is the fallback for a
 * registration made without the parameter.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
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
  // The desktop-installer proxy streams a ~100MB binary — never write it into
  // the runtime cache (storage blowout + a stale installer served after a new
  // release). The /desktop PANEL page is fine to cache (network-first).
  /\/desktop\/download(\/|$)/,
];
function isSensitive(pathname) {
  return SENSITIVE.some((re) => re.test(pathname));
}

const STATIC_RE = /\.(?:css|js|mjs|woff2?|ttf|otf|svg|png|jpg|jpeg|gif|webp|avif|ico)$/i;
/**
 * Content-hashed / tenant-AGNOSTIC immutable assets → cache-first into the
 * never-wiped STATIC_CACHE. A10-01: tenant-scoped media (member photos, brand
 * logos) is served under `/lbr-api/t/<slug>/storage/...` and ALSO ends in an
 * image extension — those must NOT be treated as immutable, or PII lands in
 * STATIC_CACHE and survives logout. Exclude `/lbr-api/` (it's handled by the
 * DATA_CACHE branch, which IS wiped) so only truly tenant-agnostic assets
 * (/_next/static, top-level public icons, etc.) are cache-first here.
 */
function isImmutableAsset(url) {
  if (url.pathname.startsWith('/lbr-api/')) return false;
  return url.pathname.startsWith('/_next/static/') || STATIC_RE.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Precache the offline fallback so it's available on the very first
      // network failure. `cache: 'reload'` skips the HTTP cache — otherwise a
      // fresh install can re-precache the browser's stale copy of the very page
      // the new build was meant to correct.
      await cache
        .add(new Request(OFFLINE_URL, { cache: 'reload' }))
        .catch(() => cache.add(OFFLINE_URL).catch(() => undefined));
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

/**
 * frontend-11: API reads are network-first, never stale-while-revalidate.
 *
 * SWR returns the cached body to the caller and keeps the fresh one for *next*
 * time, and nothing in the app observes the revalidation — no postMessage, no
 * re-render. So every client-side read was one round behind: add a member, type
 * the first letters of her name into the checkout picker, and if that exact
 * query had been typed before she existed the worker replayed the old empty
 * result and the librarian was told there was no such member. At a circulation
 * desk the couple of hundred milliseconds SWR saves are not worth a duplicate
 * patron record. The cache is still written on every success, so the offline
 * fallback below is unchanged.
 */
async function networkFirstData(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
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

  // A10-01: handle tenant API (incl. /storage media) BEFORE the immutable-asset
  // branch, so tenant images go to the wiped DATA_CACHE, never STATIC_CACHE.
  if (url.pathname.startsWith('/lbr-api/')) {
    if (isSensitive(url.pathname)) return; // auth/billing/admin — straight to network
    event.respondWith(networkFirstData(request, DATA_CACHE));
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    if (isSensitive(url.pathname)) return; // don't cache login/admin/billing HTML
    event.respondWith(networkFirstPage(request));
    return;
  }
});
