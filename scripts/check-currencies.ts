#!/usr/bin/env tsx
// The currency table was written from the standard, so it gets checked by machine.
//
// `packages/shared/src/currencies.ts` says how many minor units make one major
// unit for every currency Libriant can hold money in. Every monetary amount in
// a tenant database is a `bigint` count of those units paired with a `char(3)`
// code, so a wrong exponent is not a display bug: it is a fee, a fine or an
// invoice line wrong by a factor of ten, a hundred or a thousand, stored, and
// reconciled against nothing that could notice.
//
// This is `check-countries.mjs` applied to a second list drafted the same way,
// for the same reason: that list was written from memory and the gate is what
// found Vatican City filed under +379.
//
// ICU is the reference — but only where ICU is answering the same question.
// ICU reports the exponent people PAY in; ISO 4217 defines the one the standard
// declares, and for 16 currencies those differ because the fractional unit has
// been withdrawn or inflated away. Both numbers are correct answers to
// different questions, and the table records both. So this checks:
//
//   - every code is a well-formed alpha-3 that ICU knows, and that ICU
//     resolves to a real display name in BOTH Greek and English;
//   - the exponent matches ICU's, EXCEPT for the codes declared in
//     ICU_CASH_ROUNDING, where it must still differ and differ exactly as
//     recorded — so a future ICU release changing its mind fails the build
//     rather than silently re-pricing a currency;
//   - every code in ICU_CASH_ROUNDING is in the table and does diverge, so the
//     exemption list cannot accumulate entries that no longer mean anything;
//   - the table is sorted and free of duplicates;
//   - the exponents this business actually depends on are asserted by hand.
//
// Run through tsx, not plain node: `currencies.ts` is imported by `money.ts`
// with a `.js` specifier, which tsc and every bundler resolve and Node's type
// stripping does not. `check:translations` already runs this way.
import {
  CURRENCY_CODES,
  CURRENCY_MINOR_UNITS,
  ICU_CASH_ROUNDING,
  isCurrencyCode,
  minorUnitsFor,
} from '../packages/shared/src/currencies.js';

const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);

// --- 1. shape --------------------------------------------------------------
if (CURRENCY_CODES.length < 150) {
  fail(`only ${CURRENCY_CODES.length} codes; the active ISO 4217 list is around 180.`);
}
const seen = new Set<string>();
for (const code of CURRENCY_CODES) {
  if (!/^[A-Z]{3}$/.test(code)) fail(`'${code}' is not a well-formed alpha-3 code.`);
  if (seen.has(code)) fail(`'${code}' appears twice.`);
  seen.add(code);
}
const sorted = [...CURRENCY_CODES].sort();
for (let i = 0; i < CURRENCY_CODES.length; i += 1) {
  if (CURRENCY_CODES[i] !== sorted[i]) {
    fail(`the table is not sorted: '${CURRENCY_CODES[i]}' where '${sorted[i]}' was expected.`);
    break;
  }
}

// --- 2. ICU knows every code, in both locales ------------------------------
const nameEn = new Intl.DisplayNames(['en'], { type: 'currency' });
const nameEl = new Intl.DisplayNames(['el'], { type: 'currency' });

for (const code of CURRENCY_CODES) {
  const units = CURRENCY_MINOR_UNITS[code];
  if (units === undefined) {
    fail(`'${code}' is listed in CURRENCY_CODES but has no exponent.`);
    continue;
  }
  if (![0, 2, 3, 4].includes(units)) {
    fail(`'${code}' has exponent ${units}; ISO 4217 uses only 0, 2, 3 and 4.`);
  }

  let icu: number;
  try {
    icu = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits;
  } catch (err) {
    fail(`'${code}' is not a currency ICU can format: ${(err as Error).message}`);
    continue;
  }

  // A display name that comes back as the code itself means ICU has no name.
  // A user picking a currency from a list of three-letter codes is being asked
  // to know something they should not have to.
  const en = nameEn.of(code);
  const el = nameEl.of(code);
  if (en === code) fail(`'${code}' has no English display name in ICU.`);
  if (el === code) fail(`'${code}' has no Greek display name in ICU.`);

  const declaredDivergence = ICU_CASH_ROUNDING[code];
  if (declaredDivergence === undefined) {
    if (units !== icu) {
      fail(
        `'${code}': the table says ${units} decimal places, ICU says ${icu}. ` +
          `Either the exponent is wrong, or this is a cash-rounding divergence ` +
          `that belongs in ICU_CASH_ROUNDING with a reason.`,
      );
    }
  } else if (declaredDivergence !== icu) {
    fail(
      `'${code}': ICU_CASH_ROUNDING records ICU as ${declaredDivergence}, but ICU now says ` +
        `${icu}. ICU changed its mind; a person has to decide what that means for stored money.`,
    );
  } else if (units === icu) {
    fail(
      `'${code}' is listed in ICU_CASH_ROUNDING but ISO and ICU now agree on ${units}. ` +
        `Remove it: an exemption that exempts nothing hides the next real one.`,
    );
  }
}

// --- 3. the exemption list refers only to codes we hold --------------------
for (const code of Object.keys(ICU_CASH_ROUNDING)) {
  if (!isCurrencyCode(code)) {
    fail(`ICU_CASH_ROUNDING names '${code}', which is not in the currency table.`);
  }
}

// --- 4. the ones this business depends on, by hand -------------------------
const PINNED: Record<string, number> = {
  EUR: 2, // Greece and every launch customer.
  USD: 2,
  GBP: 2,
  CHF: 2,
  JPY: 0, // The canonical no-fraction currency.
  KRW: 0,
  ISK: 0,
  KWD: 3, // The canonical three-decimal currency: 1000 fils.
  BHD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  CLF: 4, // The only four-decimal unit of account in the list.
};
for (const [code, expected] of Object.entries(PINNED)) {
  if (CURRENCY_MINOR_UNITS[code] !== expected) {
    fail(`'${code}' must have exponent ${expected}, has ${CURRENCY_MINOR_UNITS[code]}.`);
  }
}

// --- 5. the accessor the ledger calls on untrusted input -------------------
for (const junk of ['', 'eur', 'EURO', 'XX', '978', ' EUR']) {
  if (isCurrencyCode(junk)) fail(`isCurrencyCode() accepted ${JSON.stringify(junk)}.`);
  let threw = false;
  try {
    minorUnitsFor(junk);
  } catch {
    threw = true;
  }
  if (!threw) {
    fail(
      `minorUnitsFor(${JSON.stringify(junk)}) returned instead of throwing. A default of 2 ` +
        `turns a three-decimal dinar into a two-decimal one and every fee is wrong by ten.`,
    );
  }
}
if (!isCurrencyCode('EUR')) fail("isCurrencyCode() rejected 'EUR'.");

if (problems.length) {
  console.error(`✗ packages/shared/src/currencies.ts: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`    ${p}`);
  console.error(
    '\nEvery amount in a tenant database is a count of minor units. A wrong exponent is a\n' +
      'stored balance wrong by a power of ten, with nothing downstream that could notice.',
  );
  process.exit(1);
}

const divergences = Object.keys(ICU_CASH_ROUNDING).length;
console.log(
  `currency check passed: ${CURRENCY_CODES.length} ISO 4217 codes, every one known to ICU ` +
    `with a display name in el and en; ${CURRENCY_CODES.length - divergences} exponents agree ` +
    `with ICU exactly and ${divergences} diverge exactly as declared (cash rounding); ` +
    `${Object.keys(PINNED).length} exponents pinned by hand; minorUnitsFor() throws on junk.`,
);
