/**
 * Safe parsers for numeric query-string params.
 *
 * Raw query params are strings (or arrays). `Number.parseInt('abc')` is
 * `NaN`, and `NaN` slips through `?? default` and `Math.min/Math.max`
 * unchanged — which previously reached Prisma as `take: NaN` /
 * `where: { gte: NaN }` and surfaced as an HTTP 500. These helpers collapse
 * any non-finite / out-of-range input to `undefined` so callers fall back
 * to their defaults instead of crashing.
 */

/** A positive integer, or `undefined` for missing/blank/non-numeric/≤0 input. */
export function parseLimit(raw?: string): number | undefined {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A finite integer, or `undefined` for missing/blank/non-numeric input. */
export function parseIntParam(raw?: string): number | undefined {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Opaque keyset-pagination cursor: the SORT KEYS of the last row on a page,
 * packed into one token the client hands straight back.
 *
 * performance-03 / performance-10. Every list in the product paged with
 * Prisma's `cursor: { id: after }, skip: 1`, and Prisma renders that as an
 * OR of correlated subselects — `(sortTitle = (SELECT sortTitle FROM books
 * WHERE id = $1) AND id >= (SELECT …)) OR (sortTitle > (SELECT …))`. Postgres
 * cannot turn that into a btree start key, so it walks the index from the
 * beginning of the range and throws away every row before the cursor. Measured
 * on a 400,000-title catalogue: page 1 of the books list is 0.87 ms, the page
 * at depth 200,000 is 106.90 ms, and `Rows Removed by Filter: 200001`.
 *
 * The fix is not a cleverer cursor — it is giving the planner a START KEY it
 * can seek to, which means the caller must know the last row's sort values and
 * not just its id. Hence a token: the id alone cannot produce `sortTitle >= …`
 * without the subselect that caused the problem.
 *
 * Opaque on purpose. `DataTable.loadMore()` (apps/web/components/DataTable.tsx)
 * treats `nextCursor` as a value to echo back, never to construct, so widening
 * it from an id to a tuple needs no client change — and keeping it unreadable
 * stops the next caller from building one by hand and pinning the format.
 *
 * NOT signed or encrypted. A tampered cursor can only move a reader to a
 * different page of a list they are already authorised to read; it selects a
 * position, never a scope. Every list still applies its own tenant `where`.
 */
export function encodeCursor(values: readonly (string | number | null)[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/**
 * Unpack a token produced by {@link encodeCursor}, or `null` when it did not
 * come from us.
 *
 * `null` is a routine answer, not an error: before this change `after` WAS a
 * bare row id, the controllers document it as `?after=`, and a librarian who
 * clicks "Load more" while a deploy swaps the format would otherwise get a
 * 400 mid-scroll. Callers fall back to reading the row's sort keys by id —
 * one primary-key lookup, and only for a cursor we did not mint.
 *
 * `arity` is checked so a token from a DIFFERENT list (a books cursor pasted
 * into the reservations URL) is rejected here rather than silently destructured
 * into the wrong columns.
 */
export function decodeCursor(
  token: string | undefined,
  arity: number,
): (string | number | null)[] | null {
  if (!token) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== arity) return null;
  if (!parsed.every((v) => v === null || typeof v === 'string' || typeof v === 'number')) {
    return null;
  }
  return parsed as (string | number | null)[];
}
