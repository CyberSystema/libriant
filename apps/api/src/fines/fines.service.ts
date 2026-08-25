import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  FineStatus,
  LoanStatus,
  MemberStatus,
  Prisma,
  TenantPrismaClient,
} from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import type { FineStatusValue } from './fines.dto.js';

/**
 * The money half of circulation.
 *
 * A `Fine` row has been created two ways since day one — `LoansService.return`
 * when an overdue item comes back, and the nightly accrual sweep that grows it
 * — and until this module existed NOTHING could ever close one. The schema had
 * `status`, `paidAt`, `resolvedByUserId` and `notes` from the first migration
 * and no code path wrote any of them, so:
 *
 *   1. a member handing over €2.40 at the desk could not be recorded, and the
 *      "outstanding fines" total on their page was wrong from that moment on;
 *   2. a fine raised in error was permanent, and the sweep kept growing it;
 *   3. GDPR erasure — which correctly refuses while a member owes the library
 *      money — was unreachable for anyone who had ever been overdue.
 *
 * Everything here is a financial event, so every mutation is: role-guarded,
 * single-shot (a status CAS, never an amount edit), audited with the actor, and
 * safe to submit twice.
 *
 * TENANT SCOPING is structural rather than a WHERE clause: each library has its
 * own physical database and {@link TenantPrismaService} hands back the client
 * for THIS request's tenant, so a fine id from another library is simply not a
 * row here and every lookup 404s. There is no tenant column to forget.
 */

export type FineDto = {
  id: string;
  memberId: string;
  /** NULL for ad-hoc fines that were never tied to a loan. */
  loanId: string | null;
  /** Subunits of {@link currency}. NEVER mutated by paying or waiving. */
  amountCents: number;
  currency: string;
  /** Why the money was owed. Survives resolution — see `notes` for the disposition. */
  reason: string;
  status: FineStatusValue;
  /** Set ONLY when money actually changed hands. Always null for waived/voided. */
  paidAt: Date | null;
  /**
   * When the fine stopped being outstanding, for display.
   *
   * DERIVED, because the schema has `paidAt` and no `waivedAt`: for a payment
   * it is `paidAt`; for a waiver/void it is the row's `updatedAt`, which is the
   * moment of the only write a resolved fine ever takes. The exact, immutable
   * record of who did what and when is the audit row — this is the convenience
   * value so the UI does not have to fake one.
   *
   * The caveat that comes with deriving it: a later write to the row moves it.
   * In practice the only one is a GDPR erasure redacting `notes`/`reason`, which
   * would make a waiver appear to have happened on the erasure date. Do not use
   * this for anything that has to be exact — use the audit row.
   */
  resolvedAt: Date | null;
  /**
   * Control-plane `User.id` of the staff member who resolved it. NULL when the
   * action was taken by an impersonating Libriant admin (who is not a tenant
   * user) — the audit row carries that attribution, exactly as with
   * `loan.checkedOutByUserId`.
   */
  resolvedByUserId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type FineWithJoinsDto = FineDto & {
  member: { id: string; memberNumber: string; fullName: string; status: MemberStatus };
  loan: {
    id: string;
    dueAt: Date;
    returnedAt: Date | null;
    status: LoanStatus;
    copy: { id: string; barcode: string; book: { id: string; title: string } };
  } | null;
};

/** What a member currently owes. Recomputed after every resolution. */
export type MemberFinesSummary = {
  memberId: string;
  outstandingCount: number;
  outstandingCents: number;
  currency: string;
};

export type ListFinesResult = {
  items: FineWithJoinsDto[];
  nextCursor: string | null;
  /**
   * Totals for what is still OUTSTANDING under the same member/loan filter,
   * regardless of the `status` filter applied to `items`.
   *
   * Deliberately not "the total of this page": the desk question is "what does
   * this member owe", and a page-scoped total silently understates it the
   * moment there are more fines than fit on one page.
   */
  summary: MemberFinesSummary | null;
  /** Tenant-wide outstanding totals, always for the whole library. */
  tenantSummary: { outstandingCount: number; outstandingCents: number; currency: string };
};

export type ResolveFineResult = {
  fine: FineWithJoinsDto;
  /** So the caller can refresh the member's "outstanding" total without a second round trip. */
  member: MemberFinesSummary;
};

export type ListFinesOptions = {
  status?: FineStatusValue;
  memberId?: string;
  loanId?: string;
  after?: string;
  limit?: number;
};

/** Statuses that mean "this fine is closed" — the ones a CAS must exclude. */
const RESOLVED_STATUSES: readonly FineStatusValue[] = ['paid', 'waived'];

@Injectable()
export class FinesService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
  ) {}

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  async list(tenant: TenantContext, opts: ListFinesOptions = {}): Promise<ListFinesResult> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));

    const where: Prisma.FineWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.memberId) where.memberId = opts.memberId;
    if (opts.loanId) where.loanId = opts.loanId;

    const [rows, currency, tenantTotals, memberTotals] = await Promise.all([
      client.fine.findMany({
        where,
        // Newest first, `id` as the tiebreaker so cursor pagination is a total
        // order and cannot drop or repeat a row. There is no (createdAt, id)
        // index on `fines`; the table is orders of magnitude smaller than
        // `loans` (only overdue/lost loans ever produce a row) so the sort node
        // is cheap. Revisit if a library ever pages through six figures of them.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
        include: this.fullInclude,
      }),
      this.currencyOf(client),
      client.fine.aggregate({
        where: { status: 'outstanding' },
        _sum: { amountCents: true },
        _count: true,
      }),
      opts.memberId
        ? client.fine.aggregate({
            where: { memberId: opts.memberId, status: 'outstanding' },
            _sum: { amountCents: true },
            _count: true,
          })
        : Promise.resolve(null),
    ]);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => this.toJoinsDto(r));
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
      summary:
        opts.memberId && memberTotals
          ? {
              memberId: opts.memberId,
              outstandingCount: memberTotals._count,
              outstandingCents: memberTotals._sum.amountCents ?? 0,
              currency,
            }
          : null,
      tenantSummary: {
        outstandingCount: tenantTotals._count,
        outstandingCents: tenantTotals._sum.amountCents ?? 0,
        currency,
      },
    };
  }

  async get(tenant: TenantContext, id: string): Promise<FineWithJoinsDto> {
    const client = this.tenantPrisma.getClient(tenant);
    return this.getInternal(client, id);
  }

  // -------------------------------------------------------------------------
  // resolutions — the three ways a fine stops being outstanding
  // -------------------------------------------------------------------------

  /**
   * Money came in over the desk. Full settlement only (see {@link PayFineDto}).
   *
   * `expectedAmountCents`, when supplied, must match what the fine says RIGHT
   * NOW. The accrual sweep runs nightly and a librarian's screen can be hours
   * stale, so without that check the API would happily stamp "paid in full" on
   * a €2.90 fine because the drawer took €2.40, and the €0.50 would vanish with
   * no record that it was ever owed.
   */
  async pay(
    tenant: TenantContext,
    id: string,
    input: { amountCents?: number; notes?: string },
    actor: TenantActor,
  ): Promise<ResolveFineResult> {
    return this.resolve(tenant, id, actor, {
      nextStatus: 'paid',
      auditAction: 'fine.paid',
      expectedAmountCents: input.amountCents,
      notes: input.notes,
      noteLine: 'payment recorded',
      // The ONLY path that sets paidAt. A waiver must never set it: `paidAt`
      // is the library's record that money physically changed hands, and a
      // written-off fine that claims a payment date is a false receipt.
      markPaid: true,
    });
  }

  /**
   * The debt was real; the library is choosing not to collect it.
   *
   * Owner/admin only (see the controller) — this is the one operation that
   * turns money owed into money not owed.
   */
  async waive(
    tenant: TenantContext,
    id: string,
    input: { reason: string; notes?: string },
    actor: TenantActor,
  ): Promise<ResolveFineResult> {
    return this.resolve(tenant, id, actor, {
      nextStatus: 'waived',
      auditAction: 'fine.waived',
      reason: input.reason,
      notes: input.notes,
      noteLine: `waived: ${input.reason}`,
      markPaid: false,
    });
  }

  /**
   * The debt was never real — the fine was raised in error.
   *
   * Lands on the same `waived` status (the schema has three, and a fourth is a
   * migration across every tenant database for a distinction the audit trail
   * can already carry), but it is a SEPARATE call with its own audit action so
   * the record does not claim the member owed money they never owed. See
   * {@link VoidFineDto} for why that distinction is worth a second endpoint.
   */
  async voidFine(
    tenant: TenantContext,
    id: string,
    input: { reason: string; notes?: string },
    actor: TenantActor,
  ): Promise<ResolveFineResult> {
    return this.resolve(tenant, id, actor, {
      nextStatus: 'waived',
      auditAction: 'fine.voided',
      reason: input.reason,
      notes: input.notes,
      noteLine: `voided (raised in error): ${input.reason}`,
      markPaid: false,
    });
  }

  // -------- internals -----------------------------------------------------

  /**
   * The one write shared by pay / waive / void.
   *
   * Double-apply protection is two layers deep, because the desk is a place
   * where people click twice:
   *
   *   1. `IdempotencyInterceptor` on the route — the same `Idempotency-Key`
   *      replays the first response and never re-enters this method. That
   *      covers the double-click, the offline queue flush and the retry after
   *      a dropped connection.
   *   2. This CAS — `updateMany` pinned to `status: 'outstanding'`. Two
   *      librarians on two machines with two different keys both arrive; one
   *      updates a row, the other updates zero and is told what already
   *      happened. Without it, the second call would stamp a second
   *      `resolvedByUserId`/`paidAt` over the first and the audit trail would
   *      show two payments for one fine.
   *
   * `amountCents` is never touched by any of them. A resolved fine still says
   * exactly what the library charged.
   */
  private async resolve(
    tenant: TenantContext,
    id: string,
    actor: TenantActor,
    op: {
      nextStatus: FineStatusValue;
      auditAction: string;
      expectedAmountCents?: number;
      reason?: string;
      notes?: string;
      noteLine: string;
      markPaid: boolean;
    },
  ): Promise<ResolveFineResult> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.fine.findUnique({
      where: { id },
      select: {
        id: true,
        memberId: true,
        loanId: true,
        amountCents: true,
        currency: true,
        status: true,
        paidAt: true,
        notes: true,
        updatedAt: true,
      },
    });
    // Not found here also covers "that id belongs to a different library" —
    // this client is bound to one tenant's database and nothing else is in it.
    if (!existing) throw new NotFoundException('Fine not found.');

    if (existing.status !== 'outstanding') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: this.alreadyResolvedMessage(existing.status, existing.paidAt),
        fineStatus: existing.status,
      });
    }

    if (op.expectedAmountCents !== undefined && op.expectedAmountCents !== existing.amountCents) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message:
          `This fine is now ${this.formatAmount(existing.amountCents, existing.currency)}, not ` +
          `${this.formatAmount(op.expectedAmountCents, existing.currency)} — it grew while the ` +
          'page was open. Check the new amount with the member and try again.',
        currentAmountCents: existing.amountCents,
        currency: existing.currency,
      });
    }

    const resolvedAt = new Date();
    const updated = await client.fine.updateMany({
      where: { id, status: 'outstanding' },
      data: {
        status: op.nextStatus,
        paidAt: op.markPaid ? resolvedAt : null,
        // NULL under impersonation — a Libriant support admin is not a member
        // of this library's staff. The audit row carries who they really were.
        resolvedByUserId: actor.userId,
        notes: this.appendNote(existing.notes, op.noteLine, op.notes, resolvedAt),
      },
    });
    if (updated.count === 0) {
      // Someone else settled it between our read and our write.
      const fresh = await client.fine.findUnique({
        where: { id },
        select: { status: true, paidAt: true },
      });
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: fresh
          ? this.alreadyResolvedMessage(fresh.status, fresh.paidAt)
          : 'That fine was just changed from another station. Refresh and try again.',
        fineStatus: fresh?.status ?? null,
      });
    }

    // After the commit, never inside it — a lost audit row must not turn a
    // recorded payment into a 500 (TenantAuditService is best-effort by design).
    await this.audit.record(tenant, actor, {
      action: op.auditAction,
      targetType: 'fine',
      targetId: id,
      before: {
        status: existing.status,
        amountCents: existing.amountCents,
        currency: existing.currency,
      },
      after: {
        status: op.nextStatus,
        // Repeated from `before` on purpose: an audit row for a financial event
        // has to say how much money it was about without a join to a row that
        // may since have been redacted by an erasure.
        amountCents: existing.amountCents,
        currency: existing.currency,
        memberId: existing.memberId,
        loanId: existing.loanId,
        paidAt: op.markPaid ? resolvedAt.toISOString() : null,
        resolvedAt: resolvedAt.toISOString(),
        resolvedByUserId: actor.userId,
        ...(op.reason ? { reason: op.reason } : {}),
      },
    });

    const [fine, member] = await Promise.all([
      this.getInternal(client, id),
      this.memberSummary(client, existing.memberId),
    ]);
    return { fine, member };
  }

  private async memberSummary(
    client: TenantPrismaClient,
    memberId: string,
  ): Promise<MemberFinesSummary> {
    const [totals, currency] = await Promise.all([
      client.fine.aggregate({
        where: { memberId, status: 'outstanding' },
        _sum: { amountCents: true },
        _count: true,
      }),
      this.currencyOf(client),
    ]);
    return {
      memberId,
      outstandingCount: totals._count,
      outstandingCents: totals._sum.amountCents ?? 0,
      currency,
    };
  }

  /**
   * The library's configured currency. Each fine row also carries its own — a
   * library that switched currency mid-life has rows in both — but the totals
   * are a single number, so they are labelled with the CURRENT setting. Mixing
   * currencies in one sum is a pre-existing property of
   * `member.circulation.outstandingFinesCents`; this does not make it worse,
   * and a real fix is a per-currency breakdown nobody has asked for.
   */
  private async currencyOf(client: TenantPrismaClient): Promise<string> {
    const settings = await client.tenantSetting.findUnique({
      where: { id: 1 },
      select: { currency: true },
    });
    return settings?.currency ?? 'EUR';
  }

  private readonly fullInclude = {
    member: { select: { id: true, memberNumber: true, fullName: true, status: true } },
    loan: {
      select: {
        id: true,
        dueAt: true,
        returnedAt: true,
        status: true,
        copy: {
          select: { id: true, barcode: true, book: { select: { id: true, title: true } } },
        },
      },
    },
  } as const;

  private async getInternal(client: TenantPrismaClient, id: string): Promise<FineWithJoinsDto> {
    const row = await client.fine.findUnique({ where: { id }, include: this.fullInclude });
    if (!row) throw new NotFoundException('Fine not found.');
    return this.toJoinsDto(row);
  }

  /**
   * Append the disposition to the fine's notes, stamped, keeping whatever was
   * there. `reason` is NOT overwritten: it says why the money was owed, and a
   * fine whose reason has been replaced by "waived by the librarian" can no
   * longer answer the only question a member ever asks about it.
   */
  private appendNote(
    existing: string | null,
    line: string,
    extra: string | undefined,
    at: Date,
  ): string {
    const detail = extra && extra.trim().length ? ` — ${extra.trim()}` : '';
    const stamped = `[${at.toISOString()}] ${line}${detail}`;
    return existing && existing.length ? `${existing}\n${stamped}` : stamped;
  }

  private alreadyResolvedMessage(status: string, paidAt: Date | null): string {
    if (status === 'paid') {
      return paidAt
        ? `This fine was already paid on ${paidAt.toISOString().slice(0, 10)}.`
        : 'This fine has already been paid.';
    }
    if ((RESOLVED_STATUSES as readonly string[]).includes(status)) {
      return 'This fine has already been written off.';
    }
    return `This fine is ${status} and can no longer be settled.`;
  }

  /** Display only — money is stored and compared as integer subunits, never parsed back. */
  private formatAmount(cents: number, currency: string): string {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }

  private toJoinsDto(row: {
    id: string;
    memberId: string;
    loanId: string | null;
    amountCents: number;
    currency: string;
    reason: string;
    status: FineStatus;
    paidAt: Date | null;
    resolvedByUserId: string | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    member: { id: string; memberNumber: string; fullName: string; status: MemberStatus };
    loan: {
      id: string;
      dueAt: Date;
      returnedAt: Date | null;
      status: LoanStatus;
      copy: { id: string; barcode: string; book: { id: string; title: string } };
    } | null;
  }): FineWithJoinsDto {
    return {
      id: row.id,
      memberId: row.memberId,
      loanId: row.loanId,
      amountCents: row.amountCents,
      currency: row.currency,
      reason: row.reason,
      status: row.status,
      paidAt: row.paidAt,
      resolvedAt: row.status === 'outstanding' ? null : (row.paidAt ?? row.updatedAt),
      resolvedByUserId: row.resolvedByUserId,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      member: row.member,
      loan: row.loan,
    };
  }
}
