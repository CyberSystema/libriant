import { describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { Request, Response } from 'express';
import { compressResponses } from './compression.js';

/**
 * The measured case (`GET /loans?limit=100`, 60.9 KiB raw / 4.0 KiB gzipped) is
 * covered by driving a real server. What is pinned here is everything the
 * middleware must NOT do — because the failure modes are silent corruption of
 * somebody's download rather than a larger response.
 */

/** A response object that records what finally reached the socket. */
function makeRes(headers: Record<string, string | number> = {}, statusCode = 200) {
  const store = new Map<string, string | number>(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const sent: unknown[] = [];
  const res = {
    statusCode,
    getHeader: (k: string) => store.get(k.toLowerCase()),
    setHeader: (k: string, v: string | number) => store.set(k.toLowerCase(), v),
    removeHeader: (k: string) => store.delete(k.toLowerCase()),
    write: vi.fn((chunk: unknown) => {
      sent.push(chunk);
      return true;
    }),
    end: vi.fn((chunk?: unknown) => {
      if (chunk !== undefined) sent.push(chunk);
      return res;
    }),
  } as unknown as Response & { statusCode: number };
  return { res, store, sent };
}

function makeReq(acceptEncoding?: string): Request {
  return { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} } as Request;
}

/** Run the middleware, then end the response with `body`. Resolves once sent. */
async function send(req: Request, res: Response, body: Buffer | string) {
  compressResponses()(req, res, vi.fn());
  res.end(body);
  // gzip is async; give the callback a turn.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const BIG = JSON.stringify({
  loans: Array.from({ length: 400 }, (_, i) => ({ id: i, title: 'x' })),
});

describe('compressResponses', () => {
  it('gzips a large JSON response and the client gets the same bytes back', async () => {
    const { res, store, sent } = makeRes({ ...JSON_HEADERS, 'Content-Length': BIG.length });

    await send(makeReq('gzip, deflate, br'), res, BIG);

    expect(store.get('content-encoding')).toBe('gzip');
    // A stale Content-Length describing the uncompressed body truncates the
    // response at the client.
    expect(store.has('content-length')).toBe(false);
    const out = sent.at(-1) as Buffer;
    expect(out.length).toBeLessThan(BIG.length / 2);
    expect(gunzipSync(out).toString('utf8')).toBe(BIG);
  });

  it('leaves a binary download alone even when it is large', async () => {
    // The desktop installer, the xlsx and zip exports, member photos. Gzipping
    // an already-compressed payload spends CPU to add bytes.
    const { res, store, sent } = makeRes({ 'Content-Type': 'application/octet-stream' });
    const binary = Buffer.alloc(64 * 1024, 7);

    await send(makeReq('gzip'), res, binary);

    expect(store.has('content-encoding')).toBe(false);
    expect(sent.at(-1)).toBe(binary);
  });

  it('does not touch a response the client cannot decode', async () => {
    const { res, store, sent } = makeRes(JSON_HEADERS);

    await send(makeReq(undefined), res, BIG);

    expect(store.has('content-encoding')).toBe(false);
    expect(sent.at(-1)).toBe(BIG);
    // Vary still has to be set, or a shared cache hands a gzipped body to a
    // client that asked for none.
    expect(store.get('vary')).toBe('Accept-Encoding');
  });

  it('honours gzip;q=0 — the client asking us not to', async () => {
    const { res, store } = makeRes(JSON_HEADERS);

    await send(makeReq('gzip;q=0, identity'), res, BIG);

    expect(store.has('content-encoding')).toBe(false);
  });

  it('passes a streamed response straight through', async () => {
    // Only the installer proxy streams today, and compressing a stream means
    // owning backpressure for no gain. Writing first must disable it.
    const { res, store, sent } = makeRes(JSON_HEADERS);
    compressResponses()(makeReq('gzip'), res, vi.fn());

    res.write('first chunk ');
    res.end(BIG);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.has('content-encoding')).toBe(false);
    expect(sent).toEqual(['first chunk ', BIG]);
  });

  it('does not spend a gzip header on a response too small to benefit', async () => {
    const { res, store } = makeRes(JSON_HEADERS);

    await send(makeReq('gzip'), res, '{"ok":true}');

    expect(store.has('content-encoding')).toBe(false);
  });

  it('respects an explicit Cache-Control: no-transform', async () => {
    const { res, store } = makeRes({ ...JSON_HEADERS, 'Cache-Control': 'no-transform, no-store' });

    await send(makeReq('gzip'), res, BIG);

    expect(store.has('content-encoding')).toBe(false);
  });
});
