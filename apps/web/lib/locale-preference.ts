import { isLocale, type Locale } from '@libriant/i18n';

/**
 * Remembered language choice.
 *
 * Locale used to be decided exactly once, at `/`, from `Accept-Language` — and
 * Greek libraries routinely run Windows and macOS in en-US, so their staff
 * landed on `/en/...` and stayed there, with no control anywhere in the app to
 * change it. This cookie is what the in-app language switch writes, and it
 * outranks both `Accept-Language` and the library's `defaultLocale`: a person
 * who has picked a language has said the last word on the subject.
 *
 * Not `__Host-`: it carries no authority, and it must survive being read by the
 * plain-HTTP dev origin as well as production.
 */
export const LOCALE_COOKIE = 'libriant_locale';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Read the remembered choice in the browser. */
export function preferredLocale(): Locale | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  const value = match?.[1] ? decodeURIComponent(match[1]) : null;
  return value && isLocale(value) ? value : null;
}

/** Persist the choice made in the language switch. */
export function rememberLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
