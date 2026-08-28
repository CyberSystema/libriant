import { ForbiddenException, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../config/env.js';

/**
 * Routes that have no non-browser caller, and therefore do not get the
 * missing-Origin pass.
 *
 * The pass the class below grants a missing Origin exists for Stripe, for the
 * desktop shell and for test clients.
 * The public application form has none of those: it is reached by a human
 * pressing a submit button on the marketing site and by nothing else, and every
 * browser has sent `Origin` on a form-navigation POST since the three engines
 * aligned on the Fetch Standard, which appends the header to any request whose
 * method is not GET or HEAD. So on these paths a missing Origin is not "a caller
 * we cannot classify" — it is a caller that is not a browser.
 *
 * Be honest about what that buys, because this endpoint is the only
 * unauthenticated write in the control plane and it deserves an accurate
 * accounting rather than a reassuring one. It stops the scripted POST that sends
 * no Origin — curl, requests, a form-spam crawler working through discovered
 * form actions — and it stops nothing else: anyone who reads one 403 will add
 * `-H 'Origin: …'` and be through. It is worth the six lines because of what
 * sits behind it. ApplicationsController runs the per-IP throttle AFTER
 * validation on purpose, so a deliberately-invalid submission is counted by
 * nothing, while still costing a control-plane query for the offer state and a
 * full server-side render of the home page.
 *
 * infra/caddy/Caddyfile refuses the same requests one hop earlier, on the
 * marketing vhost, where they cost a header comparison instead of a Node
 * process. This copy is not redundant with it: `/lbr-api/apply` on the app host
 * proxies to this same handler and never passes that matcher, and a rule
 * enforced at one of two entrances is exactly the shape of the /webhooks/* miss
 * the edge config's own comments are about. scripts/check-caddy.mjs asserts this
 * list and the Caddyfile's `@apply` matcher name the same paths.
 */
const BROWSER_ONLY_PATHS = new Set(['/apply', '/en/apply']);

/**
 * Express matches routes case-insensitively and ignores a trailing slash, so a
 * comparison against a literal path has to do the same or it is a bypass rather
 * than a check: `POST /Apply/` reaches the same handler as `POST /apply`.
 */
function routeKey(path: string): string {
  return path.toLowerCase().replace(/\/+$/, '') || '/';
}

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
 *     {@link BROWSER_ONLY_PATHS} is the exception to that last one.
 */
@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  private readonly apex: string;
  private readonly adminHost: string;
  /** The marketing site's host — where the public application form posts from. */
  private readonly siteHost: string;

  constructor() {
    const env = loadEnv();
    this.apex = env.publicApexDomain.toLowerCase();
    this.adminHost = env.adminHost.toLowerCase();
    this.siteHost = env.siteHost.toLowerCase();
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const origin = req.headers.origin;
    if (!origin) {
      if (BROWSER_ONLY_PATHS.has(routeKey(req.path))) {
        throw new ForbiddenException(
          `Applications are accepted only from the form at https://${this.siteHost}.`,
        );
      }
      return next(); // non-browser / same-origin-without-Origin → allow
    }

    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      // An unparseable Origin from a browser is anomalous — reject.
      throw new ForbiddenException('Invalid request origin.');
    }

    const ok =
      host === this.apex ||
      host.endsWith(`.${this.apex}`) ||
      host === this.adminHost ||
      host === this.siteHost;
    if (!ok) {
      throw new ForbiddenException('Cross-origin request rejected.');
    }

    // The form posts from exactly one host, so accept exactly one host.
    //
    // The generic test above admits the apex, EVERY tenant subdomain and the
    // admin host — which is right for the rest of the API and wrong here. The
    // edge requires this Origin to be `https://{$SITE_HOST}` exactly, and the
    // path that never reaches the edge matcher is `/lbr-api/apply` on the app
    // host, so this was the looser rule on precisely the entrance that has no
    // other one: any page on any tenant subdomain could drive the only
    // unauthenticated write in the control plane. scripts/check-caddy.mjs
    // asserts the two entrances name the same paths; this is what makes them
    // enforce the same rule on those paths, rather than merely the same list.
    if (BROWSER_ONLY_PATHS.has(routeKey(req.path)) && host !== this.siteHost) {
      throw new ForbiddenException(
        `Applications are accepted only from the form at https://${this.siteHost}.`,
      );
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
