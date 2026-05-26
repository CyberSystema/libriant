-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateEnum
CREATE TYPE "BookCopyStatus" AS ENUM ('available', 'on_loan', 'reserved', 'lost', 'damaged', 'withdrawn');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('active', 'suspended', 'archived');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('active', 'returned', 'lost');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('queued', 'ready', 'fulfilled', 'expired', 'canceled');

-- CreateEnum
CREATE TYPE "FineStatus" AS ENUM ('outstanding', 'paid', 'waived');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'admin', 'system');

-- CreateEnum
CREATE TYPE "FieldEntityKind" AS ENUM ('book', 'book_copy', 'member', 'loan', 'reservation', 'fine');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('short_text', 'long_text', 'number', 'boolean', 'date', 'datetime', 'select_one', 'select_many', 'url', 'email');

-- CreateTable
CREATE TABLE "tenant_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "loanPeriodDays" INTEGER NOT NULL DEFAULT 14,
    "maxRenewals" INTEGER NOT NULL DEFAULT 2,
    "finePerDayCents" INTEGER NOT NULL DEFAULT 0,
    "fineCapCents" INTEGER NOT NULL DEFAULT 0,
    "holdPickupHours" INTEGER NOT NULL DEFAULT 48,
    "maxActiveLoans" INTEGER NOT NULL DEFAULT 0,
    "defaultLocale" TEXT NOT NULL DEFAULT 'el',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authors" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "sortName" TEXT NOT NULL,
    "isOrganization" BOOLEAN NOT NULL DEFAULT false,
    "birthYear" INTEGER,
    "deathYear" INTEGER,
    "notes" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "authors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "sortTitle" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "isbn13" TEXT,
    "isbn10" TEXT,
    "publisher" TEXT,
    "publicationYear" INTEGER,
    "language" TEXT,
    "edition" TEXT,
    "numPages" INTEGER,
    "description" TEXT,
    "coverAssetRef" TEXT,
    "classification" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_authors" (
    "bookId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT,

    CONSTRAINT "book_authors_pkey" PRIMARY KEY ("bookId","authorId")
);

-- CreateTable
CREATE TABLE "book_copies" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "status" "BookCopyStatus" NOT NULL DEFAULT 'available',
    "shelfLocation" TEXT,
    "conditionNotes" TEXT,
    "acquiredAt" TIMESTAMP(3),
    "priceCents" INTEGER,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "book_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "memberNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "sortName" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "email" CITEXT,
    "phone" TEXT,
    "dateOfBirth" DATE,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "photoAssetRef" TEXT,
    "status" "MemberStatus" NOT NULL DEFAULT 'active',
    "staffNotes" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "loanedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "returnedAt" TIMESTAMP(3),
    "renewedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "LoanStatus" NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "checkedOutByUserId" TEXT,
    "returnedByUserId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuePosition" INTEGER,
    "status" "ReservationStatus" NOT NULL DEFAULT 'queued',
    "readyAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledByCopyId" TEXT,
    "canceledAt" TIMESTAMP(3),
    "notes" TEXT,
    "placedByUserId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fines" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "loanId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "reason" TEXT NOT NULL,
    "status" "FineStatus" NOT NULL DEFAULT 'outstanding',
    "paidAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "notes" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "fines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "supportSessionId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authors_sortName_idx" ON "authors"("sortName");

-- CreateIndex
CREATE INDEX "books_sortTitle_idx" ON "books"("sortTitle");

-- CreateIndex
CREATE INDEX "books_isbn13_idx" ON "books"("isbn13");

-- CreateIndex
CREATE INDEX "books_isbn10_idx" ON "books"("isbn10");

-- CreateIndex
CREATE INDEX "books_publicationYear_idx" ON "books"("publicationYear");

-- CreateIndex
CREATE INDEX "book_authors_authorId_idx" ON "book_authors"("authorId");

-- CreateIndex
CREATE INDEX "book_copies_bookId_status_idx" ON "book_copies"("bookId", "status");

-- CreateIndex
CREATE INDEX "book_copies_status_idx" ON "book_copies"("status");

-- CreateIndex
CREATE INDEX "members_sortName_idx" ON "members"("sortName");

-- CreateIndex
CREATE INDEX "members_status_idx" ON "members"("status");

-- CreateIndex
CREATE INDEX "members_email_idx" ON "members"("email");

-- CreateIndex
CREATE INDEX "loans_memberId_status_idx" ON "loans"("memberId", "status");

-- CreateIndex
CREATE INDEX "loans_copyId_idx" ON "loans"("copyId");

-- CreateIndex
CREATE INDEX "loans_dueAt_idx" ON "loans"("dueAt");

-- CreateIndex
CREATE INDEX "loans_returnedAt_idx" ON "loans"("returnedAt");

-- CreateIndex
CREATE INDEX "reservations_bookId_status_queuePosition_idx" ON "reservations"("bookId", "status", "queuePosition");

-- CreateIndex
CREATE INDEX "reservations_memberId_status_idx" ON "reservations"("memberId", "status");

-- CreateIndex
CREATE INDEX "reservations_expiresAt_idx" ON "reservations"("expiresAt");

-- CreateIndex
CREATE INDEX "fines_memberId_status_idx" ON "fines"("memberId", "status");

-- CreateIndex
CREATE INDEX "fines_loanId_idx" ON "fines"("loanId");

-- CreateIndex
CREATE INDEX "field_definitions_entityKind_sortOrder_idx" ON "field_definitions"("entityKind", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "field_definitions_entityKind_fieldKey_key" ON "field_definitions"("entityKind", "fieldKey");

-- CreateIndex
CREATE INDEX "collections_slug_idx" ON "collections"("slug");

-- CreateIndex
CREATE INDEX "collection_fields_collectionId_sortOrder_idx" ON "collection_fields"("collectionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "collection_fields_collectionId_fieldKey_key" ON "collection_fields"("collectionId", "fieldKey");

-- CreateIndex
CREATE INDEX "collection_records_collectionId_createdAt_idx" ON "collection_records"("collectionId", "createdAt");

-- CreateIndex
CREATE INDEX "collection_records_collectionId_archivedAt_idx" ON "collection_records"("collectionId", "archivedAt");

-- CreateIndex
CREATE INDEX "audit_log_occurredAt_idx" ON "audit_log"("occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_actorType_actorId_occurredAt_idx" ON "audit_log"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_targetType_targetId_idx" ON "audit_log"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_log_action_occurredAt_idx" ON "audit_log"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_supportSessionId_idx" ON "audit_log"("supportSessionId");

-- AddForeignKey
ALTER TABLE "book_authors" ADD CONSTRAINT "book_authors_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_authors" ADD CONSTRAINT "book_authors_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "book_copies" ADD CONSTRAINT "book_copies_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "book_copies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_fulfilledByCopyId_fkey" FOREIGN KEY ("fulfilledByCopyId") REFERENCES "book_copies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fines" ADD CONSTRAINT "fines_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fines" ADD CONSTRAINT "fines_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_fields" ADD CONSTRAINT "collection_fields_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_records" ADD CONSTRAINT "collection_records_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Augmentations beyond what Prisma can express natively.
-- These are part of the initial migration so a fresh tenant DB gets a fully
-- consistent schema in a single transaction.
-- ---------------------------------------------------------------------------

-- The TenantSetting table is intended to hold exactly one row.
ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_singleton"
  CHECK (id = 1);

-- Slug shape for collections — lowercase, digits, hyphens; 2-50 chars; no
-- leading/trailing hyphen. Matches what we expose in URLs.
ALTER TABLE "collections"
  ADD CONSTRAINT "collections_slug_format"
  CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9_-]{0,48}[a-z0-9])?$');

-- Field-key shape for both layers (matches what the schema editor enforces).
ALTER TABLE "field_definitions"
  ADD CONSTRAINT "field_definitions_key_format"
  CHECK ("fieldKey" ~ '^[a-z][a-z0-9_]{1,49}$');
ALTER TABLE "collection_fields"
  ADD CONSTRAINT "collection_fields_key_format"
  CHECK ("fieldKey" ~ '^[a-z][a-z0-9_]{1,49}$');

-- One active loan per copy. Generating a new loan on a copy that already
-- has an open loan is the single most important invariant in circulation.
CREATE UNIQUE INDEX "loans_one_active_per_copy"
  ON "loans"("copyId")
  WHERE "returnedAt" IS NULL;

-- One active reservation per (book, member). Prevents the same member
-- appearing twice in a queue.
CREATE UNIQUE INDEX "reservations_one_active_per_book_member"
  ON "reservations"("bookId", "memberId")
  WHERE "status" IN ('queued', 'ready');

-- Barcodes unique among non-archived copies. Archiving a copy frees its
-- barcode for re-use on a replacement.
CREATE UNIQUE INDEX "book_copies_barcode_unique_active"
  ON "book_copies"("barcode")
  WHERE "archivedAt" IS NULL;

-- Member numbers unique among non-archived members. Re-issuable post-archive.
CREATE UNIQUE INDEX "members_member_number_unique_active"
  ON "members"("memberNumber")
  WHERE "archivedAt" IS NULL;

-- Collection slug unique among non-archived collections.
CREATE UNIQUE INDEX "collections_slug_unique_active"
  ON "collections"("slug")
  WHERE "archivedAt" IS NULL;

-- ISBN integrity checks: digits-only when present, 10 or 13 long.
ALTER TABLE "books"
  ADD CONSTRAINT "books_isbn13_shape"
  CHECK ("isbn13" IS NULL OR "isbn13" ~ '^[0-9]{13}$');
ALTER TABLE "books"
  ADD CONSTRAINT "books_isbn10_shape"
  CHECK ("isbn10" IS NULL OR "isbn10" ~ '^[0-9Xx]{10}$');

-- Monetary amounts are non-negative.
ALTER TABLE "book_copies"
  ADD CONSTRAINT "book_copies_price_nonneg"
  CHECK ("priceCents" IS NULL OR "priceCents" >= 0);
ALTER TABLE "fines"
  ADD CONSTRAINT "fines_amount_nonneg"
  CHECK ("amountCents" >= 0);

-- Loan chronology: due after loaned, returned after loaned, renewal count non-negative.
ALTER TABLE "loans"
  ADD CONSTRAINT "loans_due_after_loaned"
  CHECK ("dueAt" > "loanedAt");
ALTER TABLE "loans"
  ADD CONSTRAINT "loans_returned_after_loaned"
  CHECK ("returnedAt" IS NULL OR "returnedAt" >= "loanedAt");
ALTER TABLE "loans"
  ADD CONSTRAINT "loans_renewed_count_nonneg"
  CHECK ("renewedCount" >= 0);

-- Returned loans must have a returnedAt; active/lost must not.
ALTER TABLE "loans"
  ADD CONSTRAINT "loans_status_returned_consistency"
  CHECK (
    ("status" = 'returned' AND "returnedAt" IS NOT NULL)
    OR ("status" <> 'returned' AND "returnedAt" IS NULL)
  );

-- Reservation chronology + status/timestamp consistency.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_ready_after_placed"
  CHECK ("readyAt" IS NULL OR "readyAt" >= "placedAt");
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_expires_after_ready"
  CHECK ("expiresAt" IS NULL OR "readyAt" IS NULL OR "expiresAt" > "readyAt");
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_fulfilled_after_placed"
  CHECK ("fulfilledAt" IS NULL OR "fulfilledAt" >= "placedAt");
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_queue_position_when_queued"
  CHECK (
    ("status" = 'queued' AND "queuePosition" IS NOT NULL AND "queuePosition" >= 1)
    OR "status" <> 'queued'
  );
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_fulfilled_consistency"
  CHECK (
    ("status" = 'fulfilled' AND "fulfilledAt" IS NOT NULL AND "fulfilledByCopyId" IS NOT NULL)
    OR ("status" <> 'fulfilled')
  );

-- Fine status / paid_at consistency.
ALTER TABLE "fines"
  ADD CONSTRAINT "fines_paid_consistency"
  CHECK (
    ("status" = 'paid' AND "paidAt" IS NOT NULL)
    OR ("status" <> 'paid' AND ("paidAt" IS NULL OR "status" = 'waived'))
  );

-- TenantSetting numeric sanity.
ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_nonneg"
  CHECK (
    "loanPeriodDays" >= 1
    AND "maxRenewals" >= 0
    AND "finePerDayCents" >= 0
    AND "fineCapCents" >= 0
    AND "holdPickupHours" >= 1
    AND "maxActiveLoans" >= 0
  );

-- Trigram + GIN indexes for fuzzy search across Greek and Latin text.
-- App-side: write lowercase + unaccented composite into searchText.
CREATE INDEX "books_search_trgm" ON "books" USING gin ("searchText" gin_trgm_ops);
CREATE INDEX "members_search_trgm" ON "members" USING gin ("searchText" gin_trgm_ops);
CREATE INDEX "authors_sortname_trgm" ON "authors" USING gin ("sortName" gin_trgm_ops);
CREATE INDEX "collection_records_search_trgm"
  ON "collection_records" USING gin ("searchText" gin_trgm_ops);

-- GIN indexes on JSONB custom_fields for filtering by custom field value.
CREATE INDEX "books_custom_fields_gin"          ON "books"          USING gin ("customFields" jsonb_path_ops);
CREATE INDEX "book_copies_custom_fields_gin"    ON "book_copies"    USING gin ("customFields" jsonb_path_ops);
CREATE INDEX "members_custom_fields_gin"        ON "members"        USING gin ("customFields" jsonb_path_ops);
CREATE INDEX "loans_custom_fields_gin"          ON "loans"          USING gin ("customFields" jsonb_path_ops);
CREATE INDEX "reservations_custom_fields_gin"   ON "reservations"   USING gin ("customFields" jsonb_path_ops);
CREATE INDEX "fines_custom_fields_gin"          ON "fines"          USING gin ("customFields" jsonb_path_ops);
CREATE INDEX "collection_records_data_gin"      ON "collection_records" USING gin ("data" jsonb_path_ops);

-- Member-number shape: capital ASCII / digits / hyphen / underscore, 2-30 chars.
ALTER TABLE "members"
  ADD CONSTRAINT "members_member_number_format"
  CHECK ("memberNumber" ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$');
