import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { instantFromCivil } from './calendar.js';
import { computeDueDate } from './duedate.js';
import { accrueOverdue } from './fines.js';
import { specificity } from './rank.js';
import { resolveCirculationPolicy } from './resolve.js';
import type {
  Calendar,
  LoanPolicy,
  OverdueFinePolicy,
  PolicySnapshot,
  ResolveContext,
  RuleSelectors,
} from './types.js';
import type { VectorDocument } from './vectors.js';

/**
 * The golden vectors, run.
 *
 * §4.1 names eight consumers "all pinned to `fixtures/resolution-vectors.json`,
 * run by both `node --test` and `cargo test`". This is the `node --test` half;
 * phase 77's Rust core reads the same file and must produce the same answers,
 * which is the only thing that will keep an offline Tauri client and this
 * package agreeing about a due date.
 *
 * The expectations in that file were NOT produced by this code — see
 * `scripts/build-vectors.ts`, where rank is computed with bit shifts, wall-clock
 * conversion by trying every UTC offset, and civil-date arithmetic by stepping
 * one day at a time through `Intl`. Two implementations agreeing is evidence;
 * one implementation agreeing with itself is not.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(path.resolve(HERE, '..', 'fixtures', 'resolution-vectors.json'), 'utf8'),
) as VectorDocument;

test('the vector file is present, versioned and not empty', () => {
  // `node --test` exits 0 on an empty glob and an empty loop, which is how a
  // suite of four hundred cases silently becomes a suite of none. The phase line
  // says ~400; this is the floor that makes the number mean something.
  assert.equal(doc.version, 1, 'schema version — a bump is how a Rust mismatch becomes loud');
  assert.ok(
    doc.vectors.length >= 400,
    `expected at least 400 vectors, found ${doc.vectors.length}`,
  );
});

test('every vector kind is exercised', () => {
  const kinds = new Set(doc.vectors.map((v) => v.kind));
  assert.deepEqual([...kinds].sort(), ['civil', 'dueDate', 'fine', 'rank', 'resolve']);
});

test('rank: specificity matches the SQL generated column for all 64 combinations', () => {
  const rank = doc.vectors.filter((v) => v.kind === 'rank');
  assert.equal(rank.length, 64, 'all 64 selector combinations');
  for (const v of rank) {
    assert.equal(specificity(v.selectors as unknown as RuleSelectors), v.expectSpecificity, v.id);
  }
});

test('civil: wall-clock to instant, including both DST edges', () => {
  let gaps = 0;
  let ambiguous = 0;
  for (const v of doc.vectors) {
    if (v.kind !== 'civil') continue;
    const got = instantFromCivil(v.timezone, v.civil, v.disambiguation);
    assert.equal(got.kind, v.expectKind, `${v.id}: kind`);
    if (v.expectKind === 'gap') {
      // The reference cannot say WHICH instant a non-existent wall time maps to
      // — there is none — so the vector pins only the classification. Which
      // instant is an engineering choice, and `calendar.test.ts` pins it.
      gaps += 1;
      continue;
    }
    assert.equal(got.instant.toISOString(), v.expectInstant, `${v.id}: instant`);
    if (v.expectKind === 'ambiguous') ambiguous += 1;
  }
  // Both edges must actually be in the corpus. A DST suite that happened to
  // contain no gap and no fold would pass against an implementation that could
  // handle neither.
  assert.ok(gaps > 0, 'the corpus must contain a DST gap');
  assert.ok(ambiguous > 0, 'the corpus must contain an ambiguous wall time');
});

test('dueDate: every vector, including the rolls that moved it', () => {
  for (const v of doc.vectors) {
    if (v.kind !== 'dueDate') continue;
    const calendar = doc.fixtures.calendars[v.calendarId] as Calendar;
    const policy = doc.fixtures.loanPolicies[v.loanPolicyId] as LoanPolicy;
    const got = computeDueDate({
      policy,
      calendar,
      from: new Date(v.from),
      hasOutstandingHold: v.hasOutstandingHold === true,
    });
    assert.equal(
      got.dueAt === null ? null : got.dueAt.toISOString(),
      v.expectDueAt,
      `${v.id}: ${v.note}`,
    );
    // THE TRACE, not only the outcome. Without this a Rust core could produce
    // the right date through the wrong rule and nothing would fail — which is
    // the failure `loans.applied_rule_id` exists to catch.
    assert.deepEqual(
      got.rolls.map((r) => r.reason),
      v.expectRolls,
      `${v.id}: rolls`,
    );
  }
});

test('fine: amounts, intervals and grace', () => {
  for (const v of doc.vectors) {
    if (v.kind !== 'fine') continue;
    const calendar = doc.fixtures.calendars[v.calendarId] as Calendar;
    const policy = doc.fixtures.finePolicies[v.finePolicyId] as OverdueFinePolicy;
    const got = accrueOverdue({
      policy,
      calendar,
      dueAt: new Date(v.dueAt),
      asOf: new Date(v.asOf),
    });
    assert.equal(Number(got.amount.amount), v.expectMinorUnits, `${v.id}: ${v.note}`);
    assert.equal(got.intervals, v.expectIntervals, `${v.id}: intervals`);
    assert.equal(got.withinGrace, v.expectWithinGrace, `${v.id}: grace`);
  }
});

test('resolve: the sweep reaches every rule, and never the disabled one', () => {
  // A sweep that resolved to the wildcard sixty-four times would pass every
  // assertion below and prove nothing. This is what makes the corpus mean
  // "every branch of the comparator was taken".
  const rv = doc.vectors.filter((v) => v.kind === 'resolve');
  assert.ok(rv.length >= 190, `expected the 64×3 sweep plus narrative cases, found ${rv.length}`);
  const won = new Set(rv.map((v) => (v as { expectMatchedRuleId: string }).expectMatchedRuleId));
  const snap2 = doc.fixtures.snapshots['snap-2'] as PolicySnapshot;
  for (const r of snap2.rules) {
    if (r.id === 'w-c-disabled') {
      // `enabled: false` with priority 999 — it would win everywhere if the
      // resolver forgot the flag, which is why it is in the fixture at all.
      assert.equal(won.has(r.id), false, 'a disabled rule won');
      continue;
    }
    assert.equal(won.has(r.id), true, `rule ${r.id} never wins; the sweep cannot see it`);
  }
});

test('resolve: which rule wins, and which matched and lost', () => {
  for (const v of doc.vectors) {
    if (v.kind !== 'resolve') continue;
    const snapshot = doc.fixtures.snapshots[v.snapshotId] as PolicySnapshot;
    const ctx = { ...(v.context as unknown as ResolveContext), at: new Date(v.at) };
    const got = resolveCirculationPolicy(snapshot, ctx);
    assert.equal(got.trace.matchedRuleId, v.expectMatchedRuleId, `${v.id}: ${v.note}`);
    assert.deepEqual([...got.trace.beatenRuleIds], [...v.expectBeatenRuleIds], `${v.id}: beaten`);
    assert.equal(got.trace.snapshotVersion, snapshot.version, `${v.id}: snapshot version`);
  }
});
