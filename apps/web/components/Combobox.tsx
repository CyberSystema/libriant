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
  /**
   * Localized hint for a query that is too short to send, e.g. "Type at least
   * 3 characters". Required in practice wherever `minQueryChars` > 1: without
   * it the picker simply says nothing while the reader waits for results that
   * are never coming.
   */
  minCharsText?: string;
  /**
   * Called with the trimmed query on every keystroke, whether or not it is long
   * enough to search. AuthorPicker needs the text to offer "create «X»", and
   * used to scrape it out of `endpoint()` — a callback that only runs when a
   * request actually fires. Raising the search floor to three characters would
   * have frozen that name at the last query long enough to send, so the button
   * offered to create an author the reader had already finished deleting.
   */
  onQueryChange?: (query: string) => void;
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
  minCharsText,
  onQueryChange,
}: Props<T>) {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<T[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listboxId = `${id}-listbox`;
  // `aria-expanded` and `aria-controls` must describe the listbox that is
  // ACTUALLY RENDERED. They used to be `open` and an unconditional id, so an
  // idle combobox advertised an expanded popup that did not exist and pointed
  // aria-controls at a missing element (finding frontend-25).
  const trimmed = query.trim();
  const typed = trimmed.length;
  const querying = open && typed >= minQueryChars;
  // Typed something, but not yet enough to search. This state used to render
  // nothing at all, which is the worst of the three options: the reader has
  // typed "Πα", the dropdown is blank, and the only available reading is that
  // the library does not hold the book. Say what is actually true instead.
  const tooShort = open && typed > 0 && typed < minQueryChars && Boolean(minCharsText);
  const listboxVisible = querying && !loading && !error && items.length > 0;
  // Every caller of this picker sits under /[locale]/t/[slug], so the locale is
  // in the route. Reading it here rather than adding an `errorText` prop keeps
  // the failure message Greek at all ~15 call sites without threading one more
  // string through each of them.
  const params = useParams();
  const t = staticTranslator(safeLocale(params?.locale));
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  // Held in a ref so the effect below depends only on the query. Callers pass
  // an inline arrow, which is a new function on every render — depending on it
  // directly would fire the notification on renders where nothing was typed.
  const onQueryChangeRef = React.useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  React.useEffect(() => {
    onQueryChangeRef.current?.(trimmed);
  }, [trimmed]);

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
        aria-expanded={listboxVisible}
        aria-controls={listboxVisible ? listboxId : undefined}
        aria-activedescendant={
          listboxVisible && items[activeIndex] ? `${listboxId}-${activeIndex}` : undefined
        }
      />
      {listboxVisible ? (
        <ul id={listboxId} role="listbox" className="lbr-combobox__listbox">
          {items.map((item, ix) => (
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
          ))}
        </ul>
      ) : null}
      {/* Loading, error and "no matches" are NOT options, and a `role="listbox"`
          may only contain `role="option"`. They used to be rendered as <li>s
          inside it, so a screen reader announced a one-item list whose item was
          a loading skeleton. They live outside the listbox now. */}
      {querying && (loading || error || items.length === 0) ? (
        <div className="lbr-combobox__status" role={error ? 'alert' : undefined}>
          {loading ? (
            <Skeleton style={{ height: 12, width: '60%' }} radius="sm" />
          ) : (
            (error ?? noMatchesText)
          )}
        </div>
      ) : tooShort ? (
        <div className="lbr-combobox__status">{minCharsText}</div>
      ) : null}
    </div>
  );
}
