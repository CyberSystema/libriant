import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  computeDueDate,
  evaluateBlocks,
  resolveCirculationPolicy,
  type Block,
  type Calendar,
  type PolicySnapshot,
  type ResolvedPolicy,
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
import { PatronBlocksService } from '../patrons/patron-blocks.service.js';
import { ageBandAt } from './age-band.js';
import { countCirculationState } from './circulation-state.js';
import { pinPolicy } from './policy-pinning.js';
import { CirculationBlockedError, CirculationRefusal, clampEffective } from './refusals.js';
import { lookupReplay, recordClaim, requestHash, type DeviceClaim } from './sync-replay.js';
import type { CheckoutResult, CirculationOrigin } from './circulation.types.js';

/**
 * Lending a copy to a reader.
 *
 * ## The lock order, and the probe that makes it possible
 *
 * `patron:` then `item:`, sorted by `orderLocks` and taken in ONE statement.
 * Checkout is the easy direction — a desk scans a card and then a barcode, so it
 * knows both keys before it opens a transaction. Checkin is the hard one and
 * `platform/locks.ts` now carries the general rule for it.
 *
 * ## Everything the policy decides is decided ONCE, here
 *
 * §6's first acceptance criterion is that "editing a rule afterwards provably
 * does not change an open loan's due date or fine", and the mechanism is that
 * `resolveCirculationPolicy` runs exactly once and its answer is frozen into
 * `loans.policy_snapshot` by `policy-pinning.ts`. Nothing downstream — not the
 * checkin, not the renewal, not phase 18's accrual sweep — resolves again.
 *
 * The resolution itself costs NO statement: `PolicySnapshotService` serves the
 * whole matrix from a process cache, and phase 13 measured p99 0.042 ms over a
 * 500-rule snapshot. That is why a checkout can afford to resolve on the hot
 * path at all.
 *
 * ## Three kinds of refusal, and they are not interchangeable
 *
 *   STATE refusals — the copy is archived, already on loan, not in this library;
 *   the patron is archived, suspended, closed, merged away, or their card has
 *   expired. These are facts, they are not policy, and they are refused here
 *   rather than by `evaluateBlocks`. `packages/circ-policy` asserts that
 *   `CARD_EXPIRED` is absent from its vocabulary by name, and it is right to:
 *   an expiry is not a comparison against a policy value.
 *
 *   POLICY blocks — too many loans, too many overdues, the balance is over the
 *   limit. Computed by `evaluateBlocks` from counts this service supplies, and
 *   returned as a LIST rather than as the first hit, because a librarian who
 *   clears one block and hits the next has been made to do the same work twice.
 *
 *   WARNINGS — `severity: 'warn'`, which do not stop the loan and which travel
 *   back in the response so the desk can say them out loud.
 *
 * Overriding a block is phase 21's (`override_reasons`, `circulation_overrides`,
 * `override_permissions`), and the block objects already carry the permission
 * key an override will need. Phase 16 refuses; it does not offer a way past.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
    @Inject(PatronBlocksService) private readonly blocks: PatronBlocksService,
  ) {}

  async checkout(
    tenant: TenantContext,
    actor: TenantActor,
    input: CheckoutInput,
  ): Promise<CheckoutResult> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const effectiveAt = clampEffective(input.effectiveAt, now);

    // ---- the replay pre-flight, outside any transaction ---------------------
    //
    // One indexed read on the primary key. A replay stops here and never opens
    // a transaction, never takes a lock and never touches a patron or an item —
    // which is exactly what "re-applies nothing" asks for.
    const hash =
      input.device === undefined
        ? null
        : requestHash({
            operation: 'checkout',
            fields: {
              itemBarcode: input.itemBarcode ?? null,
              itemId: input.itemId ?? null,
              patronId: input.patronId ?? null,
              patronBarcode: input.patronBarcode ?? null,
              branchId: input.branchId ?? null,
              // The CLAIMED instant, not the resolved one. `effectiveAt`
              // defaults to the server clock when a caller gives none,
              // and hashing that would make every replay a mismatch —
              // which is exactly the rule `sync-replay.ts` states ("OUT:
              // the server's clock. It differs on every attempt by
              // definition") and exactly the bug the replay test found.
              claimedEffectiveAt: input.effectiveAt?.toISOString() ?? null,
            },
          });
    if (input.device !== undefined && hash !== null) {
      const seen = await lookupReplay(client as unknown as TxV2, input.device, hash);
      if (seen.kind === 'replay') {
        return { ...(seen.response as CheckoutResult), replayed: true };
      }
    }

    // ---- the probe ----------------------------------------------------------
    //
    // Outside the transaction and treated as a GUESS. Its only job is to learn
    // the two lock keys; every fact it reads is re-read under the locks below.
    const probe = await this.probe(client as unknown as TxV2, input);
    const snapshot = await this.snapshots.get(tenant);

    const outcome = await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [lockKey('patron', probe.patronId), lockKey('item', probe.itemId)]);
        await setChangeActor(
          tx,
          changeActorOf(
            actor,
            input.device?.deviceId ?? null,
            input.device?.clientChangeId ?? null,
          ),
        );

        const item = await tx.item.findUnique({
          where: { id: probe.itemId },
          select: {
            id: true,
            status: true,
            archivedAt: true,
            bibId: true,
            currentBranchId: true,
            owningBranchId: true,
            itemTypeId: true,
            temporaryItemTypeId: true,
            permanentLocationId: true,
            temporaryLocationId: true,
            replacementCostCents: true,
            notForLoanCode: true,
            withdrawnAt: true,
          },
        });
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

        // RE-VERIFY. The probe is a guess and this is what makes it safe: if the
        // copy or the reader moved between the probe and the locks, the answer
        // the caller would get is one computed from a world that no longer
        // exists.
        if (item === null || patron === null)
          throw new NotFoundException('No such copy or reader.');
        if (patron.mergedIntoId !== null) {
          throw new ConflictException(
            'That reader’s record was merged into another one while you were scanning. Scan the ' +
              'card again.',
          );
        }
        this.refuseOnState(item, patron, effectiveAt);

        const branch = await tx.branch.findUnique({
          where: { id: input.branchId ?? item.currentBranchId },
          select: { id: true, timezone: true, currency: true, calendarId: true },
        });
        if (branch === null) throw new NotFoundException('No such branch.');

        const itemTypeId = item.temporaryItemTypeId ?? item.itemTypeId;
        const resolved = resolveCirculationPolicy(snapshot, {
          patronCategoryId: patron.patronCategoryId,
          itemTypeId,
          owningBranchId: item.owningBranchId,
          shelvingLocationId: item.temporaryLocationId ?? item.permanentLocationId,
          checkoutBranchId: branch.id,
          at: effectiveAt,
        });

        const counted = await countCirculationState(tx, {
          patronId: patron.id,
          bibId: item.bibId,
          currency: branch.currency,
          at: effectiveAt,
          timezone: branch.timezone,
          patron: { dateOfBirth: patron.dateOfBirth },
        });
        // WITHIN the transaction, not through the tenant client. See
        // `PatronBlocksService.liveBlocksWithin`: the per-tenant pool is clamped
        // to one connection, so a nested read on the outer client waits for a
        // connection this very transaction is holding, and the symptom is a
        // 5,000 ms Prisma transaction timeout reported against the next
        // statement.
        const stored = await this.blocks.liveBlocksWithin(tx, patron.id);

        const computed = evaluateBlocks(resolved, counted, 'checkout');
        const all = mergeBlocks(stored, computed);
        const blocking = all.filter((b) => b.severity === 'block');
        if (blocking.length > 0) throw new CirculationBlockedError('checkout', blocking, all);

        const calendar = calendarFor(snapshot, branch.calendarId);
        const due = computeDueDate({
          policy: resolved.loan,
          calendar,
          from: effectiveAt,
          ...(resolved.loan.profile === 'fixed' && resolved.loan.fixedDueDateSetId !== null
            ? { fixedDueDateSet: snapshot.fixedDueDateSets[resolved.loan.fixedDueDateSetId] }
            : {}),
        });

        const pinned = pinPolicy({
          resolved,
          resolvedAt: now,
          branchId: branch.id,
          timezone: branch.timezone,
          calendarId: branch.calendarId,
          itemTypeId,
          patronCategoryId: patron.patronCategoryId,
          rolls: due.rolls,
        });

        const loan = await tx.loan.create({
          data: {
            itemId: item.id,
            patronId: patron.id,
            bibId: item.bibId,
            checkoutBranchId: branch.id,
            checkedOutByUserId: actor.userId ?? null,
            loanedAt: effectiveAt,
            // `indefinite` has no due date, and a sentinel far-future one would
            // be a lie some report eventually renders. The column is NOT NULL,
            // so an indefinite loan is refused here rather than fabricated.
            dueAt: requireDueDate(due.dueAt, resolved),
            originalDueAt: requireDueDate(due.dueAt, resolved),
            loanPolicyId: resolved.loan.id,
            overdueFinePolicyId: resolved.overdueFine.id,
            lostItemFeePolicyId: resolved.lostItemFee.id,
            appliedRuleId: resolved.trace.matchedRuleId,
            policySnapshot: pinned as never,
            itemTypeIdApplied: itemTypeId ?? '',
            patronCategoryIdApplied: patron.patronCategoryId ?? '',
            // The three buckets that survive anonymisation. `patron_age_band` is
            // the one that CANNOT be added later: it is derived from a date of
            // birth, and once `patron_id` is nulled on return there is no row
            // left to derive it from.
            patronCategoryCode: patron.patronCategoryId,
            patronAgeBand: ageBandAt(patron.dateOfBirth, effectiveAt, branch.timezone),
            patronHomeBranchId: patron.homeBranchId,
            source: input.source ?? 'desk',
            deviceId: input.device?.deviceId ?? null,
            clientChangeId: input.device?.clientChangeId ?? null,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true, dueAt: true },
        });

        await this.status.applyWithin(tx, {
          itemId: item.id,
          toStatus: 'on_loan',
          source: input.source ?? 'desk',
          causeType: 'loan',
          causeId: loan.id,
          actorUserId: actor.userId ?? null,
          deviceId: input.device?.deviceId ?? null,
          now,
          beforeReadUnderLock: {
            id: item.id,
            status: item.status,
            currentBranchId: item.currentBranchId,
          },
        });

        await tx.loanEvent.create({
          data: {
            loanId: loan.id,
            kind: 'checked_out',
            occurredAt: now,
            effectiveAt,
            branchId: branch.id,
            source: input.source ?? 'desk',
            actorUserId: actor.userId ?? null,
            deviceId: input.device?.deviceId ?? null,
            clientChangeId: input.device?.clientChangeId ?? null,
            dueAtAfter: loan.dueAt,
            detail: { snapshotVersion: resolved.trace.snapshotVersion } as never,
          },
          select: { id: true },
        });

        const result: CheckoutResult = {
          loanId: loan.id,
          itemId: item.id,
          patronId: patron.id,
          dueAt: loan.dueAt.toISOString(),
          appliedRuleId: resolved.trace.matchedRuleId,
          snapshotVersion: resolved.trace.snapshotVersion,
          rolls: due.rolls,
          warnings: all.filter((b) => b.severity === 'warn'),
          replayed: false,
        };

        if (input.device !== undefined && hash !== null) {
          await recordClaim(tx, input.device, hash, result);
        }
        return result;
      },
      // ReadCommitted, pinned. Every writer in phases 13-16 does, and the reason
      // is the phase-14 measurement: an `ON CONFLICT DO UPDATE` onto a
      // concurrently-updated row raises `40001` at RepeatableRead in 94.8% of
      // attempts, and a desk transaction that aborts is a librarian who cannot
      // lend a book.
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'circulation.checked_out',
      targetType: 'loan',
      targetId: outcome.loanId,
    });
    return outcome;
  }

  /**
   * Find the copy and the reader, OUTSIDE the transaction.
   *
   * This is step one of the probe-lock-verify rule `platform/locks.ts` records.
   * Its answers are guesses and are re-read under the locks; what it is FOR is
   * learning the two lock keys, which cannot be known from a barcode without a
   * query.
   */
  private async probe(
    tx: TxV2,
    input: CheckoutInput,
  ): Promise<{ itemId: string; patronId: string }> {
    const itemId =
      input.itemId ??
      (
        await tx.item.findFirst({
          where: { barcodeNorm: normaliseBarcode(input.itemBarcode ?? ''), archivedAt: null },
          select: { id: true },
        })
      )?.id;
    if (itemId === undefined) throw new NotFoundException('No copy with that barcode.');

    if (input.patronId !== undefined) return { itemId, patronId: input.patronId };

    // The card scan, ONE hop through `merged_into_id` — the shape
    // `PatronsService.resolveCard` measured at 12 buffers and 0.026 ms,
    // independent of depth, and correct because `lbr2_patrons_merge_one_hop`
    // makes a chain unreachable.
    const rows = await tx.$queryRaw<{ effective_patron_id: string }[]>`
      -- COALESCE unqualified, and it has to be: it is a SQL CONSTRUCT rather
      -- than a function, so pg_catalog.coalesce(...) is 42883 function does
      -- not exist. Same for NULLIF and CASE. (No backticks in this comment:
      -- one inside a SQL comment terminates the JS template literal it lives
      -- in, mid-statement -- the phase-14 trap.)
      SELECT COALESCE(s.id, p.id) AS effective_patron_id
        FROM lbr2.patron_cards c
        JOIN lbr2.patrons p ON p.id = c.patron_id
        LEFT JOIN lbr2.patrons s ON s.id = p.merged_into_id
       WHERE c.barcode_norm = ${normaliseBarcode(input.patronBarcode ?? '')}
         AND c.retired_at IS NULL
       LIMIT 1`;
    const patronId = rows[0]?.effective_patron_id;
    if (patronId === undefined) throw new NotFoundException('No reader with that card.');
    return { itemId, patronId };
  }

  /** The refusals that are facts about the world rather than policy. */
  private refuseOnState(
    item: {
      status: string;
      archivedAt: Date | null;
      withdrawnAt: Date | null;
      notForLoanCode: string | null;
    },
    patron: { status: string; archivedAt: Date | null; expiresAt: Date | null },
    at: Date,
  ): void {
    if (item.archivedAt !== null) {
      throw new CirculationRefusal('circulation.itemArchived', 'That copy has been archived.');
    }
    if (item.withdrawnAt !== null) {
      throw new CirculationRefusal('circulation.itemWithdrawn', 'That copy has been withdrawn.');
    }
    if (item.notForLoanCode !== null) {
      throw new CirculationRefusal(
        'circulation.itemNotForLoan',
        `That copy is flagged not-for-loan (${item.notForLoanCode}).`,
      );
    }
    if (item.status !== 'available') {
      throw new CirculationRefusal(
        'circulation.itemUnavailable',
        `That copy is ${item.status.replace('_', ' ')} and cannot be lent.`,
      );
    }
    if (patron.archivedAt !== null) {
      throw new CirculationRefusal('circulation.patronArchived', 'That reader has been archived.');
    }
    if (patron.status !== 'active') {
      throw new CirculationRefusal(
        'circulation.patronNotActive',
        `That reader's account is ${patron.status}.`,
      );
    }
    // Not a `CARD_EXPIRED` policy block: `packages/circ-policy` asserts the
    // absence of that code by name, and rightly — an expiry is account state,
    // not a comparison against a policy value. `patron_blocks.card_expired` is
    // what makes it visible in advance; this is what makes it true today, even
    // if the sweep has not run since the card lapsed this morning.
    if (patron.expiresAt !== null && patron.expiresAt <= at) {
      throw new CirculationRefusal(
        'circulation.cardExpired',
        `That reader's card expired on ${patron.expiresAt.toISOString().slice(0, 10)}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

export type CheckoutInput = CirculationOrigin & {
  readonly itemBarcode?: string;
  readonly itemId?: string;
  readonly patronBarcode?: string;
  readonly patronId?: string;
  /** Defaults to where the copy currently is. */
  readonly branchId?: string;
  readonly device?: DeviceClaim;
};

/**
 * The two block sources, composed.
 *
 * STORED blocks (`patron_blocks`, phase 14) and COMPUTED ones (`evaluateBlocks`)
 * are concatenated, and the stored one wins on a shared code. Two codes overlap
 * — `too_many_overdues` and `fine_limit_exceeded` — and they agree because both
 * read the same policy; when they do not, the stored one is the one a librarian
 * has seen on the screen and possibly acted on, so showing the computed one
 * instead would contradict something the desk already said out loud.
 */
function mergeBlocks(
  stored: readonly { code: string; severity: string; reason: string | null }[],
  computed: readonly Block[],
): readonly Block[] {
  const out: Block[] = stored.map((s) => ({
    code: s.code as Block['code'],
    severity: s.severity === 'warn' ? 'warn' : 'block',
    overridable: true,
    overridePermission: 'circ.checkout.override',
    ...(s.reason === null ? {} : { observed: s.reason }),
  }));
  const seen = new Set(out.map((b) => b.code.toLowerCase()));
  for (const c of computed) {
    if (!seen.has(c.code.toLowerCase())) out.push(c);
  }
  return out;
}

function calendarFor(snapshot: PolicySnapshot, calendarId: string | null): Calendar {
  if (calendarId !== null) {
    const found = snapshot.calendars[calendarId];
    if (found !== undefined) return found;
  }
  // The seeded always-open calendar. `circulation-defaults.ts` writes one for
  // every tenant from phase 16 onward, so `CALENDAR_NOT_DEFINED_FOR` is
  // unreachable at a desk — and if it somehow is not there, refusing loudly is
  // right: §4.1 says this package "never fails open to a default policy", and a
  // fabricated calendar is a default policy wearing a different name.
  const fallback = Object.values(snapshot.calendars)[0];
  if (fallback === undefined) {
    throw new CirculationRefusal(
      'circulation.noCalendar',
      'This library has no opening calendar, so a due date cannot be computed. Seed the ' +
        'circulation defaults, or give the branch a calendar.',
    );
  }
  return fallback;
}

function requireDueDate(dueAt: Date | null, resolved: ResolvedPolicy): Date {
  if (dueAt !== null) return dueAt;
  throw new CirculationRefusal(
    'circulation.indefiniteLoanUnsupported',
    `Loan policy ${resolved.loan.id} is \`indefinite\`, which has no due date. \`loans.due_at\` ` +
      'is NOT NULL and a sentinel far-future date would be a lie some report eventually renders. ' +
      'Phase 21 owns the staff/reference loan that needs this.',
  );
}

/** The item barcode fold, matching `ItemsService`. */
function normaliseBarcode(barcode: string): string {
  return foldGreek(barcode.replace(/\s+/g, '')).toUpperCase();
}
