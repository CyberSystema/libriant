import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service.js';

export type RateLimitResult = {
  allowed: boolean;
  /** Current count in the window (after this hit). */
  count: number;
  /** Seconds until the window resets (best-effort). */
  retryAfterSec: number;
};

/**
 * Redis-backed fixed-window rate limiter, shared by the unauthenticated edge
 * endpoints (signup / login / password-reset). Keys are namespaced under the
 * RedisService `lbr:` prefix.
 *
 * Counting is a single INCR; the TTL is armed only on the first hit of a
 * window, so the window slides forward in fixed `windowSec` blocks.
 *
 * Failure policy: **fail-open**. If Redis is unreachable we allow the request
 * and log a warning rather than locking every user out of login during a
 * Redis blip. Per-account lockout (LoginService) and the global signup cap
 * remain as backstops, and availability of auth is the higher-order concern.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * Increment the counter for `key` and decide whether the caller is within
   * `limit` over the trailing `windowSec`.
   */
  async hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    // Escape hatch for integration tests, which legitimately exceed the
    // production budgets (many signups/logins from one loopback IP against a
    // shared Redis). The controller→service wiring still runs; only the
    // counting is bypassed. Never set this in any real environment.
    if (process.env.RATE_LIMIT_DISABLED === 'true') {
      return { allowed: true, count: 0, retryAfterSec: 0 };
    }
    const redisKey = `rl:${key}`;
    try {
      const count = await this.redis.client.incr(redisKey);
      if (count === 1) {
        await this.redis.client.expire(redisKey, windowSec);
      }
      let ttl = windowSec;
      if (count > limit) {
        // Only pay the extra round-trip for a precise Retry-After once tripped.
        const t = await this.redis.client.ttl(redisKey);
        if (t > 0) ttl = t;
      }
      return { allowed: count <= limit, count, retryAfterSec: ttl };
    } catch (err) {
      this.logger.warn(
        `rate-limit check failed for ${redisKey} (allowing): ${(err as Error).message}`,
      );
      return { allowed: true, count: 0, retryAfterSec: 0 };
    }
  }
}
