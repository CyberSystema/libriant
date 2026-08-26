import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { sweepFineAccrual } from '../../src/jobs/fine-accrual.job.js';
import { sweepRetention } from '../../src/jobs/retention.job.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Minting a member number and listing overdue loans are day-one library actions. ' +
    'Nothing here asserts a plan gate, so this runs the shipped configuration.',
);

/**
 * The two hot paths performance-02 and performance-04 are about, driven through
 * the REAL HTTP routes against a REAL provisioned tenant database.
 *
 * Both findings were previously reported fixed with the application code
 * untouched — a migration created `member_number_counters` and nothing read it,
 * and a partial index was created for an overdue ORDER BY that was written into
 * a SQL comment instead of into LoansService. So these tests deliberately
 * assert things that can only be true if the SERVICE changed:
 *
 *   - the counter row exists and tracks the numbers actually issued (the old
 *     scan-and-max never wrote it);
 *   - the overdue list comes back most-overdue-first, which only the `dueAt ASC`
 *     ordering produces;
 *   - the tenant database carries the index that ordering needs.
 *
 * The second wave (performance-05, -07, -08, -11, -12) follows the same rule:
 * every assertion below is one that the AUDITED code fails and the remediated
 * code passes, driven through the real HTTP route or the real job entry point.
 */
let app: NestExpressApplication;
let tenantCookie = '';
let slug = '';
let tenantClient: TenantPrismaClient | null = null;
const tag = randomBytes(3).toString('hex');
const YEAR = new Date().getUTCFullYear();

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

const http = () => request(app.getHttpServer());

// Returns the supertest Test (not a promise of one) so callers can chain
// `.expect(...)` the way every other spec in this directory does.
const createMember = (body: Record<string, unknown>) =>
  http().post(`/t/${slug}/members`).set('Cookie', tenantCookie).send(body);

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

  slug = `perfhot-${tag}`;
  const signup = await http()
    .post('/auth/signup')
    .send({
      libraryName: `Perf Hot ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'owner-signup-pw-123',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  tenantCookie = cookieFrom(signup, /^(__Host-)?libriant_session=/);

  const tenant = await controlDb.tenant.findUnique({ where: { slug } });
  if (!tenant) throw new Error('signup did not provision a tenant');
  tenantClient = makeTenantPrismaClient({ databaseUrl: tenant.dbUrl, maxPoolSize: 2 });
}, 120_000);

afterAll(async () => {
  if (tenantClient) await tenantClient.$disconnect().catch(() => undefined);
  if (app) await app.close();
});

describe('performance-04 — member numbers come from the counter, not a table scan', () => {
  it('seeds the counter from the numbers already on the shelf', async () => {
    // A member the library numbered by hand, above where a fresh counter starts.
    await createMember({
      fullName: 'Χειροκίνητο Μέλος',
      memberNumber: `M-${YEAR}-0500`,
    }).expect(201);

    // The first auto-numbered member must continue from it, not collide with it.
    const first = await createMember({ fullName: 'Πρώτο Μέλος' }).expect(201);
    expect(first.body.memberNumber).toBe(`M-${YEAR}-0501`);

    const rows = await tenantClient!.$queryRawUnsafe<{ year: number; nextSeq: number }[]>(
      'SELECT "year", "nextSeq" FROM "member_number_counters" ORDER BY "year"',
    );
    // The audited implementation never wrote this table: an empty result here
    // means the scan-and-max is back.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.year).toBe(YEAR);
    expect(rows[0]!.nextSeq).toBe(501);
  });

  it('hands out consecutive numbers and keeps the counter in step', async () => {
    const issued: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await createMember({ fullName: `Σειρά ${i}` }).expect(201);
      issued.push(res.body.memberNumber);
    }
    expect(issued).toEqual([502, 503, 504, 505, 506].map((n) => `M-${YEAR}-0${n}`));
    const [counter] = await tenantClient!.$queryRawUnsafe<{ nextSeq: number }[]>(
      'SELECT "nextSeq" FROM "member_number_counters" WHERE "year" = $1',
      YEAR,
    );
    expect(counter!.nextSeq).toBe(506);
  });

  it('gives ten CONCURRENT creates ten distinct numbers', async () => {
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createMember({ fullName: `Ταυτόχρονο ${i}` })),
    );
    for (const r of res) expect(r.status).toBe(201);
    const numbers = res.map((r) => r.body.memberNumber as string);
    expect(new Set(numbers).size).toBe(10);
  });
});

describe('performance-02 — the overdue list is ordered by how overdue it is', () => {
  const dueOffsetsDays = [-30, -1, -10, -3]; // deliberately not in order
  let memberId = '';
  let bookId = '';

  it('checks out four loans and backdates them', async () => {
    const member = await createMember({ fullName: 'Δανειζόμενος' }).expect(201);
    memberId = member.body.id;
    const book = await http()
      .post(`/t/${slug}/catalog/books`)
      .set('Cookie', tenantCookie)
      .send({ title: 'Βιβλίο Δοκιμής' })
      .expect(201);
    bookId = book.body.id;

    for (let i = 0; i < dueOffsetsDays.length; i++) {
      const copy = await http()
        .post(`/t/${slug}/catalog/books/${bookId}/copies`)
        .set('Cookie', tenantCookie)
        .send({ barcode: `PERF-${tag}-${i}` })
        .expect(201);
      const loan = await http()
        .post(`/t/${slug}/loans`)
        .set('Cookie', tenantCookie)
        .send({ copyId: copy.body.id, memberId })
        .expect(201);
      // The checkout endpoint will not let a librarian book a due date in the
      // past, so age the loan the way time would.
      const dueAt = new Date(Date.now() + dueOffsetsDays[i]! * 86_400_000);
      await tenantClient!.loan.update({
        where: { id: loan.body.loan.id },
        data: { dueAt, loanedAt: new Date(dueAt.getTime() - 14 * 86_400_000) },
      });
    }
  });

  it('returns the MOST overdue first (dueAt ascending), through the real route', async () => {
    const res = await http()
      .get(`/t/${slug}/loans?overdue=1&limit=100`)
      .set('Cookie', tenantCookie)
      .expect(200);
    const due = res.body.items.map((l: { dueAt: string }) => new Date(l.dueAt).getTime());
    expect(due).toHaveLength(4);
    expect(due).toEqual([...due].sort((a, b) => a - b));
    // The audited ordering was `loanedAt DESC`, which for these loans is the
    // exact reverse — so this assertion fails if the service is reverted.
    expect(due).not.toEqual([...due].sort((a, b) => b - a));
  });

  it('leaves the UNFILTERED list newest-first, as before', async () => {
    const res = await http()
      .get(`/t/${slug}/loans?limit=100`)
      .set('Cookie', tenantCookie)
      .expect(200);
    const loaned = res.body.items.map((l: { loanedAt: string }) => new Date(l.loanedAt).getTime());
    expect(loaned.length).toBeGreaterThanOrEqual(4);
    expect(loaned).toEqual([...loaned].sort((a, b) => b - a));
  });

  it('provisions the index that ordering needs, and drops the one it cannot use', async () => {
    const idx = await tenantClient!.$queryRawUnsafe<{ indexname: string }[]>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'loans'",
    );
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('loans_status_dueAt_id_idx');
    // Partial on `status = 'active'`, which Prisma's `CAST($1::text AS enum)`
    // can never satisfy because `enum_in` is STABLE and so is never folded to a
    // constant for the predicate prover.
    expect(names).not.toContain('loans_active_dueAt_idx');
  });
});

describe('performance-12 — a term shorter than a trigram is refused before Postgres sees it', () => {
  const TITLE = 'Ομηρικά Έπη';

  it('catalogues a book whose title a two-letter search would otherwise match', async () => {
    await http()
      .post(`/t/${slug}/catalog/books`)
      .set('Cookie', tenantCookie)
      .send({ title: TITLE })
      .expect(201);
  });

  it('answers a two-character search with an empty page and a minQueryChars hint', async () => {
    // `ομ` IS a substring of the normalised searchText, so the audited service
    // returned this book — after a `searchText LIKE '%ομ%'` that no trigram
    // index can serve. Measured on a 400,000-title catalogue: 13,407 shared
    // buffers for the two-character term, 7 for the three-character one.
    const res = await http()
      .get(`/t/${slug}/catalog/books?q=${encodeURIComponent('ομ')}`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.minQueryChars).toBe(3);
  });

  it('serves the same search from three characters, so the floor is length and not the term', async () => {
    const res = await http()
      .get(`/t/${slug}/catalog/books?q=${encodeURIComponent('ομη')}`)
      .set('Cookie', tenantCookie)
      .expect(200);
    const titles = res.body.items.map((b: { title: string }) => b.title);
    expect(titles).toContain(TITLE);
    expect(res.body.minQueryChars).toBeUndefined();
  });

  it('accepts an accented three-character term, which is how a Greek user types it', async () => {
    const res = await http()
      .get(`/t/${slug}/catalog/books?q=${encodeURIComponent('Ομή')}`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(res.body.minQueryChars).toBeUndefined();
  });
});

describe('performance-11 — the dashboard tiles are counts, not page sizes', () => {
  it('reports the real catalogue size where the list tile reported its page size', async () => {
    // What the tenant home did: `GET /catalog/books?limit=1` and render
    // `items.length`. A 400,000-title library's tile therefore read "1".
    const tile = await http()
      .get(`/t/${slug}/catalog/books?limit=1`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(tile.body.items).toHaveLength(1);

    const summary = await http().get(`/t/${slug}/summary`).set('Cookie', tenantCookie).expect(200);

    const [books, members, active, overdue, holds] = await Promise.all([
      tenantClient!.book.count({ where: { archivedAt: null } }),
      tenantClient!.member.count({ where: { archivedAt: null } }),
      tenantClient!.loan.count({ where: { status: 'active' } }),
      tenantClient!.loan.count({ where: { status: 'active', dueAt: { lt: new Date() } } }),
      tenantClient!.reservation.count({ where: { status: 'queued' } }),
    ]);

    expect(summary.body.books).toBe(books);
    expect(summary.body.members).toBe(members);
    expect(summary.body.activeLoans).toBe(active);
    expect(summary.body.overdueLoans).toBe(overdue);
    expect(summary.body.queuedHolds).toBe(holds);
    // The defect in one line: same number, two different answers.
    expect(summary.body.books).toBeGreaterThan(tile.body.items.length);
    expect(summary.body.overdueLoans).toBeGreaterThan(0);
  });

  it('serves the second read from cache', async () => {
    const first = await http().get(`/t/${slug}/summary`).set('Cookie', tenantCookie).expect(200);
    const second = await http().get(`/t/${slug}/summary`).set('Cookie', tenantCookie).expect(200);
    expect(second.body.cachedForSeconds).toBeGreaterThan(0);
    expect(second.body.books).toBe(first.body.books);
  });

  it('refuses the route without a session, like every other tenant read', async () => {
    await http().get(`/t/${slug}/summary`).expect(401);
  });
});

describe('performance-08 — the overdue sweep pages and batches instead of N+1', () => {
  // One page is 500 (OVERDUE_PAGE_SIZE), so 501 loans forces the keyset cursor
  // to advance. The audited sweep pulled every row in one findMany and then did
  // three round trips per row.
  const BULK = 501;
  const ids = Array.from({ length: BULK }, (_, i) => `perf08-loan-${tag}-${i}`);
  let bulkMemberId = '';

  it('backdates 501 overdue loans', async () => {
    const member = await createMember({ fullName: 'Μαζικός Δανειζόμενος' }).expect(201);
    bulkMemberId = member.body.id;
    const book = await http()
      .post(`/t/${slug}/catalog/books`)
      .set('Cookie', tenantCookie)
      .send({ title: 'Βιβλίο Μαζικού Δανεισμού' })
      .expect(201);

    const now = Date.now();
    await tenantClient!.bookCopy.createMany({
      data: ids.map((id, i) => ({
        id: `perf08-copy-${tag}-${i}`,
        bookId: book.body.id,
        barcode: `PERF08-${tag}-${i}`,
        status: 'on_loan' as const,
      })),
    });
    await tenantClient!.loan.createMany({
      data: ids.map((id, i) => ({
        id,
        copyId: `perf08-copy-${tag}-${i}`,
        memberId: bulkMemberId,
        // Between 1 and 10 days overdue; loanedAt safely before dueAt.
        loanedAt: new Date(now - 40 * 86_400_000),
        dueAt: new Date(now - ((i % 10) + 1) * 86_400_000),
        status: 'active' as const,
      })),
    });

    await tenantClient!.tenantSetting.update({
      where: { id: 1 },
      data: { overdueFinesEnabled: true, finePerDayCents: 10, fineCapCents: 0 },
    });
  }, 120_000);

  it('opens one outstanding fine per overdue loan, across the page boundary', async () => {
    await sweepFineAccrual();
    const fines = await tenantClient!.fine.findMany({
      where: { loanId: { in: ids }, status: 'outstanding' },
      select: { loanId: true, amountCents: true },
    });
    expect(fines).toHaveLength(BULK);
    // The loan at index 500 is on the SECOND page. If the keyset cursor did not
    // advance, this one has no fine (or the sweep never terminated).
    const last = fines.find((f) => f.loanId === ids[BULK - 1]);
    expect(last).toBeDefined();
    // 10 c/day, integer subunits throughout — the amount is days × rate.
    for (const f of fines) {
      expect(f.amountCents % 10).toBe(0);
      expect(f.amountCents).toBeGreaterThan(0);
    }
  }, 120_000);

  it('grows every existing fine through the batched UPDATE, keeping the status guard', async () => {
    const before = await tenantClient!.fine.findMany({
      where: { loanId: { in: ids }, status: 'outstanding' },
      select: { id: true, loanId: true, amountCents: true, updatedAt: true },
    });
    const byLoan = new Map(before.map((f) => [f.loanId!, f]));

    // A librarian waives one of them. The sweep must leave a resolved fine
    // alone — that guard used to live in the per-row `updateMany` WHERE and now
    // lives in the batched statement's WHERE.
    const waived = byLoan.get(ids[0]!)!;
    await tenantClient!.fine.update({
      where: { id: waived.id },
      data: { status: 'waived' },
    });

    // Age every loan by another 5 days so every remaining amount changes.
    await tenantClient!.$executeRawUnsafe(
      `UPDATE "loans" SET "dueAt" = "dueAt" - interval '5 day' WHERE "id" LIKE $1`,
      `perf08-loan-${tag}-%`,
    );

    await sweepFineAccrual();

    const after = await tenantClient!.fine.findMany({
      where: { loanId: { in: ids }, status: 'outstanding' },
      select: { id: true, loanId: true, amountCents: true, updatedAt: true },
    });
    expect(after.length).toBe(BULK);

    for (const f of after) {
      const was = byLoan.get(f.loanId!)!;
      if (f.loanId === ids[0]) {
        // The waived one. It is NOT resurrected — this is a new row — and the
        // waived amount is netted off, so the member is billed only for the
        // days that accrued AFTER the write-off: 6 days × 10 c − 10 c waived.
        expect(f.id).not.toBe(was.id);
        // 6 days overdue at 10 c/day, less the 10 c already written off.
        expect(f.amountCents).toBe(60 - was.amountCents);
        continue;
      }
      expect(f.id).toBe(was.id); // grown, not duplicated
      expect(f.amountCents).toBe(was.amountCents + 50); // 5 more days × 10 c
      // Raw SQL does not get Prisma's @updatedAt for free; the column is NOT
      // NULL with no database default, so the batched statement has to set it.
      expect(f.updatedAt.getTime()).toBeGreaterThan(was.updatedAt.getTime());
    }

    const stillWaived = await tenantClient!.fine.findUnique({ where: { id: waived.id } });
    expect(stillWaived!.status).toBe('waived');
    expect(stillWaived!.amountCents).toBe(waived.amountCents);
  }, 180_000);
});

describe('performance-07 — the 30-day Stripe payload prune the schema promised', () => {
  const evtOldProcessed = `evt_perf07_old_${tag}`;
  const evtOldUnprocessed = `evt_perf07_stuck_${tag}`;
  const evtRecent = `evt_perf07_recent_${tag}`;
  const body = { id: 'evt', object: 'event', data: { object: { blob: 'x'.repeat(512) } } };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  it('records three events: old+processed, old+stuck, recent+processed', async () => {
    await controlDb.stripeWebhookEvent.createMany({
      data: [
        {
          id: evtOldProcessed,
          type: 'invoice.paid',
          payloadJson: body,
          receivedAt: daysAgo(45),
          processedAt: daysAgo(45),
        },
        {
          id: evtOldUnprocessed,
          type: 'invoice.paid',
          payloadJson: body,
          receivedAt: daysAgo(45),
          processedAt: null,
        },
        {
          id: evtRecent,
          type: 'invoice.paid',
          payloadJson: body,
          receivedAt: daysAgo(2),
          processedAt: daysAgo(2),
        },
      ],
    });
  });

  it('prunes only the processed body past 30 days, and leaves the ledger row', async () => {
    const res = await sweepRetention({
      emails: undefined as never,
      redis: app.get(RedisService),
    });
    expect(res.counts?.stripePayloadsPruned).toBeGreaterThanOrEqual(1);

    const rows = await controlDb.stripeWebhookEvent.findMany({
      where: { id: { in: [evtOldProcessed, evtOldUnprocessed, evtRecent] } },
      select: { id: true, payloadJson: true, processedAt: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The row survives: `persistEvent` reads processedAt off it as the durable
    // replay guard, so deleting it would re-arm a >30-day-old redelivery.
    expect(byId.size).toBe(3);
    expect(byId.get(evtOldProcessed)!.payloadJson).toEqual({});
    // Never processed = an operator's to-do list; the payload is the only thing
    // they can replay from.
    expect(byId.get(evtOldUnprocessed)!.payloadJson).toEqual(body);
    expect(byId.get(evtRecent)!.payloadJson).toEqual(body);
  }, 180_000);

  it('is a no-op on the next run', async () => {
    const res = await sweepRetention({
      emails: undefined as never,
      redis: app.get(RedisService),
    });
    expect(res.counts?.stripePayloadsPruned).toBe(0);
  }, 180_000);

  it('provisions the partial index that keeps the steady state off a full scan', async () => {
    const idx = await controlDb.$queryRawUnsafe<{ indexname: string }[]>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'stripe_webhook_events'",
    );
    expect(idx.map((r) => r.indexname)).toContain('stripe_webhook_events_prunable_idx');
  });
});
