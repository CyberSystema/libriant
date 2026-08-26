import { Inject, Injectable, Logger } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import { AuthGuard } from './auth.guard.js';
import { sessionStartSec, type SessionPayload } from './jwt-session.service.js';

/**
 * Server-side session revocation for tenant users.
 *
 * ## The failure this exists to stop (authn-authz-02)
 *
 * `POST /auth/logout` used to call `cookies.clearSession(res)` and nothing
 * else. The JWT is stateless, carried no session id, and the only revocation
 * primitive in the product was the account-wide `users.sessionsValidAfter`
 * epoch, written solely by a password reset. An audit probe drove the real
 * endpoint: logout returned 204, and re-presenting the SAME cookie to
 * `GET /auth/me` returned 200 with the full user payload. On the shared
 * circulation-desk browser this product is explicitly designed for
 * (cookie.service.ts), "Sign out" was a promise the server never kept — for up
 * to 30 days on a "remember me" cookie, and a signup issues one unconditionally.
 *
 * ## Two revocation paths, and why there are two
 *
 *   {@link revokeSession}      — precise. Denylists the session's `sid` in
 *     Redis so ONLY that session dies. This is what "Sign out" must mean: the
 *     owner signing out at the desk must not sign themselves out on their phone.
 *
 *   {@link revokeAllForUser}   — blunt and durable. Bumps
 *     `users.sessionsValidAfter`, which both AuthGuard and TenantGuard already
 *     enforce on every request from the DB. This is "Sign out everywhere".
 *
 * ## Why the precise path falls back to the blunt one
 *
 * The denylist lives in Redis, and Redis is exactly the component that
 * authn-authz-10 shows this system loses silently. A logout whose Redis write
 * failed and which then reported success would be the original defect with
 * extra steps — a control that compiles and does nothing. So a failed denylist
 * write escalates to the account-wide bump: the user is signed out of MORE than
 * they asked for, which is the safe direction, and the write lands in Postgres
 * where a restart cannot lose it.
 *
 * The read side ({@link isRevoked}) fails OPEN by necessity: during a Redis
 * outage we cannot tell a denylisted session from a live one, and refusing
 * every request would turn a cache outage into a total sign-out of every
 * library. That gap is bounded by the fallback above — any logout performed
 * DURING the outage is recorded in Postgres, not Redis — and it is logged, not
 * silent.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly absoluteMaxSec: number;
  /** Throttle for the fail-open warning so an outage can't flood the log. */
  private lastDegradedLogMs = 0;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {
    this.absoluteMaxSec = loadEnv().sessionAbsoluteMaxTtlSec;
  }

  /** Redis key holding the denylist entry for one session lineage. */
  static key(sid: string): string {
    return `session:revoked:${sid}`;
  }

  /**
   * End ONE session (the "Sign out" button). Returns which path was taken so
   * the caller can log/observe it; never throws.
   */
  async revokeSession(session: SessionPayload): Promise<'session' | 'account'> {
    // A token minted before the `sid` claim existed cannot be named, so it
    // cannot be denylisted. Escalate rather than silently no-op: a logout that
    // does nothing is the defect this file was written for.
    if (!session.sid) return this.revokeAllForUser(session.sub, 'legacy token has no `sid`');

    const ttlSec = this.denylistTtlSec(session);
    try {
      await this.redis.client.set(SessionRevocationService.key(session.sid), '1', 'EX', ttlSec);
      return 'session';
    } catch (err) {
      this.logger.error(
        `Could not denylist session ${session.sid} on logout (${(err as Error).message}) — ` +
          'escalating to an account-wide revocation so the sign-out is real.',
      );
      return this.revokeAllForUser(session.sub, 'denylist write failed');
    }
  }

  /**
   * End EVERY session for a user ("Sign out everywhere", and the fallback for
   * the above). Durable: both guards re-read `sessionsValidAfter` from the DB.
   */
  async revokeAllForUser(userId: string, reason?: string): Promise<'account'> {
    await controlDb.user.update({
      where: { id: userId },
      data: { sessionsValidAfter: new Date() },
    });
    // Drop the 60s positive-revalidation cache so the bump takes effect on the
    // very next request rather than up to a minute later.
    await AuthGuard.invalidateAuthCache(this.redis, userId);
    if (reason) this.logger.warn(`Account-wide session revocation for ${userId}: ${reason}.`);
    return 'account';
  }

  /**
   * Has this session lineage been signed out? Fails OPEN (see the class
   * docblock) but says so in the log.
   */
  async isRevoked(sid: string): Promise<boolean> {
    try {
      return (await this.redis.client.get(SessionRevocationService.key(sid))) !== null;
    } catch (err) {
      const now = Date.now();
      if (now - this.lastDegradedLogMs > 60_000) {
        this.lastDegradedLogMs = now;
        this.logger.error(
          'Session denylist is unreachable — signed-out sessions are being accepted until Redis ' +
            `recovers. Logouts performed while it is down still land in Postgres: ${(err as Error).message}`,
        );
      }
      return false;
    }
  }

  /**
   * How long the denylist entry must live: until the LONGEST-lived token that
   * can carry this `sid` is dead. Sliding re-issue pushes `exp` forward but can
   * never move the session past `ist + SESSION_ABSOLUTE_MAX_TTL_SEC` (both
   * guards enforce that from the payload alone), so that instant — not the
   * current token's `exp` — is the real horizon. Taking the max of the two
   * keeps it correct even if the cap is ever configured shorter than a token TTL.
   */
  private denylistTtlSec(session: SessionPayload): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const untilAbsoluteCap = sessionStartSec(session) + this.absoluteMaxSec - nowSec;
    const untilTokenExp = session.exp - nowSec;
    // 60s floor: an already-expired token costs nothing to denylist, and a
    // zero/negative TTL is an error to Redis rather than a no-op.
    return Math.max(60, untilAbsoluteCap, untilTokenExp);
  }
}
