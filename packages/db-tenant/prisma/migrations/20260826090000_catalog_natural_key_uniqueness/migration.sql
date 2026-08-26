-- data-integrity-03 + data-integrity-06 — make the importer's natural keys real.
--
-- WHAT WAS WRONG. The import engine advertises, in its own module header, that
-- "authors are find-or-created by normalized name so a catalogue import doesn't
-- spawn duplicate author rows", and it treats `books.isbn13` as a book's
-- natural key for skip/update. Both promises were implemented as
-- `findFirst(...)` then `create(...)` with NOTHING behind them: the only
-- objects on those columns were plain btree/gin indexes.
--
--   MEASURED on the audit database before this migration, with two bare
--   INSERTs each:
--     books same isbn       | 2
--     authors same sortName | 2
--   (The auditor reached the same state through the product: four concurrent
--   ImportEngine runs -> 4 books with one ISBN, 4 authors with one sortName,
--   and a single `AuthorsService.create` call needs no concurrency at all.)
--
-- Once two rows share the key, `findFirst` returns an ARBITRARY one, so
-- `duplicateMode:'update'` refreshes a coin-flip row and every later copy, loan
-- and hold attaches to a coin-flip row. The catalogue splits: the same title
-- appears twice with its copies under one entry and its holds under the other,
-- and there is no merge tool.
--
-- WHY A PARTIAL UNIQUE INDEX AND NOT `@@unique`. Prisma cannot express a
-- partial index, and the scope has to be partial: archiving a record must free
-- its key for re-use, exactly as `book_copies_barcode_unique_active` and
-- `members_member_number_unique_active` (20260526184041_init:470,475) already
-- do. A book with no ISBN is likewise outside the constraint — pre-ISBN and
-- locally-catalogued items are the common row in a Greek library export, and
-- NULLs are not comparable anyway.
--
-- IS ISBN-13 REALLY A KEY? Yes, for this scope. An ISBN-13 identifies one
-- published manifestation; two editions of a work carry two different ISBNs.
-- A library that wants two bibliographic records for the same manifestation can
-- still have them — leave the ISBN off one, or archive one — but the importer
-- is not allowed to CREATE that split behind the librarian's back, which is
-- what it did.
--
-- ===========================================================================
-- APPLYING A UNIQUE CONSTRAINT TO LIVE DATA
-- ===========================================================================
-- A unique index does not apply if the table already violates it, and a
-- migration that dies halfway through a customer database is worse than the bug
-- it fixes. So this file never reaches DDL without first knowing it can:
--
--   STAGE 0  detect + REFUSE, before a single row is touched, for the one case
--            that cannot be resolved automatically;
--   STAGE 1  de-duplicate authors deliberately and losslessly;
--   STAGE 2  de-duplicate books deliberately and losslessly;
--   STAGE 3  only then, create the two unique indexes.
--
-- "Losslessly" is exact: nothing is deleted. A folded-away row is ARCHIVED
-- (`archivedAt` set), which both removes it from the constraint's scope and
-- leaves every column intact, and each fold writes an `audit_log` row naming
-- the survivor — so a librarian can see what happened and undo it by hand.
-- That is the same repair the audit describes doing manually ("re-point copies,
-- archive the spare"), performed once, deterministically, with a record.
--
-- `prisma migrate deploy` wraps this file in a transaction, so a STAGE 0
-- refusal rolls back the whole thing — there is no half-applied state. The
-- stages are ordered so that this also holds when the file is applied by hand
-- with psql outside a transaction.
--
-- Idempotent throughout: re-running finds no duplicate groups and the
-- `CREATE UNIQUE INDEX IF NOT EXISTS` statements are no-ops. VERIFIED by
-- applying this file twice against a scratch database seeded with duplicates.
--
-- SCHEMA QUALIFICATION. Every function call below is written `pg_catalog.…`.
-- This is not decoration: on the audit box `gen_random_uuid` and `replace`
-- resolve in BOTH `pg_catalog` and `public` (pgcrypto), and an unqualified call
-- already broke a control-plane restore once, because a restore runs with an
-- empty search_path.
--
-- TIMESTAMPS. Every timestamp written below is `pg_catalog.now() AT TIME ZONE
-- 'UTC'`, never bare `now()`. Every DateTime column in this schema is
-- `timestamp(3) WITHOUT time zone`, and Prisma writes UTC wall time into them —
-- so assigning a `timestamptz` casts it through the SESSION TimeZone and stores
-- LOCAL wall time instead. MEASURED here, on the audit Postgres, whose TimeZone
-- is Europe/Athens (as production's is):
--
--     SELECT now()::timestamp(3)                    -> 2026-08-26 00:41:22.630
--     SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) -> 2026-08-25 21:41:22.630
--     node   new Date().toISOString()               -> 2026-08-25T21:41:22.698Z
--
-- The first draft of this file used bare `now()` and duly wrote an audit_log
-- row stamped three hours in the future relative to every other row in that
-- table — which the retention sweep compares against the Node clock. This is
-- the same trap `ImportEngine.readDbClock` documents; it is worth stating twice.
--
-- LOCK NOTE: the CREATE INDEX statements take a SHARE lock on `books` and
-- `authors`, so writes to those tables block for the duration. Plain, not
-- CONCURRENTLY, because `prisma migrate deploy` wraps each migration file in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one. Deploy in
-- the maintenance window the other tenant migrations already use.
--
-- BEFORE YOU DEPLOY THIS: the API must translate the new P2002 into a friendly
-- message on every write path that can now hit it. `ImportEngine` does (see
-- `dbIssue`, and the `duplicate` outcome in `commitBook`/`commitAuthor`), and
-- `BooksService.translateDbError` already maps P2002 -> 409. `AuthorsService`
-- (apps/api/src/catalog/authors.service.ts) does NOT — `create`/`update` are
-- bare `client.author.*` calls, so a librarian typing an existing author's name
-- would get a 500 instead of "that author already exists". That file is outside
-- this package's ownership; it is reported as a required owner action.

-- ===========================================================================
-- STAGE 0 — REFUSE, LOUDLY AND BEFORE ANY WRITE
-- ===========================================================================
-- The one shape that must not be resolved automatically: two or more NON-
-- ARCHIVED books sharing an ISBN where MORE THAN ONE of them already carries
-- copies or holds. Folding those together means re-pointing physical items and
-- live queue positions between bibliographic records — a circulation operation
-- with side effects (queuePosition contiguity, the
-- `reservations_one_active_per_book_member` partial unique index), not a schema
-- change. Doing it silently from a migration is precisely the "worse than the
-- bug" outcome.
--
-- Authors have no equivalent: a `book_authors` row is a pure join row, so
-- merging authors re-points links and nothing else. STAGE 1 always succeeds.
DO $$
DECLARE
  blocked_count integer;
  blocked_isbns text;
BEGIN
  WITH active_books AS (
    SELECT b.id,
           b.isbn13,
           (
             EXISTS (SELECT 1 FROM book_copies c WHERE c."bookId" = b.id)
             OR EXISTS (SELECT 1 FROM reservations r WHERE r."bookId" = b.id)
           ) AS has_dependents
      FROM books b
     WHERE b.isbn13 IS NOT NULL
       AND b."archivedAt" IS NULL
  ), dup_groups AS (
    SELECT isbn13,
           pg_catalog.count(*) AS n_rows,
           pg_catalog.count(*) FILTER (WHERE has_dependents) AS n_with_dependents
      FROM active_books
     GROUP BY isbn13
  )
  SELECT pg_catalog.count(*),
         pg_catalog.string_agg(isbn13, ', ' ORDER BY isbn13)
    INTO blocked_count, blocked_isbns
    FROM dup_groups
   WHERE n_rows > 1
     AND n_with_dependents > 1;

  IF blocked_count > 0 THEN
    RAISE EXCEPTION
      'Libriant migration refused: % ISBN-13 value(s) are shared by more than one active catalogue record that already holds copies or holds (%). Nothing has been changed.',
      blocked_count, blocked_isbns
      USING
        DETAIL = 'books.isbn13 is about to become unique among non-archived records. Folding together two bibliographic records that both carry copies or holds would re-point physical items and live queue positions, which is a circulation change and not something a schema migration may do silently.',
        HINT   = 'List them with: SELECT b.id, b.isbn13, b.title, b."createdAt", (SELECT pg_catalog.count(*) FROM book_copies c WHERE c."bookId" = b.id) AS copies, (SELECT pg_catalog.count(*) FROM reservations r WHERE r."bookId" = b.id) AS holds FROM books b WHERE b."archivedAt" IS NULL AND b.isbn13 IS NOT NULL AND b.isbn13 IN (SELECT isbn13 FROM books WHERE "archivedAt" IS NULL AND isbn13 IS NOT NULL GROUP BY isbn13 HAVING pg_catalog.count(*) > 1) ORDER BY b.isbn13, b."createdAt"; then, in the app, move every copy and hold onto ONE of the records and archive the spares (or clear the ISBN on the spares). Re-run this migration afterwards.';
  END IF;
END $$;

-- ===========================================================================
-- STAGE 1 — AUTHORS: fold duplicates into the oldest row (data-integrity-06)
-- ===========================================================================
-- Survivor = the oldest non-archived row for the sortName (tie-broken by id, so
-- the choice is deterministic and a re-run of a partially applied file picks the
-- same winner). Every `book_authors` link moves to the survivor; a link that
-- would collide with one the survivor already has is dropped rather than
-- re-pointed, because `book_authors` is keyed on (bookId, authorId) and the
-- survivor's row already says the same thing.
--
-- The duplicate group list is materialised into an array BEFORE the loop body
-- starts archiving rows, so the loop is not iterating a cursor over a table it
-- is mutating.
DO $$
DECLARE
  dup_names       text[];
  dup_name        text;
  survivor_id     text;
  folded          integer;
  folded_total    integer := 0;
  links_moved     integer;
  links_dropped   integer;
  -- MUST be UTC wall time, not bare `now()` — see the TIMESTAMPS note above.
  stamp_utc       timestamp(3) := (pg_catalog.now() AT TIME ZONE 'UTC');
BEGIN
  SELECT pg_catalog.array_agg(g."sortName")
    INTO dup_names
    FROM (
      SELECT "sortName"
        FROM authors
       WHERE "archivedAt" IS NULL
       GROUP BY "sortName"
      HAVING pg_catalog.count(*) > 1
    ) g;

  FOREACH dup_name IN ARRAY COALESCE(dup_names, ARRAY[]::text[]) LOOP
    SELECT a.id
      INTO survivor_id
      FROM authors a
     WHERE a."archivedAt" IS NULL
       AND a."sortName" = dup_name
     ORDER BY a."createdAt", a.id
     LIMIT 1;

    -- (1) Drop links that would collide on (bookId, authorId) after the move.
    DELETE FROM book_authors la
     USING authors a
     WHERE la."authorId" = a.id
       AND a."archivedAt" IS NULL
       AND a."sortName" = dup_name
       AND a.id <> survivor_id
       AND EXISTS (
         SELECT 1 FROM book_authors sa
          WHERE sa."bookId" = la."bookId"
            AND sa."authorId" = survivor_id
       );
    GET DIAGNOSTICS links_dropped = ROW_COUNT;

    -- (2) Move every remaining bibliography link onto the survivor.
    UPDATE book_authors la
       SET "authorId" = survivor_id
      FROM authors a
     WHERE la."authorId" = a.id
       AND a."archivedAt" IS NULL
       AND a."sortName" = dup_name
       AND a.id <> survivor_id;
    GET DIAGNOSTICS links_moved = ROW_COUNT;

    -- (3) Record the fold where the library can see it. `audit_log` is the
    --     tenant-side, library-visible history; `system` is the actor type for
    --     changes no user made.
    INSERT INTO audit_log (
      id, "actorType", action, "targetType", "targetId", "beforeJson", "afterJson", "occurredAt"
    )
    SELECT 'dedup' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
           'system',
           'author.deduplicated',
           'author',
           a.id,
           pg_catalog.jsonb_build_object(
             'id', a.id,
             'fullName', a."fullName",
             'sortName', a."sortName",
             'archivedAt', NULL
           ),
           pg_catalog.jsonb_build_object(
             'mergedIntoAuthorId', survivor_id,
             'archived', true,
             'migration', '20260826090000_catalog_natural_key_uniqueness',
             'reason', 'data-integrity-06: authors.sortName is now unique among non-archived authors'
           ),
           stamp_utc
      FROM authors a
     WHERE a."archivedAt" IS NULL
       AND a."sortName" = dup_name
       AND a.id <> survivor_id;

    -- (4) Archive the losers. Nothing is deleted: every column survives and the
    --     row can be restored by clearing `archivedAt` (after freeing the key).
    UPDATE authors
       SET "archivedAt" = stamp_utc,
           "updatedAt"  = stamp_utc
     WHERE "archivedAt" IS NULL
       AND "sortName" = dup_name
       AND id <> survivor_id;
    GET DIAGNOSTICS folded = ROW_COUNT;
    folded_total := folded_total + folded;

    RAISE NOTICE 'author "%": folded % duplicate row(s) into %, moved % link(s), dropped % redundant link(s)',
      dup_name, folded, survivor_id, links_moved, links_dropped;
  END LOOP;

  IF folded_total > 0 THEN
    RAISE NOTICE 'data-integrity-06: archived % duplicate author row(s); see audit_log action=author.deduplicated', folded_total;
  END IF;
END $$;

-- ===========================================================================
-- STAGE 2 — BOOKS: archive bare duplicate records (data-integrity-03)
-- ===========================================================================
-- STAGE 0 has already proved that at most ONE record per duplicate ISBN group
-- carries copies or holds. So the survivor is that record when it exists, and
-- otherwise the oldest — and every loser is provably bare, which is why
-- archiving it moves nothing and breaks no reference.
--
-- Loser `book_authors` links are left in place on purpose: they cost nothing
-- (an archived book is filtered out of every catalogue read) and they are what
-- makes the archive reversible.
DO $$
DECLARE
  dup_isbns    text[];
  dup_isbn     text;
  survivor_id  text;
  folded       integer;
  folded_total integer := 0;
  -- MUST be UTC wall time, not bare `now()` — see the TIMESTAMPS note above.
  stamp_utc    timestamp(3) := (pg_catalog.now() AT TIME ZONE 'UTC');
BEGIN
  SELECT pg_catalog.array_agg(g.isbn13)
    INTO dup_isbns
    FROM (
      SELECT isbn13
        FROM books
       WHERE "archivedAt" IS NULL
         AND isbn13 IS NOT NULL
       GROUP BY isbn13
      HAVING pg_catalog.count(*) > 1
    ) g;

  FOREACH dup_isbn IN ARRAY COALESCE(dup_isbns, ARRAY[]::text[]) LOOP
    SELECT b.id
      INTO survivor_id
      FROM books b
     WHERE b."archivedAt" IS NULL
       AND b.isbn13 = dup_isbn
     ORDER BY (
                EXISTS (SELECT 1 FROM book_copies c WHERE c."bookId" = b.id)
                OR EXISTS (SELECT 1 FROM reservations r WHERE r."bookId" = b.id)
              ) DESC,
              b."createdAt",
              b.id
     LIMIT 1;

    INSERT INTO audit_log (
      id, "actorType", action, "targetType", "targetId", "beforeJson", "afterJson", "occurredAt"
    )
    SELECT 'dedup' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''),
           'system',
           'book.deduplicated',
           'book',
           b.id,
           pg_catalog.jsonb_build_object(
             'id', b.id,
             'title', b.title,
             'isbn13', b.isbn13,
             'archivedAt', NULL
           ),
           pg_catalog.jsonb_build_object(
             'duplicateOfBookId', survivor_id,
             'archived', true,
             'migration', '20260826090000_catalog_natural_key_uniqueness',
             'reason', 'data-integrity-03: books.isbn13 is now unique among non-archived records; this record carried no copies and no holds'
           ),
           stamp_utc
      FROM books b
     WHERE b."archivedAt" IS NULL
       AND b.isbn13 = dup_isbn
       AND b.id <> survivor_id;

    UPDATE books
       SET "archivedAt" = stamp_utc,
           "updatedAt"  = stamp_utc
     WHERE "archivedAt" IS NULL
       AND isbn13 = dup_isbn
       AND id <> survivor_id;
    GET DIAGNOSTICS folded = ROW_COUNT;
    folded_total := folded_total + folded;

    RAISE NOTICE 'isbn %: archived % bare duplicate record(s), kept %', dup_isbn, folded, survivor_id;
  END LOOP;

  IF folded_total > 0 THEN
    RAISE NOTICE 'data-integrity-03: archived % duplicate book row(s); see audit_log action=book.deduplicated', folded_total;
  END IF;
END $$;

-- ===========================================================================
-- STAGE 3 — the constraints themselves
-- ===========================================================================

-- data-integrity-03. Scope mirrors `book_copies_barcode_unique_active`:
-- archiving a record frees its ISBN for re-use.
CREATE UNIQUE INDEX IF NOT EXISTS "books_isbn13_unique_active"
  ON "books" ("isbn13")
  WHERE "isbn13" IS NOT NULL AND "archivedAt" IS NULL;

-- data-integrity-06. `sortName` is the accent-folded, lowercased name the
-- importer's find-or-create actually matches on, so it is the column that has to
-- be unique — not `fullName`, which differs by accents and casing between a
-- MARC export and a librarian's typing.
CREATE UNIQUE INDEX IF NOT EXISTS "authors_sortname_unique_active"
  ON "authors" ("sortName")
  WHERE "archivedAt" IS NULL;
