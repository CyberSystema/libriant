import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { NextFunction, Request, Response } from 'express';
import { ImpersonationCookieService } from './impersonation-cookie.service.js';
import {
  ImpersonationSessionService,
  type ImpersonationPayload,
} from './impersonation-session.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      impersonation?: ImpersonationPayload;
    }
  }
}

/**
 * Reads the impersonation cookie (when present) and attaches the decoded
 * payload to `req.impersonation`. Runs in parallel with the other auth
 * middlewares. Subsequent guards/interceptors look at this flag to:
 *
 *   - allow cross-tenant URL access (TenantGuard sees impersonation and
 *     compares to `payload.tenantId` instead of `session.tid`),
 *   - bypass plan/quota gates,
 *   - write audit log entries on every request.
 *
 * **JWT alone is not authority.** The cookie is signed and unforgeable,
 * but library revoke / admin "End session" / TTL expiry all flip the DB
 * row without invalidating the JWT. So this middleware additionally
 * loads the row and only attaches `req.impersonation` when the session
 * is provably alive *right now* — `endedAt IS NULL` and `expiresAt > now`.
 * Expensive? One indexed lookup per impersonated request. Worth it
 * because every other check downstream gets to be a cheap boolean.
 */
@Injectable()
export class ImpersonationMiddleware implements NestMiddleware {
  constructor(
    @Inject(ImpersonationCookieService) private readonly cookies: ImpersonationCookieService,
    @Inject(ImpersonationSessionService) private readonly jwt: ImpersonationSessionService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const raw = req.cookies?.[this.cookies.name];
    if (!raw || typeof raw !== 'string') return next();
    const payload = this.jwt.verify(raw);
    if (!payload) return next();
    const row = await controlDb.supportSession.findUnique({
      where: { id: payload.sessionId },
      select: { id: true, endedAt: true, expiresAt: true, tenantId: true, adminId: true },
    });
    if (!row || row.endedAt || row.expiresAt < new Date()) {
      // Session was ended/revoked/expired since the cookie was minted.
      // Leave req.impersonation unset — downstream guards will treat
      // this as a non-impersonated request and 401 the admin out.
      return next();
    }
    if (row.tenantId !== payload.tenantId || row.adminId !== payload.adminId) {
      // Cookie and row disagree about who/what the session covers. Treat
      // as no impersonation, force re-redemption.
      return next();
    }
    req.impersonation = payload;
    return next();
  }
}
