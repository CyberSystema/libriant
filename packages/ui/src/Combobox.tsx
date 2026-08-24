'use client';
import * as React from 'react';
import { Input } from './Input';
import { Skeleton } from './Skeleton';
import { fillMarker, useUiStrings } from './ui-strings';

type ComboboxProps<T extends { id: string }> = {
  /** Stable id used by the underlying `<Input>` and to derive the listbox id. */
  id: string;
  /** What the librarian sees in the input when nothing is picked. */
  placeholder: string;
  /** Current search text. The caller owns it so it can debounce and fetch. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Already-picked item; pass `null` to start empty. */
  value: T | null;
  /** Called with `null` on clear, the row on pick. */
  onChange: (item: T | null) => void;
  /** Rows for the current query. */
  items: readonly T[];
  /** A request is in flight. */
  loading?: boolean;
  /** The search failed. Rendered outside the listbox, as an alert. */
  error?: string | null;
  /** Render one option in the dropdown. */
  renderOption: (item: T) => React.ReactNode;
  /** Render the picked item back inside the input area. */
  renderSelected: (item: T) => React.ReactNode;
  /** Minimum characters before the caller queries. Defaults to 1. */
  minQueryChars?: number;
  disabled?: boolean;
  /** Overrides the shared "Clear selection" label. */
  clearLabel?: string;
};

/**
 * Accessible autocomplete picker — the member and book pickers behind checkout
 * and place-hold, the two most-used custom widgets in the product.
 *
 * Presentational on purpose: the caller owns `query`, fetching, debouncing and
 * the error message, so this file never has to know about the API client and
 * can be reasoned about (and eventually tested) on its own.
 *
 * The ARIA rules that were broken before (frontend-25) and are load-bearing
 * here:
 *
 *   • `aria-expanded` and `aria-controls` track the *rendered* listbox, not
 *     an internal `open` flag. Focusing an empty field used to report an
 *     expanded popup that did not exist, with `aria-controls` dangling at a
 *     missing id.
 *   • `role="listbox"` contains nothing but `role="option"`. Loading, error
 *     and no-matches rows used to be plain `<li>`s inside it — and the error
 *     one carried `role="alert"`, which a listbox does not permit either.
 *   • A permanently mounted live region reports the result count, so a screen
 *     reader user learns that typing produced eleven matches rather than
 *     silence. It is mounted empty and filled later, because a live region
 *     that appears already containing its text is the case assistive tech
 *     announces least reliably.
 */
export function Combobox<T extends { id: string }>({
  id,
  placeholder,
  query,
  onQueryChange,
  value,
  onChange,
  items,
  loading = false,
  error = null,
  renderOption,
  renderSelected,
  minQueryChars = 1,
  disabled,
  clearLabel,
}: ComboboxProps<T>) {
  const ui = useUiStrings();
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listboxId = `${id}-listbox`;
  const statusId = `${id}-status`;
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  const querying = open && query.trim().length >= minQueryChars;
  // The listbox exists only when it has options to hold. Everything that is
  // not an option lives in the status region below it.
  const listboxVisible = querying && !loading && !error && items.length > 0;

  React.useEffect(() => {
    setActiveIndex(0);
  }, [items]);

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
    onQueryChange('');
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
      pick(items[activeIndex]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div className="lbr-combobox lbr-combobox--picked">
        <div className="lbr-combobox__picked-body">{renderSelected(value)}</div>
        <button
          type="button"
          className="lbr-combobox__clear"
          aria-label={clearLabel ?? ui.comboboxClear}
          onClick={() => onChange(null)}
          disabled={disabled}
        >
          ×
        </button>
      </div>
    );
  }

  // Deliberately silent on the error: the visible panel below is a `role="alert"`
  // and already announces it. Repeating it here would read the failure twice.
  const statusMessage =
    !querying || error
      ? ''
      : loading
        ? ui.comboboxSearching
        : items.length === 0
          ? ui.comboboxNoMatches
          : items.length === 1
            ? ui.comboboxResultsOne
            : fillMarker(ui.comboboxResultsOther, items.length);

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
          onQueryChange(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKey}
        disabled={disabled}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listboxVisible}
        aria-controls={listboxVisible ? listboxId : undefined}
        aria-describedby={statusId}
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
      {querying && (loading || error || items.length === 0) ? (
        <div className="lbr-combobox__status" role={error ? 'alert' : undefined}>
          {loading ? (
            <Skeleton style={{ height: 12, width: '60%' }} radius="sm" />
          ) : (
            (error ?? ui.comboboxNoMatches)
          )}
        </div>
      ) : null}
      <span id={statusId} className="lbr-visually-hidden" role="status" aria-live="polite">
        {statusMessage}
      </span>
    </div>
  );
}
