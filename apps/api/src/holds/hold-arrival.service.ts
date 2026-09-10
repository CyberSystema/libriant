import { Injectable } from '@nestjs/common';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { readPinnedHoldPolicy } from './hold-pinning.js';
import { shelfExpiryFor } from './hold-shelf-expiry.js';

/**
 * "Has this copy arrived for somebody?"
 *
 * ## Why this is its own tiny module
 *
 * `ItemTransfersService` — phase 15's, in `ItemsModule` — has to ask it, because
 * a transit desk scans a barcode and does not know whether the copy in its hand
 * is a hold arrival, a float or a repair return. ONE route has to answer for all
 * three.
 *
 * But `HoldsModule` depends on `ItemsModule` (it needs `ItemStatusService` and
 * `ItemTransfersService`), so `ItemsModule` cannot depend on `HoldsModule`
 * without a `forwardRef` cycle. The way out is that the question is much smaller
 * than the answer: deciding whether a hold wants this copy needs only the
 * caller's transaction, so it lives in a module that imports nothing and both
 * sides import IT.
 *
 * ## It DECIDES, and the caller acts
 *
 * `claimOnArrival` stamps the hold and returns what the copy's status should
 * become. It does NOT call `ItemStatusService` — phase 15 made that the single
 * writer of `items.status`, the receipt transaction already has exactly one
 * `applyWithin` call in it, and a second would put a second row in
 * `item_status_history` for one physical act. Which is also what makes the
 * routed-hold criterion provable: between the send row (`available →
 * in_transit`) and the shelving row (`in_transit → awaiting_pickup`) there is NO
 * row at all, so the copy was never momentarily `available` at the pickup
 * branch, and "reaches `awaiting_pickup` only on transit receipt" is a fact
 * about an append-only table rather than about timing.
 */
@Injectable()
export class HoldArrivalService {
  /**
   * Mark the hold this copy was sent for as collectable, if there is one.
   *
   * Returns `null` when the copy arrived for nobody — a float, a rebalancing
   * move, a repair return — in which case the caller shelves it `available` as
   * before.
   *
   * MUST run inside the caller's transaction, holding whatever locks the caller
   * holds. It takes none of its own: nothing may reach the tenant client again
   * from inside a `$transaction`, because the per-tenant pool is clamped to one
   * connection and the nested read would wait for the connection the transaction
   * is holding. Phase 16 lost most of a phase to that, and the symptom was a
   * 5,000 ms timeout blamed on the next statement.
   */
  async claimOnArrival(
    tx: TxV2,
    input: {
      readonly itemId: string;
      readonly branchId: string;
      readonly now: Date;
      /** The pickup branch's zone, for the civil shelf-expiry computation. */
      readonly timezone: string;
      /** Live, not frozen — see `hold-pinning.ts` on the policy/calendar split. */
      readonly calendar: Parameters<typeof shelfExpiryFor>[0]['calendar'];
    },
  ): Promise<ArrivalClaim | null> {
    // The hold this copy is already assigned to. Assignment happened at
    // promotion, before the van; arrival is where it becomes COLLECTABLE.
    const hold = await tx.hold.findFirst({
      where: {
        assignedItemId: input.itemId,
        fulfilledAt: null,
        cancelledAt: null,
        expiredAt: null,
      },
      select: {
        id: true,
        patronId: true,
        pickupBranchId: true,
        awaitingPickupSince: true,
        policySnapshot: true,
      },
    });
    if (hold === null) return null;

    // Arrived somewhere else — a mis-routed van, or a librarian scanning a copy
    // in at the wrong desk. NOT a claim: shelving it here would put a reader's
    // book on a shelf they are not going to.
    if (hold.pickupBranchId !== input.branchId) return null;

    const pinned = readPinnedHoldPolicy(hold.id, hold.policySnapshot);
    const shelfExpiresAt = shelfExpiryFor({
      policy: pinned.hold,
      calendar: input.calendar,
      from: input.now,
      timezone: input.timezone,
    });

    await tx.hold.update({
      where: { id: hold.id },
      data: {
        // THE COLUMN THE ACCEPTANCE CRITERION TURNS ON. NULL for the whole of a
        // transit; stamped exactly here. §4.4 says producers emit INTENTS only,
        // and "this became collectable at 14:32" is the intent — phase 22 reads
        // it and decides the channel, the template and the quiet hours.
        awaitingPickupSince: input.now,
        shelfExpiresAt,
        updatedAt: input.now,
      },
    });

    return {
      holdId: hold.id,
      patronId: hold.patronId,
      shelfExpiresAt,
      // A re-scan of a copy already on the shelf is not a second arrival. The
      // caller uses this to avoid re-stamping a notice intent, which is the
      // difference between telling a reader once and telling them every time a
      // librarian tidies the shelf.
      wasAlreadyOnShelf: hold.awaitingPickupSince !== null,
    };
  }
}

export type ArrivalClaim = {
  readonly holdId: string;
  readonly patronId: string;
  readonly shelfExpiresAt: Date | null;
  readonly wasAlreadyOnShelf: boolean;
};
