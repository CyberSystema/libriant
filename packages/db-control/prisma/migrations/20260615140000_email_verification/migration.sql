-- Email verification (signup confirmation + email-change re-verify, soft-gated).
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'email_verification';
ALTER TYPE "EmailMessageKind" ADD VALUE IF NOT EXISTS 'welcome';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
