import { digitsOnly } from './normalize.js';

/**
 * Shape returned to the UI. Normalized across the various OpenLibrary
 * response quirks so the new-book form can drop it straight in.
 */
export type IsbnLookupResult = {
  isbn13: string | null;
  isbn10: string | null;
  title: string;
  subtitle: string | null;
  /** Just the names — the UI decides whether to match against existing
   *  Authors or to create new ones. */
  authors: string[];
  publisher: string | null;
  publicationYear: number | null;
  numPages: number | null;
  language: string | null;
  description: string | null;
  /** Public cover URL on OpenLibrary, if any. The UI can show it as a
   *  thumbnail; uploading the real cover into Libriant storage stays a
   *  separate user action via `POST /books/:id/cover`. */
  coverUrl: string | null;
  /** Where the data came from. */
  source: 'openlibrary';
};

/**
 * Fetch + normalize a single ISBN against OpenLibrary. Pure (no Redis, no DI)
 * so it's reusable both by {@link IsbnLookupService} (cached, request-time
 * lookups) and by the `book-metadata-refresh` background job (uncached batch
 * backfill in the worker, which skips Nest DI).
 *
 * Returns `null` when the ISBN is malformed or genuinely isn't on OpenLibrary.
 * Throws on transient transport failures (timeout, non-OK that the caller may
 * want to retry) — callers decide whether to swallow or back off.
 */
export async function fetchOpenLibraryBook(rawIsbn: string): Promise<IsbnLookupResult | null> {
  const isbn = digitsOnly(rawIsbn);
  if (!isbn || !isValidIsbnShape(isbn)) return null;

  // `details` returns a richer payload than `data`; we use it because it
  // carries page counts and descriptions.
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=details&format=json`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Libriant/0.1 (library-mgmt; +https://libriant.com)' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, OpenLibraryEntry | undefined>;
    const entry = body[`ISBN:${isbn}`];
    if (!entry?.details) return null;
    return normalize(isbn, entry);
  } finally {
    clearTimeout(timeout);
  }
}

export function isValidIsbnShape(digits: string): boolean {
  return digits.length === 10 || digits.length === 13;
}

function normalize(isbn: string, entry: OpenLibraryEntry): IsbnLookupResult {
  const d = entry.details;
  const year = parseYear(d.publish_date);
  return {
    isbn13: isbn.length === 13 ? isbn : (d.isbn_13?.[0] ?? null),
    isbn10: isbn.length === 10 ? isbn : (d.isbn_10?.[0] ?? null),
    title: d.title ?? 'Untitled',
    subtitle: d.subtitle ?? null,
    authors: (d.authors ?? []).map((a) => a.name).filter(Boolean),
    publisher: d.publishers?.[0] ?? null,
    publicationYear: year,
    numPages: typeof d.number_of_pages === 'number' ? d.number_of_pages : null,
    language: d.languages?.[0]?.key ? d.languages[0].key.replace('/languages/', '') : null,
    description:
      typeof d.description === 'string'
        ? d.description
        : typeof d.description?.value === 'string'
          ? d.description.value
          : null,
    coverUrl: entry.thumbnail_url ?? null,
    source: 'openlibrary',
  };
}

// --- OpenLibrary response shape ---------------------------------------------

type OpenLibraryEntry = {
  thumbnail_url?: string;
  details: {
    title?: string;
    subtitle?: string;
    publishers?: string[];
    publish_date?: string;
    authors?: Array<{ name: string }>;
    number_of_pages?: number;
    isbn_13?: string[];
    isbn_10?: string[];
    languages?: Array<{ key: string }>;
    description?: string | { value: string };
  };
};

/** "2003" → 2003; "April 25, 2003" → 2003; junk → null. */
function parseYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/\b(1\d{3}|20\d{2}|21\d{2})\b/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}
