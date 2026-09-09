import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK_CODE, evaluateBlocks, renewalTooEarly } from './blocks.js';
import type { CirculationRule, HoldPolicy, LoanPolicy, ResolvedPolicy } from './types.js';

const RULE: CirculationRule = {
  id: 'r',
  name: 'r',
  patronCategoryId: null,
  itemTypeId: null,
  owningBranchId: null,
  shelvingLocationId: null,
  checkoutBranchId: null,
  pickupBranchId: null,
  loanPolicyId: 'lp',
  overdueFinePolicyId: 'fp',
  lostItemFeePolicyId: 'lf',
  holdPolicyId: 'hp',
  noticePolicyId: 'np',
  maxLoansForRule: null,
  maxHoldsForRule: null,
  ageRestrictionMinYears: null,
  priority: 0,
  enabled: true,
  effectiveFrom: null,
  effectiveTo: null,
};

const LOAN: LoanPolicy = {
  id: 'lp',
  name: 'lp',
  loanable: true,
  profile: 'rolling',
  period: { value: 14, unit: 'days' },
  fixedDueDateSetId: null,
  dueTimeOfDay: null,
  closedDayHandling: 'keep',
  openingTimeOffset: null,
  maxPeriod: null,
  renewable: true,
  renewalsAllowed: 2,
  renewalPeriod: null,
  renewFrom: 'currentDueDate',
  noRenewalBefore: null,
  noRenewalBeforeRelativeTo: 'dueDate',
  renewWithOutstandingHolds: true,
  alternateCheckoutPeriodWithHolds: null,
  alternateRenewalPeriodWithHolds: null,
  itemLimitForPolicy: null,
};

const HOLD: HoldPolicy = {
  id: 'hp',
  name: 'hp',
  holdsAllowed: true,
  requestTypes: ['hold'],
  onShelfHolds: 'allow',
  itemLevelHolds: 'allow',
  maxHoldsPerRecord: 1,
  maxHoldsTotal: 10,
  pickupPolicy: 'any',
  pickupBranchIds: [],
  holdShelfExpiry: { value: 7, unit: 'days' },
  shelfExpiryUsesCalendar: true,
  unfilledRequestExpiry: null,
  suspensionAllowed: true,
  maxSuspension: null,
  placementFee: null,
  notPickedUpFee: null,
  transitAllowed: true,
  maxTransitDays: 5,
};

const resolved = (over: Partial<ResolvedPolicy> = {}): ResolvedPolicy =>
  ({
    rule: RULE,
    loan: LOAN,
    overdueFine: {} as never,
    lostItemFee: {} as never,
    hold: HOLD,
    notice: {} as never,
    categoryLimit: null,
    trace: {
      snapshotVersion: 1,
      matchedRuleId: 'r',
      beatenRuleIds: [],
      selectorsUsed: [],
      wildcardsUsed: [],
      calendarRolls: [],
    },
    ...over,
  }) as ResolvedPolicy;

const codes = (bs: readonly { code: string }[]) => bs.map((b) => b.code);

test('a policy that does not circulate blocks a checkout and not a hold', () => {
  const r = resolved({ loan: { ...LOAN, loanable: false } });
  assert.deepEqual(codes(evaluateBlocks(r, {}, 'checkout')), [BLOCK_CODE.notLoanable]);
  assert.deepEqual(codes(evaluateBlocks(r, {}, 'hold')), []);
});

test('an ABSENT count is "not checked", never "zero"', () => {
  // A self-check machine that cannot see a fine balance should get the blocks it
  // CAN evaluate rather than a refusal — and must not be told the patron owes
  // nothing.
  const r = resolved({ rule: { ...RULE, maxLoansForRule: 5 } });
  assert.deepEqual(codes(evaluateBlocks(r, {}, 'checkout')), []);
  assert.deepEqual(codes(evaluateBlocks(r, { openLoans: 5 }, 'checkout')), [
    BLOCK_CODE.tooManyLoans,
  ]);
});

test('the tighter of the rule and the category ceiling wins', () => {
  // Not a merge of two policies — two independent limits, each set on purpose.
  const r = resolved({
    rule: { ...RULE, maxLoansForRule: 10 },
    categoryLimit: {
      patronCategoryId: 'c',
      maxLoans: 3,
      maxHolds: null,
      maxOverdues: null,
      maxFineBalance: null,
    },
  });
  const blocks = evaluateBlocks(r, { openLoans: 4 }, 'checkout');
  assert.deepEqual(codes(blocks), [BLOCK_CODE.tooManyLoans]);
  assert.equal(blocks[0]!.limit, 3);
  assert.equal(blocks[0]!.observed, 4);
});

test('every block names what was seen and what was allowed', () => {
  // A desk that says "blocked" and not "12 of 10" makes the librarian guess.
  const r = resolved({
    categoryLimit: {
      patronCategoryId: 'c',
      maxLoans: null,
      maxHolds: null,
      maxOverdues: null,
      maxFineBalance: { minorUnits: 1000, currency: 'EUR' },
    },
  });
  const blocks = evaluateBlocks(
    r,
    { fineBalance: { minorUnits: 1450, currency: 'EUR' } },
    'checkout',
  );
  assert.deepEqual(codes(blocks), [BLOCK_CODE.fineLimitExceeded]);
  assert.equal(blocks[0]!.observed, '1450 EUR');
});

test('EVERY block is returned, not the first', () => {
  // A librarian who clears one and hits the next has done the same work twice,
  // and a self-check that reports one reason gives the patron a puzzle.
  const r = resolved({
    loan: { ...LOAN, loanable: false },
    rule: { ...RULE, maxLoansForRule: 1 },
    categoryLimit: {
      patronCategoryId: 'c',
      maxLoans: null,
      maxHolds: null,
      maxOverdues: 2,
      maxFineBalance: null,
    },
  });
  const blocks = evaluateBlocks(r, { openLoans: 3, overdueLoans: 5 }, 'checkout');
  assert.deepEqual(codes(blocks), [
    BLOCK_CODE.notLoanable,
    BLOCK_CODE.tooManyLoans,
    BLOCK_CODE.tooManyOverdues,
  ]);
});

test('onShelfHolds has four values because libraries argue about it', () => {
  const on = (v: HoldPolicy['onShelfHolds']) => resolved({ hold: { ...HOLD, onShelfHolds: v } });
  assert.deepEqual(codes(evaluateBlocks(on('allow'), { anyCopyAvailable: true }, 'hold')), []);
  assert.deepEqual(codes(evaluateBlocks(on('deny'), { anyCopyAvailable: true }, 'hold')), [
    BLOCK_CODE.onShelfHoldsNotAllowed,
  ]);
  assert.deepEqual(codes(evaluateBlocks(on('deny'), { anyCopyAvailable: false }, 'hold')), []);
  assert.deepEqual(
    codes(evaluateBlocks(on('ifAnyUnavailable'), { allCopiesAvailable: true }, 'hold')),
    [BLOCK_CODE.onShelfHoldsNotAllowed],
  );
});

test('the pickup policy is why pickupBranchId is a selector at all', () => {
  const r = resolved({ hold: { ...HOLD, pickupPolicy: 'owningBranch' } });
  assert.deepEqual(
    codes(evaluateBlocks(r, { requestedPickupBranchId: 'br-a', itemHomeBranchId: 'br-a' }, 'hold')),
    [],
  );
  assert.deepEqual(
    codes(evaluateBlocks(r, { requestedPickupBranchId: 'br-b', itemHomeBranchId: 'br-a' }, 'hold')),
    [BLOCK_CODE.pickupBranchNotAllowed],
  );
});

test('an age restriction WARNS rather than blocks', () => {
  // Deliberate rather than lax: a desk that cannot lend a fourteen-year-old a
  // book rated fifteen with the parent standing there is a desk that turns the
  // feature off.
  const r = resolved({ rule: { ...RULE, ageRestrictionMinYears: 15 } });
  const blocks = evaluateBlocks(r, { patronAgeYears: 14 }, 'checkout');
  assert.deepEqual(codes(blocks), [BLOCK_CODE.ageRestriction]);
  assert.equal(blocks[0]!.severity, 'warn');
});

test('renewal blocks are separate from checkout blocks', () => {
  const r = resolved({ loan: { ...LOAN, renewalsAllowed: 2, renewWithOutstandingHolds: false } });
  assert.deepEqual(codes(evaluateBlocks(r, { renewalCount: 2 }, 'renewal')), [
    BLOCK_CODE.renewalLimitReached,
  ]);
  assert.deepEqual(
    codes(evaluateBlocks(r, { renewalCount: 0, hasOutstandingHold: true }, 'renewal')),
    [BLOCK_CODE.renewalBlockedByHold],
  );
  // The same state at a checkout is not a renewal problem.
  assert.deepEqual(codes(evaluateBlocks(r, { renewalCount: 2 }, 'checkout')), []);
});

test('renewalTooEarly measures from whichever anchor the policy names', () => {
  const dueAt = new Date('2026-06-15T09:00:00Z');
  const fromDue = resolved({
    loan: {
      ...LOAN,
      noRenewalBefore: { value: 3, unit: 'days' },
      noRenewalBeforeRelativeTo: 'dueDate',
    },
  });
  assert.notEqual(renewalTooEarly(fromDue, dueAt, new Date('2026-06-01T09:00:00Z')), null);
  assert.equal(renewalTooEarly(fromDue, dueAt, new Date('2026-06-13T09:00:00Z')), null);
  assert.equal(
    renewalTooEarly(resolved(), dueAt, new Date('2026-06-01T09:00:00Z')),
    null,
    'no setting, no block',
  );
});

test('every block carries an override permission, so nothing is a dead end', () => {
  const r = resolved({ loan: { ...LOAN, loanable: false }, rule: { ...RULE, maxLoansForRule: 0 } });
  for (const b of evaluateBlocks(r, { openLoans: 1 }, 'checkout')) {
    assert.ok(b.overridable, b.code);
    assert.match(b.overridePermission, /^circ\./, b.code);
  }
});

test('the vocabulary is the ONE list SIP2, NCIP, the OPAC and the core share', () => {
  // If it were born inside apps/api/src/circulation there would be four of them
  // by M6, and a self-check machine disagreeing with the staff client about why
  // a patron was refused is a support call nobody can close.
  const codesList = Object.values(BLOCK_CODE);
  assert.equal(new Set(codesList).size, codesList.length, 'no duplicates');
  assert.ok(
    codesList.every((c) => /^[A-Z_]+$/.test(c)),
    'stable wire-format codes',
  );
  // Patron and item STATE is deliberately absent: deciding it needs a query, and
  // this package makes none.
  for (const absent of ['CARD_EXPIRED', 'ITEM_NOT_FOR_LOAN', 'PATRON_DEBARRED', 'ITEM_LOST']) {
    assert.ok(!codesList.includes(absent as never), `${absent} belongs to phase 14/16/17`);
  }
});
