/**
 * Reducing a printed identifier to the characters that identify it.
 *
 * Moved here from `catalog/normalize.ts` in 2.0 phase 20h, because that file is
 * inside a directory the cutover deletes and this function is not the
 * catalogue's — it is what an ISBN, ISSN or ISMN looks like once the hyphens a
 * human typed are gone.
 *
 * `X` is kept, and in both cases: it is a legal ISBN-10 check digit, and a
 * library whose export writes it lower-case is not writing a different number.
 * Normalising the case is the CALLER's job, because `bib_identifiers.value_norm`
 * is upper-case by convention and a comparison that forgets is a lookup that
 * silently finds nothing.
 */
export function digitsOnly(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9Xx]/g, '');
  return cleaned.length ? cleaned : null;
}
