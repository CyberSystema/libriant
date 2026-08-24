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
  'Tenant isolation must hold in the configuration we ship. Under `enforced` a signup ' +
    'without a subscription resolves to the conservative default plan, which can refuse the ' +
    'very writes this drill needs in order to prove they stay invisible across tenants.',
);

/**
 * Drill 3 from the plan, verbatim:
 *
 *   > Integration test creates two tenants, asserts a write to tenant A is
 *   > invisible to tenant B.
 *
 * Boots the real Nest app + hits the real Postgres dev DB. Each run uses
 * fresh slugs so re-runs don't collide, then cleans up its rows + drops
 * the two tenant DBs at the end so a re-run starts from the same baseline.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis containers).
 */

let app: NestExpressApplication;
let slugA: string;
let slugB: string;
let tenantIdA: string;
let tenantIdB: string;

const password = 'iso-test-password-1';
const env = loadEnv();

function uniqueSlug() {
  // 6 random alnum chars (no leading hyphen — slug regex requires alnum start)
  return 'iso-' + randomBytes(3).toString('hex');
}

async function signup(slug: string) {
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Iso ${slug}`,
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
  return res;
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
    // Terminate connections — Prisma may have lingering pooled clients.
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
    // Don't buffer logs in tests — we want errors to surface in vitest's
    // output so failures are diagnosable without `--reporter=verbose`.
    logger: ['error', 'warn'],
  });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  // One ephemeral port for the file — see listen-once.ts.
  await listenOnce(app);

  // The RedisService opens a non-blocking connection in its constructor.
  // `app.init()` doesn't await that, so a request that fires before the
  // socket is ready throws `Stream isn't writeable`. Wait for a real PONG
  // before the test sends its first request.
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
  // Drop both tenant DBs + their control-plane rows so a re-run starts
  // clean. AuditEvents / Subscription / BillingAccount cascade off the
  // Tenant FK, so the explicit tenant delete sweeps the row tree.
  const cleanup = async (slug: string, tenantId: string) => {
    if (!tenantId) return;
    await controlDb.tenant.deleteMany({ where: { slug } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  };
  await Promise.all([cleanup(slugA, tenantIdA), cleanup(slugB, tenantIdB)]);
  await app.close();
}, 60_000);

describe('cross-tenant isolation (Drill 3)', () => {
  it('signup creates each tenant with its own id, slug, and primary owner', () => {
    expect(slugA).not.toBe(slugB);
    expect(tenantIdA).not.toBe(tenantIdB);
    expect(tenantIdA).toMatch(/^cm/);
    expect(tenantIdB).toMatch(/^cm/);
  });

  it("a book created in tenant A is visible to tenant A's owner", async () => {
    const login = await loginAs(slugA);
    const cookie = sessionCookie(login);

    const created = await request(app.getHttpServer())
      .post(`/t/${slugA}/catalog/books`)
      .set('Cookie', cookie)
      .send({ title: 'Tenant-A-only book' })
      .expect(201);

    expect(created.body.title).toBe('Tenant-A-only book');

    const list = await request(app.getHttpServer())
      .get(`/t/${slugA}/catalog/books`)
      .set('Cookie', cookie)
      .expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ title: 'Tenant-A-only book' });
  });

  it("tenant B cannot read tenant A's catalog via tenant A's URL (TenantGuard 403)", async () => {
    const loginB = await loginAs(slugB);
    const cookieB = sessionCookie(loginB);

    const res = await request(app.getHttpServer())
      .get(`/t/${slugA}/catalog/books`)
      .set('Cookie', cookieB);

    expect(res.status).toBe(403);
  });

  it("tenant B's own catalog is empty — the write to A was invisible to B", async () => {
    const loginB = await loginAs(slugB);
    const cookieB = sessionCookie(loginB);

    const res = await request(app.getHttpServer())
      .get(`/t/${slugB}/catalog/books`)
      .set('Cookie', cookieB)
      .expect(200);

    expect(res.body.items).toHaveLength(0);
  });

  it('an anonymous request to a tenant URL is 401, not data', async () => {
    const res = await request(app.getHttpServer()).get(`/t/${slugA}/catalog/books`);
    expect(res.status).toBe(401);
  });
});
