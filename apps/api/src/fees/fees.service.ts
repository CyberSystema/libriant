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
      INSERT INTO lbr2.patron_accounts (id, patron_id, currency, opened_at)
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
        FROM lbr2.fees
       WHERE patron_id = ${patronId} AND owed_cents > 0
       GROUP BY currency
       ORDER BY currency`;
    return rows.map((r) => ({ currency: r.currency, owedCents: BigInt(r.owed) }));
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
          FROM lbr2.fees
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
          FROM lbr2.fees
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
        `UPDATE lbr2.fees
            SET ${column} = ${column} + $1,
                status = CASE
                  WHEN amount_cents + tax_cents
                       - paid_cents - waived_cents - written_off_cents - $1 <= 0
                  THEN CAST($2 AS lbr2.fee_status)
                  ELSE CAST('outstanding' AS lbr2.fee_status) END,
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
