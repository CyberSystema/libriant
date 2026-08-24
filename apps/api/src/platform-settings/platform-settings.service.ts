import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { RedisService } from '../platform/redis.service.js';
import { isTrustedLocalNodeEnv, resolveStripeDriverKind } from '../billing/stripe-driver-kind.js';
import { loadEnv } from '../config/env.js';

/**
 * Owner-controlled, runtime platform settings — the "switches the admin can
 * flip without a redeploy" layer. Today there is exactly one: the master
 * subscriptions toggle (`billing.enabled`).
 *
 * Resolution order for the toggle:
 *   1. the `platform_settings` row, if it exists (set via the admin panel);
 *   2. otherwise the `BILLING_ENABLED` env var (the bootstrap default).
 *
 * So a fresh install behaves exactly as the env says until the owner flips
 * the switch once in the UI, after which the DB row is the source of truth.
 *
 * Reads are Redis-cached with a short TTL and busted on every write — the
 * same belt-and-braces shape as SystemModeService.
 */
const BILLING_ENABLED_KEY = 'billing.enabled';
const CACHE_KEY = 'platform_setting:billing.enabled';
const CACHE_TTL_SEC = 30;

@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /** Master subscriptions switch. DB row wins; falls back to the env default. */
  async billingEnabled(): Promise<boolean> {
    const cached = await this.redis.client.get(CACHE_KEY);
    if (cached === 'true') return true;
    if (cached === 'false') return false;
    const row = await controlDb.platformSetting.findUnique({
      where: { key: BILLING_ENABLED_KEY },
    });
    const value = row ? row.value === 'true' : loadEnv().billingEnabled;
    await this.redis.client.set(CACHE_KEY, value ? 'true' : 'false', 'EX', CACHE_TTL_SEC);
    return value;
  }

  /**
   * Flip the switch. Persists the row, busts the cache, returns the new value.
   *
   * billing-02, guard 3 — the RUNTIME door. The boot-time guards (the fake
   * driver refuses to exist off a dev/test machine; the factory refuses to
   * start with `BILLING_ENABLED` armed and no driver that can transact) are
   * not on this path at all: this switch is a `platform_settings` row an owner
   * flips from the admin panel with no redeploy and no .env change. A5-03 only
   * warned here, which is how enforcement and the driver were able to diverge
   * in the first place.
   *
   * RECONCILED ASYMMETRY (wave 2). This guard used to exempt `development`
   * only, while the two boot guards exempt `development` AND `test`. The
   * inconsistency was not a considered hardening — it just made the service's
   * own path untestable, so `test/integration/storage-quota.spec.ts` arms
   * enforcement by writing the DB row and busting the cache by hand,
   * exercising a code path no operator ever takes. Aligned on the wider pair,
   * because: (a) `test` is already the trusted-local twin of `development`
   * throughout config/env.ts — it waives the secret-strength floor and ships
   * non-Secure cookies, so a host running NODE_ENV=test is compromised long
   * before this line matters; (b) three guards with three different notions of
   * "local" is itself a defect generator. What we trade: on a box that
   * deliberately declares NODE_ENV=test, an admin can arm enforcement against
   * the in-memory stand-in. That is the configuration the integration suite
   * runs on purpose.
   *
   * The exemption requires the FAKE driver specifically, never `disabled`:
   * arming enforcement with no driver at all gates every library behind a
   * purchase flow that refuses with a 503.
   */
  async setBillingEnabled(enabled: boolean): Promise<boolean> {
    const driverKind = resolveStripeDriverKind().kind;
    const standInIsIntentional = driverKind === 'fake' && isTrustedLocalNodeEnv();
    if (enabled && driverKind !== 'real' && !standInIsIntentional) {
      throw new BadRequestException(
        `Cannot enable subscriptions while STRIPE_DRIVER resolves to "${driverKind}": checkout and ` +
          'the customer portal have nothing that can take a payment, so every library would be ' +
          'gated with no way to buy its way out. ' +
          'Set STRIPE_DRIVER=real with STRIPE_API_KEY + STRIPE_WEBHOOK_SECRET and restart the API first.',
      );
    }
    const value = enabled ? 'true' : 'false';
    await controlDb.platformSetting.upsert({
      where: { key: BILLING_ENABLED_KEY },
      create: { key: BILLING_ENABLED_KEY, value },
      update: { value },
    });
    await this.redis.client.del(CACHE_KEY);
    this.logger.log(`Subscriptions ${enabled ? 'ENABLED' : 'DISABLED'} via admin panel.`);
    return enabled;
  }

  /**
   * Whether billing can actually transact. False for both non-real postures —
   * the in-memory stand-in (dev/test) and `disabled` (the shipped production
   * default, where no Stripe driver is loaded at all).
   */
  stripeReady(): boolean {
    return resolveStripeDriverKind().kind === 'real';
  }

  /**
   * Snapshot for the admin "Subscriptions" page: the switch, whether it's
   * still on the env default, and how many libraries still owe a plan choice
   * (the ones that would be sent through the chooser the moment it's enabled).
   */
  async subscriptionsStatus(): Promise<{
    billingEnabled: boolean;
    source: 'db' | 'env';
    totalTenants: number;
    awaitingChoice: number;
    updatedAt: Date | null;
    stripeReady: boolean;
  }> {
    const [billingEnabled, row, totalTenants, awaitingChoice] = await Promise.all([
      this.billingEnabled(),
      controlDb.platformSetting.findUnique({ where: { key: BILLING_ENABLED_KEY } }),
      controlDb.tenant.count({ where: { archivedAt: null } }),
      controlDb.subscription.count({ where: { planSelectedAt: null } }),
    ]);
    return {
      billingEnabled,
      source: row ? 'db' : 'env',
      totalTenants,
      awaitingChoice,
      updatedAt: row?.updatedAt ?? null,
      // A5-03: false when enforcement could be on but the Stripe driver is fake
      // — the admin UI can warn that checkout won't really charge.
      stripeReady: this.stripeReady(),
    };
  }
}
