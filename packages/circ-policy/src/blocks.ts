import { toMoney, type MoneyJson, type ResolvedPolicy } from './types.js';

/**
 * May this circulation happen?
 *
 * ## The split falls where the DATA does, not where the semantics do
 *
 * Comparing twelve loans against a limit of ten is arithmetic, and it belongs in
 * the package the offline Rust core runs — a Tauri client with no network has to
 * be able to refuse a checkout for the RIGHT reason, not merely refuse it.
 * COUNTING the twelve loans is a query, so it stays out: {@link CirculationState}
 * is a plain value object the caller assembles.
 *
 * That is why blocks like `CARD_EXPIRED`, `ITEM_NOT_FOR_LOAN` and
 * `PATRON_DEBARRED` are deliberately absent. They are facts about a patron or an
 * item, decidable without any policy at all, and they belong to phases 14, 16
 * and 17 where the rows they read are loaded.
 *
 * ## The vocabulary ships now even though nothing calls it until phase 16
 *
 * SIP2 (phase 61), NCIP (62), the OPAC (32), the offline core (77) and the
 * circulation desk (16) must all emit the SAME block codes — a self-check
 * machine and the staff client disagreeing about why a patron was refused is a
 * support call nobody can close. If the list is born inside
 * `apps/api/src/circulation` there will be four of them by M6.
 */

/** Everything this package can refuse, and nothing it cannot. */
export const BLOCK_CODE = {
  /** The resolved loan policy says this combination does not circulate. */
  notLoanable: 'NOT_LOANABLE',
  /** The patron already has as many loans as the rule or the category allows. */
  tooManyLoans: 'TOO_MANY_LOANS',
  /** …of THIS title, which is a different limit and a different message. */
  tooManyLoansOfTitle: 'TOO_MANY_LOANS_OF_TITLE',
  tooManyHolds: 'TOO_MANY_HOLDS',
  tooManyHoldsOfRecord: 'TOO_MANY_HOLDS_OF_RECORD',
  tooManyOverdues: 'TOO_MANY_OVERDUES',
  fineLimitExceeded: 'FINE_LIMIT_EXCEEDED',
  ageRestriction: 'AGE_RESTRICTION',
  holdsNotAllowed: 'HOLDS_NOT_ALLOWED',
  onShelfHoldsNotAllowed: 'ON_SHELF_HOLDS_NOT_ALLOWED',
  itemLevelHoldsNotAllowed: 'ITEM_LEVEL_HOLDS_NOT_ALLOWED',
  pickupBranchNotAllowed: 'PICKUP_BRANCH_NOT_ALLOWED',
  notRenewable: 'NOT_RENEWABLE',
  renewalLimitReached: 'RENEWAL_LIMIT_REACHED',
  renewalTooEarly: 'RENEWAL_TOO_EARLY',
  renewalBlockedByHold: 'RENEWAL_BLOCKED_BY_HOLD',
} as const;

export type BlockCode = (typeof BLOCK_CODE)[keyof typeof BLOCK_CODE];

export type Block = {
  readonly code: BlockCode;
  /** `warn` is shown and does not stop the transaction. */
  readonly severity: 'block' | 'warn';
  readonly overridable: boolean;
  /** The permission key an override needs. Phase 3's catalogue owns the names. */
  readonly overridePermission: string;
  /** What was seen — 12 loans, €14.50 owed, age 11. */
  readonly observed?: number | string;
  /** What was allowed. */
  readonly limit?: number | string;
};

/**
 * What the CALLER counted. Every field is a query this package does not make.
 *
 * Deliberately all-optional: a self-check machine that cannot see a fine balance
 * should get the blocks it CAN evaluate rather than a refusal, and an absent
 * count is "not checked", never "zero".
 */
export type CirculationState = {
  readonly openLoans?: number;
  readonly openLoansOfTitle?: number;
  readonly openHolds?: number;
  readonly openHoldsOfRecord?: number;
  readonly overdueLoans?: number;
  readonly fineBalance?: MoneyJson;
  readonly patronAgeYears?: number;
  /** For a renewal. */
  readonly renewalCount?: number;
  readonly hasOutstandingHold?: boolean;
  /** For a hold: is any copy on the shelf right now? */
  readonly anyCopyAvailable?: boolean;
  readonly allCopiesAvailable?: boolean;
  readonly requestedPickupBranchId?: string;
  readonly itemHomeBranchId?: string;
  readonly patronHomeBranchId?: string;
};

/** `checkout` and `renewal` ask different questions of the same policy. */
export type BlockOperation = 'checkout' | 'renewal' | 'hold';

/**
 * Every block this policy and this state produce, in the order a desk should
 * show them.
 *
 * Returns an ARRAY rather than the first hit: a librarian who clears one block
 * and hits the next has been made to do the same work twice, and a self-check
 * machine that can only report one reason gives the patron a puzzle.
 */
export function evaluateBlocks(
  resolved: ResolvedPolicy,
  state: CirculationState,
  operation: BlockOperation,
): readonly Block[] {
  const out: Block[] = [];
  const { loan, hold, rule, categoryLimit } = resolved;

  if (operation !== 'hold' && !loan.loanable) {
    out.push(block(BLOCK_CODE.notLoanable, 'circ.checkout.override'));
  }

  // Loan and hold ceilings. The RULE's limit and the CATEGORY's are both
  // ceilings and the tighter one wins — which is not a merge of two policies but
  // two independent limits, each of which a library set on purpose.
  const maxLoans = tighter(rule.maxLoansForRule, categoryLimit?.maxLoans ?? null);
  if (operation === 'checkout' && maxLoans !== null && state.openLoans !== undefined) {
    if (state.openLoans >= maxLoans) {
      out.push(block(BLOCK_CODE.tooManyLoans, 'circ.checkout.override', state.openLoans, maxLoans));
    }
  }
  if (
    operation === 'checkout' &&
    loan.itemLimitForPolicy !== null &&
    state.openLoansOfTitle !== undefined &&
    state.openLoansOfTitle >= loan.itemLimitForPolicy
  ) {
    out.push(
      block(
        BLOCK_CODE.tooManyLoansOfTitle,
        'circ.checkout.override',
        state.openLoansOfTitle,
        loan.itemLimitForPolicy,
      ),
    );
  }

  const maxHolds = tighter(rule.maxHoldsForRule, categoryLimit?.maxHolds ?? null);
  if (operation === 'hold') {
    if (!hold.holdsAllowed) out.push(block(BLOCK_CODE.holdsNotAllowed, 'circ.hold.override'));
    if (maxHolds !== null && state.openHolds !== undefined && state.openHolds >= maxHolds) {
      out.push(block(BLOCK_CODE.tooManyHolds, 'circ.hold.override', state.openHolds, maxHolds));
    }
    if (
      hold.maxHoldsPerRecord !== null &&
      state.openHoldsOfRecord !== undefined &&
      state.openHoldsOfRecord >= hold.maxHoldsPerRecord
    ) {
      out.push(
        block(
          BLOCK_CODE.tooManyHoldsOfRecord,
          'circ.hold.override',
          state.openHoldsOfRecord,
          hold.maxHoldsPerRecord,
        ),
      );
    }
    // `onShelfHolds` is the single most argued-about setting in a public
    // library, which is why Koha exposes four values for it rather than a
    // checkbox: "you cannot reserve a book that is on the shelf, go and get it"
    // and "of course you can, I am not coming in twice" are both real policies.
    if (hold.onShelfHolds === 'deny' && state.anyCopyAvailable === true) {
      out.push(block(BLOCK_CODE.onShelfHoldsNotAllowed, 'circ.hold.override'));
    }
    if (hold.onShelfHolds === 'ifAnyUnavailable' && state.allCopiesAvailable === true) {
      out.push(block(BLOCK_CODE.onShelfHoldsNotAllowed, 'circ.hold.override'));
    }
    if (hold.onShelfHolds === 'ifAllUnavailable' && state.anyCopyAvailable === true) {
      out.push(block(BLOCK_CODE.onShelfHoldsNotAllowed, 'circ.hold.override'));
    }
    const pickup = pickupBlock(resolved, state);
    if (pickup !== null) out.push(pickup);
  }

  if (
    categoryLimit?.maxOverdues != null &&
    state.overdueLoans !== undefined &&
    state.overdueLoans >= categoryLimit.maxOverdues
  ) {
    out.push(
      block(
        BLOCK_CODE.tooManyOverdues,
        'circ.checkout.override',
        state.overdueLoans,
        categoryLimit.maxOverdues,
      ),
    );
  }

  if (categoryLimit?.maxFineBalance != null && state.fineBalance !== undefined) {
    const owed = toMoney(state.fineBalance);
    const max = toMoney(categoryLimit.maxFineBalance);
    if (owed.currency === max.currency && owed.amount >= max.amount) {
      out.push(
        block(
          BLOCK_CODE.fineLimitExceeded,
          'circ.checkout.override',
          `${owed.amount} ${owed.currency}`,
          `${max.amount} ${max.currency}`,
        ),
      );
    }
  }

  if (
    rule.ageRestrictionMinYears !== null &&
    state.patronAgeYears !== undefined &&
    state.patronAgeYears < rule.ageRestrictionMinYears
  ) {
    // A WARNING, not a block, and this is a deliberate choice rather than
    // laxity: an age restriction is guidance a library gives a guardian, and a
    // desk that cannot lend a fourteen-year-old a book rated fifteen — with the
    // parent standing there — is a desk that turns the feature off.
    out.push({
      code: BLOCK_CODE.ageRestriction,
      severity: 'warn',
      overridable: true,
      overridePermission: 'circ.checkout.override',
      observed: state.patronAgeYears,
      limit: rule.ageRestrictionMinYears,
    });
  }

  if (operation === 'renewal') {
    if (!loan.renewable) out.push(block(BLOCK_CODE.notRenewable, 'circ.renew.override'));
    if (
      loan.renewalsAllowed !== null &&
      state.renewalCount !== undefined &&
      state.renewalCount >= loan.renewalsAllowed
    ) {
      out.push(
        block(
          BLOCK_CODE.renewalLimitReached,
          'circ.renew.override',
          state.renewalCount,
          loan.renewalsAllowed,
        ),
      );
    }
    if (!loan.renewWithOutstandingHolds && state.hasOutstandingHold === true) {
      out.push(block(BLOCK_CODE.renewalBlockedByHold, 'circ.renew.override'));
    }
  }

  return out;
}

/**
 * Is it too early to renew?
 *
 * Separate from {@link evaluateBlocks} because it needs two instants and the
 * rest needs none — and because a function that took `now` alongside a bag of
 * counts would invite someone to default it.
 */
export function renewalTooEarly(
  resolved: ResolvedPolicy,
  currentDueAt: Date,
  now: Date,
): Block | null {
  const { loan } = resolved;
  if (loan.noRenewalBefore === null) return null;
  const ms = durationMs(loan.noRenewalBefore);
  const opensAt =
    loan.noRenewalBeforeRelativeTo === 'dueDate'
      ? new Date(currentDueAt.getTime() - ms)
      : new Date(now.getTime() + ms);
  if (now >= opensAt) return null;
  return {
    code: BLOCK_CODE.renewalTooEarly,
    severity: 'block',
    overridable: true,
    overridePermission: 'circ.renew.override',
    observed: now.toISOString(),
    limit: opensAt.toISOString(),
  };
}

/** Where a hold may be collected. Why `pickupBranchId` is a selector at all. */
function pickupBlock(resolved: ResolvedPolicy, state: CirculationState): Block | null {
  const { hold } = resolved;
  const wanted = state.requestedPickupBranchId;
  if (wanted === undefined || hold.pickupPolicy === 'any') return null;
  const allowed =
    hold.pickupPolicy === 'explicitSet'
      ? hold.pickupBranchIds.includes(wanted)
      : hold.pickupPolicy === 'owningBranch' || hold.pickupPolicy === 'holdingBranch'
        ? state.itemHomeBranchId === wanted
        : state.patronHomeBranchId === wanted;
  if (allowed) return null;
  return {
    code: BLOCK_CODE.pickupBranchNotAllowed,
    severity: 'block',
    overridable: true,
    overridePermission: 'circ.hold.override',
    observed: wanted,
    limit: hold.pickupPolicy,
  };
}

const block = (
  code: BlockCode,
  overridePermission: string,
  observed?: number | string,
  limit?: number | string,
): Block => ({ code, severity: 'block', overridable: true, overridePermission, observed, limit });

/** The tighter of two ceilings. `null` on either side means "no ceiling here". */
function tighter(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function durationMs(d: { value: number; unit: string }): number {
  switch (d.unit) {
    case 'minutes':
      return d.value * 60_000;
    case 'hours':
      return d.value * 3_600_000;
    case 'weeks':
      return d.value * 7 * 86_400_000;
    case 'months':
      return d.value * 30 * 86_400_000;
    default:
      return d.value * 86_400_000;
  }
}
