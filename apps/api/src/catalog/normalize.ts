import { SEARCH_MIN_CHARS } from '@libriant/shared';
import { classifySearchTerm as sharedClassify, type SearchTerm } from '@libriant/shared/search';
import { foldGreek } from '@libriant/shared/greek';

/**
 * Lowercase + accent-fold helper used to compute `sortTitle` / `searchText`
 * across catalog entities (and replicated in `collection-records.service.ts`).
 *
 * THE IMPLEMENTATION MOVED TO `@libriant/shared/greek`. It used to be
 * `toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')` right here, which is
 * correct for accents and wrong for sigma:
 *
 *     normalizeText('ΠΟΛΙΣ')  ->  π ο λ ι U+03C2     (Unicode's Final_Sigma rule)
 *     normalizeText('πολισ')  ->  π ο λ ι U+03C3     (what a person types)
 *
 * so `Η ΠΟΛΙΣ ΕΑΛΩ`, catalogued in capitals as Greek library exports usually
 * are, could not be found by searching `πολισ`. `foldGreek` collapses the two
 * sigmas and every other Greek letter with more than one written form, and the
 * same fold now exists in Postgres (`greek/greek-fold.sql`) with
 * `pnpm check:greek-folding` holding the two together.
 *
 * WHAT THIS MEANS RIGHT NOW, STATED PLAINLY. The function's OUTPUT CHANGED, and
 * no stored data has been rewritten. Until the projection rebuild, rows written
 * before this change still carry the old fold, so during that window:
 *
 *   - a record written from now on is findable by an ordinary query, which it
 *     was not before — the fix, and the common case;
 *   - a record written BEFORE, whose search_text ends in U+03C2, stops matching
 *     a query that used to reach it by also ending in U+03C2. It was already
 *     unreachable from the query people actually type.
 *
 * That window is deliberate and bounded: the 1.0 -> 2.0 upgrade recomputes
 * every `searchText`, `sortName` and `sortTitle` in the same transaction, and
 * it is the only pass over that data anyone should pay for. There are no
 * libraries in production, so the window costs nothing real.
 */
export const normalizeText = foldGreek;

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
// Defined in @libriant/shared because the web pickers have to honour the same
// floor; see the note there. Re-exported so this module stays the one import
// site for everything search-normalisation in the API.
export { SEARCH_MIN_CHARS };

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
export type { SearchTerm };

/**
 * The implementation moved to `@libriant/shared/search` in 2.0 phase 20a, ahead
 * of the cutover that deletes this module. This is a thin forward so the two
 * surviving callers keep working unchanged until phase 20b repoints them.
 */
export function classifySearchTerm(q: string | null | undefined): SearchTerm {
  return sharedClassify(q, normalizeText);
}

/** Strip everything that's not a digit (or X for ISBN-10). */
export function digitsOnly(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9Xx]/g, '');
  return cleaned.length ? cleaned : null;
}
