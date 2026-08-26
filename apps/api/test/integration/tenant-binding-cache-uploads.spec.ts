import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Nothing here turns on a plan limit: the subjects are the session-to-library binding, the ' +
    'resolver cache, and what an upload is allowed to contain. Subscriptions off is the ' +
    'configuration we launch in, and it is also the one where an upload reaches the storage ' +
    'layer at all (data-integrity-01).',
);

/**
 * The four tenancy / upload findings from the pre-release audit, each driven
 * over real HTTP against a real Postgres + Redis:
 *
 *   tenant-isolation-04  a session stayed valid for a library its user had
 *                        been moved out of.
 *   tenant-isolation-05  there was no way to pause a library, and the manual
 *                        UPDATE that did it was served stale for 5 minutes.
 *   tenant-isolation-07  approving a rename left every process serving the
 *                        old name for 5 minutes.
 *   input-and-files-09   an upload's declared Content-Type was believed
 *                        without ever reading the bytes.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis) + control DB migrated/seeded.
 */

let app: NestExpressApplication;
let adminId = '';
let adminCookie = '';
let slugA = '';
let slugB = '';
let tenantIdA = '';
let tenantIdB = '';
let ownerCookieA = '';
let ownerUserIdA = '';
let bookId = '';
let memberId = '';

const tag = randomBytes(3).toString('hex');
const password = 'tenancy-uploads-pw-1';
const adminPassword = 'tenancy-uploads-admin-1';
const env = loadEnv();

/** The audit's own payload: HTML bytes offered as a PNG. */
const HTML_AS_PNG = Buffer.from('<html><script>alert(1)</script></html>');
const REAL_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(128, 7),
]);

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

async function signup(slug: string) {
  return request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Tenancy ${slug}`,
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

/** The resolved context the middleware attached — i.e. what the cache holds. */
const infoA = () =>
  request(app.getHttpServer()).get(`/t/${slugA}/info`).set('Cookie', ownerCookieA);

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const admin = await controlDb.adminUser.create({
    data: {
      email: `tenancy-${tag}@test.local`,
      fullName: 'Tenancy Owner',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync(adminPassword, 8),
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
  });
  adminId = admin.id;
  const adminLogin = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: admin.email, password: adminPassword })
    .expect(200);
  adminCookie = cookieFrom(adminLogin, /^(__Host-)?libriant_admin=/);

  slugA = `tenbind-${tag}`;
  slugB = `tenbind-${tag}b`;
  const a = await signup(slugA);
  const b = await signup(slugB);
  tenantIdA = a.body.tenant.id as string;
  tenantIdB = b.body.tenant.id as string;
  ownerCookieA = cookieFrom(a, /^(__Host-)?libriant_session=/);
  ownerUserIdA = (
    await controlDb.user.findFirstOrThrow({
      where: { tenantId: tenantIdA },
      select: { id: true },
    })
  ).id;

  const book = await request(app.getHttpServer())
    .post(`/t/${slugA}/catalog/books`)
    .set('Cookie', ownerCookieA)
    .send({ title: 'Το Κιβώτιο' })
    .expect(201);
  bookId = book.body.id as string;
  const member = await request(app.getHttpServer())
    .post(`/t/${slugA}/members`)
    .set('Cookie', ownerCookieA)
    .send({ fullName: `Μαρία ${tag}` })
    .expect(201);
  memberId = member.body.id as string;
}, 60_000);

afterAll(async () => {
  if (!app) return;
  if (adminId) {
    await controlDb.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
  }
  const cleanup = async (slug: string, tenantId: string) => {
    if (!tenantId) return;
    await controlDb.tenant.deleteMany({ where: { slug } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  };
  await cleanup(slugA, tenantIdA);
  await cleanup(slugB, tenantIdB);
  await app.close();
}, 60_000);

describe('tenant-isolation-04 — the session is bound to the library the USER is in', () => {
  it('the owner can read their own library (baseline)', async () => {
    await infoA().expect(200);
  });

  it('moving the user to another library cuts the live cookie off at once', async () => {
    // The support fix / "move this librarian" / bad-restore case. The cookie is
    // untouched and its `tid` claim still says library A, which is the only
    // thing the guard used to look at.
    await controlDb.user.update({
      where: { id: ownerUserIdA },
      data: { tenantId: tenantIdB },
    });

    const res = await infoA();
    expect(res.status).toBe(401);

    await controlDb.user.update({
      where: { id: ownerUserIdA },
      data: { tenantId: tenantIdA },
    });
    await infoA().expect(200);
  });
});

describe('tenant-isolation-05 — pausing a library takes effect now, not in five minutes', () => {
  it('a manual UPDATE behind the API is still served from cache (the control)', async () => {
    await infoA().expect(200); // warm
    await controlDb.tenant.update({ where: { id: tenantIdA }, data: { status: 'suspended' } });

    // The middleware check itself is fine — it is the cached copy that is
    // stale. This is why the operator needs an endpoint and not a psql prompt.
    await infoA().expect(200);

    await controlDb.tenant.update({ where: { id: tenantIdA }, data: { status: 'active' } });
  });

  it('the endpoint pauses the library and the very next request is refused', async () => {
    await infoA().expect(200); // warm again after the restore above

    const paused = await request(app.getHttpServer())
      .put(`/admin/tenants/${tenantIdA}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'suspended', reason: 'Requested by the library.' })
      .expect(200);
    expect(paused.body.tenant.status).toBe('suspended');

    const res = await infoA();
    expect(res.status).toBe(403);
    expect(
      await controlDb.auditEvent.count({ where: { action: 'tenant.suspended' } }),
    ).toBeGreaterThan(0);
  });

  it('and resuming it brings the library back just as fast', async () => {
    await request(app.getHttpServer())
      .put(`/admin/tenants/${tenantIdA}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'active' })
      .expect(200);

    await infoA().expect(200);
  });

  it('refuses an unauthenticated caller and a status it will not set', async () => {
    await request(app.getHttpServer())
      .put(`/admin/tenants/${tenantIdA}/status`)
      .send({ status: 'suspended' })
      .expect(401);
    await request(app.getHttpServer())
      .put(`/admin/tenants/${tenantIdA}/status`)
      .set('Cookie', adminCookie)
      .send({ status: 'archived' })
      .expect(400);
  });
});

describe('tenant-isolation-07 — an approved rename is visible immediately', () => {
  it('approving the request updates the name every process serves', async () => {
    const before = await infoA().expect(200);
    expect(before.body.tenant.name).toBe(`Tenancy ${slugA}`);

    await request(app.getHttpServer())
      .post(`/t/${slugA}/library/requests`)
      .set('Cookie', ownerCookieA)
      .send({ name: 'Δημοτική Βιβλιοθήκη Καλαμάτας', requestNote: 'Official name.' })
      .expect(201);
    const list = await request(app.getHttpServer())
      .get('/admin/library-requests?status=pending')
      .set('Cookie', adminCookie)
      .expect(200);
    const pending = list.body.requests.find(
      (r: { tenant?: { slug?: string } }) => r.tenant?.slug === slugA,
    );
    expect(pending).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/admin/library-requests/${pending.id}/approve`)
      .set('Cookie', adminCookie)
      .send({ decisionNote: 'Verified.' })
      .expect(200);

    // Not "eventually": the next request. `TenantCtx().name` is what the app
    // header and the notification email bodies render.
    const after = await infoA().expect(200);
    expect(after.body.tenant.name).toBe('Δημοτική Βιβλιοθήκη Καλαμάτας');
  });

  it('editing a FREE profile field still works (it needs no invalidation)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/t/${slugA}/library`)
      .set('Cookie', ownerCookieA)
      .send({ publicPhone: '+30 210 0000000' })
      .expect(200);
    expect(res.body.profile.publicPhone).toBe('+30 210 0000000');
  });
});

describe('input-and-files-09 — an upload has to be what it says it is', () => {
  const attachLie = (req: request.Test) =>
    req.attach('file', HTML_AS_PNG, { filename: 'cover.png', contentType: 'image/png' });

  it('refuses HTML declared image/png on the storage endpoint', async () => {
    const res = await attachLie(
      request(app.getHttpServer()).post(`/t/${slugA}/storage/covers`).set('Cookie', ownerCookieA),
    );
    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/not a PNG image/);
  });

  it('refuses it on a book cover', async () => {
    const res = await attachLie(
      request(app.getHttpServer())
        .post(`/t/${slugA}/catalog/books/${bookId}/cover`)
        .set('Cookie', ownerCookieA),
    );
    expect(res.status).toBe(415);
  });

  it('refuses it on a member photo', async () => {
    const res = await attachLie(
      request(app.getHttpServer())
        .post(`/t/${slugA}/members/${memberId}/photo`)
        .set('Cookie', ownerCookieA),
    );
    expect(res.status).toBe(415);
  });

  it('refuses it on the branding logo', async () => {
    const res = await attachLie(
      request(app.getHttpServer()).post(`/t/${slugA}/branding/logo`).set('Cookie', ownerCookieA),
    );
    expect(res.status).toBe(415);
  });

  it('refuses it on an import upload', async () => {
    const res = await attachLie(
      request(app.getHttpServer())
        .post(`/t/${slugA}/imports`)
        .set('Cookie', ownerCookieA)
        .field('entityKind', 'book'),
    );
    expect(res.status).toBe(415);
  });

  it('still accepts a real PNG cover — the check must not cost a librarian a working upload', async () => {
    const res = await request(app.getHttpServer())
      .post(`/t/${slugA}/catalog/books/${bookId}/cover`)
      .set('Cookie', ownerCookieA)
      .attach('file', REAL_PNG, { filename: 'cover.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.coverAssetRef).toMatch(/^covers\//);
  });

  it('still accepts a CSV import — those carry no signature and are read by their bytes', async () => {
    const res = await request(app.getHttpServer())
      .post(`/t/${slugA}/imports`)
      .set('Cookie', ownerCookieA)
      .field('entityKind', 'book')
      .attach('file', Buffer.from('Title,ISBN\nDune,9780441013593\n'), {
        filename: 'books.csv',
        contentType: 'text/csv',
      });
    expect(res.status).toBe(201);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual(['Title', 'ISBN']);
  });
});
