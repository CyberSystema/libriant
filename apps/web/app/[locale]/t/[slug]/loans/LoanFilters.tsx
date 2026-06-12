'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

type Props = { catalog: Catalog; locale: Locale };

const STATUSES = ['active', 'returned', 'lost'] as const;

/**
 * Toolbar above the loans table — status pills + an "Overdue only" toggle.
 * Both push their state back into the URL so a librarian's bookmark
 * preserves the filter they had in view.
 */
export function LoanFilters({ catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const search = useSearchParams();
  const status = search?.get('status') ?? '';
  const overdue = search?.get('overdue') === '1';

  function set(updates: Record<string, string | null>) {
    const next = new URLSearchParams(Array.from(search?.entries() ?? []));
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    router.push(`?${next.toString()}`);
  }

  return (
    <div
      role="group"
      aria-label={t('loans.filterAria')}
      style={{
        display: 'flex',
        gap: 'var(--sp-2)',
        flexWrap: 'wrap',
        marginBottom: 'var(--sp-4)',
      }}
    >
      <button
        type="button"
        className={`lbr-btn lbr-btn--sm ${status === '' && !overdue ? 'lbr-btn--primary' : 'lbr-btn--secondary'}`}
        onClick={() => set({ status: null, overdue: null })}
      >
        {t('loans.filters.allStatuses')}
      </button>
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          className={`lbr-btn lbr-btn--sm ${status === s && !overdue ? 'lbr-btn--primary' : 'lbr-btn--secondary'}`}
          onClick={() => set({ status: s, overdue: null })}
        >
          {t(`loans.status.${s}`)}
        </button>
      ))}
      <button
        type="button"
        className={`lbr-btn lbr-btn--sm ${overdue ? 'lbr-btn--danger' : 'lbr-btn--secondary'}`}
        onClick={() => set({ overdue: overdue ? null : '1', status: null })}
      >
        {t('loans.filters.overdueOnly')}
      </button>
    </div>
  );
}
