import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { closeQueueGap } from './hold-queue.js';
import { canCollectAt, readPinnedHoldPolicy } from '@libriant/circ-policy';

/**
 * Who gets this copy?
 *
 * ## The eligibility filter, and why the queue is not partitioned by level
 *
 * A returned copy walks the bib's ONE queue in order and takes the first hold
 * that can actually use it. Four things disqualify a hold:
 *
 *   SUSPENDED   the reader said "not until the 3rd". They keep their position —
 *               a suspension is a reader who is not ready, not a reader who has
 *               left — and are SKIPPED. This skip is the entire reason phase 17
 *               is a separate phase from 16: it is what makes the hold that
 *               leaves the queue not the head, which is what breaks the 1.0
 *               blanket decrement.
 *   WRONG LEVEL an `item` hold wants one specific copy; a `volume` hold wants
 *               one enumeration; a `title` hold takes anything.
 *   INELIGIBLE  the copy cannot legally travel to the reader's pickup branch.
 *   PICKUP      the phase-13 policy says the copy may not go where they asked.
 *
 * The acceptance criterion is built out of exactly two of these — "five mixed
 * holds (one suspended, one with an ineligible pickup branch) fill exactly
 * three" — and it counts to five, which is why the five share one queue.
 *
 * ## `FOR UPDATE SKIP LOCKED` is NOT used here, and that is deliberate
 *
 * It is the obvious tool for "three workers, one queue, no double-take", and it
 * would give the wrong answer: skipping a LOCKED row is not skipping an
 * INELIGIBLE one, so under contention worker B would hand copy 2 to position 3
 * while worker A was still deciding about position 2 — and the queue would be
 * served out of order, silently, only under load. Serialising the whole queue on
 * `lockKey('bib', bibId)` costs the three concurrent returns of one title a few
 * milliseconds each and gives every one of them the same queue to read.
 *
 * ## Every caller already holds the bib lock
 *
 * This function does not take it, because it cannot: it runs inside a checkin
 * transaction that must have taken `patron`, `bib` and `item` together, sorted,
 * as its first statement. Taking `bib` here would be taking it after the
 * caller's reads, which `platform/locks.ts` measured to be exactly the
 * protection of no lock at all.
 */
export type PromotionCandidate = {
  readonly id: string;
  readonly patronId: string;
  readonly queuePosition: number;
  readonly pickupBranchId: string;
  readonly level: string;
  readonly itemId: string | null;
  readonly volume: string | null;
  /** The reader's own home branch, for `pickupPolicy: 'patronHomeBranch'`. */
  readonly patronHomeBranchId: string | null;
  readonly policySnapshot: unknown;
};

export type PromotionOutcome =
  | {
      readonly kind: 'assigned';
      readonly holdId: string;
      readonly patronId: string;
      readonly pickupBranchId: string;
      readonly vacated: number;
      /**
       * From the winner's FROZEN policy, for the transfer this may open.
       *
       * Carried out of here rather than re-read by the caller, because the
       * caller has the COPY and not the request: `settlePromotion` would
       * otherwise have to load a policy snapshot to answer "when should this van
       * have arrived", and a transfer with no `expected_by` is one the
       * transit-timeout job can never see — its whole predicate turns on that
       * column being set.
       */
      readonly maxTransitDays: number | null;
    }
  | { readonly kind: 'nobody' };

/**
 * Assign this copy to the first hold that can use it, or report that nobody can.
 *
 * Returns WITHOUT touching the item's status. The caller owns that: phase 15's
 * `ItemStatusService` is the single writer of `items.status`, the checkin
 * transaction already has one `applyWithin` call in it, and the phase-16 budget
 * test asserts `item_status_history` gains exactly one row per checkin ("a
 * fourth means the copy transitioned twice"). So promotion decides and the
 * caller transitions, once, with the final answer.
 */
export async function promoteForItem(
  tx: TxV2,
  input: {
    readonly bibId: string;
    readonly itemId: string;
    readonly itemVolume: string | null;
    /** Where the copy IS. `holdingBranch` pickup, and the transit decision. */
    readonly itemCurrentBranchId: string;
    /** Where the copy LIVES. `owningBranch` pickup. Phase 15 made these two
     *  deliberately different for the whole of a transit. */
    readonly itemOwningBranchId: string;
    readonly now: Date;
    /** Civil today in the branch's zone, for the suspension window. */
    readonly today: string;
  },
): Promise<PromotionOutcome> {
  // The queue, in order, with the ineligible already filtered out in SQL — a
  // hold that cannot use THIS copy is not a candidate, and reading the whole
  // queue into Node to filter it there would make the scan grow with the
  // popularity of the title.
  //
  // `priority DESC, queue_position ASC` is the order the queue IS in: a
  // librarian's override changes the ORDER without renumbering anybody, which is
  // what keeps contiguity a property of one column rather than of every
  // mutation that touches the queue.
  const candidates = await tx.$queryRaw<PromotionCandidate[]>`
    SELECT h.id,
           h.patron_id        AS "patronId",
           h.queue_position   AS "queuePosition",
           h.pickup_branch_id AS "pickupBranchId",
           h.level::text      AS level,
           h.item_id          AS "itemId",
           h.volume,
           p.home_branch_id   AS "patronHomeBranchId",
           h.policy_snapshot  AS "policySnapshot"
      FROM holds h
      JOIN patrons p ON p.id = h.patron_id
     WHERE h.bib_id = ${input.bibId}
       AND h.queue_position IS NOT NULL
       AND h.fulfilled_at IS NULL AND h.cancelled_at IS NULL AND h.expired_at IS NULL
       -- SUSPENDED holds keep their place and are skipped. Civil dates, because
       -- "back on the 3rd" is true in every zone and an instant makes it true at
       -- 02:00 in one and 23:00 in another.
       AND (h.suspended_until IS NULL OR h.suspended_until < ${input.today}::date)
       -- The level filter. A title hold takes anything; a volume hold takes this
       -- enumeration; an item hold takes exactly this copy.
       AND (h.level = 'title'
            OR (h.level = 'item' AND h.item_id = ${input.itemId})
            OR (h.level = 'volume' AND h.volume IS NOT DISTINCT FROM ${input.itemVolume}))
     ORDER BY h.priority DESC, h.queue_position ASC
     LIMIT 50`;

  // THE PICKUP FILTER, which cannot be SQL.
  //
  // Eligibility depends on each hold's OWN pinned policy — a jsonb column — and
  // on three branches that are not all on the hold row. Filtering it in SQL
  // would mean either re-resolving the policy per row (which would also undo the
  // freezing §3 requires) or reaching into jsonb with a predicate no index can
  // serve. Walking the candidates in queue order and taking the first that
  // passes is O(the queue) in the worst case and O(1) in every real one, because
  // the reader at the front is almost always eligible.
  //
  // This is the second half of the acceptance criterion's "five mixed holds (one
  // suspended, ONE WITH AN INELIGIBLE PICKUP BRANCH)": the suspended hold is
  // skipped by the SQL above, this one is skipped here, and both keep their
  // positions.
  let winner: PromotionCandidate | undefined;
  let winnerMaxTransitDays: number | null = null;
  for (const candidate of candidates) {
    const pinned = readPinnedHoldPolicy(candidate.id, candidate.policySnapshot);
    const verdict = canCollectAt({
      policy: pinned.hold,
      explicitPickupBranchIds: pinned.pickupBranchIds,
      wantedBranchId: candidate.pickupBranchId,
      itemOwningBranchId: input.itemOwningBranchId,
      itemCurrentBranchId: input.itemCurrentBranchId,
      patronHomeBranchId: candidate.patronHomeBranchId,
    });
    if (verdict.ok) {
      winner = candidate;
      winnerMaxTransitDays = pinned.hold.maxTransitDays;
      break;
    }
  }
  if (winner === undefined) return { kind: 'nobody' };

  // Leaving the queue and taking the copy are ONE statement, and the condition
  // re-checks every fact the read above relied on. Under the bib lock nothing
  // can have changed — but the lock is an agreement between callers, and the
  // WHERE is an agreement with the database, which is the one that holds when a
  // future caller forgets.
  const claimed = await tx.$executeRaw`
    UPDATE holds
       SET assigned_item_id = ${input.itemId},
           assigned_at      = ${input.now},
           queue_position   = NULL,
           updated_at       = ${input.now}
     WHERE id = ${winner.id}
       AND queue_position = ${winner.queuePosition}
       AND assigned_item_id IS NULL
       AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`;
  if (claimed === 0) return { kind: 'nobody' };

  // THE TARGETED REBALANCE. `winner.queuePosition`, never 0 and never assumed to
  // be 1 — see `hold-queue.ts` for the arithmetic and the constraint that turns
  // the blanket form into a `23514`.
  await closeQueueGap(tx, input.bibId, winner.queuePosition, input.now);

  return {
    kind: 'assigned',
    holdId: winner.id,
    patronId: winner.patronId,
    pickupBranchId: winner.pickupBranchId,
    vacated: winner.queuePosition,
    maxTransitDays: winnerMaxTransitDays,
  };
}
