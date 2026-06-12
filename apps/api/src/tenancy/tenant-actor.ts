import { createParamDecorator, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditActorType } from '@libriant/db-tenant';

/**
 * Who is acting on a tenant route, resolved from a normal session OR a support
 * impersonation. Splits the two things that "actor" conflates:
 *
 *   - `userId`  — the tenant User.id to stamp on data columns like
 *     `loan.checkedOutByUserId`. NULL under impersonation: a Libriant admin is
 *     not a tenant user, so the column stays empty (it's nullable) and the
 *     audit row below carries the real attribution.
 *   - `actorId` / `actorType` / `supportSessionId` — audit attribution. A
 *     normal user is `user`; an impersonating admin is `admin` with the
 *     `support_sessions.id` so the action is traceable to the support session.
 */
export type TenantActor = {
  userId: string | null;
  actorId: string;
  actorType: AuditActorType;
  supportSessionId: string | null;
};

/**
 * Resolve the {@link TenantActor} from the request. TenantGuard already
 * guarantees one of session/impersonation on every `/t/:slug/*` route, so the
 * throw is defense-in-depth (mirrors `@Sess` / `@TenantCtx`).
 */
export const TenantActor = createParamDecorator<unknown, TenantActor>((_, ctx) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (req.impersonation) {
    return {
      userId: null,
      actorId: req.impersonation.adminId,
      actorType: 'admin',
      supportSessionId: req.impersonation.sessionId,
    };
  }
  if (req.session) {
    return {
      userId: req.session.sub,
      actorId: req.session.sub,
      actorType: 'user',
      supportSessionId: null,
    };
  }
  throw new UnauthorizedException('Authentication required.');
});
