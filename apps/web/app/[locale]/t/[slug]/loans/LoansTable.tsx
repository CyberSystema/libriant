'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';

export type LoanRow = {
  id: string;
  loanedAt: string;
  dueAt: string;
  returnedAt: string | null;
  renewedCount: number;
  status: 'active' | 'returned' | 'lost';
  member: { id: string; memberNumber: string; fullName: string };
  copy: { id: string; barcode: string; book: { id: string; title: string } };
};

function diffDays(a: string, b: string): number {
  return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  status: string | undefined;
  overdue: boolean;
  initial: { items: LoanRow[]; nextCursor: string | null };
};

export function LoansTable({ catalog, locale, slug, status, overdue, initial }: Props) {
  const t = createTranslator(catalog, locale);
  const now = new Date().toISOString();

  const columns: Column<LoanRow>[] = [
    {
      key: 'book',
      header: t('loans.columns.book'),
      render: (l) => (
        <div>
          <div style={{ fontWeight: 500 }}>{l.copy.book.title}</div>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
            {l.copy.barcode}
          </div>
        </div>
      ),
    },
    {
      key: 'member',
      header: t('loans.columns.member'),
      render: (l) => (
        <div>
          <div>{l.member.fullName}</div>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
            {l.member.memberNumber}
          </div>
        </div>
      ),
    },
    {
      key: 'loanedAt',
      header: t('loans.columns.checkedOut'),
      render: (l) => new Date(l.loanedAt).toLocaleDateString(locale),
    },
    {
      key: 'dueAt',
      header: t('loans.columns.dueDate'),
      render: (l) => {
        const dueStr = new Date(l.dueAt).toLocaleDateString(locale);
        if (l.status !== 'active') return dueStr;
        const days = diffDays(l.dueAt, now);
        if (days < 0) {
          return (
            <span style={{ color: 'var(--color-danger)' }}>
              {dueStr} · {t('loans.overdueBy', { days: -days })}
            </span>
          );
        }
        if (days <= 3) {
          return (
            <span style={{ color: 'var(--color-warning)' }}>
              {dueStr} · {t('loans.dueIn', { days })}
            </span>
          );
        }
        return dueStr;
      },
    },
    {
      key: 'status',
      header: t('loans.columns.status'),
      render: (l) => {
        const isOverdue = l.status === 'active' && new Date(l.dueAt) < new Date(now);
        if (isOverdue) {
          return (
            <span style={{ color: 'var(--color-danger)', fontWeight: 500 }}>
              {t('loans.status.overdue')}
            </span>
          );
        }
        const color =
          l.status === 'active'
            ? 'var(--color-info)'
            : l.status === 'returned'
              ? 'var(--color-success)'
              : 'var(--color-danger)';
        return <span style={{ color, fontWeight: 500 }}>{t(`loans.status.${l.status}`)}</span>;
      },
    },
  ];

  return (
    <DataTable<LoanRow>
      endpoint={`/t/${slug}/loans`}
      baseQuery={{
        limit: '25',
        status,
        overdue: overdue ? '1' : undefined,
      }}
      initial={initial}
      columns={columns}
      emptyTitle={t('loans.empty.title')}
      emptyDescription={t('loans.empty.description')}
      loadMoreLabel={t('common.actions.loadMore')}
      emptyIllustration="illustrations/empty-catalog"
    />
  );
}
