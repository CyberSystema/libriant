import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AdminCookieService } from './admin-cookie.service.js';
import { AdminSessionService, type AdminSessionPayload } from './admin-session.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminSession?: AdminSessionPayload;
    }
  }
}

/**
 * Reads the admin cookie (when present) and attaches the decoded payload
 * to `req.adminSession`. Runs in parallel with `SessionMiddleware` — admin
 * and tenant sessions are independent and the two flags don't conflict.
 *
 * No exceptions thrown — an absent or invalid admin cookie just leaves
 * `req.adminSession` undefined; `AdminAuthGuard` returns 401 downstream.
 */
@Injectable()
export class AdminMiddleware implements NestMiddleware {
  constructor(
    @Inject(AdminCookieService) private readonly cookies: AdminCookieService,
    @Inject(AdminSessionService) private readonly jwt: AdminSessionService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const raw = req.cookies?.[this.cookies.name];
    if (!raw || typeof raw !== 'string') return next();
    const payload = this.jwt.verify(raw);
    if (payload) req.adminSession = payload;
    return next();
  }
}
