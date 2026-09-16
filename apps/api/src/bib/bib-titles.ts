import type { TenantPrismaClientV2 } from '@libriant/db-tenant';

/**
 * The titles for a page of rows that carry a `bib_id` (2.0 phase 20q).
 *
 * ## Why this exists at all
 *
 * A loan, a hold and a fee are all stored against a `bib_id` and none of them
 * joins a title. Measured across the whole 2.0 surface before this file was
 * written: `GET /items/by-barcode` was the ONLY route anywhere that reached
 * `bib_records.title`, and it takes one barcode. So every screen that lists
 * circulation — the desk's busiest — had a column with no source, and the
 * shapes that would have filled it are all wrong:
 *
 *   - **A per-row `GET`** is 25 round trips for one page, and `GET /catalog/bib/:id`
 *     does not return a title anyway (20j: the record read is the MARC, and the
 *     projection is a different route).
 *   - **`BibListQueryDto`** takes no id-set filter and refuses an unknown param,
 *     so a page of ids cannot be asked for in one call.
 *   - **A relation hop from the item** (`item.bib.bib.title`) reads the item's
 *     CURRENT bib through `marc_records`, which is three `WHERE id IN (…)`
 *     queries where this is one, and answers the wrong question the day a bib
 *     merge (M5) moves a copy: a loan names the bib that was LENT.
 *
 * ## One query, and it must stay one
 *
 * Prisma resolves this as a single `WHERE bib_id IN (…)` on the primary key of
 * `bib_records`. Callers pass the ids of ONE page — never an unbounded set —
 * because the `IN` list is written into the statement text, and a caller that
 * hands it ten thousand ids has built a query plan per page size.
 *
 * `title` is `NOT NULL` in the projection (the projector substitutes a sentinel
 * and records an anomaly rather than throwing, because a record with no 245
 * exists in every real import), so a missing entry here means the projection row
 * itself is absent — which the nightly `catalog-verify` drift job owns. Callers
 * render that as an unknown title rather than an empty cell.
 */
export async function bibTitlesFor(
  client: TenantPrismaClientV2,
  bibIds: readonly string[],
): Promise<Map<string, string>> {
  // An empty page must not emit `IN ()`, which Prisma turns into a scan of the
  // whole projection.
  const ids = Array.from(new Set(bibIds));
  if (ids.length === 0) return new Map();

  const rows = await client.bibRecord.findMany({
    where: { bibId: { in: ids } },
    // ONLY these two. `search_text`, `summary` and `projection_anomalies` are
    // the three fat columns on this table, and a default select puts a TOAST
    // read on every row — the mistake `bib-projection-toast.spec.ts` measures.
    select: { bibId: true, title: true },
  });

  return new Map(rows.map((r) => [r.bibId, r.title]));
}
