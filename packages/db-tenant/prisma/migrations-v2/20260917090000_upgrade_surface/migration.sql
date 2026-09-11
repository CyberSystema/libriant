-- The surface the v1→v2 upgrade lands on (2.0 phase 19a).
--
-- Phase 19 is split in two. THIS half builds everything the copy-forward will
-- need to exist BEFORE it runs and cannot create for itself; 19b writes the
-- copy-forward, the verifier, the fixture and the CI job. The split is not
-- administrative: two of the three things here are impossible to do in the same
-- transaction as the migration that uses them, and the third is a decision about
-- what a library keeps, which deserves its own review.
--
-- ============================================================================
-- 1. TWO ENUM VALUES, AND WHY THEY CANNOT WAIT FOR THE COPY-FORWARD
-- ============================================================================
--
-- MEASURED on PG 16.15, all four cases:
--
--   BEGIN; ALTER TYPE e ADD VALUE 'c'; COMMIT;              accepted
--   the value is present afterwards                          yes
--   BEGIN; ALTER TYPE e ADD VALUE 'd'; SELECT 'd'::e;        ERROR: unsafe use
--                                                            of new value "d"
--   and the abort rolls the ADD VALUE back too               yes
--
-- So a value must be COMMITTED by one transaction before another can use it.
-- The copy-forward is a single transaction by design — the whole safety story
-- is that a corrupted fixture leaves the database byte-identical — so it cannot
-- add these itself. They land here, days earlier, and nothing in this file uses
-- them.
--
-- `ledger_account.opening_balance` is where a historical settlement is debited.
-- Not `cash_on_hand`: a fine paid in 2019 did go into a till, but that till was
-- counted and banked years ago, and posting it now would inflate the trial
-- balance of a library that has just started keeping one by every fine it has
-- ever taken. An opening balance is the accounting answer to "this happened
-- before our books began", which is exactly what a migrated settlement is.
--
-- `event_source.migration` is so a row written by the upgrade is distinguishable
-- from one a librarian made at a desk. Every other value in that enum names a
-- place a human or a device acted; a migrated row was nobody's action, and
-- labelling forty thousand of them `desk` would put fictional counter activity
-- into every report that groups by source.
--
-- ============================================================================
-- 2. FIVE COLUMNS 2.0 DOES NOT HAVE AND A MIGRATED LIBRARY NEEDS
-- ============================================================================
--
-- These are not conveniences. Each one is a 1.0 column with real content and no
-- 2.0 home, found by writing `prisma/upgrade/routing.json` — which exists to
-- make exactly this discoverable, because three independent designs for this
-- phase each lost a different subset of them silently.
--
-- `loans.notes` and `fees.notes`. The tempting alternative is to fold a loan's
-- note into `loan_events.note` on the `returned` event. That drops the note of
-- every ACTIVE and every LOST loan — and those are precisely the notes that say
-- "borrower says posted back 3/9" and "lost report filed". A note about a debt
-- has nowhere else at all: `fees` has no event table.
--
-- `fees.archived_at`. 1.0 soft-deletes a fine, and that is NOT the same fact as
-- `status = 'cancelled'`. A PAID fine that was later archived has both, and
-- collapsing them loses the archival and leaves a settled debt looking live.
--
-- `loans.custom_fields`, `holds.custom_fields`, `fees.custom_fields`. Every 1.0
-- table carries a `customFields` jsonb that a library fills through
-- `field_definitions`. `patrons`, `items` and `bib_records` already have theirs;
-- these three did not, because nothing in 2.0 had written one yet.
--
-- ============================================================================
-- 3. ELEVEN COMPAT TWINS, IN THE 1.0 PHYSICAL SHAPE, VERBATIM
-- ============================================================================
--
-- Eleven 1.0 tables have no 2.0 successor and are still LIVE: the authorization
-- five (`roles` … `staff_permission_overrides`), which every `PermissionGuard`
-- call reads on every request; `field_definitions`; the collections three; and
-- the two `_libriant_*` bookkeeping tables.
--
-- At the cutover `public` is renamed to `v1_archive`, and the 1.0 Prisma client
-- keeps running until phase 20 deletes it. That client resolves BARE names
-- through `search_path`, so the twins must be found where it looks — and it
-- generates quoted camelCase (`"createdAt"`, `"entityKind"`) and casts to
-- quoted PascalCase enum types (`CAST($1::text AS "PermissionEffect")`).
--
-- SO THE TWINS ARE NOT snake_case. A conventions-abiding twin is a twin the
-- surviving client cannot read: every PermissionGuard call would fail with
-- column "createdAt" does not exist, and a library would be locked out of its
-- own roles table on cutover day. The 2.0 conventions gate scopes itself to the
-- `schema-v2` FOLDER for this reason, and these models say so in their
-- docblocks.
--
-- The THREE 1.0 enum types are recreated here too, under their 1.0 quoted names.
-- They live in `public` today and would be renamed along with it, so a twin that
-- referenced `"PermissionEffect"` after the rename would resolve to nothing.
--
-- ============================================================================
-- 4. TWO TABLES THAT RECORD WHAT THE UPGRADE COULD NOT CARRY
-- ============================================================================
--
-- A one-way migration's real failure mode is not a wrong value — a wrong value
-- is visible. It is a row nobody mentioned. `upgrade_exceptions` and
-- `upgrade_dropped_rows` make "we did not carry this" a row rather than a
-- silence, so the verifier can assert
--
--     count(v1) = count(v2) + count(recorded as not carried)
--
-- as an EQUALITY. Without them that assertion can only be an inequality, and an
-- inequality passes when something is missing.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

-- ---------------------------------------------------------------------------
-- 1. The enum values (added here, USED by 19b's copy-forward)
-- ---------------------------------------------------------------------------

ALTER TYPE "ledger_account" ADD VALUE IF NOT EXISTS 'opening_balance';
ALTER TYPE "event_source"   ADD VALUE IF NOT EXISTS 'migration';

-- ---------------------------------------------------------------------------
-- 2. The five columns
-- ---------------------------------------------------------------------------

ALTER TABLE "loans" ADD COLUMN "notes" text;
ALTER TABLE "loans" ADD COLUMN "custom_fields" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "holds" ADD COLUMN "custom_fields" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "fees"  ADD COLUMN "notes" text;
ALTER TABLE "fees"  ADD COLUMN "custom_fields" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "fees"  ADD COLUMN "archived_at" timestamptz(3);

-- `owed_cents` (phase 18) is the only predicate a reader should ask, and an
-- ARCHIVED fee is not owed. Archiving is a soft delete, so the generated column
-- has to see it or a library's balance would include debts it has filed away.
ALTER TABLE "fees" DROP COLUMN "owed_cents";
ALTER TABLE "fees" ADD COLUMN "owed_cents" bigint
  GENERATED ALWAYS AS (
    CASE WHEN "closed_at" IS NULL AND "archived_at" IS NULL
         THEN "amount_cents" + "tax_cents" - "paid_cents" - "waived_cents" - "written_off_cents"
         ELSE 0 END
  ) STORED;

-- ---------------------------------------------------------------------------
-- 3. The 1.0 enum types, under their 1.0 names
-- ---------------------------------------------------------------------------

CREATE TYPE "PermissionEffect" AS ENUM ('grant', 'deny');
CREATE TYPE "FieldEntityKind"  AS ENUM ('book', 'book_copy', 'member', 'loan', 'reservation', 'fine');
CREATE TYPE "FieldType"        AS ENUM (
  'short_text', 'long_text', 'number', 'boolean', 'date', 'datetime',
  'select_one', 'select_many', 'url', 'email'
);

-- ---------------------------------------------------------------------------
-- 4. The eleven compat twins — 1.0 DDL, rendered from the 1.0 datamodel
-- ---------------------------------------------------------------------------

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
CREATE INDEX "roles_isSystem_idx" ON "roles"("isSystem");

CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "limitNum" BIGINT,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionKey")
);
CREATE INDEX "role_permissions_permissionKey_idx" ON "role_permissions"("permissionKey");

CREATE TABLE "staff_profiles" (
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "staff_role_grants" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_role_grants_pkey" PRIMARY KEY ("userId","roleId")
);
CREATE INDEX "staff_role_grants_roleId_idx" ON "staff_role_grants"("roleId");

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
CREATE INDEX "staff_permission_overrides_permissionKey_idx"
  ON "staff_permission_overrides"("permissionKey");

CREATE TABLE "field_definitions" (
    "id" TEXT NOT NULL,
    "entityKind" "FieldEntityKind" NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "labelJson" JSONB NOT NULL,
    "type" "FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "optionsJson" JSONB,
    "validationJson" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "indexed" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "field_definitions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "field_definitions_entityKind_sortOrder_idx"
  ON "field_definitions"("entityKind", "sortOrder");
CREATE UNIQUE INDEX "field_definitions_entityKind_fieldKey_key"
  ON "field_definitions"("entityKind", "fieldKey");

CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "singularLabelJson" JSONB NOT NULL,
    "pluralLabelJson" JSONB NOT NULL,
    "iconAssetRef" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "collections_slug_idx" ON "collections"("slug");

CREATE TABLE "collection_fields" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "labelJson" JSONB NOT NULL,
    "type" "FieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "optionsJson" JSONB,
    "validationJson" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "indexed" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "collection_fields_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "collection_fields_collectionId_sortOrder_idx"
  ON "collection_fields"("collectionId", "sortOrder");
CREATE UNIQUE INDEX "collection_fields_collectionId_fieldKey_key"
  ON "collection_fields"("collectionId", "fieldKey");

CREATE TABLE "collection_records" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "collection_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "collection_records_collectionId_createdAt_idx"
  ON "collection_records"("collectionId", "createdAt");
CREATE INDEX "collection_records_collectionId_archivedAt_idx"
  ON "collection_records"("collectionId", "archivedAt");

CREATE TABLE "_libriant_schema_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "schemaMajor" INTEGER NOT NULL DEFAULT 1,
    "onlinePending" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "_libriant_schema_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "_libriant_online_migrations" (
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "rowsDone" BIGINT NOT NULL DEFAULT 0,
    "lastError" TEXT,
    CONSTRAINT "_libriant_online_migrations_pkey" PRIMARY KEY ("name")
);
CREATE INDEX "_libriant_online_migrations_finishedAt_idx"
  ON "_libriant_online_migrations"("finishedAt");

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_role_grants" ADD CONSTRAINT "staff_role_grants_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "collection_fields" ADD CONSTRAINT "collection_fields_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "collection_records" ADD CONSTRAINT "collection_records_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. What the upgrade could not carry
-- ---------------------------------------------------------------------------

CREATE TYPE "upgrade_exception_kind" AS ENUM (
  -- A value with real content and no 2.0 column. It is recorded rather than
  -- dropped so a library can be told what it lost, in the specific.
  'no_target',
  -- A value 2.0 has a home for and this row could not satisfy — an ISBN that
  -- fails its check digit, a language code outside ISO 639-2/B.
  'invalid_source',
  -- A shape 2.0 refuses: a zero-amount fine, a hold on a book that is gone.
  'refused_by_target'
);

CREATE TABLE "upgrade_exceptions" (
  "id" text NOT NULL,
  "kind" "upgrade_exception_kind" NOT NULL,
  "source_table" text NOT NULL,
  "source_id" text NOT NULL,
  "source_column" text,
  -- The value itself, so the record is a record and not a count.
  "value" jsonb,
  "note" text NOT NULL,
  "recorded_at" timestamptz(3) NOT NULL,
  CONSTRAINT "upgrade_exceptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "upgrade_exceptions_note_is_a_sentence" CHECK (pg_catalog.length("note") >= 20)
);
CREATE INDEX "upgrade_exceptions_source_idx" ON "upgrade_exceptions" ("source_table", "kind");

CREATE TABLE "upgrade_dropped_rows" (
  "id" text NOT NULL,
  "source_table" text NOT NULL,
  "source_id" text NOT NULL,
  "reason" text NOT NULL,
  -- The whole row, so a library that disputes a drop can be shown it.
  "row" jsonb NOT NULL,
  "recorded_at" timestamptz(3) NOT NULL,
  CONSTRAINT "upgrade_dropped_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "upgrade_dropped_rows_reason_is_a_sentence" CHECK (pg_catalog.length("reason") >= 20)
);
CREATE INDEX "upgrade_dropped_rows_source_idx" ON "upgrade_dropped_rows" ("source_table");

COMMIT;
