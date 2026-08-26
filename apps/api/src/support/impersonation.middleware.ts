import { Inject, Injectable, Logger, NestMiddleware } from '@nestjs/common';
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
 *
 * **The admin behind the session is authority too (authn-authz-04).** The row
 * check above was the whole check: `adminUser` was never read, so `status`,
 * `disabledAt` and `sessionsValidAfter` — the three columns AdminAuthGuard
 * re-reads on EVERY `/admin/*` request — had no counterpart here. A probe
 * opened a support session for an active admin, then set that admin to
 * `status:'disabled', disabledAt: now()`, and with the same cookie still got
 * `GET /t/<slug>/members` → 200 and `POST /t/<slug>/members` → 201. Offboarding
 * a support engineer left them up to `SUPPORT_SESSION_TTL_SEC` (4h) of
 * unrestricted read and WRITE access to a live customer library — member PII,
 * loans, catalogue — at exactly the moment revocation matters most.
 *
 * The admin row is joined into the same query (one round-trip, not two) and a
 * non-active admin does not merely fail to attach: the session row is CLOSED,
 * so the library's own support log shows it ended and nothing lingers waiting
 * for the TTL.
 */
@Injectable()
export class ImpersonationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ImpersonationMiddleware.name);

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
      select: {
        id: true,
        endedAt: true,
        expiresAt: true,
        tenantId: true,
        adminId: true,
        admin: { select: { status: true, disabledAt: true, sessionsValidAfter: true } },
      },
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
    const revoked = adminRevocationReason(row.admin, payload.iat);
    if (revoked) {
      await this.endSession(row.id, payload.adminId, revoked);
      return next();
    }
    req.impersonation = payload;
    return next();
  }

  /**
   * Close the row for a support session whose admin is no longer entitled to
   * it. Best-effort: the access decision was already made by NOT attaching
   * `req.impersonation`, so a failure here costs bookkeeping, not safety —
   * but it must be loud, because a session that keeps reappearing as "active"
   * in the library's support view is how an operator learns nothing happened.
   */
  private async endSession(sessionId: string, adminId: string, reason: string): Promise<void> {
    this.logger.warn(`Support session ${sessionId} refused and ended: admin ${adminId} ${reason}.`);
    try {
      await controlDb.supportSession.updateMany({
        where: { id: sessionId, endedAt: null },
        data: { endedAt: new Date(), endedReason: 'admin_ended' },
      });
    } catch (err) {
      this.logger.error(
        `Could not close support session ${sessionId} for a revoked admin — access is already ` +
          `denied, but the row still reads as active: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Why this admin may no longer impersonate, or `null` if they still may.
 *
 * Mirrors AdminAuthGuard's checks one-for-one and deliberately in the same
 * order, so the two surfaces cannot drift: disabled → not active → session
 * minted before a forced credential change. Exported for the unit test, which
 * asserts each column independently rather than trusting one combined boolean.
 */
export function adminRevocationReason(
  admin: { status: string; disabledAt: Date | null; sessionsValidAfter: Date | null } | null,
  cookieIatSec: number,
): string | null {
  if (!admin) return 'no longer exists';
  if (admin.disabledAt) return 'is disabled';
  if (admin.status !== 'active') return `is not active (status=${admin.status})`;
  if (
    admin.sessionsValidAfter &&
    cookieIatSec < Math.floor(admin.sessionsValidAfter.getTime() / 1000)
  ) {
    return 'had their sessions invalidated after this cookie was minted';
  }
  return null;
}
