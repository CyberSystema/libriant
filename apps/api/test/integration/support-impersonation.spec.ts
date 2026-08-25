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
  'authn-authz-05 is an authorization boundary, not a plan gate. Subscriptions are OFF in the ' +
    'shipped configuration, so this is the posture the impersonation fence has to hold under; ' +
    'turning them on would additionally 402 routine tenant writes and hide whether the fence ' +
    'or the plan refused.',
);

/**
 * authn-authz-05, end to end over HTTP.
 *
 * The audit probe held nothing but an impersonation cookie — no tenant session
 * at all — and got:
 *
 *     POST   /t/<slug>/staff/<id>/reset-password → 200, plaintext password in body
 *     DELETE /t/<slug>/support/keys/pending      → 204
 *
 * while the library's log recorded only `POST … 200` with `targetType: null`.
 *
 * This file rebuilds that exact position through the real product flow — the
 * library issues a support key, a real MFA-enrolled admin redeems it at
 * `POST /admin/support/redeem`, and every assertion below is sent with ONLY the
 * cookie that redemption set — and then asserts:
 *
 *   1. the credential-minting route is refused, and the password hash on the
 *      target account is byte-for-byte unchanged (the handler never ran);
 *   2. the library's key-management routes are refused;
 *   3. ordinary support work still works, so the fence did not close the window;
 *   4. the refusal and the write both appear in the TENANT's own audit log
 *      (`GET /t/:slug/audit` — the one a librarian opens), naming the target;
 *   5. the control-plane support log now carries targetType/targetId.
 *
 * Pre-reqs: `pnpm db:up`, or the audit environment.
 */

let app: NestExpressApplication;
let slug: string;
let tenantId: string;
let ownerCookie = '';
let ownerUserId = '';
let adminEmail = '';
let adminId = '';
let impCookie = '';

const ownerPassword = 'imp-fence-test-password-1';
const adminPassword = 'imp-fence-admin-pw-1';
const env = loadEnv();

function cookieMatching(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = cookies.find((c) => re.test(c));
  if (!found) throw new Error(`no cookie matching ${re} in ${JSON.stringify(cookies)}`);
  return found.split(';')[0]!;
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

type AuditItem = {
  action: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  viaSupport: boolean;
  after: Record<string, unknown>;
};

/**
 * Read the librarian's own audit screen until `match` appears.
 *
 * Polling is not politeness here. On the ALLOWED path the audit rows are
 * written AFTER the response is flushed (a failed audit insert must never turn
 * a completed support action into a 500), so asserting immediately would be a
 * race that fails about as often as the machine is busy. Refusals are awaited
 * before the 403 and would not need this — they go through the same helper so
 * the two cases read alike.
 */
async function waitForAudit(
  match: (i: AuditItem) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<AuditItem> {
  const deadline = Date.now() + timeoutMs;
  let seen: AuditItem[] = [];
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/audit`)
      .set('Cookie', ownerCookie)
      .expect(200);
    seen = res.body.items as AuditItem[];
    const hit = seen.find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no audit row for ${what} within ${timeoutMs}ms; saw ${JSON.stringify(seen)}`);
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

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const http = app.getHttpServer();

  // --- the library ---------------------------------------------------------
  slug = 'imp-' + randomBytes(3).toString('hex');
  await request(http)
    .post('/auth/signup')
    .send({
      libraryName: `Impersonation ${slug}`,
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
  const tenant = await controlDb.tenant.findUnique({ where: { slug }, select: { id: true } });
  tenantId = tenant!.id;

  const login = await request(http)
    .post('/auth/login')
    .send({ slug, identifier: `owner@${slug}.test`, password: ownerPassword })
    .expect(200);
  ownerCookie = cookieMatching(login, /^(__Host-)?libriant_session=/);

  const staff = await request(http).get(`/t/${slug}/staff`).set('Cookie', ownerCookie).expect(200);
  ownerUserId = staff.body.staff[0].id;

  // --- a real Libriant admin, MFA-enrolled through the real endpoints ------
  adminEmail = `imp-fence-${randomBytes(3).toString('hex')}@test.local`;
  const adminRow = await controlDb.adminUser.create({
    data: {
      email: adminEmail,
      fullName: 'Impersonation Fence Test',
      // 'support' tier on purpose: /admin/support/redeem carries no
      // @AdminRoles, so this is the LOWEST-privileged admin who can open a
      // window, and therefore the one the fence has to hold against.
      role: 'support',
      status: 'active',
      passwordHash: bcrypt.hashSync(adminPassword, 8),
      mfaSecretCipher: randomBytes(32),
      mfaNonce: randomBytes(12),
      mfaKeyId: 'test',
    },
    select: { id: true },
  });
  adminId = adminRow.id;

  const adminLogin = await request(http)
    .post('/admin/auth/login')
    .send({ email: adminEmail, password: adminPassword })
    .expect(200);
  const adminCookie = cookieMatching(adminLogin, /^(__Host-)?libriant_admin=/);

  const setup = await request(http).post('/admin/mfa/setup').set('Cookie', adminCookie).expect(200);
  const totpSecret: string = setup.body.secret;
  await request(http)
    .post('/admin/mfa/verify')
    .set('Cookie', adminCookie)
    .send({ code: generateSync({ secret: totpSecret }) })
    .expect(200);

  // --- the library consents, the admin redeems -----------------------------
  const key = await request(http)
    .post(`/t/${slug}/support/keys`)
    .set('Cookie', ownerCookie)
    .expect(200);

  const redeem = await request(http)
    .post('/admin/support/redeem')
    .set('Cookie', adminCookie)
    .send({ code: key.body.code, totp: generateSync({ secret: totpSecret }) })
    .expect(200);
  impCookie = cookieMatching(redeem, /^(__Host-)?libriant_imp=/);
}, 120_000);

afterAll(async () => {
  // Tenant first: SupportSession rows hang off both the tenant and the admin,
  // and the tenant delete sweeps that tree. Removing the admin first would trip
  // the FK and leave a stray admin behind.
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (adminEmail) {
    await controlDb.adminUser.deleteMany({ where: { email: adminEmail } }).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('impersonation cannot mint a credential that outlives the window', () => {
  it('refuses POST /t/:slug/staff/:id/reset-password and discloses nothing', async () => {
    const before = await controlDb.user.findUnique({
      where: { id: ownerUserId },
      select: { passwordHash: true, sessionsValidAfter: true },
    });

    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/staff/${ownerUserId}/reset-password`)
      .set('Cookie', impCookie)
      .expect(403);

    // The probe's finding was a 200 whose body carried `tempPassword`.
    expect(JSON.stringify(res.body)).not.toContain('tempPassword');
    expect(res.body.message).toMatch(/four-hour window/i);

    // The handler must not have run at all: the reset rewrites passwordHash
    // and bumps sessionsValidAfter, so an unchanged pair proves it didn't.
    const after = await controlDb.user.findUnique({
      where: { id: ownerUserId },
      select: { passwordHash: true, sessionsValidAfter: true },
    });
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.sessionsValidAfter?.getTime() ?? null).toBe(
      before!.sessionsValidAfter?.getTime() ?? null,
    );
  });

  it('refuses to destroy the library key/session controls it came in through', async () => {
    await request(app.getHttpServer())
      .delete(`/t/${slug}/support/keys/pending`)
      .set('Cookie', impCookie)
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/t/${slug}/support/sessions/active`)
      .set('Cookie', impCookie)
      .expect(403);

    // Proof the refusal was real rather than incidental: the session the
    // impersonator tried to end is still open and still theirs.
    const live = await controlDb.supportSession.findFirst({
      where: { tenantId, endedAt: null },
      select: { adminId: true },
    });
    expect(live?.adminId).toBe(adminId);
  });

  it('still allows the support work the window exists for', async () => {
    // Reading staff is fine — the fence is on writes, not on looking.
    await request(app.getHttpServer()).get(`/t/${slug}/staff`).set('Cookie', impCookie).expect(200);
    // And a routine catalogue write still succeeds.
    await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/authors`)
      .set('Cookie', impCookie)
      .send({ fullName: 'Καζαντζάκης, Νίκος' })
      .expect(201);
  });
});

describe("the library's own audit log records what happened", () => {
  it('shows the blocked credential reset, naming the account it targeted', async () => {
    // GET /t/:slug/audit is the screen a librarian opens — read it as the
    // librarian, over HTTP, not through the service class.
    const blocked = await waitForAudit(
      (i) => i.action === 'support.blocked' && i.targetId === ownerUserId,
      'the refused password reset',
    );
    expect(blocked.targetType).toBe('staff');
    expect(blocked.viaSupport).toBe(true);
    expect(blocked.actorType).toBe('admin');
    expect(blocked.after.method).toBe('POST');
    expect(blocked.after.status).toBe(403);
  });

  it('shows the write support DID make, attributed to the support session', async () => {
    const write = await waitForAudit(
      (i) => i.action === 'support.action' && i.targetType === 'catalog/authors',
      'the author created under impersonation',
    );
    expect(write.viaSupport).toBe(true);
    expect(write.actorType).toBe('admin');
    expect(write.after.status).toBe(201);
  });

  it('records which fields a request carried, never their values', async () => {
    const write = await waitForAudit(
      (i) => i.action === 'support.action' && i.targetType === 'catalog/authors',
      'the author created under impersonation',
    );
    // The author name was in the request body. Field NAMES are recorded so the
    // library can see what kind of change was made; values are not, because a
    // plaintext secret leaving the building is the finding this file exists for.
    expect(write.after.bodyKeys).toEqual(['fullName']);
    expect(JSON.stringify(write.after)).not.toContain('Καζαντζάκης');
  });

  it('leaves ordinary support READS out of the librarian feed', async () => {
    // GET /t/:slug/staff was performed under impersonation above. It belongs in
    // the control-plane support log, not folded into the library's activity
    // feed, where a row per page load would bury the writes that matter.
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/audit`)
      .set('Cookie', ownerCookie)
      .expect(200);
    const reads = (res.body.items as AuditItem[]).filter((i) => i.action === 'support.read');
    expect(reads).toEqual([]);
  });
});

describe('the control-plane support log finally names its targets', () => {
  it('carries targetType/targetId on the rows the library reads', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/support/sessions/log`)
      .set('Cookie', ownerCookie)
      .expect(200);
    const actions = res.body.sessions.flatMap(
      (s: { actions: Array<Record<string, unknown>> }) => s.actions,
    );
    const reset = actions.find(
      (a: Record<string, unknown>) =>
        typeof a.path === 'string' && a.path.endsWith('/reset-password'),
    );
    expect(reset, JSON.stringify(actions)).toBeTruthy();
    // Before this fix every row came back with targetType: null.
    expect(reset.targetType).toBe('staff');
    expect(reset.targetId).toBe(ownerUserId);
    expect(reset.status).toBe(403);
  });
});
