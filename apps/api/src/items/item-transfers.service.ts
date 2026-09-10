import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { ItemStatusService } from './item-status.service.js';

/**
 * A copy on its way from one branch to another.
 *
 * §6 phase 15: "only one open transfer per item is possible." That is
 * `item_transfers_one_open_per_item`, a partial unique keyed on `WHERE
 * received_at IS NULL AND cancelled_at IS NULL` — see the migration for the
 * measurements that ruled out a status enum, of which the sharpest is that the
 * same query is an Index Scan written with a literal and a Seq Scan written the
 * way Prisma emits it.
 *
 * ## Where the copy is while it is in the van
 *
 * `items.current_branch_id` stays at the SOURCE for the whole open transfer, and
 * flips at RECEIPT, in the same transaction that stamps `received_at`. That is
 * forced rather than tidy: `items_shelf_order_idx` is `(current_branch_id,
 * call_number_sort, id)` — the shelf list at a branch — so flipping at send
 * would put the copy on the destination's shelf list while it is on a van, and
 * a librarian would walk to a shelf to fetch a book that is not in the building.
 * Availability would not catch it either, because `is_shelf_available` requires
 * `status = 'available'` and `in_transit` fails that.
 *
 * Both the send and the receipt go through `ItemStatusService`, like every other
 * status change in the system: the transit desk is not an exception to the
 * single-writer rule, it is the reason the rule needs a `cause_type`.
 *
 * ## What phase 23 adds and this does not pre-empt
 *
 * Routing — deciding WHICH branch a returned copy should go to — is phase 23's,
 * and it reads `floating_rules`, which is deferred to that phase with its
 * reasons in `BASELINE-SCOPE.json`. This service moves a copy where a librarian
 * or a hold says to. It never decides.
 */
@Injectable()
export class ItemTransfersService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
  ) {}

  /**
   * Send a copy to another branch.
   *
   * The copy goes `in_transit` and STAYS at the source branch — see the class
   * docblock. A second send while one is open is a 409 from the partial unique
   * rather than a silently second row, which is the state that makes a transit
   * list unreadable.
   */
  async send(
    tenant: TenantContext,
    actor: TenantActor,
    input: SendInput,
  ): Promise<{ id: string; fromBranchId: string; toBranchId: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const created = await client
      .$transaction(
        async (tx) => {
          await acquireLocks(tx, [lockKey('item', input.itemId)]);
          await setChangeActor(tx, changeActorOf(actor));

          const item = await tx.item.findUnique({
            where: { id: input.itemId },
            select: { id: true, currentBranchId: true, archivedAt: true },
          });
          if (item === null || item.archivedAt !== null) {
            throw new NotFoundException('No such live copy.');
          }
          if (item.currentBranchId === input.toBranchId) {
            throw new ConflictException('That copy is already at that branch.');
          }

          const transfer = await tx.itemTransfer.create({
            data: {
              itemId: input.itemId,
              fromBranchId: item.currentBranchId,
              toBranchId: input.toBranchId,
              reasonId: input.reasonId ?? null,
              holdId: input.holdId ?? null,
              queuedAt: now,
              // Stamped here because the desk that scans a copy onto the van IS
              // sending it. A queued-but-not-sent row is what phase 23's
              // send-desk screen writes, and it leaves this NULL.
              sentAt: input.markSent === false ? null : now,
              sentByUserId: input.markSent === false ? null : (actor.userId ?? null),
              expectedBy: input.expectedBy ?? null,
              source: input.source ?? 'desk',
              deviceId: input.deviceId ?? null,
              note: input.note ?? null,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true, fromBranchId: true, toBranchId: true },
          });

          await this.status.applyWithin(tx, {
            itemId: input.itemId,
            toStatus: 'in_transit',
            // Deliberately NOT `toBranchId`. See the class docblock.
            reasonId: input.reasonId ?? null,
            note: input.note ?? null,
            source: input.source ?? 'desk',
            causeType: 'item_transfer',
            causeId: transfer.id,
            actorUserId: actor.userId ?? null,
            deviceId: input.deviceId ?? null,
            now,
          });

          return transfer;
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        throw alreadyOpen(err) ?? err;
      });

    await this.audit.record(tenant, actor, {
      action: 'item.transfer.sent',
      targetType: 'item',
      targetId: input.itemId,
    });
    return created;
  }

  /**
   * Receive a copy that has arrived.
   *
   * THE BRANCH FLIP HAPPENS HERE, in the same transaction as `received_at`, and
   * the copy becomes `available` again. If a hold pulled it, phase 17 will move
   * it on to `awaiting_pickup`; this phase does not know about holds and does not
   * pretend to.
   */
  async receive(
    tenant: TenantContext,
    actor: TenantActor,
    input: ReceiveInput,
  ): Promise<{ id: string; itemId: string; atBranchId: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const received = await client.$transaction(
      async (tx) => {
        const transfer = await tx.itemTransfer.findFirst({
          where: openTransferFor(input),
          select: { id: true, itemId: true, toBranchId: true },
        });
        if (transfer === null) {
          throw new NotFoundException('No open transfer for that copy.');
        }

        // AFTER the lookup, and that is a deliberate exception to
        // `platform/locks.ts`'s "first statement of the transaction": the lock
        // key is the item id, and when the caller identified the transfer by its
        // own id there is nothing to lock until we know which copy it is. The
        // read it follows is a read of `item_transfers`, not of the row the lock
        // protects, and the write below re-checks that the transfer is still
        // open.
        await acquireLocks(tx, [lockKey('item', transfer.itemId)]);
        await setChangeActor(tx, changeActorOf(actor));

        const closed = await tx.itemTransfer.updateMany({
          where: { id: transfer.id, receivedAt: null, cancelledAt: null },
          data: {
            receivedAt: now,
            receivedByUserId: actor.userId ?? null,
            updatedAt: now,
          },
        });
        if (closed.count === 0) {
          throw new ConflictException('That transfer was closed by somebody else.');
        }

        await this.status.applyWithin(tx, {
          itemId: transfer.itemId,
          toStatus: 'available',
          toBranchId: transfer.toBranchId,
          note: input.note ?? null,
          source: input.source ?? 'desk',
          causeType: 'item_transfer',
          causeId: transfer.id,
          actorUserId: actor.userId ?? null,
          deviceId: input.deviceId ?? null,
          now,
        });

        return { id: transfer.id, itemId: transfer.itemId, atBranchId: transfer.toBranchId };
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'item.transfer.received',
      targetType: 'item',
      targetId: received.itemId,
    });
    return received;
  }

  /**
   * Call a transfer off.
   *
   * The copy goes back to `available` AT THE BRANCH IT NEVER LEFT, which is why
   * this passes no `toBranchId`: `current_branch_id` was never moved, so there
   * is nothing to put back. That is the second thing the flip-at-receipt rule
   * buys, and it is the one that would be a data-repair job if the flip happened
   * at send.
   */
  async cancel(
    tenant: TenantContext,
    actor: TenantActor,
    input: CancelInput,
  ): Promise<{ id: string; itemId: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    const cancelled = await client.$transaction(
      async (tx) => {
        const transfer = await tx.itemTransfer.findFirst({
          where: openTransferFor(input),
          select: { id: true, itemId: true },
        });
        if (transfer === null) throw new NotFoundException('No open transfer for that copy.');

        await acquireLocks(tx, [lockKey('item', transfer.itemId)]);
        await setChangeActor(tx, changeActorOf(actor));

        const closed = await tx.itemTransfer.updateMany({
          where: { id: transfer.id, receivedAt: null, cancelledAt: null },
          data: {
            cancelledAt: now,
            cancelledByUserId: actor.userId ?? null,
            cancelledReason: input.reason,
            updatedAt: now,
          },
        });
        if (closed.count === 0) {
          throw new ConflictException('That transfer was closed by somebody else.');
        }

        await this.status.applyWithin(tx, {
          itemId: transfer.itemId,
          toStatus: 'available',
          note: input.reason,
          source: input.source ?? 'desk',
          causeType: 'item_transfer',
          causeId: transfer.id,
          actorUserId: actor.userId ?? null,
          now,
        });

        return { id: transfer.id, itemId: transfer.itemId };
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'item.transfer.cancelled',
      targetType: 'item',
      targetId: cancelled.itemId,
    });
    return cancelled;
  }

  /**
   * What is on its way to a branch and has not arrived.
   *
   * The predicate matches `item_transfers_inbound_open_idx` exactly, so this is
   * an Index Scan rather than a filter over every transfer the library has ever
   * made — which after five years is the whole table.
   */
  async inbound(tenant: TenantContext, branchId: string, take = 200) {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.itemTransfer.findMany({
      where: { toBranchId: branchId, receivedAt: null, cancelledAt: null },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(take, 1), 500),
      select: {
        id: true,
        itemId: true,
        fromBranchId: true,
        queuedAt: true,
        sentAt: true,
        expectedBy: true,
        holdId: true,
        note: true,
      },
    });
  }

  /** The open transfer for a copy, if there is one. At most one — by index. */
  async openFor(tenant: TenantContext, itemId: string) {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.itemTransfer.findFirst({
      where: { itemId, receivedAt: null, cancelledAt: null },
      select: {
        id: true,
        fromBranchId: true,
        toBranchId: true,
        queuedAt: true,
        sentAt: true,
        expectedBy: true,
        holdId: true,
      },
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * The transfer a receive or cancel means, by whichever handle the caller has.
 *
 * A transit desk scans a BARCODE and knows the item; a work-list screen has the
 * transfer id. Both resolve to the same row, and both carry the open predicate
 * so a re-scan of a copy already received says "no open transfer" instead of
 * closing a second one.
 */
function openTransferFor(input: { transferId?: string; itemId?: string }) {
  return {
    receivedAt: null,
    cancelledAt: null,
    ...(input.transferId === undefined ? {} : { id: input.transferId }),
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
  };
}

/** `item_transfers_one_open_per_item`, translated. */
function alreadyOpen(err: unknown): ConflictException | null {
  if ((err as { code?: string } | null)?.code !== 'P2002') return null;
  return new ConflictException(
    'That copy already has an open transfer. Receive or cancel it before sending the copy again.',
  );
}

// ---------------------------------------------------------------------------

type Channel = 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';

export type SendInput = {
  readonly itemId: string;
  readonly toBranchId: string;
  readonly reasonId?: string | null;
  /** Set when a hold pulled it. No FK — `holds` is phase 17. */
  readonly holdId?: string | null;
  readonly expectedBy?: Date | null;
  /** `false` queues it at the send desk without putting it in the van. */
  readonly markSent?: boolean;
  readonly note?: string | null;
  readonly source?: Channel;
  readonly deviceId?: string | null;
};

export type ReceiveInput = {
  readonly transferId?: string;
  readonly itemId?: string;
  readonly note?: string | null;
  readonly source?: Channel;
  readonly deviceId?: string | null;
};

export type CancelInput = {
  readonly transferId?: string;
  readonly itemId?: string;
  readonly reason: string;
  readonly source?: Channel;
};
