-- Library profile (collected at signup) + the owner-approved edit-request
-- workflow. Idempotent (IF NOT EXISTS / guarded) to match the repo convention.

-- Enums --------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "LibraryType" AS ENUM ('public', 'academic', 'school', 'special', 'community', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LibraryEditRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- EmailMessageKind additions (ADD VALUE is not used in this same migration, so
-- it is safe inside the migration transaction).
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'library_edit_request_submitted';
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'library_edit_request_decided';

-- Tenant profile columns ---------------------------------------------------
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "libraryType" "LibraryType";
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "addressStreet" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "addressCity" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "addressPostalCode" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "addressRegion" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "addressCountry" TEXT DEFAULT 'GR';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "publicPhone" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "publicEmail" CITEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "website" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "foundedYear" INTEGER;

-- Edit-request table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS "library_edit_requests" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "status" "LibraryEditRequestStatus" NOT NULL DEFAULT 'pending',
  "proposedJson" JSONB NOT NULL,
  "beforeJson" JSONB NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "requestNote" TEXT,
  "reviewedByAdminId" TEXT,
  "decisionNote" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "library_edit_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "library_edit_requests_status_createdAt_idx" ON "library_edit_requests" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "library_edit_requests_tenantId_createdAt_idx" ON "library_edit_requests" ("tenantId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "library_edit_requests"
    ADD CONSTRAINT "library_edit_requests_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
