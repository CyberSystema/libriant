import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

/**
 * The three statements that decide whether the ledger is still true
 * (2.0 phase 18).
 *
 * ## They REPORT. They never repair.
 *
 * §8 risk 7 is explicit and this module is the answer to it: a self-healing
 * reconciler hides the bug that caused the drift. Every function here returns
 * rows; writing them to `ledger_discrepancies` and emitting the metric is the
 * job's business, and nothing in this file or that one issues an UPDATE against
 * a fee, an allocation or an entry.
 *
 * ## Why there are three and not one
 *
 * They fail for different reasons and need different repairs, which is the first
 * thing an operator has to know:
 *
 *   I1  a transaction whose legs do not sum. The balance trigger makes this
 *       UNWRITABLE, so a row here does not mean the application has a bug — it
 *       means the trigger was dropped, or a superuser wrote around it, or the
 *       data arrived from somewhere that is not this application. It is checked
 *       anyway precisely because it should be impossible: a tripwire on the
 *       guarantee itself.
 *   I2  a fee whose allocations disagree with its own counters. This is the one
 *       an application bug produces, because the counters are written by a
 *       service and the allocations are the record of what it meant to do.
 *   I3  an account whose receivable balance disagrees with the fees behind it.
 *       This is the number a patron sees, and it is the one that has to be right
 *       at a desk.
 *
 * No backticks appear in any comment below: the SQL is inside a JS template
 * literal and one would end it mid-sentence.
 */

export type Drift = {
  readonly subjectId: string;
  readonly currency: string;
  readonly expectedCents: bigint;
  readonly actualCents: bigint;
  readonly detail: Record<string, unknown>;
};

/** I1 — every transaction balances, in one currency, across at least two legs. */
export async function findUnbalancedTransactions(tx: TxV2): Promise<Drift[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      currency: string;
      debits: bigint;
      credits: bigint;
      legs: bigint;
      header: bigint;
    }[]
  >`
    SELECT t.id,
           t.currency,
           COALESCE(pg_catalog.sum(e.debit_cents), 0)::bigint  AS debits,
           COALESCE(pg_catalog.sum(e.credit_cents), 0)::bigint AS credits,
           pg_catalog.count(e.id)::bigint                      AS legs,
           t.total_cents::bigint                               AS header
      FROM lbr2.account_transactions t
      LEFT JOIN lbr2.account_entries e ON e.transaction_id = t.id
     GROUP BY t.id, t.currency, t.total_cents
    HAVING COALESCE(pg_catalog.sum(e.debit_cents), 0) <> COALESCE(pg_catalog.sum(e.credit_cents), 0)
        OR pg_catalog.count(e.id) < 2
        OR COALESCE(pg_catalog.sum(e.debit_cents), 0) <> t.total_cents`;
  return rows.map((r) => ({
    subjectId: r.id,
    currency: r.currency,
    expectedCents: BigInt(r.credits),
    actualCents: BigInt(r.debits),
    detail: { legs: Number(r.legs), headerTotalCents: String(r.header) },
  }));
}

/**
 * I2 — per fee, the sum of allocations of each kind equals the counter of that
 * name.
 *
 * A refund is a negative PAYMENT allocation, so it is summed into the payment
 * comparison rather than compared separately; that is what keeps this three
 * comparisons instead of four and what makes paid_cents a single sum.
 */
export async function findFeeCounterDrift(tx: TxV2): Promise<Drift[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      currency: string;
      paid: bigint;
      waived: bigint;
      written: bigint;
      alloc_paid: bigint;
      alloc_waived: bigint;
      alloc_written: bigint;
    }[]
  >`
    SELECT f.id,
           f.currency,
           f.paid_cents::bigint        AS paid,
           f.waived_cents::bigint      AS waived,
           f.written_off_cents::bigint AS written,
           COALESCE(pg_catalog.sum(a.amount_cents)
             FILTER (WHERE a.kind IN ('payment', 'refund')), 0)::bigint AS alloc_paid,
           COALESCE(pg_catalog.sum(a.amount_cents)
             FILTER (WHERE a.kind = 'waiver'), 0)::bigint               AS alloc_waived,
           COALESCE(pg_catalog.sum(a.amount_cents)
             FILTER (WHERE a.kind = 'write_off'), 0)::bigint            AS alloc_written
      FROM lbr2.fees f
      LEFT JOIN lbr2.fee_allocations a ON a.fee_id = f.id
     GROUP BY f.id, f.currency, f.paid_cents, f.waived_cents, f.written_off_cents
    HAVING f.paid_cents <> COALESCE(pg_catalog.sum(a.amount_cents)
             FILTER (WHERE a.kind IN ('payment', 'refund')), 0)
        OR f.waived_cents <> COALESCE(pg_catalog.sum(a.amount_cents)
             FILTER (WHERE a.kind = 'waiver'), 0)
        OR f.written_off_cents <> COALESCE(pg_catalog.sum(a.amount_cents)
             FILTER (WHERE a.kind = 'write_off'), 0)`;
  return rows.map((r) => ({
    subjectId: r.id,
    currency: r.currency,
    expectedCents: BigInt(r.alloc_paid) + BigInt(r.alloc_waived) + BigInt(r.alloc_written),
    actualCents: BigInt(r.paid) + BigInt(r.waived) + BigInt(r.written),
    detail: {
      paid: { counter: String(r.paid), allocations: String(r.alloc_paid) },
      waived: { counter: String(r.waived), allocations: String(r.alloc_waived) },
      writtenOff: { counter: String(r.written), allocations: String(r.alloc_written) },
    },
  }));
}

/**
 * I3 — per account, what the receivable carries equals what the fees behind it
 * still owe.
 *
 * The receivable side is the general ledger: debits raise a debt and credits
 * settle it, so the balance is sum(debit) - sum(credit). The fee side reads
 * owed_cents, which is the generated column and therefore the same number every
 * other reader sees, including the gate that blocks a checkout.
 *
 * A CANCELLED charge is why owed_cents exists rather than outstanding_cents: a
 * cancellation closes the row and reverses the revenue leg without moving a
 * settlement counter, so outstanding_cents stays positive on a debt that is
 * gone, and this identity would report every void as drift for ever.
 */
export async function findAccountBalanceDrift(tx: TxV2): Promise<Drift[]> {
  const rows = await tx.$queryRaw<
    { account_id: string; currency: string; ledger: bigint; fees: bigint }[]
  >`
    WITH ledger AS (
      SELECT e.account_id,
             e.currency,
             pg_catalog.sum(e.debit_cents - e.credit_cents)::bigint AS balance
        FROM lbr2.account_entries e
       WHERE e.account = 'patron_receivable'
       GROUP BY e.account_id, e.currency
    ),
    owed AS (
      SELECT f.account_id,
             f.currency,
             pg_catalog.sum(f.owed_cents)::bigint AS balance
        FROM lbr2.fees f
       GROUP BY f.account_id, f.currency
    )
    SELECT COALESCE(l.account_id, o.account_id) AS account_id,
           COALESCE(l.currency, o.currency)     AS currency,
           COALESCE(l.balance, 0)::bigint       AS ledger,
           COALESCE(o.balance, 0)::bigint       AS fees
      FROM ledger l
      FULL OUTER JOIN owed o
        ON o.account_id = l.account_id AND o.currency = l.currency
     WHERE COALESCE(l.balance, 0) <> COALESCE(o.balance, 0)`;
  return rows.map((r) => ({
    subjectId: r.account_id,
    currency: r.currency,
    expectedCents: BigInt(r.fees),
    actualCents: BigInt(r.ledger),
    detail: { receivableBalanceCents: String(r.ledger), feesOwedCents: String(r.fees) },
  }));
}
