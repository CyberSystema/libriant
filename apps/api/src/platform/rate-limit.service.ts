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
 * Buckets that DENY on a Redis error rather than allowing the request through.
 *
 *   `signup:*`    — REM-2. A signup provisions a Postgres database, so an
 *                   unthrottled signup path under a Redis outage re-opens the
 *                   provisioning-DoS the limiter was added to close.
 *   `apply-all:*` — input-and-files-10. The public application form's only
 *                   throttle was its per-IP bucket, which fails OPEN on
 *                   purpose ("a Redis outage must not eat leads") and leaves a
 *                   honeypot field as the sole defence for the duration of any
 *                   blip. Every accepted submission is a control-plane row plus
 *                   an email to the operator's inbox. This is the
 *                   platform-wide ceiling behind it, and it is the one that has
 *                   to survive Redis being the thing that broke: refusing
 *                   applications for a few minutes is recoverable, a flooded
 *                   inbox and lead table during the launch campaign is not.
 *
 * Everything else fails open — for login and password-reset, an outage that
 * locks every librarian out is worse than one that lets a few extra attempts
 * through, and per-account lockout is the backstop there.
 */
const FAIL_CLOSED_PREFIXES = ['signup:', 'apply-all:'];

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
 *   - The buckets in {@link FAIL_CLOSED_PREFIXES} **fail closed**: each one
 *     guards something that costs the platform real, unbounded resources per
 *     accepted request, so an outage that refuses them loudly is cheaper than
 *     an outage that waves them all through.
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
    const failClosed = FAIL_CLOSED_PREFIXES.some((prefix) => key.startsWith(prefix));
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
        // REM-2: deny + log loudly so the DoS these buckets close can't re-open
        // under a Redis outage. Logged at error so it pages, not warn.
        this.logger.error(
          `rate-limit check failed for ${redisKey} (DENYING — this bucket fails closed): ${(err as Error).message}`,
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
