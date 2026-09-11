import { civilKey, zonedCivil, type CirculationState } from '@libriant/circ-policy';
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
 * ## The hold counts, filled in by phase 17
 *
 * Phase 16 left `openHolds`, `openHoldsOfRecord`, `hasOutstandingHold` and the
 * two availability flags UNDEFINED rather than zero, on the rule that an absent
 * count is "not checked" and never "zero" — "a zero here would be this phase
 * asserting that no holds exist, which is a claim it cannot make". Phase 17 owns
 * `holds`, so it can make the claim, and it does so in the same statement rather
 * than in a second one.
 *
 * THREE of the five are subtler than they look:
 *
 *   `hasOutstandingHold` is "somebody ELSE is waiting", and it decides whether a
 *   loan is shortened (`alternateCheckoutPeriodWithHolds`) and whether a renewal
 *   is refused (`renewWithOutstandingHolds`). It therefore excludes the
 *   borrower's OWN hold — a reader collecting the copy they asked for must not
 *   be given a short loan because they are waiting for it — and it excludes
 *   SUSPENDED holds, because a reader who said "not until the 3rd" is not
 *   waiting today and shortening somebody else's loan for them is charging one
 *   reader for another reader's convenience.
 *
 *   `anyCopyAvailable` / `allCopiesAvailable` read the GENERATED
 *   `is_shelf_available` column rather than `status = 'available'`, for the
 *   reason the baseline migration records: Prisma emits `status = CAST($1::text
 *   AS item_status)`, `enum_in` is only STABLE, and the planner can never prove
 *   an enum-predicate index. They are also the only place "on the shelf right
 *   now" is decided, so the four exclusion codes cannot be forgotten here.
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
    /**
     * Civil today in the branch's zone, `YYYY-MM-DD`, for the suspension window.
     *
     * A DATE and not an instant, for `holds.suspended_until`'s own reason: "back
     * on the 3rd" is true in every zone, and an instant makes it true at 02:00
     * in one and 23:00 in another.
     */
    readonly today: string;
    /** Where the reader may collect, when a hold is being placed. */
    readonly requestedPickupBranchId?: string;
    readonly requestedHoldLevel?: 'title' | 'volume' | 'item';
    /** Where the copy LIVES and where it IS. Deliberately two branches. */
    readonly itemOwningBranchId?: string | null;
    readonly itemCurrentBranchId?: string | null;
    readonly patronHomeBranchId?: string | null;
  },
): Promise<CountedState> {
  const rows = await tx.$queryRaw<
    {
      open_loans: bigint;
      open_of_title: bigint;
      overdue: bigint;
      owed: bigint;
      open_holds: bigint;
      open_holds_of_record: bigint;
      outstanding_holds: bigint;
      copies: bigint;
      copies_available: bigint;
    }[]
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
      -- owed_cents (2.0 phase 18): the generated column that is the balance when
      -- the row is open and 0 when it is closed. It replaces the pair
      -- outstanding_cents + closed_at IS NULL, which was one of TWO spellings of
      -- this question in the codebase.
      (SELECT COALESCE(pg_catalog.sum(owed_cents), 0)::bigint FROM lbr2.fees
        WHERE patron_id = ${input.patronId}
          AND currency = ${input.currency}) AS owed,
      -- THE HOLD COUNTS. "Open" is three NULL tests and never a status enum —
      -- 45-items.prisma has the measurement: a parameterised enum predicate
      -- seq-scans at 1470 buffers against 2 for a NULL predicate, and still
      -- seq-scans with enable_seqscan off, so there is no index path at all.
      (SELECT pg_catalog.count(*) FROM lbr2.holds
        WHERE patron_id = ${input.patronId}
          AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL) AS open_holds,
      (SELECT pg_catalog.count(*) FROM lbr2.holds
        WHERE patron_id = ${input.patronId} AND bib_id = ${input.bibId}
          AND fulfilled_at IS NULL AND cancelled_at IS NULL
          AND expired_at IS NULL) AS open_holds_of_record,
      -- SOMEBODY ELSE, and not somebody who said "not until the 3rd". Both
      -- exclusions are in the class docblock; together they are what stops a
      -- reader being given a short loan on the copy they themselves asked for.
      (SELECT pg_catalog.count(*) FROM lbr2.holds
        WHERE bib_id = ${input.bibId} AND patron_id <> ${input.patronId}
          AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL
          AND (suspended_until IS NULL
               OR suspended_until < ${input.today}::date)) AS outstanding_holds,
      (SELECT pg_catalog.count(*) FROM lbr2.items
        WHERE bib_id = ${input.bibId} AND archived_at IS NULL) AS copies,
      -- The GENERATED column, which is the ONE definition of "on the shelf right
      -- now" and already folds in the four exclusion codes.
      (SELECT pg_catalog.count(*) FROM lbr2.items
        WHERE bib_id = ${input.bibId} AND is_shelf_available) AS copies_available`;

  const row = rows[0]!;
  const copies = Number(row.copies);
  const available = Number(row.copies_available);
  const band = ageBandAt(input.patron.dateOfBirth, input.at, input.timezone);

  return {
    openLoans: Number(row.open_loans),
    openLoansOfTitle: Number(row.open_of_title),
    overdueLoans: Number(row.overdue),
    // `MoneyJson.minorUnits` is a NUMBER, not a bigint and not a string — see
    // its docblock: "Integer, never a decimal string." A balance beyond
    // 2^53 minor units is €90 trillion, which is not a debt a library is owed.
    fineBalance: { minorUnits: Number(row.owed), currency: input.currency },
    openHolds: Number(row.open_holds),
    openHoldsOfRecord: Number(row.open_holds_of_record),
    hasOutstandingHold: Number(row.outstanding_holds) > 0,
    anyCopyAvailable: available > 0,
    // A record with NO copies is not a record all of whose copies are on the
    // shelf. `every` over an empty set is vacuously true and would turn
    // `onShelfHolds: 'ifAnyUnavailable'` into a refusal of every hold on an
    // on-order title, which is the one hold a library most wants to accept.
    allCopiesAvailable: copies > 0 && available === copies,
    // The three branch facts `pickupBlock` reads, each only when the caller
    // knows it. Undefined is "not checked" here as everywhere: a comparison
    // against an absent branch is a refusal produced by a missing value rather
    // than by a policy.
    ...(input.requestedPickupBranchId === undefined
      ? {}
      : { requestedPickupBranchId: input.requestedPickupBranchId }),
    ...(input.requestedHoldLevel === undefined
      ? {}
      : { requestedHoldLevel: input.requestedHoldLevel }),
    ...(input.itemOwningBranchId == null ? {} : { itemHomeBranchId: input.itemOwningBranchId }),
    ...(input.itemCurrentBranchId == null
      ? {}
      : { itemCurrentBranchId: input.itemCurrentBranchId }),
    ...(input.patronHomeBranchId == null ? {} : { patronHomeBranchId: input.patronHomeBranchId }),
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

/**
 * Civil today in a branch's zone, as `YYYY-MM-DD`.
 *
 * The ONE derivation of "today" that circulation and holds share, so a
 * suspension that ends on the 3rd ends on the same day for the promoter, the
 * counter and the resume sweep. `civilKey` and `zonedCivil` rather than
 * `toISOString().slice(0, 10)`, which is today in UTC and is a different day
 * either side of midnight in Athens — the `circ-5` mistake in its smallest form.
 */
export function civilToday(at: Date, timezone: string): string {
  return civilKey(zonedCivil(at, timezone));
}

/**
 * Is somebody ELSE waiting for this title today?
 *
 * The one fact a RENEWAL needs out of `holds`, and the reason it is not the
 * whole of {@link countCirculationState}: a renewal deliberately re-checks
 * almost nothing — "the reader already HAS this book, and refusing to extend it
 * because they are at their limit would mean the only way out of the limit is to
 * return something, which is a rule no library has" — so counting their loans
 * and their debts again would be nine subqueries for one boolean.
 *
 * `IS DISTINCT FROM` rather than `<>` because a returned-and-anonymised loan has
 * no patron: `patron_id <> NULL` is NULL, which is not true, so every hold would
 * be excluded and a renewal of an anonymised loan would never see one.
 */
export async function hasOutstandingHoldOn(
  tx: TxV2,
  input: {
    readonly bibId: string;
    readonly excludePatronId: string | null;
    readonly today: string;
  },
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT pg_catalog.count(*) AS n
      FROM lbr2.holds
     WHERE bib_id = ${input.bibId}
       AND patron_id IS DISTINCT FROM ${input.excludePatronId}
       AND fulfilled_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL
       AND (suspended_until IS NULL OR suspended_until < ${input.today}::date)`;
  return Number(rows[0]?.n ?? 0) > 0;
}
