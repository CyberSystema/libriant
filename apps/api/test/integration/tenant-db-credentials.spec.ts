import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client as PgClient } from 'pg';
import {
  applyTenantRoleGrants,
  composeRuntimeUrl,
  controlDb,
  describeTenantRoles,
  dropTenantRoles,
  ensureTenantRoles,
  newRuntimePassword,
  openTenantPassword,
  parseTenantDbMasterKey,
  retireTenantLoginRole,
  sealTenantPassword,
  tenantLoginRole,
  tenantPrivilegeRole,
} from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import { runtimeDbUrl } from '../../src/tenancy/tenant-db-url.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Database-level isolation must hold in the configuration we ship. Nothing here reads a ' +
    'plan; turning the gates on would only add a way for a signup to be refused for an ' +
    'unrelated reason.',
);

/**
 * tenant-isolation-02 / -03, asserted rather than described.
 *
 * The pre-release audit connected to library B's database with the connection
 * string the application held for library A and counted its members. Every
 * tenant database was opened with the same Postgres superuser role, so the
 * separation between two libraries was which string the code happened to pick.
 *
 * This file asserts the four things that make that not reproduce:
 *
 *   1. What the application holds for a tenant is that tenant's OWN role, not
 *      the superuser.
 *   2. That credential is REFUSED by Postgres against any other tenant's
 *      database. Not "checked in code" — refused by the server.
 *   3. The standby rotation slot exists and cannot log in until a rotation
 *      moves onto it.
 *   4. A rotation swaps the live credential without breaking a connection that
 *      was already open, and the retired slot then stops working.
 *
 * It also pins the fail-closed behaviour: a tenant with no sealed credential is
 * refused, not quietly served over the superuser url.
 *
 * Cleanup drops the roles as well as the databases. Other integration files
 * drop only the database (they call `dropTenantDb`, not the provisioner's
 * `teardown`), so a dev cluster accumulates inert `tenant_*_a|_b|_app` roles
 * from those runs; harmless, but this is the file that knows about them.
 */

let app: NestExpressApplication;
let slugA: string;
let slugB: string;
let idA: string;
let idB: string;
let cookieA: string;

const password = 'creds-test-password-1';
const env = loadEnv();
const masterKey = parseTenantDbMasterKey(env.tenantDbMasterKey);

function uniqueSlug() {
  return 'cred-' + randomBytes(3).toString('hex');
}

async function signup(slug: string) {
  return request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Cred ${slug}`,
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
}

async function login(slug: string) {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: `owner@${slug}.test`, password })
    .expect(200);
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const s = cookies.find((c) => /^(__Host-)?libriant_session=/.test(c));
  if (!s) throw new Error('no session cookie');
  return s.split(';')[0]!;
}

function dbNameFor(tenantId: string) {
  return `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/** The ADMIN (superuser) url for a tenant — the one thing this phase demotes. */
function adminUrlFor(tenantId: string): string {
  const u = new URL(env.pgSuperuserUrl);
  u.pathname = `/${dbNameFor(tenantId)}`;
  return u.toString();
}

async function sealedFor(tenantId: string) {
  const row = await controlDb.tenantDbCredential.findUnique({ where: { tenantId } });
  if (!row) throw new Error(`no tenant_db_credentials row for ${tenantId}`);
  return row;
}

/** Compose the live runtime url for a tenant, straight from the control plane. */
async function runtimeUrlFor(tenantId: string): Promise<string> {
  const row = await sealedFor(tenantId);
  return composeRuntimeUrl({
    adminUrl: adminUrlFor(tenantId),
    roleName: row.roleName,
    password: openTenantPassword({ tenantId, row, masterKey }),
  });
}

/** Try to connect and run one statement. Returns the Postgres error, or null. */
async function tryConnect(url: string, sql = 'SELECT 1'): Promise<Error | null> {
  const c = new PgClient({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await c.connect();
    await c.query(sql);
    return null;
  } catch (err) {
    return err as Error;
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function dropTenant(slug: string, tenantId: string) {
  if (!tenantId) return;
  await controlDb.tenant.deleteMany({ where: { slug } }).catch(() => undefined);
  const admin = new PgClient({ connectionString: env.pgSuperuserUrl });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbNameFor(tenantId)],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbNameFor(tenantId)}"`);
  } finally {
    await admin.end();
  }
  await dropTenantRoles({ adminUrl: env.pgSuperuserUrl, tenantId }).catch(() => undefined);
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error'],
  });
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
  slugA = uniqueSlug();
  slugB = uniqueSlug();
  const a = await signup(slugA);
  const b = await signup(slugB);
  idA = a.body.tenant.id as string;
  idB = b.body.tenant.id as string;
  cookieA = await login(slugA);
}, 120_000);

afterAll(async () => {
  if (!app) return;
  await dropTenant(slugA, idA);
  await dropTenant(slugB, idB);
  await app.close();
}, 120_000);

describe('per-tenant database credentials', () => {
  it('provisioning seals a credential naming this tenant’s own login role', async () => {
    const row = await sealedFor(idA);
    expect(row.roleName).toBe(tenantLoginRole(idA, 'a'));
    expect(row.encryptionKeyId).toBe('v1');
    // Sealed, not stored. The ciphertext must not contain the password.
    const plain = openTenantPassword({ tenantId: idA, row, masterKey });
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(row.encryptedPwd).toString('utf8')).not.toContain(plain);
  });

  it('what the resolver hands the request path is the tenant role, not the superuser', async () => {
    const resolver = app.get(TenantResolverService);
    const ctx = await resolver.resolveBySlug(slugA);
    expect(ctx).not.toBeNull();
    const url = new URL(ctx!.dbUrl);
    expect(url.username).toBe(tenantLoginRole(idA, 'a'));
    expect(url.username).not.toBe(new URL(env.pgSuperuserUrl).username);
    // The database name is unchanged, which is what `assertUrlBelongsToTenant`
    // in TenantPrismaService still checks on every call. Two walls, not one.
    expect(url.pathname).toBe(`/${dbNameFor(idA)}`);
  });

  it('the request path actually works on that credential end to end', async () => {
    // Not decoration: every grant could be wrong and every assertion above
    // would still pass. A 201 here means CONNECT, schema USAGE, SELECT,
    // INSERT and the sequences all landed.
    await request(app.getHttpServer())
      .post(`/t/${slugA}/members`)
      .set('Cookie', cookieA)
      .send({ fullName: 'Cred Patron', email: 'p@cred.test', phone: '+3069000123' })
      .expect(201);
    const list = await request(app.getHttpServer())
      .get(`/t/${slugA}/members`)
      .set('Cookie', cookieA)
      .expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);
  });

  it("REFUSES tenant A's runtime credential against tenant B's database", async () => {
    const runtimeA = await runtimeUrlFor(idA);
    // Sanity: it opens A.
    expect(await tryConnect(runtimeA, 'SELECT id FROM tenant_settings LIMIT 1')).toBeNull();

    // The audit's demonstration, verbatim: same credential, other database.
    const spoof = new URL(runtimeA);
    spoof.pathname = `/${dbNameFor(idB)}`;
    const err = await tryConnect(spoof.toString(), 'SELECT count(*) FROM members');
    expect(err).not.toBeNull();
    // Refused by POSTGRES at connect time — role `tenant_A_a` authenticates
    // fine (it is a real cluster role), it simply has no CONNECT on B.
    expect(String(err?.message)).toMatch(/permission denied for database/i);
  });

  it('PUBLIC cannot connect to a tenant database at all', async () => {
    const c = new PgClient({ connectionString: adminUrlFor(idB) });
    await c.connect();
    try {
      const r = await c.query<{ ok: boolean }>(
        `SELECT pg_catalog.has_database_privilege('public', $1, 'CONNECT') AS ok`,
        [dbNameFor(idB)],
      );
      expect(r.rows[0]!.ok).toBe(false);
      const p = await c.query<{ ok: boolean }>(
        `SELECT pg_catalog.has_database_privilege($1, $2, 'CONNECT') AS ok`,
        [tenantPrivilegeRole(idB), dbNameFor(idB)],
      );
      expect(p.rows[0]!.ok).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('creates a standby slot that cannot log in, and a NOLOGIN privilege role', async () => {
    const state = await describeTenantRoles({ adminUrl: adminUrlFor(idA), tenantId: idA });
    expect(state.privilegeRole).toBe(tenantPrivilegeRole(idA));
    expect(state.logins.map((l) => l.slot).sort()).toEqual(['a', 'b']);
    expect(state.logins.find((l) => l.slot === 'a')!.canLogin).toBe(true);
    expect(state.logins.find((l) => l.slot === 'b')!.canLogin).toBe(false);

    const c = new PgClient({ connectionString: adminUrlFor(idA) });
    await c.connect();
    try {
      const r = await c.query<{ rolcanlogin: boolean }>(
        'SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $1',
        [tenantPrivilegeRole(idA)],
      );
      expect(r.rows[0]!.rolcanlogin).toBe(false);
    } finally {
      await c.end();
    }
  });

  it('applies the per-role limits in the tenant database', async () => {
    const c = new PgClient({ connectionString: adminUrlFor(idA) });
    await c.connect();
    try {
      const r = await c.query<{ setconfig: string[] | null }>(
        `SELECT s.setconfig
           FROM pg_catalog.pg_db_role_setting s
           JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
           JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
          WHERE r.rolname = $1 AND d.datname = $2`,
        [tenantLoginRole(idA, 'a'), dbNameFor(idA)],
      );
      const settings = (r.rows[0]?.setconfig ?? []).join(' ');
      expect(settings).toContain(`statement_timeout=${env.tenantDbStatementTimeout}`);
      expect(settings).toContain(
        `idle_in_transaction_session_timeout=${env.tenantDbIdleTxTimeout}`,
      );
      const lim = await c.query<{ rolconnlimit: number }>(
        'SELECT rolconnlimit FROM pg_catalog.pg_roles WHERE rolname = $1',
        [tenantLoginRole(idA, 'a')],
      );
      expect(lim.rows[0]!.rolconnlimit).toBe(env.tenantDbConnectionLimit);
    } finally {
      await c.end();
    }
  });

  it('rotates onto the standby slot without breaking an open connection', async () => {
    const adminUrl = adminUrlFor(idA);
    const before = await runtimeUrlFor(idA);

    // A connection opened BEFORE the rotation — the request in flight.
    const inflight = new PgClient({ connectionString: before });
    await inflight.connect();

    try {
      const password = newRuntimePassword();
      const { loginRole } = await ensureTenantRoles({
        tenantDbUrl: adminUrl,
        tenantId: idA,
        activeSlot: 'b',
        password,
      });
      await applyTenantRoleGrants({ tenantDbUrl: adminUrl, tenantId: idA });
      expect(loginRole).toBe(tenantLoginRole(idA, 'b'));

      const sealed = sealTenantPassword({
        tenantId: idA,
        roleName: loginRole,
        password,
        masterKey,
      });
      await controlDb.tenantDbCredential.update({
        where: { tenantId: idA },
        data: {
          roleName: sealed.roleName,
          encryptedPwd: sealed.encryptedPwd,
          encryptionKeyId: sealed.encryptionKeyId,
          encryptionNonce: sealed.encryptionNonce,
          rotatedAt: new Date(),
        },
      });

      // The grace period: BOTH credentials work. This is the property that
      // makes a rotation cost time instead of availability — Postgres has no
      // second-password mechanism, so alternating slots is the only way a
      // process still holding the old string does not get an auth failure.
      const after = await runtimeUrlFor(idA);
      expect(new URL(after).username).toBe(tenantLoginRole(idA, 'b'));
      expect(await tryConnect(after, 'SELECT id FROM tenant_settings LIMIT 1')).toBeNull();
      expect(await tryConnect(before, 'SELECT id FROM tenant_settings LIMIT 1')).toBeNull();

      // …and the connection opened before any of it is untouched.
      const still = await inflight.query('SELECT id FROM tenant_settings LIMIT 1');
      expect(still.rowCount).toBeGreaterThanOrEqual(0);

      // Retire the old slot. A NEW connection as `a` is refused; the one
      // already open keeps working, because Postgres checks the password at
      // connect time only.
      await retireTenantLoginRole({ tenantDbUrl: adminUrl, tenantId: idA, slot: 'a' });
      const refused = await tryConnect(before);
      expect(refused).not.toBeNull();
      const surviving = await inflight.query('SELECT id FROM tenant_settings LIMIT 1');
      expect(surviving.rowCount).toBeGreaterThanOrEqual(0);
    } finally {
      await inflight.end().catch(() => undefined);
    }

    // The app follows the control plane, not a cached string: bust the resolver
    // cache the way the rotation script does and the next request resolves onto
    // slot b.
    await app.get(TenantResolverService).invalidate({ slug: slugA });
    const ctx = await app.get(TenantResolverService).resolveBySlug(slugA);
    expect(new URL(ctx!.dbUrl).username).toBe(tenantLoginRole(idA, 'b'));
    await request(app.getHttpServer())
      .get(`/t/${slugA}/members`)
      .set('Cookie', cookieA)
      .expect(200);
  }, 60_000);

  it('fails CLOSED for a tenant with no sealed credential', () => {
    // Not a hypothetical: this is every tenant created before phase 4, until
    // `pnpm tenant:rotate-db-creds --all` has run. Serving them over the
    // superuser url would be the finding, so the request 500s instead and the
    // message names the backfill.
    //
    // The switch is set explicitly here rather than inherited. Its DEFAULT is
    // "closed outside development" — but this suite runs under whatever
    // NODE_ENV the operator's shell carries (`.env.local` says development, CI
    // lets vitest say test), so a test that read the default would assert
    // opposite things in the two places. The default itself is pinned in
    // src/tenancy/tenant-db-url.spec.ts, which controls its whole environment.
    const saved = process.env.TENANT_DB_ALLOW_SUPERUSER_FALLBACK;
    try {
      process.env.TENANT_DB_ALLOW_SUPERUSER_FALLBACK = 'false';
      expect(() => runtimeDbUrl({ id: idA, dbUrl: adminUrlFor(idA), dbCredentials: null })).toThrow(
        /tenant:rotate-db-creds/,
      );
      // And the escape hatch is a real one, for the length of a backfill only.
      process.env.TENANT_DB_ALLOW_SUPERUSER_FALLBACK = 'true';
      expect(runtimeDbUrl({ id: idA, dbUrl: adminUrlFor(idA), dbCredentials: null })).toBe(
        adminUrlFor(idA),
      );
    } finally {
      if (saved === undefined) delete process.env.TENANT_DB_ALLOW_SUPERUSER_FALLBACK;
      else process.env.TENANT_DB_ALLOW_SUPERUSER_FALLBACK = saved;
    }
  });
});
