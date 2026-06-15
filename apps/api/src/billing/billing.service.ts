import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type {
  BillingAccount,
  BillingMode,
  Plan,
  Subscription,
  SubscriptionStatus,
} from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import {
  STRIPE_DRIVER,
  type StripeDriver,
  type StripeInvoiceShape,
  type StripeSubscriptionShape,
} from './stripe-driver.js';

const MS_PER_DAY = 86_400_000;

/**
 * Convert a Stripe epoch-seconds timestamp to a Date, or null when absent.
 * Guards against `new Date(undefined * 1000)` → Invalid Date, which Prisma
 * rejects when writing a DateTime column.
 */
function epochSecsToDate(secs: number | null | undefined): Date | null {
  return typeof secs === 'number' && Number.isFinite(secs) ? new Date(secs * 1000) : null;
}

export type BillingSnapshot = {
  tenantId: string;
  tenantSlug: string;
  billingMode: BillingMode;
  status: SubscriptionStatus;
  plan: { id: string; slug: string; name: string };
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  paidUntil: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /** Stripe customer id, if we've created one. */
  stripeCustomerId: string | null;
  /** Stripe subscription id, if there's an active Stripe subscription. */
  stripeSubscriptionId: string | null;
  /** Driver kind so the UI can decide whether to show "Open portal". */
  driver: 'real' | 'fake';
  /** When false, plan/quota enforcement is off — every feature is free and
   *  the UI hides plans / upgrade actions. */
  billingEnabled: boolean;
  /** Whether the library has explicitly chosen a plan. When billing is
   *  enabled and this is false, the full-page chooser is forced. */
  planSelected: boolean;
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(EffectivePlanService) private readonly effectivePlan: EffectivePlanService,
    @Inject(STRIPE_DRIVER) private readonly stripe: StripeDriver,
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
  ) {}

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Plans the tenant can switch to. Hides admin-only and archived plans
   * but always includes the tenant's *current* plan (even if it's now
   * private/archived) so the UI can label "you are here".
   */
  async listAvailablePlans(tenantId: string): Promise<
    Array<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      billingMode: BillingMode;
      monthlyPriceCents: number;
      currency: string;
      hasStripePrice: boolean;
      isCurrent: boolean;
      sortOrder: number;
    }>
  > {
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      select: { planId: true },
    });
    const plans = await controlDb.plan.findMany({
      where: { archivedAt: null, isActive: true, isPublic: true },
      orderBy: { sortOrder: 'asc' },
    });
    // Make sure the current plan shows up even if it's been made private.
    if (sub && !plans.some((p) => p.id === sub.planId)) {
      const current = await controlDb.plan.findUnique({ where: { id: sub.planId } });
      if (current) plans.unshift(current);
    }
    return plans.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      billingMode: p.billingMode,
      monthlyPriceCents: p.monthlyPriceCents,
      currency: p.currency,
      hasStripePrice: !!p.stripePriceId,
      isCurrent: p.id === sub?.planId,
      sortOrder: p.sortOrder,
    }));
  }

  /**
   * Cheap check for the tenant layout's forced-chooser gate. Runs on every
   * tenant page load, so it does ZERO database work while subscriptions are
   * disabled (the common case) — just the cached toggle read — and a single
   * tiny query when they're enabled.
   */
  async getGate(tenantId: string): Promise<{ billingEnabled: boolean; planSelected: boolean }> {
    const billingEnabled = await this.settings.billingEnabled();
    if (!billingEnabled) return { billingEnabled: false, planSelected: true };
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      select: { planSelectedAt: true },
    });
    return { billingEnabled: true, planSelected: sub?.planSelectedAt != null };
  }

  /** Plain-shape snapshot of where this tenant stands billing-wise. */
  async getSnapshot(tenantId: string): Promise<BillingSnapshot> {
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      include: { plan: true, tenant: true },
    });
    if (!sub) throw new NotFoundException('No subscription on file for this library.');
    const billing = await controlDb.billingAccount.findUnique({ where: { tenantId } });
    return {
      tenantId,
      tenantSlug: sub.tenant.slug,
      billingMode: sub.billingMode,
      status: sub.status,
      plan: { id: sub.plan.id, slug: sub.plan.slug, name: sub.plan.name },
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      paidUntil: sub.paidUntil,
      graceUntil: sub.graceUntil,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canceledAt: sub.canceledAt,
      stripeCustomerId: billing?.stripeCustomerId ?? null,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      driver: this.stripe.isReal ? 'real' : 'fake',
      billingEnabled: await this.settings.billingEnabled(),
      planSelected: sub.planSelectedAt !== null,
    };
  }

  // -------------------------------------------------------------------------
  // Stripe-mode self-serve flows
  // -------------------------------------------------------------------------

  /**
   * Start a Stripe Checkout session for a plan change. Idempotent in spirit
   * — re-clicking the upgrade button before the first session completes
   * just creates a second session; both reference the same customer id and
   * once one succeeds the webhook reconciles state.
   */
  /** Self-serve billing flows are unavailable while subscriptions are disabled. */
  private async assertBillingEnabled(): Promise<void> {
    if (!(await this.settings.billingEnabled())) {
      throw new BadRequestException(
        'Subscriptions are currently disabled — every feature is already included for free.',
      );
    }
  }

  /**
   * Record the library's explicit choice of a FREE plan (the chooser path).
   * Paid plans never reach here — the chooser routes those to Stripe Checkout,
   * and `startCheckout` stamps the choice. Stamping `planSelectedAt` is what
   * clears the forced full-page chooser.
   */
  async selectPlan(tenantId: string, input: { planSlug: string }): Promise<BillingSnapshot> {
    await this.assertBillingEnabled();
    const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException('No subscription on file.');
    const plan = await controlDb.plan.findUnique({ where: { slug: input.planSlug } });
    if (!plan || !plan.isActive || !plan.isPublic || plan.archivedAt) {
      throw new NotFoundException(`Plan "${input.planSlug}" isn't available.`);
    }
    if (plan.billingMode === 'stripe' && plan.monthlyPriceCents > 0) {
      throw new BadRequestException(
        'That plan requires payment — start checkout to add a payment method.',
      );
    }
    await controlDb.subscription.update({
      where: { tenantId },
      data: {
        planId: plan.id,
        billingMode: plan.billingMode,
        status: 'active',
        graceUntil: null,
        planSelectedAt: sub.planSelectedAt ?? new Date(),
      },
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  async startCheckout(
    tenantId: string,
    input: { planSlug: string; returnPath?: string },
  ): Promise<{ url: string; sessionId: string }> {
    await this.assertBillingEnabled();
    const env = loadEnv();
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      include: { tenant: true },
    });
    if (!sub) throw new NotFoundException('No subscription on file.');

    const plan = await controlDb.plan.findUnique({ where: { slug: input.planSlug } });
    // A hidden/legacy/experimental plan must not be subscribable by guessing
    // its slug — unless the tenant is already on it (a grandfathered renewal).
    if (!plan || !plan.isActive || plan.archivedAt || (!plan.isPublic && plan.id !== sub.planId)) {
      throw new NotFoundException(`Plan "${input.planSlug}" isn't available.`);
    }
    if (plan.billingMode !== 'stripe') {
      throw new BadRequestException(
        "That plan is billed manually — contact us and we'll set it up by invoice.",
      );
    }
    if (!plan.stripePriceId) {
      throw new BadRequestException(
        `Plan "${input.planSlug}" has no Stripe price configured. Ask an admin to fix the plan.`,
      );
    }
    if (plan.id === sub.planId && sub.status === 'active') {
      throw new BadRequestException(`You're already on the ${plan.name} plan.`);
    }

    const customerId = await this.ensureStripeCustomer(tenantId);

    // Starting paid checkout counts as making a choice — stamp it now so the
    // library isn't bounced back to the chooser in the window between the
    // Stripe success redirect and the confirming webhook. (If they abandon
    // checkout, they simply stay on their current free plan, un-gated.)
    if (!sub.planSelectedAt) {
      await controlDb.subscription.update({
        where: { tenantId },
        data: { planSelectedAt: new Date() },
      });
    }

    const base = env.billingReturnUrl.replace(/\/$/, '');
    const returnPath = input.returnPath?.startsWith('/')
      ? input.returnPath
      : '/t/' + sub.tenant.slug + '/billing';
    const successUrl = `${base}${returnPath}?checkout=success`;
    const cancelUrl = `${base}${returnPath}?checkout=cancelled`;

    return this.stripe.createCheckoutSession({
      customerId,
      priceId: plan.stripePriceId,
      successUrl,
      cancelUrl,
      tenantId,
    });
  }

  /** Open a Stripe Customer Portal session (manage payment methods, view invoices). */
  async openCustomerPortal(
    tenantId: string,
    input: { returnPath?: string },
  ): Promise<{ url: string }> {
    await this.assertBillingEnabled();
    const env = loadEnv();
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      include: { tenant: true },
    });
    if (!sub) throw new NotFoundException('No subscription on file.');
    if (sub.billingMode !== 'stripe') {
      throw new BadRequestException(
        'Your library is billed manually — there is no self-serve portal to open. Contact us instead.',
      );
    }
    const customerId = await this.ensureStripeCustomer(tenantId);
    const base = env.billingReturnUrl.replace(/\/$/, '');
    const returnPath = input.returnPath?.startsWith('/')
      ? input.returnPath
      : '/t/' + sub.tenant.slug + '/billing';
    return this.stripe.createBillingPortalSession({
      customerId,
      returnUrl: `${base}${returnPath}`,
    });
  }

  /**
   * Cancel the active Stripe subscription at period end. Idempotent — a
   * second call before the period ends just re-confirms the cancellation.
   */
  async cancelAtPeriodEnd(tenantId: string): Promise<BillingSnapshot> {
    await this.assertBillingEnabled();
    const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException('No subscription on file.');
    if (sub.billingMode !== 'stripe') {
      throw new BadRequestException(
        'Your library is billed manually — to end it, contact us so we can stop renewing.',
      );
    }
    if (!sub.stripeSubscriptionId) {
      throw new BadRequestException(
        "There's no active paid subscription to cancel — you're already on the free plan.",
      );
    }
    await this.stripe.cancelSubscriptionAtPeriodEnd(sub.stripeSubscriptionId);
    await controlDb.subscription.update({
      where: { tenantId },
      data: { cancelAtPeriodEnd: true },
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  async resumeSubscription(tenantId: string): Promise<BillingSnapshot> {
    await this.assertBillingEnabled();
    const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException('No subscription on file.');
    if (sub.billingMode !== 'stripe' || !sub.stripeSubscriptionId) {
      throw new BadRequestException("There's no scheduled cancellation to resume.");
    }
    if (!sub.cancelAtPeriodEnd) return this.getSnapshot(tenantId);
    await this.stripe.resumeSubscription(sub.stripeSubscriptionId);
    await controlDb.subscription.update({
      where: { tenantId },
      data: { cancelAtPeriodEnd: false, canceledAt: null },
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  // -------------------------------------------------------------------------
  // Admin / webhook flows — same shape so EffectivePlanService cache + audit
  // happen exactly once per state change.
  // -------------------------------------------------------------------------

  /**
   * Replace the tenant's plan without going through Stripe. Used by admin
   * tooling (set a tenant onto an on-prem plan) and by webhook handlers
   * that resolve the new plan from a Stripe price id.
   */
  async applyAdminPlanChange(
    tenantId: string,
    input: { planSlug: string },
  ): Promise<BillingSnapshot> {
    const plan = await controlDb.plan.findUnique({ where: { slug: input.planSlug } });
    if (!plan || plan.archivedAt) throw new NotFoundException(`Plan "${input.planSlug}" missing.`);
    await controlDb.subscription.update({
      where: { tenantId },
      data: {
        planId: plan.id,
        billingMode: plan.billingMode,
        status: 'active',
        graceUntil: null,
        // We don't touch stripeSubscriptionId here — if it's set, Stripe is
        // still the source of truth for that subscription's lifecycle.
      },
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  /** Manual billing: extend `paidUntil`. Status flips back to active. */
  async applyManualPayment(
    tenantId: string,
    input: { paidUntil: string },
  ): Promise<BillingSnapshot> {
    const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException('No subscription on file.');
    if (sub.billingMode !== 'manual') {
      throw new BadRequestException(
        'Manual paid-until only applies to manually-billed plans. Use Stripe for stripe-billed tenants.',
      );
    }
    const paidUntil = new Date(input.paidUntil);
    if (Number.isNaN(paidUntil.getTime())) {
      throw new BadRequestException('paidUntil must be an ISO date string.');
    }
    await controlDb.subscription.update({
      where: { tenantId },
      data: { status: 'active', paidUntil, graceUntil: null },
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  /**
   * Mark a payment as failed. Flips status to `past_due` and arms a grace
   * window N days out. Called from the `invoice.payment_failed` webhook;
   * EffectivePlanService keeps the paid plan active until `graceUntil`.
   *
   * billing-new: the grace window is anchored to the FIRST failure, not to
   * "now" on every redelivery. Stripe's dunning retries deliver
   * `invoice.payment_failed` repeatedly for a chronically-failing card; if we
   * recomputed `now + N days` each time, the deadline would slide forward
   * forever and the tenant would keep paid features well past the intended
   * single N-day window. So we only arm `graceUntil` when transitioning INTO
   * past_due (or when no future grace window is already set), and otherwise
   * leave the existing deadline untouched.
   */
  async recordPaymentFailure(tenantId: string): Promise<BillingSnapshot> {
    const env = loadEnv();
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      select: { status: true, graceUntil: true },
    });
    if (!sub) throw new NotFoundException('No subscription on file.');
    const now = Date.now();
    // Keep an already-running grace deadline; only arm a fresh one on the
    // first failure (or if a stale/elapsed window left graceUntil unset).
    const graceStillRunning =
      sub.status === 'past_due' && sub.graceUntil != null && sub.graceUntil.getTime() > now;
    const graceUntil = graceStillRunning
      ? sub.graceUntil
      : new Date(now + env.billingGracePeriodDays * MS_PER_DAY);
    await controlDb.subscription.update({
      where: { tenantId },
      data: { status: 'past_due', graceUntil },
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  /** Successful payment received. Clears grace and re-arms the subscription. */
  async recordPaymentSuccess(tenantId: string): Promise<BillingSnapshot> {
    await controlDb.subscription.update({
      where: { tenantId },
      data: { status: 'active', graceUntil: null },
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  // -------------------------------------------------------------------------
  // Webhook-side sync from Stripe
  // -------------------------------------------------------------------------

  /**
   * Sync a `customer.subscription.created|updated` payload into our local
   * `subscriptions` row. Resolves the local plan from `items[0].price.id`.
   */
  async syncStripeSubscription(payload: StripeSubscriptionShape): Promise<void> {
    const billing = await controlDb.billingAccount.findFirst({
      where: { stripeCustomerId: payload.customer },
      select: { tenantId: true },
    });
    if (!billing) {
      this.logger.warn(`Webhook: no BillingAccount for customer ${payload.customer}`);
      return;
    }
    const priceId = payload.items.data[0]?.price.id;
    if (!priceId) {
      this.logger.warn(`Webhook: subscription ${payload.id} has no price`);
      return;
    }
    const plan = await controlDb.plan.findUnique({ where: { stripePriceId: priceId } });
    if (!plan) {
      this.logger.warn(`Webhook: no Plan for stripePriceId ${priceId}`);
      return;
    }
    const mapStatus: Partial<Record<string, SubscriptionStatus>> = {
      active: 'active',
      trialing: 'trialing',
      past_due: 'past_due',
      canceled: 'canceled',
      paused: 'paused',
      // incomplete / incomplete_expired / unpaid all map to past_due so we
      // keep the local enum tight — the source-of-truth is still Stripe.
      incomplete: 'past_due',
      incomplete_expired: 'canceled',
      unpaid: 'past_due',
    };
    const localStatus = mapStatus[payload.status] ?? 'past_due';
    // The billing period lives on the SubscriptionItem as of Stripe API
    // `basil` (2025-03-31); fall back to the legacy top-level fields for an
    // account pinned to an older version. NEVER build a Date from undefined —
    // `new Date(undefined * 1000)` is an Invalid Date and Prisma throws on it,
    // which would fail every real subscription webhook.
    const item = payload.items.data[0];
    const periodStart = item?.current_period_start ?? payload.current_period_start;
    const periodEnd = item?.current_period_end ?? payload.current_period_end;
    const nextPeriodStart = epochSecsToDate(periodStart);

    const existing = await controlDb.subscription.findUnique({
      where: { tenantId: billing.tenantId },
      select: {
        status: true,
        graceUntil: true,
        stripeSubscriptionId: true,
        currentPeriodStart: true,
      },
    });

    // STRIPE-RETRY-STALE-REPLAY: refuse to apply an out-of-order event for the
    // SAME subscription. Stripe's `current_period_start` is monotonic across a
    // subscription's lifecycle, so a captured payload whose period starts
    // strictly before the one we already persisted is a stale replay (the
    // retry sweep re-running an old `payloadJson`, or webhooks arriving out of
    // order). Applying it would revert plan/status/grace to older state. We
    // only guard when both ids match and both periods are known — a genuinely
    // new subscription (different id) or a first-ever sync (no persisted
    // period) always applies.
    if (
      existing?.stripeSubscriptionId === payload.id &&
      existing.currentPeriodStart != null &&
      nextPeriodStart != null &&
      nextPeriodStart.getTime() < existing.currentPeriodStart.getTime()
    ) {
      this.logger.warn(
        `Webhook: ignoring stale subscription event for ${payload.id} ` +
          `(period start ${nextPeriodStart.toISOString()} < persisted ${existing.currentPeriodStart.toISOString()})`,
      );
      return;
    }

    await controlDb.subscription.update({
      where: { tenantId: billing.tenantId },
      data: {
        planId: plan.id,
        billingMode: 'stripe',
        status: localStatus,
        stripeSubscriptionId: payload.id,
        currentPeriodStart: nextPeriodStart,
        currentPeriodEnd: epochSecsToDate(periodEnd),
        cancelAtPeriodEnd: payload.cancel_at_period_end,
        canceledAt: epochSecsToDate(payload.canceled_at),
        // Stripe's own retry policy moved us to past_due; arm the grace
        // window so feature access continues until the deadline. billing-new:
        // anchor the deadline to the first failure — if we're already past_due
        // with a future grace window, keep it instead of sliding it forward on
        // every dunning redelivery.
        graceUntil:
          localStatus === 'past_due'
            ? existing?.status === 'past_due' &&
              existing.graceUntil != null &&
              existing.graceUntil.getTime() > Date.now()
              ? existing.graceUntil
              : new Date(Date.now() + loadEnv().billingGracePeriodDays * MS_PER_DAY)
            : null,
      },
    });
    // An active Stripe subscription is an explicit choice — stamp it if it
    // wasn't already (covers subs created outside our checkout flow, e.g. the
    // Stripe dashboard). `updateMany` keeps the original timestamp intact.
    await controlDb.subscription.updateMany({
      where: { tenantId: billing.tenantId, planSelectedAt: null },
      data: { planSelectedAt: new Date() },
    });
    await this.effectivePlan.invalidate(billing.tenantId);
  }

  /** Stripe killed the subscription (final cancellation). Downgrade to Starter. */
  async handleStripeSubscriptionDeleted(payload: StripeSubscriptionShape): Promise<void> {
    const billing = await controlDb.billingAccount.findFirst({
      where: { stripeCustomerId: payload.customer },
      select: { tenantId: true },
    });
    if (!billing) return;
    const starter = await controlDb.plan.findUnique({ where: { slug: 'starter' } });
    if (!starter) {
      this.logger.error('starter plan missing — webhook downgrade aborted');
      return;
    }
    await controlDb.subscription.update({
      where: { tenantId: billing.tenantId },
      data: {
        planId: starter.id,
        billingMode: starter.billingMode,
        status: 'canceled',
        stripeSubscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        graceUntil: null,
        cancelAtPeriodEnd: false,
        canceledAt: epochSecsToDate(payload.canceled_at) ?? new Date(),
      },
    });
    await this.effectivePlan.invalidate(billing.tenantId);
  }

  async handleStripeInvoicePaid(payload: StripeInvoiceShape): Promise<void> {
    const tenantId = await this.tenantForSubscriptionInvoice(payload);
    if (!tenantId) return;
    await this.recordPaymentSuccess(tenantId);
  }

  async handleStripeInvoiceFailed(payload: StripeInvoiceShape): Promise<void> {
    const tenantId = await this.tenantForSubscriptionInvoice(payload);
    if (!tenantId) return;
    await this.recordPaymentFailure(tenantId);
  }

  /**
   * Resolve the tenant an invoice event should mutate, or null to skip.
   *
   * BILL-2: an invoice event must only drive subscription status when it is
   * for THE subscription we track. A one-off invoice (`payload.subscription`
   * null) or an invoice for a different/stale subscription on the same
   * customer must not flip status to active/past_due or arm a grace window —
   * doing so could resurrect a canceled tenant's access or label a free/
   * canceled row "active". Status is driven by `customer.subscription.updated`
   * events; invoice events are only a grace-window signal for the subscription
   * they actually belong to.
   */
  private async tenantForSubscriptionInvoice(payload: StripeInvoiceShape): Promise<string | null> {
    if (!payload.subscription) return null;
    const billing = await controlDb.billingAccount.findFirst({
      where: { stripeCustomerId: payload.customer },
      select: { tenantId: true },
    });
    if (!billing) return null;
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId: billing.tenantId },
      select: { stripeSubscriptionId: true },
    });
    if (!sub?.stripeSubscriptionId || sub.stripeSubscriptionId !== payload.subscription) {
      return null;
    }
    return billing.tenantId;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Get-or-create the tenant's Stripe Customer. The id is cached on the
   * `billing_accounts` row so we never create duplicates.
   */
  private async ensureStripeCustomer(tenantId: string): Promise<string> {
    const account = await controlDb.billingAccount.findUnique({ where: { tenantId } });
    if (account?.stripeCustomerId) return account.stripeCustomerId;
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, primaryEmail: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    const { customerId } = await this.stripe.createCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      email: tenant.primaryEmail ?? `billing@${tenant.slug}.libriant.com`,
      name: tenant.name,
    });
    if (account) {
      await controlDb.billingAccount.update({
        where: { tenantId },
        data: { stripeCustomerId: customerId },
      });
    } else {
      await controlDb.billingAccount.create({
        data: {
          tenantId,
          stripeCustomerId: customerId,
          billingEmail: tenant.primaryEmail ?? `billing@${tenant.slug}.libriant.com`,
          billingName: tenant.name,
        },
      });
    }
    return customerId;
  }
}

// Re-export so callers in adjacent files don't have to import from
// db-control directly.
export type { Subscription, BillingAccount, Plan };
