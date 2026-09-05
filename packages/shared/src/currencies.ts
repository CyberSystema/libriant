/**
 * ISO 4217 currency codes and their minor-unit exponents.
 *
 * The exponent is how many decimal places the currency has, and therefore how
 * many minor units make one major unit: EUR is 2 (100 cents), JPY is 0 (there
 * is no sub-yen), KWD is 3 (1000 fils), CLF is 4. Every monetary amount in the
 * tenant database is a `bigint` count of MINOR units paired with a `char(3)`
 * code, and this table is the only thing that says what that count means.
 *
 * WHY THIS IS NOT DERIVED FROM ICU AT RUNTIME. ICU reports the exponent people
 * actually pay in, not the one the standard defines. Both numbers are correct
 * answers to different questions, and mixing them corrupts money:
 *
 *   16 codes diverge, listed in {@link ICU_CASH_ROUNDING} below. HUF is the
 *   clearest: ISO 4217 defines 2 (the fillér), ICU reports 0 because Hungary
 *   withdrew the fillér in 1999. If a fee were stored in ICU's unit and read
 *   back in ISO's, every Hungarian balance would be off by a factor of 100.
 *
 * So: ISO 4217 is authoritative for ARITHMETIC AND STORAGE — it is what a
 * ledger, an EDIFACT invoice and an accounting export all mean by "amount".
 * ICU is authoritative for DISPLAY, and `Intl.NumberFormat` is called with the
 * currency code so it applies its own rounding at the last moment.
 *
 * `pnpm check:currencies` asserts every code here is one ICU knows, that ICU
 * resolves a display name in BOTH English and Greek, and that the exponent
 * matches ICU's EXCEPT for the codes recorded below — where it must still
 * differ exactly as recorded. A change on either side fails the build. This is
 * `scripts/check-countries.mjs` applied to a second list drafted the same way,
 * for the same reason: that list was written from memory and the gate is what
 * found Vatican City filed under +379.
 *
 * Display names are deliberately NOT stored. `Intl.DisplayNames` has them in
 * every locale the app supports, and a stored bilingual name table is a second
 * thing to keep in step with `check:translations` for no gain.
 */

/** ISO 4217 alpha-3 code to minor-unit exponent. 156 active codes. */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  AED: 2,
  AFN: 2,
  ALL: 2,
  AMD: 2,
  ANG: 2,
  AOA: 2,
  ARS: 2,
  AUD: 2,
  AWG: 2,
  AZN: 2,
  BAM: 2,
  BBD: 2,
  BDT: 2,
  BGN: 2,
  BHD: 3,
  BIF: 0,
  BMD: 2,
  BND: 2,
  BOB: 2,
  BRL: 2,
  BSD: 2,
  BTN: 2,
  BWP: 2,
  BYN: 2,
  BZD: 2,
  CAD: 2,
  CDF: 2,
  CHF: 2,
  CLF: 4,
  CLP: 0,
  CNY: 2,
  COP: 2,
  CRC: 2,
  CUP: 2,
  CVE: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  DOP: 2,
  DZD: 2,
  EGP: 2,
  ERN: 2,
  ETB: 2,
  EUR: 2,
  FJD: 2,
  FKP: 2,
  GBP: 2,
  GEL: 2,
  GHS: 2,
  GIP: 2,
  GMD: 2,
  GNF: 0,
  GTQ: 2,
  GYD: 2,
  HKD: 2,
  HNL: 2,
  HTG: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  IRR: 2,
  ISK: 0,
  JMD: 2,
  JOD: 3,
  JPY: 0,
  KES: 2,
  KGS: 2,
  KHR: 2,
  KMF: 0,
  KPW: 2,
  KRW: 0,
  KWD: 3,
  KYD: 2,
  KZT: 2,
  LAK: 2,
  LBP: 2,
  LKR: 2,
  LRD: 2,
  LSL: 2,
  LYD: 3,
  MAD: 2,
  MDL: 2,
  MGA: 2,
  MKD: 2,
  MMK: 2,
  MNT: 2,
  MOP: 2,
  MRU: 2,
  MUR: 2,
  MVR: 2,
  MWK: 2,
  MXN: 2,
  MYR: 2,
  MZN: 2,
  NAD: 2,
  NGN: 2,
  NIO: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  OMR: 3,
  PAB: 2,
  PEN: 2,
  PGK: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RSD: 2,
  RUB: 2,
  RWF: 0,
  SAR: 2,
  SBD: 2,
  SCR: 2,
  SDG: 2,
  SEK: 2,
  SGD: 2,
  SHP: 2,
  SLE: 2,
  SOS: 2,
  SRD: 2,
  SSP: 2,
  STN: 2,
  SVC: 2,
  SYP: 2,
  SZL: 2,
  THB: 2,
  TJS: 2,
  TMT: 2,
  TND: 3,
  TOP: 2,
  TRY: 2,
  TTD: 2,
  TWD: 2,
  TZS: 2,
  UAH: 2,
  UGX: 0,
  USD: 2,
  UYU: 2,
  UZS: 2,
  VES: 2,
  VND: 0,
  VUV: 0,
  WST: 2,
  XAF: 0,
  XCD: 2,
  XOF: 0,
  XPF: 0,
  YER: 2,
  ZAR: 2,
  ZMW: 2,
  ZWG: 2,
};

/** Every supported ISO 4217 code, sorted. */
export const CURRENCY_CODES: readonly string[] = Object.keys(CURRENCY_MINOR_UNITS);

/**
 * Codes where ICU's cash-rounding exponent differs from ISO 4217's, with ICU's
 * value. Every entry is a currency whose fractional unit has been withdrawn
 * from circulation or inflated into irrelevance, so prices are quoted in whole
 * major units even though the standard still defines a fraction.
 *
 * This is a record of a known, permanent disagreement between two authorities,
 * not a to-do list. `check:currencies` requires the divergence to persist: if
 * a future ICU release changes its mind, the build fails and a person decides.
 */
export const ICU_CASH_ROUNDING: Readonly<Record<string, number>> = {
  AFN: 0,
  ALL: 0,
  COP: 0,
  HUF: 0,
  IDR: 0,
  IQD: 0,
  IRR: 0,
  KPW: 0,
  LAK: 0,
  LBP: 0,
  MGA: 0,
  MMK: 0,
  PKR: 0,
  SOS: 0,
  SYP: 0,
  YER: 0,
};

/** Narrowed type for a code known to this table. */
export type CurrencyCode = string & { readonly __brand?: 'CurrencyCode' };

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_MINOR_UNITS, value);
}

/**
 * Minor-unit exponent for a code.
 *
 * THROWS on an unknown code rather than assuming 2. A silent default is how a
 * three-decimal dinar becomes a two-decimal one and every Kuwaiti fee is
 * wrong by a factor of ten; there is no safe guess, so there is no guess.
 */
export function minorUnitsFor(code: string): number {
  const units = CURRENCY_MINOR_UNITS[code];
  if (units === undefined) {
    throw new RangeError(
      `Unknown currency code "${code}". Add it to CURRENCY_MINOR_UNITS in ` +
        `packages/shared/src/currencies.ts (and check:currencies will verify it against ICU).`,
    );
  }
  return units;
}
