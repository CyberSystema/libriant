import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The subject is guard DI + role checks, not a plan gate. It also drives ' +
    'POST /admin/subscriptions, which WRITES the global switch — starting from the shipped ' +
    'value keeps what this file leaves behind predictable for the next file.',
);

/**
 * Regression guard for the AdminRolesGuard DI bug.
 *
 * The app runs on tsx (esbuild), which does NOT emit `design:paramtypes`
 * metadata, so a guard whose constructor relies on the inferred type (e.g.
 * `constructor(private reflector: Reflector)`) gets `undefined` injected and
 * 500s on EVERY route it guards. A unit test that `new`s the guard with a mock
 * Reflector can't catch this — only booting the real Nest app does. This test
 * boots the app and hits the guarded admin routes, asserting:
 *   - they do NOT 500 (the guard wiring resolves), and
 *   - `@AdminRoles('owner')` actually rejects a support-tier admin (403) while
 *     allowing reads.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */
let app: NestExpressApplication;
let adminEmail: string;
const adminPassword = 'role-guard-test-pw-1';
let adminCookie = '';
let redisService: RedisService;

function adminCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => /^(__Host-)?libriant_admin=/.test(x));
  if (!c) throw new Error('no admin cookie set');
  return c.split(';')[0]!;
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  // Mirror main.ts so guards/middleware behave as in production.
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  // One ephemeral port for the file — see listen-once.ts.
  await listenOnce(app);

  redisService = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redisService.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  adminEmail = `role-guard-${randomBytes(3).toString('hex')}@test.local`;
  await controlDb.adminUser.create({
    data: {
      email: adminEmail,
      fullName: 'Role Guard Test',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync(adminPassword, 8),
      // MFA cipher/nonce/keyId are required (set for real on enrollment);
      // placeholders here mirror scripts/bootstrap-admin.ts.
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
  });
  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: adminEmail, password: adminPassword })
    .expect(200);
  adminCookie = adminCookieFrom(login);
}, 60_000);

afterAll(async () => {
  // Clean up so re-runs + sibling specs aren't polluted (the owner toggle
  // below writes the global billing switch).
  //
  // Deleting the row is NOT enough, and getting this wrong is expensive.
  // PlatformSettingsService caches the resolved switch in Redis for 30s under
  // a single global key. The toggle below leaves that cache holding 'false';
  // deleting the row behind the service's back does not touch it, so for the
  // remaining TTL every sibling spec — in its own process, sharing this Redis
  // — reads billingEnabled false. EffectivePlanService then hands out
  // unlimitedPlan(), which turns EVERY bool feature on, so any test asserting
  // a closed plan gate sees the gate open. Measured: one poisoned run leaked
  // across six spec files and 25 seconds, and surfaced as import-api.spec.ts
  // getting 201 instead of 402 roughly one run in ten.
  //
  // So clear BOTH halves explicitly. This used to call
  // `settings.setBillingEnabled(true)` to bust the cache through the owning
  // service — but billing-02 later taught that method to REFUSE while
  // STRIPE_DRIVER is not 'real', which it never is in CI. It threw, the
  // `.catch()` ate the throw, and the DEL that lives after the throw never ran:
  // the restore had quietly stopped restoring anything. Delete the row and the
  // cached key directly, and let a failure of either be visible.
  await controlDb.platformSetting.deleteMany({ where: { key: { contains: 'billing' } } });
  await redisService?.client.del('platform_setting:billing.enabled');
  if (adminEmail) {
    await controlDb.adminUser.deleteMany({ where: { email: adminEmail } }).catch(() => undefined);
  }
  if (app) await app.close();
});

describe('admin role guard (Nest-boot regression)', () => {
  it('does not 500 on a guarded GET route — the guard DI resolves', async () => {
    // The bug manifested as 500 "Cannot read properties of undefined
    // (reading 'getAllAndOverride')". Anything but 500 proves the wiring.
    await request(app.getHttpServer()).get('/admin/tenants').set('Cookie', adminCookie).expect(200);
  });

  it('allows an owner to perform an owner-only mutation', async () => {
    await request(app.getHttpServer())
      .post('/admin/subscriptions')
      .set('Cookie', adminCookie)
      .send({ enabled: false })
      .expect(200);
  });

  it('rejects a support-tier admin on an owner-only mutation (403) but allows reads', async () => {
    await controlDb.adminUser.update({
      where: { email: adminEmail },
      data: { role: 'support' },
    });
    try {
      await request(app.getHttpServer())
        .post('/admin/subscriptions')
        .set('Cookie', adminCookie)
        .send({ enabled: false })
        .expect(403);
      // Reads remain open to support.
      await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('Cookie', adminCookie)
        .expect(200);
    } finally {
      await controlDb.adminUser.update({
        where: { email: adminEmail },
        data: { role: 'owner' },
      });
    }
  });
});

/**
 * authn-authz-14. `GET /admin/applications.csv` carried `AdminRolesGuard` and
 * no `@AdminRoles`, and the guard's old first line — `if (!required) return
 * true` — made that combination a no-op: the support tier, the lowest platform
 * privilege, pulled the whole prospect list (contact name, email, phone, city
 * and the free-text message every library typed into the public form) with one
 * GET. The default is now deny; see admin-route-roles.ts.
 */
describe('authn-authz-14: no @AdminRoles means owner-only, not everyone', () => {
  it('refuses the applicant-PII export to the support tier — and still serves it to an owner', async () => {
    const http = app.getHttpServer();
    // Owner FIRST. A "fix" that 403s every tier would pass the support half of
    // this test on its own while quietly deleting the export the operator uses.
    const asOwner = await request(http)
      .get('/admin/applications.csv')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(asOwner.text).toContain('contact_email');

    await controlDb.adminUser.update({ where: { email: adminEmail }, data: { role: 'support' } });
    try {
      await request(http).get('/admin/applications.csv').set('Cookie', adminCookie).expect(403);
      // The undecorated reads that are MEANT to be any-admin must survive the
      // flipped default — a pin is what keeps them open, not the absence of a
      // decorator.
      await request(http).get('/admin/tenants').set('Cookie', adminCookie).expect(200);
      await request(http).get('/admin/library-requests').set('Cookie', adminCookie).expect(200);
      await request(http).get('/admin/plans').set('Cookie', adminCookie).expect(200);
    } finally {
      await controlDb.adminUser.update({ where: { email: adminEmail }, data: { role: 'owner' } });
    }
  });
});
