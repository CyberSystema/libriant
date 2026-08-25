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
import { EffectivePlanService } from '../../src/plans/effective-plan.service.js';
import { processImportJob } from '../../src/import/import-worker.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This spec is about what a re-uploaded file does to the tenant DB, not about a plan gate. ' +
    'Run it the way customers run it — subscriptions off — so the import path under test is ' +
    'the shipped one.',
);

/**
 * data-integrity-02 — THE RE-IMPORT DRILL.
 *
 * The bug: a librarian whose 20,000-row import died at row 12,000 has one
 * obvious action — send the file again — and doing so silently DUPLICATED
 * every row the engine had no natural key for, including patrons' fines. The
 * auditor measured one 500c fine row imported twice as `FINES rows = 2, total
 * cents = 1000`, both passes reporting 'imported' with zero issues.
 *
 * Everything here drives the REAL entry point: the multipart upload route, the
 * commit route, and `processImportJob` — the function the registered BullMQ
 * worker calls — then reads the tenant DB directly to count what actually
 * landed. Asserting against the engine class would have missed that the
 * mapping, the duplicate mode and the worker's tally all participate.
 *
 * The three shapes that matter, all covered below:
 *   1. the same file uploaded again as a NEW batch (what the UI actually
 *      offers after a failure — DonePanel's only action is "import another
 *      file");
 *   2. the SAME batch re-run after it was left `failed` (what `requireRunnable`
 *      permits, and what the crash-recovery sweep leaves behind);
 *   3. two identical rows INSIDE one file, which are two real records and must
 *      NOT be collapsed — the guard against a fix that over-corrects.
 *
 * Pre-reqs: postgres + redis (see docs/audit/.../setup-audit-env.sh).
 */

let app: NestExpressApplication;
let slug: string;
let tenantId: string;
let cookie: string;
let client: TenantPrismaClient;
let effective: EffectivePlanService;
const password = 'reimport-test-pw-1';
const env = loadEnv();

const base = () => `/t/${slug}/imports`;
const auth = (r: request.Test) => r.set('Cookie', cookie);

/** Upload a file, commit it through the real routes, run the worker job. */
async function importOnce(
  entityKind: string,
  body: string,
  filename: string,
): Promise<{ batchId: string; counts: Record<string, number>; status: string }> {
  const up = await auth(request(app.getHttpServer()).post(base()))
    .field('entityKind', entityKind)
    .attach('file', Buffer.from(body, 'utf-8'), filename)
    .expect(201);
  const batchId = up.body.batch.id as string;
  await auth(request(app.getHttpServer()).post(`${base()}/${batchId}/commit`)).expect(201);
  await processImportJob(batchId, 'commit', { effective });
  const res = await auth(request(app.getHttpServer()).get(`${base()}/${batchId}`)).expect(200);
  return { batchId, counts: res.body.batch.counts, status: res.body.batch.status };
}

/** Outstanding + settled money on the books, the number a patron argues about. */
async function fineTotals() {
  const rows = await client.fine.findMany({ select: { amountCents: true } });
  return { rows: rows.length, cents: rows.reduce((n, r) => n + r.amountCents, 0) };
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
    logger: ['error', 'warn'],
  });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  const redis = app.get(RedisService);
  effective = app.get(EffectivePlanService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slug = 'reimp-' + randomBytes(3).toString('hex');
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Reimport ${slug}`,
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

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: `owner@${slug}.test`, password })
    .expect(200);
  const raw = login.headers['set-cookie'] as unknown as string[] | string;
  const cookies = Array.isArray(raw) ? raw : [raw];
  cookie = cookies.find((c) => /libriant_session=/.test(c))!.split(';')[0]!;

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

// The library the re-import happens to: two patrons, one title, two copies.
const MEMBERS = 'Name,Member Number\nMaria Papadopoulou,M-001\nNikos Georgiou,M-002\n';
const BOOKS = 'Title,ISBN,Year\nΤο Τρίτο Στεφάνι,9789600000001,1962\n';
const COPIES = 'Barcode,ISBN\nCP-0001,9789600000001\nCP-0002,9789600000001\n';

// One patron, one 500c late-return fine. No date column anywhere: this is what
// an export from an old library system looks like, and it is the row the
// engine had no key for.
const FINES = 'Member Number,Amount,Reason\nM-001,5.00,Late return\n';

describe('data-integrity-02: re-importing a file must not duplicate what it already wrote', () => {
  it('seeds the members, book and copies the rest of the file hangs off', async () => {
    expect((await importOnce('member', MEMBERS, 'members.csv')).counts.imported).toBe(2);
    expect((await importOnce('book', BOOKS, 'books.csv')).counts.imported).toBe(1);
    expect((await importOnce('book_copy', COPIES, 'copies.csv')).counts.imported).toBe(2);
  });

  it('bills a patron ONCE when the same fines file is uploaded a second time', async () => {
    const first = await importOnce('fine', FINES, 'fines.csv');
    expect(first.status).toBe('completed');
    expect(first.counts.imported).toBe(1);
    expect(await fineTotals()).toEqual({ rows: 1, cents: 500 });

    // The librarian sends the file again. THIS is the reported bug.
    const second = await importOnce('fine', FINES, 'fines.csv');
    expect(second.status).toBe('completed');
    expect(second.counts.imported).toBe(0);
    expect(second.counts.skipped).toBe(1);
    expect(await fineTotals()).toEqual({ rows: 1, cents: 500 });
  });

  it('does not double a RETURNED loan whose file carries no checkout date', async () => {
    // A closed loan leaves the copy available, so the one-active-loan-per-copy
    // guard never sees it — the duplicate check is the only thing standing
    // between a re-upload and a doubled circulation history. With no
    // checkout-date column the engine must key on what the FILE says, not on a
    // timestamp it invents per run.
    //
    // The due date is in the FUTURE on purpose: with no checkout-date column
    // the committer defaults the checkout to now and then refuses a due date
    // before it, so a past-due closed loan is currently unimportable without
    // that column. That limitation is reported alongside this package; it is
    // not what this test is about.
    const loans = 'Member Number,Barcode,Due Date,Status\nM-002,CP-0002,2030-03-01,returned\n';
    const first = await importOnce('loan', loans, 'loans.csv');
    expect(first.counts.imported).toBe(1);
    expect(await client.loan.count()).toBe(1);

    const second = await importOnce('loan', loans, 'loans.csv');
    expect(second.counts.imported).toBe(0);
    expect(await client.loan.count()).toBe(1);
  });

  it('does not double a resolved hold whose file carries no placed date', async () => {
    // `reservations_one_active_per_book_member` only covers queued/ready, so an
    // expired hold re-imported cleanly and silently doubled.
    const holds = 'Member Number,ISBN,Status\nM-001,9789600000001,expired\n';
    const first = await importOnce('reservation', holds, 'holds.csv');
    expect(first.counts.imported).toBe(1);
    expect(await client.reservation.count()).toBe(1);

    const second = await importOnce('reservation', holds, 'holds.csv');
    expect(second.counts.imported).toBe(0);
    expect(await client.reservation.count()).toBe(1);
  });

  it('re-runs a batch left FAILED without rewriting the rows it already committed', async () => {
    // The other recovery route: `requireRunnable` deliberately lets a `failed`
    // batch be re-started (a hard error, or one reset by the crash-recovery
    // sweep), on the strength of the engine's idempotency. Prove the strength
    // is real. Upload the same fines file, mark the batch failed the way the
    // sweep does, and re-run it through the real commit route.
    const before = await fineTotals();

    const up = await auth(request(app.getHttpServer()).post(base()))
      .field('entityKind', 'fine')
      .attach('file', Buffer.from(FINES, 'utf-8'), 'fines.csv')
      .expect(201);
    const batchId = up.body.batch.id as string;
    await controlDb.importBatch.update({
      where: { id: batchId },
      data: { status: 'failed', error: 'worker died mid-commit' },
    });

    await auth(request(app.getHttpServer()).post(`${base()}/${batchId}/commit`)).expect(201);
    await processImportJob(batchId, 'commit', { effective });

    const res = await auth(request(app.getHttpServer()).get(`${base()}/${batchId}`)).expect(200);
    expect(res.body.batch.status).toBe('completed');
    expect(res.body.batch.counts.imported).toBe(0);
    expect(res.body.batch.counts.skipped).toBe(1);
    expect(await fineTotals()).toEqual(before);
  });

  it('still imports two identical rows INSIDE one file as two records', async () => {
    // The guard against over-correcting. A patron really can owe two identical
    // €3.00 charges, and a first-time import of a file that says so must write
    // both — the re-import defence only ever looks at rows written BEFORE this
    // run started. A boundary computed even slightly late collapses these two
    // and silently under-imports the library's money.
    const before = await fineTotals();
    const twice =
      'Member Number,Amount,Reason\nM-002,3.00,Damaged cover\nM-002,3.00,Damaged cover\n';

    const first = await importOnce('fine', twice, 'twin-fines.csv');
    expect(first.counts.imported).toBe(2);
    expect(await fineTotals()).toEqual({ rows: before.rows + 2, cents: before.cents + 600 });

    // ...and re-uploading THAT file adds nothing.
    const second = await importOnce('fine', twice, 'twin-fines.csv');
    expect(second.counts.imported).toBe(0);
    expect(second.counts.skipped).toBe(2);
    expect(await fineTotals()).toEqual({ rows: before.rows + 2, cents: before.cents + 600 });
  });
});
