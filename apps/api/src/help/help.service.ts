import { Injectable, NotFoundException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';

const LOCALES = ['en', 'el'] as const;
type Locale = (typeof LOCALES)[number];

function pickLocale(input: string | undefined): Locale {
  return LOCALES.includes(input as Locale) ? (input as Locale) : 'en';
}

export type ArticleListItem = {
  slug: string;
  title: string;
  summary: string;
  tags: string | null;
  sortOrder: number;
  updatedAt: Date;
};

export type ArticleDetail = ArticleListItem & {
  bodyHtml: string;
  locale: Locale;
};

type SearchRow = {
  slug: string;
  title: string;
  summary: string;
  tags: string | null;
  sortOrder: number;
  updatedAt: Date;
  /**
   * `ts_rank` of the row's tsvector against the parsed query. Higher is
   * a better match; we surface it so the UI can sort by relevance when
   * a search query is set, then fall back to sortOrder for browsing.
   */
  rank: number | null;
};

@Injectable()
export class HelpService {
  /**
   * List articles, optionally filtered by a free-text search query. When
   * `q` is set we go through `tsquery` (locale-appropriate FTS config) +
   * the same `immutable_unaccent` wrapper the index uses; results sort
   * by `ts_rank` desc. When `q` is empty we just enumerate by `sortOrder`.
   */
  async list(input: {
    locale?: string;
    q?: string;
    limit?: number;
  }): Promise<{ locale: Locale; items: ArticleListItem[]; query: string | null }> {
    const locale = pickLocale(input.locale);
    const limit = Math.max(1, Math.min(50, input.limit ?? 20));
    const q = input.q?.trim() ?? '';

    if (q.length === 0) {
      const rows = await controlDb.helpArticle.findMany({
        where: { locale, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
        take: limit,
        select: {
          slug: true,
          title: true,
          summary: true,
          tags: true,
          sortOrder: true,
          updatedAt: true,
        },
      });
      return { locale, items: rows, query: null };
    }

    // We hand-craft the query so it travels through plainto_tsquery + the
    // unaccent wrapper. `plainto_tsquery` is forgiving with punctuation,
    // which is exactly what a librarian's "type whatever you want" search
    // needs.
    const config = locale === 'en' ? 'english' : 'simple';
    const rows = (await controlDb.$queryRawUnsafe(
      `
      SELECT slug, title, summary, tags, "sortOrder", "updatedAt",
             ts_rank(search_tsv, q) AS rank
      FROM help_articles,
           plainto_tsquery($1::regconfig, public.immutable_unaccent($2)) AS q
      WHERE locale = $3
        AND "archivedAt" IS NULL
        AND search_tsv @@ q
      ORDER BY rank DESC, "sortOrder" ASC
      LIMIT $4;
      `,
      config,
      q,
      locale,
      limit,
    )) as SearchRow[];

    return {
      locale,
      query: q,
      items: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        summary: r.summary,
        tags: r.tags,
        sortOrder: r.sortOrder,
        updatedAt: new Date(r.updatedAt),
      })),
    };
  }

  /** Single article by slug. 404s if missing or archived. */
  async get(input: { locale?: string; slug: string }): Promise<ArticleDetail> {
    const locale = pickLocale(input.locale);
    const row = await controlDb.helpArticle.findFirst({
      where: { slug: input.slug, locale, archivedAt: null },
      select: {
        slug: true,
        title: true,
        summary: true,
        tags: true,
        sortOrder: true,
        updatedAt: true,
        bodyHtml: true,
      },
    });
    if (!row) {
      // If the article is missing in the requested locale, fall back to
      // English so a librarian browsing in Greek still gets the content
      // (and a marker the UI can render as "translated soon").
      if (locale !== 'en') {
        const en = await controlDb.helpArticle.findFirst({
          where: { slug: input.slug, locale: 'en', archivedAt: null },
          select: {
            slug: true,
            title: true,
            summary: true,
            tags: true,
            sortOrder: true,
            updatedAt: true,
            bodyHtml: true,
          },
        });
        if (en) return { ...en, locale: 'en' };
      }
      throw new NotFoundException('Help article not found.');
    }
    return { ...row, locale };
  }
}
