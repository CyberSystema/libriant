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
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'AUTH-06 is an authentication gate, not a plan gate. Subscriptions ON would 402 the ' +
    'ordinary admin reads this file uses as probes and hide which control refused.',
);

/**
 * authn-authz-12 — AUTH-06 (mandatory admin MFA), driven over HTTP.
 *
 * `AdminAuthGuard` decided whether a request was allowed past the enrollment
 * wall with `path.includes('/mfa/') || path.includes('/auth/')`. That is a
 * substring test on the REQUEST path, and the request path is chosen by the
 * caller: three admin controllers take a `:tenantId`, so `GET
 * /admin/tenants/auth/overrides` contains `/auth/` and walked straight through
 * a gate that exists to stop an un-enrolled admin from touching the control
 * plane at all. Before the fix those probes reached their handlers and came
 * back 404 (no tenant is called "auth"); the point is that they were HANDLED.
 *
 * Nothing here matches on a path any more — exemption is `@MfaExempt()` on the
 * handler, or the identity of the controller class — so the probes below are
 * the regression that stops the substring test coming back.
 */
let app: NestExpressApplication;
let adminEmail = '';
let adminCookie = '';
let priorMfaRequired: string | undefined;
const adminPassword = 'mfa-gate-test-pw-1';

function adminCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => /^(__Host-)?libriant_admin=/.test(x));
  if (!c) throw new Error('no admin cookie set');
  return c.split(';')[0]!;
}

beforeAll(async () => {
  // setup.ts turns AUTH-06 OFF for the suite, because every other admin spec
  // bootstraps a password-only admin and would otherwise be redirected into
  // enrollment. This file is the one that needs it ON; the guard re-reads
  // loadEnv() per request, so flipping it here is enough. Restored in afterAll
  // so a sibling file in the same worker isn't left inside the wall.
  priorMfaRequired = process.env.ADMIN_MFA_REQUIRED;
  process.env.ADMIN_MFA_REQUIRED = 'true';

  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  adminEmail = `mfa-gate-${randomBytes(3).toString('hex')}@test.local`;
  await controlDb.adminUser.create({
    data: {
      email: adminEmail,
      fullName: 'MFA Gate Test',
      role: 'owner',
      status: 'active',
      passwordHash: bcrypt.hashSync(adminPassword, 8),
      // Not enrolled — mfaEnabled defaults false. The placeholders mirror
      // scripts/bootstrap-admin.ts.
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
  });
  // A password alone still yields a cookie; the wall is on the next request.
  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: adminEmail, password: adminPassword })
    .expect(200);
  adminCookie = adminCookieFrom(login);
}, 60_000);

afterAll(async () => {
  if (adminEmail) {
    await controlDb.adminUser.deleteMany({ where: { email: adminEmail } }).catch(() => undefined);
  }
  if (priorMfaRequired === undefined) delete process.env.ADMIN_MFA_REQUIRED;
  else process.env.ADMIN_MFA_REQUIRED = priorMfaRequired;
  if (app) await app.close();
});

describe('AUTH-06: an un-enrolled admin is held at the enrollment wall', () => {
  it('blocks an ordinary admin route — the wall exists', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', adminCookie)
      .expect(403);
    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  // authn-authz-12. Each of these is a real, routable admin endpoint whose
  // path contains `/auth/` or `/mfa/` only because the CALLER put it there.
  it.each([
    ['GET', '/admin/tenants/auth/overrides'],
    ['GET', '/admin/tenants/mfa/overrides'],
    ['GET', '/admin/tenants/auth/tags'],
    ['GET', '/admin/billing/tenants/auth/'],
    ['GET', '/admin/library-requests/auth/'],
  ])('blocks %s %s — a path is not a permission', async (_method, path) => {
    const res = await request(app.getHttpServer()).get(path).set('Cookie', adminCookie);
    expect(
      { path, status: res.status, code: res.body?.code },
      'this request was HANDLED instead of being stopped at the enrollment wall',
    ).toEqual({ path, status: 403, code: 'mfa_enrollment_required' });
  });

  it('still lets the admin reach enrollment and their own identity', async () => {
    // Without these two the wall is a lockout: there is no route to MFA setup
    // and the panel cannot even name who is signed in.
    await request(app.getHttpServer())
      .get('/admin/mfa/status')
      .set('Cookie', adminCookie)
      .expect(200);
    const me = await request(app.getHttpServer())
      .get('/admin/auth/me')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(me.body.admin.email).toBe(adminEmail);
  });
});
