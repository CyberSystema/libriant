import { Controller, Get, Req } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import type { Request } from 'express';

/**
 * Public-ish endpoint used by the tenant web layout to detect that the
 * caller is an impersonating admin (vs a normal librarian). The credential
 * IS the impersonation cookie — `ImpersonationMiddleware` decodes it into
 * `req.impersonation`. We then verify the session row is still active,
 * matching the same checks `SupportSessionGuard` runs.
 *
 *   GET /support/impersonation/me
 *
 * Returns `{ impersonation: null }` when the cookie is missing/invalid/
 * expired; `{ impersonation: { adminId, tenant, expiresAt } }` otherwise.
 */
@Controller('support/impersonation')
export class ImpersonationController {
  @Get('me')
  async me(@Req() req: Request) {
    const payload = req.impersonation;
    if (!payload) return { impersonation: null };
    const session = await controlDb.supportSession.findUnique({
      where: { id: payload.sessionId },
      include: {
        tenant: { select: { id: true, slug: true, name: true } },
        admin: { select: { email: true, fullName: true } },
      },
    });
    if (!session || session.endedAt || session.expiresAt < new Date()) {
      return { impersonation: null };
    }
    return {
      impersonation: {
        adminId: payload.adminId,
        tenant: session.tenant,
        admin: session.admin,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
      },
    };
  }
}
