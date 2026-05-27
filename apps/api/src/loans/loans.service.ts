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
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { FieldDefinitionsService } from '../customization/field-definitions.service.js';
import { validateRecordOrThrow } from '../customization/dynamic-validator.js';
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
    actingUserId: string,
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
            checkedOutByUserId: actingUserId,
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

    return { loan: await this.getInternal(client, createdId) };
  }

  // -------------------------------------------------------------------------
  // return — close an active loan, free the copy, calculate an overdue fine
  // -------------------------------------------------------------------------

  async returnLoan(
    tenant: TenantContext,
    loanId: string,
    input: { returnedAt?: string; condition?: ReturnCondition; notes?: string },
    actingUserId: string,
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

    const overdueMs = Math.max(0, returnedAt.getTime() - loan.dueAt.getTime());
    const daysOverdue = Math.floor(overdueMs / MS_PER_DAY);
    const rawFine = daysOverdue * settings.finePerDayCents;
    const fineAmountCents =
      settings.fineCapCents > 0 ? Math.min(rawFine, settings.fineCapCents) : rawFine;
    const shouldCreateFine = daysOverdue > 0 && fineAmountCents > 0;

    type ReturnTxResult = {
      fineId: string | null;
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
            await tx.reservation.update({
              where: { id: head.id },
              data: {
                status: 'ready',
                readyAt: now,
                expiresAt,
                fulfilledByCopyId: loan.copyId,
                queuePosition: null,
              },
            });
            // Everyone behind the head bumps up a slot.
            await tx.$executeRaw`
              UPDATE reservations
              SET "queuePosition" = "queuePosition" - 1, "updatedAt" = NOW()
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

        // Close the loan.
        const updated = await tx.loan.updateMany({
          where: { id: loanId, status: 'active' },
          data: {
            returnedAt,
            status: 'returned',
            returnedByUserId: actingUserId,
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
        // Issue the overdue fine if any.
        let fineId: string | null = null;
        if (shouldCreateFine) {
          const fine = await tx.fine.create({
            data: {
              memberId: loan.memberId,
              loanId: loanId,
              amountCents: fineAmountCents,
              currency: settings.currency,
              reason: `${daysOverdue} day(s) overdue`,
            },
            select: { id: true },
          });
          fineId = fine.id;
        }
        return { fineId, promotedHold: promoted };
      });
    } catch (err) {
      throw this.translate(err);
    }

    const fullLoan = await this.getInternal(client, loanId);
    return {
      loan: fullLoan,
      fine:
        txResult.fineId !== null
          ? {
              id: txResult.fineId,
              amountCents: fineAmountCents,
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

    // Once someone else is queued for this book, the holding member loses
    // their option to renew. This matches typical library policy and gives
    // the next person in line a fair turn.
    const queuedHold = await client.reservation.findFirst({
      where: { bookId: loan.copy.bookId, status: { in: ['queued', 'ready'] } },
      select: { id: true },
    });
    if (queuedHold) {
      throw new BadRequestException(
        "Another member is waiting for this book — you can't renew while there's an active hold.",
      );
    }

    // If the loan is already past due, base the extension on "now" rather
    // than on the old dueAt so we don't silently bake in the overdue period.
    const base = Math.max(loan.dueAt.getTime(), Date.now());
    const newDueAt = new Date(base + periods * settings.loanPeriodDays * MS_PER_DAY);

    await client.loan.update({
      where: { id: loanId },
      data: { dueAt: newDueAt, renewedCount: { increment: periods } },
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
    actingUserId: string,
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
    const cost = input.replacementCostCents ?? 0;
    const shouldCreateFine = cost > 0;

    let fineId: string | null = null;
    try {
      const result = await client.$transaction(async (tx) => {
        const updated = await tx.loan.updateMany({
          where: { id: loanId, status: 'active' },
          data: {
            status: 'lost',
            notes: this.appendNote(loan.notes, input.notes),
            returnedByUserId: actingUserId,
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
          const fine = await tx.fine.create({
            data: {
              memberId: loan.memberId,
              loanId: loanId,
              amountCents: cost,
              currency: settings.currency,
              reason: 'Lost book replacement',
            },
            select: { id: true },
          });
          return fine.id;
        }
        return null;
      });
      fineId = result;
    } catch (err) {
      throw this.translate(err);
    }

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

    const rows = await client.loan.findMany({
      where,
      orderBy: [{ loanedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
      include: this.fullInclude,
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => this.toJoinsDto(r));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async get(tenant: TenantContext, loanId: string): Promise<LoanWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    return this.getInternal(client, loanId);
  }

  // -------- internals -----------------------------------------------------

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
    maxRenewals: number;
    finePerDayCents: number;
    fineCapCents: number;
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
