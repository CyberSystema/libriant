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
