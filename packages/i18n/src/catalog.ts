import type { Locale } from './locales';

/**
 * A catalog is a flat record of message ids to formatted ICU-style strings.
 * We keep it simple: namespaces are folders on disk, merged into a single
 * object at load time with `namespace.key` ids.
 */
export type Catalog = Record<string, string>;

/**
 * Substitute {placeholder} occurrences. ICU-style plural/select rules can be
 * layered on later via `formatjs`; for now we only need named substitution
 * plus a {count, plural, ...} fallback that picks `one` or `other`.
 */
export function format(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(
    /\{(\w+)(?:,\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\})?\}/g,
    (_, name, one, other) => {
      const v = values[name];
      if (one !== undefined && other !== undefined) {
        const n = typeof v === 'number' ? v : Number(v ?? 0);
        const branch = n === 1 ? one : other;
        return branch.replace(/#/g, String(n));
      }
      return v === undefined || v === null ? '' : String(v);
    },
  );
}

export type Translator = (
  id: string,
  values?: Record<string, string | number>,
  fallback?: string,
) => string;

/**
 * Build a translator function over a catalog. Missing keys return the
 * fallback (if provided) or the id itself, plus log a console warning in dev.
 */
export function createTranslator(catalog: Catalog, locale: Locale): Translator {
  return (id, values, fallback) => {
    const template = catalog[id] ?? fallback;
    if (!template) {
      if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
        console.warn(`[i18n:${locale}] missing key "${id}"`);
      }
      return id;
    }
    return format(template, values);
  };
}
