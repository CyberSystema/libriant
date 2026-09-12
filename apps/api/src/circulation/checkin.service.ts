import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { accrueOverdue, PolicyResolutionError, type Calendar } from '@libriant/circ-policy';
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
import { HoldArrivalService } from '../holds/hold-arrival.service.js';
import { promoteForItem } from '../holds/hold-promotion.js';
import { settlePromotion } from '../holds/hold-settlement.js';
import { civilToday } from './circulation-state.js';
import { readPinnedPolicy } from '@libriant/circ-policy';
import { CirculationRefusal, clampEffective } from './refusals.js';
import { lookupReplay, recordClaim, requestHash } from './sync-replay.js';
import type { CheckinDisposition, CheckinResult, CirculationOrigin } from './circulation.types.js';
import type { ComputedFine } from './circulation.types.js';
import type { DeviceClaim } from './sync-replay.js';

/**
 * A copy comes back.
 *
 * ## THE LOCK ORDER IS THE HARD PART, and this is where phase 16 nearly shipped
 * ## a broken lock graph
 *
 * A checkin is keyed on an ITEM barcode. It cannot know the PATRON until it has
 * found the loan. So the natural implementation takes `item:` and then
 * `patron:` — which is the inversion of `LOCK_DOMAIN_RANK`, and it deadlocks
 * against checkout, which takes them the other way round. Measured on these
 * tables: the natural order produced 17 `40P01` in fifteen seconds, the first at
 * 1,165 ms.
 *
 * The fix is the general rule `platform/locks.ts` now records — PROBE, LOCK,
 * RE-VERIFY. The probe below reads the open loan to learn the patron id, the
 * locks are then taken sorted in one statement, and the loan is read AGAIN under
 * them. If the second read disagrees with the first, the world moved between
 * them and the checkin retries rather than proceeding on a stale answer. That
 * retry branch is exercised by a test, because otherwise it is untested code on
 * the hottest path in the building.
 *
 * ## A return is never refused
 *
 * Not for a block, not for an expired card, not because the fine could not be
 * worked out. A copy coming back onto the shelf is a fact about the world, and
 * making it conditional on an arithmetic question about money is the same
 * mistake 1.0 made by conflating `returned_at` with `closed_at`. When
 * `accrueOverdue` refuses — a calendar that does not reach this far is the
 * realistic case — the refusal is RECORDED on the `loan_event` as
 * `fine_error_code` and the copy is shelved. Phase 18's sweep retries it.
 *
 * ## The fine is priced against the FROZEN policy and the LIVE calendar
 *
 * `policy-pinning.ts` argues this at length and it is the one asymmetry in the
 * design: the policy is what the library DECIDED and re-pricing an open loan
 * against an edited rule is a false statement on a receipt, while the calendar
 * is what HAPPENED and a closure entered after the fact is a correction of the
 * record. `countClosedDays: false` exists precisely so a patron is not fined for
 * a day the door was locked.
 *
 * ## Reading history is anonymised HERE, in this transaction
 *
 * §3: "`loans.patron_id` is nulled and `anonymised_at` stamped in the same
 * transaction as the return … This is an IFLA/NISO professional obligation and
 * a Greek DPA answer, and it is a DEFAULT rather than a setting someone forgot
 * to turn on." Phase 14 created `reading_history_policy` and never read it,
 * recording that phase 16 owns the transaction. This is that transaction.
 *
 * The three statistical buckets survive, which is why `patron_age_band` had to
 * be computed at CHECKOUT: after this, there is no patron row to derive it from.
 */
@Injectable()
export class CheckinService {
  private readonly logger = new Logger(CheckinService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantClockService) private readonly clock: TenantClockService,
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
    @Inject(ItemStatusService) private readonly status: ItemStatusService,
    @Inject(ItemTransfersService) private readonly transfers: ItemTransfersService,
    @Inject(HoldArrivalService) private readonly arrivals: HoldArrivalService,
  ) {}

  async checkin(
    tenant: TenantContext,
    actor: TenantActor,
    input: CheckinInput,
  ): Promise<CheckinResult> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();
    const effectiveAt = clampEffective(input.effectiveAt, now);

    const hash =
      input.device === undefined
        ? null
        : requestHash({
            operation: 'checkin',
            fields: {
              itemBarcode: input.itemBarcode ?? null,
              itemId: input.itemId ?? null,
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
      if (seen.kind === 'replay') return { ...(seen.response as CheckinResult), replayed: true };
    }

    // ---- PROBE: which copy, and whose loan? --------------------------------
    const probe = await this.probe(client as unknown as TxV2, input);
    const snapshot = await this.snapshots.get(tenant);

    const outcome = await client.$transaction(
      async (tx) => {
        // Sorted, in one statement. `patron:` is absent when the loan has
        // already been anonymised or was never linked (`ReadingHistoryMode.none`)
        // — there is nothing to serialise against, and taking a lock on a null
        // would be taking a lock on the string "null".
        // patron < bib < item, sorted, in ONE statement. `bib:` joined the list
        // in phase 17 and it is not optional: the promotion below walks the
        // whole queue for this record and takes the first hold that can use the
        // copy, and `hold-promotion.ts` explains at length why that has to
        // serialise on the bib rather than on `FOR UPDATE SKIP LOCKED` —
        // skipping a LOCKED row is not skipping an INELIGIBLE one, so under
        // contention the queue would be served out of order, silently, only
        // under load.
        await acquireLocks(tx, [
          ...(probe.patronId === null ? [] : [lockKey('patron', probe.patronId)]),
          lockKey('bib', probe.bibId),
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

        // RE-VERIFY under the locks, joined so the copy costs no second read.
        const loan = await tx.loan.findFirst({
          where: { itemId: probe.itemId, closedAt: null },
          select: {
            id: true,
            patronId: true,
            dueAt: true,
            loanedAt: true,
            policySnapshot: true,
            renewalCount: true,
            item: {
              select: {
                id: true,
                bibId: true,
                enumeration: true,
                status: true,
                currentBranchId: true,
                owningBranchId: true,
                damagedCode: true,
                notForLoanCode: true,
                replacementCostCents: true,
              },
            },
          },
        });
        if (loan === null) {
          // No open loan. This is NOT an error at a return desk — a copy handed
          // back that nobody had out is the ordinary result of a book found on a
          // trolley — but it IS a state the desk must be told about, because the
          // alternative is silently shelving a copy the system thinks is missing.
          throw new CirculationRefusal(
            'circulation.noOpenLoan',
            'That copy is not on loan. Check it in from the item screen if it needs its status ' +
              'corrected.',
            { itemId: probe.itemId },
          );
        }
        if (loan.item.bibId !== probe.bibId) {
          // The copy was re-attached to another record between the probe and the
          // locks, so the queue this transaction locked is not the queue the
          // promotion is about to walk. Step three of probe-lock-re-verify.
          throw new CirculationRefusal(
            'circulation.raced',
            'That copy was moved to another record while you were scanning. Scan it again.',
          );
        }
        if (loan.patronId !== probe.patronId) {
          // The probe's guess is stale: the loan was returned and re-lent, or
          // anonymised, between the probe and the locks. Step three of
          // probe-lock-verify.
          throw new CirculationRefusal(
            'circulation.raced',
            'That copy was checked in or out at another station while you were scanning. Scan it ' +
              'again.',
          );
        }

        const pinned = readPinnedPolicy(loan.id, loan.policySnapshot);
        const branchId = input.branchId ?? loan.item.currentBranchId;

        const overdue = effectiveAt > loan.dueAt;
        const fine = overdue ? this.priceOverdue(snapshot, pinned, loan, effectiveAt) : null;

        // ---- WHO GETS THIS COPY? -------------------------------------------
        //
        // The desk the copy came back to, for its zone and its calendar. A
        // primary-key read, and it is needed before the promotion rather than
        // after it: the suspension window is a CIVIL date — "back on the 3rd" is
        // true in every zone — so deciding who is skipped needs to know which
        // day it is HERE.
        const branch = await tx.branch.findUnique({
          where: { id: branchId },
          select: { id: true, timezone: true, calendarId: true },
        });
        const timezone = branch?.timezone ?? 'UTC';

        const promotion = await promoteForItem(tx, {
          bibId: loan.item.bibId,
          itemId: loan.item.id,
          itemVolume: loan.item.enumeration,
          itemCurrentBranchId: loan.item.currentBranchId,
          itemOwningBranchId: loan.item.owningBranchId,
          now,
          today: civilToday(effectiveAt, timezone),
        });

        // ONE status, decided before it is written. The phase-16 budget test
        // asserts `item_status_history` gains exactly one row per checkin — "a
        // fourth means the copy transitioned twice" — so the copy does not go
        // `available` and then `awaiting_pickup`: it goes where it is going.
        //
        // That is also what makes the routed-hold criterion provable rather than
        // timed. §6 phase 17: "a routed hold reaches `awaiting_pickup` only on
        // transit receipt". Here it reaches `in_transit`, `awaiting_pickup_since`
        // stays NULL for the whole journey, and `ItemTransfersService.receive`
        // stamps it at the far end.
        const settled = await settlePromotion(
          tx,
          { transfers: this.transfers, arrivals: this.arrivals },
          {
            promotion,
            itemId: loan.item.id,
            atBranchId: branchId,
            now,
            timezone,
            calendar: calendarOrNull(snapshot.calendars, branch?.calendarId ?? null),
            actorUserId: actor.userId ?? null,
            source: input.source ?? 'desk',
            deviceId: input.device?.deviceId ?? null,
          },
        );

        // The item first, so a failure leaves the loan open rather than leaving
        // a closed loan on a copy still marked `on_loan` — the direction that is
        // repairable by re-scanning.
        await this.status.applyWithin(tx, {
          itemId: loan.item.id,
          toStatus: settled.toStatus,
          source: input.source ?? 'desk',
          causeType: 'loan',
          causeId: loan.id,
          actorUserId: actor.userId ?? null,
          deviceId: input.device?.deviceId ?? null,
          now,
          beforeReadUnderLock: {
            id: loan.item.id,
            status: loan.item.status,
            currentBranchId: loan.item.currentBranchId,
          },
        });

        // ---- the anonymisation decision, and the return, in ONE update ------
        const mode = await this.readingHistoryMode(tx);
        const anonymise = mode !== 'kept' && loan.patronId !== null;

        await tx.loan.update({
          where: { id: loan.id },
          data: {
            returnedAt: effectiveAt,
            returnBranchId: branchId,
            returnedByUserId: actor.userId ?? null,
            // `closed_at` AND `returned_at`, distinct on purpose: a lost loan
            // keeps `returned_at` NULL for ever, and conflating them is the 1.0
            // dead end where a lost-then-found copy can never be returned.
            closedAt: effectiveAt,
            status: 'returned',
            ...(anonymise ? { patronId: null, anonymisedAt: now } : {}),
            updatedAt: now,
          },
        });

        await tx.loanEvent.create({
          data: {
            loanId: loan.id,
            kind: 'returned',
            occurredAt: now,
            effectiveAt,
            branchId,
            source: input.source ?? 'desk',
            actorUserId: actor.userId ?? null,
            deviceId: input.device?.deviceId ?? null,
            clientChangeId: input.device?.clientChangeId ?? null,
            dueAtBefore: loan.dueAt,
            ...(fine !== null && fine.kind === 'amount'
              ? {
                  overdueCents: BigInt(fine.minorUnits),
                  currency: fine.currency,
                  overdueDays: fine.daysOverdue,
                }
              : {}),
            ...(fine !== null && fine.kind === 'refused' ? { fineErrorCode: fine.code } : {}),
            detail: { anonymised: anonymise } as never,
          },
          select: { id: true },
        });

        const result: CheckinResult = {
          loanId: loan.id,
          itemId: loan.item.id,
          disposition:
            promotion.kind === 'assigned'
              ? settled.toStatus === 'awaiting_pickup'
                ? 'hold_shelf'
                : 'transit'
              : dispositionFor(loan.item, branchId),
          returnedAt: effectiveAt.toISOString(),
          dueAt: loan.dueAt.toISOString(),
          overdue,
          fine,
          anonymised: anonymise,
          holdId: settled.holdId,
          transferId: settled.transferId,
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
      action: 'circulation.checked_in',
      targetType: 'loan',
      targetId: outcome.loanId,
    });
    return outcome;
  }

  /**
   * The open loan for this copy, and whose it is. OUTSIDE the transaction.
   *
   * ONE statement, and its whole purpose is the patron id — the lock key that
   * `LOCK_DOMAIN_RANK` says must be taken FIRST and that a barcode does not
   * carry. See the class docblock for what happens without it.
   */
  private async probe(
    tx: TxV2,
    input: CheckinInput,
  ): Promise<{ itemId: string; patronId: string | null; bibId: string }> {
    const copy =
      input.itemId === undefined
        ? await tx.item.findFirst({
            where: { barcodeNorm: normaliseBarcode(input.itemBarcode ?? '') },
            select: { id: true, bibId: true },
          })
        : await tx.item.findUnique({
            where: { id: input.itemId },
            select: { id: true, bibId: true },
          });
    if (copy === null) throw new NotFoundException('No copy with that barcode.');

    const loan = await tx.loan.findFirst({
      where: { itemId: copy.id, closedAt: null },
      select: { patronId: true },
    });
    // `bibId` is the SECOND lock key phase 17 needs and the second thing a
    // barcode does not carry — the promotion walks this record's whole queue,
    // and `platform/locks.ts` is explicit that a lock taken after the read it
    // protects is the protection of no lock at all.
    return { itemId: copy.id, patronId: loan?.patronId ?? null, bibId: copy.bibId };
  }

  /**
   * `reading_history_policy`, which phase 14 created and never read.
   *
   * A singleton row the phase-13 migration inserts for every tenant, so this is
   * a primary-key read and never a miss. Read INSIDE the transaction because the
   * answer decides a column of the same UPDATE, and a value read outside could
   * have changed between the read and the write — which for a privacy default is
   * the direction that matters.
   */
  private async readingHistoryMode(tx: TxV2): Promise<string> {
    const row = await tx.readingHistoryPolicy.findUnique({
      where: { id: 1 },
      select: { mode: true },
    });
    // Absent is impossible (the migration inserts it) and if it ever happens the
    // safe answer is the privacy-preserving one, not the convenient one.
    return row?.mode ?? 'anonymised';
  }

  /**
   * What is owed, or why it could not be worked out.
   *
   * NEVER throws. A refusal from `accrueOverdue` — `CALENDAR_NOT_DEFINED_FOR`
   * when the branch's calendar does not reach this far, typically — is captured
   * and recorded on the event, because the copy must go back on the shelf either
   * way. Swallowing the refusal and charging zero would be a library silently
   * writing off a debt; fabricating a number would be inventing a policy the
   * librarian did not choose, which §4.1 forbids by name.
   */
  private priceOverdue(
    snapshot: { calendars: Readonly<Record<string, Calendar>> },
    pinned: ReturnType<typeof readPinnedPolicy>,
    loan: { dueAt: Date; item: { replacementCostCents: bigint | null } },
    asOf: Date,
  ): ComputedFine {
    const calendar =
      (pinned.calendarId === null ? undefined : snapshot.calendars[pinned.calendarId]) ??
      Object.values(snapshot.calendars)[0];
    if (calendar === undefined) {
      return {
        kind: 'refused',
        code: 'CALENDAR_NOT_DEFINED_FOR',
        message: 'This library has no opening calendar, so an overdue cannot be priced.',
      };
    }
    try {
      const result = accrueOverdue({
        policy: pinned.overdueFine,
        calendar,
        dueAt: loan.dueAt,
        asOf,
        ...(loan.item.replacementCostCents === null
          ? {}
          : {
              replacementCost: {
                minorUnits: Number(loan.item.replacementCostCents),
                currency: pinned.overdueFine.amountPerInterval.currency,
              },
            }),
      });
      return {
        kind: 'amount',
        minorUnits: Number(result.amount.amount),
        currency: result.amount.currency,
        daysOverdue: result.intervals,
        withinGrace: result.withinGrace,
        cappedBy: result.cappedBy,
      };
    } catch (err) {
      if (err instanceof PolicyResolutionError) {
        this.logger.warn(
          `Overdue could not be priced for a return: ${err.code}. The copy was shelved anyway.`,
        );
        return { kind: 'refused', code: err.code, message: err.message };
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------

export type CheckinInput = CirculationOrigin & {
  readonly itemBarcode?: string;
  readonly itemId?: string;
  /** Where it was handed back. Defaults to where the copy currently is. */
  readonly branchId?: string;
  readonly device?: DeviceClaim;
};

/**
 * The calendar for a branch, or none.
 *
 * NULL rather than a fabricated always-open calendar. `shelfExpiryFor` reads an
 * absent calendar as "count clock time, not open days", which is the honest
 * answer when a branch has no hours entered; inventing one would tell a reader
 * their book is held until a day the library never said it was open.
 */
function calendarOrNull(
  calendars: Readonly<Record<string, Calendar>>,
  calendarId: string | null,
): Calendar | null {
  if (calendarId !== null && calendars[calendarId] !== undefined) return calendars[calendarId]!;
  return Object.values(calendars)[0] ?? null;
}

/**
 * What the desk should do with the copy when NOBODY is waiting for it.
 *
 * The hold dispositions are decided in the transaction, from the promotion,
 * because they are facts it established rather than facts it can re-derive: a
 * copy that reached `awaiting_pickup` is on a shelf with a name on it, and a
 * copy that reached `in_transit` has a transfer row. This function answers the
 * remaining case, and phase 23 turns its `transit` branch into a routed
 * transfer of its own.
 */
function dispositionFor(
  item: { owningBranchId: string; damagedCode: string | null; notForLoanCode: string | null },
  returnedAtBranchId: string,
): CheckinDisposition {
  if (item.damagedCode !== null || item.notForLoanCode !== null) return 'staff_review';
  // Phase 23 turns this into a routed transfer. Until then the desk is told the
  // copy belongs elsewhere and a librarian decides — which is what a library
  // without a van does anyway.
  if (item.owningBranchId !== returnedAtBranchId) return 'transit';
  return 're_shelve';
}

function normaliseBarcode(barcode: string): string {
  return foldGreek(barcode.replace(/\s+/g, '')).toUpperCase();
}
