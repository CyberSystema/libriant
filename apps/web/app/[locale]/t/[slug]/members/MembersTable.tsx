'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';

/**
 * A row of the 2.0 roster (`GET /t/:slug/patrons`).
 *
 * THREE THINGS CHANGED SHAPE, and each is a decision the 2.0 surface made:
 *
 *   - `memberNumber` is `patronNumber` and is **nullable**. The schema says why:
 *     "a patron created by a bulk import may not have one yet and a fast-add at
 *     the desk should not block on minting". So it dashes like every other
 *     nullable column here — a raw render would be a silently empty cell, and
 *     TypeScript would not catch it, because `string | null` is a valid
 *     `ReactNode`.
 *   - `archived` is no longer a STATUS, it is a TIMESTAMP. A row can be
 *     `active` and archived at once, so the two are rendered separately; the
 *     status enum gained `closed` in its place.
 *   - `expired` is DERIVED by the server, with the same comparison the checkout
 *     gate makes. It is not a status member on purpose — "a status column that
 *     has to be swept nightly to stay true is a column that is wrong every night
 *     until the sweep runs" — so the roster must not recompute it here and risk
 *     telling a librarian a card is fine on the morning the desk refuses it.
 */
export type PatronRow = {
  id: string;
  patronNumber: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'suspended' | 'closed';
  expired: boolean;
  archivedAt: string | null;
  erasedAt: string | null;
  joinedAt: string;
};

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  status: string | undefined;
  initial: { items: PatronRow[]; nextCursor: string | null; minQueryChars?: number };
};

export function MembersTable({ catalog, locale, slug, status, initial }: Props) {
  const t = createTranslator(catalog, locale);
  const columns: Column<PatronRow>[] = [
    {
      key: 'patronNumber',
      header: t('members.columns.cardNumber'),
      // Dashed, not raw: nullable in 2.0 (see the type above).
      render: (m) => m.patronNumber ?? '—',
    },
    {
      key: 'fullName',
      header: t('members.columns.name'),
      render: (m) => <strong>{m.fullName}</strong>,
    },
    {
      key: 'email',
      header: t('members.columns.email'),
      render: (m) => m.email ?? '—',
    },
    {
      key: 'phone',
      header: t('members.columns.phone'),
      render: (m) => m.phone ?? '—',
    },
    {
      key: 'status',
      header: t('members.columns.status'),
      render: (m) => {
        // ARCHIVED and EXPIRED are not statuses and are not exclusive with one.
        // A row can be `active`, expired and archived at the same time, so the
        // label says the one that most changes what a librarian does next:
        // archived means the row has left the roster, expired means the desk
        // will refuse the card today whatever the status column says.
        const label = m.archivedAt
          ? t('members.status.archived')
          : m.expired
            ? t('members.status.expired')
            : t(`members.status.${m.status}`);
        const color =
          m.archivedAt || m.status === 'closed'
            ? 'var(--color-text-muted)'
            : m.expired || m.status === 'suspended'
              ? 'var(--color-warning-text)'
              : 'var(--color-success)';
        return (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--sp-1)',
              color,
              fontWeight: 500,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'currentColor',
              }}
              aria-hidden
            />
            {label}
          </span>
        );
      },
    },
  ];

  return (
    <DataTable<PatronRow>
      endpoint={`/t/${slug}/patrons`}
      baseQuery={{ limit: '25', status }}
      initial={initial}
      columns={columns}
      searchParam="q"
      searchPlaceholder={t('members.search')}
      searchLabel={t('common.actions.search')}
      noMatchesTitle={t('common.table.noMatches')}
      noMatchesDescription={t('common.table.noMatchesHint')}
      emptyTitle={t('members.empty.title')}
      emptyDescription={t('members.empty.description')}
      minCharsText={t('common.search.minChars')}
      loadMoreLabel={t('common.actions.loadMore')}
      emptyIllustration="illustrations/empty-members"
      rowHref={(m) => `/${locale}/t/${slug}/members/${m.id}`}
    />
  );
}
