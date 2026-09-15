import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This spec asserts the free-for-all desktop entitlement that is live today ' +
    '(`allowed: true, reason: free-for-all`), which only exists while subscriptions are off. ' +
    'The paid-vs-free decision table is covered by src/desktop/desktop-access.spec.ts.',
);

/**
 * End-to-end check for the desktop download + entitlement endpoints. Boots the
 * real Nest app against the dev Postgres/Redis, so the DI wiring, the
 * tenant/role guards and the gate in front of the GitHub proxy are exercised
 * for real.
 *
 * DETERMINISTIC BECAUSE IT ASSERTS THE GATE, NOT THE UPSTREAM — and it did not
 * used to be. This docblock claimed "no `desktop-v*` release exists, and even if
 * api.github.com is unreachable the proxy degrades to 404", and both halves were
 * a claim about the outside world: `DesktopReleaseService` asks GitHub live.
 * Releases v0.1.5 … v0.1.10 do exist and carry installer assets, so on
 * 2026-09-15 the proxy found one, returned 200, and a green test went red having
 * found nothing wrong with this repository. Before that it passed as often by
 * accident — an unauthenticated GitHub call from CI is rate-limited, and the 404
 * it produces is a failure being read as an empty shelf.
 *
 * So the assertions below stop at the gate: 403 when the tenant is not
 * entitled, anything-but-403-and-under-500 when it is. What GitHub had at that
 * moment is not this repository's business. The paid-vs-free entitlement
 * decision table is covered separately and deterministically by the unit spec
 * (src/desktop/desktop-access.spec.ts); here we verify the wiring, the guards,
 * and the free-for-all path that is live today.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis containers).
 */

let app: NestExpressApplication;
let slugA: string;
let slugB: string;
let tenantIdA: string;
let tenantIdB: string;

const password = 'dsk-test-password-1';
const env = loadEnv();

function uniqueSlug() {
  return 'dsk-' + randomBytes(3).toString('hex');
}

async function signup(slug: string) {
  return request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Dsk ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password,
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
}

function loginAs(slug: string) {
  return request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: `owner@${slug}.test`, password })
    .expect(200);
}

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((c) => /^(__Host-)?libriant_session=/.test(c));
  if (!session) throw new Error('no session cookie set');
  return session.split(';')[0]!;
}

async function dropTenantDb(tenantId: string) {
  const dbName = `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const admin = new PgClient({ connectionString: env.pgSuperuserUrl });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  // One ephemeral port for the file — see listen-once.ts.
  await listenOnce(app);

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slugA = uniqueSlug();
  slugB = uniqueSlug();
  const a = await signup(slugA);
  const b = await signup(slugB);
  tenantIdA = a.body.tenant.id as string;
  tenantIdB = b.body.tenant.id as string;
}, 60_000);

afterAll(async () => {
  if (!app) return;
  const cleanup = async (slug: string, tenantId: string) => {
    if (!tenantId) return;
    await controlDb.tenant.deleteMany({ where: { slug } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  };
  await Promise.all([cleanup(slugA, tenantIdA), cleanup(slugB, tenantIdB)]);
  await app.close();
}, 60_000);

describe('desktop access + download endpoints', () => {
  it('GET /desktop/access returns the entitlement contract; free-for-all while billing is off', async () => {
    const cookie = sessionCookie(await loginAs(slugA));
    const res = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/access`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        allowed: expect.any(Boolean),
        reason: expect.any(String),
        billingEnabled: expect.any(Boolean),
      }),
    );
    // The live state today (subscriptions off): everyone is entitled.
    if (res.body.billingEnabled === false) {
      expect(res.body).toMatchObject({ allowed: true, reason: 'free-for-all' });
    }
  });

  it('GET /desktop/release reports entitlement + GitHub-derived availability', async () => {
    const cookie = sessionCookie(await loginAs(slugA));
    const res = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/release`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        entitled: expect.any(Boolean),
        billingEnabled: expect.any(Boolean),
        available: expect.any(Boolean),
        platforms: expect.objectContaining({
          mac: expect.any(Boolean),
          win: expect.any(Boolean),
          linux: expect.any(Boolean),
        }),
      }),
    );
  });

  it('GET /desktop/download honors the gate: entitled → past it, else 403', async () => {
    const cookie = sessionCookie(await loginAs(slugA));
    const access = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/access`)
      .set('Cookie', cookie)
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/download?platform=mac`)
      .set('Cookie', cookie);

    // THE GATE IS WHAT THIS TEST IS ABOUT, and it is all this test may assert.
    //
    // It used to expect `404` for an entitled tenant, on the reasoning that no
    // desktop release was published — and `DesktopReleaseService` asks
    // `api.github.com` for that, live, from CI. So the expectation was a claim
    // about the OUTSIDE WORLD, and on 2026-09-15 the world changed: releases
    // v0.1.5 … v0.1.10 exist and carry installer assets, the proxy found one,
    // and a green test went red having found nothing wrong with this repository.
    //
    // Before that it passed for the wrong reason as often as the right one:
    // an unauthenticated GitHub call from CI is rate-limited, `!res.ok` logs a
    // warning and reports no release, and the 404 arrives by accident.
    //
    // So: not entitled is 403, which is the gate refusing BEFORE the proxy.
    // Entitled is anything that is not 403 — the gate let it through, and what
    // GitHub then had is not this repository's business. 5xx is still a failure
    // either way, because that would be the proxy breaking rather than the
    // upstream being empty.
    if (access.body.allowed) {
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    } else {
      expect(res.status).toBe(403);
    }
  });

  it('GET /desktop/download rejects an unknown platform (400 when entitled, 403 otherwise)', async () => {
    const cookie = sessionCookie(await loginAs(slugA));
    const access = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/access`)
      .set('Cookie', cookie)
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/download?platform=bogus`)
      .set('Cookie', cookie);
    // The entitlement gate runs before platform validation, so a non-entitled
    // tenant gets 403; an entitled one reaches parsePlatform → 400.
    expect(res.status).toBe(access.body.allowed ? 400 : 403);
  });

  it('an anonymous request to a desktop endpoint is 401', async () => {
    const res = await request(app.getHttpServer()).get(`/t/${slugA}/desktop/access`);
    expect(res.status).toBe(401);
  });

  it("tenant B cannot read tenant A's desktop endpoints (TenantGuard 403)", async () => {
    const cookieB = sessionCookie(await loginAs(slugB));
    const res = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/access`)
      .set('Cookie', cookieB);
    expect(res.status).toBe(403);
  });
});
