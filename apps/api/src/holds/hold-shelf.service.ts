import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Calendar } from '@libriant/circ-policy';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { PolicySnapshotService } from '../policy/policy-snapshot.service.js';
import { ItemStatusService } from '../items/item-status.service.js';
import { ItemTransfersService } from '../items/item-transfers.service.js';
import { civilToday } from '../circulation/circulation-state.js';
import { CirculationRefusal } from '../circulation/refusals.js';
import { HoldArrivalService } from './hold-arrival.service.js';
import { canCollectAt, readPinnedHoldPolicy } from '@libriant/circ-policy';
import { promoteForItem } from './hold-promotion.js';
import { closeQueueGap } from './hold-queue.js';
import { settlePromotion } from './hold-settlement.js';

/**
 * The two lists a librarian works every morning, and the sweeps that keep them
 * honest (2.0 phase 17).
 *
 * ## THE PULL LIST IS A QUERY, NOT A TABLE
 *
 * "These readers are waiting and a copy is on the shelf" is derivable from
 * `holds` and `items`, and `HoldsService` explains why it must NOT be stored:
 * placing a hold takes no item lock, so a copy assigned at placement can be lent
 * at the desk a second later and the reader is told a book is waiting for them
 * that somebody walked out with. Nothing is assigned until somebody is holding
 * the copy.
 *
 * So there are two lists and they are different questions:
 *
 *   PULL   "go and fetch these" — open, unassigned, unsuspended requests whose
 *          record has a copy on the shelf at this branch. Derived, every time.
 *   SHELF  "these are waiting for their readers" — collectable requests, ordered
 *          by the date the reader was told. Index-backed by `holds_shelf_idx`.
 *
 * A third, `inProgress`, is the gap between them: assigned but not yet
 * collectable — a copy in somebody's hand, or in a van. `holds_pull_list_idx`
 * serves it exactly.
 *
 * ## THE SWEEPS ALERT-BY-DOING, AND ONE OF THEM PROMOTES
 *
 * `expireShelf` is the only sweep in this phase that touches a copy, and when it
 * takes one back it immediately offers it to the next reader in the queue —
 * because a book coming off the hold shelf is exactly a book being returned, and
 * routing it through the same `promoteForItem` is what stops the second reader
 * in the queue waiting for a librarian to notice.
 *
 * Neither sweep repairs a queue. §8 risk 7's rule for the ledger applies here
 * for the same reason: "alerts rather than self-heals (self-healing hides the
 * bug that caused the drift)". `queueIntegrity` REPORTS.
 */
@Injectable()
export class HoldShelfService {
  private readonly logger = new Logger(HoldShelfService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
    @Inject(ItemTransfersService) private readonly transfers: ItemTransfersService,
    @Inject(HoldArrivalService) private readonly arrivals: HoldArrivalService,
  ) {}

  // -------------------------------------------------------------------------
  // The lists
  // -------------------------------------------------------------------------

  /**
   * "Go and fetch these."
   *
   * ONE row per request, naming ONE copy to fetch — `DISTINCT ON` over the
   * shelf-available copies, in call-number order, so two librarians working the
   * list from the top do not walk to the same shelf twice.
   *
   * `is_shelf_available` is the GENERATED column and not `status = 'available'`:
   * Prisma emits `status = CAST($1::text AS item_status)`, `enum_in` is only
   * STABLE, and the planner can never prove an enum-predicate index — the
   * measurement the baseline migration records and phase 15 re-measured at 1470
   * buffers against 2.
   *
   * SUSPENDED requests are absent. A reader who said "not until the 3rd" does
   * not want a librarian walking to a shelf for them today, and they keep their
   * place either way.
   */
  async pullList(tenant: TenantContext, branchId: string, take = 200): Promise<PullListRow[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const today = civilToday(this.clock.now(), await this.timezoneOf(tenant, branchId));
    const rows = await client.$queryRaw<(PullListRow & PullListPolicy)[]>`
      SELECT DISTINCT ON (h.id)
             h.id                AS "holdId",
             h.bib_id            AS "bibId",
             h.patron_id         AS "patronId",
             h.level::text       AS level,
             h.volume,
             h.queue_position    AS "queuePosition",
             h.pickup_branch_id  AS "pickupBranchId",
             h.placed_at         AS "placedAt",
             i.id                AS "itemId",
             i.barcode,
             -- The three parts a librarian reads off a spine, joined the way a
             -- label prints them. There is no single call-number column: phase
             -- 15 stores prefix, base and suffix separately, and call_number_sort
             -- is a fixed-width ASCII key that is deliberately unreadable.
             -- (No backticks in this comment: one inside a SQL comment ends the
             -- JS template literal it lives in, mid-statement.)
             pg_catalog.concat_ws(' ', i.call_number_prefix, i.call_number_base,
                                  i.call_number_suffix) AS "callNumber",
             i.current_branch_id AS "itemBranchId",
             i.owning_branch_id  AS "itemOwningBranchId",
             p.home_branch_id    AS "patronHomeBranchId",
             h.policy_snapshot   AS "policySnapshot"
        FROM lbr2.holds h
        JOIN lbr2.patrons p ON p.id = h.patron_id
        JOIN lbr2.items i
          ON i.bib_id = h.bib_id
         AND i.is_shelf_available
         AND i.current_branch_id = ${branchId}
         -- The level filter, identical to the promoter's. A librarian must not
         -- be sent to fetch a copy the promotion would then refuse to assign.
         AND (h.level = 'title'
              OR (h.level = 'item' AND h.item_id = i.id)
              OR (h.level = 'volume' AND h.volume IS NOT DISTINCT FROM i.enumeration))
       WHERE h.assigned_item_id IS NULL
         AND h.fulfilled_at IS NULL AND h.cancelled_at IS NULL AND h.expired_at IS NULL
         AND (h.suspended_until IS NULL OR h.suspended_until < ${today}::date)
       ORDER BY h.id, i.call_number_sort NULLS LAST, i.id
       LIMIT ${Math.min(Math.max(take, 1), 500)}`;

    // THE PICKUP FILTER, which cannot be SQL — the same filter `promoteForItem`
    // applies for the same reason: eligibility depends on each request's OWN
    // pinned policy, a jsonb column, and on three branches that are not all on
    // the hold row. Without it a request whose frozen policy will not move a copy
    // between branches is printed on the pull list every morning, a librarian
    // walks to the shelf, scans the copy, and `fetch` refuses to assign it —
    // for ever, because nothing about the situation ever changes.
    //
    // A snapshot this code cannot read is LISTED rather than hidden. A request
    // that has lost its policy needs a human, and dropping it off the one screen
    // a human looks at is the opposite of asking for one.
    return rows.filter((r) => {
      let pinned;
      try {
        pinned = readPinnedHoldPolicy(r.holdId, r.policySnapshot);
      } catch {
        return true;
      }
      return canCollectAt({
        policy: pinned.hold,
        explicitPickupBranchIds: pinned.pickupBranchIds,
        wantedBranchId: r.pickupBranchId,
        itemOwningBranchId: r.itemOwningBranchId,
        itemCurrentBranchId: r.itemBranchId,
        patronHomeBranchId: r.patronHomeBranchId,
      }).ok;
    });
  }

  /** The hold shelf itself: waiting for a name, in the order they expire. */
  async shelf(tenant: TenantContext, branchId: string, take = 500) {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.hold.findMany({
      where: {
        pickupBranchId: branchId,
        awaitingPickupSince: { not: null },
        fulfilledAt: null,
        cancelledAt: null,
        expiredAt: null,
      },
      orderBy: [{ shelfExpiresAt: 'asc' }, { awaitingPickupSince: 'asc' }],
      take: Math.min(Math.max(take, 1), 1000),
      select: {
        id: true,
        bibId: true,
        patronId: true,
        assignedItemId: true,
        awaitingPickupSince: true,
        shelfExpiresAt: true,
      },
    });
  }

  /** Assigned, not yet collectable: in a hand, or in a van. */
  async inProgress(tenant: TenantContext, branchId: string, take = 500) {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.hold.findMany({
      where: {
        pickupBranchId: branchId,
        assignedItemId: { not: null },
        awaitingPickupSince: null,
        fulfilledAt: null,
        cancelledAt: null,
        expiredAt: null,
      },
      orderBy: [{ assignedAt: 'asc' }],
      take: Math.min(Math.max(take, 1), 1000),
      select: { id: true, bibId: true, patronId: true, assignedItemId: true, assignedAt: true },
    });
  }

  // -------------------------------------------------------------------------
  // "I have this copy in my hand"
  // -------------------------------------------------------------------------

  /**
   * A librarian fetched a copy off the shelf. Who wants it?
   *
   * Deliberately keyed on the COPY and not on the request, even though the pull
   * list named one. Between printing the list and walking to the shelf, the
   * queue can have changed — a reader ahead of them resumed a suspension, a
   * request was cancelled — and giving the copy to the request that was on the
   * printout would serve the queue out of order for a reason nobody could see.
   * `promoteForItem` walks the queue as it stands, under the bib lock, exactly
   * as a checkin does.
   *
   * Returns `null` when nobody can use it, which is not an error: a list goes
   * stale, and the honest answer is "put it back".
   */
  async fetch(
    tenant: TenantContext,
    actor: TenantActor,
    input: { readonly itemId: string; readonly source?: 'desk' | 'kiosk' | 'api' },
  ): Promise<FetchOutcome | null> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const snapshot = await this.snapshots.get(tenant);

    const probe = await client.item.findUnique({
      where: { id: input.itemId },
      select: { id: true, bibId: true },
    });
    if (probe === null) throw new NotFoundException('No such copy.');

    const outcome = await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('bib', probe.bibId), lockKey('item', probe.id)]);
        await setChangeActor(tx, changeActorOf(actor));

        // RAW, for `is_shelf_available`. It is a GENERATED column and Prisma
        // has no concept of one, so it is absent from the datamodel and lives in
        // the `check:schema-drift` allowlist — which means it cannot be
        // `select`ed. Re-deriving it here from status plus the four exclusion
        // codes would be a second definition of "on the shelf right now", and
        // the baseline migration made it generated precisely so there is one.
        const rows = await tx.$queryRaw<
          {
            id: string;
            bibId: string;
            status: string;
            enumeration: string | null;
            currentBranchId: string;
            owningBranchId: string;
            isShelfAvailable: boolean;
          }[]
        >`
          SELECT id,
                 bib_id             AS "bibId",
                 status::text       AS status,
                 enumeration,
                 current_branch_id  AS "currentBranchId",
                 owning_branch_id   AS "owningBranchId",
                 is_shelf_available AS "isShelfAvailable"
            FROM lbr2.items
           WHERE id = ${probe.id}`;
        const item = rows[0] ?? null;
        if (item === null) throw new NotFoundException('No such copy.');
        if (item.bibId !== probe.bibId) {
          throw new CirculationRefusal(
            'circulation.raced',
            'That copy was moved to another record while you were fetching it. Scan it again.',
          );
        }
        if (!item.isShelfAvailable) {
          throw new CirculationRefusal(
            'holds.copyNotOnShelf',
            `That copy is ${item.status.replace('_', ' ')} and is not on the shelf to be fetched.`,
          );
        }

        const branch = await tx.branch.findUnique({
          where: { id: item.currentBranchId },
          select: { timezone: true, calendarId: true },
        });
        const timezone = branch?.timezone ?? 'UTC';

        const promotion = await promoteForItem(tx, {
          bibId: item.bibId,
          itemId: item.id,
          itemVolume: item.enumeration,
          itemCurrentBranchId: item.currentBranchId,
          itemOwningBranchId: item.owningBranchId,
          now,
          today: civilToday(now, timezone),
        });
        if (promotion.kind === 'nobody') return null;

        const settled = await settlePromotion(
          tx,
          { transfers: this.transfers, arrivals: this.arrivals },
          {
            promotion,
            itemId: item.id,
            atBranchId: item.currentBranchId,
            now,
            timezone,
            calendar: calendarOrNull(snapshot.calendars, branch?.calendarId ?? null),
            actorUserId: actor.userId ?? null,
            source: input.source ?? 'desk',
          },
        );

        await this.status.applyWithin(tx, {
          itemId: item.id,
          toStatus: settled.toStatus,
          source: input.source ?? 'desk',
          causeType: 'hold',
          causeId: promotion.holdId,
          actorUserId: actor.userId ?? null,
          now,
          beforeReadUnderLock: {
            id: item.id,
            status: item.status as never,
            currentBranchId: item.currentBranchId,
          },
        });

        return {
          holdId: promotion.holdId,
          patronId: promotion.patronId,
          itemId: item.id,
          pickupBranchId: promotion.pickupBranchId,
          disposition: settled.toStatus === 'awaiting_pickup' ? 'hold_shelf' : 'transit',
          transferId: settled.transferId,
          shelfExpiresAt: settled.shelfExpiresAt?.toISOString() ?? null,
        } satisfies FetchOutcome;
      },
      { isolationLevel: 'ReadCommitted' },
    );

    if (outcome !== null) {
      await this.audit.record(tenant, actor, {
        action: 'circulation.hold_fetched',
        targetType: 'hold',
        targetId: outcome.holdId,
      });
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // The sweeps
  // -------------------------------------------------------------------------

  /**
   * Nobody came for it.
   *
   * The copy comes off the shelf and is IMMEDIATELY offered to the next reader
   * in the queue — a book leaving the hold shelf is exactly a book being
   * returned, so it goes through `promoteForItem` like any other. Without that,
   * the second reader in the queue waits until a librarian happens to notice a
   * copy on a trolley.
   *
   * ONE TRANSACTION PER HOLD, and that is deliberate rather than lazy: each one
   * takes a different bib and item lock pair, and a sweep that took them all in
   * one transaction would hold every lock in the library for the length of the
   * sweep — at 03:00 that is invisible, and on the day somebody runs it at noon
   * it is the desk stopping.
   */
  async expireShelf(
    tenant: TenantContext,
    actor: TenantActor,
    opts: { readonly limit?: number } = {},
  ): Promise<{ expired: number; promoted: number }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const snapshot = await this.snapshots.get(tenant);

    const due = await client.$queryRaw<{ id: string; bib_id: string; assigned_item_id: string }[]>`
      SELECT id, bib_id, assigned_item_id
        FROM lbr2.holds
       WHERE awaiting_pickup_since IS NOT NULL
         AND shelf_expires_at IS NOT NULL
         AND shelf_expires_at <= ${now}
         AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL
       ORDER BY shelf_expires_at
       LIMIT ${Math.min(Math.max(opts.limit ?? 200, 1), 1000)}`;

    let expired = 0;
    let promoted = 0;
    for (const row of due) {
      const done = await client.$transaction(
        async (tx) => {
          await acquireLocks(tx, [
            lockKey('bib', row.bib_id),
            lockKey('item', row.assigned_item_id),
          ]);
          await setChangeActor(tx, changeActorOf(actor));

          // RE-VERIFIED under the lock, on `assigned_item_id`. The scan above
          // chose which ITEM to lock from a read taken outside any lock; if the
          // request has been given a different copy since, this transaction
          // holds the wrong item's lock and must not move either copy. Skipping
          // is right rather than merely safe — the next tick re-reads and takes
          // the lock that matches.
          const ended = await tx.$executeRaw`
            UPDATE lbr2.holds
               SET expired_at   = ${now},
                   expired_kind = 'shelf',
                   updated_at   = ${now}
             WHERE id = ${row.id}
               AND assigned_item_id = ${row.assigned_item_id}
               AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`;
          if (ended === 0) return { expired: 0, promoted: 0 };

          const item = await tx.item.findUnique({
            where: { id: row.assigned_item_id },
            select: {
              id: true,
              bibId: true,
              status: true,
              enumeration: true,
              currentBranchId: true,
              owningBranchId: true,
            },
          });
          // The copy went somewhere else while the request sat on the shelf —
          // lent by hand, marked missing, withdrawn. The request still expires;
          // the copy is not this sweep's to move.
          if (item === null || item.status !== 'awaiting_pickup')
            return { expired: 1, promoted: 0 };

          const branch = await tx.branch.findUnique({
            where: { id: item.currentBranchId },
            select: { timezone: true, calendarId: true },
          });
          const timezone = branch?.timezone ?? 'UTC';

          const promotion = await promoteForItem(tx, {
            bibId: item.bibId,
            itemId: item.id,
            itemVolume: item.enumeration,
            itemCurrentBranchId: item.currentBranchId,
            itemOwningBranchId: item.owningBranchId,
            now,
            today: civilToday(now, timezone),
          });
          const settled = await settlePromotion(
            tx,
            { transfers: this.transfers, arrivals: this.arrivals },
            {
              promotion,
              itemId: item.id,
              atBranchId: item.currentBranchId,
              now,
              timezone,
              calendar: calendarOrNull(snapshot.calendars, branch?.calendarId ?? null),
              actorUserId: null,
              source: 'api',
            },
          );

          await this.status.applyWithin(tx, {
            itemId: item.id,
            toStatus: settled.toStatus,
            source: 'api',
            causeType: 'hold',
            causeId: row.id,
            note: 'Not collected before the hold shelf expiry.',
            now,
            beforeReadUnderLock: {
              id: item.id,
              status: item.status,
              currentBranchId: item.currentBranchId,
            },
          });
          return { expired: 1, promoted: promotion.kind === 'assigned' ? 1 : 0 };
        },
        { isolationLevel: 'ReadCommitted' },
      );
      expired += done.expired;
      promoted += done.promoted;
    }

    if (expired > 0) {
      this.logger.log(
        `hold shelf: ${expired} request(s) expired, ${promoted} copy(ies) went straight to the ` +
          'next reader',
      );
    }
    return { expired, promoted };
  }

  /**
   * A request nobody could ever fill.
   *
   * `unfilled_request_expiry` is the copy-side answer's opposite: a shelf expiry
   * needs a copy to have arrived, and a request for a book the library has since
   * withdrawn never gets one. Only UNASSIGNED requests are swept — once a copy
   * is on its way, the shelf expiry owns the timing.
   *
   * The gap is closed with the position the request actually held, never with
   * the blanket `> 0`: a request that times out is very often not the head, and
   * the blanket form does not merely produce a wrong answer here, it aborts with
   * `23514` against `holds_position_is_one_based` the first time a suspended
   * request sits at position 1.
   */
  async expireRequests(
    tenant: TenantContext,
    actor: TenantActor,
    opts: { readonly limit?: number } = {},
  ): Promise<{ expired: number }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    // The SCAN, outside any lock, and its `queue_position` is deliberately not
    // selected: it is a guess by the time the lock is taken. See below.
    const due = await client.$queryRaw<{ id: string; bib_id: string }[]>`
      SELECT id, bib_id
        FROM lbr2.holds
       WHERE request_expires_at IS NOT NULL
         AND request_expires_at <= ${now}
         AND assigned_item_id IS NULL
         AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL
       ORDER BY request_expires_at
       LIMIT ${Math.min(Math.max(opts.limit ?? 500, 1), 2000)}`;

    let expired = 0;
    for (const row of due) {
      const done = await client.$transaction(
        async (tx) => {
          await acquireLocks(tx, [lockKey('bib', row.bib_id)]);
          await setChangeActor(tx, changeActorOf(actor));

          // THE POSITION IS RE-READ UNDER THE LOCK, and this is probe-lock-
          // re-verify rather than caution. Between the scan above and this lock
          // a checkin can promote a reader ahead of this one, and `closeQueueGap`
          // moves every position behind them — so a gap closed with the number
          // the scan saw would decrement from the wrong place and leave the
          // queue with a hole or a duplicate, which no CHECK can catch because
          // contiguity is an aggregate property.
          const fresh = await tx.$queryRaw<{ queue_position: number | null }[]>`
            SELECT queue_position
              FROM lbr2.holds
             WHERE id = ${row.id}
               AND assigned_item_id IS NULL
               AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`;
          if (fresh.length === 0) return 0;
          const vacated = fresh[0]?.queue_position ?? null;

          const ended = await tx.$executeRaw`
            UPDATE lbr2.holds
               SET expired_at     = ${now},
                   expired_kind   = 'request',
                   queue_position = NULL,
                   updated_at     = ${now}
             WHERE id = ${row.id}
               AND assigned_item_id IS NULL
               AND queue_position IS NOT DISTINCT FROM ${vacated}
               AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`;
          if (ended === 0) return 0;
          if (vacated !== null) await closeQueueGap(tx, row.bib_id, vacated, now);
          return 1;
        },
        { isolationLevel: 'ReadCommitted' },
      );
      expired += done;
    }

    if (expired > 0) this.logger.log(`hold requests: ${expired} expired unfilled`);
    return { expired };
  }

  // -------------------------------------------------------------------------

  private async timezoneOf(tenant: TenantContext, branchId: string): Promise<string> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const branch = await client.branch.findUnique({
      where: { id: branchId },
      select: { timezone: true },
    });
    return branch?.timezone ?? 'UTC';
  }
}

// ---------------------------------------------------------------------------

/** The three facts the pickup filter needs and the printed list does not. */
type PullListPolicy = {
  readonly itemOwningBranchId: string;
  readonly patronHomeBranchId: string | null;
  readonly policySnapshot: unknown;
};

export type PullListRow = {
  readonly holdId: string;
  readonly bibId: string;
  readonly patronId: string;
  readonly level: string;
  readonly volume: string | null;
  readonly queuePosition: number | null;
  readonly pickupBranchId: string;
  readonly placedAt: Date;
  readonly itemId: string;
  readonly barcode: string | null;
  readonly callNumber: string | null;
  readonly itemBranchId: string;
};

export type FetchOutcome = {
  readonly holdId: string;
  readonly patronId: string;
  readonly itemId: string;
  readonly pickupBranchId: string;
  readonly disposition: 'hold_shelf' | 'transit';
  readonly transferId: string | null;
  readonly shelfExpiresAt: string | null;
};

/** The calendar for a branch, or none. See `checkin.service.ts` on why null. */
function calendarOrNull(
  calendars: Readonly<Record<string, Calendar>>,
  calendarId: string | null,
): Calendar | null {
  if (calendarId !== null && calendars[calendarId] !== undefined) return calendars[calendarId]!;
  return Object.values(calendars)[0] ?? null;
}
