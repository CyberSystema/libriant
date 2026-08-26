import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { ImportQueueService } from '../../src/import/import-queue.service.js';
import type { EngineContext, EngineRowResult } from '../../src/import/engine/import-engine.js';
import { processImportJob } from '../../src/import/import-worker.js';
import { executeImport } from '../../src/import/engine/runner.js';
import { autoMap } from '../../src/import/mapping/auto-map.js';
import { parseDelimited } from '../../src/import/parsers/csv-parser.js';
import { normalizeText } from '../../src/catalog/normalize.js';
import {
  IMPORT_MAX_STAGED_BATCHES,
  IMPORT_MAX_STAGED_BYTES,
  IMPORT_STAGING_TTL_MS,
} from '../../src/import/import.constants.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'None of this is a plan gate: it is what the importer writes into a tenant DB, what the ' +
    'tenant DB refuses, and how much disk one library may hold. Run it the way customers run ' +
    'it — subscriptions off — so the paths under test are the shipped ones.',
);

/**
 * data-integrity-03 / -05 / -06 and input-and-files-06.
 *
 * Everything here drives a REAL entry point — the multipart upload route, the
 * commit route, `processImportJob` (the function the registered BullMQ worker
 * calls), the reservations fulfil route, and the registered
 * `ImportQueueService` provider — then reads the tenant DB and the staging
 * directory to see what actually happened. Nothing asserts against a hand-built
 * engine except the one case that needs genuine concurrency, and even that uses
 * the shipped `ImportEngine` over the shipped mapper.
 *
 * Pre-reqs: postgres + redis (docs/audit/.../env/setup-audit-env.sh).
 */

let app: NestExpressApplication;
let slug: string;
let tenantId: string;
let cookie: string;
let client: TenantPrismaClient;
let effective: EffectivePlanService;
let queueSvc: ImportQueueService;
const password = 'catalog-integrity-pw-1';
const env = loadEnv();

const base = () => `/t/${slug}/imports`;
const auth = (r: request.Test) => r.set('Cookie', cookie);
const stagingDir = () => path.join(path.resolve(env.storageRoot), '_imports');

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

/** Every issue the commit pass recorded for a batch, via the real issues route. */
async function issuesFor(batchId: string): Promise<Array<{ code: string; message: string }>> {
  const res = await auth(request(app.getHttpServer()).get(`${base()}/${batchId}/issues`)).expect(
    200,
  );
  return res.body.items as Array<{ code: string; message: string }>;
}

/**
 * Run `n` copies of an import concurrently and return every row result. The
 * runner reports only a summary, so the per-row outcomes come back through its
 * `onRow` callback — the same one the worker uses to persist issues.
 */
async function runConcurrently(
  n: number,
  start: (collect: (r: EngineRowResult) => void) => Promise<unknown>,
): Promise<EngineRowResult[]> {
  const collected: EngineRowResult[] = [];
  await Promise.all(
    Array.from({ length: n }, () =>
      start((r) => {
        collected.push(r);
      }),
    ),
  );
  return collected;
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
  // The REGISTERED provider, not a fresh instance: if the sweeper were never
  // wired into the module this line would fail.
  queueSvc = app.get(ImportQueueService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slug = 'catint-' + randomBytes(3).toString('hex');
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Catalog integrity ${slug}`,
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
}, 120_000);

afterAll(async () => {
  if (client) await client.$disconnect().catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

// ---------------------------------------------------------------------------
// data-integrity-03 + data-integrity-06 — the natural keys are real keys now
// ---------------------------------------------------------------------------
describe('data-integrity-03 / -06: the catalogue natural keys are enforced by the database', () => {
  it('refuses a second live book with the same ISBN-13, and frees the ISBN on archive', async () => {
    const isbn = '9789600001001';
    const first = await client.book.create({
      data: { title: 'Ζορμπάς', sortTitle: 'zorbas', searchText: 'zorbas', isbn13: isbn },
      select: { id: true },
    });

    // The auditor reached the split state with exactly this write.
    await expect(
      client.book.create({
        data: { title: 'Ζορμπάς (β)', sortTitle: 'zorbas b', searchText: 'zorbas b', isbn13: isbn },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Two ISBN-less records stay legal — pre-ISBN and locally-catalogued items
    // are the common row in a Greek library export, and the constraint must not
    // collapse them.
    for (const n of [1, 2]) {
      await client.book.create({
        data: {
          title: `Χειρόγραφο ${n}`,
          sortTitle: 'heirografo',
          searchText: 'heirografo',
          isbn13: null,
        },
      });
    }

    // Archiving frees the key, exactly as barcodes and member numbers do.
    await client.book.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    const reissued = await client.book.create({
      data: { title: 'Ζορμπάς (νέα)', sortTitle: 'zorbas n', searchText: 'zorbas n', isbn13: isbn },
      select: { id: true },
    });
    expect(reissued.id).toBeTruthy();
    await client.book.deleteMany({ where: { id: { in: [first.id, reissued.id] } } });
  });

  it('refuses a second live author with the same normalized name', async () => {
    // Two spellings a MARC export and a librarian's typing genuinely differ on:
    // accented and unaccented. `normalizeText` folds both to one key, which is
    // the key the importer matches on — so it is the key that has to be unique,
    // and the folding is derived here rather than hard-coded so the test breaks
    // if the two ever stop agreeing.
    const accented = 'Νίκος Καζαντζάκης';
    const plain = 'ΝΙΚΟΣ ΚΑΖΑΝΤΖΑΚΗΣ';
    expect(normalizeText(plain)).toBe(normalizeText(accented));

    const created = await client.author.create({
      data: { fullName: accented, sortName: normalizeText(accented) },
      select: { id: true },
    });
    await expect(
      client.author.create({ data: { fullName: plain, sortName: normalizeText(plain) } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await client.author.delete({ where: { id: created.id } });
  });

  it('two imports racing over the same row produce ONE book and ONE author, with no failed rows', async () => {
    // The audit's own reproduction: concurrent ImportEngine instances committing
    // the same row gave `books with SAME isbn13 = 4` and `authors for one
    // sortName = 4`. The constraint stops the duplicates; the engine's P2002
    // recovery is what stops the losers turning into failed rows instead.
    const csv = 'Title,ISBN,Author,Year\nΤο Τρίτο Στεφάνι,9789600001002,Κώστας Ταχτσής,1962\n';
    const table = parseDelimited(Buffer.from(csv, 'utf-8'));
    const mapping = autoMap('book', table.columns);
    const ctx = (): EngineContext => ({
      client,
      tenantId,
      getLimit: async () => 1_000_000,
      duplicateMode: 'skip',
      dryRun: false,
    });

    const rows = await runConcurrently(4, (collect) =>
      executeImport('book', table, mapping, ctx(), { onRow: collect }),
    );

    expect(rows.flatMap((r) => r.issues).filter((i) => i.severity === 'error')).toEqual([]);
    expect(rows.filter((r) => r.outcome === 'error')).toEqual([]);

    expect(await client.book.count({ where: { isbn13: '9789600001002', archivedAt: null } })).toBe(
      1,
    );
    expect(
      await client.author.count({
        where: { sortName: normalizeText('Κώστας Ταχτσής'), archivedAt: null },
      }),
    ).toBe(1);
    // Exactly one of the four ran the insert; the other three found the winner.
    expect(rows.filter((r) => r.outcome === 'imported')).toHaveLength(1);
  });

  it('an author a librarian typed in the UI is reused, not duplicated, by a later import', async () => {
    // The route the audit called "the realistic one": no import concurrency at
    // all, just a librarian who added the author first.
    const typed = await auth(request(app.getHttpServer()).post(`/t/${slug}/catalog/authors`))
      .send({ fullName: 'Άλκη Ζέη' })
      .expect(201);
    const typedId = typed.body.id as string;

    const res = await importOnce(
      'book',
      'Title,ISBN,Author\nΤο Καπλάνι της Βιτρίνας,9789600001003,Άλκη Ζέη\n',
      'books.csv',
    );
    expect(res.status).toBe('completed');
    expect(res.counts.imported).toBe(1);

    const authors = await client.author.findMany({
      where: { sortName: normalizeText('Άλκη Ζέη'), archivedAt: null },
      select: { id: true },
    });
    expect(authors.map((a) => a.id)).toEqual([typedId]);
  });
});

// ---------------------------------------------------------------------------
// data-integrity-05 — an imported ready hold owns a copy and expires
// ---------------------------------------------------------------------------
describe('data-integrity-05: imported ready holds are fulfillable and mortal', () => {
  const MEMBERS =
    'Name,Member Number\nΜαρία Παπαδοπούλου,H-001\nΝίκος Γεωργίου,H-002\nΕλένη Δήμου,H-003\n';
  const BOOK = 'Title,ISBN\nΗ Αρραβωνιαστικιά του Αχιλλέα,9789600002001\n';
  const COPY = 'Barcode,ISBN\nHOLD-0001,9789600002001\n';
  const READY_HOLD = 'Member Number,ISBN,Status\nH-001,9789600002001,ready\n';
  const SECOND_READY_HOLD = 'Member Number,ISBN,Status\nH-002,9789600002001,ready\n';

  let bookId: string;
  let holdId: string;

  it('seeds the member, book and single copy the holds compete for', async () => {
    expect((await importOnce('member', MEMBERS, 'members.csv')).counts.imported).toBe(3);
    expect((await importOnce('book', BOOK, 'books.csv')).counts.imported).toBe(1);
    expect((await importOnce('book_copy', COPY, 'copies.csv')).counts.imported).toBe(1);
    bookId = (await client.book.findFirstOrThrow({ where: { isbn13: '9789600002001' } })).id;
  });

  it('claims a copy and sets a pickup deadline the expiry sweep can actually match', async () => {
    const res = await importOnce('reservation', READY_HOLD, 'holds.csv');
    expect(res.status).toBe('completed');
    expect(res.counts.imported).toBe(1);

    const hold = await client.reservation.findFirstOrThrow({ where: { bookId } });
    holdId = hold.id;
    expect(hold.status).toBe('ready');
    // The three things the finding measured as broken, in order.
    expect(hold.fulfilledByCopyId).not.toBeNull();
    expect(hold.expiresAt).not.toBeNull();
    expect(hold.expiresAt!.getTime()).toBeGreaterThan(hold.readyAt!.getTime());

    const copy = await client.bookCopy.findUniqueOrThrow({
      where: { id: hold.fulfilledByCopyId! },
    });
    expect(copy.status).toBe('reserved');

    // The expiry sweep's exact predicate. The audit measured this as 0 rows
    // "even against a far-future cutoff", which is what made the hold immortal.
    const farFuture = new Date(Date.now() + 365 * 24 * 3_600_000);
    expect(
      await client.reservation.count({
        where: { status: 'ready', expiresAt: { lt: farFuture } },
      }),
    ).toBe(1);

    // The librarian is told the deadline was invented rather than read.
    const codes = (await issuesFor(res.batchId)).map((i) => i.code);
    expect(codes).toContain('defaulted');
  });

  it('lets the patron actually collect it through the real pickup route', async () => {
    // BEFORE the fix this route threw 400 "This hold is ready and can't be
    // picked up" forever, because `fulfilledByCopyId` was null — the finding's
    // "permanently unfulfillable".
    const res = await auth(
      request(app.getHttpServer()).post(`/t/${slug}/reservations/${holdId}/fulfill`),
    )
      .send({})
      .expect(201);
    expect(res.body.loan.id).toBeTruthy();

    const hold = await client.reservation.findUniqueOrThrow({ where: { id: holdId } });
    expect(hold.status).toBe('fulfilled');
    const copy = await client.bookCopy.findUniqueOrThrow({
      where: { id: hold.fulfilledByCopyId! },
    });
    expect(copy.status).toBe('on_loan');
  });

  it('imports a ready hold with no free copy as QUEUED, with a warning, not an orphan', async () => {
    // The only copy is now on loan, so there is nothing to hand over. Writing
    // `ready` here is what produced the immortal hold in the first place.
    const res = await importOnce('reservation', SECOND_READY_HOLD, 'holds2.csv');
    expect(res.status).toBe('completed');
    expect(res.counts.imported).toBe(1);

    const member = await client.member.findFirstOrThrow({ where: { memberNumber: 'H-002' } });
    const hold = await client.reservation.findFirstOrThrow({
      where: { bookId, memberId: member.id },
    });
    expect(hold.status).toBe('queued');
    expect(hold.queuePosition).toBe(1);
    expect(hold.fulfilledByCopyId).toBeNull();
    expect(hold.readyAt).toBeNull();

    const codes = (await issuesFor(res.batchId)).map((i) => i.code);
    expect(codes).toContain('downgraded_to_queued');

    // And nothing anywhere is a ready hold without a copy — the invariant the
    // three downstream paths assume.
    expect(
      await client.reservation.count({ where: { status: 'ready', fulfilledByCopyId: null } }),
    ).toBe(0);
  });

  it('the repair migration rescues orphan ready holds a PREVIOUS import already wrote', async () => {
    // The engine fix cannot reach rows that are already in a customer database.
    // Seed the exact shape the old committer wrote — ready, readyAt set, no
    // copy, no expiry — then run the real migration file against this tenant.
    const member = await client.member.findFirstOrThrow({ where: { memberNumber: 'H-003' } });
    const spare = await client.book.create({
      data: {
        title: 'Παλιά Κράτηση',
        sortTitle: 'palia kratisi',
        searchText: 'palia kratisi',
        isbn13: '9789600002002',
        copies: { create: { barcode: 'ORPHAN-0001' } },
      },
      select: { id: true, copies: { select: { id: true } } },
    });
    const orphan = await client.reservation.create({
      data: {
        bookId: spare.id,
        memberId: member.id,
        placedAt: new Date('2026-08-01T00:00:00Z'),
        status: 'ready',
        readyAt: new Date('2026-08-01T00:00:00Z'),
        expiresAt: null,
        fulfilledByCopyId: null,
        queuePosition: null,
      },
      select: { id: true },
    });
    // The bug, stated as the sweep sees it: unreachable at any cutoff.
    expect(
      await client.reservation.count({
        where: { id: orphan.id, expiresAt: { lt: new Date(Date.now() + 365 * 24 * 3_600_000) } },
      }),
    ).toBe(0);

    const sql = await fs.readFile(
      path.resolve(
        process.cwd(),
        '../../packages/db-tenant/prisma/migrations/20260826085000_repair_orphan_ready_holds/migration.sql',
      ),
      'utf-8',
    );
    await client.$executeRawUnsafe(sql);

    const repaired = await client.reservation.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(repaired.status).toBe('ready');
    expect(repaired.fulfilledByCopyId).toBe(spare.copies[0]!.id);
    expect(repaired.expiresAt).not.toBeNull();
    expect(
      (await client.bookCopy.findUniqueOrThrow({ where: { id: spare.copies[0]!.id } })).status,
    ).toBe('reserved');

    // The pickup deadline must be UTC wall time, comparable with everything
    // Prisma writes. A `now()` without `AT TIME ZONE 'UTC'` lands a whole UTC
    // offset out — three hours on a Europe/Athens server, which is three extra
    // hours of a copy held off the shelf.
    const settings = await client.tenantSetting.findUniqueOrThrow({ where: { id: 1 } });
    const skewMs = Math.abs(
      repaired.expiresAt!.getTime() - (Date.now() + settings.holdPickupHours * 3_600_000),
    );
    expect(skewMs).toBeLessThan(10 * 60_000);

    // Idempotent: the second run finds nothing to repair and changes nothing.
    await client.$executeRawUnsafe(sql);
    const again = await client.reservation.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(again.expiresAt!.getTime()).toBe(repaired.expiresAt!.getTime());
    expect(again.updatedAt.getTime()).toBe(repaired.updatedAt.getTime());
  });

  it('re-importing the same hold file skips rather than colliding with the demoted row', async () => {
    // The demotion changes what the second pass is looking for: the file says
    // `ready`, the DB holds `queued`. Keying on the file's status would miss it
    // and then trip `reservations_one_active_per_book_member`.
    const before = await client.reservation.count();
    const res = await importOnce('reservation', SECOND_READY_HOLD, 'holds2.csv');
    expect(res.status).toBe('completed');
    expect(res.counts.imported).toBe(0);
    expect(res.counts.skipped).toBe(1);
    expect(await client.reservation.count()).toBe(before);
  });

  it('predicts the demotion during the DRY RUN, before anything is written', async () => {
    // Two ready rows, one free copy: the validate pass must say so for the
    // SECOND row, or the librarian only discovers it after the commit.
    const csv = 'Member Number,ISBN,Status\nH-003,9789600002001,ready\nH-001,9789600002001,ready\n';
    const table = parseDelimited(Buffer.from(csv, 'utf-8'));
    const before = await client.reservation.count();
    const rows: EngineRowResult[] = [];
    await executeImport(
      'reservation',
      table,
      autoMap('reservation', table.columns),
      {
        client,
        tenantId,
        getLimit: async () => 1_000_000,
        duplicateMode: 'skip',
        dryRun: true,
      },
      {
        onRow: (r) => {
          rows.push(r);
        },
      },
    );
    const codes = rows.flatMap((r) => r.issues).map((i) => i.code);
    // Every copy of this book is on loan, so BOTH rows are demoted.
    expect(codes.filter((c) => c === 'downgraded_to_queued')).toHaveLength(2);
    // A dry run writes nothing.
    expect(await client.reservation.count()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// input-and-files-06 — staging is bounded and swept
// ---------------------------------------------------------------------------
describe('input-and-files-06: import staging is bounded and swept', () => {
  const smallCsv = 'Name,Member Number\nΔοκιμή,Q-001\n';

  // NOT async: callers chain `.expect(...)`, which lives on supertest's Test,
  // not on the Promise an async wrapper would hand back.
  const upload = (name: string) =>
    auth(request(app.getHttpServer()).post(base()))
      .field('entityKind', 'member')
      .attach('file', Buffer.from(smallCsv, 'utf-8'), name);

  /**
   * Leave no staged batch behind. Every test in this block asserts against a
   * per-tenant budget, so one test's leftovers become the next test's 409 —
   * which is how the first draft of this file "passed" the count limit and then
   * failed everything after it for the wrong reason.
   */
  afterEach(async () => {
    const res = await auth(request(app.getHttpServer()).get(base())).expect(200);
    for (const b of res.body.items as Array<{ id: string; status: string }>) {
      if (['uploaded', 'validated', 'failed', 'canceled'].includes(b.status)) {
        await auth(request(app.getHttpServer()).delete(`${base()}/${b.id}`));
      }
    }
  });

  it('refuses the upload that would exceed the per-tenant staged-batch count', async () => {
    const parked: string[] = [];
    for (let i = 0; i < IMPORT_MAX_STAGED_BATCHES; i++) {
      parked.push((await upload(`park-${i}.csv`).expect(201)).body.batch.id as string);
    }
    const refused = await upload('one-too-many.csv').expect(409);
    expect(String(refused.body.message)).toMatch(/waiting to run/i);

    // The refusal must happen BEFORE anything lands on disk: the whole point is
    // that the bytes never reach the shared volume.
    const names = await fs.readdir(stagingDir());
    const staged = await controlDb.importBatch.findMany({
      where: { tenantId, NOT: { stagingPath: '' } },
      select: { id: true },
    });
    expect(staged.map((b) => b.id).sort()).toEqual([...parked].sort());
    for (const id of parked) expect(names.some((n) => n.startsWith(id))).toBe(true);
  });

  it('refuses on the byte budget even when the count is under the cap', async () => {
    // ONE parked batch — well under IMPORT_MAX_STAGED_BATCHES — but as big as
    // the whole budget. `sizeBytes` is what the budget reads, so this is the
    // same arithmetic two real 64 MB uploads produce, without pushing 128 MB
    // through supertest.
    const kept = (await upload('huge.csv').expect(201)).body.batch.id as string;
    await controlDb.importBatch.update({
      where: { id: kept },
      data: { sizeBytes: IMPORT_MAX_STAGED_BYTES },
    });

    const refused = await upload('over-budget.csv').expect(409);
    expect(String(refused.body.message)).toMatch(/staging limit/i);
    // …and the count limit is demonstrably NOT what fired.
    expect(String(refused.body.message)).not.toMatch(/waiting to run/i);
  });

  it('deleting a batch and cancelling an un-run one both free the disk and the slot', async () => {
    const deleted = (await upload('to-delete.csv').expect(201)).body.batch.id as string;
    const canceled = (await upload('to-cancel.csv').expect(201)).body.batch.id as string;
    const deletedPath = (await controlDb.importBatch.findUniqueOrThrow({ where: { id: deleted } }))
      .stagingPath;
    const canceledPath = (
      await controlDb.importBatch.findUniqueOrThrow({ where: { id: canceled } })
    ).stagingPath;
    await expect(fs.stat(deletedPath)).resolves.toBeTruthy();
    await expect(fs.stat(canceledPath)).resolves.toBeTruthy();

    await auth(request(app.getHttpServer()).delete(`${base()}/${deleted}`)).expect(200);
    await auth(request(app.getHttpServer()).post(`${base()}/${canceled}/cancel`)).expect(201);

    await expect(fs.stat(deletedPath)).rejects.toBeTruthy();
    // Cancelling an `uploaded` batch used to leave the file behind forever
    // while the row left every counted state — a free bypass of the budget.
    await expect(fs.stat(canceledPath)).rejects.toBeTruthy();
    expect(
      (await controlDb.importBatch.findUniqueOrThrow({ where: { id: canceled } })).stagingPath,
    ).toBe('');
  });

  it('sweeps an abandoned upload after the TTL and says so when it is re-run', async () => {
    const batchId = (await upload('abandoned.csv').expect(201)).body.batch.id as string;
    const stagingPath = (await controlDb.importBatch.findUniqueOrThrow({ where: { id: batchId } }))
      .stagingPath;
    await expect(fs.stat(stagingPath)).resolves.toBeTruthy();

    // Not stale yet: the sweeper must leave a fresh upload alone, or a
    // librarian who steps away mid-wizard loses their file.
    await queueSvc.sweepAbandonedStaging();
    await expect(fs.stat(stagingPath)).resolves.toBeTruthy();

    // Age it past the TTL and sweep for real.
    await controlDb.$executeRawUnsafe(
      `UPDATE import_batches SET "updatedAt" = $1 WHERE id = $2`,
      new Date(Date.now() - IMPORT_STAGING_TTL_MS - 60_000),
      batchId,
    );
    expect(await queueSvc.sweepAbandonedStaging()).toBeGreaterThanOrEqual(1);

    await expect(fs.stat(stagingPath)).rejects.toBeTruthy();
    const row = await controlDb.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    // The history survives; only the bytes are gone.
    expect(row.stagingPath).toBe('');
    expect(row.originalName).toBe('abandoned.csv');

    // And the re-run offer is withdrawn with a sentence a librarian can act on,
    // instead of a worker dying on ENOENT.
    const rerun = await auth(
      request(app.getHttpServer()).post(`${base()}/${batchId}/commit`),
    ).expect(409);
    expect(String(rerun.body.message)).toMatch(/upload it again/i);
  });

  it('sweeps a staged file that no batch row claims, but only once it is old', async () => {
    // The crash window: `createBatch` writes the file before it records
    // `stagingPath`, and `remove()` deletes the row. Pass 1 can never see these.
    const orphanId = 'orphan' + randomBytes(6).toString('hex');
    const orphan = path.join(stagingDir(), `${orphanId}.csv`);
    await fs.mkdir(stagingDir(), { recursive: true });
    await fs.writeFile(orphan, smallCsv);

    await queueSvc.sweepAbandonedStaging();
    await expect(fs.stat(orphan)).resolves.toBeTruthy();

    const old = new Date(Date.now() - IMPORT_STAGING_TTL_MS - 60_000);
    await fs.utimes(orphan, old, old);
    await queueSvc.sweepAbandonedStaging();
    await expect(fs.stat(orphan)).rejects.toBeTruthy();
  });
});
