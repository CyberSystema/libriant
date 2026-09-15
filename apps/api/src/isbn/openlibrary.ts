import { digitsOnly } from './identifier.js';

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
      // EXP-005: don't follow redirects. The host is pinned to openlibrary.org,
      // but a 3xx Location could otherwise bounce us to an attacker-controlled
      // or cloud-metadata endpoint (residual SSRF). Treat any redirect as
      // "not on OpenLibrary" rather than chasing it.
      redirect: 'manual',
      headers: { 'User-Agent': 'Libriant/0.1 (library-mgmt; +https://libriant.com)' },
    });
    // A `manual` redirect surfaces as an opaqueredirect/3xx response — never OK.
    if (!res.ok) return null;
    const parsed = await readCappedJson(res);
    if (parsed === null || typeof parsed !== 'object') return null;
    const body = parsed as Record<string, OpenLibraryEntry | undefined>;
    const entry = body[`ISBN:${isbn}`];
    if (!entry?.details) return null;
    return normalize(isbn, entry);
  } finally {
    clearTimeout(timeout);
  }
}

/** Hard ceiling on the OpenLibrary response body (EXP-005) — a single-ISBN
 *  `details` payload is a few KB; cap well above that so a hostile or
 *  misbehaving upstream can't blow up memory before/around JSON.parse. */
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * Read the response body with a size cap, then JSON.parse it. Returns `null`
 * if the body exceeds {@link MAX_RESPONSE_BYTES} or isn't valid JSON — callers
 * treat that the same as "not found" (a malformed/oversized payload carries no
 * usable book metadata).
 */
async function readCappedJson(res: Response): Promise<unknown> {
  // Fast path: if the server advertised an oversized body, bail before reading.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;

  const reader = res.body?.getReader();
  if (!reader) {
    // No streamable body (e.g. opaqueredirect) — fall back to text() which is
    // already bounded by the absence of content here.
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
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
