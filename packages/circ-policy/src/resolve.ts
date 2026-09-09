import { compareRank, isInForce, matchesSelectors, selectorsUsed, wildcardsUsed } from './rank.js';
import {
  POLICY_ERROR,
  PolicyResolutionError,
  type CirculationRule,
  type NoticePolicy,
  type NoticeTemplateBinding,
  type NoticeTrigger,
  type PolicySnapshot,
  type ResolveContext,
  type ResolvedPolicy,
  type RuleTrace,
} from './types.js';

/**
 * Which rule applies, and therefore which five policies.
 *
 * ## Winner takes all — no per-field merge across rules, ever
 *
 * §3 states it and this file enforces it structurally: {@link ResolvedPolicy} is
 * built from exactly ONE {@link CirculationRule} plus the five policy objects
 * that rule names, and there is no code path here that reads a second rule.
 * There is deliberately no `mergeRules` helper for someone to reach for.
 *
 * Four reasons, and the third is the product:
 *
 * 1. A merge has no defined order for conflicting values, so the resolved policy
 *    is an object no librarian ever wrote and no test enumerated.
 * 2. `loans.applied_rule_id` is NOT NULL. Under a merge that pinned id is a lie
 *    and `policy_snapshot` cannot be explained by opening one row.
 * 3. `/circulation/explain` and the "Why is this due 19 Sep?" tooltip are only
 *    answerable under winner-takes-all. Under a merge the honest answer is a
 *    six-row field-provenance table nobody reads, and §6's M2 claim — "Koha,
 *    Alma and FOLIO cannot answer the why-this-due-date question at all" —
 *    evaporates.
 * 4. With one winner, N rules give N reachable outcomes and the golden vectors
 *    mean something. Under a per-field merge the outcome space is the product of
 *    six lattices.
 *
 * WHAT BREAKS IN KOHA, concretely, because it does merge: Koha resolves per RULE
 * NAME rather than per rule row — its `circulation_rules` is keyed
 * `(branchcode, categorycode, itemtype, rule_name)` — so `issuelength` can come
 * from one row, `renewalsallowed` from another and `fine` from a third. A blank
 * field means "inherit from somewhere" and the somewhere is not shown;
 * `maxissueqty` resolves through a different fallback chain than the loan length
 * because the `CircControl` syspref independently picks branch-by-patron-home
 * versus item-home versus checkout, so the branch that limits you is not the
 * branch that dates you; and because no single rule id applied, Koha cannot
 * reproduce a historical charge after a rules edit.
 *
 * ## It never fails open
 *
 * §4.1: "**never fails open to a default policy** — a wrong loan period is a
 * wrong receipt." Every way this can fail is a {@link PolicyResolutionError} with
 * a code, and this package exports no default policy of any kind — not even for
 * fixtures — because the moment one exists somebody writes `?? DEFAULT` and
 * every refusal becomes unreachable.
 */
export function resolveCirculationPolicy(
  snapshot: PolicySnapshot,
  ctx: ResolveContext,
): ResolvedPolicy {
  // Only rules in force at THIS instant, and only rules that match THIS context.
  // `beatenRuleIds` is the losers of that set — not every rule of lower rank,
  // which for a 500-rule snapshot would be 499 ids allocated on the checkout hot
  // path and rendered into an explain screen nobody could read. "Your branch
  // rule beat the tenant default" is what a librarian wanted to know.
  const candidates = snapshot.rules
    .filter((r) => isInForce(r, ctx.at) && matchesSelectors(r, ctx))
    .sort(compareRank);

  const winner = candidates[0];
  if (winner === undefined) {
    throw new PolicyResolutionError(
      POLICY_ERROR.noMatchingRule,
      'No circulation rule matches this loan, and there is no wildcard rule to fall back to. ' +
        'A library must have exactly one rule with every selector left blank; without it the ' +
        'desk cannot lend anything.',
    );
  }
  const runnerUp = candidates[1];
  if (runnerUp !== undefined && compareRank(winner, runnerUp) === 0) {
    // Impossible with distinct ids, and asserted anyway: a snapshot built by a
    // query with a bad join duplicates rows, and the symptom would otherwise be
    // a loan period that changes between two identical checkouts.
    throw new PolicyResolutionError(
      POLICY_ERROR.ambiguousRule,
      `Rules ${winner.id} and ${runnerUp.id} tie on priority, specificity and id. The snapshot ` +
        'contains a duplicate row.',
      winner.id,
    );
  }

  const v = snapshot.version;
  const loan = need(snapshot.loanPolicies, winner.loanPolicyId, 'loan', winner, v);
  const overdueFine = need(
    snapshot.overdueFinePolicies,
    winner.overdueFinePolicyId,
    'overdue fine',
    winner,
    v,
  );
  const lostItemFee = need(
    snapshot.lostItemFeePolicies,
    winner.lostItemFeePolicyId,
    'lost item fee',
    winner,
    v,
  );
  const hold = need(snapshot.holdPolicies, winner.holdPolicyId, 'hold', winner, v);
  const notice = need(snapshot.noticePolicies, winner.noticePolicyId, 'notice', winner, v);

  const trace: RuleTrace = {
    snapshotVersion: snapshot.version,
    matchedRuleId: winner.id,
    beatenRuleIds: candidates.slice(1).map((r) => r.id),
    selectorsUsed: selectorsUsed(winner),
    wildcardsUsed: wildcardsUsed(winner),
    // Filled by `computeDueDate`, which is where a date can move. Empty here
    // rather than absent so the shape of a trace never varies.
    calendarRolls: [],
  };

  return {
    rule: winner,
    loan,
    overdueFine,
    lostItemFee,
    hold,
    notice,
    categoryLimit:
      ctx.patronCategoryId !== null
        ? (snapshot.patronCategoryLimits[ctx.patronCategoryId] ?? null)
        : null,
    trace,
  };
}

/**
 * A rule naming a policy the snapshot does not hold is a REFUSAL.
 *
 * The important one. A resolver that fell back to a fourteen-day default here
 * would turn a stale snapshot into a fortnight's loan on a two-hour course
 * reserve, and the librarian would find out when the reserve shelf was empty.
 */
function need<T>(
  table: Readonly<Record<string, T>>,
  id: string,
  what: string,
  rule: CirculationRule,
  snapshotVersion: number,
): T {
  const found = table[id];
  if (found === undefined) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyNotInSnapshot,
      `Rule "${rule.name}" (${rule.id}) names ${what} policy ${id}, which policy snapshot ` +
        `version ${snapshotVersion} does not contain. The snapshot is stale, or the rule points ` +
        'at a policy that was deleted.',
      id,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Notice templates — the same ranking, a different table of weights
// ---------------------------------------------------------------------------

export type TemplateContext = {
  readonly trigger: NoticeTrigger;
  readonly branchId: string | null;
  readonly patronCategoryId: string | null;
};

/**
 * Which notice template fires, for one trigger.
 *
 * §4.1: "The same ranking function resolves notice templates (branch 2, category
 * 1)" — which INVERTS the circulation precedence, where the category is 32 and
 * the branch is 8.
 *
 * That inversion is the domain, not an inconsistency. A loan period is a
 * property of WHO IS BORROWING: a child gets three weeks, a member of staff a
 * term, so the category dominates. A notice is a property of WHO IS SENDING it —
 * the branch's name, address, opening hours and voice are in the text — so the
 * branch dominates. A library that has rewritten its overdue letter for one
 * branch means that branch's letter, even for a category that has its own.
 *
 * Returns `null` rather than throwing: a library that has configured no template
 * for `holdExpiring` has decided not to send one, which is a choice and not a
 * fault. That is the ONE place in this package where absence is an answer, and
 * it is safe precisely because the consequence is silence rather than a wrong
 * number.
 */
export function resolveTemplate(
  policy: NoticePolicy,
  ctx: TemplateContext,
): NoticeTemplateBinding | null {
  const matching = policy.templates.filter(
    (t) =>
      t.trigger === ctx.trigger &&
      (t.branchId === null || t.branchId === ctx.branchId) &&
      (t.patronCategoryId === null || t.patronCategoryId === ctx.patronCategoryId),
  );
  if (matching.length === 0) return null;
  return [...matching].sort(compareTemplateRank)[0] ?? null;
}

/** `specificity DESC, id ASC`, with the notice weights. */
export function compareTemplateRank(a: NoticeTemplateBinding, b: NoticeTemplateBinding): number {
  const sa = templateSpecificity(a);
  const sb = templateSpecificity(b);
  if (sa !== sb) return sb - sa;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Branch 2, category 1 — §4.1's weights, and the inverse of a rule's. */
export function templateSpecificity(t: NoticeTemplateBinding): number {
  return (t.branchId !== null ? 2 : 0) + (t.patronCategoryId !== null ? 1 : 0);
}
