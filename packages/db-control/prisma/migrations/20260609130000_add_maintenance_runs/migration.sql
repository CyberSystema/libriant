-- Operator maintenance runs: admin-launched, worker-executed jobs over the
-- control DB and/or tenant DBs (diagnostics, migrations, fixers, VACUUM).

CREATE TYPE "MaintenanceKind" AS ENUM ('diagnostics', 'migrate', 'fix', 'vacuum');
CREATE TYPE "MaintenanceScope" AS ENUM ('tenant', 'control', 'all');
CREATE TYPE "MaintenanceStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

CREATE TABLE "maintenance_runs" (
    "id" TEXT NOT NULL,
    "kind" "MaintenanceKind" NOT NULL,
    "scope" "MaintenanceScope" NOT NULL,
    "targetTenantId" TEXT,
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'queued',
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "resultJson" JSONB,
    "error" TEXT,
    "createdByAdminId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "maintenance_runs_kind_createdAt_idx" ON "maintenance_runs" ("kind", "createdAt");
CREATE INDEX "maintenance_runs_status_idx" ON "maintenance_runs" ("status");
