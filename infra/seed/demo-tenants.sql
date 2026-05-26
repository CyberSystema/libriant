-- Demo tenants used by the tenancy-layer probes in the README and CI.
-- Idempotent: pre-deletes the rows before inserting fresh copies.
--
-- All three point at the same `libriant_demo` DB so a smoke test only needs
-- one tenant schema applied. In real prod each library has its own DB.

DELETE FROM tenants WHERE slug IN ('acme', 'paused-lib', 'archived-lib');

INSERT INTO tenants (id, slug, name, "defaultLocale", "cellId", "dbUrl", "storageUrl",
                    "customSubdomain", "primaryEmail", status, "updatedAt")
VALUES
  ('tenant-acme-id', 'acme', 'Δημοτική Βιβλιοθήκη Acme', 'el', 'cell-eu-1',
   'postgresql://libriant:libriant@localhost:5432/libriant_demo',
   'file:///srv/libriant/storage/tenant-acme-id',
   'acme', 'admin@acme.test', 'active', NOW()),
  ('tenant-paused-id', 'paused-lib', 'Paused Library', 'en', 'cell-eu-1',
   'postgresql://libriant:libriant@localhost:5432/libriant_demo',
   'file:///srv/libriant/storage/tenant-paused-id',
   NULL, 'admin@paused.test', 'suspended', NOW()),
  ('tenant-arch-id', 'archived-lib', 'Archived Library', 'en', 'cell-eu-1',
   'postgresql://libriant:libriant@localhost:5432/libriant_demo',
   'file:///srv/libriant/storage/tenant-arch-id',
   NULL, 'admin@archived.test', 'archived', NOW());

-- Quick verification
SELECT slug, status, "customSubdomain" FROM tenants WHERE slug IN ('acme','paused-lib','archived-lib');
