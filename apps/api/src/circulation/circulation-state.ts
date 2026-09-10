import { zonedCivil, type CirculationState } from '@libriant/circ-policy';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import { ageBandAt } from './age-band.js';

/**
 * What `evaluateBlocks` needs counted, in ONE statement.
 *
 * `packages/circ-policy` is pure and makes no query — its `CirculationState` is
 * "what the CALLER counted", every field optional, with the rule that an absent
 * count is "not checked" and never "zero". `index.ts` assigns the counting to
 * this phase by name: "counting a patron's loans, reading a card expiry —
 * phase 16".
 *
 * ## Why one statement and not five
 *
 * The phase is accepted at "≤ 12 statements per transaction" for a checkin, and
 * a checkout is on the same hot path. Four independent `count()` calls is four
 * round trips for four numbers that come from two tables, and the natural way to
 * write it — a `Promise.all` of four Prisma counts — looks concurrent and is
 * four statements on one connection, executed in series.
 *
 * Scalar subqueries in one SELECT cost one round trip and one snapshot, which is
 * also the correctness argument: five separate counts are five snapshots, so a
 * patron who returns a book between the second and the third is over the limit
 * and under it in the same decision.
 *
 * ## What is NOT counted, and why an absent count is the honest answer
 *
 *   `openHolds`, `openHoldsOfRecord`, `hasOutstandingHold`, `anyCopyAvailable`
 *   — `holds` is phase 17 and does not exist. They are LEFT UNDEFINED rather
 *   than set to 0 or false, because `evaluateBlocks` distinguishes the two and a
 *   zero here would be this phase asserting that no holds exist, which is a
 *   claim it cannot make. The visible consequence is that
 *   `alternateCheckoutPeriodWithHolds` does not shorten a loan yet, and phase 17
 *   turns it on by filling in a field rather than by changing this file.
 *
 * ## The fine balance is real money and is read from `fees`
 *
 * `fees` exists from the phase-9 baseline and `PatronsService.deskSummary`
 * already reports balances per currency, so `fineLimitExceeded` is a block this
 * phase can genuinely evaluate rather than one it has to defer. It sums
 * `outstanding_cents` — the GENERATED column, so the desk and the ledger cannot
 * compute a balance differently — and only in the BRANCH's currency: a
 * `MoneyJson` carries one currency, and adding €4 to £3 to get 7 of something is
 * the failure the whole minor-units-plus-char(3) convention exists to prevent.
 * A debt in another currency is not silently folded in; phase 18's desk view
 * shows it per currency, which is where it belongs.
 *
 * ## Card expiry is deliberately absent
 *
 * `packages/circ-policy`'s `blocks.test.ts` asserts that `CARD_EXPIRED` is
 * absent from its vocabulary by name — "patron and item STATE is deliberately
 * absent: deciding it needs a query, and this package makes none" — and that
 * boundary is right: an expiry is not a comparison against a policy value, and
 * there is no policy field saying whether an expired card may borrow.
 * `CheckoutService` refuses it directly, beside the archived patron and the
 * suspended one, and `patron_blocks.card_expired` is what makes it visible
 * before the reader reaches the desk.
 */
export type CountedState = CirculationState;

export async function countCirculationState(
  tx: TxV2,
  input: {
    readonly patronId: string;
    readonly bibId: string;
    readonly currency: string;
    readonly at: Date;
    readonly timezone: string;
    readonly patron: { dateOfBirth: Date | null };
    /** For a renewal. Absent on a checkout. */
    readonly renewalCount?: number;
  },
): Promise<CountedState> {
  const rows = await tx.$queryRaw<
    { open_loans: bigint; open_of_title: bigint; overdue: bigint; owed: bigint }[]
  >`
    SELECT
      (SELECT pg_catalog.count(*) FROM lbr2.loans
        WHERE patron_id = ${input.patronId} AND closed_at IS NULL) AS open_loans,
      (SELECT pg_catalog.count(*) FROM lbr2.loans
        WHERE patron_id = ${input.patronId} AND closed_at IS NULL
          AND bib_id = ${input.bibId}) AS open_of_title,
      (SELECT pg_catalog.count(*) FROM lbr2.loans
        WHERE patron_id = ${input.patronId} AND closed_at IS NULL
          AND due_at < ${input.at}) AS overdue,
      -- COALESCE is a SQL construct and cannot be schema-qualified; sum is a
      -- real function and is. The ::bigint cast is because sum(bigint)
      -- returns NUMERIC, which Prisma hands back as a string.
      (SELECT COALESCE(pg_catalog.sum(outstanding_cents), 0)::bigint FROM lbr2.fees
        WHERE patron_id = ${input.patronId} AND closed_at IS NULL
          AND currency = ${input.currency}) AS owed`;

  const row = rows[0]!;
  const band = ageBandAt(input.patron.dateOfBirth, input.at, input.timezone);

  return {
    openLoans: Number(row.open_loans),
    openLoansOfTitle: Number(row.open_of_title),
    overdueLoans: Number(row.overdue),
    // `MoneyJson.minorUnits` is a NUMBER, not a bigint and not a string — see
    // its docblock: "Integer, never a decimal string." A balance beyond
    // 2^53 minor units is €90 trillion, which is not a debt a library is owed.
    fineBalance: { minorUnits: Number(row.owed), currency: input.currency },
    // Only when it is genuinely known. `ageBandAt` returns `unknown` for a
    // patron with no date of birth, and an age restriction evaluated against a
    // guessed age would refuse a reader on a fact nobody recorded.
    ...(band === 'unknown' ? {} : { patronAgeYears: wholeYears(input.patron.dateOfBirth!, input) }),
    ...(input.renewalCount === undefined ? {} : { renewalCount: input.renewalCount }),
  };
}

/**
 * Whole civil years, computed the way `ageBandAt` computes the band.
 *
 * Deliberately shares the derivation rather than dividing an elapsed duration:
 * `apps/api/src/circulation/**` may not do millisecond date arithmetic, and the
 * reason is this computation — a year is not 365 × 86_400_000 and the error
 * accumulates in the direction of making children older, which is the direction
 * that matters for an age restriction.
 */
function wholeYears(
  dateOfBirth: Date,
  input: { readonly at: Date; readonly timezone: string },
): number {
  // Reuse the band's own boundaries by bisecting them would be clever and wrong;
  // the band is coarse ON PURPOSE. This is the same civil comparison, inlined,
  // because exporting it from `age-band.ts` would invite a caller to use a raw
  // age where a band belongs.
  // `zonedCivil` and not a second `Intl.DateTimeFormat`: phase 12 measured a
  // fresh formatter at 30.4 µs against 3.74 µs for a memoised one, and this runs
  // on every checkout.
  const { year, month, day } = zonedCivil(dateOfBirth, input.timezone);
  const now = zonedCivil(input.at, input.timezone);
  let years = now.year - year;
  if (now.month < month || (now.month === month && now.day < day)) years -= 1;
  return Math.max(0, years);
}
