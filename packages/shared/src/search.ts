/**
 * The shortest query a trigram index can serve.
 *
 * This lives in `shared` and not in the API because it is a CONTRACT between
 * the two sides, and the two sides drifted. performance-12 put a 3-character
 * floor on `/catalog/books` and `/catalog/authors`: below it the endpoint
 * answers an empty page rather than running `LIKE %ab%` across the whole
 * table. The pickers in the web app kept their own default of 1, so typing
 * "Πα" fired a request, got back nothing, and rendered "No matches." — which
 * is a lie. The book is there; the query was too short to look for it.
 *
 * A constant duplicated on both sides would have drifted again the next time
 * the floor moved. Importing the same one means the UI cannot disagree with
 * the endpoint it is calling.
 *
 * Why three: a pg_trgm GIN index cannot use a pattern with fewer than three
 * characters, so a two-character search degrades to a sequential scan of every
 * row (measured at 13,407 buffers against 7 for the indexed path).
 */
export const SEARCH_MIN_CHARS = 3;

/**
 * The shortest query a REAL index can serve.
 *
 * A trigram index needs three characters because it has nothing to seek with
 * below that. An inverted index does not: it can answer a one-character prefix
 * from its term dictionary. So the floor is not a property of the product, it
 * is a property of whichever backend is answering — and once `packages/search`
 * ships two of them (Postgres for a small or air-gapped install, OpenSearch for
 * a large one), a single constant would be wrong for one of them.
 *
 * The floor therefore moves with the backend, and it moves in ONE place. The
 * mistake this prevents is the one {@link SEARCH_MIN_CHARS} already documents,
 * repeated: a UI that keeps its own default disagrees with the endpoint it is
 * calling, and the symptom is "No matches." for a book that is on the shelf.
 */
export const SEARCH_MIN_CHARS_INDEXED = 1;

/** What a search backend can do. Grows as `packages/search` grows. */
export interface SearchCapabilities {
  /**
   * True when the backend holds a term dictionary it can seek a short prefix
   * in — OpenSearch, or any inverted index. False for the trigram backend,
   * where a short pattern degrades to a sequential scan of the whole table.
   */
  readonly invertedIndex: boolean;
}

/**
 * The minimum query length for a backend.
 *
 * Deliberately takes the capability rather than a backend NAME: a name would
 * have to be re-mapped here every time a driver is added, and the thing that
 * actually decides is whether there is a term dictionary to seek in.
 */
export function minCharsFor(capabilities: SearchCapabilities): number {
  return capabilities.invertedIndex ? SEARCH_MIN_CHARS_INDEXED : SEARCH_MIN_CHARS;
}

/**
 * What a caller's query string is, once it has been folded and measured.
 *
 * Moved here from `apps/api/src/catalog/normalize.ts` by 2.0 phase 20a, ahead of
 * the cutover that deletes that module. Two of its three consumers —
 * `customization/collection-records.service.ts` and `import/engine/import-engine.ts`
 * — survive 1.0, so the classifier could not simply go with it, and the 2.0 list
 * endpoints need the same floor for the same reason.
 *
 * It belongs beside `SEARCH_MIN_CHARS` rather than in the API for the reason
 * that constant is here at all: it is a CONTRACT between the endpoint and the
 * UI, and the two drifted once already.
 */
export type SearchTerm =
  { kind: 'none' } | { kind: 'short'; minChars: number } | { kind: 'term'; value: string };

/**
 * Fold a query and decide whether it is long enough to look for.
 *
 * `short` is NOT "no results": it is "keep typing", and the endpoints return it
 * as `minQueryChars` so the UI can say so. Answering an unfiltered page instead
 * would hand back the whole catalogue for "ab", which reads as a broken filter;
 * answering an empty one with no explanation reads as "the book is not here",
 * which is a lie about a book that is on the shelf.
 *
 * Counted in CODE POINTS, not UTF-16 units, so a three-character Greek term is
 * three characters here too.
 */
export function classifySearchTerm(
  q: string | null | undefined,
  fold: (s: string) => string,
): SearchTerm {
  if (q === null || q === undefined) return { kind: 'none' };
  const normalized = fold(q);
  if (normalized.length === 0) return { kind: 'none' };
  if ([...normalized].length < SEARCH_MIN_CHARS) {
    return { kind: 'short', minChars: SEARCH_MIN_CHARS };
  }
  return { kind: 'term', value: normalized };
}
