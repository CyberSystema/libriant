/**
 * The shortest query a trigram index can serve.
 *
 * This lives in `shared` and not in the API because it is a CONTRACT between
 * the two sides, and the two sides drifted. performance-12 put a 3-character
 * floor on `/catalog/books` and `/catalog/authors`: below it the endpoint
 * answers an empty page rather than running `LIKE %ab%` across the whole
 * table. The pickers in the web app kept their own default of 1, so typing
 * "Πα" fired a request, got back nothing, and rendered "No matches." — which
 * is a lie. The book is there; the query was too short to look for it.
 *
 * A constant duplicated on both sides would have drifted again the next time
 * the floor moved. Importing the same one means the UI cannot disagree with
 * the endpoint it is calling.
 *
 * Why three: a pg_trgm GIN index cannot use a pattern with fewer than three
 * characters, so a two-character search degrades to a sequential scan of every
 * row (measured at 13,407 buffers against 7 for the indexed path).
 */
export const SEARCH_MIN_CHARS = 3;
