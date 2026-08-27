-- performance-03: give the roster, the audit log and the fines screen an index
-- that matches the ORDER BY their keyset pagination pages on.
--
-- The service change is the other half of this: `MembersService.list`,
-- `AuditService.list` and `FinesService.list` stopped using Prisma's `cursor`
-- (an OR of correlated subselects the planner cannot enter an index with) and
-- now emit `sortKey >= $1 AND (sortKey > $1 OR (sortKey = $1 AND id > $2))`.
-- That predicate is only a START KEY if an index leads with the sort column;
-- without one — `fines` had none at all — Postgres still reads the table.
--
-- Two of the three replace an index rather than adding one, so the number of
-- indexes to maintain on each table is unchanged. Both replaced indexes are
-- strict PREFIXES of their replacement, so every query that could use the old
-- one can use the new one; the composite just also settles the `id` tiebreak
-- inside the index instead of in an Incremental Sort node above it.
--
-- Measured on a local fixture (200,000 members / 400,000 audit rows / 150,000
-- fines), on the literal SQL captured from Prisma's query event log:
--
--   members, page at depth 100,000
--     BEFORE  Index Scan using "members_sortName_idx"
--             Rows Removed by Filter: 100000
--             Buffers: shared hit=98561 read=2054     79.415 ms
--     AFTER   Index Scan using "members_sortName_id_idx"
--             Index Cond: ("sortName" >= …)  Rows Removed by Filter: 1
--             Buffers: shared read=30                  0.765 ms
--
--   audit_log, page at depth 200,000
--     BEFORE  Index Scan Backward using "audit_log_occurredAt_idx"
--             Rows Removed by Filter: 200000
--             Buffers: shared hit=2762 read=1626       30.612 ms
--     AFTER   Index Scan using "audit_log_occurredAt_id_idx"
--             Index Cond: ("occurredAt" <= …)  Rows Removed by Filter: 1
--             Buffers: shared read=5                    0.075 ms
--
--   fines — the one that was never about depth at all. With no index on the
--   sort key, EVERY page including the first was a parallel seq scan plus a
--   top-N heapsort:
--     BEFORE  page 1     Parallel Seq Scan on fines
--                        Buffers: shared hit=2213 read=70   14.513 ms
--             depth 75k  Parallel Seq Scan on fines
--                        Buffers: shared hit=45 read=2238   21.187 ms
--     AFTER   page 1     Index Only Scan using "fines_createdAt_id_idx"
--                        Buffers: shared hit=1 read=3        0.524 ms
--             depth 75k  same index, Index Cond: ("createdAt" <= …)
--                        Buffers: shared hit=2 read=2        1.176 ms
--
-- DIRECTIONS ARE LOAD-BEARING on the two DESC indexes. `audit_log` and `fines`
-- both list newest-first, so the index is declared DESC to match; getting a
-- direction wrong here costs nothing visible — the same rows come back — it
-- just silently puts the sort node back. `members` sorts ascending, and
-- Postgres's default ASC/NULLS LAST is what `sortName ASC, id ASC` asks for.
--
-- `audit_log_occurredAt_id_idx` also has to keep serving the retention sweep
-- (`DELETE … WHERE "occurredAt" < $1 ORDER BY "occurredAt" LIMIT 5000` in
-- apps/api/src/jobs/retention.job.ts), which reads from the OLD end in
-- ascending order. A DESC btree is scanned backwards for that, which the
-- planner does on its own — verified on the fixture above as `Index Only Scan
-- Backward using "audit_log_occurredAt_id_idx", Index Cond: ("occurredAt" <
-- (now() - '365 days'::interval)), Heap Fetches: 0, Buffers: shared hit=3`.
--
-- COST. Only `fines` gains an index — one more write per fine raised or
-- settled, on the smallest of the three tables. `members` and `audit_log` gain
-- nothing to maintain: each new index replaces the one it supersedes, and the
-- rows written are wider by an `id` apiece. `audit_log` is the busiest table in
-- a tenant database (a row per circulation action), which is exactly why this
-- replaces its `occurredAt` index rather than adding a sixth one beside it.
--
-- Idempotent (IF NOT EXISTS / IF EXISTS), per repo convention.
--
-- LOCK NOTE: plain CREATE INDEX takes a SHARE lock, so writes to each table
-- block while its index builds (under 2 s per table on the fixture above). Not
-- CONCURRENTLY, because `prisma migrate deploy` wraps each migration file in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one.

CREATE INDEX IF NOT EXISTS "members_sortName_id_idx"
  ON "members" ("sortName", "id");
DROP INDEX IF EXISTS "members_sortName_idx";

CREATE INDEX IF NOT EXISTS "audit_log_occurredAt_id_idx"
  ON "audit_log" ("occurredAt" DESC, "id" DESC);
DROP INDEX IF EXISTS "audit_log_occurredAt_idx";

CREATE INDEX IF NOT EXISTS "fines_createdAt_id_idx"
  ON "fines" ("createdAt" DESC, "id" DESC);
