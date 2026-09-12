import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The request-side half of the billing-correctness package:
 *
 *   billing-09 — `ensureStripeCustomer` raced itself into two Stripe customers.
 *   billing-10 — nothing reconciled the price catalogue with Stripe, and
 *                `hasStripePrice` was true for every seeded placeholder.
 *   billing-11 — the billing page's downgrade-to-free button posted to Stripe
 *                Checkout with `price_seed_starter`.
 *   billing-12 — admin set-plan onto a manual plan left the Stripe
 *                subscription live while removing the tenant's own cancel.
 */
const {
  planFindMany,
  planFindUnique,
  subFindUnique,
  subUpdate,
  subUpdateMany,
  accountFindUnique,
  accountUpdateMany,
  accountCreate,
  tenantFindUnique,
  auditCreate,
} = vi.hoisted(() => ({
  planFindMany: vi.fn(),
  planFindUnique: vi.fn(),
  subFindUnique: vi.fn(),
  subUpdate: vi.fn(),
  subUpdateMany: vi.fn(),
  accountFindUnique: vi.fn(),
  accountUpdateMany: vi.fn(),
  accountCreate: vi.fn(),
  tenantFindUnique: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: {
    // 2.0 phase 20f: the sweeps read which libraries have been cut over.
    tenantSchemaState: { findMany: () => Promise.resolve([]) },
    plan: { findMany: planFindMany, findUnique: planFindUnique },
    subscription: { findUnique: subFindUnique, update: subUpdate, updateMany: subUpdateMany },
    billingAccount: {
      findUnique: accountFindUnique,
      updateMany: accountUpdateMany,
      create: accountCreate,
    },
    tenant: { findUnique: tenantFindUnique },
    adminAuditLog: { create: auditCreate },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ billingReturnUrl: 'https://app.libriant.test', billingGracePeriodDays: 7 }),
}));
vi.mock('../platform/admin-audit.js', () => ({
  recordAdminAudit: vi.fn().mockResolvedValue(undefined),
  adminAuditActor: vi.fn(),
}));

import { BillingService, isUsableStripePriceId } from './billing.service.js';
import { recordAdminAudit } from '../platform/admin-audit.js';

const TENANT = 'tnt_1';
const ACTOR = { kind: 'admin', id: 'adm_1' } as never;

/** Starter as the SEED actually ships it: stripe mode, free, placeholder id. */
const STARTER = {
  id: 'p-starter',
  slug: 'starter',
  name: 'Starter',
  billingMode: 'stripe' as const,
  isActive: true,
  isPublic: true,
  archivedAt: null,
  stripePriceId: 'price_seed_starter',
  stripeAnnualPriceId: null,
  monthlyPriceCents: 0,
  annualPriceCents: null,
  currency: 'EUR',
  sortOrder: 10,
};
const COMMUNITY = {
  id: 'p-comm',
  slug: 'community',
  name: 'Community',
  billingMode: 'stripe' as const,
  isActive: true,
  isPublic: true,
  archivedAt: null,
  stripePriceId: 'price_seed_community',
  stripeAnnualPriceId: 'price_seed_community_annual',
  monthlyPriceCents: 3900,
  annualPriceCents: 39000,
  currency: 'EUR',
  sortOrder: 20,
};
const ONPREM = {
  id: 'p-onprem',
  slug: 'on-prem-enterprise',
  name: 'On-prem',
  billingMode: 'manual' as const,
  isActive: true,
  isPublic: false,
  archivedAt: null,
  stripePriceId: null,
  stripeAnnualPriceId: null,
  monthlyPriceCents: 0,
  annualPriceCents: null,
  currency: 'EUR',
  sortOrder: 90,
};

function subRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    planId: COMMUNITY.id,
    status: 'active',
    billingMode: 'stripe',
    stripeSubscriptionId: 'sub_live',
    graceUntil: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    paidUntil: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    planSelectedAt: new Date(),
    plan: { id: COMMUNITY.id, slug: COMMUNITY.slug, name: COMMUNITY.name },
    tenant: { slug: 'acme', defaultLocale: 'el', name: 'Acme' },
    ...overrides,
  };
}

function makeRedis() {
  const store = new Map<string, string>();
  return {
    client: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      }),
      del: vi.fn(async () => 1),
    },
  } as never;
}

function makeService(stripe: Record<string, unknown> = {}) {
  const driver = {
    isReal: true,
    kind: 'real' as const,
    createCustomer: vi.fn().mockResolvedValue({ customerId: 'cus_new' }),
    createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://stripe', sessionId: 'cs_1' }),
    expireCheckoutSession: vi.fn().mockResolvedValue(undefined),
    cancelSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(undefined),
    changeSubscriptionPrice: vi.fn().mockResolvedValue(undefined),
    getSubscription: vi.fn().mockResolvedValue(null),
    listSubscriptions: vi.fn().mockResolvedValue([]),
    getPrice: vi.fn().mockResolvedValue(null),
    ...stripe,
  };
  const svc = new BillingService(
    { invalidate: vi.fn().mockResolvedValue(undefined) } as never,
    driver as never,
    { billingEnabled: async () => true } as never,
    makeRedis(),
  );
  return { svc, driver };
}

function lastUpdate(): Record<string, unknown> | null {
  const call = subUpdate.mock.calls.at(-1);
  return call ? (call[0].data as Record<string, unknown>) : null;
}

beforeEach(() => {
  planFindMany.mockReset().mockResolvedValue([STARTER, COMMUNITY]);
  planFindUnique.mockReset().mockImplementation(async (args: { where: { slug?: string } }) => {
    const bySlug: Record<string, unknown> = {
      starter: STARTER,
      community: COMMUNITY,
      'on-prem-enterprise': ONPREM,
    };
    return args.where.slug ? bySlug[args.where.slug] : undefined;
  });
  subFindUnique.mockReset().mockResolvedValue(subRow());
  subUpdate.mockReset().mockResolvedValue({});
  subUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  accountFindUnique.mockReset().mockResolvedValue(null);
  accountUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  accountCreate.mockReset().mockResolvedValue({});
  tenantFindUnique.mockReset().mockResolvedValue({
    id: TENANT,
    slug: 'acme',
    name: 'Acme Library',
    primaryEmail: 'library@example.test',
  });
  (recordAdminAudit as unknown as ReturnType<typeof vi.fn>).mockClear();
});

// ---------------------------------------------------------------------------
// billing-10 — "configured" must mean more than "not null"
// ---------------------------------------------------------------------------

describe('billing-10: the seeded placeholders are not a configured catalogue', () => {
  it('isUsableStripePriceId rejects the seed placeholders and accepts a real Price id', () => {
    expect(isUsableStripePriceId('price_seed_starter')).toBe(false);
    expect(isUsableStripePriceId('price_seed_community_annual')).toBe(false);
    expect(isUsableStripePriceId(null)).toBe(false);
    expect(isUsableStripePriceId('')).toBe(false);
    expect(isUsableStripePriceId('prod_1234')).toBe(false);
    expect(isUsableStripePriceId('price_1QxRealStripeId')).toBe(true);
  });

  it('listAvailablePlans reports a seeded plan as NOT bookable', async () => {
    const { svc } = makeService();

    const plans = await svc.listAvailablePlans(TENANT);

    // Both plans ship `price_seed_*`; the old `!!stripePriceId` said true for
    // every one of them, which is what made the go-live check vacuous.
    expect(plans.map((p) => [p.slug, p.hasStripePrice, p.hasStripeAnnualPrice])).toEqual([
      ['starter', false, false],
      ['community', false, false],
    ]);
  });

  it('the catalogue audit fails on placeholders and names each one', async () => {
    const { svc } = makeService();

    const report = await svc.auditPriceCatalogue();

    expect(report.ok).toBe(false);
    const community = report.plans.find((p) => p.slug === 'community');
    expect(community?.problems.join(' ')).toMatch(/price_seed_community.*placeholder/);
    expect(community?.problems.join(' ')).toMatch(/price_seed_community_annual.*placeholder/);
  });

  /**
   * Starter can NEVER shed its placeholder: `plans_stripe_price_matches_mode`
   * refuses a stripe-mode plan with a null price id, and Starter is stripe-mode
   * and free. If that counted as a problem, `ok` could never become true and
   * the operator would learn to ignore the whole check — the same
   * never-goes-green failure the retry sweep's give-up budget exists to avoid.
   * It is reported, just not as a defect.
   */
  it('does not hold the free tier against the catalogue, but says why', async () => {
    planFindMany.mockResolvedValue([STARTER]);
    const { svc, driver } = makeService();

    const report = await svc.auditPriceCatalogue();

    expect(report.ok).toBe(true);
    expect(report.plans[0]?.problems).toEqual([]);
    expect(report.plans[0]?.notes.join(' ')).toMatch(/price_seed_starter is never used/);
    // And it costs no Stripe call, because nothing can ever buy it.
    expect(driver.getPrice).not.toHaveBeenCalled();
  });

  it('the catalogue audit rejects a monthly Price sitting in the annual column', async () => {
    planFindMany.mockResolvedValue([
      {
        ...COMMUNITY,
        stripePriceId: 'price_month',
        stripeAnnualPriceId: 'price_month_in_annual_column',
      },
    ]);
    const { svc } = makeService({
      getPrice: vi.fn(async (id: string) => ({
        id,
        active: true,
        currency: 'eur',
        // Both are the €39 MONTHLY price; the annual column expects 39000/year.
        unitAmount: 3900,
        interval: 'month',
        intervalCount: 1,
      })),
    });

    const report = await svc.auditPriceCatalogue();

    const problems = report.plans[0]?.problems.join(' ') ?? '';
    expect(report.ok).toBe(false);
    expect(problems).toMatch(/annual Price price_month_in_annual_column charges 3900/);
    expect(problems).toMatch(/must hold a 1-year Price/);
  });

  it('the catalogue audit rejects the SAME id in both columns', async () => {
    planFindMany.mockResolvedValue([
      { ...COMMUNITY, stripePriceId: 'price_dup', stripeAnnualPriceId: 'price_dup' },
    ]);
    const { svc } = makeService({
      getPrice: vi.fn(async (id: string) => ({
        id,
        active: true,
        currency: 'eur',
        unitAmount: 3900,
        interval: 'month',
        intervalCount: 1,
      })),
    });

    const report = await svc.auditPriceCatalogue();

    expect(report.plans[0]?.problems.join(' ')).toMatch(/SAME price id \(price_dup\)/);
  });

  it('the catalogue audit reports a Price Stripe has never heard of', async () => {
    planFindMany.mockResolvedValue([
      {
        ...COMMUNITY,
        stripePriceId: 'price_typo',
        stripeAnnualPriceId: null,
        annualPriceCents: null,
      },
    ]);
    const { svc } = makeService({ getPrice: vi.fn().mockResolvedValue(null) });

    const report = await svc.auditPriceCatalogue();

    expect(report.plans[0]?.problems.join(' ')).toMatch(/Stripe has no Price price_typo/);
  });

  it('the catalogue audit passes only when Stripe agrees on amount, currency and interval', async () => {
    planFindMany.mockResolvedValue([
      { ...COMMUNITY, stripePriceId: 'price_m', stripeAnnualPriceId: 'price_y' },
    ]);
    const { svc } = makeService({
      getPrice: vi.fn(async (id: string) =>
        id === 'price_m'
          ? {
              id,
              active: true,
              currency: 'eur',
              unitAmount: 3900,
              interval: 'month',
              intervalCount: 1,
            }
          : {
              id,
              active: true,
              currency: 'eur',
              unitAmount: 39000,
              interval: 'year',
              intervalCount: 1,
            },
      ),
    });

    const report = await svc.auditPriceCatalogue();

    expect(report.plans[0]?.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// billing-11 — the free tier is chosen, never bought
// ---------------------------------------------------------------------------

describe('billing-11: the downgrade-to-free path does not go through Stripe', () => {
  it('startCheckout refuses a free plan instead of opening Checkout on a €0 price', async () => {
    const { svc, driver } = makeService();

    // The message matters: Starter would ALSO be caught by the placeholder
    // check a line later, and a test that only asserts "it throws" could not
    // tell the two guards apart.
    await expect(svc.startCheckout(TENANT, { planSlug: 'starter' })).rejects.toThrow(
      /is free — there is nothing to check out/,
    );
    await expect(svc.startCheckout(TENANT, { planSlug: 'starter' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(driver.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('startCheckout refuses a paid plan whose price is still the seeded placeholder', async () => {
    subFindUnique.mockResolvedValue(subRow({ planId: STARTER.id, stripeSubscriptionId: null }));
    const { svc, driver } = makeService();

    await expect(svc.startCheckout(TENANT, { planSlug: 'community' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(driver.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('selectPlan on a PAYING library cancels at period end rather than dropping its plan', async () => {
    const { svc, driver } = makeService();

    await svc.selectPlan(TENANT, { planSlug: 'starter' });

    expect(driver.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith('sub_live');
    // The plan itself must NOT move yet: they have paid for the rest of the
    // period, and `customer.subscription.deleted` moves the row when it ends.
    expect(lastUpdate()).toEqual({ cancelAtPeriodEnd: true });
  });

  it('selectPlan on a library with no subscription switches immediately', async () => {
    subFindUnique.mockResolvedValue(subRow({ stripeSubscriptionId: null }));
    const { svc, driver } = makeService();

    await svc.selectPlan(TENANT, { planSlug: 'starter' });

    expect(driver.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ planId: STARTER.id, status: 'active' });
  });

  /**
   * Round 2. The free-plan branch round 1 added to PlanGrid was correct AND it
   * handed a CONTRACTED library a working one-click self-downgrade it never
   * had. That is the state `applyAdminPlanChange` now leaves behind
   * (billingMode='manual', stripeSubscriptionId=null, per billing-12), and it
   * is how the launch-offer cohort is provisioned
   * (`tenant-create.ts --billing-mode=manual --paid-until=<+12mo>`), so the
   * click would have thrown away twelve prepaid months.
   */
  it('selectPlan REFUSES a contracted library trying to move itself off its plan', async () => {
    subFindUnique.mockResolvedValue(
      subRow({ billingMode: 'manual', stripeSubscriptionId: null, planId: COMMUNITY.id }),
    );
    const { svc } = makeService();

    await expect(svc.selectPlan(TENANT, { planSlug: 'starter' })).rejects.toThrow(
      /billed by contract/,
    );
    // The specific damage: the direct-update branch rewrote billingMode from
    // 'manual' to the target plan's 'stripe', with no admin involvement and no
    // audit row. Nothing may be written at all.
    expect(subUpdate).not.toHaveBeenCalled();
    expect(subUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * …but it must not become a dead end. With subscriptions on, a contracted
   * library that has never stamped `planSelectedAt` is held by the full-page
   * chooser until it picks something. Confirming the plan it is already on is
   * the way out, and it must change nothing else.
   */
  /**
   * The other self-serve route. `startCheckout` only ever inspected the PLAN's
   * billingMode, so a contract library could open Stripe Checkout for itself
   * and be charged a card on top of the invoice it has already paid — the
   * completed-session handlers copy the plan's 'stripe' mode over the contract.
   * The forced chooser sends every PAID card here, so closing selectPlan alone
   * would only have moved the hole.
   */
  it('startCheckout REFUSES a contracted library trying to buy a different plan', async () => {
    subFindUnique.mockResolvedValue(
      subRow({ billingMode: 'manual', stripeSubscriptionId: null, planId: STARTER.id }),
    );
    const { svc, driver } = makeService();

    await expect(svc.startCheckout(TENANT, { planSlug: 'community' })).rejects.toThrow(
      /billed by contract/,
    );
    expect(driver.createCheckoutSession).not.toHaveBeenCalled();
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it('startCheckout lets a contracted library confirm its own plan without paying', async () => {
    subFindUnique.mockResolvedValue(
      subRow({ billingMode: 'manual', stripeSubscriptionId: null, planSelectedAt: null }),
    );
    const { svc, driver } = makeService();

    const result = await svc.startCheckout(TENANT, { planSlug: 'community' });

    // No Stripe, no plan move — just the stamp the chooser is waiting for.
    expect(driver.createCheckoutSession).not.toHaveBeenCalled();
    expect(result.outcome).toBe('plan_changed');
    expect(result.sessionId).toBeNull();
    expect(subUpdate).not.toHaveBeenCalled();
    expect(subUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, planSelectedAt: null },
      data: { planSelectedAt: expect.any(Date) },
    });
  });

  it('selectPlan lets a contracted library confirm the plan it is already on', async () => {
    subFindUnique.mockResolvedValue(
      subRow({ billingMode: 'manual', stripeSubscriptionId: null, planSelectedAt: null }),
    );
    const { svc } = makeService();

    await svc.selectPlan(TENANT, { planSlug: 'community' });

    expect(subUpdate).not.toHaveBeenCalled();
    expect(subUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, planSelectedAt: null },
      data: { planSelectedAt: expect.any(Date) },
    });
  });
});

// ---------------------------------------------------------------------------
// billing-12 — moving a library off Stripe must stop the card
// ---------------------------------------------------------------------------

describe('billing-12: admin set-plan onto a manual plan stops the Stripe subscription', () => {
  it('cancels at period end and clears the pointer', async () => {
    const { svc, driver } = makeService();

    await svc.applyAdminPlanChange(TENANT, { planSlug: 'on-prem-enterprise' }, ACTOR);

    expect(driver.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith('sub_live');
    expect(lastUpdate()).toMatchObject({
      planId: ONPREM.id,
      billingMode: 'manual',
      stripeSubscriptionId: null,
    });
  });

  it('records the abandoned subscription id in the admin audit trail', async () => {
    const { svc } = makeService();

    await svc.applyAdminPlanChange(TENANT, { planSlug: 'on-prem-enterprise' }, ACTOR);

    const entry = (recordAdminAudit as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(entry.before).toMatchObject({ stripeSubscriptionId: 'sub_live' });
    expect(entry.after).toMatchObject({
      stripeSubscriptionId: null,
      stripeSubscriptionCancelledAtPeriodEnd: true,
    });
  });

  it('refuses the whole change when Stripe will not cancel, so it cannot half-apply', async () => {
    const { svc } = makeService({
      cancelSubscriptionAtPeriodEnd: vi.fn().mockRejectedValue(new Error('Stripe is down')),
    });

    await expect(
      svc.applyAdminPlanChange(TENANT, { planSlug: 'on-prem-enterprise' }, ACTOR),
    ).rejects.toThrow(/Stripe is down/);
    expect(subUpdate).not.toHaveBeenCalled();
  });

  it('leaves a live subscription alone when the target is another PAID stripe plan', async () => {
    subFindUnique.mockResolvedValue(subRow({ planId: STARTER.id }));
    const { svc, driver } = makeService();

    await svc.applyAdminPlanChange(TENANT, { planSlug: 'community' }, ACTOR);

    expect(driver.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    expect(lastUpdate()).not.toHaveProperty('stripeSubscriptionId');
  });
});

// ---------------------------------------------------------------------------
// launch-readiness-02 — the founding-library offer, grantable through the product
// ---------------------------------------------------------------------------

describe('launch-readiness-02: a paid stripe plan can be granted on invoice terms', () => {
  it('writes manual billing for a stripe plan when the admin asks for it', async () => {
    // The whole offer: twelve months of a paid plan at no charge. Without the
    // override the subscription got billingMode 'stripe' from the plan, and
    // applyManualPayment then refused the paid-until date the offer is made of
    // — so the advertised offer could not be granted through the product, and
    // the documented workaround was an UPDATE typed against production by hand.
    const { svc } = makeService();

    await svc.applyAdminPlanChange(
      TENANT,
      { planSlug: 'community', billingModeOverride: 'manual' },
      ACTOR,
    );

    expect(lastUpdate()).toMatchObject({ planId: COMMUNITY.id, billingMode: 'manual' });
  });

  it('stops the card, because a library we agreed to invoice must not still be charged', async () => {
    const { svc, driver } = makeService();

    await svc.applyAdminPlanChange(
      TENANT,
      { planSlug: 'community', billingModeOverride: 'manual' },
      ACTOR,
    );

    expect(driver.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith('sub_live');
    expect(lastUpdate()).toMatchObject({ stripeSubscriptionId: null });
  });

  it('marks the override in the audit trail, so it reads as a decision and not a state', async () => {
    const { svc } = makeService();

    await svc.applyAdminPlanChange(
      TENANT,
      { planSlug: 'community', billingModeOverride: 'manual' },
      ACTOR,
    );

    const entry = (recordAdminAudit as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
    expect(entry.after).toMatchObject({ billingMode: 'manual', overrodeBillingMode: true });
  });

  it('without the override the same plan is still billed by card — the default is unchanged', async () => {
    subFindUnique.mockResolvedValue(subRow({ planId: STARTER.id }));
    const { svc, driver } = makeService();

    await svc.applyAdminPlanChange(TENANT, { planSlug: 'community' }, ACTOR);

    expect(lastUpdate()).toMatchObject({ billingMode: 'stripe' });
    expect(driver.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// billing-09 — one library, one Stripe customer
// ---------------------------------------------------------------------------

describe('billing-09: ensureStripeCustomer cannot split a library in two', () => {
  it('sends a stable Idempotency-Key so two concurrent starts get one customer', async () => {
    subFindUnique.mockResolvedValue(subRow({ stripeSubscriptionId: null, planId: STARTER.id }));
    planFindUnique.mockResolvedValue({ ...COMMUNITY, stripePriceId: 'price_real_month' });
    const { svc, driver } = makeService();

    await svc.startCheckout(TENANT, { planSlug: 'community' });

    expect(driver.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `libriant:customer:${TENANT}` }),
    );
  });

  it('claims the customer column only while it is still empty', async () => {
    subFindUnique.mockResolvedValue(subRow({ stripeSubscriptionId: null, planId: STARTER.id }));
    planFindUnique.mockResolvedValue({ ...COMMUNITY, stripePriceId: 'price_real_month' });
    const { svc } = makeService();

    await svc.startCheckout(TENANT, { planSlug: 'community' });

    expect(accountUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, stripeCustomerId: null },
      data: { stripeCustomerId: 'cus_new' },
    });
  });

  it('a racer that loses ADOPTS the winner id instead of overwriting it', async () => {
    subFindUnique.mockResolvedValue(subRow({ stripeSubscriptionId: null, planId: STARTER.id }));
    planFindUnique.mockResolvedValue({ ...COMMUNITY, stripePriceId: 'price_real_month' });
    // The other request got there first: our conditional claim matches nothing.
    accountUpdateMany.mockResolvedValue({ count: 0 });
    // THREE reads happen, in this order, and the first two MUST still be null
    // — otherwise the service returns the cached id at the top of
    // `ensureStripeCustomer` and this test never reaches the race at all:
    //   1. startCheckout, deciding whether to ask Stripe about the customer
    //   2. ensureStripeCustomer's own get-or-create read
    //   3. the post-claim read that discovers who won
    accountFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ stripeCustomerId: 'cus_winner' });
    const { svc, driver } = makeService();

    await svc.startCheckout(TENANT, { planSlug: 'community' });

    // The Checkout session must open on the customer the ROW holds — a session
    // on the abandoned one produces a live subscription every webhook drops.
    expect(driver.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_winner' }),
    );
    expect(accountCreate).not.toHaveBeenCalled();
  });
});
