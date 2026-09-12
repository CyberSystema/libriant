import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { postJournalWithin } from './ledger.js';
import type { LedgerAccount } from './ledger.js';

/**
 * The overdue accrual, and the two things it gets right that are easy to get
 * wrong (2.0 phase 18).
 *
 * ## 1. THE CHARGE IS A RECOMPUTED TOTAL, NEVER AN ADDED WINDOW
 *
 * `accrueOverdue` takes an optional `since`, and its docblock offers it as
 * "fees.accrued_through for an increment". MEASURED ON THIS TREE, that is wrong
 * for every policy except a plain daily fine charged in arrears. Six nights
 * overdue at EUR 1.00 per interval, total-recomputed against nightly-windowed:
 *
 *   daily, chargeAt intervalEnd        600   600   agree
 *   daily, chargeAt intervalStart      700  1200   overcharged by EUR 5.00
 *   every 3 days, intervalEnd          200     0   THE PATRON IS NEVER CHARGED
 *   every 3 days, intervalStart        300   600   doubled
 *   daily, minimumFine EUR 2.00        600  1200   doubled
 *
 * Three separate causes, all in packages/circ-policy/src/fines.ts: `completed`
 * is floor(elapsed) + 1 when chargeAt is intervalStart, so a nightly window adds
 * a spurious interval EVERY night; `intervalsBetween` returns a FRACTION, so
 * floor is not additive — floor(4/3) is 1 while floor(2/3) + floor(2/3) is 0;
 * and `minimumFine` is a per-call floor, so a nightly sweep applies the
 * library's minimum once a night.
 *
 * NO RECONCILIATION IDENTITY CATCHES THIS. The ledger balances perfectly on a
 * number that is double, which is what makes it worth a docblock this long.
 *
 * ## 2. THE DELTA IS THE LEDGER'S OWN OPINION, NOT A REMEMBERED NUMBER
 *
 * Having recomputed the total, the journal must post only the difference. The
 * obvious way is to read the fee, subtract, and write — and that is the DATA-1
 * race in a new place: under READ COMMITTED the read sees the statement
 * snapshot while the upsert below follows the LATEST row version, so a sweep
 * committing in the window makes the two disagree and the charge is posted
 * twice.
 *
 * So the delta is derived from the ledger instead: what the receivable already
 * carries for this fee, subtracted from what the fee now says it is. That is
 * true whatever raced, it converges rather than drifting, and re-running the
 * sweep twice in one night posts nothing the second time.
 */

/** What `accrueOverdue` produced, plus the identity of the loan it is for. */
export type AccrualInput = {
  readonly loanId: string;
  readonly patronId: string;
  readonly accountId: string;
  readonly feeTypeId: string;
  readonly revenueAccount: LedgerAccount;
  readonly branchId: string;
  readonly currency: string;
  readonly itemId: string | null;
  /** The RECOMPUTED TOTAL from `dueAt`. Never a window. See the docblock. */
  readonly totalCents: bigint;
  /** How far the recomputation priced. */
  readonly accruedThrough: Date;
  readonly reason: string;
  readonly now: Date;
};

export type AccrualOutcome = {
  readonly feeId: string;
  /** What the journal moved. Zero when the total had not changed. */
  readonly deltaCents: bigint;
  readonly transactionId: string | null;
};

/**
 * Raise or top up the one open accruing fine for a loan.
 *
 * THE UPSERT IS THE DATA-1 FIX, VERBATIM. `fees_one_open_accrual_per_loan` is
 * the arbiter, and the `ON CONFLICT` repeats its predicate exactly — the
 * inference is unforgiving and reports every mistake as the same 42P10, and
 * naming the index as a CONSTRAINT is 42704 because a partial unique index is
 * not a constraint (both measured in phase 14).
 *
 * It is raw SQL because Prisma's `upsert` cannot target a partial unique index;
 * it only knows about `@@unique`.
 *
 * The arbiter's predicate is a boolean and two NULL tests and contains NO enum,
 * which is what makes it usable at all: an `ON CONFLICT` arbiter carrying an
 * enum predicate raises 42P10 through Prisma's parameterised cast while working
 * by hand in psql (measured in phase 15).
 *
 * `GREATEST` because an overdue fine only grows. A policy edited downward does
 * not claw back money a reader has already been told they owe, and the cap in
 * `accrueOverdue` stops it rather than this line.
 */
export async function accrueWithin(tx: TxV2, input: AccrualInput): Promise<AccrualOutcome> {
  const rows = await tx.$queryRaw<{ id: string; charged: bigint }[]>`
    INSERT INTO fees (
      id, account_id, patron_id, fee_type_id, currency, loan_id, item_id, branch_id,
      amount_cents, is_accruing, accrued_through, reason, created_at
    )
    VALUES (
      pg_catalog.gen_random_uuid()::text,
      ${input.accountId}, ${input.patronId}, ${input.feeTypeId}, ${input.currency},
      ${input.loanId}, ${input.itemId}, ${input.branchId},
      ${input.totalCents}, true, ${input.accruedThrough}, ${input.reason}, ${input.now}
    )
    ON CONFLICT (loan_id) WHERE loan_id IS NOT NULL AND is_accruing AND closed_at IS NULL
    DO UPDATE SET
      -- greatest is BARE. Like COALESCE, NULLIF and LEAST it is a SQL
      -- CONSTRUCT and not a function, so pg_catalog.greatest(...) is 42883 —
      -- which is what this line raised the first time anything called it, in
      -- phase 20b-ii. checkout.service.ts and holds.service.ts each carry a
      -- comment about the same trap; this file shipped it because nothing
      -- invoked accrueWithin until the overdue sweep did.
      amount_cents    = greatest(fees.amount_cents, EXCLUDED.amount_cents),
      accrued_through = EXCLUDED.accrued_through
    RETURNING id, (amount_cents + tax_cents) AS charged`;

  const fee = rows[0];
  if (fee === undefined) {
    // ON CONFLICT DO UPDATE always returns its row, so an empty result means the
    // arbiter did not match what this statement thought it would.
    throw new Error(`The accrual upsert for loan ${input.loanId} returned no row.`);
  }

  // What the receivable already carries for this charge. Derived, not
  // remembered — see decision 2 in the docblock.
  const posted = await tx.$queryRaw<{ already: bigint }[]>`
    SELECT COALESCE(pg_catalog.sum(debit_cents - credit_cents), 0)::bigint AS already
      FROM account_entries
     WHERE fee_id = ${fee.id} AND account = 'patron_receivable'`;

  const already = posted[0]?.already ?? 0n;
  const delta = BigInt(fee.charged) - BigInt(already);
  if (delta === 0n) {
    return { feeId: fee.id, deltaCents: 0n, transactionId: null };
  }

  // A negative delta cannot arise from GREATEST, but it can arise from a fee
  // whose charge was partly reversed. Posting it as a cancellation keeps the
  // sides honest rather than writing a negative debit, which the XOR refuses.
  const grew = delta > 0n;
  const magnitude = grew ? delta : -delta;
  const journal = await postJournalWithin(tx, {
    kind: grew ? 'charge' : 'cancellation',
    currency: input.currency,
    branchId: input.branchId,
    accountId: input.accountId,
    now: input.now,
    note: input.reason,
    legs: grew
      ? [
          {
            account: 'patron_receivable',
            accountId: input.accountId,
            debit: magnitude,
            feeId: fee.id,
          },
          { account: input.revenueAccount, credit: magnitude, feeId: fee.id },
        ]
      : [
          { account: input.revenueAccount, debit: magnitude, feeId: fee.id },
          {
            account: 'patron_receivable',
            accountId: input.accountId,
            credit: magnitude,
            feeId: fee.id,
          },
        ],
  });

  return { feeId: fee.id, deltaCents: delta, transactionId: journal.transactionId };
}
