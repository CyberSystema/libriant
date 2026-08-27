import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  BookCopyStatus,
  LoanStatus,
  MemberStatus,
  Prisma,
  TenantPrismaClient,
} from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { FieldDefinitionsService } from '../customization/field-definitions.service.js';
import { validateRecordOrThrow } from '../customization/dynamic-validator.js';
import { decodeCursor, encodeCursor } from '../platform/query.js';
import type { ReturnCondition } from './loans.dto.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** Statuses the user can filter loans by via the list endpoint. */
export const LOAN_STATUSES = ['active', 'returned', 'lost'] as const;

export type LoanDto = {
  id: string;
  copyId: string;
  memberId: string;
  loanedAt: Date;
  dueAt: Date;
  returnedAt: Date | null;
  renewedCount: number;
  status: LoanStatus;
  notes: string | null;
  checkedOutByUserId: string | null;
  returnedByUserId: string | null;
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type LoanWithJoinsDto = LoanDto & {
  member: { id: string; memberNumber: string; fullName: string; status: MemberStatus };
  copy: {
    id: string;
    barcode: string;
    status: BookCopyStatus;
    book: { id: string; title: string };
  };
  fines: Array<{
    id: string;
    amountCents: number;
    currency: string;
    reason: string;
    status: 'outstanding' | 'paid' | 'waived';
  }>;
};

export type CheckoutResult = {
  loan: LoanWithJoinsDto;
};

export type ReturnResult = {
  loan: LoanWithJoinsDto;
  /** Populated when the return was overdue and a fine was created. */
  fine: {
    id: string;
    amountCents: number;
    currency: string;
    daysOverdue: number;
  } | null;
  /**
   * Populated when a queued hold on the same book was auto-promoted to
   * `ready` because this copy came back. The librarian's UI shows this so
   * they can shelve the book in the holds area instead of general stacks.
   */
  promotedHold: {
    reservationId: string;
    memberId: string;
    memberFullName: string;
    expiresAt: Date;
  } | null;
};

export type MarkLostResult = {
  loan: LoanWithJoinsDto;
  fine: { id: string; amountCents: number; currency: string } | null;
};

export type ListLoansOptions = {
  memberId?: string;
  copyId?: string;
  status?: LoanStatus;
  overdue?: boolean;
  after?: string;
  limit?: number;
};

@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(FieldDefinitionsService) private readonly fieldDefs: FieldDefinitionsService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
  ) {}

  // -------------------------------------------------------------------------
  // checkout — hand a physical copy to a member
  // -------------------------------------------------------------------------

  async checkout(
    tenant: TenantContext,
    input: {
      copyId: string;
      memberId: string;
      dueAt?: string;
      loanedAt?: string;
      notes?: string;
      customFields?: Record<string, unknown>;
      /**
       * When set, this is a *fulfillment* of a ready hold (rather than a
       * plain checkout). The copy is expected to be in `reserved` state,
       * the reservation is marked `fulfilled` inside the same transaction,
       * and the usual `available`-only check is bypassed.
       */
      reservationId?: string;
    },
    actor: TenantActor,
  ): Promise<CheckoutResult> {
    const client = this.tenantPrisma.getClient(tenant);

    // 1. Custom-fields validation against the loan entity's field defs.
    const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'loan');
    const cleanedCustom = validateRecordOrThrow(defs, input.customFields ?? {}, {
      unknownFields: 'reject',
    });

    // 2. Read settings once. Used for the default loan period + the
    //    per-member active-loans ceiling.
    const settings = await this.requireSettings(client);
    const loanedAt = input.loanedAt ? new Date(input.loanedAt) : new Date();
    const dueAt = input.dueAt
      ? new Date(input.dueAt)
      : new Date(loanedAt.getTime() + settings.loanPeriodDays * MS_PER_DAY);
    if (dueAt.getTime() <= loanedAt.getTime()) {
      throw new BadRequestException('Due date must be after the checkout date — pick a later day.');
    }

    // 3. Validate member.
    const member = await client.member.findUnique({
      where: { id: input.memberId },
      select: { id: true, status: true, archivedAt: true, fullName: true, memberNumber: true },
    });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.archivedAt) {
      throw new BadRequestException(
        `${member.fullName} is archived. Restore the member before checking out.`,
      );
    }
    if (member.status !== 'active') {
      throw new BadRequestException(
        `${member.fullName} is ${member.status}. Reactivate the member before checking out.`,
      );
    }

    // 4. Enforce per-member active-loans cap (0 = uncapped).
    if (settings.maxActiveLoans > 0) {
      const activeCount = await client.loan.count({
        where: { memberId: input.memberId, status: 'active' },
      });
      if (activeCount >= settings.maxActiveLoans) {
        throw new BadRequestException(
          `${member.fullName} already has ${activeCount} active loans (limit ${settings.maxActiveLoans}). Return one first.`,
        );
      }
    }

    // 5. Validate copy. Fulfillment path accepts `reserved`; everything
    //    else requires `available`.
    const expectedCopyStatus: BookCopyStatus = input.reservationId ? 'reserved' : 'available';
    const copy = await client.bookCopy.findUnique({
      where: { id: input.copyId },
      select: {
        id: true,
        status: true,
        archivedAt: true,
        barcode: true,
        bookId: true,
        book: { select: { id: true, title: true, archivedAt: true } },
      },
    });
    if (!copy) throw new NotFoundException('Copy not found.');
    if (copy.archivedAt) {
      throw new BadRequestException(
        `Copy ${copy.barcode} is archived. Restore the copy before checking out.`,
      );
    }
    if (copy.book.archivedAt) {
      throw new BadRequestException(
        `${copy.book.title} is archived. Restore the book before checking out.`,
      );
    }
    if (copy.status !== expectedCopyStatus) {
      if (input.reservationId) {
        throw new BadRequestException(
          `Copy ${copy.barcode} is not the one held for this reservation (current status: ${copy.status}).`,
        );
      }
      throw new BadRequestException(this.copyUnavailableMessage(copy.status, copy.barcode));
    }

    // 6. Atomic state change: create Loan + flip copy to on_loan (also mark
    //    the reservation fulfilled when in fulfillment mode). All three must
    //    succeed together or none do.
    let createdId: string;
    try {
      createdId = await client.$transaction(async (tx) => {
        // Serialize against member archive (members-1): take a member-scoped
        // advisory lock and re-confirm the member is still active inside the
        // tx, so a concurrent archive can't slip a loan onto an archived
        // member after its safety check passed.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`member:${input.memberId}`}, 0))`;
        const liveMember = await tx.member.findUnique({
          where: { id: input.memberId },
          select: { status: true, archivedAt: true },
        });
        if (!liveMember || liveMember.archivedAt || liveMember.status !== 'active') {
          throw new ConflictException(
            'That member was just archived or deactivated. Refresh and try again.',
          );
        }

        // Fulfillment path: validate the reservation is in a state we can
        // close (status='ready', member match, copy match, not expired).
        if (input.reservationId) {
          const reservation = await tx.reservation.findUnique({
            where: { id: input.reservationId },
            select: {
              id: true,
              status: true,
              memberId: true,
              fulfilledByCopyId: true,
              expiresAt: true,
            },
          });
          if (!reservation) throw new NotFoundException('Reservation not found.');
          if (reservation.status !== 'ready') {
            throw new BadRequestException(
              reservation.status === 'queued'
                ? "This hold isn't ready yet — wait for it to reach the front of the queue."
                : `This hold is ${reservation.status} and can't be picked up.`,
            );
          }
          if (reservation.memberId !== input.memberId) {
            throw new BadRequestException(
              'This hold belongs to a different member. Check the reservation card.',
            );
          }
          if (reservation.fulfilledByCopyId !== input.copyId) {
            throw new BadRequestException(
              "The copy you're handing over isn't the one held for this reservation.",
            );
          }
          if (reservation.expiresAt && reservation.expiresAt.getTime() < Date.now()) {
            throw new BadRequestException(
              "This hold's pickup window has expired. Cancel or re-place it before checking out.",
            );
          }
          const closed = await tx.reservation.updateMany({
            where: { id: input.reservationId, status: 'ready' },
            data: { status: 'fulfilled', fulfilledAt: new Date() },
          });
          if (closed.count === 0) {
            throw new ConflictException(
              'Another librarian just resolved this hold. Please refresh.',
            );
          }
        }

        const created = await tx.loan.create({
          data: {
            copyId: input.copyId,
            memberId: input.memberId,
            loanedAt,
            dueAt,
            notes: input.notes ?? null,
            checkedOutByUserId: actor.userId,
            customFields: cleanedCustom as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        // Conditional update — guards against the race where two staff
        // members try to lend the same copy concurrently. If the copy was
        // grabbed first, the row count is 0 and we abort. We pin to the
        // expected status so a fulfillment doesn't accidentally lend a
        // copy that's available (and vice versa).
        const flipped = await tx.bookCopy.updateMany({
          where: { id: input.copyId, status: expectedCopyStatus },
          data: { status: 'on_loan' },
        });
        if (flipped.count === 0) {
          throw new ConflictException(
            `Copy ${copy.barcode} was just checked out from another station. Refresh and try again.`,
          );
        }
        return created.id;
      });
    } catch (err) {
      throw this.translate(err);
    }

    await this.audit.record(tenant, actor, {
      action: 'loan.checked_out',
      targetType: 'loan',
      targetId: createdId,
      after: {
        copyId: input.copyId,
        memberId: input.memberId,
        dueAt: dueAt.toISOString(),
        viaReservation: input.reservationId ?? null,
      },
    });

    return { loan: await this.getInternal(client, createdId) };
  }

  // -------------------------------------------------------------------------
  // return — close an active loan, free the copy, calculate an overdue fine
  // -------------------------------------------------------------------------

  async returnLoan(
    tenant: TenantContext,
    loanId: string,
    input: { returnedAt?: string; condition?: ReturnCondition; notes?: string },
    actor: TenantActor,
  ): Promise<ReturnResult> {
    const client = this.tenantPrisma.getClient(tenant);
    const loan = await client.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        copyId: true,
        memberId: true,
        loanedAt: true,
        dueAt: true,
        returnedAt: true,
        status: true,
        notes: true,
        copy: { select: { bookId: true } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.status !== 'active') {
      throw new BadRequestException(
        loan.status === 'returned'
          ? 'This loan was already returned.'
          : 'This loan is marked lost — it cannot be returned. Restore the copy through the catalog instead.',
      );
    }

    const settings = await this.requireSettings(client);
    const returnedAt = input.returnedAt ? new Date(input.returnedAt) : new Date();
    if (returnedAt.getTime() < loan.loanedAt.getTime()) {
      throw new BadRequestException('Return time cannot be earlier than the checkout time.');
    }
    const condition: ReturnCondition = input.condition ?? 'ok';
    const candidateNextStatus: BookCopyStatus = condition === 'damaged' ? 'damaged' : 'available';

    // circ-5: "days overdue" counts whole 24h blocks elapsed since the exact
    // `dueAt` instant — NOT calendar days in the library's local timezone. So a
    // book due at 18:00 returned at 17:00 two days later counts as 1 overdue
    // day, not 2. This is deliberate and is the single source of truth shared
    // with the fine-accrual sweep (jobs/fine-accrual.job.ts), which floors the
    // same `(now - dueAt) / 24h` so the running total and the on-return charge
    // always agree. Calendar-day billing would require a per-tenant timezone
    // (no such column exists today) applied identically in both paths.
    const overdueMs = Math.max(0, returnedAt.getTime() - loan.dueAt.getTime());
    const daysOverdue = Math.floor(overdueMs / MS_PER_DAY);
    const rawFine = daysOverdue * settings.finePerDayCents;
    const fineAmountCents =
      settings.fineCapCents > 0 ? Math.min(rawFine, settings.fineCapCents) : rawFine;
    // The overdue-fines switch is the master gate: off ⇒ never bill, whatever
    // the rate says.
    const shouldCreateFine = settings.overdueFinesEnabled && daysOverdue > 0 && fineAmountCents > 0;

    type ReturnTxResult = {
      fineId: string | null;
      /**
       * A previously-outstanding fine this return closed automatically, if any.
       * Carried out of the transaction so it can be AUDITED: closing it writes
       * off money the library was owed, and a financial write-off that leaves no
       * record is not one an auditor — or a librarian asked "why is this gone?" —
       * can ever account for. `resolvedByUserId` stays null on the row itself
       * (see closeStaleOutstandingFine) so an automatic adjustment is still
       * distinguishable from a deliberate waiver; the audit row is what supplies
       * the actor and the reason.
       */
      closedFine: { id: string; amountCents: number; why: string } | null;
      /**
       * What the member is actually being billed on THIS return — the accrued
       * total less anything already settled for this loan. Computed inside the
       * transaction because it reads the fines table; see the netting comment
       * at the charge site.
       */
      chargedCents: number;
      promotedHold: {
        reservationId: string;
        memberId: string;
        memberFullName: string;
        expiresAt: Date;
      } | null;
    };
    let txResult: ReturnTxResult;
    try {
      txResult = await client.$transaction(async (tx): Promise<ReturnTxResult> => {
        // Decide whether the freed copy goes straight back to the shelf or
        // gets handed to the next person in line. We only promote when the
        // copy is undamaged (a damaged copy needs repair before it's lent
        // again).
        let nextCopyStatus: BookCopyStatus = candidateNextStatus;
        let promoted: ReturnTxResult['promotedHold'] = null;
        if (candidateNextStatus === 'available') {
          // Serialize hold promotion PER BOOK. Without this, two copies of the
          // same book returned concurrently both read the same queue head and
          // both reserve a copy for it — stranding one copy in `reserved` with
          // no reservation pointing at it (a permanently-lost copy). The
          // xact-scoped advisory lock makes find+promote atomic across
          // concurrent returns/expiries; it releases at COMMIT/ROLLBACK.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`book:${loan.copy.bookId}`}, 0))`;
          const head = await tx.reservation.findFirst({
            where: { bookId: loan.copy.bookId, status: 'queued' },
            orderBy: { queuePosition: 'asc' },
            select: {
              id: true,
              memberId: true,
              member: { select: { fullName: true } },
            },
          });
          if (head) {
            const now = new Date();
            const expiresAt = new Date(now.getTime() + settings.holdPickupHours * MS_PER_HOUR);
            // CAS belt-and-braces with the advisory lock: only promote while the
            // reservation is still 'queued'. If a concurrent path already
            // promoted it (count===0), the freed copy goes back to the shelf.
            const promotedRes = await tx.reservation.updateMany({
              where: { id: head.id, status: 'queued' },
              data: {
                status: 'ready',
                readyAt: now,
                expiresAt,
                fulfilledByCopyId: loan.copyId,
                queuePosition: null,
              },
            });
            if (promotedRes.count > 0) {
              // Everyone behind the head bumps up a slot.
              await tx.$executeRaw`
                UPDATE reservations
                SET "queuePosition" = "queuePosition" - 1, "updatedAt" = NOW() AT TIME ZONE 'UTC'
                WHERE "bookId" = ${loan.copy.bookId}
                  AND status = 'queued'
                  AND "queuePosition" > 0
              `;
              nextCopyStatus = 'reserved';
              promoted = {
                reservationId: head.id,
                memberId: head.memberId,
                memberFullName: head.member.fullName,
                expiresAt,
              };
            }
          }
        }

        // Close the loan.
        const updated = await tx.loan.updateMany({
          where: { id: loanId, status: 'active' },
          data: {
            returnedAt,
            status: 'returned',
            returnedByUserId: actor.userId,
            notes: this.appendNote(loan.notes, input.notes),
          },
        });
        if (updated.count === 0) {
          throw new ConflictException(
            'Another staff member just returned this loan. Refresh and try again.',
          );
        }
        // Free the copy. Only flip from on_loan — protects against a
        // librarian having marked the copy damaged/lost manually in the
        // meantime (we don't want to overwrite their action).
        const flipped = await tx.bookCopy.updateMany({
          where: { id: loan.copyId, status: 'on_loan' },
          data: { status: nextCopyStatus },
        });
        if (flipped.count === 0) {
          // The copy's status was already changed manually since the loan
          // was opened — surface the inconsistency rather than silently
          // corrupting state.
          throw new ConflictException(
            "Couldn't free the copy because its status changed. Check the copy's record and contact a librarian.",
          );
        }
        // Issue the overdue fine if any. The accrual sweep may have already
        // opened an outstanding fine for this loan while it was overdue —
        // finalise that one instead of creating a duplicate (DATA-1: done as a
        // single atomic upsert so a sweep racing this return doesn't abort the tx).
        let fineId: string | null = null;
        let chargedCents = 0;
        let closedFine: ReturnTxResult['closedFine'] = null;
        if (shouldCreateFine) {
          // NET OFF WHAT THE LOAN HAS ALREADY SETTLED.
          //
          // The overdue charge for a loan is a RUNNING TOTAL (daysOverdue ×
          // rate, capped) that the nightly sweep keeps growing, and since the
          // fines module shipped a member can pay or a librarian can write off
          // part of it while the book is still out. `fineAmountCents` is that
          // whole running total, so billing it again at return would charge the
          // member a second time for days they have already paid for: pay €2.00
          // on Monday for four days overdue, bring the book back on Tuesday, and
          // the return would open a fresh €2.50 fine covering the same four days
          // plus one. The ON CONFLICT upsert below cannot see it, because a paid
          // fine is not the outstanding row it targets.
          //
          // The invariant the fines module and the accrual sweep both hold to:
          //   outstanding for a loan  =  total accrued − already settled.
          const settled = await tx.fine.aggregate({
            where: { loanId, status: { in: ['paid', 'waived'] } },
            _sum: { amountCents: true },
          });
          chargedCents = Math.max(0, fineAmountCents - (settled._sum.amountCents ?? 0));
          if (chargedCents > 0) {
            fineId = await this.upsertOutstandingFine(tx, {
              memberId: loan.memberId,
              loanId,
              amountCents: chargedCents,
              currency: settings.currency,
              reason: `${daysOverdue} day(s) overdue`,
            });
          } else {
            // Everything this loan ever accrued has already been settled. Don't
            // open a €0 fine, and close any outstanding remainder the sweep left
            // behind before the settlement landed.
            closedFine = await this.closeStaleOutstandingFine(
              tx,
              loanId,
              'closed on return — already settled in full',
            );
          }
        } else {
          // circ-3: overdue fines are off (or there's nothing to bill) at return
          // time, but the accrual sweep may have opened an outstanding fine while
          // the loan was overdue and fines were still on. Reconcile it instead of
          // leaving the member owing a charge the library has since switched off.
          closedFine = await this.closeStaleOutstandingFine(
            tx,
            loanId,
            'closed on return — overdue fines are switched off for this library',
          );
        }
        return { fineId, chargedCents, closedFine, promotedHold: promoted };
      });
    } catch (err) {
      throw this.translate(err);
    }

    await this.audit.record(tenant, actor, {
      action: 'loan.returned',
      targetType: 'loan',
      targetId: loanId,
      before: { status: loan.status, dueAt: loan.dueAt.toISOString() },
      after: {
        status: 'returned',
        returnedAt: returnedAt.toISOString(),
        condition,
        fineId: txResult.fineId,
        daysOverdue,
        // Both numbers, because they differ whenever part of this loan's
        // overdue total was paid or written off before the book came back, and
        // an audit row that only carried the accrued figure would look like the
        // member was billed money they were not billed.
        accruedCents: fineAmountCents,
        chargedCents: txResult.chargedCents,
      },
    });

    // A write-off has to be attributable, even when nothing chose it.
    //
    // Returning a book can close an outstanding fine automatically — the days
    // were already settled, or the library switched overdue fines off while the
    // book was out. That is money the library was owed and no longer is, and it
    // used to happen with no record at all: the row flipped to 'waived' with a
    // null resolver and the `loan.returned` audit row said nothing about it. A
    // librarian asked "why did this charge disappear?" had nowhere to look.
    //
    // Deliberately its OWN action rather than a field on `loan.returned`, so it
    // is findable by fine; and deliberately NOT `fine.waived`, so an automatic
    // adjustment can never be mistaken for the deliberate write-off a person
    // signed for.
    if (txResult.closedFine) {
      await this.audit.record(tenant, actor, {
        action: 'fine.closed_on_return',
        targetType: 'fine',
        targetId: txResult.closedFine.id,
        before: { status: 'outstanding', amountCents: txResult.closedFine.amountCents },
        after: { status: 'waived', reason: txResult.closedFine.why, loanId },
      });
    }

    const fullLoan = await this.getInternal(client, loanId);
    return {
      loan: fullLoan,
      fine:
        txResult.fineId !== null
          ? {
              id: txResult.fineId,
              // What the member owes NOW, not what the loan accrued in total.
              amountCents: txResult.chargedCents,
              currency: settings.currency,
              daysOverdue,
            }
          : null,
      promotedHold: txResult.promotedHold,
    };
  }

  // -------------------------------------------------------------------------
  // renew — push the due date out by N loan periods
  // -------------------------------------------------------------------------

  async renew(
    tenant: TenantContext,
    loanId: string,
    input: { periods?: number },
    actor: TenantActor,
  ): Promise<LoanWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const loan = await client.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        copyId: true,
        dueAt: true,
        renewedCount: true,
        status: true,
        copy: { select: { bookId: true } },
      },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.status !== 'active') {
      throw new BadRequestException(
        'Only active loans can be renewed. Returned or lost loans are closed.',
      );
    }

    const settings = await this.requireSettings(client);
    if (!settings.renewalsEnabled) {
      throw new BadRequestException('Loan renewals are turned off for this library.');
    }
    const periods = input.periods ?? 1;
    const remaining = Math.max(0, settings.maxRenewals - loan.renewedCount);
    if (remaining === 0) {
      throw new BadRequestException(
        `This loan has already been renewed the maximum number of times (${settings.maxRenewals}).`,
      );
    }
    if (periods > remaining) {
      throw new BadRequestException(
        `Only ${remaining} renewal(s) left on this loan — you asked for ${periods}.`,
      );
    }

    // If the loan is already past due, base the extension on "now" rather
    // than on the old dueAt so we don't silently bake in the overdue period.
    const base = Math.max(loan.dueAt.getTime(), Date.now());
    const newDueAt = new Date(base + periods * settings.loanPeriodDays * MS_PER_DAY);

    // A7-03 + circ-2: do the active-hold check AND the renew write inside ONE
    // transaction holding the per-book advisory lock. Once someone else is
    // queued for this book the holding member loses their renew option; checking
    // that OUTSIDE the lock left a window where a hold placed between the check
    // and the write would be renewed past. Hold placement takes the same
    // `book:<id>` lock, so they now mutually exclude. The renewedCount CAS still
    // guards two concurrent renews from each incrementing the count.
    const renewed = await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`book:${loan.copy.bookId}`}, 0))`;
      const queuedHold = await tx.reservation.findFirst({
        where: { bookId: loan.copy.bookId, status: { in: ['queued', 'ready'] } },
        select: { id: true },
      });
      if (queuedHold) {
        throw new BadRequestException(
          "Another member is waiting for this book — you can't renew while there's an active hold.",
        );
      }
      return tx.loan.updateMany({
        where: { id: loanId, status: 'active', renewedCount: loan.renewedCount },
        data: { dueAt: newDueAt, renewedCount: { increment: periods } },
      });
    });
    if (renewed.count === 0) {
      throw new ConflictException(
        'This loan was just renewed or returned from another station. Refresh and try again.',
      );
    }

    await this.audit.record(tenant, actor, {
      action: 'loan.renewed',
      targetType: 'loan',
      targetId: loanId,
      before: { dueAt: loan.dueAt.toISOString(), renewedCount: loan.renewedCount },
      after: { dueAt: newDueAt.toISOString(), renewedCount: loan.renewedCount + periods },
    });

    return this.getInternal(client, loanId);
  }

  // -------------------------------------------------------------------------
  // mark-lost — copy gone, optionally bill the member for replacement
  // -------------------------------------------------------------------------

  async markLost(
    tenant: TenantContext,
    loanId: string,
    input: { replacementCostCents?: number; notes?: string },
    actor: TenantActor,
  ): Promise<MarkLostResult> {
    const client = this.tenantPrisma.getClient(tenant);
    const loan = await client.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        copyId: true,
        memberId: true,
        status: true,
        notes: true,
      },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.status !== 'active') {
      throw new BadRequestException(
        loan.status === 'returned'
          ? "This loan was already returned — the copy isn't lost."
          : 'This loan is already marked lost.',
      );
    }

    const settings = await this.requireSettings(client);
    // Staff can always pass an explicit amount; otherwise fall back to the
    // library's default replacement fee, but only when lost-item fees are on.
    const cost =
      input.replacementCostCents ??
      (settings.lostItemFeesEnabled ? settings.lostItemDefaultFeeCents : 0);
    const shouldCreateFine = cost > 0;

    let fineId: string | null = null;
    try {
      const result = await client.$transaction(async (tx) => {
        const updated = await tx.loan.updateMany({
          where: { id: loanId, status: 'active' },
          data: {
            status: 'lost',
            notes: this.appendNote(loan.notes, input.notes),
            returnedByUserId: actor.userId,
          },
        });
        if (updated.count === 0) {
          throw new ConflictException('Another staff member just updated this loan.');
        }
        const flipped = await tx.bookCopy.updateMany({
          where: { id: loan.copyId, status: 'on_loan' },
          data: { status: 'lost' },
        });
        if (flipped.count === 0) {
          throw new ConflictException("Couldn't mark the copy lost because its status changed.");
        }
        if (shouldCreateFine) {
          // An overdue book may already carry an outstanding fine from the
          // accrual sweep. Finalise that one as the replacement fee rather than
          // inserting a second (the fines_one_outstanding_per_loan unique index
          // would reject the duplicate with P2002). DATA-1: settled as a single
          // atomic upsert so a concurrent sweep can't abort this mark-lost tx.
          return this.upsertOutstandingFine(tx, {
            memberId: loan.memberId,
            loanId,
            amountCents: cost,
            currency: settings.currency,
            reason: 'Lost book replacement',
          });
        }
        return null;
      });
      fineId = result;
    } catch (err) {
      throw this.translate(err);
    }

    await this.audit.record(tenant, actor, {
      action: 'loan.marked_lost',
      targetType: 'loan',
      targetId: loanId,
      before: { status: loan.status },
      after: { status: 'lost', fineId, replacementCostCents: cost },
    });

    const full = await this.getInternal(client, loanId);
    return {
      loan: full,
      fine: fineId !== null ? { id: fineId, amountCents: cost, currency: settings.currency } : null,
    };
  }

  // -------------------------------------------------------------------------
  // update — notes + customFields on an existing loan (no state change here)
  // -------------------------------------------------------------------------

  async update(
    tenant: TenantContext,
    loanId: string,
    input: { notes?: string | null; customFields?: Record<string, unknown> },
  ): Promise<LoanWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.loan.findUnique({ where: { id: loanId } });
    if (!existing) throw new NotFoundException('Loan not found.');

    let cleanedCustom: Record<string, unknown> | undefined;
    if (input.customFields !== undefined) {
      const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'loan');
      cleanedCustom = validateRecordOrThrow(defs, input.customFields, {
        unknownFields: 'reject',
        partial: true,
      });
    }

    const data: Prisma.LoanUpdateInput = {};
    if (input.notes !== undefined) data.notes = input.notes;
    if (cleanedCustom !== undefined) {
      data.customFields = {
        ...((existing.customFields as Record<string, unknown>) ?? {}),
        ...cleanedCustom,
      } as Prisma.InputJsonValue;
    }

    await client.loan.update({ where: { id: loanId }, data });
    return this.getInternal(client, loanId);
  }

  // -------------------------------------------------------------------------
  // list / get
  // -------------------------------------------------------------------------

  async list(
    tenant: TenantContext,
    opts: ListLoansOptions = {},
  ): Promise<{ items: LoanWithJoinsDto[]; nextCursor: string | null }> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.LoanWhereInput = {};
    if (opts.memberId) where.memberId = opts.memberId;
    if (opts.copyId) where.copyId = opts.copyId;
    if (opts.status) where.status = opts.status;
    if (opts.overdue) {
      where.status = 'active';
      where.dueAt = { lt: new Date() };
    }

    // performance-03, the same keyset predicate `BooksService.list` carries.
    // This used to be `cursor: { id: opts.after }, skip: 1` — an OR of
    // correlated subselects, which Postgres cannot use as a btree start key, so
    // it walked `loans_loanedAt_id_idx` from the newest loan and discarded
    // everything above the cursor. Circulation history is the list that grows
    // fastest in a working library: one row per checkout, kept forever.
    //
    // Measured on 300,000 loans, on the literal SQL Prisma emitted for the page
    // at depth 150,000:
    //   BEFORE  Index Only Scan using "loans_loanedAt_id_idx",
    //           Rows Removed by Filter: 150000, Buffers: shared hit=11
    //           read=1059 written=395, Execution Time: 11.360 ms
    //   AFTER   same index, Index Cond: ("loanedAt" <= …),
    //           Rows Removed by Filter: 1, Buffers: shared hit=1 read=3,
    //           Execution Time: 0.863 ms
    // Both orderings already have an index that matches them exactly
    // (`loans_loanedAt_id_idx`, `loans_status_dueAt_id_idx`), added for
    // performance-02 — this finding is only about giving the planner a start
    // key to enter them at, so it needs no migration.
    const key = this.sortKeyFor(opts);
    const after = await this.decodeListCursor(client, opts.after, key);
    if (after) {
      // The overdue tile runs `dueAt ASC` (most overdue first) and everything
      // else runs `loanedAt DESC` (newest first), so the boundary flips
      // direction with the sort key.
      where.AND =
        key === 'dueAt'
          ? [
              { dueAt: { gte: after.at } },
              { OR: [{ dueAt: { gt: after.at } }, { dueAt: after.at, id: { gt: after.id } }] },
            ]
          : [
              { loanedAt: { lte: after.at } },
              {
                OR: [{ loanedAt: { lt: after.at } }, { loanedAt: after.at, id: { lt: after.id } }],
              },
            ];
    }

    const rows = await client.loan.findMany({
      where,
      orderBy: this.orderFor(opts),
      take: limit + 1,
      include: this.fullInclude,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((r) => this.toJoinsDto(r));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor([
              key,
              (key === 'dueAt' ? last.dueAt : last.loanedAt).toISOString(),
              last.id,
            ])
          : null,
    };
  }

  /**
   * Which timestamp {@link orderFor} sorts this request by. Kept beside it so
   * the cursor and the ORDER BY cannot drift apart.
   */
  private sortKeyFor(opts: ListLoansOptions): 'loanedAt' | 'dueAt' {
    return opts.overdue ? 'dueAt' : 'loanedAt';
  }

  /**
   * As `BooksService.decodeListCursor`, over `(loanedAt, id)` or `(dueAt, id)`.
   *
   * The token carries WHICH key it was minted under, because this list has two
   * sort orders and a librarian who ticks "overdue only" mid-scroll hands back
   * a cursor built from the other one. Reading a `dueAt` as a `loanedAt` would
   * silently start the overdue page somewhere arbitrary in the backlog, so a
   * mismatched token is treated as a bare id and the row is re-read — one
   * primary-key lookup that lands them on the right page under the new sort.
   */
  private async decodeListCursor(
    client: TenantPrismaClient,
    after: string | undefined,
    key: 'loanedAt' | 'dueAt',
  ): Promise<{ at: Date; id: string } | null> {
    if (!after) return null;
    let rowId = after;
    const parts = decodeCursor(after, 3);
    if (parts) {
      const [tokenKey, iso, id] = parts;
      if (typeof tokenKey !== 'string' || typeof iso !== 'string' || typeof id !== 'string') {
        return null;
      }
      if (tokenKey === key) {
        const at = new Date(iso);
        return Number.isNaN(at.getTime()) ? null : { at, id };
      }
      rowId = id;
    }
    const row = await client.loan.findUnique({
      where: { id: rowId },
      select: { loanedAt: true, dueAt: true, id: true },
    });
    if (!row) return null;
    return { at: key === 'dueAt' ? row.dueAt : row.loanedAt, id: row.id };
  }

  async get(tenant: TenantContext, loanId: string): Promise<LoanWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    return this.getInternal(client, loanId);
  }

  // -------- internals -----------------------------------------------------

  /**
   * Sort key for {@link list}, chosen so an index can answer the query without
   * a sort node — performance-02.
   *
   * The overdue tile is the reason this is not a constant. `loanedAt DESC`
   * starts at the loans that were taken out most recently, i.e. precisely the
   * ones that are NOT yet late, so serving the overdue filter in that order
   * means walking the whole active backlog and discarding it: measured on the
   * audit's 2M-row tenant (200,000 active, 10,000 overdue), `Index Scan using
   * loans_status_loanedAt_id_idx … Rows Removed by Filter: 190000`, 118,319
   * buffers for 101 rows — nearly four times the buffers of the seq scan it
   * replaced, and it gets WORSE as a library gets better at chasing its
   * overdues. Ordering the overdue tile by `dueAt ASC` instead walks straight
   * along `loans_status_dueAt_id_idx` and stops after 101 index entries: 107
   * buffers, 0.107 ms.
   *
   * `dueAt ASC` is also the order a librarian wants for that list — most
   * overdue first — so this is not a performance-only concession.
   *
   * `id` is the tiebreaker in both, and both are total orders: the keyset in
   * {@link list} needs a deterministic sort to page without dropping or
   * repeating rows.
   */
  private orderFor(opts: ListLoansOptions): Prisma.LoanOrderByWithRelationInput[] {
    if (opts.overdue) return [{ dueAt: 'asc' }, { id: 'asc' }];
    return [{ loanedAt: 'desc' }, { id: 'desc' }];
  }

  private readonly fullInclude = {
    member: {
      select: { id: true, memberNumber: true, fullName: true, status: true },
    },
    copy: {
      select: {
        id: true,
        barcode: true,
        status: true,
        book: { select: { id: true, title: true } },
      },
    },
    fines: {
      select: { id: true, amountCents: true, currency: true, reason: true, status: true },
      orderBy: { createdAt: 'asc' as const },
    },
  } as const;

  private async getInternal(client: TenantPrismaClient, loanId: string): Promise<LoanWithJoinsDto> {
    const row = await client.loan.findUnique({
      where: { id: loanId },
      include: this.fullInclude,
    });
    if (!row) throw new NotFoundException('Loan not found.');
    return this.toJoinsDto(row);
  }

  private async requireSettings(client: TenantPrismaClient): Promise<{
    loanPeriodDays: number;
    renewalsEnabled: boolean;
    maxRenewals: number;
    overdueFinesEnabled: boolean;
    finePerDayCents: number;
    fineCapCents: number;
    lostItemFeesEnabled: boolean;
    lostItemDefaultFeeCents: number;
    maxActiveLoans: number;
    holdPickupHours: number;
    currency: string;
  }> {
    const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
    if (!settings) {
      // Provisioning seeds row 1 — if it's missing the tenant DB is broken.
      throw new Error('Tenant settings row missing; tenant DB is in a corrupt state.');
    }
    return settings;
  }

  /**
   * DATA-1: atomically open-or-finalise the single outstanding fine for a loan
   * from *inside* a return / mark-lost transaction.
   *
   * The naive `findFirst` → `create` loses a race with the fine-accrual sweep
   * (which opens an outstanding fine for the same loan in an autocommit
   * statement): both find nothing, both insert, and the loser's INSERT trips the
   * `fines_one_outstanding_per_loan` partial unique index with P2002. Inside an
   * interactive transaction that statement error aborts the *whole* transaction,
   * so the librarian gets a spurious 409 on an otherwise-fine return.
   *
   * Resolving it in a single `INSERT … ON CONFLICT DO UPDATE` lets Postgres
   * settle the race atomically — no statement error, no rollback, return
   * completes on the first attempt. The conflict target mirrors the partial
   * index exactly (column + predicate). `id` is minted with `gen_random_uuid()`
   * (pgcrypto is enabled tenant-wide) and `updatedAt` is set explicitly since
   * neither column carries a DB-side default.
   */
  /**
   * TIMESTAMPS ARE WRITTEN IN UTC, EXPLICITLY.
   *
   * `createdAt` / `updatedAt` are `timestamp WITHOUT time zone`, and Prisma
   * writes UTC into them for every other row in this database. Bare `NOW()` and
   * the column's own `DEFAULT CURRENT_TIMESTAMP` are `timestamptz`, so assigning
   * them converts using the SESSION timezone — which on the production host is
   * Europe/Berlin. Measured: 2026-08-25 19:39 stored where every neighbouring
   * row would hold 17:39, a two-hour skew that grows to three in winter.
   *
   * `createdAt` was omitted entirely and fell to that default, and `resolvedAt`
   * in the fines API is derived from `updatedAt` — so a fine appeared to be
   * raised, and settled, two hours in the future relative to the loan that
   * caused it.
   */
  private async upsertOutstandingFine(
    tx: Pick<TenantPrismaClient, '$queryRaw'>,
    input: {
      memberId: string;
      loanId: string;
      amountCents: number;
      currency: string;
      reason: string;
    },
  ): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "fines" ("id", "memberId", "loanId", "amountCents", "currency", "reason", "status", "createdAt", "updatedAt")
      VALUES (
        gen_random_uuid()::text,
        ${input.memberId},
        ${input.loanId},
        ${input.amountCents},
        ${input.currency},
        ${input.reason},
        'outstanding',
        NOW() AT TIME ZONE 'UTC',
        NOW() AT TIME ZONE 'UTC'
      )
      ON CONFLICT ("loanId") WHERE "status" = 'outstanding' AND "loanId" IS NOT NULL
      DO UPDATE SET
        "amountCents" = EXCLUDED."amountCents",
        "reason" = EXCLUDED."reason",
        "updatedAt" = NOW() AT TIME ZONE 'UTC'
      RETURNING "id"
    `;
    return rows[0]!.id;
  }

  /**
   * Close an outstanding fine the accrual sweep opened for a loan that, at
   * return time, turns out not to owe anything after all — either the library
   * has switched overdue fines off (circ-3) or the whole accrued total has
   * already been paid/waived.
   *
   * Two deliberate choices, both changed from the first version of this code:
   *
   *   - `reason` is PRESERVED and the disposition goes in `notes`. The old code
   *     overwrote `reason` with the explanation, which destroyed the only field
   *     that says why the money was ever owed — the exact thing a member asks
   *     about when they see a waived charge on their record. Same convention the
   *     fines module follows for a librarian's own waiver.
   *   - `resolvedByUserId` is left NULL. This is the system reconciling itself
   *     during someone's return, not a person deciding to write off a debt;
   *     stamping the returning librarian's id here would make an automatic
   *     adjustment indistinguishable from their deliberate waiver in the very
   *     record used to tell those apart.
   *
   * Status-guarded so we never touch a fine someone else just resolved.
   */
  private async closeStaleOutstandingFine(
    tx: Pick<Prisma.TransactionClient, 'fine'>,
    loanId: string,
    why: string,
  ): Promise<{ id: string; amountCents: number; why: string } | null> {
    const stale = await tx.fine.findFirst({
      where: { loanId, status: 'outstanding' },
      select: { id: true, notes: true, amountCents: true },
    });
    if (!stale) return null;
    const closed = await tx.fine.updateMany({
      where: { id: stale.id, status: 'outstanding' },
      data: {
        status: 'waived',
        notes: this.appendNote(stale.notes, why),
      },
    });
    // updateMany is the CAS: another request may have settled it between the
    // read and the write, in which case this return did not close anything and
    // must not claim an audit row for it.
    if (closed.count === 0) return null;
    return { id: stale.id, amountCents: stale.amountCents, why };
  }

  private appendNote(existing: string | null, addition?: string | null): string | null {
    if (!addition || !addition.trim().length) return existing;
    const stamp = `[${new Date().toISOString()}] ${addition.trim()}`;
    return existing && existing.length ? `${existing}\n${stamp}` : stamp;
  }

  private copyUnavailableMessage(status: BookCopyStatus, barcode: string): string {
    switch (status) {
      case 'on_loan':
        return `Copy ${barcode} is already checked out. Return it first.`;
      case 'reserved':
        return `Copy ${barcode} is on hold. Use the reservation pickup flow to check it out.`;
      case 'lost':
        return `Copy ${barcode} is marked lost — it can't be lent.`;
      case 'damaged':
        return `Copy ${barcode} is damaged — repair or restore it before lending.`;
      case 'withdrawn':
        return `Copy ${barcode} is withdrawn from circulation — restore it first.`;
      default:
        return `Copy ${barcode} is currently ${status}.`;
    }
  }

  private translate(err: unknown): Error {
    if (err instanceof BadRequestException || err instanceof ConflictException) return err;
    if (typeof err === 'object' && err !== null) {
      const code = (err as { code?: string }).code;
      // Unique-constraint violation — e.g. a second open loan on the same copy
      // (loans_one_active_per_copy) or a duplicate outstanding fine
      // (fines_one_outstanding_per_loan) lost a race. The state changed under
      // us; a refresh + retry resolves it.
      if (code === 'P2002') {
        return new ConflictException(
          'That changed while you were working on it (the copy or fine was updated by someone else). Please refresh and try again.',
        );
      }
      const message = (err as { message?: string }).message ?? '';
      const m = message.match(/violates check constraint "([^"]+)"/);
      if (m) {
        return new BadRequestException(
          `The database rejected the value (${m[1]}). Please double-check the highlighted fields.`,
        );
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private toJoinsDto(row: {
    id: string;
    copyId: string;
    memberId: string;
    loanedAt: Date;
    dueAt: Date;
    returnedAt: Date | null;
    renewedCount: number;
    status: LoanStatus;
    notes: string | null;
    checkedOutByUserId: string | null;
    returnedByUserId: string | null;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    member: { id: string; memberNumber: string; fullName: string; status: MemberStatus };
    copy: {
      id: string;
      barcode: string;
      status: BookCopyStatus;
      book: { id: string; title: string };
    };
    fines: Array<{
      id: string;
      amountCents: number;
      currency: string;
      reason: string;
      status: 'outstanding' | 'paid' | 'waived';
    }>;
  }): LoanWithJoinsDto {
    return {
      id: row.id,
      copyId: row.copyId,
      memberId: row.memberId,
      loanedAt: row.loanedAt,
      dueAt: row.dueAt,
      returnedAt: row.returnedAt,
      renewedCount: row.renewedCount,
      status: row.status,
      notes: row.notes,
      checkedOutByUserId: row.checkedOutByUserId,
      returnedByUserId: row.returnedByUserId,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      member: row.member,
      copy: row.copy,
      fines: row.fines,
    };
  }
}
