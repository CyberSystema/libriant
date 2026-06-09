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
] as const;
export type Namespace = (typeof NAMESPACES)[number];

const cache = new Map<string, Catalog>();

async function loadNamespace(locale: Locale, ns: Namespace): Promise<Catalog> {
  const key = `${locale}:${ns}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const file = path.join(LOCALES_ROOT, locale, `${ns}.json`);
  const raw = await fs.readFile(file, 'utf8');
  const obj = JSON.parse(raw) as Record<string, string>;
  // Prefix each key with its namespace so we can merge namespaces without collision.
  const prefixed: Catalog = {};
  for (const [k, v] of Object.entries(obj)) prefixed[`${ns}.${k}`] = v;
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
