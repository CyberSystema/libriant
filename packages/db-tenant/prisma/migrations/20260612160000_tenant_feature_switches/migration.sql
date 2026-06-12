-- Per-library feature switches the tenant admin controls. New columns first,
-- then a behavior-preserving backfill so this migration is invisible to
-- libraries that have already configured their circulation policy.

ALTER TABLE "tenant_settings" ADD COLUMN "renewalsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenant_settings" ADD COLUMN "overdueFinesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_settings" ADD COLUMN "lostItemFeesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_settings" ADD COLUMN "lostItemDefaultFeeCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tenant_settings" ADD COLUMN "reservationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Backfill from existing policy:
--   * a library already charging a per-day fine keeps fines ON;
--   * a library that set maxRenewals = 0 keeps renewals OFF.
-- (reservations + lost-item fees take their column defaults: reservations stay
--  on to preserve the current plan-gated behavior; lost-item fees default off.)
UPDATE "tenant_settings" SET "overdueFinesEnabled" = ("finePerDayCents" > 0);
UPDATE "tenant_settings" SET "renewalsEnabled" = ("maxRenewals" > 0);
