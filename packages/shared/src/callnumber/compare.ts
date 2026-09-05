/**
 * Comparing call numbers, and reading a shelf back.
 *
 * Everything here goes through {@link callNumberSortKey}, so a comparison in
 * the browser, in the API, in an `ORDER BY call_number_sort` and — later — in
 * the desktop client's Rust core all give the same answer. There is no second
 * comparison path, deliberately: a bespoke `compare` that "just handles Dewey"
 * is how a shelf list and an inventory session end up disagreeing about which
 * book is out of place.
 */

import { callNumberSortKey, type CallNumberParts, type CallNumberScheme } from './normalize.js';

/** Shelf order. Negative if `a` files before `b`. */
export function compareCallNumbers(
  scheme: CallNumberScheme,
  a: string | CallNumberParts,
  b: string | CallNumberParts,
): number {
  const ka = callNumberSortKey(scheme, a);
  const kb = callNumberSortKey(scheme, b);
  // Plain `<` is correct BECAUSE the key alphabet is `[0-9A-Z]`; see
  // `normalize.ts` for the measurement that establishes it. Never
  // `localeCompare` here — that reintroduces the collation dependency the key
  // exists to remove.
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export interface ShelfOrderIssue<T> {
  /** The item that is out of order relative to the one before it. */
  readonly item: T;
  /** The item it should have followed. */
  readonly previous: T;
  readonly index: number;
}

/**
 * Walk a sequence of items in the order they were scanned off the shelf and
 * report every point where the physical order departs from the call-number
 * order.
 *
 * This is the whole of shelf-order verification, and it is here rather than in
 * the inventory service because the offline wand has to run it with no server:
 * a librarian walking the stacks scans a run of barcodes, and the device must
 * say "these two are swapped" before they leave the aisle.
 */
export function findShelfOrderIssues<T>(
  scheme: CallNumberScheme,
  items: readonly T[],
  keyOf: (item: T) => string | CallNumberParts,
): ShelfOrderIssue<T>[] {
  const issues: ShelfOrderIssue<T>[] = [];
  for (let i = 1; i < items.length; i += 1) {
    const previous = items[i - 1] as T;
    const item = items[i] as T;
    if (compareCallNumbers(scheme, keyOf(previous), keyOf(item)) > 0) {
      issues.push({ item, previous, index: i });
    }
  }
  return issues;
}
