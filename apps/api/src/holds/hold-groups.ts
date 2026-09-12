import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { closeQueueGap } from './hold-queue.js';

/**
 * "Zorba, any edition." — and what happens when one of them arrives.
 *
 * ## A GROUP IS A CANCELLATION RULE, NOT A QUEUE
 *
 * `47-holds.prisma` settles the shape: each member hold sits in its OWN bib's
 * queue at its own position and is promoted independently; the group only says
 * what happens when one of them wins. There is no `hold_groups.queue_position`
 * and no group lock domain, because a promotion still serialises on ONE bib and
 * the sibling cancellation is an ordinary targeted rebalance in each of the
 * others.
 *
 * In a Greek public library this is most requests for a classic: the catalogue
 * holds four Καζαντζάκης printings under four bibliographic records, and a
 * reader who wants the book does not care which one they are handed.
 *
 * ## SIBLINGS ARE CANCELLED AT FULFILMENT, NOT AT ASSIGNMENT
 *
 * A copy being put on the shelf is not the reader having the book. If the
 * siblings were cancelled when one edition was assigned, a reader who never came
 * in would lose their place in three other queues to a copy they never touched —
 * and the shelf-expiry sweep would then have nothing to put them back into.
 * `hold_groups.resolved_at` says "stamped when a member was FILLED", and this is
 * the code that stamps it.
 *
 * ## EVERY SIBLING'S BIB MUST ALREADY BE LOCKED
 *
 * Cancelling a queued sibling moves every position behind it in ANOTHER bib's
 * queue. `platform/locks.ts` is explicit that discovering a lock you need after
 * you have read is the protection of no lock at all, so the caller probes the
 * sibling bibs outside its transaction and passes every one of them to its
 * single sorted `acquireLocks` call — bib keys are all rank 2 and sort among
 * themselves by id, so the total order survives however many there are.
 *
 * This function does not take the locks and cannot: it runs inside a checkout
 * transaction whose first statement already took them. What it does instead is
 * REFUSE when the set it is asked to touch is not the set the caller locked,
 * which is step three of probe-lock-re-verify — a sibling added between the
 * probe and the locks is a world that moved, and the desk retries.
 */
export class HoldGroupRaced extends Error {
  constructor(readonly keys: readonly string[]) {
    super(
      `A hold in this group changed on ${keys.join(', ')} while the desk was working, so its ` +
        'queue or its copy was not locked. Scan the book again.',
    );
    this.name = 'HoldGroupRaced';
  }
}

/** A sibling that was cancelled, and the copy it was holding, if any. */
export type CancelledSibling = {
  readonly holdId: string;
  readonly assignedItemId: string | null;
};

/**
 * Every bib a group's open holds sit in, and every copy already set aside for
 * one. The caller locks all of them.
 *
 * BOTH lists, because cancelling a sibling does two things that need two
 * different locks: it moves every position behind it in ANOTHER bib's queue, and
 * it can free a copy that is sitting on a hold shelf with a name on it. The
 * second is the one that is easy to miss — a group whose second edition arrived
 * first leaves that copy stranded for ever if the cancellation does not release
 * it, and no constraint can see the mismatch because `items.status` and `holds`
 * are two tables.
 */
export async function groupLockTargets(
  tx: TxV2,
  groupId: string,
): Promise<{ bibIds: string[]; itemIds: string[] }> {
  const rows = await tx.$queryRaw<{ bib_id: string; assigned_item_id: string | null }[]>`
    SELECT bib_id, assigned_item_id
      FROM holds
     WHERE group_id = ${groupId}
       AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL
     ORDER BY bib_id`;
  return {
    bibIds: [...new Set(rows.map((r) => r.bib_id))],
    itemIds: [
      ...new Set(rows.map((r) => r.assigned_item_id).filter((i): i is string => i !== null)),
    ],
  };
}

/**
 * One member was filled: close the group and cancel the rest.
 *
 * Returns the ids of the holds it cancelled, so a caller can tell the reader
 * what it did rather than leave three requests quietly vanishing from their
 * account.
 */
export async function resolveGroupOnFulfilment(
  tx: TxV2,
  input: {
    readonly groupId: string;
    readonly winningHoldId: string;
    readonly now: Date;
    /** Every bib the caller holds a lock on. */
    readonly lockedBibIds: readonly string[];
    /** Every copy the caller holds a lock on. */
    readonly lockedItemIds: readonly string[];
  },
): Promise<CancelledSibling[]> {
  const siblings = await tx.$queryRaw<
    {
      id: string;
      bib_id: string;
      queue_position: number | null;
      assigned_item_id: string | null;
    }[]
  >`
    SELECT id, bib_id, queue_position, assigned_item_id
      FROM holds
     WHERE group_id = ${input.groupId}
       AND id <> ${input.winningHoldId}
       AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL
     ORDER BY id`;

  const unlocked = [
    ...new Set(siblings.map((s) => s.bib_id)),
    ...new Set(siblings.map((s) => s.assigned_item_id).filter((i): i is string => i !== null)),
  ].filter((k) => !input.lockedBibIds.includes(k) && !input.lockedItemIds.includes(k));
  if (unlocked.length > 0) throw new HoldGroupRaced(unlocked);

  const cancelled: CancelledSibling[] = [];
  for (const sibling of siblings) {
    // The cancellation and the departure from the queue are ONE statement, and
    // the condition re-checks every fact the read relied on — the lock is an
    // agreement between callers and the WHERE is an agreement with the database,
    // which is the one that holds when a future caller forgets.
    const done = await tx.$executeRaw`
      UPDATE holds
         SET cancelled_at     = ${input.now},
             cancelled_reason = ${`Another edition in this group was collected (hold ${input.winningHoldId}).`},
             queue_position   = NULL,
             updated_at       = ${input.now}
       WHERE id = ${sibling.id}
         AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`;
    if (done === 0) continue;
    // The copy travels back to the CALLER, which owns the single status write
    // per copy — see `hold-release.ts` on why the transition is not made here.
    cancelled.push({ holdId: sibling.id, assignedItemId: sibling.assigned_item_id });
    // Only a WAITING sibling left a gap. One that had already been assigned a
    // copy had no position to give back.
    if (sibling.queue_position !== null) {
      await closeQueueGap(tx, sibling.bib_id, sibling.queue_position, input.now);
    }
  }

  await tx.$executeRaw`
    UPDATE hold_groups
       SET resolved_at = ${input.now},
           resolved_by_hold_id = ${input.winningHoldId},
           updated_at = ${input.now}
     WHERE id = ${input.groupId} AND resolved_at IS NULL`;

  return cancelled;
}
