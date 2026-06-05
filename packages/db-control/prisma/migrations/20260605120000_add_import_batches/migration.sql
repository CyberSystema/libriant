-- Bulk import / migration jobs.
--
-- Durable two-tier pattern (same as email_outbox): the batch row lives in
-- the control plane so the shared worker process can drive validate + commit
-- passes, while the actual data writes land in the per-tenant DB. The raw
-- upload is staged on the shared storage volume (path on `stagingPath`).

CREATE TYPE "ImportEntityKind" AS ENUM ('author', 'book', 'book_copy', 'member', 'loan', 'reservation', 'fine');
CREATE TYPE "ImportSourceFormat" AS ENUM ('csv', 'tsv', 'xlsx', 'marc', 'marcxml');
CREATE TYPE "ImportStatus" AS ENUM ('uploaded', 'validating', 'validated', 'committing', 'completed', 'partially_completed', 'failed', 'canceled');
CREATE TYPE "ImportDuplicateMode" AS ENUM ('skip', 'update', 'error');

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityKind" "ImportEntityKind" NOT NULL,
    "format" "ImportSourceFormat" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'uploaded',
    "originalName" TEXT NOT NULL,
    "stagingPath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "encoding" TEXT,
    "delimiter" TEXT,
    "sheetName" TEXT,
    "hasHeaderRow" BOOLEAN NOT NULL DEFAULT true,
    "columnsJson" JSONB NOT NULL DEFAULT '{}',
    "mappingJson" JSONB,
    "optionsJson" JSONB NOT NULL DEFAULT '{}',
    "duplicateMode" "ImportDuplicateMode" NOT NULL DEFAULT 'skip',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "warningRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "updatedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "issuesTruncated" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row_issues" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "field" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_row_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_batches_tenantId_createdAt_idx" ON "import_batches"("tenantId", "createdAt");
CREATE INDEX "import_batches_status_idx" ON "import_batches"("status");
CREATE INDEX "import_row_issues_batchId_rowNumber_idx" ON "import_row_issues"("batchId", "rowNumber");
CREATE INDEX "import_row_issues_batchId_severity_idx" ON "import_row_issues"("batchId", "severity");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_row_issues" ADD CONSTRAINT "import_row_issues_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-count sanity: every counter is non-negative.
ALTER TABLE "import_batches"
  ADD CONSTRAINT "import_batches_counts_nonneg"
  CHECK (
    "totalRows" >= 0 AND "validRows" >= 0 AND "errorRows" >= 0 AND "warningRows" >= 0
    AND "importedRows" >= 0 AND "updatedRows" >= 0 AND "skippedRows" >= 0 AND "sizeBytes" >= 0
  );
