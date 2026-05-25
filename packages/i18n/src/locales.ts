/**
 * All Libriant locales are equally first-class. Adding a new language means:
 *   1. add a folder under /locales/<code>/
 *   2. add the code below
 * No code changes anywhere else.
 */
export const SUPPORTED_LOCALES = ['en', 'el'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'el';

export const LOCALE_DISPLAY: Record<Locale, { native: string; english: string }> = {
  en: { native: 'English', english: 'English' },
  el: { native: 'Ελληνικά', english: 'Greek' },
};

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the best supported locale from a browser Accept-Language string,
 * falling back to DEFAULT_LOCALE.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  for (const part of acceptLanguage.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase();
    if (!tag) continue;
    const base = tag.split('-')[0];
    if (base && isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
