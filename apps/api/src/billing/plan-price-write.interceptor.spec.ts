import { BadRequestException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * billing-10, round 2 — the write-time guard.
 *
 * Round 1 shipped `GET /admin/billing/price-catalogue`, which works. It was
 * refuted because the defect the finding actually names survived it:
 *
 *   > `PATCH /admin/plans/:slug` with `{"stripeAnnualPriceId":"price_monthly_39"}`
 *   > is still accepted. The audit would report it afterwards, but only if
 *   > someone runs the audit.
 *
 * Every test below drives `PlanPriceWriteInterceptor.intercept()` — the method
 * Nest calls on the real route — with an ExecutionContext whose `getClass()`
 * is the REAL `AdminPlansController`, so a guard that stopped matching the
 * route would fail here rather than pass. The companion integration spec
 * (test/integration/admin-plan-price-write.spec.ts) proves the same code is
 * reached over HTTP through the booted app.
 */
const { planFindUnique, planFindFirst } = vi.hoisted(() => ({
  planFindUnique: vi.fn(),
  planFindFirst: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { plan: { findUnique: planFindUnique, findFirst: planFindFirst } },
}));

import { AdminPlansController } from '../admin/admin-plans.controller.js';
import { PlanPriceWriteInterceptor } from './plan-price-write.interceptor.js';
import type { StripeDriver, StripePriceState } from './stripe-driver.js';

/** Community exactly as the seed ships it: placeholders in both columns. */
const SEEDED_COMMUNITY = {
  id: 'p-comm',
  slug: 'community',
  billingMode: 'stripe' as const,
  monthlyPriceCents: 3900,
  annualPriceCents: 39000,
  currency: 'EUR',
  stripePriceId: 'price_seed_community',
  stripeAnnualPriceId: 'price_seed_community_annual',
};

/** The same plan once an operator has configured it properly. */
const CONFIGURED_COMMUNITY = {
  ...SEEDED_COMMUNITY,
  stripePriceId: 'price_live_month_39',
  stripeAnnualPriceId: 'price_live_year_390',
};

const STARTER = {
  id: 'p-starter',
  slug: 'starter',
  billingMode: 'stripe' as const,
  monthlyPriceCents: 0,
  annualPriceCents: null,
  currency: 'EUR',
  stripePriceId: 'price_seed_starter',
  stripeAnnualPriceId: null,
};

const ONPREM = {
  id: 'p-onprem',
  slug: 'on-prem-enterprise',
  billingMode: 'manual' as const,
  monthlyPriceCents: 0,
  annualPriceCents: null,
  currency: 'EUR',
  stripePriceId: null,
  stripeAnnualPriceId: null,
};

/**
 * The €39-a-MONTH Price. Pasting this id into the annual column is the exact
 * mis-billing the finding is named for, and it is what `price_monthly_39`
 * resolves to in the bypass test.
 */
const MONTHLY_39: StripePriceState = {
  id: 'price_monthly_39',
  active: true,
  currency: 'eur',
  unitAmount: 3900,
  interval: 'month',
  intervalCount: 1,
};

const YEARLY_390: StripePriceState = {
  id: 'price_live_year_390',
  active: true,
  currency: 'eur',
  unitAmount: 39000,
  interval: 'year',
  intervalCount: 1,
};

function makeInterceptor(
  opts: { kind?: 'real' | 'fake' | 'disabled'; prices?: Record<string, StripePriceState> } = {},
) {
  const prices = opts.prices ?? {};
  const getPrice = vi.fn(async (id: string) => prices[id] ?? null);
  const driver = {
    isReal: opts.kind === 'real',
    kind: opts.kind ?? 'real',
    getPrice,
  } as unknown as StripeDriver;
  return { interceptor: new PlanPriceWriteInterceptor(driver), getPrice };
}

/** A handler double: `handle()` is only called when the write is allowed through. */
function makeNext(): CallHandler & { handle: ReturnType<typeof vi.fn> } {
  return { handle: vi.fn(() => 'HANDLER RAN') } as never;
}

function ctx(
  body: unknown,
  opts: { slug?: string; method?: string; cls?: unknown } = {},
): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => opts.cls ?? AdminPlansController,
    getHandler: () => AdminPlansController.prototype.update,
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method ?? 'PATCH',
        params: { slug: opts.slug ?? 'community' },
        body,
      }),
    }),
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  planFindUnique.mockReset().mockResolvedValue(SEEDED_COMMUNITY);
  planFindFirst.mockReset().mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// The refutation, made into an assertion
// ---------------------------------------------------------------------------

describe('billing-10: PATCH /admin/plans/:slug refuses a bad price id at the write', () => {
  it('REFUSES a monthly Price id pasted into the annual column', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    const { interceptor } = makeInterceptor({
      kind: 'real',
      prices: { price_monthly_39: MONTHLY_39 },
    });
    const next = makeNext();

    // Verbatim from the refutation.
    const promise = interceptor.intercept(ctx({ stripeAnnualPriceId: 'price_monthly_39' }), next);

    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(promise).rejects.toThrow(/must hold a 1-year Price/);
    // The row must never reach the handler: this is a refusal, not a warning.
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('also catches the amount, so the page and the card cannot disagree', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    const { interceptor } = makeInterceptor({
      kind: 'real',
      prices: { price_monthly_39: MONTHLY_39 },
    });

    await expect(
      interceptor.intercept(ctx({ stripeAnnualPriceId: 'price_monthly_39' }), makeNext()),
    ).rejects.toThrow(/charges 3900 but the plan advertises 39000/);
  });

  it('ACCEPTS an annual id whose amount, currency and interval all agree', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    const { interceptor, getPrice } = makeInterceptor({
      kind: 'real',
      prices: { price_live_year_390: YEARLY_390 },
    });
    const next = makeNext();

    const result = await interceptor.intercept(
      ctx({ stripeAnnualPriceId: 'price_live_year_390' }),
      next,
    );

    // A guard that refused everything would pass every test above and be
    // useless; this is the control that says it lets a correct write through.
    expect(result).toBe('HANDLER RAN');
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(getPrice).toHaveBeenCalledWith('price_live_year_390');
  });

  it('refuses the seeded placeholder the whole catalogue ships with', async () => {
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: 'price_seed_community' }), makeNext()),
    ).rejects.toThrow(/seeded placeholder/);
  });

  it('refuses a Product id, the easiest thing to copy out of the Dashboard by mistake', async () => {
    const { interceptor, getPrice } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: 'prod_QxSomething' }), makeNext()),
    ).rejects.toThrow(/starts with "price_"/);
    // Refused on shape alone — no Stripe call is spent on it.
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('refuses an id with copy-paste whitespace rather than storing it', async () => {
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: ' price_live_month_39 ' }), makeNext()),
    ).rejects.toThrow(/leading or trailing whitespace/);
  });

  it('refuses an empty string, which @IsString and the CHECK constraint both accept', async () => {
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(interceptor.intercept(ctx({ stripePriceId: '' }), makeNext())).rejects.toThrow(
      /is not a Stripe Price id/,
    );
  });

  it('refuses the SAME id in both columns — Postgres accepts it, we must not', async () => {
    planFindUnique.mockResolvedValue({
      ...CONFIGURED_COMMUNITY,
      stripeAnnualPriceId: 'price_live_month_39',
    });
    const { interceptor } = makeInterceptor({
      kind: 'real',
      prices: { price_live_month_39: { ...MONTHLY_39, id: 'price_live_month_39' } },
    });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: 'price_live_month_39' }), makeNext()),
    ).rejects.toThrow(/both hold price_live_month_39/);
  });

  it('refuses an id that already backs another plan (otherwise a P2002 500)', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    planFindFirst.mockResolvedValue({ slug: 'municipal' });
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: 'price_live_month_79' }), makeNext()),
    ).rejects.toThrow(/already the price id of the "municipal" plan/);
  });

  it('refuses an annual id on a plan that advertises no annual price', async () => {
    planFindUnique.mockResolvedValue({ ...STARTER, monthlyPriceCents: 3900 });
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(ctx({ stripeAnnualPriceId: 'price_live_year_390' }), makeNext()),
    ).rejects.toThrow(/advertises no annual price/);
  });

  it('refuses a Stripe price id on a plan billed by contract', async () => {
    planFindUnique.mockResolvedValue(ONPREM);
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(
        ctx({ stripePriceId: 'price_live_month_39' }, { slug: 'on-prem-enterprise' }),
        makeNext(),
      ),
    ).rejects.toThrow(/billed manual/);
  });

  it('refuses a real Price on the free tier, which is never sold through Checkout', async () => {
    planFindUnique.mockResolvedValue(STARTER);
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(
        ctx({ stripePriceId: 'price_live_month_39' }, { slug: 'starter' }),
        makeNext(),
      ),
    ).rejects.toThrow(/never sold through Checkout/);
  });

  /**
   * The money-only shape. Nothing about the ids changes, but after the write
   * the plan would advertise €49 while the Stripe Price still charges €39 —
   * "the advertised price and the charged price differ with nothing to detect
   * it", which is the finding's own sentence.
   */
  it('refuses an amount change that would desync an already-configured Price', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    const { interceptor } = makeInterceptor({
      kind: 'real',
      prices: {
        price_live_month_39: { ...MONTHLY_39, id: 'price_live_month_39' },
        price_live_year_390: YEARLY_390,
      },
    });

    await expect(
      interceptor.intercept(ctx({ monthlyPriceCents: 4900 }), makeNext()),
    ).rejects.toThrow(/charges 3900 but the plan advertises 4900/);
  });

  it('refuses a currency change the Stripe Price does not share', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    const { interceptor } = makeInterceptor({
      kind: 'real',
      prices: {
        price_live_month_39: { ...MONTHLY_39, id: 'price_live_month_39' },
        price_live_year_390: YEARLY_390,
      },
    });

    await expect(interceptor.intercept(ctx({ currency: 'USD' }), makeNext())).rejects.toThrow(
      /is in EUR but the plan is priced in USD/,
    );
  });

  it('reports a Price Stripe has never heard of instead of letting Checkout 500', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    const { interceptor } = makeInterceptor({ kind: 'real', prices: {} });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: 'price_typo' }), makeNext()),
    ).rejects.toThrow(/Stripe has no Price price_typo/);
  });

  it('turns billing-11’s 23514 into a sentence instead of a 500', async () => {
    planFindUnique.mockResolvedValue(STARTER);
    const { interceptor } = makeInterceptor({ kind: 'real' });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: null }, { slug: 'starter' }), makeNext()),
    ).rejects.toThrow(/plans_stripe_price_matches_mode/);
  });

  it('refuses to store an id it cannot verify, and names the setting to change', async () => {
    planFindUnique.mockResolvedValue(CONFIGURED_COMMUNITY);
    const { interceptor, getPrice } = makeInterceptor({ kind: 'disabled' });

    await expect(
      interceptor.intercept(ctx({ stripePriceId: 'price_live_month_39' }), makeNext()),
    ).rejects.toThrow(/STRIPE_DRIVER resolves to "disabled"/);
    expect(getPrice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// It must not become a blocker. A previous guard in this package crash-looped
// production; the cost of this one on everything it is not about is zero.
// ---------------------------------------------------------------------------

describe('billing-10: the write guard stays out of the way', () => {
  it('lets a plan rename through without touching the database or Stripe', async () => {
    const { interceptor, getPrice } = makeInterceptor({ kind: 'disabled' });
    const next = makeNext();

    const result = await interceptor.intercept(
      ctx({ name: 'Community', description: 'x', isPublic: true, sortOrder: 5 }),
      next,
    );

    expect(result).toBe('HANDLER RAN');
    expect(planFindUnique).not.toHaveBeenCalled();
    expect(getPrice).not.toHaveBeenCalled();
  });

  it('lets an amount change through on a plan whose ids are still placeholders', async () => {
    // The SHIPPED catalogue. Nothing here can mis-bill anyone, so repricing on
    // a server with no Stripe must keep working.
    const { interceptor } = makeInterceptor({ kind: 'disabled' });
    const next = makeNext();

    await interceptor.intercept(ctx({ monthlyPriceCents: 4900, annualPriceCents: 49000 }), next);

    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('ignores requests to every other controller', async () => {
    class SomeOtherController {}
    const { interceptor } = makeInterceptor({ kind: 'real' });
    const next = makeNext();

    await interceptor.intercept(
      ctx({ stripePriceId: 'price_seed_community' }, { cls: SomeOtherController }),
      next,
    );

    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(planFindUnique).not.toHaveBeenCalled();
  });

  it('ignores non-PATCH requests to the plans controller', async () => {
    const { interceptor } = makeInterceptor({ kind: 'real' });
    const next = makeNext();

    await interceptor.intercept(
      ctx({ stripePriceId: 'price_seed_community' }, { method: 'PUT' }),
      next,
    );

    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(planFindUnique).not.toHaveBeenCalled();
  });

  it('leaves an unknown slug to the handler’s own 404', async () => {
    planFindUnique.mockResolvedValue(null);
    const { interceptor } = makeInterceptor({ kind: 'real' });
    const next = makeNext();

    await interceptor.intercept(
      ctx({ stripePriceId: 'price_seed_community' }, { slug: 'nope' }),
      next,
    );

    expect(next.handle).toHaveBeenCalledTimes(1);
  });
});
