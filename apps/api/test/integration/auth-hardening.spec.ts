import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateSync } from 'otplib';
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
  'Every finding here is an authentication or revocation boundary, not a plan gate. ' +
    'Subscriptions are OFF in the shipped configuration, so this is the posture these controls ' +
    'have to hold under; turning them on would additionally 402 the routine tenant reads and ' +
    'writes these tests use as probes and hide whether auth or the plan refused.',
);

/**
 * The auth-hardening package, driven through the real HTTP surface.
 *
 * Every assertion below reproduces an audit probe's exact position and then
 * checks the opposite outcome:
 *
 *   authn-authz-02  logout → 204, same cookie on /auth/me → 200
 *   authn-authz-04  admin disabled mid-session → GET 200, POST 201
 *   authn-authz-07  POST /auth/complete-setup {} → 200, temp password still works
 *   authn-authz-08  POST /auth/change-email with no password → 202
 *   authn-authz-09  POST /admin/mfa/setup on an enrolled admin → new secret
 *   authn-authz-10  delete two Redis keys → the locked account signs straight in
 *   launch-readiness-13  lost phone → no way back into the control plane
 *
 * Pre-reqs: `pnpm db:up`, or the audit environment.
 */

let app: NestExpressApplication;
let slug = '';
let tenantId = '';
let ownerCookie = '';
let ownerUserId = '';
let adminEmail = '';
let adminId = '';

const ownerEmail = () => `owner@${slug}.test`;
const ownerPassword = 'auth-hardening-owner-pw-1';
const adminPassword = 'auth-hardening-admin-pw-1';
const env = loadEnv();

function cookiesOf(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function cookieMatching(res: request.Response, re: RegExp): string {
  const found = cookiesOf(res).find((c) => re.test(c));
  if (!found) throw new Error(`no cookie matching ${re} in ${JSON.stringify(cookiesOf(res))}`);
  return found.split(';')[0]!;
}

const SESSION_RE = /^(__Host-)?libriant_session=/;
const ADMIN_RE = /^(__Host-)?libriant_admin=/;
const IMP_RE = /^(__Host-)?libriant_imp=/;

async function loginOwner(remember = false): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: ownerEmail(), password: ownerPassword, remember })
    .expect(200);
  return cookieMatching(res, SESSION_RE);
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

  const http = app.getHttpServer();
  slug = 'authh-' + randomBytes(3).toString('hex');
  await request(http)
    .post('/auth/signup')
    .send({
      libraryName: `Auth Hardening ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: ownerPassword,
      acceptLegal: true,
      // privacy-legal-09 made this REQUIRED: it records which language of the
      // Terms the owner was shown, and the API will not infer it.
      defaultLocale: 'el',
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  tenantId = (await controlDb.tenant.findUnique({ where: { slug }, select: { id: true } }))!.id;
  ownerCookie = await loginOwner();
  const staff = await request(http).get(`/t/${slug}/staff`).set('Cookie', ownerCookie).expect(200);
  ownerUserId = staff.body.staff[0].id;
  // Inviting staff is behind EmailVerifiedGuard and EMAIL_DRIVER is `console`,
  // so no link is ever delivered. Mark the owner verified directly — the
  // verification flow is not what this file is testing.
  await controlDb.user.update({
    where: { id: ownerUserId },
    data: { emailVerifiedAt: new Date() },
  });

  adminEmail = `authh-${randomBytes(3).toString('hex')}@test.local`;
  adminId = (
    await controlDb.adminUser.create({
      data: {
        email: adminEmail,
        fullName: 'Auth Hardening Admin',
        role: 'support',
        status: 'active',
        passwordHash: bcrypt.hashSync(adminPassword, 8),
        mfaSecretCipher: randomBytes(32),
        mfaNonce: randomBytes(12),
        mfaKeyId: 'test',
      },
      select: { id: true },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (adminId) {
    await controlDb.platformSetting
      .deleteMany({ where: { key: `admin.mfa.recovery:${adminId}` } })
      .catch(() => undefined);
  }
  if (adminEmail) {
    await controlDb.adminUser.deleteMany({ where: { email: adminEmail } }).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

// --------------------------------------------------------------------------
describe('authn-authz-02: logout actually ends the session', () => {
  it('refuses the same cookie on /auth/me AND on a tenant route after logout', async () => {
    const http = app.getHttpServer();
    const cookie = await loginOwner();
    await request(http).get('/auth/me').set('Cookie', cookie).expect(200);

    await request(http).post('/auth/logout').set('Cookie', cookie).expect(204);

    // The probe's line was `P1 /auth/me after logout -> 200`.
    await request(http).get('/auth/me').set('Cookie', cookie).expect(401);
    // Platform routes use AuthGuard and tenant data routes use TenantGuard.
    // Both have to refuse, which is why the check lives in the middleware.
    await request(http).get(`/t/${slug}/members`).set('Cookie', cookie).expect(401);
  });

  it('ends only that session — the same user stays signed in elsewhere', async () => {
    const http = app.getHttpServer();
    const desk = await loginOwner();
    const phone = await loginOwner();

    await request(http).post('/auth/logout').set('Cookie', desk).expect(204);

    await request(http).get('/auth/me').set('Cookie', desk).expect(401);
    // A logout that signed you out everywhere would be a different product
    // decision, and a worse one on a shared circulation desk.
    await request(http).get('/auth/me').set('Cookie', phone).expect(200);
  });

  it('POST /auth/sessions/revoke-all ends every session including the caller', async () => {
    const http = app.getHttpServer();
    try {
      const first = await loginOwner();
      const second = await loginOwner();
      // `sessionsValidAfter` is compared at SECOND granularity on purpose, so a
      // session minted in the same second as the bump survives it (see
      // isSessionRevoked — it keeps a reset that auto-signs-in from cancelling
      // its own new session). These two were minted milliseconds ago; wait past
      // the second boundary so the assertion is about revocation and not about
      // how fast this machine is.
      await new Promise((r) => setTimeout(r, 1_100));

      await request(http).post('/auth/sessions/revoke-all').set('Cookie', second).expect(204);

      await request(http).get('/auth/me').set('Cookie', first).expect(401);
      await request(http).get('/auth/me').set('Cookie', second).expect(401);
    } finally {
      // This test revokes EVERY session for the shared owner account, so the
      // file-level cookie has to be replaced whether it passed or not —
      // otherwise a failure here reappears as nine unrelated 401s.
      ownerCookie = await loginOwner();
    }
    // Still a working account — this is a sign-out, not a lockout.
    await request(http).get('/auth/me').set('Cookie', ownerCookie).expect(200);
  });

  it('survives the sliding re-issue: the pre-slide copy dies with the session', async () => {
    // The reason the claim is a per-SESSION id and not a per-token jti. A
    // sliding GET hands the browser a fresh token; a thief still holds the old
    // one. One logout has to kill both.
    const http = app.getHttpServer();
    const stolen = await loginOwner();

    // Force a slide by aging the token past half-life: sign a session whose
    // `ist`/`iat` are old but whose `sid` is the live one.
    const slid = await request(http).get('/auth/me').set('Cookie', stolen).expect(200);
    const reissued = cookiesOf(slid).find((c) => SESSION_RE.test(c));
    const current = reissued ? reissued.split(';')[0]! : stolen;

    await request(http).post('/auth/logout').set('Cookie', current).expect(204);
    await request(http).get('/auth/me').set('Cookie', stolen).expect(401);
  });
});

// --------------------------------------------------------------------------
describe('authn-authz-07: the forced first-login change cannot be skipped', () => {
  let tempPassword = '';
  let staffCookie = '';
  let staffUsername = '';

  it('creates a librarian and signs in with the temporary password', async () => {
    const http = app.getHttpServer();
    const created = await request(http)
      .post(`/t/${slug}/staff`)
      .set('Cookie', ownerCookie)
      .send({ fullName: 'Setup Test Librarian', role: 'librarian' })
      .expect(201);
    tempPassword = created.body.tempPassword;
    staffUsername = created.body.user.username;
    expect(tempPassword, JSON.stringify(created.body)).toBeTruthy();

    const login = await request(http)
      .post('/auth/login')
      .send({ slug, identifier: staffUsername, password: tempPassword })
      .expect(200);
    expect(login.body.user.mustChangeCredentials).toBe(true);
    staffCookie = cookieMatching(login, SESSION_RE);
  });

  it('refuses an empty body, and leaves the forced-change flag set', async () => {
    // The probe posted `{}` and got 200 {ok:true}; the DB then read
    // `mustChangeCredentials: false, sessionsValidAfter: null`.
    await request(app.getHttpServer())
      .post('/auth/complete-setup')
      .set('Cookie', staffCookie)
      .send({})
      .expect(400);
    const row = await controlDb.user.findFirst({
      where: { tenantId, username: staffUsername },
      select: { mustChangeCredentials: true, sessionsValidAfter: true },
    });
    expect(row!.mustChangeCredentials).toBe(true);
    expect(row!.sessionsValidAfter).toBeNull();
  });

  it('refuses a name-only change, which is the same bypass wearing a hat', async () => {
    await request(app.getHttpServer())
      .post('/auth/complete-setup')
      .set('Cookie', staffCookie)
      .send({ fullName: 'Renamed Only' })
      .expect(400);
  });

  it('refuses re-submitting the temporary password as the new one', async () => {
    // Otherwise the gate clears while the credential the admin read in
    // plaintext and pasted into a chat window keeps working — which is the
    // whole harm of the finding.
    await request(app.getHttpServer())
      .post('/auth/complete-setup')
      .set('Cookie', staffCookie)
      .send({ newPassword: tempPassword })
      .expect(400);
  });

  it('accepts a real new password and kills the temporary one', async () => {
    const http = app.getHttpServer();
    const chosen = 'a-genuinely-new-staff-password';
    await request(http)
      .post('/auth/complete-setup')
      .set('Cookie', staffCookie)
      .send({ fullName: 'Setup Test Librarian', newPassword: chosen })
      .expect(200);

    // The probe's last line was: signing in again with the ORIGINAL temp
    // password → 200.
    await request(http)
      .post('/auth/login')
      .send({ slug, identifier: staffUsername, password: tempPassword })
      .expect(401);
    const ok = await request(http)
      .post('/auth/login')
      .send({ slug, identifier: staffUsername, password: chosen })
      .expect(200);
    expect(ok.body.user.mustChangeCredentials).toBe(false);
  });
});

// --------------------------------------------------------------------------
describe('authn-authz-08: changing the account email costs the password', () => {
  it('refuses with no password at all', async () => {
    // The probe sent `{newEmail}` alone and got 202 {ok:true}.
    await request(app.getHttpServer())
      .post('/auth/change-email')
      .set('Cookie', ownerCookie)
      .send({ newEmail: `attacker-${randomBytes(2).toString('hex')}@evil.test` })
      .expect(400);
  });

  it('refuses a wrong password', async () => {
    await request(app.getHttpServer())
      .post('/auth/change-email')
      .set('Cookie', ownerCookie)
      .send({
        newEmail: `attacker-${randomBytes(2).toString('hex')}@evil.test`,
        currentPassword: 'nope',
      })
      .expect(401);
  });

  it('accepts the right password, warns the OLD address and tells the library', async () => {
    const target = `moved-${randomBytes(2).toString('hex')}@example.test`;
    await request(app.getHttpServer())
      .post('/auth/change-email')
      .set('Cookie', ownerCookie)
      .send({ newEmail: target, currentPassword: ownerPassword })
      .expect(202);

    // Nothing is delivered (EMAIL_DRIVER=console), so the notice has to be
    // somewhere a person can reach. Two places: the operator's outbox…
    const notice = await controlDb.emailOutbox.findFirst({
      where: { tenantId, toEmail: ownerEmail() },
      orderBy: { createdAt: 'desc' },
      select: { subject: true, bodyMarkdown: true },
    });
    expect(notice, 'no security notice queued to the previous address').toBeTruthy();
    expect(notice!.subject).toMatch(/email change/i);
    expect(notice!.bodyMarkdown).toContain(target);

    // …and the library's own activity log, which its owner reads.
    const audit = await request(app.getHttpServer())
      .get(`/t/${slug}/audit`)
      .set('Cookie', ownerCookie)
      .expect(200);
    const row = (
      audit.body.items as Array<{ action: string; after: Record<string, unknown> }>
    ).find((i) => i.action === 'account.email_change_requested');
    expect(row, JSON.stringify(audit.body.items)).toBeTruthy();
    expect(row!.after).toMatchObject({ from: ownerEmail(), to: target });

    // Staged only — the address has NOT moved until the link is opened.
    const user = await controlDb.user.findUnique({
      where: { id: ownerUserId },
      select: { email: true },
    });
    expect(user!.email).toBe(ownerEmail());
  });
});

// --------------------------------------------------------------------------
describe('authn-authz-10: the database lockout backstop exists', () => {
  it('refuses a CORRECT password while users.lockedUntil is in the future', async () => {
    // This column was selected at login.service.ts:102 and never read, and the
    // only writes anywhere set it to NULL. An operator freezing an account by
    // hand — the documented incident response — did nothing at all.
    const victim = await controlDb.user.create({
      data: {
        tenantId,
        fullName: 'Locked Backstop User',
        username: `locked_${randomBytes(2).toString('hex')}`,
        role: 'librarian',
        status: 'active',
        passwordHash: bcrypt.hashSync('backstop-user-password', 8),
        lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
      },
      select: { id: true, username: true },
    });
    try {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ slug, identifier: victim.username, password: 'backstop-user-password' })
        .expect(401);

      // Clearing it restores sign-in, so the 401 above was the lock and not a
      // broken fixture — the difference between a real assertion and X === X.
      await controlDb.user.update({ where: { id: victim.id }, data: { lockedUntil: null } });
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ slug, identifier: victim.username, password: 'backstop-user-password' })
        .expect(200);
    } finally {
      await controlDb.user.deleteMany({ where: { id: victim.id } }).catch(() => undefined);
    }
  });

  /** A librarian account with a known password, cleaned up by the caller. */
  async function makeVictim(password: string) {
    return controlDb.user.create({
      data: {
        tenantId,
        fullName: 'Lockout Probe User',
        username: `lockout_${randomBytes(3).toString('hex')}`,
        role: 'librarian',
        status: 'active',
        passwordHash: bcrypt.hashSync(password, 8),
      },
      select: { id: true, username: true },
    });
  }

  async function failLogin(username: string, ip: string) {
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Real-IP', ip)
      .send({ slug, identifier: username, password: 'definitely-not-the-password' })
      .expect(401);
  }

  it('refuses the correct password after the Redis keys are deleted mid-lockout', async () => {
    // THE AUDITED BYPASS, VERBATIM. The probe ran six wrong logins for one
    // account from one IP with Redis HEALTHY, confirmed the Redis lock key,
    // read `{"failedLogins":5,"lockedUntil":null}` off the row, then
    // `redis-cli del` d the two keys — a flush or a restart — and signed
    // straight in with the correct password: 200.
    //
    // The first remediation made `lockedUntil` READ but only ever WROTE it when
    // Redis threw, so this exact sequence still ended in 200 with the column
    // still NULL. The threshold write is on the normal path now.
    const password = 'lockout-probe-password-1';
    const victim = await makeVictim(password);
    const attackerIp = '203.0.113.10';
    const redis = app.get(RedisService);
    try {
      for (let i = 0; i <= env.maxFailedLogins; i++) await failLogin(victim.username!, attackerIp);

      expect(await redis.client.get(`login:lock:${victim.id}:${attackerIp}`)).not.toBeNull();
      const locked = await controlDb.user.findUnique({
        where: { id: victim.id },
        select: { failedLogins: true, lockedUntil: true },
      });
      expect(locked!.failedLogins).toBeGreaterThanOrEqual(env.maxFailedLogins);
      // The half the verifier measured as still missing.
      expect(locked!.lockedUntil).toBeInstanceOf(Date);
      expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Redis loses its memory. Delete the scope marker too — a real flush or
      // restart takes every key, and leaving it would make this test easier
      // than the incident it stands for.
      await redis.client.del(
        `login:fail:${victim.id}:${attackerIp}`,
        `login:lock:${victim.id}:${attackerIp}`,
        `login:lock-scope:${victim.id}`,
      );
      expect(await redis.client.get(`login:lock:${victim.id}:${attackerIp}`)).toBeNull();

      // Was 200. The durable lock now has nothing left to scope by, so it is
      // enforced account-wide.
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Real-IP', attackerIp)
        .send({ slug, identifier: victim.username, password })
        .expect(401);

      // …and it really is the lock: clear the column and the identical request
      // succeeds. Without this the 401 above could be a broken fixture.
      await controlDb.user.update({
        where: { id: victim.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Real-IP', attackerIp)
        .send({ slug, identifier: victim.username, password })
        .expect(200);
    } finally {
      await controlDb.user.deleteMany({ where: { id: victim.id } }).catch(() => undefined);
      await redis.client.del(`login:lock-scope:${victim.id}`).catch(() => undefined);
    }
  });

  it('still lets the real user in from their own address while the lock is live (A1-01)', async () => {
    // The durable lock is on the ACCOUNT, and a bare-account lock is the
    // remotely triggerable outage authn-authz-03 removed from the admin login:
    // five wrong passwords from a stranger who knows an email would lock the
    // librarian out of their own library, renewably. So while Redis can still
    // tell one client from another, the durable lock only bars the address that
    // armed it. If this test ever fails, the fix above has become a new defect.
    const password = 'lockout-probe-password-2';
    const victim = await makeVictim(password);
    const attackerIp = '203.0.113.11';
    const victimIp = '198.51.100.22';
    const redis = app.get(RedisService);
    try {
      for (let i = 0; i <= env.maxFailedLogins; i++) await failLogin(victim.username!, attackerIp);

      const locked = await controlDb.user.findUnique({
        where: { id: victim.id },
        select: { lockedUntil: true },
      });
      expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(await redis.client.get(`login:lock-scope:${victim.id}`)).toBe(attackerIp);

      // Same live lock, different address: in.
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Real-IP', victimIp)
        .send({ slug, identifier: victim.username, password })
        .expect(200);

      // The attacker's own address stays barred, and the successful sign-in
      // above cleared the lock — so re-trip it to prove the refusal is the
      // scope and not a stale key.
      for (let i = 0; i <= env.maxFailedLogins; i++) await failLogin(victim.username!, attackerIp);
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Real-IP', attackerIp)
        .send({ slug, identifier: victim.username, password })
        .expect(401);
    } finally {
      await controlDb.user.deleteMany({ where: { id: victim.id } }).catch(() => undefined);
      await redis.client.del(`login:lock-scope:${victim.id}`).catch(() => undefined);
    }
  });
});

// --------------------------------------------------------------------------
describe('authn-authz-09 + launch-readiness-13: the admin second factor', () => {
  let adminCookie = '';
  let secret = '';
  let recoveryCodes: string[] = [];

  it('enrolls a first authenticator and hands back recovery codes', async () => {
    const http = app.getHttpServer();
    const login = await request(http)
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword })
      .expect(200);
    adminCookie = cookieMatching(login, ADMIN_RE);

    const setup = await request(http)
      .post('/admin/mfa/setup')
      .set('Cookie', adminCookie)
      .expect(200);
    secret = setup.body.secret;
    const verified = await request(http)
      .post('/admin/mfa/verify')
      .set('Cookie', adminCookie)
      .send({ code: generateSync({ secret }) })
      .expect(200);

    // launch-readiness-13: `grep recovery|backupCode|recoveryCode` over the MFA
    // service, controller and schema returned nothing before this.
    recoveryCodes = verified.body.recoveryCodes;
    expect(Array.isArray(recoveryCodes)).toBe(true);
    expect(recoveryCodes).toHaveLength(10);
    const status = await request(http)
      .get('/admin/mfa/status')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(status.body).toMatchObject({ mfaEnabled: true, recoveryCodesRemaining: 10 });
  });

  it('refuses to re-issue a secret for an ENROLLED admin on the cookie alone', async () => {
    const http = app.getHttpServer();
    const before = await controlDb.adminUser.findUnique({
      where: { id: adminId },
      select: { mfaSecretCipher: true, mfaNonce: true },
    });

    // The probe called exactly this and got 200 with a fresh secret.
    const res = await request(http).post('/admin/mfa/setup').set('Cookie', adminCookie).expect(401);
    expect(res.body.code ?? res.body.message).toBeTruthy();

    const after = await controlDb.adminUser.findUnique({
      where: { id: adminId },
      select: { mfaSecretCipher: true, mfaNonce: true },
    });
    expect(Buffer.from(after!.mfaSecretCipher).equals(Buffer.from(before!.mfaSecretCipher))).toBe(
      true,
    );
    expect(Buffer.from(after!.mfaNonce).equals(Buffer.from(before!.mfaNonce))).toBe(true);
  });

  it('refuses /verify directly, even with a pending secret from before enrollment', async () => {
    // Belt and braces: `setup` is the gate, but a pending entry that predates
    // enrollment must not be persistable by going straight to `verify`.
    const http = app.getHttpServer();
    const redis = app.get(RedisService);
    const rogueSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await redis.client.set(`mfa:setup:${adminId}`, rogueSecret, 'EX', 300);

    await request(http)
      .post('/admin/mfa/verify')
      .set('Cookie', adminCookie)
      .send({ code: generateSync({ secret: rogueSecret }) })
      .expect(401);
  });

  it('allows re-enrollment with the password AND a code from the current factor', async () => {
    const http = app.getHttpServer();
    const setup = await request(http)
      .post('/admin/mfa/setup')
      .set('Cookie', adminCookie)
      .send({ currentPassword: adminPassword, currentTotp: generateSync({ secret }) })
      .expect(200);
    const next = setup.body.secret as string;
    expect(next).not.toBe(secret);

    // TOTP replay protection burns a code for ~120s, so the confirm below must
    // not reuse the one just spent on the step-up. It is a different secret
    // anyway, which is the point.
    const verified = await request(http)
      .post('/admin/mfa/verify')
      .set('Cookie', adminCookie)
      .send({ code: generateSync({ secret: next }) })
      .expect(200);
    expect(verified.body.mfaEnabled).toBe(true);
    // Replacing the factor re-issues the recovery set: the old codes were
    // printed against a factor that no longer exists.
    recoveryCodes = verified.body.recoveryCodes;
    // The response re-mints this browser's cookie, because the write bumped
    // sessionsValidAfter to kill every OTHER admin cookie.
    adminCookie = cookieMatching(verified, ADMIN_RE);
    secret = next;

    await request(http).get('/admin/auth/me').set('Cookie', adminCookie).expect(200);
  });

  it('signs in with a recovery code when the authenticator is gone, once', async () => {
    const http = app.getHttpServer();
    // A password alone is still not enough.
    await request(http)
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword })
      .expect(401);

    const code = recoveryCodes[0]!;
    const ok = await request(http)
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword, recoveryCode: code })
      .expect(200);
    expect(cookieMatching(ok, ADMIN_RE)).toBeTruthy();

    // Single-use.
    await request(http)
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword, recoveryCode: code })
      .expect(401);
    // …and a different one still works, so the first refusal was about that
    // code and not about recovery codes being broken.
    await request(http)
      .post('/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword, recoveryCode: recoveryCodes[1]! })
      .expect(200);
  });
});

// --------------------------------------------------------------------------
/**
 * The half of launch-readiness-13 that recovery codes do not reach.
 *
 * Issuing codes needs `POST /admin/mfa/verify` (a live enrollment) or
 * `POST /admin/mfa/recovery-codes` (password AND a code from the CURRENT
 * authenticator). Both require the working second factor, so neither is
 * available to the person the finding is about: one admin, TOTP mandatory in
 * production, phone already lost. `EMAIL_DRIVER` is `console`, so it cannot be
 * an emailed code either. What is left is the operator on the box, and these
 * tests drive that path as a real subprocess — the same `pnpm admin:bootstrap`
 * entry point `prod-bootstrap.sh` uses, not an exported function nothing calls.
 *
 * Procedure: docs/RUNBOOK.md §4.5a.
 */
describe('launch-readiness-13: the operator path back in when the phone is gone', () => {
  const run = promisify(execFile);
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const script = `${repoRoot}scripts/bootstrap-admin.ts`;
  const tsx = `${repoRoot}node_modules/.bin/tsx`;

  const lostEmail = `authh-lost-${randomBytes(3).toString('hex')}@test.local`;
  const lostPassword = 'lost-phone-admin-password-1';
  let lostId = '';
  let secret = '';

  /** Run the real CLI with only the env an operator would pass on the day. */
  async function bootstrap(extra: Record<string, string>) {
    return run(tsx, [script], {
      cwd: repoRoot,
      env: { ...process.env, ADMIN_BOOTSTRAP_EMAIL: lostEmail, ...extra },
    });
  }

  /** Enroll a fresh authenticator through the real endpoints. */
  async function enroll(cookie: string) {
    const http = app.getHttpServer();
    const setup = await request(http).post('/admin/mfa/setup').set('Cookie', cookie).expect(200);
    const s = setup.body.secret as string;
    await request(http)
      .post('/admin/mfa/verify')
      .set('Cookie', cookie)
      .send({ code: generateSync({ secret: s }) })
      .expect(200);
    return s;
  }

  beforeAll(async () => {
    lostId = (
      await controlDb.adminUser.create({
        data: {
          email: lostEmail,
          fullName: 'Admin Who Lost The Phone',
          role: 'owner',
          status: 'active',
          passwordHash: bcrypt.hashSync(lostPassword, 8),
          mfaSecretCipher: randomBytes(32),
          mfaNonce: randomBytes(12),
          mfaKeyId: 'test',
        },
        select: { id: true },
      })
    ).id;
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: lostEmail, password: lostPassword })
      .expect(200);
    secret = await enroll(cookieMatching(login, ADMIN_RE));
  }, 60_000);

  afterAll(async () => {
    await controlDb.platformSetting
      .deleteMany({ where: { key: `admin.mfa.recovery:${lostId}` } })
      .catch(() => undefined);
    await controlDb.adminUser.deleteMany({ where: { email: lostEmail } }).catch(() => undefined);
  });

  it('refuses to touch the second factor without the account named as confirmation', async () => {
    // `prod-bootstrap.sh` runs this script on EVERY deploy. A truthy `=1` left
    // in .env.prod would silently disarm MFA forever after, so the switch
    // carries the address of the account it is aimed at or it does nothing.
    await expect(bootstrap({ ADMIN_BOOTSTRAP_RESET_MFA: '1' })).rejects.toThrow();
    const row = await controlDb.adminUser.findUnique({
      where: { id: lostId },
      select: { mfaEnabled: true },
    });
    expect(row!.mfaEnabled).toBe(true);
  });

  it('leaves the second factor alone on an ordinary create/update run', async () => {
    // The same reason: a routine deploy that re-applies ADMIN_BOOTSTRAP_PASSWORD
    // must not un-enroll anybody. This is the property that makes the reset safe
    // to have at all.
    await bootstrap({ ADMIN_BOOTSTRAP_PASSWORD: lostPassword, ADMIN_BOOTSTRAP_ROLE: 'owner' });
    const row = await controlDb.adminUser.findUnique({
      where: { id: lostId },
      select: { mfaEnabled: true },
    });
    expect(row!.mfaEnabled).toBe(true);
    // …and the enrolled admin still cannot sign in on the password alone.
    await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: lostEmail, password: lostPassword })
      .expect(401);
  });

  it('mints usable recovery codes from the shell for an ALREADY-enrolled admin', async () => {
    // The gap this closes: the admin enrolled before recovery codes existed (or
    // through a screen that never showed them) can otherwise only obtain a set
    // by proving the authenticator they are about to lose.
    //
    // The assertion is deliberately end-to-end rather than "the row looks
    // right": a private copy of the digest format in the script would pass a
    // shape check and still hand the operator ten codes the login refuses.
    const { stdout } = await bootstrap({ ADMIN_BOOTSTRAP_ISSUE_RECOVERY_CODES: lostEmail });
    const codes = [...stdout.matchAll(/^\s{4}([A-Z0-9]{5}(?:-[A-Z0-9]{5}){3})$/gm)].map(
      (m) => m[1]!,
    );
    expect(codes).toHaveLength(10);

    const http = app.getHttpServer();
    // Still not enough on its own.
    await request(http)
      .post('/admin/auth/login')
      .send({ email: lostEmail, password: lostPassword })
      .expect(401);

    await request(http)
      .post('/admin/auth/login')
      .send({ email: lostEmail, password: lostPassword, recoveryCode: codes[0] })
      .expect(200);
    // Single-use…
    await request(http)
      .post('/admin/auth/login')
      .send({ email: lostEmail, password: lostPassword, recoveryCode: codes[0] })
      .expect(401);
    // …and a second one still works, so that refusal was about that code.
    await request(http)
      .post('/admin/auth/login')
      .send({ email: lostEmail, password: lostPassword, recoveryCode: codes[1] })
      .expect(200);
  });

  it('un-enrolls a lost authenticator and hands the account back on the password alone', async () => {
    const http = app.getHttpServer();
    // A cookie minted while the second factor was still in force. The person
    // holding the lost phone may have one of these.
    const stale = cookieMatching(
      await request(http)
        .post('/admin/auth/login')
        .send({ email: lostEmail, password: lostPassword, totp: generateSync({ secret }) })
        .expect(200),
      ADMIN_RE,
    );
    await request(http).get('/admin/auth/me').set('Cookie', stale).expect(200);

    // The phone is gone. This is the whole recovery, and it decrypts nothing —
    // so it works with MFA_MASTER_KEY lost or rotated, which is the corner
    // §4.4 of the runbook calls irrecoverable.
    const { stdout } = await bootstrap({ ADMIN_BOOTSTRAP_RESET_MFA: lostEmail });
    expect(stdout).toMatch(/password is UNCHANGED/i);

    const row = await controlDb.adminUser.findUnique({
      where: { id: lostId },
      select: { mfaEnabled: true, sessionsValidAfter: true },
    });
    expect(row!.mfaEnabled).toBe(false);
    expect(row!.sessionsValidAfter).toBeInstanceOf(Date);
    // Codes printed against a factor that no longer exists are not a bypass.
    expect(
      await controlDb.platformSetting.findUnique({
        where: { key: `admin.mfa.recovery:${lostId}` },
      }),
    ).toBeNull();

    // The cookie from before the reset is dead — recovering an account must not
    // leave whoever has the lost handset signed in.
    await request(http).get('/admin/auth/me').set('Cookie', stale).expect(401);

    // `sessionsValidAfter` is rounded up to a whole second because a JWT `iat`
    // is only second-resolution; wait past it rather than racing it, which is
    // what an operator opening a browser after running a shell command does
    // anyway. Without the wait this asserts nothing about the NEW cookie.
    const validFrom = row!.sessionsValidAfter!.getTime();
    if (Date.now() <= validFrom) {
      await new Promise((r) => setTimeout(r, validFrom - Date.now() + 50));
    }

    // THE POINT: in, with nothing but the password.
    const back = await request(http)
      .post('/admin/auth/login')
      .send({ email: lostEmail, password: lostPassword })
      .expect(200);
    await request(http)
      .get('/admin/auth/me')
      .set('Cookie', cookieMatching(back, ADMIN_RE))
      .expect(200);

    // From here the normal enrollment flow works, which is what the guard
    // pushes the operator into under ADMIN_MFA_REQUIRED.
    const fresh = await enroll(cookieMatching(back, ADMIN_RE));
    expect(fresh).not.toBe(secret);
  });
});

// --------------------------------------------------------------------------
describe('authn-authz-04: a disabled admin loses a live support session', () => {
  it('keeps working while the admin is active, and stops the moment they are not', async () => {
    const http = app.getHttpServer();

    // A fresh admin: the one above has had its second factor rotated mid-file.
    const email = `authh-imp-${randomBytes(3).toString('hex')}@test.local`;
    const row = await controlDb.adminUser.create({
      data: {
        email,
        fullName: 'Offboarding Test Admin',
        role: 'support',
        status: 'active',
        passwordHash: bcrypt.hashSync(adminPassword, 8),
        mfaSecretCipher: randomBytes(32),
        mfaNonce: randomBytes(12),
        mfaKeyId: 'test',
      },
      select: { id: true },
    });

    try {
      const login = await request(http)
        .post('/admin/auth/login')
        .send({ email, password: adminPassword })
        .expect(200);
      const cookie = cookieMatching(login, ADMIN_RE);
      const setup = await request(http).post('/admin/mfa/setup').set('Cookie', cookie).expect(200);
      const impSecret: string = setup.body.secret;
      await request(http)
        .post('/admin/mfa/verify')
        .set('Cookie', cookie)
        .send({ code: generateSync({ secret: impSecret }) })
        .expect(200);

      const key = await request(http)
        .post(`/t/${slug}/support/keys`)
        .set('Cookie', ownerCookie)
        .expect(200);
      const redeem = await request(http)
        .post('/admin/support/redeem')
        .set('Cookie', cookie)
        .send({ code: key.body.code, totp: generateSync({ secret: impSecret }) })
        .expect(200);
      const impCookie = cookieMatching(redeem, IMP_RE);

      // Baseline: the window works. Without this the disable assertion below
      // could pass against a session that never worked in the first place.
      await request(http).get(`/t/${slug}/members`).set('Cookie', impCookie).expect(200);

      // Offboard the engineer — exactly what the probe did.
      await controlDb.adminUser.update({
        where: { id: row.id },
        data: { status: 'disabled', disabledAt: new Date() },
      });

      // Probe results were 200 on the read and 201 on the write.
      await request(http).get(`/t/${slug}/members`).set('Cookie', impCookie).expect(401);
      await request(http)
        .post(`/t/${slug}/members`)
        .set('Cookie', impCookie)
        .send({ fullName: 'Should Never Exist', membershipType: 'adult' })
        .expect(401);

      // And the row is closed, so the library's support view stops showing an
      // open window that nobody can use.
      const session = await controlDb.supportSession.findFirst({
        where: { adminId: row.id },
        orderBy: { startedAt: 'desc' },
        select: { endedAt: true, endedReason: true },
      });
      expect(session!.endedAt).not.toBeNull();
      expect(session!.endedReason).toBe('admin_ended');
    } finally {
      await controlDb.supportSession
        .deleteMany({ where: { adminId: row.id } })
        .catch(() => undefined);
      await controlDb.adminUser.deleteMany({ where: { id: row.id } }).catch(() => undefined);
    }
  }, 120_000);
});
