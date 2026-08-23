import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import type { Locale } from '@libriant/i18n';
import { LEGAL_DOCUMENTS, type LegalDocSlug } from '@libriant/shared/legal';

/**
 * Loader for the public legal documents. Each doc is checked-in markdown at
 * `locales/<locale>/legal/<slug>.md` (same mount as the help/translation files,
 * so it ships in prod via LOCALES_ROOT). Rendered to HTML at request time with
 * `marked`. The content is OURS (no user input), so the rendered HTML is safe to
 * inject — identical trust model to the help articles.
 *
 * When a doc is missing in the requested locale we fall back to English so a
 * not-yet-translated document is still readable (the page flags the fallback).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_LOCALES = path.resolve(HERE, '..', '..', '..', 'locales');
const LOCALES_ROOT = process.env.LOCALES_ROOT?.trim() || REPO_LOCALES;

/** Maps each doc slug to the camelCase token used in its i18n keys. */
const DOC_KEY: Record<LegalDocSlug, string> = {
  terms: 'terms',
  privacy: 'privacy',
  cookies: 'cookies',
  dpa: 'dpa',
  subprocessors: 'subprocessors',
  'acceptable-use': 'acceptableUse',
  'legal-notice': 'legalNotice',
};

/** i18n key (in the `legal` namespace) for a doc's title. */
export function legalTitleKey(slug: LegalDocSlug): string {
  return `legal.docs.${DOC_KEY[slug]}.title`;
}

/** i18n key (in the `legal` namespace) for a doc's one-line summary. */
export function legalSummaryKey(slug: LegalDocSlug): string {
  return `legal.docs.${DOC_KEY[slug]}.summary`;
}

/** Order in which docs appear on the index + in the footer. */
export const LEGAL_DOC_ORDER: readonly LegalDocSlug[] = LEGAL_DOCUMENTS;

export type LegalDoc = {
  slug: LegalDocSlug;
  /** Rendered HTML body (server-owned markdown — safe to inject). */
  html: string;
  /** True when we served the English copy because the requested locale lacked it. */
  fallback: boolean;
};

const cache = new Map<string, LegalDoc | null>();

async function readMd(locale: string, slug: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(LOCALES_ROOT, locale, 'legal', `${slug}.md`), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Drop the leading blockquote, which is an AUTHOR-FACING note by convention and
 * must never reach a visitor.
 *
 * These documents open with a drafting instruction addressed to whoever is
 * writing them — "Replace every `[PLACEHOLDER]` and have it reviewed before you
 * rely on it". `marked.parse()` renders the whole file, so that instruction was
 * being published verbatim on /legal/dpa and every other legal page: a contract
 * that opens by telling the reader it is unfinished and unreviewed.
 *
 * The *public* status notice is a separate, deliberate thing — `legal.draftNotice`
 * in the i18n catalog, rendered by the page component — so stripping this loses
 * nothing a visitor should see. `scripts/check-legal-docs.mjs` enforces the
 * convention in CI.
 */
function stripAuthorNote(raw: string): string {
  const lines = raw.split('\n');
  if (lines[0]?.startsWith('>') !== true) return raw;
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('>')) i++;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  return lines.slice(i).join('\n');
}

/** Load + render one legal document for a locale (English fallback). Null if it
 *  doesn't exist in any locale (→ the route 404s). */
export async function loadLegalDoc(locale: Locale, slug: LegalDocSlug): Promise<LegalDoc | null> {
  const key = `${locale}:${slug}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  let fallback = false;
  let raw = await readMd(locale, slug);
  if (raw === null && locale !== 'en') {
    raw = await readMd('en', slug);
    fallback = true;
  }
  if (raw === null) {
    cache.set(key, null);
    return null;
  }
  const html = await marked.parse(stripAuthorNote(raw), { async: true });
  const doc: LegalDoc = { slug, html, fallback };
  cache.set(key, doc);
  return doc;
}
