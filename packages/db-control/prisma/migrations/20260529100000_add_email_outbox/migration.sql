-- Step 18d — Email outbox.
--
-- Two-table durable queue: rows in `email_outbox` are the source of truth
-- (committed inside the producer's transaction), BullMQ jobs in Redis are
-- the scheduler. Worker reads + flips status on success/failure.

CREATE TYPE "EmailOutboxStatus" AS ENUM (
  'pending',
  'sending',
  'delivered',
  'failed',
  'dead'
);

CREATE TYPE "EmailMessageKind" AS ENUM (
  'support_key_generated',
  'support_key_redeemed',
  'support_session_ended',
  'announcement',
  'password_reset',
  'transactional'
);

CREATE TABLE "email_outbox" (
  "id"             TEXT NOT NULL,
  "idempotencyKey" TEXT,
  "kind"           "EmailMessageKind" NOT NULL,
  "toEmail"        CITEXT NOT NULL,
  "fromEmail"      CITEXT,
  "replyToEmail"   CITEXT,
  "subject"        TEXT NOT NULL,
  "bodyMarkdown"   TEXT NOT NULL,
  "tenantId"       TEXT,
  "metadataJson"   JSONB NOT NULL DEFAULT '{}',
  "status"         "EmailOutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"    INTEGER NOT NULL DEFAULT 5,
  "scheduledFor"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "providerId"     TEXT,
  "lastError"      TEXT,
  "deliveredAt"    TIMESTAMP(3),
  "failedAt"       TIMESTAMP(3),
  "abandonedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_outbox_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "email_outbox_idempotencyKey_key"
  ON "email_outbox" ("idempotencyKey");

CREATE INDEX "email_outbox_status_scheduledFor_idx"
  ON "email_outbox" ("status", "scheduledFor");

CREATE INDEX "email_outbox_tenantId_kind_createdAt_idx"
  ON "email_outbox" ("tenantId", "kind", "createdAt");
