import { POLICY_ERROR, PolicyResolutionError } from './types.js';
import type {
  Duration,
  DurationUnit,
  HoldPolicy,
  LoanPolicy,
  LostItemFeePolicy,
  MoneyJson,
  OverdueFinePolicy,
  TimeOfDay,
} from './types.js';

/**
 * A policy ROW becomes a policy OBJECT here, and nowhere else (2.0 phase 20e).
 *
 * ## Why this is in the package and not beside the reader
 *
 * These four functions used to live inside `policy-snapshot.loader.ts` in the
 * API, which is the only thing that had ever needed them: the desk reads the
 * matrix through Prisma and projects it on the way past. Then the v1→v2 upgrade
 * turned out to need the same projection and could not have it — `scripts/`
 * never imports from `apps/api`, deliberately — and what it did instead is the
 * defect this file exists to make unrepeatable.
 *
 * 19b froze `{migratedFrom: '1.0', loanPeriodDays, maxRenewals, finePerDayCents,
 * currency}` onto every migrated loan and hold. `readPinnedPolicy` requires
 * `v: 1` plus `loan`, `overdueFine`, `lostItemFee` and a non-empty `timezone`,
 * and that object has none of the five — so every migrated loan threw
 * `PinnedSnapshotError` on its detail screen, on renew, on checkin, and was
 * skipped by the overdue sweep, while the upgrade's own verifier passed because
 * E04 only asserted the column was not `'{}'`. The error message had written the
 * requirement down in advance: "A migration owes it a shape it understands."
 *
 * So the projection belongs to whoever owns the policy TYPES, which §4.1 says is
 * this package. A loader and a bulk migration that both call the same function
 * cannot disagree about what a loan policy is; two implementations of it always
 * eventually do.
 *
 * ## The rows are typed structurally, on purpose
 *
 * Each parameter names the columns it reads and nothing else. `@libriant/circ-policy`
 * is "pure, synchronous, zero-dependency" (§4.1) and must not import Prisma's
 * generated types to say what a row is — and the structural form is also what
 * lets the upgrade pass rows it read its own way.
 */

/** A duration column PAIR. Both or neither; a CHECK says so in the database. */
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

/** The columns projectLoanPolicy reads. */
export type RowLoanPolicy = {
  readonly altCheckoutPeriodWithHoldsUnit: string | null;
  readonly altCheckoutPeriodWithHoldsValue: number | null;
  readonly altRenewalPeriodWithHoldsUnit: string | null;
  readonly altRenewalPeriodWithHoldsValue: number | null;
  readonly closedDayHandling: LoanPolicy['closedDayHandling'];
  readonly dueTimeOfDayMin: number | null;
  readonly fixedDueDateSetId: LoanPolicy['fixedDueDateSetId'];
  readonly id: LoanPolicy['id'];
  readonly itemLimitForPolicy: LoanPolicy['itemLimitForPolicy'];
  readonly loanable: LoanPolicy['loanable'];
  readonly maxPeriodUnit: string | null;
  readonly maxPeriodValue: number | null;
  readonly name: LoanPolicy['name'];
  readonly noRenewalBeforeRelativeTo: LoanPolicy['noRenewalBeforeRelativeTo'];
  readonly noRenewalBeforeUnit: string | null;
  readonly noRenewalBeforeValue: number | null;
  readonly openingTimeOffsetUnit: string | null;
  readonly openingTimeOffsetValue: number | null;
  readonly periodUnit: string | null;
  readonly periodValue: number | null;
  readonly profile: LoanPolicy['profile'];
  readonly renewFrom: LoanPolicy['renewFrom'];
  readonly renewWithOutstandingHolds: LoanPolicy['renewWithOutstandingHolds'];
  readonly renewable: LoanPolicy['renewable'];
  readonly renewalPeriodUnit: string | null;
  readonly renewalPeriodValue: number | null;
  readonly renewalsAllowed: LoanPolicy['renewalsAllowed'];
};

/** The columns projectOverdueFinePolicy reads. */
export type RowOverdueFinePolicy = {
  readonly amountPerIntervalCents: bigint;
  readonly capAtReplacementCost: OverdueFinePolicy['capAtReplacementCost'];
  readonly chargeAt: OverdueFinePolicy['chargeAt'];
  readonly countClosedDays: OverdueFinePolicy['countClosedDays'];
  readonly currency: string;
  readonly forgiveOn: OverdueFinePolicy['forgiveOn'];
  readonly gracePeriodUnit: string | null;
  readonly gracePeriodValue: number | null;
  readonly graceSuppressesNotice: OverdueFinePolicy['graceSuppressesNotice'];
  readonly id: OverdueFinePolicy['id'];
  readonly intervalUnit: OverdueFinePolicy['interval']['unit'];
  readonly intervalValue: OverdueFinePolicy['interval']['value'];
  readonly maximumFineCents: bigint | null;
  readonly minimumFineCents: bigint | null;
  readonly name: OverdueFinePolicy['name'];
  readonly suspensionDaysPerOverdueDay: number | null;
  readonly suspensionMaxDays: number | null;
  readonly suspensionResetOnReturn: boolean | null;
};

/** The columns projectLostItemFeePolicy reads. */
export type RowLostItemFeePolicy = {
  readonly agedToLostAfterUnit: LostItemFeePolicy['agedToLostAfter']['unit'];
  readonly agedToLostAfterValue: LostItemFeePolicy['agedToLostAfter']['value'];
  readonly chargeBasis: LostItemFeePolicy['chargeBasis'];
  readonly chargeOverdueUpToLost: LostItemFeePolicy['chargeOverdueUpToLost'];
  readonly currency: string;
  readonly fixedAmountCents: bigint | null;
  readonly id: LostItemFeePolicy['id'];
  readonly name: LostItemFeePolicy['name'];
  readonly processingFeeCents: bigint;
  readonly refundProcessingFeeOnReturn: LostItemFeePolicy['refundProcessingFeeOnReturn'];
  readonly refundReplacementOnReturn: LostItemFeePolicy['refundReplacementOnReturn'];
  readonly refundWindowUnit: string | null;
  readonly refundWindowValue: number | null;
  readonly stopOverdueAccrualOnLost: LostItemFeePolicy['stopOverdueAccrualOnLost'];
};

/** The columns projectHoldPolicy reads. */
export type RowHoldPolicy = {
  readonly currency: string;
  readonly holdShelfExpiryUnit: HoldPolicy['holdShelfExpiry']['unit'];
  readonly holdShelfExpiryValue: HoldPolicy['holdShelfExpiry']['value'];
  readonly holdsAllowed: HoldPolicy['holdsAllowed'];
  readonly id: HoldPolicy['id'];
  readonly itemLevelHolds: HoldPolicy['itemLevelHolds'];
  readonly maxHoldsPerRecord: HoldPolicy['maxHoldsPerRecord'];
  readonly maxHoldsTotal: HoldPolicy['maxHoldsTotal'];
  readonly maxSuspensionUnit: string | null;
  readonly maxSuspensionValue: number | null;
  readonly maxTransitDays: HoldPolicy['maxTransitDays'];
  readonly name: HoldPolicy['name'];
  readonly notPickedUpFeeCents: bigint | null;
  readonly onShelfHolds: HoldPolicy['onShelfHolds'];
  readonly pickupBranches: readonly { readonly branchId: string }[];
  readonly pickupPolicy: HoldPolicy['pickupPolicy'];
  readonly placementFeeCents: bigint | null;
  readonly requestTypes: HoldPolicy['requestTypes'];
  readonly shelfExpiryUsesCalendar: HoldPolicy['shelfExpiryUsesCalendar'];
  readonly suspensionAllowed: HoldPolicy['suspensionAllowed'];
  readonly transitAllowed: HoldPolicy['transitAllowed'];
  readonly unfilledRequestExpiryUnit: string | null;
  readonly unfilledRequestExpiryValue: number | null;
};

export function projectLoanPolicy(p: RowLoanPolicy): LoanPolicy {
  return {
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
  };
}

export function projectOverdueFinePolicy(p: RowOverdueFinePolicy): OverdueFinePolicy {
  return {
    id: p.id,
    name: p.name,
    interval: { value: p.intervalValue, unit: p.intervalUnit },
    amountPerInterval: requiredMoney(p.amountPerIntervalCents, p.currency),
    chargeAt: p.chargeAt,
    gracePeriod: duration(p.gracePeriodValue, p.gracePeriodUnit, `fine policy ${p.id} gracePeriod`),
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
  };
}

export function projectLostItemFeePolicy(p: RowLostItemFeePolicy): LostItemFeePolicy {
  return {
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
  };
}

export function projectHoldPolicy(p: RowHoldPolicy): HoldPolicy {
  return {
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
  };
}
