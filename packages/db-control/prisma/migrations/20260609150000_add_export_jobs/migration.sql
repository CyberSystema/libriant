-- Database export jobs: admin / library-admin launched, worker-run dumps of a
-- tenant DB, the control DB, or everything, into a downloadable file.

CREATE TYPE "ExportFormat" AS ENUM ('csv', 'json', 'xlsx', 'sql');
CREATE TYPE "ExportScope" AS ENUM ('tenant', 'control', 'all');
CREATE TYPE "ExportStatus" AS ENUM ('queued', 'running', 'completed', 'failed');
CREATE TYPE "ExportRequesterKind" AS ENUM ('admin', 'user');

CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "scope" "ExportScope" NOT NULL,
    "targetTenantId" TEXT,
    "requestedByKind" "ExportRequesterKind" NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'queued',
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "fileName" TEXT,
    "filePath" TEXT,
    "fileBytes" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "export_jobs_targetTenantId_createdAt_idx" ON "export_jobs" ("targetTenantId", "createdAt");
CREATE INDEX "export_jobs_requestedByKind_requestedById_createdAt_idx" ON "export_jobs" ("requestedByKind", "requestedById", "createdAt");
CREATE INDEX "export_jobs_status_idx" ON "export_jobs" ("status");
