import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../platform/redis.service.js';
import { AuthGuard } from './auth.guard.js';
import { PasswordService } from './password.service.js';
import { JwtSessionService } from './jwt-session.service.js';
import type { SessionPayload } from './jwt-session.service.js';

// A1-01: brute-force lockout is scoped to (account + source IP), NOT the bare
// account. A bare-account lock lets ANY attacker lock ANY user (incl. the owner)
// out of their own sessions by guessing — a trivial, renewable DoS. Per-(account
// +IP) lockout still stops a single attacker hammering one account, but a victim
// signing in from their own IP is never affected by an attacker elsewhere.
//
// That design only holds while the IP is something the attacker cannot choose.
// It wasn't: until authn-authz-01 the caller passed a raw client-supplied
// header, so six wrong logins with six different `X-Real-IP` values opened six
// empty buckets and the lockout never fired. `clientIp()` now honours a
// forwarded address only from a trusted proxy peer — read the comment there
// before changing anything about how `ip` reaches this file.
const FAIL_KEY = (uid: string, ip: string): string => `login:fail:${uid}:${ip}`;
const LOCK_KEY = (uid: string, ip: string): string => `login:lock:${uid}:${ip}`;

export type LoginResult = {
  token: string;
  expiresAt: Date;
  /** Whether this is a persistent ("remember me") session — drives the cookie. */
  remember: boolean;
  /** Snapshot to return in the response body (no password fields). */
  user: {
    id: string;
    email: string | null;
    username: string | null;
    fullName: string;
    role: SessionPayload['role'];
    mustChangeCredentials: boolean;
  };
  tenant: { id: string; slug: string; name: string; defaultLocale: string };
};

@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(JwtSessionService) private readonly jwt: JwtSessionService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  /**
   * Authenticate a user by (tenant slug, identifier, password). The
   * identifier is an email (owners/admins) OR a username (admin-created
   * staff, e.g. `staff_3`). Always uniform-time: an unknown identifier runs
   * the same dummy bcrypt to prevent a timing oracle. Failed attempts
   * increment a counter; after a threshold the account is locked.
   *
   * Throws 401 with a generic "invalid credentials" message in every
   * failure case. Lockout is reported separately so the user knows to wait.
   */
  async login(input: {
    tenantSlug: string;
    identifier: string;
    password: string;
    remember?: boolean;
    /** Source IP, for per-(account+IP) lockout (A1-01). Defaults to 'unknown'. */
    ip?: string;
  }): Promise<LoginResult> {
    const ip = input.ip ?? 'unknown';
    const tenant = await controlDb.tenant.findUnique({
      where: { slug: input.tenantSlug },
      select: {
        id: true,
        slug: true,
        name: true,
        defaultLocale: true,
        status: true,
      },
    });

    // Always do a bcrypt compare so unknown tenant takes the same time as
    // a real login attempt.
    if (!tenant) {
      await this.passwords.dummyVerify(input.password);
      throw this.invalidCredentials();
    }
    if (tenant.status !== 'active') {
      // Don't leak which non-active state.
      await this.passwords.dummyVerify(input.password);
      throw this.invalidCredentials();
    }

    const identifier = input.identifier.trim();
    const user = await controlDb.user.findFirst({
      // citext columns → case-insensitive match. Identifier is an email or a
      // staff username; both are unique per tenant.
      where: { tenantId: tenant.id, OR: [{ email: identifier }, { username: identifier }] },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        status: true,
        passwordHash: true,
        failedLogins: true,
        lockedUntil: true,
        mustChangeCredentials: true,
      },
    });
    if (!user || !user.passwordHash) {
      await this.passwords.dummyVerify(input.password);
      throw this.invalidCredentials();
    }
    if (user.status !== 'active') {
      await this.passwords.dummyVerify(input.password);
      throw this.invalidCredentials();
    }
    // authn-authz-10: the DURABLE lock, checked before the Redis one.
    // `users.lockedUntil` was selected here and never read, and the only writes
    // in the whole tenant path set it to NULL — so the "per-account lockout is
    // the backstop" that rate-limit.service.ts leans on when IT fails open did
    // not exist. A probe deleted the two Redis keys after five wrong passwords
    // and signed straight in. Two things write this column now: the degraded
    // path in recordFailure(), and an operator freezing an account by hand
    // (`UPDATE users SET "lockedUntil" = now() + interval '1 hour'`), which is
    // the documented incident response and previously did nothing.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      // Same silence as every other failure (AUTH-02) — a distinct "locked"
      // message is an account-existence oracle.
      await this.passwords.dummyVerify(input.password);
      throw this.invalidCredentials();
    }
    if (await this.isLockedOut(user.id, ip)) {
      // Lockout is enforced server-side but NOT revealed: a distinct "locked /
      // try again in N min" message is both an account-existence oracle and a
      // confirmation that a targeted lock-out succeeded (AUTH-02). Return the
      // same generic failure as every other path (still burning a dummy verify
      // for timing parity).
      await this.passwords.dummyVerify(input.password);
      throw this.invalidCredentials();
    }

    const ok = await this.passwords.verify(input.password, user.passwordHash);
    if (!ok) {
      await this.recordFailure(user.id, ip);
      throw this.invalidCredentials();
    }

    // Success — reset counters (DB audit + the per-IP Redis lock), stamp
    // lastLoginAt, issue session.
    await controlDb.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.redis.client
      .del(FAIL_KEY(user.id, ip), LOCK_KEY(user.id, ip))
      .catch(() => undefined);

    const { token, expiresAt, remember } = this.jwt.sign({
      sub: user.id,
      tid: tenant.id,
      role: user.role as SessionPayload['role'],
      remember: input.remember,
    });
    return {
      token,
      expiresAt,
      remember,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        fullName: user.fullName,
        role: user.role as SessionPayload['role'],
        mustChangeCredentials: user.mustChangeCredentials,
      },
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        defaultLocale: tenant.defaultLocale,
      },
    };
  }

  /**
   * One-time first-login setup for admin-created staff: set a new password
   * (and optionally a display name), then clear `mustChangeCredentials`.
   *
   * authn-authz-07: `newPassword` used to be optional and the flag was cleared
   * unconditionally — `const data = { mustChangeCredentials: false }` ran
   * whether or not a password was supplied. A probe signed in with the
   * admin-generated temporary password, posted `{}` to `/auth/complete-setup`,
   * got 200, and then signed in with that same temporary password again. The
   * credential the creating admin generated, read in plaintext from the API
   * response and very likely pasted into WhatsApp became the account's
   * permanent password, while the UI showed the forced-change screen once and
   * never again.
   *
   * So `newPassword` is a REQUIRED parameter — not an optional one with a
   * server-side check that a future caller can forget — and the flag is only
   * cleared in the same write that stores the new hash. Re-submitting the
   * current password is refused too: the point is that the shared secret stops
   * working, and "change it to itself" clears the gate without doing that.
   */
  async completeSetup(
    userId: string,
    input: { fullName?: string; newPassword: string },
  ): Promise<void> {
    const newPassword = input.newPassword?.trim() ? input.newPassword : '';
    if (!newPassword) {
      // A machine `code` alongside the sentence: apps/web/lib/api-errors.ts
      // translates by `code` when one arrives and otherwise falls back to a
      // generic "bad request", which is not a useful thing to read on a forced
      // password screen. The catalogue entry is `errors.api.auth.passwordRequired`.
      throw new BadRequestException({
        code: 'auth.passwordRequired',
        message:
          'Choose a new password to finish setting up your account. The temporary one your ' +
          'administrator gave you stops working once you do.',
      });
    }

    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, mustChangeCredentials: true },
    });
    if (!user?.passwordHash) {
      throw new BadRequestException('This account cannot be set up here.');
    }

    // THE GATE. This endpoint sets a new password WITHOUT asking for the old
    // one, which is only defensible while the caller is in the forced-change
    // state: they were handed a temporary password by an administrator and
    // cannot be asked to prove knowledge of anything better.
    //
    // Without this check it was a full account takeover from a stolen cookie
    // that locked the real owner out at the same time. POST /auth/complete-setup
    // with ANY live session and {"newPassword":"..."} returned 200, after which
    // the owner's real password 401'd — executed against a production-configured
    // boot. It is the exact harm authn-authz-08 closed on change-email, still
    // reachable in one request from the neighbouring route, and making
    // `newPassword` mandatory turned it from an optional trick into a reliable
    // one.
    //
    // Self-service password change belongs on an endpoint that requires the
    // current password. This is not that endpoint.
    if (!user.mustChangeCredentials) {
      throw new ForbiddenException({
        code: 'auth.setupAlreadyComplete',
        message:
          'This account is already set up. To change your password, use the password change in ' +
          'your account settings, which asks for your current one.',
      });
    }
    if (await this.passwords.verify(newPassword, user.passwordHash)) {
      throw new BadRequestException({
        code: 'auth.passwordUnchanged',
        message:
          'That is the password you were given. Choose a different one — the temporary password ' +
          'is known to whoever created your account.',
      });
    }

    const data: {
      fullName?: string;
      passwordHash: string;
      mustChangeCredentials: boolean;
      sessionsValidAfter: Date;
    } = {
      passwordHash: await this.passwords.hash(newPassword),
      // Only ever cleared alongside a real password write.
      mustChangeCredentials: false,
      // Changing the password invalidates every existing session (AUTH-01).
      sessionsValidAfter: new Date(),
    };
    if (input.fullName && input.fullName.trim()) data.fullName = input.fullName.trim();
    await controlDb.user.update({ where: { id: userId }, data });
    await AuthGuard.invalidateAuthCache(this.redis, userId);
  }

  /** True when (account, ip) is currently locked. Fails OPEN if Redis is down
   *  so an outage never blocks every login (parity with the rate limiter). */
  private async isLockedOut(userId: string, ip: string): Promise<boolean> {
    try {
      return (await this.redis.client.get(LOCK_KEY(userId, ip))) !== null;
    } catch {
      return false;
    }
  }

  private async recordFailure(userId: string, ip: string): Promise<void> {
    // Keep a DB tally for audit/visibility (atomic increment, AUTH-03). The
    // LOCK decision is normally per-(account+IP) in Redis (A1-01) so one
    // attacker can't DoS-lock a victim globally — see the degraded branch below
    // for the one case where this tally also drives a lock.
    let failedLogins: number | null = null;
    try {
      const row = await controlDb.user.update({
        where: { id: userId },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      });
      failedLogins = row.failedLogins;
    } catch (err) {
      // Not swallowed any more: this counter is the only input the degraded
      // backstop has, so losing it silently is losing the backstop silently.
      this.logger.error(
        `Could not increment failedLogins for user ${userId}: ${(err as Error).message}`,
      );
    }

    const windowSec = Math.ceil(this.env.loginLockoutMs / 1000);
    try {
      const failKey = FAIL_KEY(userId, ip);
      const n = await this.redis.client.incr(failKey);
      if (n === 1) await this.redis.client.expire(failKey, windowSec);
      if (n >= this.env.maxFailedLogins) {
        await this.redis.client.set(LOCK_KEY(userId, ip), '1', 'EX', windowSec);
        this.logger.warn(
          `Login locked for user ${userId} from ${ip} after ${n} failed attempts (${windowSec}s).`,
        );
      }
    } catch (err) {
      await this.recordDegradedFailure(userId, failedLogins, windowSec, err as Error);
    }
  }

  /**
   * Redis could not record the per-(account+IP) lock (authn-authz-10).
   *
   * In that state there is NO brute-force protection anywhere: `isLockedOut`
   * returns false, `RateLimitService.hit` fails open for every non-signup
   * bucket, and its comment points at "per-account lockout (LoginService)" as
   * the backstop. This method is that backstop, and it engages ONLY here.
   *
   * The account-wide column is deliberately not written on the healthy path.
   * A bare-account lock is a renewable denial of service — anyone who knows a
   * librarian's email can lock them out by guessing — which is precisely why
   * A1-01 moved the lock into Redis keyed on the source IP. Confining the DB
   * lock to the Redis-outage path keeps that property: an attacker cannot
   * choose to be in this branch, and while they are, unlimited guessing at
   * every account on the platform is the alternative. The lock expires by
   * itself after `LOGIN_LOCKOUT_MS`, a correct password clears it (see the
   * success path), and it is logged at error so the operator sees both the
   * outage and the degraded mode it put auth into.
   */
  private async recordDegradedFailure(
    userId: string,
    failedLogins: number | null,
    windowSec: number,
    err: Error,
  ): Promise<void> {
    if (failedLogins === null || failedLogins < this.env.maxFailedLogins) {
      this.logger.error(
        `Login lockout unavailable for user ${userId} (Redis: ${err.message}) — falling back to ` +
          `the durable per-account lock at ${this.env.maxFailedLogins} failures ` +
          `(currently ${failedLogins ?? 'unknown'}).`,
      );
      return;
    }
    const lockedUntil = new Date(Date.now() + windowSec * 1000);
    try {
      await controlDb.user.update({ where: { id: userId }, data: { lockedUntil } });
      this.logger.error(
        `Redis is unavailable (${err.message}); user ${userId} is now locked in the DATABASE until ` +
          `${lockedUntil.toISOString()} after ${failedLogins} failed sign-ins. This lock is ` +
          'account-wide, not per-IP — it is the degraded mode, not the normal one.',
      );
    } catch (dbErr) {
      this.logger.error(
        `Both the Redis lockout and the database backstop failed for user ${userId} — this account ` +
          `has NO brute-force protection right now: ${(dbErr as Error).message}`,
      );
    }
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException("We couldn't sign you in with those details.");
  }
}
