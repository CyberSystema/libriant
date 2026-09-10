import type { Calendar } from '@libriant/circ-policy';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
// A TYPE-ONLY import, so this file still pulls no Nest provider in and the
// `hold-arrival.module.ts` cycle argument survives: `ItemStatusValue` is the
// status vocabulary, not the service.
import type { ItemStatusValue } from '../items/item-status.service.js';
import { civilToday } from '../circulation/circulation-state.js';
import { promoteForItem } from './hold-promotion.js';
import { settlePromotion, type SettlementPorts } from './hold-settlement.js';

/**
 * A copy stops being set aside for somebody. Where does it go?
 *
 * ## The hole this closes, and why it is invisible without a test
 *
 * Three paths end a request that already HAS a copy on a hold shelf: a reader
 * cancels, a group sibling is cancelled because another edition was collected,
 * and the shelf-expiry sweep. Only the third one ever thought about the copy.
 *
 * Nothing else would have taken it back. The shelf sweep reads
 * `shelf_expires_at` on OPEN requests only, and a cancelled request is not open
 * — so a copy left `awaiting_pickup` by either of the first two would sit there
 * for ever, with a dead name on it: absent from `is_shelf_available`, absent
 * from the pull list, absent from the queue behind it, and present only on a
 * shelf-list screen nobody reads on purpose. No constraint can catch it, because
 * `items.status` and `holds` are two tables and the invariant between them is
 * not one a CHECK can see.
 *
 * So all three go through here, and a book leaving a hold shelf is treated as
 * exactly what it is: a book being returned. It walks the queue through
 * `promoteForItem` like any other, and the next eligible reader gets it.
 *
 * ## IT WRITES THE STATUS, unlike `settlePromotion`
 *
 * `settlePromotion` returns a status for the caller to write, because its
 * callers — a checkin, a fetch — are already making exactly one `applyWithin`
 * call for their own cause. This function's callers are not: the copy
 * transition IS this function's act, there is one per copy, and putting it here
 * is what stops three callers each writing their own and disagreeing about the
 * `cause_type`.
 *
 * ## The lock is the caller's, and it must already hold BOTH
 *
 * `bib:` for the queue walk and `item:` for the copy — sorted, in the caller's
 * single `acquireLocks` call, before any read. This function takes none and
 * cannot: `platform/locks.ts` is explicit that a lock taken after the read it
 * protects is the protection of no lock at all.
 */
export type ReleasePorts = SettlementPorts & {
  readonly status: {
    applyWithin(
      tx: TxV2,
      input: {
        readonly itemId: string;
        readonly toStatus: ItemStatusValue;
        readonly source: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
        readonly causeType: string;
        readonly causeId: string;
        readonly note: string;
        readonly now: Date;
        readonly beforeReadUnderLock: {
          readonly id: string;
          readonly status: ItemStatusValue;
          readonly currentBranchId: string;
        };
      },
    ): Promise<unknown>;
  };
};

/**
 * Give a set-aside copy back to the queue, or to the shelf.
 *
 * Returns the request it went to next, or `null` when it went back on the shelf
 * — and also `null` when the copy is not this transaction's to move. ONLY a copy
 * actually sitting `awaiting_pickup` is touched: one still in a van is left to
 * arrive (the receiving desk will find no request for it and shelve it), and one
 * that has been lent by hand, marked missing or withdrawn carries a status
 * somebody set on purpose, which re-shelving would overwrite.
 */
export async function releaseSetAsideCopy(
  tx: TxV2,
  ports: ReleasePorts,
  input: {
    readonly itemId: string;
    /** The request that just ended, for the status history's cause. */
    readonly holdId: string;
    readonly note: string;
    readonly calendars: Readonly<Record<string, Calendar>>;
    readonly now: Date;
  },
): Promise<string | null> {
  const item = await tx.item.findUnique({
    where: { id: input.itemId },
    select: {
      id: true,
      bibId: true,
      status: true,
      enumeration: true,
      currentBranchId: true,
      owningBranchId: true,
    },
  });
  if (item === null || item.status !== 'awaiting_pickup') return null;

  const branch = await tx.branch.findUnique({
    where: { id: item.currentBranchId },
    select: { timezone: true, calendarId: true },
  });
  const timezone = branch?.timezone ?? 'UTC';
  const calendarId = branch?.calendarId ?? null;
  // NULL rather than a fabricated always-open calendar: `shelfExpiryFor` reads
  // an absent calendar as "count clock time, not open days", which is the honest
  // answer for a branch with no hours entered.
  const calendar =
    (calendarId !== null ? input.calendars[calendarId] : undefined) ??
    Object.values(input.calendars)[0] ??
    null;

  const promotion = await promoteForItem(tx, {
    bibId: item.bibId,
    itemId: item.id,
    itemVolume: item.enumeration,
    itemCurrentBranchId: item.currentBranchId,
    itemOwningBranchId: item.owningBranchId,
    now: input.now,
    today: civilToday(input.now, timezone),
  });
  const settled = await settlePromotion(tx, ports, {
    promotion,
    itemId: item.id,
    atBranchId: item.currentBranchId,
    now: input.now,
    timezone,
    calendar,
    actorUserId: null,
    source: 'desk',
  });

  await ports.status.applyWithin(tx, {
    itemId: item.id,
    toStatus: settled.toStatus,
    source: 'desk',
    causeType: 'hold',
    causeId: input.holdId,
    note: input.note,
    now: input.now,
    beforeReadUnderLock: {
      id: item.id,
      status: item.status as ItemStatusValue,
      currentBranchId: item.currentBranchId,
    },
  });
  return settled.holdId;
}
