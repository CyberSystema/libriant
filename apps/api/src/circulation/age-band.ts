import { zonedCivil } from '@libriant/circ-policy';

/**
 * `loans.patron_age_band` — the one statistical bucket that cannot be added
 * later.
 *
 * §3 lists three columns as "statistical buckets that survive anonymisation":
 * `patron_category_code`, `patron_age_band` and `patron_home_branch_id`. The
 * first and third are copies of a value that stays on the patron row. The second
 * is not: it is derived from a DATE OF BIRTH, and once `loans.patron_id` has
 * been nulled on return there is no row left to derive it from.
 *
 * So "defer it to the reports phase" and "lose it for ever" are the same
 * sentence, and this file exists because they are.
 *
 * ## Why a band and not an age
 *
 * §3 wrote "band" and the reason is the one the whole anonymisation exists for.
 * An anonymised loan row carrying `age: 11`, a branch and a date is close to
 * identifying one child in a village library; carrying `child` is not. The
 * coarser value is the point, not a rounding.
 *
 * ## Why the boundaries are fixed and not configurable
 *
 * Because they have to mean the same thing across libraries for an ISO 2789
 * return to add up, and because a configurable band is a band that changes
 * meaning half-way through a year of statistics with no record of when. The
 * boundaries are 13, 18 and 65 — the conventional children's/young-adult split,
 * majority, and the age every Greek public library's concession card already
 * uses.
 *
 * 15 is deliberately NOT a boundary, even though it is the digital-consent age
 * in Ν.4624/2019 art. 21 that this codebase already cites. That threshold
 * governs whether a registration needs a guardian, phase 33 freezes the age in
 * force onto the registration row for exactly that purpose, and deriving a legal
 * question from a statistical bucket would be answering it with the wrong tool —
 * the band is coarse ON PURPOSE, and a consent decision must not be.
 *
 * ## Why the branch timezone
 *
 * An age is a civil-calendar fact. A checkout at 01:00 Athens on somebody's
 * fifteenth birthday is a fifteen-year-old borrowing a book; computed in UTC it
 * is a fourteen-year-old, and the band would be wrong for exactly the readers
 * the consent age is about.
 */
export const AGE_BANDS = ['child', 'teen', 'adult', 'senior', 'unknown'] as const;

export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * The band a patron is in on a given instant, in a given zone.
 *
 * `unknown` when there is no date of birth, which is the ordinary case: a public
 * library that does not need one should not be made to record one, and a bucket
 * that lies about that is worse than one that says so.
 */
export function ageBandAt(
  dateOfBirth: Date | null | undefined,
  at: Date,
  timezone: string,
): AgeBand {
  if (dateOfBirth === null || dateOfBirth === undefined) return 'unknown';

  const born = zonedCivil(dateOfBirth, timezone);
  const now = zonedCivil(at, timezone);

  // Whole years elapsed, by civil comparison rather than by dividing an elapsed
  // duration — `apps/api/src/circulation/**` may not do millisecond date
  // arithmetic at all, and the reason is this exact computation: a year is not
  // 365 × 86_400_000, and the error accumulates in the direction of making
  // children older.
  let years = now.year - born.year;
  const beforeBirthday = now.month < born.month || (now.month === born.month && now.day < born.day);
  if (beforeBirthday) years -= 1;

  if (years < 0) return 'unknown';
  if (years < 13) return 'child';
  if (years < 18) return 'teen';
  if (years < 65) return 'adult';
  return 'senior';
}
