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

  it('issues one statement per key, in the sorted order', async () => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (_q: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(String(values[0]));
        return 1;
      }),
    };
    await acquireLocks(tx, [lockKey('item', 'i1'), lockKey('patron', 'p1')]);
    expect(calls).toEqual(['patron:p1', 'item:i1']);
  });

  it('uses the same token shape the 1.0 services already use', () => {
    // `member:<id>` / `book:<id>` are the existing idiom. Keeping `<domain>:<id>`
    // means phase 16 migrates a call site by changing the call, not by
    // invalidating every key in flight during a rolling deploy.
    expect(lockToken(lockKey('bib', 'abc'))).toBe('bib:abc');
  });
});
