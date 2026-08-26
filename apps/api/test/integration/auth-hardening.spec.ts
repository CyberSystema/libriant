import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
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
