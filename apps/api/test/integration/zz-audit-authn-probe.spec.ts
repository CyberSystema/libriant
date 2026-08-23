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

let app: NestExpressApplication;
let slug = '';
let ownerCookie = '';
let ownerId = '';
let tenantId = '';

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  slug = `aud-${randomBytes(3).toString('hex')}`;
  const signup = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Audit ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'owner-signup-pw-123',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  ownerCookie = cookieFrom(signup, /^(__Host-)?libriant_session=/);
  ownerId = signup.body.user.id;
  tenantId = signup.body.tenant.id;
  await controlDb.user.update({
    where: { id: ownerId },
    data: { emailVerifiedAt: new Date() },
  });
}, 90_000);

afterAll(async () => {
  if (app) await app.close();
});

describe('AUDIT probes', () => {
  it('P1: logout does not revoke the JWT — old cookie still authenticates', async () => {
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', ownerCookie)
      .expect(204);
    const after = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', ownerCookie);
    console.log('P1 /auth/me after logout ->', after.status);
    expect(after.status).toBe(200);
  });

  it('P2: complete-setup with an EMPTY body clears mustChangeCredentials', async () => {
    const staff = await request(app.getHttpServer())
      .post(`/t/${slug}/staff`)
      .set('Cookie', ownerCookie)
      .send({ role: 'librarian', fullName: 'Forced Change' })
      .expect(201);
    const staffUser = staff.body.user;
    const tempPw = staff.body.tempPassword;
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ slug, identifier: staffUser.username, password: tempPw })
      .expect(200);
    expect(login.body.user.mustChangeCredentials).toBe(true);
    const staffCookie = cookieFrom(login, /^(__Host-)?libriant_session=/);
    const res = await request(app.getHttpServer())
      .post('/auth/complete-setup')
      .set('Cookie', staffCookie)
      .send({});
    console.log('P2 complete-setup {} ->', res.status, JSON.stringify(res.body));
    const row = await controlDb.user.findUnique({
      where: { id: staffUser.id },
      select: { mustChangeCredentials: true, passwordHash: true, sessionsValidAfter: true },
    });
    console.log('P2 mustChangeCredentials now =', row?.mustChangeCredentials,
      'sessionsValidAfter =', row?.sessionsValidAfter);
    // Temp password still works afterwards:
    const relogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ slug, identifier: staffUser.username, password: tempPw });
    console.log('P2 re-login with ORIGINAL temp password ->', relogin.status);
    expect(res.status).toBe(200);
    expect(row?.mustChangeCredentials).toBe(false);
    expect(relogin.status).toBe(200);
  });

  it('P3: a volunteer can upload AND delete a member photo (no role guard)', async () => {
    const vol = await request(app.getHttpServer())
      .post(`/t/${slug}/staff`)
      .set('Cookie', ownerCookie)
      .send({ role: 'volunteer', fullName: 'Vol' })
      .expect(201);
    const volLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ slug, identifier: vol.body.user.username, password: vol.body.tempPassword })
      .expect(200);
    const volCookie = cookieFrom(volLogin, /^(__Host-)?libriant_session=/);

    // sanity: volunteer is blocked from a StaffWrite route
    const blocked = await request(app.getHttpServer())
      .post(`/t/${slug}/members`)
      .set('Cookie', volCookie)
      .send({ fullName: 'Nope' });
    console.log('P3 volunteer POST /members (StaffWrite) ->', blocked.status);

    const member = await request(app.getHttpServer())
      .post(`/t/${slug}/members`)
      .set('Cookie', ownerCookie)
      .send({ fullName: 'Photo Subject' })
      .expect(201);
    const memberId = member.body.member?.id ?? member.body.id;

    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
        '0d0a2db40000000049454e44ae426082',
      'hex',
    );
    const up = await request(app.getHttpServer())
      .post(`/t/${slug}/members/${memberId}/photo`)
      .set('Cookie', volCookie)
      .attach('file', png, { filename: 'x.png', contentType: 'image/png' });
    console.log('P3 volunteer POST member photo ->', up.status, JSON.stringify(up.body).slice(0, 200));

    const del = await request(app.getHttpServer())
      .delete(`/t/${slug}/members/${memberId}/photo`)
      .set('Cookie', volCookie);
    console.log('P3 volunteer DELETE member photo ->', del.status);
    expect(blocked.status).toBe(403);
    expect(up.status).toBeLessThan(300);
    expect(del.status).toBeLessThan(300);
  });

  it('P4: 5 wrong admin passwords lock the account AND kill the live admin session', async () => {
    const email = `audit-adm-${randomBytes(3).toString('hex')}@test.local`;
    const pw = 'audit-admin-password-1';
    const adm = await controlDb.adminUser.create({
      data: {
        email,
        fullName: 'Audit Admin',
        role: 'owner',
        status: 'active',
        passwordHash: bcrypt.hashSync(pw, 8),
        mfaSecretCipher: randomBytes(32),
        mfaNonce: randomBytes(12),
        mfaKeyId: 'test',
      },
    });
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const admCookie = cookieFrom(login, /^(__Host-)?libriant_admin=/);
    const before = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Cookie', admCookie);
    console.log('P4 /admin/auth/me before attack ->', before.status);

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email, password: 'definitely-wrong' });
    }
    const row = await controlDb.adminUser.findUnique({
      where: { id: adm.id },
      select: { status: true, lockedUntil: true, failedAttempts: true },
    });
    console.log('P4 admin row after 5 wrong guesses ->', JSON.stringify(row));
    const after = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Cookie', admCookie);
    console.log('P4 /admin/auth/me AFTER attack ->', after.status, JSON.stringify(after.body));
    const relogin = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password: pw });
    console.log('P4 legitimate re-login while locked ->', relogin.status);
    await controlDb.adminUser.delete({ where: { id: adm.id } }).catch(() => undefined);
    expect(before.status).toBe(200);
    expect(after.status).toBe(403);
    expect(relogin.status).toBe(401);
  });

  it('P5: email change needs no password re-auth (session-theft → account takeover)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/change-email')
      .set('Cookie', ownerCookie)
      .send({ newEmail: `attacker-${randomBytes(2).toString('hex')}@evil.test` });
    console.log('P5 POST /auth/change-email (no password) ->', res.status, JSON.stringify(res.body));
    expect(res.status).toBe(202);
  });

  it('P6: enrolled admin can silently re-enroll a NEW MFA secret with no step-up', async () => {
    const email = `audit-mfa-${randomBytes(3).toString('hex')}@test.local`;
    const pw = 'audit-admin-password-2';
    const adm = await controlDb.adminUser.create({
      data: {
        email,
        fullName: 'MFA Admin',
        role: 'owner',
        status: 'active',
        mfaEnabled: false,
        passwordHash: bcrypt.hashSync(pw, 8),
        mfaSecretCipher: randomBytes(32),
        mfaNonce: randomBytes(12),
        mfaKeyId: 'test',
      },
    });
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password: pw })
      .expect(200);
    const admCookie = cookieFrom(login, /^(__Host-)?libriant_admin=/);
    // pretend the admin is already enrolled
    await controlDb.adminUser.update({ where: { id: adm.id }, data: { mfaEnabled: true } });
    const setup = await request(app.getHttpServer())
      .post('/admin/mfa/setup')
      .set('Cookie', admCookie);
    console.log('P6 POST /admin/mfa/setup while ALREADY enrolled ->', setup.status,
      setup.body?.secret ? 'NEW SECRET ISSUED' : JSON.stringify(setup.body));
    await controlDb.adminUser.delete({ where: { id: adm.id } }).catch(() => undefined);
    expect(setup.status).toBe(200);
  });

  it('P7: impersonation survives the admin account being disabled', async () => {
    const email = `audit-imp-${randomBytes(3).toString('hex')}@test.local`;
    const adm = await controlDb.adminUser.create({
      data: {
        email,
        fullName: 'Imp Admin',
        role: 'owner',
        status: 'active',
        passwordHash: bcrypt.hashSync('x', 8),
        mfaSecretCipher: randomBytes(32),
        mfaNonce: randomBytes(12),
        mfaKeyId: 'test',
      },
    });
    // Open a support session directly (redeem path needs a live TOTP).
    const key = await controlDb.supportKey.create({
      data: {
        tenantId,
        createdByUserId: ownerId,
        codeHash: bcrypt.hashSync('ABCDEF', 8),
        codePrefix: 'ZZZZ',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const sess = await controlDb.supportSession.create({
      data: {
        tenantId,
        adminId: adm.id,
        supportKeyId: key.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const { ImpersonationSessionService } = await import(
      '../../src/support/impersonation-session.service.js'
    );
    const { ImpersonationCookieService } = await import(
      '../../src/support/impersonation-cookie.service.js'
    );
    const impJwt = new ImpersonationSessionService();
    const impCookieName = new ImpersonationCookieService().name;
    const { token } = impJwt.sign({ adminId: adm.id, tenantId, sessionId: sess.id });
    const impCookie = `${impCookieName}=${token}`;

    const ok = await request(app.getHttpServer())
      .get(`/t/${slug}/members`)
      .set('Cookie', impCookie);
    console.log('P7 impersonated GET /members while admin active ->', ok.status);

    await controlDb.adminUser.update({
      where: { id: adm.id },
      data: { status: 'disabled', disabledAt: new Date() },
    });
    const afterDisable = await request(app.getHttpServer())
      .get(`/t/${slug}/members`)
      .set('Cookie', impCookie);
    const write = await request(app.getHttpServer())
      .post(`/t/${slug}/members`)
      .set('Cookie', impCookie)
      .send({ fullName: 'Ghost Member' });
    console.log('P7 impersonated GET /members AFTER admin disabled ->', afterDisable.status);
    console.log('P7 impersonated POST /members AFTER admin disabled ->', write.status);
    await controlDb.supportSession.delete({ where: { id: sess.id } }).catch(() => undefined);
    await controlDb.supportKey.delete({ where: { id: key.id } }).catch(() => undefined);
    await controlDb.adminUser.delete({ where: { id: adm.id } }).catch(() => undefined);
    expect(ok.status).toBe(200);
    expect(afterDisable.status).toBe(200);
    expect(write.status).toBeLessThan(300);
  });

  it('P9: tenant login lockout is Redis-only — user.lockedUntil is never written', async () => {
    const uname = `owner@${slug}.test`;
    const uid = ownerId;
    const st = { body: { tempPassword: 'owner-signup-pw-123' } };
    const ip = '198.51.100.9';
    for (let i = 0; i < 6; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Real-IP', ip)
        .send({ slug, identifier: uname, password: 'wrong-password-here' });
    }
    const redis = app.get(RedisService);
    const lock = await redis.client.get(`login:lock:${uid}:${ip}`);
    const row = await controlDb.user.findUnique({
      where: { id: uid },
      select: { failedLogins: true, lockedUntil: true, status: true },
    });
    console.log('P9 redis lock key present =', lock !== null, '| db row =', JSON.stringify(row));
    // Wipe the Redis lock (== a Redis restart / flush / outage) and retry.
    await redis.client.del(`login:lock:${uid}:${ip}`, `login:fail:${uid}:${ip}`);
    const afterFlush = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Real-IP', ip)
      .send({ slug, identifier: uname, password: st.body.tempPassword });
    console.log('P9 login after Redis lock wiped ->', afterFlush.status,
      '(db lockedUntil was', row?.lockedUntil, ')');
    expect(lock).not.toBeNull();
    expect(row?.lockedUntil).toBeNull();
    expect(afterFlush.status).toBe(200);
  });

  it('P10: impersonation cookie bypasses @Roles on the library support routes', async () => {
    const email = `audit-imp2-${randomBytes(3).toString('hex')}@test.local`;
    const adm = await controlDb.adminUser.create({
      data: {
        email,
        fullName: 'Imp Admin 2',
        role: 'support',
        status: 'active',
        passwordHash: bcrypt.hashSync('x', 8),
        mfaSecretCipher: randomBytes(32),
        mfaNonce: randomBytes(12),
        mfaKeyId: 'test',
      },
    });
    const key = await controlDb.supportKey.create({
      data: {
        tenantId,
        createdByUserId: ownerId,
        codeHash: bcrypt.hashSync('QQQQQQ', 8),
        codePrefix: 'YYYY',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const sess = await controlDb.supportSession.create({
      data: {
        tenantId,
        adminId: adm.id,
        supportKeyId: key.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const { ImpersonationSessionService } = await import(
      '../../src/support/impersonation-session.service.js'
    );
    const { ImpersonationCookieService } = await import(
      '../../src/support/impersonation-cookie.service.js'
    );
    const { token } = new ImpersonationSessionService().sign({
      adminId: adm.id,
      tenantId,
      sessionId: sess.id,
    });
    const impCookie = `${new ImpersonationCookieService().name}=${token}`;
    // Library issues a pending key; the impersonating admin revokes it.
    const revoke = await request(app.getHttpServer())
      .delete(`/t/${slug}/support/keys/pending`)
      .set('Cookie', impCookie);
    const readLog = await request(app.getHttpServer())
      .get(`/t/${slug}/support/sessions/log`)
      .set('Cookie', impCookie);
    const staffList = await request(app.getHttpServer())
      .get(`/t/${slug}/staff`)
      .set('Cookie', impCookie);
    const reset = await request(app.getHttpServer())
      .post(`/t/${slug}/staff/${staffList.body.staff?.[1]?.id ?? 'none'}/reset-password`)
      .set('Cookie', impCookie);
    console.log('P10 imp DELETE /support/keys/pending ->', revoke.status);
    console.log('P10 imp GET /support/sessions/log    ->', readLog.status);
    console.log('P10 imp GET /staff                   ->', staffList.status);
    console.log('P10 imp POST /staff/:id/reset-password ->', reset.status,
      reset.body?.tempPassword ? 'TEMP PASSWORD DISCLOSED' : '');
    await controlDb.supportSession.delete({ where: { id: sess.id } }).catch(() => undefined);
    await controlDb.supportKey.delete({ where: { id: key.id } }).catch(() => undefined);
    await controlDb.adminUser.delete({ where: { id: adm.id } }).catch(() => undefined);
    expect(revoke.status).toBeLessThan(300);
  });

  it('P8: OriginCheck lets a missing Origin through on a mutating request', async () => {
    const evil = await request(app.getHttpServer())
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ slug, identifier: `owner@${slug}.test`, password: 'owner-signup-pw-123' });
    const none = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ slug, identifier: `owner@${slug}.test`, password: 'owner-signup-pw-123' });
    console.log('P8 POST /auth/login Origin: evil.example ->', evil.status);
    console.log('P8 POST /auth/login no Origin header    ->', none.status);
    expect(evil.status).toBe(403);
    expect(none.status).toBe(200);
  });
});
