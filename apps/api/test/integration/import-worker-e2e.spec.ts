import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { EffectivePlanService } from '../../src/plans/effective-plan.service.js';
import { startImportWorker, type ImportWorkerHandle } from '../../src/import/import-worker.js';
import { loadEnv } from '../../src/config/env.js';

/**
 * True end-to-end: the LIVE BullMQ import worker drains the queue. We POST the
 * commit (which enqueues a job via the producer) and assert the running worker
 * processes it to completion with rows in the tenant DB — exercising the exact
 * producer→Redis→consumer path the worker process runs in production.
 *
 * Pre-reqs: `pnpm db:up`.
 */

let app: NestExpressApplication;
let worker: ImportWorkerHandle;
let slug: string;
let tenantId: string;
let cookie: string;
const password = 'import-e2e-pw-1';
const env = loadEnv();
const base = () => `/t/${slug}/imports`;
const auth = (r: request.Test) => r.set('Cookie', cookie);

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
    logger: ['error', 'warn'],
  });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  const redis = app.get(RedisService);
  const effective = app.get(EffectivePlanService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slug = 'impe2e-' + randomBytes(3).toString('hex');
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `E2E ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password,
    })
    .expect(201);
  tenantId = res.body.tenant.id as string;

  await controlDb.tenantPlanOverride.create({
    data: { tenantId, featureKey: 'bulk_import_enabled', valueBool: true },
  });
  await effective.invalidate(tenantId);

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: `owner@${slug}.test`, password })
    .expect(200);
  const raw = login.headers['set-cookie'] as unknown as string[] | string;
  cookie = (Array.isArray(raw) ? raw : [raw])
    .find((c) => /libriant_session=/.test(c))!
    .split(';')[0]!;

  // Boot the real consumer — the same one worker.ts runs.
  worker = await startImportWorker({ effective });
}, 90_000);

afterAll(async () => {
  if (worker) await worker.stop().catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

async function waitForStatus(id: string, until: string[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await auth(request(app.getHttpServer()).get(`${base()}/${id}`)).expect(200);
    const status = res.body.batch.status as string;
    if (until.includes(status)) return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`batch ${id} did not reach ${until.join('/')} in time`);
}

describe('import worker (live BullMQ consumer)', () => {
  it('drains a committed import end-to-end with no manual processing', async () => {
    const up = await auth(request(app.getHttpServer()).post(base()))
      .field('entityKind', 'member')
      .attach(
        'file',
        Buffer.from('Name,Email\nAda Lovelace,ada@example.com\nGrace Hopper,grace@example.com\n'),
        'members.csv',
      )
      .expect(201);
    const id = up.body.batch.id as string;

    await auth(request(app.getHttpServer()).post(`${base()}/${id}/commit`)).expect(201);

    const status = await waitForStatus(id, ['completed', 'partially_completed', 'failed']);
    expect(status).toBe('completed');

    const res = await auth(request(app.getHttpServer()).get(`${base()}/${id}`)).expect(200);
    expect(res.body.batch.counts.imported).toBe(2);

    const members = await auth(request(app.getHttpServer()).get(`/t/${slug}/members`)).expect(200);
    expect(members.body.items.map((m: { fullName: string }) => m.fullName).sort()).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
  }, 45_000);
});
