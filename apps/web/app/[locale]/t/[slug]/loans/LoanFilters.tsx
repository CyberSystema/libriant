'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

type Props = { catalog: Catalog; locale: Locale };

/**
 * The six stored statuses, in the order a desk meets them (2.0 phase 20q).
 *
 * 1.0 had three. The three new ones are not obscure — `recalled` is what a
 * librarian does when someone else needs the book now, and the two `claims_*`
 * states are the dispute a desk has to be able to find again tomorrow. Leaving
 * them out of the toolbar would make them unreachable through the UI while the
 * table still rendered them.
 */
const STATUSES = [
  'active',
  'returned',
  'lost',
  'recalled',
  'claims_returned',
  'claims_never_borrowed',
] as const;

/**
 * Toolbar above the loans table — status pills, "Out now", and "Overdue only".
 * All three push their state back into the URL so a librarian's bookmark
 * preserves the filter they had in view.
 *
 * ## The three are mutually exclusive in the toolbar, and must be
 *
 * `?overdue=1` IS the active-and-past-due queue, so the API refuses it paired
 * with any other status — setting one clears the other rather than letting the
 * page build a request that can only 400. `?open=1` is a superset of both, so it
 * clears them for a different reason: showing "Out now" and "Lost" together
 * would ask for loans that are simultaneously open and closed.
 */
export function LoanFilters({ catalog, locale }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const search = useSearchParams();
  const status = search?.get('status') ?? '';
  const overdue = search?.get('overdue') === '1';
  const open = search?.get('open') === '1';
  const unfiltered = status === '' && !overdue && !open;

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
        className={`lbr-btn lbr-btn--sm ${unfiltered ? 'lbr-btn--primary' : 'lbr-btn--secondary'}`}
        onClick={() => set({ status: null, overdue: null, open: null })}
      >
        {t('loans.filters.allStatuses')}
      </button>
      {/*
        "Out now" — the filter 1.0's `status=active` was pretending to be. The
        open set is four statuses, so this is the only honest answer to "which
        books are not on the shelf", and `?open=1` is also the only form that
        walks `loans_one_open_per_item`.
      */}
      <button
        type="button"
        className={`lbr-btn lbr-btn--sm ${open ? 'lbr-btn--primary' : 'lbr-btn--secondary'}`}
        onClick={() => set({ open: open ? null : '1', status: null, overdue: null })}
      >
        {t('loans.filters.openOnly')}
      </button>
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          className={`lbr-btn lbr-btn--sm ${status === s && !overdue && !open ? 'lbr-btn--primary' : 'lbr-btn--secondary'}`}
          onClick={() => set({ status: s, overdue: null, open: null })}
        >
          {t(`loans.status.${s}`)}
        </button>
      ))}
      <button
        type="button"
        className={`lbr-btn lbr-btn--sm ${overdue ? 'lbr-btn--danger' : 'lbr-btn--secondary'}`}
        onClick={() => set({ overdue: overdue ? null : '1', status: null, open: null })}
      >
        {t('loans.filters.overdueOnly')}
      </button>
    </div>
  );
}
