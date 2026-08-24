import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog, Locale } from '@libriant/i18n';
import { SUPPORTED_LOCALES } from '@libriant/i18n';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_LOCALES = path.resolve(HERE, '..', '..', '..', 'locales');
const LOCALES_ROOT = process.env.LOCALES_ROOT?.trim() || REPO_LOCALES;

// Every namespace shipped at MVP. Adding one means dropping a new file in
// /locales/<lang>/ — and adding the name here.
export const NAMESPACES = [
  'common',
  'auth',
  'catalog',
  'members',
  'loans',
  'reservations',
  'billing',
  'support',
  'system',
  'onboarding',
  'errors',
  'settings',
  'help',
  'import',
  'landing',
  'legal',
  'library',
  // App-shell chrome (skip link, nav landmark, language switch). Separate from
  // `common` so the shell can grow strings without touching the design-system
  // catalogue that every package shares.
  'shell',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

const cache = new Map<string, Catalog>();

async function loadNamespace(locale: Locale, ns: Namespace): Promise<Catalog> {
  const key = `${locale}:${ns}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = path.join(LOCALES_ROOT, locale, `${ns}.json`);
  let prefixed: Catalog;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const obj = JSON.parse(raw) as Record<string, string>;
    // Prefix each key with its namespace so we can merge namespaces without collision.
    prefixed = {};
    for (const [k, v] of Object.entries(obj)) prefixed[`${ns}.${k}`] = v;
  } catch (err) {
    // A catalog we cannot read must not be able to take a page down.
    //
    // This read is the FIRST await in the tenant layout, ahead of the system-mode
    // resolution, so that even the pre-auth takeover screen is localized. That
    // ordering is deliberate — but it also meant an unreadable namespace file
    // threw before the takeover branch could be evaluated, reproducing
    // frontend-03 one layer down: the maintenance screen, whose entire job is to
    // work when everything else is broken, would render as a bare 500 instead.
    // LOCALES_ROOT is a mount in production, so "unreadable" is a real
    // deployment state, not a hypothetical.
    //
    // Degrading to an empty namespace means its keys render as raw ids — visibly
    // wrong, and loud in the log — but the page, and the recovery screen, still
    // work. `pnpm check:translations` keeps this from happening by accident.
    console.error(
      `[i18n] could not load ${locale}/${ns}.json from ${LOCALES_ROOT}: ${(err as Error).message}. ` +
        'Rendering that namespace untranslated — check LOCALES_ROOT and the image contents.',
    );
    // Deliberately NOT cached: caching the empty result would turn a transient
    // read failure into a permanently untranslated namespace for the lifetime
    // of the process, long after the mount came back.
    return {};
  }
  cache.set(key, prefixed);
  return prefixed;
}

/**
 * Load a merged catalog for a locale across the given namespaces (or all of
 * them by default). Keys are namespaced as `<namespace>.<key>`.
 */
export async function loadCatalog(
  locale: Locale,
  namespaces: readonly Namespace[] = NAMESPACES,
): Promise<Catalog> {
  const merged: Catalog = {};
  for (const ns of namespaces) {
    const partial = await loadNamespace(locale, ns);
    Object.assign(merged, partial);
  }
  return merged;
}

export function isValidNamespace(value: string): value is Namespace {
  return (NAMESPACES as readonly string[]).includes(value);
}

export { SUPPORTED_LOCALES };
