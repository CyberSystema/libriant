import {
  POLICY_ERROR,
  PolicyResolutionError,
  type Calendar,
  type CalendarException,
  type CirculationRule,
  type CivilDate,
  type DayHours,
  type Duration,
  type DurationUnit,
  type FixedDueDateSet,
  type HoldPolicy,
  type LoanPolicy,
  type LostItemFeePolicy,
  type MoneyJson,
  type NoticePolicy,
  type NoticeTemplateBinding,
  type OpeningInterval,
  type OverdueFinePolicy,
  type PatronCategoryLimit,
  type PolicySnapshot,
  type TimeOfDay,
} from '@libriant/circ-policy';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';

/**
 * Fifteen tables in, one `PolicySnapshot` out.
 *
 * `packages/circ-policy/src/types.ts` is the column spec the schema was written
 * from, so this file is mostly a transcription — and the parts that are NOT a
 * transcription are the three below, each of which is a decision the database
 * could not make for us.
 *
 * ## Every read happens in ONE transaction, at REPEATABLE READ
 *
 * Not for isolation from writers — policy writes are a librarian in an admin
 * screen and are rare — but because a snapshot assembled from ten statements at
 * READ COMMITTED can straddle a commit. Concretely: statement 3 reads
 * `circulation_rules` and sees a rule naming loan policy X; the librarian's
 * transaction commits between statements 3 and 4, deleting X; statement 4 reads
 * `loan_policies` without it. The snapshot is then internally inconsistent, the
 * validator below rejects it, and the pod refuses to lend — over a policy edit
 * that was perfectly ordinary. One MVCC snapshot makes that unreachable.
 *
 * ## The version is read INSIDE the same transaction, first
 *
 * If it were read outside, the number would describe a different instant from
 * the rows, and `RuleTrace.snapshotVersion` — which exists so a reproduced
 * receipt can prove which snapshot priced it — would be a lie in exactly the
 * case it matters.
 *
 * ## `calendars` is keyed by BRANCH id, not by calendar id
 *
 * `Calendar` carries a `timezone` and `calendars` has no timezone column: the
 * zone belongs to the branch (`branches.timezone`, the `circ-5` fix), and one
 * calendar legitimately serves several branches. So a `Calendar` VALUE is only
 * meaningful once a branch has supplied the zone, and keying the map by branch
 * is the only way `computeDueDate` can be handed one. A calendar shared by two
 * branches in different zones appears twice, with different zones, which is not
 * duplication but the two different answers it genuinely is.
 */

/** What `build()` needs, and nothing else. Keeps the service testable. */
export type SnapshotSource = Pick<
  TxV2,
  | 'circulationPolicyVersion'
  | 'circulationSetting'
  | 'circulationRule'
  | 'loanPolicy'
  | 'overdueFinePolicy'
  | 'lostItemFeePolicy'
  | 'holdPolicy'
  | 'noticePolicy'
  | 'fixedDueDateSet'
  | 'patronCategoryLimit'
  | 'calendar'
  | 'branch'
>;

/**
 * The snapshot plus the two things that travel with it but are not the
 * resolver's business.
 */
export type LoadedSnapshot = {
  readonly snapshot: PolicySnapshot;
  /** §8 risk 6's switch. Gates the WRITE surface and which UI renders. */
  readonly circulationRulesEnabled: boolean;
  /** branchId → the calendar id it uses, for `/circulation/explain`. */
  readonly branchCalendars: Readonly<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Column pairs → value types
// ---------------------------------------------------------------------------

/**
 * A `Duration`, or null.
 *
 * The database CHECK guarantees the pair is all-or-nothing, so a half-set pair
 * is unreachable — and this still throws rather than coercing, because "the
 * constraint cannot be violated" is a claim about the database this process is
 * connected to, and a snapshot built against a database that has drifted is
 * exactly when a silent `unit ?? 'days'` prices a two-hour reserve as a
 * fortnight.
 */
function duration(value: number | null, unit: string | null, where: string): Duration | null {
  if (value === null && unit === null) return null;
  if (value === null || unit === null) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyIncomplete,
      `${where} has a duration value without its unit (or the reverse). The ` +
        'all-or-nothing CHECK on that column pair should make this unreachable, so the ' +
        'database schema has drifted from the migrations.',
    );
  }
  return { value, unit: unit as DurationUnit };
}

function money(cents: bigint | null, currency: string): MoneyJson | null {
  if (cents === null) return null;
  return { minorUnits: Number(cents), currency };
}

function requiredMoney(cents: bigint, currency: string): MoneyJson {
  return { minorUnits: Number(cents), currency };
}

/** Minutes from local midnight → `{hour, minute}`. */
function timeOfDay(min: number | null): TimeOfDay | null {
  if (min === null) return null;
  return { hour: Math.floor(min / 60), minute: min % 60 };
}

/**
 * A Postgres `date` → `CivilDate`.
 *
 * `@db.Date` arrives as a `Date` at UTC midnight, so `getUTCFullYear()` is the
 * civil date that was stored and `getFullYear()` is that date shifted into the
 * process's own zone — which for a pod running west of Greenwich is the day
 * before. This is the one line in the file where using the wrong getter moves a
 * term-end due date by a day, silently, on some pods and not others.
 */
function civilDate(d: Date): CivilDate {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const interval = (r: { openMin: number; closeMin: number }): OpeningInterval => ({
  open: r.openMin,
  close: r.closeMin,
});

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

export async function loadPolicySnapshot(tx: SnapshotSource): Promise<LoadedSnapshot> {
  const versionRow = await tx.circulationPolicyVersion.findUnique({ where: { id: 1 } });
  if (versionRow === null) {
    // Deliberately NOT "treat a missing counter as version 0". Zero never
    // changes, so a library whose counter row was gone would run for ever on a
    // snapshot no bump could invalidate, on every pod, and nobody would find
    // out. `PermissionsService` makes the same call for a missing seeded role:
    // "silently falling back to the shipped template would mean a library whose
    // roles table is broken behaves as though it is not."
    throw new PolicyResolutionError(
      POLICY_ERROR.policyIncomplete,
      'lbr2.circulation_policy_version holds no row. That counter is what tells every ' +
        'process a policy changed, so without it a cached snapshot could never be ' +
        'invalidated. Re-run the phase-13 migration against this library.',
    );
  }

  const [
    settings,
    rules,
    loanPolicies,
    overdueFinePolicies,
    lostItemFeePolicies,
    holdPolicies,
    noticePolicies,
    fixedDueDateSets,
    categoryLimits,
    calendars,
    branches,
  ] = await Promise.all([
    tx.circulationSetting.findUnique({ where: { id: 1 } }),
    tx.circulationRule.findMany({ where: { enabled: true } }),
    tx.loanPolicy.findMany({ where: { archivedAt: null } }),
    tx.overdueFinePolicy.findMany({ where: { archivedAt: null } }),
    tx.lostItemFeePolicy.findMany({ where: { archivedAt: null } }),
    tx.holdPolicy.findMany({ where: { archivedAt: null }, include: { pickupBranches: true } }),
    tx.noticePolicy.findMany({ where: { archivedAt: null }, include: { templates: true } }),
    tx.fixedDueDateSet.findMany({ where: { archivedAt: null }, include: { ranges: true } }),
    tx.patronCategoryLimit.findMany(),
    tx.calendar.findMany({
      where: { archivedAt: null },
      include: { hours: true, exceptions: { include: { hours: true } } },
    }),
    tx.branch.findMany({
      where: { archivedAt: null, calendarId: { not: null } },
      select: { id: true, timezone: true, calendarId: true },
    }),
  ]);

  // NO `orderBy` ON THE RULES, and that is a decision rather than an omission.
  // `resolve.ts` re-sorts with `compareRank`, a TOTAL order on distinct ids, so
  // the winner does not depend on the array order at all — and Postgres cannot
  // reproduce that order anyway. Measured on the three collations this code
  // meets: production tenants are ICU `el-GR` (the compose file's initdb args),
  // this machine's dev cluster is libc `en_US.UTF-8`, and `compareRank` is
  // UTF-16 code units, and the three disagree with each other. `r_default`
  // sorts before `r-default` under ICU and libc and after it under C;
  // `CKV1A2B3C` sorts first under C and mid-list under both others. Prisma
  // cannot express `COLLATE` in any case — `SortOrder` is `{asc, desc}` — so
  // ordering here would mean hand-writing `lbr2.`-qualified raw SQL to buy an
  // order nothing reads. Where SQL order DOES reach a human — the matrix
  // listing, `/circulation/explain`'s neighbours — the query says
  // `id COLLATE "C"` and `circulation_rules_listing_idx` serves it.

  const calendarById = new Map(calendars.map((c) => [c.id, c]));
  const branchCalendars: Record<string, string> = {};
  const snapshotCalendars: Record<string, Calendar> = {};

  for (const branch of branches) {
    const row = branch.calendarId === null ? undefined : calendarById.get(branch.calendarId);
    if (row === undefined) continue;
    branchCalendars[branch.id] = row.id;

    const weekly: DayHours[] = [];
    for (let wd = 0; wd < 7; wd += 1) {
      weekly.push({
        weekday: wd as DayHours['weekday'],
        intervals: row.hours
          .filter((h) => h.weekday === wd)
          .sort((a, b) => a.openMin - b.openMin)
          .map(interval),
      });
    }

    const exceptions: CalendarException[] = row.exceptions.map((e) => ({
      date: civilDate(e.date),
      intervals: [...e.hours].sort((a, b) => a.openMin - b.openMin).map(interval),
      name: e.name,
    }));

    snapshotCalendars[branch.id] = {
      id: row.id,
      timezone: branch.timezone,
      weekly,
      exceptions,
      definedFrom: civilDate(row.definedFrom),
      definedTo: civilDate(row.definedTo),
    };
  }

  const snapshot: PolicySnapshot = {
    version: versionRow.version,
    rules: rules.map((r): CirculationRule => ({
      id: r.id,
      name: r.name,
      patronCategoryId: r.patronCategoryId,
      itemTypeId: r.itemTypeId,
      owningBranchId: r.owningBranchId,
      shelvingLocationId: r.shelvingLocationId,
      checkoutBranchId: r.checkoutBranchId,
      pickupBranchId: r.pickupBranchId,
      loanPolicyId: r.loanPolicyId,
      overdueFinePolicyId: r.overdueFinePolicyId,
      lostItemFeePolicyId: r.lostItemFeePolicyId,
      holdPolicyId: r.holdPolicyId,
      noticePolicyId: r.noticePolicyId,
      maxLoansForRule: r.maxLoansForRule,
      maxHoldsForRule: r.maxHoldsForRule,
      ageRestrictionMinYears: r.ageRestrictionMinYears,
      priority: r.priority,
      enabled: r.enabled,
      // RFC 3339 strings, not `Date`s: `CirculationRule` is frozen verbatim
      // into `loans.policy_snapshot jsonb`, and a `Date` there would serialise
      // one way and parse back as a string.
      effectiveFrom: r.effectiveFrom === null ? null : r.effectiveFrom.toISOString(),
      effectiveTo: r.effectiveTo === null ? null : r.effectiveTo.toISOString(),
    })),
    loanPolicies: byId(
      loanPolicies.map((p): LoanPolicy => ({
        id: p.id,
        name: p.name,
        loanable: p.loanable,
        profile: p.profile,
        period: duration(p.periodValue, p.periodUnit, `loan policy ${p.id} period`),
        fixedDueDateSetId: p.fixedDueDateSetId,
        dueTimeOfDay: timeOfDay(p.dueTimeOfDayMin),
        closedDayHandling: p.closedDayHandling,
        openingTimeOffset: duration(
          p.openingTimeOffsetValue,
          p.openingTimeOffsetUnit,
          `loan policy ${p.id} openingTimeOffset`,
        ),
        maxPeriod: duration(p.maxPeriodValue, p.maxPeriodUnit, `loan policy ${p.id} maxPeriod`),
        renewable: p.renewable,
        renewalsAllowed: p.renewalsAllowed,
        renewalPeriod: duration(
          p.renewalPeriodValue,
          p.renewalPeriodUnit,
          `loan policy ${p.id} renewalPeriod`,
        ),
        renewFrom: p.renewFrom,
        noRenewalBefore: duration(
          p.noRenewalBeforeValue,
          p.noRenewalBeforeUnit,
          `loan policy ${p.id} noRenewalBefore`,
        ),
        noRenewalBeforeRelativeTo: p.noRenewalBeforeRelativeTo,
        renewWithOutstandingHolds: p.renewWithOutstandingHolds,
        alternateCheckoutPeriodWithHolds: duration(
          p.altCheckoutPeriodWithHoldsValue,
          p.altCheckoutPeriodWithHoldsUnit,
          `loan policy ${p.id} alternateCheckoutPeriodWithHolds`,
        ),
        alternateRenewalPeriodWithHolds: duration(
          p.altRenewalPeriodWithHoldsValue,
          p.altRenewalPeriodWithHoldsUnit,
          `loan policy ${p.id} alternateRenewalPeriodWithHolds`,
        ),
        itemLimitForPolicy: p.itemLimitForPolicy,
      })),
    ),
    overdueFinePolicies: byId(
      overdueFinePolicies.map((p): OverdueFinePolicy => ({
        id: p.id,
        name: p.name,
        interval: { value: p.intervalValue, unit: p.intervalUnit },
        amountPerInterval: requiredMoney(p.amountPerIntervalCents, p.currency),
        chargeAt: p.chargeAt,
        gracePeriod: duration(
          p.gracePeriodValue,
          p.gracePeriodUnit,
          `fine policy ${p.id} gracePeriod`,
        ),
        graceSuppressesNotice: p.graceSuppressesNotice,
        countClosedDays: p.countClosedDays,
        maximumFine: money(p.maximumFineCents, p.currency),
        minimumFine: money(p.minimumFineCents, p.currency),
        capAtReplacementCost: p.capAtReplacementCost,
        forgiveOn: p.forgiveOn,
        suspension:
          p.suspensionDaysPerOverdueDay === null || p.suspensionResetOnReturn === null
            ? null
            : {
                daysPerOverdueDay: p.suspensionDaysPerOverdueDay,
                maxDays: p.suspensionMaxDays,
                resetOnReturn: p.suspensionResetOnReturn,
              },
      })),
    ),
    lostItemFeePolicies: byId(
      lostItemFeePolicies.map((p): LostItemFeePolicy => ({
        id: p.id,
        name: p.name,
        chargeBasis: p.chargeBasis,
        fixedAmount: money(p.fixedAmountCents, p.currency),
        processingFee: requiredMoney(p.processingFeeCents, p.currency),
        agedToLostAfter: { value: p.agedToLostAfterValue, unit: p.agedToLostAfterUnit },
        refundReplacementOnReturn: p.refundReplacementOnReturn,
        refundProcessingFeeOnReturn: p.refundProcessingFeeOnReturn,
        refundWindow: duration(
          p.refundWindowValue,
          p.refundWindowUnit,
          `lost item policy ${p.id} refundWindow`,
        ),
        stopOverdueAccrualOnLost: p.stopOverdueAccrualOnLost,
        chargeOverdueUpToLost: p.chargeOverdueUpToLost,
      })),
    ),
    holdPolicies: byId(
      holdPolicies.map((p): HoldPolicy => ({
        id: p.id,
        name: p.name,
        holdsAllowed: p.holdsAllowed,
        requestTypes: p.requestTypes,
        onShelfHolds: p.onShelfHolds,
        itemLevelHolds: p.itemLevelHolds,
        maxHoldsPerRecord: p.maxHoldsPerRecord,
        maxHoldsTotal: p.maxHoldsTotal,
        pickupPolicy: p.pickupPolicy,
        pickupBranchIds: [...p.pickupBranches]
          .map((b) => b.branchId)
          // Sorted so the snapshot is byte-stable across rebuilds: this array
          // lands in `loans.policy_snapshot`, and a receipt reprinted from a
          // different pod must be the same bytes.
          .sort(),
        holdShelfExpiry: { value: p.holdShelfExpiryValue, unit: p.holdShelfExpiryUnit },
        shelfExpiryUsesCalendar: p.shelfExpiryUsesCalendar,
        unfilledRequestExpiry: duration(
          p.unfilledRequestExpiryValue,
          p.unfilledRequestExpiryUnit,
          `hold policy ${p.id} unfilledRequestExpiry`,
        ),
        suspensionAllowed: p.suspensionAllowed,
        maxSuspension: duration(
          p.maxSuspensionValue,
          p.maxSuspensionUnit,
          `hold policy ${p.id} maxSuspension`,
        ),
        placementFee: money(p.placementFeeCents, p.currency),
        notPickedUpFee: money(p.notPickedUpFeeCents, p.currency),
        transitAllowed: p.transitAllowed,
        maxTransitDays: p.maxTransitDays,
      })),
    ),
    noticePolicies: byId(
      noticePolicies.map((p): NoticePolicy => ({
        id: p.id,
        name: p.name,
        templates: p.templates.map((t): NoticeTemplateBinding => ({
          id: t.id,
          trigger: t.trigger,
          templateId: t.templateId,
          branchId: t.branchId,
          patronCategoryId: t.patronCategoryId,
          offset: duration(t.offsetValue, t.offsetUnit, `notice binding ${t.id} offset`),
        })),
      })),
    ),
    fixedDueDateSets: byId(
      fixedDueDateSets.map((s): FixedDueDateSet => ({
        id: s.id,
        name: s.name,
        ranges: [...s.ranges]
          .sort((a, b) => a.from.getTime() - b.from.getTime())
          .map((r) => ({
            from: civilDate(r.from),
            to: civilDate(r.to),
            dueDate: civilDate(r.dueDate),
            dueTimeOfDay: timeOfDay(r.dueTimeOfDayMin),
          })),
      })),
    ),
    patronCategoryLimits: Object.fromEntries(
      categoryLimits.map((l): [string, PatronCategoryLimit] => [
        l.patronCategoryId,
        {
          patronCategoryId: l.patronCategoryId,
          maxLoans: l.maxLoans,
          maxHolds: l.maxHolds,
          maxOverdues: l.maxOverdues,
          maxFineBalance: money(l.maxFineBalanceCents, l.currency),
        },
      ]),
    ),
    calendars: snapshotCalendars,
  };

  return {
    snapshot,
    // A missing settings row is NOT a refusal: the row is created by the
    // migration, and its absence means an older tenant, for which "the matrix is
    // off" is both the safe answer and the default the column carries.
    circulationRulesEnabled: settings?.circulationRulesEnabled ?? false,
    branchCalendars,
  };
}

function byId<T extends { id: string }>(rows: readonly T[]): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A snapshot that would refuse at the desk is refused HERE instead.
 *
 * `resolve.ts` already raises `POLICY_NOT_IN_SNAPSHOT` when a winning rule names
 * a policy the snapshot lacks — but it raises it PER MATCHING CONTEXT. A broken
 * rule that only matches "children at the Kifisiá branch" gives a working desk
 * for a week and then one refusal, at the counter, to one patron, on a Saturday.
 * Validating at build turns that into an immediate, tenant-wide, alertable
 * failure with the rule's name in it, and the previous good snapshot keeps being
 * served in the meantime.
 *
 * This does NOT weaken the resolver's own check, which stays: the offline Rust
 * core and `fixtures/resolution-vectors.json` depend on it, and a snapshot also
 * arrives by replay out of `loans.policy_snapshot`.
 */
export function validateSnapshot(snapshot: PolicySnapshot): void {
  const missing: string[] = [];
  const need = (
    table: Readonly<Record<string, unknown>>,
    id: string,
    what: string,
    rule: CirculationRule,
  ) => {
    if (table[id] === undefined) missing.push(`rule "${rule.name}" (${rule.id}) → ${what} ${id}`);
  };

  for (const rule of snapshot.rules) {
    need(snapshot.loanPolicies, rule.loanPolicyId, 'loan policy', rule);
    need(snapshot.overdueFinePolicies, rule.overdueFinePolicyId, 'overdue fine policy', rule);
    need(snapshot.lostItemFeePolicies, rule.lostItemFeePolicyId, 'lost item fee policy', rule);
    need(snapshot.holdPolicies, rule.holdPolicyId, 'hold policy', rule);
    need(snapshot.noticePolicies, rule.noticePolicyId, 'notice policy', rule);
  }

  for (const policy of Object.values(snapshot.loanPolicies) as LoanPolicy[]) {
    if (policy.profile !== 'fixed') continue;
    const setId = policy.fixedDueDateSetId;
    if (setId === null || snapshot.fixedDueDateSets[setId] === undefined) {
      missing.push(`loan policy "${policy.name}" (${policy.id}) → fixed due date set ${setId}`);
    }
  }

  // An `explicitSet` hold policy with no branches allows collection NOWHERE, and
  // it reads as "no restriction" to anyone skimming the row.
  for (const policy of Object.values(snapshot.holdPolicies) as HoldPolicy[]) {
    if (policy.pickupPolicy === 'explicitSet' && policy.pickupBranchIds.length === 0) {
      missing.push(
        `hold policy "${policy.name}" (${policy.id}) → pickupPolicy is explicitSet with no branches`,
      );
    }
  }

  if (missing.length > 0) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyNotInSnapshot,
      `Policy snapshot version ${snapshot.version} is internally inconsistent and was not ` +
        `served. ${missing.length} dangling reference(s): ${missing.slice(0, 5).join('; ')}` +
        (missing.length > 5 ? `; and ${missing.length - 5} more.` : '.'),
    );
  }
}
