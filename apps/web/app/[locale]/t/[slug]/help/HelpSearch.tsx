'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Input } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';

type Props = {
  catalog: Catalog;
  locale: Locale;
  initialQuery: string;
};

/**
 * Search input above the help-articles list. Pushes the query into the
 * URL `?q=…` so the server-rendered page re-fetches against the FTS
 * endpoint, and the user can bookmark or share the search.
 */
export function HelpSearch({ catalog, locale, initialQuery }: Props) {
  const t = createTranslator(catalog, locale);
  const router = useRouter();
  const search = useSearchParams();
  const [query, setQuery] = React.useState(initialQuery);

  React.useEffect(() => setQuery(initialQuery), [initialQuery]);

  function commit() {
    const next = new URLSearchParams(Array.from(search?.entries() ?? []));
    const trimmed = query.trim();
    if (trimmed.length) next.set('q', trimmed);
    else next.delete('q');
    router.push(`?${next.toString()}`);
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--sp-3)',
        alignItems: 'center',
        marginBottom: 'var(--sp-4)',
        maxWidth: 560,
      }}
    >
      <Input
        type="search"
        aria-label={t('help.searchAria')}
        placeholder={t('help.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <Button variant="secondary" onClick={commit}>
        {t('common.actions.search')}
      </Button>
    </div>
  );
}
