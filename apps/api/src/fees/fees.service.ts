import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { changeActorOf, setChangeActor } from '../tenancy/tenant-actor-guc.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantClockService } from '../policy/tenant-clock.service.js';
import { acquireLocks, lockKey } from '../platform/locks.js';
import { postJournalWithin, type LedgerAccount } from './ledger.js';
import { planRefund, planSettlement, type Allocation } from './fee-settlement.js';
import {
  clampLimit,
  keysetCursorValues,
  keysetPredicate,
  pageOf,
  readKeysetCursor,
  type KeysetBoundary,
  type ListResult,
} from '../platform/list.js';

/** What the fee list accepts. Validated by `FeeListQueryDto`. */
export type FeeListOptions = {
  readonly patronId?: string;
  readonly loanId?: string;
  readonly status?: string;
  readonly includeArchived?: boolean;
  readonly after?: string;
  readonly limit?: number;
};

/**
 * One row of the fee list.
 *
 * `id` is a literal `string` because `DataTable` is `T extends { id: string }`
 * and uses it as the React key; a row without one renders as a list of
 * identical children and React reconciles the wrong one on every update.
 *
 * SIX AMOUNTS, ALL STRINGS, ONE CURRENCY EACH. `owedCents` is the generated
 * column and the only number a reader should act on; the five counters beside it
 * are there so a receipt or a dispute can show how it got there, and they are
 * paired with `currency` on the SAME row rather than with a list-wide scalar —
 * a patron with EUR and GBP charges has two of these rows and no single currency
 * between them.
 */
export type FeeListRow = {
  readonly id: string;
  readonly patronId: string;
  readonly branchId: string;
  readonly loanId: string | null;
  readonly itemId: string | null;
  readonly holdId: string | null;
  readonly currency: string;
  readonly amountCents: string;
  readonly taxCents: string;
  readonly paidCents: string;
  readonly waivedCents: string;
  readonly writtenOffCents: string;
  readonly owedCents: string;
  readonly status: string;
  readonly isAccruing: boolean;
  readonly reason: string;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly feeType: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly category: string;
  };
};

/**
 * One fee in full: the list row plus the three columns the list refuses to
 * carry, and the account the charge posted to.
 *
 * `accrualPolicy` is NOT here. It is the resolved policy snapshot an accrual was
 * computed from — phase 13's `explain` surface owns rendering that, and a jsonb
 * blob whose shape is the resolver's private business would become a public
 * contract the moment a screen read a field out of it. `isAccruing` and
 * `accruedThrough` are the two facts a reader of a fee actually needs.
 */
export type FeeRead = FeeListRow & {
  readonly accountId: string;
  readonly bookingId: string | null;
  readonly accruedThrough: Date | null;
  readonly notes: string | null;
  readonly customFields: unknown;
};

type ClientV2 = ReturnType<TenantPrismaService['getClientV2']>;

/**
 * The columns a list row is built from — declared structurally rather than as
 * `Prisma.FeeGetPayload<…>` so this file needs no generated-type import. The
 * enum columns arrive as string unions and narrow into `string` on their own.
 */
type FeeColumns = {
  id: string;
  patronId: string;
  branchId: string;
  loanId: string | null;
  itemId: string | null;
  holdId: string | null;
  currency: string;
  amountCents: bigint;
  taxCents: bigint;
  paidCents: bigint;
  waivedCents: bigint;
  writtenOffCents: bigint;
  status: string;
  isAccruing: boolean;
  reason: string;
  createdAt: Date;
  closedAt: Date | null;
  archivedAt: Date | null;
  feeType: { id: string; code: string; name: string; category: string };
};

/**
 * The list's column list, named so it cannot drift from {@link FeeColumns}.
 *
 * `accrualPolicy`, `customFields` and `notes` are absent on purpose — see
 * `FeesService.list`. `feeType` is a nested explicit select and not an
 * `include`, because an `include` would pull every column of `fee_types` to
 * render a code and a name.
 */
const FEE_LIST_SELECT = {
  id: true,
  patronId: true,
  branchId: true,
  loanId: true,
  itemId: true,
  holdId: true,
  currency: true,
  amountCents: true,
  taxCents: true,
  paidCents: true,
  waivedCents: true,
  writtenOffCents: true,
  status: true,
  isAccruing: true,
  reason: true,
  createdAt: true,
  closedAt: true,
  archivedAt: true,
  feeType: { select: { id: true, code: true, name: true, category: true } },
} as const;

/** One fee: the list's columns, plus the ones a single row can afford. */
const FEE_READ_SELECT = {
  ...FEE_LIST_SELECT,
  accountId: true,
  bookingId: true,
  accruedThrough: true,
  notes: true,
  customFields: true,
} as const;

/**
 * What a borrower owes, and the record of what happened to it (2.0 phase 18).
 *
 * ## Every operation is one journal, one set of allocations, one counter write
 *
 * The shape is the same five lines every time, and that is the design rather
 * than a coincidence:
 *
 *   1. lock the patron, so two clerks cannot settle the same charge at once;
 *   2. re-read what is owed UNDER the lock, from `owed_cents`;
 *   3. plan the split in a pure function that cannot touch a database;
 *   4. post ONE journal (the balance trigger refuses anything else);
 *   5. write the allocations and move the counters in one statement each.
 *
 * Step 2 reads `owed_cents` and never `outstanding_cents`. The two differ for
 * exactly one row — a CANCELLED charge, which is closed without its settlement
 * counters moving — and reading the wrong one is how one desk shows a balance
 * the checkout gate cannot see. See the migration header, decision 4.
 *
 * ## The counters are written here, not derived by a trigger
 *
 * Deriving `paid_cents` and its two siblings from `fee_allocations` in an AFTER
 * trigger would make I2 unbreakable rather than merely checked, and it was the
 * strongest argument against this design. It is refused for three reasons: one
 * `fees` write would silently cause six others, phase 19's copy-forward would
 * have to fight the trigger to load history, and the keystone of that approach —
 * reading a STORED generated column inside the trigger that maintains it — is
 * not something this phase measured. What replaces it is cheap and sufficient:
 * the allocations and the counters move in the same transaction, and the nightly
 * reconciler asserts them against each other and ALERTS.
 */
@Injectable()
export class FeesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly clock: TenantClockService,
  ) {}

  /**
   * The patron's account for a currency, created if this is their first charge.
   *
   * ONE PER CURRENCY — the unique index says so, and the `ON CONFLICT DO
   * NOTHING` makes two concurrent first-charges settle in Postgres instead of
   * one of them raising 23505 at a desk. The DATA-1 lesson, applied to the
   * cheapest possible row.
   */
  async accountForWithin(tx: TxV2, patronId: string, currency: string, now: Date): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO patron_accounts (id, patron_id, currency, opened_at)
      VALUES (pg_catalog.gen_random_uuid()::text, ${patronId}, ${currency}, ${now})
      ON CONFLICT (patron_id, currency) DO NOTHING
      RETURNING id`;
    const created = rows[0]?.id;
    if (created !== undefined) return created;

    const existing = await tx.patronAccount.findUnique({
      where: { patronId_currency: { patronId, currency } },
      select: { id: true },
    });
    if (existing === null) {
      throw new Error(`patron_accounts row for ${patronId}/${currency} vanished after an upsert.`);
    }
    return existing.id;
  }

  /** What a patron owes, per currency. Always a set of rows, never a scalar. */
  async balances(
    tenant: TenantContext,
    patronId: string,
  ): Promise<{ currency: string; owedCents: bigint }[]> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.$queryRaw<{ currency: string; owed: bigint }[]>`
      SELECT currency, pg_catalog.sum(owed_cents)::bigint AS owed
        FROM fees
       WHERE patron_id = ${patronId} AND owed_cents > 0
       GROUP BY currency
       ORDER BY currency`;
    return rows.map((r) => ({ currency: r.currency, owedCents: BigInt(r.owed) }));
  }

  /**
   * The fee list — one patron's ledger, or one loan's (2.0 phase 20a).
   *
   * ## It refuses to list the whole ledger, and that refusal is the design
   *
   * `patronId` or `loanId` is REQUIRED. 1.0's fines list made both optional and
   * answered an unfiltered request with a parallel sequential scan of every fine
   * in the library plus a top-N heapsort — measured at 14.513 ms on page one of
   * 150,000 rows, before the row count that a library reaches in year three.
   * There is no screen that asks "show me every debt this library has ever
   * raised", so the query that serves it is pure cost, and the honest answer to
   * a caller who asks for it is a 400 that says what to filter by.
   *
   * The check lives here rather than in `FeeListQueryDto` because it is a
   * statement about the indexes, not about the shape of either field, and every
   * caller has to obey it — including the next one, which will not be HTTP.
   *
   * ## The sort walks an index that does not exist yet
   *
   * `(created_at DESC, id DESC)` under a `patron_id` or `loan_id` equality. The
   * indexes present today are `(patron_id, status)`, `(loan_id)` and the partial
   * `fees_owing_idx (patron_id, currency) WHERE closed_at IS NULL`; none of them
   * carries `created_at`, so Postgres filters on the patron and then SORTS. That
   * is survivable for a reader with nine fines and is not survivable for the
   * account that has accrued a fine a night for two years. Phase 20a does not
   * ship a migration; the operator adds
   *   CREATE INDEX fees_patron_created_idx ON lbr2.fees (patron_id, created_at DESC, id DESC);
   *   CREATE INDEX fees_loan_created_idx   ON lbr2.fees (loan_id,   created_at DESC, id DESC);
   * and the keyset predicate below becomes a start key instead of a filter.
   *
   * ## `direction: 'desc'` is not decoration
   *
   * It has to agree with the `orderBy` two lines under it. An ascending
   * predicate against a descending order returns the rows BEFORE the cursor, so
   * "Load more" walks back towards page one and the reader never reaches the end
   * of their own fines. Nothing throws; the list simply loops.
   */
  async list(tenant: TenantContext, opts: FeeListOptions = {}): Promise<ListResult<FeeListRow>> {
    const patronId = opts.patronId ?? null;
    const loanId = opts.loanId ?? null;
    if (patronId === null && loanId === null) {
      throw new BadRequestException('A fee list must be scoped to a patron or to a loan.');
    }

    const client = this.tenantPrisma.getClientV2(tenant);
    const limit = clampLimit(opts.limit);

    const where: Record<string, unknown> = {};
    if (patronId !== null) where['patronId'] = patronId;
    if (loanId !== null) where['loanId'] = loanId;
    if (opts.status !== undefined) where['status'] = opts.status;
    // Soft-deleted rows are hidden unless asked for. `owed_cents` already reads
    // `archived_at`, so an archived fee reports 0 owed; showing it beside live
    // debts with no explanation is how a desk chases money the library dropped.
    if (opts.includeArchived !== true) where['archivedAt'] = null;

    const after = await this.decodeListCursor(client, opts.after);
    if (after) {
      where['AND'] = keysetPredicate({ sortField: 'createdAt', direction: 'desc', after });
    }

    // EXPLICIT SELECT. `accrual_policy` and `custom_fields` are jsonb and
    // `notes` is unbounded text; a default `findMany` would select all three and
    // put a TOAST read on every row of every page of a screen that shows none of
    // them. They are what `read()` is for.
    const rows = await client.fee.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: FEE_LIST_SELECT,
    });

    const owed = await this.owedFor(
      client,
      rows.map((r) => r.id),
    );

    return pageOf(
      rows,
      limit,
      (r) => this.toListRow(r, owed.get(r.id)),
      (r) => keysetCursorValues(r.createdAt, r.id),
    );
  }

  /**
   * One fee, including the three columns the list deliberately leaves behind.
   *
   * An ARCHIVED fee is returned rather than 404'd. A librarian who followed a
   * link to a specific id is asking what happened to that charge, and "it does
   * not exist" is a false answer to that question — `archivedAt` on the row is
   * the true one. The list is where archiving hides things, because that is
   * where a reader would otherwise be shown a filed-away debt they did not ask
   * about.
   */
  async read(tenant: TenantContext, feeId: string): Promise<FeeRead> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const row = await client.fee.findUnique({ where: { id: feeId }, select: FEE_READ_SELECT });
    if (row === null) throw new NotFoundException(`No fee with id ${feeId}.`);

    const owed = await this.owedFor(client, [row.id]);
    return {
      ...this.toListRow(row, owed.get(row.id)),
      accountId: row.accountId,
      bookingId: row.bookingId,
      accruedThrough: row.accruedThrough,
      notes: row.notes,
      customFields: row.customFields,
    };
  }

  /**
   * `owed_cents` for the rows of one page, read from the GENERATED COLUMN.
   *
   * A second statement, and the alternative was worse. `owed_cents` is
   * `GENERATED ALWAYS … STORED`, and Prisma has no generated-column concept, so
   * it is absent from the `Fee` model and unreachable through `select`. The
   * tempting fix is to add the five counters up in TypeScript — and that is
   * precisely the defect the generated column was introduced to delete: the
   * migration's decision 4 records that two readers of the old
   * `outstanding_cents` already disagreed, and phase 19a then CHANGED the
   * expression to also read `archived_at`. A TypeScript copy would not have
   * changed with it, and a desk would today be showing a balance for debts the
   * library has filed away. One source, or none.
   *
   * The cost is a primary-key lookup of at most `limit + 1` ids, which is an
   * index scan of a hundred rows at the outside. The two statements run under
   * READ COMMITTED, so a settlement landing between them shows a row whose
   * `status` is one moment older than its `owedCents` — stale in the direction
   * of less money owed, never more. A row that vanished between them reports 0,
   * which cannot happen today: every FK into `fees` is `ON DELETE RESTRICT` and
   * nothing in the module deletes a fee.
   */
  private async owedFor(client: ClientV2, ids: readonly string[]): Promise<Map<string, bigint>> {
    if (ids.length === 0) return new Map();
    const rows = await client.$queryRaw<{ id: string; owed: bigint }[]>`
      SELECT id, owed_cents::bigint AS owed
        FROM fees
       WHERE id = ANY(${ids as string[]}::text[])`;
    return new Map(rows.map((r) => [r.id, BigInt(r.owed)]));
  }

  /**
   * Turn an `?after=` token back into the two values {@link list} pages on.
   *
   * A bare fee id is accepted as well as a token we minted, for the reason
   * `decodeCursor` states: 1.0's fines list documented `?after=` as a row id,
   * and a librarian clicking "Load more" while a deploy swaps the format must
   * not be handed a 400 halfway down a patron's account. A cursor naming a row
   * that is gone resolves to `null`, which restarts them at page one.
   */
  private async decodeListCursor(
    client: ClientV2,
    after: string | undefined,
  ): Promise<KeysetBoundary | null> {
    if (after === undefined || after.length === 0) return null;
    const parts = readKeysetCursor(after, { sortIsDate: true });
    if (parts) return parts;
    const row = await client.fee.findUnique({
      where: { id: after },
      select: { createdAt: true, id: true },
    });
    return row ? { sort: row.createdAt, id: row.id } : null;
  }

  /**
   * EVERY AMOUNT LEAVES AS A DECIMAL STRING OF MINOR UNITS.
   *
   * Not because a fee is large, but because of what happens if one is not: there
   * is no `BigInt.prototype.toJSON` in this repo, so a `bigint` reaching
   * `res.json` throws `TypeError: Do not know how to serialize a BigInt` — a 500
   * on a list that worked in every unit test, because no 2.0 spec had yet issued
   * an HTTP GET that returned one of these columns. `Number(bigint)` is the
   * other wrong answer: it silently becomes a double, which is the lossy type
   * the whole module exists to keep out of the ledger. `String(bigint)` is
   * exact, and `fees.dto.ts` already made it the convention on the way in.
   */
  private toListRow(row: FeeColumns, owedCents: bigint | undefined): FeeListRow {
    return {
      id: row.id,
      patronId: row.patronId,
      branchId: row.branchId,
      loanId: row.loanId,
      itemId: row.itemId,
      holdId: row.holdId,
      currency: row.currency,
      amountCents: String(row.amountCents),
      taxCents: String(row.taxCents),
      paidCents: String(row.paidCents),
      waivedCents: String(row.waivedCents),
      writtenOffCents: String(row.writtenOffCents),
      owedCents: String(owedCents ?? 0n),
      status: row.status,
      isAccruing: row.isAccruing,
      reason: row.reason,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      archivedAt: row.archivedAt,
      feeType: {
        id: row.feeType.id,
        code: row.feeType.code,
        name: row.feeType.name,
        category: row.feeType.category,
      },
    };
  }

  /**
   * Raise a charge that is not an accrual — a replacement cost, a printing
   * charge, a librarian typing a number.
   *
   * `tax_cents` is 0 and there is no way to pass one. Phase 18 does not wire
   * tax: every candidate design for this phase credited VAT at charge time and
   * never reversed it on a waiver, a write-off or a refund, so the library would
   * have remitted tax on money it never collected. The column and the
   * `tax_payable` account label both exist so the leg set does not change shape
   * when a library that charges VAT arrives.
   */
  async charge(
    tenant: TenantContext,
    actor: TenantActor,
    input: {
      readonly patronId: string;
      readonly feeTypeId: string;
      readonly branchId: string;
      readonly currency: string;
      readonly amountCents: bigint;
      readonly reason: string;
      readonly loanId?: string | null;
      readonly itemId?: string | null;
      readonly holdId?: string | null;
    },
  ): Promise<{ feeId: string; transactionId: string }> {
    if (input.amountCents <= 0n) {
      throw new BadRequestException('A charge must be for a positive amount.');
    }
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    return client.$transaction(async (tx) => {
      await acquireLocks(tx, [lockKey('patron', input.patronId)]);
      await setChangeActor(tx, changeActorOf(actor));

      const feeType = await tx.feeType.findUnique({
        where: { id: input.feeTypeId },
        select: { id: true, revenueAccount: true, archivedAt: true },
      });
      if (feeType === null || feeType.archivedAt !== null) {
        throw new NotFoundException(`No active fee type ${input.feeTypeId}.`);
      }

      const accountId = await this.accountForWithin(tx, input.patronId, input.currency, now);

      const fee = await tx.fee.create({
        data: {
          accountId,
          patronId: input.patronId,
          feeTypeId: feeType.id,
          currency: input.currency,
          branchId: input.branchId,
          amountCents: input.amountCents,
          loanId: input.loanId ?? null,
          itemId: input.itemId ?? null,
          holdId: input.holdId ?? null,
          reason: input.reason,
          createdAt: now,
        },
        select: { id: true },
      });

      const journal = await postJournalWithin(tx, {
        kind: 'charge',
        currency: input.currency,
        branchId: input.branchId,
        accountId,
        now,
        note: input.reason,
        actorUserId: actor.userId ?? null,
        legs: [
          { account: 'patron_receivable', accountId, debit: input.amountCents, feeId: fee.id },
          {
            account: feeType.revenueAccount as LedgerAccount,
            credit: input.amountCents,
            feeId: fee.id,
          },
        ],
      });

      return { feeId: fee.id, transactionId: journal.transactionId };
    });
  }

  /**
   * Money arrives, a debt is forgiven, or a debt is abandoned.
   *
   * The three share everything except which account the other leg lands on and
   * which counter moves, so they share a method rather than three near-copies
   * that drift. `payment` additionally needs to know where the money went, which
   * is the only asymmetry and is what `paymentMethodId` carries.
   */
  async settle(
    tenant: TenantContext,
    actor: TenantActor,
    input: {
      readonly patronId: string;
      readonly kind: 'payment' | 'waiver' | 'write_off';
      readonly currency: string;
      readonly branchId: string;
      readonly amountCents: bigint;
      readonly feeIds?: readonly string[];
      readonly paymentMethodId?: string | null;
      readonly drawerSessionId?: string | null;
      readonly clientChangeId?: string | null;
      readonly note?: string | null;
    },
  ): Promise<{ transactionId: string; allocations: readonly Allocation[]; creditCents: bigint }> {
    if (input.amountCents <= 0n) {
      throw new BadRequestException('A settlement must move money.');
    }
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    return client.$transaction(async (tx) => {
      await acquireLocks(tx, [lockKey('patron', input.patronId)]);
      await setChangeActor(tx, changeActorOf(actor));

      const accountId = await this.accountForWithin(tx, input.patronId, input.currency, now);

      // UNDER THE LOCK, and `owed_cents` rather than `outstanding_cents`.
      const open = await tx.$queryRaw<{ id: string; owed: bigint }[]>`
        SELECT id, owed_cents::bigint AS owed
          FROM fees
         WHERE patron_id = ${input.patronId}
           AND currency = ${input.currency}
           AND owed_cents > 0
         ORDER BY created_at, id`;

      const named =
        input.feeIds === undefined || input.feeIds.length === 0
          ? open
          : open.filter((f) => input.feeIds?.includes(f.id));

      const plan = planSettlement(
        input.amountCents,
        named.map((f) => ({ feeId: f.id, owedCents: BigInt(f.owed) })),
      );

      if (plan.unappliedCents > 0n && input.kind !== 'payment') {
        // Forgiving more than is owed is a typo, not a credit. Only money can
        // sit on a patron's account.
        throw new BadRequestException(
          `Cannot ${input.kind} ${input.amountCents}: only ${plan.appliedCents} is owed.`,
        );
      }

      const settlementAccount = await this.settlementAccountFor(tx, input);

      const legs = [
        ...plan.allocations.map((a) => ({
          account: 'patron_receivable' as const,
          accountId,
          credit: a.amountCents,
          feeId: a.feeId,
        })),
        ...(plan.unappliedCents > 0n
          ? [{ account: 'patron_credit' as const, accountId, credit: plan.unappliedCents }]
          : []),
        { account: settlementAccount, debit: input.amountCents },
      ];

      const journal = await postJournalWithin(tx, {
        kind: input.kind,
        currency: input.currency,
        branchId: input.branchId,
        accountId,
        paymentMethodId: input.paymentMethodId ?? null,
        drawerSessionId: input.drawerSessionId ?? null,
        clientChangeId: input.clientChangeId ?? null,
        actorUserId: actor.userId ?? null,
        note: input.note ?? null,
        now,
        legs,
      });

      await this.applyAllocations(
        tx,
        journal.transactionId,
        input.kind,
        input.currency,
        plan.allocations,
        now,
      );

      return {
        transactionId: journal.transactionId,
        allocations: plan.allocations,
        creditCents: plan.unappliedCents,
      };
    });
  }

  /**
   * Give money back. A NEGATIVE payment allocation, never a fourth counter.
   *
   * Newest settlement first, and bounded by what was actually paid — refunding
   * against `amount_cents` is how a library refunds money it never took.
   */
  async refund(
    tenant: TenantContext,
    actor: TenantActor,
    input: {
      readonly patronId: string;
      readonly currency: string;
      readonly branchId: string;
      readonly amountCents: bigint;
      readonly feeIds?: readonly string[];
      readonly paymentMethodId?: string | null;
      readonly drawerSessionId?: string | null;
      readonly note?: string | null;
    },
  ): Promise<{ transactionId: string; allocations: readonly Allocation[] }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const now = this.clock.now();

    return client.$transaction(async (tx) => {
      await acquireLocks(tx, [lockKey('patron', input.patronId)]);
      await setChangeActor(tx, changeActorOf(actor));

      const accountId = await this.accountForWithin(tx, input.patronId, input.currency, now);

      const paid = await tx.$queryRaw<{ id: string; paid: bigint }[]>`
        SELECT id, paid_cents::bigint AS paid
          FROM fees
         WHERE patron_id = ${input.patronId}
           AND currency = ${input.currency}
           AND paid_cents > 0
         ORDER BY created_at, id`;

      const named =
        input.feeIds === undefined || input.feeIds.length === 0
          ? paid
          : paid.filter((f) => input.feeIds?.includes(f.id));

      const plan = planRefund(
        input.amountCents,
        named.map((f) => ({ feeId: f.id, paidCents: BigInt(f.paid) })),
      );

      const settlementAccount = await this.settlementAccountFor(tx, input);

      const journal = await postJournalWithin(tx, {
        kind: 'refund',
        currency: input.currency,
        branchId: input.branchId,
        accountId,
        paymentMethodId: input.paymentMethodId ?? null,
        drawerSessionId: input.drawerSessionId ?? null,
        actorUserId: actor.userId ?? null,
        note: input.note ?? null,
        now,
        // The mirror of a payment: the receivable goes back UP and the money
        // leaves. Sides swapped, no negative in the general ledger.
        legs: [
          ...plan.allocations.map((a) => ({
            account: 'patron_receivable' as const,
            accountId,
            debit: -a.amountCents,
            feeId: a.feeId,
          })),
          { account: settlementAccount, credit: input.amountCents },
        ],
      });

      await this.applyAllocations(
        tx,
        journal.transactionId,
        'refund',
        input.currency,
        plan.allocations,
        now,
      );

      return { transactionId: journal.transactionId, allocations: plan.allocations };
    });
  }

  /** Which asset account money moves through, from the named method. */
  private async settlementAccountFor(
    tx: TxV2,
    input: { readonly kind?: string; readonly paymentMethodId?: string | null },
  ): Promise<LedgerAccount> {
    if (input.kind === 'waiver') return 'waiver_expense';
    if (input.kind === 'write_off') return 'bad_debt_expense';
    if ((input.paymentMethodId ?? null) === null) {
      throw new BadRequestException('Money that moved needs a payment method.');
    }
    const method = await tx.paymentMethod.findUnique({
      where: { id: input.paymentMethodId as string },
      select: { settlementAccount: true, archivedAt: true },
    });
    if (method === null || method.archivedAt !== null) {
      throw new NotFoundException(`No active payment method ${input.paymentMethodId}.`);
    }
    return method.settlementAccount as LedgerAccount;
  }

  /**
   * Write the allocations and move the counters.
   *
   * ONE statement per fee, moving the counter, the status and `closed_at`
   * together. Splitting the counter write from the status write was measured
   * unwritable under `fees_settlement_within_charge` anyway — the intermediate
   * state violates the CHECK — and it would leave a window in which a fully paid
   * fee is not closed.
   *
   * `is_accruing` is cleared alongside. See the migration header, decision 6:
   * a waived accrual that stayed accruing would fall out of
   * `fees_one_open_accrual_per_loan` (predicated on `closed_at IS NULL`) and the
   * next sweep would raise a SECOND fine against the same loan, so the reader is
   * forgiven and charged again the same night.
   */
  private async applyAllocations(
    tx: TxV2,
    transactionId: string,
    kind: 'payment' | 'waiver' | 'write_off' | 'refund',
    currency: string,
    allocations: readonly Allocation[],
    now: Date,
  ): Promise<void> {
    if (allocations.length === 0) return;

    await tx.feeAllocation.createMany({
      data: allocations.map((a) => ({
        transactionId,
        feeId: a.feeId,
        kind,
        currency,
        amountCents: a.amountCents,
        createdAt: now,
      })),
    });

    // A refund is a negative PAYMENT for counter purposes: `paid_cents` is one
    // sum that moves both ways, which is what keeps I2 three comparisons.
    const column =
      kind === 'waiver'
        ? 'waived_cents'
        : kind === 'write_off'
          ? 'written_off_cents'
          : 'paid_cents';
    const status = kind === 'waiver' ? 'waived' : kind === 'write_off' ? 'written_off' : 'paid';

    for (const a of allocations) {
      // ONE statement, and the three dependent columns are computed from the
      // SAME expression so they cannot disagree. Written symmetrically on
      // purpose: a refund carries a NEGATIVE amount, so the settled test goes
      // false again and the row REOPENS — status back to outstanding, closed_at
      // back to NULL. An earlier draft only handled the settling direction and
      // left a refunded fee reading `paid` while it owed money, which is exactly
      // the drift I2 would have reported at 03:00 instead of preventing.
      await tx.$executeRawUnsafe(
        `UPDATE fees
            SET ${column} = ${column} + $1,
                status = CASE
                  WHEN amount_cents + tax_cents
                       - paid_cents - waived_cents - written_off_cents - $1 <= 0
                  THEN CAST($2 AS fee_status)
                  ELSE CAST('outstanding' AS fee_status) END,
                closed_at = CASE
                  WHEN amount_cents + tax_cents
                       - paid_cents - waived_cents - written_off_cents - $1 <= 0
                  THEN CAST($3 AS timestamptz) ELSE NULL END,
                is_accruing = CASE
                  WHEN amount_cents + tax_cents
                       - paid_cents - waived_cents - written_off_cents - $1 <= 0
                  THEN false ELSE is_accruing END
          WHERE id = $4`,
        a.amountCents,
        status,
        now,
        a.feeId,
      );
    }
  }
}
