-- The two counts a plan ceiling runs, made cheap (2.0 phase 20g).
--
-- `BibWriteService.create` and `PatronsService.create` now enforce `max_books`
-- and `max_members` the way `BooksService.create` always has: take
-- `pg_advisory_xact_lock('quota:<tenant>:<feature>:')`, count, then insert, all
-- in one transaction. The lock serialises the whole library's cataloguing
-- session behind that count, so what the count costs is what the ceiling costs.
--
-- 1.0 measured the same statement on a 400,000-title catalogue and added
-- `books_active_idx ON books (id) WHERE "archivedAt" IS NULL` for it:
--
--   before   Aggregate … Seq Scan on books   Buffers: shared hit=32 read=10494
--   after    Aggregate … Index Only Scan     Buffers: shared hit=1536
--
-- THE PREDICATE IS NOT THE OBVIOUS ONE, and that is the whole content of this
-- migration. The natural partial index would be
--
--     ON marc_records (id) WHERE kind = 'bibliographic' AND deleted_at IS NULL
--
-- and the planner could never prove it. Prisma emits an enum comparison as
-- `kind = CAST($1::text AS marc_record_kind)` — a parameter through a function
-- that is only STABLE — so the predicate is not provable at plan time. It is the
-- same reason 1.0 could not put the `loans` status predicate in a partial index,
-- the same reason `items.is_shelf_available` is a GENERATED column rather than a
-- `status = 'available'` predicate, and the migration that added
-- `books_active_idx` says so in as many words.
--
-- So the enum moves from the PREDICATE into the KEY. `deleted_at IS NULL` is
-- provable — Prisma emits it verbatim, no parameter, no cast — so the partial
-- index is usable, and `kind` as the leading column turns the count into an
-- index-only seek over one value rather than a filter over the whole table.
--
-- MEASURED on 20,000 bibliographic records, on the statement Prisma emits:
--
--   this index          Index Only Scan using marc_records_billable_idx
--                       Index Cond: (kind = ('bibliographic'::cstring)::marc_record_kind)
--
--   the naive shape     built alongside as `(id) WHERE kind = 'bibliographic'
--                       AND deleted_at IS NULL`, ANALYZEd, and NOT CHOSEN — the
--                       planner kept using the index above, because it cannot
--                       prove the other one's predicate.
--
-- At 20,000 rows where every row matches, an unhinted planner still prefers a
-- Seq Scan (417 buffers, 3.7 ms) and is right to: an index-only scan over 100%
-- of a small table buys nothing. The index earns itself on the catalogue that
-- has grown and on the library whose records are not all bibliographic — which
-- is the shape 1.0 measured at 400,000 titles, where the same change took the
-- count from 10,494 pages read to 1,536 hit.

CREATE INDEX marc_records_billable_idx
  ON marc_records (kind)
  WHERE deleted_at IS NULL;

-- The patron half, same shape and same reasoning. `status` is an enum, so it is
-- the key; the two nullable instants are the predicate.
--
-- `erased_at` is in the predicate rather than the key because it is what makes
-- the count HONEST rather than fast: a reader erased under Article 17 is a row
-- the library is legally required to keep, and billing a plan for it would
-- charge a library for complying with the GDPR.
CREATE INDEX patrons_billable_idx
  ON patrons (status)
  WHERE archived_at IS NULL AND erased_at IS NULL;
