/**
 * Escaping a user's search term for a LIKE pattern (2.0 phase 20a).
 *
 * Prisma's `contains` renders `col LIKE '%' || $1 || '%'` and does NOT escape
 * the pattern metacharacters in `$1`. So today a reader who types `%` into a
 * search box is not searching for a per-cent sign — they are asking for a
 * wildcard, which matches every row in the table. `_` is the same defect one
 * character wide, and both slip past a minimum-length floor: `%%%` is three
 * characters, passes `SEARCH_MIN_CHARS`, and asks Postgres to match everything
 * through an index that cannot help, which is the sequential scan the floor
 * exists to prevent.
 *
 * THE BACKSLASH IS DOUBLED FIRST. Escaping `%` and `_` before `\` would then
 * escape the backslashes this function just inserted, turning `\%` back into a
 * literal backslash followed by a live wildcard — the classic ordering bug in
 * every hand-rolled escaper.
 *
 * `\` is the escape character because it is Postgres's default for LIKE, so no
 * `ESCAPE` clause is needed — which matters, because Prisma gives no way to add
 * one. (`standard_conforming_strings` is `on` by default in every supported
 * Postgres and this repo never turns it off, so the backslash reaching the
 * server is the one written here.)
 *
 * This is deliberately NOT folding or trimming: the term arriving here has
 * already been through `foldGreek`, and a function that quietly did both would
 * be impossible to reason about at the call site.
 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
