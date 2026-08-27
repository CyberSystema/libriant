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
  type StripeEventContext,
  type StripeInvoiceShape,
  type StripeSubscriptionShape,
  type StripeSubscriptionState,
} from './stripe-driver.js';
import { buildWebReturnUrl, resolveWebLocale } from './return-url.js';
import { isTrustedLocalNodeEnv, resolveStripeDriverKind } from './stripe-driver-kind.js';
import {
  isUsableStripePriceId,
  stripePriceProblems,
  unusablePriceIdProblem,
  type PriceLookupOutcome,
} from './plan-price-check.js';

const MS_PER_DAY = 86_400_000;

/**
 * billing-10. `isUsableStripePriceId` and the per-column comparisons used to
 * live in this file. They moved to `plan-price-check.ts` when the write-time
 * guard (`PlanPriceWriteInterceptor`) had to make the SAME judgements: a write
 * guard and an after-the-fact report that disagree are worse than either alone,
 * because the operator fixes the plan until the report goes green and the save
 * still refuses. Re-exported here because half a dozen call sites — and the
 * existing specs — import it from this module.
 */
export { isUsableStripePriceId } from './plan-price-check.js';

/**
 * Redis key holding `event.created` (ms) of the newest subscription event we
 * have APPLIED for one Stripe subscription id — the stale-replay ordering key
 * (billing-06).
 *
 * WHY REDIS AND NOT THE ROW: the natural home is a column on `subscriptions`,
 * which this package is not allowed to add. Losing the key degrades the guard
 * to the pre-existing period-start comparison, i.e. to today's behaviour —
 * never to something worse — so a Redis flush costs protection, not
 * correctness.
 */
const SUB_EVENT_KEY = (subscriptionId: string) => `billing:subevent:${subscriptionId}`;

/**
 * Control-plane advisory-lock key serialising everything that read-modify-writes
 * one tenant's `subscriptions` row (data-integrity-09).
 *
 * The webhook controller dedupes on `event.id`, so it serialises RETRIES of one
 * event and nothing else. Two DISTINCT events for the same library — a
 * `customer.subscription.updated` and an `invoice.payment_succeeded` arriving
 * together, which is exactly how Stripe delivers a recovered dunning — used to
 * run concurrently through a read, a derivation and a write with no transaction
 * and no row lock between them. The loser's write silently reverted the
 * winner's: a library that had just paid left marked `past_due`, or a
 * delinquent one left with an open grace window.
 *
 * Same pattern StaffService.create already uses against the control plane, on
 * the same connection pool.
 */
const BILLING_LOCK_KEY = (tenantId: string) => `billing:${tenantId}`;
/**
 * Long enough to outlast every Stripe redelivery window (3 days) and the retry
 * sweep's give-up budget (24h) many times over, short enough that dead
 * subscriptions do not accumulate keys forever.
 */
const SUB_EVENT_TTL_SEC = 90 * 24 * 60 * 60;

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
 * COMPLETES, so while BOTH sessions are still open there is nothing on Stripe's
 * side to consult: the only place those two clicks meet is here.
 *
 * That is also the exact limit of what this marker can do, and round 2 of the
 * finding lived just past it — once session A HAS completed there is something
 * to consult, and the guard for that window is `adoptCustomerSubscription`,
 * not this key.
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
 * The `graceUntil` a `customer.subscription.*` event should leave behind, given
 * the subscription row as it stands.
 *
 * Extracted because it is a pure function OF THE ROW, and that is exactly why
 * data-integrity-09 mattered: it has to be evaluated against the row the write
 * is about to overwrite, read inside the same transaction, not against a copy
 * fetched four round trips earlier that a concurrent event has since moved.
 */
function resolveGraceUntil(
  stripeStatus: string,
  row: { status: SubscriptionStatus; graceUntil: Date | null } | null,
): Date | null {
  if (stripeStatus !== 'past_due') return null;
  const running =
    row?.status === 'past_due' && row.graceUntil != null && row.graceUntil.getTime() > Date.now();
  return running
    ? row.graceUntil
    : new Date(Date.now() + loadEnv().billingGracePeriodDays * MS_PER_DAY);
}

/**
 * Stripe `billing_reason` values that can only appear on an invoice raised for
 * a subscription that ALREADY EXISTS — i.e. one whose first invoice settled.
 *
 * billing-05. The grace window keeps the full paid tier alive for a week, and
 * it is meant for an established payer whose card lapsed at renewal. The one
 * reason that is NOT in this set — `subscription_create` — is the first invoice
 * of a brand-new subscription, whose failure means nobody has ever paid us.
 */
const SETTLED_INVOICE_REASONS: ReadonlySet<string> = new Set([
  'subscription_cycle', // a renewal
  'subscription_update', // a proration after a plan change
  'subscription_threshold', // usage threshold billing
]);

/**
 * Does this failed invoice prove the library has paid us before?
 *
 * Answers FALSE for anything it cannot read — an absent or unrecognised
 * `billing_reason`, a `subscription_create`. That direction is deliberate:
 * being wrong towards "no grace" costs a paying library up to a week of
 * gated features it can end by paying, while being wrong towards "grace"
 * hands the top tier to a subscription that never settled a single invoice,
 * which is the finding.
 */
function hasSettledInvoiceBefore(payload: StripeInvoiceShape): boolean {
  return typeof payload.billing_reason === 'string'
    ? SETTLED_INVOICE_REASONS.has(payload.billing_reason)
    : false;
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
     * Holds the in-flight-Checkout marker (billing-03).
     *
     * Still typed optional so a hand-built instance compiles, but EVERY caller
     * now passes one — including the Stripe retry sweep, which replays
     * `checkout.session.completed` and would otherwise leave a spent Checkout
     * session recorded as still open. The purchase path refuses outright
     * without it (see `redisCall`) rather than quietly running unguarded.
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
      // billing-10: NOT `!!p.stripePriceId`. Every paid plan ships a
      // `price_seed_*` placeholder to satisfy the CHECK constraint, so the
      // non-null test reported every plan bookable on a database where none of
      // them were — which is what made both the UI button and the operator's
      // go-live verification vacuous. See `isUsableStripePriceId`.
      hasStripePrice: isUsableStripePriceId(p.stripePriceId),
      hasStripeAnnualPrice: isUsableStripePriceId(p.stripeAnnualPriceId),
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
   * Record the library's explicit choice of a FREE plan.
   *
   * Two callers, and they are in different situations:
   *   - the full-page chooser, for a library that has never picked anything;
   *   - the billing page's "Switch to Starter" card (billing-11), for a
   *     library that may be PAYING right now.
   *
   * Paid plans never reach here — both surfaces route those to Checkout, and
   * `startCheckout` stamps the choice. Stamping `planSelectedAt` is what clears
   * the forced full-page chooser.
   */
  async selectPlan(tenantId: string, input: { planSlug: string }): Promise<BillingSnapshot> {
    await this.assertBillingEnabled();
    const sub = await controlDb.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException('No subscription on file.');
    const plan = await controlDb.plan.findUnique({ where: { slug: input.planSlug } });
    if (!plan || !plan.isActive || !plan.isPublic || plan.archivedAt) {
      throw new NotFoundException(`Plan "${input.planSlug}" isn't available.`);
    }
    // billing-11, round 2 — the regression round 1's free-plan branch shipped.
    //
    // Giving PlanGrid the free-plan branch it was missing was right; handing a
    // CONTRACTED library a working one-click self-downgrade it never had was
    // not. A tenant on `billingMode='manual'` is there because an operator put
    // it there (`scripts/tenant-create.ts --billing-mode=manual`, or
    // `applyAdminPlanChange`, which since billing-12 leaves
    // `stripeSubscriptionId` null). A null subscription id skips the cancel
    // branch below, so the direct update ran and rewrote `billingMode` from
    // 'manual' to the target plan's 'stripe' — undoing on the tenant side
    // exactly the operator state `handleStripeSubscriptionDeleted` gained a
    // guard to protect, with no admin involvement and no audit row. The
    // launch-offer cohort is provisioned this way, so "switch to Starter"
    // would have thrown away twelve prepaid months in one click.
    //
    // A contract's tier is not a self-serve setting. But this must NOT become a
    // dead end either: with subscriptions on, a manual tenant that has never
    // stamped `planSelectedAt` is held by the full-page chooser until it picks
    // something. So confirming the plan they are already on is allowed — it
    // stamps the choice and changes nothing else — and every actual move is
    // refused. Deliberately placed ABOVE the "that plan requires payment" test
    // so a contract sitting on a paid public plan can still confirm it.
    if (sub.billingMode === 'manual') {
      if (plan.id !== sub.planId) {
        throw new BadRequestException(
          'Your library is billed by contract, not through the app — please contact us to ' +
            'change your plan.',
        );
      }
      await controlDb.subscription.updateMany({
        where: { tenantId, planSelectedAt: null },
        data: { planSelectedAt: new Date() },
      });
      return this.getSnapshot(tenantId);
    }

    if (plan.billingMode === 'stripe' && plan.monthlyPriceCents > 0) {
      throw new BadRequestException(
        'That plan requires payment — start checkout to add a payment method.',
      );
    }

    // billing-11. A library that is PAYING and picks the free tier is asking to
    // stop being charged. Writing planId=starter locally and saying nothing to
    // Stripe would do the opposite of what they asked twice over: the card
    // keeps being charged every month, AND they lose the features they are
    // still paying for the moment the row moves. So this is a cancellation, and
    // it takes the same route the Cancel button does — Stripe stops the renewal
    // at period end, they keep what they paid for until then, and
    // `customer.subscription.deleted` moves the row to Starter when the period
    // actually ends.
    if (sub.stripeSubscriptionId) {
      // Stamp the choice first: the plan itself does not move until the webhook
      // lands, and until it does the tenant must not be bounced to the chooser.
      await controlDb.subscription.updateMany({
        where: { tenantId, planSelectedAt: null },
        data: { planSelectedAt: new Date() },
      });
      // A manually-billed tenant can no longer get this far (the guard above
      // returns first), but cancelAtPeriodEnd refuses one anyway — belt and
      // braces on the only path that can stop a real card.
      return this.cancelAtPeriodEnd(tenantId);
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
    // billing-11, round 2 — the same contract-library rule `selectPlan` now
    // applies, on the other self-serve route.
    //
    // `startCheckout` only ever looked at the PLAN's billingMode, never the
    // TENANT's. So a library an operator had put on a contract could open
    // Stripe Checkout for itself: `handleCheckoutSessionCompleted` +
    // `syncStripeSubscription` then copy the plan's `billingMode='stripe'` over
    // the contract, and the library is charged a card on top of an invoice it
    // has already paid. The forced plan chooser reaches this method for every
    // PAID plan, so closing `selectPlan` alone would only have moved the hole.
    //
    // Confirming the plan they are already on is allowed and takes no payment
    // detail: it stamps `planSelectedAt`, which is the only thing the chooser
    // is waiting for. Without this branch a contract library held by the
    // chooser would have no reachable exit at all — selectPlan refuses a move
    // and every paid card lands here.
    if (sub.billingMode === 'manual') {
      if (plan.id !== sub.planId) {
        throw new BadRequestException(
          'Your library is billed by contract, not through the app — please contact us to ' +
            'change your plan.',
        );
      }
      await controlDb.subscription.updateMany({
        where: { tenantId, planSelectedAt: null },
        data: { planSelectedAt: new Date() },
      });
      return {
        url: buildWebReturnUrl({
          base: loadEnv().billingReturnUrl,
          locale: resolveWebLocale(sub.tenant.defaultLocale),
          slug: sub.tenant.slug,
          returnPath: input.returnPath,
        }),
        sessionId: null,
        outcome: 'plan_changed',
      };
    }
    if (plan.billingMode !== 'stripe') {
      throw new BadRequestException(
        "That plan is billed manually — contact us and we'll set it up by invoice.",
      );
    }
    // billing-11: a FREE plan has nothing to check out, and Checkout in
    // `mode:'subscription'` cannot express "charge nothing". Starter is
    // `billingMode='stripe'` with `monthlyPriceCents=0` only because the
    // `plans_stripe_price_matches_mode` CHECK constraint forces a stripe-mode
    // plan to carry a price id — so it reaches here looking bookable. The
    // billing page's "Switch to Starter" button used to post straight into this
    // method and get Stripe's `No such price: price_seed_starter` back as a
    // 500. Free choices belong to `selectPlan`, which also stops the live
    // subscription first.
    if (plan.monthlyPriceCents <= 0) {
      throw new BadRequestException(
        `Plan "${input.planSlug}" is free — there is nothing to check out. ` +
          'Choose it directly instead; any paid subscription is cancelled at period end.',
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
    // billing-10: "configured" has to mean more than "not null". The seed ships
    // `price_seed_*` on every paid plan, so this check used to pass on a
    // database where no Stripe Product exists at all — the tenant reached
    // Stripe and got `No such price` after the UI had promised them a purchase.
    // Refuse here, where the message can name the fix, rather than at Stripe.
    if (!isUsableStripePriceId(priceId)) {
      this.logger.error(
        `Tenant ${tenantId} tried to buy ${plan.slug} (${wantsAnnual ? 'annual' : 'monthly'}) but ` +
          `its Stripe price id is the seeded placeholder "${priceId}". Run the catalogue audit ` +
          '(GET /admin/billing/price-catalogue) and set the real Price ids before selling anything.',
      );
      throw new BadRequestException(
        `Plan "${input.planSlug}" is not connected to Stripe yet — its price is still a ` +
          'placeholder. Nothing has been charged. Please contact us so we can finish setting it up.',
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
    let live = await this.resolveLiveSubscription(tenantId, sub.stripeSubscriptionId);

    if (!live) {
      // Our row says "no subscription". That is a CACHE, and there is a window
      // in which it is provably wrong — see `adoptCustomerSubscription`. Ask
      // Stripe about the customer before selling anything.
      //
      // Read the account rather than calling `ensureStripeCustomer` first: a
      // tenant with no Stripe customer cannot have a Stripe subscription, so
      // the common case (a library's very first purchase) still costs zero
      // extra Stripe calls.
      const account = await controlDb.billingAccount.findUnique({
        where: { tenantId },
        select: { stripeCustomerId: true },
      });
      live = account?.stripeCustomerId
        ? await this.adoptCustomerSubscription(tenantId, account.stripeCustomerId)
        : null;

      if (!live) {
        const customerId = await this.ensureStripeCustomer(tenantId);
        const session = await this.openCheckoutSession(tenantId, priceId, {
          customerId,
          successUrl,
          cancelUrl,
        });
        return { ...session, outcome: 'checkout' };
      }
    }

    await this.stripe.changeSubscriptionPrice({
      subscriptionId: live.id,
      priceId,
    });
    this.logger.log(`Re-priced ${live.id} onto ${plan.slug} (${priceId}) for tenant ${tenantId}.`);
    // A re-price cannot produce a second subscription, but any Checkout
    // session still outstanding for this tenant CAN — so it is not enough to
    // forget it, which is all this used to do. Revoke it at Stripe first.
    await this.expireOutstandingCheckout(tenantId);
    // Our own row moves when `customer.subscription.updated` arrives — the
    // same path a Dashboard-side change takes. The browser lands back on
    // billing meanwhile, exactly as it would from Stripe's success redirect.
    return { url: planChangedUrl, sessionId: null, outcome: 'plan_changed' };
  }

  /**
   * Ask Stripe whether this CUSTOMER already has a live subscription that our
   * row has not heard about, and adopt it if so.
   *
   * billing-03, round 2 — the window the first fix left open, executed by the
   * verifier:
   *
   *   1. A library on Starter clicks Community. Checkout session A opens and
   *      the Redis marker records it.
   *   2. Stripe charges the card and delivers `checkout.session.completed`
   *      FIRST — its order relative to `customer.subscription.created` is not
   *      guaranteed, and only the latter writes `stripeSubscriptionId`.
   *   3. The library clicks a second plan. Our row still reads `null`, the
   *      marker has been consumed, and Checkout session B opens on a customer
   *      who is already paying. Both sessions complete: two live
   *      subscriptions, two charges, and our single id column remembers only
   *      the later one, so cancelling from the app stops one of them.
   *
   * The marker alone cannot close this: it lives in Redis, it is legitimately
   * dropped when the purchase lands, and a flush loses it. `getSubscription`
   * cannot either — we have no id to ask about, which is the whole problem.
   * The customer id we DO have, and Stripe is authoritative about it.
   *
   * Not a lockout: if Stripe reports no live subscription we fall straight
   * through to Checkout, and the pointer we write here is re-verified against
   * Stripe (and cleared when dead) on the next purchase by
   * `resolveLiveSubscription`.
   */
  private async adoptCustomerSubscription(
    tenantId: string,
    customerId: string,
  ): Promise<StripeSubscriptionState | null> {
    let all: StripeSubscriptionState[];
    try {
      all = await this.stripe.listSubscriptions(customerId);
    } catch (err) {
      // FAIL CLOSED, same reasoning as `resolveLiveSubscription`: "Stripe did
      // not answer" is not "this customer has nothing". Guessing the latter is
      // exactly how the second subscription gets sold.
      this.logger.error(
        `Could not list Stripe subscriptions for customer ${customerId} (tenant ${tenantId}): ` +
          `${(err as Error).message}. Refusing to open a Checkout session.`,
      );
      throw new ServiceUnavailableException(
        'We could not reach Stripe to check whether your library already has a subscription. ' +
          'Nothing has been charged — please try again in a moment.',
      );
    }

    const liveOnes = all.filter((s) => STRIPE_LIVE_STATUSES.has(s.status));
    // Stripe lists newest first, so `[0]` is the one just bought — the one a
    // second click means to change.
    const adopted = liveOnes[0];
    if (!adopted) return null;

    if (liveOnes.length > 1) {
      this.logger.error(
        `Stripe customer ${customerId} (tenant ${tenantId}) has ${liveOnes.length} live ` +
          `subscriptions: ${liveOnes.map((s) => `${s.id} (${s.status})`).join(', ')}. ` +
          `Re-pricing ${adopted.id} and NOT opening another — cancel the extras in Stripe and refund the overlap.`,
      );
    } else {
      this.logger.warn(
        `Tenant ${tenantId} already has live Stripe subscription ${adopted.id} (${adopted.status}) ` +
          'that our row did not know about — adopting it and re-pricing in place instead of ' +
          'opening a second Checkout session.',
      );
    }

    // Write the pointer so the NEXT click is answered from our own row, and so
    // cancel/portal reach this subscription rather than nothing. `updateMany`
    // with `stripeSubscriptionId: null` in the where clause: a concurrent
    // `customer.subscription.created` may have landed while we were talking to
    // Stripe, and overwriting the id it wrote would be the same erasure this
    // finding is about.
    await controlDb.subscription
      .updateMany({
        where: { tenantId, stripeSubscriptionId: null },
        data: { stripeSubscriptionId: adopted.id },
      })
      .catch((err: Error) => {
        // Non-fatal: the re-price below still targets the right subscription.
        this.logger.warn(`Could not record adopted subscription ${adopted.id}: ${err.message}`);
      });
    return adopted;
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
    input: { planSlug: string; billingModeOverride?: 'manual' },
    actor: AdminAuditActor,
  ): Promise<BillingSnapshot> {
    const plan = await controlDb.plan.findUnique({ where: { slug: input.planSlug } });
    if (!plan || plan.archivedAt) throw new NotFoundException(`Plan "${input.planSlug}" missing.`);
    // launch-readiness-02. The plan's own mode is the default; an admin may
    // put one library on invoice billing for a plan everyone else pays by card.
    // That is exactly the founding-library offer — twelve months of Municipal,
    // a `stripe` plan, at no charge — which previously could not be granted
    // through the product because the mode was copied from the plan and
    // `applyManualPayment` then refused the paid-until date the offer is made
    // of. See AdminSetPlanDto.billingModeOverride.
    const billingMode = input.billingModeOverride ?? plan.billingMode;
    // Snapshot the prior plan/status for the audit diff before we overwrite it.
    // `stripeSubscriptionId` is in the select for two reasons: the cancellation
    // below needs it, and once we null it the audit row is the ONLY remaining
    // record of which Stripe subscription this tenant was on.
    const before = await controlDb.subscription.findUnique({
      where: { tenantId },
      select: {
        planId: true,
        billingMode: true,
        status: true,
        stripeSubscriptionId: true,
        plan: { select: { slug: true } },
      },
    });

    // billing-12. This used to write the new plan and deliberately leave
    // `stripeSubscriptionId` alone, under a comment saying Stripe stays the
    // source of truth for that subscription's lifecycle — but no code ever
    // ended it. Moving a paying library onto a contract/on-prem plan is the
    // normal reason an operator touches this endpoint, and it left the card
    // being charged every month WHILE removing the library's own stop button:
    // once billingMode is `manual`, `cancelAtPeriodEnd` refuses ("your library
    // is billed manually"), `openCustomerPortal` refuses, and the billing page
    // renders a static notice instead of BillingActions. The same trap applies
    // to a move onto the free tier, which is also "you are no longer buying a
    // paid Stripe plan".
    //
    // Cancel at PERIOD END, not immediately: the current period is already
    // paid for and clawing it back is not ours to decide. The cancel happens
    // BEFORE the local write and its failure propagates, so the change cannot
    // half-apply into "moved off Stripe in our database, still billing at
    // Stripe" — which is the exact state this finding describes.
    // `billingMode`, not `plan.billingMode`: an override to `manual` means this
    // library stops paying by card, so a live Stripe subscription must be
    // cancelled exactly as it would be for a move onto a manual plan. Reading
    // the plan here instead would leave the card being charged for a library we
    // have just agreed to invoice — or, in the founding-library case, for one
    // we have agreed not to charge at all.
    const leavingPaidStripe = billingMode !== 'stripe' || plan.monthlyPriceCents <= 0;
    const liveSubscriptionId = before?.stripeSubscriptionId ?? null;
    const stoppingStripe = Boolean(liveSubscriptionId) && leavingPaidStripe;
    if (stoppingStripe && liveSubscriptionId) {
      await this.stripe.cancelSubscriptionAtPeriodEnd(liveSubscriptionId);
      this.logger.warn(
        `Admin moved tenant ${tenantId} onto ${plan.slug} (${billingMode}, ` +
          `${plan.monthlyPriceCents} cents) — cancelled Stripe subscription ${liveSubscriptionId} ` +
          'at period end so the card stops being charged. Refund the remainder in Stripe if the ' +
          'contract starts sooner.',
      );
    }

    await controlDb.subscription.update({
      where: { tenantId },
      data: {
        planId: plan.id,
        billingMode,
        status: 'active',
        graceUntil: null,
        // Only when we actually stopped it. Otherwise Stripe remains the source
        // of truth for a subscription that is still live and still ours.
        ...(stoppingStripe
          ? { stripeSubscriptionId: null, cancelAtPeriodEnd: false, canceledAt: new Date() }
          : {}),
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
            stripeSubscriptionId: before.stripeSubscriptionId,
          }
        : undefined,
      after: {
        planSlug: plan.slug,
        planId: plan.id,
        // The EFFECTIVE mode, and `overrodeBillingMode` beside it, so a reader
        // of the audit trail can tell "this library is on invoice billing" from
        // "someone deliberately put this library on invoice billing for a plan
        // that is normally paid by card". Those are different facts and only
        // the second one needs explaining later.
        billingMode,
        overrodeBillingMode: input.billingModeOverride ? true : undefined,
        status: 'active',
        stripeSubscriptionId: stoppingStripe ? null : (before?.stripeSubscriptionId ?? null),
        // Named in the audit row so "was the card stopped?" is answerable from
        // the log, not only from the Stripe dashboard (billing-12).
        stripeSubscriptionCancelledAtPeriodEnd: stoppingStripe,
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
  async recordPaymentFailure(
    tenantId: string,
    /**
     * billing-05. REQUIRED, not defaulted: a grace window handed out by
     * accident is a paid tier handed out for free, and the whole finding is
     * about a default nobody thought about. `hasSettledInvoice` is the
     * caller's evidence that this library has actually paid us at least once —
     * see `handleStripeInvoiceFailed`, which derives it from the invoice's
     * `billing_reason`.
     */
    evidence: { hasSettledInvoice: boolean },
  ): Promise<BillingSnapshot> {
    const env = loadEnv();
    // data-integrity-09: the read, the derivation and the write are ONE
    // control-plane transaction on the per-tenant billing lock.
    // `invoice.payment_failed` and `customer.subscription.updated` are two
    // DISTINCT Stripe events, so the webhook controller's per-event-id dedupe
    // never serialised them against each other — and BOTH of them derive
    // `graceUntil` from whatever `status`/`graceUntil` they happened to read.
    // Interleaved, the loser wrote a deadline computed from a row the winner
    // had already replaced: a library that had just paid left with an open
    // grace window, or one still in dunning left with none.
    await controlDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BILLING_LOCK_KEY(tenantId)}, 0))`;
      const sub = await tx.subscription.findUnique({
        where: { tenantId },
        select: { status: true, graceUntil: true },
      });
      if (!sub) throw new NotFoundException('No subscription on file.');
      const now = Date.now();
      // Keep an already-running grace deadline; only arm a fresh one on the
      // first failure (or if a stale/elapsed window left graceUntil unset).
      const graceStillRunning =
        sub.status === 'past_due' && sub.graceUntil != null && sub.graceUntil.getTime() > now;

      // billing-05. The grace window keeps FULL paid entitlement alive for
      // BILLING_GRACE_PERIOD_DAYS (effective-plan.service.ts admits
      // `past_due AND graceUntil > now()`), and it exists to protect an
      // established payer whose card lapsed between renewals. Arming it on the
      // failure of a subscription's FIRST invoice grants the top tier to someone
      // who has never paid a cent — the auditor executed exactly that and got
      // `institutional past_due grace=+7d` on a subscription with no settled
      // invoice. So: no settled invoice, no grace. The status still moves to
      // past_due, which is true and which gates them, and a later
      // `invoice.payment_succeeded` clears it the normal way.
      const graceUntil = evidence.hasSettledInvoice
        ? graceStillRunning
          ? sub.graceUntil
          : new Date(now + env.billingGracePeriodDays * MS_PER_DAY)
        : // Never EXTEND on an unproven failure, but do not tear down a window a
          // genuine renewal failure already armed either.
          graceStillRunning
          ? sub.graceUntil
          : null;

      if (!evidence.hasSettledInvoice && !graceStillRunning) {
        this.logger.warn(
          `Payment failed for tenant ${tenantId} on a subscription with no settled invoice — ` +
            'marking past_due WITHOUT a grace window. Grace is for a renewal that failed, not for a ' +
            'first payment that never succeeded.',
        );
      }

      await tx.subscription.update({
        where: { tenantId },
        data: { status: 'past_due', graceUntil },
      });
    });
    await this.effectivePlan.invalidate(tenantId);
    return this.getSnapshot(tenantId);
  }

  /**
   * Successful payment received. Clears grace and re-arms the subscription.
   *
   * A single unconditional UPDATE, so it needs no re-read of its own — but it
   * takes the billing lock all the same (data-integrity-09). Without it, this
   * write can land in the middle of a `syncStripeSubscription` that has already
   * read `past_due` and is about to write a grace window derived from it, and
   * the library that just paid us goes straight back to past_due. Joining a
   * lock domain is all-or-nothing: one writer outside it reopens the race for
   * everyone in it.
   */
  async recordPaymentSuccess(tenantId: string): Promise<BillingSnapshot> {
    await controlDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BILLING_LOCK_KEY(tenantId)}, 0))`;
      await tx.subscription.update({
        where: { tenantId },
        data: { status: 'active', graceUntil: null },
      });
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
  async syncStripeSubscription(
    payload: StripeSubscriptionShape,
    /**
     * The envelope this payload arrived in (billing-06). Optional ONLY because
     * the retry sweep re-dispatches a stored `data.object` without it; every
     * live delivery carries it. Absence is not silent — see
     * `isStaleSubscriptionEvent`, which falls back to asking Stripe.
     */
    event?: StripeEventContext,
  ): Promise<void> {
    const tenantId = await this.tenantForStripeCustomer(
      payload.customer,
      `subscription ${payload.id}`,
    );
    if (!tenantId) return;
    /** Kept as an object so the rest of this long method reads unchanged. */
    const billing = { tenantId };
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

    // PRE-FLIGHT ONLY (data-integrity-09). Everything the WRITE is derived from
    // — `status`, `graceUntil` — is re-read inside the transaction below, so it
    // is deliberately not selected here: a field on this row is an invitation
    // to derive the write from it again.
    const existing = await controlDb.subscription.findUnique({
      where: { tenantId: billing.tenantId },
      select: {
        stripeSubscriptionId: true,
        currentPeriodStart: true,
        // Only read for the stale-replay guard (billing-06): "would this event
        // MOVE the plan?" is what decides whether an un-orderable replay is
        // worth verifying against Stripe.
        planId: true,
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
    if (this.isStaleByPeriodStart(payload.id, nextPeriodStart, existing)) return;

    // billing-06: the guard above is INERT for exactly the events that matter.
    // A mid-cycle plan change does not move the billing period — Stripe keeps
    // `current_period_start` and prorates — so the upgrade event and the older
    // event it supersedes carry an identical period start and the `<`
    // comparison is false for both. Executed by the auditor: community →
    // municipal → replay of the community event left the row on community
    // while Stripe billed municipal, and nothing was logged. Order by the
    // envelope instead.
    if (await this.isStaleSubscriptionEvent(payload, priceId, plan.id, existing, event)) return;

    // data-integrity-09: everything from here to the write is ONE control-plane
    // transaction, opened on the per-tenant billing advisory lock, and the row
    // is re-read INSIDE it. The read above is a pre-flight — it exists so the
    // guards that may call Stripe (`isStaleSubscriptionEvent`, no-envelope
    // regime) do their network round trip outside a held transaction — and a
    // pre-flight read cannot be what a write is derived from. `graceUntil` in
    // particular is computed FROM the row: two distinct events for one library
    // in flight together (Stripe delivers `customer.subscription.updated` and
    // `invoice.payment_succeeded` within milliseconds of each other on a
    // recovered dunning) both read `past_due`, and the loser's write put the
    // grace window back on a library that had just paid.
    const applied = await controlDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BILLING_LOCK_KEY(billing.tenantId)}, 0))`;
      const current = await tx.subscription.findUnique({
        where: { tenantId: billing.tenantId },
        select: {
          status: true,
          graceUntil: true,
          stripeSubscriptionId: true,
          currentPeriodStart: true,
        },
      });

      // Re-run under the lock: between the pre-flight read and here, a
      // concurrent event may have moved the period forward, which makes this
      // one the stale replay.
      if (this.isStaleByPeriodStart(payload.id, nextPeriodStart, current)) return false;

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
      const tracked = current?.stripeSubscriptionId ?? null;
      if (tracked != null && tracked !== payload.id) {
        if (!STRIPE_LIVE_STATUSES.has(payload.status)) {
          this.logger.warn(
            `Webhook: ignoring ${payload.status} event for foreign subscription ${payload.id} ` +
              `(tenant ${billing.tenantId} is on ${tracked}). Applying it would have downgraded a ` +
              'subscription this event says nothing about.',
          );
          return false;
        }
        if (current?.status !== 'canceled') {
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

      await tx.subscription.update({
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
          graceUntil: resolveGraceUntil(payload.status, current),
        },
      });
      // An active Stripe subscription is an explicit choice — stamp it if it
      // wasn't already (covers subs created outside our checkout flow, e.g. the
      // Stripe dashboard). `updateMany` keeps the original timestamp intact.
      await tx.subscription.updateMany({
        where: { tenantId: billing.tenantId, planSelectedAt: null },
        data: { planSelectedAt: new Date() },
      });
      return true;
    });
    if (!applied) return;

    // billing-06: remember how new this event was, so a later replay of an
    // OLDER one is refused. Written after the row, never before: a marker
    // ahead of the state it describes would reject the very event that still
    // has to be applied.
    await this.recordAppliedSubscriptionEvent(payload.id, event);
    // The purchase landed. Any Checkout session still recorded as open for this
    // tenant is now a loaded gun (billing-03) — completing it would open a
    // SECOND subscription. Best-effort: a failure here only means the tenant's
    // next purchase reuses or expires a stale session, both of which the
    // openCheckoutSession path handles.
    await this.discardCheckoutMarker(billing.tenantId).catch(() => undefined);
    await this.effectivePlan.invalidate(billing.tenantId);
  }

  /**
   * `checkout.session.completed` — the EARLIEST proof that a subscription now
   * exists for this tenant.
   *
   * This used to do one thing: delete the Redis marker. That is precisely the
   * ordering the verifier exploited (billing-03, round 2). Stripe does not
   * guarantee that `customer.subscription.created` arrives before this event,
   * and `customer.subscription.created` is the ONLY thing that used to write
   * `stripeSubscriptionId`. So between the two, our row said "no subscription"
   * AND the marker was gone: a second click sailed through both guards and
   * bought a second live subscription on the same card.
   *
   * So record the subscription id FIRST — durably, in Postgres, where a Redis
   * flush cannot lose it — and only then drop the marker. The order matters:
   * if the write fails we keep the marker, because with no durable pointer the
   * marker is the only thing left standing between the tenant and a second
   * subscription.
   *
   * The row's plan/status/period stay untouched; `syncStripeSubscription`
   * still owns those when the subscription event lands. All this writes is the
   * pointer, and `resolveLiveSubscription` re-checks it against Stripe on the
   * next purchase — so an id written here for a payment that never completed
   * (`incomplete`) is cleared rather than becoming a lockout.
   */
  async handleCheckoutSessionCompleted(payload: StripeCheckoutSessionShape): Promise<void> {
    // `client_reference_id` is the tenant id we set on every session we open
    // (stripe-real.driver.ts). Prefer it: it NAMES the library, where the
    // customer lookup only infers one — and billing-07 is what a lookup that
    // matches the wrong row costs. Both are validated as non-empty strings
    // before they reach Prisma.
    const referenced =
      typeof payload.client_reference_id === 'string' && payload.client_reference_id.length > 0
        ? payload.client_reference_id
        : null;
    const tenantId =
      referenced ??
      (await this.tenantForStripeCustomer(payload.customer, `checkout session ${payload.id}`));
    if (!tenantId) return;

    // billing-09, repair half. `ensureStripeCustomer` was read-then-create with
    // no lock, so two concurrent purchase starts could each create a Stripe
    // customer and the second local write won. If the library then paid on the
    // LOSER, every later webhook for it failed the `stripeCustomerId` lookup
    // and returned after a warn line — a live subscription charging a card that
    // our database cannot connect to any tenant. The session we are holding
    // names both sides of that mismatch, so it is the one place we can repair
    // it. Only ever fills a NULL: overwriting a customer id we already track
    // would be the same erasure in the other direction.
    if (referenced && typeof payload.customer === 'string' && payload.customer.length > 0) {
      await this.adoptCheckoutCustomer(referenced, payload.customer, payload.id);
    }

    if (!payload.subscription) {
      // `mode:'subscription'` sessions carry one; a session that completed
      // without it is either a different mode or an async payment method whose
      // subscription does not exist yet. Keep the marker — it is now the only
      // guard — and let the subscription event do the rest.
      this.logger.warn(
        `Checkout session ${payload.id} for tenant ${tenantId} completed with no subscription id — ` +
          'keeping the in-flight-checkout marker as the duplicate-purchase guard.',
      );
      return;
    }

    // Only claim the pointer when the row has none: a `customer.subscription.created`
    // that arrived first already wrote it, and clobbering an id we track is the
    // erasure this whole finding is about.
    const claimed = await controlDb.subscription.updateMany({
      where: { tenantId, stripeSubscriptionId: null },
      data: { stripeSubscriptionId: payload.subscription },
    });
    if (claimed.count === 0) {
      const existing = await controlDb.subscription.findUnique({
        where: { tenantId },
        select: { stripeSubscriptionId: true },
      });
      if (existing && existing.stripeSubscriptionId !== payload.subscription) {
        this.logger.error(
          `Tenant ${tenantId} completed Checkout session ${payload.id} into subscription ` +
            `${payload.subscription} while already tracking ${existing.stripeSubscriptionId}. ` +
            'Both are billing — cancel one in Stripe and refund the overlap.',
        );
      }
    } else {
      this.logger.log(
        `Checkout session ${payload.id} completed — tenant ${tenantId} now points at ` +
          `subscription ${payload.subscription} (plan follows on the subscription event).`,
      );
    }

    await this.discardCheckoutMarker(tenantId).catch((err: Error) => {
      this.logger.warn(`Could not clear the checkout marker for ${tenantId}: ${err.message}`);
    });
  }

  /** Stripe killed the subscription (final cancellation). Downgrade to Starter. */
  async handleStripeSubscriptionDeleted(payload: StripeSubscriptionShape): Promise<void> {
    const tenantId = await this.tenantForStripeCustomer(
      payload.customer,
      `subscription.deleted ${payload.id}`,
    );
    if (!tenantId) return;
    const billing = { tenantId };
    // STRIPE-RETRY-STALE-REPLAY (delete path): only act on a delete for the
    // subscription we currently track. A customer can churn and re-subscribe on
    // a NEW subscription id; the retry sweep (or out-of-order delivery) may then
    // replay the OLD `customer.subscription.deleted`. Without this guard that
    // stale delete would downgrade a tenant who is actively paying on the newer
    // subscription. If we already moved on to a different id, ignore it; if we
    // track none (or the same id), the downgrade is legitimate.
    const existing = await controlDb.subscription.findUnique({
      where: { tenantId: billing.tenantId },
      select: { stripeSubscriptionId: true, billingMode: true },
    });
    if (existing?.stripeSubscriptionId != null && existing.stripeSubscriptionId !== payload.id) {
      this.logger.warn(
        `Webhook: ignoring stale subscription.deleted for ${payload.id} ` +
          `(tenant now on ${existing.stripeSubscriptionId})`,
      );
      return;
    }
    // billing-12, second half. A tenant an operator moved onto a manual /
    // contract plan is no longer governed by Stripe — `cancelAtPeriodEnd` and
    // `openCustomerPortal` both already refuse for `manual`, and the billing
    // page hides the actions entirely. The admin path now cancels the leftover
    // Stripe subscription and clears the pointer, which means the cancellation
    // Stripe delivers weeks later arrives at a row with
    // `stripeSubscriptionId = null` — and the stale-delete guard above passes
    // trivially for that. Without this the delete would drag a contracted
    // library back to Starter, silently undoing the plan an operator set by
    // hand. Stripe deleting a subscription we deliberately ended is expected,
    // not news.
    if (existing?.billingMode === 'manual') {
      this.logger.log(
        `Webhook: ignoring subscription.deleted for ${payload.id} — tenant ${billing.tenantId} is ` +
          'billed manually and its plan is not governed by Stripe.',
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
    await this.recordPaymentFailure(tenantId, {
      hasSettledInvoice: hasSettledInvoiceBefore(payload),
    });
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
    const tenantId = await this.tenantForStripeCustomer(payload.customer, `invoice ${payload.id}`);
    if (!tenantId) return null;
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      select: { stripeSubscriptionId: true },
    });
    if (!sub?.stripeSubscriptionId || sub.stripeSubscriptionId !== payload.subscription) {
      return null;
    }
    return tenantId;
  }

  /**
   * Resolve the library a webhook payload is about from its Stripe CUSTOMER
   * id, refusing a payload that does not name one.
   *
   * billing-07, executed by the auditor. Every call site used to pass
   * `payload.customer` straight into
   * `billingAccount.findFirst({ where: { stripeCustomerId } })` with no check
   * that it was a string. Prisma renders a null filter value as
   * `stripeCustomerId IS NULL`, and `signup.service.ts` creates a
   * `billing_accounts` row with a NULL customer id for EVERY tenant — 44 of the
   * 46 rows on the audit control plane. So a payload with `customer: null` did
   * not fail to match; it matched an arbitrary library and the handler rewrote
   * that library's plan, billingMode and subscription id. The proof run moved
   * an unrelated tenant to `institutional / sub_nullcustomer` from a payload
   * that never named it, over HTTP 200.
   *
   * Stripe never emits a subscription or invoice event without a customer, so a
   * payload that reaches here without one is malformed or forged. Log at error
   * level and refuse — guessing a victim is strictly worse than doing nothing.
   */
  private async tenantForStripeCustomer(
    customer: unknown,
    context: string,
  ): Promise<string | null> {
    if (typeof customer !== 'string' || customer.length === 0) {
      this.logger.error(
        `Webhook (${context}): payload carries no Stripe customer id (${JSON.stringify(customer)}) ` +
          '— refusing to guess which library it is about. Stripe never sends this; the delivery is ' +
          'malformed or forged.',
      );
      return null;
    }
    const billing = await controlDb.billingAccount.findFirst({
      where: { stripeCustomerId: customer },
      select: { tenantId: true },
    });
    if (!billing) {
      this.logger.warn(`Webhook (${context}): no BillingAccount for customer ${customer}`);
      return null;
    }
    return billing.tenantId;
  }

  /**
   * Fill in a `billing_accounts.stripeCustomerId` that is still NULL from the
   * Checkout session that just completed (billing-09).
   *
   * Only ever fills a null — never overwrites — and reports a genuine mismatch
   * loudly instead: two different customer ids for one tenant means a duplicate
   * exists at Stripe and a human has to merge them. The unique index on
   * `stripeCustomerId` can also reject this write (the id already belongs to
   * another tenant, which would be a `client_reference_id` that does not match
   * the customer); that is caught and reported rather than failing the webhook,
   * because the subscription pointer below is the part that must land.
   */
  private async adoptCheckoutCustomer(
    tenantId: string,
    customerId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const claimed = await controlDb.billingAccount.updateMany({
        where: { tenantId, stripeCustomerId: null },
        data: { stripeCustomerId: customerId },
      });
      if (claimed.count > 0) {
        this.logger.warn(
          `Tenant ${tenantId} had no Stripe customer id on file; adopting ${customerId} from ` +
            `completed Checkout session ${sessionId}. Without this every later webhook for that ` +
            'customer would have found no library and been dropped.',
        );
        return;
      }
      const account = await controlDb.billingAccount.findUnique({
        where: { tenantId },
        select: { stripeCustomerId: true },
      });
      if (account && account.stripeCustomerId !== customerId) {
        this.logger.error(
          `Tenant ${tenantId} paid on Stripe customer ${customerId} (session ${sessionId}) while ` +
            `we track ${account.stripeCustomerId}. Two customers exist for one library — merge ` +
            'them in Stripe, or webhooks for the other one will be dropped.',
        );
      }
    } catch (err) {
      this.logger.error(
        `Could not reconcile the Stripe customer for tenant ${tenantId} from session ` +
          `${sessionId}: ${(err as Error).message}`,
      );
    }
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
   * Revoke the tenant's outstanding Checkout session AT STRIPE, then forget it.
   *
   * The re-price path used to call `discardCheckoutMarker` here, under a
   * comment that said completing the outstanding session "WOULD produce" a
   * second subscription — and then only deleted our note of it. Forgetting a
   * loaded gun does not unload it: the session stayed completable for its full
   * 24h at Stripe, and now nothing in our system even knew its id.
   *
   * Best-effort by design. The marker is deliberately KEPT when the expire
   * fails, for the two readings that failure has:
   *   - the session already COMPLETED (Stripe refuses to expire those), in
   *     which case it produced the very subscription we are re-pricing and
   *     there is nothing to revoke; or
   *   - Stripe was briefly unreachable, in which case the session is still
   *     open and the next attempt must try again.
   * Deleting it would make the second case permanent. It expires on its own
   * with the marker's 24h TTL, which matches Stripe's own session lifetime.
   */
  private async expireOutstandingCheckout(tenantId: string): Promise<void> {
    if (!this.redis) return;
    const key = CHECKOUT_MARKER_KEY(tenantId);
    const outstanding = parseCheckoutMarker(await this.redis.client.get(key).catch(() => null));
    // Nothing recorded, or a placeholder another request is holding while it
    // talks to Stripe — in both cases there is no session id to revoke, and
    // clearing the placeholder would only undermine that request's claim.
    if (!outstanding) return;
    try {
      await this.stripe.expireCheckoutSession(outstanding.sessionId);
      this.logger.log(
        `Expired outstanding Checkout session ${outstanding.sessionId} for tenant ${tenantId} — ` +
          'the subscription was changed in place instead.',
      );
      await this.redis.client.del(key).catch(() => undefined);
    } catch (err) {
      this.logger.warn(
        `Could not expire outstanding Checkout session ${outstanding.sessionId} for tenant ` +
          `${tenantId}: ${(err as Error).message}. Either it already completed (and is the ` +
          'subscription we just changed), or Stripe was unreachable — keeping the marker so the ' +
          'next attempt retries the revocation.',
      );
    }
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
   * Reconcile the local price catalogue against Stripe (billing-10).
   *
   * NOTHING did this. `PATCH /admin/plans/:slug` takes `stripePriceId` and
   * `stripeAnnualPriceId` as bare optional strings — no format check, no call
   * to Stripe, no check that the amount or the currency or the RECURRING
   * INTERVAL match the column the id is being written into, and no guard
   * against the same id landing in both columns. A monthly id pasted into the
   * annual column bills €39 a month to a library that clicked "390 € a year",
   * and nothing in the product can tell. Meanwhile the go-live check the
   * operator was told to run asked only whether `hasStripeAnnualPrice` was
   * true, which was `!!stripeAnnualPriceId` — true for every `price_seed_*`
   * placeholder the seed ships. The single mechanical safeguard reported
   * success on the seed data it existed to catch.
   *
   * This is the check that can fail. It is read-only, it names every problem in
   * plain language, and it is what `docs/billing-go-live.md` now points the
   * operator at.
   *
   * Amounts are compared as integers throughout — Stripe reports minor units
   * and `plans.monthlyPriceCents` stores minor units. No float ever appears.
   */
  async auditPriceCatalogue(): Promise<{
    driver: 'real' | 'fake' | 'disabled';
    /**
     * billing-14. Whether this host can charge a card at all.
     *
     * Computed from the LIVE `STRIPE_DRIVER` posture rather than from the
     * driver object this process booted with, because that is exactly what
     * `PlatformSettingsService.setBillingEnabled` consults when it decides
     * whether to accept the Subscriptions toggle — so this field predicts that
     * decision instead of merely correlating with it.
     *
     * It existed before, on `subscriptionsStatus()`, and NO UI read it: an
     * operator on a host that cannot charge saw a completely normal admin
     * screen and found out when the toggle threw. It is returned here because
     * this is the payload the admin Plans screen renders.
     */
    stripeReady: boolean;
    /** The master switch as it stands right now. */
    billingEnabled: boolean;
    /** Would `POST /admin/subscriptions {enabled:true}` be accepted today? */
    subscriptionsCanBeEnabled: boolean;
    /** Plain-language reason the toggle would refuse, or null when it would not. */
    blockReason: string | null;
    ok: boolean;
    checkedAt: string;
    plans: Array<{
      slug: string;
      billingMode: BillingMode;
      currency: string;
      monthlyPriceCents: number;
      annualPriceCents: number | null;
      stripePriceId: string | null;
      stripeAnnualPriceId: string | null;
      /** Empty when this plan is ready to sell. */
      problems: string[];
      /** Things worth knowing that are NOT defects. */
      notes: string[];
    }>;
  }> {
    const [plans, billingEnabled] = await Promise.all([
      controlDb.plan.findMany({
        where: { archivedAt: null, isActive: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.settings.billingEnabled(),
    ]);
    /** Memoised so two plans sharing an id cost one Stripe call, not two. */
    const priceCache = new Map<string, PriceLookupOutcome>();
    const lookup = async (id: string): Promise<PriceLookupOutcome> => {
      const hit = priceCache.get(id);
      if (hit !== undefined) return hit;
      let result: PriceLookupOutcome;
      try {
        result = await this.stripe.getPrice(id);
      } catch (err) {
        this.logger.warn(`Catalogue audit: Stripe refused price ${id}: ${(err as Error).message}`);
        result = 'error';
      }
      priceCache.set(id, result);
      return result;
    };

    const rows: Array<{
      slug: string;
      billingMode: BillingMode;
      currency: string;
      monthlyPriceCents: number;
      annualPriceCents: number | null;
      stripePriceId: string | null;
      stripeAnnualPriceId: string | null;
      problems: string[];
      notes: string[];
    }> = [];

    for (const plan of plans) {
      const problems: string[] = [];
      const notes: string[] = [];
      const paidStripe = plan.billingMode === 'stripe' && plan.monthlyPriceCents > 0;

      if (
        plan.stripePriceId != null &&
        plan.stripeAnnualPriceId != null &&
        plan.stripePriceId === plan.stripeAnnualPriceId
      ) {
        // Both unique indexes are satisfied by this, so the database accepts it
        // (executed by the auditor). One of the two cadences is then charged at
        // the other's interval.
        problems.push(
          `the monthly and annual columns hold the SAME price id (${plan.stripePriceId}) — ` +
            'one of the two cadences will charge the wrong interval',
        );
      }

      const columns: Array<{
        label: 'monthly' | 'annual';
        id: string | null;
        expectedCents: number | null;
        expectedInterval: 'month' | 'year';
        required: boolean;
      }> = [
        {
          label: 'monthly',
          id: plan.stripePriceId,
          expectedCents: plan.monthlyPriceCents,
          expectedInterval: 'month',
          required: paidStripe,
        },
        {
          label: 'annual',
          id: plan.stripeAnnualPriceId,
          expectedCents: plan.annualPriceCents,
          expectedInterval: 'year',
          // An annual price is only required once the plan advertises one.
          required: paidStripe && plan.annualPriceCents != null,
        },
      ];

      // A plan nobody can buy through Checkout cannot mis-bill anybody, and its
      // price id is never read: `startCheckout` refuses a plan priced at zero
      // (billing-11) and refuses a non-stripe plan outright. Starter is the
      // case that matters — the `plans_stripe_price_matches_mode` CHECK
      // constraint FORCES a stripe-mode plan to carry a price id, and
      // `UPDATE plans SET "stripePriceId"=NULL WHERE slug='starter'` is
      // rejected with 23514, so its `price_seed_starter` can never be removed
      // without a migration. Reporting it as a problem every single time would
      // make `ok` permanently false, and a check that can never go green is a
      // check people learn to ignore. Say it once, as a note.
      if (!paidStripe) {
        if (plan.stripePriceId != null || plan.stripeAnnualPriceId != null) {
          notes.push(
            `not sold through Checkout (${plan.billingMode}, ${plan.monthlyPriceCents} minor units) — ` +
              `its price id ${plan.stripePriceId ?? plan.stripeAnnualPriceId} is never used and is not verified`,
          );
        }
        rows.push({
          slug: plan.slug,
          billingMode: plan.billingMode,
          currency: plan.currency,
          monthlyPriceCents: plan.monthlyPriceCents,
          annualPriceCents: plan.annualPriceCents,
          stripePriceId: plan.stripePriceId,
          stripeAnnualPriceId: plan.stripeAnnualPriceId,
          problems,
          notes,
        });
        continue;
      }

      for (const column of columns) {
        if (column.id == null) {
          if (column.required) problems.push(`no ${column.label} Stripe price id is set`);
          continue;
        }
        if (!isUsableStripePriceId(column.id)) {
          problems.push(unusablePriceIdProblem(column.label, column.id));
          continue;
        }
        // Same comparisons, same words, as the write-time guard — see
        // plan-price-check.ts for why there is only one copy of them.
        problems.push(
          ...stripePriceProblems(
            {
              label: column.label,
              id: column.id,
              expectedCents: column.expectedCents,
              expectedCurrency: plan.currency,
              expectedInterval: column.expectedInterval,
            },
            await lookup(column.id),
          ),
        );
      }

      rows.push({
        slug: plan.slug,
        billingMode: plan.billingMode,
        currency: plan.currency,
        monthlyPriceCents: plan.monthlyPriceCents,
        annualPriceCents: plan.annualPriceCents,
        stripePriceId: plan.stripePriceId,
        stripeAnnualPriceId: plan.stripeAnnualPriceId,
        problems,
        notes,
      });
    }

    // billing-14. The posture the admin toggle will consult, resolved the same
    // way `setBillingEnabled` resolves it (live env, not the booted driver), so
    // the banner the operator reads and the refusal they would hit cannot
    // disagree.
    const posture = resolveStripeDriverKind().kind;
    const standInIsIntentional = posture === 'fake' && isTrustedLocalNodeEnv();
    const subscriptionsCanBeEnabled = posture === 'real' || standInIsIntentional;
    const blockReason = subscriptionsCanBeEnabled
      ? null
      : `STRIPE_DRIVER resolves to "${posture}" on this host, so checkout and the customer ` +
        'portal have nothing that can take a payment. Enabling subscriptions would gate every ' +
        'library behind a purchase it cannot complete, so the Subscriptions switch will refuse. ' +
        'Set STRIPE_DRIVER=real with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET and restart the API.';

    return {
      driver: this.stripe.kind,
      stripeReady: posture === 'real',
      billingEnabled,
      subscriptionsCanBeEnabled,
      blockReason,
      ok: rows.every((r) => r.problems.length === 0),
      checkedAt: new Date().toISOString(),
      plans: rows,
    };
  }

  /**
   * STRIPE-RETRY-STALE-REPLAY: is this an out-of-order event for the SAME
   * subscription? Stripe's `current_period_start` is monotonic across a
   * subscription's lifecycle, so a captured payload whose period starts
   * strictly before the one we already persisted is a stale replay (the retry
   * sweep re-running an old `payloadJson`, or webhooks arriving out of order).
   * Applying it would revert plan/status/grace to older state. We only guard
   * when both ids match and both periods are known — a genuinely new
   * subscription (different id) or a first-ever sync (no persisted period)
   * always applies.
   *
   * Called TWICE per event on purpose (data-integrity-09): once on the
   * pre-flight read, so an obviously-stale replay never costs the Stripe round
   * trip `isStaleSubscriptionEvent` may make, and once on the row re-read
   * inside the billing lock, which is the answer that actually decides the
   * write.
   */
  private isStaleByPeriodStart(
    subscriptionId: string,
    nextPeriodStart: Date | null,
    row: { stripeSubscriptionId: string | null; currentPeriodStart: Date | null } | null,
  ): boolean {
    if (
      row?.stripeSubscriptionId !== subscriptionId ||
      row.currentPeriodStart == null ||
      nextPeriodStart == null ||
      nextPeriodStart.getTime() >= row.currentPeriodStart.getTime()
    ) {
      return false;
    }
    this.logger.warn(
      `Webhook: ignoring stale subscription event for ${subscriptionId} ` +
        `(period start ${nextPeriodStart.toISOString()} < persisted ${row.currentPeriodStart.toISOString()})`,
    );
    return true;
  }

  /**
   * Is this subscription event OLDER than the newest one we already applied for
   * the same subscription (billing-06)?
   *
   * Two regimes, because the two dispatchers know different things:
   *
   *   LIVE DELIVERY (`event` present) — the webhook route hands us the
   *   envelope's `created`, which is the only monotonic ordering key a
   *   subscription event carries. Compare it with the newest we have applied
   *   for this subscription id. This is the case the finding executed: two
   *   `customer.subscription.updated` events whose delivery order Stripe does
   *   not guarantee.
   *
   *   RETRY SWEEP (`event` absent) — the sweep re-dispatches a stored
   *   `data.object` with no envelope, and that is exactly the second live path
   *   the verifier named: an event whose first dispatch errored, re-dispatched
   *   after a newer one has already been applied. With no timestamp to order
   *   by, ask the authority instead — if Stripe says the subscription is on a
   *   different price than this event claims, the event has been overtaken.
   *   Fail SOFT: an unreachable Stripe here must not turn a webhook into an
   *   error, it just leaves us where we were before this guard existed.
   */
  private async isStaleSubscriptionEvent(
    payload: StripeSubscriptionShape,
    eventPriceId: string,
    eventPlanId: string,
    existing: { stripeSubscriptionId: string | null; planId?: string } | null,
    event: StripeEventContext | undefined,
  ): Promise<boolean> {
    if (event) {
      const lastApplied = await this.lastAppliedSubscriptionEventMs(payload.id);
      if (lastApplied != null && event.createdAt.getTime() < lastApplied) {
        this.logger.warn(
          `Webhook: ignoring stale subscription event ${event.id} for ${payload.id} — it was ` +
            `created ${event.createdAt.toISOString()}, and we have already applied an event ` +
            `created ${new Date(lastApplied).toISOString()} for the same subscription. Applying it ` +
            'would revert the plan while Stripe keeps billing the newer one.',
        );
        return true;
      }
      return false;
    }

    // No envelope. Only worth a Stripe round trip when the event would MOVE the
    // plan of a subscription we already track — a renewal that changes nothing
    // is not worth a network call, and a brand-new subscription has nothing to
    // be stale against.
    if (existing?.stripeSubscriptionId !== payload.id) return false;
    if (existing.planId != null && existing.planId === eventPlanId) return false;

    let state: StripeSubscriptionState | null;
    try {
      state = await this.stripe.getSubscription(payload.id);
    } catch (err) {
      this.logger.warn(
        `Could not ask Stripe whether the replayed event for ${payload.id} is still current ` +
          `(${(err as Error).message}) — applying it as received.`,
      );
      return false;
    }
    // `priceId` is null when the driver has no opinion (the in-memory
    // stand-in, or a multi-item subscription a human edited in the Dashboard).
    // No opinion is not disagreement.
    if (!state || state.priceId == null || state.priceId === eventPriceId) return false;

    this.logger.warn(
      `Webhook: ignoring replayed subscription event for ${payload.id} — it carries price ` +
        `${eventPriceId} but Stripe now has the subscription on ${state.priceId}. The event has ` +
        'been overtaken; applying it would revert the plan while Stripe bills the newer price.',
    );
    return true;
  }

  /** Newest applied `event.created` (ms) for a subscription id, or null. */
  private async lastAppliedSubscriptionEventMs(subscriptionId: string): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.client.get(SUB_EVENT_KEY(subscriptionId));
      const ms = raw == null ? Number.NaN : Number(raw);
      return Number.isFinite(ms) ? ms : null;
    } catch (err) {
      // Redis down → no ordering information → apply, which is what this code
      // did before the guard existed. Degrading to the old behaviour is the
      // right failure mode for a guard whose store is an optimisation; the
      // durable period-start comparison in the caller still runs.
      this.logger.warn(
        `Could not read the applied-event marker for ${subscriptionId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Record how new the event we just applied was. Read-then-write rather than a
   * bare SET: two events for one subscription can be in flight at once (the
   * controller serializes per EVENT id, not per subscription), and the marker
   * must only ever move forwards.
   *
   * A sweep replay applies with no envelope and therefore does not move the
   * marker — it cannot, it has no timestamp — which leaves the marker at the
   * last live delivery. That is the conservative direction: the marker stays
   * older, so it rejects less, never more.
   */
  private async recordAppliedSubscriptionEvent(
    subscriptionId: string,
    event: StripeEventContext | undefined,
  ): Promise<void> {
    if (!this.redis || !event) return;
    try {
      const current = await this.lastAppliedSubscriptionEventMs(subscriptionId);
      const next = event.createdAt.getTime();
      if (current != null && current >= next) return;
      await this.redis.client.set(
        SUB_EVENT_KEY(subscriptionId),
        String(next),
        'EX',
        SUB_EVENT_TTL_SEC,
      );
    } catch (err) {
      this.logger.warn(
        `Could not record the applied-event marker for ${subscriptionId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Get-or-create the tenant's Stripe Customer. The id is cached on the
   * `billing_accounts` row so we never create duplicates.
   *
   * billing-09. This was read → `stripe.customers.create` → write, with a
   * network round trip and no lock, transaction or idempotency key in between.
   * Two concurrent purchase starts for the same library — the billing page open
   * in two tabs — both read "no customer", both created one, and the second
   * write silently overwrote the first. Whichever customer the user's Checkout
   * session had used then decided whether we would ever hear about the
   * subscription: a session on the loser produces a live, charging subscription
   * that every webhook drops, because `findFirst({stripeCustomerId})` cannot
   * find it. The library stays on the free plan and is billed monthly anyway.
   *
   * Two changes close it. The Idempotency-Key means Stripe hands both racers
   * the SAME customer, so the duplicate is never created; the conditional write
   * means the loser ADOPTS the winner's id rather than clobbering it, so the
   * row and Stripe agree either way.
   */
  private async ensureStripeCustomer(tenantId: string): Promise<string> {
    const account = await controlDb.billingAccount.findUnique({ where: { tenantId } });
    if (account?.stripeCustomerId) return account.stripeCustomerId;
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, primaryEmail: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    const billingEmail = tenant.primaryEmail ?? `billing@${tenant.slug}.libriant.com`;
    const { customerId } = await this.stripe.createCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      email: billingEmail,
      name: tenant.name,
      // Stable per tenant, so a concurrent second call is answered with the
      // first call's customer instead of a new one.
      idempotencyKey: `libriant:customer:${tenant.id}`,
    });

    // Claim the column only while it is still empty. `updateMany` rather than
    // `update` because the where-clause carries the condition: a racer that
    // wrote first keeps its id and we adopt it below.
    const claimed = await controlDb.billingAccount.updateMany({
      where: { tenantId, stripeCustomerId: null },
      data: { stripeCustomerId: customerId },
    });
    if (claimed.count > 0) return customerId;

    // Nothing claimed: either another request won the race, or this tenant has
    // no billing_accounts row at all (every signup writes one, so this is the
    // rare path).
    const winner = await controlDb.billingAccount.findUnique({
      where: { tenantId },
      select: { stripeCustomerId: true },
    });
    if (winner?.stripeCustomerId) {
      if (winner.stripeCustomerId !== customerId) {
        // Only reachable if the idempotency key did not apply — e.g. the two
        // calls were more than 24h apart, which needs the first one's write to
        // have failed. Loud, because two customers for one library splits its
        // billing history and someone has to merge them.
        this.logger.error(
          `Tenant ${tenantId} raced itself into TWO Stripe customers: keeping ` +
            `${winner.stripeCustomerId} (already on file) and abandoning ${customerId}. ` +
            'Delete the abandoned one in Stripe before anything is charged on it.',
        );
      }
      return winner.stripeCustomerId;
    }
    await controlDb.billingAccount.create({
      data: {
        tenantId,
        stripeCustomerId: customerId,
        billingEmail,
        billingName: tenant.name,
      },
    });
    return customerId;
  }
}

// Re-export so callers in adjacent files don't have to import from
// db-control directly.
export type { Subscription, BillingAccount, Plan };
