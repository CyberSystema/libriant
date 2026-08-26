import { BadRequestException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Two cheap structural facts about a request that every handler downstream
 * assumes and nothing checked.
 *
 * input-and-files-05 — a NUL byte anywhere in a text query parameter reached
 * Postgres, which rejects it outright (SQLSTATE 22021, "invalid byte sequence
 * for encoding UTF8: 0x00"). Prisma threw, and the exception filter turned that
 * into a 500 with a support code. Executed before this fix:
 * `GET /help/articles?q=%00` — unauthenticated, no cookie — answered 500, as
 * did the members / books / authors / audit list endpoints. For a librarian
 * that is a search box saying "something went wrong" because a NUL rode along
 * in a paste out of their old system; for the server it is one
 * error-with-stack-trace log line per anonymous request on a public endpoint.
 *
 * input-and-files-07 — `validateDto` hands the raw parsed body to
 * class-transformer's `plainToInstance`, which walks it recursively with no
 * depth bound. A ~40 KB body of `{"a":{"a":…}}` nested 5,000 deep — comfortably
 * under the 100 KB body cap — overflowed the V8 stack inside
 * `TransformOperationExecutor.getKeys` and returned a 500. Executed before this
 * fix: depth 5,000 to `/auth/login` and `/auth/signup`, neither of which needs
 * a credential, answered 500; depth 2,000 answered 400.
 *
 * WHY HERE AND NOT IN `validateDto`, where the audit put it: the depth bound
 * belongs in front of EVERY handler, not only the ones that happen to call that
 * helper. `validateDto` is per-route and opt-in, and the NUL half has no home
 * there at all — query strings never reach it (main.ts documents why there is
 * no global ValidationPipe). One middleware in the root chain covers both, and
 * covers the routes written after it.
 *
 * The NUL is STRIPPED, not rejected: it is never meaningful input, and a 400 on
 * a paste that merely contains one is a worse answer than a search that works.
 * Only U+0000 goes — tabs and newlines are legitimate inside a book description
 * or an application message, and Postgres stores them happily.
 */

/**
 * Deepest object/array nesting accepted in a request body.
 *
 * Sized as a floor, not a fit: the deepest real payload here is a Stripe event
 * (event → data → object → lines → data[] → item → price → …, about ten), and
 * the measured failure sat between 2,000 (fine) and 5,000 (RangeError). 32
 * leaves every legitimate body — including bodies for endpoints not written
 * yet — an order of magnitude of headroom, while refusing the attack two orders
 * of magnitude before class-transformer runs out of stack.
 */
const MAX_BODY_DEPTH = 32;

/** The one character Postgres refuses inside a text value. */
const NUL = '\u0000';

@Injectable()
export class RequestSanityMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    // Express 5's `req.query` is a prototype getter that re-parses `req.url` on
    // every access and returns a FRESH object (express/lib/request.js:217), so
    // sanitising what it hands back and stopping there would change nothing an
    // handler ever sees. Shadow the getter with an own property instead; that
    // is what `@Query()` reads from here on.
    const query = req.query as Record<string, unknown> | undefined;
    if (query && typeof query === 'object') {
      // No depth bound on the query: Express's default parser produces strings
      // and arrays of strings, one level, so there is nothing to bound.
      sanitize(query, Number.POSITIVE_INFINITY);
      Object.defineProperty(req, 'query', {
        value: query,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    const body: unknown = req.body;
    if (body !== null && typeof body === 'object') {
      sanitize(body, MAX_BODY_DEPTH);
    }
    next();
  }
}

/**
 * Strip U+0000 from every string reachable from `root`, and refuse anything
 * nested deeper than `maxDepth`.
 *
 * Iterative on purpose: a recursive walk would blow the same stack the depth
 * bound exists to protect, on exactly the input that triggers it.
 */
function sanitize(root: object, maxDepth: number): void {
  const stack: Array<{ node: Record<string, unknown>; depth: number }> = [
    { node: root as Record<string, unknown>, depth: 1 },
  ];

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > maxDepth) {
      throw new BadRequestException(
        `That request is nested more than ${maxDepth} levels deep — refusing it. ` +
          'Please check whatever generated it.',
      );
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === 'string') {
        if (value.includes(NUL)) node[key] = value.replaceAll(NUL, '');
      } else if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
        stack.push({ node: value as Record<string, unknown>, depth: depth + 1 });
      }
    }
  }
}
