import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { RedisService } from '../platform/redis.service.js';

/**
 * Refuses requests without a verified session (set by SessionMiddleware) and
 * re-validates that session against the DB.
 *
 * Sessions are stateless JWTs with a 7-day TTL. Without revalidation, a
 * deactivated user or a suspended/archived library would keep working for the
 * full token lifetime. We re-read the user + tenant status, but cache a
 * positive result in Redis for a short window so this costs at most one DB
 * round-trip per user per minute rather than one per request.
 *
 * Session invalidation (AUTH-01): the cache stores the user's
 * `sessionsValidAfter` epoch (not a bare "1"), and EVERY request — cache hit or
 * miss — rejects a token whose `iat` predates it. So a password reset / forced
 * credential or role change (which bumps the column AND deletes this cache key,
 * see `invalidateAuthCache`) terminates already-issued cookies immediately
 * rather than at the 7-day TTL. Comparison is at second granularity so a token
 * minted in the same second as the bump (e.g. a reset that auto-signs-in) is
 * not caught by its own bump.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private static readonly REVALIDATE_TTL_SEC = 60;

  /** Redis key holding the cached `sessionsValidAfter` epoch (ms) for a user. */
  static cacheKey(userId: string): string {
    return `authcheck:${userId}`;
  }

  /**
   * Drop the positive-revalidation cache for a user so the next request re-reads
   * the DB (and the freshly-bumped `sessionsValidAfter`). Call after any change
   * that must take effect immediately: password reset, forced credential reset,
   * role change, deactivation. Best-effort — correctness still holds via the
   * 60s TTL even if this no-ops.
   */
  static async invalidateAuthCache(redis: RedisService, userId: string): Promise<void> {
    try {
      await redis.client.del(AuthGuard.cacheKey(userId));
    } catch {
      // Redis unavailable — the cache expires within REVALIDATE_TTL_SEC anyway.
    }
  }

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) {
      throw new UnauthorizedException('Please sign in.');
    }

    const cacheKey = AuthGuard.cacheKey(session.sub);
    try {
      const cached = await this.redis.client.get(cacheKey);
      if (cached !== null) {
        this.assertNotStale(session.iat, Number(cached) || 0);
        return true; // validated recently
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      // Redis unavailable — fall through to a direct DB check.
    }

    const user = await controlDb.user.findUnique({
      where: { id: session.sub },
      select: { status: true, tenantId: true, sessionsValidAfter: true },
    });
    if (!user || user.status !== 'active' || user.tenantId !== session.tid) {
      throw new UnauthorizedException('Your session is no longer valid. Please sign in again.');
    }
    const tenant = await controlDb.tenant.findUnique({
      where: { id: session.tid },
      select: { status: true },
    });
    if (!tenant || tenant.status !== 'active') {
      throw new UnauthorizedException('This library is not available right now.');
    }
    const validAfterMs = user.sessionsValidAfter ? user.sessionsValidAfter.getTime() : 0;
    this.assertNotStale(session.iat, validAfterMs);

    try {
      await this.redis.client.set(
        cacheKey,
        String(validAfterMs),
        'EX',
        AuthGuard.REVALIDATE_TTL_SEC,
      );
    } catch {
      // Best-effort cache; correctness doesn't depend on it.
    }
    return true;
  }

  /** Reject a token issued strictly before the user's session epoch. */
  private assertNotStale(iatSec: number | undefined, validAfterMs: number): void {
    if (
      validAfterMs > 0 &&
      typeof iatSec === 'number' &&
      iatSec < Math.floor(validAfterMs / 1000)
    ) {
      throw new UnauthorizedException('Your session is no longer valid. Please sign in again.');
    }
  }
}
