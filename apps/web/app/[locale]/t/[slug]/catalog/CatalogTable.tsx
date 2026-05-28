'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';

export type CatalogBook = {
  id: string;
  title: string;
  subtitle: string | null;
  publicationYear: number | null;
  language: string | null;
  isbn13: string | null;
  authors: Array<{ authorId: string; fullName: string; order: number }>;
};

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  initial: { items: CatalogBook[]; nextCursor: string | null };
};

export function CatalogTable({ catalog, locale, slug, initial }: Props) {
  const t = createTranslator(catalog, locale);
  const columns: Column<CatalogBook>[] = [
    {
      key: 'title',
      header: t('catalog.columns.title'),
      render: (b) => (
        <div>
          <div style={{ fontWeight: 500 }}>{b.title}</div>
          {b.subtitle ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
              {b.subtitle}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'authors',
      header: t('catalog.columns.author'),
      render: (b) =>
        b.authors.length === 0
          ? '—'
          : b.authors
              .slice()
              .sort((a, c) => a.order - c.order)
              .map((a) => a.fullName)
              .join(', '),
    },
    {
      key: 'publicationYear',
      header: t('catalog.columns.year'),
      render: (b) => (b.publicationYear ? String(b.publicationYear) : '—'),
    },
    {
      key: 'isbn13',
      header: t('catalog.columns.isbn'),
      render: (b) => b.isbn13 ?? '—',
    },
    {
      key: 'language',
      header: t('catalog.columns.language'),
      render: (b) => (b.language ? b.language.toUpperCase() : '—'),
    },
  ];

  return (
    <DataTable<CatalogBook>
      endpoint={`/t/${slug}/catalog/books`}
      baseQuery={{ limit: '25' }}
      initial={initial}
      columns={columns}
      searchParam="q"
      searchPlaceholder={t('catalog.search')}
      emptyTitle={t('catalog.empty.title')}
      emptyDescription={t('catalog.empty.description')}
      emptyIllustration="illustrations/empty-catalog"
      rowHref={(b) => `/${locale}/t/${slug}/catalog/${b.id}`}
    />
  );
}
