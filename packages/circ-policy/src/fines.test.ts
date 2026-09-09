import assert from 'node:assert/strict';
import test from 'node:test';
import { accrueOverdue, computeLostItemFee, computeSuspensionDays } from './fines.js';
import {
  POLICY_ERROR,
  type Calendar,
  type LostItemFeePolicy,
  type OverdueFinePolicy,
} from './types.js';

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

/** Mon–Fri only, so a weekend is genuinely closed. */
const WEEKDAYS: Calendar = {
  ...ALWAYS,
  id: 'weekdays',
  weekly: [
    { weekday: 0, intervals: [] },
    ...([1, 2, 3, 4, 5] as const).map((weekday) => ({
      weekday,
      intervals: [{ open: 540, close: 1020 }],
    })),
    { weekday: 6, intervals: [] },
  ],
};

const BASE: OverdueFinePolicy = {
  id: 'fp',
  name: 'test',
  interval: { value: 1, unit: 'days' },
  amountPerInterval: { minorUnits: 20, currency: 'EUR' },
  chargeAt: 'intervalEnd',
  gracePeriod: null,
  graceSuppressesNotice: false,
  countClosedDays: true,
  maximumFine: null,
  minimumFine: null,
  capAtReplacementCost: false,
  forgiveOn: [],
  suspension: null,
};

const owed = (
  p: Partial<OverdueFinePolicy>,
  dueAt: string,
  asOf: string,
  calendar = ALWAYS,
  extra = {},
) =>
  accrueOverdue({
    policy: { ...BASE, ...p },
    calendar,
    dueAt: new Date(dueAt),
    asOf: new Date(asOf),
    ...extra,
  });

test('nothing is owed before the due date', () => {
  const r = owed({}, '2026-05-05T12:00:00Z', '2026-05-05T11:00:00Z');
  assert.equal(r.amount.amount, 0n);
  assert.equal(r.intervals, 0);
});

test('GRACE (1): inside the window costs nothing', () => {
  const r = owed(
    { gracePeriod: { value: 3, unit: 'days' } },
    '2026-05-05T12:00:00Z',
    '2026-05-07T12:00:00Z',
  );
  assert.equal(r.amount.amount, 0n);
  assert.equal(r.withinGrace, true);
});

test('GRACE (2): outside it, the fine is measured from dueAt — not from the end of grace', () => {
  // THE PROPERTY LIBRARIES MISCONFIGURE AND AUDITORS CATCH. Five days late with
  // three days' grace costs FIVE days, not two. It is invisible in every test
  // where the item comes back inside grace, which is why it needs its own.
  const r = owed(
    { gracePeriod: { value: 3, unit: 'days' } },
    '2026-05-05T12:00:00Z',
    '2026-05-10T12:00:00Z',
  );
  assert.equal(r.intervals, 5, 'five, not two');
  assert.equal(r.amount.amount, 100n);
  assert.equal(r.withinGrace, false);
});

test('GRACE (3): the end of grace is computable at CHECKOUT', () => {
  // `loans.grace_period_ends_at` is a stored column, so the value has to exist
  // before anything is returned.
  const r = owed(
    { gracePeriod: { value: 3, unit: 'days' } },
    '2026-05-05T12:00:00Z',
    '2026-05-05T12:00:00Z',
  );
  assert.equal(r.graceEndsAt!.toISOString(), '2026-05-08T12:00:00.000Z');
});

test('a day-granular fine counts CALENDAR days in the library timezone', () => {
  // circ-5 again: due 09:00 Athens, back 08:00 two days later. Whole-24-hour
  // arithmetic says one day; the librarian holding the book says two.
  const r = owed({}, '2026-06-01T06:00:00Z', '2026-06-03T05:00:00Z');
  assert.equal(r.intervals, 2);
  assert.equal(r.amount.amount, 40n);
});

test('closed days can be excluded, which is the fair answer to a Greek August', () => {
  // Friday to the following Monday: three calendar days, one of them a weekend
  // the patron could not have returned it on.
  const closedCount = owed({}, '2026-06-05T06:00:00Z', '2026-06-08T06:00:00Z', WEEKDAYS);
  const openOnly = owed(
    { countClosedDays: false },
    '2026-06-05T06:00:00Z',
    '2026-06-08T06:00:00Z',
    WEEKDAYS,
  );
  assert.equal(closedCount.intervals, 3);
  assert.equal(openOnly.intervals, 1, 'only the Monday');
});

test('chargeAt decides whether one minute late costs a whole day', () => {
  const atEnd = owed({}, '2026-05-05T12:00:00Z', '2026-05-05T12:01:00Z');
  const atStart = owed(
    { chargeAt: 'intervalStart' },
    '2026-05-05T12:00:00Z',
    '2026-05-05T12:01:00Z',
  );
  assert.equal(atEnd.amount.amount, 0n, 'free until the first whole day passes');
  assert.equal(atStart.amount.amount, 20n, 'a day the moment the day starts');
});

test('hourly fines are ELAPSED time and take no calendar at all', () => {
  // A library that closed in between did not stop the hour passing.
  const r = owed(
    {
      interval: { value: 1, unit: 'hours' },
      amountPerInterval: { minorUnits: 50, currency: 'EUR' },
    },
    '2026-05-05T12:00:00Z',
    '2026-05-05T16:30:00Z',
    WEEKDAYS,
  );
  assert.equal(r.intervals, 4);
  assert.equal(r.amount.amount, 200n);
});

test('NOTHING IS ROUNDED, because nothing fractional is ever charged', () => {
  // `@libriant/shared/money`'s multiplyRounded is HALF TO EVEN — €0.025 becomes
  // €0.02 and €0.075 becomes €0.08 — which is right for a ledger and disagrees
  // with the librarian's spreadsheet on exactly the values a patron queries.
  // A fine is rate × completed intervals, an integer times an integer, so there
  // is no fraction for the two to disagree about and the Rust i64 mirror is
  // trivially identical.
  const r = owed(
    {
      amountPerInterval: { minorUnits: 25, currency: 'EUR' },
      interval: { value: 2, unit: 'days' },
    },
    '2026-05-05T12:00:00Z',
    '2026-05-12T12:00:00Z',
  );
  // Seven days, two-day intervals: three complete, and the seventh day is not
  // charged as half an interval.
  assert.equal(r.intervals, 3);
  assert.equal(r.amount.amount, 75n);
});

test('the maximum caps the TOTAL, not the increment', () => {
  const first = owed(
    { maximumFine: { minorUnits: 500, currency: 'EUR' } },
    '2026-01-05T12:00:00Z',
    '2026-04-05T12:00:00Z',
  );
  assert.equal(first.amount.amount, 500n);
  assert.equal(first.cappedBy, 'maximumFine');
  // An increment run by the accrual sweep must respect what has been charged
  // already, or a nightly job charges the cap every night.
  const more = owed(
    { maximumFine: { minorUnits: 500, currency: 'EUR' } },
    '2026-01-05T12:00:00Z',
    '2026-04-06T12:00:00Z',
    ALWAYS,
    {
      since: new Date('2026-04-05T12:00:00Z'),
      alreadyCharged: { minorUnits: 500, currency: 'EUR' },
    },
  );
  assert.equal(more.amount.amount, 0n);
});

test('it is RESUMABLE, because fees.accrued_through exists', () => {
  const whole = owed({}, '2026-05-05T12:00:00Z', '2026-05-15T12:00:00Z');
  const firstHalf = owed({}, '2026-05-05T12:00:00Z', '2026-05-10T12:00:00Z');
  const secondHalf = owed({}, '2026-05-05T12:00:00Z', '2026-05-15T12:00:00Z', ALWAYS, {
    since: new Date('2026-05-10T12:00:00Z'),
  });
  // The sweep charges the difference; the two paths must add up, or a fee grows
  // or shrinks depending on how often the job ran.
  assert.equal(firstHalf.amount.amount + secondHalf.amount.amount, whole.amount.amount);
});

test('a minimum is a floor on a charge, never a charge on a non-overdue item', () => {
  const late = owed(
    { minimumFine: { minorUnits: 100, currency: 'EUR' } },
    '2026-05-05T12:00:00Z',
    '2026-05-06T12:00:00Z',
  );
  const ontime = owed(
    { minimumFine: { minorUnits: 100, currency: 'EUR' } },
    '2026-05-05T12:00:00Z',
    '2026-05-05T10:00:00Z',
  );
  assert.equal(late.amount.amount, 100n, 'raised from 20c');
  assert.equal(ontime.amount.amount, 0n, 'not everyone pays');
});

test('suspension days are computed here; phase 14 writes the row', () => {
  // Continental and Greek libraries frequently suspend borrowing INSTEAD of
  // charging, and an ILS that models only cash cannot express their policy.
  const policy: OverdueFinePolicy = {
    ...BASE,
    suspension: { daysPerOverdueDay: 2, maxDays: 30, resetOnReturn: true },
  };
  assert.equal(
    computeSuspensionDays(
      policy,
      ALWAYS,
      new Date('2026-05-05T12:00:00Z'),
      new Date('2026-05-12T12:00:00Z'),
    ),
    14,
  );
  assert.equal(
    computeSuspensionDays(
      policy,
      ALWAYS,
      new Date('2026-01-05T12:00:00Z'),
      new Date('2026-05-12T12:00:00Z'),
    ),
    30,
    'capped',
  );
});

const LOST: LostItemFeePolicy = {
  id: 'lf',
  name: 'test',
  chargeBasis: 'replacementPrice',
  fixedAmount: null,
  processingFee: { minorUnits: 500, currency: 'EUR' },
  agedToLostAfter: { value: 30, unit: 'days' },
  refundReplacementOnReturn: true,
  refundProcessingFeeOnReturn: false,
  refundWindow: { value: 90, unit: 'days' },
  stopOverdueAccrualOnLost: true,
  chargeOverdueUpToLost: true,
};

test('a lost item keeps the book and the admin charge separate', () => {
  // Which is what makes "refund the book, keep the admin fee" expressible. Koha
  // conflates them and libraries write manual credits to get the same effect.
  const r = computeLostItemFee({
    policy: LOST,
    replacementPrice: { minorUnits: 1850, currency: 'EUR' },
  });
  assert.equal(r.replacement.amount, 1850n);
  assert.equal(r.processing.amount, 500n);
  assert.equal(r.total.amount, 2350n);
});

test('a replacement-price basis on an item with no price REFUSES', () => {
  // Charging zero would be a library silently writing a book off; charging a
  // guess would be billing a patron for a number nobody chose.
  assert.throws(
    () => computeLostItemFee({ policy: LOST }),
    (e: { code?: string }) => e.code === POLICY_ERROR.noReplacementPrice,
  );
});

test('a total across two currencies is refused rather than added', () => {
  assert.throws(
    () =>
      computeLostItemFee({ policy: LOST, replacementPrice: { minorUnits: 1850, currency: 'GBP' } }),
    (e: { code?: string }) => e.code === POLICY_ERROR.policyIncomplete,
  );
});
