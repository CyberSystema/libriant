/**
 * The shape every 2.0 list endpoint returns, and the keyset predicate behind it
 * (2.0 phase 20a).
 *
 * ## Why this is one file and not eleven copies
 *
 * 1.0 has exactly one correct keyset implementation — `books.service.ts` —
 * written for performance-03 and carrying the measurement in its comment: on a
 * 400,000-title catalogue, `cursor: { id }, skip: 1` renders as an OR of
 * correlated subselects that Postgres cannot use as a btree start key, so page 1
 * is 0.87 ms and the page at depth 200,000 is 106.90 ms with
 * `Rows Removed by Filter: 200001`. The `gte` start key takes that back to
 * 0.87 ms and `Rows Removed by Filter: 1`.
 *
 * 2.0 needs the same thing eleven times over. Copying it eleven times is how the
 * TIE TIER gets dropped — and a keyset missing its tie tier is the worst kind of
 * defect this product can ship, because the page still renders. It just silently
 * loses whichever rows share a sort value with the last row of the previous
 * page: one patron of three who share a name, gone from the roster, with nothing
 * logged and no error anywhere. So the predicate is built here, once, and the
 * services say WHAT to page over rather than HOW.
 *
 * ## The predicate
 *
 * For an ascending list ordered by `(sortField, idField)`, resuming after the
 * row `(s, i)`:
 *
 *     sortField >= s                                    -- the START KEY
 *     AND (sortField > s OR (sortField = s AND id > i))  -- the exact BOUNDARY
 *
 * The first line is the whole performance fix: it is a value the planner can
 * seek to in the index, and it is only expressible because the cursor token
 * carries the last row's sort value and not merely its id. The second line is
 * the whole correctness fix: `gte` alone repeats every row tied on `sortField`,
 * and `gt` alone skips them. Descending lists get the mirror image.
 *
 * Both halves are needed and they are needed together, which is precisely why
 * they are not left to be re-derived per service.
 */
import { decodeCursor, encodeCursor } from './query.js';

/** What `encodeCursor` can carry. Dates are encoded as ISO strings. */
export type CursorScalar = string | number | null;

/**
 * The envelope. `items` + `nextCursor` is the contract `DataTable.loadMore()`
 * already speaks (apps/web/components/DataTable.tsx): it echoes `nextCursor`
 * back verbatim and never constructs one, so the token stays opaque.
 *
 * `minQueryChars` is optional and additive. It is present only on the answer to
 * a query that was too short to run, and it means "keep typing", not "nothing
 * found" — the difference between a UI that explains itself and one that tells a
 * librarian a book on the shelf is not in the catalogue.
 */
export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
  minQueryChars?: number;
}

/** The default page size, and the ceiling a caller cannot raise past. */
export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 100;

/**
 * A page size that is always a sane integer.
 *
 * `Number.parseInt('abc')` is NaN, and NaN survives `??`, `Math.min` and
 * `Math.max` unchanged — which reached Prisma as `take: NaN` and surfaced as a
 * 500 before `parseLimit` existed. Non-finite input falls back rather than
 * propagating.
 */
export function clampLimit(
  raw: number | undefined,
  max: number = LIST_MAX_LIMIT,
  fallback: number = LIST_DEFAULT_LIMIT,
): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(raw)));
}

/** The two values a keyset cursor carries: the leading sort key, and the id. */
export interface KeysetBoundary {
  readonly sort: string | number | Date;
  readonly id: string;
}

/**
 * The `AND` clauses that resume a list after {@link KeysetBoundary}.
 *
 * Returned as an array so a caller can drop it straight into
 * `where.AND = keysetPredicate(...)`, and as plain objects because the field
 * names are per-model — Prisma's generated `WhereInput` types cannot express
 * "some string key of this model" without a generic that every call site would
 * then have to spell out. The cast happens once, at the assignment, next to the
 * `orderBy` it has to agree with.
 *
 * `direction` MUST match the list's `orderBy`. They are two halves of one
 * decision and a mismatch is silent: an ascending predicate against a descending
 * order returns the rows BEFORE the cursor, so "Load more" pages backwards to
 * the start and the reader never reaches the end of the list.
 */
export function keysetPredicate(opts: {
  sortField: string;
  idField?: string;
  direction?: 'asc' | 'desc';
  after: KeysetBoundary;
}): Record<string, unknown>[] {
  const idField = opts.idField ?? 'id';
  const asc = (opts.direction ?? 'asc') === 'asc';
  const startKey = asc ? 'gte' : 'lte';
  const strict = asc ? 'gt' : 'lt';
  const { sort, id } = opts.after;
  return [
    { [opts.sortField]: { [startKey]: sort } },
    {
      OR: [
        { [opts.sortField]: { [strict]: sort } },
        { [opts.sortField]: sort, [idField]: { [strict]: id } },
      ],
    },
  ];
}

/**
 * Cut a `take: limit + 1` result down to a page and mint the next token.
 *
 * Reading one row past the page is how `hasMore` is known without a second
 * COUNT — and a COUNT over a filtered list is the query that makes a deep page
 * slow again after the keyset made it fast.
 */
export function pageOf<TRow, TItem>(
  rows: TRow[],
  limit: number,
  map: (row: TRow) => TItem,
  cursorOf: (row: TRow) => CursorScalar[],
): ListResult<TItem> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(map),
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}

/**
 * Read an `?after=` token minted by {@link pageOf}, or `null` if we did not mint
 * it.
 *
 * `null` is routine, not an error. Every 1.0 controller documents `?after=` as a
 * bare row id, because that is what it was before the keyset landed, and a
 * librarian who clicks "Load more" while a deploy swaps the format would
 * otherwise get a 400 halfway down a list. Callers fall back to reading that
 * row's sort keys by primary key — one indexed lookup, and only for a token we
 * did not mint.
 *
 * The arity check is what stops a cursor from one list being destructured into
 * another list's columns: a bib token pasted into the patrons URL is rejected
 * here and restarts at page one, rather than resuming at a nonsense position.
 */
export function readKeysetCursor(
  token: string | undefined,
  opts: { sortIsDate?: boolean } = {},
): KeysetBoundary | null {
  const parts = decodeCursor(token, 2);
  if (!parts) return null;
  const [sort, id] = parts;
  if (typeof id !== 'string') return null;
  if (opts.sortIsDate) {
    if (typeof sort !== 'string') return null;
    const at = new Date(sort);
    // An unparseable date would reach Prisma as `Invalid Date` and render as
    // NULL in the predicate, which silently matches nothing — an empty list
    // rather than a rejected cursor.
    return Number.isNaN(at.getTime()) ? null : { sort: at, id };
  }
  if (typeof sort !== 'string' && typeof sort !== 'number') return null;
  return { sort, id };
}

/** Encode a boundary for the next page. Dates go as ISO so they round-trip. */
export function keysetCursorValues(sort: string | number | Date, id: string): CursorScalar[] {
  return [sort instanceof Date ? sort.toISOString() : sort, id];
}
