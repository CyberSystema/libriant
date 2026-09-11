import { randomUUID } from 'node:crypto';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

/**
 * THE ONLY WAY A LEDGER ENTRY IS WRITTEN (2.0 phase 18).
 *
 * ## Why this is one function and not an `create` call at each site
 *
 * Eight operations post journals — charge, pay, waive, write off, refund,
 * cancel, reverse and a drawer that did not count — and every one of them is
 * two or three legs that must sum. A second writer is a second chance for one
 * of them to post a single leg, and a one-legged journal balances only at zero.
 *
 * The database agrees, and that is what makes this enforceable rather than
 * conventional. `account_entries_balance` is a STATEMENT-level trigger, so the
 * legs of one journal must arrive in ONE insert: a half-journal written on its
 * own is refused with 23514 even though the transaction would balance by the
 * end. There is therefore no way to write an entry incrementally, and this
 * function is the only thing in the codebase that writes them all at once.
 *
 * ## Debits and credits, not signs
 *
 * Both columns are non-negative and exactly one of them is positive. A reversal
 * SWAPS the sides rather than negating an amount, so no negative number ever
 * appears in the general ledger — which is why `sum(debit_cents)` is a
 * meaningful number on its own and a trial balance prints.
 *
 * The signed amount in this module is `fee_allocations.amount_cents`, one layer
 * up, where the sign is the difference between a payment and a refund of it.
 */

/** Which chart-of-accounts label a leg lands on. Mirrors the `ledger_account` enum. */
export type LedgerAccount =
  | 'patron_receivable'
  | 'patron_credit'
  | 'cash_on_hand'
  | 'bank'
  | 'card_clearing'
  | 'fine_revenue'
  | 'replacement_revenue'
  | 'service_revenue'
  | 'tax_payable'
  | 'waiver_expense'
  | 'bad_debt_expense'
  | 'cash_over_short';

export type LedgerTxKind =
  | 'charge'
  | 'payment'
  | 'waiver'
  | 'write_off'
  | 'refund'
  | 'cancellation'
  | 'reversal'
  | 'cash_over_short';

/**
 * The two accounts that are a PATRON's, not the library's.
 *
 * A leg on either carries an `account_id` and a leg on any other must not — a
 * CHECK enforces the iff, and this constant is what the service side uses so
 * the two cannot drift apart.
 */
export const SUBSIDIARY_ACCOUNTS: ReadonlySet<LedgerAccount> = new Set([
  'patron_receivable',
  'patron_credit',
]);

export function isSubsidiary(account: LedgerAccount): boolean {
  return SUBSIDIARY_ACCOUNTS.has(account);
}

/** One leg. Exactly one of `debit` and `credit` is given and positive. */
export type Leg = {
  readonly account: LedgerAccount;
  /** Required exactly when `account` is subsidiary. */
  readonly accountId?: string | null;
  readonly debit?: bigint;
  readonly credit?: bigint;
  /** Which charge this leg concerns, when it concerns one. */
  readonly feeId?: string | null;
};

export type JournalInput = {
  readonly kind: LedgerTxKind;
  readonly currency: string;
  readonly branchId: string;
  readonly legs: readonly Leg[];
  readonly accountId?: string | null;
  readonly drawerSessionId?: string | null;
  readonly paymentMethodId?: string | null;
  readonly reversesTransactionId?: string | null;
  readonly actorUserId?: string | null;
  readonly source?: 'desk' | 'opac' | 'sip2' | 'ncip' | 'api' | 'offline' | 'kiosk';
  readonly deviceId?: string | null;
  readonly clientChangeId?: string | null;
  readonly note?: string | null;
  readonly now: Date;
};

export type PostedJournal = {
  readonly transactionId: string;
  readonly totalCents: bigint;
};

/** A journal that this code can already see is not a journal. */
export class LedgerError extends Error {
  constructor(
    readonly code:
      | 'noLegs'
      | 'unbalanced'
      | 'legHasBothSides'
      | 'legHasNeitherSide'
      | 'negativeLeg'
      | 'subsidiaryWithoutAccount'
      | 'accountOnLibraryLeg',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Check the journal here as well as in the database, and mean both.
 *
 * The trigger is the guarantee; this is the error message. A 23514 naming a
 * transaction id tells an operator that something is wrong and nothing about
 * which leg, because by then the statement has been rolled back and the rows are
 * gone. Refusing here names the leg while it is still in a variable.
 *
 * It is deliberately NOT the only check. Every argument for putting validation
 * in the service is an argument that holds until somebody writes a second
 * service, which is exactly what the trigger exists for.
 */
export function assertBalanced(legs: readonly Leg[]): bigint {
  if (legs.length < 2) {
    throw new LedgerError('noLegs', `A journal needs at least two legs; got ${legs.length}.`);
  }
  let debits = 0n;
  let credits = 0n;
  for (const [i, leg] of legs.entries()) {
    const d = leg.debit ?? 0n;
    const c = leg.credit ?? 0n;
    if (d < 0n || c < 0n) {
      throw new LedgerError('negativeLeg', `Leg ${i} (${leg.account}) is negative.`);
    }
    if (d > 0n && c > 0n) {
      throw new LedgerError(
        'legHasBothSides',
        `Leg ${i} (${leg.account}) is both a debit and a credit.`,
      );
    }
    if (d === 0n && c === 0n) {
      throw new LedgerError('legHasNeitherSide', `Leg ${i} (${leg.account}) moves nothing.`);
    }
    if (isSubsidiary(leg.account) && (leg.accountId ?? null) === null) {
      throw new LedgerError(
        'subsidiaryWithoutAccount',
        `Leg ${i} is on ${leg.account}, which is a patron's account, and names no account_id.`,
      );
    }
    if (!isSubsidiary(leg.account) && (leg.accountId ?? null) !== null) {
      throw new LedgerError(
        'accountOnLibraryLeg',
        `Leg ${i} is on ${leg.account}, which is the library's, and names an account_id.`,
      );
    }
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw new LedgerError(
      'unbalanced',
      `A journal must balance: ${debits} debit against ${credits} credit.`,
    );
  }
  return debits;
}

/**
 * Post one journal. ONE statement for the header, ONE for every leg.
 *
 * The legs go in a single `createMany` because the balance trigger fires per
 * statement — see the file docblock. `randomUUID` is only for the entry ids,
 * which have no meaning outside this table.
 */
export async function postJournalWithin(tx: TxV2, input: JournalInput): Promise<PostedJournal> {
  const totalCents = assertBalanced(input.legs);

  const transaction = await tx.accountTransaction.create({
    data: {
      kind: input.kind,
      currency: input.currency,
      totalCents,
      branchId: input.branchId,
      accountId: input.accountId ?? null,
      drawerSessionId: input.drawerSessionId ?? null,
      paymentMethodId: input.paymentMethodId ?? null,
      reversesTransactionId: input.reversesTransactionId ?? null,
      actorUserId: input.actorUserId ?? null,
      ...(input.source === undefined ? {} : { source: input.source }),
      deviceId: input.deviceId ?? null,
      clientChangeId: input.clientChangeId ?? null,
      note: input.note ?? null,
      createdAt: input.now,
    },
    select: { id: true },
  });

  await tx.accountEntry.createMany({
    data: input.legs.map((leg) => ({
      id: randomUUID(),
      transactionId: transaction.id,
      account: leg.account,
      accountId: leg.accountId ?? null,
      currency: input.currency,
      debitCents: leg.debit ?? 0n,
      creditCents: leg.credit ?? 0n,
      feeId: leg.feeId ?? null,
      createdAt: input.now,
    })),
  });

  return { transactionId: transaction.id, totalCents };
}
