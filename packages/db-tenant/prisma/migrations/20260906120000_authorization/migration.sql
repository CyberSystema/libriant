-- Authorization: roles a library defines, and what its staff hold.
--
-- WHAT THIS REPLACES. Four roles in an enum, checked by
-- apps/api/src/tenancy/roles.guard.ts, with @StaffWrite() as shorthand for the
-- first three. Enough for a five-person school library, and it runs out
-- immediately above one:
--
--   A library cannot say "Maria may waive a fine, but not one over EUR 5."
--   Fee forgiveness is a single bit held by two roles.
--
--   A library cannot add a role. The four are compiled in, so "cataloguer who
--   may not touch circulation" is a feature request.
--
-- NOTHING CHANGES TODAY. The four system roles seeded below hold exactly the
-- permissions that reproduce the old role check, route for route. That is not
-- a claim: 125 routes x 4 roles = 500 decisions were compared before a single
-- controller was annotated, and the same comparison runs as
-- authorization-matrix.spec.ts against the live Nest router.
--
-- Two of those 500 mattered. `GET /t/:slug/settings` and the three billing
-- reads carry no role check at all, so filing `admin.settings.read` and
-- `billing.read` under the administrator role — which is where they look like
-- they belong — would have quietly REVOKED them from volunteers and
-- librarians. The matrix caught it on paper.
--
-- SYSTEM ROLES ARE RECONCILED, NOT FROZEN. This migration seeds them as of
-- today; `prisma/seed-defaults.ts` re-applies the shipped templates on every
-- run, so a library that never edited a built-in role inherits the permissions
-- a later phase adds. A library that DID edit one keeps its edit — which is
-- why the inserts below are ON CONFLICT DO NOTHING rather than upserts.
--
-- WHY THE KEY IS TEXT AND NOT AN ENUM. The catalog is code
-- (packages/shared/src/permissions.ts) and grows with every module. A database
-- enum would need a migration per verb, on every tenant database, forever.

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('grant', 'deny');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "limitNum" BIGINT,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionKey")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "staff_role_grants" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_role_grants_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "staff_permission_overrides" (
    "userId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,
    "limitNum" BIGINT,
    "reason" TEXT,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_permission_overrides_pkey" PRIMARY KEY ("userId","permissionKey")
);

-- CreateIndex
CREATE INDEX "roles_isSystem_idx" ON "roles"("isSystem");

-- CreateIndex
CREATE INDEX "role_permissions_permissionKey_idx" ON "role_permissions"("permissionKey");

-- CreateIndex
CREATE INDEX "staff_role_grants_roleId_idx" ON "staff_role_grants"("roleId");

-- CreateIndex
CREATE INDEX "staff_permission_overrides_permissionKey_idx" ON "staff_permission_overrides"("permissionKey");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A role key is unique among live roles, and freed by archiving one — the same
-- partial-unique shape as `book_copies_barcode_unique_active`
-- (20260526184041_init). Prisma cannot express a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "roles_key_unique_active"
  ON "roles" ("key") WHERE "archivedAt" IS NULL;

-- A system role may not be archived: a staff account whose control-plane role
-- maps onto it would resolve to no permissions at all, which fails closed and
-- locks the library out of its own catalogue.
ALTER TABLE "roles"
  ADD CONSTRAINT "roles_system_not_archivable"
  CHECK (NOT ("isSystem" AND "archivedAt" IS NOT NULL));

-- A limit is a ceiling, so a negative one is not a stricter rule — it is a
-- typo that denies everything while looking like a grant.
ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_limit_nonneg"
  CHECK ("limitNum" IS NULL OR "limitNum" >= 0);
ALTER TABLE "staff_permission_overrides"
  ADD CONSTRAINT "staff_permission_overrides_limit_nonneg"
  CHECK ("limitNum" IS NULL OR "limitNum" >= 0);

-- A `deny` override carries no ceiling: it is not "up to zero", it is "no".
ALTER TABLE "staff_permission_overrides"
  ADD CONSTRAINT "staff_permission_overrides_deny_has_no_limit"
  CHECK ("effect" <> 'deny' OR "limitNum" IS NULL);

-- The four shipped roles. Ids are fixed strings rather than cuids so the
-- reconciler in seed-defaults.ts can address them without a lookup, and so
-- this migration is re-runnable.
INSERT INTO "roles" ("id","key","name","description","isSystem","sortOrder","createdAt","updatedAt")
VALUES ('role_owner', 'owner', 'Owner', 'Everything, including accepting the legal agreements.', true, 10,
        (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "role_permissions" ("roleId","permissionKey")
VALUES
  ('role_owner', 'admin.announcement.read'),
  ('role_owner', 'admin.audit.read'),
  ('role_owner', 'admin.branding.manage'),
  ('role_owner', 'admin.desktop.download'),
  ('role_owner', 'admin.export.manage'),
  ('role_owner', 'admin.identity.manage'),
  ('role_owner', 'admin.import.manage'),
  ('role_owner', 'admin.legal.accept'),
  ('role_owner', 'admin.legal.read'),
  ('role_owner', 'admin.library.edit'),
  ('role_owner', 'admin.library.read'),
  ('role_owner', 'admin.plan.read'),
  ('role_owner', 'admin.settings.edit'),
  ('role_owner', 'admin.settings.read'),
  ('role_owner', 'admin.staff.manage'),
  ('role_owner', 'billing.manage'),
  ('role_owner', 'billing.read'),
  ('role_owner', 'cat.bib.delete'),
  ('role_owner', 'cat.bib.read'),
  ('role_owner', 'cat.bib.write'),
  ('role_owner', 'cat.cover.write'),
  ('role_owner', 'cat.isbn.lookup'),
  ('role_owner', 'cat.item.delete'),
  ('role_owner', 'cat.item.write'),
  ('role_owner', 'circ.fee.pay'),
  ('role_owner', 'circ.fee.read'),
  ('role_owner', 'circ.fee.void'),
  ('role_owner', 'circ.fee.waive'),
  ('role_owner', 'circ.hold.cancel'),
  ('role_owner', 'circ.hold.edit'),
  ('role_owner', 'circ.hold.expire'),
  ('role_owner', 'circ.hold.fulfill'),
  ('role_owner', 'circ.hold.place'),
  ('role_owner', 'circ.hold.read'),
  ('role_owner', 'circ.loan.checkout'),
  ('role_owner', 'circ.loan.edit'),
  ('role_owner', 'circ.loan.mark_lost'),
  ('role_owner', 'circ.loan.read'),
  ('role_owner', 'circ.loan.renew'),
  ('role_owner', 'circ.loan.return'),
  ('role_owner', 'data.collection.manage'),
  ('role_owner', 'data.collection.read'),
  ('role_owner', 'data.field.manage'),
  ('role_owner', 'data.field.read'),
  ('role_owner', 'data.record.delete'),
  ('role_owner', 'data.record.read'),
  ('role_owner', 'data.record.write'),
  ('role_owner', 'patron.archive'),
  ('role_owner', 'patron.erase'),
  ('role_owner', 'patron.photo.write'),
  ('role_owner', 'patron.pii.export'),
  ('role_owner', 'patron.read'),
  ('role_owner', 'patron.status'),
  ('role_owner', 'patron.write'),
  ('role_owner', 'report.dashboard.read'),
  ('role_owner', 'support.key.manage'),
  ('role_owner', 'support.session.read'),
  ('role_owner', 'support.session.revoke')
ON CONFLICT ("roleId","permissionKey") DO NOTHING;

INSERT INTO "roles" ("id","key","name","description","isSystem","sortOrder","createdAt","updatedAt")
VALUES ('role_admin', 'admin', 'Administrator', 'Runs the library: settings, staff, billing and the destructive actions.', true, 20,
        (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "role_permissions" ("roleId","permissionKey")
VALUES
  ('role_admin', 'admin.announcement.read'),
  ('role_admin', 'admin.audit.read'),
  ('role_admin', 'admin.branding.manage'),
  ('role_admin', 'admin.desktop.download'),
  ('role_admin', 'admin.export.manage'),
  ('role_admin', 'admin.identity.manage'),
  ('role_admin', 'admin.import.manage'),
  ('role_admin', 'admin.legal.read'),
  ('role_admin', 'admin.library.edit'),
  ('role_admin', 'admin.library.read'),
  ('role_admin', 'admin.plan.read'),
  ('role_admin', 'admin.settings.edit'),
  ('role_admin', 'admin.settings.read'),
  ('role_admin', 'admin.staff.manage'),
  ('role_admin', 'billing.manage'),
  ('role_admin', 'billing.read'),
  ('role_admin', 'cat.bib.delete'),
  ('role_admin', 'cat.bib.read'),
  ('role_admin', 'cat.bib.write'),
  ('role_admin', 'cat.cover.write'),
  ('role_admin', 'cat.isbn.lookup'),
  ('role_admin', 'cat.item.delete'),
  ('role_admin', 'cat.item.write'),
  ('role_admin', 'circ.fee.pay'),
  ('role_admin', 'circ.fee.read'),
  ('role_admin', 'circ.fee.void'),
  ('role_admin', 'circ.fee.waive'),
  ('role_admin', 'circ.hold.cancel'),
  ('role_admin', 'circ.hold.edit'),
  ('role_admin', 'circ.hold.expire'),
  ('role_admin', 'circ.hold.fulfill'),
  ('role_admin', 'circ.hold.place'),
  ('role_admin', 'circ.hold.read'),
  ('role_admin', 'circ.loan.checkout'),
  ('role_admin', 'circ.loan.edit'),
  ('role_admin', 'circ.loan.mark_lost'),
  ('role_admin', 'circ.loan.read'),
  ('role_admin', 'circ.loan.renew'),
  ('role_admin', 'circ.loan.return'),
  ('role_admin', 'data.collection.manage'),
  ('role_admin', 'data.collection.read'),
  ('role_admin', 'data.field.manage'),
  ('role_admin', 'data.field.read'),
  ('role_admin', 'data.record.delete'),
  ('role_admin', 'data.record.read'),
  ('role_admin', 'data.record.write'),
  ('role_admin', 'patron.archive'),
  ('role_admin', 'patron.erase'),
  ('role_admin', 'patron.photo.write'),
  ('role_admin', 'patron.pii.export'),
  ('role_admin', 'patron.read'),
  ('role_admin', 'patron.status'),
  ('role_admin', 'patron.write'),
  ('role_admin', 'report.dashboard.read'),
  ('role_admin', 'support.key.manage'),
  ('role_admin', 'support.session.read'),
  ('role_admin', 'support.session.revoke')
ON CONFLICT ("roleId","permissionKey") DO NOTHING;

INSERT INTO "roles" ("id","key","name","description","isSystem","sortOrder","createdAt","updatedAt")
VALUES ('role_librarian', 'librarian', 'Librarian', 'The daily work of a circulation desk and a cataloguer.', true, 30,
        (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "role_permissions" ("roleId","permissionKey")
VALUES
  ('role_librarian', 'admin.announcement.read'),
  ('role_librarian', 'admin.desktop.download'),
  ('role_librarian', 'admin.settings.read'),
  ('role_librarian', 'billing.read'),
  ('role_librarian', 'cat.bib.delete'),
  ('role_librarian', 'cat.bib.read'),
  ('role_librarian', 'cat.bib.write'),
  ('role_librarian', 'cat.cover.write'),
  ('role_librarian', 'cat.isbn.lookup'),
  ('role_librarian', 'cat.item.delete'),
  ('role_librarian', 'cat.item.write'),
  ('role_librarian', 'circ.fee.pay'),
  ('role_librarian', 'circ.fee.read'),
  ('role_librarian', 'circ.hold.cancel'),
  ('role_librarian', 'circ.hold.edit'),
  ('role_librarian', 'circ.hold.expire'),
  ('role_librarian', 'circ.hold.fulfill'),
  ('role_librarian', 'circ.hold.place'),
  ('role_librarian', 'circ.hold.read'),
  ('role_librarian', 'circ.loan.checkout'),
  ('role_librarian', 'circ.loan.edit'),
  ('role_librarian', 'circ.loan.mark_lost'),
  ('role_librarian', 'circ.loan.read'),
  ('role_librarian', 'circ.loan.renew'),
  ('role_librarian', 'circ.loan.return'),
  ('role_librarian', 'data.collection.read'),
  ('role_librarian', 'data.field.read'),
  ('role_librarian', 'data.record.delete'),
  ('role_librarian', 'data.record.read'),
  ('role_librarian', 'data.record.write'),
  ('role_librarian', 'patron.archive'),
  ('role_librarian', 'patron.photo.write'),
  ('role_librarian', 'patron.pii.export'),
  ('role_librarian', 'patron.read'),
  ('role_librarian', 'patron.status'),
  ('role_librarian', 'patron.write'),
  ('role_librarian', 'report.dashboard.read')
ON CONFLICT ("roleId","permissionKey") DO NOTHING;

INSERT INTO "roles" ("id","key","name","description","isSystem","sortOrder","createdAt","updatedAt")
VALUES ('role_volunteer', 'volunteer', 'Volunteer', 'May look at everything and change nothing.', true, 40,
        (pg_catalog.now() AT TIME ZONE 'UTC'), (pg_catalog.now() AT TIME ZONE 'UTC'))
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "role_permissions" ("roleId","permissionKey")
VALUES
  ('role_volunteer', 'admin.announcement.read'),
  ('role_volunteer', 'admin.desktop.download'),
  ('role_volunteer', 'admin.settings.read'),
  ('role_volunteer', 'billing.read'),
  ('role_volunteer', 'cat.bib.read'),
  ('role_volunteer', 'cat.isbn.lookup'),
  ('role_volunteer', 'circ.fee.read'),
  ('role_volunteer', 'circ.hold.read'),
  ('role_volunteer', 'circ.loan.read'),
  ('role_volunteer', 'data.collection.read'),
  ('role_volunteer', 'data.field.read'),
  ('role_volunteer', 'data.record.read'),
  ('role_volunteer', 'patron.read'),
  ('role_volunteer', 'report.dashboard.read')
ON CONFLICT ("roleId","permissionKey") DO NOTHING;

