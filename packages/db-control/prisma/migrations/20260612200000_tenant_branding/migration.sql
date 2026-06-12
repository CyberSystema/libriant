-- Per-library branding: accent colour + header logo (tenant-storage ref).
-- Both nullable; NULL falls back to the default Libriant theme + wordmark.
ALTER TABLE "tenants" ADD COLUMN "brandColor" TEXT;
ALTER TABLE "tenants" ADD COLUMN "brandLogoRef" TEXT;
