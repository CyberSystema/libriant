/**
 * Brute-force defenses for support-key redemption (plan §"Rate limiting &
 * brute-force defenses").
 *
 * The decision is a pure function of three counts so it can be unit-tested
 * without a DB. The controller does the counting against
 * `support_redemption_attempts` and delegates the verdict here.
 *
 * Limits:
 *   - 5 attempts / minute / admin
 *   - 10 attempts / minute / IP
 *   - 10 FAILED attempts / hour / admin → temporary lockout (the rolling
 *     window self-heals after an hour; an explicit owner-tier unlock is a
 *     documented future enhancement).
 */
export const REDEEM_LIMITS = {
  adminPerMinute: 5,
  ipPerMinute: 10,
  failedPerHourLockout: 10,
} as const;

export type RedeemAttemptCounts = {
  /** Attempts (success + fail) by this admin in the last 60s. */
  adminLastMinute: number;
  /** Attempts (success + fail) from this IP in the last 60s. */
  ipLastMinute: number;
  /** FAILED attempts by this admin in the last hour. */
  adminFailedLastHour: number;
};

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: 'locked_out' | 'admin_rate' | 'ip_rate'; message: string };

export function evaluateRedeemRateLimit(counts: RedeemAttemptCounts): RateLimitDecision {
  // Lockout (the most severe) is checked first so its message wins.
  if (counts.adminFailedLastHour >= REDEEM_LIMITS.failedPerHourLockout) {
    return {
      allowed: false,
      reason: 'locked_out',
      message:
        'Too many failed support-key redemptions on this account. ' +
        'Redemption is temporarily locked. Try again later or ask an owner to restore access.',
    };
  }
  if (counts.adminLastMinute >= REDEEM_LIMITS.adminPerMinute) {
    return {
      allowed: false,
      reason: 'admin_rate',
      message: 'Too many redemption attempts. Please wait a minute and try again.',
    };
  }
  if (counts.ipLastMinute >= REDEEM_LIMITS.ipPerMinute) {
    return {
      allowed: false,
      reason: 'ip_rate',
      message:
        'Too many redemption attempts from this network. Please wait a minute and try again.',
    };
  }
  return { allowed: true };
}
