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

/**
 * End-to-end check for the desktop download + entitlement endpoints. Boots the
 * real Nest app against the dev Postgres/Redis (so DI wiring, the tenant/role
 * guards, and the GitHub-proxy 404 path are all exercised for real).
 *
 * Deterministic regardless of network: no `desktop-v*` release exists, and even
 * if api.github.com is unreachable the proxy degrades to 404. The paid-vs-free
 * entitlement decision table is covered separately + deterministically by the
 * unit spec (src/desktop/desktop-access.spec.ts); here we verify the wiring,
 * the guards, and the free-for-all path that is live today.
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

  it('GET /desktop/download honors the gate: entitled → 404 (no release), else 403', async () => {
    const cookie = sessionCookie(await loginAs(slugA));
    const access = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/access`)
      .set('Cookie', cookie)
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/t/${slugA}/desktop/download?platform=mac`)
      .set('Cookie', cookie);
    // Entitled → the gate lets it through and the proxy 404s (no desktop-v*
    // release published). Not entitled (e.g. free plan while billing is on) →
    // the gate blocks with 403 BEFORE the proxy. Never a 200 or 5xx.
    expect(res.status).toBe(access.body.allowed ? 404 : 403);
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
