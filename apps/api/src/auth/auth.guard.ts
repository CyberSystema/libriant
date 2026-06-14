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
 * NOTE: this catches deactivation/suspension. Invalidating sessions on
 * password change still needs a token-version / passwordChangedAt claim
 * (tracked separately) — it can't be derived from status alone.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private static readonly REVALIDATE_TTL_SEC = 60;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const session = req.session;
    if (!session) {
      throw new UnauthorizedException('Please sign in.');
    }

    const cacheKey = `authcheck:${session.sub}`;
    try {
      if (await this.redis.client.get(cacheKey)) return true; // validated recently
    } catch {
      // Redis unavailable — fall through to a direct DB check.
    }

    const user = await controlDb.user.findUnique({
      where: { id: session.sub },
      select: { status: true, tenantId: true },
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

    try {
      await this.redis.client.set(cacheKey, '1', 'EX', AuthGuard.REVALIDATE_TTL_SEC);
    } catch {
      // Best-effort cache; correctness doesn't depend on it.
    }
    return true;
  }
}
