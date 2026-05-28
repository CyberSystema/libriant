-- Lock down "at most one tenant-wide delivery row per (announcement, tenant)".
-- The default unique index `(announcementId, tenantId, userId)` doesn't catch
-- this because Postgres BTREE treats NULL userIds as distinct. Without the
-- partial unique below, two simultaneous first-fetches by different users on
-- the same tenant could race-insert duplicate rows for the same tenant-wide
-- announcement.
CREATE UNIQUE INDEX IF NOT EXISTS "announcement_deliveries_tenant_wide_unique"
ON "announcement_deliveries" ("announcementId", "tenantId")
WHERE "userId" IS NULL AND "tenantId" IS NOT NULL;
