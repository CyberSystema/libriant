import { addDuration, type Calendar } from '@libriant/circ-policy';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import type { ArrivalClaim } from './hold-arrival.service.js';
import type { PromotionOutcome } from './hold-promotion.js';

/**
 * A copy has been given to a reader. Now: shelf, or van?
 *
 * ## Why this is a function and not two copies of an `if`
 *
 * Two places promote a copy — a checkin at a return desk, and a librarian
 * working the pull list — and they reach the identical fork. The decision is
 * three lines long and each of them is load-bearing:
 *
 *   - the copy is HERE, so it goes on the hold shelf and the reader is told;
 *   - the copy is elsewhere, so a transfer opens and `awaiting_pickup_since`
 *     stays NULL for the whole journey;
 *   - and the status the caller writes is the FINAL one, never an intermediate.
 *
 * The third is the phase's acceptance criterion — "a routed hold reaches
 * `awaiting_pickup` only on transit receipt" — and it is provable rather than
 * timed precisely because there is no intermediate row: between the send row
 * (`on_loan → in_transit`) and the shelving row (`in_transit →
 * awaiting_pickup`) `item_status_history` has nothing at all. Two copies of this
 * decision is two chances for one of them to write `available` first, and the
 * criterion would then be a fact about how fast the next statement ran.
 *
 * ## It performs the SIDE EFFECTS and returns the STATUS
 *
 * The transfer row and the `awaiting_pickup_since` stamp happen here; the
 * `items.status` write does not. Phase 15 made `ItemStatusService` the single
 * writer of that column and the phase-16 budget test asserts one history row per
 * checkin, so the caller — which knows whether the cause was a loan, a transfer
 * or a shelf sweep — makes exactly one `applyWithin` call with what this
 * returns.
 *
 * ## The ports are structural on purpose
 *
 * `ItemStatusService`, `ItemTransfersService` and `HoldArrivalService` are Nest
 * providers in two different modules, and importing either class here would put
 * a cycle back into the graph that `hold-arrival.module.ts` exists to keep out.
 * The two methods this needs are described by their shapes instead, so a caller
 * passes the services it already holds and nothing is injected.
 */
export type SettlementPorts = {
  readonly transfers: {
    openWithin(
      tx: TxV2,
      input: {
        readonly itemId: string;
        readonly toBranchId: string;
        readonly holdId?: string | null;
        readonly expectedBy?: Date | null;
        readonly fromBranchId: string;
        readonly actorUserId: string | null;
        readonly source?: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
        readonly deviceId?: string | null;
        readonly now: Date;
      },
    ): Promise<{ id: string }>;
  };
  readonly arrivals: {
    claimOnArrival(
      tx: TxV2,
      input: {
        readonly itemId: string;
        readonly branchId: string;
        readonly now: Date;
        readonly timezone: string;
        readonly calendar: Calendar | null;
      },
    ): Promise<ArrivalClaim | null>;
  };
};

export type Settlement = {
  /** What the caller must transition the copy to. Exactly one write. */
  readonly toStatus: 'available' | 'awaiting_pickup' | 'in_transit';
  readonly holdId: string | null;
  readonly transferId: string | null;
  readonly shelfExpiresAt: Date | null;
};

export async function settlePromotion(
  tx: TxV2,
  ports: SettlementPorts,
  input: {
    readonly promotion: PromotionOutcome;
    readonly itemId: string;
    /** The desk the copy is standing on right now. */
    readonly atBranchId: string;
    readonly now: Date;
    readonly timezone: string;
    readonly calendar: Calendar | null;
    readonly actorUserId: string | null;
    readonly source?: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
    readonly deviceId?: string | null;
  },
): Promise<Settlement> {
  const { promotion } = input;
  if (promotion.kind === 'nobody') {
    return { toStatus: 'available', holdId: null, transferId: null, shelfExpiresAt: null };
  }

  if (promotion.pickupBranchId === input.atBranchId) {
    const claim = await ports.arrivals.claimOnArrival(tx, {
      itemId: input.itemId,
      branchId: input.atBranchId,
      now: input.now,
      timezone: input.timezone,
      calendar: input.calendar,
    });
    // `claimOnArrival` cannot return null here: it finds the hold by
    // `assigned_item_id`, which the promotion has just set, and the pickup
    // branch matched the test above. Written as a branch rather than a `!`
    // because the alternative is an assertion on the decision that puts a book
    // on a shelf with somebody's name on it.
    return {
      toStatus: claim === null ? 'available' : 'awaiting_pickup',
      holdId: promotion.holdId,
      transferId: null,
      shelfExpiresAt: claim?.shelfExpiresAt ?? null,
    };
  }

  const transfer = await ports.transfers.openWithin(tx, {
    itemId: input.itemId,
    toBranchId: promotion.pickupBranchId,
    holdId: promotion.holdId,
    // WHEN THE VAN SHOULD HAVE ARRIVED, from the winner's frozen
    // `maxTransitDays`. Without it the row has a NULL `expected_by`, and
    // `hold-transit-timeout.job.ts` counts only transfers where that column is
    // set and past — so every hold-routed transfer would have been invisible to
    // the one alert built to notice a crate nobody unpacked.
    // CIVIL DAYS through `addDuration`, never `n * 86_400_000`. The ESLint block
    // on this directory caught the milliseconds version and is right to: a van
    // given three days on 25 March in Athens arrives an hour late on the 28th,
    // because Greece springs forward on the 29th. `maxTransitDays` is a number
    // of DAYS a library counted on a calendar.
    expectedBy:
      promotion.maxTransitDays === null
        ? null
        : addDuration(
            input.timezone,
            input.now,
            { value: promotion.maxTransitDays, unit: 'days' },
            null,
          ),
    fromBranchId: input.atBranchId,
    actorUserId: input.actorUserId,
    ...(input.source === undefined ? {} : { source: input.source }),
    deviceId: input.deviceId ?? null,
    now: input.now,
  });
  return {
    toStatus: 'in_transit',
    holdId: promotion.holdId,
    transferId: transfer.id,
    shelfExpiresAt: null,
  };
}
