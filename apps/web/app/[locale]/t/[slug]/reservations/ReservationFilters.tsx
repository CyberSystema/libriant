'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

type Props = { catalog: Catalog; locale: Locale };

const STATUSES = ['queued', 'ready', 'fulfilled', 'expired', 'canceled'] as const;

/** Filter pills above the reservations table. */
export function ReservationFilters({ catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const search = useSearchParams();
  const status = search?.get('status') ?? '';
  const includeResolved = search?.get('includeResolved') === '1';

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
      aria-label="Filter reservations"
      style={{
        display: 'flex',
        gap: 'var(--sp-2)',
        flexWrap: 'wrap',
        marginBottom: 'var(--sp-4)',
      }}
    >
      <button
        type="button"
        className={`lbr-btn lbr-btn--sm ${status === '' ? 'lbr-btn--primary' : 'lbr-btn--secondary'}`}
        onClick={() => set({ status: null })}
      >
        {t('reservations.filters.active')}
      </button>
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          className={`lbr-btn lbr-btn--sm ${status === s ? 'lbr-btn--primary' : 'lbr-btn--secondary'}`}
          onClick={() => set({ status: s, includeResolved: '1' })}
        >
          {t(`reservations.status.${s}`)}
        </button>
      ))}
      <button
        type="button"
        className={`lbr-btn lbr-btn--sm ${includeResolved && !status ? 'lbr-btn--secondary' : 'lbr-btn--ghost'}`}
        onClick={() =>
          set({
            includeResolved: includeResolved ? null : '1',
            status: null,
          })
        }
      >
        {includeResolved
          ? t('reservations.filters.hideResolved')
          : t('reservations.filters.includeResolved')}
      </button>
    </div>
  );
}
