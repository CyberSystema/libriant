'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { Input, Skeleton } from '@libriant/ui';
import { api } from '@/lib/api';
import { translateApiError } from '@/lib/api-errors';
import { safeLocale, staticTranslator } from '@/lib/static-catalog';

type ListResponse<T> = { items: T[]; nextCursor: string | null };

type Props<T extends { id: string }> = {
  /** Stable id used by the underlying <Input>. */
  id: string;
  /** What the librarian sees in the input when nothing is picked. */
  placeholder: string;
  /** Already-picked item; pass `null` to start empty. */
  value: T | null;
  /** Called with `null` on clear, the row on pick. */
  onChange: (item: T | null) => void;
  /**
   * Builds the API path to query for a given input. Should return a URL
   * the API handler can interpret (e.g. `/t/x/members?q=...&limit=10`).
   */
  endpoint: (query: string) => string;
  /** Render one option in the dropdown. */
  renderOption: (item: T) => React.ReactNode;
  /** Render the picked item back inside the input area. Defaults to JSON. */
  renderSelected?: (item: T) => React.ReactNode;
  /** Minimum characters before we query. Defaults to 1. */
  minQueryChars?: number;
  /** Optional disabled flag. */
  disabled?: boolean;
  /** Localized aria-label for the clear (×) button. */
  clearLabel?: string;
  /** Localized text shown when a query returns no rows. */
  noMatchesText?: string;
};

/**
 * Generic autocomplete picker. Fetches results from an API endpoint as
 * the user types (debounced), supports keyboard navigation (↑/↓ + Enter),
 * and surfaces friendly states for empty / loading / error.
 *
 * Used by:
 *   - Loans checkout (member + book pickers)
 *   - Place-hold form
 *   - Future: any "find an X" UI
 */
export function Combobox<T extends { id: string }>({
  id,
  placeholder,
  value,
  onChange,
  endpoint,
  renderOption,
  renderSelected,
  minQueryChars = 1,
  disabled,
  clearLabel = 'Clear selection',
  noMatchesText = 'No matches.',
}: Props<T>) {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<T[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listboxId = `${id}-listbox`;
  // Every caller of this picker sits under /[locale]/t/[slug], so the locale is
  // in the route. Reading it here rather than adding an `errorText` prop keeps
  // the failure message Greek at all ~15 call sites without threading one more
  // string through each of them.
  const params = useParams();
  const t = staticTranslator(safeLocale(params?.locale));
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  // Debounce queries so we don't hammer the API on every keystroke.
  React.useEffect(() => {
    if (!open) return;
    if (query.trim().length < minQueryChars) {
      setItems([]);
      setLoading(false);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api<ListResponse<T>>(endpoint(query.trim()));
        setItems(res.items);
        setActiveIndex(0);
      } catch (err) {
        setError(translateApiError(err, t));
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, open, minQueryChars, endpoint]);

  // Close the dropdown on outside click.
  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function pick(item: T) {
    onChange(item);
    setOpen(false);
    setQuery('');
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && items[activeIndex]) {
      e.preventDefault();
      pick(items[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div className="lbr-combobox lbr-combobox--picked">
        <div className="lbr-combobox__picked-body">
          {renderSelected ? renderSelected(value) : JSON.stringify(value)}
        </div>
        <button
          type="button"
          className="lbr-combobox__clear"
          aria-label={clearLabel}
          onClick={() => onChange(null)}
          disabled={disabled}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="lbr-combobox" ref={wrapperRef}>
      <Input
        id={id}
        type="search"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKey}
        disabled={disabled}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={items[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
      />
      {open && query.trim().length >= minQueryChars ? (
        <ul id={listboxId} role="listbox" className="lbr-combobox__listbox">
          {loading ? (
            <li className="lbr-combobox__option lbr-combobox__option--inert">
              <Skeleton style={{ height: 12, width: '60%' }} radius="sm" />
            </li>
          ) : error ? (
            <li className="lbr-combobox__option lbr-combobox__option--inert" role="alert">
              {error}
            </li>
          ) : items.length === 0 ? (
            <li className="lbr-combobox__option lbr-combobox__option--inert">{noMatchesText}</li>
          ) : (
            items.map((item, ix) => (
              <li
                key={item.id}
                id={`${listboxId}-${ix}`}
                role="option"
                aria-selected={ix === activeIndex}
                className={
                  ix === activeIndex
                    ? 'lbr-combobox__option lbr-combobox__option--active'
                    : 'lbr-combobox__option'
                }
                onMouseEnter={() => setActiveIndex(ix)}
                onMouseDown={(e) => {
                  // mousedown fires before blur, so we keep the input focused
                  // long enough to commit the pick.
                  e.preventDefault();
                  pick(item);
                }}
              >
                {renderOption(item)}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
