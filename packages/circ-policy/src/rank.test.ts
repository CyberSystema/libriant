import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SELECTOR_WEIGHTS,
  TEMPLATE_SELECTOR_WEIGHTS,
  compareRank,
  isInForce,
  matchesSelectors,
  rank,
  selectorsUsed,
  specificity,
  wildcardsUsed,
} from './rank.js';
import type { CirculationRule, ResolveContext, RuleSelectors } from './types.js';

const NONE: RuleSelectors = {
  patronCategoryId: null,
  itemTypeId: null,
  owningBranchId: null,
  shelvingLocationId: null,
  checkoutBranchId: null,
  pickupBranchId: null,
};

const ruleOf = (id: string, s: Partial<RuleSelectors>, priority = 0): CirculationRule => ({
  ...NONE,
  ...s,
  id,
  name: id,
  loanPolicyId: 'lp',
  overdueFinePolicyId: 'fp',
  lostItemFeePolicyId: 'lf',
  holdPolicyId: 'hp',
  noticePolicyId: 'np',
  maxLoansForRule: null,
  maxHoldsForRule: null,
  ageRestrictionMinYears: null,
  priority,
  enabled: true,
  effectiveFrom: null,
  effectiveTo: null,
});

test('the weights are exactly §3 s, in §3 s order', () => {
  // Not configurable, and the ORDER is the precedence a Koha librarian already
  // carries in their head. A change here silently re-ranks every rule in every
  // library, which is why the list is asserted rather than trusted.
  assert.deepEqual(
    SELECTOR_WEIGHTS.map(([n]) => n),
    [
      'patronCategoryId',
      'itemTypeId',
      'owningBranchId',
      'shelvingLocationId',
      'checkoutBranchId',
      'pickupBranchId',
    ],
  );
  assert.deepEqual(
    SELECTOR_WEIGHTS.map(([, w]) => w),
    [32, 16, 8, 4, 2, 1],
  );
});

test('specificity is the 6-bit mask, over all 64 combinations', () => {
  // THE PHASE ACCEPTANCE CRITERION: "rank() equals the SQL column for all 64
  // selector combinations". Verified against a real PostgreSQL 16 generated
  // column in the divergence entry — zero mismatches — and the expectation here
  // is built with bit shifts rather than with the weight table above, so the two
  // expressions are independent.
  for (let n = 0; n < 64; n += 1) {
    const s: Record<string, string | null> = {};
    SELECTOR_WEIGHTS.forEach(([name], i) => {
      s[name] = (n >> (5 - i)) & 1 ? 'x' : null;
    });
    assert.equal(specificity(s as unknown as RuleSelectors), n, `combination ${n}`);
  }
});

test('a NULL selector is a wildcard; a context null matches only a wildcard', () => {
  const ctx: ResolveContext = {
    patronCategoryId: 'cat',
    itemTypeId: 'it',
    owningBranchId: null,
    shelvingLocationId: null,
    checkoutBranchId: 'br',
    pickupBranchId: null,
    at: new Date('2026-05-05T09:00:00Z'),
  };
  assert.equal(matchesSelectors(NONE, ctx), true, 'the wildcard matches everything');
  assert.equal(matchesSelectors({ ...NONE, patronCategoryId: 'cat' }, ctx), true);
  assert.equal(matchesSelectors({ ...NONE, patronCategoryId: 'other' }, ctx), false);
  // A rule that names a shelving location is not about an item that has none.
  assert.equal(matchesSelectors({ ...NONE, shelvingLocationId: 'shelf' }, ctx), false);
});

test('rank is priority first, then specificity, then id', () => {
  const specific = ruleOf('a', { patronCategoryId: 'c', itemTypeId: 'i' });
  const general = ruleOf('b', { patronCategoryId: 'c' });
  assert.ok(compareRank(specific, general) < 0, 'more specific wins');

  const exception = ruleOf('z', { patronCategoryId: 'c' }, 100);
  assert.ok(compareRank(exception, specific) < 0, 'priority beats specificity');

  // The id tiebreak is what makes it a TOTAL order. Without it two equally
  // specific rules resolve differently on different pods, which is how an ILS
  // policy bug becomes unreproducible.
  const tieA = ruleOf('rule-a', { itemTypeId: 'i' });
  const tieB = ruleOf('rule-b', { itemTypeId: 'i' });
  assert.ok(compareRank(tieA, tieB) < 0);
  assert.ok(compareRank(tieB, tieA) > 0);
  assert.equal(compareRank(tieA, tieA), 0);
});

test('the id tiebreak is CODE-UNIT order, which Postgres el-GR is not', () => {
  // MEASURED on this repo's own Postgres, whose tenant databases are created
  // with ICU el-GR as the default collation:
  //
  //   ICU el-GR:  … rule_b, rule-10, rule-2, rule-a, rule-A, rule-B
  //   C / JS:     … rule-10, rule-2, rule-A, rule-B, rule-a, rule_b
  //
  // So `ORDER BY … id` in SQL and `compareRank` here disagree exactly when two
  // rules tie — which is exactly when the tiebreak decides anything. The fix
  // belongs to phase 13's query, which must say `id COLLATE "C"`, and this test
  // exists so that requirement is written down somewhere it will be read.
  const ids = ['rule-a', 'rule-A', 'rule_b', 'rule-10', 'rule-2'];
  const sorted = [...ids].sort((a, b) => compareRank(ruleOf(a, {}), ruleOf(b, {})));
  assert.deepEqual(sorted, ['rule-10', 'rule-2', 'rule-A', 'rule-a', 'rule_b']);
});

test('rank() as a number never lets priority and specificity interfere', () => {
  // specificity is 0..63, so one step of priority must outweigh every possible
  // specificity — the same reason the weights are a bitmask.
  assert.ok(
    rank(ruleOf('a', {}, 1)) >
      rank(
        ruleOf(
          'b',
          {
            ...NONE,
            patronCategoryId: 'c',
            itemTypeId: 'i',
            owningBranchId: 'o',
            shelvingLocationId: 's',
            checkoutBranchId: 'k',
            pickupBranchId: 'p',
          },
          0,
        ),
      ),
  );
});

test('selectorsUsed and wildcardsUsed partition the six, high weight first', () => {
  const r = ruleOf('a', { patronCategoryId: 'c', checkoutBranchId: 'b' });
  assert.deepEqual(selectorsUsed(r), ['patronCategoryId', 'checkoutBranchId']);
  assert.deepEqual(wildcardsUsed(r), [
    'itemTypeId',
    'owningBranchId',
    'shelvingLocationId',
    'pickupBranchId',
  ]);
  assert.equal(selectorsUsed(r).length + wildcardsUsed(r).length, 6);
});

test('effective dates are half-open, so two scheduled rules never overlap', () => {
  const r = ruleOf('a', {});
  const scheduled: CirculationRule = {
    ...r,
    effectiveFrom: '2026-09-01T00:00:00Z',
    effectiveTo: '2026-10-01T00:00:00Z',
  };
  assert.equal(isInForce(scheduled, new Date('2026-08-31T23:59:59Z')), false);
  assert.equal(isInForce(scheduled, new Date('2026-09-01T00:00:00Z')), true);
  assert.equal(isInForce(scheduled, new Date('2026-09-30T23:59:59Z')), true);
  // Exclusive: a rule that ends on the 1st and one that begins on the 1st do
  // not both apply for a day.
  assert.equal(isInForce(scheduled, new Date('2026-10-01T00:00:00Z')), false);
  assert.equal(
    isInForce({ ...scheduled, enabled: false }, new Date('2026-09-15T00:00:00Z')),
    false,
  );
});

test('notice templates use the INVERTED weights: branch 2, category 1', () => {
  // §4.1 says so, and it is the domain rather than an inconsistency. A loan
  // period is a property of who is BORROWING, so the category dominates at 32
  // against the branch's 8. A notice is a property of who is SENDING — the
  // branch's name, address and voice are in the text — so the branch dominates.
  assert.deepEqual(TEMPLATE_SELECTOR_WEIGHTS, [
    ['branchId', 2],
    ['patronCategoryId', 1],
  ]);
});
