/**
 * The six rows a library must have before it can lend anything.
 *
 * `packages/circ-policy` exports NO default policy — deliberately, and a test
 * greps its source to be sure — because "the first `?? DEFAULT` at a call site
 * makes every refusal in the package unreachable". That leaves a gap this file
 * fills, and the difference between the two is the whole point:
 *
 *   a DEFAULT is what the resolver falls back to when it cannot find a policy.
 *     Invisible, unattributable, and it prices a real loan with a value nobody
 *     wrote.
 *   a SEED is a row, in the library's own database, with a name, a created_at
 *     and an audit trail, which the librarian can see and edit and which
 *     `RuleTrace.matchedRuleId` names on the receipt.
 *
 * So these values are not a fallback. They are the starting configuration of a
 * new library, and the moment they are written they stop being ours.
 *
 * ## The numbers, and where they come from
 *
 * They are 1.0's `tenant_settings` defaults, verbatim — fourteen days, two
 * renewals, fines off, holds on, a 48-hour hold shelf — because those are the
 * numbers this product has been shipping to Greek libraries and a 2.0 tenant
 * that behaved differently on day one would be a migration nobody asked for.
 *
 * THE ARITHMETIC IS NOT THE SAME, and that is deliberate. 1.0 computes a due
 * date as `loanedAt + days × 86_400_000` — elapsed milliseconds — and counts an
 * overdue in whole 24-hour blocks, with the reason written into
 * `loans.service.ts:377`: "Calendar-day billing would require a per-tenant
 * timezone (no such column exists today)". 2.0 has that column, so `{value: 14,
 * unit: 'days'}` means fourteen CIVIL days in the branch's zone and a fine
 * accrues per calendar day. Across a Greek DST boundary the two answers differ
 * by an hour, and a fine on a loan spanning one differs by up to a day's charge.
 * That difference IS phase 23's "`circ-5` closed, with a regression test that
 * fails under the 1.0 arithmetic" — so simple mode must not try to reproduce
 * 1.0, and phase 19's copy-forward is where the divergence gets stated to a
 * migrating library.
 *
 * ## Fines and lost-item fees are OFF, and off is expressed as a rate of zero
 *
 * 1.0 has master switches — `overdueFinesEnabled`, `lostItemFeesEnabled` —
 * layered above the rate, and `OverdueFinePolicy` has no `enabled` field.
 * Encoding "off" as `amountPerInterval = 0` is faithful (nothing is charged) and
 * lossy in one way worth naming: a library that turns fines off loses the rate
 * unless the simple-mode form keeps it, which is why the form keeps it rather
 * than writing straight through.
 */

export const DEFAULT_IDS = {
  loanPolicy: 'lp-default',
  finePolicy: 'fp-default',
  lostItemPolicy: 'lf-default',
  holdPolicy: 'hp-default',
  noticePolicy: 'np-default',
  /**
   * THE WILDCARD RULE, and its id is stable and readable on purpose.
   *
   * It is written into `loans.applied_rule_id` on every checkout a small library
   * ever makes, it is what `/circulation/explain` names, and it is the row the
   * delete guard protects. A cuid would put an opaque 25-character string in all
   * three places. Note that a human-chosen id is also exactly the case where the
   * ICU-versus-code-unit collation divergence is real — which is why nothing
   * orders rules in SQL; see the loader.
   */
  wildcardRule: 'rule-default',
} as const;

/** 1.0's `tenant_settings` circulation defaults, as the six rows they become. */
export const CIRCULATION_DEFAULTS = {
  loanPolicy: {
    id: DEFAULT_IDS.loanPolicy,
    name: 'Standard loan',
    loanable: true,
    profile: 'rolling',
    periodValue: 14,
    periodUnit: 'days',
    // NULL keeps the checkout's own time of day, which is what 1.0 does and what
    // a library with no configured closing time expects.
    dueTimeOfDayMin: null,
    // `keep` until the library has a calendar. A branch with no calendar has no
    // closed days to roll off, and rolling against a calendar that does not
    // exist is `CALENDAR_NOT_DEFINED_FOR` at the desk.
    closedDayHandling: 'keep',
    renewable: true,
    renewalsAllowed: 2,
    renewalPeriodValue: 14,
    renewalPeriodUnit: 'days',
    // 1.0's renewal base is `max(dueAt, now)`, which is `currentDueDate` for a
    // loan not yet due and `systemDate` for one already overdue. `renewFrom` has
    // no value that means both. `currentDueDate` is Koha's default and the
    // answer 1.0 gives on the majority of renewals, which are not overdue; the
    // simple-mode form offers the other as a two-option choice rather than
    // migrating it silently.
    renewFrom: 'currentDueDate',
    // 1.0 blocks a renewal outright when any hold exists on the book.
    renewWithOutstandingHolds: false,
  },
  finePolicy: {
    id: DEFAULT_IDS.finePolicy,
    name: 'Overdue fine',
    currency: 'EUR',
    intervalValue: 1,
    intervalUnit: 'days',
    // Off. See the docblock.
    amountPerIntervalCents: 0n,
    // 1.0 floors `(returnedAt - dueAt) / 24h`, so a partial day is free.
    chargeAt: 'intervalEnd',
    countClosedDays: true,
    forgiveOn: [],
  },
  lostItemPolicy: {
    id: DEFAULT_IDS.lostItemPolicy,
    name: 'Lost item',
    currency: 'EUR',
    // 1.0 bills `replacementCostCents ?? lostItemDefaultFeeCents`, i.e. a fixed
    // amount, not the item's price. `replacementPrice` is the better model and
    // is what a library moves to once its items carry prices; starting there
    // would raise `NO_REPLACEMENT_PRICE` on every item imported without one.
    chargeBasis: 'fixedAmount',
    fixedAmountCents: 0n,
    processingFeeCents: 0n,
    agedToLostAfterValue: 30,
    agedToLostAfterUnit: 'days',
  },
  holdPolicy: {
    id: DEFAULT_IDS.holdPolicy,
    name: 'Standard holds',
    currency: 'EUR',
    holdsAllowed: true,
    requestTypes: ['hold'],
    onShelfHolds: 'allow',
    itemLevelHolds: 'allow',
    // 1.0's reservations unique index is one live reservation per (book, member).
    maxHoldsPerRecord: 1,
    pickupPolicy: 'any',
    holdShelfExpiryValue: 48,
    holdShelfExpiryUnit: 'hours',
    // 1.0 adds elapsed hours with no calendar, and a library with no calendar
    // cannot do otherwise. Phase 23's calendar UI is where this becomes true.
    shelfExpiryUsesCalendar: false,
  },
  noticePolicy: {
    id: DEFAULT_IDS.noticePolicy,
    name: 'Standard notices',
    // NO BINDINGS. 1.0 ships every `notify*` switch OFF "so a library never
    // auto-emails its patrons until an admin turns them on", and phase 22 owns
    // the templates a binding would point at. An empty policy is silence, which
    // `resolveTemplate` returns `null` for — the one place in `circ-policy`
    // where absence is an answer, and it is safe precisely because the
    // consequence is silence rather than a wrong number.
    templates: [],
  },
} as const;

export type CirculationDefaults = typeof CIRCULATION_DEFAULTS;

/**
 * The six rows, stamped with one instant.
 *
 * Typed structurally rather than against `Prisma.*UncheckedCreateInput`: the v2
 * namespace is not re-exported from `@libriant/db-tenant`, and widening that
 * package's public surface to type a seed would be the tail wagging the dog.
 * The `create` calls in `policy-write.service.ts` are checked against the real
 * generated types at the call site, which is where a wrong column name should
 * fail.
 */
export function defaultPolicyRows(now: Date) {
  const d = CIRCULATION_DEFAULTS;
  return {
    loanPolicy: { ...d.loanPolicy, createdAt: now, updatedAt: now },
    finePolicy: {
      ...d.finePolicy,
      forgiveOn: [...d.finePolicy.forgiveOn],
      createdAt: now,
      updatedAt: now,
    },
    lostItemPolicy: { ...d.lostItemPolicy, createdAt: now, updatedAt: now },
    holdPolicy: {
      ...d.holdPolicy,
      requestTypes: [...d.holdPolicy.requestTypes],
      createdAt: now,
      updatedAt: now,
    },
    noticePolicy: {
      id: d.noticePolicy.id,
      name: d.noticePolicy.name,
      createdAt: now,
      updatedAt: now,
    },
    rule: {
      id: DEFAULT_IDS.wildcardRule,
      name: 'Library default',
      notes:
        'The wildcard rule. Every loan this library makes resolves to it unless a more specific ' +
        'rule matches, and it cannot be deleted or disabled — without it the desk cannot lend.',
      loanPolicyId: d.loanPolicy.id,
      overdueFinePolicyId: d.finePolicy.id,
      lostItemFeePolicyId: d.lostItemPolicy.id,
      holdPolicyId: d.holdPolicy.id,
      noticePolicyId: d.noticePolicy.id,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Write the six rows if the library has none. Returns whether it did.
 *
 * ONE implementation, called from two places, for the reason
 * `TenantProvisioningService.seedDefaults` already states about
 * `seedTenantDefaults`: "this used to be one of three copies of the same
 * defaults object, beside a fourth provisioning path that had none."
 *
 * Takes any client that can run the six creates — the provisioning path hands it
 * a bare v2 client with no request context, and `PolicyWriteService` hands it a
 * transaction that has already taken the advisory lock and set the change actor.
 * The guard is `count() === 0` rather than an upsert per row so that a library
 * which has EDITED its defaults is never quietly reset to them.
 */
export async function seedCirculationDefaults(
  tx: {
    circulationRule: { count: () => Promise<number>; create: (a: never) => Promise<unknown> };
    loanPolicy: { create: (a: never) => Promise<unknown> };
    overdueFinePolicy: { create: (a: never) => Promise<unknown> };
    lostItemFeePolicy: { create: (a: never) => Promise<unknown> };
    holdPolicy: { create: (a: never) => Promise<unknown> };
    noticePolicy: { create: (a: never) => Promise<unknown> };
    circulationSetting: { upsert: (a: never) => Promise<unknown> };
  },
  now: Date,
): Promise<boolean> {
  if ((await tx.circulationRule.count()) > 0) return false;
  const rows = defaultPolicyRows(now);
  await tx.loanPolicy.create({ data: rows.loanPolicy } as never);
  await tx.overdueFinePolicy.create({ data: rows.finePolicy } as never);
  await tx.lostItemFeePolicy.create({ data: rows.lostItemPolicy } as never);
  await tx.holdPolicy.create({ data: rows.holdPolicy } as never);
  await tx.noticePolicy.create({ data: rows.noticePolicy } as never);
  await tx.circulationRule.create({ data: rows.rule } as never);
  await tx.circulationSetting.upsert({
    where: { id: 1 },
    create: { id: 1, circulationRulesEnabled: false, updatedAt: now },
    update: {},
  } as never);
  return true;
}
