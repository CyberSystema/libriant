import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';

/**
 * AUDIT PROBE (pre-release-2026-08-23, dimension: tenant-isolation).
 * Throwaway. Deleted after the run.
 */

let app: NestExpressApplication;
let slugA: string;
let slugB: string;
let idA: string;
let idB: string;
let cookieA: string;
let cookieB: string;
const password = 'audit-probe-password-1';
const env = loadEnv();
const findings: string[] = [];

function note(s: string) {
  findings.push(s);

  appendFileSync('/tmp/lbraudit/probe-out.txt', 'PROBE ' + s + '\n');
}

function uniqueSlug(p: string) {
  return p + '-' + randomBytes(3).toString('hex');
}

async function signup(slug: string) {
  return request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: 'Probe ' + slug,
      slug,
      fullName: 'Owner ' + slug,
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

async function dropTenantDb(tenantId: string) {
  const dbName = `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
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
  slugA = uniqueSlug('pa');
  slugB = uniqueSlug('pb');
  const a = await signup(slugA);
  const b = await signup(slugB);
  idA = a.body.tenant.id;
  idB = b.body.tenant.id;
  cookieA = await login(slugA);
  cookieB = await login(slugB);
  note(`tenants A=${slugA}/${idA} B=${slugB}/${idB}`);
}, 120_000);

afterAll(async () => {
  if (!app) return;
  for (const [slug, id] of [
    [slugA, idA],
    [slugB, idB],
  ] as const) {
    if (!id) continue;
    await controlDb.tenant.deleteMany({ where: { slug } }).catch(() => undefined);
    await dropTenantDb(id).catch(() => undefined);
  }
  await app.close();
  // eslint-disable-next-line no-console
  console.log(
    '\n===== PROBE SUMMARY =====\n' + findings.join('\n') + '\n=========================',
  );
}, 120_000);

describe('tenant-isolation audit probe', () => {
  it('P1 baseline: B cannot read A via /t/A path', async () => {
    await request(app.getHttpServer())
      .post(`/t/${slugA}/members`)
      .set('Cookie', cookieA)
      .send({ fullName: 'Secret Patron A', email: 'patron@a.test', phone: '+3069000001' })
      .expect(201);
    const r = await request(app.getHttpServer()).get(`/t/${slugA}/members`).set('Cookie', cookieB);
    note(`P1 GET /t/A/members with B cookie -> ${r.status}`);
    expect(r.status).toBe(403);
  });

  it('P2 case-variant path prefix (/T/ vs /t/) + Host-header fallback', async () => {
    // Express routing is case-insensitive; TenantMiddleware's prefix check is not.
    const r1 = await request(app.getHttpServer()).get(`/T/${slugA}/members`).set('Cookie', cookieB);
    note(
      `P2a GET /T/A/members (B cookie, no Host) -> ${r1.status} ${JSON.stringify(r1.body).slice(0, 200)}`,
    );

    // Same, but with a Host header naming tenant B as a subdomain of the apex.
    const apex = env.publicApexDomain;
    const r2 = await request(app.getHttpServer())
      .get(`/T/${slugA}/members`)
      .set('Cookie', cookieB)
      .set('Host', `${slugB}.${apex}`);
    note(
      `P2b GET /T/A/members Host=B.apex (B cookie) -> ${r2.status} ${JSON.stringify(r2.body).slice(0, 300)}`,
    );

    // And the dangerous direction: A's URL, Host claiming A, B's cookie.
    const r3 = await request(app.getHttpServer())
      .get(`/T/${slugB}/members`)
      .set('Cookie', cookieB)
      .set('Host', `${slugA}.${apex}`);
    note(
      `P2c GET /T/B/members Host=A.apex (B cookie) -> ${r3.status} ${JSON.stringify(r3.body).slice(0, 300)}`,
    );
  });

  it('P3 percent-encoded slug in path', async () => {
    const enc = '%74'; // 't'
    const encSlug = enc + slugA.slice(1);
    const r = await request(app.getHttpServer())
      .get(`/t/${encSlug}/members`)
      .set('Cookie', cookieB);
    note(`P3 GET /t/<pct-encoded A slug>/members (B cookie) -> ${r.status}`);
  });

  it('P4 storage: cross-tenant ref + traversal', async () => {
    const up = await request(app.getHttpServer())
      .post(`/t/${slugA}/storage/covers`)
      .set('Cookie', cookieA)
      .attach('file', Buffer.from('AAA-SECRET-COVER-BYTES'), {
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      });
    note(`P4 upload to A -> ${up.status} ${JSON.stringify(up.body).slice(0, 160)}`);
    const ref: string | undefined = up.body?.ref;
    if (!ref) return;
    const fname = ref.split('/')[1]!;

    const own = await request(app.getHttpServer())
      .get(`/t/${slugA}/storage/covers/${fname}`)
      .set('Cookie', cookieA);
    note(`P4a A reads own file -> ${own.status}`);

    const cross = await request(app.getHttpServer())
      .get(`/t/${slugB}/storage/covers/${fname}`)
      .set('Cookie', cookieB);
    note(`P4b B reads same filename in own tenant -> ${cross.status}`);

    const trav = await request(app.getHttpServer())
      .get(`/t/${slugB}/storage/covers/..%2f..%2f${idA}%2fcovers%2f${fname}`)
      .set('Cookie', cookieB);
    note(`P4c B traversal to A dir -> ${trav.status} body=${String(trav.text).slice(0, 120)}`);

    // Forge a signed URL with SESSION_SECRET (storageSigningSecret falls back
    // to sessionSecret outside NODE_ENV=production).
    const forged = jwt.sign({ tid: idA, ref, fn: 'stolen.jpg' }, env.sessionSecret, {
      algorithm: 'HS256',
      expiresIn: 600,
    });
    const sres = await request(app.getHttpServer()).get(`/_files/signed`).query({ token: forged });
    note(
      `P4d anonymous /_files/signed with token forged from SESSION_SECRET -> ${sres.status} bytes=${JSON.stringify(String(sres.text).slice(0, 40))}`,
    );
    note(
      `P4d storageSigningSecret===sessionSecret? ${env.storageSigningSecret === env.sessionSecret}`,
    );
  });

  it('P5 export job cross-tenant download', async () => {
    const create = await request(app.getHttpServer())
      .post(`/t/${slugA}/exports`)
      .set('Cookie', cookieA)
      .send({ format: 'csv' });
    note(`P5 A creates export -> ${create.status}`);
    const jobId = create.body?.export?.id;
    if (!jobId) return;
    const r1 = await request(app.getHttpServer())
      .get(`/t/${slugB}/exports/${jobId}/download`)
      .set('Cookie', cookieB);
    note(`P5a B downloads A's export via own URL -> ${r1.status}`);
    const r2 = await request(app.getHttpServer())
      .get(`/t/${slugA}/exports/${jobId}/download`)
      .set('Cookie', cookieB);
    note(`P5b B downloads A's export via A URL -> ${r2.status}`);
    const r3 = await request(app.getHttpServer()).get(`/t/${slugB}/exports`).set('Cookie', cookieB);
    note(`P5c B lists exports -> ${r3.status} n=${r3.body?.exports?.length}`);
  });

  it('P6 idempotency key namespace', async () => {
    const redis = app.get(RedisService);
    const key = 'audit-shared-key-' + randomBytes(4).toString('hex');
    // Two different tenants use the SAME idempotency key on their own routes.
    const rA = await request(app.getHttpServer())
      .post(`/t/${slugA}/loans/checkout`)
      .set('Cookie', cookieA)
      .set('Idempotency-Key', key)
      .send({ memberId: 'nope', copyId: 'nope' });
    const rB = await request(app.getHttpServer())
      .post(`/t/${slugB}/loans/checkout`)
      .set('Cookie', cookieB)
      .set('Idempotency-Key', key)
      .send({ memberId: 'nope', copyId: 'nope' });
    note(`P6 same Idempotency-Key: A -> ${rA.status}, B -> ${rB.status}`);
    const keys = await redis.client.keys(`lbr:idem:*${key}`);
    note(`P6 redis idem keys: ${JSON.stringify(keys)}`);
  });

  it('P7 import batch cross-tenant read', async () => {
    const up = await request(app.getHttpServer())
      .post(`/t/${slugA}/imports`)
      .set('Cookie', cookieA)
      .field('entityKind', 'members')
      .attach('file', Buffer.from('fullName,email\nPatron A,pa@a.test\n'), {
        filename: 'm.csv',
        contentType: 'text/csv',
      });
    note(`P7 A creates import batch -> ${up.status} ${JSON.stringify(up.body).slice(0, 140)}`);
    const bid = up.body?.batch?.id ?? up.body?.id;
    if (!bid) return;
    const r1 = await request(app.getHttpServer())
      .get(`/t/${slugB}/imports/${bid}`)
      .set('Cookie', cookieB);
    note(`P7a B reads A's batch via own URL -> ${r1.status}`);
    const r2 = await request(app.getHttpServer())
      .get(`/t/${slugB}/imports/${bid}/issues`)
      .set('Cookie', cookieB);
    note(`P7b B reads A's batch issues -> ${r2.status}`);
  });

  it('P8 custom subdomain routing with a foreign session', async () => {
    const sub = uniqueSlug('sub');
    await controlDb.tenant.update({ where: { id: idB }, data: { customSubdomain: sub } });
    const apex = env.publicApexDomain;
    const r = await request(app.getHttpServer())
      .get(`/members`)
      .set('Cookie', cookieA)
      .set('Host', `${sub}.${apex}`);
    note(`P8 GET /members Host=<B subdomain> with A cookie -> ${r.status}`);
    // Now the same subdomain but a /t/<A> path — which source wins?
    const r2 = await request(app.getHttpServer())
      .get(`/t/${slugA}/members`)
      .set('Cookie', cookieA)
      .set('Host', `${sub}.${apex}`);
    note(
      `P8b GET /t/A/members Host=<B subdomain> with A cookie -> ${r2.status} n=${r2.body?.items?.length}`,
    );
    await controlDb.tenant.update({ where: { id: idB }, data: { customSubdomain: null } });
  });

  it('P9 resolver cache holds dbUrl; relocate/stale-status window', async () => {
    const redis = app.get(RedisService);
    const raw = await redis.client.get(`tenant:slug:${slugA}`);
    note(`P9 cached tenant blob for A: ${String(raw).slice(0, 400)}`);
    // Suspend A directly in the DB (the only way — no API path suspends) and
    // see whether the middleware honours it inside the cache TTL.
    await controlDb.tenant.update({ where: { id: idA }, data: { status: 'suspended' } });
    const r = await request(app.getHttpServer()).get(`/t/${slugA}/members`).set('Cookie', cookieA);
    note(`P9a after DB suspend, A request -> ${r.status} (403 = honoured, 200 = stale cache)`);
    await controlDb.tenant.update({ where: { id: idA }, data: { status: 'active' } });
    await redis.client.del(`tenant:slug:${slugA}`);
  });

  it('P10 every tenant DB is reachable with the SAME credentials', async () => {
    const a = await controlDb.tenant.findUnique({ where: { id: idA }, select: { dbUrl: true } });
    const b = await controlDb.tenant.findUnique({ where: { id: idB }, select: { dbUrl: true } });
    const ua = new URL(a!.dbUrl);
    const ub = new URL(b!.dbUrl);
    note(
      `P10 A role=${ua.username} B role=${ub.username} sameCreds=${ua.username === ub.username && ua.password === ub.password}`,
    );
    // Connect to B's database using the URL the API holds for A (creds only differ in dbname).
    const spoof = new URL(a!.dbUrl);
    spoof.pathname = ub.pathname;
    const c = new PgClient({ connectionString: spoof.toString() });
    await c.connect();
    const res = await c.query('select count(*)::int as n from members');
    await c.end();
    note(`P10 connected to B's DB using A's connection credentials: members=${res.rows[0].n}`);
    const cred = await controlDb.tenantDbCredential.count();
    note(`P10 tenant_db_credentials rows: ${cred}`);
  });
});
