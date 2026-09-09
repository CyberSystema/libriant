import { Injectable, PayloadTooLargeException, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CATALOG_INGEST_MAX_BYTES } from './bib.constants.js';

/**
 * Collect an `application/marc` body into a Buffer, with a hard ceiling.
 *
 * ## Why this exists at all
 *
 * `main.ts` bootstraps with `rawBody: true`, which registers the JSON and
 * urlencoded parsers and keeps a copy of the bytes for the Stripe webhook
 * signature. NEITHER PARSER CLAIMS `application/marc`, so without this the
 * ingest handler receives `{}` — an empty object rather than an error, which is
 * indistinguishable from an empty file and is exactly the failure that looks
 * like a working route in a smoke test.
 *
 * ## Why hand-rolled rather than `express.raw`
 *
 * `express` is not a dependency of `apps/api` — it arrives transitively through
 * `@nestjs/platform-express`, and importing it directly would make a transitive
 * package a direct one for thirty lines of stream reading. This repo already
 * draws that line ("we hand-roll protocols and encodings, never primitives");
 * accumulating chunks up to a limit is neither a protocol nor a primitive, it is
 * a loop.
 *
 * ## The ceiling is enforced DURING the read
 *
 * Checking `Content-Length` alone is not enough: it is a claim by the client, a
 * chunked request has none, and a body that lies about its length would be fully
 * buffered before anyone noticed. So the running total is checked per chunk and
 * the request is destroyed the moment it goes over — which is the difference
 * between a 413 and an out-of-memory.
 */
@Injectable()
export class MarcBodyMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    // Anything else falls through untouched, and the handler answers with the
    // 400 that names the content type it wants. Silently accepting a body of
    // some other type would be guessing at what a caller meant.
    if (type !== 'application/marc') {
      next();
      return;
    }

    // A declared length over the cap is refused before a byte is read.
    const declared = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > CATALOG_INGEST_MAX_BYTES) {
      next(tooLarge(declared));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      next(err);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > CATALOG_INGEST_MAX_BYTES) {
        // Stop reading. Without this the rest of the body still arrives and is
        // still counted against this process's memory.
        req.destroy();
        finish(tooLarge(total));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      req.body = Buffer.concat(chunks, total);
      finish();
    };
    const onError = (err: Error) => finish(err);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  }
}

const tooLarge = (saw: number) =>
  new PayloadTooLargeException({
    statusCode: 413,
    error: 'Payload Too Large',
    code: 'catalog.ingestTooLarge',
    message:
      `A MARC ingest body may be up to ${CATALOG_INGEST_MAX_BYTES} bytes and this one is at ` +
      `least ${saw}. Split the file — \`pnpm catalog:import\` does it with the codec's own ` +
      'splitter, so a chunk boundary never falls inside a record.',
    limitBytes: CATALOG_INGEST_MAX_BYTES,
  });
