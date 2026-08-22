import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { PlatformSettingsService } from '../../src/platform-settings/platform-settings.service.js';
import { listenOnce } from './listen-once.js';

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
let settings: PlatformSettingsService;

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

  const redis = app.get(RedisService);
  settings = app.get(PlatformSettingsService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
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
  // So restore through the service that owns both halves, then drop the row.
  await settings.setBillingEnabled(true).catch(() => undefined);
  await controlDb.platformSetting
    .deleteMany({ where: { key: { contains: 'billing' } } })
    .catch(() => undefined);
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
