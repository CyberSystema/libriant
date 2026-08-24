-- Tenant-side half of the "retention, erasure and scans" remediation.
--
-- Four independent things, all in one migration because they all land on the
-- same two hot tables and a library should take the write lock once:
--
--   1. members."erasedAt"          — the GDPR Art. 17 tombstone marker
--                                    (privacy-legal-03). DELETE /members/:id
--                                    only ever soft-archived; every identifier
--                                    survived, so an erasure request could not
--                                    be honoured through the product at all.
--   2. member_number_counters      — O(1) member-number minting (performance-04).
--   3. loans list indexes          — the dashboard's two seq scans (performance-02).
--   4. members text_pattern_ops    — prefix + equality lookups on memberNumber
--                                    under the el_GR.UTF-8 collation
--                                    (performance-04 / performance-13).
--
-- Idempotent throughout (IF NOT EXISTS / guarded DO blocks), per repo
-- convention and because a partial apply against ONE tenant database must stay
-- re-runnable rather than wedging that tenant's migration history at P3009.
-- Verified by applying the whole file twice against the audit Postgres: the
-- second run reports no change.
--
-- LOCK NOTE: the CREATE INDEX statements below take a SHARE lock on `loans`
-- and `members`, so writes to those tables block for the duration (~4 s on a
-- 2M-row loans table on the audit box). They are plain, not CONCURRENTLY,
-- because `prisma migrate deploy` wraps each migration file in a transaction
-- and CREATE INDEX CONCURRENTLY cannot run inside one. Deploy in the
-- maintenance window the other tenant migrations already use.

-- 1. Erasure tombstone --------------------------------------------------------
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "erasedAt" TIMESTAMP(3);

-- 2. Member-number counter ----------------------------------------------------
-- One row per year. `nextSeq` is the LAST sequence handed out; the minting
-- statement is `UPDATE … SET "nextSeq" = "nextSeq" + 1 RETURNING "nextSeq"`,
-- whose row lock serialises concurrent creates. Deliberately NOT seeded here:
-- the seed value is `max(existing memberNumber for the year)`, which the
-- application computes once, lazily, the first time a year is used — so a
-- library that already printed M-2026-0417 on a card never gets it re-issued.
CREATE TABLE IF NOT EXISTS "member_number_counters" (
  "year"    INTEGER NOT NULL,
  "nextSeq" INTEGER NOT NULL,
  CONSTRAINT "member_number_counters_pkey" PRIMARY KEY ("year")
);

-- A counter that goes backwards would re-issue numbers, so make the database
-- refuse it rather than trusting every future caller.
DO $$ BEGIN
  ALTER TABLE "member_number_counters"
    ADD CONSTRAINT "member_number_counters_next_seq_positive" CHECK ("nextSeq" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Loans list indexes (performance-02) --------------------------------------
-- Unfiltered list ordering — `ORDER BY "loanedAt" DESC, id DESC LIMIT n`.
CREATE INDEX IF NOT EXISTS "loans_loanedAt_id_idx"
  ON "loans" ("loanedAt" DESC, "id" DESC);

-- The two dashboard tiles: status='active', and status='active' AND dueAt<now().
-- `status` leads so the planner seeks to the active rows and then walks them
-- already in `loanedAt` order — no sort node, no heap scan of closed loans.
CREATE INDEX IF NOT EXISTS "loans_status_loanedAt_id_idx"
  ON "loans" ("status", "loanedAt" DESC, "id" DESC);

-- Whole-set overdue readers (fine accrual, due-soon notices) ask for
-- `status='active' AND "dueAt" < now()`. `loans_dueAt_idx` cannot serve them:
-- EVERY historical loan also has a dueAt in the past, so the index matches the
-- whole table. This partial index contains only the open loans.
--
-- The predicate is `status = 'active'`, NOT the equivalent `"returnedAt" IS
-- NULL`: Postgres' index-predicate prover works from the query's own WHERE
-- clause and does not consult the `loans_status_returned_consistency` CHECK, so
-- a returnedAt-based predicate would never match a status-based query.
--
-- `"id"` is in the key, not for lookups, but so that the overdue LIST — which
-- now orders by `dueAt ASC, id ASC` (see LoansService.list) — is answered
-- entirely from the index with no sort node at all.
CREATE INDEX IF NOT EXISTS "loans_active_dueAt_idx"
  ON "loans" ("dueAt", "id")
  WHERE "status" = 'active';

-- 4. Member-number lookups under a Greek collation (performance-04 / -13) -----
-- Tenant databases inherit the server collation, which is el_GR.UTF-8 in
-- production. Under any non-C collation a DEFAULT btree cannot answer
-- `LIKE 'M-2026-%'`, so both the sequence seed scan and the importer's
-- per-row `memberNumber` lookup fell back to a seq scan of the whole members
-- table. text_pattern_ops indexes byte-wise, which makes the prefix range
-- usable; it also carries plain `=`, so the importer's equality lookup is
-- served by the same index whether or not the caller remembered to add
-- `archivedAt: null` (the existing partial unique index is unusable without it).
CREATE INDEX IF NOT EXISTS "members_member_number_pattern_idx"
  ON "members" ("memberNumber" text_pattern_ops);
