'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';
import { ReservationRowActions } from './ReservationRowActions';

export type ReservationRow = {
  id: string;
  placedAt: string;
  queuePosition: number | null;
  status: 'queued' | 'ready' | 'fulfilled' | 'expired' | 'canceled';
  readyAt: string | null;
  expiresAt: string | null;
  book: { id: string; title: string };
  member: { id: string; memberNumber: string; fullName: string };
  fulfilledByCopy: { id: string; barcode: string } | null;
};

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  status: string | undefined;
  includeResolved: boolean;
  initial: { items: ReservationRow[]; nextCursor: string | null };
};

export function ReservationsTable({
  catalog,
  locale,
  slug,
  status,
  includeResolved,
  initial,
}: Props) {
  const t = createTranslator(catalog, locale);

  const columns: Column<ReservationRow>[] = [
    {
      key: 'queuePosition',
      header: '#',
      render: (r) =>
        r.status === 'queued' && r.queuePosition !== null
          ? String(r.queuePosition)
          : r.status === 'ready'
            ? '★'
            : '—',
    },
    {
      key: 'book',
      header: t('reservations.columns.book'),
      render: (r) => <strong>{r.book.title}</strong>,
    },
    {
      key: 'member',
      header: t('reservations.columns.member'),
      render: (r) => (
        <div>
          <div>{r.member.fullName}</div>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
            {r.member.memberNumber}
          </div>
        </div>
      ),
    },
    {
      key: 'placedAt',
      header: t('reservations.columns.placedAt'),
      render: (r) => new Date(r.placedAt).toLocaleDateString(locale),
    },
    {
      key: 'status',
      header: t('reservations.columns.status'),
      render: (r) => {
        const colors: Record<ReservationRow['status'], string> = {
          queued: 'var(--color-info)',
          ready: 'var(--color-success)',
          fulfilled: 'var(--color-text-muted)',
          expired: 'var(--color-warning)',
          canceled: 'var(--color-text-muted)',
        };
        const expires =
          r.status === 'ready' && r.expiresAt
            ? ` · ${t('reservations.expiresAt', {
                date: new Date(r.expiresAt).toLocaleString(locale),
              })}`
            : '';
        return (
          <span style={{ color: colors[r.status], fontWeight: 500 }}>
            {t(`reservations.status.${r.status}`)}
            <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>{expires}</span>
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <ReservationRowActions slug={slug} reservation={r} catalog={catalog} locale={locale} />
      ),
    },
  ];

  return (
    <DataTable<ReservationRow>
      endpoint={`/t/${slug}/reservations`}
      baseQuery={{
        limit: '25',
        status,
        includeResolved: includeResolved ? '1' : undefined,
      }}
      initial={initial}
      columns={columns}
      emptyTitle={t('reservations.empty.title')}
      emptyDescription={t('reservations.empty.description')}
      loadMoreLabel={t('common.actions.loadMore')}
      emptyIllustration="illustrations/empty-catalog"
    />
  );
}
