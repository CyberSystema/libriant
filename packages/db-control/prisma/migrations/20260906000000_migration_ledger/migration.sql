-- The migration ledger: what schema each tenant is on, and what a fan-out did.
--
-- WHAT WAS WRONG. `scripts/tenant-migrate.ts` iterated every tenant, shelled
-- out to `prisma migrate deploy`, printed a summary and exited. Nothing about
-- the run survived the process, and two consequences follow directly:
--
--   A partial fan-out was unrecoverable. Forty tenants in, one fails; the
--   script exits 2 and the only way forward is to run the whole thing again
--   and trust that every already-migrated tenant is a no-op. That holds until
--   a migration is not idempotent — and this repo has migrations that
--   deduplicate rows and repair orphaned holds, which are precisely the ones
--   that must not run twice.
--
--   Nobody could answer "what schema is this library on?" without opening a
--   connection to its database. That is the first question of any incident,
--   and `pnpm fleet:report` could not answer it.
--
-- WHAT THIS ADDS.
--
--   tenant_schema_state    one row per tenant, the schema its database is on.
--                          A CACHE of what the tenant DB says about itself,
--                          never the source of truth — `_prisma_migrations`
--                          in the tenant database is — so `--resume` verifies
--                          against the tenant rather than trusting this row.
--
--   migration_runs         one fan-out, with its plan and its outcome.
--
--   migration_run_tenants  one tenant within one run: the unit `--resume`
--                          skips or retries. `slug` is denormalised on
--                          purpose, so a run stays readable after a tenant is
--                          renamed or archived.
--
-- NO DATA IS TOUCHED. Three new tables and two enums; nothing existing is read
-- or written. On a database that has never run a fan-out, every tenant simply
-- has no row and `--resume` has nothing to resume, which is the correct
-- reading of "we do not know yet".

-- CreateEnum
CREATE TYPE "MigrationRunStatus" AS ENUM ('running', 'completed', 'failed', 'aborted');

-- CreateEnum
CREATE TYPE "MigrationTenantStatus" AS ENUM ('planned', 'running', 'ok', 'failed', 'skipped', 'timeout');

-- CreateTable
CREATE TABLE "tenant_schema_state" (
    "tenantId" TEXT NOT NULL,
    "schemaMajor" INTEGER NOT NULL DEFAULT 1,
    "lastMigration" TEXT,
    "migrationCount" INTEGER NOT NULL DEFAULT 0,
    "onlinePending" TEXT,
    "checkedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_schema_state_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "migration_runs" (
    "id" TEXT NOT NULL,
    "status" "MigrationRunStatus" NOT NULL DEFAULT 'running',
    "note" TEXT,
    "invocation" TEXT,
    "plannedCount" INTEGER NOT NULL DEFAULT 0,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "resumedFromId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "migration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_run_tenants" (
    "runId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "MigrationTenantStatus" NOT NULL DEFAULT 'planned',
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,

    CONSTRAINT "migration_run_tenants_pkey" PRIMARY KEY ("runId","tenantId")
);

-- CreateIndex
CREATE INDEX "tenant_schema_state_schemaMajor_idx" ON "tenant_schema_state"("schemaMajor");

-- CreateIndex
CREATE INDEX "migration_runs_status_startedAt_idx" ON "migration_runs"("status", "startedAt");

-- CreateIndex
CREATE INDEX "migration_run_tenants_runId_status_idx" ON "migration_run_tenants"("runId", "status");

-- CreateIndex
CREATE INDEX "migration_run_tenants_tenantId_startedAt_idx" ON "migration_run_tenants"("tenantId", "startedAt");

-- AddForeignKey
ALTER TABLE "migration_run_tenants" ADD CONSTRAINT "migration_run_tenants_runId_fkey" FOREIGN KEY ("runId") REFERENCES "migration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

