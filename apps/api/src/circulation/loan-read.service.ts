import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import {
  clampLimit,
  keysetCursorValues,
  keysetPredicate,
  pageOf,
  readKeysetCursor,
  type KeysetBoundary,
  type ListResult,
} from '../platform/list.js';
import { readPinnedPolicy, type PinnedPolicySnapshot } from '@libriant/circ-policy';

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
   * The loan list — the desk's work queue, and the history behind it
   * (2.0 phase 20a).
   *
   * ## Two orders, because a list and a queue are not the same question
   *
   * The default is `(loaned_at desc, id desc)`: circulation history, newest
   * first, which is what "what went out today" and "what has this reader
   * borrowed" both mean. `?overdue=1` is not that list with a filter on it — it
   * is a WORK QUEUE, so it pins `status = 'active' AND due_at < asOf` and flips
   * the order to `(due_at asc, id asc)`, which puts the book that is six weeks
   * late at the top instead of four thousand rows down.
   *
   * The sort field, the direction, the `orderBy` and the meaning of the cursor
   * are all derived from ONE boolean below, and that is the point. A `desc`
   * order paged with an `asc` keyset predicate returns the rows BEFORE the
   * cursor, so "Load more" walks back towards the newest loan and the reader
   * never reaches the end of the list. Nothing throws, nothing is logged, and
   * the only symptom is a list that quietly repeats itself.
   *
   * ## The index each order walks
   *
   * `?overdue=1` walks `loans_status_due_id_idx` — `(status, due_at, id)`,
   * which is exactly the order it asks for, so the page is a range scan and not
   * a sort. The enum is an ORDINARY equality on the leading column rather than
   * an index predicate, for the reason {@link overdue} records: `enum_in` is
   * only STABLE, so Postgres can never prove a `WHERE status = 'active'` partial
   * index applies — the mistake 1.0's `loans_active_dueAt_idx` made and this
   * schema un-made.
   *
   * THE DEFAULT ORDER HAS NO INDEX TODAY. `lbr2.loans` carries
   * `loans_status_due_id_idx`, `loans_bib_id_idx`, and two PARTIAL indexes on
   * `patron_id` and `item_id` that are `WHERE closed_at IS NULL` and carry no
   * sort column — so an unfiltered first page is a sort over every loan the
   * library has ever made, and `?patronId=` is a sort over that reader's whole
   * history rather than a scan of the newest 25. `loans` is the table that grows
   * fastest in a working library (one row per checkout, kept for ever), so this
   * is the read that degrades first. It needs
   * `@@index([loanedAt, id], map: "loans_loaned_at_id_idx")` plus the three
   * filtered variants, and the migration is NOT written here — phase 20a owns
   * no schema file. See the report handed to the operator with this phase.
   *
   * ## The clock belongs to the caller
   *
   * `asOf` is passed in rather than read here: `apps/api/src/circulation/**` may
   * not read the process clock (phase 13's ESLint block), and an overdue cut-off
   * that moved between the boundary and the page would make one loan appear on
   * two consecutive pages.
   *
   * ## `closed_at IS NULL` is deliberately NOT repeated beside `status`
   *
   * `loans_closed_consistency` is `(closed_at IS NULL) = (status IN
   * ('active','claims_returned','claims_never_borrowed','recalled'))`, so on the
   * overdue path the two predicates name the same set. Repeating it would add a
   * recheck on a column in no index here, buy nothing, and read as though one of
   * them might be false — which the constraint has already made impossible.
   */
  async list(tenant: TenantContext, opts: LoanListOptions): Promise<LoanListPage> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const limit = clampLimit(opts.limit);

    // ONE boolean decides the sort field, the direction, the `orderBy` and what
    // the cursor means. Spreading that decision over four independent
    // expressions is exactly how the direction and the order stop agreeing.
    const workQueue = opts.overdue === true;
    const sortField = workQueue ? 'dueAt' : 'loanedAt';
    const direction: 'asc' | 'desc' = workQueue ? 'asc' : 'desc';

    const where: Record<string, unknown> = {};
    if (opts.patronId !== undefined) where['patronId'] = opts.patronId;
    if (opts.itemId !== undefined) where['itemId'] = opts.itemId;
    if (opts.bibId !== undefined) where['bibId'] = opts.bibId;
    if (opts.status !== undefined) where['status'] = opts.status;
    if (workQueue) {
      // The queue defines its own status, and the controller has already
      // refused a request that asked for a different one — a silent override
      // here would answer `?status=lost&overdue=1` with an empty page that
      // reads at the desk as "nothing is overdue".
      where['status'] = 'active';
      where['dueAt'] = { lt: opts.asOf };
    }

    const after = await this.decodeLoanCursor(client, opts.after, sortField);
    if (after) where['AND'] = keysetPredicate({ sortField, direction, after });

    // EXPLICIT SELECT. A default `findMany` on this table drags `policy_snapshot`
    // (the frozen resolution, jsonb), `custom_fields` (jsonb) and `notes` into
    // every row of every page — three TOAST-able columns on the busiest list in
    // the product, none of which a list can render.
    const rows = await client.loan.findMany({
      where: where as never,
      orderBy: workQueue
        ? [{ dueAt: 'asc' }, { id: 'asc' }]
        : [{ loanedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        bibId: true,
        checkoutBranchId: true,
        loanedAt: true,
        dueAt: true,
        returnedAt: true,
        closedAt: true,
        anonymisedAt: true,
        status: true,
        renewalCount: true,
        // The barcode and the name are what a desk acts on: "who has this, and
        // which copy is it". They come through the RELATION rather than a loop
        // over the page, because Prisma resolves a to-one `select` as one
        // `WHERE id IN (…)` per relation per page — two extra indexed queries,
        // not the fifty a caller-side lookup would make.
        item: { select: { id: true, barcode: true } },
        patron: { select: { id: true, fullName: true, patronNumber: true } },
      },
    });

    return pageOf(
      rows,
      limit,
      (r) => ({
        id: r.id,
        item: r.item,
        // NULL on every anonymised loan, which is the DEFAULT for a closed one:
        // `patron_id` is nulled and `anonymised_at` stamped in the same
        // transaction as the return. `anonymisedAt` travels beside it so a
        // client can say "reader details were erased on return" instead of
        // rendering a blank cell that looks like a bug.
        patron: r.patron,
        bibId: r.bibId,
        checkoutBranchId: r.checkoutBranchId,
        loanedAt: r.loanedAt,
        dueAt: r.dueAt,
        returnedAt: r.returnedAt,
        closedAt: r.closedAt,
        anonymisedAt: r.anonymisedAt,
        status: r.status,
        renewalCount: r.renewalCount,
      }),
      (r) => keysetCursorValues(workQueue ? r.dueAt : r.loanedAt, r.id),
    );
  }

  /**
   * Turn an `?after=` token back into the two values {@link list} pages on.
   *
   * A bare loan id is accepted as well as a token we minted, for the reason
   * `decodeCursor` states: every 1.0 controller documents `?after=` as a row id,
   * and a librarian who clicks "Load more" across a deploy must not be handed a
   * 400 halfway down the day's circulation. A cursor row that has since been
   * deleted resolves to `null`, which restarts them at page one — the one
   * answer that is always honest.
   *
   * WHAT THE TOKEN DOES NOT CARRY is which of the two orders minted it: the
   * shared two-value format has room for a sort value and an id and nothing
   * else, and `?overdue=` is what says which column that value came from. So a
   * client that flips the queue on mid-scroll must drop the cursor with it —
   * handing a `loaned_at` boundary to the `due_at` order resumes at a real but
   * unrelated position rather than failing. `?overdue=` and `?after=` are one
   * decision and the UI sends them together.
   */
  private async decodeLoanCursor(
    client: ReturnType<TenantPrismaService['getClientV2']>,
    after: string | undefined,
    sortField: 'dueAt' | 'loanedAt',
  ): Promise<KeysetBoundary | null> {
    if (after === undefined || after.length === 0) return null;
    // `sortIsDate`, because both orders sort on a `timestamptz`: the token
    // carries an ISO string and the predicate needs a Date. An unparseable one
    // is rejected here rather than reaching Prisma as `Invalid Date`, which
    // renders as NULL and silently matches nothing.
    const parts = readKeysetCursor(after, { sortIsDate: true });
    if (parts) return parts;
    const row = await client.loan.findUnique({
      where: { id: after },
      select: { id: true, loanedAt: true, dueAt: true },
    });
    if (row === null) return null;
    return { sort: sortField === 'dueAt' ? row.dueAt : row.loanedAt, id: row.id };
  }

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

/**
 * Every state `lbr2.loan_status` has — SIX, where 1.0 had three.
 *
 * A runtime array and a type derived from it, rather than a bare union, because
 * `LoanListQueryDto` has to validate `?status=` against exactly this set and a
 * second hand-written list is a list that drifts: the day a seventh state lands,
 * the union would compile and the query param would answer 400 for a status the
 * table holds.
 *
 * The first four are the OPEN set, and that is forced rather than chosen —
 * `loans_closed_consistency` is `(closed_at IS NULL) = (status IN
 * ('active','claims_returned','claims_never_borrowed','recalled'))`.
 * `claims_returned` deliberately keeps the loan open: the reader says they
 * brought it back, the shelf says otherwise, and the copy must not be
 * re-lendable while that is unresolved.
 */
export const LOAN_STATUS_VALUES = [
  'active',
  'recalled',
  'claims_returned',
  'claims_never_borrowed',
  'returned',
  'lost',
] as const;

export type LoanStatusValue = (typeof LOAN_STATUS_VALUES)[number];

/**
 * Every value `event_source` can hold, because this type is a READ.
 *
 * `migration` is in it and is NOT in the write-side unions in
 * `circulation.types.ts`, `item-status.service.ts`, `holds.service.ts` and the
 * six others. That asymmetry is deliberate and is the whole point of restating
 * the shape here: a librarian at a desk cannot perform a `migration`, so the
 * INPUT types must refuse it, while anything that reads a row the v1 to v2
 * upgrade wrote has to be able to name what it finds.
 *
 * Widening the input types instead would let a caller post a loan event
 * claiming to be the upgrade, months after the upgrade ran.
 */
export type ChannelValue =
  'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk' | 'migration';

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

/** What the loan list accepts. Validated by `LoanListQueryDto`. */
export type LoanListOptions = {
  readonly patronId?: string;
  readonly itemId?: string;
  readonly bibId?: string;
  readonly status?: LoanStatusValue;
  /** Active AND past due. Pins the status and flips the sort — see {@link LoanReadService.list}. */
  readonly overdue?: boolean;
  /**
   * The instant "overdue" is measured against, read ONCE by the caller.
   * Required even when `overdue` is false, so that a list cannot acquire a
   * clock read of its own the day somebody adds a second time-dependent filter.
   */
  readonly asOf: Date;
  readonly after?: string;
  readonly limit?: number;
};

/**
 * One row of the loan list.
 *
 * `id` is the LOAN id and is a literal `string`, because `DataTable` is
 * `T extends { id: string }` and uses it as the React key — a row keyed by
 * anything else re-mounts the whole page on every refresh.
 *
 * NO BIGINT CROSSES THIS BOUNDARY. There is no `BigInt.prototype.toJSON` in
 * this repo, so a raw `bigint` reaching `res.json()` throws `TypeError: Do not
 * know how to serialize a BigInt` — a 500 on a list that renders perfectly in a
 * unit test. `loans` has no money column (fees are their own table, and
 * `fees.controller.ts` serialises minor units as a DECIMAL STRING), so there is
 * nothing here to convert; the rule is written down because the next column
 * added to this row is the one that would break it.
 */
export type LoanListRow = {
  readonly id: string;
  readonly item: { readonly id: string; readonly barcode: string | null };
  /** NULL once the loan has been anonymised — see {@link LoanListRow.anonymisedAt}. */
  readonly patron: {
    readonly id: string;
    readonly fullName: string;
    readonly patronNumber: string | null;
  } | null;
  readonly bibId: string;
  readonly checkoutBranchId: string;
  readonly loanedAt: Date;
  readonly dueAt: Date;
  readonly returnedAt: Date | null;
  readonly closedAt: Date | null;
  /** Why `patron` is null. Erasure on return is the default, not an incident. */
  readonly anonymisedAt: Date | null;
  readonly status: LoanStatusValue;
  readonly renewalCount: number;
};

export type LoanListPage = ListResult<LoanListRow>;
