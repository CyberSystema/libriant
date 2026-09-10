import assert from 'node:assert/strict';
import test from 'node:test';
import { zonedCivil } from './calendar.js';
import { addDuration, computeDueDate, computeRenewalDueDate } from './duedate.js';
import { POLICY_ERROR, type Calendar, type LoanPolicy } from './types.js';

const TZ = 'Europe/Athens';

const ALWAYS: Calendar = {
  id: 'always',
  timezone: TZ,
  weekly: Array.from({ length: 7 }, (_, weekday) => ({
    weekday: weekday as 0,
    intervals: [{ open: 0, close: 1440 }],
  })),
  exceptions: [],
  definedFrom: { year: 2025, month: 1, day: 1 },
  definedTo: { year: 2027, month: 12, day: 31 },
};

/** Mon–Fri 08:00–14:00 + 17:00–21:00, Sat 09:00–13:00, Sun closed. */
const SPLIT: Calendar = {
  ...ALWAYS,
  id: 'split',
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
};

const BASE: LoanPolicy = {
  id: 'lp',
  name: 'test',
  loanable: true,
  profile: 'rolling',
  period: { value: 14, unit: 'days' },
  fixedDueDateSetId: null,
  dueTimeOfDay: null,
  closedDayHandling: 'keep',
  openingTimeOffset: null,
  maxPeriod: null,
  renewable: true,
  renewalsAllowed: 2,
  renewalPeriod: null,
  renewFrom: 'currentDueDate',
  noRenewalBefore: null,
  noRenewalBeforeRelativeTo: 'dueDate',
  renewWithOutstandingHolds: true,
  alternateCheckoutPeriodWithHolds: null,
  alternateRenewalPeriodWithHolds: null,
  itemLimitForPolicy: null,
};

const due = (p: Partial<LoanPolicy>, from: string, calendar = ALWAYS, extra = {}) =>
  computeDueDate({ policy: { ...BASE, ...p }, calendar, from: new Date(from), ...extra });

test('THE ACCEPTANCE CASE: a 2-hour loan starting 01:30 on a spring-forward night', () => {
  // 01:30 Athens is 23:30Z the previous day. Two ELAPSED hours later is 01:30Z,
  // which is 04:30 local — because 03:30 never happened. Not 03:30, which is a
  // due time that does not exist, and not 02:30, which would be ninety minutes.
  const r = due({ period: { value: 2, unit: 'hours' } }, '2026-03-28T23:30:00Z');
  assert.equal(r.dueAt!.toISOString(), '2026-03-29T01:30:00.000Z');
  assert.deepEqual(zonedCivil(r.dueAt!, TZ), {
    year: 2026,
    month: 3,
    day: 29,
    hour: 4,
    minute: 30,
    second: 0,
  });
});

test('days are CIVIL, so the wall-clock time survives a DST change', () => {
  // Fourteen days from 12:00 local is 12:00 local, and one hour LESS elapsed
  // time because the clock went forward in between. That is what a library means
  // by "two weeks", and `from + 14 * 86_400_000` would give 11:00.
  const r = due({}, '2026-03-20T10:00:00Z'); // 12:00 Athens, EET
  assert.deepEqual(zonedCivil(r.dueAt!, TZ), {
    year: 2026,
    month: 4,
    day: 3,
    hour: 12,
    minute: 0,
    second: 0,
  });
  assert.equal(
    r.dueAt!.getTime() - Date.parse('2026-03-20T10:00:00Z'),
    14 * 86_400_000 - 3_600_000,
  );
});

test('hours are ELAPSED, so the same crossing gives one hour less wall clock', () => {
  const r = due({ period: { value: 336, unit: 'hours' } }, '2026-03-20T10:00:00Z');
  assert.equal(r.dueAt!.getTime() - Date.parse('2026-03-20T10:00:00Z'), 336 * 3_600_000);
  assert.deepEqual(zonedCivil(r.dueAt!, TZ).hour, 13, 'the wall clock moved instead');
});

test('dueTimeOfDay replaces the time, so "two weeks" is not "at 14:37"', () => {
  const r = due({ dueTimeOfDay: { hour: 21, minute: 0 } }, '2026-05-05T11:37:00Z');
  assert.deepEqual(zonedCivil(r.dueAt!, TZ), {
    year: 2026,
    month: 5,
    day: 19,
    hour: 21,
    minute: 0,
    second: 0,
  });
});

test('months clamp at the end, so 31 January plus one is 28 February', () => {
  const r = due({ period: { value: 1, unit: 'months' } }, '2026-01-31T09:00:00Z');
  const c = zonedCivil(r.dueAt!, TZ);
  assert.equal(c.month, 2);
  assert.equal(c.day, 28, 'not 3 March');
});

test('an indefinite loan has no due date, and no sentinel one either', () => {
  const r = due({ profile: 'indefinite', period: null }, '2026-05-05T09:00:00Z');
  assert.equal(r.dueAt, null);
});

test('a hold shortens the loan, and the trace says so', () => {
  const r = due(
    { alternateCheckoutPeriodWithHolds: { value: 7, unit: 'days' } },
    '2026-05-05T09:00:00Z',
    ALWAYS,
    { hasOutstandingHold: true },
  );
  assert.equal(zonedCivil(r.dueAt!, TZ).day, 12);
  assert.deepEqual(
    r.rolls.map((x) => x.reason),
    ['holdShortened'],
  );
  assert.match(r.rolls[0]!.detail!, /unfilled hold/);
});

test('maxPeriod caps, and names itself', () => {
  const r = due(
    { period: { value: 3, unit: 'weeks' }, maxPeriod: { value: 10, unit: 'days' } },
    '2026-05-05T09:00:00Z',
  );
  assert.equal(zonedCivil(r.dueAt!, TZ).day, 15);
  assert.deepEqual(
    r.rolls.map((x) => x.reason),
    ['maxPeriodCap'],
  );
});

test('THE PHASE-25 CASE: a 2-hour in-library loan on a Greek split day', () => {
  // Started 13:30, the naive due is 15:30 — when the desk is shut, between the
  // 08:00–14:00 and 17:00–21:00 sessions. `endOfCurrentOpenHours` measures from
  // the loan START, so it is due at 14:00 when the librarian expects it back.
  // Never 15:30, and never 17:00 either, which would have the patron holding a
  // reference book through the afternoon closure.
  const r = due(
    { period: { value: 2, unit: 'hours' }, closedDayHandling: 'endOfCurrentOpenHours' },
    '2026-06-03T10:30:00Z', // Wednesday 13:30 Athens
    SPLIT,
  );
  assert.deepEqual(zonedCivil(r.dueAt!, TZ), {
    year: 2026,
    month: 6,
    day: 3,
    hour: 14,
    minute: 0,
    second: 0,
  });
  assert.deepEqual(
    r.rolls.map((x) => x.reason),
    ['closedHours'],
  );
});

test('an in-library loan that fits inside the session is not moved', () => {
  const r = due(
    { period: { value: 2, unit: 'hours' }, closedDayHandling: 'endOfCurrentOpenHours' },
    '2026-06-03T06:00:00Z', // 09:00 Athens, due 11:00, well inside
    SPLIT,
  );
  assert.deepEqual(zonedCivil(r.dueAt!, TZ).hour, 11);
  assert.deepEqual(r.rolls, []);
});

test('a due date on a closed day rolls to the next opening', () => {
  // 2026-05-31 is a Sunday. Fourteen days from 17 May lands on it.
  const r = due({ closedDayHandling: 'startOfNextOpenDay' }, '2026-05-17T09:00:00Z', SPLIT);
  assert.deepEqual(zonedCivil(r.dueAt!, TZ), {
    year: 2026,
    month: 6,
    day: 1,
    hour: 8,
    minute: 0,
    second: 0,
  });
  assert.deepEqual(
    r.rolls.map((x) => x.reason),
    ['closedDay'],
  );
});

test('a roll onto a named holiday says which one', () => {
  const withFeast: Calendar = {
    ...SPLIT,
    exceptions: [
      { date: { year: 2026, month: 6, day: 1 }, intervals: [], name: 'Αγίου Πνεύματος' },
    ],
  };
  const r = due({ closedDayHandling: 'startOfNextOpenDay' }, '2026-05-17T09:00:00Z', withFeast);
  // Sunday 31 May is shut and Monday 1 June is Holy Spirit, so it lands on the
  // Tuesday — and the trace names the feast rather than saying "closed".
  assert.deepEqual(zonedCivil(r.dueAt!, TZ).day, 2);
  assert.equal(r.rolls[0]!.reason, 'closedDay');
});

test('endOfPreviousOpenDay pulls back instead of forward', () => {
  const r = due({ closedDayHandling: 'endOfPreviousOpenDay' }, '2026-05-17T09:00:00Z', SPLIT);
  // Back to Saturday 30 May, 13:00 — the close of the only Saturday interval.
  assert.deepEqual(zonedCivil(r.dueAt!, TZ), {
    year: 2026,
    month: 5,
    day: 30,
    hour: 13,
    minute: 0,
    second: 0,
  });
});

test('openingTimeOffset avoids a queue of returns at the door', () => {
  const r = due(
    { closedDayHandling: 'startOfNextOpenDay', openingTimeOffset: { value: 1, unit: 'hours' } },
    '2026-05-17T09:00:00Z',
    SPLIT,
  );
  assert.deepEqual(zonedCivil(r.dueAt!, TZ).hour, 9);
  assert.deepEqual(
    r.rolls.map((x) => x.reason),
    ['closedDay', 'openingOffset'],
  );
});

test('a fixed due date comes from the term, and refuses outside every term', () => {
  const set = {
    id: 'fdd',
    name: 'Academic year 2026',
    ranges: [
      {
        from: { year: 2026, month: 9, day: 15 },
        to: { year: 2026, month: 12, day: 20 },
        dueDate: { year: 2026, month: 12, day: 21 },
        dueTimeOfDay: { hour: 17, minute: 0 },
      },
    ],
  };
  const inTerm = computeDueDate({
    policy: { ...BASE, profile: 'fixed', period: null, fixedDueDateSetId: 'fdd' },
    calendar: ALWAYS,
    from: new Date('2026-10-01T09:00:00Z'),
    fixedDueDateSet: set,
  });
  assert.deepEqual(zonedCivil(inTerm.dueAt!, TZ), {
    year: 2026,
    month: 12,
    day: 21,
    hour: 17,
    minute: 0,
    second: 0,
  });
  assert.deepEqual(
    inTerm.rolls.map((x) => x.reason),
    ['fixedDueDate'],
  );

  // FOLIO silently falls back to rolling here, so a semester loan taken the day
  // after term ends gets an arbitrary date. Refusing is the point of §4.1.
  assert.throws(
    () =>
      computeDueDate({
        policy: { ...BASE, profile: 'fixed', period: null, fixedDueDateSetId: 'fdd' },
        calendar: ALWAYS,
        from: new Date('2027-02-01T09:00:00Z'),
        fixedDueDateSet: set,
      }),
    (e: { code?: string }) => e.code === POLICY_ERROR.noFixedDueDateRange,
  );
});

test('a rolling policy with no period refuses rather than guessing', () => {
  assert.throws(
    () => due({ period: null }, '2026-05-05T09:00:00Z'),
    (e: { code?: string }) => e.code === POLICY_ERROR.policyIncomplete,
  );
});

test('renewFrom decides whether an overdue renewal starts today or from the past', () => {
  const from = new Date('2026-06-01T09:00:00Z');
  const currentDueAt = new Date('2026-05-20T09:00:00Z'); // already twelve days overdue
  const fromDue = computeRenewalDueDate({
    policy: { ...BASE, renewFrom: 'currentDueDate' },
    calendar: ALWAYS,
    from,
    currentDueAt,
  });
  const fromNow = computeRenewalDueDate({
    policy: { ...BASE, renewFrom: 'systemDate' },
    calendar: ALWAYS,
    from,
    currentDueAt,
  });
  assert.equal(zonedCivil(fromDue.dueAt!, TZ).day, 3, 'fourteen days from the old due date');
  assert.equal(zonedCivil(fromNow.dueAt!, TZ).day, 15, 'fourteen days from today');
});

test('addDuration is exported, because phase 13 needs the same arithmetic', () => {
  const t = addDuration(TZ, new Date('2026-05-05T09:00:00Z'), { value: 3, unit: 'days' }, null);
  assert.equal(zonedCivil(t, TZ).day, 8);
});

test('a renewal uses the RENEWAL period, and the hold variant of it', () => {
  // Both of these were silently ignored until phase 17: `computeRenewalDueDate`
  // chose a period and then handed `computeDueDate` the untouched policy, which
  // re-derived the CHECKOUT period from the same fields. Every vector has
  // `renewalPeriod: null`, so nothing caught it.
  const from = new Date('2026-06-01T09:00:00Z');
  const currentDueAt = new Date('2026-06-01T09:00:00Z');
  const policy = {
    ...BASE,
    renewFrom: 'systemDate' as const,
    period: { value: 14, unit: 'days' as const },
    renewalPeriod: { value: 7, unit: 'days' as const },
    alternateCheckoutPeriodWithHolds: { value: 3, unit: 'days' as const },
    alternateRenewalPeriodWithHolds: { value: 2, unit: 'days' as const },
  };
  const plain = computeRenewalDueDate({ policy, calendar: ALWAYS, from, currentDueAt });
  assert.equal(zonedCivil(plain.dueAt!, TZ).day, 8, 'seven days, not fourteen');

  const withHold = computeRenewalDueDate({
    policy,
    calendar: ALWAYS,
    from,
    currentDueAt,
    hasOutstandingHold: true,
  });
  // Two days, from `alternateRenewalPeriodWithHolds` — NOT three, which is the
  // checkout variant, and not two-then-shortened-again.
  assert.equal(zonedCivil(withHold.dueAt!, TZ).day, 3);

  // A checkout of the same policy still gets the checkout numbers.
  const checkout = computeDueDate({ policy, calendar: ALWAYS, from, hasOutstandingHold: true });
  assert.equal(zonedCivil(checkout.dueAt!, TZ).day, 4, 'three days for a checkout with a hold');
});
