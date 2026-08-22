-- Applications from the public marketing site's form at libriant.com.
--
-- Replaces the Cloudflare D1 table the site used to write to; there was never a
-- production D1 database, so nothing is migrated in. Idempotent (guarded /
-- IF NOT EXISTS) to match the repo convention.

-- Enums --------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "ApplicationStatus" AS ENUM ('new', 'contacted', 'accepted', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- EmailMessageKind addition. No row in THIS migration uses the new value, so
-- ADD VALUE is safe inside the migration transaction.
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'application_submitted';

-- Table ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "applications" (
  "id"                TEXT         NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  "libraryName"       TEXT         NOT NULL,
  "libraryType"       "LibraryType" NOT NULL,
  "city"              TEXT         NOT NULL,
  "contactName"       TEXT         NOT NULL,
  "contactEmail"      CITEXT       NOT NULL,
  "phone"             TEXT,

  "collectionSize"    TEXT,
  "currentSystem"     TEXT,
  "message"           TEXT,

  "consent"           BOOLEAN      NOT NULL,
  "privacyVersion"    TEXT         NOT NULL,

  "notified"          BOOLEAN      NOT NULL DEFAULT false,
  "notifyError"       TEXT,

  "status"            "ApplicationStatus" NOT NULL DEFAULT 'new',
  "reviewedByAdminId" TEXT,
  "decisionNote"      TEXT,
  "reviewedAt"        TIMESTAMP(3),

  CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "applications_status_createdAt_idx" ON "applications" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "applications_createdAt_idx"        ON "applications" ("createdAt");
