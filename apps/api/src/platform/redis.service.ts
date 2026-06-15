import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { loadEnv } from '../config/env.js';

/**
 * Singleton Redis client shared across the API process.
 *
 * Used by:
 *   - TenantResolverService (slug → tenant context cache)
 *   - Webhook dedupe (Stripe / future)
 *   - Rate limiting (auth + support redemption)
 *
 * Lifecycle: connect at app start, gracefully `quit` on shutdown.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor() {
    const env = loadEnv();
    this.client = new Redis(env.redisUrl, {
      lazyConnect: false,
      // Don't queue commands during disconnects; surface failures fast.
      enableOfflineQueue: false,
      // Reasonable default retry: backoff up to 2 s.
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 2000),
      maxRetriesPerRequest: 3,
      // Distinguishes our keys from any cohabitating consumer in the same Redis.
      keyPrefix: 'lbr:',
    });

    this.client.on('error', (err: Error) => this.logger.error(`Redis error: ${err.message}`));
    // REL-05: redact any credentials before logging — when REDIS_URL carries a
    // password it would otherwise land in stdout/Docker logs on every reconnect.
    this.client.on('connect', () =>
      this.logger.log(`Connected to Redis at ${redactUrl(env.redisUrl)}`),
    );
  }

  async onModuleDestroy() {
    if (this.client.status === 'ready' || this.client.status === 'connecting') {
      await this.client.quit();
    }
  }

  /** Quick liveness ping used by `/readyz`. */
  async ping(): Promise<boolean> {
    try {
      const r = await this.client.ping();
      return r === 'PONG';
    } catch {
      return false;
    }
  }
}

/**
 * Strip the password from a `redis://user:pass@host` URL before logging.
 * Mirrors the `redactUrl` pattern in `email/drivers/smtp-driver.ts` (REL-05).
 */
function redactUrl(u: string): string {
  return u.replace(/:[^:@/]+@/, ':***@');
}
