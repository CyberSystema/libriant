import { createTranslator, DEFAULT_LOCALE, isLocale } from '@libriant/i18n';
import type { Catalog, Locale, Translator } from '@libriant/i18n';
import elErrors from '../../../locales/el/errors.json';
import elSystem from '../../../locales/el/system.json';
import enErrors from '../../../locales/en/errors.json';
import enSystem from '../../../locales/en/system.json';

/**
 * The two namespaces the failure pages need, bundled at build time.
 *
 * `error.tsx`, `global-error.tsx` and the root `not-found.tsx` are the screens
 * that have to render when everything else has already broken. React hands an
 * error boundary no props, so they cannot receive the server-loaded catalogue
 * the way every other page does — and a page whose whole job is to work during
 * an outage must not fetch its own copy over the network. Importing the JSON
 * keeps their copy in /locales, where `check:translations` enforces el/en
 * parity, at the cost of a couple of kilobytes in the client bundle.
 */
const CATALOGS: Record<Locale, Catalog> = {
  el: prefix({ system: elSystem, errors: elErrors }),
  en: prefix({ system: enSystem, errors: enErrors }),
};

function prefix(namespaces: Record<string, Record<string, string>>): Catalog {
  const merged: Catalog = {};
  for (const [ns, entries] of Object.entries(namespaces)) {
    for (const [key, value] of Object.entries(entries)) merged[`${ns}.${key}`] = value;
  }
  return merged;
}

/** Coerce whatever the URL segment held into a locale we can actually render. */
export function safeLocale(value: unknown): Locale {
  return typeof value === 'string' && isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Translator over the bundled `system` + `errors` namespaces. */
export function staticTranslator(locale: Locale): Translator {
  return createTranslator(CATALOGS[locale], locale);
}
