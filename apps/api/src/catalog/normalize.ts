/**
 * Lowercase + accent-fold helper used to compute `sortTitle` / `searchText`
 * across catalog entities (and replicated in `collection-records.service.ts`).
 *
 * Greek and Latin both share the property that diacritics (tonos, acute,
 * grave, ...) are decoded as combining code points in NFD. Stripping them
 * with a regex over the `̀-ͯ` block leaves the base letter.
 *
 * Why JS-side and not Postgres? Postgres has `unaccent`, but it's not
 * `IMMUTABLE` by default, which means it can't be used in a generated
 * column or index expression without wrapping. Doing the fold in the
 * application keeps the schema simple and matches what the trigram GIN
 * index expects.
 */
export function normalizeText(input: string): string {
  return input.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/**
 * Build a `searchText` blob for an entity — concatenated, normalized,
 * deduplicated whitespace.
 */
export function buildSearchText(parts: Array<string | number | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p === null || p === undefined) continue;
    const s = normalizeText(String(p));
    if (!s) continue;
    for (const token of s.split(/\s+/)) {
      if (!token) continue;
      if (!seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out.join(' ');
}

/**
 * Shortest search term the trigram indexes can answer (performance-12).
 *
 * `searchText LIKE '%q%'` is served by the `*_search_trgm` / `*_sortname_trgm`
 * GIN indexes only once the pattern yields at least one FULL trigram, i.e.
 * from three characters. At one or two the planner has nothing to seek with
 * and falls back to reading the entire table.
 *
 * Measured on a 400,000-title catalogue (audit Postgres, C locale), on the
 * literal statement Prisma emits for `books.list`:
 *
 *   '%ab%'   Parallel Seq Scan on books   Buffers: shared hit=1892 read=11515
 *                                         Execution Time: 33.324 ms
 *   '%abc%'  Bitmap Index Scan on books_search_trgm
 *                                         Buffers: shared hit=4 read=3
 *                                         Execution Time: 0.025 ms
 *
 * 13,407 buffers versus 7 — a 1,915x difference across the two/three-character
 * boundary, on a route any signed-in staff member can hold down. Postgres runs
 * 128 MB of shared_buffers for EVERY library on the box, so one librarian
 * leaning on the search box evicts every other library's cache.
 */
export const SEARCH_MIN_CHARS = 3;

/**
 * Normalize a user-supplied search term and classify it for a list endpoint.
 *
 * Three outcomes, because the caller has to treat them differently:
 *   - `{ kind: 'none' }`  — nothing was typed; list everything.
 *   - `{ kind: 'short' }` — something was typed but it cannot be indexed.
 *                           The caller must answer an EMPTY page, not an
 *                           unfiltered one: returning the whole catalogue for
 *                           "ab" looks like the filter silently broke, and
 *                           running the query looks like performance-12.
 *   - `{ kind: 'term' }`  — normalized term to hand to Prisma.
 *
 * Counted in code points, not UTF-16 units, so a three-character Greek term is
 * three characters here as well.
 */
export type SearchTerm =
  { kind: 'none' } | { kind: 'short'; minChars: number } | { kind: 'term'; value: string };

export function classifySearchTerm(q: string | null | undefined): SearchTerm {
  if (q === null || q === undefined) return { kind: 'none' };
  const normalized = normalizeText(q);
  if (normalized.length === 0) return { kind: 'none' };
  if ([...normalized].length < SEARCH_MIN_CHARS) {
    return { kind: 'short', minChars: SEARCH_MIN_CHARS };
  }
  return { kind: 'term', value: normalized };
}

/** Strip everything that's not a digit (or X for ISBN-10). */
export function digitsOnly(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9Xx]/g, '');
  return cleaned.length ? cleaned : null;
}
