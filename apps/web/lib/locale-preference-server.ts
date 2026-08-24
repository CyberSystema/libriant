import { cookies } from 'next/headers';
import { isLocale, type Locale } from '@libriant/i18n';
import { LOCALE_COOKIE } from './locale-preference';

/** Server-side read of the remembered language choice. See locale-preference.ts. */
export async function preferredLocaleFromCookies(): Promise<Locale | null> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return value && isLocale(value) ? value : null;
}
