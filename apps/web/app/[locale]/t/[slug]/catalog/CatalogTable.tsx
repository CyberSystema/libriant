'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';

/**
 * A row of the 2.0 catalogue list (`GET /t/:slug/catalog/bib`).
 *
 * THREE FIELDS CHANGED SHAPE and each absence is a decision the 2.0 read
 * surface made, not an oversight:
 *
 *   - no `subtitle`. The projector joins 245 $a and $b into `title`, because a
 *     MARC record does not have a subtitle field — it has a title statement.
 *   - no `authors[]`. A contributor is a 100 or 700 field inside the record and
 *     there is no authority store until phase 45, so there is no id to key a
 *     row on. `browseAuthor` is the browse form — the name without dates, so
 *     "Καζαντζάκης, Νίκος, 1883-1957." and "Καζαντζάκης, Νίκος." are one
 *     entry — and `mainEntryDisplay` is what the record actually says.
 *   - `language` is `languageCode`, ISO 639-2/B and three characters.
 */
export type CatalogBib = {
  id: string;
  title: string;
  statementOfResp: string | null;
  mainEntryDisplay: string | null;
  browseAuthor: string | null;
  publicationYear: number | null;
  languageCode: string | null;
  isbn: string | null;
  itemCount: number;
  availableCount: number;
};

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  initial: { items: CatalogBib[]; nextCursor: string | null; minQueryChars?: number };
};

export function CatalogTable({ catalog, locale, slug, initial }: Props) {
  const t = createTranslator(catalog, locale);
  const columns: Column<CatalogBib>[] = [
    {
      key: 'title',
      header: t('catalog.columns.title'),
      render: (b) => (
        <div>
          <div style={{ fontWeight: 500 }}>{b.title}</div>
          {/*
            The statement of responsibility — 245 $c, "Νίκος Καζαντζάκης." —
            where the subtitle used to be. It is what the TITLE PAGE says, which
            is a different fact from the heading in the author column, and a
            cataloguer reads both.
          */}
          {b.statementOfResp ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
              {b.statementOfResp}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'author',
      header: t('catalog.columns.author'),
      render: (b) => b.mainEntryDisplay ?? b.browseAuthor ?? '—',
    },
    {
      key: 'publicationYear',
      header: t('catalog.columns.year'),
      render: (b) => (b.publicationYear ? String(b.publicationYear) : '—'),
    },
    {
      key: 'isbn',
      header: t('catalog.columns.isbn'),
      render: (b) => b.isbn ?? '—',
    },
    {
      key: 'languageCode',
      header: t('catalog.columns.language'),
      render: (b) => (b.languageCode ? b.languageCode.toUpperCase() : '—'),
    },
    {
      key: 'copies',
      header: t('catalog.columns.copies'),
      render: (b) => `${b.availableCount} / ${b.itemCount}`,
    },
  ];

  return (
    <DataTable<CatalogBib>
      endpoint={`/t/${slug}/catalog/bib`}
      baseQuery={{ limit: '25' }}
      initial={initial}
      columns={columns}
      searchParam="q"
      searchPlaceholder={t('catalog.search')}
      searchLabel={t('common.actions.search')}
      noMatchesTitle={t('common.table.noMatches')}
      noMatchesDescription={t('common.table.noMatchesHint')}
      minCharsText={t('common.search.minChars')}
      emptyTitle={t('catalog.empty.title')}
      emptyDescription={t('catalog.empty.description')}
      loadMoreLabel={t('common.actions.loadMore')}
      emptyIllustration="illustrations/empty-catalog"
      rowHref={(b) => `/${locale}/t/${slug}/catalog/${b.id}`}
    />
  );
}
