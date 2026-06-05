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
import { processImportJob } from '../../src/import/import-worker.js';
import { loadEnv } from '../../src/config/env.js';

/**
 * Full bulk-import API + worker drill: upload → map → validate → commit,
 * driving the worker's `processImportJob` directly (no live BullMQ consumer
 * in-test). Proves the plan gate, multipart upload + auto-mapping, the
 * dry-run report, and a real commit that lands rows in the tenant DB.
 *
 * Pre-reqs: `pnpm db:up`.
 */

let app: NestExpressApplication;
let slug: string;
let tenantId: string;
let cookie: string;
let effective: EffectivePlanService;
const password = 'import-api-pw-1';
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
  effective = app.get(EffectivePlanService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slug = 'impapi-' + randomBytes(3).toString('hex');
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `ImportAPI ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password,
    })
    .expect(201);
  tenantId = res.body.tenant.id as string;

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, email: `owner@${slug}.test`, password })
    .expect(200);
  const raw = login.headers['set-cookie'] as unknown as string[] | string;
  const cookies = Array.isArray(raw) ? raw : [raw];
  cookie = cookies.find((c) => /libriant_session=/.test(c))!.split(';')[0]!;
}, 90_000);

afterAll(async () => {
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('bulk import API + worker', () => {
  let batchId = '';

  it('blocks upload when bulk_import_enabled is off (402)', async () => {
    const res = await auth(request(app.getHttpServer()).post(base()))
      .field('entityKind', 'book')
      .attach('file', Buffer.from('Title,ISBN\nDune,9780441013593\n'), 'books.csv');
    expect(res.status).toBe(402);
  });

  it('enables the feature via a tenant override (then the gate opens)', async () => {
    await controlDb.tenantPlanOverride.create({
      data: { tenantId, featureKey: 'bulk_import_enabled', valueBool: true },
    });
    await effective.invalidate(tenantId);
  });

  it('uploads a CSV and returns a preview + auto-suggested mapping', async () => {
    const res = await auth(request(app.getHttpServer()).post(base()))
      .field('entityKind', 'book')
      .attach(
        'file',
        Buffer.from(
          'Title,ISBN,Author\nDune,0-441-17271-7,"Herbert, Frank"\nIt,9781501142970,"King, Stephen"\n',
        ),
        'books.csv',
      )
      .expect(201);
    expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
      'Title',
      'ISBN',
      'Author',
    ]);
    expect(res.body.mapping.Title.field).toBe('title');
    expect(res.body.mapping.ISBN.field).toBe('isbn13');
    expect(res.body.batch.status).toBe('uploaded');
    batchId = res.body.batch.id;
  });

  it('runs a dry-run validate and reports counts without writing', async () => {
    await auth(request(app.getHttpServer()).post(`${base()}/${batchId}/validate`)).expect(201);
    await processImportJob(batchId, 'validate', { effective });
    const res = await auth(request(app.getHttpServer()).get(`${base()}/${batchId}`)).expect(200);
    expect(res.body.batch.status).toBe('validated');
    expect(res.body.batch.counts.valid).toBe(2);
    expect(res.body.batch.counts.errors).toBe(0);
    // Dry run wrote nothing.
    const books = await auth(request(app.getHttpServer()).get(`/t/${slug}/catalog/books`)).expect(
      200,
    );
    expect(books.body.items).toHaveLength(0);
  });

  it('commits and lands the rows in the tenant catalog', async () => {
    await auth(request(app.getHttpServer()).post(`${base()}/${batchId}/commit`)).expect(201);
    await processImportJob(batchId, 'commit', { effective });
    const res = await auth(request(app.getHttpServer()).get(`${base()}/${batchId}`)).expect(200);
    expect(res.body.batch.status).toBe('completed');
    expect(res.body.batch.counts.imported).toBe(2);

    const books = await auth(request(app.getHttpServer()).get(`/t/${slug}/catalog/books`)).expect(
      200,
    );
    expect(books.body.items.map((b: { title: string }) => b.title).sort()).toEqual(['Dune', 'It']);
  });

  it('reports a dirty row error + downloadable errors.csv on commit', async () => {
    const up = await auth(request(app.getHttpServer()).post(base()))
      .field('entityKind', 'member')
      .attach(
        'file',
        Buffer.from('Name,Email\nGood Person,good@example.com\n,missing-name\n'),
        'm.csv',
      )
      .expect(201);
    const id = up.body.batch.id as string;
    await auth(request(app.getHttpServer()).post(`${base()}/${id}/commit`)).expect(201);
    await processImportJob(id, 'commit', { effective });

    const res = await auth(request(app.getHttpServer()).get(`${base()}/${id}`)).expect(200);
    expect(res.body.batch.status).toBe('partially_completed');
    expect(res.body.batch.counts.imported).toBe(1);
    expect(res.body.batch.counts.errors).toBe(1);

    const issues = await auth(request(app.getHttpServer()).get(`${base()}/${id}/issues`)).expect(
      200,
    );
    expect(issues.body.items.length).toBeGreaterThanOrEqual(1);

    const csv = await auth(request(app.getHttpServer()).get(`${base()}/${id}/errors.csv`)).expect(
      200,
    );
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('row,field,code,message');
  });
});
