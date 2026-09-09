import {
  POLICY_ERROR,
  PolicyResolutionError,
  type Calendar,
  type CivilDate,
  type CivilDateTime,
  type OpeningInterval,
} from './types.js';

/**
 * Time, with `Intl` and integers and nothing else.
 *
 * ## Why there is no date library here, and never will be
 *
 * §7 cuts one explicitly: "`Intl.DateTimeFormat` in Node 26 and every browser,
 * backed by the same ICU tzdata the platform ships. A date library is a second,
 * divergent tzdb — and the Rust core must agree byte-for-byte." §5's IANA row
 * says the same from the other side: "every computation via
 * `Intl.DateTimeFormat` parts — never offset arithmetic, never a date library,
 * because a second tzdb is a second answer. **This is the circ-5 fix.**"
 *
 * circ-5 is live in 1.0 today, with a comment naming itself:
 * `apps/api/src/loans/loans.service.ts` computes days overdue as
 * `Math.floor((now - dueAt) / 86_400_000)` — whole 24-hour blocks since an
 * instant, not calendar days in the library's own timezone. A book due at 09:00
 * and returned at 08:00 two days later is "1 day overdue" under that arithmetic
 * and two days overdue to the librarian holding it.
 *
 * ## Exactly two `Intl` crossings, and everything between them is integers
 *
 * MEASURED on this repo's Node v26.7.0:
 *
 *     construct Intl.DateTimeFormat   30.4  µs
 *     formatToParts (cached fmtr)      3.74 µs
 *     integer civil arithmetic         0.009 µs      ← 415× cheaper
 *
 * Phase 13's budget for a WHOLE resolution is 200 µs. A `nextOpen` that
 * formatted each candidate day would cost ~80 µs to roll a twenty-day August
 * closure; the integer version costs 0.2 µs. So: {@link zonedCivil} converts an
 * instant to wall-clock ONCE at the start, {@link instantFromCivil} converts
 * back ONCE at the end, and every day, weekday and minute computation in between
 * is arithmetic on a day number.
 *
 * The formatter cache is a module-level `Map`. It is still referentially
 * transparent — the same instant and zone always give the same parts, and
 * nothing observable depends on whether the formatter was built now or a
 * millisecond ago — so "pure" survives it. It is also invisible to the Rust
 * core, which is why the golden vectors must never depend on it.
 */

/** Milliseconds in a day. Only ever used on UTC day NUMBERS, never on instants. */
const DAY_MS = 86_400_000;

/** How far a closed-day roll will search before refusing. */
export const ROLL_HORIZON_DAYS = 45;

/**
 * One formatter per timezone, built once.
 *
 * `hourCycle: 'h23'` asks for 00–23, and the `% 24` in {@link readParts} is belt
 * as well as braces: current V8 returns `'00'` for midnight, but the phase-76
 * client is WKWebView and WebView2 rather than V8, and older engines returned
 * `'24'`. A silent off-by-one-day at midnight is not a bug worth discovering in
 * a library.
 *
 * `era: 'short'` because a year before 1 CE formats as `'1'` with era `'BC'`,
 * and a calendar that quietly maps 1 BC to 1 CE is worse than one that refuses.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** An instant, as wall-clock time in a zone. The first of the two crossings. */
export function zonedCivil(instant: Date, timezone: string): CivilDateTime {
  return readParts(formatterFor(timezone), instant.getTime());
}

function readParts(f: Intl.DateTimeFormat, ms: number): CivilDateTime {
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') out[p.type] = p.value;
  const year = Number(out['year']);
  return {
    year: out['era'] === 'BC' ? 1 - year : year,
    month: Number(out['month']),
    day: Number(out['day']),
    hour: Number(out['hour']) % 24,
    minute: Number(out['minute']),
    second: Number(out['second']),
  };
}

/** What to do when a wall-clock time does not exist, or exists twice. */
export type Disambiguation = 'earlier' | 'later' | 'reject';

/**
 * A wall-clock time in a zone, as an instant. The second crossing, and the hard
 * direction.
 *
 * ## Why the probe is ±24 hours and not the obvious two steps
 *
 * The intuitive algorithm reads the offset at the guessed instant and re-probes
 * at `wall - offset`. It converges, and on an autumn fallback it converges to
 * ONE of the two valid instants and never sees the other. MEASURED, Athens
 * 2026-10-25 03:30 — a wall time that happens twice:
 *
 *     naive two-probe:  ['2026-10-25T01:30:00Z']                       ← loses 00:30Z
 *     ±24 h probe:      ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']
 *
 * An implementation with the naive version passes every ordinary day and every
 * spring-forward test and is wrong for exactly one hour a year. Probing a day
 * either side instead gives both candidate offsets, and keeping only the ones
 * that format back to the wall time asked for gives 0 (a gap), 1 (ordinary) or
 * 2 (a fold).
 *
 * ## What the three answers mean for a library, and why the default is `'later'`
 *
 * A GAP — local 03:30 on the spring-forward night — is an instant that does not
 * exist; the two candidates either side are local 02:30 and local 04:30. A FOLD
 * — local 03:30 on the autumn night — happens twice, at 00:30Z and 01:30Z.
 *
 * ONE RULE COVERS BOTH: take the LATER instant. Every value this function
 * produces in this package is a deadline — a due date, a hold shelf expiry, the
 * end of a grace period — and the later instant is the one that gives the patron
 * more time. The failure mode of the other choice is a fine for a minute the
 * clock stole, which is indefensible to the person paying it and impossible to
 * explain at the desk.
 *
 * `'reject'` is offered rather than assumed because phase 97's room booking
 * genuinely must refuse to schedule a room at a wall-clock time that will not
 * happen, where a library loan can simply be an hour more generous.
 */
export function instantFromCivil(
  timezone: string,
  civil: CivilDateTime,
  disambiguation: Disambiguation = 'later',
): { instant: Date; kind: 'unique' | 'gap' | 'ambiguous' } {
  const f = formatterFor(timezone);
  const wall = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    civil.hour,
    civil.minute,
    civil.second,
  );
  const asUtc = (ms: number) => {
    const p = readParts(f, ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  const offsetAt = (ms: number) => asUtc(ms) - ms;

  const candidates: number[] = [];
  for (const probe of [wall - DAY_MS, wall + DAY_MS]) {
    const t = wall - offsetAt(probe);
    if (asUtc(t) === wall && !candidates.includes(t)) candidates.push(t);
  }
  candidates.sort((a, b) => a - b);

  if (candidates.length === 1) return { instant: new Date(candidates[0]!), kind: 'unique' };

  if (candidates.length === 0) {
    // The gap. Both probes disagree, and neither instant formats back. The wall
    // time is skipped, so the honest answer is the moment the clock jumped TO —
    // which is `wall` interpreted at the offset AFTER the change.
    if (disambiguation === 'reject') {
      throw new PolicyResolutionError(
        POLICY_ERROR.nonexistentLocalTime,
        `${civilString(civil)} does not exist in ${timezone}: the clock moved forward past it.`,
        timezone,
      );
    }
    const after = wall - offsetAt(wall + DAY_MS);
    const before = wall - offsetAt(wall - DAY_MS);
    return {
      instant: new Date(
        disambiguation === 'later' ? Math.max(after, before) : Math.min(after, before),
      ),
      kind: 'gap',
    };
  }

  if (disambiguation === 'reject') {
    throw new PolicyResolutionError(
      POLICY_ERROR.ambiguousLocalTime,
      `${civilString(civil)} happens twice in ${timezone}: the clock moved back through it.`,
      timezone,
    );
  }
  return {
    instant: new Date(
      disambiguation === 'later' ? candidates[candidates.length - 1]! : candidates[0]!,
    ),
    kind: 'ambiguous',
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const civilString = (c: CivilDateTime) =>
  `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)}`;

// ---------------------------------------------------------------------------
// Integer civil arithmetic. No Date, no Intl, no timezone.
// ---------------------------------------------------------------------------

/**
 * Days since 1970-01-01, from a proleptic Gregorian civil date.
 *
 * Howard Hinnant's `days_from_civil`, which is exact for every year a library
 * will ever hold and has no `Date` object anywhere near it. This is the
 * arithmetic the 415× measurement is about.
 */
export function daysFromCivil(d: CivilDate): number {
  const y = d.month <= 2 ? d.year - 1 : d.year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (d.month + (d.month > 2 ? -3 : 9)) + 2) / 5) + d.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** The inverse. Hinnant's `civil_from_days`. */
export function civilFromDays(z: number): CivilDate {
  const zz = z + 719_468;
  const era = Math.floor((zz >= 0 ? zz : zz - 146_096) / 146_097);
  const doe = zz - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: month <= 2 ? y + 1 : y, month, day };
}

/**
 * 0 = Sunday, from a day number, with no `Date` at all.
 *
 * 1970-01-01 was a Thursday, so day 0 is weekday 4. The `+ 7` before the second
 * modulo is what makes it right for dates before 1970, where `%` in JavaScript
 * returns a negative.
 */
export function weekdayOf(days: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return (((days % 7) + 4 + 7) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/** `2026-04-12`, for comparing and for exception lookup. */
export function civilKey(d: CivilDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

/**
 * The intervals this calendar is open on one civil date.
 *
 * An exception REPLACES the weekly pattern rather than merging with it — see
 * {@link CalendarException}. Empty means closed.
 */
export function hoursOn(calendar: Calendar, date: CivilDate): readonly OpeningInterval[] {
  assertDefined(calendar, date);
  const key = civilKey(date);
  for (const e of calendar.exceptions) if (civilKey(e.date) === key) return e.intervals;
  const wd = weekdayOf(daysFromCivil(date));
  for (const d of calendar.weekly) if (d.weekday === wd) return d.intervals;
  return [];
}

/** The exception that applies on a date, if any — for the trace's `detail`. */
export function exceptionOn(calendar: Calendar, date: CivilDate) {
  const key = civilKey(date);
  return calendar.exceptions.find((e) => civilKey(e.date) === key);
}

function assertDefined(calendar: Calendar, date: CivilDate): void {
  const n = daysFromCivil(date);
  if (n < daysFromCivil(calendar.definedFrom) || n > daysFromCivil(calendar.definedTo)) {
    throw new PolicyResolutionError(
      POLICY_ERROR.calendarNotDefinedFor,
      `Calendar ${calendar.id} declares hours from ${civilKey(calendar.definedFrom)} to ` +
        `${civilKey(calendar.definedTo)} and was asked about ${civilKey(date)}. Assuming ordinary ` +
        'opening beyond that range is how a library fines a patron for a day it was shut.',
      calendar.id,
    );
  }
}

/** Is the library open at this wall-clock minute on this date? */
export function isOpenAtCivil(calendar: Calendar, date: CivilDate, minuteOfDay: number): boolean {
  for (const i of hoursOn(calendar, date)) {
    if (minuteOfDay >= i.open && minuteOfDay < i.close) return true;
  }
  return false;
}

/** Is the library open at this instant? The public, instant-taking form. */
export function isOpenAt(calendar: Calendar, instant: Date): boolean {
  const c = zonedCivil(instant, calendar.timezone);
  return isOpenAtCivil(calendar, c, c.hour * 60 + c.minute);
}

/** Any opening interval at all on this date. */
export function isOpenDay(calendar: Calendar, date: CivilDate): boolean {
  return hoursOn(calendar, date).length > 0;
}

/**
 * The next moment the library is open, at or after a given civil minute.
 *
 * RETURNS A LATER TIME ON THE SAME DAY when it can — 14:30 on a Greek split day
 * gives 17:00 that afternoon, not 08:00 tomorrow. A day-granular calendar cannot
 * express that at all, which is the whole reason {@link DayHours} holds an array.
 *
 * Bounded by {@link ROLL_HORIZON_DAYS}. A Greek library shut 10–20 August, plus
 * the weekends either side, plus Δεκαπενταύγουστος, can be closed for three
 * consecutive weeks — so a 7- or 14-day horizon refuses an ordinary summer loan.
 * Unbounded is worse: a misconfigured all-closed calendar spins the desk. 45
 * days survives August and still names a number in the refusal.
 */
export function nextOpenCivil(
  calendar: Calendar,
  from: CivilDate,
  minuteOfDay: number,
): { date: CivilDate; minuteOfDay: number } {
  let day = daysFromCivil(from);
  let minute = minuteOfDay;
  for (let i = 0; i < ROLL_HORIZON_DAYS; i += 1, day += 1, minute = 0) {
    const date = civilFromDays(day);
    for (const iv of hoursOn(calendar, date)) {
      if (minute < iv.open) return { date, minuteOfDay: iv.open };
      if (minute < iv.close) return { date, minuteOfDay: minute };
    }
  }
  throw new PolicyResolutionError(
    POLICY_ERROR.calendarExhausted,
    `Calendar ${calendar.id} has no open minute in the ${ROLL_HORIZON_DAYS} days from ` +
      `${civilKey(from)}. Check its hours and exceptions.`,
    calendar.id,
  );
}

/** The last minute the library was open, at or before a given civil minute. */
export function previousOpenCivil(
  calendar: Calendar,
  from: CivilDate,
  minuteOfDay: number,
): { date: CivilDate; minuteOfDay: number } {
  let day = daysFromCivil(from);
  let minute = minuteOfDay;
  for (let i = 0; i < ROLL_HORIZON_DAYS; i += 1, day -= 1, minute = 24 * 60) {
    const date = civilFromDays(day);
    const intervals = [...hoursOn(calendar, date)].reverse();
    for (const iv of intervals) {
      // The last instant of an interval is `close`, not `close - 1`: the
      // intervals are half-open for OPENNESS, but "the end of the open day" is
      // the closing minute itself — a book due "at closing" is due at 14:00.
      if (minute >= iv.close) return { date, minuteOfDay: iv.close };
      if (minute >= iv.open) return { date, minuteOfDay: minute };
    }
  }
  throw new PolicyResolutionError(
    POLICY_ERROR.calendarExhausted,
    `Calendar ${calendar.id} has no open minute in the ${ROLL_HORIZON_DAYS} days before ` +
      `${civilKey(from)}. Check its hours and exceptions.`,
    calendar.id,
  );
}

/** The closing minute of the last interval on a date, or null when shut. */
export function endOfOpenDay(calendar: Calendar, date: CivilDate): number | null {
  const h = hoursOn(calendar, date);
  return h.length === 0 ? null : h[h.length - 1]!.close;
}

/** The opening minute of the first interval on a date, or null when shut. */
export function startOfOpenDay(calendar: Calendar, date: CivilDate): number | null {
  const h = hoursOn(calendar, date);
  return h.length === 0 ? null : h[0]!.open;
}

/** The end of the interval covering this minute, or null if it is not open. */
export function endOfCurrentInterval(
  calendar: Calendar,
  date: CivilDate,
  minuteOfDay: number,
): number | null {
  for (const i of hoursOn(calendar, date)) {
    if (minuteOfDay >= i.open && minuteOfDay < i.close) return i.close;
  }
  return null;
}

/**
 * OPEN days in `[from, to)`, counted as CALENDAR days in the library's timezone.
 *
 * This is the circ-5 fix expressed as a function. `Math.floor((b - a) / 864e5)`
 * counts whole 24-hour blocks since an instant, so a book due at 09:00 and
 * brought back at 08:00 two days later counts as one day overdue — and every DST
 * change shifts the boundary by an hour for the rest of the year.
 *
 * Counting DAY NUMBERS in the branch's zone gives the answer the librarian
 * holding the book would give. `countClosed: false` then removes the days the
 * patron could not have returned it, which is what makes a three-week August
 * closure fair rather than expensive.
 *
 * Half-open: the due DAY itself is not overdue, the day after is the first.
 */
export function openDaysBetween(
  calendar: Calendar,
  from: Date,
  to: Date,
  opts: { countClosed: boolean },
): number {
  const a = daysFromCivil(zonedCivil(from, calendar.timezone));
  const b = daysFromCivil(zonedCivil(to, calendar.timezone));
  if (b <= a) return 0;
  if (opts.countClosed) return b - a;
  let n = 0;
  for (let d = a + 1; d <= b; d += 1) if (isOpenDay(calendar, civilFromDays(d))) n += 1;
  return n;
}

/** Calendar days in `[from, to)` in this zone, closed days included. */
export function calendarDaysBetween(timezone: string, from: Date, to: Date): number {
  const a = daysFromCivil(zonedCivil(from, timezone));
  const b = daysFromCivil(zonedCivil(to, timezone));
  return Math.max(0, b - a);
}
