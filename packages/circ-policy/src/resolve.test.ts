import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCirculationPolicy, resolveTemplate, templateSpecificity } from './resolve.js';
import {
  POLICY_ERROR,
  type CirculationRule,
  type PolicySnapshot,
  type ResolveContext,
} from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const rule = (id: string, s: Partial<CirculationRule>): CirculationRule => ({
  id,
  name: id,
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
  ...s,
});

const snapshotOf = (rules: CirculationRule[]): PolicySnapshot => ({
  version: 42,
  rules,
  loanPolicies: { lp: { id: 'lp' } as never },
  overdueFinePolicies: { fp: { id: 'fp' } as never },
  lostItemFeePolicies: { lf: { id: 'lf' } as never },
  holdPolicies: { hp: { id: 'hp' } as never },
  noticePolicies: { np: { id: 'np', name: 'np', templates: [] } },
  fixedDueDateSets: {},
  patronCategoryLimits: {},
  calendars: {},
});

const CTX: ResolveContext = {
  patronCategoryId: null,
  itemTypeId: null,
  owningBranchId: null,
  shelvingLocationId: null,
  checkoutBranchId: null,
  pickupBranchId: null,
  at: new Date('2026-05-05T09:00:00Z'),
};

test('the wildcard rule is what makes a library able to lend anything', () => {
  const r = resolveCirculationPolicy(snapshotOf([rule('r-default', {})]), CTX);
  assert.equal(r.trace.matchedRuleId, 'r-default');
  assert.deepEqual([...r.trace.wildcardsUsed].length, 6);
});

test('NO WILDCARD IS A REFUSAL, not a default', () => {
  // §4.1: "never fails open to a default policy — a wrong loan period is a wrong
  // receipt."
  assert.throws(
    () => resolveCirculationPolicy(snapshotOf([rule('r', { itemTypeId: 'dvd' })]), CTX),
    (e: { code?: string }) => e.code === POLICY_ERROR.noMatchingRule,
  );
});

test('beatenRuleIds is the rules that MATCHED and lost, not every lower rank', () => {
  // The naive reading returns 499 ids from a 500-rule snapshot on every
  // checkout, allocated on the hot path and rendered into an explain screen
  // nobody could read. "Your branch rule beat the tenant default" is what a
  // librarian wanted to know.
  const snap = snapshotOf([
    rule('r-default', {}),
    rule('r-child', { patronCategoryId: 'cat-child' }),
    rule('r-dvd', { itemTypeId: 'it-dvd' }),
    rule('r-other-branch', { owningBranchId: 'br-z' }),
  ]);
  const r = resolveCirculationPolicy(snap, { ...CTX, patronCategoryId: 'cat-child' });
  assert.equal(r.trace.matchedRuleId, 'r-child');
  assert.deepEqual([...r.trace.beatenRuleIds], ['r-default']);
  // Neither the DVD rule nor the other branch's is in there: they did not match.
  assert.ok(!r.trace.beatenRuleIds.includes('r-dvd'));
});

test('the category outranks the branch — 32 against 8', () => {
  const snap = snapshotOf([
    rule('r-default', {}),
    rule('r-child', { patronCategoryId: 'cat-child' }),
    rule('r-branch', { owningBranchId: 'br-b' }),
  ]);
  const r = resolveCirculationPolicy(snap, {
    ...CTX,
    patronCategoryId: 'cat-child',
    owningBranchId: 'br-b',
  });
  assert.equal(r.trace.matchedRuleId, 'r-child');
});

test('priority is the escape hatch for the one-off exception', () => {
  const snap = snapshotOf([
    rule('r-default', {}),
    rule('r-child-dvd', { patronCategoryId: 'cat-child', itemTypeId: 'it-dvd' }),
    rule('r-exception', { itemTypeId: 'it-dvd', priority: 100 }),
  ]);
  const r = resolveCirculationPolicy(snap, {
    ...CTX,
    patronCategoryId: 'cat-child',
    itemTypeId: 'it-dvd',
  });
  assert.equal(r.trace.matchedRuleId, 'r-exception');
});

test('a rule that is not yet in force does not apply', () => {
  const snap = snapshotOf([
    rule('r-default', {}),
    rule('r-autumn', { patronCategoryId: 'cat-student', effectiveFrom: '2026-09-01T00:00:00Z' }),
  ]);
  const before = resolveCirculationPolicy(snap, { ...CTX, patronCategoryId: 'cat-student' });
  assert.equal(before.trace.matchedRuleId, 'r-default');
  const after = resolveCirculationPolicy(snap, {
    ...CTX,
    patronCategoryId: 'cat-student',
    at: new Date('2026-09-15T09:00:00Z'),
  });
  assert.equal(after.trace.matchedRuleId, 'r-autumn');
});

test('a policy the snapshot does not hold is a REFUSAL, and names the version', () => {
  // The important one. A fallback to fourteen days here turns a stale snapshot
  // into a fortnight's loan on a two-hour course reserve, and the librarian
  // finds out when the reserve shelf is empty.
  const snap = { ...snapshotOf([rule('r', { loanPolicyId: 'lp-missing' })]) };
  assert.throws(
    () => resolveCirculationPolicy(snap, CTX),
    (e: { code?: string; message: string }) =>
      e.code === POLICY_ERROR.policyNotInSnapshot && e.message.includes('42'),
  );
});

test('a duplicated rule row is refused rather than resolved arbitrarily', () => {
  const dup = rule('r-same', { itemTypeId: 'dvd' });
  assert.throws(
    () => resolveCirculationPolicy(snapshotOf([dup, { ...dup }]), { ...CTX, itemTypeId: 'dvd' }),
    (e: { code?: string }) => e.code === POLICY_ERROR.ambiguousRule,
  );
});

test('the trace stamps the snapshot version, so a receipt can be reproduced', () => {
  const r = resolveCirculationPolicy(snapshotOf([rule('r-default', {})]), CTX);
  assert.equal(r.trace.snapshotVersion, 42);
});

test('an unknown category in the CONTEXT falls through, and is not a refusal', () => {
  // Refusing would make a fast-add item unlendable at the desk, which is the
  // opposite of what "never fails open" is protecting.
  const r = resolveCirculationPolicy(snapshotOf([rule('r-default', {})]), {
    ...CTX,
    patronCategoryId: 'cat-never-seen',
    itemTypeId: 'it-never-seen',
  });
  assert.equal(r.trace.matchedRuleId, 'r-default');
  assert.equal(r.categoryLimit, null);
});

test('notice templates rank branch OVER category — the inverse of a rule', () => {
  const policy = {
    id: 'np',
    name: 'np',
    templates: [
      {
        id: 'nt-any',
        trigger: 'overdue' as const,
        templateId: 'generic',
        branchId: null,
        patronCategoryId: null,
        offset: null,
      },
      {
        id: 'nt-cat',
        trigger: 'overdue' as const,
        templateId: 'child',
        branchId: null,
        patronCategoryId: 'cat-child',
        offset: null,
      },
      {
        id: 'nt-branch',
        trigger: 'overdue' as const,
        templateId: 'branch-b',
        branchId: 'br-b',
        patronCategoryId: null,
        offset: null,
      },
    ],
  };
  const both = resolveTemplate(policy, {
    trigger: 'overdue',
    branchId: 'br-b',
    patronCategoryId: 'cat-child',
  });
  // A library that has rewritten its overdue letter for one branch means THAT
  // letter, even for a category with its own — the text carries the branch's
  // name, address and voice.
  assert.equal(both!.templateId, 'branch-b');
  assert.equal(templateSpecificity(policy.templates[2]!), 2);
  assert.equal(templateSpecificity(policy.templates[1]!), 1);
});

test('no template configured is SILENCE, and that is the one safe absence', () => {
  // A library that has configured no `holdExpiring` template has decided not to
  // send one. The consequence is silence rather than a wrong number, which is
  // why this is the only place in the package where absence is an answer.
  const policy = { id: 'np', name: 'np', templates: [] };
  assert.equal(
    resolveTemplate(policy, { trigger: 'holdExpiring', branchId: null, patronCategoryId: null }),
    null,
  );
});

test('THE PACKAGE EXPORTS NO DEFAULT POLICY, and that is enforced', () => {
  // §4.1's "never fails open" is defeated by exporting any default-shaped
  // constant, even one meant only for fixtures: the first `?? DEFAULT` at a call
  // site makes every refusal in this package unreachable, and nothing in CI
  // would notice. Grepping the source is the only check that survives a
  // refactor.
  const files = [
    'types.ts',
    'rank.ts',
    'calendar.ts',
    'duedate.ts',
    'fines.ts',
    'blocks.ts',
    'resolve.ts',
    'index.ts',
  ];
  for (const f of files) {
    const src = readFileSync(path.join(HERE, f), 'utf8');
    const offenders = src.match(/export\s+const\s+DEFAULT_[A-Z_]*(POLICY|RULE|SNAPSHOT)/g);
    assert.equal(offenders, null, `${f} exports a default policy: ${offenders?.join(', ')}`);
  }
});
