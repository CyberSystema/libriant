/**
 * How one sum of money is spread across several charges (2.0 phase 18).
 *
 * ## Sequential exhaustion, and why not a pro-rata split
 *
 * A reader owes EUR 2.40 on three books and hands over EUR 5. The money is
 * applied to the oldest charge until it is settled, then to the next, and what
 * is left over becomes a credit. It is not divided proportionally.
 *
 * `@libriant/shared/money` has `allocate`, which divides a sum by weights to the
 * cent with no residue, and it is deliberately NOT used here. Pro-rata is the
 * right primitive for splitting one payment across funds that all must move
 * together — a consortium settlement, phase 95 — and the wrong one for a desk:
 * a patron who pays EUR 1 against three fines expects one of them to be gone,
 * not three of them to be a third paid. Sequential exhaustion is also EXACT by
 * construction, because every step is `min(remaining, owed)` on integers, so
 * there is no residue to lose and nothing for a rounding rule to decide.
 *
 * ## The order is the oldest first, and it is not configurable
 *
 * A librarian who wants to settle a particular charge names it; the default is
 * the order the debts were incurred, which is what a reader means by "pay off my
 * fines". Making it configurable would make every support conversation start by
 * asking what the setting is.
 */

/** What is owed on one charge, in the order it should be settled. */
export type SettleTarget = {
  readonly feeId: string;
  /** `fees.owed_cents` — the generated column, never a recomputation. */
  readonly owedCents: bigint;
};

export type Allocation = {
  readonly feeId: string;
  readonly amountCents: bigint;
};

export type SettlementPlan = {
  readonly allocations: readonly Allocation[];
  /** Applied to charges. */
  readonly appliedCents: bigint;
  /** What is left when every named charge is settled. Becomes `patron_credit`. */
  readonly unappliedCents: bigint;
};

/**
 * Spread `amountCents` over `targets`, oldest first.
 *
 * Total by construction: `appliedCents + unappliedCents === amountCents`, and
 * every allocation is positive. A target that is already settled contributes
 * nothing rather than a zero allocation, because `fee_allocations_not_zero`
 * refuses a zero row — an allocation that moved nothing is a claim to have
 * touched a fee that was not touched.
 */
export function planSettlement(
  amountCents: bigint,
  targets: readonly SettleTarget[],
): SettlementPlan {
  if (amountCents <= 0n) {
    throw new RangeError(`A settlement must move money; got ${amountCents}.`);
  }
  const allocations: Allocation[] = [];
  let remaining = amountCents;
  for (const target of targets) {
    if (remaining === 0n) break;
    if (target.owedCents <= 0n) continue;
    const take = target.owedCents < remaining ? target.owedCents : remaining;
    allocations.push({ feeId: target.feeId, amountCents: take });
    remaining -= take;
  }
  return {
    allocations,
    appliedCents: amountCents - remaining,
    unappliedCents: remaining,
  };
}

/**
 * The mirror: give money back, newest settlement first.
 *
 * A refund can never exceed what was paid, and the caller passes what each fee
 * has actually received (`fees.paid_cents`), not what it was charged. Refunding
 * against `amount_cents` is how a library refunds money it never took.
 */
export function planRefund(
  amountCents: bigint,
  targets: readonly { readonly feeId: string; readonly paidCents: bigint }[],
): SettlementPlan {
  if (amountCents <= 0n) {
    throw new RangeError(`A refund must move money; got ${amountCents}.`);
  }
  const refundable = targets.reduce((sum, t) => sum + (t.paidCents > 0n ? t.paidCents : 0n), 0n);
  if (amountCents > refundable) {
    throw new RangeError(
      `Cannot refund ${amountCents}: only ${refundable} has been paid against these charges.`,
    );
  }
  const allocations: Allocation[] = [];
  let remaining = amountCents;
  for (const target of [...targets].reverse()) {
    if (remaining === 0n) break;
    if (target.paidCents <= 0n) continue;
    const take = target.paidCents < remaining ? target.paidCents : remaining;
    // NEGATIVE. A refund is a payment allocation that goes the other way, so
    // `paid_cents` stays one sum that moves up and down rather than becoming a
    // fourth counter nothing reconciles against.
    allocations.push({ feeId: target.feeId, amountCents: -take });
    remaining -= take;
  }
  return { allocations, appliedCents: amountCents, unappliedCents: 0n };
}
