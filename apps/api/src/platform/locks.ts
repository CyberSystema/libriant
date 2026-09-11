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
 * ## The gate landed in phase 16, and the shape it took
 *
 * §6 phase 16 owns this file by name, together with "a CI grep forbidding a bare
 * `pg_advisory_xact_lock` outside it". Phase 10 wrote the helper and deferred
 * the gate, on the argument that "a gate shipped with 25 allowlist entries
 * pointing at code the phase-20 cutover deletes is a gate that checks nothing
 * while looking like coverage".
 *
 * Phase 16 found NINETEEN bare call sites, and the deferral turned out to be
 * right for a reason phase 10 could not see: they fall into three groups, not
 * one.
 *
 *   NINE are in `apps/api/src/{loans,reservations,members}` plus one scheduled
 *   job, and phase 20 deletes all of them. They are allowlisted by DIRECTORY
 *   with that citation — and because an allowlist entry that stops matching
 *   FAILS, phase 20 is forced to delete the entries in the same commit that
 *   deletes the code.
 *
 *   NINE are CONTROL-PLANE locks — billing, import staging, quota, staff seats.
 *   They live in a different Postgres database and can never contend with a
 *   tenant lock, which is why their domains are deliberately absent from
 *   `LOCK_DOMAIN_RANK` below rather than ranked against `patron`.
 *
 *   ONE was in the 2.0 tree: `PolicyWriteService.seedDefaults`. It is now a
 *   `policy` domain and goes through `acquireLocks`.
 *
 * So the gate guards the tenant plane with zero exemptions ON that plane, which
 * is the only state in which a gate is worth having. `check:advisory-locks`
 * reads `.sql` too, because a migration can take a lock and ESLint cannot read
 * SQL — the complementary-blindness argument `check:item-status-writer` makes,
 * in the other direction.
 */

/**
 * The domains a lock key can name, in acquisition order.
 *
 * Rank, not alphabetical: a patron lock is always taken before a bib lock, which
 * is always taken before an item lock. Adding a domain means deciding where it
 * sits relative to these three, which is a real design question and should look
 * like one.
 *
 * ## `policy` is rank 0, and the argument is SIMULTANEITY
 *
 * Phase 16 added it, for the one 2.0 call site that was taking a bare lock —
 * `PolicyWriteService.seedDefaults`, on `policy:<tenantId>`, which was already
 * spelling the key this file's way and hashing it this file's way "so the two
 * can never collide by accident". It was a `LockDomain` in everything but the
 * type.
 *
 * It sorts FIRST because the ordering a rank encodes is which lock a transaction
 * can discover it needs while already holding another. `policy:<tenantId>` is
 * derivable from the tenant alone — known before any read — so every path that
 * wants it wants it as its first statement and only afterwards discovers which
 * patron, bib or item it will touch. The reverse derivation does not exist and
 * cannot: there is no "look up the item, then lock its policy", because the
 * policy lock is not per-policy-row. The relation is strictly one-directional,
 * which is exactly what a rank is for.
 *
 * The pair that makes it concrete is not hypothetical: §3 gives phase 21 a
 * `POST /circulation/loans/repolicy` route that must hold the policy
 * configuration steady while it re-prices N open loans — `policy:<t>` plus N
 * patron and item keys, in one transaction, and the first transaction in this
 * codebase to hold two domains at once.
 *
 * ## What is NOT here, and why refusing is the useful part
 *
 * `billing:`, `import-staging:` and `quota:<tenant>:<feature>` are locks on the
 * CONTROL-PLANE database. They can never contend with a tenant lock because they
 * are not in the same database, so ranking them against `patron` would be
 * ranking two things that cannot meet. Leaving them out turns "these are in
 * different databases" from a fact somebody has to know into a type error, and
 * `check:advisory-locks` records them as what they are.
 */
export const LOCK_DOMAIN_RANK = {
  policy: 0,
  patron: 1,
  bib: 2,
  item: 3,
  /**
   * A cash drawer (2.0 phase 18). LAST, and the ordering is settled by which
   * paths can meet rather than by importance.
   *
   * A payment holds `patron:` (whose account the money settles) and `drawer:`
   * (which till it went into). A checkin holds `patron:`, `bib:` and `item:`,
   * and never a drawer — phase 18 charges an overdue at the desk but does not
   * take the money in the same transaction, because a fine a reader disputes
   * must not be able to abort the return of the book. So no path holds `item:`
   * and `drawer:` together today, and putting the drawer after item costs
   * nothing while keeping the rank a total order that phase 21's till-side
   * refund can extend without renumbering.
   */
  drawer: 4,
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
 * Take every lock, in order, inside the caller's transaction. ONE statement.
 *
 * MUST be the first statement of the transaction, before any read — with the one
 * exception below, which is stated here because phase 16 hit it immediately.
 * That is not a style preference: measured, taking the lock AFTER the read gives
 * exactly the protection of no lock at all, because both readers complete before
 * either lock is requested.
 *
 * ## THE PROBE EXCEPTION, and the rule that keeps it safe
 *
 * A caller sometimes cannot know its highest-ranked key until it has read
 * something. Checkin is the first instance and will not be the last: it is
 * keyed on an ITEM barcode and cannot know the PATRON until it has found the
 * loan — so the natural implementation takes `item:` and then `patron:`, which
 * is the inversion of this rank, and it deadlocks against checkout within about
 * a second. Measured on the real tables: the `item:`→`patron:` order produced 17
 * `40P01` in fifteen seconds, the first at 1,165 ms.
 *
 * The rule is PROBE, LOCK, RE-VERIFY:
 *
 *   1. read what you need to learn the key — OUTSIDE the transaction, or at
 *      least before any lock, and treat the answer as a guess;
 *   2. open the transaction and take every lock, sorted, in one call;
 *   3. re-read under the locks and check the guess still holds. If it does not,
 *      the world moved between 1 and 2 and the caller must retry rather than
 *      proceed on the stale answer.
 *
 * Step 3 is what makes step 1 safe, and skipping it is the same defect as
 * locking after the read: the guess protects nothing on its own. The branch is
 * cheap — one indexed row — and it must be exercised by a test, or it is
 * untested code on the hottest path in the building.
 *
 * ## Why one statement rather than a loop
 *
 * `FROM pg_catalog.unnest($1::text[])` over an ALREADY-SORTED array: a Function
 * Scan produces its rows in array order, so the acquisition order is the one
 * `orderLocks` decided. It saves N−1 round trips inside a transaction budgeted
 * at twelve statements.
 *
 * NOT two calls in one target list. Target-list evaluation order is unspecified,
 * and the entire value of this file is that the order is fixed — a merge that
 * gave that up to save a round trip would be trading the guarantee for the cost
 * of the guarantee.
 *
 * `hashtextextended(text, 0)` rather than a hand-assigned integer: the key space
 * is 2^64 and the names are readable in `pg_locks` via the query text, whereas a
 * table of magic numbers is a second thing to keep in step.
 */
export async function acquireLocks(tx: RawExecutor, keys: readonly LockKey[]): Promise<void> {
  const tokens = orderLocks(keys).map(lockToken);
  if (tokens.length === 0) return;
  await tx.$executeRaw`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(k, 0))
      FROM pg_catalog.unnest(${tokens}::text[]) AS k`;
}
