import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { loadEnv } from '../config/env.js';
import { CookieService } from './cookie.service.js';
import {
  JwtSessionService,
  isPastAbsoluteMax,
  isPastHalfLife,
  sessionStartSec,
} from './jwt-session.service.js';
import { SessionRevocationService } from './session-revocation.service.js';

/**
 * Reads the session cookie on every request and (if present + valid)
 * attaches the decoded payload to `req.session`. Runs BEFORE TenantGuard
 * sees the request so the guard can compare `session.tid` with the
 * resolved tenant.
 *
 * Sliding sessions: on a GET past the token's half-life, re-issue a fresh
 * cookie (same role + remember flag) so an active user never hits the hard
 * expiry. GET-only so we never race the logout / mutating-request Set-Cookie,
 * and at most once per half-life so it's cheap. The re-issued token gets a
 * fresh `iat`, which stays ≥ any `sessionsValidAfter` epoch — so sliding never
 * resurrects a session that a password-reset / role-change invalidated.
 *
 * Signed-out sessions (authn-authz-02) are refused HERE rather than in a guard.
 * Tenant data routes go through TenantGuard and platform routes through
 * AuthGuard; putting the denylist check in one of them would leave the other
 * open, and TenantGuard is not ours to edit. This middleware is the single
 * point every request already passes through, so a denylisted `sid` simply
 * never becomes a `req.session` and BOTH guards 401 it for free.
 *
 * No exceptions thrown — an invalid cookie simply leaves req.session
 * undefined and AuthGuard will return 401 downstream.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  private readonly absoluteMaxSec: number;

  constructor(
    @Inject(CookieService) private readonly cookies: CookieService,
    @Inject(JwtSessionService) private readonly jwt: JwtSessionService,
    @Inject(SessionRevocationService) private readonly revocations: SessionRevocationService,
  ) {
    this.absoluteMaxSec = loadEnv().sessionAbsoluteMaxTtlSec;
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const raw = req.cookies?.[this.cookies.name];
    if (!raw || typeof raw !== 'string') return next();
    const payload = this.jwt.verify(raw);
    if (!payload) return next();
    // Signed out on any device that shared this session. Leave req.session
    // unset (→ 401 from whichever guard the route uses) and wipe the dead
    // cookie so the browser stops re-presenting it on every request.
    if (payload.sid && (await this.revocations.isRevoked(payload.sid))) {
      this.cookies.clearSession(res);
      return next();
    }
    req.session = payload;

    const nowSec = Math.floor(Date.now() / 1000);
    // Slide only when: it's a safe GET, the token is past half-life, and the
    // session hasn't hit its absolute cap. Crucially the re-issue PRESERVES the
    // immutable session start (`ist`) — so sliding refreshes the expiry window
    // but can never reset the clock that revocation + the absolute cap measure
    // against (the guards still authoritatively reject a revoked/aged session).
    if (
      req.method === 'GET' &&
      isPastHalfLife(payload, nowSec) &&
      !isPastAbsoluteMax(payload, nowSec, this.absoluteMaxSec)
    ) {
      const fresh = this.jwt.sign({
        sub: payload.sub,
        tid: payload.tid,
        role: payload.role,
        remember: payload.rmb,
        // Carry forward the TRUE session start. For a legacy token minted before
        // `ist` existed, `payload.ist` is undefined — fall back to its original
        // `iat` (via sessionStartSec) so the slide can NEVER move the start
        // forward. Passing a bare `payload.ist` here would let sign() default it
        // to now, laundering a revoked/aged legacy session into a fresh one.
        ist: sessionStartSec(payload),
        // Carry the session id too (authn-authz-02). If the slide minted a new
        // one, a later logout would denylist only the newest copy and every
        // older copy of the cookie — which is exactly what a thief holds —
        // would keep working. A legacy token has none; sign() mints one, which
        // is how pre-`sid` sessions become revocable at all.
        sid: payload.sid,
      });
      this.cookies.setSession(res, fresh.token, fresh.expiresAt, fresh.remember);
    }
    return next();
  }
}
