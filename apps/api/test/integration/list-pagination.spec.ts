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
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Paging the catalogue and the holds screen are day-one library actions. Nothing here ' +
    'asserts a plan gate, so this runs the shipped configuration.',
);

/**
 * performance-03 and performance-10, driven through the real HTTP routes
 * against a real provisioned tenant database.
 *
 * Both findings are about work Postgres does that never reaches the response,
 * so a test that only compares JSON certifies nothing: the audited code returns
 * exactly the same rows, it just reads the whole table to produce them. So each
 * case here pairs a CORRECTNESS assertion (walking a list page by page must
 * visit every row once, in order) with a COST assertion read from Postgres's own
 * cumulative statistics — how many tuples the database had to touch in
 * `books` / `reservations` to render one page.
 *
 * Each meter has a POSITIVE CONTROL in the same describe block — the full walk,
 * which must register at least one tuple per row — so that a small reading can
 * never be mistaken for statistics that never arrived, which would turn this
 * whole file into a test that passes when it is not looking.
 */
let app: NestExpressApplication;
let tenantCookie = '';
let slug = '';
let tenantClient: TenantPrismaClient | null = null;
let statsProbe: TenantPrismaClient | null = null;
/** The order the database itself puts each list in — every walk is compared to
 *  this, so a keyset tier that drops or repeats a row cannot hide. */
let bookOrder: string[] = [];
let holdOrder: string[] = [];
const tag = randomBytes(3).toString('hex');

/** Big enough that reading the whole table to render one page is measurable. */
const BOOKS = 3_000;
const MEMBERS = 40;
const LIVE_HOLDS = 1_200;
const PAGE = 25;

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

const http = () => request(app.getHttpServer());

type Cost = { scans: number; tuples: number };

/**
 * Make the API's Postgres backends hand over the statistics they are still
 * holding.
 *
 * A backend accumulates its counter updates locally and pushes them into the
 * shared tables only when it next processes a command, and never more than once
 * a second — so after the request under test the numbers are still sitting in a
 * connection somewhere. Requests to an unrelated table (`members`, which no
 * measurement here touches), each one arriving after that one-second window has
 * closed, walk every connection in the tenant pool and force the flush. The
 * PAUSE is the load-bearing part: five requests fired back to back flush
 * nothing at all, and the leftovers then land in the next test's measurement.
 */
async function drainStats(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 1_100));
    // In PARALLEL, and more of them than the pool holds: the flush happens per
    // CONNECTION, so serial requests can be served by one connection all the way
    // through while the one that ran the query under test never gets a command
    // and never hands its counters over. That made this guard miss a real
    // regression one run in two.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        http().get(`/t/${slug}/members?limit=1`).set('Cookie', tenantCookie).expect(200),
      ),
    );
  }
}

/**
 * Read `table`'s cumulative counters.
 *
 * `pg_stat_clear_snapshot()` first, and this is not optional: Postgres defaults
 * to `stats_fetch_consistency = cache`, so a long-lived pooled connection keeps
 * serving the FIRST reading it ever took. Without the clear this returns the
 * same numbers all suite long, every delta is zero, and every "the page was
 * cheap" assertion below passes without looking at anything.
 */
async function readCost(table: string): Promise<Cost> {
  await statsProbe!.$executeRawUnsafe(`SELECT pg_stat_clear_snapshot()`);
  const [t] = await statsProbe!.$queryRawUnsafe<{ scans: bigint; tuples: bigint }[]>(
    `SELECT coalesce(seq_scan,0) + coalesce(idx_scan,0) AS scans,
            coalesce(seq_tup_read,0) + coalesce(idx_tup_fetch,0) AS tuples
       FROM pg_stat_user_tables WHERE relname = $1`,
    table,
  );
  const [x] = await statsProbe!.$queryRawUnsafe<{ tuples: bigint }[]>(
    `SELECT coalesce(sum(idx_tup_read),0) AS tuples
       FROM pg_stat_all_indexes WHERE relname = $1`,
    table,
  );
  return {
    scans: Number(t?.scans ?? 0),
    tuples: Number(t?.tuples ?? 0) + Number(x?.tuples ?? 0),
  };
}

/**
 * How much of `table` Postgres had to touch to serve `work`: scans started, and
 * tuples read through them.
 *
 * A DELTA rather than a reset-and-read, because a reset cannot win the race —
 * counters still pending in a connection from an earlier test land after the
 * reset and are charged to this one. Draining on BOTH sides makes those
 * leftovers appear in the `before` reading, where they cancel.
 */
async function measureCost<T>(table: string, work: () => Promise<T>): Promise<[T, Cost]> {
  await drainStats();
  const before = await readCost(table);
  const result = await work();
  await drainStats();
  const after = await readCost(table);
  const cost: Cost = { scans: after.scans - before.scans, tuples: after.tuples - before.tuples };
  if (process.env.LBR_COST_DEBUG)
    console.log(
      'cost',
      table,
      JSON.stringify(cost),
      'before',
      JSON.stringify(before),
      'after',
      JSON.stringify(after),
    );
  return [result, cost];
}

/** Walk a list endpoint to the end, following `nextCursor`, collecting ids. */
async function walk(path: string): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let after: string | null = null;
  let pages = 0;
  // Hard stop well above the expected page count, so a cursor that fails to
  // advance fails the page-count assertion instead of looping forever.
  while (pages < 500) {
    const url = `${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}${
      after ? `&after=${encodeURIComponent(after)}` : ''
    }`;
    const res: request.Response = await http().get(url).set('Cookie', tenantCookie).expect(200);
    pages++;
    ids.push(...(res.body.items as { id: string }[]).map((r) => r.id));
    after = res.body.nextCursor as string | null;
    if (!after) break;
  }
  return { ids, pages };
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

  slug = `paging-${tag}`;
  const signup = await http()
    .post('/auth/signup')
    .send({
      libraryName: `Paging ${slug}`,
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
  // Its own connection: reading the counters must not be the thing that moves
  // them, and it has to survive while the app's pool is busy.
  statsProbe = makeTenantPrismaClient({ databaseUrl: tenant.dbUrl, maxPoolSize: 1 });

  // Seed straight into the tenant database. `sortTitle` is a hash of the index
  // so that alphabetical order is UNCORRELATED with insertion order — a keyset
  // cursor that quietly paged by id instead would otherwise still look right.
  const hash = (n: number) => `t${(n * 2654435761) % 4294967296}`.padEnd(12, '0');
  await tenantClient.book.createMany({
    data: Array.from({ length: BOOKS }, (_, i) => ({
      id: `bk${String(i).padStart(8, '0')}`,
      title: `Τίτλος ${i}`,
      sortTitle: hash(i + 1),
      searchText: `${hash(i + 1)} τιτλος ${i}`,
      // An ISBN and no description: every one of these is a candidate for the
      // metadata backfill sweep, which is what makes the plan assertion in the
      // performance-09 block worth anything.
      isbn13: `978${String(i).padStart(10, '0')}`,
    })),
  });
  await tenantClient.member.createMany({
    data: Array.from({ length: MEMBERS }, (_, i) => ({
      id: `mb${String(i).padStart(8, '0')}`,
      memberNumber: `PG-${tag.toUpperCase()}-${String(i).padStart(5, '0')}`,
      fullName: `Μέλος ${i}`,
      sortName: `μελος ${i}`,
      searchText: `μελος ${i}`,
    })),
  });
  // Live holds across all four sort keys: two statuses, several queue
  // positions, `queuePosition = NULL` for the ready ones (which is what breaks
  // Prisma's own cursor), and placedAt spread out.
  const now = Date.now();
  await tenantClient.reservation.createMany({
    data: Array.from({ length: LIVE_HOLDS }, (_, i) => {
      const ready = i % 6 === 0;
      return {
        id: `rs${String(i).padStart(8, '0')}`,
        bookId: `bk${String(i).padStart(8, '0')}`,
        memberId: `mb${String(i % MEMBERS).padStart(8, '0')}`,
        placedAt: new Date(now - (i % 97) * 60_000),
        queuePosition: ready ? null : 1 + (i % 5),
        status: ready ? ('ready' as const) : ('queued' as const),
        ...(ready ? { readyAt: new Date(now), expiresAt: new Date(now + 86_400_000) } : {}),
      };
    }),
  });
  await tenantClient.$executeRawUnsafe('ANALYZE books');
  await tenantClient.$executeRawUnsafe('ANALYZE reservations');

  bookOrder = (
    await tenantClient.book.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortTitle: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
  ).map((b) => b.id);
  holdOrder = (
    await tenantClient.reservation.findMany({
      where: { status: { in: ['queued', 'ready'] } },
      orderBy: [
        { status: 'asc' },
        { queuePosition: { sort: 'asc', nulls: 'last' } },
        { placedAt: 'desc' },
        { id: 'asc' },
      ],
      select: { id: true },
    })
  ).map((r) => r.id);
}, 180_000);

afterAll(async () => {
  if (tenantClient) await tenantClient.$disconnect().catch(() => undefined);
  if (statsProbe) await statsProbe.$disconnect().catch(() => undefined);
  if (app) await app.close();
}, 60_000);

describe('performance-03 — paging the catalogue seeks instead of re-reading it', () => {
  let wholeCatalogueCost = 0;

  it('walks every title exactly once, in order, over the real route', async () => {
    // Doubles as the cost meter's POSITIVE CONTROL: 120 pages that between them
    // read the whole catalogue must register as at least a catalogue's worth of
    // tuples. Without this, "the deep page cost almost nothing" below could be
    // satisfied by statistics that simply never arrived.
    const [{ ids, pages }, cost] = await measureCost('books', () =>
      walk(`/t/${slug}/catalog/books`),
    );
    expect(pages).toBe(Math.ceil(BOOKS / PAGE));
    expect(new Set(ids).size).toBe(BOOKS);
    expect(bookOrder).toHaveLength(BOOKS);
    expect(ids).toEqual(bookOrder);

    expect(cost.scans).toBeGreaterThan(0);
    expect(cost.tuples).toBeGreaterThanOrEqual(BOOKS);
    wholeCatalogueCost = cost.tuples;
  }, 180_000);

  it('reads a page near the END of the catalogue without reading what came before', async () => {
    // The audited code paged with Prisma's `cursor: { id }`, which renders as an
    // OR of correlated subselects — not a btree start key — so Postgres walked
    // `books_sortTitle_idx` from the beginning of the range and discarded every
    // row before the cursor. On a 400,000-title catalogue that is 106.90 ms and
    // `Rows Removed by Filter: 200001` for a 26-row page.
    //
    // The cursor here is the id of book 2,975 of 3,000 — deliberately the BARE
    // ID form, which is exactly what the audited code took, so the two builds
    // are asked the identical question. The audited one has to walk ~2,975
    // index entries to answer it.
    const deepId = bookOrder[BOOKS - PAGE - 1]!;

    const [page, cost] = await measureCost('books', () =>
      http()
        .get(`/t/${slug}/catalog/books?limit=${PAGE}&after=${deepId}`)
        .set('Cookie', tenantCookie)
        .expect(200),
    );
    expect(page.body.items.map((b: { id: string }) => b.id)).toEqual(bookOrder.slice(BOOKS - PAGE));

    expect(cost.scans).toBeGreaterThan(0);
    // Generous by design: the point is the difference between "a page" and "the
    // catalogue", not a tight constant. One page of 25 out of 3,000 titles must
    // cost far less than one three-hundredth of walking all 120 pages.
    expect(cost.tuples).toBeLessThan(300);
    expect(cost.tuples).toBeLessThan(wholeCatalogueCost / 100);
  }, 120_000);

  it('still accepts a bare book id as `after`, the way the cursor used to look', async () => {
    // A librarian mid-scroll across a deploy hands back the old shape. It must
    // land on the same page, not a 400 and not page 1.
    const first = await http()
      .get(`/t/${slug}/catalog/books?limit=${PAGE}`)
      .set('Cookie', tenantCookie)
      .expect(200);
    const lastId = first.body.items[PAGE - 1].id as string;
    const byToken = await http()
      .get(
        `/t/${slug}/catalog/books?limit=${PAGE}&after=${encodeURIComponent(first.body.nextCursor)}`,
      )
      .set('Cookie', tenantCookie)
      .expect(200);
    const byLegacyId = await http()
      .get(`/t/${slug}/catalog/books?limit=${PAGE}&after=${lastId}`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(byLegacyId.body.items.map((b: { id: string }) => b.id)).toEqual(
      byToken.body.items.map((b: { id: string }) => b.id),
    );
    expect(byToken.body.items[0].id).toBe(bookOrder[PAGE]);
  }, 60_000);
});

describe('performance-09 — the metadata backfill seeks its work queue', () => {
  it('provisions the partial NULLS FIRST index the sweep needs', async () => {
    const idx = await tenantClient!.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'books' AND indexname = 'books_metadata_backfill_idx'`,
    );
    expect(idx).toHaveLength(1);
    // Both halves are load-bearing. NULLS FIRST is what puts the
    // never-attempted books at the HEAD of the index, which is the end the
    // sweep reads from; the partial predicate is what keeps the index to the
    // work queue instead of the whole catalogue.
    expect(idx[0]!.indexdef).toMatch(/NULLS FIRST/);
    expect(idx[0]!.indexdef).toMatch(/WHERE .*"archivedAt" IS NULL/s);
    expect(idx[0]!.indexdef).toMatch(/description IS NULL/);
  });

  it('plans the candidate query as a seek, not a scan of the catalogue', async () => {
    // This is the PLAN for the statement `refreshBookMetadata` issues, taken
    // against the same real tenant database — not a run of the sweep itself,
    // which would call OpenLibrary for every active tenant on the box.
    //
    // `books_metadataRefreshedAt_idx` is plain ascending, which in Postgres is
    // NULLS LAST — the wrong end — so before the partial index the planner had
    // nothing to satisfy this ordering with and read the table:
    // `Parallel Seq Scan on books`, 10,598 buffers, 27.2 ms on 400,000 titles.
    const plan = (
      await tenantClient!.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT id, isbn13 FROM books
          WHERE "archivedAt" IS NULL AND isbn13 IS NOT NULL
            AND ("metadataRefreshedAt" IS NULL
                 OR "metadataRefreshedAt" < now() - interval '30 days')
            AND (description IS NULL OR "publicationYear" IS NULL
                 OR "numPages" IS NULL OR language IS NULL)
          ORDER BY "metadataRefreshedAt" ASC NULLS FIRST LIMIT 40`,
      )
    )
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain('books_metadata_backfill_idx');
    expect(plan).not.toMatch(/Seq Scan on books/);
  });
});

describe('performance-10 — the holds screen pages without sorting the whole queue', () => {
  it('walks every live hold exactly once, in order, over the real route', async () => {
    // This is the four-key ordering, including a NULLABLE key — the shape
    // Prisma cannot express an exact cursor predicate for. Any tier of the
    // hand-written keyset being wrong shows up here as a duplicate or a gap.
    //
    // Also the positive control for the reservations meter, as the catalogue
    // walk is for books: 48 pages that between them cover every live hold.
    const [{ ids, pages }, cost] = await measureCost('reservations', () =>
      walk(`/t/${slug}/reservations`),
    );
    expect(pages).toBe(Math.ceil(LIVE_HOLDS / PAGE));
    expect(new Set(ids).size).toBe(LIVE_HOLDS);
    expect(holdOrder).toHaveLength(LIVE_HOLDS);
    expect(ids).toEqual(holdOrder);

    expect(cost.scans).toBeGreaterThan(0);
    expect(cost.tuples).toBeGreaterThanOrEqual(LIVE_HOLDS);
  }, 180_000);

  it('renders "Load more" without pulling the rest of the hold queue', async () => {
    // THE regression this file exists for. Prisma silently DROPS the LIMIT when
    // a nullable column takes part in a cursor's ORDER BY, and filters the page
    // down in the client instead: `count(*)` over the literal SQL it emitted
    // for page 2 of a 40,000-hold library returned 39,976 rows to render 25.
    const first = await http()
      .get(`/t/${slug}/reservations?limit=${PAGE}`)
      .set('Cookie', tenantCookie)
      .expect(200);
    expect(first.body.nextCursor).toBeTruthy();

    const [second, cost] = await measureCost('reservations', () =>
      http()
        .get(
          `/t/${slug}/reservations?limit=${PAGE}&after=${encodeURIComponent(
            first.body.nextCursor,
          )}`,
        )
        .set('Cookie', tenantCookie)
        .expect(200),
    );
    expect(second.body.items).toHaveLength(PAGE);
    expect(second.body.items.map((r: { id: string }) => r.id)).toEqual(
      holdOrder.slice(PAGE, PAGE * 2),
    );

    expect(cost.scans).toBeGreaterThan(0);
    // One page's worth, not one library's worth. The audited path touches
    // roughly LIVE_HOLDS.
    expect(cost.tuples).toBeLessThan(200);
    expect(cost.tuples).toBeLessThan(LIVE_HOLDS / 4);
  }, 120_000);

  it('provisions the index that ordering needs', async () => {
    const idx = await tenantClient!.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'reservations'
          AND indexname = 'reservations_status_queuePosition_placedAt_id_idx'`,
    );
    expect(idx).toHaveLength(1);
    // Directions matter: `placedAt` DESC is what removes the sort node. An
    // all-ascending index returns the same rows and reintroduces the sort.
    expect(idx[0]!.indexdef).toMatch(/"placedAt" DESC/);
  });
});
