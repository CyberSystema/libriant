import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { RequestSanityMiddleware } from './request-sanity.middleware.js';

/**
 * Both halves of this were reproduced against a running API as plain 500s:
 * `GET /help/articles?q=%00` with no cookie at all, and a 5,000-deep
 * `{"a":{"a":…}}` body to `/auth/login`. What follows pins the two behaviours
 * that stop them, plus the two things the fix must NOT do — reject a NUL
 * instead of stripping it, and eat the whitespace a librarian legitimately
 * types into a book description.
 */

/**
 * A stand-in for the Express 5 request. `query` is a PROTOTYPE getter that
 * re-parses on every access and returns a fresh object — the detail that makes
 * "sanitise in place" a silent no-op — so the middleware has to shadow it.
 */
function makeReq(rawQuery: Record<string, unknown>, body?: unknown): Request {
  const proto = {};
  Object.defineProperty(proto, 'query', {
    configurable: true,
    enumerable: true,
    get: () => structuredClone(rawQuery),
  });
  const req = Object.create(proto) as Request;
  (req as { body?: unknown }).body = body;
  return req;
}

function run(req: Request): NextFunction {
  const next = vi.fn() as unknown as NextFunction;
  new RequestSanityMiddleware().use(req, {} as Response, next);
  return next;
}

/** `{"a":{"a":…}}`, `depth` levels down. */
function nest(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 1; i < depth; i++) {
    const child: Record<string, unknown> = {};
    cursor.a = child;
    cursor = child;
  }
  cursor.a = 'leaf';
  return root;
}

describe('RequestSanityMiddleware — NUL bytes', () => {
  it('strips a NUL from a query value and makes the sanitised value stick', () => {
    const req = makeReq({ q: 'ab\u0000cd' });

    run(req);

    expect(req.query.q).toBe('abcd');
    // Read it twice: the Express getter would have handed back the raw string
    // again if the middleware had only mutated the copy it was given.
    expect(req.query.q).toBe('abcd');
  });

  it('strips a NUL from every element of a repeated query parameter', () => {
    const req = makeReq({ tag: ['a\u0000', 'b'] });

    run(req);

    expect(req.query.tag).toEqual(['a', 'b']);
  });

  it('leaves tabs and newlines alone — Postgres takes those, and typists use them', () => {
    const req = makeReq({}, { message: 'line one\nline two\tindented' });

    run(req);

    expect((req.body as { message: string }).message).toBe('line one\nline two\tindented');
  });

  it('strips a NUL from a nested body string rather than rejecting the request', () => {
    const req = makeReq({}, { member: { name: 'Μαρ\u0000ία', tags: ['a\u0000b'] } });

    const next = run(req);

    expect(req.body).toEqual({ member: { name: 'Μαρία', tags: ['ab'] } });
    expect(next).toHaveBeenCalledWith();
  });
});

describe('RequestSanityMiddleware — body nesting', () => {
  it('accepts a body at the limit', () => {
    const req = makeReq({}, nest(32));

    expect(() => run(req)).not.toThrow();
  });

  it('refuses one level past it with a 400, not a 500', () => {
    const req = makeReq({}, nest(33));

    expect(() => run(req)).toThrow(/nested more than 32 levels deep/);
  });

  it('refuses the executed 5,000-deep body without blowing the stack itself', () => {
    // The walk is iterative precisely so the guard cannot fail the same way the
    // thing it guards did (RangeError inside TransformOperationExecutor).
    const req = makeReq({}, nest(5000));

    try {
      run(req);
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as Error).constructor.name).toBe('BadRequestException');
    }
  });
});
