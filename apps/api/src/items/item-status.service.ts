import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';

/**
 * THE SINGLE WRITER of `items.status` and `items.current_branch_id`.
 *
 * §6 phase 15 states the criterion in one line — "`items.status` is writable
 * through exactly one service (ESLint boundary rule + a grep gate). Every
 * transition writes history." Both halves are here, and the reason they are one
 * claim rather than two is that the history is worthless if it can be bypassed:
 * a table that records 95% of transitions answers "what happened to this copy?"
 * with something that looks like an answer and is not.
 *
 * ## Why this is not enforceable in the database
 *
 * There is no trigger, grant or rule that expresses "only this TypeScript
 * function may issue this UPDATE". Every writer connects as the same role, and a
 * `BEFORE UPDATE` trigger can inspect the row but not the caller. A trigger COULD
 * write the history row itself — and that is the shape §4.2 chose for
 * `change_events`, on the argument that a forgotten `emit()` is invisible. It is
 * deliberately not the shape chosen here, for three reasons:
 *
 *   - A trigger sees the row, not the intent. `reason_id`, `note`, `cause_type`
 *     and `source` are the columns a librarian actually reads, and none of them
 *     is derivable from a status column changing.
 *   - A trigger would make every status write succeed, including the ones that
 *     should have gone through checkout and did not. The value of the boundary
 *     is that a stray `item.update({status})` FAILS REVIEW, not that it is
 *     silently repaired.
 *   - `change_events` already exists and already carries the row-level record.
 *     A second trigger writing a second row-level record would be a second,
 *     divergent answer to the same question.
 *
 * So the boundary is `check:item-status-writer` plus an ESLint
 * `no-restricted-syntax` block, and this docblock is the argument they cite.
 *
 * ## The lock, and why there is no `SELECT … FOR UPDATE`
 *
 * A transition is read-then-write — the history row names the status the copy
 * was in — so two concurrent transitions must not interleave, or the second one
 * records a `from_status` that was never true. The exclusion is an ADVISORY lock
 * taken as the first statement of the transaction, per `platform/locks.ts`.
 *
 * It is NOT `SELECT … FOR UPDATE` on `items`, and that is the phase-14 finding
 * applied rather than rediscovered: `item_status_history` foreign-keys to
 * `items`, so inserting the history row takes `FOR KEY SHARE` on the same item
 * row, and a concurrent transaction holding `FOR UPDATE` on it blocks that
 * insert. Measured on `patrons` in phase 14, the equivalent shape gave 0/20
 * desk commits and zero loans written. An advisory lock does not join the
 * row-lock graph at all.
 */
@Injectable()
export class ItemStatusService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
  ) {}

  /**
   * Move a copy, in its own transaction.
   *
   * The desk path: mark missing, mark found, withdraw, put in process. Phase 16
   * uses {@link applyWithin} instead, because a checkout's status change and its
   * loan row must commit together or neither.
   */
  async transition(
    tenant: TenantContext,
    actor: TenantActor,
    input: TransitionInput,
  ): Promise<TransitionResult> {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('item', input.itemId)]);
        await setChangeActor(tx, changeActorOf(actor));
        return this.applyWithin(tx, {
          ...input,
          actorUserId: input.actorUserId ?? actor.userId ?? null,
        });
      },
      // ReadCommitted, pinned. RepeatableRead turns every concurrent transition
      // on the same copy into `40001 could not serialize access` — measured at
      // 94.8% failure on the phase-14 counter, which is the same shape.
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Move a copy inside a transaction the caller owns.
   *
   * THE CALLER MUST ALREADY HOLD `lockKey('item', itemId)`, taken as the first
   * statement of that transaction. Taking it here would be taking it after the
   * caller's own reads, which `platform/locks.ts` measured to be exactly the
   * protection of no lock at all — both writers complete before either lock is
   * requested.
   *
   * Returns the history row it wrote, or `null` when the copy is already exactly
   * where the caller wants it. A no-op is NOT an error: a checkin that finds an
   * item already `available` at this branch has nothing to record, and
   * `item_status_history_is_a_change` would refuse the row anyway.
   */
  async applyWithin(tx: TxV2, input: TransitionInput): Promise<TransitionResult> {
    const before = await tx.item.findUnique({
      where: { id: input.itemId },
      select: { id: true, status: true, currentBranchId: true },
    });
    if (before === null) throw new NotFoundException('No such copy.');

    const toStatus = input.toStatus ?? before.status;
    const toBranchId = input.toBranchId ?? before.currentBranchId;
    const now = input.now ?? this.clock.now();

    if (toStatus === before.status && toBranchId === before.currentBranchId) {
      return { itemId: before.id, changed: false, historyId: null, fromStatus: before.status };
    }

    await tx.item.update({
      where: { id: input.itemId },
      data: {
        status: toStatus,
        currentBranchId: toBranchId,
        // Only when the STATUS moved. A float changes where a copy is and not
        // what it is, and advancing `status_since` on it would make "how long
        // has this been missing?" answer "since it was moved".
        ...(toStatus === before.status ? {} : { statusSince: now }),
        statusReasonId: input.reasonId ?? null,
        updatedAt: now,
      },
    });

    const history = await tx.itemStatusHistory.create({
      data: {
        itemId: input.itemId,
        fromStatus: before.status,
        toStatus,
        fromBranchId: before.currentBranchId,
        toBranchId,
        reasonId: input.reasonId ?? null,
        note: input.note ?? null,
        source: input.source ?? 'desk',
        causeType: input.causeType ?? null,
        causeId: input.causeId ?? null,
        occurredAt: now,
        actorUserId: input.actorUserId ?? null,
        deviceId: input.deviceId ?? null,
      },
      select: { id: true },
    });

    return {
      itemId: before.id,
      changed: true,
      historyId: history.id,
      fromStatus: before.status,
    };
  }

  /**
   * The first history row a copy has: its creation.
   *
   * `from_status` is NULL here and only here — there is no previous state to
   * name — and `item_status_history_is_a_change` accepts it because NULL IS
   * DISTINCT FROM any status. Written by `ItemsService.create` inside the same
   * transaction as the item, so a copy cannot exist with an empty history.
   */
  async recordCreation(tx: TxV2, input: CreationInput): Promise<void> {
    await tx.itemStatusHistory.create({
      data: {
        itemId: input.itemId,
        fromStatus: null,
        toStatus: input.status,
        fromBranchId: null,
        toBranchId: input.branchId,
        note: input.note ?? null,
        source: input.source ?? 'desk',
        occurredAt: input.now,
        actorUserId: input.actorUserId ?? null,
      },
      select: { id: true },
    });
  }

  // -------------------------------------------------------------------------
  // The reason vocabulary
  // -------------------------------------------------------------------------

  /**
   * Why a copy is in the state it is in — the library's own list.
   *
   * A REASON IS NOT A CODE. `items.not_for_loan_code`, `damaged_code` and
   * `lost_code` are CONDITION flags: they are read by the `is_shelf_available`
   * generated column, they change what a copy IS, and a copy can carry more than
   * one at once. A reason is the librarian's answer to "why did you do that?" —
   * one per transition, never read by a predicate, meaningful only beside the
   * status it explains. Those three vocabularies have no table anywhere in
   * `lbr2` and stay with phase 21, which already owns `override_reasons`.
   */
  async reasons(
    tenant: TenantContext,
    opts: { staffOnly?: boolean } = {},
  ): Promise<StatusReasonRow[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.itemStatusReason.findMany({
      where: { archivedAt: null, ...(opts.staffOnly === true ? { staffSelectable: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        nameI18n: true,
        appliesToStatuses: true,
        staffSelectable: true,
        sortOrder: true,
      },
    });
  }

  async createReason(
    tenant: TenantContext,
    actor: TenantActor,
    input: { code: string; name: string; staffSelectable?: boolean; sortOrder?: number },
  ): Promise<{ id: string }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    return client
      .$transaction(
        async (tx) => {
          await setChangeActor(tx, changeActorOf(actor));
          return tx.itemStatusReason.create({
            data: {
              // Uppercased here as well as CHECKed in the database. The CHECK is
              // what makes it true for phase 19's PL/pgSQL copy-forward, which
              // never runs through this service.
              code: input.code.trim().toUpperCase(),
              name: input.name,
              staffSelectable: input.staffSelectable ?? true,
              sortOrder: input.sortOrder ?? 0,
              createdAt: now,
              updatedAt: now,
            },
            select: { id: true },
          });
        },
        { isolationLevel: 'ReadCommitted' },
      )
      .catch((err: unknown) => {
        if ((err as { code?: string } | null)?.code === 'P2002') {
          throw new ConflictException('A reason with that code already exists.');
        }
        throw err;
      });
  }

  /** What has happened to this copy, most recent first. */
  async history(tenant: TenantContext, itemId: string, take = 100): Promise<HistoryRow[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.itemStatusHistory.findMany({
      where: { itemId },
      // The index is `(item_id, occurred_at)`; a descending read of it is a
      // backwards index scan, not a sort.
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        fromBranchId: true,
        toBranchId: true,
        reasonId: true,
        note: true,
        source: true,
        causeType: true,
        causeId: true,
        occurredAt: true,
        actorUserId: true,
      },
    });
  }
}

export type ItemStatusValue =
  'available' | 'on_loan' | 'in_transit' | 'awaiting_pickup' | 'in_process' | 'missing';

export type TransitionInput = {
  readonly itemId: string;
  /** Omit to leave the status alone — a pure branch move, which a float is. */
  readonly toStatus?: ItemStatusValue;
  /** Omit to leave the place alone. */
  readonly toBranchId?: string;
  readonly reasonId?: string | null;
  readonly note?: string | null;
  readonly source?: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
  /** The loan, transfer or hold behind it. Both or neither — a CHECK says so. */
  readonly causeType?: string;
  readonly causeId?: string;
  readonly actorUserId?: string | null;
  readonly deviceId?: string | null;
  readonly now?: Date;
};

export type TransitionResult = {
  readonly itemId: string;
  readonly changed: boolean;
  readonly historyId: string | null;
  readonly fromStatus: ItemStatusValue;
};

export type CreationInput = {
  readonly itemId: string;
  readonly status: ItemStatusValue;
  readonly branchId: string;
  readonly note?: string | null;
  readonly source?: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
  readonly actorUserId?: string | null;
  readonly now: Date;
};

/**
 * Annotated rather than inferred, and not for style: Prisma's generated
 * `ItemStatus` and `JsonValue` live under `node_modules/.prisma/...`, so an
 * inferred return type here is `TS2883 — cannot be named without a reference`
 * and the build fails. Restating the shape is what keeps the generated client
 * an implementation detail of this file rather than of every caller.
 */
export type StatusReasonRow = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Per-locale display names. Opaque here; the UI reads it by locale key. */
  readonly nameI18n: unknown;
  readonly appliesToStatuses: readonly ItemStatusValue[];
  readonly staffSelectable: boolean;
  readonly sortOrder: number;
};

export type HistoryRow = {
  readonly id: string;
  readonly fromStatus: ItemStatusValue | null;
  readonly toStatus: ItemStatusValue;
  readonly fromBranchId: string | null;
  readonly toBranchId: string | null;
  readonly reasonId: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly causeType: string | null;
  readonly causeId: string | null;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
};
