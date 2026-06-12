-- Per-library overrides for the reminder email copy. Empty by default — the
-- cron falls back to the built-in localized templates.
ALTER TABLE "tenant_settings" ADD COLUMN "notificationTemplates" JSONB NOT NULL DEFAULT '{}';
