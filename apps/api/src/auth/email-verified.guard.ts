import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';

/**
 * Soft email-verification gate. Runs AFTER the session/tenant guards (so
 * `req.session` is set) on verification-SENSITIVE routes only — e.g. inviting
 * staff, going live. An unverified email account is blocked here with a 403
 * `{ code: 'email_verification_required' }` the web turns into a "verify your
 * email" prompt; everything else (browsing, basic editing) stays open.
 *
 * Staff accounts have a username and NO email, so there's nothing to verify —
 * they're exempt (they were created by an already-verified owner). Reads the
 * `controlDb` singleton directly (no DI), mirroring RolesGuard/TenantGuard so a
 * standalone `@UseGuards(EmailVerifiedGuard)` reference works under tsx.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const sub = req.session?.sub;
    if (!sub) {
      // Should be unreachable behind AuthGuard/TenantGuard, but never run the
      // DB read unauthenticated.
      throw new UnauthorizedException('Please sign in.');
    }
    const user = await controlDb.user.findUnique({
      where: { id: sub },
      select: { email: true, emailVerifiedAt: true },
    });
    if (user?.email && !user.emailVerifiedAt) {
      throw new ForbiddenException({
        code: 'email_verification_required',
        message:
          'Verify your email address to use this feature — check your inbox or resend the link from your account.',
      });
    }
    return true;
  }
}
