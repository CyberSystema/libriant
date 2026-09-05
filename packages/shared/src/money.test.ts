/**
 * Money tests. Run from `packages/shared`: node --import tsx --test.
 *
 * The properties here are the ones a fee ledger is reconciled against every
 * night. If `allocate` can lose a minor unit, the nightly reconciler alarms on
 * drift the code created itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENCY_CODES,
  CURRENCY_MINOR_UNITS,
  ICU_CASH_ROUNDING,
  isCurrencyCode,
  minorUnitsFor,
} from './currencies.js';
import {
  addMoney,
  allocate,
  allocateMoney,
  compareMoney,
  formatMoney,
  money,
  multiplyRounded,
  parseMoney,
  subtractMoney,
  sumMoney,
  toDecimalString,
  zeroMoney,
} from './money.js';

// --------------------------------------------------------------------------
// Allocation — the property the ledger depends on
// --------------------------------------------------------------------------

test('allocate splits to the cent with no residue', () => {
  assert.deepEqual(allocate(1250n, [1, 1, 1]), [417n, 417n, 416n]);
  assert.equal(
    allocate(1250n, [1, 1, 1]).reduce((a, b) => a + b, 0n),
    1250n,
  );
  assert.deepEqual(allocate(100n, [60, 40]), [60n, 40n]);
  assert.deepEqual(allocate(1n, [1, 1, 1]), [1n, 0n, 0n], 'the odd unit goes to the first');
  assert.deepEqual(allocate(0n, [1, 1]), [0n, 0n]);
  assert.deepEqual(allocate(7n, [1]), [7n]);
});

test('a refund splits exactly as the charge it reverses did', () => {
  // Truncation toward zero runs the opposite way for negatives, so a naive
  // implementation refunds 417/417/416 against a charge of 416/417/417 and
  // leaves a cent behind on two accounts.
  const charge = allocate(1250n, [1, 1, 1]);
  const refund = allocate(-1250n, [1, 1, 1]);
  assert.deepEqual(
    refund,
    charge.map((c) => -c),
  );
  assert.equal(
    refund.reduce((a, b) => a + b, 0n),
    -1250n,
  );
});

test('property: 20,000 random allocations lose nothing', () => {
  let seed = 987654321 >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 20_000; i += 1) {
    const amount = BigInt(Math.floor(rnd() * 4_000_000) - 2_000_000);
    const n = 1 + Math.floor(rnd() * 8);
    const weights = Array.from({ length: n }, () => Math.floor(rnd() * 12));
    if (weights.reduce((a, b) => a + b, 0) === 0) continue;
    const parts = allocate(amount, weights);
    assert.equal(parts.length, n);
    assert.equal(
      parts.reduce((a, b) => a + b, 0n),
      amount,
      `lost a unit: ${amount} over ${JSON.stringify(weights)}`,
    );
  }
});

test('allocate is deterministic, so an audit reproduces it', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.deepEqual(allocate(1000n, [3, 3, 3, 1]), allocate(1000n, [3, 3, 3, 1]));
  }
});

test('allocate refuses input it cannot divide', () => {
  assert.throws(() => allocate(100n, []), RangeError);
  assert.throws(() => allocate(100n, [0, 0]), RangeError);
  assert.throws(() => allocate(100n, [1, -1]), RangeError);
});

test('allocateMoney carries the currency onto every part', () => {
  const parts = allocateMoney(money(1250n, 'EUR'), [1, 1, 1]);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.currency === 'EUR'));
  assert.equal(sumMoney(parts, 'EUR').amount, 1250n);
});

// --------------------------------------------------------------------------
// Rounding
// --------------------------------------------------------------------------

test('multiplyRounded rounds half to even', () => {
  // Half-up is biased: over a few thousand VAT lines it drifts upward and the
  // invoice total stops matching the sum of its lines.
  assert.equal(multiplyRounded(5n, 1n, 2n), 2n, '2.5 -> 2');
  assert.equal(multiplyRounded(15n, 1n, 2n), 8n, '7.5 -> 8');
  assert.equal(multiplyRounded(25n, 1n, 2n), 12n, '12.5 -> 12');
  assert.equal(multiplyRounded(35n, 1n, 2n), 18n, '17.5 -> 18');
  assert.equal(multiplyRounded(-5n, 1n, 2n), -2n, 'and symmetrically for negatives');
  assert.equal(multiplyRounded(-15n, 1n, 2n), -8n);
});

test('multiplyRounded is exact for ordinary tax arithmetic', () => {
  assert.equal(multiplyRounded(1000n, 24n, 100n), 240n, 'Greek standard VAT');
  assert.equal(multiplyRounded(1000n, 13n, 100n), 130n, 'reduced rate');
  assert.equal(multiplyRounded(1000n, 6n, 100n), 60n, 'super-reduced rate');
  assert.equal(multiplyRounded(999n, 24n, 100n), 240n);
  assert.throws(() => multiplyRounded(1n, 1n, 0n), RangeError);
});

test('half-to-even does not drift over many lines', () => {
  // 1000 lines each priced at a half-cent tie. Half-up would add 1000 units of
  // bias; half-to-even splits them and lands within one.
  let total = 0n;
  for (let i = 1n; i <= 1000n; i += 1n) total += multiplyRounded(i * 10n + 5n, 1n, 10n);
  const exact = Array.from({ length: 1000 }, (_, i) => (BigInt(i) + 1n) * 10n + 5n).reduce(
    (a, b) => a + b,
    0n,
  );
  assert.ok(
    total * 10n - exact <= 10n && exact - total * 10n <= 10n,
    `drift ${total * 10n - exact}`,
  );
});

// --------------------------------------------------------------------------
// Currency safety
// --------------------------------------------------------------------------

test('two currencies never combine silently', () => {
  assert.throws(() => addMoney(money(1n, 'EUR'), money(1n, 'USD')), TypeError);
  assert.throws(() => subtractMoney(money(1n, 'EUR'), money(1n, 'USD')), TypeError);
  assert.throws(() => compareMoney(money(1n, 'EUR'), money(1n, 'USD')), TypeError);
  assert.throws(() => sumMoney([money(1n, 'EUR'), money(1n, 'USD')], 'EUR'), TypeError);
});

test('an unknown currency is refused rather than assumed to have two decimals', () => {
  assert.throws(() => money(1n, 'XXX'), RangeError);
  assert.throws(() => minorUnitsFor('ZZZ'), RangeError);
  assert.equal(isCurrencyCode('EUR'), true);
  assert.equal(isCurrencyCode('XXX'), false);
  assert.equal(isCurrencyCode(null), false);
});

test('money() refuses a fractional number', () => {
  assert.throws(() => money(12.5, 'EUR'), TypeError);
  assert.equal(money(1250, 'EUR').amount, 1250n, 'but a whole number of minor units is fine');
  assert.equal(zeroMoney('EUR').amount, 0n);
});

test('arithmetic is exact past 2^53', () => {
  // The reason for bigint: a double stops being exact at 9,007,199,254,740,993.
  const huge = money(9_007_199_254_740_993n, 'EUR');
  assert.equal(addMoney(huge, money(1n, 'EUR')).amount, 9_007_199_254_740_994n);
  assert.notEqual(Number(huge.amount) + 1, 9_007_199_254_740_994, 'which a double cannot do');
});

// --------------------------------------------------------------------------
// Parsing and display
// --------------------------------------------------------------------------

test('parseMoney reads both decimal conventions', () => {
  assert.equal(parseMoney('12.50', 'EUR').amount, 1250n);
  assert.equal(parseMoney('12,50', 'EUR').amount, 1250n);
  assert.equal(parseMoney('-12.50', 'EUR').amount, -1250n);
  assert.equal(parseMoney('12.5', 'EUR').amount, 1250n);
  assert.equal(parseMoney('0', 'EUR').amount, 0n);
  assert.equal(parseMoney('1.234,56', 'EUR').amount, 123456n, 'Greek grouping');
  assert.equal(parseMoney('1,234.56', 'EUR').amount, 123456n, 'English grouping');
  assert.equal(parseMoney('1.234.567,89', 'EUR').amount, 123456789n);
  assert.equal(parseMoney('1250', 'JPY').amount, 1250n, 'a currency with no fraction');
  assert.equal(parseMoney('1.234', 'KWD').amount, 1234n, 'three decimals fill a dinar exactly');
});

test('parseMoney refuses the ambiguous case instead of guessing', () => {
  // `1.234` is one thousand two hundred thirty-four in Greek and one-and-a-bit
  // in English. The two readings differ by a factor of a thousand, so `auto`
  // names both and refuses; a UI that knows its locale passes the separator.
  assert.throws(() => parseMoney('1.234', 'EUR'), /ambiguous/);
  assert.throws(() => parseMoney('12,505', 'EUR'), /ambiguous/);
  assert.equal(parseMoney('1.234', 'EUR', ',').amount, 123400n, 'the dot is grouping');
  assert.equal(parseMoney('1,234', 'EUR', '.').amount, 123400n, 'and so is the comma');
  assert.equal(parseMoney('1.23', 'EUR').amount, 123n, 'two decimals are never ambiguous');
});

test('parseMoney refuses to round a value away', () => {
  assert.throws(() => parseMoney('12.505', 'EUR', '.'), /decimal places/);
  assert.throws(() => parseMoney('1.5', 'JPY'), /decimal places/);
  assert.throws(() => parseMoney('abc', 'EUR'), /Not an amount/);
  assert.throws(() => parseMoney('', 'EUR'), /Not an amount/);
  assert.throws(() => parseMoney('1..2', 'EUR'), /Not an amount/);
});

test('toDecimalString honours the currency exponent', () => {
  assert.equal(toDecimalString(money(1250n, 'EUR')), '12.50');
  assert.equal(toDecimalString(money(-1250n, 'EUR')), '-12.50');
  assert.equal(toDecimalString(money(5n, 'EUR')), '0.05');
  assert.equal(toDecimalString(money(1250n, 'JPY')), '1250');
  assert.equal(toDecimalString(money(1234n, 'KWD')), '1.234');
  assert.equal(toDecimalString(money(0n, 'EUR')), '0.00');
});

test('parse and print round-trip', () => {
  for (const [text, cur] of [
    ['12.50', 'EUR'],
    ['0.05', 'EUR'],
    ['1250', 'JPY'],
    ['1.234', 'KWD'],
  ] as const) {
    assert.equal(toDecimalString(parseMoney(text, cur, '.')), text);
  }
});

test('formatMoney defers to ICU for the locale', () => {
  assert.match(formatMoney(money(1250n, 'EUR'), 'el'), /12,50/);
  assert.match(formatMoney(money(1250n, 'EUR'), 'en'), /12\.50/);
  assert.match(formatMoney(money(1250n, 'JPY'), 'en'), /1,250/);
});

// --------------------------------------------------------------------------
// The currency table
// --------------------------------------------------------------------------

test('every code is a well-formed ISO 4217 alpha-3 with a sane exponent', () => {
  assert.ok(CURRENCY_CODES.length >= 150, `only ${CURRENCY_CODES.length} codes`);
  for (const code of CURRENCY_CODES) {
    assert.match(code, /^[A-Z]{3}$/, code);
    const units = CURRENCY_MINOR_UNITS[code] as number;
    assert.ok([0, 2, 3, 4].includes(units), `${code} has exponent ${units}`);
  }
  assert.deepEqual([...CURRENCY_CODES], [...CURRENCY_CODES].sort(), 'and the table is sorted');
});

test('the ICU cash-rounding divergences are real and bounded', () => {
  for (const [code, icu] of Object.entries(ICU_CASH_ROUNDING)) {
    assert.ok(isCurrencyCode(code), `${code} is not in the table`);
    assert.notEqual(CURRENCY_MINOR_UNITS[code], icu, `${code} is listed but does not diverge`);
  }
  assert.equal(CURRENCY_MINOR_UNITS['HUF'], 2, 'ISO 4217 defines the fillér');
  assert.equal(ICU_CASH_ROUNDING['HUF'], 0, 'and ICU reports what Hungary pays in');
});

test('the exponents that matter are right', () => {
  assert.equal(minorUnitsFor('EUR'), 2);
  assert.equal(minorUnitsFor('JPY'), 0);
  assert.equal(minorUnitsFor('KWD'), 3);
  assert.equal(minorUnitsFor('CLF'), 4);
});
