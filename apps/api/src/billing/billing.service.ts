import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { recordAdminAudit, type AdminAuditActor } from '../platform/admin-audit.js';
import { RedisService } from '../platform/redis.service.js';
import {
  STRIPE_DRIVER,
  STRIPE_LIVE_STATUSES,
  type StripeCheckoutSessionShape,
  type StripeDriver,
  type StripeInvoiceShape,
  type StripeSubscriptionShape,
  type StripeSubscriptionState,
} from './stripe-driver.js';
import { buildWebReturnUrl, resolveWebLocale } from './return-url.js';

const MS_PER_DAY = 86_400_000;

/**
 * Redis key holding the Checkout session a tenant currently has open.
 *
 * billing-03 (duplicate-purchase half). The old guard keyed on our own
 * `stripeSubscriptionId`, so it did nothing at all while that was still null —
 * exactly the state a brand-new library is in. Executed path: open billing,
 * click Community (session A), press Back, click Municipal (id still null, so
 * session B), complete both. Two live Stripe subscriptions, two charges, and
 * our row only ever remembered the newer id, so cancelling from the app
 * stopped one of them. A subscription does not exist in Stripe until a session
 * COMPLETES, so nothing on Stripe's side can be consulted to close this
 * window; the only place the two clicks meet is here.
 */
const CHECKOUT_MARKER_KEY = (tenantId: string) => `billing:checkout:${tenantId}`;
/**
 * Matches Stripe's default Checkout session lifetime (24h). The marker is not
 * a lock the user waits out — a second click for a DIFFERENT plan expires the
 * session it names and opens a new one — so a long TTL costs nothing and a
 * short one would reopen the window it exists to close.
 */
const CHECKOUT_MARKER_TTL_SEC = 24 * 60 * 60;
/** Written between claiming the marker and having a session id to put in it. */
const CHECKOUT_MARKER_PENDING = 'pending';
/**
 * TTL for that placeholder. Short on purpose: it is held only across one
 * Stripe round trip, and a process that dies mid-create must not leave the
 * tenant unable to buy anything for the marker's full 24h. A minute of
 * "try again in a moment" is the whole cost of a crash here.
 */
const CHECKOUT_CLAIM_TTL_SEC = 60;

type CheckoutMarker = { sessionId: string; priceId: string; url: string };

/**
 * Read a stored marker. Returns null for the placeholder, for a missing key,
 * and for anything unparsable — all three mean "we do not know of a reusable
 * session", which is the safe reading in every caller.
 */
function parseCheckoutMarker(raw: string | null): CheckoutMarker | null {
  if (!raw || raw === CHECKOUT_MARKER_PENDING) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CheckoutMarker>;
    if (!parsed.sessionId || !parsed.priceId || !parsed.url) return null;
    return { sessionId: parsed.sessionId, priceId: parsed.priceId, url: parsed.url };
  } catch {
    return null;
  }
}

/**
 * Convert a Stripe epoch-seconds timestamp to a Date, or null when absent.
 * Guards against `new Date(undefined * 1000)` → Invalid Date, which Prisma
 * rejects when writing a DateTime column.
 */
function epochSecsToDate(secs: number | null | undefined): Date | null {
  return typeof secs === 'number' && Number.isFinite(secs) ? new Date(secs * 1000) : null;
}

/**
 * What `startCheckout` did. Two very different things share the entry point
 * because the caller only ever redirects to `url`:
 *
 *   - `checkout`     — a Stripe Checkout session for the library's FIRST paid
 *                      subscription; `url` is Stripe's.
 *   - `plan_changed` — the library already had a live subscription and it was
 *                      re-priced in place (billing-03), so there is no session
 *                      and `url` just sends the browser back to billing.
 */
export type StartCheckoutResult = {
  url: string;
  sessionId: string | null;
  outcome: 'checkout' | 'plan_changed';
};

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
  /**
   * Driver kind so the UI can decide whether to show "Open portal".
   *
   * The `disabled` posture (the shipped production default, where no Stripe
   * driver is loaded at all) reports `fake` here: this field exists only to
   * tell the UI "there is no real Stripe behind this", which is true of both.
   * Widening the union would need a matching change in `apps/web/lib/api.ts`,
   * which declares its own copy of this type.
   */
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
    /**
     * Holds the in-flight-Checkout marker (billing-03). OPTIONAL because the
     * Stripe retry sweep (`jobs/stripe-retry.job.ts`) constructs this service
     * by hand to replay webhook events, and that path never touches the
     * purchase flow. `startCheckout` refuses outright rather than proceeding
     * without it — see `claimCheckoutMarker`.
     */
    @Optional() @Inject(RedisService) private readonly redis?: RedisService,
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
      /** Null when the plan is not offered annually (the free tier). */
      annualPriceCents: number | null;
      currency: string;
      hasStripePrice: boolean;
      hasStripeAnnualPrice: boolean;
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
      annualPriceCents: p.annualPriceCents,
      currency: p.currency,
      hasStripePrice: !!p.stripePriceId,
      hasStripeAnnualPrice: !!p.stripeAnnualPriceId,
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

  /**
   * Whether this tenant is entitled to the DESKTOP app. The rule:
   *   - subscriptions OFF globally → everyone's entitled (free-for-all launch);
   *   - subscriptions ON           → only a PAID plan (`monthlyPriceCents > 0`)
   *     in good standing: `active`/`trialing`, or `past_due` still inside its
   *     grace window. Free-plan, canceled, paused, or lapsed tenants are blocked.
   * Used both to gate the in-app download and to hard-block the desktop shell.
   */
  async getDesktopAccess(
    tenantId: string,
  ): Promise<{ allowed: boolean; reason: string; billingEnabled: boolean }> {
    if (!(await this.settings.billingEnabled())) {
      return { allowed: true, reason: 'free-for-all', billingEnabled: false };
    }
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    });
    if (!sub) return { allowed: false, reason: 'no-subscription', billingEnabled: true };
    if (sub.plan.monthlyPriceCents <= 0) {
      return { allowed: false, reason: 'free-plan', billingEnabled: true };
    }
    const inGrace = sub.graceUntil != null && sub.graceUntil.getTime() > Date.now();
    const goodStanding =
      sub.status === 'active' ||
      sub.status === 'trialing' ||
      (sub.status === 'past_due' && inGrace);
    return goodStanding
      ? { allowed: true, reason: sub.status, billingEnabled: true }
      : { allowed: false, reason: sub.status, billingEnabled: true };
  }

  // -------------------------------------------------------------------------
  // Stripe-mode self-serve flows
  // -------------------------------------------------------------------------

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

  /**
   * Put the library on `planSlug`, by whichever route is correct for where it
   * stands today: a Stripe Checkout session when there is nothing to change,
   * or an in-place re-price when there already is a live subscription.
   *
   * billing-03: this used to be Checkout unconditionally. Checkout in
   * `mode:'subscription'` can only ever CREATE a subscription, so an upgrade
   * opened a second one and left the first billing; `syncStripeSubscription`
   * then overwrote `stripeSubscriptionId`, erasing the only pointer we had to
   * the abandoned one. A library upgrading Community → Municipal paid €39 AND
   * €79 every month, and cancelling from the app stopped only the newer of the
   * two.
   */
  async startCheckout(
    tenantId: string,
    input: { planSlug: string; interval?: 'month' | 'year'; returnPath?: string },
  ): Promise<StartCheckoutResult> {
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
    const wantsAnnual = input.interval === 'year';
    const priceId = wantsAnnual ? plan.stripeAnnualPriceId : plan.stripePriceId;
    if (!priceId) {
      throw new BadRequestException(
        wantsAnnual
          ? `Plan "${input.planSlug}" is not offered annually.`
          : `Plan "${input.planSlug}" has no Stripe price configured. Ask an admin to fix the plan.`,
      );
    }
    if (plan.id === sub.planId && sub.status === 'active') {
      throw new BadRequestException(`You're already on the ${plan.name} plan.`);
    }

    // billing-01: every one of these three used to be built by hand as
    // `${base}/t/<slug>/billing`, which is a 404 — the web app's only billing
    // route carries a mandatory locale segment. `buildWebReturnUrl` is now the
    // single place that knows the route shape; see return-url.ts.
    const urlFor = (query?: string): string =>
      buildWebReturnUrl({
        base: env.billingReturnUrl,
        locale: resolveWebLocale(sub.tenant.defaultLocale),
        slug: sub.tenant.slug,
        returnPath: input.returnPath,
        query,
      });
    const successUrl = urlFor('checkout=success');
    const cancelUrl = urlFor('checkout=cancelled');
    // The re-price branch below returns the BARE billing path, not
    // `?checkout=success`. Nothing in apps/web reads that parameter — no page,
    // no layout — so it was a confirmation we promised the browser and never
    // rendered. Stripe's own redirect still carries it (it is Stripe that
    // appends the query to `successUrl`), so the day apps/web grows a handler
    // both branches light up together. See the package report for what the web
    // side would need to show "your plan was changed".
    const planChangedUrl = urlFor();

    // Picking a paid plan counts as making a choice — stamp it now so the
    // library isn't bounced back to the chooser in the window between the
    // Stripe redirect and the confirming webhook. (If they abandon checkout,
    // they simply stay on their current free plan, un-gated.)
    if (!sub.planSelectedAt) {
      await controlDb.subscription.update({
        where: { tenantId },
        data: { planSelectedAt: new Date() },
      });
    }

    // A live subscription is CHANGED, never re-bought — but "live" is a
    // question only Stripe can answer. See `resolveLiveSubscription`.
    const live = await this.resolveLiveSubscription(tenantId, sub.stripeSubscriptionId);
    if (live) {
      await this.stripe.changeSubscriptionPrice({
        subscriptionId: live.id,
        priceId,
      });
      this.logger.log(
        `Re-priced ${live.id} onto ${plan.slug} (${priceId}) for tenant ${tenantId}.`,
      );
      // A re-price cannot produce a second subscription, so any Checkout
      // session still hanging around for this tenant is now stale — and
      // completing it WOULD produce one. Drop it.
      await this.discardCheckoutMarker(tenantId).catch(() => undefined);
      // Our own row moves when `customer.subscription.updated` arrives — the
      // same path a Dashboard-side change takes. The browser lands back on
      // billing meanwhile, exactly as it would from Stripe's success redirect.
      return { url: planChangedUrl, sessionId: null, outcome: 'plan_changed' };
    }

    const customerId = await this.ensureStripeCustomer(tenantId);
    const session = await this.openCheckoutSession(tenantId, priceId, {
      customerId,
      successUrl,
      cancelUrl,
    });
    return { ...session, outcome: 'checkout' };
  }

  /**
   * Decide whether the tenant has a subscription that must be RE-PRICED rather
   * than re-bought, asking Stripe rather than trusting our own row.
   *
   * Two failures this replaces, both executed by the auditor:
   *
   *   1. HARD PURCHASE LOCKOUT. The test was `stripeSubscriptionId != null &&
   *      status !== 'canceled'`, evaluated entirely against our own row. Any
   *      tenant whose row still carried an id could therefore never reach
   *      Checkout again, even when that subscription was long gone in Stripe —
   *      `changeSubscriptionPrice` then failed forever on a dead id. A single
   *      missed `customer.subscription.deleted` webhook bricked purchasing for
   *      that library permanently, with no operator recovery short of a manual
   *      SQL update.
   *   2. SILENT NO-CHARGE "SUCCESS". Stripe's `incomplete` (first payment never
   *      completed) and `unpaid` (dunning exhausted) both collapse into our
   *      local `past_due`, and `past_due` reads as live — so a subscription
   *      nobody ever paid for got RE-PRICED instead of re-purchased. The
   *      library saw a plan change succeed and was never charged.
   *
   * When Stripe says the subscription is gone we clear the dead pointer, so
   * the next read of the row does not lie either.
   */
  private async resolveLiveSubscription(
    tenantId: string,
    subscriptionId: string | null,
  ): Promise<StripeSubscriptionState | null> {
    if (!subscriptionId) return null;

    let state: StripeSubscriptionState | null;
    try {
      state = await this.stripe.getSubscription(subscriptionId);
    } catch (err) {
      // FAIL CLOSED, deliberately. "Stripe did not answer" is not "there is no
      // subscription": guessing the latter opens a SECOND live subscription
      // and double-charges a real library every month until someone notices.
      // Refusing costs the operator a retry ten seconds later.
      this.logger.error(
        `Could not confirm Stripe subscription ${subscriptionId} for tenant ${tenantId}: ` +
          `${(err as Error).message}. Refusing to open a second subscription.`,
      );
      throw new ServiceUnavailableException(
        'We could not reach Stripe to check your current subscription. ' +
          'Nothing has changed — please try again in a moment.',
      );
    }

    if (state && STRIPE_LIVE_STATUSES.has(state.status)) return state;

    // Not live. Whatever the row said, this id can no longer be re-priced.
    const detail = state ? `status ${state.status}` : 'no such subscription';
    this.logger[state?.status === 'unpaid' ? 'error' : 'warn'](
      `Tenant ${tenantId} still pointed at Stripe subscription ${subscriptionId} (${detail}) — ` +
        'clearing the pointer and treating this as a fresh purchase.' +
        (state?.status === 'unpaid'
          ? ' The unpaid subscription still exists in Stripe; cancel it there so it does not linger.'
          : ''),
    );
    // Only clear the pointer we actually looked up: a concurrent webhook may
    // have moved the row onto a different, genuinely live subscription while
    // we were talking to Stripe, and blanking that would lose the new id.
    await controlDb.subscription
      .updateMany({
        where: { tenantId, stripeSubscriptionId: subscriptionId },
        data: { stripeSubscriptionId: null },
      })
      .catch((err: Error) => {
        this.logger.warn(`Could not clear stale stripeSubscriptionId: ${err.message}`);
      });
    return null;
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
    // billing-01: the Portal's return_url had the identical missing-locale
    // defect as Checkout's success/cancel URLs — a library that opened the
    // portal to update a card was dropped on a 404 on the way back.
    return this.stripe.createBillingPortalSession({
      customerId,
      returnUrl: buildWebReturnUrl({
        base: env.billingReturnUrl,
        locale: resolveWebLocale(sub.tenant.defaultLocale),
        slug: sub.tenant.slug,
        returnPath: input.returnPath,
      }),
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
    actor: AdminAuditActor,
  ): Promise<BillingSnapshot> {
    const plan = await controlDb.plan.findUnique({ where: { slug: input.planSlug } });
    if (!plan || plan.archivedAt) throw new NotFoundException(`Plan "${input.planSlug}" missing.`);
    // Snapshot the prior plan/status for the audit diff before we overwrite it.
    const before = await controlDb.subscription.findUnique({
      where: { tenantId },
      select: { planId: true, billingMode: true, status: true, plan: { select: { slug: true } } },
    });
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
    await recordAdminAudit(actor, {
      tenantId,
      action: 'subscription.changed',
      targetType: 'subscription',
      targetId: tenantId,
      before: before
        ? {
            planSlug: before.plan?.slug ?? null,
            planId: before.planId,
            billingMode: before.billingMode,
            status: before.status,
          }
        : undefined,
      after: {
        planSlug: plan.slug,
        planId: plan.id,
        billingMode: plan.billingMode,
        status: 'active',
      },
    });
    return this.getSnapshot(tenantId);
  }

  /** Manual billing: extend `paidUntil`. Status flips back to active. */
  async applyManualPayment(
    tenantId: string,
    input: { paidUntil: string },
    actor: AdminAuditActor,
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
    await recordAdminAudit(actor, {
      tenantId,
      action: 'subscription.paid_until_set',
      targetType: 'subscription',
      targetId: tenantId,
      before: { status: sub.status, paidUntil: sub.paidUntil?.toISOString() ?? null },
      after: { status: 'active', paidUntil: paidUntil.toISOString() },
    });
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
    // A plan now has TWO Stripe Prices — monthly and annual — because a Stripe
    // Price is immutable and each interval is its own object. An annual
    // subscriber's webhook carries the annual id, so matching only the monthly
    // one would leave their subscription row permanently stale while logging a
    // warning nobody reads.
    const plan = await controlDb.plan.findFirst({
      where: { OR: [{ stripePriceId: priceId }, { stripeAnnualPriceId: priceId }] },
    });
    if (!plan) {
      this.logger.warn(`Webhook: no Plan for Stripe price ${priceId}`);
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

    // Events about a subscription that is NOT the one we track.
    //
    // Two separate defects lived in the old single condition, which required
    // `localStatus !== 'canceled'` before it would even speak up:
    //
    //   a) It went SILENT whenever the incoming event was the cancellation of
    //      a different subscription — the one case where the operator most
    //      needs to know which of a customer's two subscriptions just died.
    //   b) Worse than silent: it then APPLIED that event. A terminal event for
    //      a foreign subscription would overwrite the plan, status and
    //      subscription id of a tenant who is actively paying on the one we do
    //      track, cancelling a live customer's access from a webhook about
    //      something else. `handleStripeSubscriptionDeleted` has guarded
    //      against exactly this since A6-01; the update path never did.
    const tracked = existing?.stripeSubscriptionId ?? null;
    if (tracked != null && tracked !== payload.id) {
      if (!STRIPE_LIVE_STATUSES.has(payload.status)) {
        this.logger.warn(
          `Webhook: ignoring ${payload.status} event for foreign subscription ${payload.id} ` +
            `(tenant ${billing.tenantId} is on ${tracked}). Applying it would have downgraded a ` +
            'subscription this event says nothing about.',
        );
        return;
      }
      if (existing?.status !== 'canceled') {
        // Both are live. We are about to overwrite `stripeSubscriptionId`, the
        // ONLY record we keep of the previous one — after this write nothing
        // in the product can see it and cancelling reaches only the newest.
        // `startCheckout` can no longer produce this, but a Dashboard-created
        // subscription still can.
        this.logger.error(
          `Tenant ${billing.tenantId} has TWO live Stripe subscriptions: ${tracked} ` +
            `(ours until now) and ${payload.id} (this event). The older one keeps billing and is about to ` +
            'disappear from our records — cancel it in Stripe and refund the overlap.',
        );
      }
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
        //
        // Keyed on STRIPE's status, not our collapsed local one. `incomplete`
        // and `unpaid` also map to local `past_due`, and granting either of
        // them a grace window hands out N days of paid features on a
        // subscription whose first payment never completed (`incomplete`) or
        // whose dunning is already over (`unpaid`). A grace window is for a
        // paying customer whose RENEWAL failed; those two never paid.
        graceUntil:
          payload.status === 'past_due'
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
    // The purchase landed. Any Checkout session still recorded as open for this
    // tenant is now a loaded gun (billing-03) — completing it would open a
    // SECOND subscription. Best-effort: a failure here only means the tenant's
    // next purchase reuses or expires a stale session, both of which the
    // openCheckoutSession path handles.
    await this.discardCheckoutMarker(billing.tenantId).catch(() => undefined);
    await this.effectivePlan.invalidate(billing.tenantId);
  }

  /**
   * `checkout.session.completed`. The `customer.subscription.created` event
   * that follows carries the full state, so there is nothing to sync here —
   * but this is the EARLIEST signal that the tenant's outstanding session has
   * been used up, and dropping the marker now means a user who immediately
   * clicks another plan gets the re-price path rather than a reused session
   * (billing-03).
   */
  async handleCheckoutSessionCompleted(payload: StripeCheckoutSessionShape): Promise<void> {
    const tenantId =
      payload.client_reference_id ??
      (
        await controlDb.billingAccount.findFirst({
          where: { stripeCustomerId: payload.customer },
          select: { tenantId: true },
        })
      )?.tenantId ??
      null;
    if (!tenantId) return;
    await this.discardCheckoutMarker(tenantId).catch((err: Error) => {
      this.logger.warn(`Could not clear the checkout marker for ${tenantId}: ${err.message}`);
    });
  }

  /** Stripe killed the subscription (final cancellation). Downgrade to Starter. */
  async handleStripeSubscriptionDeleted(payload: StripeSubscriptionShape): Promise<void> {
    const billing = await controlDb.billingAccount.findFirst({
      where: { stripeCustomerId: payload.customer },
      select: { tenantId: true },
    });
    if (!billing) return;
    // STRIPE-RETRY-STALE-REPLAY (delete path): only act on a delete for the
    // subscription we currently track. A customer can churn and re-subscribe on
    // a NEW subscription id; the retry sweep (or out-of-order delivery) may then
    // replay the OLD `customer.subscription.deleted`. Without this guard that
    // stale delete would downgrade a tenant who is actively paying on the newer
    // subscription. If we already moved on to a different id, ignore it; if we
    // track none (or the same id), the downgrade is legitimate.
    const existing = await controlDb.subscription.findUnique({
      where: { tenantId: billing.tenantId },
      select: { stripeSubscriptionId: true },
    });
    if (existing?.stripeSubscriptionId != null && existing.stripeSubscriptionId !== payload.id) {
      this.logger.warn(
        `Webhook: ignoring stale subscription.deleted for ${payload.id} ` +
          `(tenant now on ${existing.stripeSubscriptionId})`,
      );
      return;
    }
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
   * Open a Stripe Checkout session for a tenant that has no live subscription,
   * allowing AT MOST ONE completable session per tenant at a time.
   *
   * billing-03 (duplicate-purchase half). Executed path before this existed: a
   * brand-new library opens billing, clicks Community (session A), presses
   * Back, clicks Municipal (our `stripeSubscriptionId` is still null, so the
   * re-price guard does not fire — session B), and completes both. Two live
   * Stripe subscriptions, two monthly charges, and `syncStripeSubscription`
   * overwrites our single `stripeSubscriptionId` column with whichever arrived
   * last, so cancelling from the app only ever stopped one of them.
   *
   * Stripe cannot close this window for us: in `mode:'subscription'` the
   * subscription does not exist until a session COMPLETES, so at the moment of
   * the second click there is nothing to find. The marker below is the only
   * place the two clicks meet.
   *
   * Three outcomes when a session is already outstanding:
   *   - same price  → hand back the SAME session. A double-submit or a reload
   *     must be idempotent, and reusing the session cannot create a second
   *     subscription. It also leaves a half-finished Stripe tab working.
   *   - other price → the user changed their mind. Expire session A at Stripe
   *     first, so only session B can ever complete, then open B.
   *   - mid-create  → another request holds the placeholder; 409, retry.
   */
  private async openCheckoutSession(
    tenantId: string,
    priceId: string,
    urls: { customerId: string; successUrl: string; cancelUrl: string },
  ): Promise<{ url: string; sessionId: string }> {
    const key = CHECKOUT_MARKER_KEY(tenantId);
    const claimed = await this.redisCall(
      (r) => r.client.set(key, CHECKOUT_MARKER_PENDING, 'EX', CHECKOUT_CLAIM_TTL_SEC, 'NX'),
      'claim the checkout slot',
    );

    if (claimed !== 'OK') {
      const raw = await this.redisCall((r) => r.client.get(key), 'read the checkout slot');
      const existing = parseCheckoutMarker(raw);
      if (!existing) {
        // Placeholder still in place: a concurrent request is between "claimed
        // the slot" and "got a session id back from Stripe". Refusing is the
        // point — the alternative is the second subscription.
        throw new ConflictException(
          'A checkout is already being opened for this library. Try again in a moment.',
        );
      }
      if (existing.priceId === priceId) {
        this.logger.log(
          `Reusing open Checkout session ${existing.sessionId} for tenant ${tenantId} ` +
            '(same price, repeat request).',
        );
        return { url: existing.url, sessionId: existing.sessionId };
      }
      // Take the slot back under the short placeholder TTL before touching
      // Stripe, so a crash mid-swap costs a minute rather than a day.
      await this.redisCall(
        (r) => r.client.set(key, CHECKOUT_MARKER_PENDING, 'EX', CHECKOUT_CLAIM_TTL_SEC),
        'reclaim the checkout slot',
      );
      try {
        await this.stripe.expireCheckoutSession(existing.sessionId);
        this.logger.log(
          `Expired Checkout session ${existing.sessionId} for tenant ${tenantId} before opening ` +
            `a new one on ${priceId}.`,
        );
      } catch (err) {
        // Stripe refuses to expire a session that is already COMPLETE — which
        // means a subscription now exists and opening a second session would
        // buy a second one. Fail closed and send them back to a page that will
        // show the subscription they just bought.
        this.logger.error(
          `Could not expire Checkout session ${existing.sessionId} for tenant ${tenantId}: ` +
            `${(err as Error).message}`,
        );
        throw new ConflictException(
          'Your previous checkout may already have completed. Reload the billing page to see ' +
            'your current plan before starting another purchase.',
        );
      }
    }

    let session: { url: string; sessionId: string };
    try {
      session = await this.stripe.createCheckoutSession({
        customerId: urls.customerId,
        priceId,
        successUrl: urls.successUrl,
        cancelUrl: urls.cancelUrl,
        tenantId,
      });
    } catch (err) {
      // No session exists, so nothing is outstanding — release the slot rather
      // than making the user wait out the placeholder to retry.
      await this.discardCheckoutMarker(tenantId).catch(() => undefined);
      throw err;
    }

    const marker: CheckoutMarker = {
      sessionId: session.sessionId,
      priceId,
      url: session.url,
    };
    await this.redisCall(
      (r) => r.client.set(key, JSON.stringify(marker), 'EX', CHECKOUT_MARKER_TTL_SEC),
      'record the open checkout session',
    ).catch(() => undefined);
    return session;
  }

  /**
   * Forget the outstanding Checkout session for a tenant. Called once the
   * purchase has landed (webhook) or become moot (an in-place re-price), so
   * the next purchase is not answered with a stale session.
   */
  async discardCheckoutMarker(tenantId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.client.del(CHECKOUT_MARKER_KEY(tenantId));
  }

  /**
   * Run one Redis command for the duplicate-purchase guard, FAILING CLOSED.
   *
   * The considered trade: with Redis unreachable we cannot tell a first click
   * from a second, and the thing we are guarding is a real library being
   * charged twice a month, indefinitely, for a mistake it cannot see. A 503
   * that says "try again" is recoverable in seconds; a duplicate live
   * subscription needs a human, a refund and an apology. (Note the webhook
   * route's replay guard resolves the same question the other way — but only
   * because it has a DURABLE second guard in Postgres to fall back on. This
   * path has no second guard, which is exactly why it refuses.)
   */
  private async redisCall<T>(fn: (redis: RedisService) => Promise<T>, what: string): Promise<T> {
    if (!this.redis) {
      // Only reachable if something constructs BillingService without Redis
      // and then calls the purchase path — today nothing does.
      throw new ServiceUnavailableException(
        'Checkout is unavailable: this process has no Redis connection to guard against ' +
          'duplicate purchases.',
      );
    }
    try {
      return await fn(this.redis);
    } catch (err) {
      this.logger.error(`Redis unavailable, could not ${what}: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'Checkout is temporarily unavailable. Nothing has been charged — please try again in a moment.',
      );
    }
  }

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
