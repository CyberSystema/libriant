import {
  addDuration,
  calendarDaysBetween,
  civilFromDays,
  daysFromCivil,
  endOfOpenDay,
  instantFromCivil,
  isOpenAtCivil,
  isOpenDay,
  nextOpenCivil,
  PolicyResolutionError,
  ROLL_HORIZON_DAYS,
  zonedCivil,
  type Calendar,
  type HoldPolicy,
} from '@libriant/circ-policy';

/**
 * "We will keep it for you until Friday."
 *
 * ## Computed ONCE, when the copy is shelved, and stored
 *
 * `hold-pinning.ts` names this column as the one thing a hold neither freezes
 * nor reads live, and says why: a shelf expiry is a promise made to a named
 * reader at a desk — it is on the slip in the book and in the message they were
 * sent. Re-deriving it nightly would let a closure entered on Tuesday silently
 * extend a shelf life the reader was told expired on Monday, and a closure
 * REMOVED would shorten one. Neither is a correction of the record the way a
 * fine re-priced against a live calendar is; both are the library changing its
 * mind about something it already said out loud.
 *
 * So this function is called exactly once per arrival, by
 * {@link HoldArrivalService.claimOnArrival}, and its answer becomes a column.
 *
 * ## `shelfExpiryUsesCalendar`, which is not cosmetic
 *
 * Phase 12 put the switch on `HoldPolicy` with the failure written into its own
 * docblock — "a hold shelved on Friday with three days' life must not expire
 * across a closed weekend. FOLIO shipped this bug" — and phase 13 loads it. This
 * is the only code that reads it.
 *
 *   OFF   three days is seventy-two hours of clock, wherever they land.
 *   ON    three days is three days the library was OPEN. The copy shelved on the
 *         Friday before a long weekend is still there on the Tuesday.
 *
 * The count is of open DAYS rather than of open hours, and it is taken from the
 * plain duration rather than from the unit, so `weeks` and `months` get the same
 * treatment without a second arithmetic: 3 days spans 3 civil days, 2 weeks
 * spans 14, one month spans 28–31, and each becomes that many open days.
 *
 * ## What time of day it expires
 *
 * On the target day, the plain wall-clock time IF the library is open then, and
 * otherwise the minute the desk shuts. A copy shelved at 09:00 expires at 09:00
 * three open days later, which is what the slip says; a copy shelved at 22:00 by
 * a night-shift transit run does NOT expire at 22:00 on a day the doors closed
 * at 14:00, because eight of those hours were hours nobody could have collected
 * in. The FOLIO bug in miniature, and the same reasoning as `calendar.ts`'s
 * `previousOpenCivil`: "a book due at closing is due at 14:00".
 *
 * ## It never throws
 *
 * The calendar functions refuse rather than guess — `CALENDAR_NOT_DEFINED_FOR`
 * beyond the declared coverage, `CALENDAR_EXHAUSTED` when there is no open day
 * within {@link ROLL_HORIZON_DAYS}. Both mean a library that has not entered its
 * hours far enough ahead, and neither is a reason to refuse a copy at a pickup
 * desk: the physical act happened, the same way a return is never refused.
 *
 * A `null` expiry means NO AUTOMATIC EXPIRY. The shelf-expiry sweep skips the
 * row, the copy stays on the shelf for its reader, and a librarian sees it on
 * the shelf list. That is the generous failure; the other one — guessing a date
 * from a calendar that does not cover it — puts a date nobody chose on a slip.
 */
export function shelfExpiryFor(input: {
  readonly policy: HoldPolicy;
  /** LIVE, not frozen — `hold-pinning.ts` on the policy/calendar split. */
  readonly calendar: Calendar | null;
  /** The moment the copy reached the pickup shelf. */
  readonly from: Date;
  /** The PICKUP branch's zone. `hold-pinning.ts` freezes it onto the snapshot. */
  readonly timezone: string;
}): Date | null {
  const { policy, calendar, from, timezone } = input;

  // The plain answer, in the arithmetic the unit demands: `minutes`/`hours` are
  // elapsed, `days`/`weeks`/`months` are civil days in the branch's zone. Passing
  // `null` for the time of day keeps the shelving time, which is what a shelf
  // life means — unlike a due date, nobody says "expires at closing on the third
  // day" until the calendar below says it.
  const plain = addDuration(timezone, from, policy.holdShelfExpiry, null);
  if (!policy.shelfExpiryUsesCalendar || calendar === null) return plain;

  try {
    const plainCivil = zonedCivil(plain, timezone);
    const plainMinute = plainCivil.hour * 60 + plainCivil.minute;
    const wantedOpenDays = calendarDaysBetween(timezone, from, plain);

    // An hourly shelf life, which never leaves the shelving day. There are no
    // days to count, so the only calendar question is whether the moment it
    // names is a moment the desk is open — and if it is not, the reader gets
    // until it next is rather than an expiry behind a locked door.
    if (wantedOpenDays === 0) {
      if (isOpenAtCivil(calendar, plainCivil, plainMinute)) return plain;
      const open = nextOpenCivil(calendar, plainCivil, plainMinute);
      return atMinute(timezone, open.date, open.minuteOfDay);
    }

    // Walk forward one day at a time, counting only the days the library is
    // open. Bounded by the plain span plus one roll horizon: a Greek library can
    // be shut for three consecutive weeks in August, and `calendar.ts` chose 45
    // days for exactly that, so a three-week shelf life may skip at most a
    // further 45 closed days before this gives up and says nothing.
    let day = daysFromCivil(zonedCivil(from, timezone));
    let counted = 0;
    for (let i = 0; i < wantedOpenDays + ROLL_HORIZON_DAYS && counted < wantedOpenDays; i += 1) {
      day += 1;
      if (isOpenDay(calendar, civilFromDays(day))) counted += 1;
    }
    if (counted < wantedOpenDays) return null;

    const date = civilFromDays(day);
    const close = endOfOpenDay(calendar, date);
    // `isOpenDay` was true for this date, so `endOfOpenDay` cannot be null here;
    // the fallback is written rather than asserted because a `!` on a value that
    // decides when a reader loses their book is not worth the character saved.
    if (close === null) return null;
    return atMinute(
      timezone,
      date,
      isOpenAtCivil(calendar, date, plainMinute) ? plainMinute : close,
    );
  } catch (err) {
    if (err instanceof PolicyResolutionError) return null;
    throw err;
  }
}

/**
 * A civil date and a minute-of-day, as an instant.
 *
 * `minuteOfDay` may be 1440 — `endOfOpenDay` returns the CLOSING minute, and a
 * library open 00:00–24:00 (which is what phase 16's default calendar seeds)
 * closes at 24:00. `Date.UTC` carries hour 24 into the next day, which is the
 * arithmetic that makes "until we close" and "until midnight" the same instant
 * rather than one being an hour of nothing.
 */
function atMinute(
  timezone: string,
  date: { year: number; month: number; day: number },
  minuteOfDay: number,
): Date {
  return instantFromCivil(timezone, {
    ...date,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
  }).instant;
}
