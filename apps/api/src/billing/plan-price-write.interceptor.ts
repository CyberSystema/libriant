import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { controlDb } from '@libriant/db-control';
import { AdminPlansController } from '../admin/admin-plans.controller.js';
import { STRIPE_DRIVER, type StripeDriver, type StripePriceState } from './stripe-driver.js';
import {
  isUsableStripePriceId,
  stripePriceProblems,
  unusablePriceIdProblem,
  type PriceColumnLabel,
  type PriceLookupOutcome,
} from './plan-price-check.js';

/**
 * Refuse a bad Stripe price id AT THE WRITE (billing-10, round 2).
 *
 * WHAT WENT WRONG. `PATCH /admin/plans/:slug` takes `stripePriceId` and
 * `stripeAnnualPriceId` as bare optional strings: no format check, no call to
 * Stripe, no check that the amount / the currency / the recurring INTERVAL
 * match the column the id is being written into, and no guard against the same
 * id landing in both columns (Postgres accepts that — both unique indexes are
 * satisfied; the auditor executed it). A monthly id pasted into the annual
 * column bills €39 every month to a library that clicked "390 € a year".
 *
 * Round 1 answered this with `GET /admin/billing/price-catalogue`, a real
 * reconciliation that really can fail. It was refuted, correctly:
 *
 *   > `PATCH /admin/plans/:slug` with `{"stripeAnnualPriceId":"price_monthly_39"}`
 *   > is still accepted. The audit would report it afterwards, but only if
 *   > someone runs the audit.
 *
 * A report nobody is scheduled to read is not a control. This is the control.
 *
 * WHY AN INTERCEPTOR, AND NOT A CHECK INSIDE THE HANDLER. The handler lives in
 * `AdminPlansController`, i.e. in `AdminModule` — and `BillingModule` already
 * imports `AdminModule` for the admin guards, so having the plans controller
 * inject anything of billing's would close a module cycle. An interceptor
 * registered as an `APP_INTERCEPTOR` by `BillingModule` attaches billing's
 * invariant to that route with the dependency arrow pointing the way it already
 * points. It is the same mechanism `SupportAuditInterceptor` uses in
 * `app.module.ts`.
 *
 * WHY AN INTERCEPTOR AND NOT A GUARD. Nest runs GLOBAL guards BEFORE
 * controller-scoped ones, so a global guard here would execute before
 * `AdminAuthGuard`/`AdminRolesGuard` — handing an unauthenticated caller a
 * validator that makes outbound Stripe calls. Interceptors run strictly AFTER
 * all guards, so by the time this code runs the request is an authenticated
 * owner. Do not turn it into a guard.
 *
 * WHAT IT DOES NOT DO: it never touches a request that is not a PATCH on
 * `AdminPlansController`, and it does no database or network work at all unless
 * the body actually carries a price id or an amount/currency an already-stored
 * price id has to keep matching. A plan rename costs one identity comparison.
 */
@Injectable()
export class PlanPriceWriteInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PlanPriceWriteInterceptor.name);

  constructor(@Inject(STRIPE_DRIVER) private readonly stripe: StripeDriver) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    // Class identity, not a string match on the URL: a route rename cannot
    // silently unmount the guard. `AdminPlansController` has exactly one PATCH
    // route (`plans/:slug`), which is the one that writes the price columns.
    if (context.getClass() !== AdminPlansController) return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method !== 'PATCH') return next.handle();

    await this.assertWriteIsSafe(String(req.params?.slug ?? ''), req.body);
    return next.handle();
  }

  /**
   * Throws `BadRequestException` describing everything wrong with the proposed
   * plan row. Silent when the request cannot mis-price anything.
   */
  private async assertWriteIsSafe(slug: string, rawBody: unknown): Promise<void> {
    if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) return;
    const body = rawBody as Record<string, unknown>;

    const writesMonthlyId = Object.hasOwn(body, 'stripePriceId');
    const writesAnnualId = Object.hasOwn(body, 'stripeAnnualPriceId');
    const writesMoney =
      Object.hasOwn(body, 'monthlyPriceCents') ||
      Object.hasOwn(body, 'annualPriceCents') ||
      Object.hasOwn(body, 'currency');
    // Renames, sort order, isPublic… nothing here can make a card disagree with
    // a page. Cost of this interceptor for those: two `Object.hasOwn` calls.
    if (!writesMonthlyId && !writesAnnualId && !writesMoney) return;

    const plan = await controlDb.plan.findUnique({ where: { slug } });
    // No plan: the handler's own 404 is the right answer and is not ours to
    // pre-empt. Same for a wrongly-typed field — `validateDto` produces a
    // better message for that than we could.
    if (!plan) return;

    const nextMonthlyId = this.resolveId(body, 'stripePriceId', plan.stripePriceId);
    const nextAnnualId = this.resolveId(body, 'stripeAnnualPriceId', plan.stripeAnnualPriceId);
    if (nextMonthlyId === 'unreadable' || nextAnnualId === 'unreadable') return;

    const nextMonthlyCents = this.resolveInt(body, 'monthlyPriceCents', plan.monthlyPriceCents);
    const nextAnnualCents = this.resolveInt(body, 'annualPriceCents', plan.annualPriceCents);
    const nextCurrency =
      typeof body.currency === 'string' && body.currency.trim() ? body.currency : plan.currency;
    if (nextMonthlyCents === 'unreadable' || nextAnnualCents === 'unreadable') return;

    const problems: string[] = [];

    // ---- structural checks, no network -------------------------------------
    const columns: Array<{
      label: PriceColumnLabel;
      nextId: string | null;
      storedId: string | null;
      written: boolean;
      cents: number | null;
      interval: 'month' | 'year';
    }> = [
      {
        label: 'monthly',
        nextId: nextMonthlyId,
        storedId: plan.stripePriceId,
        written: writesMonthlyId,
        cents: nextMonthlyCents,
        interval: 'month',
      },
      {
        label: 'annual',
        nextId: nextAnnualId,
        storedId: plan.stripeAnnualPriceId,
        written: writesAnnualId,
        cents: nextAnnualCents,
        interval: 'year',
      },
    ];

    for (const column of columns) {
      if (column.written && column.nextId === null && column.storedId !== null) {
        // billing-11's other half, turned from a 500 into a sentence. The
        // `plans_stripe_price_matches_mode` CHECK (migration
        // 20260822140000_repricing) refuses a `billingMode='stripe'` plan with a
        // NULL monthly price id, so `UPDATE plans SET "stripePriceId"=NULL WHERE
        // slug='starter'` comes back 23514 — which reached the operator as a
        // Prisma stack trace and an HTTP 500. Say what the database is going to
        // say, before it says it.
        if (column.label === 'monthly' && plan.billingMode === 'stripe') {
          problems.push(
            'the monthly price id cannot be cleared while this plan is billed through Stripe — ' +
              'the plans_stripe_price_matches_mode CHECK constraint refuses a stripe-mode plan ' +
              'with a null monthly price id (Postgres 23514). Relaxing it for a plan priced at ' +
              'zero needs a migration in packages/db-control',
          );
        }
        continue;
      }
      if (column.nextId === null) continue;

      if (column.written) {
        if (column.nextId !== column.nextId.trim()) {
          problems.push(
            `the ${column.label} price id has leading or trailing whitespace — Stripe would ` +
              'answer "No such price"; paste just the id',
          );
          continue;
        }
        if (!isUsableStripePriceId(column.nextId)) {
          problems.push(unusablePriceIdProblem(column.label, column.nextId));
          continue;
        }
        if (plan.billingMode !== 'stripe') {
          problems.push(
            `this plan is billed ${plan.billingMode}, so a Stripe Price id on its ${column.label} ` +
              'column is never read and can only mislead the next person to look at the row',
          );
          continue;
        }
        if (column.label === 'monthly' && nextMonthlyCents !== null && nextMonthlyCents <= 0) {
          // A free plan is never sold through Checkout (`startCheckout` refuses
          // `monthlyPriceCents <= 0`), so a real Price on it would be a second
          // fabricated id — indistinguishable from a configured one — for
          // exactly the reason billing-11 names.
          problems.push(
            'this plan is free, so it is never sold through Checkout and a real Stripe Price on ' +
              'it would never be charged — leave the placeholder the CHECK constraint requires',
          );
          continue;
        }
        if (column.label === 'annual' && nextAnnualCents === null) {
          problems.push(
            'an annual price id was set but the plan advertises no annual price — set ' +
              'annualPriceCents in the same request, or send stripeAnnualPriceId: null',
          );
          continue;
        }
      }
    }

    // Same id in both columns. Postgres accepts it (both unique indexes are
    // satisfied — executed by the auditor), and one of the two cadences then
    // charges at the other's interval.
    if (
      (writesMonthlyId || writesAnnualId) &&
      nextMonthlyId !== null &&
      nextAnnualId !== null &&
      nextMonthlyId === nextAnnualId
    ) {
      problems.push(
        `the monthly and annual columns would both hold ${nextMonthlyId} — one of the two ` +
          'cadences would charge the wrong interval',
      );
    }

    // The same id on ANOTHER plan. Both columns are uniquely indexed, so this
    // otherwise surfaces as a Prisma P2002 and an HTTP 500 with no hint of
    // which plan already owns the id.
    for (const column of columns) {
      if (!column.written || column.nextId === null) continue;
      const clash = await controlDb.plan.findFirst({
        where: {
          id: { not: plan.id },
          OR: [{ stripePriceId: column.nextId }, { stripeAnnualPriceId: column.nextId }],
        },
        select: { slug: true },
      });
      if (clash) {
        problems.push(
          `${column.nextId} is already the price id of the "${clash.slug}" plan — one Stripe ` +
            'Price cannot back two plans',
        );
      }
    }

    if (problems.length) throw this.refuse(plan.slug, problems);

    // ---- Stripe round trip -------------------------------------------------
    //
    // Only for columns that will hold a usable id AND whose correctness this
    // request could have changed. A rename never gets here; a plan whose ids are
    // all `price_seed_*` (the shipped catalogue) never gets here either, so
    // editing amounts on an unconfigured server costs nothing.
    const toVerify = columns.filter(
      (c) =>
        c.nextId !== null &&
        isUsableStripePriceId(c.nextId) &&
        (c.written || writesMoney) &&
        plan.billingMode === 'stripe',
    );
    if (!toVerify.length) return;

    if (this.stripe.kind !== 'real') {
      // WHY THIS REFUSES RATHER THAN WAVES THE WRITE THROUGH: the whole finding
      // is that a wrong id is accepted and discovered by a library's card. On a
      // host that cannot ask Stripe, "accept it unverified" reproduces the
      // defect exactly. And a price id is useless on such a host anyway —
      // nothing can charge with it. So the honest answer is no, plus the fix.
      throw new BadRequestException(
        `This server cannot verify a Stripe price id: STRIPE_DRIVER resolves to ` +
          `"${this.stripe.kind}", so there is nothing to ask about ` +
          `${toVerify.map((c) => c.nextId).join(', ')}. A price id it cannot check is a price id ` +
          'it cannot charge with. Set STRIPE_DRIVER=real with STRIPE_API_KEY + ' +
          'STRIPE_WEBHOOK_SECRET and restart the API, then save the plan again.',
      );
    }

    /** Memoised so the same id in two columns costs one call, not two. */
    const cache = new Map<string, PriceLookupOutcome>();
    const lookup = async (id: string): Promise<PriceLookupOutcome> => {
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      let result: PriceLookupOutcome;
      try {
        result = (await this.stripe.getPrice(id)) as StripePriceState | null;
      } catch (err) {
        this.logger.warn(
          `Plan ${plan.slug}: Stripe refused price ${id} during a write check: ${
            (err as Error).message
          }`,
        );
        result = 'error';
      }
      cache.set(id, result);
      return result;
    };

    for (const column of toVerify) {
      problems.push(
        ...stripePriceProblems(
          {
            label: column.label,
            id: column.nextId as string,
            expectedCents: column.cents,
            expectedCurrency: nextCurrency,
            expectedInterval: column.interval,
          },
          await lookup(column.nextId as string),
        ),
      );
    }
    if (problems.length) throw this.refuse(plan.slug, problems);
  }

  /**
   * `undefined`   — the field is absent, keep what the row has.
   * `null`        — an explicit clear.
   * `'unreadable'`— present but not a string; let `validateDto` say so.
   */
  private resolveId(
    body: Record<string, unknown>,
    field: string,
    stored: string | null,
  ): string | null | 'unreadable' {
    if (!Object.hasOwn(body, field)) return stored;
    const value = body[field];
    if (value === null) return null;
    if (typeof value !== 'string') return 'unreadable';
    // Returned VERBATIM, never trimmed. This interceptor cannot change what the
    // handler writes, so validating a cleaned-up copy of the value would be
    // validating something other than the row that lands — `" price_x "` would
    // pass here and be stored with the spaces. An empty string is not
    // normalised to null either: `@IsString` accepts `""` and so does the CHECK
    // constraint, so it would be written as a plan that reads configured to the
    // database and is unsellable to everyone else. Both are caught below.
    return value;
  }

  private resolveInt(
    body: Record<string, unknown>,
    field: string,
    stored: number | null,
  ): number | null | 'unreadable' {
    if (!Object.hasOwn(body, field)) return stored;
    const value = body[field];
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value)) return 'unreadable';
    return value;
  }

  private refuse(slug: string, problems: string[]): BadRequestException {
    this.logger.warn(`Refused a price-id write on plan "${slug}": ${problems.join('; ')}`);
    return new BadRequestException(
      `This price change was not saved. ${problems.map((p) => `Because ${p}.`).join(' ')}`,
    );
  }
}
