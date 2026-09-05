/**
 * Money — `bigint` minor units paired with an ISO 4217 code.
 *
 * WHY BIGINT AND NOT NUMBER. `fines.amountCents` is an `Int` in 1.0 and fees
 * are computed in JavaScript numbers, which are IEEE-754 doubles. That is
 * safe today because a library fine is small, and it stops being safe the
 * moment the same code touches an acquisitions ledger: a €40,000 order in a
 * three-decimal currency is 40,000,000 minor units, and once a running total
 * crosses 2^53 the additions silently stop being exact. `bigint` has no such
 * ceiling and no rounding at all, so the only rounding in the system is the
 * rounding this file performs deliberately.
 *
 * WHY THE CURRENCY TRAVELS WITH THE AMOUNT. A consortium has members in EUR
 * and members outside the euro. A `bigint` on its own can be added to any
 * other `bigint`, and the first time a total sums two currencies nobody finds
 * out until an auditor does. Every operation here refuses a currency mismatch.
 *
 * WHY MINOR UNITS AND NOT DECIMALS. A decimal string is a display format; an
 * integer count of the smallest indivisible unit is what a ledger actually
 * holds. `minorUnitsFor` says how many of them make one major unit, per
 * ISO 4217 — never per ICU, which reports what people pay in rather than what
 * the standard defines. See `currencies.ts`.
 *
 * THE ONE PLACE THIS TYPE DOES NOT REACH is the acquisitions fund ledger,
 * which uses `numeric(19,4)` because per-line VAT splits and eight-decimal FX
 * rates cannot survive integer minor units. That boundary is crossed in
 * exactly one module, and this file owns the conversion.
 */

import { minorUnitsFor } from './currencies.js';

export interface Money {
  /** Count of minor units. Negative is a credit. */
  readonly amount: bigint;
  /** ISO 4217 alpha-3. */
  readonly currency: string;
}

export function money(amount: bigint | number, currency: string): Money {
  minorUnitsFor(currency); // Throws on an unknown code before any amount exists.
  if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) {
      throw new TypeError(
        `money() takes whole minor units; got ${amount}. Use parseMoney() for a decimal string.`,
      );
    }
    return { amount: BigInt(amount), currency };
  }
  return { amount, currency };
}

export function zeroMoney(currency: string): Money {
  return money(0n, currency);
}

/**
 * Refuse to operate across currencies.
 *
 * This is a throw and not a silent coercion because there is no correct
 * answer: converting needs a rate and a rate needs a date, and neither is
 * available at the point two amounts are added.
 */
export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Cannot combine ${a.currency} with ${b.currency}. Convert explicitly with a dated rate.`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function negateMoney(a: Money): Money {
  return { amount: -a.amount, currency: a.currency };
}

export function sumMoney(items: readonly Money[], currency: string): Money {
  let total = 0n;
  for (const m of items) {
    if (m.currency !== currency) {
      throw new TypeError(`Cannot sum ${m.currency} into a ${currency} total.`);
    }
    total += m.amount;
  }
  return { amount: total, currency };
}

/** Negative if `a` is less than `b`. Throws on a currency mismatch. */
export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

export function isZeroMoney(a: Money): boolean {
  return a.amount === 0n;
}

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * Multiply by the rational `numerator / denominator`, rounding half to even.
 *
 * Half-to-even ("banker's rounding") rather than half-up because half-up is
 * biased: applied to a few thousand VAT lines it drifts upward by roughly half
 * a minor unit per tie, and an accountant reconciling the total against the
 * sum of the lines finds a discrepancy nobody can explain. Half-to-even has no
 * such bias, and it is what EN 16931 and every accounting package assume.
 *
 * Exact throughout — the arithmetic is integer, so `24 %` is `24n / 100n` and
 * never `0.24`.
 */
export function multiplyRounded(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('multiplyRounded: denominator is zero.');
  const negative = (amount < 0n !== numerator < 0n) !== denominator < 0n;
  const a = amount < 0n ? -amount : amount;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const product = a * n;
  const quotient = product / d;
  const remainder = product % d;
  const twice = remainder * 2n;

  let result = quotient;
  if (twice > d) result += 1n;
  else if (twice === d && quotient % 2n === 1n) result += 1n; // Exactly half: go to even.

  return negative ? -result : result;
}

/** {@link multiplyRounded} on a {@link Money}. */
export function multiplyMoney(m: Money, numerator: bigint, denominator: bigint): Money {
  return { amount: multiplyRounded(m.amount, numerator, denominator), currency: m.currency };
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Split `amount` across `weights` so the parts sum EXACTLY back to `amount`.
 *
 * Largest-remainder: give everyone their floor, then hand the leftover minor
 * units out one at a time to the largest remainders, ties broken by position
 * so the result is deterministic and reproducible in a test and in an audit.
 *
 *   allocate(1250n, [1, 1, 1])  ->  [417n, 417n, 416n]      sums to 1250n
 *   allocate(-1250n, [1, 1, 1]) ->  [-417n, -417n, -416n]   sums to -1250n
 *
 * There is NO configuration for what happens to the remainder, because every
 * alternative loses money. Dividing €12.50 three ways and rounding each part
 * gives €4.17 × 3 = €12.51; truncating gives €12.48. A ledger that does either
 * fails its own reconciliation, which is exactly the drift the nightly
 * reconciler exists to alarm on — so it must never be generated here.
 *
 * Weights are integers (a fund distribution of 60/40, three equal payers, a
 * per-line VAT split). They may be zero; they may not be negative.
 */
export function allocate(amount: bigint, weights: readonly (number | bigint)[]): bigint[] {
  if (weights.length === 0) {
    throw new RangeError('allocate: needs at least one weight.');
  }
  const w = weights.map((x) => {
    const b = typeof x === 'bigint' ? x : BigInt(Math.trunc(x));
    if (b < 0n) throw new RangeError('allocate: weights must not be negative.');
    return b;
  });
  const total = w.reduce((acc, x) => acc + x, 0n);
  if (total === 0n) {
    throw new RangeError('allocate: weights sum to zero, so there is nothing to divide by.');
  }

  // Work on the magnitude so truncation is always toward zero and the sign is
  // reapplied at the end; otherwise `-1250n / 3n` truncates the opposite way
  // from `1250n / 3n` and a refund splits differently from the charge it reverses.
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;

  const parts: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;
  for (let i = 0; i < w.length; i += 1) {
    const numerator = magnitude * (w[i] as bigint);
    const share = numerator / total;
    parts.push(share);
    remainders.push({ index: i, remainder: numerator % total });
    distributed += share;
  }

  let leftover = magnitude - distributed;
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const r of remainders) {
    if (leftover <= 0n) break;
    parts[r.index] = (parts[r.index] as bigint) + 1n;
    leftover -= 1n;
  }

  return negative ? parts.map((p) => -p) : parts;
}

/** {@link allocate} on a {@link Money}. */
export function allocateMoney(m: Money, weights: readonly (number | bigint)[]): Money[] {
  return allocate(m.amount, weights).map((amount) => ({ amount, currency: m.currency }));
}

// ---------------------------------------------------------------------------
// Display and input
// ---------------------------------------------------------------------------

/**
 * Format for display. ICU decides the symbol, separators and its own rounding;
 * we only supply the exact value and the code.
 */
export function formatMoney(m: Money, locale: string): string {
  const units = minorUnitsFor(m.currency);
  const divisor = 10 ** units;
  // Number() is safe here and nowhere else: this is the last step before a
  // human reads it, and a balance large enough to lose precision in a double
  // is large enough that its exact minor units are not what the reader needs.
  const major = Number(m.amount) / divisor;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(major);
}

/** Minor units as a plain decimal string: `1250n` EUR becomes `"12.50"`. */
export function toDecimalString(m: Money): string {
  const units = minorUnitsFor(m.currency);
  const negative = m.amount < 0n;
  const digits = (negative ? -m.amount : m.amount).toString().padStart(units + 1, '0');
  const whole = digits.slice(0, digits.length - units);
  const fraction = units === 0 ? '' : '.' + digits.slice(digits.length - units);
  return (negative ? '-' : '') + whole + fraction;
}

/** Which character separates the fractional part. `auto` refuses ambiguity — see below. */
export type DecimalSeparator = '.' | ',' | 'auto';

/**
 * Parse a decimal string typed by a person into exact minor units.
 *
 * Accepts `12.50`, `12,50` (the Greek and continental decimal comma), a
 * leading `-`, and thousands separators in either convention.
 *
 * REFUSES more fractional digits than the currency has, rather than rounding
 * them away: if a cashier typed `12.505` into a euro field, one of us is
 * confused and it must not be resolved silently inside a ledger.
 *
 * AND REFUSES THE AMBIGUOUS CASE. A single separator with exactly three digits
 * after it — `1.234`, `12,505` — has two correct readings:
 *
 *   Greek / continental : `1.234` is one thousand two hundred thirty-four.
 *   English             : `1.234` is one and a bit, and has too many decimals
 *                         for a euro.
 *
 * Nothing in the string decides between them, and the two differ by a factor
 * of a thousand. So `auto` throws and names both readings. Every UI call site
 * knows its locale and passes `'.'` or `','` explicitly; only bulk import,
 * where the locale genuinely is unknown, ever sees `auto` — and there an
 * import row issue naming the ambiguity is exactly the right outcome.
 *
 * A currency with three decimal places (KWD, BHD) is not ambiguous: `1.234`
 * fills the fraction exactly, so it parses without complaint.
 */
export function parseMoney(
  input: string,
  currency: string,
  decimalSeparator: DecimalSeparator = 'auto',
): Money {
  const units = minorUnitsFor(currency);
  const cleaned = input.trim().replace(/\s/g, '');
  const match = /^(-)?([0-9]+(?:[.,][0-9]+)*)$/.exec(cleaned);
  if (!match) throw new RangeError(`Not an amount: "${input}"`);

  const sign = match[1] === '-' ? -1n : 1n;
  const body = match[2] as string;

  const dot = body.lastIndexOf('.');
  const comma = body.lastIndexOf(',');
  const lastSep = Math.max(dot, comma);

  let whole: string;
  let fraction: string;

  if (lastSep === -1) {
    whole = body;
    fraction = '';
  } else {
    const sepChar = body[lastSep] as string;
    const tail = body.slice(lastSep + 1);
    const head = body.slice(0, lastSep);
    const bothKindsPresent = dot !== -1 && comma !== -1;

    let isGrouping: boolean;
    if (head.includes(sepChar)) {
      // The same separator twice can only be grouping: `1.234.567`.
      isGrouping = true;
    } else if (bothKindsPresent) {
      // Two different separators: the last one is the decimal point.
      isGrouping = false;
    } else if (decimalSeparator !== 'auto') {
      isGrouping = sepChar !== decimalSeparator;
    } else if (tail.length === 3 && units !== 3) {
      throw new RangeError(
        `"${input}" is ambiguous: "${sepChar}" could be a decimal point ` +
          `(too many decimals for ${currency}) or a thousands separator ` +
          `(${body.replace(/[.,]/g, '')}). Pass the decimal separator explicitly.`,
      );
    } else {
      isGrouping = false;
    }

    if (isGrouping) {
      whole = body.replace(/[.,]/g, '');
      fraction = '';
    } else {
      whole = head.replace(/[.,]/g, '');
      fraction = tail;
    }
  }

  if (fraction.length > units) {
    throw new RangeError(
      `"${input}" has ${fraction.length} decimal places but ${currency} has ${units}. ` +
        `Refusing to round it away.`,
    );
  }

  const padded = fraction.padEnd(units, '0');
  return { amount: sign * BigInt((whole || '0') + padded), currency };
}
