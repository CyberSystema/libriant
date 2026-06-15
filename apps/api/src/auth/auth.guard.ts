import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import { isPastAbsoluteMax, isSessionRevoked, type SessionPayload } from './jwt-session.service.js';

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

  private readonly absoluteMaxSec: number;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.absoluteMaxSec = loadEnv().sessionAbsoluteMaxTtlSec;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) {
      throw new UnauthorizedException('Please sign in.');
    }

    // Absolute lifetime cap — payload-only (keys off the immutable session
    // start), so it holds even on the revalidation-cache fast path and can't be
    // extended by sliding.
    if (isPastAbsoluteMax(session, Math.floor(Date.now() / 1000), this.absoluteMaxSec)) {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }

    const cacheKey = AuthGuard.cacheKey(session.sub);
    try {
      const cached = await this.redis.client.get(cacheKey);
      if (cached !== null) {
        this.assertNotRevoked(session, Number(cached) || 0);
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
    this.assertNotRevoked(session, validAfterMs);

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

  /**
   * Reject a session that STARTED before the user's revocation epoch. Keys off
   * the immutable session start (`ist`), not `iat`, so a sliding re-issue can't
   * launder a reset/role-changed session into a fresh-looking one.
   */
  private assertNotRevoked(session: SessionPayload, validAfterMs: number): void {
    if (isSessionRevoked(session, validAfterMs)) {
      throw new UnauthorizedException('Your session is no longer valid. Please sign in again.');
    }
  }
}
