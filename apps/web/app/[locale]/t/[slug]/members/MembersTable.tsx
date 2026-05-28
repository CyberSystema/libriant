'use client';
import * as React from 'react';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { DataTable, type Column } from '@/components/DataTable';

export type MemberRow = {
  id: string;
  memberNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'suspended' | 'archived';
  joinedAt: string;
};

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  status: string | undefined;
  initial: { items: MemberRow[]; nextCursor: string | null };
};

export function MembersTable({ catalog, locale, slug, status, initial }: Props) {
  const t = createTranslator(catalog, locale);
  const columns: Column<MemberRow>[] = [
    {
      key: 'memberNumber',
      header: t('members.columns.cardNumber'),
      render: (m) => m.memberNumber,
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
      header: 'Phone',
      render: (m) => m.phone ?? '—',
    },
    {
      key: 'status',
      header: t('members.columns.status'),
      render: (m) => {
        const label = t(`members.status.${m.status}`);
        const color =
          m.status === 'active'
            ? 'var(--color-success)'
            : m.status === 'suspended'
              ? 'var(--color-warning)'
              : 'var(--color-text-muted)';
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
    <DataTable<MemberRow>
      endpoint={`/t/${slug}/members`}
      baseQuery={{ limit: '25', status }}
      initial={initial}
      columns={columns}
      searchParam="q"
      searchPlaceholder={t('members.search')}
      emptyTitle={t('members.empty.title')}
      emptyDescription={t('members.empty.description')}
      emptyIllustration="illustrations/empty-members"
      rowHref={(m) => `/${locale}/t/${slug}/members/${m.id}`}
    />
  );
}
