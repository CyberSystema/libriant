import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDuration,
  evaluateBlocks,
  resolveCirculationPolicy,
  type Block,
  type HoldPolicy,
} from '@libriant/circ-policy';
import { foldGreek } from '@libriant/shared/greek';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { PolicySnapshotService } from '../policy/policy-snapshot.service.js';
import { ItemStatusService } from '../items/item-status.service.js';
import { ItemTransfersService } from '../items/item-transfers.service.js';
import { PatronBlocksService } from '../patrons/patron-blocks.service.js';
import { mergeBlocks } from '../circulation/block-merge.js';
import { civilToday, countCirculationState } from '../circulation/circulation-state.js';
import { CirculationBlockedError, CirculationRefusal } from '../circulation/refusals.js';
import { HoldArrivalService } from './hold-arrival.service.js';
import { pinHoldPolicy, readPinnedHoldPolicy } from './hold-pinning.js';
import { closeQueueGap, nextQueuePosition } from './hold-queue.js';
import { releaseSetAsideCopy } from './hold-release.js';

/**
 * Asking for a book somebody else has (2.0 phase 17).
 *
 * ## PLACEMENT NEVER ASSIGNS A COPY
 *
 * The tempting shortcut is to look for a copy on the shelf and hand it to the
 * reader on the spot. It is wrong for a reason that is invisible until it
 * happens: assigning a copy is a claim on a physical object, and this
 * transaction holds no lock on any item — so a copy assigned here can be lent at
 * the desk a second later, and the reader is told a book is waiting for them
 * that somebody walked out with.
 *
 * So a placement puts the reader in the queue, and nothing else. A copy is
 * claimed in exactly two places, both of which hold the item's lock because they
 * are already holding the copy:
 *
 *   `hold-promotion.ts`   a copy comes back at a desk, and the checkin
 *                         transaction that holds it walks the queue.
 *   `HoldShelfService`    a librarian works the pull list, fetches a copy off
 *                         the shelf and scans it against the request.
 *
 * That is also why the pull list is a QUERY rather than a table of assignments:
 * "these readers are waiting and a copy is on the shelf" is derivable, and
 * derivable beats stored for anything a librarian has not yet physically done.
 *
 * ## THE LOCK, AND WHY IT IS THE BIB AND NOT THE HOLD
 *
 * `nextQueuePosition` is `max(queue_position) + 1`, a read-then-write, and it is
 * safe only because every writer of a queue holds `lockKey('bib', bibId)`. There
 * is no `ON CONFLICT` alternative and the migration says why: an arbiter must
 * name the index's columns, and an upsert that wanted "the next position" would
 * have to know the position before it could name it.
 *
 * `patron:` is taken too and sorts first, because a placement reads the reader's
 * blocks and counts their open holds — and a checkout of the same reader must
 * not be interleaved with it.
 *
 * ## WHAT IS FROZEN, AND THE ONE THING THAT IS NOT
 *
 * §3: holds pin `hold_policy_id` + `policy_snapshot` "IDENTICALLY" to loans.
 * `hold-pinning.ts` argues the split; the short version is that a reader was
 * told the rules when they asked, so re-resolving later can retroactively make
 * their pickup branch ineligible — which is not a bug, it is a promise broken.
 * The calendar stays live, because it is what HAPPENED rather than what the
 * library DECIDED.
 */
@Injectable()
export class HoldsService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
    @Inject(PatronBlocksService) private readonly blocks: PatronBlocksService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
    @Inject(ItemTransfersService) private readonly transfers: ItemTransfersService,
    @Inject(HoldArrivalService) private readonly arrivals: HoldArrivalService,
  ) {}

  // -------------------------------------------------------------------------
  // Placing
  // -------------------------------------------------------------------------

  async place(
    tenant: TenantContext,
    actor: TenantActor,
    input: PlaceHoldInput,
  ): Promise<PlacedHold> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    // PROBE, outside the transaction and treated as a guess: its only job is to
    // learn the two lock keys, which a card barcode and an item barcode do not
    // carry. Everything it reads is read again under the locks.
    const probe = await this.probe(client as unknown as TxV2, input);
    const snapshot = await this.snapshots.get(tenant);

    const placed = await client
      .$transaction(
        async (tx) => {
          await acquireLocks(tx, [lockKey('patron', probe.patronId), lockKey('bib', probe.bibId)]);
          await setChangeActor(tx, changeActorOf(actor));

          const patron = await tx.patron.findUnique({
            where: { id: probe.patronId },
            select: {
              id: true,
              status: true,
              archivedAt: true,
              expiresAt: true,
              dateOfBirth: true,
              mergedIntoId: true,
              patronCategoryId: true,
              homeBranchId: true,
            },
          });
          const bib = await tx.marcRecord.findUnique({
            where: { id: probe.bibId },
            select: { id: true, deletedAt: true, mergedIntoId: true },
          });
          if (patron === null || bib === null)
            throw new NotFoundException('No such reader or record.');

          // RE-VERIFY. A merge that landed between the probe and the locks would
          // otherwise put a reader in the queue of a record nobody looks at
          // again, which is the quietest way to lose a request.
          if (patron.mergedIntoId !== null || bib.mergedIntoId !== null) {
            throw new CirculationRefusal(
              'circulation.raced',
              'That reader or record was merged into another one while you were working. Try ' +
                'again from the record it was merged into.',
            );
          }
          if (bib.deletedAt !== null) {
            throw new CirculationRefusal(
              'holds.recordDeleted',
              'That record has been deleted, so nothing can be requested from it.',
            );
          }
          this.refusePatronState(patron, now);

          // The copy, for an item-level request AND for the policy selectors.
          // A title hold has no item, so `itemTypeId` and the two branches are
          // null and the rules matrix falls through to a wider rule — which is
          // exactly what a wildcard selector is for.
          const item =
            input.itemId === undefined
              ? null
              : await tx.item.findUnique({
                  where: { id: input.itemId },
                  select: {
                    id: true,
                    bibId: true,
                    archivedAt: true,
                    withdrawnAt: true,
                    enumeration: true,
                    itemTypeId: true,
                    temporaryItemTypeId: true,
                    permanentLocationId: true,
                    temporaryLocationId: true,
                    owningBranchId: true,
                    currentBranchId: true,
                  },
                });
          if (input.itemId !== undefined && (item === null || item.archivedAt !== null)) {
            throw new NotFoundException('No such live copy.');
          }
          if (item !== null && item.bibId !== probe.bibId) {
            throw new CirculationRefusal(
              'holds.copyBelongsElsewhere',
              'That copy is not attached to that record.',
            );
          }
          if (item !== null && item.withdrawnAt !== null) {
            throw new CirculationRefusal(
              'holds.copyWithdrawn',
              'That copy has been withdrawn and cannot be requested.',
            );
          }

          const branch = await tx.branch.findUnique({
            where: { id: input.pickupBranchId },
            select: {
              id: true,
              timezone: true,
              currency: true,
              calendarId: true,
              pickupLocation: true,
              archivedAt: true,
            },
          });
          if (branch === null || branch.archivedAt !== null) {
            throw new NotFoundException('No such branch.');
          }
          // A branch that is not a pickup location is a store, a bindery or an
          // office. Refusing here rather than in the policy is deliberate: it is
          // a FACT about the branch, not a rule a library chose about holds, and
          // no `hold_policies` row can make a closed store collectable.
          if (!branch.pickupLocation) {
            throw new CirculationRefusal(
              'holds.branchNotAPickupLocation',
              'Readers cannot collect at that location.',
            );
          }

          const level = input.level ?? (input.itemId === undefined ? 'title' : 'item');
          const volume = level === 'volume' ? (input.volume ?? item?.enumeration ?? null) : null;
          if (level === 'volume' && volume === null) {
            throw new CirculationRefusal(
              'holds.volumeRequired',
              'A volume-level request has to name the volume it wants.',
            );
          }
          if (level === 'item' && item === null) {
            throw new CirculationRefusal(
              'holds.copyRequired',
              'An item-level request has to name the copy it wants.',
            );
          }

          const resolved = resolveCirculationPolicy(snapshot, {
            patronCategoryId: patron.patronCategoryId,
            itemTypeId: item === null ? null : (item.temporaryItemTypeId ?? item.itemTypeId),
            owningBranchId: item?.owningBranchId ?? null,
            shelvingLocationId:
              item === null ? null : (item.temporaryLocationId ?? item.permanentLocationId),
            // A hold has no checkout branch. NULL is the wildcard, and the rules
            // matrix is built for exactly this: the reader has not decided where
            // they will borrow it, only where they will collect it.
            checkoutBranchId: null,
            pickupBranchId: branch.id,
            at: now,
          });

          const requestType = input.requestType ?? 'hold';
          if (!resolved.hold.requestTypes.includes(requestType)) {
            throw new CirculationRefusal(
              'holds.requestTypeNotAllowed',
              `This policy accepts ${resolved.hold.requestTypes.join(', ')} requests, not ` +
                `${requestType}.`,
              { allowed: resolved.hold.requestTypes },
            );
          }

          const counted = await countCirculationState(tx, {
            patronId: patron.id,
            bibId: bib.id,
            currency: branch.currency,
            at: now,
            timezone: branch.timezone,
            patron: { dateOfBirth: patron.dateOfBirth },
            today: civilToday(now, branch.timezone),
            requestedPickupBranchId: branch.id,
            requestedHoldLevel: level,
            itemOwningBranchId: item?.owningBranchId ?? null,
            itemCurrentBranchId: item?.currentBranchId ?? null,
            patronHomeBranchId: patron.homeBranchId,
          });
          // WITHIN the transaction. The per-tenant pool is clamped to one
          // connection, so a read through the outer client would wait for the
          // connection this transaction is holding — phase 16 lost most of a
          // phase to that, and the symptom is a 5,000 ms timeout blamed on the
          // next statement.
          const stored = await this.blocks.liveBlocksWithin(tx, patron.id);

          const all = mergeBlocks(stored, evaluateBlocks(resolved, counted, 'hold'));
          const blocking = all.filter((b) => b.severity === 'block');
          if (blocking.length > 0) throw new CirculationBlockedError('hold', blocking, all);

          if (input.groupId !== undefined) await this.assertGroup(tx, input.groupId, patron.id);

          // "Place it, but not until I'm back from Crete." The SAME policy the
          // suspend route enforces — see `refuseBadSuspension` for why it is one
          // function and what a past date used to do.
          const suspendedFrom = civilToday(now, branch.timezone);
          if (input.suspendedUntil !== undefined) {
            this.refuseBadSuspension(
              resolved.hold,
              branch.timezone,
              suspendedFrom,
              input.suspendedUntil,
              now,
            );
          }

          const pinned = pinHoldPolicy({
            resolved,
            resolvedAt: now,
            branchId: branch.id,
            timezone: branch.timezone,
            calendarId: branch.calendarId,
            itemTypeId: item === null ? null : (item.temporaryItemTypeId ?? item.itemTypeId),
            patronCategoryId: patron.patronCategoryId,
            pickupBranchIds: resolved.hold.pickupBranchIds,
          });

          const hold = await tx.hold.create({
            data: {
              bibId: bib.id,
              level,
              itemId: level === 'item' ? (item?.id ?? null) : null,
              volume,
              patronId: patron.id,
              requestType,
              pickupBranchId: branch.id,
              // The back of the queue, under the bib lock. `priority` is the
              // librarian's thumb on the scale and changes the ORDER without
              // renumbering anybody — which is what keeps contiguity a property
              // of one column rather than of every mutation.
              queuePosition: await nextQueuePosition(tx, bib.id),
              priority: input.priority ?? 0,
              ...(input.suspendedUntil === undefined
                ? {}
                : {
                    suspendedFrom: civilDate(suspendedFrom),
                    suspendedUntil: civilDate(input.suspendedUntil),
                  }),
              requestExpiresAt: unfilledExpiryFor(resolved.hold, now, branch.timezone),
              holdPolicyId: resolved.hold.id,
              appliedRuleId: resolved.trace.matchedRuleId,
              policySnapshot: pinned as never,
              groupId: input.groupId ?? null,
              source: input.source ?? 'desk',
              placedByUserId: actor.userId ?? null,
              notes: input.notes ?? null,
              placedAt: now,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true, queuePosition: true, requestExpiresAt: true },
          });

          return {
            id: hold.id,
            bibId: bib.id,
            patronId: patron.id,
            level,
            pickupBranchId: branch.id,
            queuePosition: hold.queuePosition!,
            requestExpiresAt: hold.requestExpiresAt?.toISOString() ?? null,
            appliedRuleId: resolved.trace.matchedRuleId,
            snapshotVersion: resolved.trace.snapshotVersion,
            warnings: all.filter((b) => b.severity === 'warn'),
          } satisfies PlacedHold;
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw alreadyHolding(err) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'circulation.hold_placed',
      targetType: 'hold',
      targetId: placed.id,
    });
    return placed;
  }

  // -------------------------------------------------------------------------
  // Ending one
  // -------------------------------------------------------------------------

  /**
   * Cancel a request.
   *
   * THE TARGETED REBALANCE, and the whole reason phase 17 exists apart from 16:
   * `closeQueueGap` is given the position the hold ACTUALLY held. The 1.0 blanket
   * `WHERE queue_position > 0` is correct only while the head always leaves, and
   * a cancelled hold is very often not the head.
   *
   * ## AN ASSIGNED HOLD RELEASES ITS COPY, and that is not optional
   *
   * A reader who changes their mind after a copy has been set aside has left a
   * book on a shelf with their name on it. Nothing else would ever take it back:
   * the shelf sweep reads `shelf_expires_at` on OPEN requests only, and a
   * cancelled one is not open — so a copy left `awaiting_pickup` here would sit
   * there for ever, invisible to the pull list, to availability, and to the next
   * reader in the queue.
   *
   * So the copy goes straight back through `promoteForItem`, exactly as it would
   * on a return: the next eligible reader gets it, or it goes back on the shelf.
   * That needs the ITEM lock as well as the bib's, which is why the probe reads
   * `assigned_item_id` before the transaction opens — patron < bib < item, one
   * sorted `acquireLocks` call, and the rank is unchanged.
   *
   * A copy still IN TRANSIT is left alone, and needs no special case: the
   * receiving desk will scan it, `claimOnArrival` will find no hold for it, and
   * `ItemTransfersService.receive` shelves it `available`. The van does not have
   * to be turned around.
   */
  async cancel(
    tenant: TenantContext,
    actor: TenantActor,
    input: { readonly holdId: string; readonly reason?: string },
  ): Promise<{ id: string; releasedItemId: string | null; promotedHoldId: string | null }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const snapshot = await this.snapshots.get(tenant);

    const probe = await client.hold.findUnique({
      where: { id: input.holdId },
      select: { id: true, bibId: true, patronId: true, assignedItemId: true },
    });
    if (probe === null) throw new NotFoundException('No such hold.');

    const out = await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [
          lockKey('patron', probe.patronId),
          lockKey('bib', probe.bibId),
          ...(probe.assignedItemId === null ? [] : [lockKey('item', probe.assignedItemId)]),
        ]);
        await setChangeActor(tx, changeActorOf(actor));

        const hold = await this.openHold(tx, input.holdId);
        // RE-VERIFY. A copy assigned between the probe and the locks is a copy
        // this transaction holds no lock on, so it cannot be released here.
        if (hold.assigned_item_id !== probe.assignedItemId) {
          throw new CirculationRefusal(
            'circulation.raced',
            'A copy was set aside for this request while you were working. Refresh and try again.',
          );
        }

        const done = await tx.$executeRaw`
          UPDATE lbr2.holds
             SET cancelled_at         = ${now},
                 cancelled_by_user_id = ${actor.userId ?? null},
                 cancelled_reason     = ${input.reason ?? null},
                 queue_position       = NULL,
                 updated_at           = ${now}
           WHERE id = ${hold.id}
             AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`;
        if (done === 0) {
          throw new ConflictException('That hold was closed by somebody else.');
        }
        if (hold.queue_position !== null) {
          await closeQueueGap(tx, hold.bib_id, hold.queue_position, now);
        }

        const promotedHoldId =
          hold.assigned_item_id === null
            ? null
            : await releaseSetAsideCopy(
                tx,
                { status: this.status, transfers: this.transfers, arrivals: this.arrivals },
                {
                  itemId: hold.assigned_item_id,
                  holdId: hold.id,
                  note: 'The request this copy was set aside for was cancelled.',
                  calendars: snapshot.calendars,
                  now,
                },
              );

        return { id: hold.id, releasedItemId: hold.assigned_item_id, promotedHoldId };
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'circulation.hold_cancelled',
      targetType: 'hold',
      targetId: out.id,
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // "Not until I'm back from Crete on the 3rd"
  // -------------------------------------------------------------------------

  /**
   * Suspend a request, keeping its place.
   *
   * A suspended hold KEEPS its queue position — it is a reader who is not ready,
   * not a reader who has left — and is skipped by `promoteForItem`. That skip is
   * what makes the hold that leaves the queue not the head, which is what breaks
   * the 1.0 blanket decrement, which is why this phase is a phase.
   *
   * CIVIL DATES, never instants: "back on the 3rd" is true in every zone, and an
   * instant makes it true at 02:00 in one and 23:00 in another.
   *
   * An ASSIGNED hold cannot be suspended. The copy is already off the shelf for
   * this reader — possibly on a van — and "keep my place but give the book to
   * somebody else" is two different requests. Cancel it, or collect it.
   */
  async suspend(
    tenant: TenantContext,
    actor: TenantActor,
    input: { readonly holdId: string; readonly until?: string | null },
  ): Promise<{ id: string; suspendedFrom: string; suspendedUntil: string | null }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const probe = await client.hold.findUnique({
      where: { id: input.holdId },
      select: { id: true, bibId: true, patronId: true, pickupBranchId: true, policySnapshot: true },
    });
    if (probe === null) throw new NotFoundException('No such hold.');
    const pinned = readPinnedHoldPolicy(probe.id, probe.policySnapshot);
    const from = civilToday(now, pinned.timezone);
    const until = input.until ?? null;
    this.refuseBadSuspension(pinned.hold, pinned.timezone, from, until, now);

    const out = await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('patron', probe.patronId), lockKey('bib', probe.bibId)]);
        await setChangeActor(tx, changeActorOf(actor));

        const hold = await this.openHold(tx, input.holdId);
        if (hold.assigned_item_id !== null) {
          throw new CirculationRefusal(
            'holds.alreadyAssigned',
            'A copy has already been set aside for this request, so it cannot be suspended. ' +
              'Cancel it, or collect it.',
          );
        }
        await tx.$executeRaw`
          UPDATE lbr2.holds
             SET suspended_from = ${from}::date,
                 suspended_until = ${until}::date,
                 updated_at = ${now}
           WHERE id = ${hold.id}`;
        return { id: hold.id, suspendedFrom: from, suspendedUntil: until };
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'circulation.hold_suspended',
      targetType: 'hold',
      targetId: out.id,
    });
    return out;
  }

  /** Back in the running, in the place they never lost. */
  async resume(
    tenant: TenantContext,
    actor: TenantActor,
    input: { readonly holdId: string },
  ): Promise<{ id: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const probe = await client.hold.findUnique({
      where: { id: input.holdId },
      select: { id: true, bibId: true, patronId: true },
    });
    if (probe === null) throw new NotFoundException('No such hold.');

    await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('patron', probe.patronId), lockKey('bib', probe.bibId)]);
        await setChangeActor(tx, changeActorOf(actor));
        await this.openHold(tx, input.holdId);
        await tx.$executeRaw`
          UPDATE lbr2.holds
             SET suspended_from = NULL, suspended_until = NULL, updated_at = ${now}
           WHERE id = ${input.holdId}`;
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'circulation.hold_resumed',
      targetType: 'hold',
      targetId: probe.id,
    });
    return { id: probe.id };
  }

  /**
   * The librarian's thumb on the scale.
   *
   * Changes the ORDER without renumbering anybody: the queue is read
   * `priority DESC, queue_position ASC`, so raising one request moves it to the
   * front and leaves every position contiguous and 1-based. The alternative —
   * renumbering — makes contiguity a property of every mutation that touches the
   * queue instead of a property of one column, and it is how a "move to top"
   * button turns into a rebalance bug.
   */
  async prioritise(
    tenant: TenantContext,
    actor: TenantActor,
    input: { readonly holdId: string; readonly priority: number },
  ): Promise<{ id: string; priority: number }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const probe = await client.hold.findUnique({
      where: { id: input.holdId },
      select: { id: true, bibId: true, patronId: true },
    });
    if (probe === null) throw new NotFoundException('No such hold.');

    await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('patron', probe.patronId), lockKey('bib', probe.bibId)]);
        await setChangeActor(tx, changeActorOf(actor));
        await this.openHold(tx, input.holdId);
        await tx.hold.update({
          where: { id: input.holdId },
          data: { priority: input.priority, updatedAt: now },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'circulation.hold_prioritised',
      targetType: 'hold',
      targetId: probe.id,
    });
    return { id: probe.id, priority: input.priority };
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /** "Zorba, any edition." See `hold-groups.ts` for what a group actually is. */
  async createGroup(
    tenant: TenantContext,
    actor: TenantActor,
    input: { readonly patronId: string; readonly name?: string },
  ): Promise<{ id: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const group = await client.holdGroup.create({
      data: {
        patronId: input.patronId,
        name: input.name ?? null,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    await this.audit.record(tenant, actor, {
      action: 'circulation.hold_group_created',
      targetType: 'hold_group',
      targetId: group.id,
    });
    return group;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** One reader's requests, newest first, with where each one stands. */
  async forPatron(
    tenant: TenantContext,
    patronId: string,
    includeClosed = false,
  ): Promise<HoldSummary[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.hold.findMany({
      where: {
        patronId,
        ...(includeClosed ? {} : { fulfilledAt: null, cancelledAt: null, expiredAt: null }),
      },
      orderBy: [{ placedAt: 'desc' }],
      take: 200,
      select: HOLD_SUMMARY,
    });
    return rows.map(toSummary);
  }

  /** The queue for one record, in the order it will actually be served. */
  async queueFor(tenant: TenantContext, bibId: string): Promise<HoldSummary[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.hold.findMany({
      where: { bibId, fulfilledAt: null, cancelledAt: null, expiredAt: null },
      orderBy: [{ priority: 'desc' }, { queuePosition: 'asc' }, { placedAt: 'asc' }],
      take: 500,
      select: HOLD_SUMMARY,
    });
    return rows.map(toSummary);
  }

  // -------------------------------------------------------------------------

  /**
   * The reader and the record, OUTSIDE the transaction.
   *
   * Step one of probe-lock-re-verify: a card barcode does not carry a patron id
   * and an item barcode does not carry a bib id, and both are lock keys that must
   * be taken before any read that matters.
   */
  private async probe(
    tx: TxV2,
    input: PlaceHoldInput,
  ): Promise<{ patronId: string; bibId: string }> {
    const patronId =
      input.patronId ??
      (
        await tx.$queryRaw<{ effective_patron_id: string }[]>`
          -- COALESCE unqualified: it is a SQL CONSTRUCT and not a function, so
          -- pg_catalog.coalesce(...) raises 42883. ONE hop through
          -- merged_into_id, which lbr2_patrons_merge_one_hop makes sufficient.
          SELECT COALESCE(s.id, p.id) AS effective_patron_id
            FROM lbr2.patron_cards c
            JOIN lbr2.patrons p ON p.id = c.patron_id
            LEFT JOIN lbr2.patrons s ON s.id = p.merged_into_id
           WHERE c.barcode_norm = ${normaliseBarcode(input.patronBarcode ?? '')}
             AND c.retired_at IS NULL
           LIMIT 1`
      )[0]?.effective_patron_id;
    if (patronId === undefined) throw new NotFoundException('No reader with that card.');

    if (input.bibId !== undefined) return { patronId, bibId: input.bibId };
    if (input.itemId !== undefined) {
      const item = await tx.item.findUnique({
        where: { id: input.itemId },
        select: { bibId: true },
      });
      if (item === null) throw new NotFoundException('No such copy.');
      return { patronId, bibId: item.bibId };
    }
    throw new NotFoundException('A request has to name a record or a copy.');
  }

  /** The hold, refusing one that has already ended. Raw, so it is one read. */
  private async openHold(
    tx: TxV2,
    holdId: string,
  ): Promise<{
    id: string;
    bib_id: string;
    queue_position: number | null;
    assigned_item_id: string | null;
  }> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        bib_id: string;
        queue_position: number | null;
        assigned_item_id: string | null;
      }[]
    >`
      SELECT id, bib_id, queue_position, assigned_item_id
        FROM lbr2.holds
       WHERE id = ${holdId}
         AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`;
    const hold = rows[0];
    if (hold === undefined) {
      throw new CirculationRefusal(
        'holds.alreadyClosed',
        'That request has already been collected, cancelled or expired.',
      );
    }
    return hold;
  }

  private async assertGroup(tx: TxV2, groupId: string, patronId: string): Promise<void> {
    const group = await tx.holdGroup.findUnique({
      where: { id: groupId },
      select: { id: true, patronId: true, resolvedAt: true },
    });
    if (group === null) throw new NotFoundException('No such hold group.');
    // A group belongs to ONE reader. Without this, a group id typed into the
    // wrong field would cancel a different reader's requests the moment this one
    // collected a book.
    if (group.patronId !== patronId) {
      throw new CirculationRefusal(
        'holds.groupBelongsToAnotherReader',
        'That group belongs to a different reader.',
      );
    }
    if (group.resolvedAt !== null) {
      throw new CirculationRefusal(
        'holds.groupResolved',
        'That group has already been filled. Start a new one.',
      );
    }
  }

  /**
   * May this request be suspended, and until when?
   *
   * SHARED BY `place` AND `suspend`, and the sharing is the point. `suspend`
   * enforced `suspensionAllowed`, the maximum and the past-date rule from the
   * day it was written; `place` accepted the same field from the same DTO and
   * wrote it straight into the row. So a reader could not suspend a request the
   * policy forbade — unless they suspended it AS they placed it, which is one
   * checkbox on the same form. And a date in the past went to the database and
   * came back as a `23514` on `holds_suspension_window`, which reaches a
   * librarian as a 500 with no sentence in it.
   *
   * Two surfaces enforcing one policy differently is the shape this repository
   * has already paid for twice, so there is one function and both call it.
   */
  private refuseBadSuspension(
    policy: HoldPolicy,
    timezone: string,
    from: string,
    until: string | null,
    now: Date,
  ): void {
    if (!policy.suspensionAllowed) {
      throw new CirculationRefusal(
        'holds.suspensionNotAllowed',
        'The policy this request was placed under does not allow it to be suspended.',
      );
    }
    if (until === null) return;
    if (until < from) {
      throw new CirculationRefusal(
        'holds.suspensionEndsInThePast',
        'A suspension cannot end before it starts.',
        { from, until },
      );
    }
    if (policy.maxSuspension !== null) {
      const cap = civilToday(addDuration(timezone, now, policy.maxSuspension, null), timezone);
      if (until > cap) {
        throw new CirculationRefusal(
          'holds.suspensionTooLong',
          `This policy allows a suspension of at most ${policy.maxSuspension.value} ` +
            `${policy.maxSuspension.unit}, which ends on ${cap}.`,
          { requested: until, latest: cap },
        );
      }
    }
  }

  /** Facts, not policy — the same refusals a checkout makes, for the same reason. */
  private refusePatronState(
    patron: { status: string; archivedAt: Date | null; expiresAt: Date | null },
    at: Date,
  ): void {
    if (patron.archivedAt !== null) {
      throw new CirculationRefusal('circulation.patronArchived', 'That reader has been archived.');
    }
    if (patron.status !== 'active') {
      throw new CirculationRefusal(
        'circulation.patronNotActive',
        `That reader's account is ${patron.status}.`,
      );
    }
    // An expired card may not place a request, for the same reason it may not
    // borrow — and it is refused HERE rather than as a policy block because
    // `packages/circ-policy` asserts the absence of `CARD_EXPIRED` by name: an
    // expiry is account state, not a comparison against a policy value.
    if (patron.expiresAt !== null && patron.expiresAt <= at) {
      throw new CirculationRefusal(
        'circulation.cardExpired',
        `That reader's card expired on ${patron.expiresAt.toISOString().slice(0, 10)}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

export const HOLD_SUMMARY = {
  id: true,
  bibId: true,
  level: true,
  itemId: true,
  volume: true,
  patronId: true,
  requestType: true,
  pickupBranchId: true,
  queuePosition: true,
  priority: true,
  assignedItemId: true,
  assignedAt: true,
  awaitingPickupSince: true,
  shelfExpiresAt: true,
  suspendedFrom: true,
  suspendedUntil: true,
  requestExpiresAt: true,
  fulfilledAt: true,
  cancelledAt: true,
  cancelledReason: true,
  expiredAt: true,
  expiredKind: true,
  groupId: true,
  placedAt: true,
} as const;

/**
 * One request, as every hold surface reports it.
 *
 * WRITTEN OUT rather than inferred from the Prisma select, and that is forced:
 * an inferred return type names `HoldLevel` and `HoldRequestType` from inside
 * `.prisma/tenant-v2-client`, which `tsc` refuses as unportable — and rightly,
 * because that path is a generated artefact and not a contract. The enums cross
 * this boundary as strings, which is also what the OPAC, SIP2 and the offline
 * core will read them as.
 */
export type HoldSummary = {
  readonly id: string;
  readonly bibId: string;
  readonly level: string;
  readonly itemId: string | null;
  readonly volume: string | null;
  readonly patronId: string;
  readonly requestType: string;
  readonly pickupBranchId: string;
  readonly queuePosition: number | null;
  readonly priority: number;
  readonly assignedItemId: string | null;
  readonly assignedAt: Date | null;
  readonly awaitingPickupSince: Date | null;
  readonly shelfExpiresAt: Date | null;
  readonly suspendedFrom: Date | null;
  readonly suspendedUntil: Date | null;
  readonly requestExpiresAt: Date | null;
  readonly fulfilledAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancelledReason: string | null;
  readonly expiredAt: Date | null;
  readonly expiredKind: string | null;
  readonly groupId: string | null;
  readonly placedAt: Date;
};

function toSummary(row: {
  id: string;
  bibId: string;
  level: unknown;
  itemId: string | null;
  volume: string | null;
  patronId: string;
  requestType: unknown;
  pickupBranchId: string;
  queuePosition: number | null;
  priority: number;
  assignedItemId: string | null;
  assignedAt: Date | null;
  awaitingPickupSince: Date | null;
  shelfExpiresAt: Date | null;
  suspendedFrom: Date | null;
  suspendedUntil: Date | null;
  requestExpiresAt: Date | null;
  fulfilledAt: Date | null;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  expiredAt: Date | null;
  expiredKind: string | null;
  groupId: string | null;
  placedAt: Date;
}): HoldSummary {
  return { ...row, level: String(row.level), requestType: String(row.requestType) };
}

type Channel = 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';

export type PlaceHoldInput = {
  readonly patronId?: string;
  readonly patronBarcode?: string;
  readonly bibId?: string;
  readonly itemId?: string;
  readonly level?: 'title' | 'volume' | 'item';
  readonly volume?: string;
  readonly pickupBranchId: string;
  readonly requestType?: 'page' | 'hold' | 'recall';
  readonly priority?: number;
  /** `YYYY-MM-DD`. A reader who is not ready yet, keeping their place. */
  readonly suspendedUntil?: string;
  readonly groupId?: string;
  readonly notes?: string;
  readonly source?: Channel;
};

export type PlacedHold = {
  readonly id: string;
  readonly bibId: string;
  readonly patronId: string;
  readonly level: 'title' | 'volume' | 'item';
  readonly pickupBranchId: string;
  readonly queuePosition: number;
  readonly requestExpiresAt: string | null;
  readonly appliedRuleId: string;
  readonly snapshotVersion: number;
  readonly warnings: readonly Block[];
};

/**
 * When an UNFILLED request gives up.
 *
 * A reader who asked for a book the library has since withdrawn should not wait
 * for ever, and the copy-side answer — the shelf expiry — cannot help, because
 * a request that is never filled never reaches a shelf. Null when the policy
 * names no expiry, which is a library that would rather a librarian looked at
 * the list than have requests disappear on a schedule.
 */
function unfilledExpiryFor(policy: HoldPolicy, from: Date, timezone: string): Date | null {
  if (policy.unfilledRequestExpiry === null) return null;
  return addDuration(timezone, from, policy.unfilledRequestExpiry, null);
}

/**
 * A civil `YYYY-MM-DD` as the value a `@db.Date` column wants.
 *
 * Midnight UTC, deliberately. Postgres `date` carries no zone, and Prisma sends
 * a `DateTime` as an instant — so a value built at local midnight in Athens is
 * `21:00Z the previous day` and lands one day early. Every civil date in this
 * file goes through here, and none is built with `new Date(y, m, d)`.
 */
function civilDate(civil: string): Date {
  return new Date(`${civil}T00:00:00.000Z`);
}

/** `holds_one_live_per_patron_bib`, translated. */
function alreadyHolding(err: unknown): ConflictException | null {
  if ((err as { code?: string } | null)?.code !== 'P2002') return null;
  return new ConflictException(
    'That reader already has a live request for this record. A second is a mistake at a desk, ' +
      'not a second place in the queue.',
  );
}

/** The patron card fold, matching `PatronsService` and `CheckoutService`. */
function normaliseBarcode(barcode: string): string {
  return foldGreek(barcode.replace(/\s+/g, '')).toUpperCase();
}
