import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Nothing here reaches a plan gate: every request below dies in the body parser or the router, ' +
    'before any handler runs. The launch configuration is the honest default for a spec with no ' +
    'opinion about subscriptions.',
);

/**
 * reliability-13, driven rather than simulated.
 *
 * The unit spec next to the filter builds the exception by hand —
 * `Object.assign(new Error(), { status: 413, type: 'entity.too.large' })` — and
 * asks the filter what it does with it. That proves the filter's branching. It
 * cannot prove the branch is REACHED, and the half of this finding that
 * survived the first fix is exactly a reach problem: a malformed JSON body does
 * not arrive as the body-parser error the unit spec builds. NestJS converts the
 * `SyntaxError` into a `BadRequestException` before any filter runs
 * (`RoutesResolver.mapExternalException`), so it lands on the pass-through
 * branch, which returned without a log line — and pino-http, which writes the
 * "request completed" line every other request gets, sits BEHIND the body
 * parsers in the middleware chain and never saw the request either.
 *
 * `POST /auth/login` with `{oops` — the one unauthenticated endpoint anyone on
 * the internet can reach — was therefore a 400 with NO server-side record of
 * any kind: nothing to grep when a librarian reports being unable to sign in,
 * and nothing to see when a scanner walks the endpoint.
 *
 * So this sends the real bytes to the real app over a real socket and asserts
 * the filter logged. The logger is spied on the instance this spec mounts,
 * which is the same instance `main.ts` mounts (`app.useGlobalFilters(new
 * HttpExceptionFilter())`), so the only thing not exercised here is the pino
 * transport that writes it to stdout.
 */

let app: NestExpressApplication;
let filter: HttpExceptionFilter;
let warn: ReturnType<typeof vi.spyOn>;

/** Every warn line the filter emitted since the last reset, joined. */
const logged = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error'],
  });
  app.use(cookieParser());
  filter = new HttpExceptionFilter();
  app.useGlobalFilters(filter);
  await app.init();
  await listenOnce(app);
  warn = vi.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  warn.mockClear();
});

describe('a request the server could not read (reliability-13)', () => {
  it('answers a malformed JSON body 400 AND leaves a log line', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send('{oops');

    expect(res.status).toBe(400);
    // One line, carrying the three things an operator needs: what, where, why.
    expect(logged()).toContain('"status":400');
    expect(logged()).toContain('/auth/login');
    expect(logged()).toMatch(/JSON/i);
  });

  it('keeps the message the web app switches on, rather than re-skinning it', async () => {
    // Path 1 logs but does NOT replace the body. Every translated error in the
    // product arrives through this branch (`auth.setupAlreadyComplete` and the
    // rest), and a generic "We couldn't read that request" here would turn
    // precise Greek error text into a shrug.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send('{oops');

    expect(res.body.message).toMatch(/JSON/i);
    expect(res.body.message).not.toMatch(/refresh and try again/i);
  });

  it('answers an oversized body 413 AND leaves a log line', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ slug: 'x'.repeat(300_000) }));

    expect(res.status).toBe(413);
    expect(logged()).toContain('"status":413');
    expect(logged()).toContain('PayloadTooLargeError');
    // This one IS re-skinned: body-parser's message is not for a librarian.
    expect(res.body.message).toMatch(/too large/i);
  });

  it('answers a bad percent-encoding in the path 400 AND leaves a log line', async () => {
    // The other error Express raises before routing, and the other one that
    // never reached pino-http.
    const res = await request(app.getHttpServer()).get('/t/%FF/members');

    expect(res.status).toBe(400);
    expect(logged()).toContain('"status":400');
    expect(logged()).toContain('%FF');
  });

  it('does not log a SECOND line for an ordinary 4xx the access log already has', async () => {
    // The other half of the fix: `wasAccessLogged` reads the request-scoped
    // logger nestjs-pino attaches, so a 401 from a controller — which pino
    // already wrote a "request completed" line for — must not be duplicated
    // here. Without that check, every 4xx in the product doubles its log volume
    // and the new lines are the least interesting ones.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send({ slug: 'no-such-library-here', identifier: 'nobody@example.test', password: 'x' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(logged()).toBe('');
  });
});
