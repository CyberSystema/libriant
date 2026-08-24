import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { EffectivePlanService, UNLIMITED_INT } from '../../src/plans/effective-plan.service.js';
import { PlatformSettingsService } from '../../src/platform-settings/platform-settings.service.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The launch configuration is the whole subject: with subscriptions off every int limit is ' +
    'the UNLIMITED_INT sentinel, which is the path that used to 500 every upload. The one case ' +
    'that needs enforcement arms the platform_settings row itself, mid-file.',
);

/**
 * Storage quota enforcement in the configuration the product actually ships in.
 *
 * With subscriptions OFF (the launch default) every int limit resolves to the
 * UNLIMITED_INT sentinel. StorageService used to scale `max_storage_mb` by 1024²
 * into a byte ceiling and bind it into the atomic reservation UPDATE — ~1024×
 * the int8 maximum handed to an int8 parameter. Postgres answered SQLSTATE 22003
 * and EVERY upload (covers, member photos, branding logos, MARC) came back as an
 * opaque 500. The entire integration suite forced BILLING_ENABLED=true, so it
 * only ever ran the configuration where the bug is invisible; this file now
 * declares the launch posture explicitly (see billing-posture.ts) and pins it.
 *
 * Both halves matter: dropping the ceiling must not drop the enforcement, so the
 * second case flips subscriptions on and proves a real finite quota still says no.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis) + control DB migrated/seeded.
 */

let app: NestExpressApplication;
let slug = '';
let tenantId = '';
let cookie = '';
let effective: EffectivePlanService;
let settings: PlatformSettingsService;
let redis: RedisService;
const password = 'storage-quota-pw-1';
const env = loadEnv();

const uploadCover = (bytes: number) =>
  request(app.getHttpServer())
    .post(`/t/${slug}/storage/covers`)
    .set('Cookie', cookie)
    .attach('file', Buffer.alloc(bytes, 7), { filename: 'cover.png', contentType: 'image/png' });

async function usedBytes(): Promise<bigint> {
  const row = await controlDb.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { storageUsedBytes: true },
  });
  return row.storageUsedBytes;
}

async function dropTenantDb(id: string) {
  const dbName = `tenant_${id.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
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

  effective = app.get(EffectivePlanService);
  settings = app.get(PlatformSettingsService);
  redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slug = 'stgq-' + randomBytes(3).toString('hex');
  const signup = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Storage Quota ${slug}`,
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
  tenantId = signup.body.tenant.id as string;

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: `owner@${slug}.test`, password })
    .expect(200);
  const raw = login.headers['set-cookie'] as unknown as string[] | string;
  const cookies = Array.isArray(raw) ? raw : [raw];
  cookie = cookies.find((c) => /libriant_session=/.test(c))!.split(';')[0]!;
}, 90_000);

afterAll(async () => {
  // The second case arms the GLOBAL subscriptions switch. Both halves have to
  // come back down — the row AND the Redis key it is cached under — or every
  // sibling spec for the next 30 s resolves a switch this file set (see
  // admin-role-guard.spec.ts for the full-cost version of getting this wrong).
  await controlDb.platformSetting
    .deleteMany({ where: { key: 'billing.enabled' } })
    .catch(() => undefined);
  await redis?.client.del('platform_setting:billing.enabled').catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('storage quota with subscriptions off (the launch configuration)', () => {
  it('accepts a cover upload and books the bytes against the tenant', async () => {
    // State the precondition rather than assume it: the shared Redis holds the
    // subscriptions switch under one global key, so a sibling spec can leave
    // this process resolving the wrong configuration. If that happens this
    // assertion names it instead of the upload silently proving nothing.
    expect(await effective.getInt(tenantId, 'max_storage_mb')).toBe(UNLIMITED_INT);

    const before = await usedBytes();
    const size = 4096;
    const res = await uploadCover(size);

    expect(res.status).toBe(201);
    expect(res.body.ref).toMatch(/^covers\/.+\.png$/);
    expect(res.body.sizeBytes).toBe(size);
    // The reservation UPDATE is the statement that used to blow up. Proving the
    // counter moved proves it ran, not merely that the route returned 201.
    expect(await usedBytes()).toBe(before + BigInt(size));
  }, 60_000);

  it('still refuses an upload that overruns a real finite quota', async () => {
    // Lifting the ceiling must not lift the enforcement. Turn subscriptions on
    // and pin this tenant to 1 MB, then push 1.5 MB at it.
    //
    // Arm the switch by writing the row + busting the cache — the two halves
    // PlatformSettingsService resolves — rather than calling setBillingEnabled():
    // that method refuses to arm enforcement unless STRIPE_DRIVER=real, and this
    // test is about the storage quota, not about Stripe.
    await controlDb.platformSetting.upsert({
      where: { key: 'billing.enabled' },
      create: { key: 'billing.enabled', value: 'true' },
      update: { value: 'true' },
    });
    await redis.client.del('platform_setting:billing.enabled');
    expect(await settings.billingEnabled()).toBe(true);

    await controlDb.tenantPlanOverride.create({
      data: { tenantId, featureKey: 'max_storage_mb', valueInt: 1 },
    });
    await effective.invalidate(tenantId);
    expect(await effective.getInt(tenantId, 'max_storage_mb')).toBe(1);

    const before = await usedBytes();
    const res = await uploadCover(Math.floor(1.5 * 1024 * 1024));

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ feature: 'max_storage_mb', limit: 1 });
    // A refused upload must not consume quota — the reservation is conditional.
    expect(await usedBytes()).toBe(before);
  }, 60_000);
});
