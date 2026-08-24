'use client';
import * as React from 'react';
import { Button, useToast } from '@libriant/ui';
import type { Catalog, Locale } from '@libriant/i18n';
import { createTranslator } from '@libriant/i18n';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { Combobox } from './Combobox';

type Author = { id: string; fullName: string };

type Props = {
  slug: string;
  catalog: Catalog;
  locale: Locale;
  /** Currently-picked authors, in the order they were added. */
  value: Author[];
  onChange: (next: Author[]) => void;
};

/**
 * Multi-author picker for the book form. Behaviors:
 *
 *   - Autocomplete on existing authors via the regular Combobox (debounced
 *     `/catalog/authors?q=…`).
 *   - When no match exists, a "+ Add new author" affordance appears at
 *     the bottom of the input area. Clicking it POSTs `/catalog/authors`
 *     with the current query text and adds the new row to the selection.
 *   - Selected authors render as removable chips. Order is preserved
 *     (matches `BookAuthorLinkDto.order`).
 */
export function AuthorPicker({ slug, catalog, locale, value, onChange }: Props) {
  const t = createTranslator(catalog, locale);
  const toast = useToast();
  const [pendingName, setPendingName] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  function add(a: Author) {
    if (value.some((x) => x.id === a.id)) return;
    onChange([...value, a]);
  }

  function remove(authorId: string) {
    onChange(value.filter((a) => a.id !== authorId));
  }

  async function createNew() {
    const fullName = pendingName.trim();
    if (!fullName) return;
    setCreating(true);
    try {
      const created = await api<Author>(`/t/${slug}/catalog/authors`, {
        method: 'POST',
        body: { fullName },
      });
      toast.show({
        severity: 'success',
        title: t('catalog.book.authorCreated'),
        body: created.fullName,
      });
      add(created);
      setPendingName('');
    } catch (err) {
      toast.show({
        severity: 'critical',
        title: translateApiError(err, t, t('common.states.error')),
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      {value.length > 0 ? (
        <ul
          aria-label={t('catalog.book.selectedAuthors')}
          style={{
            listStyle: 'none',
            margin: '0 0 var(--sp-3) 0',
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sp-2)',
          }}
        >
          {value.map((a) => (
            <li
              key={a.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--sp-1)',
                background: 'var(--color-surface-muted)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-full)',
                padding: 'var(--sp-1) var(--sp-3)',
                fontSize: 'var(--fs-sm)',
              }}
            >
              {a.fullName}
              <button
                type="button"
                aria-label={t('catalog.book.removeAuthor', { name: a.fullName })}
                onClick={() => remove(a.id)}
                style={{
                  background: 'transparent',
                  border: 0,
                  cursor: 'pointer',
                  fontSize: '1.125rem',
                  lineHeight: 1,
                  color: 'var(--color-text-muted)',
                  padding: 0,
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Combobox<Author>
        id="book-author-picker"
        placeholder={t('catalog.book.authorPlaceholder')}
        clearLabel={t('common.combobox.clear')}
        noMatchesText={t('common.combobox.noMatches')}
        value={null}
        onChange={(a) => {
          if (a) {
            add(a);
            setPendingName('');
          }
        }}
        endpoint={(q) => {
          setPendingName(q);
          return `/t/${slug}/catalog/authors?q=${encodeURIComponent(q)}&limit=8`;
        }}
        renderOption={(a) => <div>{a.fullName}</div>}
        renderSelected={(a) => <div>{a.fullName}</div>}
      />
      {pendingName.trim().length >= 2 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          loading={creating}
          onClick={createNew}
          style={{ marginTop: 'var(--sp-2)' }}
        >
          + {t('catalog.book.createAuthor', { name: pendingName.trim() })}
        </Button>
      ) : null}
    </div>
  );
}
