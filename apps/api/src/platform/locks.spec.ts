import { describe, expect, it, vi } from 'vitest';
import { acquireLocks, lockKey, lockToken, orderLocks, LOCK_DOMAIN_RANK } from './locks.js';

/**
 * The ordering is the entire content of this module, so it is what gets tested.
 *
 * A deadlock is the failure it prevents, and a deadlock is not reproducible in a
 * unit test — Postgres kills one of the two transactions and which one is
 * timing. So the test is on the property that makes deadlock impossible: any two
 * callers asking for the same set of locks, in any order, issue them in the SAME
 * order.
 */
describe('advisory lock ordering', () => {
  it('sorts by domain rank, not alphabetically', () => {
    // Alphabetically this is bib, item, patron. By rank it is patron, bib, item.
    // A helper that sorted the obvious way would look correct and reverse two of
    // the three pairs.
    const ordered = orderLocks([
      lockKey('item', 'i1'),
      lockKey('bib', 'b1'),
      lockKey('patron', 'p1'),
    ]);
    expect(ordered.map(lockToken)).toEqual(['patron:p1', 'bib:b1', 'item:i1']);
    expect(LOCK_DOMAIN_RANK.patron).toBeLessThan(LOCK_DOMAIN_RANK.bib);
    expect(LOCK_DOMAIN_RANK.bib).toBeLessThan(LOCK_DOMAIN_RANK.item);
  });

  it('gives the same order whatever order the caller asked in', () => {
    // THE property. Two transactions that permute the same set must not be able
    // to disagree, because that disagreement IS the deadlock.
    const keys = [
      lockKey('item', 'i2'),
      lockKey('patron', 'p9'),
      lockKey('bib', 'b3'),
      lockKey('item', 'i1'),
    ];
    const canonical = orderLocks(keys).map(lockToken);
    const permutations = [
      [keys[3]!, keys[2]!, keys[1]!, keys[0]!],
      [keys[1]!, keys[3]!, keys[0]!, keys[2]!],
      [keys[2]!, keys[0]!, keys[3]!, keys[1]!],
    ];
    for (const p of permutations) {
      expect(orderLocks(p).map(lockToken)).toEqual(canonical);
    }
    // And within a domain the tiebreak is the id, so the order is TOTAL rather
    // than merely grouped — two item locks in one transaction would otherwise
    // still be free to swap.
    expect(canonical).toEqual(['patron:p9', 'bib:b3', 'item:i1', 'item:i2']);
  });

  it('collapses a duplicate rather than taking it twice', () => {
    const ordered = orderLocks([lockKey('bib', 'b1'), lockKey('bib', 'b1')]);
    expect(ordered).toHaveLength(1);
  });

  it('issues ONE statement, carrying the keys in the sorted order', async () => {
    // Phase 16 merged the per-key loop into a single `FROM unnest($1::text[])`,
    // because a checkin is budgeted at twelve statements and two locks were two
    // of them. The array is what carries the order now, and a Function Scan
    // produces its rows in array order — which is why it is `FROM unnest(...)`
    // and NOT two calls in a SELECT target list, whose evaluation order is
    // unspecified. Trading the ordering guarantee to save a round trip would be
    // trading away the entire point of this module.
    const batches: unknown[][] = [];
    const tx = {
      $executeRaw: vi.fn(async (_q: TemplateStringsArray, ...values: unknown[]) => {
        batches.push(values);
        return 1;
      }),
    };
    await acquireLocks(tx, [lockKey('item', 'i1'), lockKey('patron', 'p1')]);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]).toEqual(['patron:p1', 'item:i1']);
  });

  it('issues NOTHING when there is nothing to lock', async () => {
    // A checkin whose loan has already been anonymised has no patron key, and
    // `unnest` of an empty array would take no lock and still cost a round trip
    // in a transaction that is counting them.
    const tx = { $executeRaw: vi.fn(async () => 1) };
    await acquireLocks(tx, []);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('ranks `policy` first, and the argument is simultaneity', () => {
    // Added in phase 16 for `PolicyWriteService`, which was taking the key by
    // hand. It sorts FIRST because a tenant-wide configuration key is derivable
    // before any read, so every path that wants one wants it as its first
    // statement and only afterwards discovers which patron or item it touches.
    // The reverse derivation does not exist: there is no "look up the item, then
    // lock its policy".
    expect(LOCK_DOMAIN_RANK.policy).toBeLessThan(LOCK_DOMAIN_RANK.patron);
    expect(orderLocks([lockKey('item', 'i'), lockKey('policy', 't')]).map(lockToken)).toEqual([
      'policy:t',
      'item:i',
    ]);
  });

  it('uses the same token shape the 1.0 services already use', () => {
    // `member:<id>` / `book:<id>` are the existing idiom. Keeping `<domain>:<id>`
    // means phase 16 migrates a call site by changing the call, not by
    // invalidating every key in flight during a rolling deploy.
    expect(lockToken(lockKey('bib', 'abc'))).toBe('bib:abc');
  });
});
