import {
  civilFromDays,
  civilKey,
  daysFromCivil,
  endOfCurrentInterval,
  endOfOpenDay,
  exceptionOn,
  instantFromCivil,
  isOpenAtCivil,
  nextOpenCivil,
  previousOpenCivil,
  startOfOpenDay,
  zonedCivil,
} from './calendar.js';
import {
  POLICY_ERROR,
  PolicyResolutionError,
  type Calendar,
  type CalendarRoll,
  type CivilDate,
  type CivilDateTime,
  type Duration,
  type FixedDueDateSet,
  type LoanPolicy,
} from './types.js';

/**
 * When is it due?
 *
 * The question §6's M2 claim turns on — "ask *why* a book is due on a given date
 * and get the rule that decided it, which Koha, Alma and FOLIO cannot answer at
 * all" — so every movement of the answer is recorded as a {@link CalendarRoll}
 * rather than folded silently into the result.
 *
 * ## Elapsed time and civil time are different arithmetic
 *
 * `minutes` and `hours` are ELAPSED: a two-hour loan is 7,200,000 ms later,
 * whatever the clock did in between. `days`, `weeks` and `months` are CIVIL:
 * fourteen days later is the same wall-clock time on a date fourteen days on,
 * which is one hour more or less of elapsed time when a DST boundary falls
 * between them.
 *
 * Conflating them is circ-5 in miniature. A library that says "three weeks"
 * means three weeks on a calendar. A library that says "two hours" means two
 * hours on a clock. Measured, the difference across the Athens spring forward is
 * exactly one hour, and it is the hour a patron is fined for.
 *
 * The acceptance criterion names the sharpest case: "a 2-hour loan starting
 * 01:30 on a spring-forward night". 01:30 local is 23:30Z the previous day; two
 * ELAPSED hours later is 01:30Z, which is 04:30 local, because 03:30 never
 * happened. Not 03:30 — a due time that does not exist — and not 02:30, which
 * would be ninety minutes.
 */

export type DueDateInput = {
  readonly policy: LoanPolicy;
  readonly calendar: Calendar;
  /** The instant the loan begins. */
  readonly from: Date;
  /** The `fixed` profile's set, when the policy names one. */
  readonly fixedDueDateSet?: FixedDueDateSet;
  /**
   * Whether an unfilled hold exists on this title, so
   * `alternateCheckoutPeriodWithHolds` can shorten the loan. A boolean the
   * CALLER supplies — counting holds is a query and this package does none.
   */
  readonly hasOutstandingHold?: boolean;
};

export type DueDateResult = {
  /** `null` only for the `indefinite` profile. */
  readonly dueAt: Date | null;
  readonly rolls: readonly CalendarRoll[];
};

/**
 * The due date, and every step that moved it.
 *
 * Returns `dueAt: null` for `indefinite` — a staff reference loan or a long-term
 * departmental deposit genuinely has no due date, and a sentinel far-future date
 * would be a lie that some report eventually renders.
 */
export function computeDueDate(input: DueDateInput): DueDateResult {
  const { policy, calendar, from } = input;
  const rolls: CalendarRoll[] = [];

  if (policy.profile === 'indefinite') return { dueAt: null, rolls };

  let due =
    policy.profile === 'fixed'
      ? fixedDue(input, rolls)
      : rollingDue(policy, calendar, from, input.hasOutstandingHold === true, rolls);

  due = applyMaxPeriod(policy, calendar, from, due, rolls);
  due = applyClosedDayHandling(policy, calendar, from, due, rolls);

  return { dueAt: due, rolls };
}

/** `renewalPeriod` from either the current due date or now, per the policy. */
export function computeRenewalDueDate(
  input: DueDateInput & { readonly currentDueAt: Date },
): DueDateResult {
  const { policy } = input;
  // `renewFrom` is the classic librarian complaint made configurable: renewing
  // an overdue loan either gives fourteen days from today or fourteen days from
  // a date already past. Both are defensible policies and libraries hold both.
  const anchor =
    policy.renewFrom === 'currentDueDate' && input.currentDueAt > input.from
      ? input.currentDueAt
      : policy.renewFrom === 'currentDueDate'
        ? input.currentDueAt
        : input.from;

  const period =
    input.hasOutstandingHold === true
      ? (policy.alternateRenewalPeriodWithHolds ?? policy.renewalPeriod ?? policy.period)
      : (policy.renewalPeriod ?? policy.period);

  if (policy.profile === 'rolling' && period === null) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyIncomplete,
      `Loan policy ${policy.id} renews on a rolling profile but names no renewal or loan period.`,
      policy.id,
    );
  }
  // THE PERIOD CHOSEN ABOVE IS THE ONE APPLIED, and it has to be handed over
  // explicitly. `computeDueDate` re-derives a period from `policy.period` and
  // `alternateCheckoutPeriodWithHolds`, so passing the untouched policy would
  // compute a CHECKOUT due date from a renewal anchor: `renewalPeriod` would
  // never take effect at all, and `alternateRenewalPeriodWithHolds` would be
  // silently replaced by its checkout twin. Every vector in
  // `resolution-vectors.json` has `renewalPeriod: null`, which is exactly why
  // this went unnoticed until phase 17 wired `hasOutstandingHold` in and asked
  // the alternate renewal period to do something.
  //
  // `alternateCheckoutPeriodWithHolds: null` because `period` has already
  // absorbed the hold decision; leaving it set would apply the shortening twice.
  return computeDueDate({
    ...input,
    from: anchor,
    policy: { ...policy, period, alternateCheckoutPeriodWithHolds: null },
  });
}

// ---------------------------------------------------------------------------

function rollingDue(
  policy: LoanPolicy,
  calendar: Calendar,
  from: Date,
  hasHold: boolean,
  rolls: CalendarRoll[],
): Date {
  let period = policy.period;
  if (hasHold && policy.alternateCheckoutPeriodWithHolds !== null) {
    // How a hold shortens a loan WITHOUT a special case anywhere in the engine:
    // it is a second period on the same policy, selected by a boolean the caller
    // already knows.
    const shortened = policy.alternateCheckoutPeriodWithHolds;
    if (period !== null) {
      rolls.push({
        reason: 'holdShortened',
        from: `${period.value} ${period.unit}`,
        to: `${shortened.value} ${shortened.unit}`,
        detail: 'an unfilled hold exists on this title',
      });
    }
    period = shortened;
  }
  if (period === null) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyIncomplete,
      `Loan policy ${policy.id} has a rolling profile and no period.`,
      policy.id,
    );
  }
  return addDuration(calendar.timezone, from, period, policy.dueTimeOfDay);
}

function fixedDue(input: DueDateInput, rolls: CalendarRoll[]): Date {
  const { policy, calendar, from, fixedDueDateSet } = input;
  if (policy.fixedDueDateSetId === null || fixedDueDateSet === undefined) {
    throw new PolicyResolutionError(
      POLICY_ERROR.policyIncomplete,
      `Loan policy ${policy.id} has a fixed profile and no due-date set.`,
      policy.id,
    );
  }
  const civil = zonedCivil(from, calendar.timezone);
  const n = daysFromCivil(civil);
  for (const r of fixedDueDateSet.ranges) {
    if (n >= daysFromCivil(r.from) && n <= daysFromCivil(r.to)) {
      const time = r.dueTimeOfDay ?? policy.dueTimeOfDay ?? { hour: 23, minute: 59 };
      const due = instantFromCivil(calendar.timezone, {
        ...r.dueDate,
        hour: time.hour,
        minute: time.minute,
        second: 0,
      }).instant;
      rolls.push({
        reason: 'fixedDueDate',
        from: from.toISOString(),
        to: due.toISOString(),
        detail: `${fixedDueDateSet.name}: ${civilKey(r.from)}–${civilKey(r.to)}`,
      });
      return due;
    }
  }
  // FOLIO falls back to rolling here and gives a semester loan taken the day
  // after term ends an arbitrary date. Refusing is the whole point of §4.1.
  throw new PolicyResolutionError(
    POLICY_ERROR.noFixedDueDateRange,
    `Fixed due-date set ${fixedDueDateSet.name} has no range covering ${civilKey(civil)}. ` +
      'A loan taken outside every term cannot be given a term-end due date.',
    fixedDueDateSet.id,
  );
}

/**
 * Add a duration to an instant, in the arithmetic its unit demands.
 *
 * `dueTimeOfDay` replaces the time of day AFTER the date arithmetic, which is
 * what makes "two weeks, due at closing" mean the fourteenth day at closing
 * rather than at 14:37 because that is when the barcode was scanned. It is
 * deliberately NOT applied to `minutes`/`hours`: an hourly loan means an hour.
 */
export function addDuration(
  timezone: string,
  from: Date,
  period: Duration,
  dueTimeOfDay: { hour: number; minute: number } | null,
): Date {
  if (period.unit === 'minutes') return new Date(from.getTime() + period.value * 60_000);
  if (period.unit === 'hours') return new Date(from.getTime() + period.value * 3_600_000);

  const civil = zonedCivil(from, timezone);
  let target: CivilDate;
  if (period.unit === 'months') {
    // Month arithmetic clamps: 31 January plus one month is 28 February, not
    // 3 March. The same month-end clamp phase 69's serials prediction needs, and
    // the same one every naive implementation gets wrong in the other direction.
    const total = civil.year * 12 + (civil.month - 1) + period.value;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const day = Math.min(civil.day, daysInMonth(year, month));
    target = { year, month, day };
  } else {
    const step = period.unit === 'weeks' ? 7 : 1;
    target = civilFromDays(daysFromCivil(civil) + period.value * step);
  }

  const time = dueTimeOfDay ?? { hour: civil.hour, minute: civil.minute };
  return instantFromCivil(timezone, {
    ...target,
    hour: time.hour,
    minute: time.minute,
    second: dueTimeOfDay === null ? civil.second : 0,
  }).instant;
}

function daysInMonth(year: number, month: number): number {
  return (
    daysFromCivil(
      month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 },
    ) - daysFromCivil({ year, month, day: 1 })
  );
}

function applyMaxPeriod(
  policy: LoanPolicy,
  calendar: Calendar,
  from: Date,
  due: Date,
  rolls: CalendarRoll[],
): Date {
  if (policy.maxPeriod === null) return due;
  const cap = addDuration(calendar.timezone, from, policy.maxPeriod, policy.dueTimeOfDay);
  if (due <= cap) return due;
  rolls.push({
    reason: 'maxPeriodCap',
    from: due.toISOString(),
    to: cap.toISOString(),
    detail: `capped at ${policy.maxPeriod.value} ${policy.maxPeriod.unit}`,
  });
  return cap;
}

/**
 * Move a due date that lands when the library is shut.
 *
 * NOT A BOOLEAN, and phase 25 is why: "reserve items are 2-hour in-library
 * loans" has to be an ordinary rule, and a two-hour loan started at 13:30 on a
 * Greek split day (08:00–14:00, 17:00–21:00) must be due at 14:00 when the desk
 * closes — never at 15:30 when there is nobody to hand it to.
 *
 * `endOfCurrentOpenHours` is that case, and it is the one a checkbox cannot say.
 */
function applyClosedDayHandling(
  policy: LoanPolicy,
  calendar: Calendar,
  from: Date,
  due: Date,
  rolls: CalendarRoll[],
): Date {
  if (policy.closedDayHandling === 'keep') return due;

  const civil = zonedCivil(due, calendar.timezone);
  const minute = civil.hour * 60 + civil.minute;
  const date: CivilDate = { year: civil.year, month: civil.month, day: civil.day };

  if (policy.closedDayHandling === 'endOfCurrentOpenHours') {
    // MEASURED FROM THE LOAN START, not from the computed due date, and that is
    // the whole meaning of an in-library loan: "you may keep it until we close".
    //
    // A two-hour reserve taken at 13:30 on a Greek split day (08:00–14:00,
    // 17:00–21:00) computes a naive due of 15:30, which is not in any interval.
    // Asking about 15:30 would send it to 17:00 — the desk reopening — and the
    // patron would be holding a reference book through the afternoon closure.
    // Asking about 13:30 gives 14:00, which is when the librarian expects it
    // back.
    const start = zonedCivil(from, calendar.timezone);
    const startDate: CivilDate = { year: start.year, month: start.month, day: start.day };
    const end = endOfCurrentInterval(calendar, startDate, start.hour * 60 + start.minute);
    if (end !== null) {
      const clamp = instantFromCivil(calendar.timezone, {
        ...startDate,
        hour: Math.floor(end / 60),
        minute: end % 60,
        second: 0,
      }).instant;
      if (clamp >= due) return due;
      rolls.push({
        reason: 'closedHours',
        from: due.toISOString(),
        to: clamp.toISOString(),
        detail: 'in-library loan: due when the current opening ends',
      });
      return clamp;
    }
    // The loan began while the library was shut — a back-office transaction, or
    // a clock that disagrees with the calendar. Fall forward to the next open
    // minute, which on a split day is this afternoon rather than tomorrow.
    const open = nextOpenCivil(calendar, date, minute);
    return moveTo(
      calendar,
      open.date,
      open.minuteOfDay,
      due,
      reasonFor(calendar, open.date),
      rolls,
      'next opening',
    );
  }

  if (isOpenAtCivil(calendar, date, minute)) return due;

  if (policy.closedDayHandling === 'endOfPreviousOpenDay') {
    const prev = previousOpenCivil(calendar, date, minute);
    const end = endOfOpenDay(calendar, prev.date) ?? prev.minuteOfDay;
    return moveTo(
      calendar,
      prev.date,
      end,
      due,
      reasonFor(calendar, prev.date),
      rolls,
      'previous open day',
    );
  }

  const next = nextOpenCivil(calendar, date, minute);
  if (policy.closedDayHandling === 'endOfNextOpenDay') {
    const end = endOfOpenDay(calendar, next.date) ?? next.minuteOfDay;
    return moveTo(
      calendar,
      next.date,
      end,
      due,
      reasonFor(calendar, next.date),
      rolls,
      'end of the next open day',
    );
  }

  // startOfNextOpenDay, plus the optional offset — "one hour after we open",
  // which is how a library avoids a queue of returns at the door.
  let minuteOfDay = startOfOpenDay(calendar, next.date) ?? next.minuteOfDay;
  if (minuteOfDay < next.minuteOfDay) minuteOfDay = next.minuteOfDay;
  const moved = moveTo(
    calendar,
    next.date,
    minuteOfDay,
    due,
    reasonFor(calendar, next.date),
    rolls,
    'next open day',
  );
  if (policy.openingTimeOffset === null) return moved;
  const offset = addDuration(calendar.timezone, moved, policy.openingTimeOffset, null);
  rolls.push({
    reason: 'openingOffset',
    from: moved.toISOString(),
    to: offset.toISOString(),
    detail: `${policy.openingTimeOffset.value} ${policy.openingTimeOffset.unit} after opening`,
  });
  return offset;
}

/** `holiday` when a named exception closed the day, `closedDay` otherwise. */
function reasonFor(calendar: Calendar, date: CivilDate): CalendarRoll['reason'] {
  return exceptionOn(calendar, date) !== undefined ? 'holiday' : 'closedDay';
}

function moveTo(
  calendar: Calendar,
  date: CivilDate,
  minuteOfDay: number,
  from: Date,
  reason: CalendarRoll['reason'],
  rolls: CalendarRoll[],
  what: string,
): Date {
  const civil: CivilDateTime = {
    ...date,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
  };
  const { instant, kind } = instantFromCivil(calendar.timezone, civil);
  const named = exceptionOn(calendar, date);
  rolls.push({
    reason,
    from: from.toISOString(),
    to: instant.toISOString(),
    detail: named !== undefined ? `${what} (${named.name})` : what,
  });
  // A due date that moved an hour because of DST is the most common "this is
  // wrong" support ticket there is, so it is named in the trace rather than
  // being an unexplained hour.
  if (kind !== 'unique') {
    rolls.push({
      reason: kind === 'gap' ? 'dstGap' : 'dstAmbiguous',
      from: `${civilKey(date)} ${String(civil.hour).padStart(2, '0')}:${String(civil.minute).padStart(2, '0')} local`,
      to: instant.toISOString(),
      detail:
        kind === 'gap'
          ? 'that wall-clock time does not exist; the later instant was used'
          : 'that wall-clock time happens twice; the later instant was used',
    });
  }
  return instant;
}
