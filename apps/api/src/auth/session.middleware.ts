import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CookieService } from './cookie.service.js';
import { JwtSessionService } from './jwt-session.service.js';

/**
 * Reads the session cookie on every request and (if present + valid)
 * attaches the decoded payload to `req.session`. Runs BEFORE TenantGuard
 * sees the request so the guard can compare `session.tid` with the
 * resolved tenant.
 *
 * No exceptions thrown — an invalid cookie simply leaves req.session
 * undefined and AuthGuard will return 401 downstream.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(
    @Inject(CookieService) private readonly cookies: CookieService,
    @Inject(JwtSessionService) private readonly jwt: JwtSessionService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const raw = req.cookies?.[this.cookies.name];
    if (!raw || typeof raw !== 'string') return next();
    const payload = this.jwt.verify(raw);
    if (payload) req.session = payload;
    return next();
  }
}
