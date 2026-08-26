-- performance-09: turn the book-metadata backfill's candidate query from a
-- full catalogue scan into a work queue it can seek into.
--
-- `book-metadata-refresh.job.ts` asks for the 40 oldest-attempted books that
-- still have an ISBN-13 and are still missing at least one backfillable field,
-- ordered `"metadataRefreshedAt" ASC NULLS FIRST`. The only index that existed
-- was `books_metadataRefreshedAt_idx`, a plain ascending btree — and plain
-- ascending in Postgres means NULLS LAST, the opposite end. So the index could
-- not satisfy the ordering, and the planner fell back to reading the table.
--
--   BEFORE  Parallel Seq Scan on books (rows=53333 loops=3)
--           Sort Key: "metadataRefreshedAt" NULLS FIRST
--           Buffers: shared hit=168 read=10430   Execution Time: 27.2 ms
--   AFTER   Index Scan using books_metadata_backfill_idx
--           Buffers: shared read=5               Execution Time: 0.033 ms
--   (400,000 titles, 160,000 of them candidates)
--
-- TWO things make it a work queue rather than just a matching sort order:
--   * NULLS FIRST, so the never-attempted books — the ones the sweep always
--     wants next — sit at the head of the index instead of the tail;
--   * the "still missing something" disjunction in the PREDICATE, so books the
--     sweep has already finished with fall out of the index entirely rather
--     than being scanned and discarded. That is what keeps it small: 1096 kB
--     against an 82 MB heap on the fixture above.
--
-- The predicate is stated with literal IS NULL tests only, so the planner can
-- prove it from the query's own WHERE clause — no enum casts, no parameters,
-- none of the un-provable shapes that made the partial index in 20260824120000
-- dead on arrival (see 20260824170000).
--
-- It also answers the backlog count the job now reports, as an index-only scan:
-- 24.6 ms / 10,526 buffers before, 6.5 ms / 138 buffers after.
--
-- `books_metadataRefreshedAt_idx` is deliberately LEFT IN PLACE: it is declared
-- in schema.prisma via `@@index([metadataRefreshedAt])`, so dropping it here
-- would put the database permanently out of step with the schema and the next
-- `prisma migrate dev` would recreate it.
--
-- Idempotent per repo convention. LOCK NOTE: plain CREATE INDEX takes a SHARE
-- lock on `books`, so cataloguing blocks while it builds. Not CONCURRENTLY,
-- because `prisma migrate deploy` wraps each migration file in a transaction.

CREATE INDEX IF NOT EXISTS "books_metadata_backfill_idx"
  ON "books" ("metadataRefreshedAt" NULLS FIRST)
  WHERE "archivedAt" IS NULL
    AND "isbn13" IS NOT NULL
    AND ("description" IS NULL
         OR "publicationYear" IS NULL
         OR "numPages" IS NULL
         OR "language" IS NULL);
