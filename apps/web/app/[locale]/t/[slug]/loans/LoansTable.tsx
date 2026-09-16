'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';

/**
 * One row of `GET /t/:slug/circulation/loans` (2.0 phase 20q).
 *
 * Three fields changed shape in ways a renderer cannot ignore, and each is
 * nullable for a DIFFERENT reason — which is why none of them is defaulted away
 * with `??  ''`:
 *
 *   - **`patron`** is null on every ANONYMISED loan, and anonymisation on return
 *     is the DEFAULT: `reading_history_policy` seeds `mode='anonymised'` and
 *     check-in nulls `patron_id` in the same transaction as the return. So the
 *     Member column is empty for most of the history, by design and not by
 *     accident, and `anonymisedAt` is what tells the two apart.
 *   - **`item.barcode`** is null for a copy catalogued before its label was
 *     printed — a real state in a working library, and one a fast-add creates.
 *   - **`title`** is null only when the projection row is missing, which is
 *     drift the nightly `catalog-verify` job owns and a desk cannot cause.
 *
 * `renewedCount` became `renewalCount`, and `status` went from three values to
 * six.
 */
export type LoanRow = {
  id: string;
  loanedAt: string;
  dueAt: string;
  returnedAt: string | null;
  closedAt: string | null;
  anonymisedAt: string | null;
  renewalCount: number;
  status: 'active' | 'recalled' | 'claims_returned' | 'claims_never_borrowed' | 'returned' | 'lost';
  bibId: string;
  title: string | null;
  item: { id: string; barcode: string | null };
  patron: { id: string; fullName: string; patronNumber: string | null } | null;
};

function diffDays(a: string, b: string): number {
  return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

/**
 * The four statuses `closed_at IS NULL` means — the OPEN set.
 *
 * Not `status === 'active'`, which is the mistake that reads a recalled copy or
 * one the reader claims to have returned as "already back". Those loans are
 * open, the copy is out, and a due date on them is still a live date.
 */
const OPEN: ReadonlySet<LoanRow['status']> = new Set([
  'active',
  'recalled',
  'claims_returned',
  'claims_never_borrowed',
]);

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  status: string | undefined;
  overdue: boolean;
  open: boolean;
  initial: { items: LoanRow[]; nextCursor: string | null };
};

export function LoansTable({ catalog, locale, slug, status, overdue, open, initial }: Props) {
  const t = createTranslator(catalog, locale);
  const now = new Date().toISOString();

  const columns: Column<LoanRow>[] = [
    {
      key: 'book',
      header: t('loans.columns.book'),
      render: (l) => (
        <div>
          <div style={{ fontWeight: 500 }}>{l.title ?? t('loans.unknownTitle')}</div>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
            {l.item.barcode ?? t('loans.noBarcode')}
          </div>
        </div>
      ),
    },
    {
      key: 'member',
      header: t('loans.columns.member'),
      // An empty cell would read as a bug. It is a privacy guarantee the
      // library gave, so it says so.
      render: (l) =>
        l.patron === null ? (
          <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
            {t(l.anonymisedAt === null ? 'loans.readerUnknown' : 'loans.readerErased')}
          </span>
        ) : (
          <div>
            <div>{l.patron.fullName}</div>
            <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
              {l.patron.patronNumber ?? ''}
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
        if (!OPEN.has(l.status)) return dueStr;
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
            <span style={{ color: 'var(--color-warning-text)' }}>
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
        // Overdue is a DERIVED state, not a stored one, and it only overrides
        // `active`: a recalled or claims-returned loan that is past due has
        // something more specific to say than "late".
        if (l.status === 'active' && new Date(l.dueAt) < new Date(now)) {
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
              : l.status === 'lost'
                ? 'var(--color-danger)'
                : // recalled, claims_returned, claims_never_borrowed: open, and
                  // all three are something a librarian has to act on.
                  'var(--color-warning-text)';
        return <span style={{ color, fontWeight: 500 }}>{t(`loans.status.${l.status}`)}</span>;
      },
    },
  ];

  return (
    <DataTable<LoanRow>
      endpoint={`/t/${slug}/circulation/loans`}
      baseQuery={{
        limit: '25',
        status,
        overdue: overdue ? '1' : undefined,
        open: open ? '1' : undefined,
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
