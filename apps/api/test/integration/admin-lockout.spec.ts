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
  'Admin sign-in is upstream of every plan gate and touches no tenant, so this runs the ' +
    'configuration customers actually get.',
);

/**
 * The admin brute-force lockout, exercised through HTTP.
 *
 * This file exists because of a specific failure. `AdminAuthService` was
 * rewritten exactly as the audit prescribed — Redis-backed, keyed on
 * (adminId, clientIp), with a doc comment telling callers in capitals to pass
 * the address — and the controller never passed it. The parameter defaulted to
 * the literal 'unknown', `lockBucket()` rejected that, and the entire lockout
 * became a no-op: eight wrong passwords followed by the right one signed in.
 *
 * Every unit test passed the whole time, because they call the service directly
 * and hand it an address. That is the shape of a test asserting an
 * implementation rather than an invariant, and the only cure is to come in
 * through the front door the attacker uses.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */
let app: NestExpressApplication;
let email: string;
let adminId: string;
const password = 'admin-lockout-test-pw-1';
/** Fixed on purpose: the lockout is per (admin, IP), so it must not rotate. */
const ATTACKER_IP = '203.0.113.55';

function login(pw: string, ip = ATTACKER_IP) {
  return request(app.getHttpServer())
    .post('/admin/auth/login')
    .set('X-Real-IP', ip)
    .send({ email, password: pw });
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error'],
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

  email = `lockout-${randomBytes(3).toString('hex')}@test.local`;
  const admin = await controlDb.adminUser.create({
    data: {
      email,
      fullName: 'Lockout Test',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync(password, 8),
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
    select: { id: true },
  });
  adminId = admin.id;
}, 60_000);

afterAll(async () => {
  if (adminId) await controlDb.adminUser.deleteMany({ where: { id: adminId } });
  if (app) await app.close();
}, 60_000);

describe('admin brute-force lockout, over HTTP (authn-authz-03)', () => {
  it('stops accepting the CORRECT password once the threshold is passed', async () => {
    // The threshold is 5 (MAX_FAILED_LOGINS). Six wrong attempts from one
    // address, then the right one — which must NOT be honoured.
    for (let i = 0; i < 6; i += 1) {
      const res = await login('definitely-wrong');
      // 401 while counting, 429 once locked; either is a refusal.
      expect([401, 429]).toContain(res.status);
    }

    const good = await login(password);
    expect(good.status).not.toBe(200);
    expect([401, 429]).toContain(good.status);
    expect(good.headers['set-cookie']).toBeUndefined();
  }, 60_000);

  it('does not lock the same admin for a DIFFERENT address', async () => {
    // The DoS half of the finding: an unauthenticated stranger must not be able
    // to lock a named admin out of the control plane. The lockout is per
    // (admin, IP) for exactly that reason, so a legitimate sign-in from
    // somewhere else still works while the attacker's bucket is hot.
    const elsewhere = await login(password, '198.51.100.9');
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers['set-cookie']).toBeDefined();
  }, 60_000);

  it('leaves the account row untouched — the lockout is never DB state', async () => {
    // Writing status='locked' from an unauthenticated path was the severe half
    // of the finding: AdminAuthGuard reads that column as account-disabled, so
    // anyone could disable any admin permanently. It must stay in Redis.
    const row = await controlDb.adminUser.findUnique({
      where: { id: adminId },
      select: { status: true, lockedUntil: true },
    });
    expect(row?.status).toBe('active');
    expect(row?.lockedUntil).toBeNull();
  }, 60_000);
});
