import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env.js';

/**
 * What's inside the session cookie. Compact field names keep the cookie
 * small. We never put PII here — only IDs and the issuance metadata.
 */
export type SessionPayload = {
  /** Subject = User.id (control-plane cuid). */
  sub: string;
  /** Tenant id this user belongs to. Cross-checked against the URL tenant
   *  by `TenantGuard` to prevent cross-tenant access. */
  tid: string;
  /** Role at signing time. May be stale — authoritative role lives in DB. */
  role: 'owner' | 'admin' | 'librarian' | 'volunteer';
  /** "Remember me": a long-lived persistent session. Drives both the TTL and
   *  whether the cookie persists across browser restarts. */
  rmb?: boolean;
  /**
   * Session START time, in seconds. IMMUTABLE across sliding re-issues (unlike
   * `iat`, which is refreshed each slide). All security checks key off THIS, not
   * `iat`, so a slide can never escape revocation (a session that started before
   * a password-reset/role-change keeps its old `ist`) and the absolute lifetime
   * cap measures total age. Optional for backward-compat with pre-`ist` tokens
   * (those fall back to `iat`).
   */
  ist?: number;
  /**
   * Session id — a random identifier minted once per LOGIN and, like `ist`,
   * carried unchanged through every sliding re-issue.
   *
   * authn-authz-02: `POST /auth/logout` used to clear the cookie and nothing
   * else, so a cookie captured before the click kept working for the token's
   * full TTL (7d, or 30d for "remember me", extended by sliding up to the 90-day
   * absolute cap). A probe proved it: logout → 204, then the SAME cookie on
   * `GET /auth/me` → 200. This claim is what logout now denylists.
   *
   * It is deliberately per-SESSION and not per-TOKEN. A `jti` refreshed on each
   * slide would let the two copies of a stolen cookie drift apart, so revoking
   * the copy the browser holds would leave the attacker's copy alive. Both
   * copies share this `sid` for the life of the session, so one logout kills
   * the lineage.
   *
   * Optional for backward-compat with tokens minted before this claim existed:
   * those cannot be revoked individually, so logout falls back to the
   * account-wide `sessionsValidAfter` bump (see SessionRevocationService).
   */
  sid?: string;
  /** Issued-at, in seconds (refreshed on every sliding re-issue). */
  iat: number;
  /** Expires-at, in seconds. */
  exp: number;
};

export type SignedSession = { token: string; expiresAt: Date; remember: boolean };

@Injectable()
export class JwtSessionService {
  private readonly secret: string;
  private readonly ttlSec: number;
  private readonly rememberTtlSec: number;

  constructor() {
    const env = loadEnv();
    this.secret = env.sessionSecret;
    this.ttlSec = env.sessionTtlSec;
    this.rememberTtlSec = env.sessionRememberTtlSec;
  }

  /**
   * Sign a session token. `remember` picks the long persistent TTL and is
   * stamped (`rmb`) so a sliding re-issue can preserve the lifetime + cookie
   * persistence. `ist` (session start) is set to now for a FRESH login and MUST
   * be passed through unchanged on a slide so the immutable start time — which
   * revocation + the absolute cap depend on — is preserved.
   */
  sign(
    input: Pick<SessionPayload, 'sub' | 'tid' | 'role'> & {
      remember?: boolean;
      ist?: number;
      /** Pass the CURRENT session's `sid` on a slide; omit for a fresh login. */
      sid?: string;
    },
  ): SignedSession {
    const remember = !!input.remember;
    const expiresInSec = remember ? this.rememberTtlSec : this.ttlSec;
    const ist = input.ist ?? Math.floor(Date.now() / 1000);
    // 128 bits of randomness: the denylist is keyed on this value, so a
    // guessable id would let anyone revoke a stranger's session.
    const sid = input.sid ?? randomBytes(16).toString('base64url');
    // jsonwebtoken stamps `iat` itself and refuses to honor an explicit one
    // unless `noTimestamp` is set — and `noTimestamp` strips iat from the
    // payload entirely, which then trips our typed-claim guard on verify.
    // Easiest: let the library handle iat + expiresIn for us.
    const token = jwt.sign(
      { sub: input.sub, tid: input.tid, role: input.role, rmb: remember, ist, sid },
      this.secret,
      { algorithm: 'HS256', expiresIn: expiresInSec },
    );
    return { token, expiresAt: new Date(Date.now() + expiresInSec * 1000), remember };
  }

  /**
   * Verify a token's signature and expiry. Returns the payload on success,
   * null on any failure (bad signature, expired, malformed).
   */
  verify(token: string): SessionPayload | null {
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof decoded !== 'object' || decoded === null) return null;
      const obj = decoded as Record<string, unknown>;
      if (
        typeof obj.sub !== 'string' ||
        typeof obj.tid !== 'string' ||
        typeof obj.role !== 'string' ||
        typeof obj.iat !== 'number' ||
        typeof obj.exp !== 'number'
      ) {
        return null;
      }
      // `sid` is our own claim and the signature already proves authenticity,
      // but it is used verbatim as a Redis key — so anything that is not a
      // plain string is dropped rather than concatenated into one.
      if (obj.sid !== undefined && typeof obj.sid !== 'string') delete obj.sid;
      return obj as unknown as SessionPayload;
    } catch {
      return null;
    }
  }
}

/** Immutable session-start time (seconds). Falls back to `iat` for legacy tokens. */
export function sessionStartSec(payload: Pick<SessionPayload, 'iat' | 'ist'>): number {
  return typeof payload.ist === 'number' && Number.isFinite(payload.ist)
    ? payload.ist
    : payload.iat;
}

/**
 * Should an active session's cookie be re-issued? True once it's past half its
 * lifetime — so a user who keeps using the app never hits the hard expiry
 * (sliding), while a token gets refreshed at most once per half-life. Pure +
 * exported so it's unit-testable without minting real JWTs.
 */
export function isPastHalfLife(
  payload: Pick<SessionPayload, 'iat' | 'exp'>,
  nowSec: number,
): boolean {
  if (
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= payload.iat
  ) {
    return false;
  }
  return nowSec >= payload.iat + (payload.exp - payload.iat) / 2;
}

/**
 * Revoked? True if the session STARTED (ist) before the user's
 * `sessionsValidAfter` epoch — i.e. a password reset / forced credential or
 * role change happened after login. Uses `ist` (not `iat`), so a sliding
 * re-issue can NOT launder a revoked session into a fresh-looking one.
 * Second-granularity so a token minted in the same second as the bump survives.
 */
export function isSessionRevoked(
  payload: Pick<SessionPayload, 'iat' | 'ist'>,
  sessionsValidAfterMs: number,
): boolean {
  if (!(sessionsValidAfterMs > 0)) return false;
  return sessionStartSec(payload) < Math.floor(sessionsValidAfterMs / 1000);
}

/**
 * Past the absolute lifetime cap? True once total age (now − session start)
 * exceeds `absoluteMaxSec`, forcing a fresh sign-in regardless of activity.
 */
export function isPastAbsoluteMax(
  payload: Pick<SessionPayload, 'iat' | 'ist'>,
  nowSec: number,
  absoluteMaxSec: number,
): boolean {
  return nowSec - sessionStartSec(payload) > absoluteMaxSec;
}
