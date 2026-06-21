import { Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { RedisService } from '../platform/redis.service.js';
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

  /** Flip the switch. Persists the row, busts the cache, returns the new value. */
  async setBillingEnabled(enabled: boolean): Promise<boolean> {
    const value = enabled ? 'true' : 'false';
    await controlDb.platformSetting.upsert({
      where: { key: BILLING_ENABLED_KEY },
      create: { key: BILLING_ENABLED_KEY, value },
      update: { value },
    });
    await this.redis.client.del(CACHE_KEY);
    this.logger.log(`Subscriptions ${enabled ? 'ENABLED' : 'DISABLED'} via admin panel.`);
    // A5-03: enabling enforcement while the Stripe driver is the in-memory
    // stand-in means checkout/portal silently do nothing real — no charges, no
    // subscriptions. Loudly warn outside development so an operator can't flip
    // this on in production against the fake driver without noticing. The admin
    // status snapshot also exposes `stripeReady` so the UI can surface it.
    const env = loadEnv();
    if (enabled && env.stripeDriver !== 'real' && env.nodeEnv !== 'development') {
      this.logger.warn(
        'Subscriptions ENABLED but STRIPE_DRIVER is not "real" — checkout/portal ' +
          'will run the in-memory fake driver (no real charges). Set STRIPE_DRIVER=real ' +
          '+ STRIPE_API_KEY/STRIPE_WEBHOOK_SECRET before charging customers.',
      );
    }
    return enabled;
  }

  /** Whether real billing can actually transact (real driver, or billing off). */
  stripeReady(): boolean {
    return loadEnv().stripeDriver === 'real';
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
