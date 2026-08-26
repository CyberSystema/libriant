import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { controlDb } from '@libriant/db-control';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { SCHEDULED_JOBS } from '../../src/jobs/registry.js';
import {
  startScheduledJobs,
  type ScheduledJobsHandle,
} from '../../src/jobs/scheduled-jobs.runner.js';
import type { JobContext } from '../../src/jobs/jobs.types.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The recompute repairs a counter; it never consults a limit. Run it the way libraries do.',
);

/**
 * data-integrity-12 — the nightly `storageUsedBytes` recompute that
 * storage.service.ts names three times as the backstop for its best-effort
 * counter maintenance, and which did not exist.
 *
 * This drives it the way the worker does: the entry taken OUT of the real
 * `SCHEDULED_JOBS` registry, handed to the real `startScheduledJobs`, fired by
 * real BullMQ. Only `intervalMs` is overridden, so the test does not wait 24 h.
 * A test that called `recomputeStorageUsage()` directly would pass just as
 * happily if the registry entry were missing, which is the whole failure mode
 * this remediation keeps repeating.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */

let app: NestExpressApplication;
let handle: ScheduledJobsHandle | undefined;
let tenantId = '';
let storageDir = '';
const slug = 'stgrecomp-' + randomBytes(3).toString('hex');
const env = loadEnv();

const QUEUE_NAME = 'scheduled';
const QUEUE_PREFIX = 'lbr-bull';

/** The file a library actually stores: a cover, on the tenant's volume. */
const COVER_BYTES = 4_096;

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

async function usedBytes(): Promise<bigint> {
  const row = await controlDb.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { storageUsedBytes: true },
  });
  return row.storageUsedBytes;
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
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

  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Storage recompute ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'stgrecomp-test-pw-1',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  tenantId = res.body.tenant.id as string;

  const row = await controlDb.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { storageUrl: true },
  });
  storageDir = fileURLToPath(row.storageUrl.endsWith('/') ? row.storageUrl : row.storageUrl + '/');
  await mkdir(path.join(storageDir, 'covers'), { recursive: true });
  await writeFile(path.join(storageDir, 'covers', 'cover.jpg'), Buffer.alloc(COVER_BYTES, 7));
}, 90_000);

afterAll(async () => {
  await handle?.stop();
  const conn = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const q = new Queue(QUEUE_NAME, { connection: conn, prefix: QUEUE_PREFIX });
  for (const s of await q.getJobSchedulers()) await q.removeJobScheduler(s.key);
  await q.close();
  await conn.quit();
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('nightly storageUsedBytes recompute (data-integrity-12)', () => {
  it('is registered in the real job registry, nightly', () => {
    const entry = SCHEDULED_JOBS.find((j) => j.name === 'storage-usage-recompute');
    expect(entry).toBeDefined();
    expect(entry!.intervalMs).toBe(24 * 60 * 60_000);
  });

  it('hands back the phantom usage a swallowed release left behind', async () => {
    // What a swallowed `releaseReservedBytes` leaves: the file is gone from the
    // volume (or was never written), the counter still charges for it. The
    // decrement is the ONLY best-effort side of this counter, so drift is
    // always in this direction — the library slowly loses storage it is not
    // using and eventually gets a 402 quoting a figure nothing on disk matches.
    const phantom = 900n * 1024n * 1024n;
    await controlDb.tenant.update({
      where: { id: tenantId },
      data: { storageUsedBytes: phantom },
    });
    expect(await usedBytes()).toBe(phantom);

    const entry = SCHEDULED_JOBS.find((j) => j.name === 'storage-usage-recompute')!;
    handle = await startScheduledJobs([{ ...entry, intervalMs: 500 }], {
      emails: { enqueue: async () => undefined },
    } as unknown as Omit<JobContext, 'redis'>);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (handle.lastResults()['storage-usage-recompute']) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const run = handle.lastResults()['storage-usage-recompute'];
    expect(run, 'the registered job never fired').toBeDefined();
    expect(run!.ok).toBe(true);
    expect(run!.counts?.corrected).toBeGreaterThan(0);

    // The counter now says exactly what is on the volume — one 4 KiB cover.
    expect(await usedBytes()).toBe(BigInt(COVER_BYTES));
  }, 90_000);
});
