import { formatCurrency, type Locale } from '@libriant/i18n';

/**
 * Render an amount that the API gave us in **integer subunits**.
 *
 * Money crosses the wire as `amountCents` + an ISO-4217 `currency` and is never
 * a float anywhere in this codebase — a fine of €2.40 is the integer 240, it is
 * compared as 240 (the pay endpoint refuses a mismatch), and it is divided by
 * 100 exactly once: here, on its way to the screen. Every screen that needed
 * money used to inline its own `Intl.NumberFormat(...).format(cents / 100)`,
 * and the member detail page hardcoded `currency: 'EUR'` while the API returns
 * whatever the library configured — so a library billing in another currency
 * had its members' debts mislabelled in euros. One helper, one division, one
 * place to fix.
 *
 * Never parse the result back into a number. It carries a locale's group and
 * decimal separators (Greek renders €2.40 as "2,40 €"), so a round-trip is a
 * silent corruption of an amount someone owes.
 *
 * KNOWN LIMIT: two decimal subunits are assumed, which is the same assumption
 * the API's own formatter makes (`(cents / 100).toFixed(2)` in FinesService).
 * A zero-decimal currency (JPY) would render 240 as "¥2". Greek libraries bill
 * in EUR; fixing it properly means asking `Intl.NumberFormat` for the currency's
 * minor-unit exponent on both sides of the wire, and the API has to move first.
 */
export function formatMoney(cents: number, currency: string, locale: Locale): string {
  return formatCurrency(cents / 100, locale, currency.length ? currency : 'EUR');
}
