-- Legal consent capture (GDPR / contract accountability). Records which version
-- of the Terms of Service + Privacy Policy the owner accepted at signup, when,
-- and from which IP — on both the User (the individual who accepted) and the
-- Tenant (the contracting library). Nullable + IF NOT EXISTS so the migration is
-- safe to re-run and existing rows are simply un-stamped.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "legalAcceptedVersion" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "legalAcceptedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "legalAcceptedIp" TEXT;

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "legalAcceptedVersion" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "legalAcceptedAt" TIMESTAMP(3);
