import type { Locale } from './locales';

const LOCALE_BCP47: Record<Locale, string> = {
  en: 'en-US',
  el: 'el-GR',
};

export function formatDate(value: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_BCP47[locale], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function formatDateTime(value: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_BCP47[locale], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: locale === 'en',
  }).format(value);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_BCP47[locale]).format(value);
}

export function formatCurrency(value: number, locale: Locale, currency = 'EUR'): string {
  return new Intl.NumberFormat(LOCALE_BCP47[locale], {
    style: 'currency',
    currency,
  }).format(value);
}
