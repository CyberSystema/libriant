-- Per-library member-email reminder switches. All default OFF (opt-in): a
-- library never auto-emails its patrons until an admin turns these on, so this
-- migration is invisible to existing tenants.
ALTER TABLE "tenant_settings" ADD COLUMN "notifyDueSoon" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_settings" ADD COLUMN "dueSoonDays" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "tenant_settings" ADD COLUMN "notifyOverdue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_settings" ADD COLUMN "notifyHoldReady" BOOLEAN NOT NULL DEFAULT false;
