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
 * Atomic INCR-then-arm-TTL. Increments the key and, on the FIRST hit of a
 * window (result === 1), sets the expiry in the SAME round-trip so a process
 * death / Redis hiccup between the two commands can't strand a TTL-less
 * counter that never resets (AUTH-04). PEXPIRE is also (re-)armed whenever the
 * key currently has no TTL (PTTL === -1) as a defensive self-heal for any key
 * that slipped through before this fix. Returns the post-INCR count.
 */
const INCR_WITH_TTL_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * Redis-backed fixed-window rate limiter, shared by the unauthenticated edge
 * endpoints (signup / login / password-reset). Keys are namespaced under the
 * RedisService `lbr:` prefix.
 *
 * Counting is an INCR with the TTL armed atomically on the first hit of a
 * window (see {@link INCR_WITH_TTL_LUA}), so the window slides forward in
 * fixed `windowSec` blocks and never wedges a bucket with a stranded counter.
 *
 * Failure policy is per-bucket:
 *   - Cheap endpoints (login / password-reset) **fail open**: if Redis is
 *     unreachable we allow the request rather than locking every user out
 *     during a Redis blip. Per-account lockout (LoginService) is the backstop.
 *   - The signup buckets (`signup:*`) **fail closed** (REM-2): signup
 *     provisions a Postgres DB, so an unthrottled signup path under a Redis
 *     outage re-opens the provisioning-DoS the rate limiter was added to close.
 *     We'd rather refuse signups (loudly) for the duration of a Redis outage
 *     than let an attacker exhaust the cell while Redis is down.
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
    // counting is bypassed. AUTH-07: honoured ONLY outside production — a
    // stray/copied RATE_LIMIT_DISABLED in a prod env file must never silently
    // no-op every limiter, so in production we log loudly and ignore it.
    if (process.env.RATE_LIMIT_DISABLED === 'true') {
      // Read NODE_ENV directly (not loadEnv()) so this hot path never depends
      // on the full env being present/valid, and so a unit test can flip it.
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          'RATE_LIMIT_DISABLED is set in production — IGNORING it. Rate limiting stays ON. ' +
            'Remove this env var; it must only ever be set in test/dev.',
        );
      } else {
        return { allowed: true, count: 0, retryAfterSec: 0 };
      }
    }
    // Signup is expensive (provisions a DB) so its buckets fail CLOSED on a
    // Redis error; every other bucket fails open (auth availability wins).
    const failClosed = key.startsWith('signup:');
    const redisKey = `rl:${key}`;
    try {
      const count = (await this.redis.client.eval(
        INCR_WITH_TTL_LUA,
        1,
        redisKey,
        String(windowSec * 1000),
      )) as number;
      let ttl = windowSec;
      if (count > limit) {
        // Only pay the extra round-trip for a precise Retry-After once tripped.
        const t = await this.redis.client.ttl(redisKey);
        if (t > 0) ttl = t;
      }
      return { allowed: count <= limit, count, retryAfterSec: ttl };
    } catch (err) {
      if (failClosed) {
        // REM-2: deny + log loudly so the signup-provisioning DoS can't
        // re-open under a Redis outage. Logged at error so it pages, not warn.
        this.logger.error(
          `rate-limit check failed for ${redisKey} (DENYING — signup fails closed): ${(err as Error).message}`,
        );
        return { allowed: false, count: limit + 1, retryAfterSec: windowSec };
      }
      this.logger.warn(
        `rate-limit check failed for ${redisKey} (allowing): ${(err as Error).message}`,
      );
      return { allowed: true, count: 0, retryAfterSec: 0 };
    }
  }
}
