'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, EmptyState, Input } from '@libriant/ui';
import { ApiError, api } from '@/lib/api';

/**
 * A `<Column>` describes how to render one cell from a row. The accessor
 * is either a property key (for primitives) or a render function (for
 * computed cells like joined names or status badges).
 */
export type Column<T> = {
  key: string;
  header: React.ReactNode;
  /** Defaults to `String(row[key])` when the key matches a row property. */
  render?: (row: T) => React.ReactNode;
  /** Optional table-cell className for column-specific alignment / width. */
  className?: string;
};

type ListResponse<T> = { items: T[]; nextCursor: string | null };

type DataTableProps<T extends { id: string }> = {
  /** Path on the API (without query string). */
  endpoint: string;
  /** Query params merged into every fetch. */
  baseQuery?: Record<string, string | undefined>;
  /** Server-rendered first page so the table is usable before JS hydrates. */
  initial: ListResponse<T>;
  columns: Column<T>[];
  /** Empty-state title when there are no items at all. */
  emptyTitle: string;
  emptyDescription: string;
  /** Optional empty-state illustration slot from the assets manifest. */
  emptyIllustration?: string;
  /**
   * URL search-param name for free-text search. When set, the table shows
   * a search input that pushes the value back into the URL so it's
   * preserved through reloads + shareable.
   */
  searchParam?: string;
  searchPlaceholder?: string;
  /** Localized label for the search action (button text + aria-label). */
  searchLabel?: string;
  /** Localized empty state when a search yields nothing. */
  noMatchesTitle?: string;
  noMatchesDescription?: string;
  /** Localized "load more" button. */
  loadMoreLabel?: string;
  /** Optional row → URL function; rows become clickable. */
  rowHref?: (row: T) => string;
  /** Optional toolbar slot rendered next to the search box. */
  toolbar?: React.ReactNode;
};

/**
 * Generic list + search + load-more table used by every read-only data
 * screen. Server renders page 1; client appends subsequent pages and
 * re-fetches when the user types in the search box.
 */
export function DataTable<T extends { id: string }>({
  endpoint,
  baseQuery,
  initial,
  columns,
  emptyTitle,
  emptyDescription,
  emptyIllustration,
  searchParam,
  searchPlaceholder,
  searchLabel = 'Search',
  noMatchesTitle = 'No matches',
  noMatchesDescription,
  loadMoreLabel = 'Load more',
  rowHref,
  toolbar,
}: DataTableProps<T>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentQ = searchParam ? (searchParams?.get(searchParam) ?? '') : '';

  // Client-side state: items + the cursor for the next page. Reset to the
  // server-rendered initial values whenever the URL search params change.
  const [items, setItems] = React.useState<T[]>(initial.items);
  const [nextCursor, setNextCursor] = React.useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [searchInput, setSearchInput] = React.useState(currentQ);

  React.useEffect(() => {
    setItems(initial.items);
    setNextCursor(initial.nextCursor);
    setError(null);
  }, [initial.items, initial.nextCursor]);

  React.useEffect(() => {
    setSearchInput(currentQ);
  }, [currentQ]);

  function buildQS(extra: Record<string, string | undefined> = {}): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...(baseQuery ?? {}), ...extra })) {
      if (v && v.length) params.set(k, v);
    }
    const s = params.toString();
    return s.length ? `?${s}` : '';
  }

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<ListResponse<T>>(
        `${endpoint}${buildQS({
          after: nextCursor,
          ...(searchParam ? { [searchParam]: currentQ } : {}),
        })}`,
      );
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  /** Push the search input back into the URL so the server re-renders. */
  function commitSearch() {
    if (!searchParam) return;
    const next = new URLSearchParams(Array.from(searchParams?.entries() ?? []));
    if (searchInput.trim().length) next.set(searchParam, searchInput.trim());
    else next.delete(searchParam);
    router.push(`?${next.toString()}`);
  }

  const isEmpty = items.length === 0 && !currentQ;
  const noMatches = items.length === 0 && !!currentQ;

  return (
    <>
      {searchParam ? (
        <div
          style={{
            display: 'flex',
            gap: 'var(--sp-3)',
            alignItems: 'center',
            marginBottom: 'var(--sp-4)',
          }}
        >
          <Input
            type="search"
            placeholder={searchPlaceholder}
            value={searchInput}
            onChange={(e) => setSearchInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSearch();
            }}
            aria-label={searchLabel}
            style={{ maxWidth: 360 }}
          />
          <Button variant="secondary" onClick={commitSearch}>
            {searchLabel}
          </Button>
          {toolbar ? <div style={{ marginLeft: 'auto' }}>{toolbar}</div> : null}
        </div>
      ) : toolbar ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--sp-4)' }}>
          {toolbar}
        </div>
      ) : null}

      {isEmpty ? (
        <EmptyState
          illustration={emptyIllustration ?? 'illustrations/empty-catalog'}
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : noMatches ? (
        <EmptyState
          illustration={emptyIllustration ?? 'illustrations/empty-catalog'}
          title={noMatchesTitle}
          description={
            noMatchesDescription ??
            `Nothing matches "${currentQ}". Try a different word — searches are accent-insensitive.`
          }
        />
      ) : (
        <>
          {/* Wrapper scrolls a wide table horizontally on small screens; the
              `--cards` modifier reflows each row into a stacked label/value
              card below the mobile breakpoint (see styles.css). Each cell
              carries its column header as `data-label` so the card view can
              show it. */}
          <div className="lbr-table-wrap">
            <table className="lbr-table lbr-table--cards">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={c.className}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={row.id}
                    onClick={rowHref ? () => router.push(rowHref(row)) : undefined}
                    style={rowHref ? { cursor: 'pointer' } : undefined}
                  >
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={c.className}
                        data-label={typeof c.header === 'string' ? c.header : ''}
                      >
                        {c.render
                          ? c.render(row)
                          : String((row as Record<string, unknown>)[c.key] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error ? (
            <p role="alert" style={{ color: 'var(--color-danger)', marginTop: 'var(--sp-3)' }}>
              {error}
            </p>
          ) : null}
          {nextCursor ? (
            <div style={{ textAlign: 'center', marginTop: 'var(--sp-4)' }}>
              <Button variant="secondary" onClick={loadMore} loading={loading}>
                {loadMoreLabel}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
