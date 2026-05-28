import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupportSessionService } from './support-session.service.js';

/**
 * Validates that the request's impersonation cookie still points to an
 * active session row (not ended, not expired). Used implicitly by
 * `TenantGuard` (which checks the impersonation tenant matches the URL
 * tenant) — this guard makes sure the session itself is real.
 *
 * Cheap: one DB lookup per request. Could be cached behind a short Redis
 * TTL later, but the table is small and the queries hit a primary key.
 */
@Injectable()
export class SupportSessionGuard implements CanActivate {
  constructor(@Inject(SupportSessionService) private readonly sessions: SupportSessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const imp = req.impersonation;
    if (!imp) throw new UnauthorizedException('Impersonation cookie required.');
    const active = await this.sessions.getActive(imp.sessionId);
    if (!active) {
      throw new UnauthorizedException(
        'This support session has ended (or was revoked). Ask the library for a new key.',
      );
    }
    return true;
  }
}
