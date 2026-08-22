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

/**
 * Runtime proof that every sensitive Libriant-staff (admin) mutation writes a
 * control-plane `audit_log` row (the gap the pre-prod audit flagged: the model
 * existed but only 3 of the sensitive handlers wrote to it).
 *
 * Boots the REAL Nest app and drives each owner-gated route through HTTP, then
 * asserts the row landed with the right action, actor, tenant scope, and the
 * captured ip / userAgent. Static checks can't prove this (the writes go
 * through the live recordAdminAudit helper + DI), so — per the audit's own
 * lesson — we probe it at runtime.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis). Touches only control-plane
 * rows it creates itself; everything is torn down in afterAll.
 */
let app: NestExpressApplication;
let adminId = '';
let adminCookie = '';
let tenantId = '';
let testPlanSlug = '';
let featureKey = '';
let featureValue: { valueInt?: number; valueBool?: boolean; valueText?: string } = {};
const adminPassword = 'audit-test-pw-1';
const TEST_IP = '203.0.113.7';
const TEST_UA = 'audit-test-agent/1.0';
const tag = randomBytes(3).toString('hex');

function adminCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => /^(__Host-)?libriant_admin=/.test(x));
  if (!c) throw new Error('no admin cookie set');
  return c.split(';')[0]!;
}

/** Latest audit row for our admin + action; fails the test if none exists. */
async function latestAudit(action: string) {
  const row = await controlDb.auditEvent.findFirst({
    where: { actorId: adminId, action },
    orderBy: { occurredAt: 'desc' },
  });
  expect(row, `expected an audit_log row for action="${action}"`).toBeTruthy();
  return row!;
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
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

  const admin = await controlDb.adminUser.create({
    data: {
      email: `audit-${tag}@test.local`,
      fullName: 'Audit Test Owner',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync(adminPassword, 8),
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
  });
  adminId = admin.id;

  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: admin.email, password: adminPassword })
    .expect(200);
  adminCookie = adminCookieFrom(login);

  // Minimal control-plane fixtures. These admin endpoints only touch the
  // control plane, so a tenant + subscription row is enough — no tenant DB
  // provisioning needed.
  const cell = await controlDb.cell.findFirst();
  if (!cell) throw new Error('no seeded cell — run pnpm db:seed against the audit DB');

  const plan = await controlDb.plan.create({
    data: {
      slug: `audit-plan-${tag}`,
      name: 'Audit Test Plan',
      billingMode: 'manual',
      isPublic: false,
      sortOrder: 999,
    },
  });
  testPlanSlug = plan.slug;

  const tenant = await controlDb.tenant.create({
    data: {
      slug: `audit-t-${tag}`,
      name: 'Audit Test Library',
      cellId: cell.id,
      dbUrl: 'postgresql://placeholder/audit',
      storageUrl: 'file:///tmp/libriant-audit-test',
      primaryEmail: `audit-${tag}@test.local`,
    },
  });
  tenantId = tenant.id;

  await controlDb.subscription.create({
    data: { tenantId, planId: plan.id, billingMode: 'manual', status: 'active' },
  });

  const feature = await controlDb.planFeature.findFirst();
  if (!feature) throw new Error('no seeded plan features — run pnpm db:seed against the audit DB');
  featureKey = feature.key;
  featureValue =
    feature.type === 'integer'
      ? { valueInt: 7 }
      : feature.type === 'boolean'
        ? { valueBool: true }
        : { valueText: 'audit' };
}, 60_000);

afterAll(async () => {
  // Tear down everything we created (order respects FKs / cascades).
  await controlDb.auditEvent.deleteMany({ where: { actorId: adminId } }).catch(() => undefined);
  await controlDb.systemModeEvent
    .deleteMany({ where: { createdByAdminId: adminId } })
    .catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
  }
  if (testPlanSlug) {
    await controlDb.plan.deleteMany({ where: { slug: testPlanSlug } }).catch(() => undefined);
  }
  if (adminId) {
    await controlDb.adminUser.deleteMany({ where: { id: adminId } }).catch(() => undefined);
  }
  if (app) await app.close();
});

function authed(req: request.Test): request.Test {
  return req.set('Cookie', adminCookie).set('X-Real-IP', TEST_IP).set('User-Agent', TEST_UA);
}

describe('admin audit logging (Nest-boot, real DB)', () => {
  it('set-plan → subscription.changed (with actor, ip, ua, tenant scope)', async () => {
    await authed(
      request(app.getHttpServer())
        .post(`/admin/billing/tenants/${tenantId}/set-plan`)
        .send({ planSlug: testPlanSlug }),
    ).expect(201);

    const row = await latestAudit('subscription.changed');
    expect(row.tenantId).toBe(tenantId);
    expect(row.actorType).toBe('admin');
    expect(row.actorId).toBe(adminId);
    expect(row.ip).toBe(TEST_IP);
    expect(row.userAgent).toBe(TEST_UA);
    expect(row.afterJson).toMatchObject({ planSlug: testPlanSlug, status: 'active' });
  });

  it('set-paid-until → subscription.paid_until_set (before/after captured)', async () => {
    const paidUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await authed(
      request(app.getHttpServer())
        .post(`/admin/billing/tenants/${tenantId}/set-paid-until`)
        .send({ paidUntil }),
    ).expect(201);

    const row = await latestAudit('subscription.paid_until_set');
    expect(row.tenantId).toBe(tenantId);
    expect(row.afterJson).toMatchObject({ status: 'active' });
    expect((row.afterJson as Record<string, unknown>).paidUntil).toBe(paidUntil);
    expect(row.beforeJson).toBeTruthy();
  });

  it('PUT override → feature_override.set ; DELETE → feature_override.cleared', async () => {
    await authed(
      request(app.getHttpServer())
        .put(`/admin/tenants/${tenantId}/overrides`)
        .send({ featureKey, ...featureValue }),
    ).expect(200);
    const setRow = await latestAudit('feature_override.set');
    expect(setRow.tenantId).toBe(tenantId);
    expect(setRow.targetId).toBe(featureKey);
    expect(setRow.afterJson).toBeTruthy();

    await authed(
      request(app.getHttpServer()).delete(`/admin/tenants/${tenantId}/overrides/${featureKey}`),
    ).expect(200);
    const clearRow = await latestAudit('feature_override.cleared');
    expect(clearRow.tenantId).toBe(tenantId);
    expect(clearRow.targetId).toBe(featureKey);
    expect(clearRow.beforeJson).toBeTruthy();
  });

  it('PATCH plan → plan.updated (platform-wide, before/after diff)', async () => {
    await authed(
      request(app.getHttpServer())
        .patch(`/admin/plans/${testPlanSlug}`)
        .send({ name: 'Audit Test Plan Renamed' }),
    ).expect(200);

    const row = await latestAudit('plan.updated');
    expect(row.tenantId).toBeNull(); // platform-wide
    expect(row.targetId).toBe(testPlanSlug);
    expect(row.afterJson).toMatchObject({ name: 'Audit Test Plan Renamed' });
    expect(row.beforeJson).toMatchObject({ name: 'Audit Test Plan' });
  });

  it('PUT plan features → plan.features_updated', async () => {
    await authed(
      request(app.getHttpServer())
        .put(`/admin/plans/${testPlanSlug}/features`)
        .send({ featureKey, ...featureValue }),
    ).expect(200);

    const row = await latestAudit('plan.features_updated');
    expect(row.tenantId).toBeNull();
    expect(row.targetId).toBe(testPlanSlug);
    expect(row.afterJson).toMatchObject({ featureKey });
  });

  it('system-mode global open → system_mode.set ; end → system_mode.ended', async () => {
    const opened = await authed(
      request(app.getHttpServer()).post('/admin/system-mode/global').send({ mode: 'read_only' }),
    ).expect(201);
    const eventId = opened.body.event.id as string;

    const setRow = await latestAudit('system_mode.set');
    expect(setRow.tenantId).toBeNull(); // global
    expect(setRow.targetId).toBe(eventId);
    expect(setRow.ip).toBe(TEST_IP);

    await authed(
      request(app.getHttpServer()).post(`/admin/system-mode/events/${eventId}/end`),
    ).expect(200);
    const endRow = await latestAudit('system_mode.ended');
    expect(endRow.targetId).toBe(eventId);
  });
});
