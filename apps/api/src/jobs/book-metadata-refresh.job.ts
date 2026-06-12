import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { fetchOpenLibraryBook } from '../catalog/openlibrary.js';
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
    select: {
      id: true,
      slug: true,
      name: true,
      defaultLocale: true,
      status: true,
      dbUrl: true,
      storageUrl: true,
      customSubdomain: true,
      tags: true,
    },
  });

  const tenantPrisma = new TenantPrismaService();
  let enriched = 0;
  let attempted = 0;
  let failed = 0;
  try {
    for (const t of tenants) {
      const ctx: TenantContext = { ...t, resolvedFrom: 'path' };
      try {
        const res = await refreshOneTenant(ctx, tenantPrisma);
        enriched += res.enriched;
        attempted += res.attempted;
      } catch (err) {
        failed++;
        logger.warn(`metadata refresh failed for tenant=${t.slug}: ${(err as Error).message}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      attempted === 0
        ? `${tenants.length} tenant(s) scanned; no books needed metadata`
        : `enriched ${enriched}/${attempted} book(s) across ${tenants.length} tenant(s)`,
    counts: { enriched, attempted, tenantsScanned: tenants.length, tenantsFailed: failed },
  };
}

async function refreshOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
): Promise<{ enriched: number; attempted: number }> {
  const client = tenantPrisma.getClient(ctx);
  const cutoff = new Date(Date.now() - REFRESH_INTERVAL_DAYS * MS_PER_DAY);

  const candidates = await client.book.findMany({
    where: {
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
    },
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
  for (const book of candidates) {
    if (!book.isbn13) continue;
    let result;
    try {
      result = await fetchOpenLibraryBook(book.isbn13);
    } catch (err) {
      // Transient transport failure — leave metadataRefreshedAt untouched so
      // the next sweep retries this book.
      logger.debug(`OpenLibrary fetch failed for isbn=${book.isbn13}: ${(err as Error).message}`);
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

  return { enriched, attempted };
}
