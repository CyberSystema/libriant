import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  computeRenewalDueDate,
  evaluateBlocks,
  renewalTooEarly,
  type Block,
  type Calendar,
} from '@libriant/circ-policy';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { PolicySnapshotService } from '../policy/policy-snapshot.service.js';
import { civilToday, hasOutstandingHoldOn } from './circulation-state.js';
import { readPinnedPolicy } from '@libriant/circ-policy';
import { CirculationBlockedError, CirculationRefusal, clampEffective } from './refusals.js';
import { lookupReplay, recordClaim, requestHash } from './sync-replay.js';
import type { CirculationOrigin, RenewResult } from './circulation.types.js';
import type { DeviceClaim } from './sync-replay.js';

/**
 * Extending a loan — one, several, or every loan a reader has.
 *
 * ## The renewal is priced from the FROZEN policy, and that is the acceptance
 * ## criterion, not a nicety
 *
 * "Policy resolved once and frozen; editing a rule afterwards provably does not
 * change an open loan's due date or fine." A renewal is where that is easiest to
 * get wrong: the obvious implementation resolves the policy again — the rule
 * matrix is right there, the snapshot is cached, and it costs nothing — and a
 * library that shortened its loan period this morning would silently re-price
 * every renewal of every book lent under the old terms.
 *
 * So `RenewService` never calls `resolveCirculationPolicy`. It reads
 * `loans.policy_snapshot` through `readPinnedPolicy`, which REFUSES a snapshot
 * it does not recognise rather than merging in a default — §4.1: "never fails
 * open to a default policy — a wrong loan period is a wrong receipt."
 *
 * ## A renewal that moves the due date BACKWARDS is refused
 *
 * `renewFrom: 'currentDueDate'` on an overdue loan computes fourteen days from a
 * date already past, which can land before today. `loans_due_after_loaned` does
 * not catch it — the new due date is still after the original checkout — so a
 * librarian would "renew" a book and make it MORE overdue, with no error.
 *
 * It is refused at this layer rather than clamped in `packages/circ-policy`,
 * deliberately. `circulation-defaults.ts` records that 1.0's renewal base is
 * `max(dueAt, now)` and that "`renewFrom` has no value that means both"; a
 * silent clamp in the package would invent a third semantics nobody configured,
 * for every one of its eight consumers. Refusing names the problem to the person
 * who can fix it.
 *
 * ## Batch renewal is N transactions, not one
 *
 * "renew (single/batch/all)". One transaction holding N patron and item locks is
 * a transaction whose lock set grows with the reader's shelf, and a reader with
 * forty books would hold forty item locks while the desk waits. Each renewal is
 * its own transaction and its own row in the result; a block on the third does
 * not roll back the first two, which is also what a librarian expects — "these
 * four renewed, this one is on hold for somebody else" is a useful answer and
 * "nothing renewed" is not.
 */
@Injectable()
export class RenewService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
  ) {}

  /** One loan. */
  async renew(tenant: TenantContext, actor: TenantActor, input: RenewInput): Promise<RenewResult> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const effectiveAt = clampEffective(input.effectiveAt, now);

    const hash =
      input.device === undefined
        ? null
        : requestHash({
            operation: 'renew',
            fields: {
              loanId: input.loanId,
              // The CLAIMED instant, never the server-defaulted one — see
              // the note in `sync-replay.ts` and in the two siblings.
              claimedEffectiveAt: input.effectiveAt?.toISOString() ?? null,
            },
          });
    if (input.device !== undefined && hash !== null) {
      const seen = await lookupReplay(client as unknown as TxV2, input.device, hash);
      if (seen.kind === 'replay') return { ...(seen.response as RenewResult), replayed: true };
    }

    const probe = await client.loan.findUnique({
      where: { id: input.loanId },
      select: { id: true, patronId: true, itemId: true, closedAt: true },
    });
    if (probe === null) throw new NotFoundException('No such loan.');
    if (probe.closedAt !== null) {
      throw new CirculationRefusal(
        'circulation.loanClosed',
        'That loan is closed. A returned book cannot be renewed.',
      );
    }
    const snapshot = await this.snapshots.get(tenant);

    const outcome = await client.$transaction(
      async (tx) => {
        await acquireLocks(tx, [
          ...(probe.patronId === null ? [] : [lockKey('patron', probe.patronId)]),
          lockKey('item', probe.itemId),
        ]);
        await setChangeActor(
          tx,
          changeActorOf(
            actor,
            input.device?.deviceId ?? null,
            input.device?.clientChangeId ?? null,
          ),
        );

        const loan = await tx.loan.findUnique({
          where: { id: input.loanId },
          select: {
            id: true,
            itemId: true,
            patronId: true,
            dueAt: true,
            loanedAt: true,
            closedAt: true,
            renewalCount: true,
            checkoutBranchId: true,
            bibId: true,
            policySnapshot: true,
          },
        });
        if (loan === null || loan.closedAt !== null) {
          throw new CirculationRefusal(
            'circulation.raced',
            'That loan was closed at another station while you were working. Refresh and try again.',
          );
        }

        const pinned = readPinnedPolicy(loan.id, loan.policySnapshot);
        const resolved = {
          rule: { maxLoansForRule: null, maxHoldsForRule: null, ageRestrictionMinYears: null },
          loan: pinned.loan,
          overdueFine: pinned.overdueFine,
          lostItemFee: pinned.lostItemFee,
          categoryLimit: null,
        } as never;

        // IS SOMEBODY ELSE WAITING? The one fact a renewal reads out of phase
        // 17's `holds`, and it decides two different things: whether the
        // renewal is refused at all (`renewWithOutstandingHolds`) and, when it
        // is allowed, whether it is shortened
        // (`alternateRenewalPeriodWithHolds`). Phase 16 left it undefined and
        // said so; this is the field being filled rather than the file being
        // rewritten.
        const hasOutstandingHold = await hasOutstandingHoldOn(tx, {
          bibId: loan.bibId,
          excludePatronId: loan.patronId,
          today: civilToday(effectiveAt, pinned.timezone),
        });

        // Only the renewal half of the block set. A renewal does not re-check
        // the loan ceiling — the reader already HAS this book, and refusing to
        // extend it because they are at their limit would mean the only way out
        // of the limit is to return something, which is a rule no library has.
        const computed: Block[] = [
          ...evaluateBlocks(
            resolved,
            { renewalCount: loan.renewalCount, hasOutstandingHold },
            'renewal',
          ),
        ];
        const tooEarly = renewalTooEarly(resolved, loan.dueAt, effectiveAt);
        if (tooEarly !== null) computed.push(tooEarly);

        const blocking = computed.filter((b) => b.severity === 'block');
        if (blocking.length > 0) throw new CirculationBlockedError('renewal', blocking, computed);

        const calendar = calendarFor(snapshot.calendars, pinned.calendarId);
        const next = computeRenewalDueDate({
          policy: pinned.loan,
          calendar,
          from: effectiveAt,
          currentDueAt: loan.dueAt,
          hasOutstandingHold,
        });
        if (next.dueAt === null) {
          throw new CirculationRefusal(
            'circulation.indefiniteLoanUnsupported',
            'That loan policy is `indefinite` and has no due date to extend.',
          );
        }
        if (next.dueAt <= effectiveAt) {
          throw new CirculationRefusal(
            'circulation.renewalWouldNotExtend',
            'Renewing from the due date would make this book due before today. Change the loan ' +
              'policy to renew from today, or ask for an override.',
            { wouldBeDueAt: next.dueAt.toISOString(), effectiveAt: effectiveAt.toISOString() },
          );
        }

        const updated = await tx.loan.update({
          where: { id: loan.id },
          data: {
            dueAt: next.dueAt,
            renewalCount: { increment: 1 },
            updatedAt: now,
          },
          select: { renewalCount: true },
        });

        await tx.loanEvent.create({
          data: {
            loanId: loan.id,
            kind: 'renewed',
            occurredAt: now,
            effectiveAt,
            branchId: input.branchId ?? loan.checkoutBranchId,
            source: input.source ?? 'desk',
            actorUserId: actor.userId ?? null,
            deviceId: input.device?.deviceId ?? null,
            clientChangeId: input.device?.clientChangeId ?? null,
            dueAtBefore: loan.dueAt,
            dueAtAfter: next.dueAt,
            detail: { rolls: next.rolls } as never,
          },
          select: { id: true },
        });

        const result: RenewResult = {
          loanId: loan.id,
          itemId: loan.itemId,
          renewed: true,
          dueAtBefore: loan.dueAt.toISOString(),
          dueAtAfter: next.dueAt.toISOString(),
          renewalCount: updated.renewalCount,
          blocks: [],
          warnings: computed.filter((b) => b.severity === 'warn'),
          replayed: false,
        };

        if (input.device !== undefined && hash !== null) {
          await recordClaim(tx, input.device, hash, result);
        }
        return result;
      },
      { isolationLevel: 'ReadCommitted' },
    );

    await this.audit.record(tenant, actor, {
      action: 'circulation.renewed',
      targetType: 'loan',
      targetId: outcome.loanId,
    });
    return outcome;
  }

  /**
   * Several loans, or every open loan a reader has.
   *
   * N transactions, and a refusal on one does not roll back the others — see the
   * class docblock. The result is one row per loan with its own verdict, which
   * is the answer a desk can act on.
   */
  async renewMany(
    tenant: TenantContext,
    actor: TenantActor,
    input: RenewManyInput,
  ): Promise<readonly RenewOutcome[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const loanIds =
      input.loanIds ??
      (
        await client.loan.findMany({
          where: { patronId: input.patronId, closedAt: null },
          orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        })
      ).map((l) => l.id);

    const out: RenewOutcome[] = [];
    for (const loanId of loanIds) {
      try {
        out.push({
          loanId,
          ok: true,
          result: await this.renew(tenant, actor, { ...input, loanId }),
        });
      } catch (err) {
        out.push({
          loanId,
          ok: false,
          code: codeOf(err),
          message: err instanceof Error ? err.message : 'Renewal failed.',
          blocks: err instanceof CirculationBlockedError ? err.blocks : [],
        });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

export type RenewInput = CirculationOrigin & {
  readonly loanId: string;
  readonly branchId?: string;
  readonly device?: DeviceClaim;
};

export type RenewManyInput = CirculationOrigin & {
  /** One of the two. `patronId` means "everything this reader has out". */
  readonly loanIds?: readonly string[];
  readonly patronId?: string;
  readonly branchId?: string;
  readonly device?: DeviceClaim;
};

export type RenewOutcome =
  | { readonly loanId: string; readonly ok: true; readonly result: RenewResult }
  | {
      readonly loanId: string;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly blocks: readonly Block[];
    };

function codeOf(err: unknown): string {
  const response = (err as { getResponse?: () => unknown })?.getResponse?.();
  if (response !== null && typeof response === 'object' && 'code' in response) {
    return String((response as { code: unknown }).code);
  }
  return 'circulation.renewalFailed';
}

function calendarFor(
  calendars: Readonly<Record<string, Calendar>>,
  calendarId: string | null,
): Calendar {
  const found = calendarId === null ? undefined : calendars[calendarId];
  const fallback = found ?? Object.values(calendars)[0];
  if (fallback === undefined) {
    throw new CirculationRefusal(
      'circulation.noCalendar',
      'This library has no opening calendar, so a renewal date cannot be computed.',
    );
  }
  return fallback;
}
