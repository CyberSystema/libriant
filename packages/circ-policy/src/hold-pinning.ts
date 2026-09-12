import type { CalendarRoll, HoldPolicy, ResolvedPolicy } from './types.js';

/**
 * What is frozen onto a hold.
 *
 * §3: "Holds are title / volume / item level with `hold_policy_id` +
 * `policy_snapshot` pinned IDENTICALLY" — identically to loans, whose freezing
 * `apps/api/src/circulation/policy-pinning.ts` argues at length. This file is
 * the hold half, and it is a SEPARATE file rather than an extension of that one
 * for three reasons that are all in the reader:
 *
 *   - `readPinnedPolicy` takes a `loanId`, throws `PinnedSnapshotError(loanId,
 *     …)`, and every message it produces says "Loan …";
 *   - its required-key check is `['loan', 'overdueFine', 'lostItemFee']`, none
 *     of which a hold snapshot has, so it would REFUSE every hold;
 *   - and sharing `v: 1` between two incompatible shapes is exactly what that
 *     discriminator's own docblock exists to prevent.
 *
 * ## What a hold freezes, and the one thing it does NOT
 *
 * The same asymmetry `policy-pinning.ts` argues, applied to a different pair.
 *
 *   FROZEN   `hold` — the whole policy. A reader was told the rules when they
 *            asked: how long the shelf holds it, whether they may suspend, where
 *            they may collect. Re-resolving later can retroactively make their
 *            pickup branch ineligible, which is not a bug, it is a promise
 *            broken.
 *   FROZEN   `pickupBranchIds` — the resolved `explicitSet`, flattened. It comes
 *            from a SECOND table (`hold_policy_pickup_branches`) and the whole
 *            point of freezing the policy is lost if half of it is read live.
 *   FROZEN   `ruleId`, `snapshotVersion`, `timezone`, `calendarId` — which rule,
 *            from which version of the matrix, in whose civil day.
 *   LIVE     the CALENDAR body, for `policy-pinning.ts`'s reason: the policy is
 *            what the library DECIDED and the calendar is what HAPPENED.
 *
 * And ONE THING IS NEITHER: `holds.shelf_expires_at` is computed ONCE when the
 * copy is shelved and stored as a column, exactly as `loans.due_at` is. A shelf
 * expiry is a promise made to a named reader at a desk — "we will keep it until
 * Friday" — not a retrospective statement about what the library did, so
 * re-deriving it against a live calendar would let a closure entered on Tuesday
 * silently extend a shelf life the reader was told expired on Monday, and a
 * closure REMOVED would shorten one.
 */
export const HOLD_SNAPSHOT_VERSION = 1 as const;

export type PinnedHoldSnapshot = {
  readonly v: typeof HOLD_SNAPSHOT_VERSION;
  /** RFC 3339. */
  readonly resolvedAt: string;
  readonly snapshotVersion: number;
  readonly ruleId: string;
  /** The PICKUP branch — the one whose calendar the shelf expiry is computed in. */
  readonly branchId: string;
  readonly timezone: string;
  readonly calendarId: string | null;
  readonly itemTypeId: string | null;
  readonly patronCategoryId: string | null;
  readonly hold: HoldPolicy;
  /** The resolved `explicitSet`. Empty for every other pickup policy. */
  readonly pickupBranchIds: readonly string[];
  readonly rolls: readonly CalendarRoll[];
};

/** {@link pinNamedPolicy}'s hold half, for the same loader and the same reason. */
export function pinNamedHoldPolicy(input: {
  readonly snapshotVersion: number;
  readonly ruleId: string;
  readonly resolvedAt: Date;
  readonly branchId: string;
  readonly timezone: string;
  readonly calendarId: string | null;
  readonly itemTypeId: string | null;
  readonly patronCategoryId: string | null;
  readonly hold: HoldPolicy;
  readonly pickupBranchIds: readonly string[];
}): PinnedHoldSnapshot {
  return {
    v: HOLD_SNAPSHOT_VERSION,
    resolvedAt: input.resolvedAt.toISOString(),
    snapshotVersion: input.snapshotVersion,
    ruleId: input.ruleId,
    branchId: input.branchId,
    timezone: input.timezone,
    calendarId: input.calendarId,
    itemTypeId: input.itemTypeId,
    patronCategoryId: input.patronCategoryId,
    hold: input.hold,
    pickupBranchIds: input.pickupBranchIds,
    rolls: [],
  };
}

export function pinHoldPolicy(input: {
  readonly resolved: ResolvedPolicy;
  readonly resolvedAt: Date;
  readonly branchId: string;
  readonly timezone: string;
  readonly calendarId: string | null;
  readonly itemTypeId: string | null;
  readonly patronCategoryId: string | null;
  readonly pickupBranchIds: readonly string[];
  readonly rolls?: readonly CalendarRoll[];
}): PinnedHoldSnapshot {
  return {
    v: HOLD_SNAPSHOT_VERSION,
    resolvedAt: input.resolvedAt.toISOString(),
    snapshotVersion: input.resolved.trace.snapshotVersion,
    ruleId: input.resolved.trace.matchedRuleId,
    branchId: input.branchId,
    timezone: input.timezone,
    calendarId: input.calendarId,
    itemTypeId: input.itemTypeId,
    patronCategoryId: input.patronCategoryId,
    hold: input.resolved.hold,
    pickupBranchIds: input.pickupBranchIds,
    rolls: input.rolls ?? [],
  };
}

export class PinnedHoldSnapshotError extends Error {
  constructor(
    readonly holdId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PinnedHoldSnapshotError';
  }
}

/**
 * Read one back, refusing anything this code did not write.
 *
 * Loud rather than merged with defaults, for §4.1's reason: "never fails open to
 * a default policy". A hold whose snapshot has lost its `hold` policy is not a
 * hold that should be collectable anywhere for ever; it is a hold that needs a
 * human.
 */
export function readPinnedHoldPolicy(holdId: string, raw: unknown): PinnedHoldSnapshot {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PinnedHoldSnapshotError(holdId, `Hold ${holdId} has no frozen policy snapshot.`);
  }
  const snap = raw as Partial<PinnedHoldSnapshot>;
  if (snap.v !== HOLD_SNAPSHOT_VERSION) {
    throw new PinnedHoldSnapshotError(
      holdId,
      `Hold ${holdId} carries a policy snapshot of version ${String(snap.v)}; this build writes ` +
        `and reads version ${HOLD_SNAPSHOT_VERSION}.`,
    );
  }
  if (snap.hold === undefined || snap.hold === null) {
    throw new PinnedHoldSnapshotError(
      holdId,
      `Hold ${holdId}'s frozen policy snapshot has no hold policy. It cannot be routed, shelved ` +
        'or expired, and guessing a policy would put terms nobody chose in front of a reader.',
    );
  }
  return { ...snap, pickupBranchIds: snap.pickupBranchIds ?? [] } as PinnedHoldSnapshot;
}

/**
 * May this copy be collected at that branch?
 *
 * ## Why it lives here and not in `packages/circ-policy`
 *
 * `evaluateBlocks` answers it at PLACEMENT, from `CirculationState`, and emits
 * `PICKUP_BRANCH_NOT_ALLOWED`. That is the right home for the refusal a reader
 * sees. But PROMOTION asks the same question of a different subject — not "may
 * this reader ask for that branch?" but "may THIS COPY go to the branch this
 * reader already asked for?" — against a FROZEN policy rather than a live
 * resolution, and for a hold that was placed weeks ago.
 *
 * So the predicate is shared and the two callers differ. Keeping one function
 * means the answer a reader was given at placement and the answer a returned
 * copy gets at promotion cannot drift, which is the whole reason the policy is
 * frozen in the first place.
 *
 * ## `owningBranch` and `holdingBranch` are NOT the same branch
 *
 * Where a copy LIVES and where it IS. Phase 15 made them deliberately different
 * for the whole of a transit — "the copy stays at the SOURCE branch for the
 * whole open transfer" — so collapsing them, which is easy and looks harmless,
 * is silently wrong for exactly the copies this phase spends its time routing.
 *
 * ## An unknown branch is not a refusal
 *
 * `patrons.home_branch_id` is nullable, so under `patronHomeBranch` a reader who
 * never chose one would be refused EVERY branch by a comparison against
 * `undefined`. A refusal produced by an absent value is not a policy decision;
 * it returns `ok` with a stated reason instead, and the desk sees a hold it can
 * route rather than a reader it cannot serve.
 */
export type PickupVerdict = { readonly ok: boolean; readonly reason: string };

export function canCollectAt(input: {
  readonly policy: HoldPolicy;
  readonly explicitPickupBranchIds: readonly string[];
  readonly wantedBranchId: string;
  readonly itemOwningBranchId: string | null;
  readonly itemCurrentBranchId: string | null;
  readonly patronHomeBranchId: string | null;
}): PickupVerdict {
  const { policy, wantedBranchId } = input;

  switch (policy.pickupPolicy) {
    case 'any':
      break;
    case 'owningBranch':
      if (input.itemOwningBranchId === null) {
        return {
          ok: true,
          reason: 'No copy is assigned yet, so there is no owning branch to test.',
        };
      }
      if (input.itemOwningBranchId !== wantedBranchId) {
        return { ok: false, reason: 'This copy may only be collected at the branch that owns it.' };
      }
      break;
    case 'holdingBranch':
      if (input.itemCurrentBranchId === null) {
        return {
          ok: true,
          reason: 'No copy is assigned yet, so there is nowhere it currently is.',
        };
      }
      if (input.itemCurrentBranchId !== wantedBranchId) {
        return { ok: false, reason: 'This copy may only be collected where it currently is.' };
      }
      break;
    case 'patronHomeBranch':
      if (input.patronHomeBranchId === null) {
        // See the docblock. A reader with no home branch is not a reader who may
        // collect nowhere.
        return {
          ok: true,
          reason: 'This reader has no home branch recorded, so none is enforced.',
        };
      }
      if (input.patronHomeBranchId !== wantedBranchId) {
        return { ok: false, reason: 'This reader may only collect at their home branch.' };
      }
      break;
    case 'explicitSet':
      if (input.explicitPickupBranchIds.length === 0) {
        // The phase-13 loader treats an empty set under `explicitSet` as a
        // VALIDATION FAILURE rather than "no pickup branches", "which would
        // silently make every hold uncollectable". A snapshot frozen before that
        // check existed could still carry one, so refuse loudly here too.
        return {
          ok: false,
          reason:
            'The pickup policy names an explicit set of branches and the set is empty, so no ' +
            'branch can be collected at. Fix the hold policy.',
        };
      }
      if (!input.explicitPickupBranchIds.includes(wantedBranchId)) {
        return { ok: false, reason: 'That branch is not in this policy’s pickup list.' };
      }
      break;
  }

  // The copy has to be able to GET there. `transitAllowed: false` is a library
  // that does not run a van, and a hold it can never fill is worse than a hold
  // it refuses — this is the "ineligible pickup branch" of the phase's own
  // acceptance criterion.
  if (
    !policy.transitAllowed &&
    input.itemCurrentBranchId !== null &&
    input.itemCurrentBranchId !== wantedBranchId
  ) {
    return {
      ok: false,
      reason:
        'This copy is at another branch and this policy does not move copies between branches.',
    };
  }

  return { ok: true, reason: 'Collectable.' };
}
