-- Repricing against the Greek market.
--
-- Sized and priced from 76 real contract awards published on ΔΙΑΥΓΕΙΑ: the
-- median Greek library pays ~€900/yr for openABEKT, the mode is €500, and the
-- median δημόσια βιβλιοθήκη holds ~67,000 volumes ≈ 53,000 titles. The old
-- tiers put an ordinary library in a €2,988/yr band and priced the entry tier
-- below the cheapest contract in the whole dataset.
--
-- This migration is REQUIRED, not a convenience. prisma/seed.ts skips any plan
-- whose slug already exists, so editing seed-data.ts alone would leave the
-- static pricing page advertising numbers the database does not enforce. And
-- there is no create-plan endpoint anywhere, so the new `central` tier can only
-- arrive this way.
--
-- Idempotent throughout (guarded / IF NOT EXISTS / upsert), per repo convention.

-- Annual pricing ------------------------------------------------------------
-- A Stripe Price is immutable and each billing interval is its own Price
-- object, so the annual cadence needs its own id column rather than reusing
-- stripePriceId.
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "annualPriceCents" INTEGER;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "stripeAnnualPriceId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "plans_stripeAnnualPriceId_key"
  ON "plans" ("stripeAnnualPriceId");

-- The old CHECK predates annual pricing. A stripe plan still needs its monthly
-- Price id; a manual plan must carry neither.
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_stripe_price_matches_mode";
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_stripe_price_matches_mode"
  CHECK (
    ("billingMode" = 'stripe' AND "stripePriceId" IS NOT NULL)
    OR ("billingMode" = 'manual' AND "stripePriceId" IS NULL AND "stripeAnnualPriceId" IS NULL)
  );

-- Catalog defaults ----------------------------------------------------------
-- These are the fallback when neither an override nor a plan row exists, and
-- they shadow Starter key for key. Left behind they would make the no-plan
-- floor stricter than the free plan.
UPDATE "plan_features" SET "defaultInt" = 5000 WHERE "key" = 'max_books';
UPDATE "plan_features" SET "defaultInt" = 1500 WHERE "key" = 'max_members';
UPDATE "plan_features" SET "defaultInt" = 512 WHERE "key" = 'max_storage_mb';
UPDATE "plan_features" SET "defaultInt" = 3 WHERE "key" = 'staff_seats';
UPDATE "plan_features" SET "defaultInt" = 5 WHERE "key" = 'max_custom_fields_per_entity';

-- Plans ---------------------------------------------------------------------
INSERT INTO "plans" ("id","slug","name","description","billingMode","stripePriceId","monthlyPriceCents","stripeAnnualPriceId","annualPriceCents","currency","isActive","isPublic","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'starter', 'Starter', 'Free. Sized for a Greek school library — roughly 2,000-6,000 items — or a very small community collection.', 'stripe', 'price_seed_starter', 0, NULL, NULL, 'EUR', true, true, 10, now(), now())
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
  "stripeAnnualPriceId" = EXCLUDED."stripeAnnualPriceId",
  "annualPriceCents" = EXCLUDED."annualPriceCents",
  "isPublic" = EXCLUDED."isPublic",
  "sortOrder" = EXCLUDED."sortOrder",
  "updatedAt" = now();
INSERT INTO "plans" ("id","slug","name","description","billingMode","stripePriceId","monthlyPriceCents","stripeAnnualPriceId","annualPriceCents","currency","isActive","isPublic","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'community', 'Community', 'A small municipal, community or specialist library. Around 20,000 titles.', 'stripe', 'price_seed_community', 3900, 'price_seed_community_annual', 39000, 'EUR', true, true, 20, now(), now())
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
  "stripeAnnualPriceId" = EXCLUDED."stripeAnnualPriceId",
  "annualPriceCents" = EXCLUDED."annualPriceCents",
  "isPublic" = EXCLUDED."isPublic",
  "sortOrder" = EXCLUDED."sortOrder",
  "updatedAt" = now();
INSERT INTO "plans" ("id","slug","name","description","billingMode","stripePriceId","monthlyPriceCents","stripeAnnualPriceId","annualPriceCents","currency","isActive","isPublic","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'municipal', 'Municipal', 'A working municipal library. 60,000 titles covers the median Greek public library.', 'stripe', 'price_seed_municipal', 7900, 'price_seed_municipal_annual', 79000, 'EUR', true, true, 30, now(), now())
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
  "stripeAnnualPriceId" = EXCLUDED."stripeAnnualPriceId",
  "annualPriceCents" = EXCLUDED."annualPriceCents",
  "isPublic" = EXCLUDED."isPublic",
  "sortOrder" = EXCLUDED."sortOrder",
  "updatedAt" = now();
INSERT INTO "plans" ("id","slug","name","description","billingMode","stripePriceId","monthlyPriceCents","stripeAnnualPriceId","annualPriceCents","currency","isActive","isPublic","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'central', 'Central', 'A large or central municipal library, or a δημόσια βιβλιοθήκη. Up to 150,000 titles.', 'stripe', 'price_seed_central', 11900, 'price_seed_central_annual', 119000, 'EUR', true, true, 35, now(), now())
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
  "stripeAnnualPriceId" = EXCLUDED."stripeAnnualPriceId",
  "annualPriceCents" = EXCLUDED."annualPriceCents",
  "isPublic" = EXCLUDED."isPublic",
  "sortOrder" = EXCLUDED."sortOrder",
  "updatedAt" = now();
INSERT INTO "plans" ("id","slug","name","description","billingMode","stripePriceId","monthlyPriceCents","stripeAnnualPriceId","annualPriceCents","currency","isActive","isPublic","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'institutional', 'Institutional', 'An academic library or a very large public collection. Up to 400,000 titles.', 'stripe', 'price_seed_institutional', 18900, 'price_seed_institutional_annual', 189000, 'EUR', true, true, 40, now(), now())
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
  "stripeAnnualPriceId" = EXCLUDED."stripeAnnualPriceId",
  "annualPriceCents" = EXCLUDED."annualPriceCents",
  "isPublic" = EXCLUDED."isPublic",
  "sortOrder" = EXCLUDED."sortOrder",
  "updatedAt" = now();

-- Feature values ------------------------------------------------------------
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_books', 5000, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_members', 1500, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_storage_mb', 512, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'staff_seats', 3, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_collections', 0, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_records_per_collection', 0, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_fields_per_entity', 5, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'reservations_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'isbn_lookup_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'bulk_import_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'email_notifications_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'audit_log_retention_days', 7, NULL FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'api_access_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'custom_subdomain_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'priority_support', NULL, false FROM "plans" p WHERE p."slug" = 'starter'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_books', 20000, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_members', 5000, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_storage_mb', 2048, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'staff_seats', 10, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_collections', 1, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_records_per_collection', 1000, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_fields_per_entity', 15, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'reservations_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'isbn_lookup_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'bulk_import_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'email_notifications_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'audit_log_retention_days', 90, NULL FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'api_access_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'custom_subdomain_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'priority_support', NULL, false FROM "plans" p WHERE p."slug" = 'community'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_books', 60000, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_members', 15000, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_storage_mb', 10240, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'staff_seats', 25, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_collections', 5, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_records_per_collection', 25000, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_fields_per_entity', 30, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'reservations_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'isbn_lookup_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'bulk_import_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'email_notifications_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'audit_log_retention_days', 365, NULL FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'api_access_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'custom_subdomain_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'priority_support', NULL, false FROM "plans" p WHERE p."slug" = 'municipal'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_books', 150000, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_members', 40000, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_storage_mb', 25600, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'staff_seats', 60, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_collections', 10, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_records_per_collection', 100000, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_fields_per_entity', 60, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'reservations_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'isbn_lookup_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'bulk_import_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'email_notifications_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'audit_log_retention_days', 1095, NULL FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'api_access_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'custom_subdomain_enabled', NULL, false FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'priority_support', NULL, true FROM "plans" p WHERE p."slug" = 'central'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_books', 400000, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_members', 100000, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_storage_mb', 102400, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'staff_seats', 150, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_collections', 20, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_records_per_collection', 250000, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_fields_per_entity', 120, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'reservations_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'isbn_lookup_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'bulk_import_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'email_notifications_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'audit_log_retention_days', 3650, NULL FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'api_access_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'custom_subdomain_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'priority_support', NULL, true FROM "plans" p WHERE p."slug" = 'institutional'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_books', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_members', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_storage_mb', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'staff_seats', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_collections', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_records_per_collection', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'max_custom_fields_per_entity', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'reservations_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'isbn_lookup_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'bulk_import_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'email_notifications_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'audit_log_retention_days', 1000000000, NULL FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueInt" = EXCLUDED."valueInt", "valueBool" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'api_access_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'custom_subdomain_enabled', NULL, true FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
INSERT INTO "plan_feature_values" ("planId","featureKey","valueInt","valueBool")
SELECT p."id", 'priority_support', NULL, true FROM "plans" p WHERE p."slug" = 'on-prem-enterprise'
ON CONFLICT ("planId","featureKey") DO UPDATE SET "valueBool" = EXCLUDED."valueBool", "valueInt" = NULL;
