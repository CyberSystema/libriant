import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

/**
 * The queue: allocating a position, and giving one back.
 *
 * ## ONE implementation, because 1.0 proved what two do
 *
 * The blanket `> 0` decrement §3 names is in THREE files in 1.0 —
 * `reservations.service.ts`'s promoter, `reservation-expiry.job.ts` and
 * `loans.service.ts`'s return path — and it got there by exactly the reasoning
 * that looks sensible at the time: the worker could not take the Nest graph, so
 * the job re-implemented the rebalance, and the return path copied it again to
 * avoid a circular module dependency. `circ-4` then had to fix the same
 * rebalance in each of them separately.
 *
 * So these are PLAIN FUNCTIONS that take a transaction. The service calls them,
 * both jobs call them, and there is one place to be wrong.
 *
 * ## The targeted rebalance, which is the whole phase
 *
 * §3: "a TARGETED queue rebalance (`WHERE queue_position > <vacated>`). The 1.0
 * blanket `> 0` decrement is correct only because the head always leaves; with
 * suspended holds being skipped it corrupts positions."
 *
 * Concretely, five holds with #1 suspended and #2 filled:
 *
 * ```
 *   targeted  WHERE queue_position > 2  ->  1(susp), 2, 3, 4   correct
 *   blanket   WHERE queue_position > 0  ->  0(susp), 2, 3, 4   position 0
 * ```
 *
 * And under `holds_position_is_one_based` the second does not quietly produce a
 * position 0 — it aborts with `23514`. The constraint is what turns the
 * regression test from "assert a multiset" into "assert a SQLSTATE", which a
 * subtly different wrong implementation cannot satisfy by accident.
 */

/**
 * The next free slot at the back of a bib's queue.
 *
 * `max(queue_position) + 1` is a READ-THEN-WRITE and it is only safe because
 * every caller holds `lockKey('bib', bibId)` — which `HoldsService` and the
 * promoter both take as the first statement of their transactions. There is no
 * `ON CONFLICT` alternative here and the migration says why: an arbiter must
 * name the index's columns, and an upsert that wanted "the next position" would
 * have to know the position before it could name it.
 *
 * `COALESCE(max(...), 0) + 1` so an empty queue starts at 1, which is the
 * 1-based half of the invariant.
 */
export async function nextQueuePosition(tx: TxV2, bibId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ next: number }[]>`
    SELECT (COALESCE(pg_catalog.max(queue_position), 0) + 1)::int AS next
      FROM holds
     WHERE bib_id = ${bibId} AND queue_position IS NOT NULL`;
  return rows[0]?.next ?? 1;
}

/**
 * Close the gap a departing hold left.
 *
 * `vacated` is the position the hold ACTUALLY held — never 0, never assumed to
 * be 1. That single argument is the difference between this function and the
 * three copies of the 1.0 form, and the reason the phase exists separately from
 * 16: once a suspended hold can be skipped, the hold that leaves is not the
 * head.
 *
 * Returns how many rows moved, so a caller can assert it rather than trust it.
 */
export async function closeQueueGap(
  tx: TxV2,
  bibId: string,
  vacated: number,
  now: Date,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE holds
       SET queue_position = queue_position - 1, updated_at = ${now}
     WHERE bib_id = ${bibId}
       AND queue_position IS NOT NULL
       AND queue_position > ${vacated}`;
}

/**
 * Is this queue contiguous and 1-based?
 *
 * Aggregate properties no CHECK can reach — a constraint sees one row — so they
 * are asserted here, by the named regression test and by the hold-expiry sweep,
 * which is the only code that looks at a whole queue on a schedule.
 *
 * A sweep that REPORTS rather than repairs, on §8 risk 7's rule for the ledger
 * reconciliation: "alerts rather than self-heals (self-healing hides the bug
 * that caused the drift)". A queue that silently renumbers itself every night is
 * a queue whose promotion bug nobody ever sees.
 */
export async function queueIntegrity(
  tx: TxV2,
  bibId: string,
): Promise<{ ok: boolean; positions: number[] }> {
  const rows = await tx.$queryRaw<{ queue_position: number }[]>`
    SELECT queue_position
      FROM holds
     WHERE bib_id = ${bibId} AND queue_position IS NOT NULL
     ORDER BY queue_position`;
  const positions = rows.map((r) => r.queue_position);
  const ok = positions.every((p, i) => p === i + 1);
  return { ok, positions };
}
