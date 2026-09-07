-- Libriant 2.0 — the baseline.
--
-- Creates the 2.0 tenant schema in its own Postgres namespace, beside the 1.0
-- one, cutting nothing over. Sixteen tables of the 184 that §3 of the master
-- architecture names; `prisma/schema-v2/BASELINE-SCOPE.json` names all 184 with
-- a status each, and `pnpm check:schema-conventions` fails if this migration and
-- that manifest ever disagree in either direction.
--
-- ============================================================================
-- THE BEGIN/COMMIT IS NOT DECORATION. READ THIS BEFORE REMOVING IT.
-- ============================================================================
--
-- Eight migrations in this repository, `scripts/_lib/online-track.ts`,
-- `scripts/check-migration-safety.ts` and `.github/workflows/verify.yml` all
-- state that `prisma migrate deploy` wraps each migration file in a
-- transaction. Measured on Prisma 7.9.1 against Postgres 16.15, IT DOES NOT:
--
--     migration.sql:  CREATE TABLE probe_tx_two (...);  SELECT 1/0;
--     result:         Error: P3018 ... Database error code: 22012
--     afterwards:     probe_tx_two STILL EXISTS, and _prisma_migrations holds
--                     20260101000001_b | applied_steps_count 0 | finished_at NULL
--
-- That trailing row is a poison pill: every later `migrate deploy` against that
-- tenant refuses until somebody runs `prisma migrate resolve` by hand. For a
-- fleet rollout of a sixteen-table baseline the difference is between "a failed
-- baseline is a no-op" and "a failed baseline leaves a half-built database on an
-- unknown subset of libraries".
--
-- An explicit wrapper restores atomicity exactly. Same probe, with BEGIN/COMMIT
-- around it: the transaction aborts and NEITHER table survives. So this file
-- owns its own atomicity rather than inheriting an assumption that was asserted
-- nine times and never once tested. `tenant-schema-invariants.spec.ts` applies a
-- deliberately-broken copy of this migration and asserts zero of its tables
-- survive, so the wrapper cannot be removed silently.
--
-- ============================================================================
-- WHY THIS LIVES IN ITS OWN SCHEMA
-- ============================================================================
--
-- Nine physical table names collide with 1.0 — `loans` and `audit_log` among
-- them — and `loans` cannot be deferred, because phase 16 builds the 2.0
-- circulation engine on it and phase 16 precedes the phase-19/20 cutover.
--
-- `prisma migrate deploy` against `…?schema=lbr2` creates the schema, keeps its
-- `_prisma_migrations` inside it, and creates these tables there. The 1.0
-- `public` schema is not read, not written and not locked. Phase 20's cutover is
-- then `ALTER SCHEMA public RENAME TO v1_archive; ALTER SCHEMA lbr2 RENAME TO
-- public;` — the exact shape §10 already specifies for the rollback, measured to
-- leave every constraint below working.
--
-- Table names are deliberately UNQUALIFIED. They resolve through the
-- search_path Prisma sets from `?schema=`, which is what keeps this migration
-- relocatable and the phase-20 rename a rename rather than a rewrite.

BEGIN;

-- Extension objects live in `public` and are reached from here. Rather than
-- hardcoding either schema name, keep whichever one `?schema=` put us in and
-- append `public`, so this is still correct after the phase-20 rename.
SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
--
-- WITH SCHEMA public, explicitly. Without it these would be created in `lbr2`
-- (the session's first search_path entry), and the phase-20 rename would carry
-- them somewhere no unqualified reference expects. `IF NOT EXISTS` because
-- `tenant-create.ts` and `TenantProvisioningService` already create four of the
-- six before any migration runs; both were extended with these two, and
-- `tenant-schema-census.spec.ts` provisions a tenant through the real service to
-- catch the two lists disagreeing.
--
-- btree_gist is what makes `EXCLUDE USING gist (x WITH =, range WITH &&)`
-- possible on a scalar-plus-range key, which is how a double-booked room and an
-- overlapping calendar exception become IMPOSSIBLE rather than unlikely. It is
-- installed here, in the phase that creates none of those tables, because
-- installing an extension is the part that needs a superuser and it must not
-- have to happen again on a live fleet.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- record_version_seq
-- ---------------------------------------------------------------------------
--
-- ONE sequence shared by `marc_records.row_version` and
-- `change_events.row_version`, so a device replica can order a catalogue change
-- against a circulation change without a clock. Two sequences would produce two
-- unrelated orderings and the offline reconciler could not merge them.
--
-- Created before the tables, because their DEFAULTs name it. `nextval` resolves
-- the sequence to an OID at DDL time, so the unqualified name in those DEFAULTs
-- is fixed at creation and survives any later search_path change.
CREATE SEQUENCE record_version_seq AS bigint START WITH 1 INCREMENT BY 1;

-- CreateEnum
CREATE TYPE "marc_record_kind" AS ENUM ('bibliographic', 'authority', 'holdings', 'classification');

-- CreateEnum
CREATE TYPE "marc_schema" AS ENUM ('marc21', 'unimarc');

-- CreateEnum
CREATE TYPE "marc_record_status" AS ENUM ('draft', 'in_process', 'complete', 'suppressed', 'deleted');

-- CreateEnum
CREATE TYPE "call_number_scheme" AS ENUM ('ddc', 'lcc', 'udc', 'nlm', 'alphanum', 'local');

-- CreateEnum
CREATE TYPE "loan_status" AS ENUM ('active', 'recalled', 'claims_returned', 'claims_never_borrowed', 'returned', 'lost');

-- CreateEnum
CREATE TYPE "audit_actor_kind" AS ENUM ('user', 'admin', 'system', 'device');

-- CreateEnum
CREATE TYPE "branch_kind" AS ENUM ('system', 'branch', 'bookmobile', 'storage', 'virtual');

-- CreateEnum
CREATE TYPE "item_status" AS ENUM ('available', 'on_loan', 'in_transit', 'awaiting_pickup', 'in_process', 'missing');

-- CreateEnum
CREATE TYPE "event_source" AS ENUM ('desk', 'opac', 'sip2', 'ncip', 'api', 'offline', 'kiosk');

-- CreateEnum
CREATE TYPE "fee_status" AS ENUM ('outstanding', 'paid', 'waived', 'written_off', 'cancelled');

-- CreateEnum
CREATE TYPE "marc_source_format" AS ENUM ('iso2709', 'marcxml', 'marc_json', 'manual');

-- CreateEnum
CREATE TYPE "marc_change_kind" AS ENUM ('create', 'edit', 'import', 'overlay', 'batch', 'merge', 'restore', 'delete');

-- CreateTable
CREATE TABLE "marc_records" (
    "id" TEXT NOT NULL,
    "public_no" BIGINT NOT NULL,
    "kind" "marc_record_kind" NOT NULL,
    "schema" "marc_schema" NOT NULL,
    "status" "marc_record_status" NOT NULL,
    "leader" CHAR(24) NOT NULL,
    "content_hash" BYTEA NOT NULL,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "row_version" BIGINT NOT NULL DEFAULT nextval('record_version_seq'::regclass),
    "record_status_code" CHAR(1) NOT NULL,
    "record_type_code" CHAR(1),
    "bib_level_code" CHAR(1),
    "encoding_level" CHAR(1),
    "charset_code" CHAR(1) NOT NULL DEFAULT 'a',
    "control_number" TEXT,
    "control_number_source" TEXT,
    "date_entered" CHAR(6),
    "merged_into_id" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" TEXT,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "marc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marc_record_contents" (
    "record_id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "source_format" "marc_source_format" NOT NULL,
    "source_encoding" TEXT,
    "source_normalization" TEXT,
    "source_blob" BYTEA,
    "source_blob_sha256" BYTEA,
    "source_roundtrips" BOOLEAN NOT NULL DEFAULT true,
    "anomalies" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marc_record_contents_pkey" PRIMARY KEY ("record_id")
);

-- CreateTable
CREATE TABLE "marc_record_versions" (
    "id" BIGSERIAL NOT NULL,
    "record_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "leader" CHAR(24) NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" BYTEA NOT NULL,
    "change_kind" "marc_change_kind" NOT NULL,
    "change_summary" TEXT,
    "changed_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "batch_job_id" TEXT,
    "actor_kind" "audit_actor_kind" NOT NULL,
    "actor_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marc_record_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iana_timezones" (
    "name" TEXT NOT NULL,

    CONSTRAINT "iana_timezones_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_i18n" JSONB NOT NULL DEFAULT '{}',
    "isil" TEXT,
    "marc_org_code" TEXT,
    "parent_branch_id" TEXT,
    "depth" SMALLINT NOT NULL DEFAULT 0,
    "kind" "branch_kind" NOT NULL DEFAULT 'branch',
    "timezone" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "default_locale" TEXT NOT NULL DEFAULT 'el',
    "calendar_id" TEXT,
    "address_street" TEXT,
    "address_city" TEXT,
    "address_postal_code" TEXT,
    "address_region" TEXT,
    "address_country" TEXT DEFAULT 'GR',
    "geo_lat" DECIMAL(9,6),
    "geo_lon" DECIMAL(9,6),
    "circulates" BOOLEAN NOT NULL DEFAULT true,
    "pickup_location" BOOLEAN NOT NULL DEFAULT true,
    "is_floating_member" BOOLEAN NOT NULL DEFAULT false,
    "opac_visible" BOOLEAN NOT NULL DEFAULT true,
    "staff_only" BOOLEAN NOT NULL DEFAULT false,
    "ill_supplier" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shelving_locations" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_i18n" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "shelving_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holdings_records" (
    "record_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "holdings_records_pkey" PRIMARY KEY ("record_id")
);

-- CreateTable
CREATE TABLE "item_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_i18n" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "item_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_i18n" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "material_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "holdings_record_id" TEXT NOT NULL,
    "bib_id" TEXT NOT NULL,
    "barcode" TEXT,
    "barcode_norm" TEXT,
    "item_type_id" TEXT NOT NULL,
    "temporary_item_type_id" TEXT,
    "material_type_id" TEXT,
    "owning_branch_id" TEXT NOT NULL,
    "current_branch_id" TEXT NOT NULL,
    "permanent_location_id" TEXT NOT NULL,
    "temporary_location_id" TEXT,
    "call_number_prefix" TEXT,
    "call_number_base" TEXT,
    "call_number_suffix" TEXT,
    "copy_number" TEXT,
    "call_number_sort" TEXT,
    "call_number_scheme" "call_number_scheme" NOT NULL DEFAULT 'ddc',
    "enumeration" TEXT,
    "chronology" TEXT,
    "status" "item_status" NOT NULL DEFAULT 'available',
    "status_since" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_reason_id" TEXT,
    "not_for_loan_code" TEXT,
    "damaged_code" TEXT,
    "lost_code" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "restricted_access" BOOLEAN NOT NULL DEFAULT false,
    "holdable" BOOLEAN NOT NULL DEFAULT true,
    "bookable" BOOLEAN NOT NULL DEFAULT false,
    "price_cents" BIGINT,
    "replacement_cost_cents" BIGINT,
    "acquired_at" DATE,
    "accession_number" TEXT,
    "public_note" TEXT,
    "staff_note" TEXT,
    "rfid_tag_uid" TEXT,
    "rfid_afi" SMALLINT,
    "rfid_written_at" TIMESTAMPTZ(3),
    "inventoried_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "last_seen_at_branch_id" TEXT,
    "checkout_count" INTEGER NOT NULL DEFAULT 0,
    "renewal_count" INTEGER NOT NULL DEFAULT 0,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patrons" (
    "id" TEXT NOT NULL,
    "patron_number" TEXT,
    "patron_category_id" TEXT,
    "home_branch_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "patrons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "patron_id" TEXT,
    "anonymised_at" TIMESTAMPTZ(3),
    "proxy_patron_id" TEXT,
    "bib_id" TEXT NOT NULL,
    "checkout_branch_id" TEXT NOT NULL,
    "checkout_service_point_id" TEXT,
    "checked_out_by_user_id" TEXT,
    "loaned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "original_due_at" TIMESTAMPTZ(3) NOT NULL,
    "grace_period_ends_at" TIMESTAMPTZ(3),
    "returned_at" TIMESTAMPTZ(3),
    "return_branch_id" TEXT,
    "returned_by_user_id" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "status" "loan_status" NOT NULL DEFAULT 'active',
    "renewal_count" INTEGER NOT NULL DEFAULT 0,
    "auto_renew_count" INTEGER NOT NULL DEFAULT 0,
    "auto_renew_fail_reason" TEXT,
    "recalled_at" TIMESTAMPTZ(3),
    "recall_due_at" TIMESTAMPTZ(3),
    "recalled_by_hold_id" TEXT,
    "declared_lost_at" TIMESTAMPTZ(3),
    "claimed_returned_at" TIMESTAMPTZ(3),
    "loan_policy_id" TEXT NOT NULL,
    "overdue_fine_policy_id" TEXT NOT NULL,
    "lost_item_fee_policy_id" TEXT NOT NULL,
    "applied_rule_id" TEXT NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "item_type_id_applied" TEXT NOT NULL,
    "patron_category_id_applied" TEXT NOT NULL,
    "patron_category_code" TEXT,
    "patron_age_band" TEXT,
    "patron_home_branch_id" TEXT,
    "source" "event_source" NOT NULL DEFAULT 'desk',
    "device_id" TEXT,
    "client_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fees" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "patron_id" TEXT NOT NULL,
    "fee_type_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "loan_id" TEXT,
    "item_id" TEXT,
    "hold_id" TEXT,
    "booking_id" TEXT,
    "branch_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "tax_cents" BIGINT NOT NULL DEFAULT 0,
    "paid_cents" BIGINT NOT NULL DEFAULT 0,
    "waived_cents" BIGINT NOT NULL DEFAULT 0,
    "written_off_cents" BIGINT NOT NULL DEFAULT 0,
    "status" "fee_status" NOT NULL DEFAULT 'outstanding',
    "is_accruing" BOOLEAN NOT NULL DEFAULT false,
    "accrual_policy" JSONB,
    "accrued_through" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_events" (
    "seq" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entity_kind" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "branch_id" TEXT,
    "row_version" BIGINT NOT NULL,
    "payload" JSONB,
    "actor_kind" "audit_actor_kind" NOT NULL,
    "actor_id" TEXT,
    "device_id" TEXT,
    "client_change_id" UUID,
    "commit_xmin" xid8,

    CONSTRAINT "change_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "change_consumers" (
    "consumer" TEXT NOT NULL,
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_consumers_pkey" PRIMARY KEY ("consumer")
);

-- CreateTable
CREATE TABLE "sync_client_changes" (
    "device_id" TEXT NOT NULL,
    "client_change_id" UUID NOT NULL,
    "device_seq" BIGINT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_json" JSONB NOT NULL,
    "server_event_seq" BIGINT,
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_client_changes_pkey" PRIMARY KEY ("device_id","client_change_id")
);


-- ---------------------------------------------------------------------------
-- audit_log — partitioned monthly
-- ---------------------------------------------------------------------------
--
-- The composite primary key is FORCED, not chosen:
--
--     CREATE TABLE audit_p (id text PRIMARY KEY, occurred_at timestamptz(3))
--       PARTITION BY RANGE (occurred_at);
--     ERROR:  0A000: unique constraint on partitioned table must include all
--             partitioning columns
--     DETAIL: PRIMARY KEY constraint on table "audit_p" lacks column "occurred_at"
--
-- So a lookup by id alone scans every partition. That is the price, and it is
-- worth paying: the audit log is the one table that grows without bound, it is
-- almost always read by time window, and DROP PARTITION is the only retention
-- mechanism that does not spend hours in DELETE holding locks.
CREATE TABLE "audit_log" (
"id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" "audit_actor_kind" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_kind" TEXT NOT NULL,
    "entity_id" TEXT,
    "branch_id" TEXT,
    "summary" TEXT,
    "detail" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "device_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- Partitions for a window around provisioning: three months back, twenty-four
-- forward. Relative to now() rather than hardcoded dates, so a tenant created in
-- 2029 gets a usable window instead of one that expired before it existed.
--
-- No DEFAULT partition, deliberately. A missing future partition makes the
-- INSERT fail with 23514, which is loud and fixable; a DEFAULT partition
-- silently swallows those rows into a heap that can never be partitioned
-- afterwards without rewriting it. Phase 16 owns the job that rolls the window
-- forward, and its alert is what stops the loud failure ever happening.
DO $partitions$
DECLARE
  m date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC')::date
            - INTERVAL '3 months';
  i integer;
BEGIN
  FOR i IN 0..26 LOOP
    EXECUTE pg_catalog.format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      'audit_log_' || pg_catalog.to_char(m, 'YYYY_MM'),
      m,
      m + INTERVAL '1 month'
    );
    m := (m + INTERVAL '1 month')::date;
  END LOOP;
END;
$partitions$;

-- CreateIndex
CREATE INDEX "marc_records_kind_status_updated_at_id_idx" ON "marc_records"("kind", "status", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "marc_records_type_idx" ON "marc_records"("kind", "record_type_code", "bib_level_code");

-- CreateIndex
CREATE INDEX "marc_records_row_version_idx" ON "marc_records"("row_version");

-- CreateIndex
CREATE INDEX "marc_record_versions_desc_idx" ON "marc_record_versions"("record_id", "version" DESC);

-- CreateIndex
CREATE INDEX "marc_record_versions_sweep_idx" ON "marc_record_versions"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "marc_record_versions_key" ON "marc_record_versions"("record_id", "version");

-- CreateIndex
CREATE INDEX "branches_parent_branch_id_idx" ON "branches"("parent_branch_id");

-- CreateIndex
CREATE INDEX "shelving_locations_branch_id_idx" ON "shelving_locations"("branch_id");

-- CreateIndex
CREATE INDEX "holdings_records_branch_id_idx" ON "holdings_records"("branch_id");

-- CreateIndex
CREATE INDEX "items_shelf_order_idx" ON "items"("current_branch_id", "call_number_sort", "id");

-- CreateIndex
CREATE INDEX "items_holdings_record_id_idx" ON "items"("holdings_record_id");

-- CreateIndex
CREATE INDEX "items_item_type_id_idx" ON "items"("item_type_id");

-- CreateIndex
CREATE INDEX "patrons_patron_category_id_idx" ON "patrons"("patron_category_id");

-- CreateIndex
CREATE INDEX "loans_status_due_id_idx" ON "loans"("status", "due_at", "id");

-- CreateIndex
CREATE INDEX "loans_bib_id_idx" ON "loans"("bib_id");

-- CreateIndex
CREATE INDEX "fees_patron_id_status_idx" ON "fees"("patron_id", "status");

-- CreateIndex
CREATE INDEX "fees_loan_id_idx" ON "fees"("loan_id");

-- CreateIndex
CREATE INDEX "change_events_kind_seq_idx" ON "change_events"("entity_kind", "seq");

-- CreateIndex
CREATE INDEX "change_events_branch_seq_idx" ON "change_events"("branch_id", "seq");

-- CreateIndex
CREATE INDEX "sync_client_changes_applied_idx" ON "sync_client_changes"("applied_at");

-- CreateIndex
CREATE INDEX "audit_log_occurred_idx" ON "audit_log"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entity_idx" ON "audit_log"("entity_kind", "entity_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "marc_records" ADD CONSTRAINT "marc_records_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "marc_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marc_record_contents" ADD CONSTRAINT "marc_record_contents_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "marc_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marc_record_versions" ADD CONSTRAINT "marc_record_versions_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "marc_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_timezone_fkey" FOREIGN KEY ("timezone") REFERENCES "iana_timezones"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_parent_branch_id_fkey" FOREIGN KEY ("parent_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shelving_locations" ADD CONSTRAINT "shelving_locations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_holdings_record_id_fkey" FOREIGN KEY ("holdings_record_id") REFERENCES "holdings_records"("record_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_bib_id_fkey" FOREIGN KEY ("bib_id") REFERENCES "marc_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_item_type_id_fkey" FOREIGN KEY ("item_type_id") REFERENCES "item_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_temporary_item_type_id_fkey" FOREIGN KEY ("temporary_item_type_id") REFERENCES "item_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_material_type_id_fkey" FOREIGN KEY ("material_type_id") REFERENCES "material_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_owning_branch_id_fkey" FOREIGN KEY ("owning_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_current_branch_id_fkey" FOREIGN KEY ("current_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_permanent_location_id_fkey" FOREIGN KEY ("permanent_location_id") REFERENCES "shelving_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_temporary_location_id_fkey" FOREIGN KEY ("temporary_location_id") REFERENCES "shelving_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_patron_id_fkey" FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Generated columns
-- ---------------------------------------------------------------------------
--
-- Prisma has no generated-column concept, so these live here and are
-- allowlisted in `check:schema-drift` as objects the datamodel cannot express.
--
-- `is_shelf_available` is generated rather than written as a
-- `WHERE status = 'available'` index predicate for a measured reason this repo
-- has already paid for once: Prisma emits `status = CAST($1::text AS
-- item_status)` and `enum_in` is only STABLE, so the planner can never prove an
-- enum-predicate partial index matches a query. That is exactly why
-- `loans_active_dueAt_idx` had to be dropped in 1.0. A boolean the planner CAN
-- reason about is the fix, and folding the four exclusion codes into it means
-- "on the shelf right now" has one definition instead of five.
ALTER TABLE items ADD COLUMN is_shelf_available boolean
  GENERATED ALWAYS AS (
    status = 'available'::item_status
    AND not_for_loan_code IS NULL
    AND damaged_code IS NULL
    AND lost_code IS NULL
    AND withdrawn_at IS NULL
    AND archived_at IS NULL
  ) STORED;

-- A balance two code paths compute differently is the most damaging bug class
-- in a fee ledger. Generated, so they cannot.
ALTER TABLE fees ADD COLUMN outstanding_cents bigint
  GENERATED ALWAYS AS (
    amount_cents + tax_cents - paid_cents - waived_cents - written_off_cents
  ) STORED;

-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------

ALTER TABLE marc_records
  ADD CONSTRAINT marc_leader_len CHECK (pg_catalog.length(leader) = 24),
  ADD CONSTRAINT marc_hash_len   CHECK (pg_catalog.octet_length(content_hash) = 32);

ALTER TABLE branches
  ADD CONSTRAINT branches_no_self_parent CHECK (parent_branch_id <> id);

ALTER TABLE items
  ADD CONSTRAINT items_price_non_negative
    CHECK (price_cents IS NULL OR price_cents >= 0),
  ADD CONSTRAINT items_replacement_cost_non_negative
    CHECK (replacement_cost_cents IS NULL OR replacement_cost_cents >= 0);

ALTER TABLE loans
  ADD CONSTRAINT loans_due_after_loaned CHECK (due_at > loaned_at),
  ADD CONSTRAINT loans_renewal_count_non_negative CHECK (renewal_count >= 0),
  -- The open set and the closed set, stated once. Without this a `lost` loan
  -- could keep closed_at NULL and pin its copy out of circulation forever, which
  -- is the 1.0 dead end this schema exists to fix.
  ADD CONSTRAINT loans_closed_consistency CHECK (
    (closed_at IS NULL) =
    (status IN ('active', 'claims_returned', 'claims_never_borrowed', 'recalled'))
  );

ALTER TABLE fees
  ADD CONSTRAINT fees_amount_positive CHECK (amount_cents > 0),
  ADD CONSTRAINT fees_tax_non_negative CHECK (tax_cents >= 0),
  -- A patron cannot be credited more than they were charged, whatever
  -- combination of payment, waiver and write-off gets there.
  ADD CONSTRAINT fees_settlement_within_charge CHECK (
    paid_cents + waived_cents + written_off_cents <= amount_cents + tax_cents
  );

ALTER TABLE change_events
  ADD CONSTRAINT change_events_op_known
    CHECK (op IN ('insert', 'update', 'delete', 'archive', 'restore'));

-- ---------------------------------------------------------------------------
-- Unique and partial indexes
-- ---------------------------------------------------------------------------
--
-- Every uniqueness rule that has to hold only among LIVE rows is written
-- `WHERE archived_at IS NULL`, per §3. Without the predicate, archiving a branch
-- would permanently reserve its code and a library could never reuse the name of
-- a reading room it closed.

CREATE UNIQUE INDEX marc_records_public_no_key ON marc_records (public_no);

CREATE UNIQUE INDEX marc_records_control_number_unique_active
  ON marc_records (kind, control_number)
  WHERE control_number IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX marc_records_merged_idx ON marc_records (merged_into_id)
  WHERE merged_into_id IS NOT NULL;
CREATE INDEX marc_records_deleted_idx ON marc_records (deleted_at)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX marc_record_versions_batch_idx ON marc_record_versions (batch_job_id)
  WHERE batch_job_id IS NOT NULL;

CREATE UNIQUE INDEX branches_code_unique_active ON branches (code)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX branches_isil_unique_active ON branches (isil)
  WHERE isil IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX shelving_locations_code_unique_active
  ON shelving_locations (branch_id, code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX item_types_code_unique_active
  ON item_types (code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX material_types_code_unique_active
  ON material_types (code) WHERE archived_at IS NULL;

-- On barcode_norm, not barcode: two copies must not differ only by case or by a
-- Greek accent, which `@libriant/shared/greek` folds away.
CREATE UNIQUE INDEX items_barcode_unique_active ON items (barcode_norm)
  WHERE barcode_norm IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX items_rfid_uid_unique ON items (rfid_tag_uid)
  WHERE rfid_tag_uid IS NOT NULL AND archived_at IS NULL;
-- The generated boolean, used as a predicate. See the note on the column.
CREATE INDEX items_shelf_available_idx ON items (bib_id, current_branch_id)
  WHERE is_shelf_available;

CREATE UNIQUE INDEX patrons_number_unique_active ON patrons (patron_number)
  WHERE patron_number IS NOT NULL AND archived_at IS NULL;

-- ONE open loan per copy. `closed_at`, not `returned_at` — see the model
-- docblock for the lost-then-found dead end that distinction fixes.
CREATE UNIQUE INDEX loans_one_open_per_item ON loans (item_id)
  WHERE closed_at IS NULL;
CREATE INDEX loans_patron_open_idx ON loans (patron_id) WHERE closed_at IS NULL;

-- Preserves the 1.0 `INSERT … ON CONFLICT … DO UPDATE` accrual upsert verbatim
-- (DATA-1): a return racing the nightly sweep updates the open accrual instead
-- of aborting the librarian's transaction.
CREATE UNIQUE INDEX fees_one_open_accrual_per_loan ON fees (loan_id)
  WHERE loan_id IS NOT NULL AND is_accruing AND closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- iana_timezones — the seed that makes `branches.timezone` checkable
-- ---------------------------------------------------------------------------
--
-- The acceptance criterion is "a non-IANA timezone is rejected". All three ways
-- of saying that were measured on Postgres 16.15:
--
--   CHECK (tz IN (SELECT name FROM pg_catalog.pg_timezone_names))
--     -> ERROR: 0A000: cannot use subquery in check constraint
--
--   CHECK (an IMMUTABLE wrapper over pg_timezone_names)
--     -> works, and costs 11.1 ms PER ROW: 10,000 inserts took 111 seconds
--        against 4.6 ms with no constraint. pg_timezone_names is a
--        set-returning function that walks the tzdata tree on every call, and
--        marking a wrapper over it IMMUTABLE is false besides — tzdata changes.
--
--   FOREIGN KEY to this table
--     -> 8.2 µs per row, about 1,350x faster, raising a plain 23503.
--
-- MINUS ('Factory','posixrules'), and both exclusions earn their place. They are
-- the only two of the 181 names Postgres knows and
-- `Intl.supportedValuesOf('timeZone')` does not list that `Intl.DateTimeFormat`
-- also refuses — the other 179 are IANA backward links the runtime
-- canonicalises — so excluding them makes this table a strict subset of what the
-- application layer can format with, which is the safe direction. And
-- `posixrules` is the single row on which the two Postgres 16.15 builds on the
-- development machine disagree (599 vs 598), so excluding it makes a seeded
-- tenant identical on both and removes the pg_restore hazard where a COPY
-- re-validates the foreign key against newer tzdata.
--
-- The check has to be in the DATABASE and not only in TypeScript, because phase
-- 19's copy-forward is PL/pgSQL and writes `branches` without going through the
-- application at all.
--
-- A fixed offset like '+02:00' is refused too, and that is the point rather than
-- a side effect: an offset has no DST, and fine accrual against one is the
-- circ-5 bug in a new costume.
INSERT INTO iana_timezones (name)
SELECT name FROM pg_catalog.pg_timezone_names
WHERE name NOT IN ('Factory', 'posixrules')
ON CONFLICT (name) DO NOTHING;

DO $tzcheck$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM iana_timezones) < 300 THEN
    RAISE EXCEPTION
      'iana_timezones seeded only % row(s); this Postgres build has no usable tzdata, and '
      'every branch insert would fail on the timezone foreign key',
      (SELECT pg_catalog.count(*) FROM iana_timezones)
      USING ERRCODE = '23514';
  END IF;
END;
$tzcheck$;

-- ---------------------------------------------------------------------------
-- branches_guard_cycle — the cycle trigger, and the three things §3 leaves open
-- ---------------------------------------------------------------------------
--
-- §3 gives this one comment line: "Cycles cannot be a CHECK: branches_guard_cycle()
-- walks parents (max 16 hops) and maintains depth." Three things it does not say
-- are decided here, explicitly, because an implementer who skips any of them
-- ships something that looks right:
--
--   1. WHAT HAPPENS AT THE LIMIT. It raises, with SQLSTATE 23514. A custom class
--      would be more precise, but 23514 is already handled as a constraint
--      violation everywhere in this codebase, so a cycle surfaces to a librarian
--      as a refused save rather than a 500.
--   2. WHETHER DESCENDANTS ARE RECOMPUTED WHEN A PARENT MOVES. They are — this
--      is the case that gets skipped. Re-parenting a branch that has children
--      leaves every child's `depth` stale otherwise, and `depth` exists
--      precisely so a picker does not have to run a recursive CTE.
--   3. WHEN IT FIRES. Depth on every write (it is cheap and it cannot then drift);
--      the descendant recompute only on an actual change of parent.
CREATE OR REPLACE FUNCTION branches_guard_cycle() RETURNS trigger
  LANGUAGE plpgsql AS $branches_guard_cycle$
DECLARE
  v_parent text := NEW.parent_branch_id;
  v_depth  integer := 0;
  v_hops   integer := 0;
BEGIN
  WHILE v_parent IS NOT NULL LOOP
    v_hops := v_hops + 1;
    IF v_hops > 16 THEN
      RAISE EXCEPTION
        'branch hierarchy from % exceeds 16 levels, or contains a cycle', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF v_parent = NEW.id THEN
      RAISE EXCEPTION 'branch % cannot be its own ancestor', NEW.id
        USING ERRCODE = '23514';
    END IF;
    SELECT b.parent_branch_id INTO v_parent FROM branches b WHERE b.id = v_parent;
    v_depth := v_depth + 1;
  END LOOP;

  NEW.depth := v_depth;
  RETURN NEW;
END;
$branches_guard_cycle$;

CREATE TRIGGER branches_guard_cycle
  BEFORE INSERT OR UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION branches_guard_cycle();

-- Decision 2 above. Only rows whose depth actually differs are written, so the
-- BEFORE trigger this fires on each descendant recomputes the same value and the
-- second pass updates nothing — it converges rather than recursing.
CREATE OR REPLACE FUNCTION branches_recompute_descendant_depth() RETURNS trigger
  LANGUAGE plpgsql AS $branches_depth$
BEGIN
  WITH RECURSIVE tree AS (
    SELECT b.id, NEW.depth + 1 AS d
      FROM branches b WHERE b.parent_branch_id = NEW.id
    UNION ALL
    SELECT b.id, t.d + 1
      FROM branches b JOIN tree t ON b.parent_branch_id = t.id
  )
  UPDATE branches b SET depth = t.d
    FROM tree t WHERE b.id = t.id AND b.depth <> t.d;
  RETURN NULL;
END;
$branches_depth$;

CREATE TRIGGER branches_recompute_descendant_depth
  AFTER UPDATE OF parent_branch_id ON branches
  FOR EACH ROW WHEN (OLD.parent_branch_id IS DISTINCT FROM NEW.parent_branch_id)
  EXECUTE FUNCTION branches_recompute_descendant_depth();

-- ---------------------------------------------------------------------------
-- The changelog triggers
-- ---------------------------------------------------------------------------
--
-- GENERATED by `node scripts/gen-changelog-triggers.mjs` from the
-- `/// @replicated entity_kind=…` markers in `prisma/schema-v2/`, and COMMITTED
-- here. `pnpm check:changelog-coverage` compares those markers against THIS
-- TEXT, in both directions — never against the generator's output, which would
-- be comparing a function to its own input and could not fail for any reason.
--
-- Nine tables, not sixteen. `change_events` itself, `audit_log`,
-- `marc_record_versions` and `sync_client_changes` are append-only or are the
-- feed, so replicating them would be either a loop or a duplicate.
-- `marc_record_contents` is 1:1 with `marc_records` and every content write
-- bumps the parent's `row_version` in the same transaction, so one event per
-- edit is right and two would make every consumer process the record twice.
-- `iana_timezones` is a static lookup. `fees` is excluded for a reason recorded
-- on the model.
--
-- To change the set: edit the marker on the model, re-run the generator, and
-- write a NEW migration. Editing this block by hand is what the gate catches.

CREATE OR REPLACE FUNCTION lbr2_write_change_event() RETURNS trigger
  LANGUAGE plpgsql AS $lbr2_changelog$
DECLARE
  v_entity_kind  text := TG_ARGV[0];
  v_pk_column    text := TG_ARGV[1];
  v_has_branch   boolean := TG_ARGV[2]::boolean;
  v_row          jsonb;
  v_op           text;
  v_entity_id    text;
  v_branch_id    text;
  v_payload      jsonb;
  v_archived_col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := pg_catalog.to_jsonb(OLD);
    v_op := 'delete';
    v_payload := NULL;
  ELSE
    v_row := pg_catalog.to_jsonb(NEW);
    v_payload := v_row;
    IF TG_OP = 'INSERT' THEN
      v_op := 'insert';
    ELSE
      v_op := 'update';
      -- A soft delete is a disappearance, not an edit. marc_records spells it
      -- deleted_at; everything else spells it archived_at.
      v_archived_col := CASE WHEN v_row ? 'deleted_at' THEN 'deleted_at' ELSE 'archived_at' END;
      IF v_row ? v_archived_col THEN
        IF pg_catalog.to_jsonb(OLD) ->> v_archived_col IS NULL
           AND v_row ->> v_archived_col IS NOT NULL THEN
          v_op := 'archive';
        ELSIF pg_catalog.to_jsonb(OLD) ->> v_archived_col IS NOT NULL
           AND v_row ->> v_archived_col IS NULL THEN
          v_op := 'restore';
        END IF;
      END IF;
    END IF;
  END IF;

  v_entity_id := v_row ->> v_pk_column;
  IF v_has_branch THEN
    v_branch_id := v_row ->> 'branch_id';
  END IF;

  INSERT INTO change_events (
    entity_kind, entity_id, op, branch_id, row_version, payload,
    actor_kind, actor_id, device_id
  ) VALUES (
    v_entity_kind,
    v_entity_id,
    v_op,
    v_branch_id,
    pg_catalog.nextval('record_version_seq'),
    v_payload,
    COALESCE(
      pg_catalog.current_setting('libriant.actor_kind', true),
      'system'
    )::audit_actor_kind,
    pg_catalog.current_setting('libriant.actor_id', true),
    pg_catalog.current_setting('libriant.device_id', true)
  );

  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$lbr2_changelog$;

CREATE TRIGGER branches_changelog
  AFTER INSERT OR UPDATE OR DELETE ON branches
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('branch', 'id', false);

CREATE TRIGGER holdings_records_changelog
  AFTER INSERT OR UPDATE OR DELETE ON holdings_records
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('holdings_record', 'record_id', true);

CREATE TRIGGER item_types_changelog
  AFTER INSERT OR UPDATE OR DELETE ON item_types
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('item_type', 'id', false);

CREATE TRIGGER items_changelog
  AFTER INSERT OR UPDATE OR DELETE ON items
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('item', 'id', false);

CREATE TRIGGER loans_changelog
  AFTER INSERT OR UPDATE OR DELETE ON loans
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('loan', 'id', false);

CREATE TRIGGER marc_records_changelog
  AFTER INSERT OR UPDATE OR DELETE ON marc_records
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('marc_record', 'id', false);

CREATE TRIGGER material_types_changelog
  AFTER INSERT OR UPDATE OR DELETE ON material_types
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('material_type', 'id', false);

CREATE TRIGGER patrons_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patrons
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron', 'id', false);

CREATE TRIGGER shelving_locations_changelog
  AFTER INSERT OR UPDATE OR DELETE ON shelving_locations
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('shelving_location', 'id', true);

-- ---------------------------------------------------------------------------
-- TOAST compression
-- ---------------------------------------------------------------------------
--
-- The database-level GUC is set because it is the right default for everything
-- added later, and it is transaction-safe. But it is NOT an assertable property
-- of any stored byte — measured: with database-level lz4 in force, a session
-- that does `SET default_toast_compression='pglz'` writes a pglz row and
-- `pg_attribute.attcompression` stays empty (follow-the-GUC). pgbouncer, a psql
-- session, a maintenance script or a future ALTER ROLE all override it
-- invisibly.
--
-- So the columns that actually matter get an explicit per-column setting, which
-- is durable, is recorded in `pg_attribute.attcompression = 'l'`, and is what
-- `tenant-schema-census.spec.ts` asserts. A version store that silently halves
-- its compression ratio is not something anyone notices until the disk does.
--
-- Note for phase 19: SET COMPRESSION does not rewrite existing rows, so it has
-- to be in place BEFORE the bulk copy-forward, not after.
DO $lz4$
BEGIN
  IF NOT EXISTS (
    -- enumvals is already text[]; casting it to text first yields the literal
    -- '{pglz,lz4}' and the match silently never fires, which is how a guard
    -- becomes a guard against nothing.
    SELECT 1 FROM pg_catalog.pg_settings
    WHERE name = 'default_toast_compression'
      AND 'lz4' = ANY (enumvals)
  ) THEN
    RAISE EXCEPTION
      'this Postgres build has no lz4 TOAST compression, so the MARC version store '
      'would fall back to pglz at roughly half the ratio'
      USING ERRCODE = '0A000';
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER DATABASE %I SET default_toast_compression = %L',
    pg_catalog.current_database(), 'lz4'
  );
END;
$lz4$;

ALTER TABLE marc_record_contents ALTER COLUMN content SET COMPRESSION lz4;
ALTER TABLE marc_record_contents ALTER COLUMN anomalies SET COMPRESSION lz4;
ALTER TABLE marc_record_versions ALTER COLUMN content SET COMPRESSION lz4;
ALTER TABLE change_events ALTER COLUMN payload SET COMPRESSION lz4;
ALTER TABLE loans ALTER COLUMN policy_snapshot SET COMPRESSION lz4;
ALTER TABLE sync_client_changes ALTER COLUMN response_json SET COMPRESSION lz4;

-- ---------------------------------------------------------------------------
--
-- `_libriant_schema_state.schemaMajor` is deliberately NOT set to 2 here.
--
-- It records which schema generation a database IS, and after this migration a
-- tenant is still a 1.0 database that happens to have an empty 2.0 schema beside
-- it. `scripts/tenant-migrate.ts --plan` and the control-plane cache both key
-- off that flag, so setting it now would tell every tool the cutover had
-- happened. Phase 20 sets it, in the transaction that actually performs the
-- cutover. Until then, the existence of the `lbr2` schema and its own
-- `_prisma_migrations` is the record that this ran.

COMMIT;
