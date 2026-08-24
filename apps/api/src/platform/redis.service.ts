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

  /**
   * Resolve once the socket can actually carry a command.
   *
   * `enableOfflineQueue: false` above means a command issued while the socket
   * is still `connecting` does not wait — it rejects immediately with
   * "Stream isn't writeable and enableOfflineQueue options is false". A
   * long-lived client never notices, because it connects at boot and is ready
   * long before the first request. A freshly-constructed one always loses that
   * race: every background job used to do `new RedisService()` and issue a GET
   * on the next tick, so member notifications failed for 100% of tenants on
   * 100% of ticks while still reporting success (reliability-01 / -16).
   *
   * Deliberately does NOT reject on `error`: ioredis emits one per failed
   * reconnect attempt, and `retryStrategy` above always retries, so rejecting
   * there would abandon a connection that is about to come up. The timeout is
   * the backstop for a Redis that is genuinely gone.
   */
  async ready(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.client.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.client.off('ready', onReady);
        this.client.off('end', onEnd);
        if (err) reject(err);
        else resolve();
      };
      const onReady = () => done();
      // 'end' means ioredis gave up (or someone called quit) — waiting out the
      // full timeout after that would only delay the caller's failure.
      const onEnd = () => done(new Error('Redis connection ended before it became ready'));
      const timer = setTimeout(
        () =>
          done(new Error(`Redis not ready after ${timeoutMs}ms (status=${this.client.status})`)),
        timeoutMs,
      );
      this.client.once('ready', onReady);
      this.client.once('end', onEnd);
    });
  }
}

/** How long `ready()` waits for a cold socket before giving up. */
const READY_TIMEOUT_MS = 10_000;

/**
 * A tiny process-local cache that only ever holds values Redis refused to
 * store or serve. It lives next to RedisService because it exists purely to
 * absorb this client's outages.
 *
 * BOOT-01 made every cache read here fail *open* — a Redis error falls through
 * to the control-plane query instead of 500ing the request. Without a memo
 * that turns one unreachable Redis into a control-DB query on EVERY request,
 * which just moves the outage to Postgres. Entries are short-lived, so the
 * extra staleness on top of the caller's own Redis TTL is a few seconds and
 * only during an outage.
 */
export class FailOpenMemo<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    /** Hard cap so a long outage across many tenants can't grow the heap. */
    private readonly maxEntries = 500,
  ) {}

  get(key: string): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Cheapest correct eviction: drop everything. This map is only populated
      // while Redis is down, so churning it costs a DB read, never correctness.
      this.entries.clear();
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(...keys: string[]): void {
    for (const k of keys) this.entries.delete(k);
  }
}

/**
 * Strip the password from a `redis://user:pass@host` URL before logging.
 * Mirrors the `redactUrl` pattern in `email/drivers/smtp-driver.ts` (REL-05).
 */
function redactUrl(u: string): string {
  return u.replace(/:[^:@/]+@/, ':***@');
}
