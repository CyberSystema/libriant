import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import type { AdminSessionPayload } from './admin-session.service.js';

/**
 * Gate every `/admin/*` route behind a valid admin session **AND** a
 * still-active row in `admin_users`. Looking up the row every request
 * means a disabled admin's existing session is invalidated immediately,
 * not at next sign-in.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.adminSession) {
      throw new UnauthorizedException('Admin sign-in required.');
    }
    const admin = await controlDb.adminUser.findUnique({
      where: { id: req.adminSession.sub },
      select: { id: true, role: true, status: true, disabledAt: true },
    });
    if (!admin || admin.disabledAt || admin.status !== 'active') {
      throw new ForbiddenException('Your admin account is no longer active.');
    }
    return true;
  }
}

/**
 * Pull the verified admin session from the request inside a route handler.
 * Throws 401 if no session — used inside handlers behind `AdminAuthGuard`
 * for type safety.
 */
export const AdminSess = createParamDecorator<unknown, ExecutionContext, AdminSessionPayload>(
  (_, ctx) => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.adminSession) {
      throw new UnauthorizedException('Admin sign-in required.');
    }
    return req.adminSession;
  },
);
