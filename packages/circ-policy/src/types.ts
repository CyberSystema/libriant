import type { Money } from '@libriant/shared/money';

/**
 * The vocabulary of circulation policy.
 *
 * ## These types are the column spec phase 13 will be written from
 *
 * §3 gives `circulation_rules` a full CREATE TABLE and `loans` another, and then
 * names fourteen more tables — `calendars`, `calendar_hours`,
 * `calendar_exceptions`, `loan_policies`, `overdue_fine_policies`,
 * `lost_item_fee_policies`, `hold_policies`, `notice_policies`,
 * `fixed_due_date_sets`, `patron_category_limits` — in one inventory list and
 * specifies no column of any of them. `BASELINE-SCOPE.json` marks every one
 * `deferred` to "9b/12-17", and the README says 9b is authored WITH phases 12
 * and 13.
 *
 * So this file is doing two jobs at once and it is worth being honest about
 * which: it is the resolver's input type, and it is the design of tables that do
 * not exist yet. Every field below therefore has to justify itself as something
 * a library actually configures — not as something a resolver found convenient.
 * Where a field exists because Koha, Alma or FOLIO all have it and libraries
 * would notice its absence, the docblock says so.
 *
 * ## Everything here must survive `JSON.stringify`
 *
 * `loans.policy_snapshot jsonb` freezes the whole {@link ResolvedPolicy} at
 * checkout so that editing a rule can never retroactively re-price an open loan,
 * and `fees.accrual_policy jsonb` freezes the fine policy. That makes JSON
 * round-tripping a TYPE CONSTRAINT, not a serialization detail:
 *
 *   - no `bigint` — `JSON.stringify({a: 1n})` THROWS, so money is
 *     {@link MoneyJson}, not `Money`, everywhere a policy is stored;
 *   - no `Date` — instants are RFC 3339 strings in stored shapes and real
 *     `Date`s only in function arguments;
 *   - no `undefined`-versus-absent ambiguity that changes meaning.
 *
 * The same constraint is what makes `fixtures/resolution-vectors.json` runnable
 * by `cargo test` as well as `node --test`.
 */

/**
 * Money as it is stored and as it crosses the vector file.
 *
 * `@libriant/shared/money` is the arithmetic and `Money.amount` is a `bigint`,
 * which is right for a ledger and impossible in JSON. So a policy holds this,
 * and {@link toMoney} converts at the boundary — once, in one place, rather than
 * at every call site.
 */
export type MoneyJson = {
  /** Count of minor units. Integer, never a decimal string. */
  readonly minorUnits: number;
  /** ISO 4217 alpha-3. */
  readonly currency: string;
};

/** A length of time, as a library configures it. */
export type Duration = {
  readonly value: number;
  readonly unit: DurationUnit;
};

/**
 * The unit decides the ARITHMETIC, and this is the most consequential field in
 * the package.
 *
 * `minutes` and `hours` are ELAPSED time: a 2-hour loan is 7,200,000 ms later,
 * whatever the clock did in between. `days`, `weeks` and `months` are CIVIL
 * calendar arithmetic in the branch's timezone: 14 days later is the same
 * wall-clock time on a date 14 days on, which is one hour more or less of
 * elapsed time when a DST boundary falls between them.
 *
 * Conflating the two is `circ-5` in miniature. A library that says "three
 * weeks" means three weeks on a calendar; a library that says "two hours" means
 * two hours on a clock.
 */
export type DurationUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

/** A wall-clock date in some timezone. No instant, no offset, no zone. */
export type CivilDate = {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** 1-31. */
  readonly day: number;
};

/** A wall-clock date and time in some timezone. */
export type CivilDateTime = CivilDate & {
  /** 0-23. */
  readonly hour: number;
  /** 0-59. */
  readonly minute: number;
  /** 0-59. */
  readonly second: number;
};

/** A time of day, with no date. */
export type TimeOfDay = { readonly hour: number; readonly minute: number };

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

/**
 * One opening interval, in MINUTES FROM LOCAL MIDNIGHT, half-open `[open, close)`.
 *
 * Minutes rather than a time string because every comparison in this package is
 * then integer arithmetic — see `calendar.ts` for why that matters at 415× the
 * speed of an `Intl` round trip. Half-open because a library that closes at
 * 14:00 is shut AT 14:00, and a 2-hour loan started at 12:00 is due exactly when
 * the desk closes rather than one minute inside it.
 */
export type OpeningInterval = {
  /** Minutes from local midnight. 480 = 08:00. */
  readonly open: number;
  /** Minutes from local midnight. 840 = 14:00. May exceed 1440 for past midnight. */
  readonly close: number;
};

/**
 * A weekday's opening hours: an ARRAY of intervals, not one pair.
 *
 * THE GREEK SPLIT DAY (διακεκομμένο ωράριο) is why. 08:00–14:00 then 17:00–21:00
 * is the ordinary shape of a Greek municipal library, and three things break if
 * a day has a single open/close pair: `isOpenAt(14:30)` says open when the desk
 * is shut, `nextOpen` from 14:30 cannot answer "17:00 today", and "end of the
 * open day" comes out as 14:00 or 23:59 rather than 21:00.
 *
 * Koha's and FOLIO's calendar UIs both fight this, and every Greek library that
 * uses them works around it.
 */
export type DayHours = {
  /** 0 = Sunday, per `Date.prototype.getUTCDay` and this package's `weekdayOf`. */
  readonly weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Empty means closed all day. */
  readonly intervals: readonly OpeningInterval[];
};

/**
 * A named exception to the weekly pattern, on one civil date.
 *
 * `intervals` empty means CLOSED that day; non-empty REPLACES the weekly hours
 * — never merges with them, because "we open late on 24 December" and "we are
 * shut on 25 December" are the same kind of statement and a merge cannot express
 * the first.
 */
export type CalendarException = {
  readonly date: CivilDate;
  /** Empty = closed. Non-empty = these hours instead of the weekday's. */
  readonly intervals: readonly OpeningInterval[];
  /** Shown to a librarian, and in the resolution trace. */
  readonly name: string;
};

/**
 * One branch's opening calendar.
 *
 * `definedFrom`/`definedTo` are the honest half. A calendar knows its own
 * hours for a bounded range of dates, and a resolver asked about a date outside
 * it must REFUSE rather than assume "open, normal hours" — assuming is how a
 * library fines patrons for days it was shut. See
 * `POLICY_ERROR.calendarNotDefinedFor`.
 */
export type Calendar = {
  readonly id: string;
  /** IANA name, exactly as stored. NEVER `resolvedOptions().timeZone`. */
  readonly timezone: string;
  readonly weekly: readonly DayHours[];
  readonly exceptions: readonly CalendarException[];
  /** Inclusive. */
  readonly definedFrom: CivilDate;
  /** Inclusive. */
  readonly definedTo: CivilDate;
};

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** The six selectors of `circulation_rules`, in weight order. NULL = wildcard. */
export type RuleSelectors = {
  readonly patronCategoryId: string | null;
  readonly itemTypeId: string | null;
  readonly owningBranchId: string | null;
  readonly shelvingLocationId: string | null;
  readonly checkoutBranchId: string | null;
  readonly pickupBranchId: string | null;
};

export type SelectorName = keyof RuleSelectors;

/**
 * One row of `circulation_rules`.
 *
 * WINNER TAKES ALL. The five policy ids are the PAYLOAD of exactly one rule and
 * are never merged across rules — see `resolve.ts` for the argument, which is
 * the difference between being able to answer "why is this due on the 19th?" and
 * not.
 */
export type CirculationRule = RuleSelectors & {
  readonly id: string;
  readonly name: string;
  readonly loanPolicyId: string;
  readonly overdueFinePolicyId: string;
  readonly lostItemFeePolicyId: string;
  readonly holdPolicyId: string;
  readonly noticePolicyId: string;
  /** Rule-scoped ceilings. `null` means "this rule sets none", not "zero". */
  readonly maxLoansForRule: number | null;
  readonly maxHoldsForRule: number | null;
  readonly ageRestrictionMinYears: number | null;
  /** Higher wins first. The escape hatch for a one-off exception. */
  readonly priority: number;
  readonly enabled: boolean;
  /** RFC 3339, or null for "always". Both bounds inclusive-from, exclusive-to. */
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
};

// ---------------------------------------------------------------------------
// The five policies a rule names
// ---------------------------------------------------------------------------

/**
 * How the due date is computed.
 *
 * `rolling` adds {@link LoanPolicy.period} to the checkout instant. `fixed`
 * takes the due date from a {@link FixedDueDateSet} — the school and university
 * "everything is due at the end of term" case, which in Greece is a public-
 * library case too because school libraries run mid-September to mid-June.
 * `indefinite` has no due date at all: a staff reference loan, a long-term
 * departmental deposit.
 */
export type LoanProfile = 'rolling' | 'fixed' | 'indefinite';

/**
 * What to do when the computed due date falls when the library is shut.
 *
 * NOT A BOOLEAN, and that is the phase-25 requirement in disguise: "reserve
 * items are 2-hour in-library loans" must be expressible as an ordinary rule,
 * and a 2-hour loan started at 13:30 on a Greek split day (08:00–14:00,
 * 17:00–21:00) must be due at 14:00 — when the desk closes — and never at 15:30
 * when nobody is there to take it back.
 *
 *   keep                    leave it, however shut the library is
 *   endOfPreviousOpenDay    pull back to the last minute the library was open
 *   startOfNextOpenDay      push to opening time (plus `openingTimeOffset`)
 *   endOfNextOpenDay        push to the next open day's closing minute
 *   endOfCurrentOpenHours   clamp to the end of the CURRENT open interval —
 *                           the in-library loan
 */
export type ClosedDayHandling =
  | 'keep'
  | 'endOfPreviousOpenDay'
  | 'startOfNextOpenDay'
  | 'endOfNextOpenDay'
  | 'endOfCurrentOpenHours';

export type LoanPolicy = {
  readonly id: string;
  readonly name: string;
  /** False means this combination does not circulate at all. */
  readonly loanable: boolean;
  readonly profile: LoanProfile;
  /** Required when `profile` is `rolling`. */
  readonly period: Duration | null;
  /** Required when `profile` is `fixed`. */
  readonly fixedDueDateSetId: string | null;
  /**
   * What "14 days" means at the minute level.
   *
   * A library that lends for two weeks does not mean "at 14:37 in a fortnight
   * because that is when the barcode was scanned"; it means "the fourteenth day,
   * at closing" or "at 23:59". Null keeps the checkout time of day, which is
   * what an hourly loan wants and what a daily loan almost never does.
   */
  readonly dueTimeOfDay: TimeOfDay | null;
  readonly closedDayHandling: ClosedDayHandling;
  /** Added after rolling to a next open day, e.g. "one hour after opening". */
  readonly openingTimeOffset: Duration | null;
  /** An upper bound on the whole period, whatever the arithmetic produced. */
  readonly maxPeriod: Duration | null;
  readonly renewable: boolean;
  /** `null` is UNLIMITED. `0` is "renewable: false" said twice — use `renewable`. */
  readonly renewalsAllowed: number | null;
  readonly renewalPeriod: Duration | null;
  /**
   * Renewing an overdue loan: 14 days from now, or 14 days from a date already
   * past?
   *
   * The classic librarian complaint, and both answers are defensible — which is
   * exactly why it is configuration and not a constant.
   */
  readonly renewFrom: 'currentDueDate' | 'systemDate';
  /** How close to the due date a renewal is allowed. Null = any time. */
  readonly noRenewalBefore: Duration | null;
  readonly noRenewalBeforeRelativeTo: 'dueDate' | 'now';
  readonly renewWithOutstandingHolds: boolean;
  /** A hold on the title shortens the loan without any special case in the engine. */
  readonly alternateCheckoutPeriodWithHolds: Duration | null;
  readonly alternateRenewalPeriodWithHolds: Duration | null;
  /** A ceiling on copies of ONE title on loan to one patron. */
  readonly itemLimitForPolicy: number | null;
};

/**
 * How an overdue is priced.
 *
 * GRACE MEANS THREE THINGS and each one is a separate test:
 *
 *   1. returned inside `[dueAt, dueAt + gracePeriod)` → NO fine at all;
 *   2. returned outside it → the fine is measured from `dueAt`, **not** from the
 *      end of grace. A 5-day-late book with 3 days' grace costs FIVE days;
 *   3. whether grace also suppresses the overdue NOTICE is a separate flag,
 *      because a library may want to warn without charging.
 *
 * (2) is the one libraries misconfigure and auditors catch. Koha measures from
 * the due date and is right to; an implementation that measures from the end of
 * grace looks correct in every test where the item comes back inside grace.
 */
export type OverdueFinePolicy = {
  readonly id: string;
  readonly name: string;
  readonly interval: Duration;
  readonly amountPerInterval: MoneyJson;
  /**
   * `intervalEnd` charges only for intervals that have completed, so being one
   * minute late is free until the first whole day passes. `intervalStart`
   * charges the moment the interval begins, so one minute late costs a day.
   */
  readonly chargeAt: 'intervalEnd' | 'intervalStart';
  readonly gracePeriod: Duration | null;
  readonly graceSuppressesNotice: boolean;
  /**
   * False is the fairness answer to a Greek library shut for three weeks in
   * August: the patron could not have returned it.
   */
  readonly countClosedDays: boolean;
  readonly maximumFine: MoneyJson | null;
  readonly minimumFine: MoneyJson | null;
  readonly capAtReplacementCost: boolean;
  readonly forgiveOn: readonly ForgiveTrigger[];
  /**
   * Suspension INSTEAD OF or as well as money.
   *
   * Continental and Greek libraries frequently suspend borrowing rather than
   * charge, and an ILS that models only cash cannot express their actual policy.
   */
  readonly suspension: {
    readonly daysPerOverdueDay: number;
    readonly maxDays: number | null;
    readonly resetOnReturn: boolean;
  } | null;
};

export type ForgiveTrigger = 'renewal' | 'claimedReturned' | 'declaredLost' | 'foundAfterLost';

export type LostItemFeePolicy = {
  readonly id: string;
  readonly name: string;
  readonly chargeBasis: 'replacementPrice' | 'itemTypeDefault' | 'fixedAmount' | 'actualCost';
  readonly fixedAmount: MoneyJson | null;
  /**
   * Structurally separate from the replacement value, which is what makes
   * "refund the book, keep the admin charge" expressible. Koha conflates them
   * and libraries write manual credits.
   */
  readonly processingFee: MoneyJson;
  readonly agedToLostAfter: Duration;
  readonly refundReplacementOnReturn: boolean;
  readonly refundProcessingFeeOnReturn: boolean;
  readonly refundWindow: Duration | null;
  readonly stopOverdueAccrualOnLost: boolean;
  readonly chargeOverdueUpToLost: boolean;
};

export type HoldPolicy = {
  readonly id: string;
  readonly name: string;
  readonly holdsAllowed: boolean;
  readonly requestTypes: readonly ('page' | 'hold' | 'recall')[];
  /**
   * The single most argued-about setting in a public library, which is why Koha
   * exposes four values for it rather than a checkbox.
   */
  readonly onShelfHolds: 'allow' | 'deny' | 'ifAnyUnavailable' | 'ifAllUnavailable';
  readonly itemLevelHolds: 'allow' | 'deny' | 'force';
  readonly maxHoldsPerRecord: number | null;
  readonly maxHoldsTotal: number | null;
  /**
   * WHY `pickupBranchId` IS A SELECTOR AT ALL. Without a hold policy that reads
   * it, the weight-1 bit in `circulation_rules.specificity` is dead.
   */
  readonly pickupPolicy:
    'any' | 'owningBranch' | 'patronHomeBranch' | 'holdingBranch' | 'explicitSet';
  readonly pickupBranchIds: readonly string[];
  readonly holdShelfExpiry: Duration;
  /**
   * A hold shelved on Friday with three days' life must not expire across a
   * closed weekend. FOLIO shipped this bug.
   */
  readonly shelfExpiryUsesCalendar: boolean;
  readonly unfilledRequestExpiry: Duration | null;
  readonly suspensionAllowed: boolean;
  readonly maxSuspension: Duration | null;
  readonly placementFee: MoneyJson | null;
  readonly notPickedUpFee: MoneyJson | null;
  readonly transitAllowed: boolean;
  readonly maxTransitDays: number | null;
};

/**
 * WHICH notice templates apply. NOT how they are sent.
 *
 * §4.4 is emphatic that producers emit intents only and the notification engine
 * owns channel resolution, quiet hours, digests and the renderer. All this type
 * carries is the set of triggers a rule selects and the template each names, so
 * that the SAME ranking function can pick a template — with a different weight
 * table, because for a notice the BRANCH outranks the category (§4.1: "branch 2,
 * category 1").
 */
export type NoticePolicy = {
  readonly id: string;
  readonly name: string;
  readonly templates: readonly NoticeTemplateBinding[];
};

export type NoticeTemplateBinding = {
  readonly id: string;
  readonly trigger: NoticeTrigger;
  readonly templateId: string;
  /** NULL = wildcard, exactly as for a circulation rule. */
  readonly branchId: string | null;
  readonly patronCategoryId: string | null;
  /** For `dueSoon`/`overdue`: how far from the due date this one fires. */
  readonly offset: Duration | null;
};

export type NoticeTrigger =
  'checkout' | 'checkin' | 'dueSoon' | 'overdue' | 'holdAvailable' | 'holdExpiring' | 'feeCharged';

/** A `fixed` loan profile's due dates: the term-end model. */
export type FixedDueDateSet = {
  readonly id: string;
  readonly name: string;
  readonly ranges: readonly FixedDueDateRange[];
};

export type FixedDueDateRange = {
  /** Inclusive. A checkout on or after this date uses `dueDate`. */
  readonly from: CivilDate;
  /** Inclusive. */
  readonly to: CivilDate;
  readonly dueDate: CivilDate;
  readonly dueTimeOfDay: TimeOfDay | null;
};

/** Ceilings that belong to a patron category rather than to one rule. */
export type PatronCategoryLimit = {
  readonly patronCategoryId: string;
  readonly maxLoans: number | null;
  readonly maxHolds: number | null;
  readonly maxOverdues: number | null;
  readonly maxFineBalance: MoneyJson | null;
};

// ---------------------------------------------------------------------------
// The snapshot, the context, the answer
// ---------------------------------------------------------------------------

/**
 * Everything the resolver may look at. One version of one library's policy.
 *
 * A VALUE, not a service. Phase 13's `PolicySnapshotService` builds it, caches
 * it process-locally, versions it by the trigger-maintained
 * `circulation_policy_version` and invalidates it over Redis pub/sub — and none
 * of that is in this package, because a function that can load its own data is a
 * function the offline Rust core cannot run.
 */
export type PolicySnapshot = {
  /** `circulation_policy_version`. Stamped into every trace, so a reproduced
   * receipt can prove which snapshot priced it. */
  readonly version: number;
  readonly rules: readonly CirculationRule[];
  readonly loanPolicies: Readonly<Record<string, LoanPolicy>>;
  readonly overdueFinePolicies: Readonly<Record<string, OverdueFinePolicy>>;
  readonly lostItemFeePolicies: Readonly<Record<string, LostItemFeePolicy>>;
  readonly holdPolicies: Readonly<Record<string, HoldPolicy>>;
  readonly noticePolicies: Readonly<Record<string, NoticePolicy>>;
  readonly fixedDueDateSets: Readonly<Record<string, FixedDueDateSet>>;
  readonly patronCategoryLimits: Readonly<Record<string, PatronCategoryLimit>>;
  readonly calendars: Readonly<Record<string, Calendar>>;
};

/** What is being circulated, to whom, where — and WHEN, explicitly. */
export type ResolveContext = {
  readonly patronCategoryId: string | null;
  readonly itemTypeId: string | null;
  readonly owningBranchId: string | null;
  readonly shelvingLocationId: string | null;
  readonly checkoutBranchId: string | null;
  readonly pickupBranchId?: string | null;
  /**
   * The instant. NEVER `Date.now()` — §4.1: "every function takes an explicit
   * instant". A resolver that reads the clock cannot be tested against a golden
   * vector, cannot be replayed to explain a historical charge, and gives two
   * answers on either side of midnight.
   */
  readonly at: Date;
};

export type CalendarRollReason =
  | 'closedDay'
  | 'closedHours'
  | 'holiday'
  | 'dstGap'
  | 'dstAmbiguous'
  | 'holdShortened'
  | 'fixedDueDate'
  | 'maxPeriodCap'
  | 'openingOffset';

/** One movement of a computed instant, and why. */
export type CalendarRoll = {
  readonly reason: CalendarRollReason;
  /** RFC 3339. */
  readonly from: string;
  /** RFC 3339. */
  readonly to: string;
  readonly detail?: string;
};

/**
 * Why this answer.
 *
 * §4.1 fixes five of these names and they are not negotiable:
 * `matchedRuleId`, `beatenRuleIds`, `selectorsUsed`, `wildcardsUsed`,
 * `calendarRolls`. `snapshotVersion` is added here — without it a reproduced
 * receipt cannot prove which snapshot priced it, and `circulation_policy_version`
 * exists precisely to be that number.
 *
 * `beatenRuleIds` is bounded to rules that MATCHED this context and lost. The
 * naive reading — every rule of lower rank — returns 499 ids from a 500-rule
 * snapshot on every checkout, and none of them is what a librarian wanted to
 * know. "Your branch rule beat the tenant default" is.
 */
export type RuleTrace = {
  readonly snapshotVersion: number;
  readonly matchedRuleId: string;
  readonly beatenRuleIds: readonly string[];
  readonly selectorsUsed: readonly SelectorName[];
  readonly wildcardsUsed: readonly SelectorName[];
  readonly calendarRolls: readonly CalendarRoll[];
};

/** The resolved policy for one circulation, frozen into `loans.policy_snapshot`. */
export type ResolvedPolicy = {
  readonly rule: CirculationRule;
  readonly loan: LoanPolicy;
  readonly overdueFine: OverdueFinePolicy;
  readonly lostItemFee: LostItemFeePolicy;
  readonly hold: HoldPolicy;
  readonly notice: NoticePolicy;
  /** From the category, when the context named one this snapshot knows. */
  readonly categoryLimit: PatronCategoryLimit | null;
  readonly trace: RuleTrace;
};

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every way this package declines to answer.
 *
 * §4.1: "**never fails open to a default policy** — a wrong loan period is a
 * wrong receipt." Each of these is a real production failure in a shipped ILS,
 * and the reason each is an ERROR rather than a fallback is that the fallback is
 * always plausible and always wrong: a resolver that defaults to 14 days turns a
 * stale snapshot into a fortnight's loan on a two-hour course reserve, and the
 * librarian finds out when the reserve shelf is empty.
 */
export const POLICY_ERROR = {
  /** No rule matched — including no wildcard rule. */
  noMatchingRule: 'NO_MATCHING_RULE',
  /** The winning rule names a policy id the snapshot does not contain. */
  policyNotInSnapshot: 'POLICY_NOT_IN_SNAPSHOT',
  /** Two rules tie on priority, specificity AND id. A duplicated row. */
  ambiguousRule: 'AMBIGUOUS_RULE',
  /** A `fixed` profile whose set has no range covering the checkout date. */
  noFixedDueDateRange: 'NO_FIXED_DUE_DATE_RANGE',
  /** The calendar's declared coverage does not reach the instant asked about. */
  calendarNotDefinedFor: 'CALENDAR_NOT_DEFINED_FOR',
  /** No open day within the search horizon. The message names the horizon. */
  calendarExhausted: 'CALENDAR_EXHAUSTED',
  /** The wall-clock time does not exist (a DST gap) and the caller said reject. */
  nonexistentLocalTime: 'NONEXISTENT_LOCAL_TIME',
  /** The wall-clock time happens twice (a DST fold) and the caller said reject. */
  ambiguousLocalTime: 'AMBIGUOUS_LOCAL_TIME',
  /** A lost-item fee based on replacement price, on an item that has none. */
  noReplacementPrice: 'NO_REPLACEMENT_PRICE',
  /** A rolling profile with no period, or a fixed one with no set. */
  policyIncomplete: 'POLICY_INCOMPLETE',
} as const;

export type PolicyErrorCode = (typeof POLICY_ERROR)[keyof typeof POLICY_ERROR];

/**
 * A refusal, with a code a caller can branch on and a sentence a librarian can
 * act on.
 *
 * `Error` rather than a result type because every one of these is a
 * configuration fault or a stale cache, never an expected outcome — and a result
 * type invites `?? fallback` at the call site, which is precisely the failing
 * open that §4.1 forbids.
 */
export class PolicyResolutionError extends Error {
  readonly code: PolicyErrorCode;
  /** Whatever identifies the thing that was missing or wrong. */
  readonly subject: string | undefined;

  constructor(code: PolicyErrorCode, message: string, subject?: string) {
    super(message);
    this.name = 'PolicyResolutionError';
    this.code = code;
    this.subject = subject;
  }
}

/** `MoneyJson` → the arithmetic type. The one place the boundary is crossed. */
export function toMoney(m: MoneyJson): Money {
  return { amount: BigInt(m.minorUnits), currency: m.currency };
}

/** The arithmetic type → what a policy and a vector file hold. */
export function toMoneyJson(m: Money): MoneyJson {
  return { minorUnits: Number(m.amount), currency: m.currency };
}
