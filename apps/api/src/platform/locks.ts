/**
 * Advisory locks, taken in ONE order.
 *
 * ## What this is for, and what it is not
 *
 * A transaction-scoped advisory lock gives MUTUAL EXCLUSION across a
 * multi-statement transaction: it is held by the transaction, released at
 * COMMIT, ROLLBACK or disconnect, and — unlike a session-scoped
 * `pg_advisory_lock` — it is safe behind pgbouncer's transaction pooling. There
 * is no session-scoped form anywhere in this repository, deliberately.
 *
 * It does NOT detect staleness. A caller that takes a lock, reads a row, and
 * writes it back has serialised two writers and lost nothing — but a caller that
 * READ the row before taking the lock has protected nothing at all. Measured, on
 * the real tables, two writers doing read → compare-in-JS → lock → write:
 * both commit, at two-way and at twenty-five-way alike. Optimistic concurrency
 * is a separate mechanism (a compare-and-swap on the row); see
 * `BibWriteService`. Do not let these two share a name in the code.
 *
 * ## Why the ORDER is the whole point
 *
 * Two transactions taking the same two locks in opposite orders deadlock. That
 * is not hypothetical here: measured, two writers touching
 * `marc_record_contents` and `marc_records` in opposite orders inside one
 * transaction produced `40P01 deadlock detected`. Postgres resolves it by
 * killing one, which surfaces to a librarian as a failed save with no
 * explanation.
 *
 * The fix is a TOTAL ORDER that every caller obeys without having to think:
 * sort by domain rank first, then by id. The ranks are the ones the master
 * architecture fixes for phase 16 — patron < bib < item — and they are not
 * configurable, because the value of a total order is that it is the same one
 * everywhere.
 *
 * ## Why this exists in phase 10 rather than phase 16
 *
 * §6 phase 16 owns this file by name, together with "a CI grep forbidding a bare
 * `pg_advisory_xact_lock` outside it". Phase 10 needs one lock, and writing it
 * by hand would add a 26th hand-rolled call site to a pile phase 16 then has to
 * find and rewrite.
 *
 * So the helper lands now and the GATE does not. There are 25 bare call sites in
 * 1.0 services today, and a gate shipped with 25 allowlist entries pointing at
 * code the phase-20 cutover deletes is a gate that checks nothing while looking
 * like coverage. Phase 16 migrates the 1.0 call sites it keeps and lands the
 * grep against a tree where it can be clean. Until then this file is the
 * convention for NEW code, enforced by review rather than by CI — which is
 * stated here rather than implied.
 */

/**
 * The domains a lock key can name, in acquisition order.
 *
 * Rank, not alphabetical: a patron lock is always taken before a bib lock, which
 * is always taken before an item lock. Adding a domain means deciding where it
 * sits relative to these three, which is a real design question and should look
 * like one.
 */
export const LOCK_DOMAIN_RANK = {
  patron: 1,
  bib: 2,
  item: 3,
} as const;

export type LockDomain = keyof typeof LOCK_DOMAIN_RANK;

/** One thing to be locked. */
export type LockKey = {
  readonly domain: LockDomain;
  readonly id: string;
};

export function lockKey(domain: LockDomain, id: string): LockKey {
  return { domain, id };
}

/**
 * The string hashed into the advisory-lock space.
 *
 * `<domain>:<id>`, matching the idiom the 1.0 services already use
 * (`member:<id>`, `book:<id>`), so phase 16 can migrate them by changing the
 * call rather than by invalidating every key in flight during a deploy.
 */
export function lockToken(key: LockKey): string {
  return `${key.domain}:${key.id}`;
}

/**
 * The keys, in the order they must be acquired.
 *
 * Exported separately from {@link acquireLocks} so it can be unit-tested without
 * a database — the ordering is the part that is easy to get wrong and cheap to
 * check. Duplicates are collapsed: taking the same lock twice in one transaction
 * is harmless in Postgres but is a sign the caller has lost track of what it
 * holds.
 */
export function orderLocks(keys: readonly LockKey[]): LockKey[] {
  const seen = new Set<string>();
  const unique: LockKey[] = [];
  for (const key of keys) {
    const token = lockToken(key);
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(key);
  }
  return unique.sort(
    (a, b) =>
      LOCK_DOMAIN_RANK[a.domain] - LOCK_DOMAIN_RANK[b.domain] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The minimum of a Prisma transaction client this module needs. */
export type RawExecutor = {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

/**
 * Take every lock, in order, inside the caller's transaction.
 *
 * MUST be the first statement of the transaction, before any read. That is not
 * a style preference: measured, taking the lock AFTER the read gives exactly the
 * protection of no lock at all, because both readers complete before either lock
 * is requested. It is also the natural left-to-right reading of "advisory lock →
 * hash precondition", which is why it is written down here.
 *
 * `hashtextextended(text, 0)` rather than a hand-assigned integer: the key space
 * is 2^64 and the names are readable in `pg_locks` via the query text, whereas a
 * table of magic numbers is a second thing to keep in step.
 */
export async function acquireLocks(tx: RawExecutor, keys: readonly LockKey[]): Promise<void> {
  for (const key of orderLocks(keys)) {
    await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockToken(
      key,
    )}, 0))`;
  }
}
