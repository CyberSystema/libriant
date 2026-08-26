import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { loadEnv } from '../../src/config/env.js';
import { parseDelimited } from '../../src/import/parsers/csv-parser.js';
import { autoMap } from '../../src/import/mapping/auto-map.js';
import { executeImport } from '../../src/import/engine/runner.js';
import type { EngineContext } from '../../src/import/engine/import-engine.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  "The ceiling under test is supplied directly as the engine context's `getLimit`, exactly as " +
    'import-worker.ts supplies it from EffectivePlanService — so this file proves the engine ' +
    'honours a limit without needing the global switch to manufacture one. Turning subscriptions ' +
    'on would additionally 402 the signup and tenant reads it uses as scaffolding.',
);

/**
 * data-integrity-04: the import pipeline enforced `max_books` / `max_members`
 * from a private in-memory counter, seeded once in `init()` and incremented per
 * row — outside the advisory-lock domain every other create path uses
 * (`QuotaService.enforceWithinTx`, `quota:<tenant>:<feature>:`).
 *
 * The consequence is not theoretical and needs no race to reproduce: anything
 * that writes a book while an import is running is invisible to that counter
 * for the whole run. A librarian at the desk cataloguing three arrivals during
 * a 10,000-row import IS that writer. The import then admits its full quota on
 * top of theirs and the library ends the day over its plan ceiling, with
 * nothing in the report to say so.
 *
 * The interleave below is deliberate rather than timed — `onRow` is the
 * runner's own per-row callback, the one `import-worker.ts` uses to stream
 * issues — so this fails for the reason it names, on every run, rather than
 * one run in ten.
 */

let app: NestExpressApplication;
let slug: string;
let tenantId: string;
let client: TenantPrismaClient;
const password = 'import-quota-pw-1';
const env = loadEnv();

const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({
  client,
  tenantId,
  getLimit: async () => 1_000_000,
  duplicateMode: 'skip',
  dryRun: false,
  ...over,
});

const csv = (s: string) => parseDelimited(Buffer.from(s, 'utf-8'));

/** `n` rows of distinct, ISBN-less titles — the common shape of a Greek export. */
function titles(prefix: string, n: number): ReturnType<typeof csv> {
  const rows = Array.from({ length: n }, (_, i) => `${prefix} ${i + 1},19${(i % 90) + 10}`);
  return csv(`Title,Year\n${rows.join('\n')}\n`);
}

const activeBooks = () => client.book.count({ where: { archivedAt: null } });

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

  slug = 'impq-' + randomBytes(3).toString('hex');
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Import Quota ${slug}`,
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
  tenantId = res.body.tenant.id as string;
  const tenant = await controlDb.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { dbUrl: true },
  });
  client = makeTenantPrismaClient({ databaseUrl: tenant.dbUrl });
}, 90_000);

afterAll(async () => {
  if (client) await client.$disconnect().catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('the import ceiling against a writer the import cannot see (data-integrity-04)', () => {
  it('stops at the plan ceiling when books are catalogued mid-import', async () => {
    const LIMIT = 5;
    expect(await activeBooks()).toBe(0);

    let deskWorkDone = false;
    const summary = await executeImport(
      'book',
      titles('Imported', LIMIT),
      autoMap('book', titles('Imported', LIMIT).columns),
      ctx({ getLimit: async () => LIMIT }),
      {
        onRow: async () => {
          if (deskWorkDone) return;
          deskWorkDone = true;
          // Three arrivals catalogued at the desk while the import runs. Real
          // rows, same table, same predicate the quota counts by.
          await client.book.createMany({
            data: [1, 2, 3].map((n) => ({
              title: `Desk arrival ${n}`,
              sortTitle: `desk arrival ${n}`,
              searchText: `desk arrival ${n}`,
            })),
          });
        },
      },
    );

    // The ceiling is the whole point: five is five, whoever wrote the rows.
    expect(await activeBooks()).toBeLessThanOrEqual(LIMIT);
    // And the rows it could not take are reported per row, not silently
    // dropped — a librarian has to be able to see which titles did not land.
    expect(summary.imported + 3).toBeLessThanOrEqual(LIMIT);
    expect(summary.errorRows).toBeGreaterThan(0);
  }, 60_000);

  it('imports the whole file when the ceiling is nowhere near', async () => {
    // The other half of the trade: settling every row against the database
    // would put a `count(*)` on a table nothing indexes in front of every one
    // of up to IMPORT_MAX_ROWS (250,000) rows. A run that is far from its
    // ceiling must not pay that, and must not refuse anything either.
    const before = await activeBooks();
    const table = titles('Roomy', 40);
    const summary = await executeImport(
      'book',
      table,
      autoMap('book', table.columns),
      ctx({ getLimit: async () => 1_000_000 }),
    );
    expect(summary.imported).toBe(40);
    expect(summary.errorRows).toBe(0);
    expect(await activeBooks()).toBe(before + 40);
  }, 60_000);

  it('takes the same advisory lock the UI create path takes', async () => {
    // Not a shape assertion: a DIFFERENT key is the same bug with a lock in
    // front of it. `QuotaService.enforceWithinTx` builds
    // `quota:<tenantId>:<featureKey>:<lockContext ?? ''>` and hashes it with
    // `hashtextextended(key, 0)`; two writers that hash different strings never
    // wait for each other. This holds the UI's key in one session and asserts
    // the import blocks on it.
    // Ten slots of headroom: inside the exact zone, so the row is settled
    // against the database rather than the projection, and above the cheap
    // projection gate, so it gets that far at all.
    const LIMIT = (await activeBooks()) + 10;
    const lockKey = `quota:${tenantId}:max_books:`;
    const { dbUrl } = await controlDb.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { dbUrl: true },
    });
    const holder = new PgClient({ connectionString: dbUrl });
    // A separate pool for the import, or it would queue behind the holder's
    // session on the shared one and prove nothing about the lock.
    const importClient = makeTenantPrismaClient({ databaseUrl: dbUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

      const table = titles('Blocked', 1);
      let settled = false;
      const run = executeImport('book', table, autoMap('book', table.columns), {
        ...ctx({ getLimit: async () => LIMIT }),
        client: importClient,
      }).then((s) => {
        settled = true;
        return s;
      });

      await new Promise((r) => setTimeout(r, 1_500));
      expect(settled, 'the import did not wait for the quota lock').toBe(false);

      await holder.query('COMMIT');
      const summary = await run;
      expect(settled).toBe(true);
      // …and once the UI's transaction let go, the row landed normally.
      expect(summary.imported).toBe(1);
    } finally {
      await holder.end().catch(() => undefined);
      await importClient.$disconnect().catch(() => undefined);
    }
  }, 60_000);
});
