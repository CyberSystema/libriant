/**
 * Ingest the in-product help center.
 *
 * Reads every `*.md` file under `locales/<lang>/help/`, parses a tiny
 * YAML frontmatter (title / slug / summary / tags) + renders the body to
 * HTML via `marked`, then upserts the result into `help_articles`.
 *
 * Idempotent: we hash the source bytes and skip rows whose hash hasn't
 * changed. Files that disappear between runs leave the row in place but
 * stamp `archivedAt = now()` so a librarian's bookmark gets a friendly
 * "retired article" page rather than a 404.
 *
 * Runs in a separate process — does not pull NestJS or the API container.
 *
 *   ENV: CONTROL_DATABASE_URL (required)
 *   USAGE: pnpm ingest:help
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import { marked } from 'marked';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_ROOT = path.resolve(HERE, '..', 'locales');

type Frontmatter = {
  title: string;
  slug: string;
  summary: string;
  tags?: string;
};

type ParsedArticle = Frontmatter & {
  body: string;
  /** Leading digits in the filename → sortOrder for stable in-locale ordering. */
  sortOrder: number;
};

function parseFrontmatter(raw: string, file: string): { fm: Frontmatter; body: string } {
  if (!raw.startsWith('---\n')) {
    throw new Error(`${file}: missing frontmatter (file must start with --- block).`);
  }
  const closeIx = raw.indexOf('\n---', 4);
  if (closeIx === -1) throw new Error(`${file}: unterminated frontmatter.`);
  const header = raw.slice(4, closeIx);
  const body = raw.slice(closeIx + 4).replace(/^\n/, '');

  const fm: Partial<Frontmatter> = {};
  for (const line of header.split('\n')) {
    const ix = line.indexOf(':');
    if (ix === -1) continue;
    const key = line.slice(0, ix).trim();
    const value = line.slice(ix + 1).trim();
    if (key === 'title' || key === 'slug' || key === 'summary' || key === 'tags') {
      fm[key] = value;
    }
  }
  if (!fm.title || !fm.slug || !fm.summary) {
    throw new Error(`${file}: frontmatter must include title, slug and summary.`);
  }
  return { fm: fm as Frontmatter, body };
}

function sortOrderFromFilename(filename: string): number {
  const m = filename.match(/^(\d+)/);
  if (!m) return 100;
  // Multiply by 10 so manual re-ordering between files is easy later.
  return Number(m[1]) * 10;
}

async function readArticles(locale: string): Promise<ParsedArticle[]> {
  const dir = path.join(LOCALES_ROOT, locale, 'help');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ParsedArticle[] = [];
  for (const file of entries) {
    const full = path.join(dir, file);
    const raw = await fs.readFile(full, 'utf8');
    const { fm, body } = parseFrontmatter(raw, file);
    out.push({ ...fm, body, sortOrder: sortOrderFromFilename(file) });
  }
  return out;
}

function renderHtml(markdown: string): string {
  marked.setOptions({ gfm: true, breaks: false });
  return marked.parse(markdown, { async: false }) as string;
}

async function ingestLocale(locale: string): Promise<{ upserted: number; archived: number }> {
  const articles = await readArticles(locale);
  const existing = await controlDb.helpArticle.findMany({
    where: { locale },
    select: { slug: true, sourceHash: true, archivedAt: true },
  });
  const existingBySlug = new Map(existing.map((e) => [e.slug, e]));

  let upserted = 0;
  for (const a of articles) {
    const hash = createHash('sha256').update(a.body).digest('hex');
    const prev = existingBySlug.get(a.slug);
    if (prev && prev.sourceHash === hash && prev.archivedAt === null) {
      // Unchanged + active: skip the round-trip entirely.
      continue;
    }
    const html = renderHtml(a.body);
    await controlDb.helpArticle.upsert({
      where: { slug_locale: { slug: a.slug, locale } },
      create: {
        slug: a.slug,
        locale,
        title: a.title,
        summary: a.summary,
        tags: a.tags ?? null,
        sortOrder: a.sortOrder,
        bodyMarkdown: a.body,
        bodyHtml: html,
        sourceHash: hash,
      },
      update: {
        title: a.title,
        summary: a.summary,
        tags: a.tags ?? null,
        sortOrder: a.sortOrder,
        bodyMarkdown: a.body,
        bodyHtml: html,
        sourceHash: hash,
        archivedAt: null,
      },
    });
    upserted += 1;
  }

  const fileSlugs = new Set(articles.map((a) => a.slug));
  const toArchive = existing.filter((e) => !fileSlugs.has(e.slug) && e.archivedAt === null);
  for (const row of toArchive) {
    await controlDb.helpArticle.update({
      where: { slug_locale: { slug: row.slug, locale } },
      data: { archivedAt: new Date() },
    });
  }

  return { upserted, archived: toArchive.length };
}

async function main() {
  const locales = ['en', 'el'];
  for (const locale of locales) {
    const { upserted, archived } = await ingestLocale(locale);
    // eslint-disable-next-line no-console
    console.log(`[help:${locale}] upserted=${upserted} archived=${archived}`);
  }
  await controlDb.$disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('Ingest failed:', err);
  await controlDb.$disconnect();
  process.exit(1);
});
