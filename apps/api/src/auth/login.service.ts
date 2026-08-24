import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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
   * One-time first-login setup for admin-created staff: optionally change the
   * display name and/or password, then clear `mustChangeCredentials`. Either
   * field may be omitted ("keep the same"); the flag is always cleared so the
   * forced screen doesn't reappear until an admin resets the account.
   */
  async completeSetup(
    userId: string,
    input: { fullName?: string; newPassword?: string },
  ): Promise<void> {
    const data: {
      fullName?: string;
      passwordHash?: string;
      mustChangeCredentials: boolean;
      sessionsValidAfter?: Date;
    } = {
      mustChangeCredentials: false,
    };
    if (input.fullName && input.fullName.trim()) data.fullName = input.fullName.trim();
    if (input.newPassword) {
      data.passwordHash = await this.passwords.hash(input.newPassword);
      // Changing the password invalidates every existing session (AUTH-01).
      data.sessionsValidAfter = new Date();
    }
    await controlDb.user.update({ where: { id: userId }, data });
    if (input.newPassword) await AuthGuard.invalidateAuthCache(this.redis, userId);
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
    // Keep a DB tally for audit/visibility (atomic increment, AUTH-03), but the
    // LOCK decision is per-(account+IP) in Redis (A1-01) so one attacker can't
    // DoS-lock a victim globally.
    await controlDb.user
      .update({
        where: { id: userId },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      })
      .catch(() => undefined);

    try {
      const windowSec = Math.ceil(this.env.loginLockoutMs / 1000);
      const failKey = FAIL_KEY(userId, ip);
      const n = await this.redis.client.incr(failKey);
      if (n === 1) await this.redis.client.expire(failKey, windowSec);
      if (n >= this.env.maxFailedLogins) {
        await this.redis.client.set(LOCK_KEY(userId, ip), '1', 'EX', windowSec);
        this.logger.warn(
          `Login locked for user ${userId} from ${ip} after ${n} failed attempts (${windowSec}s).`,
        );
      }
    } catch {
      // Redis down → no lockout this attempt (fail open); the per-IP edge rate
      // limit (auth.controller) still bounds the attempt rate.
    }
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException("We couldn't sign you in with those details.");
  }
}
