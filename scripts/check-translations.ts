/**
 * CI gate: every locale must have the same set of keys across every namespace.
 *
 * If a key exists in en/catalog.json it must exist in el/catalog.json (and any
 * future locale). Translation drift fails CI loudly so it never silently ships.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LOCALES_DIR = path.join(REPO, 'locales');

type Catalog = Record<string, string>;

async function readJson(file: string): Promise<Catalog> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as Catalog;
}

async function listLocales(): Promise<string[]> {
  const entries = await fs.readdir(LOCALES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function listNamespaces(locale: string): Promise<string[]> {
  const dir = path.join(LOCALES_DIR, locale);
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
}

async function main() {
  const locales = await listLocales();
  if (locales.length < 2) {
    console.error(`Expected at least 2 locales under ${LOCALES_DIR}, found: ${locales.join(', ')}`);
    process.exit(1);
  }

  const referenceLocale = locales[0]!;
  const referenceNs = await listNamespaces(referenceLocale);
  let errors = 0;

  for (const locale of locales) {
    const ns = await listNamespaces(locale);
    // namespace parity
    const missingNs = referenceNs.filter((n) => !ns.includes(n));
    const extraNs = ns.filter((n) => !referenceNs.includes(n));
    for (const m of missingNs) {
      console.error(`[${locale}] missing namespace: ${m}.json`);
      errors++;
    }
    for (const m of extraNs) {
      console.error(`[${locale}] extra namespace not present in ${referenceLocale}: ${m}.json`);
      errors++;
    }
  }

  // key parity per namespace
  for (const namespace of referenceNs) {
    const catalogs = new Map<string, Catalog>();
    for (const locale of locales) {
      try {
        catalogs.set(locale, await readJson(path.join(LOCALES_DIR, locale, `${namespace}.json`)));
      } catch {
        // already reported above
      }
    }
    const refKeys = new Set(Object.keys(catalogs.get(referenceLocale) ?? {}));
    for (const [locale, cat] of catalogs.entries()) {
      if (locale === referenceLocale) continue;
      const keys = new Set(Object.keys(cat));
      for (const k of refKeys) {
        if (!keys.has(k)) {
          console.error(`[${locale}/${namespace}] missing key: ${k}`);
          errors++;
        }
      }
      for (const k of keys) {
        if (!refKeys.has(k)) {
          console.error(`[${locale}/${namespace}] extra key not in ${referenceLocale}: ${k}`);
          errors++;
        }
      }
    }
  }

  if (errors > 0) {
    console.error(`\nTranslation check FAILED with ${errors} issue(s).`);
    process.exit(1);
  }
  console.log(`Translation check passed for locales: ${locales.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
