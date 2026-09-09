import { addDuration } from './duedate.js';
import { calendarDaysBetween, openDaysBetween } from './calendar.js';
import {
  POLICY_ERROR,
  PolicyResolutionError,
  toMoney,
  type Calendar,
  type Duration,
  type LostItemFeePolicy,
  type MoneyJson,
  type OverdueFinePolicy,
} from './types.js';
import type { Money } from '@libriant/shared/money';

/**
 * What it costs.
 *
 * ## The whole file rounds nothing, deliberately
 *
 * `@libriant/shared/money` has `multiplyRounded`, and it rounds HALF TO EVEN —
 * €0.025 becomes €0.02 and €0.075 becomes €0.08. That is the correct default for
 * a ledger and the wrong answer for a fine, because it disagrees with the
 * librarian's spreadsheet on exactly the values a patron queries.
 *
 * The fix here is structural rather than a second rounding mode: a fine is
 * `amountPerInterval × completedIntervals`, an integer multiplied by an integer,
 * so no fraction of an interval ever exists and there is nothing to round. Koha,
 * Alma and FOLIO all charge this way. It also makes the offline Rust core's `i64`
 * mirror trivially identical — there is no tie-break rule for the two to
 * disagree about.
 *
 * ## Grace means three things
 *
 * 1. Returned inside `[dueAt, dueAt + grace)` → NO fine at all.
 * 2. Returned OUTSIDE it → the fine is measured from `dueAt`, **not** from the
 *    end of grace. A book five days late with three days' grace costs FIVE days.
 * 3. Whether grace also suppresses the NOTICE is a separate flag, because a
 *    library may want to warn without charging.
 *
 * (2) is the one libraries misconfigure and auditors catch, and it is invisible
 * in every test where the item comes back inside grace. Koha measures from the
 * due date and is right to.
 *
 * ## It is resumable, because phase 18 needs it to be
 *
 * `fees.accrued_through` means the sweep charges the difference rather than
 * recomputing a total, so {@link accrueOverdue} takes an explicit `since` and
 * returns what is owed for `[since, asOf)`. Passing `since = dueAt` gives the
 * whole fine; passing the last accrual instant gives the increment. Same
 * function, so the two can never disagree.
 */

export type OverdueInput = {
  readonly policy: OverdueFinePolicy;
  readonly calendar: Calendar;
  readonly dueAt: Date;
  /** The moment to price up to — a return, or a sweep's own clock. */
  readonly asOf: Date;
  /**
   * Charge only for the part after this instant. `dueAt` for a full
   * calculation; `fees.accrued_through` for an increment.
   */
  readonly since?: Date;
  /** What has already been charged, so `maximumFine` bounds the TOTAL. */
  readonly alreadyCharged?: MoneyJson;
  /** For `capAtReplacementCost`. */
  readonly replacementCost?: MoneyJson;
};

export type OverdueResult = {
  /** Owed for this window. Zero, never negative. */
  readonly amount: Money;
  /** Intervals charged for in this window. */
  readonly intervals: number;
  /** Whether the return fell inside the grace period. */
  readonly withinGrace: boolean;
  /** When grace ends — `loans.grace_period_ends_at`, computable at CHECKOUT. */
  readonly graceEndsAt: Date | null;
  /** Named when a cap bit, so a librarian can see why the number stopped. */
  readonly cappedBy: 'maximumFine' | 'replacementCost' | null;
};

/**
 * What an overdue costs for `[since, asOf)`.
 *
 * Returns an AMOUNT. It does not create a fee, touch a ledger or know a fee id —
 * the moment it took one of those it would be phase 18, and phase 18's job is to
 * record what this computes.
 */
export function accrueOverdue(input: OverdueInput): OverdueResult {
  const { policy, calendar, dueAt, asOf } = input;
  const currency = policy.amountPerInterval.currency;
  const zero: Money = { amount: 0n, currency };

  const graceEndsAt =
    policy.gracePeriod === null
      ? null
      : addDuration(calendar.timezone, dueAt, policy.gracePeriod, null);

  if (asOf <= dueAt) {
    return { amount: zero, intervals: 0, withinGrace: false, graceEndsAt, cappedBy: null };
  }
  if (graceEndsAt !== null && asOf < graceEndsAt) {
    return { amount: zero, intervals: 0, withinGrace: true, graceEndsAt, cappedBy: null };
  }

  // MEASURED FROM `dueAt`, NOT from the end of grace. See the file docblock.
  const from = input.since !== undefined && input.since > dueAt ? input.since : dueAt;
  const elapsed = intervalsBetween(policy, calendar, from, asOf);
  // `intervalEnd` charges for intervals that have FINISHED, so being one minute
  // late is free until the first whole day passes. `intervalStart` charges for
  // intervals that have BEGUN, so it is one more — and `+ 1` rather than
  // `Math.ceil` because a day-granular count is already an integer number of
  // calendar days, and `ceil(0)` is 0. One minute late under a
  // charged-up-front policy must cost a day, which is the whole difference
  // between the two settings.
  const completed =
    policy.chargeAt === 'intervalEnd' ? Math.floor(elapsed) : Math.floor(elapsed) + 1;
  if (completed <= 0) {
    return { amount: zero, intervals: 0, withinGrace: false, graceEndsAt, cappedBy: null };
  }

  // Integer × integer. Nothing to round, nothing for the Rust mirror to
  // disagree about.
  let amount: Money = {
    amount: BigInt(policy.amountPerInterval.minorUnits) * BigInt(completed),
    currency,
  };
  let cappedBy: OverdueResult['cappedBy'] = null;

  const already = input.alreadyCharged ? toMoney(input.alreadyCharged) : zero;
  if (policy.maximumFine !== null) {
    const max = toMoney(policy.maximumFine);
    const room = max.amount - already.amount;
    if (amount.amount > room) {
      amount = { amount: room > 0n ? room : 0n, currency };
      cappedBy = 'maximumFine';
    }
  }
  if (policy.capAtReplacementCost && input.replacementCost !== undefined) {
    const cost = toMoney(input.replacementCost);
    const room = cost.amount - already.amount;
    if (amount.amount > room) {
      amount = { amount: room > 0n ? room : 0n, currency };
      cappedBy = 'replacementCost';
    }
  }
  // `minimumFine` is a FLOOR on a non-zero charge, never a charge on a
  // non-overdue item: a library that sets one means "if you owe, you owe at
  // least this", not "everyone pays".
  if (policy.minimumFine !== null && amount.amount > 0n) {
    const min = toMoney(policy.minimumFine);
    if (amount.amount < min.amount && cappedBy === null) amount = min;
  }

  return { amount, intervals: completed, withinGrace: false, graceEndsAt, cappedBy };
}

/**
 * How many fine intervals fit between two instants.
 *
 * DAY-GRANULAR INTERVALS COUNT CALENDAR DAYS IN THE LIBRARY'S TIMEZONE — which
 * is the circ-5 fix, and the difference between the fine a librarian would write
 * down and the one 1.0 charges. `Math.floor((now - dueAt) / 86_400_000)` counts
 * whole 24-hour blocks since an instant, so a book due at 09:00 and returned at
 * 08:00 two days later is "one day overdue"; counting day numbers in the
 * branch's zone says two, which is what the person holding the book would say.
 *
 * `countClosedDays: false` then removes the days the patron could not have
 * returned it. That is not generosity — it is the only defensible answer for a
 * Greek library shut for three weeks in August.
 *
 * Hour- and minute-granular intervals are ELAPSED time and take no calendar at
 * all: a two-hour reserve loan is priced by the clock, and a library that closed
 * in between did not stop the hour passing.
 */
function intervalsBetween(
  policy: OverdueFinePolicy,
  calendar: Calendar,
  from: Date,
  to: Date,
): number {
  const { interval } = policy;
  if (interval.value <= 0) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyIncomplete,
      `Overdue fine policy ${policy.id} has an interval of ${interval.value} ${interval.unit}.`,
      policy.id,
    );
  }
  if (interval.unit === 'minutes' || interval.unit === 'hours') {
    const ms = interval.unit === 'minutes' ? 60_000 : 3_600_000;
    return (to.getTime() - from.getTime()) / (interval.value * ms);
  }
  const days = policy.countClosedDays
    ? calendarDaysBetween(calendar.timezone, from, to)
    : openDaysBetween(calendar, from, to, { countClosed: false });
  const perInterval = daysPerInterval(interval);
  return days / perInterval;
}

function daysPerInterval(d: Duration): number {
  if (d.unit === 'days') return d.value;
  if (d.unit === 'weeks') return d.value * 7;
  // A monthly fine interval is unusual and not worth a civil-month calculation
  // that would make the answer depend on which month the book was lost in. 30
  // days is what a library that writes "monthly" means.
  return d.value * 30;
}

/**
 * How many days a patron is suspended for an overdue.
 *
 * Continental and Greek libraries frequently suspend borrowing INSTEAD of
 * charging money, and an ILS that models only cash cannot express their actual
 * policy. This computes the DAYS; phase 14 writes the `patron_blocks` row.
 */
export function computeSuspensionDays(
  policy: OverdueFinePolicy,
  calendar: Calendar,
  dueAt: Date,
  returnedAt: Date,
): number {
  if (policy.suspension === null) return 0;
  const days = policy.countClosedDays
    ? calendarDaysBetween(calendar.timezone, dueAt, returnedAt)
    : openDaysBetween(calendar, dueAt, returnedAt, { countClosed: false });
  const raw = days * policy.suspension.daysPerOverdueDay;
  return policy.suspension.maxDays === null ? raw : Math.min(raw, policy.suspension.maxDays);
}

export type LostItemFeeInput = {
  readonly policy: LostItemFeePolicy;
  /** From the item, when the basis is `replacementPrice`. */
  readonly replacementPrice?: MoneyJson;
  /** From the item type, when the basis is `itemTypeDefault`. */
  readonly itemTypeDefault?: MoneyJson;
  /** What a librarian keyed in, when the basis is `actualCost`. */
  readonly actualCost?: MoneyJson;
};

export type LostItemFeeResult = {
  /** The book. */
  readonly replacement: Money;
  /** The admin charge, kept separate so "refund the book, keep the fee" works. */
  readonly processing: Money;
  readonly total: Money;
};

/**
 * What a lost item costs.
 *
 * `processingFee` is structurally separate from the replacement value, which is
 * what makes "refund the book but keep the admin charge" expressible. Koha
 * conflates them and libraries write manual credits to get the same effect.
 *
 * A `replacementPrice` basis on an item with no price REFUSES. Charging zero
 * would be a library silently writing off a book, and charging a guess would be
 * a library billing a patron for a number nobody chose.
 */
export function computeLostItemFee(input: LostItemFeeInput): LostItemFeeResult {
  const { policy } = input;
  const processing = toMoney(policy.processingFee);
  const currency = processing.currency;

  const basis = ((): MoneyJson => {
    switch (policy.chargeBasis) {
      case 'fixedAmount':
        if (policy.fixedAmount === null) {
          throw new PolicyResolutionError(
            POLICY_ERROR.policyIncomplete,
            `Lost item fee policy ${policy.id} charges a fixed amount and names none.`,
            policy.id,
          );
        }
        return policy.fixedAmount;
      case 'replacementPrice':
        if (input.replacementPrice === undefined) {
          throw new PolicyResolutionError(
            POLICY_ERROR.noReplacementPrice,
            `Lost item fee policy ${policy.id} charges the replacement price and this item has ` +
              'none. Set a price on the item, or choose a different basis — charging zero would ' +
              'write the book off silently.',
            policy.id,
          );
        }
        return input.replacementPrice;
      case 'itemTypeDefault':
        if (input.itemTypeDefault === undefined) {
          throw new PolicyResolutionError(
            POLICY_ERROR.noReplacementPrice,
            `Lost item fee policy ${policy.id} charges the item type's default and this type has none.`,
            policy.id,
          );
        }
        return input.itemTypeDefault;
      case 'actualCost':
        if (input.actualCost === undefined) {
          throw new PolicyResolutionError(
            POLICY_ERROR.noReplacementPrice,
            `Lost item fee policy ${policy.id} charges an actual cost and none was supplied.`,
            policy.id,
          );
        }
        return input.actualCost;
    }
  })();

  const replacement = toMoney(basis);
  if (replacement.currency !== currency) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyIncomplete,
      `Lost item fee policy ${policy.id} charges ${replacement.currency} against a ` +
        `${currency} processing fee. A total across two currencies is not a number.`,
      policy.id,
    );
  }
  return {
    replacement,
    processing,
    total: { amount: replacement.amount + processing.amount, currency },
  };
}
