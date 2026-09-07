/**
 * Tests for the port boundary (2.0 phase 6).
 *
 * What is worth pinning here is not "does the adapter call through" — tsc
 * proves the shapes — but the four places where a plausible refactor would
 * break something silently:
 *
 *   1. `upload()` must NOT set Content-Type. If it does, the runtime's
 *      multipart boundary never reaches the server and every cover, photo,
 *      logo and CSV import fails with an unparseable body. This is exactly why
 *      the four upload screens bypassed `api()` in the first place.
 *   2. `resourceUrl()` must keep producing `/lbr-api/…`. `public/sw.js` decides
 *      what to cache for offline reads by matching that literal prefix, and it
 *      is a plain dependency-free file that cannot import a constant. A port
 *      that moved the prefix would keep working online and silently stop
 *      working offline.
 *   3. `openExternal()` must refuse a non-http(s) scheme BEFORE any host sees
 *      it. On a native host "open this URL" with `file:` is a local file read.
 *   4. A host capability that is absent must ACK rather than throw. Every
 *      caller shows a toast; none has a try/catch.
 *
 * Run from `apps/web`: `node --import tsx --test "lib/**\/*.test.ts"`.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '@/lib/api';
import {
  BROWSER_API_PREFIX,
  BrowserPlatformPort,
  BrowserPrintPort,
  DesktopPrintPort,
  HttpDataPort,
  buildPrintPath,
} from './index';

// `api()` takes the server branch when there is no `window`, which is the case
// under node:test — so the base URL comes from the environment.
process.env.API_INTERNAL_URL = 'http://api.test';

type Captured = { url: string; init: RequestInit };

/** Install a fetch stub, run `body`, restore. Returns what fetch was handed. */
async function capture(
  respond: () => Response,
  body: (calls: Captured[]) => Promise<void>,
): Promise<Captured[]> {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

const ok = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

// -- DataPort ---------------------------------------------------------------

test('every DataPort method is present on HttpDataPort', () => {
  const port = new HttpDataPort();
  for (const m of ['get', 'post', 'patch', 'put', 'delete', 'upload', 'resourceUrl'] as const) {
    assert.equal(typeof port[m], 'function', `HttpDataPort.${m} must exist`);
  }
});

test('post sends JSON with a JSON content type and the requested method', async () => {
  const calls = await capture(
    () => ok({ id: '1' }),
    async () => {
      const got = await new HttpDataPort().post<{ id: string }>('/t/acme/loans', { copyId: 'c1' });
      assert.deepEqual(got, { id: '1' });
    },
  );
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.url, 'http://api.test/t/acme/loans');
  assert.equal(call!.init.method, 'POST');
  assert.equal((call!.init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(call!.init.body, '{"copyId":"c1"}');
});

test('an idempotency key becomes the Idempotency-Key header', async () => {
  const calls = await capture(
    () => ok({}),
    async () => {
      await new HttpDataPort().post('/t/acme/loans', {}, { idempotencyKey: 'k-1' });
    },
  );
  assert.equal((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key'], 'k-1');
});

test('upload builds a multipart body and sets NO content type', async () => {
  const calls = await capture(
    () => ok({ coverAssetRef: 'books/1.png' }),
    async () => {
      const got = await new HttpDataPort().upload<{ coverAssetRef: string }>(
        '/t/acme/catalog/books/b1/cover',
        {
          file: { name: 'cover.png', type: 'image/png', data: new Blob(['x']) },
          fields: { entityKind: 'books' },
        },
      );
      assert.deepEqual(got, { coverAssetRef: 'books/1.png' });
    },
  );
  const [call] = calls;
  assert.equal(call!.init.method, 'POST');
  // The boundary is the runtime's to choose; naming a content type here is the
  // bug this test exists for — it is why the four upload screens bypassed
  // `api()` entirely before phase 6.
  assert.equal((call!.init.headers as Record<string, string>)['Content-Type'], undefined);
  const body = call!.init.body as FormData;
  assert.ok(body instanceof FormData, 'fetch must receive a FormData');
  assert.equal(body.get('entityKind'), 'books');
  // `FileInterceptor('file')` on every upload endpoint in the API.
  const sent = body.get('file');
  assert.ok(sent instanceof File, 'the part must carry a filename');
  assert.equal(sent.name, 'cover.png');
});

test('upload accepts raw bytes, not just a Blob', async () => {
  const calls = await capture(
    () => ok({}),
    async () => {
      await new HttpDataPort().upload('/t/acme/import/books', {
        file: { name: 'rows.csv', type: 'text/csv', data: new TextEncoder().encode('a,b\n') },
      });
    },
  );
  const sent = (calls[0]!.init.body as FormData).get('file');
  assert.ok(sent instanceof File);
  assert.equal(sent.type, 'text/csv');
  assert.equal(await sent.text(), 'a,b\n');
});

test('a non-2xx response throws ApiError carrying the status and body', async () => {
  await capture(
    () => new Response(JSON.stringify({ code: 'copy_on_loan' }), { status: 409 }),
    async () => {
      await assert.rejects(
        () => new HttpDataPort().post('/t/acme/loans', {}),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'copy_on_loan');
          return true;
        },
      );
    },
  );
});

test('resourceUrl is browser-facing even on the server, and normalises the slash', () => {
  const port = new HttpDataPort();
  assert.equal(port.resourceUrl('/t/acme/storage/x.png'), '/lbr-api/t/acme/storage/x.png');
  assert.equal(port.resourceUrl('t/acme/storage/x.png'), '/lbr-api/t/acme/storage/x.png');
  // NOT the internal container address, even though this runs server-side and
  // `api()` would resolve to it — the browser is the one loading this URL.
  assert.ok(!port.resourceUrl('/x').startsWith('http://api.test'));
});

test('the service worker still matches the prefix the data port produces', () => {
  const sw = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  const marker = `'${BROWSER_API_PREFIX}/'`;
  assert.ok(
    sw.includes(marker),
    `public/sw.js decides what to cache offline by matching ${marker}; the data port ` +
      'must keep producing that prefix or offline reads stop silently.',
  );
});

// -- PlatformPort -----------------------------------------------------------

test('openExternal refuses every scheme but http and https', async () => {
  const platform = new BrowserPlatformPort();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>']) {
    const ack = await platform.openExternal(url);
    assert.equal(ack.ok, false, `${url} must be refused`);
    assert.equal(ack.reason, 'forbidden-scheme');
  }
  const bad = await platform.openExternal('http://[');
  assert.equal(bad.reason, 'invalid-url');
});

test('an absent host capability acks instead of throwing', async () => {
  const platform = new BrowserPlatformPort();
  // No `navigator.clipboard` and no `window` under node:test — the same shape a
  // browser produces on an insecure origin or with the permission denied.
  assert.deepEqual(await platform.copyText('secret'), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await platform.openExternal('https://libriant.com'), {
    ok: false,
    reason: 'unsupported',
  });
  assert.equal(typeof platform.onOnlineChange(() => undefined), 'function');
  assert.equal(platform.kind, 'browser');
});

test('isOnline is optimistic when the host has no opinion', () => {
  assert.equal(new BrowserPlatformPort().isOnline(), true);
});

// -- PrintPort --------------------------------------------------------------

test('print paths carry the /print/ segment the desktop shell validates', () => {
  const receipt = buildPrintPath({ locale: 'el', slug: 'acme', kind: 'receipt', id: 'L 1' });
  assert.equal(receipt, '/el/print/acme/receipt/L%201');
  const label = buildPrintPath({
    locale: 'en',
    slug: 'acme',
    kind: 'label',
    id: 'c/1',
    bookId: 'b 2',
  });
  assert.equal(label, '/en/print/acme/label/c%2F1?book=b%202');
  // apps/desktop/src/main.ts refuses any path whose pathname lacks this.
  for (const p of [receipt, label]) assert.ok(p.includes('/print/'));
});

test('both print implementations ack rather than throw when their host is missing', async () => {
  const target = { locale: 'el', slug: 'acme', kind: 'receipt', id: 'L1' } as const;
  assert.deepEqual(await new BrowserPrintPort().print(target), {
    ok: false,
    reason: 'unsupported',
  });
  assert.deepEqual(await new DesktopPrintPort().print(target), { ok: false, reason: 'no-bridge' });
  assert.deepEqual(await new BrowserPrintPort().listDestinations(), []);
  assert.deepEqual(await new DesktopPrintPort().listDestinations(), []);
});
