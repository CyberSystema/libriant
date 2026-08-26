import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
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
  'Password reset and email verification are account-recovery paths that must work whatever a ' +
    'library is paying; no plan gate is in front of either.',
);

/**
 * authn-authz-11: what a one-time link leaves lying in Redis.
 *
 * The reset token was the Redis KEY — `pwreset:<token>` with `{uid,tid}` as the
 * value — so anything that could read Redis read a working password reset for
 * every account with a link in flight. Production Redis has no `requirepass`
 * and runs `--appendonly yes`, so that also meant the tokens were on disk in
 * the `redis_data` volume and inside every volume-level backup. The key is the
 * SHA-256 digest now; the plaintext lives only in the message.
 *
 * These tests take the token from the real HTTP surface and then look at what
 * Redis actually holds, because that is the only place the claim can be checked.
 */
let app: NestExpressApplication;
let redis: RedisService;
let tenantId = '';
let userId = '';
let userEmail = '';
let slug = '';
let adminEmail = '';
let adminCookie = '';
const adminPassword = 'token-at-rest-admin-pw-1';

function adminCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => /^(__Host-)?libriant_admin=/.test(x));
  if (!c) throw new Error('no admin cookie set');
  return c.split(';')[0]!;
}

/**
 * Reset-token keys only — `pwreset:acct:*` and `pwreset:ip:*` are rate-limit
 * counters, not tokens.
 *
 * `KEYS` takes a pattern, not a key, so ioredis does NOT put the client's
 * `keyPrefix` on it — the pattern has to carry the prefix by hand, and the
 * names that come back have to have it taken off again before they can be fed
 * to `get`/`del`, which DO re-apply it.
 */
async function resetTokenKeys(): Promise<string[]> {
  const prefix = redis.client.options.keyPrefix ?? '';
  const keys = await redis.client.keys(`${prefix}pwreset:*`);
  return keys
    .map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k))
    .filter((k) => !k.startsWith('pwreset:acct:') && !k.startsWith('pwreset:ip:'));
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
  await listenOnce(app);
  redis = app.get(RedisService);

  const tag = randomBytes(3).toString('hex');
  // Control-plane rows only. Neither the reset request nor its redemption
  // touches a tenant database, so there is nothing to provision here.
  const cell = await controlDb.cell.findFirst();
  if (!cell) throw new Error('no seeded cell — run pnpm db:seed against the test DB');
  slug = `tokrest-${tag}`;
  const tenant = await controlDb.tenant.create({
    data: {
      slug,
      name: 'Token At Rest Library',
      cellId: cell.id,
      dbUrl: 'postgresql://placeholder/token-at-rest',
      storageUrl: `file:///tmp/libriant-token-at-rest-${tag}`,
      primaryEmail: `owner@${slug}.test`,
    },
  });
  tenantId = tenant.id;
  userEmail = `owner@${slug}.test`;
  const user = await controlDb.user.create({
    data: {
      tenantId,
      email: userEmail,
      fullName: 'Token At Rest Owner',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync('token-at-rest-owner-pw-1', 8),
    },
    select: { id: true },
  });
  userId = user.id;

  adminEmail = `tokrest-${tag}@test.local`;
  await controlDb.adminUser.create({
    data: {
      email: adminEmail,
      fullName: 'Token At Rest Admin',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync(adminPassword, 8),
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
  if (tenantId) {
    await controlDb.emailOutbox.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await controlDb.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
  }
  if (adminEmail) {
    await controlDb.adminUser.deleteMany({ where: { email: adminEmail } }).catch(() => undefined);
  }
  if (app) await app.close();
});

describe('a password-reset token is not readable out of Redis', () => {
  it('stores a digest for the public "forgot password" flow, not the token', async () => {
    const before = new Set(await resetTokenKeys());
    await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ slug, email: userEmail })
      // 202: the endpoint answers identically whether or not the address is
      // registered, so it cannot become an enumeration oracle.
      .expect(202);

    // Find OUR key by its payload rather than by name — a sibling spec sharing
    // this Redis could have minted one in the same second.
    const fresh = (await resetTokenKeys()).filter((k) => !before.has(k));
    const mine: string[] = [];
    for (const k of fresh) {
      const raw = await redis.client.get(k);
      if (raw && (JSON.parse(raw) as { uid?: string }).uid === userId) mine.push(k);
    }
    expect(mine).toHaveLength(1);
    // The token is 32 random bytes as base64url: 43 chars, mixed case, with
    // `-`/`_`. A 64-character lowercase-hex suffix cannot be one.
    expect(mine[0]).toMatch(/^pwreset:[0-9a-f]{64}$/);
    await redis.client.del(mine[0]!);
  });

  it('accepts the plaintext token from the link and leaves nothing behind', async () => {
    // The out-of-band issuer (admin account-recovery) hands the URL straight
    // back, which is the only way to see a real token without a mailbox.
    const res = await request(app.getHttpServer())
      .post(`/admin/account-recovery/users/${userId}/reset-link`)
      .set('Cookie', adminCookie)
      .expect(200);
    const token = new URLSearchParams(new URL(res.body.url as string).hash.slice(1)).get('token');
    expect(token).toBeTruthy();

    // The probe the finding describes: read Redis, mint a reset. It finds nothing.
    expect(await redis.client.exists(`pwreset:${token}`)).toBe(0);
    const digestKey = `pwreset:${createHash('sha256').update(token!, 'utf8').digest('hex')}`;
    expect(await redis.client.exists(digestKey)).toBe(1);

    // ...and the link in the librarian's hand still works, which is the half a
    // "hash it" change breaks if the two sides ever disagree.
    await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token, newPassword: 'a-fresh-owner-passphrase-9' })
      .expect(200);
    expect(await redis.client.exists(digestKey)).toBe(0);
    await request(app.getHttpServer())
      .post('/auth/password-reset/complete')
      .send({ token, newPassword: 'another-owner-passphrase-9' })
      .expect(404);
  }, 30_000);
});
