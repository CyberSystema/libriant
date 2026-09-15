import { controlDb } from '@libriant/db-control';
import type { Prisma } from '@libriant/db-tenant';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import {
  TENANT_CONTEXT_SELECT,
  tenantContextFrom,
  readSchemaMajors,
} from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { fetchOpenLibraryBook } from '../isbn/openlibrary.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Book-metadata backfill sweep.
 *
 * Books are enriched from OpenLibrary at creation time, but plenty arrive
 * without it — bulk imports, manual entry, or ISBNs OpenLibrary hadn't indexed
 * yet. This walks every active tenant and, for books that have an ISBN-13 but
 * are still missing display metadata, fetches OpenLibrary and fills *only the
 * empty fields*. It never overwrites data a librarian has entered.
 *
 * Scope is deliberately the "display/independent" fields — description,
 * publicationYear, numPages, language. Search-derived fields (publisher,
 * subtitle, title) are left alone: they feed `searchText`/`sortTitle`, which
 * this DI-free worker job can't recompute without the full book payload, so
 * backfilling them would drift the search index.
 *
 * `metadataRefreshedAt` is stamped on *every* attempt — even when OpenLibrary
 * has nothing — so each run walks forward through the catalog (nulls first,
 * then oldest) instead of re-hammering the same rows. A row is reconsidered
 * once it's older than {@link REFRESH_INTERVAL_DAYS}, in case OpenLibrary has
 * since indexed it. Transient fetch failures are *not* stamped, so they retry
 * on the next sweep.
 *
 * Mirrors the fine-accrual / reservation-expiry per-tenant pattern (one client
 * per tenant DB; the TenantPrismaService LRU bounds connection counts).
 *
 * performance-09, and DO THE ARITHMETIC, because the number is the argument.
 * The budget is PER_TENANT_LIMIT books per run and the registry ticks this
 * every 6 h, so a tenant gets 40 x 4 = 160 attempts a day. `nulls: 'first'`
 * means never-attempted books always win, so a pass really does advance at
 * 160/day — but on the audit's 400,000-title fixture 160,000 rows qualify, and
 * 160,000 / 160 is 1,000 days. An Institutional catalogue is not going to be
 * enriched by this job in any timeframe a librarian would recognise.
 *
 * NOT "fixed" by raising the budget. The rate ceiling is INTER_REQUEST_MS
 * against a free public API, not the database: 1,000 days becomes 200 days by
 * multiplying OpenLibrary traffic fivefold, which is not ours to spend. What is
 * fixed is that the arithmetic is now VISIBLE — every run reports `backlog`,
 * the count still waiting, which the runner prints and exports on
 * `libriant_worker_job_count` without flipping the run red. Before this the
 * same run said "49 tenant(s) scanned; no books needed metadata" whether the
 * queue held nothing or held 160,000.
 *
 * For the libraries this is actually sold to the arithmetic is different and
 * fine: a 30,000-title catalogue with, say, 15,000 qualifying rows converges in
 * about 94 days, unattended, at no cost to anyone.
 */
const REFRESH_INTERVAL_DAYS = 30;
const PER_TENANT_LIMIT = 40; // bound OpenLibrary traffic per tenant per run
const INTER_REQUEST_MS = 200; // be a polite OpenLibrary citizen
const MS_PER_DAY = 86_400_000;
const logger = new Logger('BookMetadataRefresh');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function refreshBookMetadata(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  // 2.0 phase 20f: which of these libraries have been cut over, in one query.
  // A sweep that assumed `lbr2` would query a schema a promoted tenant no
  // longer has.
  const schemaMajors = await readSchemaMajors(tenants.map((x) => x.id));

  const tenantPrisma = new TenantPrismaService('worker');
  let enriched = 0;
  let attempted = 0;
  let failed = 0;
  // Books that qualify and did not fit in this run's budget, summed across
  // tenants. Reported under `backlog`, which the runner prints for the operator
  // and exports on /metrics WITHOUT flipping the run red — a queue this job can
  // only drain at 160 rows/tenant/day is a fact to see, not a failure to page
  // someone about (see BACKLOG_KEYS in scheduled-jobs.runner.ts).
  let backlog = 0;
  // Transport errors talking to OpenLibrary. Informational on purpose — see
  // the note on the tenant loop below for why these do NOT flip the run red
  // on their own.
  let fetchErrors = 0;
  try {
    for (const t of tenants) {
      // The one-connection-per-tenant pin lives in the service's 'worker' role
      // now, not in this URL (performance-06: the old `connection_limit=1`
      // query parameter was silently ignored by Prisma 7's driver adapter).
      // Constructed INSIDE the per-tenant try. `tenantContextFrom` throws for a
      // tenant with no sealed database credential (tenant-isolation-02), and a
      // throw out here would end the sweep for EVERY library at the first
      // un-backfilled one — turning a single tenant's missing row into a
      // fleet-wide outage of the nightly job. The counter below is what that
      // case is for.
      try {
        const ctx: TenantContext = tenantContextFrom(t, 'path', schemaMajors.get(t.id));
        const res = await refreshOneTenant(ctx, tenantPrisma);
        enriched += res.enriched;
        attempted += res.attempted;
        fetchErrors += res.fetchErrors;
        backlog += res.backlog;
        // reliability-07 at row granularity. The per-book `catch` around the
        // OpenLibrary call used to `logger.debug` and continue, bumping
        // nothing: with OpenLibrary unreachable every candidate was skipped,
        // `attempted` stayed 0, and the sweep reported "N tenant(s) scanned;
        // no books needed metadata" — a clean success for a run that did
        // literally nothing, for six hours at a time.
        //
        // Judgement call on the threshold: a single flaky fetch among forty is
        // noise (the 5 s timeout will trip occasionally on a free public API),
        // and a job that goes red for six hours over one aborted request
        // trains everyone to ignore it. So the failure signal is "this tenant
        // had candidates and got NOTHING through" — zero progress despite
        // trying — which is the state that actually means the sweep is broken.
        // The raw count is still reported either way.
        if (res.attempted === 0 && res.fetchErrors > 0) {
          failed++;
          logger.warn(
            `metadata refresh made no progress for tenant=${t.slug}: ` +
              `all ${res.fetchErrors} OpenLibrary fetch(es) failed`,
          );
        }
      } catch (err) {
        failed++;
        logger.warn(`metadata refresh failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  const summary =
    attempted === 0
      ? `${tenants.length} tenant(s) scanned; no books needed metadata`
      : `enriched ${enriched}/${attempted} book(s) across ${tenants.length} tenant(s)`;

  return {
    message: fetchErrors === 0 ? summary : `${summary}; ${fetchErrors} OpenLibrary fetch error(s)`,
    counts: {
      enriched,
      attempted,
      fetchErrors,
      backlog,
      tenantsScanned: tenants.length,
      tenantsFailed: failed,
    },
  };
}

async function refreshOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
): Promise<{ enriched: number; attempted: number; fetchErrors: number; backlog: number }> {
  const client = tenantPrisma.getClient(ctx);
  const cutoff = new Date(Date.now() - REFRESH_INTERVAL_DAYS * MS_PER_DAY);

  // performance-09. Both statements below are answered by
  // `books_metadata_backfill_idx` (migration 20260826210100), which is partial
  // on exactly this predicate and ordered NULLS FIRST to match the sort.
  // Without it the ordering could not be served — a plain ascending btree is
  // NULLS LAST, the wrong end — and each of these read the whole table:
  //   candidates  Parallel Seq Scan, 10,598 buffers, 27.2 ms -> 5 buffers, 0.033 ms
  //   backlog     Parallel Seq Scan, 10,526 buffers, 24.6 ms -> Index Only Scan,
  //               138 buffers, 6.5 ms
  // measured on 400,000 titles of which 160,000 qualify. The count is the
  // reason the sweep can say how far behind it is; on the pre-index plan it
  // would have doubled the scan it was there to report on.
  const candidateWhere = {
    archivedAt: null,
    isbn13: { not: null },
    AND: [
      // not attempted recently
      { OR: [{ metadataRefreshedAt: null }, { metadataRefreshedAt: { lt: cutoff } }] },
      // still missing at least one backfillable field
      {
        OR: [
          { description: null },
          { publicationYear: null },
          { numPages: null },
          { language: null },
        ],
      },
    ],
  } satisfies Prisma.BookWhereInput;

  const candidates = await client.book.findMany({
    where: candidateWhere,
    orderBy: { metadataRefreshedAt: { sort: 'asc', nulls: 'first' } },
    take: PER_TENANT_LIMIT,
    select: {
      id: true,
      isbn13: true,
      description: true,
      publicationYear: true,
      numPages: true,
      language: true,
    },
  });

  let enriched = 0;
  let attempted = 0;
  let fetchErrors = 0;
  for (const book of candidates) {
    if (!book.isbn13) continue;
    let result;
    try {
      result = await fetchOpenLibraryBook(book.isbn13);
    } catch (err) {
      // Transient transport failure — leave metadataRefreshedAt untouched so
      // the next sweep retries this book. Counted, not just logged: a `catch`
      // that bumps nothing is how a 100%-failing run reported success (the
      // caller decides what the count means).
      fetchErrors++;
      logger.debug(`OpenLibrary fetch failed for isbn=${book.isbn13}: ${describeError(err)}`);
      continue;
    }
    attempted++;

    const patch: {
      description?: string;
      publicationYear?: number;
      numPages?: number;
      language?: string;
      metadataRefreshedAt: Date;
    } = { metadataRefreshedAt: new Date() };

    if (result) {
      if (book.description == null && result.description) patch.description = result.description;
      if (book.publicationYear == null && result.publicationYear != null) {
        patch.publicationYear = result.publicationYear;
      }
      if (book.numPages == null && result.numPages != null) patch.numPages = result.numPages;
      if (book.language == null && result.language) patch.language = result.language;
    }

    const filledSomething =
      patch.description !== undefined ||
      patch.publicationYear !== undefined ||
      patch.numPages !== undefined ||
      patch.language !== undefined;

    await client.book.update({ where: { id: book.id }, data: patch });
    if (filledSomething) enriched++;

    await sleep(INTER_REQUEST_MS);
  }

  // What is still waiting AFTER this run's budget. Counted here, at the end,
  // so the rows just stamped are already out of it and the number is the size
  // of the queue the next tick will see.
  const backlog = await client.book.count({ where: candidateWhere });

  return { enriched, attempted, fetchErrors, backlog };
}
