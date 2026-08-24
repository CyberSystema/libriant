/**
 * Tests for the shipped service worker, `apps/web/public/sw.js`.
 *
 * The worker is the one part of the web app that only runs in production
 * (`ServiceWorkerManager` registers it behind `NODE_ENV === 'production'`), so
 * every defect in it is invisible in dev and invisible to a human clicking
 * around a preview. frontend-11 and frontend-27 were both found by reading it,
 * not by running it, and that is the gap this file closes: the real file is
 * evaluated in a sandbox with a fake Cache API, and the handlers it registers
 * are driven with fake requests.
 *
 * Run from `apps/web`: `node --import tsx --test "lib/**\/*.test.ts"`. tsx is a
 * root devDependency and reads `apps/web/tsconfig.json` for the `@/*` alias,
 * which is why the working directory matters.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SW_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js');
const SW_SOURCE = readFileSync(SW_PATH, 'utf8');

const ORIGIN = 'https://demo.libriant.com';

/* --- the smallest fake platform sw.js actually touches --------------------- */

/**
 * `sw.js` gates caching on `response.type === 'basic'` (same-origin), which a
 * Node `Response` never reports, so responses are faked rather than borrowed.
 */
class SwResponse {
  readonly status: number;
  readonly type: string;
  readonly body: string;
  constructor(body: string, init?: { status?: number; type?: string }) {
    this.body = body;
    this.status = init?.status ?? 200;
    this.type = init?.type ?? 'basic';
  }
  clone(): SwResponse {
    return new SwResponse(this.body, { status: this.status, type: this.type });
  }
  static error(): SwResponse {
    return new SwResponse('', { status: 0, type: 'error' });
  }
}

type SwRequestInit = { method?: string; mode?: string; cache?: string };

class SwRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly cache: string;
  constructor(url: string, init?: SwRequestInit) {
    this.url = url.startsWith('http') ? url : `${ORIGIN}${url}`;
    this.method = init?.method ?? 'GET';
    this.mode = init?.mode ?? 'cors';
    this.cache = init?.cache ?? 'default';
  }
}

/** Keyed by URL, like the real Cache — the query string is part of the key. */
class FakeCache {
  readonly entries = new Map<string, SwResponse>();
  constructor(private readonly store: FakeCacheStorage) {}
  async match(request: SwRequest | string): Promise<SwResponse | undefined> {
    const key = typeof request === 'string' ? new SwRequest(request).url : request.url;
    return this.entries.get(key)?.clone();
  }
  async put(request: SwRequest | string, response: SwResponse): Promise<void> {
    const key = typeof request === 'string' ? new SwRequest(request).url : request.url;
    this.entries.set(key, response);
  }
  async add(request: SwRequest | string): Promise<void> {
    const req = typeof request === 'string' ? new SwRequest(request) : request;
    this.store.added.push(req);
    const response = await this.store.fetcher(req);
    if (!response || response.status !== 200) throw new Error('add failed');
    await this.put(req, response);
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  /** Every request `cache.add()` issued — the `cache: 'reload'` proof. */
  readonly added: SwRequest[] = [];
  fetcher: (request: SwRequest) => Promise<SwResponse> = async () => {
    throw new TypeError('Failed to fetch');
  };
  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache(this);
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  async match(request: SwRequest | string): Promise<SwResponse | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
  seed(name: string, url: string, body: string): void {
    const cache = new FakeCache(this);
    const existing = this.caches.get(name) ?? cache;
    existing.entries.set(new SwRequest(url).url, new SwResponse(body));
    this.caches.set(name, existing);
  }
}

type SwEvent = {
  request?: SwRequest;
  data?: unknown;
  waitUntil: (p: Promise<unknown>) => void;
  respondWith: (p: Promise<SwResponse>) => void;
};

type Harness = {
  caches: FakeCacheStorage;
  /** Whatever the next `fetch()` from inside the worker should do. */
  setNetwork: (fn: (request: SwRequest) => Promise<SwResponse>) => void;
  install: () => Promise<void>;
  activate: () => Promise<void>;
  message: (data: unknown) => Promise<void>;
  /** Returns undefined when the worker declined to handle the request — which
   *  is how "this goes straight to the network, uncached" is expressed. */
  handle: (request: SwRequest) => Promise<SwResponse | undefined>;
};

/** Evaluate the real sw.js against fakes and hand back its registered handlers. */
function loadWorker(scriptUrl = `${ORIGIN}/sw.js?v=build-2`): Harness {
  const store = new FakeCacheStorage();
  const listeners = new Map<string, (event: SwEvent) => void>();
  const location = new URL(scriptUrl);
  const self = {
    location: { href: scriptUrl, origin: location.origin },
    addEventListener: (type: string, fn: (event: SwEvent) => void) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const sandbox = {
    self,
    caches: store,
    fetch: (request: SwRequest) => store.fetcher(request),
    Response: SwResponse,
    Request: SwRequest,
    URL,
    Promise,
    Set,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: SW_PATH });

  const dispatch = async (type: string, event: Partial<SwEvent>): Promise<unknown> => {
    const fn = listeners.get(type);
    assert.ok(fn, `sw.js registered no '${type}' listener`);
    const waited: Promise<unknown>[] = [];
    let answered: Promise<SwResponse> | undefined;
    fn({
      ...event,
      waitUntil: (p) => void waited.push(p),
      respondWith: (p) => {
        answered = p;
      },
    } as SwEvent);
    await Promise.all(waited);
    return answered;
  };

  return {
    caches: store,
    setNetwork: (fn) => {
      store.fetcher = fn;
    },
    install: async () => void (await dispatch('install', {})),
    activate: async () => void (await dispatch('activate', {})),
    message: async (data) => void (await dispatch('message', { data })),
    handle: async (request) => {
      const answered = (await dispatch('fetch', { request })) as Promise<SwResponse> | undefined;
      return answered ? await answered : undefined;
    },
  };
}

const ok = (body: string) => async () => new SwResponse(body);
const offline = () => async () => {
  throw new TypeError('Failed to fetch');
};

/* --- frontend-11: never serve a cached API response to an online client ---- */

test('an online client gets the network answer, not the cached one (frontend-11)', async () => {
  // The exact scenario: 'Μαρ' was typed before Μαρία existed, so the empty
  // result for that query string is already in the cache. Under
  // stale-while-revalidate the worker replayed it and the picker said "no
  // matches" for a member who had just been created.
  const sw = loadWorker();
  const search = '/lbr-api/t/acme/members?q=%CE%9C%CE%B1%CF%81';
  sw.caches.seed('lbr-data-build-2', search, '{"items":[]}');
  sw.setNetwork(ok('{"items":[{"name":"Μαρία"}]}'));

  const response = await sw.handle(new SwRequest(search));
  assert.ok(response, 'the worker must handle /lbr-api GETs');
  assert.equal(response.body, '{"items":[{"name":"Μαρία"}]}');

  // …and the fresh answer replaces the stale one for the offline fallback.
  const cached = await (await sw.caches.open('lbr-data-build-2')).match(new SwRequest(search));
  assert.equal(cached?.body, '{"items":[{"name":"Μαρία"}]}');
});

test('an offline client still gets the cached answer (the fix is not "stop caching")', async () => {
  const sw = loadWorker();
  const search = '/lbr-api/t/acme/loans?status=open';
  sw.caches.seed('lbr-data-build-2', search, '{"items":[1]}');
  sw.setNetwork(offline());

  const response = await sw.handle(new SwRequest(search));
  assert.equal(response?.body, '{"items":[1]}');
});

test('offline with nothing cached fails rather than inventing an answer', async () => {
  const sw = loadWorker();
  sw.setNetwork(offline());
  await assert.rejects(() => sw.handle(new SwRequest('/lbr-api/t/acme/books')));
});

test('a navigation offline falls back to the precached offline page', async () => {
  const sw = loadWorker();
  sw.setNetwork(ok('<html>offline</html>'));
  await sw.install(); // precaches /offline.html
  sw.setNetwork(offline());

  const response = await sw.handle(
    new SwRequest('/el/t/acme/loans/new', { mode: 'navigate' as const }),
  );
  assert.equal(response?.body, '<html>offline</html>');
});

/* --- frontend-27: cache names must change when the build changes ----------- */

test('cache names come from the registration build id, not a literal (frontend-27)', async () => {
  const sw = loadWorker(`${ORIGIN}/sw.js?v=build-2`);
  sw.setNetwork(ok('offline page'));
  await sw.install();
  const names = await sw.caches.keys();
  assert.ok(
    names.every((n) => n.endsWith('-build-2')),
    `expected every cache to carry the build id, got ${names.join(', ')}`,
  );
  assert.ok(
    !names.some((n) => n.endsWith('-v1')),
    'a hardcoded version is exactly the defect this guards',
  );
});

test('activate evicts the previous build and keeps this one (frontend-27)', async () => {
  const sw = loadWorker(`${ORIGIN}/sw.js?v=build-2`);
  sw.caches.seed('lbr-static-build-1', '/_next/static/old.js', 'old');
  sw.caches.seed('lbr-pages-build-1', '/el/t/acme', 'old');
  sw.caches.seed('lbr-data-build-1', '/lbr-api/t/acme/books', 'old');
  sw.caches.seed('lbr-static-build-2', '/_next/static/new.js', 'new');
  sw.caches.seed('unrelated-app-cache', '/x', 'keep');

  await sw.activate();

  const names = (await sw.caches.keys()).sort();
  assert.deepEqual(names, ['lbr-static-build-2', 'unrelated-app-cache']);
});

test('install re-fetches offline.html past the HTTP cache (frontend-27)', async () => {
  // Without `cache: 'reload'` a fresh install re-precaches the browser's stale
  // copy of the very page the new build was meant to correct.
  const sw = loadWorker();
  sw.setNetwork(ok('offline page'));
  await sw.install();
  const offlineAdd = sw.caches.added.find((r) => r.url.endsWith('/offline.html'));
  assert.equal(offlineAdd?.cache, 'reload');
});

/* --- what must never be cached -------------------------------------------- */

test('tenant media goes to the wiped data cache, never the static one (A10-01)', async () => {
  // A member photo ends in .png and would otherwise look like an immutable
  // asset — landing PII in the cache that logout does NOT clear.
  const sw = loadWorker();
  const photo = '/lbr-api/t/acme/storage/members/1/photo.png';
  sw.setNetwork(ok('JPEGDATA'));
  await sw.handle(new SwRequest(photo));

  const dataCache = await sw.caches.open('lbr-data-build-2');
  assert.ok(await dataCache.match(new SwRequest(photo)));
  const staticCache = await sw.caches.open('lbr-static-build-2');
  assert.equal(await staticCache.match(new SwRequest(photo)), undefined);
});

test('logout wipes tenant caches and keeps the static one', async () => {
  const sw = loadWorker();
  sw.caches.seed('lbr-pages-build-2', '/el/t/acme', 'page');
  sw.caches.seed('lbr-data-build-2', '/lbr-api/t/acme/members', 'members');
  sw.caches.seed('lbr-static-build-2', '/_next/static/a.js', 'chunk');

  await sw.message({ type: 'LBR_CLEAR_OFFLINE' });

  assert.deepEqual(await sw.caches.keys(), ['lbr-static-build-2']);
});

test('sensitive paths and writes are never touched by the worker', async () => {
  const sw = loadWorker();
  sw.setNetwork(ok('secret'));
  for (const url of [
    '/lbr-api/auth/session',
    '/lbr-api/billing/portal',
    '/lbr-api/admin/tenants',
    '/lbr-api/t/acme/loans/1/print',
    '/lbr-api/desktop/download/latest',
  ]) {
    assert.equal(await sw.handle(new SwRequest(url)), undefined, `${url} must bypass the worker`);
  }
  assert.equal(
    await sw.handle(new SwRequest('/lbr-api/t/acme/loans', { method: 'POST' })),
    undefined,
    'writes must never be cached',
  );
  assert.equal(await sw.caches.keys().then((k) => k.length), 0);
});

test('cross-origin requests are left alone', async () => {
  const sw = loadWorker();
  sw.setNetwork(ok('third party'));
  assert.equal(await sw.handle(new SwRequest('https://example.org/pixel.png')), undefined);
});
