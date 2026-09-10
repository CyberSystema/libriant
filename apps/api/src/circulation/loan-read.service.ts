import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { readPinnedPolicy, type PinnedPolicySnapshot } from './policy-pinning.js';

/**
 * Reading loans — the three questions a desk asks and the one a dispute asks.
 *
 * Separate from the three writing services on purpose. Everything here is a
 * plain indexed read with no lock, no transaction and no policy resolution, and
 * mixing it into `CheckoutService` would put un-transactional code in a file
 * whose whole discipline is that it is transactional.
 */
@Injectable()
export class LoanReadService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * What a reader has out.
   *
   * `loans_patron_open_idx` is `(patron_id) WHERE closed_at IS NULL`, so this is
   * an index scan over exactly the open set rather than a filter over every loan
   * the reader has ever taken — which after ten years is the difference between
   * eight rows and eight hundred.
   */
  async openLoansFor(tenant: TenantContext, patronId: string): Promise<OpenLoanRow[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.loan.findMany({
      where: { patronId, closedAt: null },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        itemId: true,
        bibId: true,
        loanedAt: true,
        dueAt: true,
        originalDueAt: true,
        renewalCount: true,
        status: true,
        checkoutBranchId: true,
        item: { select: { barcode: true, callNumberSort: true } },
      },
    });
  }

  /**
   * Everything overdue, oldest first.
   *
   * `loans_status_due_id_idx` is `(status, due_at, id)` and is NOT partial on
   * `status` — the baseline says why, and it is the same wall the whole 2.0
   * schema keeps meeting: `enum_in` is only STABLE, so a `WHERE status =
   * 'active'` predicate can never be proved by the planner, which is exactly
   * the mistake `loans_active_dueAt_idx` made in 1.0. Here the enum is an
   * ORDINARY equality on the leading column rather than an index predicate, so
   * the index is usable.
   */
  async overdue(tenant: TenantContext, asOf: Date, branchId?: string): Promise<OverdueRow[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.loan.findMany({
      where: {
        status: 'active',
        dueAt: { lt: asOf },
        closedAt: null,
        ...(branchId === undefined ? {} : { checkoutBranchId: branchId }),
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        itemId: true,
        patronId: true,
        dueAt: true,
        checkoutBranchId: true,
        patronCategoryCode: true,
        item: { select: { barcode: true } },
      },
    });
  }

  /**
   * One loan, with its frozen policy made legible.
   *
   * The snapshot comes back READ rather than raw, so a client cannot accidentally
   * render a shape from a future version — `readPinnedPolicy` refuses anything
   * it does not recognise rather than merging in a default.
   */
  async get(tenant: TenantContext, loanId: string): Promise<LoanDetail> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const loan = await client.loan.findUnique({
      where: { id: loanId },
      select: {
        id: true,
        itemId: true,
        patronId: true,
        anonymisedAt: true,
        bibId: true,
        checkoutBranchId: true,
        loanedAt: true,
        dueAt: true,
        originalDueAt: true,
        returnedAt: true,
        returnBranchId: true,
        closedAt: true,
        status: true,
        renewalCount: true,
        appliedRuleId: true,
        policySnapshot: true,
        patronCategoryCode: true,
        patronAgeBand: true,
        patronHomeBranchId: true,
        source: true,
      },
    });
    if (loan === null) throw new NotFoundException('No such loan.');
    const { policySnapshot, ...rest } = loan;
    return { ...rest, policy: readPinnedPolicy(loan.id, policySnapshot) };
  }

  /**
   * The event log — `occurred_at` AND `effective_at`, side by side.
   *
   * This is the read the phase's two-instant design exists for. A reader
   * disputing a fine is not asking when the library HEARD about the return; they
   * are asking when the return HAPPENED, and for every book that went through a
   * drop box or a synced wand those are different days.
   */
  async events(tenant: TenantContext, loanId: string): Promise<LoanEventRow[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    return client.loanEvent.findMany({
      where: { loanId },
      // `loan_events_loan_idx` is `(loan_id, occurred_at)`; descending is a
      // backwards index scan, not a sort.
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true,
        kind: true,
        occurredAt: true,
        effectiveAt: true,
        branchId: true,
        source: true,
        actorUserId: true,
        deviceId: true,
        dueAtBefore: true,
        dueAtAfter: true,
        overdueCents: true,
        currency: true,
        overdueDays: true,
        fineErrorCode: true,
        note: true,
      },
    });
  }
}

// ---------------------------------------------------------------------------
//
// Every return type below is WRITTEN OUT rather than inferred, for the reason
// phase 15 hit first: Prisma's generated enums live under
// `node_modules/.prisma/...`, so an inferred return type is `TS2883 — cannot be
// named without a reference` and the build fails. Restating the shape is what
// keeps the generated client an implementation detail of this file rather than
// of every caller.

export type LoanStatusValue =
  'active' | 'recalled' | 'claims_returned' | 'claims_never_borrowed' | 'returned' | 'lost';

export type ChannelValue = 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';

export type OpenLoanRow = {
  readonly id: string;
  readonly itemId: string;
  readonly bibId: string;
  readonly loanedAt: Date;
  readonly dueAt: Date;
  readonly originalDueAt: Date;
  readonly renewalCount: number;
  readonly status: LoanStatusValue;
  readonly checkoutBranchId: string;
  readonly item: { readonly barcode: string | null; readonly callNumberSort: string | null };
};

export type OverdueRow = {
  readonly id: string;
  readonly itemId: string;
  readonly patronId: string | null;
  readonly dueAt: Date;
  readonly checkoutBranchId: string;
  readonly patronCategoryCode: string | null;
  readonly item: { readonly barcode: string | null };
};

export type LoanDetail = {
  readonly id: string;
  readonly itemId: string;
  readonly patronId: string | null;
  readonly anonymisedAt: Date | null;
  readonly bibId: string;
  readonly checkoutBranchId: string;
  readonly loanedAt: Date;
  readonly dueAt: Date;
  readonly originalDueAt: Date;
  readonly returnedAt: Date | null;
  readonly returnBranchId: string | null;
  readonly closedAt: Date | null;
  readonly status: LoanStatusValue;
  readonly renewalCount: number;
  readonly appliedRuleId: string;
  readonly patronCategoryCode: string | null;
  readonly patronAgeBand: string | null;
  readonly patronHomeBranchId: string | null;
  readonly source: ChannelValue;
  readonly policy: PinnedPolicySnapshot;
};

export type LoanEventRow = {
  readonly id: string;
  readonly kind: 'checked_out' | 'renewed' | 'returned' | 'anonymised';
  /** When Postgres learned. */
  readonly occurredAt: Date;
  /** When it happened, at a desk, in the world. */
  readonly effectiveAt: Date;
  readonly branchId: string;
  readonly source: ChannelValue;
  readonly actorUserId: string | null;
  readonly deviceId: string | null;
  readonly dueAtBefore: Date | null;
  readonly dueAtAfter: Date | null;
  readonly overdueCents: bigint | null;
  readonly currency: string | null;
  readonly overdueDays: number | null;
  readonly fineErrorCode: string | null;
  readonly note: string | null;
};
