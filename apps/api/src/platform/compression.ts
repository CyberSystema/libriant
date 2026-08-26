import { gzip } from 'node:zlib';
import type { NextFunction, Request, Response } from 'express';

/**
 * gzip for the API's own responses.
 *
 * performance-15: `encode zstd gzip` appears exactly once in the Caddyfile, in
 * the marketing-site block. Neither the app host nor the admin host has it, and
 * main.ts installed no compression of its own, so everything under
 * `/lbr-api/*` left this process at full size. Measured on real DTO shapes from
 * the scale database: `GET /loans?limit=100` is 60.9 KiB raw and 4.0 KiB
 * gzipped (93% saved); `GET /catalog/books?limit=25` is 15.7 KiB raw and
 * 1.4 KiB. Cloudflare re-compresses for browsers, so the visible half is
 * mostly absorbed — what is not absorbed is origin-to-edge egress on a Hetzner
 * box, the desktop app and the PWA offline sync, and any direct-to-origin or
 * self-hosted deployment, which gets the raw bytes all the way to the client.
 *
 * WHY NOT the `compression` package, which is the obvious answer: it is not a
 * dependency of this app, and a new runtime dependency days before launch buys
 * a low-severity byte count at the price of a supply-chain review. The other
 * route the audit suggested — `encode zstd gzip` on the PUBLIC_HOST and
 * ADMIN_HOST blocks — is one line each and still worth adding; it lives in
 * infra/caddy/Caddyfile and would additionally cover what Caddy serves itself.
 *
 * WHY ONLY SINGLE-SHOT RESPONSES: a response that is streamed with `res.write`
 * — today only the desktop-installer proxy, which pipes an octet-stream
 * straight through — is passed to the original `write` untouched. Compressing a
 * stream means owning backpressure, `drain`, and the flush semantics of a
 * pipeline that already works, in exchange for nothing: the streamed responses
 * here are binaries. Everything a librarian actually waits on — the loan list,
 * the catalogue, the CSV export, the rendered marketing page — is built as one
 * buffer by `res.json()` / `res.send()` and ends in a single `res.end(body)`,
 * which is the case handled below.
 *
 * BREACH: compressing a response that mixes a secret with attacker-chosen text
 * can leak the secret to someone who can both influence the input and measure
 * the size. Judged not to apply: the session and admin credentials live in
 * cookies, never in a body, and CSRF is enforced by an Origin check rather than
 * a token echoed in the payload — so there is no secret in a compressed body to
 * extract. Revisit if a token is ever rendered into a response.
 */

/** Below this, a gzip header costs more than the compression saves. */
const MIN_BYTES = 1024;

/**
 * Content types worth compressing. Everything else — images, PDFs, zip and
 * xlsx exports, installers — is already compressed, and running it through
 * gzip a second time burns CPU to add bytes.
 */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|.*\+json|javascript|xml|.*\+xml|x-ndjson)|image\/svg\+xml)/i;

export function compressResponses() {
  return function compress(req: Request, res: Response, next: NextFunction): void {
    // Set on every response, including the ones we do not compress: a shared
    // cache that stored a gzipped body under a key that ignores Accept-Encoding
    // would serve it to a client that cannot read it.
    appendVary(res);

    if (!acceptsGzip(req)) {
      next();
      return;
    }

    const rawEnd = res.end.bind(res) as (...args: unknown[]) => Response;
    const rawWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
    let streamed = false;
    let awaitingGzip = false;

    res.write = function write(...args: unknown[]): boolean {
      streamed = true;
      return rawWrite(...args);
    } as Response['write'];

    res.end = function end(...args: unknown[]): Response {
      const [chunk, maybeEncoding] = args;
      const encoding = typeof maybeEncoding === 'string' ? maybeEncoding : undefined;
      const body = toBuffer(chunk, encoding as BufferEncoding | undefined);

      // A second `end()` while the first one's gzip is still running would send
      // the response without the body and leave the callback below writing to a
      // finished stream. Nothing here does that today; the cost of being sure
      // is one boolean.
      if (awaitingGzip) return res;

      const restore = (): void => {
        res.end = rawEnd as Response['end'];
        res.write = rawWrite as Response['write'];
      };

      if (streamed || !body || !worthCompressing(res, body.length)) {
        restore();
        return rawEnd(...args);
      }

      // Headers have not been flushed yet — nothing has been written — so both
      // of these still take effect, and the error path below can undo them.
      const declaredLength = res.getHeader('Content-Length');
      res.setHeader('Content-Encoding', 'gzip');
      res.removeHeader('Content-Length');
      awaitingGzip = true;

      gzip(body, (err, compressed) => {
        awaitingGzip = false;
        restore();
        if (err) {
          // Better a slightly larger answer than none: put the response back
          // exactly as it was and send it uncompressed.
          res.removeHeader('Content-Encoding');
          if (declaredLength !== undefined) res.setHeader('Content-Length', declaredLength);
          rawEnd(...args);
          return;
        }
        // Forward whatever completion callback the caller passed, if any.
        const done = args.find((a) => typeof a === 'function');
        rawEnd(compressed, done);
      });
      return res;
    } as Response['end'];

    next();
  };
}

function acceptsGzip(req: Request): boolean {
  const header = req.headers['accept-encoding'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const token of raw.split(',')) {
    const [name, ...params] = token.trim().split(';');
    if (name?.trim().toLowerCase() !== 'gzip' && name?.trim() !== '*') continue;
    const q = params
      .map((p) => /^\s*q=([\d.]+)\s*$/i.exec(p))
      .find((m): m is RegExpExecArray => m !== null);
    // `gzip;q=0` is a client asking us NOT to.
    return q ? Number(q[1]) > 0 : true;
  }
  return false;
}

function appendVary(res: Response): void {
  const current = res.getHeader('Vary');
  const values = String(current ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.some((v) => v.toLowerCase() === 'accept-encoding' || v === '*')) return;
  values.push('Accept-Encoding');
  res.setHeader('Vary', values.join(', '));
}

function worthCompressing(res: Response, length: number): boolean {
  if (length < MIN_BYTES) return false;
  if (res.statusCode === 204 || res.statusCode === 304) return false;
  if (res.getHeader('Content-Encoding')) return false;
  // An explicit `no-transform` is a caller telling every hop, us included, to
  // leave the bytes alone.
  if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') ?? ''))) return false;
  return COMPRESSIBLE.test(String(res.getHeader('Content-Type') ?? ''));
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer | null {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  return null;
}
