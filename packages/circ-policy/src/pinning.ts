import type {
  CalendarRoll,
  LoanPolicy,
  LostItemFeePolicy,
  OverdueFinePolicy,
  ResolvedPolicy,
} from './types.js';

/**
 * What is frozen onto a loan, and what is deliberately not.
 *
 * §6 phase 16's first acceptance criterion: "Policy resolved once and frozen;
 * editing a rule afterwards provably does not change an open loan's due date or
 * fine." This file is that freezing, and every inclusion and exclusion below is
 * a decision rather than a copy of whatever `resolveCirculationPolicy` returned.
 *
 * ## THE POLICY IS FROZEN AND THE CALENDAR IS NOT
 *
 * This is the one that looks inconsistent and is not, and it is the reason the
 * snapshot stores a `calendarId` rather than a calendar. The two answer
 * different questions:
 *
 *   The POLICY is what the library DECIDED. Fourteen days, twenty cents a day,
 *   two renewals. Re-pricing an open loan because somebody edited a rule this
 *   morning is charging a patron under terms that did not exist when they
 *   borrowed the book — which is not a bug, it is a false statement on a
 *   receipt. So it is frozen, in full, here.
 *
 *   The CALENDAR is what HAPPENED. The library was shut on the 28th. A closure
 *   entered after the fact is a CORRECTION OF THE RECORD, not a change of
 *   terms, and `OverdueFinePolicy.countClosedDays: false` exists precisely so a
 *   patron is not fined for a day the door was locked. Freezing the calendar at
 *   checkout would mean a snowstorm closure entered on Tuesday could never
 *   forgive the Monday it closed — and a librarian would have to waive the fine
 *   by hand, one patron at a time, which is exactly the manual work an ILS is
 *   for.
 *
 * The DUE DATE has no such tension, and that is why the asymmetry is safe: it is
 * computed ONCE at checkout, stored in `loans.due_at`, and never re-derived. The
 * frozen `rolls` explain it — "moved from Sunday the 5th because the branch is
 * closed" — without needing the hours it was computed against.
 *
 * ## Six things in, four out
 *
 *   IN   `loan`, `overdueFine`, `lostItemFee` — the three policies whose values
 *        price this loan. `lostItemFee` is here even though phase 16 never
 *        declares a loss, because phase 21 does and it must price against the
 *        terms in force at CHECKOUT.
 *   IN   `ruleId`, `snapshotVersion` — which rule, from which version of the
 *        matrix. A receipt reproduced two years later can name both.
 *   IN   `branchId` and `timezone` — the branch whose calendar priced it and
 *        whose civil day a fine counts in. Twenty-eight bytes against a whole
 *        civil day of drift, and the branch could be re-homed to another zone.
 *   IN   `calendarId` — WHICH calendar, so the live read has an address. Not
 *        the calendar itself; see above.
 *   IN   `rolls` — what moved the due date, and why.
 *   IN   `itemTypeId`, `patronCategoryId` — the two selectors that decided it,
 *        which `loans` also stores as columns because the statistics rollup
 *        groups on them and cannot read jsonb cheaply.
 *
 *   OUT  `hold`. §3 pins a hold policy on `holds` "identically", so phase 17
 *        freezes its own. A copy here would be a second answer that drifts.
 *   OUT  `notice`. §4.4 gives the notification engine channel resolution at SEND
 *        time; a frozen template binding would send last year's letter in this
 *        year's branding.
 *   OUT  the calendar body. See above.
 *   OUT  `beatenRuleIds` and the selector lists. They are `/circulation/explain`'s
 *        answer about the matrix as it stands, not about this loan; storing them
 *        would put a rule id in every loan row for a rule that merely lost.
 *
 * ## `v: 1`
 *
 * A discriminator, so the shape can be widened without a migration and without
 * a reader having to guess. `policy_snapshot` is jsonb on a table that will hold
 * millions of rows for a decade; the one thing certain about it is that phase 21
 * or phase 61 will want a field it has not got.
 */
export const POLICY_SNAPSHOT_VERSION = 1 as const;

export type PinnedPolicySnapshot = {
  readonly v: typeof POLICY_SNAPSHOT_VERSION;
  /** RFC 3339. When the resolution happened, which is not always `loaned_at`. */
  readonly resolvedAt: string;
  readonly snapshotVersion: number;
  readonly ruleId: string;
  readonly branchId: string;
  readonly timezone: string;
  readonly calendarId: string | null;
  readonly itemTypeId: string | null;
  readonly patronCategoryId: string | null;
  readonly loan: LoanPolicy;
  readonly overdueFine: OverdueFinePolicy;
  readonly lostItemFee: LostItemFeePolicy;
  readonly rolls: readonly CalendarRoll[];
};

/**
 * The same freeze, for a bulk loader that NAMES its policies instead of
 * resolving them (2.0 phase 20e).
 *
 * The v1→v2 upgrade pins the seeded wildcard rule onto every migrated loan,
 * deliberately: a 1.0 library had exactly one policy, so there is no matrix to
 * evaluate and nothing for `resolveCirculationPolicy` to decide. Making it
 * fabricate a `ResolvedPolicy` just to satisfy {@link pinPolicy}'s parameter
 * would be a lie in the shape of a type.
 *
 * It exists because of what happened without it. 19b wrote its own object —
 * `{migratedFrom: '1.0', loanPeriodDays, maxRenewals, finePerDayCents,
 * currency}` — and {@link readPinnedPolicy} refuses it on all five of its
 * requirements, so every migrated loan threw on its detail screen, on renew, on
 * checkin, and was skipped by the overdue sweep. This is the entry point that
 * makes the honest version no harder to write than the broken one.
 *
 * `rolls` is empty and not a parameter: a roll records a closed day a COMPUTED
 * due date was pushed over, and a migrated loan's due date is a fact copied from
 * the old system. Claiming a calendar decided it would be the same class of
 * invention this function exists to prevent.
 */
export function pinNamedPolicy(input: {
  readonly snapshotVersion: number;
  readonly ruleId: string;
  readonly resolvedAt: Date;
  readonly branchId: string;
  readonly timezone: string;
  readonly calendarId: string | null;
  readonly itemTypeId: string | null;
  readonly patronCategoryId: string | null;
  readonly loan: LoanPolicy;
  readonly overdueFine: OverdueFinePolicy;
  readonly lostItemFee: LostItemFeePolicy;
}): PinnedPolicySnapshot {
  return {
    v: POLICY_SNAPSHOT_VERSION,
    resolvedAt: input.resolvedAt.toISOString(),
    snapshotVersion: input.snapshotVersion,
    ruleId: input.ruleId,
    branchId: input.branchId,
    timezone: input.timezone,
    calendarId: input.calendarId,
    itemTypeId: input.itemTypeId,
    patronCategoryId: input.patronCategoryId,
    loan: input.loan,
    overdueFine: input.overdueFine,
    lostItemFee: input.lostItemFee,
    rolls: [],
  };
}

export function pinPolicy(input: {
  readonly resolved: ResolvedPolicy;
  readonly resolvedAt: Date;
  readonly branchId: string;
  readonly timezone: string;
  readonly calendarId: string | null;
  readonly itemTypeId: string | null;
  readonly patronCategoryId: string | null;
  readonly rolls: readonly CalendarRoll[];
}): PinnedPolicySnapshot {
  return {
    v: POLICY_SNAPSHOT_VERSION,
    resolvedAt: input.resolvedAt.toISOString(),
    snapshotVersion: input.resolved.trace.snapshotVersion,
    ruleId: input.resolved.trace.matchedRuleId,
    branchId: input.branchId,
    timezone: input.timezone,
    calendarId: input.calendarId,
    itemTypeId: input.itemTypeId,
    patronCategoryId: input.patronCategoryId,
    loan: input.resolved.loan,
    overdueFine: input.resolved.overdueFine,
    lostItemFee: input.resolved.lostItemFee,
    rolls: input.rolls,
  };
}

/**
 * Read one back, refusing anything that is not what this code wrote.
 *
 * A LOUD refusal rather than a merge with defaults, for §4.1's reason: "never
 * fails open to a default policy — a wrong loan period is a wrong receipt." A
 * snapshot that has lost its `overdueFine` is not a loan that should be priced
 * at zero; it is a loan that needs a human.
 */
export class PinnedSnapshotError extends Error {
  constructor(
    readonly loanId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PinnedSnapshotError';
  }
}

export function readPinnedPolicy(loanId: string, raw: unknown): PinnedPolicySnapshot {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PinnedSnapshotError(loanId, `Loan ${loanId} has no frozen policy snapshot.`);
  }
  const snap = raw as Partial<PinnedPolicySnapshot>;
  if (snap.v !== POLICY_SNAPSHOT_VERSION) {
    throw new PinnedSnapshotError(
      loanId,
      `Loan ${loanId} carries a policy snapshot of version ${String(snap.v)}; this build writes ` +
        `and reads version ${POLICY_SNAPSHOT_VERSION}. A migration owes it a shape it understands.`,
    );
  }
  for (const key of ['loan', 'overdueFine', 'lostItemFee'] as const) {
    if (snap[key] === undefined || snap[key] === null) {
      throw new PinnedSnapshotError(
        loanId,
        `Loan ${loanId}'s frozen policy snapshot has no \`${key}\`. It cannot be priced, and ` +
          'guessing a policy would put a number nobody chose onto a receipt.',
      );
    }
  }
  if (typeof snap.timezone !== 'string' || snap.timezone.length === 0) {
    throw new PinnedSnapshotError(
      loanId,
      `Loan ${loanId}'s frozen policy snapshot has no timezone. Every civil-day computation ` +
        'below it would be wrong by up to a day.',
    );
  }
  return snap as PinnedPolicySnapshot;
}
