import type { CirculationRule, ResolveContext, RuleSelectors, SelectorName } from './types.js';

/**
 * Which rule wins, and why.
 *
 * ## The weights are a 6-bit mask, and they are deliberately not configurable
 *
 * §3's `circulation_rules.specificity` is a STORED generated column:
 *
 *     (CASE WHEN patron_category_id   IS NOT NULL THEN 32 ELSE 0 END)
 *   + (CASE WHEN item_type_id         IS NOT NULL THEN 16 ELSE 0 END)
 *   + (CASE WHEN owning_branch_id     IS NOT NULL THEN  8 ELSE 0 END)
 *   + (CASE WHEN shelving_location_id IS NOT NULL THEN  4 ELSE 0 END)
 *   + (CASE WHEN checkout_branch_id   IS NOT NULL THEN  2 ELSE 0 END)
 *   + (CASE WHEN pickup_branch_id     IS NOT NULL THEN  1 ELSE 0 END)
 *
 * — verified against a real Postgres 16.15 over all 64 selector combinations,
 * zero mismatches, which is the phase-12 acceptance criterion. {@link specificity}
 * below is the same arithmetic in TypeScript, and `rank.test.ts` enumerates the
 * same 64.
 *
 * §3 states why the weights are fixed: they "encode the precedence Koha
 * librarians already carry in their heads", `priority` exists for the one-off
 * exception, and "a configurable precedence order makes every support
 * conversation start from scratch".
 *
 * ## The `id` tiebreak has a portability trap, and it is not this package's to fix
 *
 * Rank is `priority DESC, specificity DESC, id ASC`, and the `id` is what makes
 * it a TOTAL order — without it two equally specific rules resolve differently
 * on different pods, which is how ILS policy bugs become unreproducible.
 *
 * But `id ASC` means something different in the two places it is evaluated.
 * Tenant databases are created with ICU `el-GR` as the default collation, and
 * measured on this repo's own Postgres:
 *
 *     ICU el-GR:  c0abc, c0Abc, r1, R1, rule_b, rule-10, rule-2, rule-a, …
 *     C / JS:     R1, c0Abc, c0abc, r1, rule-10, rule-2, rule-A, rule-B, …
 *
 * So a SQL `ORDER BY … id` and this function disagree exactly when two rules
 * tie, which is exactly when the tiebreak matters. The fix belongs to phase 13's
 * query — `ORDER BY priority DESC, specificity DESC, id COLLATE "C"` — and
 * `rank.test.ts` documents the requirement so that phase cannot ship without
 * meeting it.
 */

/**
 * The weights, in the order §3 fixes them.
 *
 * Declared as a list rather than a record so that iteration order IS the
 * precedence order: every loop below reads high-to-low, and a reader can see the
 * hierarchy without holding six numbers in their head.
 */
export const SELECTOR_WEIGHTS: readonly (readonly [SelectorName, number])[] = [
  ['patronCategoryId', 32],
  ['itemTypeId', 16],
  ['owningBranchId', 8],
  ['shelvingLocationId', 4],
  ['checkoutBranchId', 2],
  ['pickupBranchId', 1],
];

/**
 * The SECOND weight table: notice templates.
 *
 * §4.1: "The same ranking function resolves notice templates (branch 2,
 * category 1)" — which INVERTS the circulation precedence, where the category
 * is 32 and the branch is 8.
 *
 * That is not an inconsistency, it is the domain. A loan period is a property of
 * WHO is borrowing (a child gets three weeks, a member of staff a term), so the
 * category dominates. A notice is a property of WHO IS SENDING it — the branch's
 * name, address, opening hours and voice appear in the text — so the branch
 * dominates. A tenant that has customised its overdue wording for one branch
 * means that branch's wording even for a category with its own template.
 */
export const TEMPLATE_SELECTOR_WEIGHTS: readonly (readonly [string, number])[] = [
  ['branchId', 2],
  ['patronCategoryId', 1],
];

/** The 6-bit mask §3's generated column computes. */
export function specificity(s: RuleSelectors): number {
  let n = 0;
  for (const [name, weight] of SELECTOR_WEIGHTS) if (s[name] !== null) n += weight;
  return n;
}

/**
 * Does this rule apply to this context?
 *
 * A NULL selector is a WILDCARD and matches anything. A non-null selector must
 * equal the context's value — and a context value of `null` (an item with no
 * shelving location, a checkout with no pickup branch) therefore matches only a
 * wildcard, which is right: a rule that names a shelving location is not about
 * an item that has none.
 */
export function matchesSelectors(rule: RuleSelectors, ctx: ResolveContext): boolean {
  for (const [name] of SELECTOR_WEIGHTS) {
    const want = rule[name];
    if (want === null) continue;
    const have = name === 'pickupBranchId' ? (ctx.pickupBranchId ?? null) : ctx[name];
    if (want !== have) return false;
  }
  return true;
}

/** Which selectors this rule pins, high weight first. */
export function selectorsUsed(rule: RuleSelectors): SelectorName[] {
  return SELECTOR_WEIGHTS.filter(([n]) => rule[n] !== null).map(([n]) => n);
}

/** Which selectors this rule leaves open, high weight first. */
export function wildcardsUsed(rule: RuleSelectors): SelectorName[] {
  return SELECTOR_WEIGHTS.filter(([n]) => rule[n] === null).map(([n]) => n);
}

/**
 * `priority DESC, specificity DESC, id ASC` as a comparator.
 *
 * Negative means `a` wins. Sorting an array with this puts the winner first.
 *
 * The id comparison is `<`/`>` on the raw strings — UTF-16 code units, which is
 * what Rust's `Ord for str` does too, so the TypeScript resolver and the offline
 * core agree. See the file docblock for why Postgres does not, and whose problem
 * that is.
 */
export function compareRank(a: CirculationRule, b: CirculationRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const sa = specificity(a);
  const sb = specificity(b);
  if (sa !== sb) return sb - sa;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * A single sortable number for a rule's rank, for a caller that wants one.
 *
 * `priority` and `specificity` only; the id tiebreak cannot be expressed as a
 * number and {@link compareRank} is what a sort should use. Exposed because
 * phase 13's `/circulation/explain` renders it, and because a test that asserts
 * "this rule outranks that one" reads better with a number than with a
 * comparator's sign.
 */
export function rank(rule: CirculationRule): number {
  // `specificity` is 0..63, so shifting priority left by six keeps the two
  // fields from ever interfering — the same reason the weights are a bitmask.
  return rule.priority * 64 + specificity(rule);
}

/**
 * Is this rule in force at this instant?
 *
 * `effective_from`/`effective_to` are how a library schedules a change — "from
 * 1 September, students get four weeks" — without editing a live rule at
 * midnight. Half-open `[from, to)`: a rule that ends on the 1st and one that
 * begins on the 1st do not both apply for a day.
 */
export function isInForce(rule: CirculationRule, at: Date): boolean {
  if (!rule.enabled) return false;
  const t = at.getTime();
  if (rule.effectiveFrom !== null && t < Date.parse(rule.effectiveFrom)) return false;
  if (rule.effectiveTo !== null && t >= Date.parse(rule.effectiveTo)) return false;
  return true;
}
