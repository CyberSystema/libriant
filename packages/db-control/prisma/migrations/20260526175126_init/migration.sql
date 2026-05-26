-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'archived');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'librarian', 'volunteer');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('owner', 'support');

-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('active', 'locked', 'disabled');

-- CreateEnum
CREATE TYPE "FeatureType" AS ENUM ('int', 'bool', 'text');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('stripe', 'manual');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'paused');

-- CreateEnum
CREATE TYPE "SupportKeyStatus" AS ENUM ('pending', 'redeemed', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "SupportSessionEndReason" AS ENUM ('expired', 'admin_ended', 'library_revoked');

-- CreateEnum
CREATE TYPE "AnnouncementSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "SystemModeKind" AS ENUM ('normal', 'maintenance', 'read_only', 'out_of_order', 'under_construction');

-- CreateEnum
CREATE TYPE "SystemModeScope" AS ENUM ('global', 'tenant');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'admin', 'system');

-- CreateTable
CREATE TABLE "cells" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'eu-central',
    "dbHostUrl" TEXT,
    "acceptsNew" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultLocale" TEXT NOT NULL DEFAULT 'el',
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "cellId" TEXT NOT NULL,
    "dbUrl" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "customSubdomain" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "primaryEmail" CITEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_db_credentials" (
    "tenantId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "encryptedPwd" BYTEA NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "encryptionNonce" BYTEA NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_db_credentials_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'librarian',
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "locale" TEXT,
    "passwordHash" TEXT,
    "mfaSecretCipher" BYTEA,
    "mfaNonce" BYTEA,
    "mfaKeyId" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inviteToken" TEXT,
    "inviteExpires" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_features" (
    "key" TEXT NOT NULL,
    "type" "FeatureType" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "defaultInt" INTEGER,
    "defaultBool" BOOLEAN,
    "defaultText" TEXT,
    "unit" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "billingMode" "BillingMode" NOT NULL DEFAULT 'stripe',
    "stripePriceId" TEXT,
    "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_feature_values" (
    "planId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "valueInt" INTEGER,
    "valueBool" BOOLEAN,
    "valueText" TEXT,

    CONSTRAINT "plan_feature_values_pkey" PRIMARY KEY ("planId","featureKey")
);

-- CreateTable
CREATE TABLE "tenant_plan_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "valueInt" INTEGER,
    "valueBool" BOOLEAN,
    "valueText" TEXT,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_plan_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "billingMode" "BillingMode" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "stripeSubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "paidUntil" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "tenantId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "defaultPaymentMethodId" TEXT,
    "billingEmail" CITEXT NOT NULL,
    "billingName" TEXT NOT NULL,
    "taxId" TEXT,
    "taxCountry" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "stripe_webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'support',
    "status" "AdminStatus" NOT NULL DEFAULT 'active',
    "passwordHash" TEXT NOT NULL,
    "mfaSecretCipher" BYTEA NOT NULL,
    "mfaNonce" BYTEA NOT NULL,
    "mfaKeyId" TEXT NOT NULL,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_keys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemedByAdminId" TEXT,
    "redeemedFromIp" TEXT,
    "status" "SupportKeyStatus" NOT NULL DEFAULT 'pending',
    "sessionId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "support_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "supportKeyId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedReason" "SupportSessionEndReason",
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_action_log" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,

    CONSTRAINT "support_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_redemption_attempts" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "ipAddress" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "codePrefix" TEXT,

    CONSTRAINT "support_redemption_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "severity" "AnnouncementSeverity" NOT NULL DEFAULT 'info',
    "audienceFilter" JSONB NOT NULL,
    "deliverInApp" BOOLEAN NOT NULL DEFAULT true,
    "deliverEmail" BOOLEAN NOT NULL DEFAULT false,
    "publishAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "requiresAck" BOOLEAN NOT NULL DEFAULT false,
    "createdByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_deliveries" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "deliveredInAppAt" TIMESTAMP(3),
    "deliveredEmailAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "announcement_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_mode_events" (
    "id" TEXT NOT NULL,
    "scope" "SystemModeScope" NOT NULL,
    "tenantId" TEXT,
    "mode" "SystemModeKind" NOT NULL,
    "messageMarkdown" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "allowAdminBypass" BOOLEAN NOT NULL DEFAULT true,
    "createdByAdminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "system_mode_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cells_slug_key" ON "cells"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_cellId_idx" ON "tenants"("cellId");

-- CreateIndex
CREATE INDEX "tenants_status_idx" ON "tenants"("status");

-- CreateIndex
CREATE INDEX "users_tenantId_status_idx" ON "users"("tenantId", "status");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "plans_slug_key" ON "plans"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "plans_stripePriceId_key" ON "plans"("stripePriceId");

-- CreateIndex
CREATE INDEX "plans_isActive_idx" ON "plans"("isActive");

-- CreateIndex
CREATE INDEX "plan_feature_values_featureKey_idx" ON "plan_feature_values"("featureKey");

-- CreateIndex
CREATE INDEX "tenant_plan_overrides_featureKey_idx" ON "tenant_plan_overrides"("featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_plan_overrides_tenantId_featureKey_key" ON "tenant_plan_overrides"("tenantId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripeSubscriptionId_key" ON "subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_planId_idx" ON "subscriptions"("planId");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_stripeCustomerId_key" ON "billing_accounts"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "stripe_webhook_events_type_receivedAt_idx" ON "stripe_webhook_events"("type", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_users_status_idx" ON "admin_users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "support_keys_sessionId_key" ON "support_keys"("sessionId");

-- CreateIndex
CREATE INDEX "support_keys_tenantId_status_idx" ON "support_keys"("tenantId", "status");

-- CreateIndex
CREATE INDEX "support_keys_codePrefix_status_idx" ON "support_keys"("codePrefix", "status");

-- CreateIndex
CREATE INDEX "support_keys_expiresAt_idx" ON "support_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_sessions_supportKeyId_key" ON "support_sessions"("supportKeyId");

-- CreateIndex
CREATE INDEX "support_sessions_tenantId_idx" ON "support_sessions"("tenantId");

-- CreateIndex
CREATE INDEX "support_sessions_adminId_idx" ON "support_sessions"("adminId");

-- CreateIndex
CREATE INDEX "support_sessions_endedAt_idx" ON "support_sessions"("endedAt");

-- CreateIndex
CREATE INDEX "support_action_log_sessionId_ts_idx" ON "support_action_log"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "support_action_log_ts_idx" ON "support_action_log"("ts");

-- CreateIndex
CREATE INDEX "support_redemption_attempts_adminId_ts_idx" ON "support_redemption_attempts"("adminId", "ts");

-- CreateIndex
CREATE INDEX "support_redemption_attempts_ipAddress_ts_idx" ON "support_redemption_attempts"("ipAddress", "ts");

-- CreateIndex
CREATE INDEX "audit_log_tenantId_occurredAt_idx" ON "audit_log"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_actorType_actorId_occurredAt_idx" ON "audit_log"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_targetType_targetId_idx" ON "audit_log"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_log_action_occurredAt_idx" ON "audit_log"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "announcements_publishAt_idx" ON "announcements"("publishAt");

-- CreateIndex
CREATE INDEX "announcements_expiresAt_idx" ON "announcements"("expiresAt");

-- CreateIndex
CREATE INDEX "announcement_deliveries_tenantId_announcementId_idx" ON "announcement_deliveries"("tenantId", "announcementId");

-- CreateIndex
CREATE INDEX "announcement_deliveries_userId_announcementId_idx" ON "announcement_deliveries"("userId", "announcementId");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_deliveries_announcementId_tenantId_userId_key" ON "announcement_deliveries"("announcementId", "tenantId", "userId");

-- CreateIndex
CREATE INDEX "system_mode_events_scope_startsAt_idx" ON "system_mode_events"("scope", "startsAt");

-- CreateIndex
CREATE INDEX "system_mode_events_tenantId_startsAt_idx" ON "system_mode_events"("tenantId", "startsAt");

-- CreateIndex
CREATE INDEX "system_mode_events_endsAt_idx" ON "system_mode_events"("endsAt");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_db_credentials" ADD CONSTRAINT "tenant_db_credentials_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_feature_values" ADD CONSTRAINT "plan_feature_values_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_feature_values" ADD CONSTRAINT "plan_feature_values_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "plan_features"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_plan_overrides" ADD CONSTRAINT "tenant_plan_overrides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_plan_overrides" ADD CONSTRAINT "tenant_plan_overrides_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "plan_features"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_plan_overrides" ADD CONSTRAINT "tenant_plan_overrides_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_keys" ADD CONSTRAINT "support_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_keys" ADD CONSTRAINT "support_keys_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_keys" ADD CONSTRAINT "support_keys_redeemedByAdminId_fkey" FOREIGN KEY ("redeemedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_keys" ADD CONSTRAINT "support_keys_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "support_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_action_log" ADD CONSTRAINT "support_action_log_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "support_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_redemption_attempts" ADD CONSTRAINT "support_redemption_attempts_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_deliveries" ADD CONSTRAINT "announcement_deliveries_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_deliveries" ADD CONSTRAINT "announcement_deliveries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_deliveries" ADD CONSTRAINT "announcement_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_mode_events" ADD CONSTRAINT "system_mode_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_mode_events" ADD CONSTRAINT "system_mode_events_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Augmentations beyond what Prisma can express natively.
-- These are written here (not as separate migrations) so an initial deploy
-- gets a fully consistent schema in one transaction.
-- ---------------------------------------------------------------------------

-- One pending support key per tenant — generating a new one revokes any prior
-- pending key (enforced at application layer; the index keeps it true at the DB).
CREATE UNIQUE INDEX "support_keys_one_pending_per_tenant"
  ON "support_keys"("tenantId")
  WHERE "status" = 'pending';

-- One active support session per tenant.
CREATE UNIQUE INDEX "support_sessions_one_active_per_tenant"
  ON "support_sessions"("tenantId")
  WHERE "endedAt" IS NULL;

-- Tenants with a custom subdomain set must each have a unique value; NULLs
-- are unconstrained (most tenants will be NULL).
CREATE UNIQUE INDEX "tenants_custom_subdomain_unique"
  ON "tenants"("customSubdomain")
  WHERE "customSubdomain" IS NOT NULL;

-- PlanFeatureValue: exactly one of value_int / value_bool / value_text is set.
ALTER TABLE "plan_feature_values"
  ADD CONSTRAINT "plan_feature_values_value_exactly_one"
  CHECK (
    (("valueInt"  IS NOT NULL)::int +
     ("valueBool" IS NOT NULL)::int +
     ("valueText" IS NOT NULL)::int) = 1
  );

-- Same invariant for per-tenant overrides.
ALTER TABLE "tenant_plan_overrides"
  ADD CONSTRAINT "tenant_plan_overrides_value_exactly_one"
  CHECK (
    (("valueInt"  IS NOT NULL)::int +
     ("valueBool" IS NOT NULL)::int +
     ("valueText" IS NOT NULL)::int) = 1
  );

-- PlanFeature catalog: exactly one of defaultInt/defaultBool/defaultText is set,
-- OR all three are NULL (feature has no default — value MUST come from plan/override).
ALTER TABLE "plan_features"
  ADD CONSTRAINT "plan_features_default_at_most_one"
  CHECK (
    (("defaultInt"  IS NOT NULL)::int +
     ("defaultBool" IS NOT NULL)::int +
     ("defaultText" IS NOT NULL)::int) <= 1
  );

-- Stripe-billed plans must carry a Stripe price id; manual plans must not.
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_stripe_price_matches_mode"
  CHECK (
    ("billingMode" = 'stripe' AND "stripePriceId" IS NOT NULL)
    OR ("billingMode" = 'manual' AND "stripePriceId" IS NULL)
  );

-- Tenant-scoped system mode events must carry a tenant id; global ones must not.
ALTER TABLE "system_mode_events"
  ADD CONSTRAINT "system_mode_events_tenant_id_matches_scope"
  CHECK (
    ("scope" = 'tenant' AND "tenantId" IS NOT NULL)
    OR ("scope" = 'global' AND "tenantId" IS NULL)
  );

-- Tenant slug shape: lowercase, digits, hyphens; 2-50 chars; no leading/trailing
-- hyphen. Matches what we expose in URLs.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_slug_format"
  CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$');

-- Custom subdomain follows the same rule as slug when present.
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_custom_subdomain_format"
  CHECK (
    "customSubdomain" IS NULL
    OR "customSubdomain" ~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$'
  );

-- Plan slug shape: lowercase, digits, hyphens; 2-40 chars.
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_slug_format"
  CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$');

-- Feature key shape: snake_case, ASCII, 2-50 chars (matches FEATURE_KEYS catalog).
ALTER TABLE "plan_features"
  ADD CONSTRAINT "plan_features_key_format"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,49}$');

-- Support-session expiry must be after start; ended_at must be at/after start.
ALTER TABLE "support_sessions"
  ADD CONSTRAINT "support_sessions_expiry_after_start"
  CHECK ("expiresAt" > "startedAt");
ALTER TABLE "support_sessions"
  ADD CONSTRAINT "support_sessions_ended_after_start"
  CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");

-- Support-key expiry must be after generation.
ALTER TABLE "support_keys"
  ADD CONSTRAINT "support_keys_expiry_after_generated"
  CHECK ("expiresAt" > "generatedAt");

-- System mode window: ends_at must be after starts_at when set.
ALTER TABLE "system_mode_events"
  ADD CONSTRAINT "system_mode_events_window"
  CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");

-- Announcement window: expires_at must be after publish_at when both set.
ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_window"
  CHECK (
    "publishAt" IS NULL OR "expiresAt" IS NULL OR "expiresAt" > "publishAt"
  );

-- Trigram indexes for fuzzy tenant/admin lookup in the internal admin UI.
CREATE INDEX "tenants_name_trgm" ON "tenants" USING gin ("name" gin_trgm_ops);
CREATE INDEX "tenants_slug_trgm" ON "tenants" USING gin ("slug" gin_trgm_ops);
CREATE INDEX "users_email_trgm" ON "users" USING gin (("email"::text) gin_trgm_ops);
CREATE INDEX "admin_users_email_trgm" ON "admin_users" USING gin (("email"::text) gin_trgm_ops);

-- Helpful array index for tag-based audience filtering on announcements.
CREATE INDEX "tenants_tags_gin" ON "tenants" USING gin ("tags");
