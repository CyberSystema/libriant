/**
 * Lowercase + accent-fold helper used to compute `sortTitle` / `searchText`
 * across catalog entities (and replicated in `collection-records.service.ts`).
 *
 * Greek and Latin both share the property that diacritics (tonos, acute,
 * grave, ...) are decoded as combining code points in NFD. Stripping them
 * with a regex over the `̀-ͯ` block leaves the base letter.
 *
 * Why JS-side and not Postgres? Postgres has `unaccent`, but it's not
 * `IMMUTABLE` by default, which means it can't be used in a generated
 * column or index expression without wrapping. Doing the fold in the
 * application keeps the schema simple and matches what the trigram GIN
 * index expects.
 */
export function normalizeText(input: string): string {
  return input.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/**
 * Build a `searchText` blob for an entity — concatenated, normalized,
 * deduplicated whitespace.
 */
export function buildSearchText(parts: Array<string | number | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p === null || p === undefined) continue;
    const s = normalizeText(String(p));
    if (!s) continue;
    for (const token of s.split(/\s+/)) {
      if (!token) continue;
      if (!seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out.join(' ');
}

/** Strip everything that's not a digit (or X for ISBN-10). */
export function digitsOnly(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9Xx]/g, '');
  return cleaned.length ? cleaned : null;
}
