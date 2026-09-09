import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROLL_HORIZON_DAYS,
  calendarDaysBetween,
  civilFromDays,
  daysFromCivil,
  endOfOpenDay,
  hoursOn,
  instantFromCivil,
  isOpenAt,
  isOpenAtCivil,
  nextOpenCivil,
  openDaysBetween,
  previousOpenCivil,
  startOfOpenDay,
  weekdayOf,
  zonedCivil,
} from './calendar.js';
import { POLICY_ERROR, type Calendar } from './types.js';

const TZ = 'Europe/Athens';

/** Mon–Fri 08:00–14:00 + 17:00–21:00, Sat 09:00–13:00, Sun closed. */
const SPLIT: Calendar = {
  id: 'split',
  timezone: TZ,
  weekly: [
    { weekday: 0, intervals: [] },
    ...([1, 2, 3, 4, 5] as const).map((weekday) => ({
      weekday,
      intervals: [
        { open: 480, close: 840 },
        { open: 1020, close: 1260 },
      ],
    })),
    { weekday: 6, intervals: [{ open: 540, close: 780 }] },
  ],
  exceptions: [
    { date: { year: 2026, month: 8, day: 15 }, intervals: [], name: 'Κοίμηση της Θεοτόκου' },
  ],
  definedFrom: { year: 2025, month: 1, day: 1 },
  definedTo: { year: 2027, month: 12, day: 31 },
};

test('civil arithmetic agrees with the calendar everyone knows', () => {
  assert.equal(daysFromCivil({ year: 1970, month: 1, day: 1 }), 0);
  assert.equal(weekdayOf(0), 4, '1970-01-01 was a Thursday');
  assert.deepEqual(civilFromDays(0), { year: 1970, month: 1, day: 1 });
  // Round-trips over a long span, including leap days and century boundaries.
  for (const d of [
    { year: 1900, month: 3, day: 1 },
    { year: 2000, month: 2, day: 29 },
    { year: 2100, month: 1, day: 1 },
  ]) {
    assert.deepEqual(civilFromDays(daysFromCivil(d)), d, JSON.stringify(d));
  }
  // Before 1970, where a `%` that forgets JavaScript returns negatives breaks.
  assert.equal(weekdayOf(daysFromCivil({ year: 1969, month: 12, day: 31 })), 3, 'a Wednesday');
});

test('the Athens DST edges, both directions', () => {
  // Read straight off Intl: 2026-03-29 local 03:00–03:59 does not exist, and
  // 2026-10-25 local 03:00–03:59 happens twice.
  assert.deepEqual(zonedCivil(new Date('2026-03-29T00:59:00Z'), TZ), {
    year: 2026,
    month: 3,
    day: 29,
    hour: 2,
    minute: 59,
    second: 0,
  });
  assert.deepEqual(zonedCivil(new Date('2026-03-29T01:00:00Z'), TZ), {
    year: 2026,
    month: 3,
    day: 29,
    hour: 4,
    minute: 0,
    second: 0,
  });
});

test('a wall time that happens twice returns BOTH, and the later by default', () => {
  // THE MEASURED BUG the ±24-hour probe exists to avoid: the obvious algorithm
  // — probe at the wall guess, re-probe at `wall - offset` — converges to
  // 01:30Z and never sees 00:30Z, and is therefore wrong for exactly one hour a
  // year.
  const civil = { year: 2026, month: 10, day: 25, hour: 3, minute: 30, second: 0 };
  const earlier = instantFromCivil(TZ, civil, 'earlier');
  const later = instantFromCivil(TZ, civil, 'later');
  assert.equal(earlier.kind, 'ambiguous');
  assert.equal(earlier.instant.toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(later.instant.toISOString(), '2026-10-25T01:30:00.000Z');
  // The default gives the patron more time.
  assert.equal(instantFromCivil(TZ, civil).instant.toISOString(), later.instant.toISOString());
});

test('a wall time that does not exist is named, and refused when asked', () => {
  const civil = { year: 2026, month: 3, day: 29, hour: 3, minute: 30, second: 0 };
  const got = instantFromCivil(TZ, civil);
  assert.equal(got.kind, 'gap');
  // 01:30Z is local 04:30 — past the gap, which is the more generous reading.
  assert.equal(got.instant.toISOString(), '2026-03-29T01:30:00.000Z');
  assert.throws(
    () => instantFromCivil(TZ, civil, 'reject'),
    (e: { code?: string }) => e.code === POLICY_ERROR.nonexistentLocalTime,
  );
});

test('the Greek split day: shut at 14:30, open again at 17:00 THE SAME DAY', () => {
  // A day-granular calendar cannot express this at all, which is why DayHours
  // holds an array. Koha's and FOLIO's calendar UIs both fight it.
  const wed = { year: 2026, month: 6, day: 3 };
  assert.equal(isOpenAtCivil(SPLIT, wed, 7 * 60 + 59), false);
  assert.equal(isOpenAtCivil(SPLIT, wed, 8 * 60), true);
  assert.equal(isOpenAtCivil(SPLIT, wed, 13 * 60 + 59), true);
  assert.equal(isOpenAtCivil(SPLIT, wed, 14 * 60), false, 'half-open: shut AT 14:00');
  assert.equal(isOpenAtCivil(SPLIT, wed, 15 * 60 + 30), false);
  assert.equal(isOpenAtCivil(SPLIT, wed, 17 * 60), true);
  assert.equal(isOpenAtCivil(SPLIT, wed, 21 * 60), false);

  const next = nextOpenCivil(SPLIT, wed, 14 * 60 + 30);
  assert.deepEqual(next.date, wed, 'the same day, not tomorrow');
  assert.equal(next.minuteOfDay, 17 * 60);

  assert.equal(startOfOpenDay(SPLIT, wed), 8 * 60);
  assert.equal(endOfOpenDay(SPLIT, wed), 21 * 60, 'the END of the day is 21:00, not 14:00');
});

test('a named exception closes the day and replaces the weekly pattern', () => {
  const feast = { year: 2026, month: 8, day: 15 };
  assert.deepEqual(hoursOn(SPLIT, feast), []);
  // 15 August 2026 is a Saturday; the next open minute is Monday morning.
  const next = nextOpenCivil(SPLIT, feast, 0);
  assert.deepEqual(next.date, { year: 2026, month: 8, day: 17 });
  assert.equal(next.minuteOfDay, 8 * 60);
});

test('previousOpen finds the last minute the library was open', () => {
  // Sunday: back to Saturday 13:00, the close of the only interval.
  const sun = { year: 2026, month: 6, day: 7 };
  const prev = previousOpenCivil(SPLIT, sun, 12 * 60);
  assert.deepEqual(prev.date, { year: 2026, month: 6, day: 6 });
  assert.equal(prev.minuteOfDay, 13 * 60);
});

test('a calendar refuses a date outside its declared coverage', () => {
  // Assuming "open, ordinary hours" beyond the defined range is how a library
  // fines a patron for a day it was shut.
  assert.throws(
    () => hoursOn(SPLIT, { year: 2030, month: 1, day: 1 }),
    (e: { code?: string }) => e.code === POLICY_ERROR.calendarNotDefinedFor,
  );
});

test('an all-closed calendar refuses rather than spinning', () => {
  const shut: Calendar = {
    ...SPLIT,
    id: 'shut',
    weekly: Array.from({ length: 7 }, (_, weekday) => ({ weekday: weekday as 0, intervals: [] })),
    exceptions: [],
  };
  assert.throws(
    () => nextOpenCivil(shut, { year: 2026, month: 6, day: 1 }, 0),
    (e: { code?: string; message: string }) =>
      e.code === POLICY_ERROR.calendarExhausted && e.message.includes(String(ROLL_HORIZON_DAYS)),
  );
});

test('the horizon survives a three-week Greek August closure', () => {
  // 10–20 August shut, plus the weekends either side, plus Δεκαπενταύγουστος: a
  // 7- or 14-day horizon would refuse an ordinary summer loan.
  const august: Calendar = {
    ...SPLIT,
    exceptions: Array.from({ length: 20 }, (_, i) => ({
      date: { year: 2026, month: 8, day: 3 + i },
      intervals: [],
      name: 'Θερινή διακοπή',
    })),
  };
  const next = nextOpenCivil(august, { year: 2026, month: 8, day: 3 }, 0);
  assert.deepEqual(next.date, { year: 2026, month: 8, day: 24 });
});

test('openDaysBetween counts CALENDAR days, which is the circ-5 fix', () => {
  // 1.0 computes days overdue as `Math.floor((now - dueAt) / 86_400_000)` —
  // whole 24-hour blocks since an instant. A book due at 09:00 and returned at
  // 08:00 two days later is "1 day overdue" under that arithmetic and two days
  // overdue to the librarian holding it. There is a comment in
  // `loans.service.ts` naming the finding.
  const due = new Date('2026-06-01T06:00:00Z'); // Monday 09:00 Athens
  const back = new Date('2026-06-03T05:00:00Z'); // Wednesday 08:00 Athens
  const naive = Math.floor((back.getTime() - due.getTime()) / 86_400_000);
  assert.equal(naive, 1, 'what 1.0 charges');
  assert.equal(calendarDaysBetween(TZ, due, back), 2, 'what the librarian would say');
  assert.equal(openDaysBetween(SPLIT, due, back, { countClosed: true }), 2);
});

test('closed days can be excluded, which is what makes August fair', () => {
  // Friday to the following Monday: three calendar days, but the library was
  // shut on the Sunday.
  const fri = new Date('2026-06-05T06:00:00Z');
  const mon = new Date('2026-06-08T06:00:00Z');
  assert.equal(openDaysBetween(SPLIT, fri, mon, { countClosed: true }), 3);
  assert.equal(
    openDaysBetween(SPLIT, fri, mon, { countClosed: false }),
    2,
    'Sunday does not count',
  );
});

test('isOpenAt takes an instant and answers in the branch timezone', () => {
  // 2026-06-03 is a Wednesday. 11:00Z is 14:00 Athens — shut.
  assert.equal(isOpenAt(SPLIT, new Date('2026-06-03T09:00:00Z')), true, '12:00 Athens');
  assert.equal(isOpenAt(SPLIT, new Date('2026-06-03T11:00:00Z')), false, '14:00 Athens');
  assert.equal(isOpenAt(SPLIT, new Date('2026-06-03T15:00:00Z')), true, '18:00 Athens');
});
