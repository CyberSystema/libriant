'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

type Props = {
  catalog: Catalog;
  locale: Locale;
  slug: string;
  kinds: string[];
  current: string;
};

/**
 * Horizontal tab strip of entity kinds. Clicking a tab updates the URL
 * `?entity=…` so the server-rendered page re-fetches the right field list.
 */
export function EntityTabs({ catalog, locale, current, kinds }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const search = useSearchParams();

  function go(kind: string) {
    const next = new URLSearchParams(Array.from(search?.entries() ?? []));
    next.set('entity', kind);
    router.push(`?${next.toString()}`);
  }

  return (
    <div
      role="tablist"
      aria-label={t('settings.dataModel.entityTabsLabel')}
      style={{
        display: 'flex',
        gap: 'var(--sp-1)',
        marginBottom: 'var(--sp-4)',
        borderBottom: '1px solid var(--color-border-muted)',
        paddingBottom: 'var(--sp-1)',
        flexWrap: 'wrap',
      }}
    >
      {kinds.map((k) => {
        const active = k === current;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => go(k)}
            style={{
              background: active ? 'var(--color-surface)' : 'transparent',
              border: active ? '1px solid var(--color-border-muted)' : '1px solid transparent',
              borderBottom: active ? '1px solid var(--color-surface)' : '1px solid transparent',
              marginBottom: -1,
              padding: 'var(--sp-2) var(--sp-3)',
              borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
              cursor: 'pointer',
              fontWeight: active ? 600 : 400,
              color: active ? 'var(--color-primary)' : 'var(--color-text-muted)',
              fontSize: 'var(--fs-sm)',
            }}
          >
            {t(`settings.dataModel.entity.${k}`)}
          </button>
        );
      })}
    </div>
  );
}
