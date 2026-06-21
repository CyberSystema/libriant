import { ForbiddenException, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../config/env.js';

/**
 * A10-03: defence-in-depth CSRF protection via an Origin check.
 *
 * The tenant session cookie is `SameSite=Lax` (needed so following an external
 * link INTO the app keeps the user signed in). Lax already blocks cross-site
 * POSTs from forms, and there are no state-changing GETs + no CORS — so CSRF is
 * not exploitable today. This adds a second, independent layer: every
 * state-changing request that carries a browser `Origin` header must have it
 * point at one of our own hosts (the apex, any tenant subdomain `*.apex`, or the
 * admin host). A cross-site attacker page's Origin (evil.com) is rejected 403.
 *
 * Deliberately permissive where it must be:
 *   - Safe methods (GET/HEAD/OPTIONS) are never checked.
 *   - A MISSING Origin is allowed — server-to-server callers (Stripe webhooks),
 *     the desktop shell's non-browser calls, and test clients don't send one,
 *     and a missing Origin can't be a cross-site browser attack.
 */
@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  private readonly apex: string;
  private readonly adminHost: string;

  constructor() {
    const env = loadEnv();
    this.apex = env.publicApexDomain.toLowerCase();
    this.adminHost = env.adminHost.toLowerCase();
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser / same-origin-without-Origin → allow

    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      // An unparseable Origin from a browser is anomalous — reject.
      throw new ForbiddenException('Invalid request origin.');
    }

    const ok = host === this.apex || host.endsWith(`.${this.apex}`) || host === this.adminHost;
    if (!ok) {
      throw new ForbiddenException('Cross-origin request rejected.');
    }

    // A2-02: admin API is served from the admin host only. Defence-in-depth on
    // top of the __Host- admin cookie (which the browser never sends off-host):
    // a state-changing /admin/* request that carries a browser Origin must have
    // that Origin be the admin host — so a page on the public apex/tenant host
    // can't drive an admin mutation. (Server-side/SSR calls send no Origin and
    // are unaffected; the cookie scoping covers reads.)
    if ((req.path.startsWith('/admin/') || req.path === '/admin') && host !== this.adminHost) {
      throw new ForbiddenException('Admin requests must originate from the admin host.');
    }
    return next();
  }
}
