-- Billing on/off becomes an owner-controlled, runtime setting (no redeploy),
-- and tenants gain an explicit "I chose this plan" marker so that enabling
-- subscriptions can force an unchosen tenant through the plan chooser.

-- ---------------------------------------------------------------------------
-- Global runtime settings. Today holds a single row, `billing.enabled`.
-- Absent key => reader falls back to the BILLING_ENABLED env var.
-- ---------------------------------------------------------------------------
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- ---------------------------------------------------------------------------
-- Per-tenant explicit plan choice. NULL = never chosen.
-- ---------------------------------------------------------------------------
ALTER TABLE "subscriptions" ADD COLUMN "planSelectedAt" TIMESTAMP(3);

-- Backfill: a tenant already on a real paying subscription (Stripe-backed or
-- a manually-billed plan) has effectively chosen — don't drag them back
-- through the chooser when subscriptions are switched on. Everyone else
-- (free Starter placeholders created while billing was off) stays NULL.
UPDATE "subscriptions"
   SET "planSelectedAt" = "updatedAt"
 WHERE "stripeSubscriptionId" IS NOT NULL
    OR "billingMode" = 'manual';
