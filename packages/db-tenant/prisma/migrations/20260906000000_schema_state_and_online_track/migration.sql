-- Schema bookkeeping: what this database is, and what is half-done to it.
--
-- Prisma's `_prisma_migrations` records which migration FILES have run. It
-- cannot record either of the two things a fleet of databases actually needs.
--
-- WHICH SCHEMA GENERATION THIS DATABASE IS ON. Telling a 1.0 tenant from a 2.0
-- one by reading its migration list means knowing which migration name is the
-- boundary, in every tool that asks. `schema_major` is one integer, and the
-- 2.0 upgrade is the only thing that ever sets it to 2.
--
-- WHICH ONLINE SCRIPT IS PART-WAY THROUGH. This is the one Prisma structurally
-- cannot know. An online script runs OUTSIDE a transaction — that is the whole
-- point of it, because `CREATE INDEX CONCURRENTLY` cannot run inside one — so
-- it has states that are neither "applied" nor "not applied": half a backfill
-- committed, an index left INVALID by a failed build. Applying the next
-- barrier migration on top of that is how a database ends up with an index
-- the planner will not use and a column half-populated, with nothing anywhere
-- that reports it.
--
-- `_libriant_online_migrations` is deliberately NOT shaped like
-- `_prisma_migrations`. A checksum-and-refuse ledger is right for a
-- transactional migration that must run exactly once; it is wrong for a
-- resumable script, which must be re-enterable after a failure and needs to
-- remember where it got to.


-- CreateTable
CREATE TABLE "_libriant_schema_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "schemaMajor" INTEGER NOT NULL DEFAULT 1,
    "onlinePending" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "_libriant_schema_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_libriant_online_migrations" (
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "rowsDone" BIGINT NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "_libriant_online_migrations_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "_libriant_online_migrations_finishedAt_idx" ON "_libriant_online_migrations"("finishedAt");


-- The singleton CHECK Prisma cannot express, exactly as `tenant_settings`
-- does it (20260526184041_init). Without it, a second row is a legal state and
-- every reader has to decide which one wins.
ALTER TABLE "_libriant_schema_state"
  ADD CONSTRAINT "_libriant_schema_state_singleton" CHECK ("id" = 1);

-- Seed the singleton so readers never have to handle "no row yet". Every
-- database this migration runs on is, by definition, on the 1.x schema.
INSERT INTO "_libriant_schema_state" ("id", "schemaMajor", "createdAt", "updatedAt")
VALUES (1, 1, (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;
