-- Per-library member-email reminder switches. All default OFF (opt-in): a
-- library never auto-emails its patrons until an admin turns these on, so this
-- migration is invisible to existing tenants.
ALTER TABLE "tenant_settings" ADD COLUMN "notifyDueSoon" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_settings" ADD COLUMN "dueSoonDays" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "tenant_settings" ADD COLUMN "notifyOverdue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_settings" ADD COLUMN "notifyHoldReady" BOOLEAN NOT NULL DEFAULT false;

-- DATA-2: keep tenant_settings numeric columns consistently constrained
-- (matches the tenant_settings_nonneg CHECK from the init migration). The DTO
-- already enforces @Min(1) and the reminder job clamps with Math.max(1, …), so
-- this is defense-in-depth. Guarded so the migration stays re-runnable — there
-- is no ADD CONSTRAINT IF NOT EXISTS for CHECK in Postgres.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_settings_due_soon_days_nonneg'
  ) THEN
    ALTER TABLE "tenant_settings"
      ADD CONSTRAINT "tenant_settings_due_soon_days_nonneg" CHECK ("dueSoonDays" >= 1);
  END IF;
END $$;
